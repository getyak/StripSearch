/**
 * GET-58 case persistence: SQLite backing for the shared research-case domain
 * contract (shared/research-case.ts).
 *
 * Every write runs inside one transaction and validates owner + case + account
 * + expectedScopeVersion plus evidence source ownership and evidence roles
 * before it can commit: stale scope versions, foreign ids and role-mismatched
 * references are rejected and the whole write rolls back. Source updates
 * append immutable revisions; withdrawal only sets a timestamp and never
 * renumbers or rewrites ids. Scope versions and source revisions are
 * append-only, so reopening the database preserves the full history.
 *
 * Scope is mutated only through one atomic path: `applyScopeChange` (batch,
 * one-submit) or `updateAccountFacets` when a patch touches userSelection or
 * allowedScope. Both snapshot the actual per-account selection/allowedScope
 * state before and after the change and advance scopeVersion in the same
 * transaction, so an old expectedScopeVersion can never write into a widened
 * scope. `addAccount` records discovered candidates as `unanswered`
 * baselines; it never implies a user selection.
 *
 * Coverage items are keyed by their per-content locator (account + source id +
 * source revision) plus a collision-free taskRef key; bound identities are
 * never rebound and each write appends an immutable revision keeping its
 * scopeVersion as historical provenance.
 *
 * This is a foundation only: no scheduling, workers or leases. The capability
 * hangs off the existing Store lifetime (`Store.cases`).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import {
  CaseNotFoundError,
  EvidenceRoleError,
  FACTUAL_COUNTEREVIDENCE_ROLE,
  FACTUAL_SUPPORT_ROLE,
  ForeignReferenceError,
  IDENTITY_COUNTEREVIDENCE_ROLE,
  IDENTITY_SUPPORT_ROLE,
  ScopeBypassError,
  StaleScopeError,
  asPersonRevision,
  asScopeVersion,
  buildCaseReportView,
  nextPersonRevision,
  nextScopeVersion,
  taskRefKey
} from '../../shared/research-case.js';
import type {
  AccountFacetPatch,
  AccountSelection,
  CaseClaim,
  CaseReportView,
  CaseSourceView,
  CoverageLocator,
  EvidenceRef,
  EvidenceRole,
  IdentitySupport,
  ItemCoverage,
  ItemCoverageRevision,
  PersonRevision,
  RecordProvenance,
  ResearchCase,
  ScopeAccountSnapshot,
  ScopeVersion,
  ScopeVersionRecord,
  SourceRevision,
  TaskRef
} from '../../shared/research-case.js';
import type { ClaimKind } from '../../shared/types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newRecordId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function quoteHash(quote: string): string {
  return createHash('sha256').update(quote).digest('hex');
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write context required by every mutating call. */
export interface CaseWriteContext {
  /** Tenant boundary. */
  ownerId: string;
  caseId: string;
  /** Researched-account boundary; the account must belong to the case. */
  accountId: string;
  expectedScopeVersion: ScopeVersion;
}

export interface CreateCaseInput {
  ownerId: string;
  intent: string;
  provenance: RecordProvenance;
  /** Stable id or generated; colliding ids are rejected, never reused. */
  caseId?: string;
  personId?: string;
}

export interface AccountDraft {
  platform: string;
  handle: string | null;
  profileUrl: string | null;
  identitySupport: AccountSelection['identitySupport'];
  userSelection: AccountSelection['userSelection'];
  allowedScope: AccountSelection['allowedScope'];
  researchValue: AccountSelection['researchValue'];
  accessCoverage: AccountSelection['accessCoverage'];
  accountId?: string;
}

export interface SourceRevisionDraft {
  author: string | null;
  originalUrl: string;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
  locator: string | null;
  contentHash: string;
  provenance: RecordProvenance;
  /** Existing source to append an immutable revision to; omitted = new source. */
  sourceId?: string;
}

export interface EvidenceDraft {
  sourceId: string;
  sourceRevision: number;
  role: EvidenceRef['role'];
  quote: string;
  locator: string | null;
  provenance: RecordProvenance;
  evidenceId?: string;
}

export interface ClaimDraft {
  statement: string;
  kind: ClaimKind;
  supportIds: string[];
  counterevidenceIds: string[];
  limitations: string[];
  claimId?: string;
}

export interface CoverageDraft {
  /** Stable per-content locator: account + source/content + source revision. */
  locator: CoverageLocator;
  taskRef: TaskRef;
  status: ItemCoverage['status'];
  evidenceIds: string[];
  counterevidenceIds: string[];
  note: string | null;
  /** When set, must match the full bound identity of an existing item. */
  itemId?: string;
}

/** One account entry of an atomic scope change (selection and/or allowed scope). */
export interface ScopeAccountChange {
  /** Existing account to update; mutually exclusive with `create`. */
  accountId?: string;
  /** New account to create inside this same scope change. */
  create?: AccountDraft;
  userSelection?: AccountSelection['userSelection'];
  allowedScope?: AccountSelection['allowedScope'];
}

/** The atomic scope mutation request: all entries commit together or not at all. */
export interface ScopeChangeInput {
  ownerId: string;
  caseId: string;
  expectedScopeVersion: ScopeVersion;
  reason: string;
  accounts: ScopeAccountChange[];
}

export interface ScopeChangeResult {
  case: ResearchCase;
  /** Immutable before/after snapshot written by this change. */
  snapshot: ScopeVersionRecord;
  accounts: AccountSelection[];
}

interface CaseRow {
  id: string;
  owner_id: string;
  person_id: string;
  intent: string;
  scope_version: number;
  person_revision: number;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  case_id: string;
  owner_id: string;
  platform: string;
  handle: string | null;
  profile_url: string | null;
  identity_support_json: string;
  user_selection_json: string;
  allowed_scope_json: string;
  research_value_json: string;
  access_coverage_json: string;
  created_at: string;
  updated_at: string;
}

interface SourceRow {
  id: string;
  case_id: string;
  account_id: string;
  latest_revision: number;
  created_at: string;
  updated_at: string;
}

interface SourceRevisionRow {
  source_id: string;
  revision: number;
  author: string | null;
  original_url: string;
  title: string;
  published_at: string | null;
  retrieved_at: string;
  locator: string | null;
  content_hash: string;
  provenance_json: string;
  created_at: string;
}

interface EvidenceRow {
  id: string;
  case_id: string;
  account_id: string;
  source_id: string;
  source_revision: number;
  role: EvidenceRef['role'];
  quote: string;
  locator: string | null;
  quote_hash: string;
  provenance_json: string;
  created_at: string;
  revoked_at: string | null;
}

interface ClaimRow {
  id: string;
  case_id: string;
  account_id: string;
  statement: string;
  kind: ClaimKind;
  limitations_json: string;
  created_at: string;
  updated_at: string;
  withdrawn_at: string | null;
}

interface CoverageRow {
  id: string;
  case_id: string;
  account_id: string;
  source_id: string;
  source_revision: number;
  task_ref_key: string;
  task_ref_json: string;
  latest_revision: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface CoverageRevisionRow {
  item_id: string;
  revision: number;
  scope_version: number;
  status: ItemCoverage['status'];
  evidence_json: string;
  counterevidence_json: string;
  note: string | null;
  created_at: string;
}

function mapCase(row: CaseRow): ResearchCase {
  return {
    caseId: row.id,
    ownerId: row.owner_id,
    personId: row.person_id,
    intent: row.intent,
    scopeVersion: asScopeVersion(row.scope_version),
    personRevision: asPersonRevision(row.person_revision),
    provenance: parseJson<RecordProvenance>(row.provenance_json, {
      authorization: 'not_recorded',
      collector: 'unknown',
      note: null
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAccount(row: AccountRow): AccountSelection {
  return {
    caseId: row.case_id,
    accountId: row.id,
    platform: row.platform,
    handle: row.handle,
    profileUrl: row.profile_url,
    identitySupport: parseJson(row.identity_support_json, {
      state: 'proposed',
      evidenceIds: [],
      counterevidenceIds: [],
      policyVersion: 'identity-policy/v1',
      note: null
    }),
    userSelection: parseJson(row.user_selection_json, { state: 'unanswered', note: null, recordedAt: null }),
    allowedScope: parseJson(row.allowed_scope_json, { state: 'none', note: null }),
    researchValue: parseJson(row.research_value_json, { state: 'unassessed', rationale: null }),
    accessCoverage: parseJson(row.access_coverage_json, { state: 'unassessed', earliestReadAt: null, note: null }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSourceRevision(caseId: string, accountId: string, row: SourceRevisionRow): SourceRevision {
  return {
    sourceId: row.source_id,
    sourceRevision: row.revision,
    caseId,
    accountId,
    author: row.author,
    originalUrl: row.original_url,
    title: row.title,
    publishedAt: row.published_at,
    retrievedAt: row.retrieved_at,
    locator: row.locator,
    contentHash: row.content_hash,
    provenance: parseJson<RecordProvenance>(row.provenance_json, {
      authorization: 'not_recorded',
      collector: 'unknown',
      note: null
    })
  };
}

function mapEvidence(row: EvidenceRow): EvidenceRef {
  return {
    evidenceId: row.id,
    caseId: row.case_id,
    accountId: row.account_id,
    sourceId: row.source_id,
    sourceRevision: row.source_revision,
    role: row.role,
    quote: row.quote,
    locator: row.locator,
    quoteHash: row.quote_hash,
    provenance: parseJson<RecordProvenance>(row.provenance_json, {
      authorization: 'not_recorded',
      collector: 'unknown',
      note: null
    }),
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

function mapCoverageRevision(caseId: string, row: CoverageRow, revision: CoverageRevisionRow): ItemCoverage {
  return {
    caseId,
    itemId: row.id,
    locator: {
      accountId: row.account_id,
      sourceId: row.source_id,
      sourceRevision: row.source_revision
    },
    taskRef: parseJson<TaskRef>(row.task_ref_json, { kind: 'question_matrix', slot: 'work' }),
    revision: revision.revision,
    scopeVersion: asScopeVersion(revision.scope_version),
    status: revision.status,
    evidenceIds: parseJson<string[]>(revision.evidence_json, []),
    counterevidenceIds: parseJson<string[]>(revision.counterevidence_json, []),
    note: revision.note,
    createdAt: row.created_at,
    updatedAt: revision.created_at
  };
}

function mapCoverageHistoryEntry(
  caseId: string,
  row: CoverageRow,
  revision: CoverageRevisionRow
): ItemCoverageRevision {
  return {
    caseId,
    itemId: row.id,
    revision: revision.revision,
    scopeVersion: asScopeVersion(revision.scope_version),
    status: revision.status,
    evidenceIds: parseJson<string[]>(revision.evidence_json, []),
    counterevidenceIds: parseJson<string[]>(revision.counterevidence_json, []),
    note: revision.note,
    createdAt: revision.created_at
  };
}

export class CaseStore {
  constructor(private readonly db: DB) {}

  /** Single transaction boundary for every mutating operation. */
  private write<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Validate owner + case + account + expectedScopeVersion (inside a write). */
  private validate(ctx: CaseWriteContext): CaseRow {
    const row = this.db
      .prepare('SELECT * FROM research_cases WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(ctx.caseId, ctx.ownerId) as CaseRow | undefined;
    if (!row) throw new CaseNotFoundError(ctx.caseId);
    if (row.scope_version !== ctx.expectedScopeVersion) {
      throw new StaleScopeError(ctx.caseId, ctx.expectedScopeVersion, asScopeVersion(row.scope_version));
    }
    const account = this.db
      .prepare('SELECT id FROM research_case_accounts WHERE id = ? AND case_id = ?')
      .get(ctx.accountId, ctx.caseId) as { id: string } | undefined;
    if (!account) {
      throw new ForeignReferenceError(`account ${ctx.accountId} is not part of case ${ctx.caseId}`);
    }
    return row;
  }

  /** Validate owner + case + expectedScopeVersion before an account is created. */
  private validateCaseScope(ownerId: string, caseId: string, expectedScopeVersion: ScopeVersion): CaseRow {
    const row = this.db
      .prepare('SELECT * FROM research_cases WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(caseId, ownerId) as CaseRow | undefined;
    if (!row) throw new CaseNotFoundError(caseId);
    if (row.scope_version !== expectedScopeVersion) {
      throw new StaleScopeError(caseId, expectedScopeVersion, asScopeVersion(row.scope_version));
    }
    return row;
  }

  /** Evidence source ownership: the source revision must belong to case+account. */
  private requireSourceRevision(ctx: CaseWriteContext, sourceId: string, sourceRevision: number): void {
    const row = this.db
      .prepare(
        `SELECT r.revision FROM research_case_source_revisions r
         JOIN research_case_sources s ON s.id = r.source_id
         WHERE r.source_id = ? AND r.revision = ? AND s.case_id = ? AND s.account_id = ?`
      )
      .get(sourceId, sourceRevision, ctx.caseId, ctx.accountId) as { revision: number } | undefined;
    if (!row) {
      throw new ForeignReferenceError(
        `source revision ${sourceId}@${String(sourceRevision)} is not owned by case ${ctx.caseId} account ${ctx.accountId}`
      );
    }
  }

  /** Evidence ownership + role: the id must belong to case+account with `role`. */
  private requireEvidence(
    caseId: string,
    accountId: string,
    evidenceId: string,
    role?: EvidenceRole
  ): EvidenceRow {
    const row = this.db
      .prepare('SELECT * FROM research_case_evidence WHERE id = ? AND case_id = ? AND account_id = ?')
      .get(evidenceId, caseId, accountId) as EvidenceRow | undefined;
    if (!row) {
      throw new ForeignReferenceError(
        `evidence ${evidenceId} is not owned by case ${caseId} account ${accountId}`
      );
    }
    if (role !== undefined && row.role !== role) {
      throw new EvidenceRoleError(`evidence ${evidenceId} has role ${row.role}, expected ${role}`);
    }
    return row;
  }

  /** Identity facets only cite identity evidence; supported needs real support. */
  private validateIdentitySupport(caseId: string, accountId: string, support: IdentitySupport): void {
    for (const evidenceId of support.evidenceIds) {
      this.requireEvidence(caseId, accountId, evidenceId, IDENTITY_SUPPORT_ROLE);
    }
    for (const evidenceId of support.counterevidenceIds) {
      this.requireEvidence(caseId, accountId, evidenceId, IDENTITY_COUNTEREVIDENCE_ROLE);
    }
    if (support.state === 'supported' && support.evidenceIds.length === 0) {
      throw new ForeignReferenceError('identitySupport state supported requires identity_support evidence');
    }
  }

  private bumpPersonRevision(caseId: string): PersonRevision {
    this.db
      .prepare('UPDATE research_cases SET person_revision = person_revision + 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), caseId);
    const row = this.db.prepare('SELECT person_revision FROM research_cases WHERE id = ?').get(caseId) as
      | { person_revision: number }
      | undefined;
    return asPersonRevision(row?.person_revision ?? 1);
  }

  /** Stable insertion ordering for deterministic listings and exports. */
  private nextSortOrder(
    kind: 'account' | 'source' | 'evidence' | 'claim' | 'coverage',
    caseId: string
  ): number {
    const sql = {
      account: 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM research_case_accounts WHERE case_id = ?',
      source: 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM research_case_sources WHERE case_id = ?',
      evidence: 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM research_case_evidence WHERE case_id = ?',
      claim: 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM research_case_claims WHERE case_id = ?',
      coverage: 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM research_case_item_coverage WHERE case_id = ?'
    }[kind];
    return (this.db.prepare(sql).get(caseId) as { n: number }).n;
  }

  /** Full per-account selection/allowedScope slice, snapshotted verbatim. */
  private scopeSnapshot(caseId: string): ScopeAccountSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM research_case_accounts WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
      .all(caseId) as AccountRow[];
    return rows.map((row) => {
      const account = mapAccount(row);
      return {
        accountId: account.accountId,
        platform: account.platform,
        handle: account.handle,
        userSelection: account.userSelection,
        allowedScope: account.allowedScope
      };
    });
  }

  /** Append one immutable scope journal entry with real before/after state. */
  private recordScopeEvent(
    caseId: string,
    scopeVersion: number,
    reason: string,
    before: ScopeAccountSnapshot[],
    after: ScopeAccountSnapshot[]
  ): ScopeVersionRecord {
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO research_case_scope_versions
          (case_id, scope_version, reason, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(caseId, scopeVersion, reason, JSON.stringify(before), JSON.stringify(after), createdAt);
    return { caseId, scopeVersion: asScopeVersion(scopeVersion), reason, createdAt, before, after };
  }

  /** Atomic scope commit: journal before/after state, then advance the version. */
  private commitScopeMutation(
    caseId: string,
    current: CaseRow,
    reason: string,
    before: ScopeAccountSnapshot[]
  ): { case: ResearchCase; snapshot: ScopeVersionRecord } {
    const after = this.scopeSnapshot(caseId);
    const next = nextScopeVersion(asScopeVersion(current.scope_version));
    this.db
      .prepare('UPDATE research_cases SET scope_version = ?, updated_at = ? WHERE id = ?')
      .run(next, nowIso(), caseId);
    const snapshot = this.recordScopeEvent(caseId, next, reason, before, after);
    return { case: mapCase(this.db.prepare('SELECT * FROM research_cases WHERE id = ?').get(caseId) as CaseRow), snapshot };
  }

  private mapClaim(row: ClaimRow): CaseClaim {
    const links = this.db
      .prepare(
        'SELECT evidence_id, role FROM research_case_claim_evidence WHERE claim_id = ? ORDER BY sort_order, evidence_id'
      )
      .all(row.id) as { evidence_id: string; role: 'support' | 'counterevidence' }[];
    return {
      claimId: row.id,
      caseId: row.case_id,
      accountId: row.account_id,
      statement: row.statement,
      kind: row.kind,
      supportIds: links.filter((link) => link.role === 'support').map((link) => link.evidence_id),
      counterevidenceIds: links.filter((link) => link.role === 'counterevidence').map((link) => link.evidence_id),
      limitations: parseJson<string[]>(row.limitations_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      withdrawnAt: row.withdrawn_at
    };
  }

  /* ---------------------------------------------------------------- */
  /* Cases and scope versions                                         */
  /* ---------------------------------------------------------------- */

  createCase(input: CreateCaseInput): ResearchCase {
    return this.write(() => {
      const timestamp = nowIso();
      const caseId = input.caseId ?? newRecordId('case');
      const personId = input.personId ?? newRecordId('person');
      const existing = this.db.prepare('SELECT id FROM research_cases WHERE id = ?').get(caseId);
      if (existing) throw new ForeignReferenceError(`case id ${caseId} is already taken`);
      this.db
        .prepare(
          `INSERT INTO research_cases (
            id, owner_id, person_id, intent, scope_version, person_revision,
            provenance_json, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, NULL)`
        )
        .run(caseId, input.ownerId, personId, input.intent, JSON.stringify(input.provenance), timestamp, timestamp);
      this.db
        .prepare(
          'INSERT INTO research_case_scope_versions (case_id, scope_version, reason, before_json, after_json, created_at) VALUES (?, 1, ?, ?, ?, ?)'
        )
        .run(caseId, 'case_created', '[]', '[]', timestamp);
      const row = this.db.prepare('SELECT * FROM research_cases WHERE id = ?').get(caseId) as CaseRow;
      return mapCase(row);
    });
  }

  getCase(ownerId: string, caseId: string): ResearchCase | null {
    const row = this.db
      .prepare('SELECT * FROM research_cases WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(caseId, ownerId) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  listCases(ownerId: string): ResearchCase[] {
    const rows = this.db
      .prepare('SELECT * FROM research_cases WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at, id')
      .all(ownerId) as CaseRow[];
    return rows.map(mapCase);
  }

  scopeHistory(ownerId: string, caseId: string): ScopeVersionRecord[] {
    if (!this.getCase(ownerId, caseId)) return [];
    const rows = this.db
      .prepare('SELECT * FROM research_case_scope_versions WHERE case_id = ? ORDER BY id ASC')
      .all(caseId) as {
      case_id: string;
      scope_version: number;
      reason: string;
      before_json: string;
      after_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      caseId: row.case_id,
      scopeVersion: asScopeVersion(row.scope_version),
      reason: row.reason,
      createdAt: row.created_at,
      before: parseJson<ScopeAccountSnapshot[]>(row.before_json, []),
      after: parseJson<ScopeAccountSnapshot[]>(row.after_json, [])
    }));
  }

  /**
   * Explicit case-level scope advance: journals the current per-account scope
   * state (before == after) and bumps the version so stale writers fail closed.
   */
  advanceScope(ctx: CaseWriteContext, reason: string): ResearchCase {
    return this.write(() => {
      const row = this.validate(ctx);
      return this.commitScopeMutation(ctx.caseId, row, reason, this.scopeSnapshot(ctx.caseId)).case;
    });
  }

  /**
   * The atomic scope mutation path: create accounts and/or change per-account
   * userSelection/allowedScope in one transaction. The actual before/after
   * selection and allowed scope of every account is snapshotted immutably and
   * the case scope version advances exactly once. Any invalid entry rolls the
   * whole batch back — no partial changes.
   */
  applyScopeChange(input: ScopeChangeInput): ScopeChangeResult {
    return this.write(() => {
      const row = this.validateCaseScope(input.ownerId, input.caseId, input.expectedScopeVersion);
      const before = this.scopeSnapshot(input.caseId);
      const touched = new Set<string>();
      for (const change of input.accounts) {
        const hasCreate = change.create !== undefined;
        const hasAccount = change.accountId !== undefined;
        if (hasCreate === hasAccount) {
          throw new ForeignReferenceError('each scope change entry needs exactly one of accountId or create');
        }
        if (hasCreate) {
          const draft = change.create as AccountDraft;
          const accountId = draft.accountId ?? newRecordId('acct');
          if (touched.has(accountId)) {
            throw new ForeignReferenceError(`account ${accountId} appears twice in one scope change`);
          }
          touched.add(accountId);
          const existing = this.db.prepare('SELECT id FROM research_case_accounts WHERE id = ?').get(accountId);
          if (existing) throw new ForeignReferenceError(`account id ${accountId} is already taken`);
          this.validateIdentitySupport(input.caseId, accountId, draft.identitySupport);
          const timestamp = nowIso();
          this.db
            .prepare(
              `INSERT INTO research_case_accounts (
                id, case_id, owner_id, platform, handle, profile_url,
                identity_support_json, user_selection_json, allowed_scope_json,
                research_value_json, access_coverage_json, sort_order, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              accountId,
              input.caseId,
              input.ownerId,
              draft.platform,
              draft.handle,
              draft.profileUrl,
              JSON.stringify(draft.identitySupport),
              JSON.stringify(change.userSelection ?? draft.userSelection),
              JSON.stringify(change.allowedScope ?? draft.allowedScope),
              JSON.stringify(draft.researchValue),
              JSON.stringify(draft.accessCoverage),
              this.nextSortOrder('account', input.caseId),
              timestamp,
              timestamp
            );
        } else {
          const accountId = change.accountId as string;
          if (touched.has(accountId)) {
            throw new ForeignReferenceError(`account ${accountId} appears twice in one scope change`);
          }
          touched.add(accountId);
          const account = this.db
            .prepare('SELECT id FROM research_case_accounts WHERE id = ? AND case_id = ?')
            .get(accountId, input.caseId) as { id: string } | undefined;
          if (!account) {
            throw new ForeignReferenceError(`account ${accountId} is not part of case ${input.caseId}`);
          }
          const fields: Record<string, unknown> = { updated_at: nowIso() };
          if (change.userSelection) fields.user_selection_json = JSON.stringify(change.userSelection);
          if (change.allowedScope) fields.allowed_scope_json = JSON.stringify(change.allowedScope);
          const sets = Object.keys(fields).map((key) => `${key} = @${key}`).join(', ');
          this.db.prepare(`UPDATE research_case_accounts SET ${sets} WHERE id = @id`).run({ ...fields, id: accountId });
        }
      }
      const { case: record, snapshot } = this.commitScopeMutation(input.caseId, row, input.reason, before);
      return {
        case: record,
        snapshot,
        accounts: this.listAccounts(input.ownerId, input.caseId)
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Account selection: five facets, no implicit upgrades             */
  /* ---------------------------------------------------------------- */

  /**
   * Intake for discovered candidates. Selection must stay `unanswered` —
   * discovery never implies a user selection; selecting an account is a scope
   * change and goes through `applyScopeChange`. The initial allowedScope is
   * recorded as the account's baseline and journaled at the version in effect.
   */
  addAccount(ctx: CaseWriteContext, draft: AccountDraft): AccountSelection {
    return this.write(() => {
      const row = this.validateCaseScope(ctx.ownerId, ctx.caseId, ctx.expectedScopeVersion);
      if (draft.userSelection.state !== 'unanswered') {
        throw new ScopeBypassError('creating an account with a user selection must go through applyScopeChange');
      }
      const accountId = draft.accountId ?? newRecordId('acct');
      const existing = this.db.prepare('SELECT id FROM research_case_accounts WHERE id = ?').get(accountId);
      if (existing) throw new ForeignReferenceError(`account id ${accountId} is already taken`);
      this.validateIdentitySupport(ctx.caseId, accountId, draft.identitySupport);
      const before = this.scopeSnapshot(ctx.caseId);
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO research_case_accounts (
            id, case_id, owner_id, platform, handle, profile_url,
            identity_support_json, user_selection_json, allowed_scope_json,
            research_value_json, access_coverage_json, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          accountId,
          ctx.caseId,
          ctx.ownerId,
          draft.platform,
          draft.handle,
          draft.profileUrl,
          JSON.stringify(draft.identitySupport),
          JSON.stringify(draft.userSelection),
          JSON.stringify(draft.allowedScope),
          JSON.stringify(draft.researchValue),
          JSON.stringify(draft.accessCoverage),
          this.nextSortOrder('account', ctx.caseId),
          timestamp,
          timestamp
        );
      this.recordScopeEvent(
        ctx.caseId,
        row.scope_version,
        'account_created',
        before,
        this.scopeSnapshot(ctx.caseId)
      );
      return mapAccount(this.db.prepare('SELECT * FROM research_case_accounts WHERE id = ?').get(accountId) as AccountRow);
    });
  }

  /**
   * Update only the named facets. Nothing is inferred: patching `userSelection`
   * can never touch `identitySupport`, and vice versa. A patch that sets
   * userSelection or allowedScope IS a scope mutation and runs through the same
   * atomic path as `applyScopeChange`: real before/after snapshots plus a
   * scopeVersion advance in this very transaction. Same-scope content/status
   * updates (identitySupport, researchValue, accessCoverage) keep the version.
   */
  updateAccountFacets(ctx: CaseWriteContext, patch: AccountFacetPatch): AccountSelection {
    return this.write(() => {
      const caseRow = this.validate(ctx);
      const row = this.db
        .prepare('SELECT * FROM research_case_accounts WHERE id = ? AND case_id = ?')
        .get(ctx.accountId, ctx.caseId) as AccountRow | undefined;
      if (!row) {
        throw new ForeignReferenceError(`account ${ctx.accountId} is not part of case ${ctx.caseId}`);
      }
      if (patch.identitySupport) this.validateIdentitySupport(ctx.caseId, ctx.accountId, patch.identitySupport);
      const scopeTouched = patch.userSelection !== undefined || patch.allowedScope !== undefined;
      const before = scopeTouched ? this.scopeSnapshot(ctx.caseId) : null;
      const fields: Record<string, unknown> = { updated_at: nowIso() };
      if (patch.identitySupport) fields.identity_support_json = JSON.stringify(patch.identitySupport);
      if (patch.userSelection) fields.user_selection_json = JSON.stringify(patch.userSelection);
      if (patch.allowedScope) fields.allowed_scope_json = JSON.stringify(patch.allowedScope);
      if (patch.researchValue) fields.research_value_json = JSON.stringify(patch.researchValue);
      if (patch.accessCoverage) fields.access_coverage_json = JSON.stringify(patch.accessCoverage);
      const sets = Object.keys(fields).map((key) => `${key} = @${key}`).join(', ');
      this.db.prepare(`UPDATE research_case_accounts SET ${sets} WHERE id = @id`).run({ ...fields, id: ctx.accountId });
      if (before) this.commitScopeMutation(ctx.caseId, caseRow, 'account_scope_updated', before);
      return mapAccount(
        this.db.prepare('SELECT * FROM research_case_accounts WHERE id = ?').get(ctx.accountId) as AccountRow
      );
    });
  }

  listAccounts(ownerId: string, caseId: string): AccountSelection[] {
    if (!this.getCase(ownerId, caseId)) return [];
    const rows = this.db
      .prepare('SELECT * FROM research_case_accounts WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
      .all(caseId) as AccountRow[];
    return rows.map(mapAccount);
  }

  /* ---------------------------------------------------------------- */
  /* Source revisions: append-only                                    */
  /* ---------------------------------------------------------------- */

  /** New source or an immutable revision appended to an existing one. */
  recordSourceRevision(ctx: CaseWriteContext, draft: SourceRevisionDraft): SourceRevision {
    return this.write(() => {
      this.validate(ctx);
      const timestamp = nowIso();
      if (draft.sourceId !== undefined) {
        const source = this.db
          .prepare('SELECT * FROM research_case_sources WHERE id = ? AND case_id = ? AND account_id = ?')
          .get(draft.sourceId, ctx.caseId, ctx.accountId) as SourceRow | undefined;
        if (!source) {
          throw new ForeignReferenceError(
            `source ${draft.sourceId} is not owned by case ${ctx.caseId} account ${ctx.accountId}`
          );
        }
        const revision = source.latest_revision + 1;
        this.db
          .prepare(
            `INSERT INTO research_case_source_revisions (
              source_id, revision, author, original_url, title, published_at,
              retrieved_at, locator, content_hash, provenance_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            source.id,
            revision,
            draft.author,
            draft.originalUrl,
            draft.title,
            draft.publishedAt,
            draft.retrievedAt,
            draft.locator,
            draft.contentHash,
            JSON.stringify(draft.provenance),
            timestamp
          );
        this.db
          .prepare('UPDATE research_case_sources SET latest_revision = ?, updated_at = ? WHERE id = ?')
          .run(revision, timestamp, source.id);
        return mapSourceRevision(ctx.caseId, ctx.accountId, this.db
          .prepare('SELECT * FROM research_case_source_revisions WHERE source_id = ? AND revision = ?')
          .get(source.id, revision) as SourceRevisionRow);
      }
      const sourceId = newRecordId('src');
      this.db
        .prepare(
          'INSERT INTO research_case_sources (id, case_id, account_id, latest_revision, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
        )
        .run(sourceId, ctx.caseId, ctx.accountId, this.nextSortOrder('source', ctx.caseId), timestamp, timestamp);
      this.db
        .prepare(
          `INSERT INTO research_case_source_revisions (
            source_id, revision, author, original_url, title, published_at,
            retrieved_at, locator, content_hash, provenance_json, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sourceId,
          draft.author,
          draft.originalUrl,
          draft.title,
          draft.publishedAt,
          draft.retrievedAt,
          draft.locator,
          draft.contentHash,
          JSON.stringify(draft.provenance),
          timestamp
        );
      return mapSourceRevision(ctx.caseId, ctx.accountId, this.db
        .prepare('SELECT * FROM research_case_source_revisions WHERE source_id = ? AND revision = 1')
        .get(sourceId) as SourceRevisionRow);
    });
  }

  listSourceRevisions(ownerId: string, caseId: string, accountId: string, sourceId: string): SourceRevision[] {
    if (!this.getCase(ownerId, caseId)) return [];
    const rows = this.db
      .prepare('SELECT * FROM research_case_source_revisions WHERE source_id = ? ORDER BY revision ASC')
      .all(sourceId) as SourceRevisionRow[];
    return rows
      .filter((row) => {
        const source = this.db
          .prepare('SELECT * FROM research_case_sources WHERE id = ?')
          .get(row.source_id) as SourceRow | undefined;
        return source?.case_id === caseId && source.account_id === accountId;
      })
      .map((row) => mapSourceRevision(caseId, accountId, row));
  }

  /* ---------------------------------------------------------------- */
  /* Evidence                                                         */
  /* ---------------------------------------------------------------- */

  /** Evidence must cite a source revision owned by the same case and account. */
  addEvidence(ctx: CaseWriteContext, draft: EvidenceDraft): EvidenceRef {
    return this.write(() => {
      this.validate(ctx);
      this.requireSourceRevision(ctx, draft.sourceId, draft.sourceRevision);
      const evidenceId = draft.evidenceId ?? newRecordId('ev');
      const existing = this.db.prepare('SELECT id FROM research_case_evidence WHERE id = ?').get(evidenceId);
      if (existing) throw new ForeignReferenceError(`evidence id ${evidenceId} is already taken`);
      this.db
        .prepare(
          `INSERT INTO research_case_evidence (
            id, case_id, account_id, source_id, source_revision, role, quote,
            locator, quote_hash, provenance_json, sort_order, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          evidenceId,
          ctx.caseId,
          ctx.accountId,
          draft.sourceId,
          draft.sourceRevision,
          draft.role,
          draft.quote,
          draft.locator,
          quoteHash(draft.quote),
          JSON.stringify(draft.provenance),
          this.nextSortOrder('evidence', ctx.caseId),
          nowIso()
        );
      return mapEvidence(this.db.prepare('SELECT * FROM research_case_evidence WHERE id = ?').get(evidenceId) as EvidenceRow);
    });
  }

  /** Withdrawal sets a timestamp only; the id and record survive unchanged. */
  revokeEvidence(ctx: CaseWriteContext, evidenceId: string): EvidenceRef {
    return this.write(() => {
      this.validate(ctx);
      const row = this.requireEvidence(ctx.caseId, ctx.accountId, evidenceId);
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE research_case_evidence SET revoked_at = ? WHERE id = ?').run(nowIso(), evidenceId);
        this.bumpPersonRevision(ctx.caseId);
      }
      return mapEvidence(this.db.prepare('SELECT * FROM research_case_evidence WHERE id = ?').get(evidenceId) as EvidenceRow);
    });
  }

  getEvidence(ownerId: string, caseId: string, accountId: string, evidenceId: string): EvidenceRef | null {
    if (!this.getCase(ownerId, caseId)) return null;
    const row = this.db
      .prepare('SELECT * FROM research_case_evidence WHERE id = ? AND case_id = ? AND account_id = ?')
      .get(evidenceId, caseId, accountId) as EvidenceRow | undefined;
    return row ? mapEvidence(row) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Claims                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Insert the claim first, then link evidence: any foreign or unknown
   * reference throws inside the transaction, so the claim row rolls back with
   * the failed links.
   */
  addClaim(ctx: CaseWriteContext, draft: ClaimDraft): CaseClaim {
    return this.write(() => {
      this.validate(ctx);
      const claimId = draft.claimId ?? newRecordId('clm');
      const existing = this.db.prepare('SELECT id FROM research_case_claims WHERE id = ?').get(claimId);
      if (existing) throw new ForeignReferenceError(`claim id ${claimId} is already taken`);
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO research_case_claims (
            id, case_id, account_id, statement, kind, limitations_json,
            sort_order, created_at, updated_at, withdrawn_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          claimId,
          ctx.caseId,
          ctx.accountId,
          draft.statement,
          draft.kind,
          JSON.stringify(draft.limitations),
          this.nextSortOrder('claim', ctx.caseId),
          timestamp,
          timestamp
        );
      // Role compatibility: factual claims only cite factual evidence; an
      // identity-link excerpt can never back a factual statement.
      const link = this.db.prepare(
        'INSERT INTO research_case_claim_evidence (claim_id, evidence_id, role, sort_order) VALUES (?, ?, ?, ?)'
      );
      draft.supportIds.forEach((evidenceId, index) => {
        this.requireEvidence(ctx.caseId, ctx.accountId, evidenceId, FACTUAL_SUPPORT_ROLE);
        link.run(claimId, evidenceId, 'support', index);
      });
      draft.counterevidenceIds.forEach((evidenceId, index) => {
        this.requireEvidence(ctx.caseId, ctx.accountId, evidenceId, FACTUAL_COUNTEREVIDENCE_ROLE);
        link.run(claimId, evidenceId, 'counterevidence', index);
      });
      return this.mapClaim(this.db.prepare('SELECT * FROM research_case_claims WHERE id = ?').get(claimId) as ClaimRow);
    });
  }

  /** Withdrawal keeps the claim and its id; only the timestamp is set. */
  withdrawClaim(ctx: CaseWriteContext, claimId: string): CaseClaim {
    return this.write(() => {
      this.validate(ctx);
      const row = this.db
        .prepare('SELECT * FROM research_case_claims WHERE id = ? AND case_id = ? AND account_id = ?')
        .get(claimId, ctx.caseId, ctx.accountId) as ClaimRow | undefined;
      if (!row) {
        throw new ForeignReferenceError(`claim ${claimId} is not owned by case ${ctx.caseId} account ${ctx.accountId}`);
      }
      if (row.withdrawn_at === null) {
        this.db.prepare('UPDATE research_case_claims SET withdrawn_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), claimId);
        this.bumpPersonRevision(ctx.caseId);
      }
      return this.mapClaim(this.db.prepare('SELECT * FROM research_case_claims WHERE id = ?').get(claimId) as ClaimRow);
    });
  }

  listClaims(ownerId: string, caseId: string): CaseClaim[] {
    if (!this.getCase(ownerId, caseId)) return [];
    const rows = this.db
      .prepare('SELECT * FROM research_case_claims WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
      .all(caseId) as ClaimRow[];
    return rows.map((row) => this.mapClaim(row));
  }

  /* ---------------------------------------------------------------- */
  /* Per-item coverage (typed task references)                        */
  /* ---------------------------------------------------------------- */

  /**
   * One coverage item per (locator, taskRef). The bound identity — account,
   * source/content id, source revision and taskRef key — is never rebound: an
   * explicit itemId must match all of it or the write is rejected atomically.
   * Writes append immutable revisions so every write's scopeVersion stays
   * readable as historical provenance instead of being overwritten.
   */
  recordItemCoverage(ctx: CaseWriteContext, draft: CoverageDraft): ItemCoverage {
    return this.write(() => {
      this.validate(ctx);
      if (draft.locator.accountId !== ctx.accountId) {
        throw new ForeignReferenceError(
          `coverage locator account ${draft.locator.accountId} does not match write context account ${ctx.accountId}`
        );
      }
      this.requireSourceRevision(ctx, draft.locator.sourceId, draft.locator.sourceRevision);
      const key = taskRefKey(draft.taskRef);
      const timestamp = nowIso();
      const byKey = this.db
        .prepare(
          `SELECT * FROM research_case_item_coverage
           WHERE case_id = ? AND account_id = ? AND source_id = ? AND source_revision = ? AND task_ref_key = ?`
        )
        .get(ctx.caseId, ctx.accountId, draft.locator.sourceId, draft.locator.sourceRevision, key) as
        | CoverageRow
        | undefined;
      let target = byKey;
      if (draft.itemId !== undefined) {
        const byId = this.db
          .prepare('SELECT * FROM research_case_item_coverage WHERE id = ? AND case_id = ?')
          .get(draft.itemId, ctx.caseId) as CoverageRow | undefined;
        if (!byId) {
          throw new ForeignReferenceError(`coverage item ${draft.itemId} is not part of case ${ctx.caseId}`);
        }
        const bound =
          byId.account_id === draft.locator.accountId &&
          byId.source_id === draft.locator.sourceId &&
          byId.source_revision === draft.locator.sourceRevision &&
          byId.task_ref_key === key;
        if (!bound) {
          throw new ForeignReferenceError(
            `coverage item ${byId.id} is bound to (${byId.account_id}, ${byId.source_id}@${byId.source_revision}, ${byId.task_ref_key}); rebinding is not allowed`
          );
        }
        target = byId;
      }
      if (target) {
        const next = target.latest_revision + 1;
        this.insertCoverageRevision(target.id, next, ctx, draft, timestamp);
        this.db
          .prepare('UPDATE research_case_item_coverage SET latest_revision = ?, updated_at = ? WHERE id = ?')
          .run(next, timestamp, target.id);
        return this.coverageItem(ctx.caseId, target.id);
      }
      // The item row commits before evidence validation, so a mixed
      // valid/invalid reference list rolls the whole write back.
      const itemId = newRecordId('cov');
      this.db
        .prepare(
          `INSERT INTO research_case_item_coverage (
            id, case_id, account_id, source_id, source_revision, task_ref_key, task_ref_json,
            latest_revision, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          itemId,
          ctx.caseId,
          ctx.accountId,
          draft.locator.sourceId,
          draft.locator.sourceRevision,
          key,
          JSON.stringify(draft.taskRef),
          this.nextSortOrder('coverage', ctx.caseId),
          timestamp,
          timestamp
        );
      this.insertCoverageRevision(itemId, 1, ctx, draft, timestamp);
      return this.coverageItem(ctx.caseId, itemId);
    });
  }

  /** Evidence polarity checks then one immutable revision row. */
  private insertCoverageRevision(
    itemId: string,
    revision: number,
    ctx: CaseWriteContext,
    draft: CoverageDraft,
    timestamp: string
  ): void {
    for (const evidenceId of draft.evidenceIds) {
      const row = this.requireEvidence(ctx.caseId, ctx.accountId, evidenceId);
      if (row.role !== FACTUAL_SUPPORT_ROLE && row.role !== IDENTITY_SUPPORT_ROLE) {
        throw new EvidenceRoleError(`evidence ${evidenceId} has role ${row.role}, expected a support role`);
      }
    }
    for (const evidenceId of draft.counterevidenceIds) {
      const row = this.requireEvidence(ctx.caseId, ctx.accountId, evidenceId);
      if (row.role !== FACTUAL_COUNTEREVIDENCE_ROLE && row.role !== IDENTITY_COUNTEREVIDENCE_ROLE) {
        throw new EvidenceRoleError(`evidence ${evidenceId} has role ${row.role}, expected a counterevidence role`);
      }
    }
    this.db
      .prepare(
        `INSERT INTO research_case_item_coverage_revisions (
          item_id, revision, scope_version, status, evidence_json, counterevidence_json, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        itemId,
        revision,
        ctx.expectedScopeVersion,
        draft.status,
        JSON.stringify(draft.evidenceIds),
        JSON.stringify(draft.counterevidenceIds),
        draft.note,
        timestamp
      );
  }

  private latestCoverageRevision(row: CoverageRow): CoverageRevisionRow {
    return this.db
      .prepare('SELECT * FROM research_case_item_coverage_revisions WHERE item_id = ? ORDER BY revision DESC LIMIT 1')
      .get(row.id) as CoverageRevisionRow;
  }

  private coverageItem(caseId: string, itemId: string): ItemCoverage {
    const row = this.db.prepare('SELECT * FROM research_case_item_coverage WHERE id = ?').get(itemId) as CoverageRow;
    return mapCoverageRevision(caseId, row, this.latestCoverageRevision(row));
  }

  listItemCoverage(ownerId: string, caseId: string): ItemCoverage[] {
    if (!this.getCase(ownerId, caseId)) return [];
    const rows = this.db
      .prepare('SELECT * FROM research_case_item_coverage WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
      .all(caseId) as CoverageRow[];
    return rows.map((row) => mapCoverageRevision(caseId, row, this.latestCoverageRevision(row)));
  }

  /** Immutable per-item history: older scoped coverage stays readable. */
  listItemCoverageHistory(ownerId: string, caseId: string, itemId: string): ItemCoverageRevision[] {
    if (!this.getCase(ownerId, caseId)) return [];
    const row = this.db
      .prepare('SELECT * FROM research_case_item_coverage WHERE id = ? AND case_id = ?')
      .get(itemId, caseId) as CoverageRow | undefined;
    if (!row) return [];
    const revisions = this.db
      .prepare('SELECT * FROM research_case_item_coverage_revisions WHERE item_id = ? ORDER BY revision ASC')
      .all(itemId) as CoverageRevisionRow[];
    return revisions.map((revision) => mapCoverageHistoryEntry(caseId, row, revision));
  }

  /* ---------------------------------------------------------------- */
  /* Canonical case report view                                       */
  /* ---------------------------------------------------------------- */

  reportView(ownerId: string, caseId: string): CaseReportView {
    const record = this.getCase(ownerId, caseId);
    if (!record) throw new CaseNotFoundError(caseId);
    const accounts = this.listAccounts(ownerId, caseId);
    const sourceRows = this.db
      .prepare('SELECT * FROM research_case_sources WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
      .all(caseId) as SourceRow[];
    const sources: CaseSourceView[] = sourceRows.map((source) => {
      const revisions = (
        this.db
          .prepare('SELECT * FROM research_case_source_revisions WHERE source_id = ? ORDER BY revision ASC')
          .all(source.id) as SourceRevisionRow[]
      ).map((row) => mapSourceRevision(caseId, source.account_id, row));
      return { sourceId: source.id, accountId: source.account_id, latestRevision: source.latest_revision, revisions };
    });
    const evidence = (
      this.db
        .prepare('SELECT * FROM research_case_evidence WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
        .all(caseId) as EvidenceRow[]
    ).map(mapEvidence);
    const claims = (
      this.db
        .prepare('SELECT * FROM research_case_claims WHERE case_id = ? ORDER BY sort_order ASC, id ASC')
        .all(caseId) as ClaimRow[]
    ).map((row) => this.mapClaim(row));
    const coverage = this.listItemCoverage(ownerId, caseId);
    return buildCaseReportView({ case: record, accounts, sources, evidence, claims, coverage });
  }
}
