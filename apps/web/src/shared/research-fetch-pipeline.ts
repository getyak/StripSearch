/**
 * GET-99 local Fetch pipeline contract (shared, pure): the durable
 * scheduling shapes and deterministic policy helpers for the local Fetch
 * controller (server/research/fetch-pipeline.ts) and its synthetic harness.
 *
 * Boundary (see docs/fetch-pipeline.md): this is a LOCAL synthetic chain over
 * injected gateways only. It composes the existing authoritative stores —
 * GET-58 case/scope, GET-60 frozen completion, GET-59 tool dispatch and the
 * GET-95 fetch coverage receipts — instead of inventing a second case,
 * completion or coverage model. The pipeline never publishes: findings stay
 * pending, no claim or report is written, and the only completion authority is
 * the deterministic GET-60 assessment. Batch quanta (`maxStepsPerBatch`) and
 * scheduling round limits are resumable scheduling bounds, never total corpus,
 * history, request or time caps.
 *
 * Resumability: every planned action carries a collision-free canonical step
 * identity built from the FULL exact tool + input (plus the pinned source
 * revision identity wherever the GET-59 input omits it). The durable
 * checkpoint records done/refused step identities, validated evidence
 * read-back and each account's exact listing cursor, so a close/reopen resumes
 * at the precise account cursor and item step and never replays a known
 * successful action. Every dispatch is preceded by a durable intent record;
 * an unresolved intent stops the run as unreconciled and is never
 * auto-replayed until explicit authoritative reconciliation.
 *
 * Untrusted content: tool outputs and source prose are data, never
 * instructions or authority. Source binding requires adapter-produced exact
 * source pins (sourceId + sourceRevision + canonical full-text hash); a
 * metadata-only hash is never a body pin and a changed hash/revision is
 * refused, never silently accepted.
 *
 * Chunked stage/verify plans (server/research/fetch-pipeline-plan.ts): the
 * GET-59 per-call/per-finding bounds (50 findings per save_findings call,
 * 100 support + 100 counter + 100 coverage identities per finding, 100
 * evidence refs per read_evidence call) are respected by DETERMINISTIC
 * chunking that preserves every dependency and coverage identity exactly
 * once — never silent slice losses and never cumulative caps (a chunk size
 * is a per-call bound only).
 *
 * Immutable phase manifests: every stage / read_evidence /
 * verification-save call plan is FROZEN durably in the checkpoint (with an
 * explicit planner version) before its first dispatch and never re-packed
 * from successful subsets. A partially submitted or refused call keeps its
 * exact step key: rejected material is never turned into a fresh key and
 * auto-retried; it stays explicitly incomplete (`stage_incomplete`). The
 * read manifest is fixed only once ALL stage material is actually staged;
 * the verification-save manifest only once the read manifest has settled and
 * is built from actually validated fresh pinned read-backs (partial subsets
 * allowed with honest gaps). Legacy checkpoints without manifests that
 * already attempted stage/verify fail closed (`upgrade_required`) — never
 * re-planned, never replayed; a finished run restores read-only (zero
 * dispatches, events, checkpoint writes or new assessments).
 *
 * Read-back pinning: a read-back is approved only against the exact returned
 * identity + sourceRevision + role + quote + quoteHash (real SHA256) +
 * applicable metadata revision and fresh authoritative case evidence/source
 * binding (existing, owner/case/account bound, unrevoked). The cache records
 * the immutable pin, not just the id, and every later use (verification
 * planning, submission, final outcome) re-checks current validity: a cached
 * id alone never proves verification. Staged dependencies without a
 * currently valid verification finding stay `verify_readback_incomplete`.
 *
 * Stage progress and the verify phase are gated on ALL stage material being
 * actually submitted. Failed/refused/unavailable read-backs stay honest
 * partial: the run is never marked finished and no semantic facts or quality
 * claims are created.
 */

/* ------------------------------------------------------------------ */
/* Run lifecycle                                                      */
/* ------------------------------------------------------------------ */

export type FetchPipelineRunState = 'running' | 'finished' | 'stopped';

export type FetchPipelineStopReason =
  /** All planned processing work folded and assessed. Not a GET-60 verdict. */
  | 'obligations_processed'
  /** Scheduling stop: consecutive rounds made no progress. Not completion. */
  | 'no_progress'
  /** Scheduling bound: the run stays resumable with obligations still open. */
  | 'batch_quantum_exhausted'
  /** A gateway settlement was unknown/unreconciled; nothing is auto-replayed. */
  | 'unreconciled_action'
  /** Owner/case/scope changed or the case was cancelled mid-run. */
  | 'scope_changed'
  | 'cancelled'
  /** The dispatch gateway refused the batch boundary. */
  | 'blocked'
  | 'batch_failed'
  /**
   * The frozen stage manifest still misses planned references or coverage
   * identities in the actual durable collected findings (refused, partially
   * submitted or lost material). Explicitly incomplete: no verify phase, no
   * success progress, never `finished`.
   */
  | 'stage_incomplete'
  /**
   * Verify read-back did not pin every staged dependency (failed, refused or
   * unavailable read-backs, revoked or invalid evidence, or missing currently
   * valid verification findings). Honest partial: the run is NOT marked
   * finished and no semantic fact/quality claim is created.
   */
  | 'verify_readback_incomplete'
  /**
   * Legacy checkpoint without immutable phase manifests (or an incompatible
   * planner pin) that already attempted stage/verify: fail closed with an
   * explicit upgrade/new-run gap; historical material is never re-planned or
   * retried.
   */
  | 'upgrade_required';

/* ------------------------------------------------------------------ */
/* Step identities (collision-free canonical serialization)           */
/* ------------------------------------------------------------------ */

/**
 * One planned tool action. `key` is the stable resume identity; `tool` and
 * `input` are exactly what the model may dispatch through the GET-59 gateway.
 */
export interface FetchPipelinePlanStep {
  key: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Canonical JSON with recursively sorted object keys and preserved array
 * order. Distinct values never share a serialization: strings are escaped, so
 * delimiters inside native ids cannot collide (`a:b`+`c` vs `a`+`b:c`).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(',')}}`;
}

/**
 * Deterministic, collision-free step identity for one exact tool call: the
 * canonical serialization of the FULL tool + input, plus the pinned source
 * revision identity wherever the GET-59 input omits it (read_post /
 * list_comments / read_media / read_thread carry no sourceRevision). The key
 * never parses back into meaning — counts must come from durable state, not
 * from key prefixes.
 */
export function fetchPlanStepKey(
  tool: string,
  input: Record<string, unknown>,
  identity?: { sourceId: string; sourceRevision: number } | null
): string {
  return `${tool}|${canonicalJson({ tool, input, identity: identity ?? null })}`;
}

/** Identity-free local controller step (explicit unknown/unread media state). */
export function fetchLocalStepKey(action: string, params: Record<string, unknown>): string {
  return `local:${action}|${canonicalJson({ action, params })}`;
}

/* ------------------------------------------------------------------ */
/* Branch selection policy (explicit, never implicit)                 */
/* ------------------------------------------------------------------ */

/** Adapter-reported signals for one candidate thread branch. */
export interface FetchBranchCandidate {
  branchKey: string;
  /** Substantial reply activity on this branch (adapter-reported). */
  important: boolean;
  /** The subject author replies inside this branch. */
  subjectAuthor: boolean;
  /** Counterevidence-shaped content in this branch (adapter-reported). */
  contradictory: boolean;
  /** Ancestor chain gaps (missing/deleted/hidden) preserved verbatim. */
  ancestorGaps: string[];
}

/**
 * Explicit selection of important / subject-author / contradictory branches.
 * Every selected branch keeps its ancestor gaps; unselected branches stay
 * visible as explicit gaps rather than being silently dropped.
 */
export function selectFetchBranches(candidates: readonly FetchBranchCandidate[]): FetchBranchCandidate[] {
  return candidates
    .filter((candidate) => candidate.important || candidate.subjectAuthor || candidate.contradictory)
    .slice()
    .sort((a, b) => (a.branchKey < b.branchKey ? -1 : a.branchKey > b.branchKey ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Immutable phase manifests and read-back pins                       */
/* ------------------------------------------------------------------ */

/** One frozen planned call: the exact tool + input + step identity. */
export interface FetchPipelinePhaseCall {
  key: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Durable IMMUTABLE call manifest for one phase (stage / read_evidence /
 * verification-save), frozen before its first dispatch and never re-packed
 * from successful subsets. `planner` pins the planner version explicitly.
 */
export interface FetchPipelinePhaseManifest {
  planner: string;
  calls: FetchPipelinePhaseCall[];
}

/**
 * Immutable approval record for one successfully pinned read-back: the full
 * identity/source binding (never just the evidence id) so every later use can
 * re-check current validity against the authoritative case state.
 */
export interface FetchPipelineReadBackPin {
  evidenceId: string;
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  role: string;
  quoteHash: string;
}

/* ------------------------------------------------------------------ */
/* Durable checkpoint                                                 */
/* ------------------------------------------------------------------ */

export interface FetchPipelineAccountCheckpoint {
  accountId: string;
  /** Pages folded so far; the next page uses `cursorToken`. */
  pagesDone: number;
  cursorToken: string | null;
  /** Provider-native cursors already issued (cycle detection, never a cap). */
  seenNativeCursors: string[];
  /** Accumulated listing gaps: any gap keeps the denominator unknown. */
  gaps: string[];
  enumeration: 'open' | 'exhausted' | 'gap' | 'failed';
}

/** Durable, JSON-serialisable resume state; append events hold the history. */
export interface FetchPipelineCheckpoint {
  runId: string;
  scopeVersion: number;
  /** Identity of the adapter catalog the run was opened against. */
  catalogDigest: string;
  accounts: FetchPipelineAccountCheckpoint[];
  /** Step identities already folded (success or explicit refusal) — never replayed. */
  doneSteps: string[];
  /** Step identities explicitly refused (failed/blocked) — never auto-retried. */
  refusedSteps: string[];
  /** Structured gaps preserved from listing validation and gateway receipts. */
  gaps: { code: string; detail: string }[];
  /** Evidence ids validated by successful read_evidence read-back (verify gate). */
  evidenceReadBack: string[];
  /** Immutable pin records behind `evidenceReadBack` (never id-only). */
  readBackPins?: FetchPipelineReadBackPin[];
  /** Frozen stage `save_findings` call manifest (null = legacy/not yet frozen). */
  stageManifest?: FetchPipelinePhaseManifest | null;
  /** Frozen read-back `read_evidence` call manifest. */
  readManifest?: FetchPipelinePhaseManifest | null;
  /** Frozen verification `save_findings` call manifest. */
  verificationSaveManifest?: FetchPipelinePhaseManifest | null;
  stagedFindings: string[];
  verificationFindings: string[];
  progressReports: number;
}

/* ------------------------------------------------------------------ */
/* Structured run summary                                             */
/* ------------------------------------------------------------------ */

export interface FetchPipelineAccountSummary {
  accountId: string;
  platform: string;
  pages: number;
  enumeratedItems: number;
  bodiesRead: number;
  commentsRead: number;
  mediaReads: number;
  /** Explicit unknown/unread media states recorded (never counted as read). */
  mediaUnknownUnread: number;
  branchesSelected: number;
  branchesRead: number;
}

export interface FetchPipelineCounts {
  toolActions: number;
  modelCalls: number;
  batches: number;
  providerRequests: number;
  listedItems: number;
  bodiesRead: number;
  commentsRead: number;
  mediaReads: number;
  mediaUnknownUnread: number;
  branchesSelected: number;
  branchesRead: number;
  findingsStaged: number;
  verificationsStaged: number;
  /** Token/fee values stay null when the gateway never reported them. */
  estimatedUsd: number | null;
  credits: number | null;
  unknownFeeRequests: number;
  /** Model gateway usage is its own accounting; unknown stays null. */
  modelInputTokens: number | null;
  modelOutputTokens: number | null;
  modelEstimatedUsd: number | null;
}

export interface FetchPipelinePendingFindingSummary {
  pendingRef: string;
  kind: 'collected_finding' | 'verification_check';
  accountIds: string[];
  dependencyEvidenceIds: string[];
}

export interface FetchPipelineDimensionSummary {
  dimension: string;
  state: string;
  total: number | null;
  addressed: number;
  unresolved: number;
  percent: number | null;
}

export interface FetchPipelineAssessmentSummary {
  verdict: string;
  dimensions: FetchPipelineDimensionSummary[];
}

/**
 * Concise structured summary with real counts reconstructed from durable
 * events, receipts and findings. It carries the GET-60 assessment status and
 * remaining gaps — it never claims research completion on its own and never
 * contains a provider "verified" claim.
 */
export interface FetchPipelineSummary {
  runId: string;
  state: FetchPipelineRunState;
  stopReason: FetchPipelineStopReason;
  scopeSpecId: string;
  frozenScopeStale: boolean;
  /** Planned steps still open (resumable scheduling, not a corpus cap). */
  openSteps: number;
  accounts: FetchPipelineAccountSummary[];
  counts: FetchPipelineCounts;
  pendingFindings: FetchPipelinePendingFindingSummary[];
  assessment: FetchPipelineAssessmentSummary | null;
  /**
   * Current validity of the reported assessment. Finished-run restore reuses
   * the stored assessment read-only and reports its honest current validity;
   * a fresh in-run assessment is `valid`.
   */
  assessmentCurrentValidity?: 'valid' | 'review' | null;
  assessmentStaleReasons?: string[];
  remainingGaps: string[];
  /** The synthetic pass verifies no provider profile; kept explicit. */
  providerProfilesVerified: 0;
}
