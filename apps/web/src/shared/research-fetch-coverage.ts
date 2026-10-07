/**
 * GET-95 shared domain contract: Fetch processing coverage (first batch).
 *
 * This module is authoritative for the Fetch processing layer that sits on top
 * of the frozen GET-60 obligations: immutable per-content processing receipts
 * and the read-side coverage projection derived from them. It reuses the GET-58
 * authoritative types (`CoverageLocator`, `ScopeVersion`, `AccountSelection`,
 * `RecordProvenance`, `EvidenceRef` roles) and the GET-60 frozen scope/time
 * semantics (`TimeRangeSpec`, `mergeMediaMetadata`, `isEligibleInvestigation`)
 * instead of inventing a second identity, scope or completion model.
 *
 * Content identity is case + account + stable sourceId + sourceRevision
 * (`CoverageLocator`). Processing dimensions are independent: `body`, `media`,
 * the default first page of top-level `comments` and each selected
 * `thread_branch` (identified by its branch key). The explicit processing
 * states are `listed / unread / read / skipped / context_missing / inaccessible
 * / unsupported / deleted / truncated / failed`; `read` is the only success and
 * every other state carries a mandatory non-empty reason. Source prose or a
 * caller "done" note is never authority — the structured state is.
 *
 * Persistence semantics (see server/research/fetch-coverage-store.ts): receipts
 * are append-only with replay identity — recording the same receipt key with
 * the same body is a no-op and the same key with a different body is a rejected
 * conflict. Writes bind immutable source revisions and atomically validate
 * owner / case / account / allowedScope / current scopeVersion; history
 * processing on `profile_only` or `none` accounts, stale or future scopes,
 * foreign references and already-revoked dependencies are rejected. Batch
 * writes commit fully or roll back fully.
 *
 * Projection semantics: the latest receipt per dimension supersedes by append
 * order (never by clock) within the same scope, and a later `failed` or
 * `inaccessible` receipt reopens a prior success. Duplicate pages and replayed
 * receipts never double count. New source revisions, stale-scope receipts and
 * missing/deleted/hidden thread parents stay explicit. Unknown publication
 * dates stay inside the frozen window with a limitation. Counters are grouped
 * per platform/account over the frozen publication window; `percent` is null
 * for unknown denominators, open cursors, known gaps and zero denominators.
 * Enumeration exhaustion only ever comes from a protocol-conforming GET-60
 * observation (explicit `endpoint_exhausted`, no cursor, no known gap) — never
 * from a fetch-layer cursor going null. Media applicability reuses the frozen
 * `mergeMediaMetadata` rule: unknown media is never treated as completed and
 * credible metadata is required to establish absence.
 *
 * Boundary (see docs/fetch-coverage.md): this is an offline coverage
 * foundation. Receipts are processing records, kept strictly separate from
 * GET-60 policy observations; recording them never writes observations,
 * assessments, frozen rules, identity state or publication output, and this
 * module never derives a second "complete" verdict — completion claims stay
 * with GET-60 assessments. No network, provider, worker or runtime wiring.
 */

import type {
  AllowedScopeState,
  CoverageLocator,
  RecordProvenance,
  ScopeVersion
} from './research-case.js';
import type { TimeRangeSpec } from './research-completion.js';
import type { Validity } from './types.js';

export const FETCH_COVERAGE_SCHEMA_VERSION = 'stripsearch/research-fetch-coverage/v1';

/* ------------------------------------------------------------------ */
/* Errors (fail closed)                                               */
/* ------------------------------------------------------------------ */

/** The receipt draft violates the processing receipt protocol. */
export class FetchReceiptProtocolError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'FetchReceiptProtocolError';
  }
}

/**
 * Replay identity conflict: the receipt key was already recorded with a
 * different body. Nothing is written and the surrounding batch rolls back.
 */
export class FetchReceiptConflictError extends Error {
  constructor(readonly receiptKey: string) {
    super(`receipt ${receiptKey} was already recorded with a different body`);
    this.name = 'FetchReceiptConflictError';
  }
}

/**
 * History processing is not allowed for this account: `profile_only` and
 * `none` allowedScope never permit body/media/comments/thread reads.
 */
export class FetchScopeDeniedError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'FetchScopeDeniedError';
  }
}

/* ------------------------------------------------------------------ */
/* Dimensions and states                                              */
/* ------------------------------------------------------------------ */

export type FetchDimensionName = 'body' | 'media' | 'comments' | 'thread_branch';

export const FETCH_DIMENSION_NAMES: readonly FetchDimensionName[] = [
  'body',
  'media',
  'comments',
  'thread_branch'
];

/**
 * One processing dimension instance: body/media/default first-page comments of
 * a content identity, or one selected thread branch (by its branch key).
 */
export type FetchDimensionRef =
  | { name: 'body' | 'media' | 'comments' }
  | { name: 'thread_branch'; branchKey: string };

/** Canonical collision-free dimension key (branch keys are length-prefixed). */
export function fetchDimensionKey(ref: FetchDimensionRef): string {
  return ref.name === 'thread_branch'
    ? `thread_branch:${String(ref.branchKey.length)}:${ref.branchKey}`
    : ref.name;
}

export type FetchProcessingState =
  | 'listed'
  | 'unread'
  | 'read'
  | 'skipped'
  | 'context_missing'
  | 'inaccessible'
  | 'unsupported'
  | 'deleted'
  | 'truncated'
  | 'failed';

/** Fixed order used by every state histogram in the projection. */
export const FETCH_PROCESSING_STATES: readonly FetchProcessingState[] = [
  'listed',
  'unread',
  'read',
  'skipped',
  'context_missing',
  'inaccessible',
  'unsupported',
  'deleted',
  'truncated',
  'failed'
];

/** `read` is the only success state; everything else needs a reason. */
export const FETCH_SUCCESS_STATE: FetchProcessingState = 'read';

const STATE_SET: ReadonlySet<string> = new Set<string>(FETCH_PROCESSING_STATES);

/* ------------------------------------------------------------------ */
/* Parent context (thread branches)                                   */
/* ------------------------------------------------------------------ */

export type ParentContextState = 'present' | 'missing' | 'deleted' | 'hidden';

/** One explicit parent-chain node state; missing/deleted/hidden never smooth over. */
export interface ParentContextEntry {
  commentKey: string;
  state: ParentContextState;
}

const PARENT_STATES: ReadonlySet<string> = new Set(['present', 'missing', 'deleted', 'hidden']);

/* ------------------------------------------------------------------ */
/* Processing receipts (immutable, replay-identifiable)               */
/* ------------------------------------------------------------------ */

/**
 * Caller draft of one processing receipt. `receiptKey` is the replay identity:
 * the same key with the same body is a no-op replay and the same key with a
 * different body is a conflict. `occurredAt` records when the processing
 * actually happened and never decides ordering — supersession uses append
 * order only.
 */
export interface FetchProcessingReceiptDraft {
  receiptKey: string;
  /** Immutable content identity: account + stable source id + source revision. */
  content: CoverageLocator;
  dimension: FetchDimensionRef;
  state: FetchProcessingState;
  /** Mandatory non-empty for every non-success state; `null` for `read`. */
  reason: string | null;
  /** Explicit parent-chain context; thread branches only. */
  parents: ParentContextEntry[];
  /** Support-role evidence (factual_/identity_support) this receipt relies on. */
  evidenceIds: string[];
  /** Counterevidence-role evidence (factual_/identity_counterevidence). */
  counterevidenceIds: string[];
  /** When the processing happened (ISO); free-form enough to run backwards. */
  occurredAt: string;
  note: string | null;
  /** Explicit synthetic provenance for offline fixtures. */
  synthetic: boolean;
  provenance: RecordProvenance;
}

/** Canonical receipt body used for replay-identity hashing. */
export interface FetchReceiptBody {
  content: CoverageLocator;
  dimension: FetchDimensionRef;
  state: FetchProcessingState;
  reason: string | null;
  parents: ParentContextEntry[];
  evidenceIds: string[];
  counterevidenceIds: string[];
  occurredAt: string;
  note: string | null;
  synthetic: boolean;
  provenance: RecordProvenance;
}

/**
 * Deterministic body of a receipt (the replay comparison input). The receipt
 * key is the lookup identity and is not part of the body: same key + same body
 * is a no-op, same key + different body conflicts.
 */
export function fetchReceiptBody(draft: FetchProcessingReceiptDraft): FetchReceiptBody {
  return {
    content: {
      accountId: draft.content.accountId,
      sourceId: draft.content.sourceId,
      sourceRevision: draft.content.sourceRevision
    },
    dimension:
      draft.dimension.name === 'thread_branch'
        ? { name: 'thread_branch', branchKey: draft.dimension.branchKey }
        : { name: draft.dimension.name },
    state: draft.state,
    reason: draft.reason,
    parents: draft.parents.map((entry) => ({ commentKey: entry.commentKey, state: entry.state })),
    evidenceIds: [...draft.evidenceIds],
    counterevidenceIds: [...draft.counterevidenceIds],
    occurredAt: draft.occurredAt,
    note: draft.note,
    synthetic: draft.synthetic,
    provenance: {
      authorization: draft.provenance.authorization,
      collector: draft.provenance.collector,
      note: draft.provenance.note
    }
  };
}

/** Persisted receipt: draft fields plus store-assigned identity and ordering. */
export interface FetchReceiptRecord extends FetchProcessingReceiptDraft {
  receiptId: string;
  caseId: string;
  /** Scope version in effect when this receipt was recorded. */
  scopeVersion: ScopeVersion;
  /** Append order. Supersession and history ordering use this, never a clock. */
  seq: number;
  bodyHash: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Draft validation (pure, fail closed)                               */
/* ------------------------------------------------------------------ */

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new FetchReceiptProtocolError(
      `${where} must have exactly the keys ${wanted.join('/')}, got ${actual.join('/') || '(none)'}`
    );
  }
}

const DRAFT_KEYS = [
  'receiptKey',
  'content',
  'dimension',
  'state',
  'reason',
  'parents',
  'evidenceIds',
  'counterevidenceIds',
  'occurredAt',
  'note',
  'synthetic',
  'provenance'
] as const;

const CONTENT_KEYS = ['accountId', 'sourceId', 'sourceRevision'] as const;
const PROVENANCE_KEYS = ['authorization', 'collector', 'note'] as const;

/**
 * Structural protocol check of one receipt draft (ownership, scope and
 * dependency checks happen atomically in the store). Unknown keys are rejected
 * at every level so a model or caller cannot smuggle authority fields in.
 */
export function validateFetchReceiptDraft(draft: FetchProcessingReceiptDraft): void {
  if (draft === null || typeof draft !== 'object') {
    throw new FetchReceiptProtocolError('receipt draft must be an object');
  }
  exactKeys(draft as unknown as Record<string, unknown>, DRAFT_KEYS, 'receipt draft');
  if (!isNonEmptyString(draft.receiptKey)) {
    throw new FetchReceiptProtocolError('receiptKey must be a non-empty string');
  }
  if (draft.content === null || typeof draft.content !== 'object') {
    throw new FetchReceiptProtocolError('content must be an object');
  }
  exactKeys(draft.content as unknown as Record<string, unknown>, CONTENT_KEYS, 'content');
  if (!isNonEmptyString(draft.content.accountId) || !isNonEmptyString(draft.content.sourceId)) {
    throw new FetchReceiptProtocolError('content accountId/sourceId must be non-empty strings');
  }
  if (!Number.isInteger(draft.content.sourceRevision) || draft.content.sourceRevision < 1) {
    throw new FetchReceiptProtocolError('content sourceRevision must be a positive integer');
  }
  if (draft.dimension === null || typeof draft.dimension !== 'object') {
    throw new FetchReceiptProtocolError('dimension must be an object');
  }
  const dimensionKeys = Object.keys(draft.dimension as unknown as Record<string, unknown>).sort();
  const isBranch = draft.dimension.name === 'thread_branch';
  const wantedDimensionKeys = isBranch ? ['branchKey', 'name'] : ['name'];
  if (
    dimensionKeys.length !== wantedDimensionKeys.length ||
    dimensionKeys.some((key, index) => key !== wantedDimensionKeys[index])
  ) {
    throw new FetchReceiptProtocolError(
      `dimension must have exactly the keys ${wantedDimensionKeys.join('/')}, got ${dimensionKeys.join('/') || '(none)'}`
    );
  }
  if (!FETCH_DIMENSION_NAMES.includes(draft.dimension.name)) {
    throw new FetchReceiptProtocolError(`unknown dimension ${String(draft.dimension.name)}`);
  }
  if (isBranch && !isNonEmptyString((draft.dimension as { branchKey: string }).branchKey)) {
    throw new FetchReceiptProtocolError('thread_branch dimension requires a non-empty branchKey');
  }
  if (!STATE_SET.has(draft.state)) {
    throw new FetchReceiptProtocolError(`unknown processing state ${String(draft.state)}`);
  }
  if (draft.state === FETCH_SUCCESS_STATE) {
    if (draft.reason !== null) {
      throw new FetchReceiptProtocolError('read is the success state and cannot carry a reason');
    }
  } else if (!isNonEmptyString(draft.reason)) {
    throw new FetchReceiptProtocolError(
      `state ${draft.state} is not a success and requires a non-empty reason`
    );
  }
  if (!Array.isArray(draft.parents)) {
    throw new FetchReceiptProtocolError('parents must be an array');
  }
  if (!isBranch && draft.parents.length > 0) {
    throw new FetchReceiptProtocolError('parent context is only representable on thread_branch dimensions');
  }
  for (const entry of draft.parents) {
    if (entry === null || typeof entry !== 'object') {
      throw new FetchReceiptProtocolError('parent entries must be objects');
    }
    exactKeys(entry as unknown as Record<string, unknown>, ['commentKey', 'state'], 'parent entry');
    if (!isNonEmptyString(entry.commentKey) || !PARENT_STATES.has(entry.state)) {
      throw new FetchReceiptProtocolError('parent entries require a commentKey and a known state');
    }
  }
  for (const list of [draft.evidenceIds, draft.counterevidenceIds]) {
    if (!Array.isArray(list) || list.some((id) => !isNonEmptyString(id))) {
      throw new FetchReceiptProtocolError('evidence reference lists must be arrays of non-empty ids');
    }
  }
  if (!isNonEmptyString(draft.occurredAt)) {
    throw new FetchReceiptProtocolError('occurredAt must be a non-empty timestamp');
  }
  if (draft.note !== null && typeof draft.note !== 'string') {
    throw new FetchReceiptProtocolError('note must be a string or null');
  }
  if (typeof draft.synthetic !== 'boolean') {
    throw new FetchReceiptProtocolError('synthetic must be a boolean');
  }
  if (draft.provenance === null || typeof draft.provenance !== 'object') {
    throw new FetchReceiptProtocolError('provenance must be an object');
  }
  exactKeys(draft.provenance as unknown as Record<string, unknown>, PROVENANCE_KEYS, 'provenance');
  if (!isNonEmptyString(draft.provenance.collector)) {
    throw new FetchReceiptProtocolError('provenance.collector must be a non-empty string');
  }
  if (draft.provenance.note !== null && typeof draft.provenance.note !== 'string') {
    throw new FetchReceiptProtocolError('provenance.note must be a string or null');
  }
}

/* ------------------------------------------------------------------ */
/* Frozen publication window semantics (GET-60)                       */
/* ------------------------------------------------------------------ */

function day(value: string): string {
  return value.slice(0, 10);
}

/**
 * GET-60 frozen time semantics: compared at date granularity, a null bound is
 * unbounded and an unknown publication date never silently becomes
 * out-of-window — such items stay in scope and are flagged as limited.
 */
export function inFrozenPublicationWindow(
  publishedAt: string | null,
  window: TimeRangeSpec
): boolean {
  if (publishedAt === null) return true;
  if (window.from !== null && day(publishedAt) < day(window.from)) return false;
  if (window.to !== null && day(publishedAt) > day(window.to)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Read-side projection                                               */
/* ------------------------------------------------------------------ */

export type FetchMediaApplicability = 'none' | 'present' | 'unknown';

/** Receipt with separately derived current scope and dependency validity. */
export interface FetchReceiptView extends FetchReceiptRecord {
  scopeValidity: Validity;
  scopeReviewReason: string | null;
  dependencyValidity: Validity;
  dependencyReviewReason: string | null;
}

/** Per-dimension processing state of one content identity (or thread branch). */
export interface FetchDimensionView {
  dimension: FetchDimensionRef;
  /**
   * Latest receipt within the current scope by append order (never by clock);
   * a stale-scope latest receipt is shown but marked, and with no receipt at
   * all the state is the derived `unread` baseline.
   */
  state: FetchProcessingState;
  reason: string | null;
  /** True only for a `read` on the current scope with currently valid dependencies. */
  countsAsValidRead: boolean;
  scopeValidity: Validity;
  dependencyValidity: Validity;
  staleReasons: string[];
  /** Thread branches: whether GET-60 holds a `select_branch` selection record. */
  branchSelected: boolean;
  /** Thread branches: explicit parent states (missing/deleted/hidden stay visible). */
  parents: ParentContextEntry[];
  history: FetchReceiptView[];
}

export interface FetchMediaView {
  /** Frozen `mergeMediaMetadata` result over GET-60 enumeration metadata. */
  applicability: FetchMediaApplicability;
  /** Every distinct value recorded, for truthful conflict limitations. */
  recorded: FetchMediaApplicability[];
  conflict: boolean;
}

export interface FetchCoverageItemView {
  content: CoverageLocator;
  platform: string;
  publishedAt: string | null;
  dateKnown: boolean;
  /** Unknown dates stay inside the frozen window (with a limitation). */
  inWindow: boolean;
  inAccountRange: boolean;
  /** Whether GET-60 enumeration observations list this exact source revision. */
  enumerated: boolean;
  media: FetchMediaView;
  /** Explicit: a newer immutable source revision exists for this source. */
  newerRevisionAvailable: number | null;
  dimensions: FetchDimensionView[];
  limitations: string[];
}

export interface FetchDimensionCounter {
  dimension: FetchDimensionName;
  /** Dimension instances counted (items for body/media/comments; branches for threads). */
  instances: number;
  states: Record<FetchProcessingState, number>;
  validReads: number;
  /** Media only: instances with credibly absent media (nothing to read). */
  satisfiedByAbsence: number;
  satisfied: number;
  /** Null for unknown or zero denominators — never a fake percentage. */
  percent: number | null;
}

export type FetchEnumerationBasis =
  | 'endpoint_exhausted'
  | 'cursor_open'
  | 'known_gap'
  | 'access_boundary'
  | 'blocked'
  | 'not_exhausted'
  | 'failed'
  | 'cancelled'
  | 'needs_input'
  | 'dependency_withdrawn'
  | 'no_observation';

/**
 * Current enumeration state of one account. Exhaustion is only ever derived
 * from a protocol-conforming GET-60 `enumerate_history` observation — an
 * explicit `endpoint_exhausted` with no cursor and no known gap — never from a
 * fetch-layer cursor going null.
 */
export interface FetchEnumerationStatus {
  exhausted: boolean;
  basis: FetchEnumerationBasis;
  openCursor: boolean;
  knownGaps: string[];
  observationId: string | null;
}

export interface FetchAccountCoverage {
  accountId: string;
  platform: string;
  allowedScope: AllowedScopeState;
  /** GET-60 frozen account range membership (explicit list or public_history). */
  inAccountRange: boolean;
  enumeration: FetchEnumerationStatus;
  enumeratedItems: number;
  /** Explicit: processing receipts for content outside the enumerated set. */
  receiptOnlyItems: number;
  inWindowItems: number;
  /** In-window items whose publication date is unknown (kept in scope). */
  unknownDateItems: number;
  outOfWindowItems: number;
  /** Explicit: in-window items outside the frozen account range (not counted). */
  outOfRangeItems: number;
  denominatorKnown: boolean;
  /** Null when the denominator is unknown; zero stays zero (percent still null). */
  total: number | null;
  dimensions: FetchDimensionCounter[];
  limitations: string[];
}

/**
 * Read-only projection: per-platform/account counters over the frozen
 * publication window plus per-item state/reason/history. Deliberately carries
 * no completion verdict — GET-60 assessments own completion claims.
 */
export interface FetchCoverageView {
  schemaVersion: typeof FETCH_COVERAGE_SCHEMA_VERSION;
  caseId: string;
  scopeSpecId: string;
  /** Current authoritative case scope version used for stale markings. */
  currentScopeVersion: ScopeVersion;
  /** Frozen publication window (GET-60 frozen spec) the counters are cut at. */
  window: TimeRangeSpec;
  threadDepth: number;
  accounts: FetchAccountCoverage[];
  items: FetchCoverageItemView[];
  limitations: string[];
}
