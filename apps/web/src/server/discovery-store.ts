/**
 * Durable store for platform discovery tasks.
 *
 * Persistence invariants:
 *
 * - A probe row is keyed by (task, probeKey) and upserted, so a resumed task
 *   never re-runs or double-counts a question that already has an answer.
 * - Account links are append-only revisions: every correction records actor,
 *   basis, note and the before/after state. Nothing is silently rewritten.
 * - Tracked posts depend on their account link. Dismissing a link revokes the
 *   posts attributed through it (excluded + excluded_at) and re-opening the
 *   link restores them; the cascade is explicit and recorded as events.
 * - Late writes after cancellation or completion are dropped through
 *   `updateTaskIfActive`, so a slow probe can never resurrect a terminal task.
 */

import type {
  DiscoveryAuthorization,
  DiscoveryCheckpoint,
  DiscoveryLimits,
  DiscoveryStage,
  DiscoverySubjectKind,
  DiscoveryTaskState,
  DiscoveryUsage,
  LinkBasis,
  LinkState,
  ProbeMethod,
  ProbeResultDraft,
  ProbeVerification,
  ProbeReceipt,
  ProbeEvidence,
  TrackedPostDraft,
  TrackedPostFetchStatus
} from '../shared/platform-discovery.js';
import {
  attributionFor,
  emptyCheckpoint,
  emptyUsage
} from '../shared/platform-discovery.js';
import type { DB } from './db/index.js';
import { newId, nowIso } from './store.js';

export interface DiscoveryTaskRecord {
  id: string;
  ownerId: string;
  subjectKind: DiscoverySubjectKind;
  subjectValue: string;
  authorization: DiscoveryAuthorization;
  seedUrl: string | null;
  mode: 'discover' | 'discover_and_track';
  state: DiscoveryTaskState;
  stage: DiscoveryStage;
  registryVersion: string;
  idempotencyKey: string | null;
  bodyFingerprint: string;
  revision: number;
  checkpoint: DiscoveryCheckpoint;
  limits: DiscoveryLimits;
  usage: DiscoveryUsage;
  stopReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  interrupted: boolean;
  cancelRequested: boolean;
  needsInputPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DiscoveryProbeRecord {
  id: string;
  taskId: string;
  probeKey: string;
  platformId: string;
  method: ProbeMethod;
  status: ProbeResultDraft['status'];
  handle: string | null;
  profileUrl: string | null;
  evidence: ProbeEvidence | null;
  verification: ProbeVerification;
  receipt: ProbeReceipt;
  limitations: string[];
  requests: number;
  bytes: number;
  sortOrder: number;
  createdAt: string;
}

export interface AccountLinkRecord {
  id: string;
  taskId: string;
  platformId: string;
  handle: string | null;
  profileUrl: string | null;
  state: LinkState;
  basis: LinkBasis[];
  counterevidence: string | null;
  note: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface LinkRevisionRecord {
  seq: number;
  linkId: string;
  revision: number;
  action: string;
  fromState: LinkState;
  toState: LinkState;
  basis: LinkBasis[];
  note: string | null;
  counterevidence: string | null;
  actor: string;
  createdAt: string;
}

export interface TrackedPostRecord extends TrackedPostDraft {
  id: string;
  taskId: string;
  excluded: boolean;
  excludedAt: string | null;
  linkState: LinkState;
  attribution: 'linked' | 'unattributed' | 'revoked';
  valid: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface DiscoveryEventRecord {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface DiscoveryImportRecord {
  id: string;
  taskId: string;
  tool: string;
  reportFormat: string;
  toolVersion: string | null;
  generatedAt: string | null;
  resultCount: number;
  warnings: string[];
  contentHash: string;
  createdAt: string;
}

interface TaskRow {
  id: string;
  owner_id: string;
  subject_kind: DiscoverySubjectKind;
  subject_value: string;
  authorization: DiscoveryAuthorization;
  seed_url: string | null;
  mode: 'discover' | 'discover_and_track';
  state: DiscoveryTaskState;
  stage: DiscoveryStage;
  registry_version: string;
  idempotency_key: string | null;
  body_fingerprint: string;
  revision: number;
  checkpoint_json: string;
  limits_json: string;
  usage_json: string;
  stop_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  interrupted: number;
  cancel_requested: number;
  needs_input_prompt: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ProbeRow {
  id: string;
  task_id: string;
  probe_key: string;
  platform_id: string;
  method: ProbeMethod;
  status: ProbeResultDraft['status'];
  handle: string | null;
  profile_url: string | null;
  evidence_json: string;
  verification: ProbeVerification;
  receipt_json: string;
  limitations_json: string;
  requests: number;
  bytes: number;
  sort_order: number;
  created_at: string;
}

interface LinkRow {
  id: string;
  task_id: string;
  platform_id: string;
  handle: string | null;
  profile_url: string | null;
  state: LinkState;
  basis_json: string;
  counterevidence: string | null;
  note: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface PostRow {
  id: string;
  task_id: string;
  account_link_id: string;
  post_key: string;
  platform_id: string;
  url: string;
  title: string;
  published_at: string | null;
  excerpt: string | null;
  excerpt_locator: string | null;
  fetch_status: TrackedPostFetchStatus;
  limits_json: string;
  excluded: number;
  excluded_at: string | null;
  sort_order: number;
  created_at: string;
  link_state: LinkState;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapTask(row: TaskRow): DiscoveryTaskRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    subjectKind: row.subject_kind,
    subjectValue: row.subject_value,
    authorization: row.authorization,
    seedUrl: row.seed_url,
    mode: row.mode,
    state: row.state,
    stage: row.stage,
    registryVersion: row.registry_version,
    idempotencyKey: row.idempotency_key,
    bodyFingerprint: row.body_fingerprint,
    revision: row.revision,
    checkpoint: parseJson<DiscoveryCheckpoint>(row.checkpoint_json, emptyCheckpoint()),
    limits: parseJson<DiscoveryLimits>(row.limits_json, {
      maxProbes: 40,
      maxPostsPerLink: 20,
      maxRequests: 80,
      maxBytes: 2 * 1024 * 1024
    }),
    usage: parseJson<DiscoveryUsage>(row.usage_json, emptyUsage()),
    stopReason: row.stop_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    interrupted: row.interrupted === 1,
    cancelRequested: row.cancel_requested === 1,
    needsInputPrompt: row.needs_input_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function mapProbe(row: ProbeRow): DiscoveryProbeRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    probeKey: row.probe_key,
    platformId: row.platform_id,
    method: row.method,
    status: row.status,
    handle: row.handle,
    profileUrl: row.profile_url,
    evidence: parseJson<ProbeEvidence | null>(row.evidence_json, null),
    verification: row.verification,
    receipt: parseJson<ProbeReceipt>(row.receipt_json, {
      tool: 'unknown',
      toolVersion: null,
      generatedAt: null,
      reportFormat: 'unknown'
    }),
    limitations: parseJson<string[]>(row.limitations_json, []),
    requests: row.requests,
    bytes: row.bytes,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  };
}

function mapLink(row: LinkRow): AccountLinkRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    platformId: row.platform_id,
    handle: row.handle,
    profileUrl: row.profile_url,
    state: row.state,
    basis: parseJson<LinkBasis[]>(row.basis_json, []),
    counterevidence: row.counterevidence,
    note: row.note,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPost(row: PostRow): TrackedPostRecord {
  const attribution = attributionFor(row.link_state);
  return {
    id: row.id,
    taskId: row.task_id,
    postKey: row.post_key,
    accountLinkId: row.account_link_id,
    platformId: row.platform_id,
    url: row.url,
    title: row.title,
    publishedAt: row.published_at,
    excerpt: row.excerpt,
    excerptLocator: row.excerpt_locator,
    fetchStatus: row.excluded ? 'excluded' : row.fetch_status,
    limits: parseJson<string[]>(row.limits_json, []),
    excluded: row.excluded === 1,
    excludedAt: row.excluded_at,
    linkState: row.link_state,
    attribution,
    valid: attribution === 'linked' && row.excluded !== 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at
  };
}

export class DiscoveryTerminalError extends Error {
  constructor(readonly taskId: string) {
    super(`discovery task ${taskId} is no longer writable`);
    this.name = 'DiscoveryTerminalError';
  }
}

export interface CreateDiscoveryTaskInput {
  ownerId: string;
  subjectKind: DiscoverySubjectKind;
  subjectValue: string;
  authorization: DiscoveryAuthorization;
  seedUrl: string | null;
  mode: 'discover' | 'discover_and_track';
  registryVersion: string;
  idempotencyKey: string | null;
  bodyFingerprint: string;
  limits: DiscoveryLimits;
}

export class DiscoveryStore {
  constructor(private readonly db: DB) {}

  insertTask(input: CreateDiscoveryTaskInput): DiscoveryTaskRecord {
    const timestamp = nowIso();
    const id = newId('dtask');
    this.db
      .prepare(
        `INSERT INTO discovery_tasks (
          id, owner_id, subject_kind, subject_value, authorization, seed_url, mode, state, stage, registry_version,
          idempotency_key, body_fingerprint, revision, checkpoint_json, limits_json, usage_json,
          stop_reason, error_code, error_message, interrupted, cancel_requested, needs_input_prompt,
          created_at, updated_at, started_at, finished_at
        ) VALUES (
          @id, @owner_id, @subject_kind, @subject_value, @authorization, @seed_url, @mode, @state, @stage, @registry_version,
          @idempotency_key, @body_fingerprint, @revision, @checkpoint_json, @limits_json, @usage_json,
          @stop_reason, @error_code, @error_message, @interrupted, @cancel_requested, @needs_input_prompt,
          @created_at, @updated_at, @started_at, @finished_at
        )`
      )
      .run({
        id,
        owner_id: input.ownerId,
        subject_kind: input.subjectKind,
        subject_value: input.subjectValue,
        authorization: input.authorization,
        seed_url: input.seedUrl,
        mode: input.mode,
        state: 'queued',
        stage: 'discover',
        registry_version: input.registryVersion,
        idempotency_key: input.idempotencyKey,
        body_fingerprint: input.bodyFingerprint,
        revision: 1,
        checkpoint_json: JSON.stringify(emptyCheckpoint()),
        limits_json: JSON.stringify(input.limits),
        usage_json: JSON.stringify(emptyUsage()),
        stop_reason: null,
        error_code: null,
        error_message: null,
        interrupted: 0,
        cancel_requested: 0,
        needs_input_prompt: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: null,
        finished_at: null
      });
    const created = this.getTask(id);
    if (!created) throw new Error('failed to insert discovery task');
    return created;
  }

  getTask(id: string): DiscoveryTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM discovery_tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    return row ? mapTask(row) : null;
  }

  getTaskForOwner(id: string, ownerId: string): DiscoveryTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM discovery_tasks WHERE id = ? AND owner_id = ?')
      .get(id, ownerId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  listTasksForOwner(ownerId: string, limit = 50): DiscoveryTaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM discovery_tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(ownerId, limit) as TaskRow[];
    return rows.map(mapTask);
  }

  countTasksForOwner(ownerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM discovery_tasks WHERE owner_id = ?')
      .get(ownerId) as { n: number };
    return row.n;
  }

  findIdempotencyKey(ownerId: string, key: string): { fingerprint: string; taskId: string } | null {
    const row = this.db
      .prepare(
        'SELECT fingerprint, task_id FROM discovery_idempotency_keys WHERE owner_id = ? AND key = ?'
      )
      .get(ownerId, key) as { fingerprint: string; task_id: string } | undefined;
    return row ? { fingerprint: row.fingerprint, taskId: row.task_id } : null;
  }

  recordIdempotencyKey(ownerId: string, key: string, fingerprint: string, taskId: string): void {
    this.db
      .prepare(
        `INSERT INTO discovery_idempotency_keys (owner_id, key, fingerprint, task_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, key) DO NOTHING`
      )
      .run(ownerId, key, fingerprint, taskId, nowIso());
  }

  updateTask(id: string, fields: Record<string, unknown>): number {
    const keys = Object.keys(fields);
    if (keys.length === 0) return 0;
    const sets = keys.map((key) => `${key} = @${key}`).join(', ');
    const info = this.db
      .prepare(`UPDATE discovery_tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...fields, updated_at: nowIso(), id });
    return info.changes;
  }

  /** Writes progress only while the task is writable; late results are dropped. */
  updateTaskIfActive(id: string, fields: Record<string, unknown>): number {
    const keys = Object.keys(fields);
    if (keys.length === 0) return 0;
    const sets = keys.map((key) => `${key} = @${key}`).join(', ');
    const info = this.db
      .prepare(
        `UPDATE discovery_tasks SET ${sets}, updated_at = @updated_at
         WHERE id = @id AND state IN ('queued', 'discovering', 'correcting', 'tracking', 'needs_input')`
      )
      .run({ ...fields, updated_at: nowIso(), id });
    return info.changes;
  }

  setState(id: string, state: DiscoveryTaskState, extra: Record<string, unknown> = {}): void {
    const fields: Record<string, unknown> = { state, ...extra };
    if (state === 'discovering' && !extra.started_at) fields.started_at = nowIso();
    if (state === 'completed' || state === 'partial' || state === 'failed' || state === 'cancelled') {
      fields.finished_at = nowIso();
    }
    if (state !== 'needs_input') fields.needs_input_prompt = extra.needs_input_prompt ?? null;
    this.updateTaskIfActive(id, fields);
  }

  /** Cancel is allowed from any non-terminal state and is idempotent. */
  requestCancel(id: string): boolean {
    const task = this.getTask(id);
    if (!task) return false;
    this.updateTask(id, { cancel_requested: 1 });
    const terminal =
      task.state === 'completed' || task.state === 'partial' || task.state === 'failed' || task.state === 'cancelled';
    if (!terminal) {
      this.updateTask(id, {
        state: 'cancelled',
        stop_reason: 'cancelled',
        finished_at: nowIso()
      });
      this.addEvent(id, 'cancelled', { stopReason: 'cancelled' });
      return true;
    }
    return false;
  }

  addEvent(taskId: string, type: string, payload: unknown): DiscoveryEventRecord {
    const createdAt = nowIso();
    const nextSeq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM discovery_events WHERE task_id = ?')
        .get(taskId) as { n: number }
    ).n;
    this.db
      .prepare(
        'INSERT INTO discovery_events (task_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(taskId, nextSeq, type, JSON.stringify(payload ?? null), createdAt);
    return { seq: nextSeq, type, payload: payload ?? null, createdAt };
  }

  listEvents(taskId: string, afterSeq = 0, limit = 1000): DiscoveryEventRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM discovery_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
      )
      .all(taskId, afterSeq, limit) as {
      seq: number;
      type: string;
      payload_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: row.created_at
    }));
  }

  /**
   * Upsert a probe under an explicit stable key (the resume checkpoint's
   * probeKey, or an import key). Repeat calls with the same key overwrite the
   * answer instead of duplicating it, so resume never double-records a
   * question that already has an answer.
   */
  upsertProbe(taskId: string, probeKey: string, draft: ProbeResultDraft, sortOrder: number): void {
    this.db
      .prepare(
        `INSERT INTO discovery_probes (
          id, task_id, probe_key, platform_id, method, status, handle, profile_url, evidence_json,
          verification, receipt_json, limitations_json, requests, bytes, sort_order, created_at
        ) VALUES (
          @id, @task_id, @probe_key, @platform_id, @method, @status, @handle, @profile_url, @evidence_json,
          @verification, @receipt_json, @limitations_json, @requests, @bytes, @sort_order, @created_at
        )
        ON CONFLICT(task_id, probe_key) DO UPDATE SET
          status = excluded.status,
          handle = excluded.handle,
          profile_url = excluded.profile_url,
          evidence_json = excluded.evidence_json,
          verification = excluded.verification,
          receipt_json = excluded.receipt_json,
          limitations_json = excluded.limitations_json,
          requests = excluded.requests,
          bytes = excluded.bytes`
      )
      .run({
        id: newId('dprobe'),
        task_id: taskId,
        probe_key: probeKey,
        platform_id: draft.platformId,
        method: draft.method,
        status: draft.status,
        handle: draft.handle,
        profile_url: draft.profileUrl,
        evidence_json: JSON.stringify(draft.evidence),
        verification: draft.verification,
        receipt_json: JSON.stringify(draft.receipt),
        limitations_json: JSON.stringify(draft.limitations),
        requests: draft.requests,
        bytes: draft.bytes,
        sort_order: sortOrder,
        created_at: nowIso()
      });
  }

  probeExists(taskId: string, probeKey: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS n FROM discovery_probes WHERE task_id = ? AND probe_key = ?')
      .get(taskId, probeKey) as { n: number } | undefined;
    return Boolean(row);
  }

  listProbes(taskId: string): DiscoveryProbeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM discovery_probes WHERE task_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(taskId) as ProbeRow[];
    return rows.map(mapProbe);
  }

  upsertLink(
    taskId: string,
    platformId: string,
    handle: string | null,
    profileUrl: string | null
  ): AccountLinkRecord {
    const existing = this.db
      .prepare('SELECT * FROM account_links WHERE task_id = ? AND platform_id = ?')
      .get(taskId, platformId) as LinkRow | undefined;
    if (existing) return mapLink(existing);
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO account_links (
          id, task_id, platform_id, handle, profile_url, state, basis_json, counterevidence, note,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'proposed', '[]', NULL, NULL, 1, ?, ?)`
      )
      .run(newId('dlink'), taskId, platformId, handle, profileUrl, timestamp, timestamp);
    const created = this.db
      .prepare('SELECT * FROM account_links WHERE task_id = ? AND platform_id = ?')
      .get(taskId, platformId) as LinkRow;
    return mapLink(created);
  }

  getLink(taskId: string, linkId: string): AccountLinkRecord | null {
    const row = this.db
      .prepare('SELECT * FROM account_links WHERE task_id = ? AND id = ?')
      .get(taskId, linkId) as LinkRow | undefined;
    return row ? mapLink(row) : null;
  }

  listLinks(taskId: string): AccountLinkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM account_links WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as LinkRow[];
    return rows.map(mapLink);
  }

  /**
   * Apply one correction and append its revision record. The caller validates
   * the transition; this method is the single writer so state, revision number
   * and history can never drift apart.
   */
  applyLinkRevision(input: {
    taskId: string;
    linkId: string;
    action: string;
    fromState: LinkState;
    toState: LinkState;
    basis: LinkBasis[];
    note: string | null;
    counterevidence: string | null;
    actor: string;
  }): AccountLinkRecord {
    const tx = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT * FROM account_links WHERE task_id = ? AND id = ?')
        .get(input.taskId, input.linkId) as LinkRow | undefined;
      if (!current) throw new Error('link not found');
      const nextRevision = current.revision + 1;
      const mergedBasis = Array.from(
        new Set([...parseJson<LinkBasis[]>(current.basis_json, []), ...input.basis])
      );
      this.db
        .prepare(
          `UPDATE account_links SET state = ?, basis_json = ?, counterevidence = ?, note = ?,
            revision = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          input.toState,
          JSON.stringify(mergedBasis),
          input.counterevidence ?? current.counterevidence,
          input.note ?? current.note,
          nextRevision,
          nowIso(),
          input.linkId
        );
      this.db
        .prepare(
          `INSERT INTO account_link_revisions (
            task_id, link_id, revision, action, from_state, to_state, basis_json, note,
            counterevidence, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.taskId,
          input.linkId,
          nextRevision,
          input.action,
          input.fromState,
          input.toState,
          JSON.stringify(input.basis),
          input.note,
          input.counterevidence,
          input.actor,
          nowIso()
        );
    });
    tx();
    const updated = this.getLink(input.taskId, input.linkId);
    if (!updated) throw new Error('link vanished');
    return updated;
  }

  listLinkRevisions(taskId: string): LinkRevisionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM account_link_revisions WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as {
      seq: number | null;
      id: number;
      link_id: string;
      revision: number;
      action: string;
      from_state: LinkState;
      to_state: LinkState;
      basis_json: string;
      note: string | null;
      counterevidence: string | null;
      actor: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      seq: row.id,
      linkId: row.link_id,
      revision: row.revision,
      action: row.action,
      fromState: row.from_state,
      toState: row.to_state,
      basis: parseJson<LinkBasis[]>(row.basis_json, []),
      note: row.note,
      counterevidence: row.counterevidence,
      actor: row.actor,
      createdAt: row.created_at
    }));
  }

  upsertPost(taskId: string, draft: TrackedPostDraft, sortOrder: number): void {
    this.db
      .prepare(
        `INSERT INTO tracked_posts (
          id, task_id, account_link_id, post_key, platform_id, url, title, published_at, excerpt,
          excerpt_locator, fetch_status, limits_json, excluded, excluded_at, sort_order, created_at
        ) VALUES (
          @id, @task_id, @account_link_id, @post_key, @platform_id, @url, @title, @published_at, @excerpt,
          @excerpt_locator, @fetch_status, @limits_json, 0, NULL, @sort_order, @created_at
        )
        ON CONFLICT(task_id, post_key) DO UPDATE SET
          url = excluded.url,
          title = excluded.title,
          published_at = excluded.published_at,
          excerpt = excluded.excerpt,
          excerpt_locator = excluded.excerpt_locator,
          fetch_status = excluded.fetch_status,
          limits_json = excluded.limits_json`
      )
      .run({
        id: newId('dpost'),
        task_id: taskId,
        account_link_id: draft.accountLinkId,
        post_key: draft.postKey,
        platform_id: draft.platformId,
        url: draft.url,
        title: draft.title,
        published_at: draft.publishedAt,
        excerpt: draft.excerpt,
        excerpt_locator: draft.excerptLocator,
        fetch_status: draft.fetchStatus,
        limits_json: JSON.stringify(draft.limits),
        sort_order: sortOrder,
        created_at: nowIso()
      });
  }

  listPosts(taskId: string): TrackedPostRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, l.state AS link_state FROM tracked_posts p
         JOIN account_links l ON l.id = p.account_link_id
         WHERE p.task_id = ? ORDER BY p.sort_order ASC, p.created_at ASC`
      )
      .all(taskId) as PostRow[];
    return rows.map(mapPost);
  }

  countPostsForLink(taskId: string, accountLinkId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM tracked_posts WHERE task_id = ? AND account_link_id = ?')
      .get(taskId, accountLinkId) as { n: number };
    return row.n;
  }

  /** Revocation cascade: posts attributed through a dismissed link stop counting. */
  revokePostsForLink(taskId: string, accountLinkId: string): number {
    const info = this.db
      .prepare(
        'UPDATE tracked_posts SET excluded = 1, excluded_at = ? WHERE task_id = ? AND account_link_id = ? AND excluded = 0'
      )
      .run(nowIso(), taskId, accountLinkId);
    return info.changes;
  }

  restorePostsForLink(taskId: string, accountLinkId: string): number {
    const info = this.db
      .prepare(
        'UPDATE tracked_posts SET excluded = 0, excluded_at = NULL WHERE task_id = ? AND account_link_id = ? AND excluded = 1'
      )
      .run(taskId, accountLinkId);
    return info.changes;
  }

  recordImport(input: {
    taskId: string;
    tool: string;
    reportFormat: string;
    toolVersion: string | null;
    generatedAt: string | null;
    resultCount: number;
    warnings: string[];
    contentHash: string;
  }): DiscoveryImportRecord {
    const id = newId('dimport');
    this.db
      .prepare(
        `INSERT INTO discovery_imports (
          id, task_id, tool, report_format, tool_version, generated_at, result_count, warning_json,
          content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.taskId,
        input.tool,
        input.reportFormat,
        input.toolVersion,
        input.generatedAt,
        input.resultCount,
        JSON.stringify(input.warnings),
        input.contentHash,
        nowIso()
      );
    return {
      id,
      taskId: input.taskId,
      tool: input.tool,
      reportFormat: input.reportFormat,
      toolVersion: input.toolVersion,
      generatedAt: input.generatedAt,
      resultCount: input.resultCount,
      warnings: input.warnings,
      contentHash: input.contentHash,
      createdAt: nowIso()
    };
  }

  listImports(taskId: string): DiscoveryImportRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM discovery_imports WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as {
      id: string;
      task_id: string;
      tool: string;
      report_format: string;
      tool_version: string | null;
      generated_at: string | null;
      result_count: number;
      warning_json: string;
      content_hash: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      tool: row.tool,
      reportFormat: row.report_format,
      toolVersion: row.tool_version,
      generatedAt: row.generated_at,
      resultCount: row.result_count,
      warnings: parseJson<string[]>(row.warning_json, []),
      contentHash: row.content_hash,
      createdAt: row.created_at
    }));
  }

  /**
   * Restart recovery: unfinished tasks become `partial` with their checkpoint
   * intact, so an explicit resume continues instead of starting over. This is
   * the continuity improvement over the run model, where interrupted work is
   * terminal.
   */
  recoverInterruptedTasks(): number {
    const rows = this.db
      .prepare("SELECT id FROM discovery_tasks WHERE state IN ('queued', 'discovering', 'correcting', 'tracking')")
      .all() as { id: string }[];
    let count = 0;
    for (const row of rows) {
      const info = this.db
        .prepare(
          `UPDATE discovery_tasks SET state = 'partial', interrupted = 1, stop_reason = 'interrupted',
            error_code = 'interrupted', error_message = '服务重启，任务已暂停；可从检查点继续。',
            finished_at = @finished_at, updated_at = @finished_at
           WHERE id = @id AND state IN ('queued', 'discovering', 'correcting', 'tracking')`
        )
        .run({ id: row.id, finished_at: nowIso() });
      if (info.changes > 0) {
        this.addEvent(row.id, 'interrupted', {
          message: '服务重启，任务已暂停并保留检查点。',
          state: 'partial'
        });
        count += 1;
      }
    }
    return count;
  }
}
