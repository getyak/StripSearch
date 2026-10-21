/**
 * Persisted person-confirmation gates (GET-213): one owner/revision-bound,
 * idempotent and revocable confirmation action for a staged name attempt.
 *
 * Guarantees (docs/design/name-confirmation-2026-10-21.md):
 * - The candidate is validated against the PERSISTED authoritative overview of
 *   the bound discovery revision — never client-supplied URL/text/sources.
 * - The action binds run revision, scope version, discovery revision, input
 *   revision and one immutable candidate id; any mismatch fails closed and
 *   nothing is written. Missing/forged/stale/revoked/wrong-owner input is
 *   refused.
 * - Idempotent replay: the same idempotency key replays the exact receipt and
 *   a double submit of the same confirmation never creates a second record or
 *   a duplicate downstream request. A conflicting person choice is refused.
 * - Confirmation is USER INTENT, never identity evidence; a new discovery
 *   revision (expand/补线索) revokes it and re-stages the overview.
 */

import { createHash } from 'node:crypto';
import { newRecordId, nowIso, parseJson } from '../db/row-helpers.js';
import type { DB } from '../db/index.js';
import type { Store } from '../store.js';
import type { FirstStepStore } from './first-step-store.js';
import type { ResearchToolAction, ResearchToolResult } from './tool-contracts.js';
import {
  gatePersonCandidate,
  validatePersonConfirmationInput,
  type PersonCandidateView,
  type PersonConfirmationInput
} from '../../shared/person-confirmation.js';

/**
 * Immutable source dependency of a confirmed person candidate: an actual
 * checked receipt reference (original hash + exact span for read sources; a
 * real search receipt for indexed clues). Validation is a readback against
 * the EXISTING receipt ledger — originals are never copied into a parallel
 * fact store and a third-party biography never becomes an owned account.
 */
export interface PersonSourceDependency {
  sourceKey: string;
  url: string;
  retrieval: 'read' | 'indexed';
  contentHash: string | null;
  quote: string | null;
}

export function sourceDependenciesOf(candidate: PersonCandidateView): PersonSourceDependency[] {
  return candidate.sources.map((source) => ({
    sourceKey: source.sourceKey,
    url: source.url,
    retrieval: source.retrieval,
    contentHash: source.contentHash,
    quote: source.quote
  }));
}

/**
 * Fail-closed readback of every source dependency against the persisted
 * immutable receipts: a read source must resolve its actual retained text,
 * hash and exact span; an indexed clue must bind a real completed search
 * receipt and can never stand in for an original. A missing, changed or
 * withdrawn source invalidates the confirmation.
 */
export function validatePersonSourceDependencies(
  store: Store,
  runId: string,
  dependencies: readonly PersonSourceDependency[]
): { ok: true } | { ok: false; error: string } {
  const receipts = store.research.receipts(runId).filter((row) => row.kind === 'tool' && row.state === 'completed');
  for (const dependency of dependencies) {
    if (dependency.retrieval === 'read') {
      // A URL can have several immutable originals after a new attempt.
      // Resolve the content version selected by this overview, independently
      // of receipt order; an indexed clue never stands in for an original.
      const page = receipts
        .filter((row) => ['read', 'firecrawl'].includes(String((row.request as ResearchToolAction | null)?.type)))
        .flatMap((row) => ((row.result as ResearchToolResult | undefined)?.pages ?? []))
        .find((candidate) => candidate.url === dependency.url &&
          `sha256:${createHash('sha256').update(candidate.text).digest('hex')}` === dependency.contentHash);
      if (!page) return { ok: false, error: '来源原文版本缺失或内容哈希不一致；确认失效，请重新确认。' };
      if (dependency.quote !== null && !page.text.includes(dependency.quote)) {
        return { ok: false, error: '来源摘录不在保留原文内；确认失效，请重新确认。' };
      }
    } else {
      const bound = receipts.some(
        (row) => (row.request as ResearchToolAction | null)?.type === 'search' &&
          ((row.result as ResearchToolResult | undefined)?.pages ?? []).some((page) => page.url === dependency.url)
      );
      if (!bound) return { ok: false, error: '索引线索未绑定实际检索回执；确认失效，请重新确认。' };
    }
  }
  return { ok: true };
}

export type PersonConfirmationErrorCode =
  | 'run_not_found'
  | 'not_staged'
  | 'run_not_waiting'
  | 'stale_run_revision'
  | 'stale_scope_version'
  | 'stale_discovery_revision'
  | 'unknown_candidate'
  | 'revoked_candidate'
  | 'confirmation_conflict'
  | 'idempotency_conflict'
  | 'invalid_decision';

export class PersonConfirmationError extends Error {
  constructor(readonly code: PersonConfirmationErrorCode, readonly detail: string) {
    super(detail);
    this.name = 'PersonConfirmationError';
  }
}

export interface PersonConfirmationResult {
  confirmationId: string;
  runRevision: number;
  caseId: string;
  discoveryRevision: number;
  inputRevision: number;
  candidateId: string;
  /** Immutable source dependencies validated at confirmation time. */
  sourceDeps: PersonSourceDependency[];
  confirmedAt: string;
  idempotent: boolean;
}

export interface ActivePersonConfirmation {
  confirmationId: string;
  candidateId: string;
  discoveryRevision: number;
  inputRevision: number;
  sourceDeps: PersonSourceDependency[];
  confirmedAt: string;
}

interface PersonConfirmationRow {
  id: string;
  owner_id: string;
  run_id: string;
  case_id: string;
  candidate_id: string;
  discovery_revision: number;
  input_revision: number;
  expected_run_revision: number;
  expected_scope_version: number;
  fingerprint: string;
  result_json: string;
  idempotency_key: string | null;
  confirmed_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

function fingerprintOf(runId: string, input: PersonConfirmationInput): string {
  return createHash('sha256')
    .update(
      `pc|${runId}|${String(input.discoveryRevision)}|${input.candidateId}|${String(input.expectedRunRevision)}|${String(input.expectedScopeVersion)}`
    )
    .digest('hex');
}

/**
 * The one active confirmation of a run for the CURRENT input revision.
 * Shared by the store gate, the runner stage decision and the routes so the
 * authority cannot disagree across double submission, restart or stale input.
 */
export function activePersonConfirmation(
  db: DB,
  runId: string,
  inputRevision: number | null
): ActivePersonConfirmation | null {
  const row = db
    .prepare(
      `SELECT * FROM first_step_person_confirmations
       WHERE run_id = ? AND revoked_at IS NULL
       ORDER BY confirmed_at DESC, id DESC LIMIT 1`
    )
    .get(runId) as PersonConfirmationRow | undefined;
  if (!row) return null;
  if (inputRevision !== null && row.input_revision !== inputRevision) return null;
  const result = parseJson<PersonConfirmationResult>(row.result_json, null as unknown as PersonConfirmationResult);
  return {
    confirmationId: row.id,
    candidateId: row.candidate_id,
    discoveryRevision: row.discovery_revision,
    inputRevision: row.input_revision,
    sourceDeps: result?.sourceDeps ?? [],
    confirmedAt: row.confirmed_at
  };
}

export function revokePersonConfirmations(db: DB, runId: string, reason: string): void {
  db.prepare('UPDATE first_step_person_confirmations SET revoked_at = ?, revoke_reason = ? WHERE run_id = ? AND revoked_at IS NULL')
    .run(nowIso(), reason.slice(0, 200), runId);
}

export class PersonConfirmationStore {
  constructor(
    private readonly db: DB,
    private readonly store: Store,
    private readonly firstStep: FirstStepStore
  ) {}

  active(runId: string): ActivePersonConfirmation | null {
    const link = this.firstStep.link(runId);
    return activePersonConfirmation(this.db, runId, link?.inputRevision ?? null);
  }

  /** A new discovery revision supersedes person intent; old receipts stay. */
  revokeForRun(runId: string, reason: string): void {
    revokePersonConfirmations(this.db, runId, reason);
  }

  applyConfirmation(
    ownerId: string,
    runId: string,
    raw: unknown,
    idempotencyKey: string | null
  ): PersonConfirmationResult {
    const validated = validatePersonConfirmationInput(raw);
    if (!validated.ok) throw new PersonConfirmationError('invalid_decision', validated.error);
    const input = validated.input;
    const fingerprint = fingerprintOf(runId, input);
    return this.db.transaction((): PersonConfirmationResult => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM first_step_person_confirmations WHERE owner_id = ? AND idempotency_key = ?')
          .get(ownerId, idempotencyKey) as PersonConfirmationRow | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.run_id !== runId) {
            throw new PersonConfirmationError('idempotency_conflict', '同一幂等键已用于不同的确认请求。');
          }
          // Replay preserves the immutable receipt but can never resurrect a
          // REVOKED permission or a cancelled/deleted run.
          if (existing.revoked_at !== null) {
            throw new PersonConfirmationError('revoked_candidate', '该人物确认已被撤销；请重新确认。');
          }
          const run = this.store.getRunForOwner(runId, ownerId);
          if (!run || run.cancelRequested) {
            throw new PersonConfirmationError('run_not_waiting', '研究已取消或删除，历史确认不能恢复为授权。');
          }
          return { ...parseJson<PersonConfirmationResult>(existing.result_json, null as unknown as PersonConfirmationResult), idempotent: true };
        }
      }
      const run = this.store.getRunForOwner(runId, ownerId);
      if (!run) throw new PersonConfirmationError('run_not_found', '未找到该研究。');
      if (run.cancelRequested || run.state === 'cancelled') {
        throw new PersonConfirmationError('run_not_waiting', '研究已取消，不能恢复人物确认授权。');
      }
      const link = this.firstStep.link(runId);
      if (!link) throw new PersonConfirmationError('not_staged', '该研究不是第一步发现作业。');
      // Replay the SAME confirmation (double click / restart) without minting a
      // second record or a duplicate downstream request.
      const activeRow = this.db
        .prepare('SELECT * FROM first_step_person_confirmations WHERE run_id = ? AND revoked_at IS NULL ORDER BY confirmed_at DESC, id DESC LIMIT 1')
        .get(runId) as PersonConfirmationRow | undefined;
      if (activeRow) {
        if (activeRow.fingerprint === fingerprint) {
          return { ...parseJson<PersonConfirmationResult>(activeRow.result_json, null as unknown as PersonConfirmationResult), idempotent: true };
        }
        throw new PersonConfirmationError('confirmation_conflict', '已确认其他人物候选；改变人物请新建研究。');
      }
      if (run.state !== 'needs_input') {
        throw new PersonConfirmationError('run_not_waiting', '该研究不在等待人物确认状态。');
      }
      if (run.revision !== input.expectedRunRevision) {
        throw new PersonConfirmationError('stale_run_revision', '研究已更新，请刷新后重新确认。');
      }
      const record = this.firstStep.currentDiscovery(runId);
      if (!record || record.discoveryRevision !== input.discoveryRevision) {
        throw new PersonConfirmationError('stale_discovery_revision', '发现结果已更新，请刷新后重新确认。');
      }
      // The overview revision AND the input revision must both be current:
      // a stale overview after expand/cancel/recovery is refused.
      if (record.view.inputRevision !== link.inputRevision) {
        throw new PersonConfirmationError('stale_discovery_revision', '输入修订已更新；旧概览不能确认，请刷新后重新确认。');
      }
      const view = record.view;
      if (view.personConfirmation?.required !== true || view.personConfirmation.status === 'confirmed') {
        throw new PersonConfirmationError('not_staged', '本次发现不需要人物确认；明确账号链接直接进入账号范围流程。');
      }
      const caseRecord = this.store.cases.getCase(ownerId, link.caseId);
      if (!caseRecord) throw new PersonConfirmationError('run_not_found', '未找到该研究的案例。');
      if (caseRecord.scopeVersion !== input.expectedScopeVersion) {
        throw new PersonConfirmationError('stale_scope_version', '研究范围已更新，请刷新后重新确认。');
      }
      const gate = gatePersonCandidate(view.personOverview ?? null, input.candidateId);
      if (!gate.ok) {
        throw new PersonConfirmationError(gate.code, gate.error);
      }
      // Source-authority readback against the EXISTING immutable receipts:
      // the candidate's read originals must still resolve with their hashes
      // and exact spans and its indexed clues must bind real search receipts.
      const sourceDeps = sourceDependenciesOf(gate.candidate);
      const sources = validatePersonSourceDependencies(this.store, runId, sourceDeps);
      if (!sources.ok) {
        throw new PersonConfirmationError('revoked_candidate', sources.error);
      }
      const timestamp = nowIso();
      const confirmationId = newRecordId('pconf');
      const result: PersonConfirmationResult = {
        confirmationId,
        runRevision: run.revision + 1,
        caseId: link.caseId,
        discoveryRevision: input.discoveryRevision,
        inputRevision: link.inputRevision,
        candidateId: input.candidateId,
        sourceDeps,
        confirmedAt: timestamp,
        idempotent: false
      };
      this.db
        .prepare(
          `INSERT INTO first_step_person_confirmations (
            id, owner_id, run_id, case_id, candidate_id, discovery_revision, input_revision,
            expected_run_revision, expected_scope_version, fingerprint, result_json,
            idempotency_key, confirmed_at, revoked_at, revoke_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
        )
        .run(
          confirmationId,
          ownerId,
          runId,
          link.caseId,
          input.candidateId,
          input.discoveryRevision,
          link.inputRevision,
          input.expectedRunRevision,
          input.expectedScopeVersion,
          fingerprint,
          JSON.stringify(result),
          idempotencyKey,
          timestamp
        );
      this.firstStep.setPhase(runId, 'expanding_accounts');
      this.store.updateRun(runId, {
        revision: result.runRevision,
        state: 'queued',
        error_code: null,
        error_message: null,
        stop_reason: null
      });
      this.store.addEvent(runId, 'person_confirmation', {
        confirmationId,
        candidateId: input.candidateId,
        discoveryRevision: input.discoveryRevision,
        inputRevision: link.inputRevision,
        intentOnly: true
      });
      return result;
    })();
  }
}
