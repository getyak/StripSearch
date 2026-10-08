/**
 * GET-99 real GitHub Fetch acquisition journal (phase 1 persistence).
 *
 * Durable per-request intent/outcome rows, the exact complete returned body
 * with its SHA-256, parsed listing rows, captured README/issue material and
 * the first page of issue comments (actual login/id attribution, original
 * permalink and complete body). Every settle commits its outcome + fold +
 * checkpoint in ONE transaction; a durable unresolved in-flight row stops the
 * run as unreconciled and is never blindly replayed; a persisted successful
 * request is never repeated (request_key dedupe); explicit cancel/stop rejects
 * late commits (no capture is persisted). There is no cumulative request,
 * item or history cap — the journal makes the acquisition resumable.
 */

import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { Store } from '../store.js';
import type {
  FetchGithubAccessScope,
  FetchGithubGapView,
  FetchGithubRequestKind,
  FetchGithubRequestState,
  FetchGithubRunPhase,
  FetchGithubRunState,
  FetchGithubTarget
} from '../../shared/research-fetch-github.js';

export interface FetchGithubRunRecord {
  runId: string;
  ownerId: string;
  caseId: string;
  scopeSpecId: string;
  scopeVersion: number;
  pipelineRunId: string | null;
  target: FetchGithubTarget;
  accessScope: FetchGithubAccessScope;
  question: string;
  confirmation: { target: string; question: string; accessScope: FetchGithubAccessScope; confirmedAt: string };
  idempotencyKey: string | null;
  bodyFingerprint: string | null;
  state: FetchGithubRunState;
  phase: FetchGithubRunPhase;
  revision: number;
  checkpoint: FetchGithubCheckpoint;
  stopReason: string | null;
  snapshotFrozenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FetchGithubRequestRecord {
  requestId: string;
  runId: string;
  requestKey: string;
  kind: FetchGithubRequestKind;
  url: string;
  attempt: number;
  state: FetchGithubRequestState;
  status: number | null;
  body: string | null;
  bodyHash: string | null;
  bodyBytes: number | null;
  linkHeader: string | null;
  apiVersion: string | null;
  gap: string | null;
  /** Set only by explicit user reconciliation of an unknown outcome. */
  reconciledAt: string | null;
  /**
   * Validated semantic capture outcome ('valid' | 'partial' | 'invalid'),
   * separate from HTTP settlement: an HTTP 200 whose payload is malformed,
   * non-array or carries unparseable rows is never a successful captured
   * read. NULL = not semantically assessed yet.
   */
  semanticState: 'valid' | 'partial' | 'invalid' | null;
  createdAt: string;
  settledAt: string | null;
}

export interface FetchGithubListingRowRecord {
  id: string;
  runId: string;
  listingKind: 'repos' | 'issues';
  rowKey: string;
  requestKey: string;
  row: Record<string, unknown>;
  createdAt: string;
}

export interface FetchGithubItemRecord {
  id: string;
  runId: string;
  itemKey: string;
  kind: 'readme' | 'issue' | 'pull_request';
  accountId: string;
  title: string;
  originalUrl: string | null;
  authorLogin: string | null;
  authorId: number | null;
  publishedAt: string | null;
  fulltext: string;
  bodyHash: string;
  bodyBytes: number;
  sourceId: string;
  sourceRevision: number;
  requestKey: string;
  processingEligible: boolean;
  processingGap: string | null;
  createdAt: string;
}

export interface FetchGithubCommentRecord {
  id: string;
  runId: string;
  itemKey: string;
  commentId: string;
  authorLogin: string | null;
  authorId: number | null;
  authorRole: 'subject' | 'third_party' | 'unknown';
  originalUrl: string | null;
  body: string;
  bodyHash: string;
  excerpt: string;
  commentCreatedAt: string | null;
  createdAt: string;
}

export interface FetchGithubEventRecord {
  seq: number;
  eventId: string;
  runId: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface FetchGithubListingCursor {
  /** Terminal boundary proven (no further Link continuation). */
  done: boolean;
  pagesDone: number;
  /** Validated continuation URL for the next page; null = start or terminal. */
  nextUrl: string | null;
  /** Continuation identities already issued (duplicate/cyclic detection). */
  seenContinuations: string[];
  gaps: string[];
}

export interface FetchGithubCheckpoint {
  version: 'fetch-github-acquisition/v1';
  target: FetchGithubTarget;
  /** `user` / `org` known only from the settled public profile response. */
  accountKind: 'user' | 'org' | null;
  /** Numeric ids verified from PUBLIC metadata (Link id-form binding). */
  verified: { accountId: number | null; repoId: number | null };
  /**
   * The ACTUAL case-bound account id created at start (never a global
   * login-derived id): the same login in two cases never collides or merges.
   */
  accountId: string;
  /** True only after public metadata confirmed private=false for a repo target. */
  publicConfirmed: boolean;
  /** Whether `type=owner` applies to the user-repos listing request. */
  reposListingBuilt: boolean;
  /**
   * Request keys the user EXPLICITLY authorised for re-issue after an
   * unknown outcome. Set only by an explicit resume action — unknown
   * outcomes are never retried automatically.
   */
  retryRequestKeys: string[];
  /** Missing on legacy checkpoints whose bare retry keys are ambiguous. */
  retryAuthorizationVersion?: 2;
  listings: {
    repos: FetchGithubListingCursor | null;
    issues: FetchGithubListingCursor | null;
  };
  gaps: FetchGithubGapView[];
  snapshot: { frozen: boolean; digest: string | null; frozenAt: string | null };
}

export function createFetchGithubCheckpoint(target: FetchGithubTarget, accountId: string): FetchGithubCheckpoint {
  return {
    version: 'fetch-github-acquisition/v1',
    target,
    accountId,
    accountKind: null,
    verified: { accountId: null, repoId: null },
    publicConfirmed: false,
    reposListingBuilt: false,
    retryRequestKeys: [],
    retryAuthorizationVersion: 2,
    listings: { repos: null, issues: null },
    gaps: [],
    snapshot: { frozen: false, digest: null, frozenAt: null }
  };
}

export interface BeginRequestInput {
  runId: string;
  requestKey: string;
  kind: FetchGithubRequestKind;
  url: string;
}

export interface SettleRequestInput {
  state: Extract<FetchGithubRequestState, 'succeeded' | 'failed' | 'unknown'>;
  status: number | null;
  body: string | null;
  bodyHash: string | null;
  bodyBytes: number | null;
  linkHeader: string | null;
  apiVersion: string | null;
  gap: string | null;
}

export interface PutItemInput {
  runId: string;
  itemKey: string;
  kind: 'readme' | 'issue' | 'pull_request';
  accountId: string;
  title: string;
  originalUrl: string | null;
  authorLogin: string | null;
  authorId: number | null;
  publishedAt: string | null;
  fulltext: string;
  bodyHash: string;
  sourceId: string;
  sourceRevision: number;
  requestKey: string;
  processingEligible: boolean;
  processingGap: string | null;
}

export type PutItemResult =
  | { outcome: 'created' }
  | { outcome: 'duplicate' }
  | { outcome: 'hash_changed'; detail: string };

function nowIso(): string {
  return new Date().toISOString();
}

function recordId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

interface RunRow {
  id: string;
  owner_id: string;
  case_id: string;
  scope_spec_id: string;
  scope_version: number;
  pipeline_run_id: string | null;
  target_json: string;
  access_scope: string;
  question: string;
  confirmation_json: string;
  idempotency_key: string | null;
  body_fingerprint: string | null;
  state: string;
  phase: string;
  revision: number;
  checkpoint_json: string;
  stop_reason: string | null;
  snapshot_frozen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: string;
  run_id: string;
  request_key: string;
  kind: string;
  url: string;
  attempt: number;
  state: string;
  status: number | null;
  body: string | null;
  body_hash: string | null;
  body_bytes: number | null;
  link_header: string | null;
  api_version: string | null;
  gap: string | null;
  reconciled_at: string | null;
  semantic_state: string | null;
  created_at: string;
  settled_at: string | null;
}

export class FetchGithubStore {
  constructor(
    private readonly db: DB,
    private readonly store: Store
  ) {}

  /** Single transaction boundary: settle + fold + checkpoint commit together. */
  inTransaction<T>(fn: () => T): T {
    return this.store.inTransaction(fn);
  }

  createRun(input: {
    ownerId: string;
    caseId: string;
    scopeSpecId: string;
    scopeVersion: number;
    target: FetchGithubTarget;
    accessScope: FetchGithubAccessScope;
    question: string;
    confirmation: FetchGithubRunRecord['confirmation'];
    checkpoint: FetchGithubCheckpoint;
    idempotencyKey?: string | null;
    bodyFingerprint?: string | null;
  }): FetchGithubRunRecord {
    const runId = recordId('fetchgh');
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO research_fetch_github_runs
          (id, owner_id, case_id, scope_spec_id, scope_version, pipeline_run_id, target_json, access_scope,
           question, confirmation_json, idempotency_key, body_fingerprint, state, phase, revision,
           checkpoint_json, stop_reason, snapshot_frozen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'acquiring', 'acquire', 0, ?, NULL, NULL, ?, ?)`
      )
      .run(
        runId,
        input.ownerId,
        input.caseId,
        input.scopeSpecId,
        input.scopeVersion,
        JSON.stringify(input.target),
        input.accessScope,
        input.question,
        JSON.stringify(input.confirmation),
        input.idempotencyKey ?? null,
        input.bodyFingerprint ?? null,
        JSON.stringify(input.checkpoint),
        at,
        at
      );
    return this.requireRun(runId);
  }

  getRunForOwner(runId: string, ownerId: string): FetchGithubRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM research_fetch_github_runs WHERE id = ? AND owner_id = ?')
      .get(runId, ownerId) as RunRow | undefined;
    return row ? this.hydrateRun(row) : null;
  }

  requireRun(runId: string): FetchGithubRunRecord {
    const row = this.db.prepare('SELECT * FROM research_fetch_github_runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) throw new Error(`fetch github run not found: ${runId}`);
    return this.hydrateRun(row);
  }

  listRunsForOwner(ownerId: string): FetchGithubRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM research_fetch_github_runs WHERE owner_id = ? ORDER BY created_at DESC, id DESC')
      .all(ownerId) as RunRow[];
    return rows.map((row) => this.hydrateRun(row));
  }

  /**
   * Key-based idempotency matching the legacy routes: only the SAME key with
   * the SAME normalized request fingerprint resolves to an existing run.
   */
  findByIdempotency(
    ownerId: string,
    idempotencyKey: string
  ): { runId: string; bodyFingerprint: string | null } | null {
    const row = this.db
      .prepare('SELECT id, body_fingerprint FROM research_fetch_github_runs WHERE owner_id = ? AND idempotency_key = ?')
      .get(ownerId, idempotencyKey) as { id: string; body_fingerprint: string | null } | undefined;
    return row ? { runId: row.id, bodyFingerprint: row.body_fingerprint } : null;
  }

  recordIdempotency(ownerId: string, idempotencyKey: string, bodyFingerprint: string, runId: string): void {
    this.db
      .prepare('UPDATE research_fetch_github_runs SET idempotency_key = ?, body_fingerprint = ? WHERE id = ? AND owner_id = ?')
      .run(idempotencyKey, bodyFingerprint, runId, ownerId);
  }

  private hydrateRun(row: RunRow): FetchGithubRunRecord {
    return {
      runId: row.id,
      ownerId: row.owner_id,
      caseId: row.case_id,
      scopeSpecId: row.scope_spec_id,
      scopeVersion: row.scope_version,
      pipelineRunId: row.pipeline_run_id,
      target: JSON.parse(row.target_json) as FetchGithubTarget,
      accessScope: row.access_scope as FetchGithubAccessScope,
      question: row.question,
      confirmation: JSON.parse(row.confirmation_json) as FetchGithubRunRecord['confirmation'],
      idempotencyKey: row.idempotency_key,
      bodyFingerprint: row.body_fingerprint,
      state: row.state as FetchGithubRunState,
      phase: row.phase as FetchGithubRunPhase,
      revision: row.revision,
      checkpoint: JSON.parse(row.checkpoint_json) as FetchGithubCheckpoint,
      stopReason: row.stop_reason,
      snapshotFrozenAt: row.snapshot_frozen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  updateRun(
    runId: string,
    patch: {
      state?: FetchGithubRunState;
      phase?: FetchGithubRunPhase;
      stopReason?: string | null;
      pipelineRunId?: string | null;
      snapshotFrozenAt?: string | null;
    }
  ): FetchGithubRunRecord {
    const current = this.requireRun(runId);
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE research_fetch_github_runs
            SET state = ?, phase = ?, stop_reason = ?, pipeline_run_id = ?, snapshot_frozen_at = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = ?`
      )
      .run(
        patch.state ?? current.state,
        patch.phase ?? current.phase,
        patch.stopReason === undefined ? current.stopReason : patch.stopReason,
        patch.pipelineRunId === undefined ? current.pipelineRunId : patch.pipelineRunId,
        patch.snapshotFrozenAt === undefined ? current.snapshotFrozenAt : patch.snapshotFrozenAt,
        at,
        runId
      );
    return this.requireRun(runId);
  }

  updateCheckpoint(runId: string, checkpoint: FetchGithubCheckpoint): void {
    this.db
      .prepare('UPDATE research_fetch_github_runs SET checkpoint_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(checkpoint), nowIso(), runId);
  }

  /* ---------------------------------------------------------------- */
  /* Requests: durable intent before HTTP, exact bodies on settle     */
  /* ---------------------------------------------------------------- */

  /**
   * Durable per-request intent BEFORE any HTTP. A request key that already
   * has a persisted SUCCESSFUL response is refused: successful requests are
   * never repeated. A prior unknown/failed outcome may be re-issued only as
   * an explicit new attempt (never automatically).
   */
  beginRequest(input: BeginRequestInput): { request: FetchGithubRequestRecord; attempt: number } {
    const prior = this.db
      .prepare('SELECT * FROM research_fetch_github_requests WHERE run_id = ? AND request_key = ? ORDER BY attempt')
      .all(input.runId, input.requestKey) as RequestRow[];
    if (prior.some((row) => row.state === 'succeeded')) {
      throw new Error(`fetch github: request already settled successfully, refusing to repeat ${input.requestKey}`);
    }
    const attempt = (prior[prior.length - 1]?.attempt ?? 0) + 1;
    const requestId = recordId('fetchreq');
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO research_fetch_github_requests
          (id, run_id, request_key, kind, url, attempt, state, status, body, body_hash, body_bytes,
           link_header, api_version, gap, reconciled_at, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in_flight', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`
      )
      .run(requestId, input.runId, input.requestKey, input.kind, input.url, attempt, at);
    return { request: this.requireRequest(requestId), attempt };
  }

  requireRequest(requestId: string): FetchGithubRequestRecord {
    const row = this.db.prepare('SELECT * FROM research_fetch_github_requests WHERE id = ?').get(requestId) as
      | RequestRow
      | undefined;
    if (!row) throw new Error(`fetch github request not found: ${requestId}`);
    return this.hydrateRequest(row);
  }

  private hydrateRequest(row: RequestRow): FetchGithubRequestRecord {
    return {
      requestId: row.id,
      runId: row.run_id,
      requestKey: row.request_key,
      kind: row.kind as FetchGithubRequestKind,
      url: row.url,
      attempt: row.attempt,
      state: row.state as FetchGithubRequestState,
      status: row.status,
      body: row.body,
      bodyHash: row.body_hash,
      bodyBytes: row.body_bytes,
      linkHeader: row.link_header,
      apiVersion: row.api_version,
      gap: row.gap,
      reconciledAt: row.reconciled_at,
      semanticState:
        row.semantic_state === 'valid' || row.semantic_state === 'partial' || row.semantic_state === 'invalid'
          ? row.semantic_state
          : null,
      createdAt: row.created_at,
      settledAt: row.settled_at
    };
  }

  listRequests(runId: string): FetchGithubRequestRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM research_fetch_github_requests WHERE run_id = ? ORDER BY created_at, attempt')
      .all(runId) as RequestRow[];
    return rows.map((row) => this.hydrateRequest(row));
  }

  /**
   * Unresolved outcomes stop the run as unreconciled BEFORE any next HTTP or
   * snapshot freeze: in-flight rows (crash) and unknown outcomes (timeout,
   * transport fault after dispatch, control-fence rejection) that have NOT
   * been explicitly reconciled by the user.
   */
  listUnresolvedRequests(runId: string): FetchGithubRequestRecord[] {
    return this.listRequests(runId).filter(
      (request) =>
        request.state === 'in_flight' || (request.state === 'unknown' && request.reconciledAt === null)
    );
  }

  /**
   * Record the validated semantic capture outcome for one settled request,
   * inside the SAME transaction as the settle + fold. HTTP settlement and
   * semantic capture stay separate facts.
   */
  setRequestSemantic(
    requestId: string,
    semanticState: 'valid' | 'partial' | 'invalid'
  ): FetchGithubRequestRecord {
    this.db
      .prepare("UPDATE research_fetch_github_requests SET semantic_state = ? WHERE id = ?")
      .run(semanticState, requestId);
    return this.requireRequest(requestId);
  }

  /** Explicit user reconciliation of every unresolved request ('abandon'). */
  reconcileUnknownRequests(runId: string, resolution: 'abandon'): FetchGithubRequestRecord[] {
    const reconciled: FetchGithubRequestRecord[] = [];
    for (const request of this.listUnresolvedRequests(runId)) {
      this.db
        .prepare(
          `UPDATE research_fetch_github_requests
              SET state = 'unknown',
                  gap = COALESCE(gap, ?),
                  reconciled_at = ?,
                  settled_at = COALESCE(settled_at, ?)
            WHERE id = ?`
        )
        .run(`explicit reconciliation: ${resolution}; outcome unknown, cost unknown`, nowIso(), nowIso(), request.requestId);
      reconciled.push(this.requireRequest(request.requestId));
    }
    return reconciled;
  }

  /** The exact settle write; callers wrap it with the fold in one transaction. */
  settleRequest(requestId: string, input: SettleRequestInput): FetchGithubRequestRecord {
    this.db
      .prepare(
        `UPDATE research_fetch_github_requests
            SET state = ?, status = ?, body = ?, body_hash = ?, body_bytes = ?, link_header = ?,
                api_version = ?, gap = ?, settled_at = ?
          WHERE id = ? AND state = 'in_flight'`
      )
      .run(
        input.state,
        input.status,
        input.body,
        input.bodyHash,
        input.bodyBytes,
        input.linkHeader,
        input.apiVersion,
        input.gap,
        nowIso(),
        requestId
      );
    return this.requireRequest(requestId);
  }

  /**
   * Reject a late packet after explicit cancel/stop or scope change: the
   * body and any capture are NOT persisted; the row records only the
   * rejection so the journal still explains what happened.
   */
  rejectRequest(requestId: string, gap: string): FetchGithubRequestRecord {
    this.db
      .prepare(
        `UPDATE research_fetch_github_requests
            SET state = 'rejected', gap = ?, settled_at = ?
          WHERE id = ? AND state = 'in_flight'`
      )
      .run(gap, nowIso(), requestId);
    return this.requireRequest(requestId);
  }

  /* ---------------------------------------------------------------- */
  /* Listing rows / items / comments (fold; atomic with the settle)   */
  /* ---------------------------------------------------------------- */

  putListingRow(input: {
    runId: string;
    listingKind: 'repos' | 'issues';
    rowKey: string;
    requestKey: string;
    row: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO research_fetch_github_listing_rows (id, run_id, listing_kind, row_key, request_key, row_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, listing_kind, row_key) DO NOTHING`
      )
      .run(recordId('fetchrow'), input.runId, input.listingKind, input.rowKey, input.requestKey, JSON.stringify(input.row), nowIso());
  }

  listListingRows(runId: string, listingKind: 'repos' | 'issues'): FetchGithubListingRowRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM research_fetch_github_listing_rows WHERE run_id = ? AND listing_kind = ? ORDER BY created_at, id')
      .all(runId, listingKind) as {
      id: string;
      run_id: string;
      listing_kind: string;
      row_key: string;
      request_key: string;
      row_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      listingKind: row.listing_kind as 'repos' | 'issues',
      rowKey: row.row_key,
      requestKey: row.request_key,
      row: JSON.parse(row.row_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  /**
   * Same-source dedupe on (run_id, item_key): an identical capture is
   * recorded once; a changed hash keeps the FIRST frozen capture and records
   * an explicit gap — completed snapshot/source pins never silently change.
   */
  putItem(input: PutItemInput): PutItemResult {
    const existing = this.db
      .prepare('SELECT * FROM research_fetch_github_items WHERE run_id = ? AND item_key = ?')
      .get(input.runId, input.itemKey) as { body_hash: string } | undefined;
    if (existing) {
      return existing.body_hash === input.bodyHash
        ? { outcome: 'duplicate' }
        : {
            outcome: 'hash_changed',
            detail: `item ${input.itemKey} returned a changed body hash; keeping the first frozen capture`
          };
    }
    this.db
      .prepare(
        `INSERT INTO research_fetch_github_items
          (id, run_id, item_key, kind, account_id, title, original_url, author_login, author_id, published_at,
           fulltext, body_hash, body_bytes, source_id, source_revision, request_key, processing_eligible,
           processing_gap, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        recordId('fetchitem'),
        input.runId,
        input.itemKey,
        input.kind,
        input.accountId,
        input.title,
        input.originalUrl,
        input.authorLogin,
        input.authorId,
        input.publishedAt,
        input.fulltext,
        input.bodyHash,
        Buffer.byteLength(input.fulltext, 'utf8'),
        input.sourceId,
        input.sourceRevision,
        input.requestKey,
        input.processingEligible ? 1 : 0,
        input.processingGap,
        nowIso()
      );
    return { outcome: 'created' };
  }

  listItems(runId: string): FetchGithubItemRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM research_fetch_github_items WHERE run_id = ? ORDER BY created_at, id')
      .all(runId) as {
      id: string;
      run_id: string;
      item_key: string;
      kind: string;
      account_id: string;
      title: string;
      original_url: string | null;
      author_login: string | null;
      author_id: number | null;
      published_at: string | null;
      fulltext: string;
      body_hash: string;
      body_bytes: number;
      source_id: string;
      source_revision: number;
      request_key: string;
      processing_eligible: number;
      processing_gap: string | null;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      itemKey: row.item_key,
      kind: row.kind as FetchGithubItemRecord['kind'],
      accountId: row.account_id,
      title: row.title,
      originalUrl: row.original_url,
      authorLogin: row.author_login,
      authorId: row.author_id,
      publishedAt: row.published_at,
      fulltext: row.fulltext,
      bodyHash: row.body_hash,
      bodyBytes: row.body_bytes,
      sourceId: row.source_id,
      sourceRevision: row.source_revision,
      requestKey: row.request_key,
      processingEligible: row.processing_eligible === 1,
      processingGap: row.processing_gap,
      createdAt: row.created_at
    }));
  }

  putComment(input: {
    runId: string;
    itemKey: string;
    commentId: string;
    authorLogin: string | null;
    authorId: number | null;
    authorRole: 'subject' | 'third_party' | 'unknown';
    originalUrl: string | null;
    body: string;
    bodyHash: string;
    excerpt: string;
    commentCreatedAt: string | null;
  }): 'created' | 'duplicate' | 'hash_changed' {
    const existing = this.db
      .prepare('SELECT id, body_hash FROM research_fetch_github_comments WHERE run_id = ? AND item_key = ? AND comment_id = ?')
      .get(input.runId, input.itemKey, input.commentId) as { id: string; body_hash: string } | undefined;
    if (existing) {
      // Same-source dedupe: an identical comment body is stored once.
      return existing.body_hash === input.bodyHash ? 'duplicate' : 'hash_changed';
    }
    this.db
      .prepare(
        `INSERT INTO research_fetch_github_comments
          (id, run_id, item_key, comment_id, author_login, author_id, author_role, original_url,
           body, body_hash, excerpt, comment_created_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        recordId('fetchcmt'),
        input.runId,
        input.itemKey,
        input.commentId,
        input.authorLogin,
        input.authorId,
        input.authorRole,
        input.originalUrl,
        input.body,
        input.bodyHash,
        input.excerpt,
        input.commentCreatedAt,
        nowIso()
      );
    return 'created';
  }

  listComments(runId: string, itemKey?: string): FetchGithubCommentRecord[] {
    const rows = (
      itemKey === undefined
        ? this.db.prepare('SELECT * FROM research_fetch_github_comments WHERE run_id = ? ORDER BY created_at, id').all(runId)
        : this.db
            .prepare('SELECT * FROM research_fetch_github_comments WHERE run_id = ? AND item_key = ? ORDER BY created_at, id')
            .all(runId, itemKey)
    ) as {
      id: string;
      run_id: string;
      item_key: string;
      comment_id: string;
      author_login: string | null;
      author_id: number | null;
      author_role: string;
      original_url: string | null;
      body: string;
      body_hash: string;
      excerpt: string;
      comment_created_at: string | null;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      itemKey: row.item_key,
      commentId: row.comment_id,
      authorLogin: row.author_login,
      authorId: row.author_id,
      authorRole: row.author_role as FetchGithubCommentRecord['authorRole'],
      originalUrl: row.original_url,
      body: row.body,
      bodyHash: row.body_hash,
      excerpt: row.excerpt,
      commentCreatedAt: row.comment_created_at,
      createdAt: row.created_at
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Events (append-only audit)                                       */
  /* ---------------------------------------------------------------- */

  appendEvent(runId: string, kind: string, payload: unknown): FetchGithubEventRecord {
    const eventId = recordId('fetchevt');
    const at = nowIso();
    this.db
      .prepare(
        'INSERT INTO research_fetch_github_events (id, run_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(eventId, runId, kind, JSON.stringify(payload ?? null), at);
    const row = this.db
      .prepare('SELECT seq, id, run_id, kind, payload_json, created_at FROM research_fetch_github_events WHERE id = ?')
      .get(eventId) as { seq: number; id: string; run_id: string; kind: string; payload_json: string; created_at: string };
    return {
      seq: row.seq,
      eventId: row.id,
      runId: row.run_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at
    };
  }

  listEvents(runId: string): FetchGithubEventRecord[] {
    const rows = this.db
      .prepare('SELECT seq, id, run_id, kind, payload_json, created_at FROM research_fetch_github_events WHERE run_id = ? ORDER BY seq')
      .all(runId) as {
      seq: number;
      id: string;
      run_id: string;
      kind: string;
      payload_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      eventId: row.id,
      runId: row.run_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at
    }));
  }
}
