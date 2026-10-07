/**
 * GET-95 fetch processing coverage persistence (first batch): the trusted
 * record/get-view API for shared/research-fetch-coverage.ts.
 *
 * Everything is append-only and runs in one transaction per call:
 * - `recordFetchReceipt` / `recordFetchBatch` append immutable per-content
 *   processing receipts with caller replay identity. Re-recording the same
 *   receipt key with the same body is a no-op that returns the original
 *   record; the same key with a different body is a rejected
 *   `FetchReceiptConflictError`. Batches are all-or-nothing: one invalid
 *   reference rolls the whole batch back with zero rows written.
 * - Every write binds an immutable case source revision and atomically
 *   validates owner / case / account / allowedScope / current scopeVersion.
 *   History processing on `profile_only` or `none` accounts, stale or future
 *   scope versions, foreign account/case references and already-revoked
 *   dependencies are rejected — never silently dropped.
 * - `getFetchCoverageView` derives a read-only projection: per-platform/
 *   account counters over the frozen publication window plus per-item
 *   state/reason/history. The latest receipt per dimension supersedes by
 *   append order (`seq`), never by `occurredAt` or `created_at`; a later
 *   failed/inaccessible receipt reopens a prior success. Duplicate pages and
 *   replayed receipts never double count because counters aggregate distinct
 *   content identities and current dimension states.
 *
 * Current dependency validity is derived at read time: evidence withdrawn
 * after a receipt was recorded keeps the record as history but stops it from
 * counting as a valid read. Stale-scope receipts are preserved the same way.
 *
 * Strict separation from GET-60: this store never writes completion
 * observations, frozen scopes, assessments, claims or reports, and the
 * projection derives no second completion verdict. Enumeration exhaustion and
 * media applicability are read from protocol-conforming GET-60 observations
 * (`isEligibleInvestigation` + explicit `endpoint_exhausted`, frozen
 * `mergeMediaMetadata`); a fetch-layer cursor going null is never exhaustion
 * and unknown media is never treated as completed.
 *
 * Foundation only: no network, provider, worker or runtime wiring. Reads
 * enforce owner/case isolation (owner mismatch reports "not found").
 */

import { randomUUID } from 'node:crypto';

import type { DB } from '../db/index.js';
import type { CaseStore } from './case-store.js';
import type { CompletionStore } from './completion-store.js';
import {
  CaseNotFoundError,
  EvidenceRoleError,
  ForeignReferenceError,
  StaleScopeError,
  asScopeVersion
} from '../../shared/research-case.js';
import type {
  CoverageLocator,
  EvidenceRef,
  EvidenceRole,
  RecordProvenance,
  ScopeVersion
} from '../../shared/research-case.js';
import {
  FETCH_COVERAGE_SCHEMA_VERSION,
  FETCH_DIMENSION_NAMES,
  FETCH_PROCESSING_STATES,
  FETCH_SUCCESS_STATE,
  FetchReceiptConflictError,
  FetchReceiptProtocolError,
  FetchScopeDeniedError,
  fetchDimensionKey,
  fetchReceiptBody,
  inFrozenPublicationWindow,
  validateFetchReceiptDraft
} from '../../shared/research-fetch-coverage.js';
import type {
  FetchAccountCoverage,
  FetchCoverageItemView,
  FetchCoverageView,
  FetchDimensionCounter,
  FetchDimensionName,
  FetchDimensionRef,
  FetchDimensionView,
  FetchEnumerationBasis,
  FetchEnumerationStatus,
  FetchMediaView,
  FetchProcessingReceiptDraft,
  FetchProcessingState,
  FetchReceiptRecord,
  FetchReceiptView,
  ParentContextEntry
} from '../../shared/research-fetch-coverage.js';
import {
  DEFAULT_THREAD_DEPTH,
  isEligibleInvestigation,
  mergeMediaMetadata
} from '../../shared/research-completion.js';
import type {
  CompletionObservation,
  CompletionScopeSpec,
  HistoryEnumerationObservation,
  MediaMetadataEntry
} from '../../shared/research-completion.js';
import { sha256Hex, stableStringify } from './completion-eval.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newRecordId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const SUPPORT_ROLES: ReadonlySet<EvidenceRole> = new Set<EvidenceRole>(['factual_support', 'identity_support']);
const COUNTER_ROLES: ReadonlySet<EvidenceRole> = new Set<EvidenceRole>([
  'factual_counterevidence',
  'identity_counterevidence'
]);

/** Length-prefixed content identity key (collision-free for arbitrary ids). */
function itemKey(accountId: string, sourceId: string, sourceRevision: number): string {
  return `${String(accountId.length)}:${accountId}:${String(sourceId.length)}:${sourceId}:${String(sourceRevision)}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Inputs and results                                                 */
/* ------------------------------------------------------------------ */

export interface RecordFetchReceiptInput {
  ownerId: string;
  caseId: string;
  expectedScopeVersion: ScopeVersion;
  receipt: FetchProcessingReceiptDraft;
}

export interface RecordFetchBatchInput {
  ownerId: string;
  caseId: string;
  expectedScopeVersion: ScopeVersion;
  /** All-or-nothing: one invalid draft rolls the whole batch back. */
  receipts: FetchProcessingReceiptDraft[];
}

export interface FetchReceiptResult {
  receipt: FetchReceiptRecord;
  /** True when the receipt key was already recorded with the same body. */
  replayed: boolean;
}

export interface FetchBatchResult {
  results: FetchReceiptResult[];
}

interface ReceiptRow {
  seq: number;
  id: string;
  case_id: string;
  receipt_key: string;
  scope_version: number;
  account_id: string;
  source_id: string;
  source_revision: number;
  dimension: string;
  branch_key: string | null;
  state: string;
  reason: string | null;
  occurred_at: string;
  parents_json: string;
  evidence_json: string;
  counterevidence_json: string;
  note: string | null;
  synthetic: number;
  provenance_json: string;
  body_hash: string;
  created_at: string;
}

interface ReceiptInfo {
  record: FetchReceiptRecord;
  scopeValidity: 'valid' | 'review';
  scopeReviewReason: string | null;
  dependencyValidity: 'valid' | 'review';
  dependencyReviewReason: string | null;
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

/**
 * Trusted server-side store: callers pass explicit owner/case/scope context
 * and the store validates everything atomically. Nothing here is a model
 * tool surface.
 */
export class FetchCoverageStore {
  constructor(
    private readonly db: DB,
    private readonly cases: CaseStore,
    private readonly completion: CompletionStore
  ) {}

  /** Single transaction boundary for every mutating operation. */
  private write<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* ---------------------------------------------------------------- */
  /* Recording                                                        */
  /* ---------------------------------------------------------------- */

  recordFetchReceipt(input: RecordFetchReceiptInput): FetchReceiptResult {
    return this.recordFetchBatch({
      ownerId: input.ownerId,
      caseId: input.caseId,
      expectedScopeVersion: input.expectedScopeVersion,
      receipts: [input.receipt]
    }).results[0] as FetchReceiptResult;
  }

  /**
   * Atomic batch append. Every draft is validated against the persisted case
   * state before anything is inserted, and any failure rolls back the whole
   * batch (including replayed no-ops), so a batch with invalid references
   * never leaves partial writes.
   */
  recordFetchBatch(input: RecordFetchBatchInput): FetchBatchResult {
    return this.write(() => {
      if (!Array.isArray(input.receipts) || input.receipts.length === 0) {
        throw new FetchReceiptProtocolError('receipt batch must contain at least one draft');
      }
      const caseRecord = this.cases.getCase(input.ownerId, input.caseId);
      if (!caseRecord) throw new CaseNotFoundError(input.caseId);
      if (caseRecord.scopeVersion !== input.expectedScopeVersion) {
        throw new StaleScopeError(input.caseId, input.expectedScopeVersion, caseRecord.scopeVersion);
      }
      const results: FetchReceiptResult[] = [];
      for (const draft of input.receipts) {
        validateFetchReceiptDraft(draft);
        this.validateContentAndRefs(input.caseId, draft);
        const body = fetchReceiptBody(draft);
        const bodyHash = sha256Hex(stableStringify(body));
        const existing = this.db
          .prepare('SELECT * FROM research_case_fetch_receipts WHERE case_id = ? AND receipt_key = ?')
          .get(input.caseId, draft.receiptKey) as ReceiptRow | undefined;
        if (existing) {
          if (existing.body_hash !== bodyHash) {
            throw new FetchReceiptConflictError(draft.receiptKey);
          }
          results.push({ receipt: this.mapReceipt(existing), replayed: true });
          continue;
        }
        const receiptId = newRecordId('fetchrcpt');
        this.db
          .prepare(
            `INSERT INTO research_case_fetch_receipts (
              id, case_id, receipt_key, scope_version, account_id, source_id, source_revision,
              dimension, branch_key, state, reason, occurred_at, parents_json, evidence_json,
              counterevidence_json, note, synthetic, provenance_json, body_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            receiptId,
            input.caseId,
            draft.receiptKey,
            input.expectedScopeVersion,
            draft.content.accountId,
            draft.content.sourceId,
            draft.content.sourceRevision,
            draft.dimension.name,
            draft.dimension.name === 'thread_branch' ? draft.dimension.branchKey : null,
            draft.state,
            draft.reason,
            draft.occurredAt,
            JSON.stringify(body.parents),
            JSON.stringify(body.evidenceIds),
            JSON.stringify(body.counterevidenceIds),
            draft.note,
            draft.synthetic ? 1 : 0,
            JSON.stringify(body.provenance),
            bodyHash,
            nowIso()
          );
        const row = this.db
          .prepare('SELECT * FROM research_case_fetch_receipts WHERE id = ?')
          .get(receiptId) as ReceiptRow;
        results.push({ receipt: this.mapReceipt(row), replayed: false });
      }
      return { results };
    });
  }

  /**
   * Atomic owner/case/account/allowedScope/source-revision/dependency checks
   * for one draft. History processing requires `public_history`; profile-only
   * and none accounts are refused. Foreign references and revoked
   * dependencies are refused outright (later withdrawal is derived at read
   * time and keeps the record as history).
   */
  private validateContentAndRefs(caseId: string, draft: FetchProcessingReceiptDraft): void {
    const account = this.db
      .prepare('SELECT id, allowed_scope_json FROM research_case_accounts WHERE id = ? AND case_id = ?')
      .get(draft.content.accountId, caseId) as { id: string; allowed_scope_json: string } | undefined;
    if (!account) {
      throw new ForeignReferenceError(`account ${draft.content.accountId} is not part of case ${caseId}`);
    }
    const allowedScope = parseJson<{ state?: string }>(account.allowed_scope_json, {}).state ?? 'none';
    if (allowedScope !== 'public_history') {
      throw new FetchScopeDeniedError(
        `account ${draft.content.accountId} has allowedScope ${allowedScope}; history processing requires public_history`
      );
    }
    const source = this.db
      .prepare(
        `SELECT r.revision FROM research_case_source_revisions r
         JOIN research_case_sources s ON s.id = r.source_id
         WHERE r.source_id = ? AND r.revision = ? AND s.case_id = ? AND s.account_id = ?`
      )
      .get(draft.content.sourceId, draft.content.sourceRevision, caseId, draft.content.accountId) as
      | { revision: number }
      | undefined;
    if (!source) {
      throw new ForeignReferenceError(
        `source revision ${draft.content.sourceId}@${String(draft.content.sourceRevision)} is not owned by case ${caseId} account ${draft.content.accountId}`
      );
    }
    for (const evidenceId of draft.evidenceIds) {
      this.requireFreshEvidence(caseId, draft.content.accountId, evidenceId, true);
    }
    for (const evidenceId of draft.counterevidenceIds) {
      this.requireFreshEvidence(caseId, draft.content.accountId, evidenceId, false);
    }
  }

  private requireFreshEvidence(
    caseId: string,
    accountId: string,
    evidenceId: string,
    supportPolarity: boolean
  ): void {
    const row = this.db
      .prepare('SELECT id, role, revoked_at FROM research_case_evidence WHERE id = ? AND case_id = ? AND account_id = ?')
      .get(evidenceId, caseId, accountId) as
      | { id: string; role: string; revoked_at: string | null }
      | undefined;
    if (!row) {
      throw new ForeignReferenceError(`evidence ${evidenceId} is not owned by case ${caseId} account ${accountId}`);
    }
    const roles = supportPolarity ? SUPPORT_ROLES : COUNTER_ROLES;
    if (!roles.has(row.role as EvidenceRole)) {
      throw new EvidenceRoleError(
        `evidence ${evidenceId} has role ${row.role}, expected ${supportPolarity ? 'support' : 'counterevidence'} polarity`
      );
    }
    if (row.revoked_at !== null) {
      throw new ForeignReferenceError(`evidence ${evidenceId} is revoked and cannot be a fresh dependency`);
    }
  }

  private mapReceipt(row: ReceiptRow): FetchReceiptRecord {
    const dimension: FetchDimensionRef =
      row.dimension === 'thread_branch'
        ? { name: 'thread_branch', branchKey: row.branch_key ?? '' }
        : { name: row.dimension as 'body' | 'media' | 'comments' };
    return {
      receiptId: row.id,
      receiptKey: row.receipt_key,
      caseId: row.case_id,
      scopeVersion: asScopeVersion(row.scope_version),
      seq: row.seq,
      content: {
        accountId: row.account_id,
        sourceId: row.source_id,
        sourceRevision: row.source_revision
      },
      dimension,
      state: row.state as FetchProcessingState,
      reason: row.reason,
      parents: parseJson<ParentContextEntry[]>(row.parents_json, []),
      evidenceIds: parseJson<string[]>(row.evidence_json, []),
      counterevidenceIds: parseJson<string[]>(row.counterevidence_json, []),
      occurredAt: row.occurred_at,
      note: row.note,
      synthetic: row.synthetic !== 0,
      provenance: parseJson<RecordProvenance>(row.provenance_json, {
        authorization: 'not_recorded',
        collector: 'unknown',
        note: null
      }),
      bodyHash: row.body_hash,
      createdAt: row.created_at
    };
  }

  /** Trusted read: every receipt of a case in append order. */
  listFetchReceipts(ownerId: string, caseId: string): FetchReceiptRecord[] {
    if (!this.cases.getCase(ownerId, caseId)) return [];
    const rows = this.db
      .prepare('SELECT * FROM research_case_fetch_receipts WHERE case_id = ? ORDER BY seq ASC')
      .all(caseId) as ReceiptRow[];
    return rows.map((row) => this.mapReceipt(row));
  }

  /* ---------------------------------------------------------------- */
  /* Projection                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Read-only projection over persisted state. Derives nothing that writes:
   * no observation, assessment, claim or report is ever created here, and no
   * second completion verdict exists in the result.
   */
  getFetchCoverageView(ownerId: string, caseId: string, scopeSpecId: string): FetchCoverageView | null {
    const caseRecord = this.cases.getCase(ownerId, caseId);
    if (!caseRecord) return null;
    const frozen = this.completion.getCompletionScope(ownerId, caseId, scopeSpecId);
    if (!frozen) return null;
    const report = this.cases.reportView(ownerId, caseId);
    const spec: CompletionScopeSpec = frozen.spec;
    const currentScope = caseRecord.scopeVersion;

    const accountById = new Map(report.accounts.map((account) => [account.accountId, account]));
    const evidenceById = new Map<string, EvidenceRef>(report.evidence.map((entry) => [entry.evidenceId, entry]));
    const publishedByKey = new Map<string, string | null>();
    const latestRevisionBySource = new Map<string, number>();
    for (const source of report.sources) {
      for (const revision of source.revisions) {
        publishedByKey.set(
          itemKey(source.accountId, revision.sourceId, revision.sourceRevision),
          revision.publishedAt
        );
        const latest = latestRevisionBySource.get(revision.sourceId) ?? 0;
        if (revision.sourceRevision > latest) {
          latestRevisionBySource.set(revision.sourceId, revision.sourceRevision);
        }
      }
    }

    // Receipts with separately derived current validity (append order only).
    const receiptRows = this.db
      .prepare('SELECT * FROM research_case_fetch_receipts WHERE case_id = ? ORDER BY seq ASC')
      .all(caseId) as ReceiptRow[];
    const receiptInfos: ReceiptInfo[] = receiptRows.map((row) => {
      const record = this.mapReceipt(row);
      const scopeReasons: string[] = [];
      if (record.scopeVersion !== currentScope) {
        scopeReasons.push(`回执来自范围 v${String(record.scopeVersion)}，当前范围 v${String(currentScope)}`);
      }
      const dependencyReasons: string[] = [];
      for (const [ids, supportPolarity] of [
        [record.evidenceIds, true],
        [record.counterevidenceIds, false]
      ] as const) {
        for (const evidenceId of ids) {
          const problem = evidenceProblem(
            evidenceById.get(evidenceId),
            supportPolarity,
            caseId,
            record.content.accountId
          );
          if (problem !== null) dependencyReasons.push(`${evidenceId} ${problem}`);
        }
      }
      return {
        record,
        scopeValidity: scopeReasons.length > 0 ? 'review' : 'valid',
        scopeReviewReason: scopeReasons.length > 0 ? scopeReasons.join('；') : null,
        dependencyValidity: dependencyReasons.length > 0 ? 'review' : 'valid',
        dependencyReviewReason: dependencyReasons.length > 0 ? dependencyReasons.join('；') : null
      };
    });

    // GET-60 read side: enumeration/media metadata and selected branches.
    const observations = this.completion.listCompletionObservations(ownerId, caseId, scopeSpecId);
    const contentByKey = new Map<string, CoverageLocator>();
    const enumerated = new Map<
      string,
      { accountId: string; sourceId: string; sourceRevision: number; mediaEntries: MediaMetadataEntry[] }
    >();
    const enumerationByAccount = new Map<string, HistoryEnumerationObservation[]>();
    const selectedBranches = new Map<string, Set<string>>();
    const parentEntries = new Map<string, Map<string, ParentContextEntry[]>>();
    const addParents = (key: string, branchKey: string, entries: ParentContextEntry[]): void => {
      let branches = parentEntries.get(key);
      if (!branches) {
        branches = new Map();
        parentEntries.set(key, branches);
      }
      branches.set(branchKey, [...(branches.get(branchKey) ?? []), ...entries]);
    };
    for (const observation of observations) {
      if (observation.action === 'enumerate_history' && observation.obligationRef.kind === 'account_history') {
        const accountId = observation.obligationRef.accountId;
        const list = enumerationByAccount.get(accountId) ?? [];
        list.push(observation);
        enumerationByAccount.set(accountId, list);
        const credible =
          observation.attemptState === 'succeeded' &&
          observation.accessBoundary === null &&
          (observation.stopReason === null || observation.stopReason === 'endpoint_exhausted');
        for (const item of observation.items) {
          const key = itemKey(accountId, item.sourceId, item.sourceRevision);
          contentByKey.set(key, {
            accountId,
            sourceId: item.sourceId,
            sourceRevision: item.sourceRevision
          });
          const existing = enumerated.get(key);
          if (existing) {
            existing.mediaEntries.push({ hasMedia: item.hasMedia, credible });
            continue;
          }
          enumerated.set(key, {
            accountId,
            sourceId: item.sourceId,
            sourceRevision: item.sourceRevision,
            mediaEntries: [{ hasMedia: item.hasMedia, credible }]
          });
        }
        continue;
      }
      const ref = observation.obligationRef;
      if (ref.kind !== 'thread_branch') continue;
      const key = itemKey(ref.accountId, ref.sourceId, ref.sourceRevision);
      contentByKey.set(key, {
        accountId: ref.accountId,
        sourceId: ref.sourceId,
        sourceRevision: ref.sourceRevision
      });
      if (observation.action === 'select_branch') {
        let branches = selectedBranches.get(key);
        if (!branches) {
          branches = new Set();
          selectedBranches.set(key, branches);
        }
        branches.add(ref.branchKey);
        addParents(
          key,
          ref.branchKey,
          observation.parentChain.map((entry) => ({ commentKey: entry.commentKey, state: entry.state }))
        );
      } else if (observation.action === 'read_thread') {
        addParents(
          key,
          ref.branchKey,
          observation.blockers.map((entry) => ({ commentKey: entry.commentKey, state: entry.state }))
        );
      }
    }

    // Group receipts per content identity; every receipted item is content too.
    const receiptsByItem = new Map<string, ReceiptInfo[]>();
    for (const info of receiptInfos) {
      const content = info.record.content;
      const key = itemKey(content.accountId, content.sourceId, content.sourceRevision);
      contentByKey.set(key, content);
      const list = receiptsByItem.get(key) ?? [];
      list.push(info);
      receiptsByItem.set(key, list);
    }

    const allKeys = [...contentByKey.keys()];
    allKeys.sort((a, b) => {
      const left = contentByKey.get(a) as CoverageLocator;
      const right = contentByKey.get(b) as CoverageLocator;
      return (
        compareText(left.accountId, right.accountId) ||
        compareText(left.sourceId, right.sourceId) ||
        left.sourceRevision - right.sourceRevision
      );
    });

    const limitations: string[] = [];
    const items: FetchCoverageItemView[] = allKeys.map((key) => {
      const content = contentByKey.get(key) as CoverageLocator;
      const account = accountById.get(content.accountId);
      const platform = account?.platform ?? 'unknown';
      const publishedAt = publishedByKey.get(key) ?? null;
      const dateKnown = publishedAt !== null;
      const inWindow = inFrozenPublicationWindow(publishedAt, spec.timeRange);
      const inAccountRange = inSpecAccountRange(spec, content.accountId, account?.allowedScope.state ?? 'none');
      const isEnumerated = enumerated.has(key);
      const itemLimitations: string[] = [];
      if (!dateKnown) {
        itemLimitations.push('发布日期未知：保留在冻结时间窗范围内，未按窗外排除。');
      }
      const resolution = mergeMediaMetadata(enumerated.get(key)?.mediaEntries ?? []);
      const media: FetchMediaView = {
        applicability: resolution.state,
        recorded: resolution.recorded,
        conflict: resolution.recorded.length > 1
      };
      if (media.conflict) {
        itemLimitations.push(
          `hasMedia 元数据冲突（${resolution.recorded.join('→')}），媒体义务保留为 ${resolution.state}。`
        );
      }
      const latestRevision = latestRevisionBySource.get(content.sourceId) ?? content.sourceRevision;
      const newerRevisionAvailable =
        latestRevision > content.sourceRevision ? latestRevision : null;
      if (newerRevisionAvailable !== null) {
        itemLimitations.push(
          `来源 ${content.sourceId} 已有更新 revision ${String(newerRevisionAvailable)}；本条处理记录绑定在 revision ${String(content.sourceRevision)}，不传递到新 revision。`
        );
      }
      if (!isEnumerated) {
        itemLimitations.push('处理回执不在 GET-60 枚举集合内（receipt_only）。');
      }

      const itemReceipts = receiptsByItem.get(key) ?? [];
      const dimensions: FetchDimensionView[] = [];
      for (const name of ['body', 'media', 'comments'] as const) {
        dimensions.push(this.dimensionView({ name }, itemReceipts, currentScope, [], false));
      }
      const branchKeys = new Set<string>();
      for (const branchKey of selectedBranches.get(key) ?? []) branchKeys.add(branchKey);
      for (const branchKey of (parentEntries.get(key) ?? new Map()).keys()) branchKeys.add(branchKey);
      for (const info of itemReceipts) {
        if (info.record.dimension.name === 'thread_branch') branchKeys.add(info.record.dimension.branchKey);
      }
      for (const branchKey of [...branchKeys].sort(compareText)) {
        const selection = (selectedBranches.get(key) ?? new Set<string>()).has(branchKey);
        const latestReceiptParents = itemReceipts
          .filter(
            (info) =>
              info.record.dimension.name === 'thread_branch' && info.record.dimension.branchKey === branchKey
          )
          .map((info) => info.record.parents);
        const parents = mergeParentEntries([
          parentEntries.get(key)?.get(branchKey) ?? [],
          latestReceiptParents.length > 0 ? (latestReceiptParents[latestReceiptParents.length - 1] ?? []) : []
        ]);
        const view = this.dimensionView(
          { name: 'thread_branch', branchKey },
          itemReceipts,
          currentScope,
          parents,
          selection
        );
        if (!selection) {
          itemLimitations.push(`thread 分支 ${branchKey} 无 GET-60 select_branch 选择记录（仅处理回执）。`);
        }
        const blockedParents = parents.filter((entry) => entry.state !== 'present');
        if (blockedParents.length > 0) {
          itemLimitations.push(
            `thread 分支 ${branchKey} 父链包含缺失/删除/隐藏节点：${blockedParents
              .map((entry) => `${entry.commentKey}:${entry.state}`)
              .join('；')}`
          );
        }
        if (view.history.some((entry) => entry.state === 'context_missing')) {
          itemLimitations.push(`thread 分支 ${branchKey} 有 context_missing 处理回执：上下文缺失保持显式。`);
        }
        dimensions.push(view);
      }
      if (itemReceipts.some((info) => info.scopeValidity === 'review')) {
        itemLimitations.push('存在旧范围的处理回执：保留为历史，不计为有效读取。');
      }
      return {
        content: { ...content },
        platform,
        publishedAt,
        dateKnown,
        inWindow,
        inAccountRange,
        enumerated: isEnumerated,
        media,
        newerRevisionAvailable,
        dimensions,
        limitations: itemLimitations
      };
    });

    // Per platform/account counters over the frozen publication window.
    const accountIds = [
      ...new Set([...report.accounts.map((account) => account.accountId), ...items.map((item) => item.content.accountId)])
    ];
    accountIds.sort(compareText);
    const accounts: FetchAccountCoverage[] = accountIds.map((accountId) => {
      const account = accountById.get(accountId);
      const accountItems = items.filter((entry) => entry.content.accountId === accountId);
      const enumeration = enumerationStatus(enumerationByAccount.get(accountId) ?? [], spec, evidenceById);
      const enumeratedItems = accountItems.filter((entry) => entry.enumerated).length;
      const receiptOnlyItems = accountItems.filter((entry) => !entry.enumerated).length;
      const outOfWindowItems = accountItems.filter((entry) => !entry.inWindow).length;
      const unknownDateItems = accountItems.filter((entry) => entry.inWindow && !entry.dateKnown).length;
      const inWindowItems = accountItems.filter((entry) => entry.inWindow).length;
      const inScopeItems = accountItems.filter((entry) => entry.inWindow && entry.inAccountRange);
      const outOfRangeItems = accountItems.filter((entry) => entry.inWindow && !entry.inAccountRange).length;
      const denominatorKnown = enumeration.exhausted;
      const accountLimitations: string[] = [];
      if (!denominatorKnown) {
        accountLimitations.push(`枚举未耗尽（${enumeration.basis}）：分母未知，所有维度 percent 为 null。`);
      } else if (inScopeItems.length === 0) {
        accountLimitations.push('分母为 0：percent 保持 null，不显示 100%。');
      }
      if (unknownDateItems > 0) {
        accountLimitations.push(`${String(unknownDateItems)} 项发布日期未知，保留在冻结时间窗内。`);
      }
      if (outOfWindowItems > 0) {
        accountLimitations.push(`${String(outOfWindowItems)} 项超出冻结时间窗，未计入窗口计数。`);
      }
      if (outOfRangeItems > 0) {
        accountLimitations.push(`${String(outOfRangeItems)} 项不在冻结账号范围内，未计入分母。`);
      }
      if (receiptOnlyItems > 0) {
        accountLimitations.push(`${String(receiptOnlyItems)} 项只有处理回执而不在 GET-60 枚举集合内。`);
      }
      const dimensions: FetchDimensionCounter[] = FETCH_DIMENSION_NAMES.map((name) => {
        const views: FetchDimensionView[] = [];
        for (const item of inScopeItems) {
          for (const dimension of item.dimensions) {
            if (dimension.dimension.name === name) views.push(dimension);
          }
        }
        const states = Object.fromEntries(
          FETCH_PROCESSING_STATES.map((state) => [state, 0])
        ) as Record<FetchProcessingState, number>;
        for (const view of views) states[view.state] += 1;
        const validReads = views.filter((view) => view.countsAsValidRead).length;
        // Credible media absence satisfies the media instance only when no
        // valid read already satisfies it (never double counted).
        const satisfiedByAbsence =
          name === 'media'
            ? inScopeItems.filter((entry) => {
                const mediaView = entry.dimensions.find((dimension) => dimension.dimension.name === 'media');
                return entry.media.applicability === 'none' && !(mediaView?.countsAsValidRead ?? false);
              }).length
            : 0;
        const satisfied = validReads + satisfiedByAbsence;
        const instances = views.length;
        const percent =
          denominatorKnown && instances > 0 ? Math.round((satisfied * 1000) / instances) / 10 : null;
        return {
          dimension: name,
          instances,
          states,
          validReads,
          satisfiedByAbsence,
          satisfied,
          percent
        };
      });
      return {
        accountId,
        platform: account?.platform ?? 'unknown',
        allowedScope: account?.allowedScope.state ?? 'none',
        inAccountRange: inSpecAccountRange(spec, accountId, account?.allowedScope.state ?? 'none'),
        enumeration,
        enumeratedItems,
        receiptOnlyItems,
        inWindowItems,
        unknownDateItems,
        outOfWindowItems,
        outOfRangeItems,
        denominatorKnown,
        total: denominatorKnown ? inScopeItems.length : null,
        dimensions,
        limitations: accountLimitations
      };
    });

    if (items.some((entry) => !entry.dateKnown)) {
      limitations.push('存在发布日期未知的条目：保留在冻结时间窗内，未按窗外排除。');
    }
    if (receiptInfos.some((info) => info.scopeValidity === 'review')) {
      limitations.push('存在旧范围的处理回执：保留为历史，不计为有效读取。');
    }
    if (receiptInfos.some((info) => info.dependencyValidity === 'review')) {
      limitations.push('存在依赖已撤回/缺失的处理回执：保留为历史，不计为有效读取。');
    }
    if (items.some((entry) => entry.media.conflict)) {
      limitations.push('存在 hasMedia 元数据冲突：按冻结合并规则保留，矛盾不被抹平。');
    }
    if (items.some((entry) => entry.newerRevisionAvailable !== null)) {
      limitations.push('存在来源更新 revision：旧 revision 的处理记录不传递到新 revision。');
    }
    if (!accounts.some((account) => account.enumeration.exhausted)) {
      limitations.push('没有任何账号的枚举达到协议耗尽：计数只是已见内容的处理覆盖，不是完整历史覆盖。');
    }

    return {
      schemaVersion: FETCH_COVERAGE_SCHEMA_VERSION,
      caseId,
      scopeSpecId,
      currentScopeVersion: currentScope,
      window: { from: spec.timeRange.from, to: spec.timeRange.to },
      threadDepth: spec.threadDepth > 0 ? spec.threadDepth : DEFAULT_THREAD_DEPTH,
      accounts,
      items,
      limitations
    };
  }

  /** One dimension instance with its append-order supersession and history. */
  private dimensionView(
    dimensionRef: FetchDimensionRef,
    itemReceipts: ReceiptInfo[],
    currentScope: ScopeVersion,
    parents: ParentContextEntry[],
    branchSelected: boolean
  ): FetchDimensionView {
    const wantedKey = fetchDimensionKey(dimensionRef);
    const history = itemReceipts.filter(
      (info) => fetchDimensionKey(info.record.dimension) === wantedKey
    );
    const currentScopeHistory = history.filter((info) => info.record.scopeVersion === currentScope);
    const pick =
      currentScopeHistory.length > 0
        ? currentScopeHistory[currentScopeHistory.length - 1]
        : history.length > 0
          ? history[history.length - 1]
          : null;
    if (pick === undefined || pick === null) {
      return {
        dimension: dimensionRef,
        state: 'unread',
        reason: '尚无处理回执（派生基线）',
        countsAsValidRead: false,
        scopeValidity: 'valid',
        dependencyValidity: 'valid',
        staleReasons: [],
        branchSelected,
        parents,
        history: []
      };
    }
    const staleReasons = [pick.scopeReviewReason, pick.dependencyReviewReason].filter(
      (reason): reason is string => reason !== null
    );
    const historyViews: FetchReceiptView[] = history.map((info) => ({
      ...info.record,
      scopeValidity: info.scopeValidity,
      scopeReviewReason: info.scopeReviewReason,
      dependencyValidity: info.dependencyValidity,
      dependencyReviewReason: info.dependencyReviewReason
    }));
    return {
      dimension: dimensionRef,
      state: pick.record.state,
      reason: pick.record.reason,
      countsAsValidRead:
        pick.record.state === FETCH_SUCCESS_STATE &&
        pick.scopeValidity === 'valid' &&
        pick.dependencyValidity === 'valid',
      scopeValidity: pick.scopeValidity,
      dependencyValidity: pick.dependencyValidity,
      staleReasons,
      branchSelected,
      parents,
      history: historyViews
    };
  }
}

/* ------------------------------------------------------------------ */
/* Pure derivation helpers                                            */
/* ------------------------------------------------------------------ */

function inSpecAccountRange(
  spec: CompletionScopeSpec,
  accountId: string,
  allowedScope: string
): boolean {
  return spec.accountRange.mode === 'explicit'
    ? spec.accountRange.accountIds.includes(accountId)
    : allowedScope === 'public_history';
}

function evidenceProblem(
  evidence: EvidenceRef | undefined,
  supportPolarity: boolean,
  caseId: string,
  accountId: string
): string | null {
  if (!evidence) return '不在案';
  if (evidence.revokedAt !== null) return '已撤回';
  const roles = supportPolarity ? SUPPORT_ROLES : COUNTER_ROLES;
  if (!roles.has(evidence.role)) return '角色不符';
  if (evidence.caseId !== caseId || evidence.accountId !== accountId) return '不属于该内容账号';
  return null;
}

/**
 * Deterministic parent-state merge: GET-60 `select_branch` parent chains,
 * `read_thread` blockers and the latest thread receipt. Distinct states for
 * one comment key are all kept so contradictions stay visible instead of
 * being smoothed over.
 */
function mergeParentEntries(groups: ParentContextEntry[][]): ParentContextEntry[] {
  const seen = new Set<string>();
  const merged: ParentContextEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      const key = `${String(entry.commentKey.length)}:${entry.commentKey}:${entry.state}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  const rank: Record<string, number> = { missing: 0, deleted: 1, hidden: 2, present: 3 };
  return merged.sort(
    (a, b) => compareText(a.commentKey, b.commentKey) || (rank[a.state] ?? 4) - (rank[b.state] ?? 4)
  );
}

/**
 * Current enumeration state of one account, mirroring the frozen GET-60
 * establishment order (attempt state, current dependency validity, cursor,
 * known gaps, blocking stop reason, access boundary, explicit exhaustion).
 * Exhaustion requires a protocol-conforming observation: succeeded, unblocked,
 * no access boundary and an explicit `endpoint_exhausted` — a null cursor
 * alone never establishes it. Transitive predecessor chains stay the GET-60
 * evaluator's authority (documented limitation).
 */
function enumerationStatus(
  observations: HistoryEnumerationObservation[],
  spec: CompletionScopeSpec,
  evidenceById: Map<string, EvidenceRef>
): FetchEnumerationStatus {
  const latest = observations.length > 0 ? observations[observations.length - 1] : undefined;
  if (latest === undefined) {
    return { exhausted: false, basis: 'no_observation', openCursor: false, knownGaps: [], observationId: null };
  }
  const base = {
    observationId: latest.observationId,
    openCursor: latest.nextCursor !== null,
    knownGaps: [...latest.knownGaps]
  };
  const done = (exhausted: boolean, basis: FetchEnumerationBasis): FetchEnumerationStatus => ({
    exhausted,
    basis,
    ...base
  });
  if (latest.attemptState === 'failed') return done(false, 'failed');
  if (latest.attemptState === 'cancelled') return done(false, 'cancelled');
  if (latest.attemptState === 'needs_input') return done(false, 'needs_input');
  if (!observationDepsValid(latest, evidenceById)) return done(false, 'dependency_withdrawn');
  if (latest.nextCursor !== null) return done(false, 'cursor_open');
  if (latest.knownGaps.length > 0) return done(false, 'known_gap');
  if (latest.stopReason !== null && latest.stopReason !== 'endpoint_exhausted') return done(false, 'blocked');
  if (latest.accessBoundary !== null) return done(false, 'access_boundary');
  if (latest.stopReason === 'endpoint_exhausted' && isEligibleInvestigation(latest, spec)) {
    return done(true, 'endpoint_exhausted');
  }
  return done(false, 'not_exhausted');
}

/** Light current-dependency check for the establishing enumeration receipt. */
function observationDepsValid(
  observation: CompletionObservation,
  evidenceById: Map<string, EvidenceRef>
): boolean {
  const ref = observation.obligationRef;
  const accountId = 'accountId' in ref ? ref.accountId : null;
  for (const [ids, supportPolarity] of [
    [observation.refs.evidenceIds, true],
    [observation.refs.counterevidenceIds, false]
  ] as const) {
    for (const evidenceId of ids) {
      if (accountId === null) return false;
      if (evidenceProblem(evidenceById.get(evidenceId), supportPolarity, observation.caseId, accountId) !== null) {
        return false;
      }
    }
  }
  return true;
}
