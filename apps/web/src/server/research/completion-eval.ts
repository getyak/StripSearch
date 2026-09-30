/**
 * GET-60 deterministic completion evaluation (pure functions).
 *
 * `evaluateCompletion` reads exactly one persisted input snapshot (frozen
 * scope spec + account slice + immutable observations + pinned coverage and
 * source/evidence/identity state) and returns the verdict without any I/O.
 * The same snapshot always yields the same evaluation and digests, so an
 * assessment can be replayed from its stored input after a close/reopen and
 * historical replay never depends on current rows.
 *
 * Ordered supersession (frozen contract, see shared/research-completion.ts):
 * the CURRENT state of each obligation is established by the latest receipt
 * of its action family. Earlier receipts stay history and keep their
 * limitations visible; a later blocker supersedes an earlier success and is
 * never hidden by it, and a later valid success releases earlier gaps.
 * Enumerated items accumulate across all enumeration receipts.
 *
 * Establishment additionally requires currently valid dependencies: revoked
 * or missing evidence, role/ownership mismatches, broken coverage pins and
 * ineligible predecessor observations all break completion while remaining
 * readable history. Investigated unknowns follow the frozen
 * `isEligibleInvestigation` protocol plus valid concrete dependencies.
 *
 * The caller can never supply final counters, percentages or a conveniently
 * reduced registry: every number here is derived from the frozen rules and
 * the immutable receipts. Free-text notes and "completed" flags are not
 * inputs. Dimensions stay separate and a zero or unknown denominator never
 * renders a percentage (never 100%).
 */

import { createHash } from 'node:crypto';

import {
  DEFAULT_THREAD_DEPTH,
  isEligibleInvestigation,
  mergeMediaMetadata,
  obligationKey
} from '../../shared/research-completion.js';
import type {
  BranchSelectionObservation,
  CompletionAssessmentInput,
  CompletionDimension,
  CompletionDimensionReport,
  CompletionEvaluation,
  CompletionObservation,
  CompletionScopeSpec,
  CompletionSnapshot,
  CompletionVerdict,
  EnumeratedItem,
  EvidenceDigestEntry,
  HandledUnknown,
  MediaMetadataEntry,
  PinnedCoverageRecord,
  PreservedAttempt,
  QuestionObservation,
  RequiredCheckObservation,
  UnresolvedObligation,
  UnresolvedReason
} from '../../shared/research-completion.js';
import type { EvidenceRole } from '../../shared/research-case.js';

/* ------------------------------------------------------------------ */
/* Deterministic serialization and digests                            */
/* ------------------------------------------------------------------ */

/** JSON with recursively sorted object keys; arrays keep their order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = sortValue(source[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Length-prefixed tuple parts so arbitrary legal strings cannot collide. */
function part(value: string): string {
  return `${String(value.length)}:${value}`;
}

/**
 * Compose the persisted assessment input with deterministic digests.
 * `evidenceRevision` covers sorted persisted source/evidence/identity state
 * (never `personRevision`); `inputHash` binds the whole selected input.
 */
export function buildAssessmentInput(snapshot: CompletionSnapshot): CompletionAssessmentInput {
  const sources = [...snapshot.sources].sort(
    (a, b) => compareIds(a.sourceId, b.sourceId) || a.sourceRevision - b.sourceRevision || compareIds(a.accountId, b.accountId)
  );
  const evidence = [...snapshot.evidence].sort((a, b) => compareIds(a.evidenceId, b.evidenceId));
  const identity = [...snapshot.identity].sort((a, b) => compareIds(a.accountId, b.accountId));
  const coverage = [...snapshot.coverage].sort(
    (a, b) => compareIds(a.itemId, b.itemId) || a.revision - b.revision
  );
  const specHash = sha256Hex(stableStringify(snapshot.spec));
  const registryHash = sha256Hex(stableStringify(snapshot.spec.platformRegistry));
  const accountSliceHash = sha256Hex(stableStringify(snapshot.accountSlice));
  const evidenceRevision = sha256Hex(stableStringify({ sources, evidence, identity }));
  const observationDigest = sha256Hex(stableStringify(snapshot.observations));
  const coverageDigest = sha256Hex(stableStringify(coverage));
  const base = {
    policyVersion: snapshot.policyVersion,
    scopeSpecId: snapshot.scopeSpecId,
    scopeVersion: snapshot.scopeVersion,
    spec: snapshot.spec,
    accountSlice: snapshot.accountSlice,
    observations: snapshot.observations,
    coverage,
    sources,
    evidence,
    identity,
    specHash,
    registryHash,
    accountSliceHash,
    evidenceRevision,
    observationDigest,
    coverageDigest
  };
  return { ...base, inputHash: sha256Hex(stableStringify(base)) };
}

/** Compare a stored input against the current one; mismatch = stale reason. */
export function staleReasonsAgainst(
  stored: CompletionAssessmentInput,
  current: CompletionAssessmentInput
): string[] {
  const reasons: string[] = [];
  if (stored.scopeVersion !== current.scopeVersion) reasons.push('scope_advanced');
  if (stored.specHash !== current.specHash) reasons.push('scope_spec_changed');
  if (stored.accountSliceHash !== current.accountSliceHash) reasons.push('account_slice_changed');
  if (stored.observationDigest !== current.observationDigest) reasons.push('observations_changed');
  if (stored.coverageDigest !== current.coverageDigest) reasons.push('coverage_changed');
  if (stored.evidenceRevision !== current.evidenceRevision) reasons.push('evidence_changed');
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Current dependency validity                                        */
/* ------------------------------------------------------------------ */

const SUPPORT_ROLES: ReadonlySet<EvidenceRole> = new Set<EvidenceRole>(['factual_support', 'identity_support']);
const COUNTER_ROLES: ReadonlySet<EvidenceRole> = new Set<EvidenceRole>([
  'factual_counterevidence',
  'identity_counterevidence'
]);

interface SnapshotIndex {
  evidenceById: Map<string, EvidenceDigestEntry>;
  /** Length-prefixed sourceId + revision -> owning account. */
  sourceAccount: Map<string, string>;
  /** itemId + revision -> the pinned immutable coverage record. */
  coverageByKey: Map<string, PinnedCoverageRecord>;
  observationById: Map<string, CompletionObservation>;
}

function buildIndex(snapshot: CompletionSnapshot): SnapshotIndex {
  return {
    evidenceById: new Map(snapshot.evidence.map((entry) => [entry.evidenceId, entry])),
    sourceAccount: new Map(
      snapshot.sources.map((entry) => [`${part(entry.sourceId)}:${String(entry.sourceRevision)}`, entry.accountId])
    ),
    coverageByKey: new Map(snapshot.coverage.map((entry) => [`${part(entry.itemId)}:${String(entry.revision)}`, entry])),
    observationById: new Map(snapshot.observations.map((entry) => [entry.observationId, entry]))
  };
}

function evidenceUsable(entry: EvidenceDigestEntry | undefined, supportPolarity: boolean, owner: string | null): boolean {
  if (!entry || entry.revokedAt !== null) return false;
  if (supportPolarity ? !SUPPORT_ROLES.has(entry.role) : !COUNTER_ROLES.has(entry.role)) return false;
  return owner === null || entry.accountId === owner;
}

/**
 * Whether every reference a receipt depends on is still valid in the current
 * snapshot: non-revoked polarity-matching evidence, persisted owned source
 * revisions, exact coverage pins whose own evidence dependencies survive and
 * dependency-valid predecessor observations.
 *
 * `expectedAccount` is the INHERITED account boundary of the root receipt: it
 * constrains the whole transitive chain, including intermediate case-level
 * nodes (which must not erase it) and nested account-scoped nodes (which must
 * match it). A case-level root passes `null` and may legitimately span
 * accounts. Memoization is keyed by (observationId, expectedAccount) so a
 * permissive case-level pass never satisfies a restricted one.
 */
function dependencyValid(
  observation: CompletionObservation,
  index: SnapshotIndex,
  memo: Map<string, boolean>,
  visiting: Set<string>,
  expectedAccount: string | null
): boolean {
  const cacheKey = `${observation.observationId}~${expectedAccount ?? ''}`;
  const cached = memo.get(cacheKey);
  if (cached !== undefined) return cached;
  if (visiting.has(cacheKey)) return true;
  visiting.add(cacheKey);
  const nodeAccount = 'accountId' in observation.obligationRef ? observation.obligationRef.accountId : null;
  let ok = true;
  // Nested account-scoped nodes must match the inherited account directly.
  if (expectedAccount !== null && nodeAccount !== null && expectedAccount !== nodeAccount) ok = false;
  const effective = expectedAccount ?? nodeAccount;
  for (const evidenceId of observation.refs.evidenceIds) {
    if (!evidenceUsable(index.evidenceById.get(evidenceId), true, effective)) ok = false;
  }
  for (const evidenceId of observation.refs.counterevidenceIds) {
    if (!evidenceUsable(index.evidenceById.get(evidenceId), false, effective)) ok = false;
  }
  for (const source of observation.refs.sourceRevisions) {
    const account = index.sourceAccount.get(`${part(source.sourceId)}:${String(source.sourceRevision)}`);
    if (account === undefined || (effective !== null && account !== effective)) ok = false;
  }
  for (const pin of observation.refs.coverageItems) {
    const record = index.coverageByKey.get(`${part(pin.itemId)}:${String(pin.revision)}`);
    if (
      !record ||
      record.locator.accountId !== pin.locator.accountId ||
      record.locator.sourceId !== pin.locator.sourceId ||
      record.locator.sourceRevision !== pin.locator.sourceRevision
    ) {
      ok = false;
      continue;
    }
    if (effective !== null && record.locator.accountId !== effective) ok = false;
    for (const evidenceId of record.evidenceIds) {
      if (!evidenceUsable(index.evidenceById.get(evidenceId), true, record.locator.accountId)) ok = false;
    }
    for (const evidenceId of record.counterevidenceIds) {
      if (!evidenceUsable(index.evidenceById.get(evidenceId), false, record.locator.accountId)) ok = false;
    }
  }
  for (const observationId of observation.refs.observationIds) {
    const dep = index.observationById.get(observationId);
    if (!dep || !dependencyValid(dep, index, memo, visiting, effective)) ok = false;
  }
  visiting.delete(cacheKey);
  memo.set(cacheKey, ok);
  return ok;
}

/**
 * Frozen investigated-unknown predecessor chain: every referenced action must
 * itself be an eligible investigation (structured payload included) with
 * valid account-boundary-preserving dependencies. A succeeded transport
 * receipt whose actual outcome is unsupported/permission/budget, a blocked
 * thread, an open enumeration or a partial required check is not sufficient
 * investigation.
 */
function investigationChainOk(
  observation: CompletionObservation,
  spec: CompletionScopeSpec,
  index: SnapshotIndex,
  memo: Map<string, boolean>,
  expectedAccount: string | null,
  seen: Set<string>
): boolean {
  const seenKey = `${observation.observationId}~${expectedAccount ?? ''}`;
  if (seen.has(seenKey)) return true;
  seen.add(seenKey);
  if (!isEligibleInvestigation(observation, spec)) return false;
  if (!dependencyValid(observation, index, memo, new Set(), expectedAccount)) return false;
  for (const observationId of observation.refs.observationIds) {
    const dep = index.observationById.get(observationId);
    if (!dep || !investigationChainOk(dep, spec, index, memo, expectedAccount, seen)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                         */
/* ------------------------------------------------------------------ */

interface Resolved {
  addressed: number;
  investigatedUnknown: number;
  unresolved: UnresolvedObligation[];
}

interface Resolution {
  established: boolean;
  reason: UnresolvedReason | null;
  investigatedUnknown: boolean;
}

function blockingStopReason(obs: CompletionObservation): UnresolvedReason | null {
  if (obs.stopReason === null || obs.stopReason === 'endpoint_exhausted') return null;
  switch (obs.stopReason) {
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'permission_denied':
      return 'permission_denied';
    case 'unsupported':
      return 'unsupported';
    case 'deferred':
    case 'operator_stop':
      return 'deferred';
    case 'needs_input':
      return 'needs_input';
    case 'cursor_open':
      return 'cursor_open';
    case 'known_gap':
      return 'known_gap';
    case 'unavailable_content':
      return 'unavailable_content';
    default:
      return null;
  }
}

function attemptStateReason(obs: CompletionObservation): UnresolvedReason | null {
  if (obs.attemptState === 'failed') return 'failed';
  if (obs.attemptState === 'cancelled') return 'cancelled';
  if (obs.attemptState === 'needs_input') return 'needs_input';
  return null;
}

function day(value: string): string {
  return value.slice(0, 10);
}

function inTimeWindow(publishedAt: string | null, spec: CompletionScopeSpec): boolean {
  // Unknown publication dates stay in scope; they never silently fall out.
  if (publishedAt === null) return true;
  const { from, to } = spec.timeRange;
  if (from !== null && day(publishedAt) < day(from)) return false;
  if (to !== null && day(publishedAt) > day(to)) return false;
  return true;
}

interface ItemObligation {
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  publishedAt: string | null;
  hasMedia: EnumeratedItem['hasMedia'];
  dateUnknown: boolean;
}

function questionConforms(
  obs: QuestionObservation,
  spec: CompletionScopeSpec,
  index: SnapshotIndex,
  memo: Map<string, boolean>
): { ok: boolean; investigatedUnknown: boolean } {
  const explained = obs.explanation.trim().length > 0;
  const refs = obs.refs;
  const expectedAccount = 'accountId' in obs.obligationRef ? obs.obligationRef.accountId : null;
  if (obs.result === 'supported') {
    return { ok: explained && refs.evidenceIds.length > 0, investigatedUnknown: false };
  }
  if (obs.result === 'conflicting') {
    return {
      ok: explained && refs.evidenceIds.length > 0 && refs.counterevidenceIds.length > 0,
      investigatedUnknown: false
    };
  }
  // Investigated unknown: protocol-conforming investigative actions AND
  // concrete currently valid dependencies. A free-text note, a bare claim, a
  // blocked/unsupported transport receipt or a payload-blocked action (short
  // thread depth, unresolved blockers, open cursor, known gaps, incomplete
  // required check) is not sufficient investigation.
  const dependencies =
    refs.evidenceIds.length + refs.counterevidenceIds.length + refs.coverageItems.length + refs.sourceRevisions.length > 0;
  const actionsConform =
    refs.observationIds.length > 0 &&
    refs.observationIds.every((id) => {
      const dep = index.observationById.get(id);
      return dep !== undefined && investigationChainOk(dep, spec, index, memo, expectedAccount, new Set());
    });
  return { ok: explained && dependencies && actionsConform, investigatedUnknown: true };
}

/**
 * The deterministic pure completion evaluation. Given the same persisted
 * snapshot it always returns the same verdict, dimension reports, digests
 * (via `buildAssessmentInput`) and preserved attempt states.
 */
export function evaluateCompletion(snapshot: CompletionSnapshot): CompletionEvaluation {
  const spec = snapshot.spec;
  const observations = snapshot.observations;
  const index = buildIndex(snapshot);
  const dependencyMemo = new Map<string, boolean>();
  const depValid = (obs: CompletionObservation): boolean =>
    dependencyValid(obs, index, dependencyMemo, new Set(), 'accountId' in obs.obligationRef ? obs.obligationRef.accountId : null);

  const byKey = new Map<string, CompletionObservation[]>();
  for (const obs of observations) {
    const key = obligationKey(obs.obligationRef);
    const list = byKey.get(key);
    if (list) list.push(obs);
    else byKey.set(key, [obs]);
  }
  /** Latest receipt of one action family for one obligation (supersession). */
  const latestOf = (key: string, action: CompletionObservation['action']): CompletionObservation | undefined => {
    const attempts = (byKey.get(key) ?? []).filter((obs) => obs.action === action);
    return attempts[attempts.length - 1];
  };

  const handledUnknowns: HandledUnknown[] = [];
  const claimBoundaries: string[] = [];
  const limitationsByDimension = new Map<CompletionDimension, string[]>();
  const notApplicableByDimension = new Map<CompletionDimension, string[]>();
  const addNote = (map: Map<CompletionDimension, string[]>, dimension: CompletionDimension, line: string) => {
    const list = map.get(dimension);
    if (list) list.push(line);
    else map.set(dimension, [line]);
  };
  const preservedAttempts: PreservedAttempt[] = observations
    .filter((obs) => obs.attemptState !== 'succeeded')
    .map((obs) => ({
      observationId: obs.observationId,
      action: obs.action,
      attemptState: obs.attemptState,
      stopReason: obs.stopReason,
      remainingUnknown: obs.remainingUnknown,
      note: obs.note
    }));

  const explicitRange = spec.accountRange.mode === 'explicit';
  const inScope = new Set(
    snapshot.accountSlice
      .filter((entry) =>
        explicitRange
          ? spec.accountRange.accountIds.includes(entry.accountId)
          : entry.allowedScope.state === 'public_history'
      )
      .map((entry) => entry.accountId)
  );

  /* ---------------- platform discovery ---------------- */
  const discovery: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  const registryEntries = [...spec.platformRegistry.entries].sort((a, b) =>
    compareIds(a.platformId, b.platformId)
  );
  for (const entry of registryEntries) {
    const key = obligationKey({ kind: 'platform_discovery', platformId: entry.platformId });
    if (entry.applicability === 'not_applicable') {
      addNote(
        notApplicableByDimension,
        'platform_discovery',
        `${entry.platformId}: ${entry.applicabilityReason}`
      );
      continue;
    }
    const current = latestOf(key, 'discover_platform');
    let established = false;
    let reason: UnresolvedReason = 'unattempted';
    if (current) {
      if (attemptStateReason(current)) reason = attemptStateReason(current) as UnresolvedReason;
      else if (!depValid(current)) reason = 'dependency_withdrawn';
      else if (blockingStopReason(current)) reason = blockingStopReason(current) as UnresolvedReason;
      else if (current.result === 'checked_no_match' || current.result === 'candidates') established = true;
      else if (current.result === 'needs_input') reason = 'needs_input';
      else if (current.result === 'inaccessible') reason = 'permission_denied';
      else if (current.result === 'unsupported') reason = 'unsupported';
      else if (current.result === 'deferred') reason = 'deferred';
    }
    if (established) discovery.addressed += 1;
    else discovery.unresolved.push({ obligationKey: key, dimension: 'platform_discovery', reason, detail: entry.platformId });
  }

  /* ---------------- history enumeration ---------------- */
  const history: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  const sliceAccounts = [...snapshot.accountSlice].sort((a, b) => compareIds(a.accountId, b.accountId));
  const enumerationDone = new Set<string>();
  for (const account of sliceAccounts) {
    if (!inScope.has(account.accountId)) {
      const reason =
        explicitRange && !spec.accountRange.accountIds.includes(account.accountId)
          ? 'not_in_account_range'
          : account.allowedScope.state === 'profile_only'
            ? 'profile_only'
            : 'allowed_scope_none';
      addNote(notApplicableByDimension, 'history_enumeration', `${account.accountId}: ${reason}`);
      continue;
    }
    const key = obligationKey({ kind: 'account_history', accountId: account.accountId });
    // Current enumeration state = the latest receipt (supersession). An open
    // cursor can be closed by a later exhaustion; a later cursor/gap reopens
    // the range even if an earlier receipt claimed exhaustion.
    const current = latestOf(key, 'enumerate_history');
    let established = false;
    let reason: UnresolvedReason = 'unattempted';
    let detail: string | null = account.accountId;
    if (current && current.action === 'enumerate_history') {
      if (attemptStateReason(current)) reason = attemptStateReason(current) as UnresolvedReason;
      else if (!depValid(current)) reason = 'dependency_withdrawn';
      else if (current.nextCursor !== null) {
        reason = 'cursor_open';
        detail = `${account.accountId}: nextCursor 未耗尽`;
      } else if (current.knownGaps.length > 0) {
        reason = 'known_gap';
        detail = `${account.accountId}: ${current.knownGaps.join('；')}`;
      } else if (blockingStopReason(current)) reason = blockingStopReason(current) as UnresolvedReason;
      else if (current.accessBoundary !== null) {
        reason = 'unavailable_content';
        detail = `${account.accountId}: ${current.accessBoundary}`;
      } else if (current.stopReason === 'endpoint_exhausted' && current.knownGaps.length === 0 && current.nextCursor === null) {
        established = true;
      } else reason = 'not_exhausted';
    }
    if (established) {
      history.addressed += 1;
      enumerationDone.add(account.accountId);
    } else {
      history.unresolved.push({ obligationKey: key, dimension: 'history_enumeration', reason, detail });
    }
  }

  /* ---------------- item obligations from enumeration ---------------- */
  // Enumerated items ACCUMULATE across all enumeration receipts; a later
  // empty page never erases earlier discoveries. Media metadata for the same
  // source@revision merges conservatively (frozen `mergeMediaMetadata`):
  // any recorded present keeps the media obligation, contradictions stay
  // visible, and only credible later metadata resolves unknown↔none.
  const itemEntries = new Map<string, ItemObligation & { mediaEntries: MediaMetadataEntry[] }>();
  for (const obs of observations) {
    if (obs.action !== 'enumerate_history') continue;
    if (obs.obligationRef.kind !== 'account_history') continue;
    const accountId = obs.obligationRef.accountId;
    if (!inScope.has(accountId)) continue;
    if (obs.accessBoundary !== null) {
      addNote(limitationsByDimension, 'history_enumeration', `${accountId}: ${obs.accessBoundary}`);
    }
    const credible = obs.attemptState === 'succeeded' && obs.accessBoundary === null &&
      (obs.stopReason === null || obs.stopReason === 'endpoint_exhausted');
    for (const item of obs.items) {
      const itemKey = `${part(accountId)}:${part(item.sourceId)}:${String(item.sourceRevision)}`;
      const existing = itemEntries.get(itemKey);
      if (existing) {
        existing.mediaEntries.push({ hasMedia: item.hasMedia, credible });
        continue;
      }
      const pin = snapshot.sources.find(
        (source) =>
          source.accountId === accountId &&
          source.sourceId === item.sourceId &&
          source.sourceRevision === item.sourceRevision
      );
      itemEntries.set(itemKey, {
        accountId,
        sourceId: item.sourceId,
        sourceRevision: item.sourceRevision,
        publishedAt: pin?.publishedAt ?? null,
        hasMedia: item.hasMedia,
        dateUnknown: (pin?.publishedAt ?? null) === null,
        mediaEntries: [{ hasMedia: item.hasMedia, credible }]
      });
    }
  }
  const items = [...itemEntries.values()]
    .map((entry) => {
      const resolution = mergeMediaMetadata(entry.mediaEntries);
      if (resolution.recorded.length > 1) {
        addNote(
          limitationsByDimension,
          'media',
          `${entry.sourceId}@${String(entry.sourceRevision)}: hasMedia 元数据冲突（${resolution.recorded.join('→')}），媒体义务保留`
        );
      }
      return { ...entry, hasMedia: resolution.state };
    })
    .sort(
      (a, b) =>
        compareIds(a.accountId, b.accountId) ||
        compareIds(a.sourceId, b.sourceId) ||
        a.sourceRevision - b.sourceRevision
    );
  const inWindowItems = items.filter((item) => inTimeWindow(item.publishedAt, spec));
  const outOfWindow = items.length - inWindowItems.length;
  if (outOfWindow > 0) {
    for (const dimension of ['body', 'media', 'comments'] as const) {
      addNote(notApplicableByDimension, dimension, `${String(outOfWindow)} 项超出冻结时间窗（out_of_window）`);
    }
  }
  if (items.some((item) => item.dateUnknown)) {
    claimBoundaries.push('存在发布日期未知的条目：保留在范围内，未按窗外排除。');
  }
  const noAccounts = inScope.size === 0;
  if (noAccounts) {
    for (const dimension of ['body', 'media', 'comments'] as const) {
      addNote(notApplicableByDimension, dimension, 'no_accounts_in_scope');
    }
    addNote(notApplicableByDimension, 'history_enumeration', 'no_accounts_in_scope');
  }
  const itemDenominatorKnown =
    noAccounts || [...inScope].every((accountId) => enumerationDone.has(accountId));

  const resolveItemRead = (
    dimension: 'body' | 'comments' | 'media',
    action: 'read_body' | 'read_comments' | 'read_media',
    doneResult: 'content_read' | 'comments_read' | 'media_read',
    item: ItemObligation,
    unresolvedReasonWhenAbsent: UnresolvedReason
  ): Resolved => {
    const key = obligationKey({
      kind: dimension === 'body' ? 'item_body' : dimension === 'comments' ? 'item_comments' : 'item_media',
      accountId: item.accountId,
      sourceId: item.sourceId,
      sourceRevision: item.sourceRevision
    });
    const current = latestOf(key, action);
    const resolved: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
    let established = false;
    let reason: UnresolvedReason = unresolvedReasonWhenAbsent;
    if (current) {
      if (attemptStateReason(current)) reason = attemptStateReason(current) as UnresolvedReason;
      else if (!depValid(current)) reason = 'dependency_withdrawn';
      else if (blockingStopReason(current)) reason = blockingStopReason(current) as UnresolvedReason;
      else if (current.result === doneResult) established = true;
      else if (current.result === 'unavailable') reason = 'unavailable_content';
    }
    if (established) {
      resolved.addressed = 1;
      return resolved;
    }
    resolved.unresolved.push({
      obligationKey: key,
      dimension,
      reason,
      detail: `${item.accountId} ${item.sourceId}@${String(item.sourceRevision)}`
    });
    return resolved;
  };

  const body: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  const media: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  const comments: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  const thread: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  let mediaNotApplicable = 0;
  let mediaUnknownApplicability = 0;
  for (const item of inWindowItems) {
    const bodyResolved = resolveItemRead('body', 'read_body', 'content_read', item, 'unattempted');
    body.addressed += bodyResolved.addressed;
    body.unresolved.push(...bodyResolved.unresolved);
    const commentsResolved = resolveItemRead('comments', 'read_comments', 'comments_read', item, 'unattempted');
    comments.addressed += commentsResolved.addressed;
    comments.unresolved.push(...commentsResolved.unresolved);
    if (item.hasMedia === 'none') {
      mediaNotApplicable += 1;
      addNote(
        notApplicableByDimension,
        'media',
        `${item.sourceId}@${String(item.sourceRevision)}: no_media`
      );
      continue;
    }
    const absentReason: UnresolvedReason =
      item.hasMedia === 'unknown' ? 'media_applicability_unknown' : 'unattempted';
    if (item.hasMedia === 'unknown') mediaUnknownApplicability += 1;
    const mediaResolved = resolveItemRead('media', 'read_media', 'media_read', item, absentReason);
    media.addressed += mediaResolved.addressed;
    media.unresolved.push(...mediaResolved.unresolved);
  }

  /* ---------------- selected thread branches ---------------- */
  const branchSelections = observations.filter(
    (obs): obs is BranchSelectionObservation => obs.action === 'select_branch' && obs.attemptState === 'succeeded'
  );
  const threadDepth = spec.threadDepth > 0 ? spec.threadDepth : DEFAULT_THREAD_DEPTH;
  const seqOf = new Map(observations.map((obs, seq) => [obs.observationId, seq]));
  const branchKeys: string[] = [];
  const selectionsByKey = new Map<string, BranchSelectionObservation[]>();
  for (const selection of branchSelections) {
    if (selection.obligationRef.kind !== 'thread_branch') continue;
    const key = obligationKey(selection.obligationRef);
    const list = selectionsByKey.get(key);
    if (list) list.push(selection);
    else {
      selectionsByKey.set(key, [selection]);
      branchKeys.push(key);
    }
  }
  for (const key of branchKeys) {
    const selections = selectionsByKey.get(key) ?? [];
    // Historical limitations: selection-time parent chain gaps and every read
    // receipt's blockers stay visible even after a later clean read.
    for (const selection of selections) {
      for (const link of selection.parentChain) {
        if (link.state !== 'present') {
          addNote(limitationsByDimension, 'thread', `${key}: ${link.state} ${link.commentKey}`);
        }
      }
    }
    const reads = (byKey.get(key) ?? []).filter(
      (obs) => obs.action === 'read_thread'
    ) as Extract<CompletionObservation, { action: 'read_thread' }>[];
    for (const read of reads) {
      for (const blocker of read.blockers) {
        addNote(limitationsByDimension, 'thread', `${key}: ${blocker.state} ${blocker.commentKey}`);
      }
    }
    // Current context = the latest context receipt (selection or read) in
    // insertion order; a later blocker is never hidden by an earlier success,
    // and a later CLEAN read to frozen depth releases earlier gaps.
    const contextReceipts = [...selections, ...reads].sort(
      (a, b) => (seqOf.get(a.observationId) ?? 0) - (seqOf.get(b.observationId) ?? 0)
    );
    const currentContext = contextReceipts[contextReceipts.length - 1];
    const currentBlockers: string[] = [];
    if (currentContext?.action === 'read_thread') {
      currentBlockers.push(...currentContext.blockers.map((blocker) => `${blocker.state} ${blocker.commentKey}`));
    } else if (currentContext?.action === 'select_branch') {
      currentBlockers.push(
        ...currentContext.parentChain
          .filter((link) => link.state !== 'present')
          .map((link) => `${link.state} ${link.commentKey}`)
      );
    }
    // Depth alone can never replace missing context: unresolved parent-chain
    // blockers keep the branch incomplete regardless of depthReached.
    const current = reads[reads.length - 1];
    let established = false;
    let reason: UnresolvedReason = currentBlockers.length > 0 ? 'unavailable_content' : 'unattempted';
    if (current) {
      if (attemptStateReason(current)) reason = attemptStateReason(current) as UnresolvedReason;
      else if (!depValid(current)) reason = 'dependency_withdrawn';
      else if (blockingStopReason(current)) reason = blockingStopReason(current) as UnresolvedReason;
      else if (current.result === 'unavailable' || currentBlockers.length > 0 || current.blockers.length > 0) {
        reason = 'unavailable_content';
      } else if (current.result === 'thread_read' && current.depthReached >= threadDepth && currentBlockers.length === 0) {
        established = true;
      } else if (current.depthReached < threadDepth) reason = 'depth_not_reached';
    }
    if (established) thread.addressed += 1;
    else thread.unresolved.push({ obligationKey: key, dimension: 'thread', reason, detail: key });
  }

  /* ---------------- questions ---------------- */
  const questions: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  for (const question of [...spec.questions].sort((a, b) => compareIds(a.questionId, b.questionId))) {
    const key = obligationKey({ kind: 'question', questionId: question.questionId });
    if (question.applicability === 'not_applicable') {
      addNote(notApplicableByDimension, 'questions', `${question.questionId}: ${question.applicabilityReason}`);
      continue;
    }
    const current = latestOf(key, 'answer_question') as QuestionObservation | undefined;
    let established = false;
    let investigated = false;
    let reason: UnresolvedReason = 'unattempted';
    if (current) {
      if (attemptStateReason(current)) reason = attemptStateReason(current) as UnresolvedReason;
      else if (!depValid(current)) reason = 'dependency_withdrawn';
      else if (blockingStopReason(current)) reason = blockingStopReason(current) as UnresolvedReason;
      else {
        const conform = questionConforms(current, spec, index, dependencyMemo);
        if (conform.ok) {
          established = true;
          investigated = conform.investigatedUnknown;
        } else reason = 'no_conforming_investigation';
      }
    }
    if (established) {
      questions.addressed += 1;
      if (investigated) {
        questions.investigatedUnknown += 1;
        handledUnknowns.push({
          obligationKey: key,
          dimension: 'questions',
          explanation: current ? (current as QuestionObservation).explanation : ''
        });
      }
    } else {
      questions.unresolved.push({ obligationKey: key, dimension: 'questions', reason, detail: question.questionId });
    }
  }

  /* ---------------- required checks ---------------- */
  const checks: Resolved = { addressed: 0, investigatedUnknown: 0, unresolved: [] };
  for (const check of [...spec.requiredChecks].sort((a, b) => compareIds(a.checkId, b.checkId))) {
    const key = obligationKey({ kind: 'required_check', checkId: check.checkId });
    const current = latestOf(key, 'report_required_check') as RequiredCheckObservation | undefined;
    let established = false;
    let reason: UnresolvedReason = 'unattempted';
    let detail: string | null = check.checkId;
    if (current) {
      if (attemptStateReason(current)) reason = attemptStateReason(current) as UnresolvedReason;
      else if (!depValid(current)) reason = 'dependency_withdrawn';
      else if (blockingStopReason(current)) reason = blockingStopReason(current) as UnresolvedReason;
      else if (current.result === 'observed' && check.required.every((entry) => current.observed.includes(entry))) {
        established = true;
      } else {
        reason = 'check_entries_missing';
        detail = check.required.filter((entry) => !current.observed.includes(entry)).join('；') || check.checkId;
      }
    }
    if (established) checks.addressed += 1;
    else checks.unresolved.push({ obligationKey: key, dimension: 'required_checks', reason, detail });
  }

  /* ---------------- reports ---------------- */
  const buildReport = (
    dimension: CompletionDimension,
    resolved: Resolved,
    total: number | null,
    denominatorKnown: boolean,
    notApplicable: number,
    zeroReason: string | null
  ): CompletionDimensionReport => {
    const notApplicableReasons = [...(notApplicableByDimension.get(dimension) ?? [])];
    let state: CompletionDimensionReport['state'];
    if (!denominatorKnown) state = 'unknown_denominator';
    else if (total === 0) {
      if (notApplicable > 0 || notApplicableReasons.length > 0 || zeroReason !== null) {
        state = 'not_applicable';
        if (zeroReason !== null) notApplicableReasons.push(zeroReason);
      } else state = 'complete';
    } else state = resolved.unresolved.length === 0 ? 'complete' : 'partial';
    const percent =
      denominatorKnown && total !== null && total > 0
        ? Math.round((resolved.addressed / total) * 100)
        : null;
    return {
      dimension,
      state,
      total,
      addressed: resolved.addressed,
      investigatedUnknown: resolved.investigatedUnknown,
      notApplicable,
      unresolved: resolved.unresolved.length,
      denominatorKnown,
      percent,
      unresolvedItems: resolved.unresolved,
      notApplicableReasons,
      limitations: limitationsByDimension.get(dimension) ?? []
    };
  };

  const historyTotal = noAccounts ? 0 : inScope.size;
  const historyNotApplicable = sliceAccounts.filter((account) => !inScope.has(account.accountId)).length;
  const mediaTotal = inWindowItems.filter((item) => item.hasMedia !== 'none').length;
  const applicableQuestions = spec.questions.filter((q) => q.applicability === 'applicable').length;
  const applicablePlatforms = registryEntries.filter((entry) => entry.applicability === 'applicable').length;
  const dimensions: CompletionDimensionReport[] = [
    buildReport(
      'platform_discovery',
      discovery,
      applicablePlatforms,
      true,
      registryEntries.length - applicablePlatforms,
      null
    ),
    buildReport('history_enumeration', history, historyTotal, true, historyNotApplicable, noAccounts ? 'no_accounts_in_scope' : null),
    buildReport(
      'body',
      body,
      itemDenominatorKnown ? inWindowItems.length : null,
      itemDenominatorKnown,
      outOfWindow,
      noAccounts ? 'no_accounts_in_scope' : null
    ),
    buildReport(
      'media',
      media,
      itemDenominatorKnown ? mediaTotal : null,
      itemDenominatorKnown,
      mediaNotApplicable + outOfWindow,
      noAccounts ? 'no_accounts_in_scope' : null
    ),
    buildReport(
      'comments',
      comments,
      itemDenominatorKnown ? inWindowItems.length : null,
      itemDenominatorKnown,
      outOfWindow,
      noAccounts ? 'no_accounts_in_scope' : null
    ),
    buildReport('thread', thread, branchKeys.length, true, 0, branchKeys.length === 0 ? 'no_branches_selected' : null),
    buildReport('questions', questions, applicableQuestions, true, spec.questions.length - applicableQuestions, null),
    buildReport('required_checks', checks, spec.requiredChecks.length, true, 0, null)
  ];

  const unresolvedTotal = dimensions.reduce((sum, report) => sum + report.unresolved, 0);
  const addressedTotal = dimensions.reduce((sum, report) => sum + report.addressed, 0);
  const verdict: CompletionVerdict =
    unresolvedTotal === 0 ? 'complete' : addressedTotal > 0 ? 'partial' : 'incomplete';

  claimBoundaries.push('持久哈希只证明记录未被改写，不证明网络原文真实性（GET-58 不保存全文）。');
  if (history.addressed > 0) {
    claimBoundaries.push('枚举完成只证明接口可访问范围（endpoint-accessible range），不代表账号完整历史。');
  }
  if (preservedAttempts.length > 0) {
    claimBoundaries.push('failed / cancelled / needs_input 状态按原样保留，完成判定未覆盖这些尝试。');
  }
  if (mediaUnknownApplicability > 0) {
    claimBoundaries.push('部分条目媒体是否存在未知（hasMedia=unknown），未按无媒体处理。');
  }
  claimBoundaries.push('当前状态由每个义务的最新回执决定（有序 supersession）；更早回执保留为历史与其限制。');

  return {
    verdict,
    dimensions,
    handledUnknowns,
    preservedAttempts,
    claimBoundaries
  };
}
