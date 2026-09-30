/**
 * GET-60 completion persistence: SQLite backing for the shared
 * research-completion domain contract (shared/research-completion.ts).
 *
 * Everything is append-only and runs in one transaction per call:
 * - `freezeCompletionScope` binds the current authoritative case scopeVersion
 *   exactly once, before any account may exist (no fake account is ever
 *   invented), and copies + hashes the actual account slice in the same
 *   transaction. The frozen spec is a deep copy of the caller's rules;
 *   caller mutation, same-version discovery events and close/reopen never
 *   change it. There is no update or delete path.
 * - `reviseCompletionScope` advances the same authoritative scope version
 *   exactly once through the shared case-level scope mutation path
 *   (`CaseStore.applyCaseScopeMutation`) and appends the new immutable spec.
 *   Any invalid entry rolls the version, journal and spec back together.
 * - `recordCompletionObservation` appends a minimal immutable attempt receipt
 *   bound to case + frozen spec + obligation, validating account/source/
 *   evidence/coverage item+revision references. A free-text note or a caller
 *   "completed" flag can never establish completion.
 * - `assessCompletion` reads one consistent persisted snapshot, runs the
 *   deterministic pure `evaluateCompletion` and appends the assessment with
 *   its selected input, original verdict and policyVersion/scopeVersion/
 *   evidenceRevision/inputHash. The caller cannot supply counters,
 *   percentages or a reduced registry.
 *
 * Old assessments keep their original verdict and input forever; current
 * validity is derived separately at read time from dependency digests, so a
 * new/withdrawn support or counterevidence dependency invalidates a formerly
 * current assessment while historical replay stays possible.
 *
 * Foundation only: no GET-94/95/99 autonomous runtime, scheduling, leases or
 * platform collection. Legacy `research_actions` and `TaskRef.research_task`
 * are never used as investigation receipts. Reads enforce owner/case
 * isolation (owner mismatch reports "not found") and stale-context rejection.
 */

import { randomUUID } from 'node:crypto';

import type { DB } from '../db/index.js';
import type { CaseStore } from './case-store.js';
import {
  CaseNotFoundError,
  ForeignReferenceError,
  StaleScopeError,
  asScopeVersion
} from '../../shared/research-case.js';
import type {
  EvidenceRole,
  IdentitySupportState,
  RecordProvenance,
  ScopeAccountSnapshot,
  ScopeVersion,
  TaskRef
} from '../../shared/research-case.js';
import {
  COMPLETION_POLICY_VERSION,
  CompletionSpecError,
  ObservationProtocolError,
  obligationKey
} from '../../shared/research-completion.js';
import type {
  CompletionAssessment,
  CompletionAssessmentInput,
  CompletionAssessmentView,
  CompletionEvaluation,
  CompletionObservation,
  CompletionObservationDraft,
  CompletionScopeSpec,
  CompletionSnapshot,
  FrozenCompletionScope,
  FrozenCompletionScopeView,
  ObservationRefs,
  ObligationRef,
  PinnedCoverageRecord,
  StopReason
} from '../../shared/research-completion.js';
import { buildAssessmentInput, evaluateCompletion, sha256Hex, stableStringify, staleReasonsAgainst } from './completion-eval.js';

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

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const APPLICABILITY = new Set(['applicable', 'not_applicable']);
const ATTEMPT_STATES = new Set(['succeeded', 'failed', 'cancelled', 'needs_input']);
const STOP_REASONS = new Set<StopReason>([
  'endpoint_exhausted',
  'cursor_open',
  'known_gap',
  'budget_exhausted',
  'permission_denied',
  'unsupported',
  'deferred',
  'needs_input',
  'unavailable_content',
  'operator_stop'
]);

/* ------------------------------------------------------------------ */
/* Inputs                                                             */
/* ------------------------------------------------------------------ */

export interface FreezeCompletionScopeInput {
  ownerId: string;
  caseId: string;
  expectedScopeVersion: ScopeVersion;
  spec: CompletionScopeSpec;
  reason?: string;
}

export interface ReviseCompletionScopeInput extends FreezeCompletionScopeInput {
  /** Why the scope changed; kept with the immutable new spec. */
  reason: string;
}

export interface RecordObservationInput {
  ownerId: string;
  caseId: string;
  expectedScopeVersion: ScopeVersion;
  scopeSpecId: string;
  receipt: CompletionObservationDraft;
}

export interface AssessCompletionInput {
  ownerId: string;
  caseId: string;
  scopeSpecId: string;
  expectedScopeVersion: ScopeVersion;
}

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

interface CaseRow {
  id: string;
  owner_id: string;
  scope_version: number;
}

interface CompletionScopeRow {
  id: string;
  case_id: string;
  scope_version: number;
  registry_version: string;
  registry_hash: string;
  spec_hash: string;
  spec_json: string;
  account_slice_json: string;
  account_slice_hash: string;
  scope_event_id: number;
  reason: string;
  created_at: string;
}

interface ObservationRow {
  seq: number;
  id: string;
  case_id: string;
  scope_spec_id: string;
  scope_version: number;
  obligation_key: string;
  obligation_json: string;
  action: string;
  result: string;
  attempt_state: string;
  stop_reason: string | null;
  access_boundary: string | null;
  remaining_unknown: string | null;
  note: string | null;
  payload_json: string;
  refs_json: string;
  synthetic: number;
  provenance_json: string;
  created_at: string;
}

interface AssessmentRow {
  id: string;
  case_id: string;
  scope_spec_id: string;
  scope_version: number;
  policy_version: string;
  evidence_revision: string;
  input_hash: string;
  input_json: string;
  verdict: string;
  evaluation_json: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Protocol validation                                                */
/* ------------------------------------------------------------------ */

const ACTION_BY_REF_KIND: Record<string, Set<string>> = {
  platform_discovery: new Set(['discover_platform']),
  account_history: new Set(['enumerate_history']),
  item_body: new Set(['read_body']),
  item_media: new Set(['read_media']),
  item_comments: new Set(['read_comments']),
  thread_branch: new Set(['read_thread', 'select_branch']),
  question: new Set(['answer_question']),
  required_check: new Set(['report_required_check']),
  note: new Set(['note'])
};

const RESULTS_BY_ACTION: Record<string, Set<string>> = {
  discover_platform: new Set(['checked_no_match', 'candidates', 'needs_input', 'inaccessible', 'unsupported', 'deferred']),
  enumerate_history: new Set(['items_found', 'no_match']),
  read_body: new Set(['content_read', 'unavailable']),
  read_comments: new Set(['comments_read', 'unavailable']),
  read_media: new Set(['media_read', 'unavailable']),
  read_thread: new Set(['thread_read', 'unavailable']),
  select_branch: new Set(['branch_selected']),
  answer_question: new Set(['supported', 'conflicting', 'investigated_unknown']),
  report_required_check: new Set(['observed']),
  note: new Set(['note_only'])
};

function validateReceipt(draft: CompletionObservationDraft): void {
  const ref: ObligationRef = draft.obligationRef;
  const allowedActions = ACTION_BY_REF_KIND[ref.kind];
  if (!allowedActions || !allowedActions.has(draft.action)) {
    throw new ObservationProtocolError(`action ${draft.action} does not match obligation ${ref.kind}`);
  }
  const allowedResults = RESULTS_BY_ACTION[draft.action];
  if (!allowedResults || !allowedResults.has(draft.result)) {
    throw new ObservationProtocolError(`result ${draft.result} is not valid for action ${draft.action}`);
  }
  if (!ATTEMPT_STATES.has(draft.attemptState)) {
    throw new ObservationProtocolError(`unknown attempt state ${String(draft.attemptState)}`);
  }
  if (draft.stopReason !== null && !STOP_REASONS.has(draft.stopReason)) {
    throw new ObservationProtocolError(`unknown stop reason ${String(draft.stopReason)}`);
  }
  if (typeof draft.synthetic !== 'boolean') {
    throw new ObservationProtocolError('receipt must state synthetic provenance explicitly (synthetic: true|false)');
  }
  if (!draft.provenance || typeof draft.provenance.collector !== 'string') {
    throw new ObservationProtocolError('receipt provenance is required');
  }
  if (draft.action === 'enumerate_history') {
    const payload = draft as Extract<CompletionObservationDraft, { action: 'enumerate_history' }>;
    if (!Array.isArray(payload.items)) {
      throw new ObservationProtocolError('enumerate_history needs an items array');
    }
    if (payload.stopReason === 'endpoint_exhausted' && (payload.nextCursor !== null || payload.knownGaps.length > 0)) {
      throw new ObservationProtocolError(
        'endpoint exhaustion requires an empty cursor and no known gaps; it only proves the endpoint-accessible range'
      );
    }
    for (const item of payload.items) {
      if (!item || typeof item.sourceId !== 'string' || !Number.isInteger(item.sourceRevision)) {
        throw new ObservationProtocolError('enumerated items need sourceId and integer sourceRevision');
      }
      if (!['none', 'present', 'unknown'].includes(item.hasMedia)) {
        throw new ObservationProtocolError(`unknown hasMedia state ${String(item.hasMedia)}`);
      }
    }
  }
  if (draft.action === 'read_thread') {
    const payload = draft as Extract<CompletionObservationDraft, { action: 'read_thread' }>;
    if (!Number.isInteger(payload.depthReached) || payload.depthReached < 0) {
      throw new ObservationProtocolError('read_thread needs a non-negative integer depthReached');
    }
    for (const blocker of payload.blockers) {
      if (!['missing', 'deleted', 'hidden'].includes(blocker.state)) {
        throw new ObservationProtocolError(`unknown blocker state ${String(blocker.state)}`);
      }
    }
  }
  if (draft.action === 'select_branch') {
    const payload = draft as Extract<CompletionObservationDraft, { action: 'select_branch' }>;
    if (draft.obligationRef.kind !== 'thread_branch' || draft.obligationRef.branchKey.trim() === '') {
      throw new ObservationProtocolError('select_branch needs a non-empty branchKey');
    }
    for (const link of payload.parentChain) {
      if (!['present', 'missing', 'deleted', 'hidden'].includes(link.state)) {
        throw new ObservationProtocolError(`unknown parent state ${String(link.state)}`);
      }
    }
  }
  if (draft.action === 'answer_question') {
    const payload = draft as Extract<CompletionObservationDraft, { action: 'answer_question' }>;
    if (typeof payload.explanation !== 'string') {
      throw new ObservationProtocolError('answer_question needs an explanation');
    }
    if (payload.result === 'investigated_unknown' && payload.remainingUnknown === null) {
      throw new ObservationProtocolError('investigated_unknown must record what remains unknown');
    }
  }
  if (draft.action === 'report_required_check') {
    const payload = draft as Extract<CompletionObservationDraft, { action: 'report_required_check' }>;
    if (!Array.isArray(payload.observed)) {
      throw new ObservationProtocolError('report_required_check needs an observed list');
    }
  }
}

function validateScopeSpec(spec: CompletionScopeSpec): void {
  const fail = (detail: string): never => {
    throw new CompletionSpecError(detail);
  };
  const registry = spec.platformRegistry;
  if (!registry || typeof registry.registryVersion !== 'string' || registry.registryVersion.trim() === '') {
    fail('platform registry version is required');
  }
  const entries = registry.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('an empty platform registry cannot freeze obligations or pass vacuously');
  }
  const platformIds = new Set<string>();
  let applicablePlatforms = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.platformId !== 'string' || entry.platformId.trim() === '') {
      fail('every registry entry needs a platformId');
    }
    if (platformIds.has(entry.platformId)) fail(`duplicate registry platform ${entry.platformId}`);
    platformIds.add(entry.platformId);
    if (typeof entry.label !== 'string' || entry.label.trim() === '') fail(`platform ${entry.platformId} needs a label`);
    if (!APPLICABILITY.has(entry.applicability)) fail(`platform ${entry.platformId} has an invalid applicability`);
    if (typeof entry.applicabilityReason !== 'string' || entry.applicabilityReason.trim() === '') {
      fail(`platform ${entry.platformId} needs a frozen applicability reason`);
    }
    if (entry.applicability === 'applicable') applicablePlatforms += 1;
  }
  if (applicablePlatforms === 0) fail('the frozen registry needs at least one applicable platform');
  if (!Array.isArray(spec.questions) || spec.questions.length === 0) {
    fail('empty global question obligations cannot freeze or pass vacuously');
  }
  const questionIds = new Set<string>();
  let applicableQuestions = 0;
  for (const question of spec.questions) {
    if (!question || typeof question.questionId !== 'string' || question.questionId.trim() === '') {
      fail('every question needs a questionId');
    }
    if (questionIds.has(question.questionId)) fail(`duplicate question ${question.questionId}`);
    questionIds.add(question.questionId);
    if (typeof question.text !== 'string' || question.text.trim() === '') fail(`question ${question.questionId} needs text`);
    if (!APPLICABILITY.has(question.applicability)) fail(`question ${question.questionId} has an invalid applicability`);
    if (typeof question.applicabilityReason !== 'string' || question.applicabilityReason.trim() === '') {
      fail(`question ${question.questionId} needs a frozen applicability reason`);
    }
    if (question.applicability === 'applicable') applicableQuestions += 1;
  }
  if (applicableQuestions === 0) fail('the frozen scope needs at least one applicable question');
  const range = spec.accountRange;
  if (!range || (range.mode !== 'researched_accounts' && range.mode !== 'explicit')) {
    fail('accountRange.mode must be researched_accounts or explicit');
  }
  if (range.mode === 'researched_accounts' && range.accountIds.length > 0) {
    fail('researched_accounts range must not list accountIds');
  }
  if (range.mode === 'explicit') {
    if (range.accountIds.length === 0) fail('explicit account range must not be empty');
    if (new Set(range.accountIds).size !== range.accountIds.length) fail('explicit account range has duplicates');
  }
  if (!spec.timeRange || typeof spec.timeRange !== 'object' || Array.isArray(spec.timeRange)) {
    fail('timeRange must explicitly provide from and to (ISO dates or null)');
  }
  const { from, to } = spec.timeRange;
  for (const [name, bound] of [['from', from], ['to', to]] as const) {
    if (bound !== null && (typeof bound !== 'string' || !ISO_DATE.test(bound))) {
      fail(`timeRange.${name} must be an ISO date or null`);
    }
  }
  if (from !== null && to !== null && from.slice(0, 10) > to.slice(0, 10)) fail('timeRange.from must not be after timeRange.to');
  if (!Number.isInteger(spec.threadDepth) || spec.threadDepth < 1) {
    fail('threadDepth must be a positive integer (design default 4)');
  }
  if (!Array.isArray(spec.requiredChecks) || spec.requiredChecks.length === 0) {
    fail('at least one deterministic required check must be configured and frozen');
  }
  const checkIds = new Set<string>();
  for (const check of spec.requiredChecks) {
    if (!check || typeof check.checkId !== 'string' || check.checkId.trim() === '') fail('every check needs a checkId');
    if (checkIds.has(check.checkId)) fail(`duplicate required check ${check.checkId}`);
    checkIds.add(check.checkId);
    if (check.kind !== 'time_coverage' && check.kind !== 'source_diversity') {
      fail(`check ${check.checkId} has an invalid kind`);
    }
    if (!Array.isArray(check.required) || check.required.length === 0) {
      fail(`check ${check.checkId} must configure explicit required entries, not an uncalibrated threshold`);
    }
    if (new Set(check.required).size !== check.required.length) fail(`check ${check.checkId} has duplicate required entries`);
    for (const entry of check.required) {
      if (typeof entry !== 'string' || entry.trim() === '') fail(`check ${check.checkId} has an empty required entry`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export class CompletionStore {
  constructor(
    private readonly db: DB,
    private readonly cases: CaseStore
  ) {}

  /** Single transaction boundary for every mutating operation. */
  private write<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private loadCase(ownerId: string, caseId: string, expectedScopeVersion?: ScopeVersion): CaseRow {
    const row = this.db
      .prepare('SELECT id, owner_id, scope_version FROM research_cases WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(caseId, ownerId) as CaseRow | undefined;
    if (!row) throw new CaseNotFoundError(caseId);
    if (expectedScopeVersion !== undefined && row.scope_version !== expectedScopeVersion) {
      throw new StaleScopeError(caseId, expectedScopeVersion, asScopeVersion(row.scope_version));
    }
    return row;
  }

  private scopeRow(caseId: string, scopeSpecId: string): CompletionScopeRow {
    const row = this.db
      .prepare('SELECT * FROM research_case_completion_scopes WHERE id = ? AND case_id = ?')
      .get(scopeSpecId, caseId) as CompletionScopeRow | undefined;
    if (!row) {
      throw new ForeignReferenceError(`completion scope ${scopeSpecId} is not part of case ${caseId}`);
    }
    return row;
  }

  private mapScope(row: CompletionScopeRow): FrozenCompletionScope {
    return {
      scopeSpecId: row.id,
      caseId: row.case_id,
      scopeVersion: asScopeVersion(row.scope_version),
      registryVersion: row.registry_version,
      registryHash: row.registry_hash,
      specHash: row.spec_hash,
      spec: deepCopy(parseJson<CompletionScopeSpec>(row.spec_json, {} as CompletionScopeSpec)),
      accountSlice: deepCopy(parseJson<ScopeAccountSnapshot[]>(row.account_slice_json, [])),
      accountSliceHash: row.account_slice_hash,
      scopeEventId: row.scope_event_id,
      reason: row.reason,
      createdAt: row.created_at
    };
  }

  private mapObservation(row: ObservationRow): CompletionObservation {
    const base = {
      observationId: row.id,
      caseId: row.case_id,
      scopeSpecId: row.scope_spec_id,
      scopeVersion: asScopeVersion(row.scope_version),
      obligationRef: parseJson<ObligationRef>(row.obligation_json, { kind: 'note' }),
      attemptState: row.attempt_state as CompletionObservation['attemptState'],
      stopReason: (row.stop_reason as StopReason | null) ?? null,
      accessBoundary: row.access_boundary,
      remainingUnknown: row.remaining_unknown,
      note: row.note,
      synthetic: row.synthetic !== 0,
      provenance: parseJson<RecordProvenance>(row.provenance_json, {
        authorization: 'not_recorded',
        collector: 'unknown',
        note: null
      }),
      refs: parseJson<ObservationRefs>(row.refs_json, {
        accountIds: [],
        sourceRevisions: [],
        evidenceIds: [],
        counterevidenceIds: [],
        coverageItems: [],
        observationIds: []
      }),
      createdAt: row.created_at
    };
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
    return { ...base, action: row.action, result: row.result, ...payload } as unknown as CompletionObservation;
  }

  /* ---------------------------------------------------------------- */
  /* Frozen scope specifications                                      */
  /* ---------------------------------------------------------------- */

  /**
   * First freeze: binds the current authoritative case scopeVersion once,
   * before any account has to exist. The rules are deep-copied and the actual
   * account slice is copied and hashed in the same transaction; the scope
   * journal event written here is the immutable anchor.
   */
  freezeCompletionScope(input: FreezeCompletionScopeInput): FrozenCompletionScope {
    return this.write(() => {
      this.loadCase(input.ownerId, input.caseId, input.expectedScopeVersion);
      const existing = this.db
        .prepare('SELECT id FROM research_case_completion_scopes WHERE case_id = ?')
        .get(input.caseId);
      if (existing) {
        throw new CompletionSpecError(
          'completion scope is already frozen for this case; edits must advance the scope version via reviseCompletionScope'
        );
      }
      const spec = deepCopy(input.spec);
      validateScopeSpec(spec);
      return this.persistFrozenScope(input.ownerId, input.caseId, input.expectedScopeVersion, spec, input.reason ?? 'completion_scope_frozen', false);
    });
  }

  /**
   * Scope edits (questions / time window / depth / account range): advance the
   * same authoritative scope version exactly once through the shared
   * case-level scope mutation path and append the new immutable spec. Old
   * specs and assessments stay readable. Any invalid entry rolls the version,
   * journal and spec back together.
   */
  reviseCompletionScope(input: ReviseCompletionScopeInput): FrozenCompletionScope {
    return this.write(() => {
      this.loadCase(input.ownerId, input.caseId, input.expectedScopeVersion);
      const existing = this.db
        .prepare('SELECT id FROM research_case_completion_scopes WHERE case_id = ?')
        .get(input.caseId);
      if (!existing) {
        throw new CompletionSpecError('no frozen completion scope to revise; freezeCompletionScope must run first');
      }
      const spec = deepCopy(input.spec);
      // Structural validation runs before anything is written; reference
      // validation runs after the advance so a foreign account reference
      // rolls the version and journal back together with the spec.
      validateScopeSpec(spec);
      // Hard problems cannot be deleted after the fact to claim completion:
      // every previously frozen question must stay, at worst marked
      // not_applicable with a frozen reason, and shrinking is a new version.
      // The previous frozen spec is selected by the AUTHORITATIVE
      // scope_version (never wall time or random ids), so same-millisecond or
      // backwards-clock revisions cannot bypass this guard.
      const previousRow = this.db
        .prepare('SELECT * FROM research_case_completion_scopes WHERE case_id = ? ORDER BY scope_version DESC LIMIT 1')
        .get(input.caseId) as CompletionScopeRow;
      const kept = new Set(spec.questions.map((question) => question.questionId));
      for (const question of parseJson<CompletionScopeSpec>(previousRow.spec_json, {} as CompletionScopeSpec).questions ?? []) {
        if (!kept.has(question.questionId)) {
          throw new CompletionSpecError(
            `question ${question.questionId} cannot be deleted by a scope revision; freeze it as not_applicable with a reason instead`
          );
        }
      }
      return this.persistFrozenScope(input.ownerId, input.caseId, input.expectedScopeVersion, spec, input.reason, true);
    });
  }

  private persistFrozenScope(
    ownerId: string,
    caseId: string,
    expectedScopeVersion: ScopeVersion,
    spec: CompletionScopeSpec,
    reason: string,
    advance: boolean
  ): FrozenCompletionScope {
    const mutation = this.cases.applyCaseScopeMutation({
      ownerId,
      caseId,
      expectedScopeVersion,
      reason: advance ? `completion_scope_revised: ${reason}` : `completion_scope_frozen: ${reason}`,
      advance
    });
    // Reference validation after the scope event: a foreign account id rolls
    // the version, journal and spec insert back in this same transaction.
    if (spec.accountRange.mode === 'explicit') {
      const slice = this.cases.accountScopeSlice(ownerId, caseId);
      const known = new Set(slice.map((entry) => entry.accountId));
      for (const accountId of spec.accountRange.accountIds) {
        if (!known.has(accountId)) {
          throw new ForeignReferenceError(`account ${accountId} is not part of case ${caseId}`);
        }
      }
    }
    const accountSlice = this.cases.accountScopeSlice(ownerId, caseId);
    const scopeSpecId = newRecordId('cspec');
    const registryHash = sha256Hex(stableStringify(spec.platformRegistry));
    const specHash = sha256Hex(stableStringify(spec));
    const accountSliceHash = sha256Hex(stableStringify(accountSlice));
    this.db
      .prepare(
        `INSERT INTO research_case_completion_scopes (
          id, case_id, scope_version, registry_version, registry_hash, spec_hash,
          spec_json, account_slice_json, account_slice_hash, scope_event_id, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scopeSpecId,
        caseId,
        mutation.case.scopeVersion,
        spec.platformRegistry.registryVersion,
        registryHash,
        specHash,
        stableStringify(spec),
        stableStringify(accountSlice),
        accountSliceHash,
        mutation.eventId,
        reason,
        nowIso()
      );
    return this.mapScope(this.scopeRow(caseId, scopeSpecId));
  }

  /* ---------------------------------------------------------------- */
  /* Observation receipts                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Append one immutable receipt bound to case + frozen spec + obligation.
   * Account/source/evidence/coverage item+revision references are validated
   * against real persisted records; an invalid reference rejects the whole
   * write.
   */
  recordCompletionObservation(input: RecordObservationInput): CompletionObservation {
    return this.write(() => {
      this.loadCase(input.ownerId, input.caseId, input.expectedScopeVersion);
      const specRow = this.scopeRow(input.caseId, input.scopeSpecId);
      if (specRow.scope_version !== input.expectedScopeVersion) {
        throw new StaleScopeError(input.caseId, input.expectedScopeVersion, asScopeVersion(specRow.scope_version));
      }
      const draft = deepCopy(input.receipt) as CompletionObservationDraft;
      validateReceipt(draft);
      this.validateReceiptRefs(input.caseId, input.scopeSpecId, specRow, draft);
      const observationId = newRecordId('obs');
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(draft)) {
        if (
          ![
            'obligationRef',
            'attemptState',
            'stopReason',
            'accessBoundary',
            'remainingUnknown',
            'note',
            'synthetic',
            'provenance',
            'refs',
            'action',
            'result'
          ].includes(key)
        ) {
          payload[key] = value;
        }
      }
      this.db
        .prepare(
          `INSERT INTO research_case_completion_observations (
            id, case_id, scope_spec_id, scope_version, obligation_key, obligation_json,
            action, result, attempt_state, stop_reason, access_boundary, remaining_unknown,
            note, payload_json, refs_json, synthetic, provenance_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          observationId,
          input.caseId,
          input.scopeSpecId,
          input.expectedScopeVersion,
          obligationKey(draft.obligationRef),
          JSON.stringify(draft.obligationRef),
          draft.action,
          draft.result,
          draft.attemptState,
          draft.stopReason,
          draft.accessBoundary,
          draft.remainingUnknown,
          draft.note,
          JSON.stringify(payload),
          JSON.stringify(draft.refs),
          draft.synthetic ? 1 : 0,
          JSON.stringify(draft.provenance),
          nowIso()
        );
      return this.mapObservation(
        this.db.prepare('SELECT * FROM research_case_completion_observations WHERE id = ?').get(observationId) as ObservationRow
      );
    });
  }

  private validateReceiptRefs(
    caseId: string,
    scopeSpecId: string,
    specRow: CompletionScopeRow,
    draft: CompletionObservationDraft
  ): void {
    const spec = parseJson<CompletionScopeSpec>(specRow.spec_json, {} as CompletionScopeSpec);
    const sliceIds = new Set(parseJson<ScopeAccountSnapshot[]>(specRow.account_slice_json, []).map((entry) => entry.accountId));
    const ref = draft.obligationRef;
    const accountScoped = 'accountId' in ref ? ref.accountId : null;

    if (ref.kind === 'platform_discovery') {
      if (!spec.platformRegistry.entries.some((entry) => entry.platformId === ref.platformId)) {
        throw new ForeignReferenceError(`platform ${ref.platformId} is not in the frozen registry`);
      }
    } else if (ref.kind === 'account_history') {
      if (!sliceIds.has(ref.accountId)) {
        throw new ForeignReferenceError(`account ${ref.accountId} is not in the frozen account slice of ${specRow.id}`);
      }
    } else if (ref.kind === 'item_body' || ref.kind === 'item_media' || ref.kind === 'item_comments' || ref.kind === 'thread_branch') {
      if (!sliceIds.has(ref.accountId)) {
        throw new ForeignReferenceError(`account ${ref.accountId} is not in the frozen account slice of ${specRow.id}`);
      }
      this.requireSourceRevision(caseId, ref.accountId, ref.sourceId, ref.sourceRevision);
    } else if (ref.kind === 'question') {
      if (!spec.questions.some((question) => question.questionId === ref.questionId)) {
        throw new ForeignReferenceError(`question ${ref.questionId} is not in the frozen scope`);
      }
    } else if (ref.kind === 'required_check') {
      if (!spec.requiredChecks.some((check) => check.checkId === ref.checkId)) {
        throw new ForeignReferenceError(`required check ${ref.checkId} is not in the frozen scope`);
      }
    }

    // Enumerated items are persisted source revisions of the obligation
    // account: every item is validated here in the recording transaction, so
    // callers cannot smuggle nonexistent/foreign/wrong-revision items past
    // the persistence contract by leaving refs.sourceRevisions empty.
    if (draft.action === 'enumerate_history') {
      const payload = draft as Extract<CompletionObservationDraft, { action: 'enumerate_history' }>;
      const accountId = draft.obligationRef.kind === 'account_history' ? draft.obligationRef.accountId : null;
      for (const item of payload.items) {
        this.requireSourceRevision(caseId, accountId, item.sourceId, item.sourceRevision);
      }
    }

    this.assertRefsConform(caseId, draft.refs, accountScoped);
    for (const observationId of draft.refs.observationIds) {
      this.validateObservationChain(caseId, scopeSpecId, observationId, accountScoped, new Set());
    }
  }

  /**
   * Account-boundary inheritance (frozen contract): `effectiveAccount` is the
   * inherited account of the reference chain. Every account/source/evidence/
   * coverage reference must conform to it; a case-level root (null) may
   * legitimately span accounts.
   */
  private assertRefsConform(caseId: string, refs: ObservationRefs, effectiveAccount: string | null): void {
    for (const accountId of refs.accountIds) {
      if (effectiveAccount !== null && accountId !== effectiveAccount) {
        throw new ForeignReferenceError(
          `account reference ${accountId} does not match inherited account ${effectiveAccount}`
        );
      }
      const row = this.db
        .prepare('SELECT id FROM research_case_accounts WHERE id = ? AND case_id = ?')
        .get(accountId, caseId);
      if (!row) throw new ForeignReferenceError(`account ${accountId} is not part of case ${caseId}`);
    }
    for (const source of refs.sourceRevisions) {
      this.requireSourceRevision(caseId, effectiveAccount, source.sourceId, source.sourceRevision);
    }
    for (const [ids, supportPolarity] of [
      [refs.evidenceIds, true],
      [refs.counterevidenceIds, false]
    ] as const) {
      for (const evidenceId of ids) {
        const row = this.db
          .prepare('SELECT id, account_id, role FROM research_case_evidence WHERE id = ? AND case_id = ?')
          .get(evidenceId, caseId) as { id: string; account_id: string; role: EvidenceRole } | undefined;
        if (!row) throw new ForeignReferenceError(`evidence ${evidenceId} is not part of case ${caseId}`);
        if (effectiveAccount !== null && row.account_id !== effectiveAccount) {
          throw new ForeignReferenceError(
            `evidence ${evidenceId} does not belong to inherited account ${effectiveAccount}`
          );
        }
        const supportRole = row.role === 'factual_support' || row.role === 'identity_support';
        if (supportRole !== supportPolarity) {
          throw new ForeignReferenceError(
            `evidence ${evidenceId} has role ${row.role}; receipts must cite support and counterevidence by polarity`
          );
        }
      }
    }
    for (const pin of refs.coverageItems) {
      const item = this.db
        .prepare('SELECT * FROM research_case_item_coverage WHERE id = ? AND case_id = ?')
        .get(pin.itemId, caseId) as
        | { id: string; account_id: string; source_id: string; source_revision: number }
        | undefined;
      if (!item) throw new ForeignReferenceError(`coverage item ${pin.itemId} is not part of case ${caseId}`);
      const revision = this.db
        .prepare('SELECT revision FROM research_case_item_coverage_revisions WHERE item_id = ? AND revision = ?')
        .get(pin.itemId, pin.revision);
      if (!revision) {
        throw new ForeignReferenceError(`coverage revision ${pin.itemId}@${String(pin.revision)} does not exist`);
      }
      const bound =
        pin.locator.accountId === item.account_id &&
        pin.locator.sourceId === item.source_id &&
        pin.locator.sourceRevision === item.source_revision;
      if (!bound) {
        throw new ForeignReferenceError(
          `coverage pin ${pin.itemId}@${String(pin.revision)} locator does not match the bound (${item.account_id}, ${item.source_id}@${String(item.source_revision)})`
        );
      }
      if (effectiveAccount !== null && item.account_id !== effectiveAccount) {
        throw new ForeignReferenceError(
          `coverage item ${pin.itemId} does not belong to inherited account ${effectiveAccount}`
        );
      }
    }
  }

  /**
   * Transitive account-boundary validation of a referenced observation
   * chain: nested account-scoped nodes must match the inherited account and
   * intermediate case-level nodes must not erase it. Recursion/memo keys
   * include the expected account so permissive case-level validation can
   * never satisfy a restricted one.
   */
  private validateObservationChain(
    caseId: string,
    scopeSpecId: string,
    observationId: string,
    expectedAccount: string | null,
    seen: Set<string>
  ): void {
    const key = `${observationId}~${expectedAccount ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const row = this.db
      .prepare('SELECT * FROM research_case_completion_observations WHERE id = ? AND case_id = ? AND scope_spec_id = ?')
      .get(observationId, caseId, scopeSpecId) as ObservationRow | undefined;
    if (!row) {
      throw new ForeignReferenceError(`observation ${observationId} is not part of case ${caseId} scope ${scopeSpecId}`);
    }
    const observation = this.mapObservation(row);
    const nodeAccount = 'accountId' in observation.obligationRef ? observation.obligationRef.accountId : null;
    if (expectedAccount !== null && nodeAccount !== null && expectedAccount !== nodeAccount) {
      throw new ForeignReferenceError(
        `observation ${observationId} belongs to account ${nodeAccount}, not the inherited account ${expectedAccount}`
      );
    }
    const effective = expectedAccount ?? nodeAccount;
    this.assertRefsConform(caseId, observation.refs, effective);
    for (const dep of observation.refs.observationIds) {
      this.validateObservationChain(caseId, scopeSpecId, dep, effective, seen);
    }
  }

  private requireSourceRevision(
    caseId: string,
    accountId: string | null,
    sourceId: string,
    sourceRevision: number
  ): void {
    const row = this.db
      .prepare(
        `SELECT r.revision FROM research_case_source_revisions r
         JOIN research_case_sources s ON s.id = r.source_id
         WHERE r.source_id = ? AND r.revision = ? AND s.case_id = ?
           AND (? IS NULL OR s.account_id = ?)`
      )
      .get(sourceId, sourceRevision, caseId, accountId, accountId) as { revision: number } | undefined;
    if (!row) {
      throw new ForeignReferenceError(
        `source revision ${sourceId}@${String(sourceRevision)} is not owned by case ${caseId}${accountId ? ` account ${accountId}` : ''}`
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Assessment                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Read one consistent persisted snapshot, evaluate it with the
   * deterministic pure function and append the assessment. The caller cannot
   * supply final counters, percentages or a registry subset.
   */
  assessCompletion(input: AssessCompletionInput): CompletionAssessment {
    return this.write(() => {
      const caseRow = this.loadCase(input.ownerId, input.caseId, input.expectedScopeVersion);
      const specRow = this.scopeRow(input.caseId, input.scopeSpecId);
      if (specRow.scope_version !== caseRow.scope_version) {
        throw new StaleScopeError(input.caseId, input.expectedScopeVersion, asScopeVersion(specRow.scope_version));
      }
      const snapshot = this.buildSnapshot(caseRow, specRow);
      const composed = buildAssessmentInput(snapshot);
      if (composed.specHash !== specRow.spec_hash || composed.accountSliceHash !== specRow.account_slice_hash) {
        throw new CompletionSpecError('frozen spec or account slice hash mismatch; refusing to assess corrupted state');
      }
      const evaluation = evaluateCompletion(snapshot);
      const assessmentId = newRecordId('asmt');
      this.db
        .prepare(
          `INSERT INTO research_case_completion_assessments (
            id, case_id, scope_spec_id, scope_version, policy_version,
            evidence_revision, input_hash, input_json, verdict, evaluation_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          assessmentId,
          input.caseId,
          input.scopeSpecId,
          input.expectedScopeVersion,
          composed.policyVersion,
          composed.evidenceRevision,
          composed.inputHash,
          stableStringify(composed),
          evaluation.verdict,
          stableStringify(evaluation),
          nowIso()
        );
      return this.mapAssessment(
        this.db.prepare('SELECT * FROM research_case_completion_assessments WHERE id = ?').get(assessmentId) as AssessmentRow
      );
    });
  }

  private mapAssessment(row: AssessmentRow): CompletionAssessment {
    return {
      assessmentId: row.id,
      caseId: row.case_id,
      scopeSpecId: row.scope_spec_id,
      scopeVersion: asScopeVersion(row.scope_version),
      policyVersion: row.policy_version,
      evidenceRevision: row.evidence_revision,
      inputHash: row.input_hash,
      input: parseJson<CompletionAssessmentInput>(row.input_json, {} as CompletionAssessmentInput),
      evaluation: parseJson<CompletionEvaluation>(row.evaluation_json, {} as CompletionEvaluation),
      createdAt: row.created_at
    };
  }

  /** One consistent persisted input snapshot for a frozen spec. */
  private buildSnapshot(caseRow: CaseRow, specRow: CompletionScopeRow): CompletionSnapshot {
    const spec = parseJson<CompletionScopeSpec>(specRow.spec_json, {} as CompletionScopeSpec);
    const accountSlice = parseJson<ScopeAccountSnapshot[]>(specRow.account_slice_json, []);
    const observationRows = this.db
      .prepare(
        'SELECT * FROM research_case_completion_observations WHERE case_id = ? AND scope_spec_id = ? ORDER BY seq ASC'
      )
      .all(specRow.case_id, specRow.id) as ObservationRow[];
    const observations = observationRows.map((row) => this.mapObservation(row));
    const pinKeys = new Map<string, PinnedCoverageRecord>();
    for (const observation of observations) {
      for (const pin of observation.refs.coverageItems) {
        const key = `${pin.itemId}@${String(pin.revision)}`;
        if (pinKeys.has(key)) continue;
        pinKeys.set(key, this.loadCoveragePin(specRow.case_id, pin.itemId, pin.revision));
      }
    }
    const coverage = [...pinKeys.values()];
    const sources = (
      this.db
        .prepare(
          `SELECT s.id AS source_id, r.revision AS source_revision, s.account_id, r.published_at, r.content_hash
           FROM research_case_sources s
           JOIN research_case_source_revisions r ON r.source_id = s.id
           WHERE s.case_id = ?
           ORDER BY s.id ASC, r.revision ASC`
        )
        .all(specRow.case_id) as {
        source_id: string;
        source_revision: number;
        account_id: string;
        published_at: string | null;
        content_hash: string;
      }[]
    ).map((row) => ({
      sourceId: row.source_id,
      sourceRevision: row.source_revision,
      accountId: row.account_id,
      publishedAt: row.published_at,
      contentHash: row.content_hash
    }));
    const evidence = (
      this.db
        .prepare(
          `SELECT id, account_id, source_id, source_revision, role, quote_hash, revoked_at
           FROM research_case_evidence WHERE case_id = ? ORDER BY id ASC`
        )
        .all(specRow.case_id) as {
        id: string;
        account_id: string;
        source_id: string;
        source_revision: number;
        role: EvidenceRole;
        quote_hash: string;
        revoked_at: string | null;
      }[]
    ).map((row) => ({
      evidenceId: row.id,
      accountId: row.account_id,
      sourceId: row.source_id,
      sourceRevision: row.source_revision,
      role: row.role,
      quoteHash: row.quote_hash,
      revokedAt: row.revoked_at
    }));
    const identity = (
      this.db
        .prepare('SELECT id, identity_support_json FROM research_case_accounts WHERE case_id = ? ORDER BY id ASC')
        .all(specRow.case_id) as { id: string; identity_support_json: string }[]
    ).map((row) => {
      const support = parseJson<{
        state: IdentitySupportState;
        evidenceIds: string[];
        counterevidenceIds: string[];
        policyVersion: string;
      }>(row.identity_support_json, {
        state: 'proposed',
        evidenceIds: [],
        counterevidenceIds: [],
        policyVersion: 'identity-policy/v1'
      });
      return {
        accountId: row.id,
        state: support.state,
        evidenceIds: [...support.evidenceIds].sort(),
        counterevidenceIds: [...support.counterevidenceIds].sort(),
        policyVersion: support.policyVersion
      };
    });
    return {
      policyVersion: COMPLETION_POLICY_VERSION,
      scopeSpecId: specRow.id,
      scopeVersion: asScopeVersion(specRow.scope_version),
      spec,
      accountSlice,
      observations,
      coverage,
      sources,
      evidence,
      identity
    };
  }

  private loadCoveragePin(caseId: string, itemId: string, revision: number): PinnedCoverageRecord {
    const item = this.db
      .prepare('SELECT * FROM research_case_item_coverage WHERE id = ? AND case_id = ?')
      .get(itemId, caseId) as
      | {
          id: string;
          account_id: string;
          source_id: string;
          source_revision: number;
          task_ref_json: string;
        }
      | undefined;
    if (!item) throw new ForeignReferenceError(`coverage item ${itemId} is not part of case ${caseId}`);
    const rev = this.db
      .prepare('SELECT * FROM research_case_item_coverage_revisions WHERE item_id = ? AND revision = ?')
      .get(itemId, revision) as
      | {
          scope_version: number;
          status: PinnedCoverageRecord['status'];
          evidence_json: string;
          counterevidence_json: string;
        }
      | undefined;
    if (!rev) throw new ForeignReferenceError(`coverage revision ${itemId}@${String(revision)} does not exist`);
    return {
      itemId: item.id,
      revision,
      locator: {
        accountId: item.account_id,
        sourceId: item.source_id,
        sourceRevision: item.source_revision
      },
      taskRef: parseJson<TaskRef>(item.task_ref_json, { kind: 'question_matrix', slot: 'work' }),
      scopeVersion: asScopeVersion(rev.scope_version),
      status: rev.status,
      evidenceIds: parseJson<string[]>(rev.evidence_json, []),
      counterevidenceIds: parseJson<string[]>(rev.counterevidence_json, [])
    };
  }

  /* ---------------------------------------------------------------- */
  /* Reads: immutable history plus separately derived validity        */
  /* ---------------------------------------------------------------- */

  getCompletionScope(ownerId: string, caseId: string, scopeSpecId: string): FrozenCompletionScopeView | null {
    const caseRow = this.loadCase(ownerId, caseId);
    const row = this.db
      .prepare('SELECT * FROM research_case_completion_scopes WHERE id = ? AND case_id = ?')
      .get(scopeSpecId, caseId) as CompletionScopeRow | undefined;
    if (!row) return null;
    return { ...this.mapScope(row), isCurrent: row.scope_version === caseRow.scope_version };
  }

  listCompletionScopes(ownerId: string, caseId: string): FrozenCompletionScopeView[] {
    const caseRow = this.loadCase(ownerId, caseId);
    const rows = this.db
      .prepare('SELECT * FROM research_case_completion_scopes WHERE case_id = ? ORDER BY scope_version ASC')
      .all(caseId) as CompletionScopeRow[];
    return rows.map((row) => ({ ...this.mapScope(row), isCurrent: row.scope_version === caseRow.scope_version }));
  }

  listCompletionObservations(ownerId: string, caseId: string, scopeSpecId?: string): CompletionObservation[] {
    this.loadCase(ownerId, caseId);
    const rows = (
      scopeSpecId === undefined
        ? this.db
            .prepare('SELECT * FROM research_case_completion_observations WHERE case_id = ? ORDER BY seq ASC')
            .all(caseId)
        : this.db
            .prepare(
              'SELECT * FROM research_case_completion_observations WHERE case_id = ? AND scope_spec_id = ? ORDER BY seq ASC'
            )
            .all(caseId, scopeSpecId)
    ) as ObservationRow[];
    return rows.map((row) => this.mapObservation(row));
  }

  getCompletionAssessment(ownerId: string, caseId: string, assessmentId: string): CompletionAssessmentView | null {
    const caseRow = this.loadCase(ownerId, caseId);
    const row = this.db
      .prepare('SELECT * FROM research_case_completion_assessments WHERE id = ? AND case_id = ?')
      .get(assessmentId, caseId) as AssessmentRow | undefined;
    if (!row) return null;
    return this.assessView(caseRow, row);
  }

  listCompletionAssessments(ownerId: string, caseId: string, scopeSpecId?: string): CompletionAssessmentView[] {
    const caseRow = this.loadCase(ownerId, caseId);
    // Insertion order (rowid) is monotonic regardless of wall clock; created_at
    // and random ids never decide listing order.
    const rows = (
      scopeSpecId === undefined
        ? this.db
            .prepare('SELECT * FROM research_case_completion_assessments WHERE case_id = ? ORDER BY rowid ASC')
            .all(caseId)
        : this.db
            .prepare(
              'SELECT * FROM research_case_completion_assessments WHERE case_id = ? AND scope_spec_id = ? ORDER BY rowid ASC'
            )
            .all(caseId, scopeSpecId)
    ) as AssessmentRow[];
    return rows.map((row) => this.assessView(caseRow, row));
  }

  /** Historical verdict stays; current validity is derived from current state. */
  private assessView(caseRow: CaseRow, row: AssessmentRow): CompletionAssessmentView {
    const assessment = this.mapAssessment(row);
    const staleReasons: string[] = [];
    if (caseRow.scope_version !== row.scope_version) staleReasons.push('scope_advanced');
    const specRow = this.db
      .prepare('SELECT * FROM research_case_completion_scopes WHERE id = ?')
      .get(row.scope_spec_id) as CompletionScopeRow | undefined;
    if (!specRow) {
      staleReasons.push('scope_spec_missing');
    } else {
      const current = buildAssessmentInput(this.buildSnapshot(caseRow, specRow));
      staleReasons.push(
        ...staleReasonsAgainst(assessment.input, current).filter((reason) => reason !== 'scope_advanced')
      );
    }
    return {
      ...assessment,
      currentValidity: staleReasons.length > 0 ? 'review' : 'valid',
      staleReasons
    };
  }

  /**
   * Deterministic same-input replay: re-run the pure evaluator on the stored
   * input and compare with the original verdict and digests. Historical
   * replay never depends on current rows.
   */
  replayCompletionAssessment(
    ownerId: string,
    caseId: string,
    assessmentId: string
  ): { assessment: CompletionAssessment; replayed: CompletionEvaluation; verdictMatches: boolean; inputHashMatches: boolean } {
    this.loadCase(ownerId, caseId);
    const row = this.db
      .prepare('SELECT * FROM research_case_completion_assessments WHERE id = ? AND case_id = ?')
      .get(assessmentId, caseId) as AssessmentRow | undefined;
    if (!row) throw new ForeignReferenceError(`assessment ${assessmentId} is not part of case ${caseId}`);
    const assessment = this.mapAssessment(row);
    const replayed = evaluateCompletion(assessment.input);
    const recomputed = buildAssessmentInput(assessment.input);
    return {
      assessment,
      replayed,
      verdictMatches: stableStringify(replayed) === stableStringify(assessment.evaluation),
      inputHashMatches: recomputed.inputHash === assessment.inputHash
    };
  }
}
