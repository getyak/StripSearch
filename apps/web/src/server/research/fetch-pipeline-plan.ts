/**
 * Deterministic chunked stage/verify planning for the local Fetch pipeline
 * (pure, no stores): the exact `save_findings` / `read_evidence` call inputs
 * the controller may dispatch through the GET-59 gateway.
 *
 * Why chunking (see docs/fetch-pipeline.md): GET-59 bounds every
 * `save_findings` call to at most 50 findings and every finding to at most
 * 100 support + 100 counter references and 100 coverage identities, and
 * every `read_evidence` call to at most 100 evidence references. The
 * pre-chunking planner silently sliced support/counter ids and mapped whole
 * account/identity sets into single payloads, losing dependencies and
 * failing validation past the bounds. These helpers split material into
 * deterministic chunks that respect every registry bound while preserving
 * EVERY dependency and coverage identity exactly once — no silent slice
 * losses, no cumulative caps (a chunk size is a per-call bound only).
 *
 * Resume semantics: chunks are pure functions of the durable inputs given
 * here. The controller freezes each phase call manifest durably BEFORE its
 * first dispatch and never re-packs it from successful subsets: a partial or
 * refused call keeps its exact immutable step key and its rejected material
 * stays explicitly incomplete instead of being re-chunked into a fresh key
 * and auto-retried. `remainingStageMaterial` computes the not-yet-staged
 * remainder for manifest construction; coverage identities are emitted only
 * when still needed, and shared support/counter references are deduplicated
 * across the whole material so statement counts equal unique references.
 */

import { canonicalJson } from '../../shared/research-fetch-pipeline.js';

/** Explicit planner version pin recorded in every frozen phase manifest. */
export const FETCH_PLANNER_VERSION = 'fetch-pipeline-plan/v2-immutable-manifests';

/* ------------------------------------------------------------------ */
/* GET-59 per-call / per-finding bounds (registry stays authoritative) */
/* ------------------------------------------------------------------ */

/** Bounds of `save_findings` (`research-tool-contracts.toolInputs`). */
export const SAVE_FINDINGS_BOUNDS = {
  /** Max findings per `save_findings` call. */
  findingsPerCall: 50,
  /** Max `supportEvidenceIds` per finding. */
  supportPerFinding: 100,
  /** Max `counterEvidenceIds` per finding. */
  counterPerFinding: 100,
  /** Max `coverageDelta` entries per finding. */
  coveragePerFinding: 100
} as const;

/** Max evidence references per `read_evidence` call. */
export const READ_EVIDENCE_BOUND = 100;

/* ------------------------------------------------------------------ */
/* Material shapes                                                      */
/* ------------------------------------------------------------------ */

export interface StageIdentityUnit {
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  /** Current support evidence ids of this identity (may include staged ones). */
  supportIds: string[];
  /** Current counter evidence ids of this identity (may include staged ones). */
  counterIds: string[];
  /**
   * Whether this identity still needs its coverage entry. A covered identity
   * with new references stages the references WITHOUT re-emitting coverage.
   * Absent = coverage still needed.
   */
  coverageNeeded?: boolean;
}

export interface StageAccountUnit {
  accountId: string;
  identities: StageIdentityUnit[];
}

/** Coverage identities and dependency refs already staged durably. */
export interface StagedStageMaterial {
  coverage: readonly { accountId: string; sourceId: string; sourceRevision: number }[];
  dependencyIds: readonly string[];
}

/** Collision-free canonical identity tuple (never delimiter-concatenated). */
function coverageKey(entry: { accountId: string; sourceId: string; sourceRevision: number }): string {
  return canonicalJson({ accountId: entry.accountId, sourceId: entry.sourceId, sourceRevision: entry.sourceRevision });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function chunks<T>(entries: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < entries.length; index += size) {
    out.push(entries.slice(index, index + size));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stage remainder (durable staged material is never re-staged)        */
/* ------------------------------------------------------------------ */

/**
 * The NOT-YET-STAGED stage material: identities whose coverage entry is not
 * in any staged collected finding, plus the current evidence references not
 * yet referenced by any staged finding. Pure and deterministic; refused or
 * partially submitted calls leave their material in the remainder so it is
 * recorded as incomplete; the controller freezes the phase manifest before
 * dispatch and never re-packs or auto-retries rejected material.
 */
export function remainingStageMaterial(
  units: readonly StageAccountUnit[],
  staged: StagedStageMaterial
): StageAccountUnit[] {
  const stagedCoverage = new Set(staged.coverage.map(coverageKey));
  const stagedRefs = new Set(staged.dependencyIds);
  const out: StageAccountUnit[] = [];
  for (const account of [...units].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))) {
    const identities: StageIdentityUnit[] = [];
    for (const identity of account.identities) {
      const supportIds = sortedUnique(identity.supportIds).filter((evidenceId) => !stagedRefs.has(evidenceId));
      const counterIds = sortedUnique(identity.counterIds).filter((evidenceId) => !stagedRefs.has(evidenceId));
      const covered = identity.coverageNeeded === false || stagedCoverage.has(coverageKey(identity));
      if (covered && supportIds.length === 0 && counterIds.length === 0) continue;
      // A covered identity keeps `coverageNeeded: false`: new references are
      // staged without ever re-emitting its coverage identity.
      identities.push({ ...identity, supportIds, counterIds, coverageNeeded: !covered });
    }
    if (identities.length > 0) out.push({ accountId: account.accountId, identities });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stage findings and save_findings calls                              */
/* ------------------------------------------------------------------ */

interface FindingSlice {
  accountId: string;
  supportIds: string[];
  counterIds: string[];
  coverage: { accountId: string; sourceId: string; sourceRevision: number }[];
}

function identitySlices(identity: StageIdentityUnit): FindingSlice[] {
  // One identity's material may itself exceed a per-finding bound (e.g. more
  // than 100 counter references): split into lane chunks and keep the
  // coverage identity with the FIRST slice so it appears exactly once — and
  // only when the identity still needs its coverage entry.
  const laneCount = Math.max(
    1,
    Math.ceil(identity.supportIds.length / SAVE_FINDINGS_BOUNDS.supportPerFinding),
    Math.ceil(identity.counterIds.length / SAVE_FINDINGS_BOUNDS.counterPerFinding)
  );
  const coverageNeeded = identity.coverageNeeded !== false;
  const slices: FindingSlice[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    slices.push({
      accountId: identity.accountId,
      supportIds: identity.supportIds.slice(
        lane * SAVE_FINDINGS_BOUNDS.supportPerFinding,
        (lane + 1) * SAVE_FINDINGS_BOUNDS.supportPerFinding
      ),
      counterIds: identity.counterIds.slice(
        lane * SAVE_FINDINGS_BOUNDS.counterPerFinding,
        (lane + 1) * SAVE_FINDINGS_BOUNDS.counterPerFinding
      ),
      coverage:
        lane === 0 && coverageNeeded
          ? [{ accountId: identity.accountId, sourceId: identity.sourceId, sourceRevision: identity.sourceRevision }]
          : []
    });
  }
  return slices;
}

function findingFromSlice(accountId: string, slice: FindingSlice, group: { index: number; total: number }): Record<string, unknown> {
  const support = slice.supportIds.length;
  const counter = slice.counterIds.length;
  const coverage = slice.coverage.length;
  const grouped = group.total > 1 ? `（同账号第 ${String(group.index)}/${String(group.total)} 条记录）` : '';
  const statement =
    coverage > 0
      ? `账号 ${accountId}：已处理 ${String(coverage)} 个枚举条目的正文与默认评论页（支持 ${String(support)} 条、反证 ${String(counter)} 条）${grouped}；矛盾材料单列。`
      : `账号 ${accountId}：补充同账号材料记录（支持 ${String(support)} 条、反证 ${String(counter)} 条）${grouped}；矛盾材料单列。`;
  return {
    kind: 'collected_finding',
    statement,
    supportEvidenceIds: slice.supportIds,
    counterEvidenceIds: slice.counterIds,
    coverageDelta: slice.coverage.map((locator) => ({
      locator,
      taskRef: { kind: 'question_matrix', slot: 'work' },
      status: 'evidence_found'
    })),
    note: 'pending only: 本批只暂存 pending finding，不发布、不写报告'
  };
}

/**
 * Deterministic collected findings for the remaining stage material: per
 * account, identities in stable identity order, every support/counter
 * reference and every coverage identity exactly once (shared references are
 * deduplicated across the whole material, keeping every independent coverage
 * identity), every finding inside the GET-59 per-finding bounds. Statement
 * counts equal the finding's unique references.
 */
export function planStageFindings(material: readonly StageAccountUnit[]): Record<string, unknown>[] {
  const findings: Record<string, unknown>[] = [];
  // Global per-polarity dedupe: the same evidence referenced by two items is
  // ONE dependency, never counted or dispatched twice.
  const usedSupport = new Set<string>();
  const usedCounter = new Set<string>();
  for (const account of [...material].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))) {
    const slices: FindingSlice[] = [];
    const identities = [...account.identities].sort((a, b) =>
      a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.sourceRevision - b.sourceRevision
    );
    for (const identity of identities) {
      const supportIds = sortedUnique(identity.supportIds).filter((evidenceId) => {
        if (usedSupport.has(evidenceId)) return false;
        usedSupport.add(evidenceId);
        return true;
      });
      const counterIds = sortedUnique(identity.counterIds).filter((evidenceId) => {
        if (usedCounter.has(evidenceId)) return false;
        usedCounter.add(evidenceId);
        return true;
      });
      if (identity.coverageNeeded === false && supportIds.length === 0 && counterIds.length === 0) continue;
      slices.push(...identitySlices({ ...identity, supportIds, counterIds }));
    }
    // Greedy pack slices into findings within every per-finding bound.
    const packed: FindingSlice[] = [];
    let current: FindingSlice | null = null;
    for (const slice of slices) {
      const fits =
        current !== null &&
        current.supportIds.length + slice.supportIds.length <= SAVE_FINDINGS_BOUNDS.supportPerFinding &&
        current.counterIds.length + slice.counterIds.length <= SAVE_FINDINGS_BOUNDS.counterPerFinding &&
        current.coverage.length + slice.coverage.length <= SAVE_FINDINGS_BOUNDS.coveragePerFinding;
      if (current === null || !fits) {
        if (current !== null) packed.push(current);
        current = { accountId: slice.accountId, supportIds: [...slice.supportIds], counterIds: [...slice.counterIds], coverage: [...slice.coverage] };
      } else {
        current.supportIds.push(...slice.supportIds);
        current.counterIds.push(...slice.counterIds);
        current.coverage.push(...slice.coverage);
      }
    }
    if (current !== null) packed.push(current);
    for (let index = 0; index < packed.length; index += 1) {
      findings.push(findingFromSlice(account.accountId, packed[index]!, { index: index + 1, total: packed.length }));
    }
  }
  return findings;
}

/**
 * Deterministic `save_findings` calls for the remaining stage material: at
 * most `findingsPerCall` findings per call, in stable finding order.
 */
export function planStageSaveFindingsCalls(material: readonly StageAccountUnit[]): Record<string, unknown>[] {
  return chunks(planStageFindings(material), SAVE_FINDINGS_BOUNDS.findingsPerCall).map((findings) => ({ findings }));
}

/* ------------------------------------------------------------------ */
/* Verify: read_evidence calls and verification findings               */
/* ------------------------------------------------------------------ */

/**
 * Deterministic bounded `read_evidence` calls over the given references in
 * the given order (the caller passes a stable sorted order): at most
 * `READ_EVIDENCE_BOUND` references per call, every reference exactly once.
 */
export function planEvidenceReadCalls(evidenceIds: readonly string[]): Record<string, unknown>[] {
  return chunks(evidenceIds, READ_EVIDENCE_BOUND).map((batch) => ({
    evidence: batch.map((evidenceId) => ({ evidenceId }))
  }));
}

/**
 * Deterministic isolated verification findings over the EXACT successfully
 * pinned read-back references given here (never more): every reference
 * exactly once, every finding inside the GET-59 per-finding bounds, and the
 * statement counts are exactly the references of that finding. `unverified`
 * discloses (in the note only) how many staged dependencies this read-back
 * did NOT pin, keeping the record honest partial with no semantic facts or
 * quality claims.
 */
export function planVerificationFindings(input: {
  supportIds: readonly string[];
  counterIds: readonly string[];
  /** Staged dependencies NOT successfully pinned by read-back (honest gap). */
  unverifiedDependencies: number;
}): Record<string, unknown>[] {
  const support = sortedUnique(input.supportIds);
  const counter = sortedUnique(input.counterIds);
  const supportChunks = chunks(support, SAVE_FINDINGS_BOUNDS.supportPerFinding);
  const counterChunks = chunks(counter, SAVE_FINDINGS_BOUNDS.counterPerFinding);
  const total = Math.max(supportChunks.length, counterChunks.length);
  const findings: Record<string, unknown>[] = [];
  for (let index = 0; index < total; index += 1) {
    const supportRefs = supportChunks[index] ?? [];
    const counterRefs = counterChunks[index] ?? [];
    const grouped = total > 1 ? `（第 ${String(index + 1)}/${String(total)} 条核验记录）` : '';
    const partial =
      input.unverifiedDependencies > 0
        ? `；另有 ${String(input.unverifiedDependencies)} 条 staged 依赖未能回读，核验保持 partial，不作完整核验、语义事实或质量结论`
        : '';
    findings.push({
      kind: 'verification_check',
      statement: `核验：${String(supportRefs.length)} 条支持与 ${String(counterRefs.length)} 条反证依赖已按 pin 成功回读${grouped}；无新增来源、正文或覆盖。`,
      supportEvidenceIds: supportRefs,
      counterEvidenceIds: counterRefs,
      note: `isolated verify: read-back validated; no new sources, bodies or coverage${partial}`
    });
  }
  return findings;
}

/**
 * Deterministic `save_findings` calls for verification findings: at most
 * `findingsPerCall` findings per call, in stable order.
 */
export function planVerificationSaveFindingsCalls(input: {
  supportIds: readonly string[];
  counterIds: readonly string[];
  unverifiedDependencies: number;
}): Record<string, unknown>[] {
  return chunks(planVerificationFindings(input), SAVE_FINDINGS_BOUNDS.findingsPerCall).map((findings) => ({ findings }));
}
