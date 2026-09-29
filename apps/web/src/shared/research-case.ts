/**
 * GET-58 shared domain contract for person research cases.
 *
 * This module is authoritative for `ResearchCase`, `AccountSelection`,
 * `ScopeVersion`, `SourceRevision`, `EvidenceRef` and `ItemCoverage`. Later
 * issues import these types instead of defining competing shapes.
 *
 * Boundaries:
 * - `ownerId` is the tenant boundary: no read or write may cross owners.
 * - `accountId` is the researched-account boundary: an account belongs to
 *   exactly one case and never crosses cases. Multiple accounts on the same
 *   platform are first-class; nothing merges them.
 *
 * Revision dimensions stay distinct and are never substituted for one another:
 * legacy run `revision`, `personRevision`, `scopeVersion` and the per-source
 * `sourceRevision` counter.
 *
 * The five `AccountSelection` facets — `identitySupport`, `userSelection`,
 * `allowedScope`, `researchValue`, `accessCoverage` — are recorded
 * independently. A user selection never upgrades identity evidence, research
 * value never widens allowed scope and access coverage never proves identity.
 *
 * Identity-link support (`identity_support` / `identity_counterevidence`) is a
 * separate evidence role from factual support and counterevidence. Reference
 * slots are role-checked: identity facets only cite identity evidence, claims
 * only cite factual evidence, coverage items match by support/counterevidence
 * polarity. Nonexistent, foreign or role-mismatched references are rejected —
 * never silently dropped.
 *
 * Scope is mutated through one atomic path (`applyScopeChange` in the store):
 * it snapshots the actual per-account selection/allowedScope state before and
 * after the change and advances `scopeVersion` in the same transaction, so an
 * old expectedScopeVersion can never write into a widened scope. Discovered
 * candidates are recorded as `unanswered` — discovery never implies a user
 * selection.
 *
 * These records are foundations only: no Search/Fetch runtime, workers,
 * leases or scheduling live here. The typed task references and per-item
 * coverage records are seeded for later scheduling/coverage issues. See
 * docs/research-case-domain.md.
 */

import type { ClaimKind, Validity } from './types.js';

export const RESEARCH_CASE_SCHEMA_VERSION = 'stripsearch/research-case/v1';

/* ------------------------------------------------------------------ */
/* Distinct revision dimensions                                       */
/* ------------------------------------------------------------------ */

/** Case scope generation. Task references and writes carry it; stale writes are rejected. */
export type ScopeVersion = number & { readonly __brand: 'ScopeVersion' };

/** Understanding-of-the-person generation; advanced by withdrawal/revocation. */
export type PersonRevision = number & { readonly __brand: 'PersonRevision' };

export function asScopeVersion(value: number): ScopeVersion {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`scopeVersion must be a positive integer, got ${String(value)}`);
  }
  return value as ScopeVersion;
}

export function asPersonRevision(value: number): PersonRevision {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`personRevision must be a positive integer, got ${String(value)}`);
  }
  return value as PersonRevision;
}

export function nextScopeVersion(current: ScopeVersion): ScopeVersion {
  return asScopeVersion(current + 1);
}

export function nextPersonRevision(current: PersonRevision): PersonRevision {
  return asPersonRevision(current + 1);
}

/* ------------------------------------------------------------------ */
/* Errors (fail closed)                                               */
/* ------------------------------------------------------------------ */

/** The write carried an older scope version than the case currently has. */
export class StaleScopeError extends Error {
  constructor(
    readonly caseId: string,
    readonly expected: ScopeVersion,
    readonly actual: ScopeVersion
  ) {
    super(
      `case ${caseId} moved past scope version ${String(expected)} (current ${String(actual)})`
    );
    this.name = 'StaleScopeError';
  }
}

/** A referenced id belongs to another owner/case/account or does not exist. */
export class ForeignReferenceError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ForeignReferenceError';
  }
}

/** Selection/allowedScope changes must use the atomic scope mutation path. */
export class ScopeBypassError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ScopeBypassError';
  }
}

/** A referenced evidence id exists but not with the role the slot accepts. */
export class EvidenceRoleError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'EvidenceRoleError';
  }
}

/**
 * Unknown case, or a case owned by another tenant. Owner mismatches report the
 * same "not found" so tenant existence cannot be probed.
 */
export class CaseNotFoundError extends Error {
  constructor(readonly caseId: string) {
    super(`case ${caseId} not found`);
    this.name = 'CaseNotFoundError';
  }
}

/* ------------------------------------------------------------------ */
/* Provenance                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where a record's authorization came from. Legacy alpha databases and reports
 * carry `legacy_no_authorization`; consent is never invented.
 */
export type ConsentProvenance = 'user_confirmed' | 'legacy_no_authorization' | 'not_recorded';

export interface RecordProvenance {
  authorization: ConsentProvenance;
  /** What produced the record, e.g. 'synthetic-fixture' or 'legacy-alpha-import'. */
  collector: string;
  note: string | null;
}

/** Honest provenance for material adopted from the pre-GET-58 alpha. */
export function legacyNoAuthorizationProvenance(collector = 'legacy-alpha-import'): RecordProvenance {
  return { authorization: 'legacy_no_authorization', collector, note: '旧版 alpha 记录，无用户授权记录。' };
}

/* ------------------------------------------------------------------ */
/* Case                                                               */
/* ------------------------------------------------------------------ */

export interface ResearchCase {
  caseId: string;
  ownerId: string;
  /** Stable person-understanding id inside the case; never derived from accounts. */
  personId: string;
  intent: string;
  scopeVersion: ScopeVersion;
  personRevision: PersonRevision;
  provenance: RecordProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeVersionRecord {
  caseId: string;
  scopeVersion: ScopeVersion;
  reason: string;
  createdAt: string;
  /** Actual per-account selection/allowedScope before this entry. */
  before: ScopeAccountSnapshot[];
  /** Actual per-account selection/allowedScope at this entry. Immutable. */
  after: ScopeAccountSnapshot[];
}

/** The scope-relevant slice of one account, snapshotted verbatim. */
export interface ScopeAccountSnapshot {
  accountId: string;
  platform: string;
  handle: string | null;
  userSelection: UserSelection;
  allowedScope: AllowedScope;
}

/* ------------------------------------------------------------------ */
/* Account selection: five independent facets                         */
/* ------------------------------------------------------------------ */

export type IdentitySupportState = 'proposed' | 'supported' | 'disputed' | 'rejected' | 'revoked';

/** Identity-link evidence only; factual support never lands here. */
export interface IdentitySupport {
  state: IdentitySupportState;
  /** Evidence ids with role `identity_support`. */
  evidenceIds: string[];
  /** Evidence ids with role `identity_counterevidence`. */
  counterevidenceIds: string[];
  policyVersion: string;
  note: string | null;
}

export type UserSelectionState = 'unanswered' | 'selected' | 'only_this_account' | 'not_selected';

/** What the user asked to research. A statement of intent, never evidence. */
export interface UserSelection {
  state: UserSelectionState;
  note: string | null;
  recordedAt: string | null;
}

export type AllowedScopeState = 'none' | 'profile_only' | 'public_history';

/** What may be read on this account. Research value cannot widen it. */
export interface AllowedScope {
  state: AllowedScopeState;
  note: string | null;
}

export type ResearchValueState = 'unassessed' | 'high' | 'medium' | 'low';

/** Expected research payoff; never evidence and never scope. */
export interface ResearchValue {
  state: ResearchValueState;
  rationale: string | null;
}

export type AccessCoverageState = 'unassessed' | 'inaccessible' | 'partial' | 'capped' | 'interface_complete';

/** What has actually been read; never proof of identity or ownership. */
export interface AccessCoverage {
  state: AccessCoverageState;
  earliestReadAt: string | null;
  note: string | null;
}

export interface AccountSelection {
  caseId: string;
  /** Stable researched-account boundary id. */
  accountId: string;
  platform: string;
  handle: string | null;
  profileUrl: string | null;
  identitySupport: IdentitySupport;
  userSelection: UserSelection;
  allowedScope: AllowedScope;
  researchValue: ResearchValue;
  accessCoverage: AccessCoverage;
  createdAt: string;
  updatedAt: string;
}

export type AccountFacetPatch = Partial<
  Pick<
    AccountSelection,
    'identitySupport' | 'userSelection' | 'allowedScope' | 'researchValue' | 'accessCoverage'
  >
>;

/* ------------------------------------------------------------------ */
/* Source revisions: append-only                                     */
/* ------------------------------------------------------------------ */

export interface SourceRevision {
  sourceId: string;
  /** Immutable per-source counter, distinct from scopeVersion/personRevision. */
  sourceRevision: number;
  caseId: string;
  accountId: string;
  author: string | null;
  /** URL exactly as the source stated it; never rewritten by later fetches. */
  originalUrl: string;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
  locator: string | null;
  /** sha256 of the captured content at this revision. */
  contentHash: string;
  provenance: RecordProvenance;
}

export interface CaseSourceView {
  sourceId: string;
  accountId: string;
  latestRevision: number;
  /** Every immutable revision, ascending. */
  revisions: SourceRevision[];
}

/* ------------------------------------------------------------------ */
/* Evidence                                                           */
/* ------------------------------------------------------------------ */

/**
 * Why an excerpt is on file. Identity-link support is kept separate from
 * factual support and counterevidence so attribution and truth never merge.
 */
export type EvidenceRole =
  | 'identity_support'
  | 'identity_counterevidence'
  | 'factual_support'
  | 'factual_counterevidence';

/** Role each reference slot accepts; enforced on every write and in the view. */
export const IDENTITY_SUPPORT_ROLE: EvidenceRole = 'identity_support';
export const IDENTITY_COUNTEREVIDENCE_ROLE: EvidenceRole = 'identity_counterevidence';
export const FACTUAL_SUPPORT_ROLE: EvidenceRole = 'factual_support';
export const FACTUAL_COUNTEREVIDENCE_ROLE: EvidenceRole = 'factual_counterevidence';

export interface EvidenceRef {
  /** Stable id assigned once; filtering or withdrawal never renumbers it. */
  evidenceId: string;
  caseId: string;
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  role: EvidenceRole;
  quote: string;
  locator: string | null;
  /** sha256 of `quote`; proves the excerpt was not edited later. */
  quoteHash: string;
  provenance: RecordProvenance;
  createdAt: string;
  /** Withdrawal keeps the record and its id; only this timestamp is set. */
  revokedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Claims                                                             */
/* ------------------------------------------------------------------ */

export interface CaseClaim {
  /** Stable id assigned once; never renumbered by filtering. */
  claimId: string;
  caseId: string;
  accountId: string;
  statement: string;
  kind: ClaimKind;
  supportIds: string[];
  counterevidenceIds: string[];
  limitations: string[];
  createdAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
}

export interface CaseClaimView extends CaseClaim {
  validity: Validity;
  reviewReason: string | null;
}

/**
 * Account with derived identity marking. The stored facets are preserved
 * verbatim; `identityValidity` flags identity support that depended on
 * withdrawn or mismatched evidence so a previously `supported` state is never
 * displayed as fully supported again. User selection is never consulted.
 */
export interface CaseAccountView extends AccountSelection {
  identityValidity: Validity;
  identityReviewReason: string | null;
}

/* ------------------------------------------------------------------ */
/* Typed task references and per-item coverage                        */
/* ------------------------------------------------------------------ */

/** The default question matrix slots; items are marked applicable, never deleted. */
export type QuestionSlot = 'experience' | 'work' | 'expression' | 'interaction' | 'change' | 'counterevidence';

/**
 * Typed reference to what an item covers. `research_task` points at the
 * evaluation rubric in research-task.ts; later scheduling/coverage issues add
 * kinds here instead of inventing free-form strings.
 */
export type TaskRef =
  | { kind: 'research_task'; taskId: string; checkId: string }
  | { kind: 'question_matrix'; slot: QuestionSlot };

/**
 * Canonical, collision-free key of a task reference. `research_task` tuples are
 * length-prefixed so arbitrary legal strings cannot collide (`alpha#beta` +
 * `gamma` vs `alpha` + `beta#gamma`); `question_matrix` slots come from a
 * closed enum and keep their readable form. Stored verbatim as the uniqueness
 * component of coverage items.
 */
export function taskRefKey(ref: TaskRef): string {
  return ref.kind === 'research_task'
    ? `research_task:${ref.taskId.length}:${ref.taskId}:${ref.checkId}`
    : `question_matrix:${ref.slot}`;
}

export type CoverageStatus = 'unseen' | 'evidence_found' | 'conflicting' | 'resolved_unknown' | 'blocked';

/**
 * Stable per-content coverage locator. Coverage is recorded per researched
 * account and per content item (stable source id + source revision), so two
 * accounts, two posts of one account and two revisions of one post never share
 * a record and cross-account data is never mixed. The locator can be
 * established by `recordSourceRevision` before any evidence exists, so
 * `unseen` coverage is representable.
 */
export interface CoverageLocator {
  /** Must equal the write-context account; part of the item's bound identity. */
  accountId: string;
  /** Stable source/content id. */
  sourceId: string;
  /** Source revision the coverage is about; distinct revisions are distinct items. */
  sourceRevision: number;
}

/**
 * One per-content coverage item: keyed by (locator, taskRef) and never
 * rebound. Updates append immutable revisions (see `ItemCoverageRevision`), so
 * the scopeVersion of older scoped coverage is preserved as historical
 * provenance instead of being silently overwritten.
 */
export interface ItemCoverage {
  caseId: string;
  /** Stable per-item id; updates keep it, so later scheduling can reference it. */
  itemId: string;
  locator: CoverageLocator;
  taskRef: TaskRef;
  /** Latest coverage revision number. */
  revision: number;
  /** Scope version of the latest write; older scoped revisions stay readable. */
  scopeVersion: ScopeVersion;
  status: CoverageStatus;
  evidenceIds: string[];
  counterevidenceIds: string[];
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Immutable history entry of one coverage item, bound to its scope version. */
export interface ItemCoverageRevision {
  caseId: string;
  itemId: string;
  revision: number;
  scopeVersion: ScopeVersion;
  status: CoverageStatus;
  evidenceIds: string[];
  counterevidenceIds: string[];
  note: string | null;
  createdAt: string;
}

/**
 * Coverage with derived scope marking. A record written under an older scope
 * version stays honest history but is flagged for re-checking; no completion
 * or scheduling policy is implied (later GET-60/95 work).
 */
export interface CaseCoverageView extends ItemCoverage {
  scopeValidity: Validity;
  scopeReviewReason: string | null;
}

/* ------------------------------------------------------------------ */
/* Canonical case report view (single source for all exports)         */
/* ------------------------------------------------------------------ */

export interface CaseReportInput {
  case: ResearchCase;
  accounts: AccountSelection[];
  sources: CaseSourceView[];
  evidence: EvidenceRef[];
  claims: CaseClaim[];
  coverage: ItemCoverage[];
}

export interface CaseReportView {
  schemaVersion: typeof RESEARCH_CASE_SCHEMA_VERSION;
  case: ResearchCase;
  accounts: CaseAccountView[];
  sources: CaseSourceView[];
  evidence: EvidenceRef[];
  claims: CaseClaimView[];
  coverage: CaseCoverageView[];
}

/**
 * Deterministic dependency marking for one canonical case view. Every renderer
 * (JSON, Markdown) derives from this view, so format switches cannot create new
 * facts, and no step here rewrites an id: withdrawn evidence keeps its id and
 * surviving records keep their identities.
 *
 * Withdrawal is symmetric: a revoked support **or** counterevidence dependency
 * (and any missing or role-mismatched reference) forces review — nothing stays
 * valid on a withdrawn basis.
 */
export function buildCaseReportView(input: CaseReportInput): CaseReportView {
  const known = new Map(input.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const refProblem = (id: string, role: EvidenceRole): string | null => {
    const evidence = known.get(id);
    if (!evidence) return `${id} 不在案`;
    if (evidence.revokedAt !== null) return `${id} 已撤回`;
    if (evidence.role !== role) return `${id} 角色不符`;
    return null;
  };
  const claims = input.claims.map<CaseClaimView>((claim) => {
    const reasons: string[] = [];
    if (claim.withdrawnAt !== null) reasons.push('结论已撤回');
    for (const id of claim.supportIds) {
      const problem = refProblem(id, FACTUAL_SUPPORT_ROLE);
      if (problem) reasons.push(problem);
    }
    for (const id of claim.counterevidenceIds) {
      const problem = refProblem(id, FACTUAL_COUNTEREVIDENCE_ROLE);
      if (problem) reasons.push(problem);
    }
    return {
      ...claim,
      validity: reasons.length > 0 ? 'review' : 'valid',
      reviewReason: reasons.length > 0 ? reasons.join('；') : null
    };
  });
  const accounts = input.accounts.map<CaseAccountView>((account) => {
    const reasons: string[] = [];
    for (const id of account.identitySupport.evidenceIds) {
      const problem = refProblem(id, IDENTITY_SUPPORT_ROLE);
      if (problem) reasons.push(problem);
    }
    for (const id of account.identitySupport.counterevidenceIds) {
      const problem = refProblem(id, IDENTITY_COUNTEREVIDENCE_ROLE);
      if (problem) reasons.push(problem);
    }
    if (account.identitySupport.state === 'supported' && account.identitySupport.evidenceIds.length === 0) {
      reasons.push('支持状态缺少身份证据');
    }
    return {
      ...account,
      identityValidity: reasons.length > 0 ? 'review' : 'valid',
      identityReviewReason: reasons.length > 0 ? reasons.join('；') : null
    };
  });
  // Coverage keeps its own scope provenance: an item written under an older
  // scope version is flagged instead of being presented as current-scope fact.
  const coverage = input.coverage.map<CaseCoverageView>((item) => {
    const reasons: string[] = [];
    if (item.scopeVersion !== input.case.scopeVersion) {
      reasons.push(`覆盖来自范围 v${String(item.scopeVersion)}，当前范围 v${String(input.case.scopeVersion)}`);
    }
    return {
      ...item,
      scopeValidity: reasons.length > 0 ? 'review' : 'valid',
      scopeReviewReason: reasons.length > 0 ? reasons.join('；') : null
    };
  });
  return {
    schemaVersion: RESEARCH_CASE_SCHEMA_VERSION,
    case: input.case,
    accounts,
    sources: input.sources,
    evidence: input.evidence,
    claims,
    coverage
  };
}
