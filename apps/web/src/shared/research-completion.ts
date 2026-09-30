/**
 * GET-60 shared domain contract: frozen research scope, completion policy,
 * observation receipts and append-only assessments.
 *
 * This module defines exactly three new record shapes — `CompletionScopeSpec`
 * (the frozen scope rules), `CompletionObservation` (immutable attempt
 * receipts) and `CompletionAssessment` (append-only evaluations). It imports
 * the GET-58 authoritative types (`ResearchCase`, `ScopeVersion`,
 * `AccountSelection`, `CoverageLocator`, `ItemCoverageRevision`, `EvidenceRef`,
 * `SourceRevision`, `ScopeAccountSnapshot`) instead of defining competing
 * identity or scope models.
 *
 * Boundaries (see docs/research-completion-domain.md):
 * - The frozen scope binds RULES (questions with applicability reasons, the
 *   full platform registry version/hash/snapshot, account range, time window,
 *   body/media/default first-page top-level comments and the selected
 *   thread/ancestor depth — design default 4), never a hand-picked corpus of
 *   a few posts. Per-item obligations are derived from immutable enumeration
 *   observations at evaluation time.
 * - The first freeze binds the current authoritative case `scopeVersion` once
 *   and works before any account exists. Subsequent edits advance the same
 *   authoritative scope version exactly once through the shared case-level
 *   scope mutation path and persist a new immutable spec. Nothing updates or
 *   deletes a frozen spec: hard questions cannot be dropped after the fact to
 *   claim completion.
 * - A free-text note or a caller "completed" flag can never establish
 *   completion. `resolved_unknown` counts as addressed only with
 *   protocol-conforming investigative actions and dependencies;
 *   unattempted, budget exhaustion, permission failure and unsupported stay
 *   distinct and never masquerade as `no_match` or `resolved_unknown`.
 * - Missing registries or empty global obligations cannot pass vacuously;
 *   true complete enumeration with zero items may complete that dimension,
 *   but a zero/unknown denominator never displays 100% and dimensions stay
 *   distinct instead of a misleading aggregate percentage.
 *
 * These records are persisted scope/completion policy foundations only: no
 * GET-94/95/99 autonomous runtime, scheduling, leases or platform collection
 * lives here. Legacy `research_actions` is run history and
 * `TaskRef.research_task` is the evaluation rubric; neither is a case
 * investigation receipt.
 *
 * Ordered observation semantics (frozen): receipts are immutable and
 * insertion-ordered; the CURRENT state of every obligation is established by
 * the latest receipt of its action family (supersession). Earlier receipts
 * stay readable as history and keep their limitations visible. A later
 * successful receipt resolves earlier gaps (e.g. an open cursor closed by
 * final exhaustion, or a clean thread read releasing an earlier missing
 * parent); a later blocker supersedes an earlier success and must not be
 * hidden by it. Enumerated items accumulate across all enumeration receipts;
 * an empty later page never erases accumulated discoveries.
 *
 * Current dependency validity is part of establishment: a receipt whose
 * evidence/coverage/predecessor references are revoked, missing,
 * role-mismatched or foreign cannot establish completion (it stays history).
 * An independent valid dependency can restore completion later.
 *
 * Investigated-unknown eligibility protocol (frozen, deterministic — it
 * validates recorded protocol semantics, not provider execution or factual
 * truth): a predecessor observation counts as an actual investigation only
 * via `isEligibleInvestigation` plus currently valid concrete dependencies.
 *
 * Account-boundary inheritance (frozen): every reference chain of an
 * account-scoped receipt inherits that account across transitive
 * evidence/source/coverage/observation dependencies — including intermediate
 * case-level nodes, which must not erase the inherited account constraint.
 * Case-level aggregation (e.g. a question spanning accounts) may legitimately
 * reference multiple accounts from its own unrestricted root. Nested
 * account-scoped nodes must match the inherited account. Any validity
 * memoization is keyed by (observationId, expectedAccount|null) so a
 * permissive case-level pass can never satisfy a restricted one.
 */

import type {
  CoverageLocator,
  CoverageStatus,
  EvidenceRole,
  IdentitySupportState,
  QuestionSlot,
  RecordProvenance,
  ScopeAccountSnapshot,
  ScopeVersion,
  TaskRef
} from './research-case.js';
import type { Validity } from './types.js';

export const COMPLETION_POLICY_VERSION = 'stripsearch/research-completion/v1';

/** Design default ancestor depth for selected thread/author-reply branches. */
export const DEFAULT_THREAD_DEPTH = 4;

/* ------------------------------------------------------------------ */
/* Errors (fail closed)                                               */
/* ------------------------------------------------------------------ */

/** The frozen scope rules violate the completion policy (empty registry, bad window, ...). */
export class CompletionSpecError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'CompletionSpecError';
  }
}

/** An observation receipt violates the minimal receipt protocol. */
export class ObservationProtocolError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ObservationProtocolError';
  }
}

/* ------------------------------------------------------------------ */
/* Frozen scope specification (rules, never a hand-picked corpus)     */
/* ------------------------------------------------------------------ */

export type QuestionApplicability = 'applicable' | 'not_applicable';

export interface CompletionQuestion {
  /** Stable question id; questions are marked not applicable, never deleted. */
  questionId: string;
  /** Design question-matrix slot when the question maps to one. */
  slot: QuestionSlot | null;
  text: string;
  applicability: QuestionApplicability;
  /** Frozen reason for the applicability decision. */
  applicabilityReason: string;
}

export interface PlatformRegistryEntry {
  platformId: string;
  label: string;
  applicability: QuestionApplicability;
  /** Frozen reason (e.g. why a catalog platform is out of this research). */
  applicabilityReason: string;
}

/**
 * The full discovery catalog snapshot. Every listed platform stays
 * represented — including platforms beyond the initial deep-read samples and
 * unsupported/inaccessible/unattempted states. Discovery is never silently
 * restricted to enabled adapters.
 */
export interface PlatformRegistry {
  registryVersion: string;
  entries: PlatformRegistryEntry[];
}

/**
 * Which frozen-slice accounts carry history/body/media/comment obligations:
 * `researched_accounts` = every frozen-slice account whose `allowedScope` is
 * `public_history`; `explicit` = exactly the listed account ids.
 */
export interface AccountRangeSpec {
  mode: 'researched_accounts' | 'explicit';
  accountIds: string[];
}

/**
 * Inclusive publication-date window (ISO 8601, compared at date granularity).
 * A null bound is unbounded. An unknown publication date never silently
 * becomes out-of-window: such items stay in scope and are flagged.
 */
export interface TimeRangeSpec {
  from: string | null;
  to: string | null;
}

/**
 * Deterministic configured required check (design time/source diversity
 * checks). Satisfaction is exact configured membership — never an
 * uncalibrated score or an arbitrary source-count threshold.
 */
export interface RequiredCheckSpec {
  checkId: string;
  kind: 'time_coverage' | 'source_diversity';
  /** Explicit required entries the observations must cover. */
  required: string[];
}

/** The immutable scope rules frozen before research starts. */
export interface CompletionScopeSpec {
  questions: CompletionQuestion[];
  platformRegistry: PlatformRegistry;
  accountRange: AccountRangeSpec;
  timeRange: TimeRangeSpec;
  /** Selected thread/ancestor depth rule (design default 4). */
  threadDepth: number;
  requiredChecks: RequiredCheckSpec[];
}

/**
 * One immutable frozen scope record. The spec is deep-copied at freeze time,
 * the actual account slice is copied and hashed in the same transaction and
 * `scopeEventId` anchors the case-level scope journal row written by the
 * freeze. Later same-version discovery events append rows but never change
 * this record, so old scope is never reconstructed from current account rows.
 */
export interface FrozenCompletionScope {
  scopeSpecId: string;
  caseId: string;
  scopeVersion: ScopeVersion;
  registryVersion: string;
  registryHash: string;
  specHash: string;
  spec: CompletionScopeSpec;
  accountSlice: ScopeAccountSnapshot[];
  accountSliceHash: string;
  /** Journal row id anchoring this freeze/revision; never re-derived later. */
  scopeEventId: number;
  reason: string;
  createdAt: string;
}

export interface FrozenCompletionScopeView extends FrozenCompletionScope {
  /** Whether this spec is still bound to the case's current scope version. */
  isCurrent: boolean;
}

/* ------------------------------------------------------------------ */
/* Observation receipts (immutable attempt records)                   */
/* ------------------------------------------------------------------ */

/** Recorded run state of one attempt; failed/cancelled/needs_input survive. */
export type AttemptState = 'succeeded' | 'failed' | 'cancelled' | 'needs_input';

export type StopReason =
  | 'endpoint_exhausted'
  | 'cursor_open'
  | 'known_gap'
  | 'budget_exhausted'
  | 'permission_denied'
  | 'unsupported'
  | 'deferred'
  | 'needs_input'
  | 'unavailable_content'
  | 'operator_stop';

export type ObligationRef =
  | { kind: 'platform_discovery'; platformId: string }
  | { kind: 'account_history'; accountId: string }
  | {
      kind: 'item_body' | 'item_media' | 'item_comments';
      accountId: string;
      sourceId: string;
      sourceRevision: number;
    }
  | {
      kind: 'thread_branch';
      accountId: string;
      sourceId: string;
      sourceRevision: number;
      branchKey: string;
    }
  | { kind: 'question'; questionId: string }
  | { kind: 'required_check'; checkId: string }
  | { kind: 'note' };

/**
 * Canonical collision-free obligation key. Free-form caller strings are
 * length-prefixed, so arbitrary legal values cannot collide.
 */
export function obligationKey(ref: ObligationRef): string {
  const part = (value: string) => `${String(value.length)}:${value}`;
  switch (ref.kind) {
    case 'platform_discovery':
      return `platform_discovery:${part(ref.platformId)}`;
    case 'account_history':
      return `account_history:${part(ref.accountId)}`;
    case 'item_body':
    case 'item_media':
    case 'item_comments':
      return `${ref.kind}:${part(ref.accountId)}:${part(ref.sourceId)}:${String(ref.sourceRevision)}`;
    case 'thread_branch':
      return `thread_branch:${part(ref.accountId)}:${part(ref.sourceId)}:${String(ref.sourceRevision)}:${part(ref.branchKey)}`;
    case 'question':
      return `question:${part(ref.questionId)}`;
    case 'required_check':
      return `required_check:${part(ref.checkId)}`;
    case 'note':
      return 'note';
  }
}

/** Validated references a receipt depends on; all ownership is checked on write. */
export interface ObservationRefs {
  accountIds: string[];
  sourceRevisions: Array<{ sourceId: string; sourceRevision: number }>;
  /** Support-role evidence (factual_support / identity_support). */
  evidenceIds: string[];
  /** Counterevidence-role evidence (factual_/identity_counterevidence). */
  counterevidenceIds: string[];
  /** Pinned coverage records: itemId + revision + locator, never rebound. */
  coverageItems: Array<{ itemId: string; revision: number; locator: CoverageLocator }>;
  /** Protocol-conforming investigative actions this receipt depends on. */
  observationIds: string[];
}

export interface CompletionObservationBase {
  observationId: string;
  caseId: string;
  scopeSpecId: string;
  scopeVersion: ScopeVersion;
  obligationRef: ObligationRef;
  attemptState: AttemptState;
  stopReason: StopReason | null;
  /** What the attempt could not access; kept explicit, never smoothed over. */
  accessBoundary: string | null;
  /** What remains unknown after this attempt. */
  remainingUnknown: string | null;
  /** Free text. A note alone can never establish completion. */
  note: string | null;
  /** Explicit synthetic provenance for offline fixtures. */
  synthetic: boolean;
  provenance: RecordProvenance;
  refs: ObservationRefs;
  createdAt: string;
}

/** Discovery outcome per design §5; only a finished check with no match is `checked_no_match`. */
export type DiscoveryResult =
  | 'checked_no_match'
  | 'candidates'
  | 'needs_input'
  | 'inaccessible'
  | 'unsupported'
  | 'deferred';

export interface PlatformDiscoveryObservation extends CompletionObservationBase {
  action: 'discover_platform';
  result: DiscoveryResult;
}

export interface EnumeratedItem {
  sourceId: string;
  sourceRevision: number;
  hasMedia: 'none' | 'present' | 'unknown';
}

/* ------------------------------------------------------------------ */
/* Media metadata merge (frozen conservative rule)                    */
/* ------------------------------------------------------------------ */

/** One recorded media metadata observation for a source@revision. */
export interface MediaMetadataEntry {
  hasMedia: 'none' | 'present' | 'unknown';
  /**
   * Metadata is credible only from a succeeded, non-blocking enumeration
   * receipt with no accessBoundary. An access-limited current enumeration
   * cannot establish exhaustion, even with endpoint_exhausted recorded.
   * Failed or blocked pages can neither resolve unknown→none nor
   * clear an established unknown with a later none.
   */
  credible: boolean;
}

export interface MediaMetadataResolution {
  /** Effective current state used for the media obligation. */
  state: 'none' | 'present' | 'unknown';
  /** Every distinct value recorded, for truthful conflict limitations. */
  recorded: Array<'none' | 'present' | 'unknown'>;
}

/**
 * Frozen conservative merge for accumulated enumeration metadata of one
 * source@revision (hasMedia is not part of the immutable SourceRevision, so
 * later enumeration pages may legitimately disagree):
 * - item identities accumulate across pages and never disappear;
 * - ANY recorded `present` (even from a failed/blocked page) preserves the
 *   media obligation forever — a later `none` never silently erases known
 *   presence, and a real media read may satisfy the obligation while the
 *   contradiction stays visible as a limitation;
 * - with no `present` ever recorded, only credible (succeeded, non-blocking)
 *   metadata resolves unknown→none, and a later credible `unknown` reopens a
 *   prior `none`; failed/blocked `none` never clears an unknown;
 * - with no credible metadata at all the state stays `unknown`.
 */
export function mergeMediaMetadata(entries: MediaMetadataEntry[]): MediaMetadataResolution {
  const recorded: Array<'none' | 'present' | 'unknown'> = [];
  for (const entry of entries) {
    if (!recorded.includes(entry.hasMedia)) recorded.push(entry.hasMedia);
  }
  if (entries.some((entry) => entry.hasMedia === 'present')) {
    return { state: 'present', recorded };
  }
  const credible = entries.filter((entry) => entry.credible);
  const last = credible[credible.length - 1];
  return { state: last === undefined ? 'unknown' : last.hasMedia === 'none' ? 'none' : 'unknown', recorded };
}

export interface HistoryEnumerationObservation extends CompletionObservationBase {
  action: 'enumerate_history';
  result: 'items_found' | 'no_match';
  /** Page of enumerated items (stable source id + revision). */
  items: EnumeratedItem[];
  /** Open cursor means the endpoint-accessible range is not exhausted. */
  nextCursor: string | null;
  knownGaps: string[];
}

export interface ItemReadObservation extends CompletionObservationBase {
  /** `read_comments` is the default first page of top-level comments. */
  action: 'read_body' | 'read_comments' | 'read_media';
  result: 'content_read' | 'comments_read' | 'media_read' | 'unavailable';
}

export interface ThreadReadObservation extends CompletionObservationBase {
  action: 'read_thread';
  result: 'thread_read' | 'unavailable';
  depthReached: number;
  /** Missing/deleted/hidden context stays explicit. */
  blockers: Array<{ commentKey: string; state: 'missing' | 'deleted' | 'hidden' }>;
}

export interface BranchSelectionObservation extends CompletionObservationBase {
  action: 'select_branch';
  result: 'branch_selected';
  parentChain: Array<{ commentKey: string; depth: number; state: 'present' | 'missing' | 'deleted' | 'hidden' }>;
}

export interface QuestionObservation extends CompletionObservationBase {
  action: 'answer_question';
  result: 'supported' | 'conflicting' | 'investigated_unknown';
  /** Support/conflict explanation, or what was investigated for an unknown. */
  explanation: string;
}

export interface RequiredCheckObservation extends CompletionObservationBase {
  action: 'report_required_check';
  result: 'observed';
  /** Configured entries actually observed (set membership, never a score). */
  observed: string[];
  explanation: string;
}

export interface NoteObservation extends CompletionObservationBase {
  action: 'note';
  result: 'note_only';
}

export type CompletionObservation =
  | PlatformDiscoveryObservation
  | HistoryEnumerationObservation
  | ItemReadObservation
  | ThreadReadObservation
  | BranchSelectionObservation
  | QuestionObservation
  | RequiredCheckObservation
  | NoteObservation;

export type ObservationAction = CompletionObservation['action'];

/* ------------------------------------------------------------------ */
/* Investigated-unknown eligibility protocol (frozen)                  */
/* ------------------------------------------------------------------ */

/** Actions that can constitute an actual investigation. `note`,
 * `answer_question` (no circular answers) and `select_branch` (a plan, not an
 * investigation) are never eligible predecessors. */
export const INVESTIGATIVE_ACTIONS: ReadonlySet<ObservationAction> = new Set([
  'discover_platform',
  'enumerate_history',
  'read_body',
  'read_comments',
  'read_media',
  'read_thread',
  'report_required_check'
]);

/** Results that record an actual outcome, as opposed to blocked/unavailable
 * states (`inaccessible`, `unsupported`, `needs_input`, `unavailable`, ...). */
export const INVESTIGATION_OUTCOMES: ReadonlySet<string> = new Set([
  'checked_no_match',
  'candidates',
  'items_found',
  'no_match',
  'content_read',
  'comments_read',
  'media_read',
  'thread_read',
  'observed'
]);

/**
 * Deterministic eligibility half of the frozen protocol: the receipt must be
 * a succeeded investigative action with an outcome-bearing result, without a
 * blocking stop reason and without an access boundary (a bounded attempt is
 * blocked/limited work, not an investigation that resolves an unknown), AND
 * its structured action payload must show the work actually done:
 * - `read_thread`: the frozen `spec.threadDepth` must be reached and no
 *   unresolved blocker may remain — depth alone never replaces missing
 *   context, and omitting `stopReason` never erases recorded unfinished work;
 * - `enumerate_history`: no open `nextCursor` and no `knownGaps` (a null
 *   stopReason cannot bypass recorded gaps);
 * - `report_required_check`: the configured `required` entries of the frozen
 *   check must actually appear in `observed` — the `observed` result label
 *   alone never proves the required work was met.
 * Dependency validity (evidence/coverage/predecessor references must be
 * currently valid and account-boundary preserving) is checked by the
 * evaluator against the persisted snapshot. This validates recorded protocol
 * semantics only — it never asserts provider execution or factual truth.
 */
export function isEligibleInvestigation(
  observation: CompletionObservation,
  spec: CompletionScopeSpec
): boolean {
  if (!INVESTIGATIVE_ACTIONS.has(observation.action)) return false;
  if (observation.attemptState !== 'succeeded') return false;
  if (!INVESTIGATION_OUTCOMES.has(observation.result)) return false;
  if (observation.stopReason !== null && observation.stopReason !== 'endpoint_exhausted') return false;
  if (observation.accessBoundary !== null) return false;
  if (observation.action === 'read_thread') {
    return (
      observation.result === 'thread_read' &&
      observation.depthReached >= (spec.threadDepth > 0 ? spec.threadDepth : DEFAULT_THREAD_DEPTH) &&
      observation.blockers.length === 0
    );
  }
  if (observation.action === 'enumerate_history') {
    return observation.nextCursor === null && observation.knownGaps.length === 0;
  }
  if (observation.action === 'report_required_check') {
    const ref = observation.obligationRef;
    if (ref.kind !== 'required_check') return false;
    const check = spec.requiredChecks.find((entry) => entry.checkId === ref.checkId);
    return (
      observation.result === 'observed' &&
      check !== undefined &&
      check.required.every((entry) => observation.observed.includes(entry))
    );
  }
  return true;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Caller draft: the store assigns ids and binds case/spec/scope. */
export type CompletionObservationDraft = DistributiveOmit<
  CompletionObservation,
  'observationId' | 'caseId' | 'scopeSpecId' | 'scopeVersion' | 'createdAt'
>;

/* ------------------------------------------------------------------ */
/* Assessment input snapshot (pinned persisted state)                 */
/* ------------------------------------------------------------------ */

export interface PinnedCoverageRecord {
  itemId: string;
  revision: number;
  locator: CoverageLocator;
  taskRef: TaskRef;
  scopeVersion: ScopeVersion;
  status: CoverageStatus;
  evidenceIds: string[];
  counterevidenceIds: string[];
}

export interface SourcePin {
  sourceId: string;
  sourceRevision: number;
  accountId: string;
  publishedAt: string | null;
  contentHash: string;
}

export interface EvidenceDigestEntry {
  evidenceId: string;
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  role: EvidenceRole;
  quoteHash: string;
  revokedAt: string | null;
}

/** Identity-support state and dependencies; `personRevision` alone is never used. */
export interface IdentityDigestEntry {
  accountId: string;
  state: IdentitySupportState;
  evidenceIds: string[];
  counterevidenceIds: string[];
  policyVersion: string;
}

/**
 * One consistent persisted input snapshot. The assessment stores this
 * selected input verbatim so historical replay never depends on current rows.
 */
export interface CompletionSnapshot {
  policyVersion: string;
  scopeSpecId: string;
  scopeVersion: ScopeVersion;
  spec: CompletionScopeSpec;
  accountSlice: ScopeAccountSnapshot[];
  observations: CompletionObservation[];
  coverage: PinnedCoverageRecord[];
  sources: SourcePin[];
  evidence: EvidenceDigestEntry[];
  identity: IdentityDigestEntry[];
}

export interface CompletionAssessmentInput extends CompletionSnapshot {
  specHash: string;
  registryHash: string;
  accountSliceHash: string;
  /**
   * Deterministic digest of sorted persisted source/evidence/identity state:
   * source revision + contentHash, evidence role/ownership/quoteHash/revokedAt
   * and identity-support state/dependencies. Insertion or an identity patch
   * changes it even when `personRevision` does not move.
   */
  evidenceRevision: string;
  observationDigest: string;
  coverageDigest: string;
  /** Binds the whole selected input (coverage and observations included). */
  inputHash: string;
}

/* ------------------------------------------------------------------ */
/* Evaluation result                                                  */
/* ------------------------------------------------------------------ */

export type CompletionDimension =
  | 'platform_discovery'
  | 'history_enumeration'
  | 'body'
  | 'media'
  | 'comments'
  | 'thread'
  | 'questions'
  | 'required_checks';

export type UnresolvedReason =
  | 'unattempted'
  | 'needs_input'
  | 'budget_exhausted'
  | 'permission_denied'
  | 'unsupported'
  | 'deferred'
  | 'cursor_open'
  | 'known_gap'
  | 'not_exhausted'
  | 'dependency_withdrawn'
  | 'failed'
  | 'cancelled'
  | 'unavailable_content'
  | 'depth_not_reached'
  | 'media_applicability_unknown'
  | 'check_entries_missing'
  | 'no_conforming_investigation';

export interface UnresolvedObligation {
  obligationKey: string;
  dimension: CompletionDimension;
  reason: UnresolvedReason;
  detail: string | null;
}

/** An obligation addressed by a protocol-conforming investigated unknown. */
export interface HandledUnknown {
  obligationKey: string;
  dimension: CompletionDimension;
  explanation: string;
}

/** Original attempt state preserved; the completion algorithm never erases it. */
export interface PreservedAttempt {
  observationId: string;
  action: ObservationAction;
  attemptState: AttemptState;
  stopReason: StopReason | null;
  remainingUnknown: string | null;
  note: string | null;
}

export type CompletionDimensionState = 'complete' | 'partial' | 'unknown_denominator' | 'not_applicable';

export interface CompletionDimensionReport {
  dimension: CompletionDimension;
  state: CompletionDimensionState;
  /** Obligation count; null when the denominator is unknown. */
  total: number | null;
  addressed: number;
  /** Subset of `addressed` established by investigated unknowns. */
  investigatedUnknown: number;
  notApplicable: number;
  unresolved: number;
  denominatorKnown: boolean;
  /** Null for zero or unknown denominators — never a fake percentage. */
  percent: number | null;
  unresolvedItems: UnresolvedObligation[];
  notApplicableReasons: string[];
  limitations: string[];
}

export type CompletionVerdict = 'complete' | 'partial' | 'incomplete';

export interface CompletionEvaluation {
  verdict: CompletionVerdict;
  /** One report per dimension; dimensions are never merged into one percentage. */
  dimensions: CompletionDimensionReport[];
  handledUnknowns: HandledUnknown[];
  preservedAttempts: PreservedAttempt[];
  /** Honest limits of what this verdict can claim. */
  claimBoundaries: string[];
}

export interface CompletionAssessment {
  assessmentId: string;
  caseId: string;
  scopeSpecId: string;
  scopeVersion: ScopeVersion;
  policyVersion: string;
  evidenceRevision: string;
  inputHash: string;
  /** The exact selected persisted input, kept verbatim and immutable. */
  input: CompletionAssessmentInput;
  /** The original deterministic verdict; never rewritten in place. */
  evaluation: CompletionEvaluation;
  createdAt: string;
}

/** Historical verdict plus separately derived current validity. */
export interface CompletionAssessmentView extends CompletionAssessment {
  currentValidity: Validity;
  staleReasons: string[];
}
