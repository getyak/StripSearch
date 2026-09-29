import { randomUUID, createHash } from 'node:crypto';
import { ResearchStore } from './research/research-store.js';
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

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

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

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

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
  constructor(private readonly db: DB) { this.research = new ResearchStore(db); }

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
  isResearchSourceActive(runId: string, sourceKey: string, ownerId: string, visited = new Set<string>()): boolean {
    const key = `${runId}:${sourceKey}`;
    if (visited.has(key)) return false;
    const seen = new Set(visited); seen.add(key);
    const run = this.getRunForOwner(runId, ownerId);
    const source = run ? this.getSource(runId, sourceKey) : null;
    if (!run || !source || source.excluded) return false;
    const checkpoint = this.research.checkpoint(runId);
    const page = checkpoint?.pages.find(page => page.sourceKey === sourceKey);
    const anchor = checkpoint?.pages.find(page => page.url === checkpoint.anchorUrl);
    if (anchor && anchor.sourceKey !== sourceKey && !this.isResearchSourceActive(runId, anchor.sourceKey, ownerId, seen)) return false;
    return !page?.inheritedFrom || this.isResearchSourceActive(page.inheritedFrom.runId, page.inheritedFrom.sourceKey, ownerId, seen);
  }

  buildCanonicalView(run: RunRecord): CanonicalView {
    const checkpoint = run.provider === 'research' ? this.research.checkpoint(run.id) : null;
    const sources = this.listSources(run.id).map(source => checkpoint && !this.isResearchSourceActive(run.id, source.sourceKey, run.ownerId)
      ? { ...source, excluded: true, fetchStatus: 'excluded' as const }
      : source);
    const excluded = excludedSourceKeys(sources);
    const anchorRevoked = Boolean(checkpoint?.anchorUrl && sources.some(source => source.url === checkpoint.anchorUrl && source.excluded));
    if (anchorRevoked) sources.forEach(source => excluded.add(source.sourceKey));
    const observations = this.listObservations(run.id).map(observation => ({ ...observation,
      validity: validityFor(observation.sourceKeys, excluded), reviewReason: reviewReason(observation.sourceKeys, excluded)
    }));
    const answer: CanonicalAnswerSection[] = run.answer.map((section) => ({
      id: section.id,
      heading: section.heading,
      body: section.body,
      bullets: section.bullets.map((bullet) => ({
        text: bullet.text,
        sourceKeys: bullet.sourceKeys,
        kind: bullet.kind,
        validity: validityFor(bullet.sourceKeys, excluded),
        reviewReason: reviewReason(bullet.sourceKeys, excluded)
      }))
    }));
    const identity: CanonicalIdentity = {
      displayName: run.identity.displayName,
      handle: run.identity.handle,
      profileUrl: run.identity.profileUrl,
      status: run.identity.status,
      note: run.identity.note,
      candidates: run.identity.candidates
    };
    if (anchorRevoked) { identity.status = 'ambiguous'; identity.note = '人物主页证据已撤回，需要重新确认身份。'; }
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: run.id,
      state: run.state,
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
      stopReason: run.stopReason,
      identity,
      sources,
      observations,
      answer,
      limitations: run.limitations,
      usage: run.usage,
      reviewCount: countReviewItems(observations, answer),
      ...(checkpoint ? {
        research: { phase: checkpoint.phase, steps: checkpoint.steps, budget: this.research.budget(run.id), stopReason: run.stopReason ?? checkpoint.stopReason, unresolved: checkpoint.unknowns },
        ...(checkpoint.anchorUrl && identity.status === 'resolved' ? {
          personObject: {
            schemaVersion: 'stripsearch/person/v1' as const,
            person: { id: 'person_' + createHash('sha256').update(run.ownerId + '\0' + checkpoint.anchorUrl).digest('hex').slice(0,24), displayName: identity.displayName, profileUrl: checkpoint.anchorUrl },
            claims: checkpoint.claims.filter(claim => sources.some(source => source.sourceKey === claim.sourceKey && !source.excluded && source.excerpt?.includes(claim.quote))).map((claim,index) => ({id:`C${index+1}`,statement:claim.statement,kind:claim.kind,sourceKeys:[claim.sourceKey],evidenceIds:[`E${index+1}`]})),
            evidence: checkpoint.claims.filter(claim => sources.some(source => source.sourceKey === claim.sourceKey && !source.excluded && source.excerpt?.includes(claim.quote))).map((claim,index) => ({id:`E${index+1}`,sourceKey:claim.sourceKey,quote:claim.quote})),
            unknowns: checkpoint.unknowns,
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
      state: run.state,
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
        const unknown = this.research.receipts(row.id).some(receipt => receipt.state !== 'completed');
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
