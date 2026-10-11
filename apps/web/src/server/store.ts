import {nativeOrganizationKeys} from './research/native-account-kind.js';
import { genreReviewIssue } from './research/quote-genre.js';
import { researchDepthCoverage, claimEvidenceIssue, presentedResearchUnknowns } from '../shared/research-depth.js';
import { classifyFirstStepUrl, type FirstStepDiscoveryView } from '../shared/first-step-discovery.js';
import { createHash } from 'node:crypto';
import { newRecordId as newId, nowIso, parseJson } from './db/row-helpers.js';

export { nowIso, newId };
import { ResearchStore, type FirstStepBinding } from './research/research-store.js';
import { CaseStore } from './research/case-store.js';
import {identitySemanticReviewAccounts} from './research/identity-semantic-validity.js';
import { CompletionStore } from './research/completion-store.js';
import { FetchCoverageStore } from './research/fetch-coverage-store.js';
import type {
  AnswerSectionDraft,
  CanonicalView,
  IdentityDraft,
  ObservationDraft,
  ProviderName,
  RunEventRecord,
  RunState,
  SourceDraft,
  SourceKind,
  ClaimKind,
  FetchStatus,
  CanonicalSource,
  CanonicalObservation,
  CanonicalAnswerSection,
  CanonicalIdentity,
  CanonicalUsage,
  RunSummary
} from '../shared/types.js';
import { SCHEMA_VERSION, isTerminalState } from '../shared/types.js';
import {
  countReviewItems,
  excludedSourceKeys,
  providerLabel,
  reviewReason,
  stateLabel,
  validityFor
} from '../shared/canonical.js';
import type { DB } from './db/index.js';

interface RunRow {
  id: string;
  owner_id: string;
  parent_run_id: string | null;
  retry_of: string | null;
  followup: number;
  state: RunState;
  question: string;
  seed_url: string | null;
  provider: ProviderName;
  idempotency_key: string | null;
  body_fingerprint: string;
  revision: number;
  identity_json: string;
  answer_json: string;
  limitations_json: string;
  usage_json: string;
  stop_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  interrupted: number;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  deleted_at: string | null;
}

interface SourceRow {
  id: string;
  run_id: string;
  source_key: string;
  url: string;
  title: string;
  kind: SourceKind;
  published_at: string | null;
  retrieved_at: string;
  fetch_status: FetchStatus;
  excerpt: string | null;
  excerpt_locator: string | null;
  identity_label: string;
  identity_confirmed: number;
  limits_json: string;
  excluded: number;
  excluded_at: string | null;
  sort_order: number;
  created_at: string;
}

interface ObservationRow {
  id: string;
  run_id: string;
  statement: string;
  kind: ClaimKind;
  source_keys_json: string;
  limitations_json: string;
  sort_order: number;
  created_at: string;
}

interface EventRow {
  id: number;
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface RunRecord {
  id: string;
  ownerId: string;
  parentRunId: string | null;
  retryOf: string | null;
  followup: boolean;
  state: RunState;
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  idempotencyKey: string | null;
  bodyFingerprint: string;
  revision: number;
  identity: IdentityDraft;
  answer: AnswerSectionDraft[];
  limitations: string[];
  usage: CanonicalUsage;
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  interrupted: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const EMPTY_IDENTITY: IdentityDraft = {
  displayName: '',
  handle: null,
  profileUrl: null,
  status: 'needs_input',
  note: null,
  candidates: []
};

const EMPTY_USAGE: CanonicalUsage = {
  provider: 'github',
  requests: 0,
  bytes: 0,
  elapsedMs: null,
  measurement: 'not_run'
};


function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    parentRunId: row.parent_run_id,
    retryOf: row.retry_of,
    followup: row.followup === 1,
    state: row.state,
    question: row.question,
    seedUrl: row.seed_url,
    provider: row.provider,
    idempotencyKey: row.idempotency_key,
    bodyFingerprint: row.body_fingerprint,
    revision: row.revision,
    identity: parseJson<IdentityDraft>(row.identity_json, EMPTY_IDENTITY),
    answer: parseJson<AnswerSectionDraft[]>(row.answer_json, []),
    limitations: parseJson<string[]>(row.limitations_json, []),
    usage: parseJson<CanonicalUsage>(row.usage_json, EMPTY_USAGE),
    stopReason: row.stop_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    interrupted: row.interrupted === 1,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function mapSource(row: SourceRow): CanonicalSource {
  return {
    sourceKey: row.source_key,
    url: row.url,
    title: row.title,
    kind: row.kind,
    publishedAt: row.published_at,
    retrievedAt: row.retrieved_at,
    fetchStatus: row.excluded ? 'excluded' : row.fetch_status,
    excerpt: row.excerpt,
    excerptLocator: row.excerpt_locator,
    identityLabel: row.identity_label,
    identityConfirmed: row.identity_confirmed === 1,
    limits: parseJson<string[]>(row.limits_json, []),
    excluded: row.excluded === 1,
    excludedAt: row.excluded_at
  };
}

export class RunTerminalError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is no longer writable`);
    this.name = 'RunTerminalError';
  }
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} not found`);
    this.name = 'RunNotFoundError';
  }
}

export interface CreateRunInput {
  ownerId: string;
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  parentRunId: string | null;
  retryOf: string | null;
  followup: boolean;
  idempotencyKey: string | null;
  bodyFingerprint: string;
  identity?: IdentityDraft;
}

export class Store {
  readonly research: ResearchStore;
  readonly cases: CaseStore;
  /** GET-60 frozen scope / completion policy foundations (same lifetime). */
  readonly completion: CompletionStore;
  /** GET-95 fetch processing coverage receipts and projection (same lifetime). */
  readonly fetchCoverage: FetchCoverageStore;
  constructor(private readonly db: DB) {
    this.research = new ResearchStore(db);
    this.cases = new CaseStore(db);
    this.completion = new CompletionStore(db, this.cases);
    this.fetchCoverage = new FetchCoverageStore(db, this.cases, this.completion);
  }

  /**
   * Named controller-side transaction boundary: one atomic multi-store fold
   * (case evidence, GET-60 observations, GET-95 receipts, local originals,
   * pipeline checkpoint) across the stores sharing this database. Nested
   * store writes join this transaction; a throw rolls every derived write
   * back together. The callback must be synchronous (better-sqlite3 transaction API);
   * async/provider work belongs outside the fold. Callers never reach into the private DB handle.
   */
  inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insertRun(input: CreateRunInput): RunRecord {
    const timestamp = nowIso();
    const id = newId('run');
    const identity = input.identity ?? { ...EMPTY_IDENTITY, displayName: '' };
    this.db
      .prepare(
        `INSERT INTO runs (
          id, owner_id, parent_run_id, retry_of, followup, state, question, seed_url, provider,
          idempotency_key, body_fingerprint, revision, identity_json, answer_json, limitations_json,
          usage_json, stop_reason, error_code, error_message, interrupted, cancel_requested,
          created_at, updated_at, started_at, finished_at, deleted_at
        ) VALUES (
          @id, @owner_id, @parent_run_id, @retry_of, @followup, @state, @question, @seed_url, @provider,
          @idempotency_key, @body_fingerprint, @revision, @identity_json, @answer_json, @limitations_json,
          @usage_json, @stop_reason, @error_code, @error_message, @interrupted, @cancel_requested,
          @created_at, @updated_at, @started_at, @finished_at, @deleted_at
        )`
      )
      .run({
        id,
        owner_id: input.ownerId,
        parent_run_id: input.parentRunId,
        retry_of: input.retryOf,
        followup: input.followup ? 1 : 0,
        state: 'queued',
        question: input.question,
        seed_url: input.seedUrl,
        provider: input.provider,
        idempotency_key: input.idempotencyKey,
        body_fingerprint: input.bodyFingerprint,
        revision: 1,
        identity_json: JSON.stringify(identity),
        answer_json: JSON.stringify([]),
        limitations_json: JSON.stringify([]),
        usage_json: JSON.stringify({ ...EMPTY_USAGE, provider: input.provider }),
        stop_reason: null,
        error_code: null,
        error_message: null,
        interrupted: 0,
        cancel_requested: 0,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: null,
        finished_at: null,
        deleted_at: null
      });
    const created = this.getRun(id);
    if (!created) throw new Error('failed to insert run');
    return created;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE id = ? AND deleted_at IS NULL')
      .get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  getRunForOwner(id: string, ownerId: string): RunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(id, ownerId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRunsForOwner(ownerId: string, limit = 60): RunRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?'
      )
      .all(ownerId, limit) as RunRow[];
    return rows.map(mapRun);
  }

  countRunsForOwner(ownerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND deleted_at IS NULL')
      .get(ownerId) as { n: number };
    return row.n;
  }

  findIdempotencyKey(ownerId: string, key: string): { fingerprint: string; runId: string } | null {
    const row = this.db
      .prepare('SELECT fingerprint, run_id FROM idempotency_keys WHERE owner_id = ? AND key = ?')
      .get(ownerId, key) as { fingerprint: string; run_id: string } | undefined;
    return row ? { fingerprint: row.fingerprint, runId: row.run_id } : null;
  }

  recordIdempotencyKey(ownerId: string, key: string, fingerprint: string, runId: string): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys (owner_id, key, fingerprint, run_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, key) DO NOTHING`
      )
      .run(ownerId, key, fingerprint, runId, nowIso());
  }

  updateRun(id: string, fields: Record<string, unknown>): number {
    const keys = Object.keys(fields);
    if (keys.length === 0) return 0;
    const sets = keys.map((key) => `${key} = @${key}`).join(', ');
    const info = this.db
      .prepare(`UPDATE runs SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...fields, updated_at: nowIso(), id });
    return info.changes;
  }

  /** Writes progress only while the run is still writable; late results are dropped. */
  updateRunIfActive(id: string, fields: Record<string, unknown>): number {
    const keys = Object.keys(fields);
    if (keys.length === 0) return 0;
    const sets = keys.map((key) => `${key} = @${key}`).join(', ');
    const info = this.db
      .prepare(
        `UPDATE runs SET ${sets}, updated_at = @updated_at
         WHERE id = @id AND deleted_at IS NULL AND state IN ('queued', 'researching', 'needs_input')`
      )
      .run({ ...fields, updated_at: nowIso(), id });
    return info.changes;
  }

  setRunState(id: string, state: RunState, extra: Record<string, unknown> = {}): void {
    const fields: Record<string, unknown> = { state, ...extra };
    if (isTerminalState(state)) fields.finished_at = nowIso();
    if (state === 'researching') fields.started_at = extra.started_at ?? nowIso();
    this.updateRunIfActive(id, fields);
  }

  /** Cancel is allowed from any non-terminal state and is idempotent. */
  requestCancel(id: string): boolean {
    const run = this.getRun(id);
    if (!run) return false;
    this.updateRun(id, { cancel_requested: 1 });
    if (!isTerminalState(run.state)) {
      this.updateRun(id, { state: 'cancelled', stop_reason: 'cancelled', finished_at: nowIso() });
      return true;
    }
    return false;
  }

  private bumpDependentRevisions(runId: string, ownerId: string): void {
    const queue = [runId]; const visited = new Set(queue);
    while (queue.length) {
      const parent = queue.shift()!;
      const children = this.db.prepare('SELECT id FROM runs WHERE parent_run_id=? AND owner_id=? AND deleted_at IS NULL').all(parent, ownerId) as {id:string}[];
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id); queue.push(child.id);
        this.db.prepare('UPDATE runs SET revision=revision+1,updated_at=? WHERE id=?').run(nowIso(),child.id);
        const updated = this.getRun(child.id);
        this.addEvent(child.id,'revision',{revision:updated?.revision,reason:'parent_dependency_changed'});
      }
    }
  }

  deleteRun(id: string): boolean {
    const run = this.getRun(id);
    if (run) this.bumpDependentRevisions(id,run.ownerId);
    const info = this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
    return info.changes > 0;
  }

  addEvent(runId: string, type: string, payload: unknown): RunEventRecord {
    const createdAt = nowIso();
    const nextSeq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM run_events WHERE run_id = ?')
        .get(runId) as { n: number }
    ).n;
    this.db
      .prepare(
        'INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(runId, nextSeq, type, JSON.stringify(payload ?? null), createdAt);
    return { seq: nextSeq, type, payload: payload ?? null, createdAt };
  }

  listEvents(runId: string, afterSeq = 0, limit = 1000): RunEventRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      )
      .all(runId, afterSeq, limit) as EventRow[];
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: row.created_at
    }));
  }

  latestSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE run_id = ?')
      .get(runId) as { n: number };
    return row.n;
  }

  addSource(runId: string, draft: SourceDraft, sortOrder: number, excluded = false): void {
    this.db
      .prepare(
        `INSERT INTO sources (
          id, run_id, source_key, url, title, kind, published_at, retrieved_at, fetch_status,
          excerpt, excerpt_locator, identity_label, identity_confirmed, limits_json,
          excluded, excluded_at, sort_order, created_at
        ) VALUES (
          @id, @run_id, @source_key, @url, @title, @kind, @published_at, @retrieved_at, @fetch_status,
          @excerpt, @excerpt_locator, @identity_label, @identity_confirmed, @limits_json,
          @excluded, @excluded_at, @sort_order, @created_at
        )
        ON CONFLICT(run_id, source_key) DO UPDATE SET
          url = excluded.url,
          title = excluded.title,
          kind = excluded.kind,
          published_at = excluded.published_at,
          retrieved_at = excluded.retrieved_at,
          fetch_status = excluded.fetch_status,
          excerpt = excluded.excerpt,
          excerpt_locator = excluded.excerpt_locator,
          identity_label = excluded.identity_label,
          identity_confirmed = excluded.identity_confirmed,
          limits_json = excluded.limits_json`
      )
      .run({
        id: newId('src'),
        run_id: runId,
        source_key: draft.key,
        url: draft.url,
        title: draft.title,
        kind: draft.kind,
        published_at: draft.publishedAt,
        retrieved_at: nowIso(),
        fetch_status: draft.fetchStatus,
        excerpt: draft.excerpt,
        excerpt_locator: draft.excerptLocator,
        identity_label: draft.identityLabel,
        identity_confirmed: draft.identityConfirmed ? 1 : 0,
        limits_json: JSON.stringify(draft.limits),
        excluded: excluded ? 1 : 0,
        excluded_at: excluded ? nowIso() : null,
        sort_order: sortOrder,
        created_at: nowIso()
      });
  }

  /**
   * Replace the whole source set with the provider's canonical result, keeping
   * any exclusion the user already applied by source key.
   */
  replaceSources(runId: string, drafts: SourceDraft[]): void {
    const excludedKeys = new Set(
      this.listSources(runId)
        .filter((source) => source.excluded)
        .map((source) => source.sourceKey)
    );
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sources WHERE run_id = ?').run(runId);
      drafts.forEach((draft, index) => this.addSource(runId, draft, index, excludedKeys.has(draft.key)));
    });
    tx();
  }

  listSources(runId: string): CanonicalSource[] {
    const rows = this.db
      .prepare('SELECT * FROM sources WHERE run_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(runId) as SourceRow[];
    return rows.map(mapSource);
  }

  getSource(runId: string, sourceKey: string): CanonicalSource | null {
    const row = this.db
      .prepare('SELECT * FROM sources WHERE run_id = ? AND source_key = ?')
      .get(runId, sourceKey) as SourceRow | undefined;
    return row ? mapSource(row) : null;
  }

  setSourceExcluded(runId: string, sourceKey: string, excluded: boolean): boolean {
    const previous = this.getSource(runId,sourceKey);
    const info = this.db
      .prepare(
        'UPDATE sources SET excluded = ?, excluded_at = ? WHERE run_id = ? AND source_key = ?'
      )
      .run(excluded ? 1 : 0, excluded ? nowIso() : null, runId, sourceKey);
    const run = this.getRun(runId);
    if (run && previous && previous.excluded !== excluded) this.bumpDependentRevisions(runId,run.ownerId);
    return info.changes > 0;
  }

  clearRunContent(runId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sources WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM observations WHERE run_id = ?').run(runId);
      this.db
        .prepare(
          "UPDATE runs SET answer_json = '[]', limitations_json = '[]', identity_json = ?, updated_at = ? WHERE id = ?"
        )
        .run(JSON.stringify(EMPTY_IDENTITY), nowIso(), runId);
    });
    tx();
  }

  clearObservations(runId: string): void {
    this.db.prepare('DELETE FROM observations WHERE run_id = ?').run(runId);
  }

  addObservation(runId: string, draft: ObservationDraft, sortOrder: number): void {
    this.db
      .prepare(
        `INSERT INTO observations (id, run_id, statement, kind, source_keys_json, limitations_json, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        newId('obs'),
        runId,
        draft.statement,
        draft.kind,
        JSON.stringify(draft.sourceKeys),
        JSON.stringify(draft.limitations),
        sortOrder,
        nowIso()
      );
  }

  listObservations(runId: string): CanonicalObservation[] {
    const rows = this.db
      .prepare('SELECT * FROM observations WHERE run_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(runId) as ObservationRow[];
    const excluded = excludedSourceKeys(this.listSources(runId));
    return rows.map((row) => {
      const sourceKeys = parseJson<string[]>(row.source_keys_json, []);
      const reason = reviewReason(sourceKeys, excluded);
      return {
        observationId: row.id,
        statement: row.statement,
        kind: row.kind,
        sourceKeys,
        limitations: parseJson<string[]>(row.limitations_json, []),
        validity: validityFor(sourceKeys, excluded),
        reviewReason: reason
      };
    });
  }

  /** Follow-up provenance is transitive; cycles, deleted ancestors and owner mismatches fail closed. */
  isFirstStepScopeActive(ownerId: string, binding: FirstStepBinding): boolean {
    const currentCase = this.cases.getCase(ownerId, binding.caseId);
    if (!currentCase || currentCase.scopeVersion !== binding.scopeVersion) return false;
    const current = new Map(this.cases.listAccounts(ownerId, binding.caseId).map(account => [account.accountId, account]));
    return binding.selectedAccountIds.length > 0 && binding.selectedAccountIds.every(id => {
      const frozen = binding.accounts.find(account => account.accountId === id);
      const account = current.get(id);
      const ref = account?.profileUrl ? classifyFirstStepUrl(account.profileUrl) : null;
      return Boolean(frozen && account && ref?.ok && ref.ref.accountKey === frozen.accountKey &&
        binding.accountKeys[frozen.accountKey] === id &&
        account.userSelection.state === (binding.independentAccountIds.includes(id) ? 'only_this_account' : 'selected') &&
        account.allowedScope.state === frozen.allowedScope);
    });
  }

  /** Frozen authorization is separate from person identity, including descendant reports. */
  isResearchScopeActive(runId: string, ownerId: string, visited = new Set<string>(), accountIds = new Set<string>()): boolean {
    if (visited.has(runId)) return false;
    const run = this.getRunForOwner(runId, ownerId);
    if (!run) return false;
    const seen = new Set(visited); seen.add(runId);
    const binding = this.research.checkpoint(runId)?.firstStep;
    const dependencies = new Set(accountIds);
    if (binding) {
      if (!this.isFirstStepScopeActive(ownerId, binding)) return false;
      for (const accountId of new Set([...binding.selectedAccountIds, ...(binding.identityDependencyAccountIds ?? [])])) {
        dependencies.add(accountId);
      }
    }
    for (const accountId of dependencies) {
      if (this.db.prepare('SELECT id FROM first_step_exclusions WHERE run_id=? AND account_id=? AND revoked_at IS NULL').get(runId, accountId)) return false;
    }
    return [run.parentRunId, run.retryOf].every(parent => !parent || this.isResearchScopeActive(parent, ownerId, seen, dependencies));
  }

  private isIndependentResearchPage(runId: string, url: string): boolean {
    const binding = this.research.checkpoint(runId)?.firstStep;
    const ref = classifyFirstStepUrl(url);
    return Boolean(binding && ref.ok && binding.independentAccountIds.includes(binding.accountKeys[ref.ref.accountKey] ?? ''));
  }

  isResearchSourceActive(runId: string, sourceKey: string, ownerId: string, visited = new Set<string>()): boolean {
    const key = `${runId}:${sourceKey}`;
    if (visited.has(key)) return false;
    const seen = new Set(visited); seen.add(key);
    const run = this.getRunForOwner(runId, ownerId);
    const source = run ? this.getSource(runId, sourceKey) : null;
    if (!run || !source || source.excluded || !this.isResearchScopeActive(runId, ownerId)) return false;
    const checkpoint = this.research.checkpoint(runId);
    const page = checkpoint?.pages.find(page => page.sourceKey === sourceKey);
    const anchor = checkpoint?.pages.find(page => page.url === checkpoint.anchorUrl);
    if (anchor && anchor.sourceKey !== sourceKey && !this.isIndependentResearchPage(runId, source.url) && !this.isResearchSourceActive(runId, anchor.sourceKey, ownerId, seen)) return false;
    if (page?.discoveredFrom?.length && !page.discoveredFrom.some(parentKey => this.isResearchSourceActive(runId, parentKey, ownerId, seen))) return false;
    return !page?.inheritedFrom || this.isResearchSourceActive(page.inheritedFrom.runId, page.inheritedFrom.sourceKey, ownerId, seen);
  }

  /** Person attribution can depend on an unselected intermediate identity anchor. */
  isFirstStepIdentityActive(ownerId: string, binding: FirstStepBinding): boolean {
    const merged = new Set(binding.selectedAccountIds.filter(id => !binding.independentAccountIds.includes(id)));
    if (merged.size === 0) return true;
    if (!this.cases.getCase(ownerId, binding.caseId)) return false;
    const report=this.cases.reportView(ownerId,binding.caseId);
    const semanticReview=identitySemanticReviewAccounts(this.db,report);
    const organizationKeys=nativeOrganizationKeys(this.db,ownerId,binding.caseId);
    const conflicted=new Set<string>();
    const rows=this.db.prepare(`SELECT d.view_json FROM first_step_discoveries d JOIN first_step_links l ON l.run_id=d.run_id WHERE l.case_id=? AND d.discovery_revision=(SELECT MAX(latest.discovery_revision) FROM first_step_discoveries latest WHERE latest.run_id=d.run_id)`).all(binding.caseId) as Array<{view_json:string}>;
    for(const row of rows){
      try{const view=JSON.parse(row.view_json) as FirstStepDiscoveryView;for(const account of view.accounts??[]){if(account.identity.conflicts.length||account.identity.nativeIdConflict||(account.accountKind==='organization'||organizationKeys.has(account.accountKey)))conflicted.add(account.accountId);}}catch{return false;}
    }
    const current = new Map(report.accounts.map(account => [account.accountId, account]));
    return [...new Set(binding.identityDependencyAccountIds ?? merged)].every(id => {
      const account = current.get(id);
      return account && !semanticReview.has(id) && !conflicted.has(id) && account.identitySupport.counterevidenceIds.length===0 && account.identityValidity === 'valid' && !['disputed', 'rejected', 'revoked'].includes(account.identitySupport.state);
    });
  }

  buildCanonicalView(run: RunRecord): CanonicalView {
    const checkpoint = run.provider === 'research' ? this.research.checkpoint(run.id) : null;
    const scopeChanged = Boolean(checkpoint && !this.isResearchScopeActive(run.id, run.ownerId));
    const scopeReason = '已冻结的账号研究范围已变更或撤回；原资料保留，相关结论需要重新核对。';
    const identityChanged = Boolean(checkpoint?.firstStep && !this.isFirstStepIdentityActive(run.ownerId, checkpoint.firstStep));
    const identityReason = '人物关联的归属依据已失效；原资料保留，人物结论需要重新核对。';
    const sources = this.listSources(run.id).map(source => checkpoint && !this.isResearchSourceActive(run.id, source.sourceKey, run.ownerId)
      ? { ...source, excluded: true, fetchStatus: 'excluded' as const }
      : identityChanged ? { ...source, identityConfirmed: false, identityLabel: '人物归属待复核；账号自身原资料保留。' } : source);
    const excluded = excludedSourceKeys(sources);
    const anchorRevoked = Boolean(checkpoint?.anchorUrl && !this.isIndependentResearchPage(run.id, checkpoint.anchorUrl) && sources.some(source => source.url === checkpoint.anchorUrl && source.excluded));
    // Projection never rewrites checkpoint claims or supplier receipts. Policy
    // checks are shared with verification, including on terminal reopens/exports.
    const evidenceIssue=(claim:NonNullable<typeof checkpoint>['claims'][number]):string|null=>{
      const page=checkpoint?.pages.find(p=>p.sourceKey===claim.sourceKey),source=sources.find(s=>s.sourceKey===claim.sourceKey&&!s.excluded);
      return claimEvidenceIssue(claim,checkpoint?.quoteSupportPolicy)??genreReviewIssue(claim,page,checkpoint?.quoteGenrePolicy)??genreReviewIssue(claim,source&&typeof source.excerpt==='string'?{url:source.url,text:source.excerpt}:undefined,checkpoint?.quoteGenrePolicy);
    };
    const policyRejected = (checkpoint?.claims ?? []).filter(claim => evidenceIssue(claim)!==null);
    const hasActiveSupport=(statement:string,sourceKey?:string):boolean=>(checkpoint?.claims??[]).some(claim=>claim.statement===statement&&(!sourceKey||claim.sourceKey===sourceKey)&&!policyRejected.includes(claim)&&sources.some(source=>source.sourceKey===claim.sourceKey&&!source.excluded&&source.excerpt?.includes(claim.quote))&&checkpoint?.pages.some(page=>page.sourceKey===claim.sourceKey&&page.text.includes(claim.quote)));
    const projectedKeys=(statement:string,sourceKeys:readonly string[]):string[]=>policyRejected.some(claim=>claim.statement===statement&&sourceKeys.includes(claim.sourceKey))?sourceKeys.filter(key=>hasActiveSupport(statement,key)):[...sourceKeys];
    const isPolicyRejected=(statement:string,sourceKeys:readonly string[]):boolean=>sourceKeys.length>0&&projectedKeys(statement,sourceKeys).length===0;
    const policyLimits=policyRejected.map(claim=>`${claim.sourceKey}：${evidenceIssue(claim)} 该引文绑定不作为已支持依据展示；原记录保留。`);
    const policyStop=policyRejected.length>0&&run.state==='completed'&& !['scope_changed','source_revoked'].includes(run.stopReason??'');
    // Legacy Person Object IDs are checkpoint ordinals. Assign them before
    // filtering so withdrawing one source cannot rename unrelated references.
    const personClaims = (checkpoint?.claims ?? [])
      .map((claim, index) => ({ claim, ordinal: index + 1 }))
      .filter(({ claim }) => !policyRejected.includes(claim)&&sources.some(source =>
        source.sourceKey === claim.sourceKey && !source.excluded && source.excerpt?.includes(claim.quote)));
    if (anchorRevoked) sources.forEach(source => excluded.add(source.sourceKey));
    const binding=checkpoint?.firstStep;
    const currentCase=binding?this.cases.getCase(run.ownerId,binding.caseId):null;
    const independentAccounts=binding&&currentCase?.scopeVersion===binding.scopeVersion?new Set(this.cases.listAccounts(run.ownerId,binding.caseId).filter(account=>binding.independentAccountIds.includes(account.accountId)&&account.userSelection.state==='only_this_account'&&account.allowedScope.state!=='none').flatMap(account=>{const ref=classifyFirstStepUrl(account.profileUrl);return ref.ok?[ref.ref.accountKey]:[];})):new Set<string>();
    const accountMaterials=(checkpoint?.independentMaterials??[]).filter(material=>{
      const page=checkpoint?.pages.find(page=>page.sourceKey===material.sourceKey),account=classifyFirstStepUrl(material.sourceUrl);
      const source=sources.find(source=>source.sourceKey===material.sourceKey&&!source.excluded);
      return account.ok&&independentAccounts.has(account.ref.accountKey)&&page?.url===material.sourceUrl&&(page.retrieval==='read'||page.retrieval==='profile')&&source?.url===material.sourceUrl&&typeof source.excerpt==='string'&&Number.isSafeInteger(material.quoteOffset)&&material.quoteOffset>=0&&material.quote.length>=3&&page.text.slice(material.quoteOffset,material.quoteOffset+material.quote.length)===material.quote&&createHash('sha256').update(page.text).digest('hex')===material.sourceContentHash&&source.excerpt.slice(material.quoteOffset,material.quoteOffset+material.quote.length)===material.quote&&createHash('sha256').update(source.excerpt).digest('hex')===material.sourceContentHash;
    });
    const observations = this.listObservations(run.id).filter(observation=>!isPolicyRejected(observation.statement,observation.sourceKeys)).map(observation=>({...observation,sourceKeys:projectedKeys(observation.statement,observation.sourceKeys)})).map(observation => ({ ...observation,
      validity: scopeChanged || identityChanged ? 'review' as const : validityFor(observation.sourceKeys, excluded),
      reviewReason: scopeChanged ? scopeReason : identityChanged ? identityReason : reviewReason(observation.sourceKeys, excluded)
    }));
    const answer: CanonicalAnswerSection[] = run.answer.map((section) => ({
      id: section.id,
      heading: section.heading,
      body: scopeChanged || policyRejected.some(claim=>section.body.includes(claim.statement)&&!hasActiveSupport(claim.statement))?'':section.body,
      bullets: section.bullets.filter(bullet=>!isPolicyRejected(bullet.text,bullet.sourceKeys)).map(bullet=>({...bullet,sourceKeys:projectedKeys(bullet.text,bullet.sourceKeys)})).map((bullet) => ({
        text: bullet.text,
        sourceKeys: bullet.sourceKeys,
        kind: bullet.kind,
        validity: scopeChanged || identityChanged ? 'review' as const : validityFor(bullet.sourceKeys, excluded),
        reviewReason: scopeChanged ? scopeReason : identityChanged ? identityReason : reviewReason(bullet.sourceKeys, excluded)
      }))
    })).filter(section=>!policyRejected.length||section.body||section.bullets.length);
    const identity: CanonicalIdentity = {
      displayName: run.identity.displayName,
      handle: run.identity.handle,
      profileUrl: run.identity.profileUrl,
      status: run.identity.status,
      note: run.identity.note,
      candidates: run.identity.candidates
    };
    if (anchorRevoked) { identity.status = 'ambiguous'; identity.note = '人物主页证据已撤回，需要重新确认身份。'; }
    if (identityChanged) { identity.status = 'ambiguous'; identity.note = identityReason; }
    if (scopeChanged) { identity.status = 'ambiguous'; identity.note = scopeReason; }
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: run.id,
      state: scopeChanged || policyStop ? 'partial' : run.state,
      revision: run.revision,
      question: run.question,
      seedUrl: run.seedUrl,
      provider: run.provider,
      parentRunId: run.parentRunId,
      retryOf: run.retryOf,
      followup: run.followup,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      interrupted: run.interrupted,
      stopReason: scopeChanged ? 'scope_changed' : policyStop?'claim_scope_unverified':run.stopReason,
      identity,
      sources,
      observations,
      answer,
      limitations: [...new Set([...run.limitations,...policyLimits,...scopeChanged?[scopeReason]:[]])],
      usage: run.usage,
      reviewCount: countReviewItems(observations, answer),
      ...(checkpoint ? {
        research: { phase: checkpoint.phase, steps: checkpoint.steps, budget: this.research.budget(run.id, checkpoint.limits), stopReason: scopeChanged ? 'scope_changed' : policyStop?'claim_scope_unverified':run.stopReason ?? checkpoint.stopReason, unresolved: presentedResearchUnknowns(checkpoint), ...(checkpoint.independentMaterials?{accountMaterials}:{}), coverage: researchDepthCoverage(personClaims.map(({claim})=>claim), new Set(sources.filter(s=>!s.excluded&&checkpoint.pages.some(p=>p.sourceKey===s.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile'))).map(s=>s.sourceKey))) },
        ...(checkpoint.anchorUrl && identity.status === 'resolved' ? {
          personObject: {
            schemaVersion: 'stripsearch/person/v1' as const,
            person: { id: 'person_' + createHash('sha256').update(run.ownerId + '\0' + checkpoint.anchorUrl).digest('hex').slice(0,24), displayName: identity.displayName, profileUrl: checkpoint.anchorUrl },
            claims: personClaims.map(({ claim, ordinal }) => ({
              id: `C${ordinal}`, statement: claim.statement, kind: claim.kind,
              sourceKeys: [claim.sourceKey], evidenceIds: [`E${ordinal}`]
            })),
            evidence: personClaims.map(({ claim, ordinal }) => ({
              id: `E${ordinal}`, sourceKey: claim.sourceKey, quote: claim.quote
            })),
            unknowns: [...new Set([...presentedResearchUnknowns(checkpoint),...policyLimits])],
            report: { runId: run.id, revision: run.revision, asOf: run.updatedAt }
          }
        } : {})
      } : {})
    };
  }

  summarize(run: RunRecord): RunSummary {
    const view = this.buildCanonicalView(run);
    return {
      runId: run.id,
      question: run.question,
      state: view.state,
      provider: run.provider,
      revision: run.revision,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      sourceCount: view.sources.length,
      reviewCount: view.reviewCount
    };
  }

  countActiveGlobal(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE state IN ('queued', 'researching') AND deleted_at IS NULL")
      .get() as { n: number };
    return row.n;
  }

  countByState(state: RunState): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM runs WHERE state = ? AND deleted_at IS NULL')
      .get(state) as { n: number };
    return row.n;
  }

  countActiveForOwner(ownerId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE owner_id = ? AND state IN ('queued', 'researching') AND deleted_at IS NULL"
      )
      .get(ownerId) as { n: number };
    return row.n;
  }

  listQueuedRuns(): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE state = 'queued' AND deleted_at IS NULL ORDER BY created_at ASC")
      .all() as RunRow[];
    return rows.map(mapRun);
  }

  markInterrupted(runId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE runs SET state = 'partial', interrupted = 1, stop_reason = 'interrupted',
          error_code = 'interrupted', error_message = '服务重启，未完成的研究已标记为中断，可手动重试。',
          finished_at = @finished_at, updated_at = @finished_at
         WHERE id = @id AND deleted_at IS NULL AND state IN ('queued', 'researching')`
      )
      .run({ id: runId, finished_at: nowIso() });
    return info.changes > 0;
  }

  recoverInterruptedRuns(): number {
    const rows = this.db
      .prepare("SELECT id FROM runs WHERE state IN ('queued', 'researching') AND deleted_at IS NULL")
      .all() as { id: string }[];
    let count = 0;
    for (const row of rows) {
      const run = this.getRun(row.id);
      if (run?.provider === 'research') {
        const hasFirstStepTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='first_step_links'").get();
        const firstStep = hasFirstStepTable && this.db.prepare('SELECT 1 FROM first_step_links WHERE run_id=?').get(row.id);
        const unknown = this.research.receipts(row.id).some(receipt => firstStep ? receipt.state === 'inflight' : receipt.state !== 'completed');
        if (!unknown) { this.updateRun(row.id, {state:'queued', interrupted:1}); continue; }
      }
      if (this.markInterrupted(row.id)) {
        if (run?.provider === 'research') this.updateRun(row.id, {stop_reason:'unknown_inflight',error_message:'上次调用的计费结果不明，已保留材料；不会自动重复调用。'});
        this.addEvent(row.id, 'interrupted', {
          message: '服务重启，未完成的研究已标记为中断。',
          state: 'partial' as RunState
        });
        count += 1;
      }
    }
    return count;
  }
}

export { providerLabel, stateLabel };
