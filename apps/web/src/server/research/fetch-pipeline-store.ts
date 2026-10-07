/**
 * GET-99 local Fetch pipeline persistence: durable runs, append events,
 * resumable checkpoints, dispatch intents, per-request metering receipts,
 * trusted opaque cursors, complete local originals and pending-only findings
 * — plus the injected GET-59 port implementations (SubmissionPort,
 * AccountingPort, CursorPort, ControllerPort) the dispatch gateway binds.
 *
 * Everything here is local scheduling state. Nothing writes a GET-60
 * observation, assessment, claim or report; pending findings never publish.
 * Every commit re-checks owner / case / expectedScopeVersion and evidence
 * dependencies atomically at the actual write. A dispatch intent is persisted
 * BEFORE any provider request, and its raw outcome is persisted before the
 * derived fold; an unresolved intent (in_flight or reported-but-not-folded)
 * stops the run as unreconciled and is never auto-replayed. Local originals
 * store complete captured full text keyed by the adapter-produced canonical
 * content hash — synthetic fixture content only; real provider ingestion
 * remains pending. No cross-worker lease or attempt fencing exists here:
 * GET-79 stays unsupported and unclaimed.
 */

import { randomUUID } from 'node:crypto';

import type { DB } from '../db/index.js';
import type { Store } from '../store.js';
import {
  SubmissionRejectedError,
  type AccountingPort,
  type ControllerCommitContext,
  type ControllerPort,
  type CursorBinding,
  type CursorPort,
  type PendingFindingCommit,
  type RequestOutcome,
  type RequestReservation,
  type ReserveRequest,
  type SubmissionPort,
  type UsageSummary
} from './research-tool-dispatch.js';
import type {
  FetchPipelineCheckpoint,
  FetchPipelineRunState,
  FetchPipelineStopReason
} from '../../shared/research-fetch-pipeline.js';

function nowIso(): string {
  return new Date().toISOString();
}

function newRecordId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Records                                                            */
/* ------------------------------------------------------------------ */

export interface FetchPipelineRunRecord {
  runId: string;
  ownerId: string;
  caseId: string;
  scopeSpecId: string;
  scopeVersion: number;
  state: FetchPipelineRunState;
  stopReason: FetchPipelineStopReason;
  createdAt: string;
  updatedAt: string;
}

export interface FetchPipelineEventRecord {
  seq: number;
  eventId: string;
  runId: string;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export interface FetchPipelineIntentRecord {
  intentId: string;
  runId: string;
  stepKey: string;
  tool: string;
  input: Record<string, unknown>;
  /** in_flight -> reported (raw outcome durable) -> folded | abandoned. */
  state: 'in_flight' | 'reported' | 'folded' | 'abandoned';
  outcome: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface FetchPipelineRequestRecord {
  requestId: string;
  runId: string;
  intentId: string | null;
  actionId: string;
  kind: string;
  tool: string;
  endpoint: string;
  state: 'reserved' | 'completed' | 'failed' | 'unknown';
  estimatedUsd: number | null;
  credits: number | null;
  note: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface FetchPipelineOriginalRecord {
  caseId: string;
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  contentHash: string;
  fulltext: string;
  createdAt: string;
}

export interface FetchPipelineFindingRecord {
  findingId: string;
  runId: string;
  ownerId: string;
  caseId: string;
  kind: 'collected_finding' | 'verification_check';
  statement: string;
  accountIds: string[];
  dependencies: { evidenceId: string; sourceRevision: number }[];
  supportEvidenceIds: string[];
  counterEvidenceIds: string[];
  coverageDelta: PendingFindingCommit['finding']['coverageDelta'];
  note: string | null;
  /** Always `pending` here; this store has no publish path. */
  state: 'pending';
  createdAt: string;
}

interface RunRow {
  id: string;
  owner_id: string;
  case_id: string;
  scope_spec_id: string;
  scope_version: number;
  state: string;
  stop_reason: string;
  created_at: string;
  updated_at: string;
}

interface IntentRow {
  id: string;
  run_id: string;
  step_key: string;
  tool: string;
  input_json: string;
  state: string;
  outcome_json: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export class FetchPipelineStore {
  constructor(
    private readonly db: DB,
    private readonly cases: Store
  ) {}

  private write<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* ---------------------------------------------------------------- */
  /* Runs                                                             */
  /* ---------------------------------------------------------------- */

  createRun(input: {
    ownerId: string;
    caseId: string;
    scopeSpecId: string;
    scopeVersion: number;
    checkpoint: FetchPipelineCheckpoint;
  }): FetchPipelineRunRecord {
    return this.write(() => {
      const runId = newRecordId('fetchrun');
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO research_fetch_pipeline_runs
            (id, owner_id, case_id, scope_spec_id, scope_version, state, stop_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', 'batch_quantum_exhausted', ?, ?)`
        )
        .run(runId, input.ownerId, input.caseId, input.scopeSpecId, input.scopeVersion, timestamp, timestamp);
      this.db
        .prepare(
          'INSERT INTO research_fetch_pipeline_checkpoints (run_id, checkpoint_json, updated_at) VALUES (?, ?, ?)'
        )
        .run(runId, JSON.stringify({ ...input.checkpoint, runId }), timestamp);
      return this.requireRun(runId);
    });
  }

  requireRun(runId: string): FetchPipelineRunRecord {
    const row = this.db.prepare('SELECT * FROM research_fetch_pipeline_runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined;
    if (!row) throw new Error(`fetch pipeline run ${runId} not found`);
    return {
      runId: row.id,
      ownerId: row.owner_id,
      caseId: row.case_id,
      scopeSpecId: row.scope_spec_id,
      scopeVersion: row.scope_version,
      state: row.state as FetchPipelineRunState,
      stopReason: row.stop_reason as FetchPipelineStopReason,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listRuns(ownerId: string, caseId: string): FetchPipelineRunRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id FROM research_fetch_pipeline_runs WHERE owner_id = ? AND case_id = ? ORDER BY created_at, id'
      )
      .all(ownerId, caseId) as { id: string }[];
    return rows.map((row) => this.requireRun(row.id));
  }

  finishRun(runId: string, state: FetchPipelineRunState, stopReason: FetchPipelineStopReason): FetchPipelineRunRecord {
    return this.write(() => {
      this.requireRun(runId);
      this.db
        .prepare('UPDATE research_fetch_pipeline_runs SET state = ?, stop_reason = ?, updated_at = ? WHERE id = ?')
        .run(state, stopReason, nowIso(), runId);
      return this.requireRun(runId);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Append events                                                    */
  /* ---------------------------------------------------------------- */

  /** Append one immutable event (raw outcomes, model usage, run decisions). */
  appendEvent(runId: string, kind: string, payload: unknown): FetchPipelineEventRecord {
    return this.write(() => {
      this.requireRun(runId);
      const eventId = newRecordId('fetchevt');
      const timestamp = nowIso();
      this.db
        .prepare(
          'INSERT INTO research_fetch_pipeline_events (id, run_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(eventId, runId, kind, JSON.stringify(payload), timestamp);
      const row = this.db
        .prepare('SELECT seq, id, run_id, kind, payload_json, created_at FROM research_fetch_pipeline_events WHERE id = ?')
        .get(eventId) as {
        seq: number;
        id: string;
        run_id: string;
        kind: string;
        payload_json: string;
        created_at: string;
      };
      return {
        seq: row.seq,
        eventId: row.id,
        runId: row.run_id,
        kind: row.kind,
        payload: parseJson<unknown>(row.payload_json, null),
        createdAt: row.created_at
      };
    });
  }

  listEvents(runId: string): FetchPipelineEventRecord[] {
    const rows = this.db
      .prepare('SELECT seq, id, run_id, kind, payload_json, created_at FROM research_fetch_pipeline_events WHERE run_id = ? ORDER BY seq ASC')
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
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: row.created_at
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Dispatch intents (durable before any provider request)           */
  /* ---------------------------------------------------------------- */

  beginIntent(input: { runId: string; stepKey: string; tool: string; input: Record<string, unknown> }): FetchPipelineIntentRecord {
    return this.write(() => {
      this.requireRun(input.runId);
      const intentId = newRecordId('fetchintent');
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO research_fetch_pipeline_intents
            (id, run_id, step_key, tool, input_json, state, outcome_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'in_flight', NULL, ?, ?)`
        )
        .run(intentId, input.runId, input.stepKey, input.tool, JSON.stringify(input.input), timestamp, timestamp);
      return this.requireIntent(intentId);
    });
  }

  requireIntent(intentId: string): FetchPipelineIntentRecord {
    const row = this.db.prepare('SELECT * FROM research_fetch_pipeline_intents WHERE id = ?').get(intentId) as
      | IntentRow
      | undefined;
    if (!row) throw new Error(`fetch pipeline intent ${intentId} not found`);
    return {
      intentId: row.id,
      runId: row.run_id,
      stepKey: row.step_key,
      tool: row.tool,
      input: parseJson<Record<string, unknown>>(row.input_json, {}),
      state: row.state as FetchPipelineIntentRecord['state'],
      outcome: parseJson<unknown>(row.outcome_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listIntents(runId: string): FetchPipelineIntentRecord[] {
    const rows = this.db
      .prepare('SELECT id FROM research_fetch_pipeline_intents WHERE run_id = ? ORDER BY created_at, id')
      .all(runId) as { id: string }[];
    return rows.map((row) => this.requireIntent(row.id));
  }

  /** Unresolved = dispatched but not folded/abandoned: never auto-replayed. */
  listUnresolvedIntents(runId: string): FetchPipelineIntentRecord[] {
    return this.listIntents(runId).filter(
      (intent) => intent.state === 'in_flight' || intent.state === 'reported'
    );
  }

  /**
   * The authoritative raw outcome of one executed call, durable BEFORE any
   * derived write and independent of any case rollback.
   */
  recordOutcome(intentId: string, outcome: unknown, state: 'reported' | 'abandoned'): FetchPipelineIntentRecord {
    return this.write(() => {
      this.requireIntent(intentId);
      this.db
        .prepare('UPDATE research_fetch_pipeline_intents SET outcome_json = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(outcome), state, nowIso(), intentId);
      return this.requireIntent(intentId);
    });
  }

  /**
   * Marks the intent folded; joins the caller's transaction so the derived
   * writes and this marker commit or roll back together. A rollback therefore
   * leaves the intent unresolved and the run stops as unreconciled.
   */
  markIntentFolded(intentId: string): void {
    this.db
      .prepare('UPDATE research_fetch_pipeline_intents SET state = ?, updated_at = ? WHERE id = ?')
      .run('folded', nowIso(), intentId);
  }

  /**
   * Explicit authoritative reconciliation of unresolved intents: their raw
   * outcomes stay durable and the affected steps are abandoned (never
   * replayed). This is the only way a stopped/unreconciled run may proceed.
   */
  reconcileIntents(runId: string, checkpoint: FetchPipelineCheckpoint, resolution: 'abandon'): { reconciled: string[] } {
    return this.write(() => {
      const unresolved = this.listUnresolvedIntents(runId);
      const reconciled: string[] = [];
      const refused = new Set(checkpoint.refusedSteps);
      for (const intent of unresolved) {
        this.db
          .prepare('UPDATE research_fetch_pipeline_intents SET state = ?, updated_at = ? WHERE id = ?')
          .run('abandoned', nowIso(), intent.intentId);
        if (!checkpoint.doneSteps.includes(intent.stepKey)) refused.add(intent.stepKey);
        reconciled.push(intent.intentId);
      }
      checkpoint.refusedSteps = [...refused].sort();
      this.db
        .prepare('UPDATE research_fetch_pipeline_checkpoints SET checkpoint_json = ?, updated_at = ? WHERE run_id = ?')
        .run(JSON.stringify(checkpoint), nowIso(), runId);
      return { reconciled };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Checkpoints                                                      */
  /* ---------------------------------------------------------------- */

  loadCheckpoint(runId: string): FetchPipelineCheckpoint | null {
    const row = this.db
      .prepare('SELECT checkpoint_json FROM research_fetch_pipeline_checkpoints WHERE run_id = ?')
      .get(runId) as { checkpoint_json: string } | undefined;
    if (!row) return null;
    return parseJson<FetchPipelineCheckpoint | null>(row.checkpoint_json, null);
  }

  /**
   * Checkpoint-only write that JOINS the caller's transaction (the atomic
   * controller fold): evidence/originals/observations/receipts and this
   * checkpoint commit or roll back together. No event is appended here.
   */
  updateCheckpoint(runId: string, checkpoint: FetchPipelineCheckpoint): void {
    this.requireRun(runId);
    this.db
      .prepare('UPDATE research_fetch_pipeline_checkpoints SET checkpoint_json = ?, updated_at = ? WHERE run_id = ?')
      .run(JSON.stringify(checkpoint), nowIso(), runId);
    this.db.prepare('UPDATE research_fetch_pipeline_runs SET updated_at = ? WHERE id = ?').run(nowIso(), runId);
  }

  /** One transaction: append the event and commit the checkpoint together. */
  commitStep(runId: string, kind: string, payload: unknown, checkpoint: FetchPipelineCheckpoint): void {
    this.write(() => {
      this.requireRun(runId);
      const eventId = newRecordId('fetchevt');
      this.db
        .prepare(
          'INSERT INTO research_fetch_pipeline_events (id, run_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(eventId, runId, kind, JSON.stringify(payload), nowIso());
      this.updateCheckpoint(runId, checkpoint);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Local originals (complete captured text, content-hash bound)     */
  /* ---------------------------------------------------------------- */

  putOriginal(input: {
    caseId: string;
    accountId: string;
    sourceId: string;
    sourceRevision: number;
    contentHash: string;
    fulltext: string;
  }): FetchPipelineOriginalRecord {
    return this.write(() => {
      const existing = this.db
        .prepare(
          'SELECT * FROM research_fetch_pipeline_originals WHERE case_id = ? AND source_id = ? AND source_revision = ?'
        )
        .get(input.caseId, input.sourceId, input.sourceRevision) as
        | {
            case_id: string;
            account_id: string;
            source_id: string;
            source_revision: number;
            content_hash: string;
            fulltext: string;
            created_at: string;
          }
        | undefined;
      if (existing) {
        if (existing.content_hash !== input.contentHash || existing.account_id !== input.accountId) {
          throw new Error('local original already stored under a different content hash or account');
        }
        return {
          caseId: existing.case_id,
          accountId: existing.account_id,
          sourceId: existing.source_id,
          sourceRevision: existing.source_revision,
          contentHash: existing.content_hash,
          fulltext: existing.fulltext,
          createdAt: existing.created_at
        };
      }
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO research_fetch_pipeline_originals
            (case_id, account_id, source_id, source_revision, content_hash, fulltext, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.caseId,
          input.accountId,
          input.sourceId,
          input.sourceRevision,
          input.contentHash,
          input.fulltext,
          timestamp
        );
      return { ...input, createdAt: timestamp };
    });
  }

  getOriginal(caseId: string, sourceId: string, sourceRevision: number): FetchPipelineOriginalRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM research_fetch_pipeline_originals WHERE case_id = ? AND source_id = ? AND source_revision = ?'
      )
      .get(caseId, sourceId, sourceRevision) as
      | {
          case_id: string;
          account_id: string;
          source_id: string;
          source_revision: number;
          content_hash: string;
          fulltext: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      caseId: row.case_id,
      accountId: row.account_id,
      sourceId: row.source_id,
      sourceRevision: row.source_revision,
      contentHash: row.content_hash,
      fulltext: row.fulltext,
      createdAt: row.created_at
    };
  }

  /* ---------------------------------------------------------------- */
  /* Pending findings (pending only; this store never publishes)      */
  /* ---------------------------------------------------------------- */

  listFindings(runId: string): FetchPipelineFindingRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM research_fetch_pipeline_findings WHERE run_id = ? ORDER BY created_at, id')
      .all(runId) as {
      id: string;
      run_id: string;
      owner_id: string;
      case_id: string;
      kind: string;
      statement: string;
      account_ids_json: string;
      dependencies_json: string;
      support_json: string;
      counter_json: string;
      coverage_json: string;
      note: string | null;
      state: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      findingId: row.id,
      runId: row.run_id,
      ownerId: row.owner_id,
      caseId: row.case_id,
      kind: row.kind as FetchPipelineFindingRecord['kind'],
      statement: row.statement,
      accountIds: parseJson<string[]>(row.account_ids_json, []),
      dependencies: parseJson<FetchPipelineFindingRecord['dependencies']>(row.dependencies_json, []),
      supportEvidenceIds: parseJson<string[]>(row.support_json, []),
      counterEvidenceIds: parseJson<string[]>(row.counter_json, []),
      coverageDelta: parseJson<FetchPipelineFindingRecord['coverageDelta']>(row.coverage_json, []),
      note: row.note,
      state: 'pending',
      createdAt: row.created_at
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Injected GET-59 ports                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Pending-only submission port with atomic commit-time re-validation of
   * owner / case / expectedScopeVersion and every evidence dependency.
   */
  createSubmissionPort(runId: string): SubmissionPort {
    return {
      stagePendingFinding: async (commit: PendingFindingCommit): Promise<{ pendingRef: string | null }> => {
        return this.write(() => {
          const run = this.requireRun(runId);
          const record = this.cases.cases.getCase(commit.ownerId, commit.caseId);
          if (!record || commit.ownerId !== run.ownerId || commit.caseId !== run.caseId) {
            throw new SubmissionRejectedError('foreign_commit', 'commit does not belong to this run');
          }
          if (record.scopeVersion !== commit.expectedScopeVersion) {
            throw new SubmissionRejectedError(
              'stale_scope',
              'commit scope version no longer matches the current case scope'
            );
          }
          for (const dependency of commit.dependencies) {
            const rows = this.db
              .prepare('SELECT id, revoked_at, source_revision FROM research_case_evidence WHERE id = ? AND case_id = ?')
              .all(dependency.evidenceId, commit.caseId) as {
              id: string;
              revoked_at: string | null;
              source_revision: number;
            }[];
            const found = rows[0];
            if (!found || found.revoked_at !== null || found.source_revision !== dependency.sourceRevision) {
              throw new SubmissionRejectedError(
                'dependency_invalid',
                `evidence dependency ${dependency.evidenceId} is missing, revoked or pinned to another revision`
              );
            }
          }
          const findingId = newRecordId('fetchfind');
          this.db
            .prepare(
              `INSERT INTO research_fetch_pipeline_findings
                (id, run_id, case_id, owner_id, kind, statement, account_ids_json, dependencies_json,
                 support_json, counter_json, coverage_json, note, state, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
            )
            .run(
              findingId,
              runId,
              commit.caseId,
              commit.ownerId,
              commit.finding.kind,
              commit.finding.statement,
              JSON.stringify(commit.accountIds),
              JSON.stringify(commit.dependencies),
              JSON.stringify(commit.finding.supportEvidenceIds),
              JSON.stringify(commit.finding.counterEvidenceIds),
              JSON.stringify(commit.finding.coverageDelta),
              commit.finding.note,
              nowIso()
            );
          return { pendingRef: findingId };
        });
      }
    };
  }

  /**
   * Durable per-request metering (reserve -> settle) with run-local receipts:
   * fees stay exactly as reported (unknown stays unknown), and a settlement
   * that fails leaves an unreconciled receipt instead of inventing usage.
   */
  createAccountingPort(runId: string): AccountingPort {
    let sequence = 0;
    return {
      reserve: (request: ReserveRequest): RequestReservation => {
        return this.write(() => {
          this.requireRun(runId);
          sequence += 1;
          const actionId = newRecordId('fetchact');
          const endpoint = request.kind === 'provider_request' ? request.descriptor.endpoint : request.kind;
          const tool = request.tool;
          this.db
            .prepare(
              `INSERT INTO research_fetch_pipeline_requests
                (id, run_id, intent_id, action_id, kind, tool, endpoint, state, estimated_usd, credits, note, created_at, settled_at)
               VALUES (?, ?, NULL, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, ?, NULL)`
            )
            .run(
              newRecordId('fetchreq'),
              runId,
              actionId,
              request.kind,
              tool,
              endpoint,
              request.kind === 'provider_request' ? request.descriptor.note : `sequence ${String(sequence)}`,
              nowIso()
            );
          return {
            actionId,
            tool,
            descriptor:
              request.kind === 'provider_request'
                ? request.descriptor
                : { endpoint: request.kind, note: 'local step' }
          };
        });
      },
      settle: (reservation: RequestReservation, outcome: RequestOutcome): void => {
        this.write(() => {
          const row = this.db
            .prepare('SELECT id, state FROM research_fetch_pipeline_requests WHERE run_id = ? AND action_id = ?')
            .get(runId, reservation.actionId) as { id: string; state: string } | undefined;
          if (!row) throw new Error('settlement without a durable reservation');
          if (row.state !== 'reserved') throw new Error('double settlement refused');
          this.db
            .prepare(
              'UPDATE research_fetch_pipeline_requests SET state = ?, estimated_usd = ?, credits = ?, note = ?, settled_at = ? WHERE id = ?'
            )
            .run(
              outcome.state,
              outcome.estimatedUsd,
              outcome.credits,
              outcome.note,
              nowIso(),
              row.id
            );
        });
      },
      usage: (): UsageSummary => {
        const rows = this.db
          .prepare('SELECT kind, state, estimated_usd, credits FROM research_fetch_pipeline_requests WHERE run_id = ?')
          .all(runId) as {
          kind: string;
          state: string;
          estimated_usd: number | null;
          credits: number | null;
        }[];
        const executed = rows.filter(
          (row) => row.kind === 'provider_request' && row.state !== 'reserved'
        );
        const unknownFee = executed.some((row) => row.estimated_usd === null);
        const unknownCredits = executed.some((row) => row.credits === null);
        return {
          providerRequests: executed.length,
          settledRequests: executed.filter((row) => row.state !== 'reserved').length,
          unknownFeeRequests: executed.filter((row) => row.estimated_usd === null).length,
          notDispatchedRequests: 0,
          localSteps: rows.filter((row) => row.kind !== 'provider_request').length,
          estimatedUsd: unknownFee ? null : executed.reduce((sum, row) => sum + (row.estimated_usd ?? 0), 0),
          credits: unknownCredits ? null : executed.reduce((sum, row) => sum + (row.credits ?? 0), 0),
          unaccounted: false
        };
      }
    };
  }

  /** Durable trusted opaque cursors so close/reopen resumes mid-enumeration. */
  createCursorPort(runId: string): CursorPort {
    return {
      issue: (binding: CursorBinding, nativeCursor: string): string => {
        return this.write(() => {
          this.requireRun(runId);
          const token = newRecordId('fetchcur');
          this.db
            .prepare(
              'INSERT INTO research_fetch_pipeline_cursors (token, run_id, binding_json, native_cursor, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(token, runId, JSON.stringify(binding), nativeCursor, nowIso());
          return token;
        });
      },
      resolve: (token: string, binding: CursorBinding): string | null => {
        const row = this.db
          .prepare('SELECT binding_json, native_cursor FROM research_fetch_pipeline_cursors WHERE token = ? AND run_id = ?')
          .get(token, runId) as { binding_json: string; native_cursor: string } | undefined;
        return row && row.binding_json === JSON.stringify(binding) ? row.native_cursor : null;
      }
    };
  }

  /** Progress-only controller port: records receipts, grants nothing. */
  createControllerPort(runId: string): ControllerPort {
    const reject = (code: string): Promise<never> =>
      Promise.reject(new SubmissionRejectedError(code, 'the local fetch pipeline records progress only'));
    return {
      submitCandidates: () => reject('not_applicable'),
      requestConfirmation: () => reject('not_applicable'),
      reportProgress: async (input: {
        commit: ControllerCommitContext;
        note: string | null;
        gaps: string[];
        usage: UsageSummary;
      }): Promise<void> => {
        const record = this.cases.cases.getCase(input.commit.ownerId, input.commit.caseId);
        if (!record || record.scopeVersion !== input.commit.expectedScopeVersion) {
          throw new SubmissionRejectedError('stale_scope', 'progress commit is stale against the current case scope');
        }
        this.appendEvent(runId, 'progress', {
          note: input.note,
          gaps: input.gaps,
          usage: input.usage
        });
      }
    };
  }
}
