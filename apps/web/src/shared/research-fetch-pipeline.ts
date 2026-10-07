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
  | 'batch_failed';

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
  remainingGaps: string[];
  /** The synthetic pass verifies no provider profile; kept explicit. */
  providerProfilesVerified: 0;
}
