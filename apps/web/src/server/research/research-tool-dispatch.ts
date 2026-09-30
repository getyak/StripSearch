/**
 * GET-59 production dispatch(trustedContext, modelCall, ports, signal) for the
 * Search 8 / Fetch 10 tool contracts.
 *
 * Authority rules enforced here:
 * - Owner / case / role / phase / account permissions / capability snapshot /
 *   skill pins arrive only from trusted server context; model input carrying
 *   privilege, ownership or budget fields is refused.
 * - Case authority is consolidated into one gate reused at entry, after awaited
 *   step accounting, before EVERY real provider request, before any local
 *   write and before returning usable content. A missing fresh-state port
 *   fails closed; the opening trusted snapshot is never a substitute for
 *   current Store state. The original dispatch AbortSignal is always enforced,
 *   even when a handler passes a different signal to requests.run. Cancellation
 *   / scope / dependency changes stop NEW execution while already executed
 *   requests still settle exactly once (no persistent GET-79 lease claim).
 * - Evidence and finding/coverage locators go through one account
 *   authorization: trusted slice membership, current Store scope, and a
 *   trusted source-access classifier decide profile vs history reads.
 *   profile_only never infers access from evidence existence or role.
 * - Every underlying provider request goes through one controlled metered
 *   executor: reserve -> execute -> settle, exactly once per executed attempt
 *   (failed, HTTP-failed, unknown-fee and schema-rejected results included).
 *   Settlement failure stops further execution and staging (unreconciled); the
 *   remote request is never repeated to repair accounting.
 * - save_findings is pending-only through a constrained SubmissionPort whose
 *   commit atomically compares owner/case/expectedScopeVersion and evidence
 *   dependencies at write time; controller ports carry the same commit
 *   obligations and can never grant permissions. Partial batch acceptance is
 *   reported truthfully with the accepted pending refs.
 *
 * This is an offline contract foundation: it does not enable online
 * Search/Fetch, does not wire the legacy Web runtime, and claims no durable
 * GET-78 ledger, GET-79 leases or GET-95 workers.
 */

import { randomUUID } from 'node:crypto';

import type { Store } from '../store.js';
import type { AllowedScopeState, EvidenceRole } from '../../shared/research-case.js';
import {
  ContractViolation,
  TOOL_REGISTRY,
  assertNoPrivilegeFields,
  toolAllowedFor,
  type ActionReceiptView,
  type ContentMetadata,
  type CursorState,
  type Gap,
  type ProviderToolName,
  type ToolEnvelope,
  type ToolName,
  type ToolPhase,
  type ToolRole,
  type UsageSummary
} from './research-tool-contracts.js';

export type { AllowedScopeState } from '../../shared/research-case.js';
export type { UsageSummary } from './research-tool-contracts.js';

/* ------------------------------------------------------------------ */
/* Trusted context (server-injected)                                   */
/* ------------------------------------------------------------------ */

export interface TrustedAccount {
  accountId: string;
  platform: string;
  handle: string | null;
  allowedScope: AllowedScopeState;
}

export interface SkillPin {
  skillId: string;
  version: string;
  hash: string;
}

export interface CapabilityOperation {
  platform: string;
  operation: string;
  state: 'supported' | 'unsupported' | 'unverified';
  sortOptions: string[];
  dateRange: 'supported' | 'unsupported';
  maxDepth: number | null;
  limitation: string | null;
}

export interface CapabilitySnapshot {
  registryVersion: string;
  operations: CapabilityOperation[];
}

export interface TrustedContext {
  ownerId: string;
  caseId: string;
  role: ToolRole;
  phase: ToolPhase;
  /** Current authoritative scope version; never model-supplied. */
  scopeVersion: number;
  cancelled: boolean;
  accounts: TrustedAccount[];
  capabilities: CapabilitySnapshot;
  skillPins: SkillPin[];
  /** Only a trusted capability can authorize media OCR/transcription. */
  mediaConversionAuthorized?: boolean;
}

export interface ModelCall {
  tool: ToolName;
  /** Untrusted: strict schema, unknown keys and privilege fields refused. */
  input: unknown;
}

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

export class BudgetRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BudgetRefusedError';
  }
}

export class SettlementFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementFailureError';
  }
}

/** A request that never reached the provider; carries why it was stopped. */
export class RequestNotDispatchedError extends Error {
  constructor(readonly endpoint: string, readonly code: 'authority' | 'fail_stop' | 'budget', message: string) {
    super(message);
    this.name = 'RequestNotDispatchedError';
  }
}

/** Raised by a submission/controller port when its atomic commit refuses. */
export class SubmissionRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SubmissionRejectedError';
  }
}

/** A transport-level response whose endpoint status was not successful. */
export class ProviderHttpError extends Error {
  constructor(readonly status: number | null) {
    super(`provider endpoint returned status ${String(status)}`);
    this.name = 'ProviderHttpError';
  }
}

export interface MeteredRequestDescriptor {
  /** Logical endpoint id (never a URL), e.g. `exa.search`. */
  endpoint: string;
  note: string;
}

export interface RequestReservation {
  actionId: string;
  tool: ToolName;
  descriptor: MeteredRequestDescriptor;
}

export type ReserveRequest =
  | { kind: 'provider_request'; tool: ToolName; descriptor: MeteredRequestDescriptor }
  | { kind: 'provider_step'; tool: ToolName }
  | { kind: 'local_step'; tool: ToolName };

export interface RequestOutcome {
  state: 'completed' | 'failed' | 'unknown';
  estimatedUsd: number | null;
  credits: number | null;
  note: string;
}

/**
 * GET-78 seam: reserve -> execute -> settle for every actual underlying
 * request (failed, unknown and retries included). No persistent ledger is
 * created here; legacy ResearchStore run accounting is not case budgeting.
 * Without this port no billable dispatch happens.
 */
export interface AccountingPort {
  reserve(request: ReserveRequest): RequestReservation;
  settle(reservation: RequestReservation, outcome: RequestOutcome): void | Promise<void>;
  /** Optional cumulative usage; report_progress derives costs from receipts. */
  usage?(): UsageSummary;
}

export interface ProviderResponse {
  /** Endpoint status: non-2xx is a failed settled attempt, never a success. */
  status: number;
  body: unknown;
  /** Provider-reported fee; absent or null means unknown cost, never zero. */
  fee?: { estimatedUsd?: number | null; credits?: number | null } | null;
}

/** The single controlled transport. Handlers never receive raw fetch access. */
export interface ProviderExecutorPort {
  execute(reservation: RequestReservation, descriptor: MeteredRequestDescriptor, signal: AbortSignal): Promise<ProviderResponse>;
}

export interface MeteredRequestClient {
  /** The passed signal can only add cancellation; the dispatch signal always binds. */
  run(descriptor: MeteredRequestDescriptor, signal: AbortSignal): Promise<ProviderResponse>;
}

export interface CursorBinding {
  caseId: string;
  accountId: string | null;
  platform: string | null;
  tool: ToolName;
  endpoint: string;
  scopeVersion: number;
  sort: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** Full request identity: the target item (comments/media) or null. */
  itemId: string | null;
  /** Search query and discovery rules belong to the bound identity. */
  query: string | null;
  rules: string | null;
}

/** Trusted opaque cursor records; never model wrapper fields or JSON hashes. */
export interface CursorPort {
  issue(binding: CursorBinding, nativeCursor: string): string;
  resolve(token: string, binding: CursorBinding): string | null;
}

export interface SkillManifest {
  skillId: string;
  version: string;
  hash: string;
  body: string;
  dependencies: string[];
}

/** Audited local manifest catalog only; no arbitrary paths, no network. */
export interface SkillManifestPort {
  get(skillId: string, version: string): SkillManifest | null;
}

export interface EvidenceSourceMeta {
  author: string | null;
  originalUrl: string;
  publishedAt: string | null;
  retrievedAt: string;
  locator: string | null;
  contentHash: string;
}

export interface EvidenceView {
  evidenceId: string;
  caseId: string;
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  role: EvidenceRole;
  quote: string;
  quoteHash: string;
  locator: string | null;
  revokedAt: string | null;
  source: EvidenceSourceMeta;
}

export type EvidenceReadState = 'ok' | 'missing' | 'revoked' | 'revision_mismatch' | 'locator_mismatch';

export interface EvidenceReadResult {
  state: EvidenceReadState;
  evidence: EvidenceView | null;
  detail: string;
}

export interface EvidenceReadPort {
  readEvidence(req: {
    ownerId: string;
    caseId: string;
    evidenceId: string;
    sourceRevision?: number | null;
    locator?: string | null;
  }): EvidenceReadResult;
  readSourceRevision(req: {
    ownerId: string;
    caseId: string;
    accountId: string;
    sourceId: string;
    sourceRevision: number;
  }): EvidenceSourceMeta | null;
}

export type SourceAccessKind = 'profile' | 'history';

/**
 * Trusted source-access classifier seam. Classification never enters model
 * input. The default Store factory treats a pinned source whose originalUrl
 * exactly matches the real account.profileUrl as `profile`; every other or
 * unknown source is `history` and needs history permission (or an explicit
 * trusted classification). Unbound classification fails closed to `history`.
 */
export interface SourceAccessPort {
  classify(req: { ownerId: string; caseId: string; accountId: string; source: EvidenceSourceMeta }): SourceAccessKind;
}

export interface CaseStateSnapshot {
  scopeVersion: number;
  cancelled: boolean;
  accounts: { accountId: string; allowedScope: AllowedScopeState }[];
}

/** Fresh authorization reads current Store state, never the opening snapshot. */
export interface FreshStatePort {
  readCaseState(ownerId: string, caseId: string): CaseStateSnapshot | null;
  revokedEvidence(ownerId: string, caseId: string, evidenceIds: string[]): Record<string, boolean>;
}

export interface PendingFinding {
  kind: 'collected_finding' | 'verification_check';
  statement: string;
  supportEvidenceIds: string[];
  counterEvidenceIds: string[];
  coverageDelta: {
    locator: { accountId: string; sourceId: string; sourceRevision: number };
    taskRef: unknown;
    status: 'unseen' | 'evidence_found' | 'conflicting' | 'resolved_unknown' | 'blocked';
  }[];
  note: string | null;
}

/**
 * One commit = one finding. `accountIds` is the finding's own authorized
 * account set (sorted, empty = case-level); it is never inherited from another
 * finding and multi-account synthesis stays explicit.
 */
export interface PendingFindingCommit {
  ownerId: string;
  caseId: string;
  /** Scope version the finding was collected under. */
  expectedScopeVersion: number;
  accountIds: string[];
  finding: PendingFinding;
  dependencies: { evidenceId: string; sourceRevision: number }[];
}

/**
 * Constrained pending-only submission seam (GET-60 exposes no generic pending
 * store). Implementations must atomically compare owner/case/
 * expectedScopeVersion and evidence dependencies at the actual commit so the
 * post-check-to-write race cannot widen scope. It stages `pending` records
 * only and can never grant permissions. Unbound -> not_implemented.
 */
export interface SubmissionPort {
  stagePendingFinding(commit: PendingFindingCommit): Promise<{ pendingRef: string | null }>;
}

/**
 * Commit obligation shared by controller writes: the port must atomically
 * compare owner/case/expectedScopeVersion and dependencies at its actual
 * write and raise SubmissionRejectedError when they no longer hold. Controller
 * ports record candidates / intent / progress only; they can never grant
 * permissions, select accounts or prove identity.
 */
export interface ControllerCommitContext {
  ownerId: string;
  caseId: string;
  expectedScopeVersion: number;
  accountIds: string[];
  dependencies: { evidenceId: string; sourceRevision: number }[];
}

export interface ControllerPort {
  submitCandidates(input: { commit: ControllerCommitContext; candidates: unknown[]; note: string | null }): Promise<{ batchRef: string | null }>;
  requestConfirmation(input: { commit: ControllerCommitContext; question: string; options: unknown[]; note: string | null }): Promise<{ confirmationRef: string | null }>;
  /** Progress cost/budget always arrives derived from receipts. */
  reportProgress(input: { commit: ControllerCommitContext; note: string | null; gaps: string[]; usage: UsageSummary }): Promise<void>;
}

export interface HandlerContext {
  readonly input: unknown;
  readonly trusted: TrustedContext;
  /** Resolved native cursor for this page; binding is enforced by the port. */
  readonly cursor: { token: string | null; nativeCursor: string | null };
  /** The only way to reach a provider: metered, bounded, fail-stop. */
  readonly requests: MeteredRequestClient;
  readonly signal: AbortSignal;
}

export type ToolHandler = (ctx: HandlerContext) => Promise<unknown>;

export interface ResearchToolPorts {
  accounting?: AccountingPort | null;
  executor?: ProviderExecutorPort | null;
  cursors?: CursorPort | null;
  evidence?: EvidenceReadPort | null;
  sourceAccess?: SourceAccessPort | null;
  skills?: SkillManifestPort | null;
  submissions?: SubmissionPort | null;
  controller?: ControllerPort | null;
  /** Required: case authority fails closed when current state is unreadable. */
  state?: FreshStatePort | null;
  handlers?: Partial<Record<ProviderToolName, ToolHandler>>;
}

/* ------------------------------------------------------------------ */
/* In-memory trusted port implementations (opaque, server-side)         */
/* ------------------------------------------------------------------ */

export function createOpaqueCursorPort(): CursorPort {
  const records = new Map<string, { binding: string; nativeCursor: string }>();
  return {
    issue(binding, nativeCursor) {
      const token = `cur_${randomUUID()}`;
      records.set(token, { binding: JSON.stringify(binding), nativeCursor });
      return token;
    },
    resolve(token, binding) {
      const record = records.get(token);
      // Replaying a token under a different account/item/tool/endpoint/scope/
      // sort/date/query/rules window is refused: the binding is server-side.
      return record && record.binding === JSON.stringify(binding) ? record.nativeCursor : null;
    }
  };
}

export function createPinnedSkillManifestPort(manifests: readonly SkillManifest[]): SkillManifestPort {
  const catalog = manifests.map((m) => ({ ...m }));
  return {
    get(skillId, version) {
      return catalog.find((m) => m.skillId === skillId && m.version === version) ?? null;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Real CaseStore adapters (reusable production factories)              */
/* ------------------------------------------------------------------ */

const SUPPORT_ROLES: readonly EvidenceRole[] = ['identity_support', 'factual_support'];

export function rolePolarity(role: EvidenceRole): 'support' | 'counter' {
  return SUPPORT_ROLES.includes(role) ? 'support' : 'counter';
}

/**
 * Pinned-history policy: an EvidenceRef is pinned to the exact sourceRevision
 * captured with it. A newer SourceRevision of the same source never
 * auto-invalidates that immutable historical pin; read-back returns the pinned
 * revision's metadata verbatim. Only revocation (revokedAt) or a mismatched
 * request pin refuses the read.
 */
export function createCaseStoreEvidenceAdapter(store: Store): EvidenceReadPort {
  function findEvidence(ownerId: string, caseId: string, evidenceId: string) {
    const record = store.cases.getCase(ownerId, caseId);
    if (!record) return null;
    for (const account of store.cases.listAccounts(ownerId, caseId)) {
      const found = store.cases.getEvidence(ownerId, caseId, account.accountId, evidenceId);
      if (found) return found;
    }
    return null;
  }
  return {
    readEvidence(req) {
      const found = findEvidence(req.ownerId, req.caseId, req.evidenceId);
      if (!found) return { state: 'missing', evidence: null, detail: 'evidence not found in case' };
      if (found.revokedAt !== null) return { state: 'revoked', evidence: null, detail: 'evidence withdrawn' };
      if (req.sourceRevision != null && req.sourceRevision !== found.sourceRevision) {
        return { state: 'revision_mismatch', evidence: null, detail: 'request pin does not match the captured source revision' };
      }
      if (req.locator != null && req.locator !== found.locator) {
        return { state: 'locator_mismatch', evidence: null, detail: 'request locator does not match the captured locator' };
      }
      const revisions = store.cases.listSourceRevisions(req.ownerId, req.caseId, found.accountId, found.sourceId);
      const pinned = revisions.find((revision) => revision.sourceRevision === found.sourceRevision);
      if (!pinned) return { state: 'missing', evidence: null, detail: 'pinned source revision absent' };
      return {
        state: 'ok',
        detail: 'ok',
        evidence: {
          evidenceId: found.evidenceId,
          caseId: found.caseId,
          accountId: found.accountId,
          sourceId: found.sourceId,
          sourceRevision: found.sourceRevision,
          role: found.role,
          quote: found.quote,
          quoteHash: found.quoteHash,
          locator: found.locator,
          revokedAt: found.revokedAt,
          source: {
            author: pinned.author,
            originalUrl: pinned.originalUrl,
            publishedAt: pinned.publishedAt,
            retrievedAt: pinned.retrievedAt,
            locator: pinned.locator,
            contentHash: pinned.contentHash
          }
        }
      };
    },
    readSourceRevision(req) {
      const record = store.cases.getCase(req.ownerId, req.caseId);
      if (!record) return null;
      const account = store.cases.listAccounts(req.ownerId, req.caseId).find((a) => a.accountId === req.accountId);
      if (!account) return null;
      const pinned = store.cases
        .listSourceRevisions(req.ownerId, req.caseId, req.accountId, req.sourceId)
        .find((revision) => revision.sourceRevision === req.sourceRevision);
      if (!pinned) return null;
      return {
        author: pinned.author,
        originalUrl: pinned.originalUrl,
        publishedAt: pinned.publishedAt,
        retrievedAt: pinned.retrievedAt,
        locator: pinned.locator,
        contentHash: pinned.contentHash
      };
    }
  };
}

/** Fresh Store reads; cancellation state stays a trusted injected concern. */
export function createStoreFreshStatePort(store: Store): FreshStatePort {
  return {
    readCaseState(ownerId, caseId) {
      const record = store.cases.getCase(ownerId, caseId);
      if (!record) return null;
      return {
        scopeVersion: record.scopeVersion,
        cancelled: false,
        accounts: store.cases.listAccounts(ownerId, caseId).map((account) => ({
          accountId: account.accountId,
          allowedScope: account.allowedScope.state
        }))
      };
    },
    revokedEvidence(ownerId, caseId, evidenceIds) {
      const adapter = createCaseStoreEvidenceAdapter(store);
      const out: Record<string, boolean> = {};
      for (const evidenceId of evidenceIds) {
        out[evidenceId] = adapter.readEvidence({ ownerId, caseId, evidenceId }).state === 'revoked';
      }
      return out;
    }
  };
}

/**
 * Default trusted source classifier: a pinned source whose originalUrl exactly
 * matches the real CaseStore account.profileUrl is profile material; every
 * other or unknown source is history material. No schema/counter/ledger added.
 */
export function createStoreSourceAccessPort(store: Store): SourceAccessPort {
  return {
    classify({ ownerId, caseId, accountId, source }) {
      const account = store.cases.listAccounts(ownerId, caseId).find((entry) => entry.accountId === accountId);
      return account?.profileUrl && source.originalUrl === account.profileUrl ? 'profile' : 'history';
    }
  };
}

/* ------------------------------------------------------------------ */
/* Fee and usage normalization: invalid metering is unknown, never fake */
/* ------------------------------------------------------------------ */

function normalizeFee(raw: ProviderResponse['fee']): { estimatedUsd: number | null; credits: number | null; invalid: boolean } {
  const pick = (value: unknown): number | null | 'invalid' => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    return 'invalid';
  };
  const usd = pick(raw == null ? null : (raw as { estimatedUsd?: unknown }).estimatedUsd);
  const credits = pick(raw == null ? null : (raw as { credits?: unknown }).credits);
  return {
    estimatedUsd: usd === 'invalid' ? null : usd,
    credits: credits === 'invalid' ? null : credits,
    invalid: usd === 'invalid' || credits === 'invalid'
  };
}

function sanitizeUsage(raw: UsageSummary): UsageSummary {
  const count = (value: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
  const money = (value: number | null): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  return {
    providerRequests: count(raw.providerRequests),
    settledRequests: count(raw.settledRequests),
    unknownFeeRequests: count(raw.unknownFeeRequests),
    notDispatchedRequests: count(raw.notDispatchedRequests),
    localSteps: count(raw.localSteps),
    estimatedUsd: money(raw.estimatedUsd),
    credits: money(raw.credits),
    unaccounted: Boolean(raw.unaccounted)
  };
}

/* ------------------------------------------------------------------ */
/* Consolidated authority gate                                          */
/* ------------------------------------------------------------------ */

type SourceNeed = 'profile' | 'history';

interface AuthorityArgs {
  trusted: TrustedContext;
  ports: ResearchToolPorts;
  signal: AbortSignal;
  tool: ToolName;
}

interface AuthorityNeed {
  accountId?: string | null;
  need?: SourceNeed;
  evidenceIds?: string[];
}

/**
 * Single source of case authority: dispatch AbortSignal, fresh Store state
 * (fail closed when unreadable), cancellation, scope version, account slice
 * membership and current allowedScope, then evidence revocation. Used at
 * entry, after awaited step accounting, before every provider request, before
 * every local write and before returning usable content.
 */
function authorityRefusal(args: AuthorityArgs, needs: AuthorityNeed = {}): string | null {
  const { trusted, ports, signal, tool } = args;
  if (signal.aborted || trusted.cancelled) return 'cancelled before this action; no new execution is dispatched';
  if (!ports.state) return 'fresh state port unbound: current case authority cannot be verified';
  const current = ports.state.readCaseState(trusted.ownerId, trusted.caseId);
  if (!current) return 'case refused: unknown to current store state';
  if (current.cancelled) return 'cancelled in current store state';
  if (current.scopeVersion !== trusted.scopeVersion) return 'scope refused: trusted snapshot is stale against current store state';
  const accountId = needs.accountId ?? null;
  if (accountId) {
    const trustedAccount = trusted.accounts.find((entry) => entry.accountId === accountId);
    if (!trustedAccount) return 'account refused: unknown or foreign account for this case';
    const freshAccount = current.accounts.find((entry) => entry.accountId === accountId);
    const need: SourceNeed = needs.need ?? (HISTORY_TOOLS.includes(tool) ? 'history' : 'profile');
    const allowed: AllowedScopeState[] = need === 'history' ? ['public_history'] : ['profile_only', 'public_history'];
    // Both the injected slice permission and the current Store scope must
    // allow the read; the trusted snapshot never widens current state.
    const scopes = [trustedAccount.allowedScope, freshAccount?.allowedScope];
    if (!freshAccount || scopes.some((scope) => scope === undefined || !allowed.includes(scope))) {
      if (scopes.includes('none')) return 'scope refused: allowedScope none cannot read restricted content';
      return need === 'history'
        ? 'scope refused: profile_only cannot read history'
        : 'scope refused: current store state no longer permits this read';
    }
  }
  if (needs.evidenceIds && needs.evidenceIds.length > 0) {
    const revoked = ports.state.revokedEvidence(trusted.ownerId, trusted.caseId, needs.evidenceIds);
    if (Object.values(revoked).some(Boolean)) return 'evidence withdrawn: dependencies are no longer readable';
  }
  return null;
}

const HISTORY_TOOLS: readonly ToolName[] = ['list_posts', 'read_post', 'list_comments', 'read_thread', 'read_media'];
const LOCAL_WRITE_TOOLS: readonly ToolName[] = ['submit_candidates', 'request_confirmation', 'save_findings', 'report_progress'];

type EvidenceAccess = { ok: true; evidence: EvidenceView } | { ok: false; reason: string };

/** Central evidence authorization: slice + current scope + source class. */
function authorizeEvidenceRef(args: AuthorityArgs, ref: { evidenceId: string; sourceRevision?: number | null; locator?: string | null }): EvidenceAccess {
  const { trusted, ports } = args;
  if (!ports.evidence) return { ok: false, reason: 'evidence read port unbound: dependency verification cannot proceed' };
  const result = ports.evidence.readEvidence({
    ownerId: trusted.ownerId,
    caseId: trusted.caseId,
    evidenceId: ref.evidenceId,
    sourceRevision: ref.sourceRevision ?? null,
    locator: ref.locator ?? null
  });
  if (result.state !== 'ok' || !result.evidence) return { ok: false, reason: `evidence refused (${result.state}): ${result.detail}` };
  const found = result.evidence;
  const account = trusted.accounts.find((entry) => entry.accountId === found.accountId);
  const need: SourceNeed = account?.allowedScope === 'public_history'
    ? 'history'
    : ports.sourceAccess?.classify({ ownerId: trusted.ownerId, caseId: trusted.caseId, accountId: found.accountId, source: found.source }) ?? 'history';
  const refusal = authorityRefusal(args, { accountId: found.accountId, need, evidenceIds: [found.evidenceId] });
  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, evidence: found };
}

/* ------------------------------------------------------------------ */
/* Metered request execution: reserve -> execute -> settle               */
/* ------------------------------------------------------------------ */

type AuthorityGuard = (evidenceIds?: string[]) => string | null;

function notDispatchedAction(endpoint: string, note: string): ActionReceiptView {
  return { actionId: null, kind: 'not_dispatched', endpoint, state: 'not_dispatched', estimatedUsd: null, credits: null, note };
}

class MeteredClient implements MeteredRequestClient {
  executed = 0;
  failedAttempt = false;
  settleFailures = 0;
  constructor(
    private readonly tool: ToolName,
    private readonly maxRequests: number,
    private readonly accounting: AccountingPort,
    private readonly executor: ProviderExecutorPort,
    private readonly actions: ActionReceiptView[],
    private readonly gaps: Gap[],
    private readonly signal: AbortSignal,
    private readonly guard: AuthorityGuard
  ) {}

  async run(descriptor: MeteredRequestDescriptor, handlerSignal?: AbortSignal): Promise<ProviderResponse> {
    if (this.failedAttempt || this.executed >= this.maxRequests) {
      const note = this.failedAttempt ? 'fail-stop after an earlier failed or unreconciled attempt' : 'tool request budget exhausted';
      this.actions.push(notDispatchedAction(descriptor.endpoint, note));
      throw new RequestNotDispatchedError(descriptor.endpoint, 'fail_stop', `request not dispatched: ${note}`);
    }
    // Authority + the ORIGINAL dispatch signal before EVERY real provider
    // request. A handler-supplied signal can add cancellation, never bypass it.
    const refusal = this.signal.aborted || handlerSignal?.aborted
      ? 'cancelled before this action; no new execution is dispatched'
      : this.guard();
    if (refusal) {
      this.actions.push(notDispatchedAction(descriptor.endpoint, `authority refused: ${refusal}`));
      throw new RequestNotDispatchedError(descriptor.endpoint, 'authority', `request not dispatched: ${refusal}`);
    }
    let reservation: RequestReservation;
    try {
      reservation = this.accounting.reserve({ kind: 'provider_request', tool: this.tool, descriptor });
    } catch (error) {
      this.failedAttempt = true;
      this.actions.push(notDispatchedAction(descriptor.endpoint, error instanceof BudgetRefusedError ? `budget refused: ${error.code}` : 'reservation failed'));
      throw error;
    }
    this.executed += 1;
    let outcome: RequestOutcome = { state: 'unknown', estimatedUsd: null, credits: null, note: 'no outcome recorded' };
    let response: ProviderResponse | null = null;
    let failure: unknown = null;
    let httpFailure: ProviderHttpError | null = null;
    try {
      response = await this.executor.execute(reservation, descriptor, this.signal);
      const fee = normalizeFee(response?.fee);
      if (fee.invalid) {
        this.gaps.push({ code: 'invalid_fee', detail: `${descriptor.endpoint}: provider reported an invalid fee; treated as unknown` });
      }
      const status = response?.status;
      const httpOk = typeof status === 'number' && Number.isInteger(status) && status >= 200 && status < 300;
      if (httpOk) {
        outcome = { state: 'completed', estimatedUsd: fee.estimatedUsd, credits: fee.credits, note: fee.invalid ? 'executed; invalid fee treated as unknown' : 'executed' };
      } else {
        // Transport completed but the endpoint failed: a failed settled
        // attempt with honest fees that fail-stops later requests.
        this.failedAttempt = true;
        httpFailure = new ProviderHttpError(typeof status === 'number' ? status : null);
        outcome = {
          state: 'failed',
          estimatedUsd: fee.estimatedUsd,
          credits: fee.credits,
          note: `provider endpoint status ${String(status)}; ${fee.invalid ? 'invalid fee treated as unknown' : fee.estimatedUsd === null ? 'fee unknown' : 'valid reported fee kept'}`
        };
      }
    } catch (error) {
      failure = error;
      this.failedAttempt = true;
      outcome = { state: 'failed', estimatedUsd: null, credits: null, note: 'executor attempt failed; fee unknown' };
    }
    const action: ActionReceiptView = {
      actionId: reservation.actionId,
      kind: 'provider_request',
      endpoint: descriptor.endpoint,
      state: outcome.state,
      estimatedUsd: outcome.estimatedUsd,
      credits: outcome.credits,
      note: outcome.note
    };
    this.actions.push(action);
    try {
      await this.accounting.settle(reservation, outcome);
    } catch {
      // Settlement failure: fail-stop. Never re-execute the remote request and
      // never double-settle; the receipt stays unreconciled/unknown.
      this.failedAttempt = true;
      this.settleFailures += 1;
      action.state = 'unreconciled';
      action.note = 'settlement failed; usage unreconciled, request never repeated';
      this.gaps.push({ code: 'unreconciled', detail: 'accounting settlement failed after an executed request' });
      throw new SettlementFailureError('accounting settlement failed');
    }
    if (httpFailure !== null) throw httpFailure;
    if (failure !== null) throw failure;
    return response as ProviderResponse;
  }
}

/* ------------------------------------------------------------------ */
/* Envelope assembly                                                    */
/* ------------------------------------------------------------------ */

function deriveUsage(actions: ActionReceiptView[], accounting: AccountingPort | null | undefined): UsageSummary {
  const executed = actions.filter((a) => a.kind === 'provider_request' && a.state !== 'not_dispatched');
  const usage: UsageSummary = {
    providerRequests: executed.length,
    settledRequests: executed.filter((a) => a.state === 'completed' || a.state === 'failed' || a.state === 'unknown').length,
    unknownFeeRequests: executed.filter((a) => a.estimatedUsd === null).length,
    notDispatchedRequests: actions.filter((a) => a.state === 'not_dispatched').length,
    localSteps: actions.filter((a) => a.kind === 'local_step').length,
    estimatedUsd: 0,
    credits: 0,
    unaccounted: !accounting
  };
  let unknownUsd = false;
  let unknownCredits = false;
  for (const action of executed) {
    if (action.estimatedUsd === null) unknownUsd = true;
    if (action.credits === null) unknownCredits = true;
  }
  usage.estimatedUsd = unknownUsd ? null : executed.reduce((sum, a) => sum + (a.estimatedUsd ?? 0), 0);
  usage.credits = unknownCredits ? null : executed.reduce((sum, a) => sum + (a.credits ?? 0), 0);
  return sanitizeUsage(usage);
}

interface BuildContext {
  actions: ActionReceiptView[];
  gaps: Gap[];
  staged: boolean;
  /** Receipt-derived cumulative usage for report_progress only. */
  usageOverride?: UsageSummary;
}

function envelope(
  tool: ToolName,
  status: ToolEnvelope['status'],
  reason: string | null,
  content: unknown,
  cursor: CursorState,
  build: BuildContext,
  ports: ResearchToolPorts
): ToolEnvelope {
  return {
    tool,
    status,
    // Adapter diagnostics may be arbitrarily long; keep the envelope valid
    // without discarding executed-request or accepted-write receipts.
    reason: reason !== null && reason.length > 2000 ? `${reason.slice(0, 1987)}… [truncated]` : reason,
    content,
    cursor,
    gaps: build.gaps,
    actions: build.actions,
    usage: build.usageOverride ?? deriveUsage(build.actions, ports.accounting),
    staged: build.staged
  };
}

function metadataOf(value: unknown): ContentMetadata | null {
  if (typeof value !== 'object' || value === null) return null;
  const meta = (value as Record<string, unknown>).metadata;
  if (typeof meta !== 'object' || meta === null) return null;
  return meta as ContentMetadata;
}

/** Semantic output checks: request subject, locator binding and honesty rules. */
function semanticViolation(tool: ToolName, trusted: TrustedContext, input: Record<string, unknown>, output: Record<string, unknown>): string | null {
  const requireApplicable = (item: unknown, label: string): string | null => {
    const meta = metadataOf(item);
    if (!meta || meta.applicable !== true) return `${label}: applicable content metadata required`;
    return null;
  };
  const subjectRole = (item: Record<string, unknown>, subjectId: string): string | null => {
    const isSubject = item.authorAccountId === subjectId;
    const role = item.authorRole;
    if (isSubject && role !== 'subject') return `${String(item.nodeId ?? item.commentId)}: subject author declared as ${String(role)}`;
    if (!isSubject && role === 'subject') return `${String(item.nodeId ?? item.commentId)}: foreign author declared as subject`;
    return null;
  };
  switch (tool) {
    case 'discover_accounts': {
      const status = output.discoveryStatus;
      const stopReason = output.stopReason;
      if (status === 'checked_no_match' && typeof stopReason === 'string' && stopReason.length > 0) {
        return 'an interrupted/timeout discovery can never report checked_no_match';
      }
      const items = output.items as unknown[];
      for (let i = 0; i < items.length; i += 1) {
        const violation = requireApplicable(items[i], `items[${i}]`);
        if (violation) return violation;
      }
      return null;
    }
    case 'read_profile':
    case 'search_web': {
      const items = output.items as unknown[];
      for (let i = 0; i < items.length; i += 1) {
        const violation = requireApplicable(items[i], `items[${i}]`);
        if (violation) return violation;
      }
      return null;
    }
    case 'list_posts': {
      const subjectId = input.accountId as string;
      const items = output.items as Record<string, unknown>[];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] as Record<string, unknown>;
        if (item.authorAccountId !== subjectId) return `items[${i}]: post bound to a foreign account`;
        const violation = requireApplicable(item, `items[${i}]`);
        if (violation) return violation;
      }
      return null;
    }
    case 'read_post': {
      const subjectId = input.accountId as string;
      const item = output.item as Record<string, unknown>;
      if (item.itemId !== input.itemId) return 'item: substituted target locator';
      if (item.authorAccountId !== subjectId) return 'item: post bound to a foreign account';
      return requireApplicable(item, 'item');
    }
    case 'list_comments': {
      const subjectId = input.accountId as string;
      const items = output.items as Record<string, unknown>[];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] as Record<string, unknown>;
        // Third-party comment authors stay legitimate and preserved.
        if (item.rootItemId !== input.itemId) return `items[${i}]: comment bound to a foreign item locator`;
        const violation = subjectRole(item, subjectId) ?? requireApplicable(item, `items[${i}]`);
        if (violation) return violation;
      }
      return null;
    }
    case 'read_thread': {
      const subjectId = input.accountId as string;
      const nodes = output.nodes as Record<string, unknown>[];
      const missingNodeIds = output.missingNodeIds as string[];
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i] as Record<string, unknown>;
        // The root/parent relationships must belong to the requested thread;
        // third-party authors and missing nodes inside it stay legitimate.
        if (node.rootNodeId !== input.itemId) return `nodes[${i}]: thread node bound to a foreign root locator`;
        const text = node.text;
        const reason = node.textUnavailableReason;
        if (text === null || text === undefined) {
          if (typeof reason !== 'string' || reason.length === 0) return `nodes[${i}]: unread node text requires an explicit reason`;
        } else {
          if (node.state !== 'present') return `nodes[${i}]: only present nodes can carry readable text`;
          if (reason !== null) return `nodes[${i}]: readable text cannot also declare an unavailability reason`;
        }
        const violation = subjectRole(node, subjectId) ?? requireApplicable(node, `nodes[${i}]`);
        if (violation) return violation;
      }
      const parentRef = (input.parentRef as string | null | undefined) ?? null;
      if (parentRef !== null && !nodes.some((node) => (node as Record<string, unknown>).nodeId === parentRef) && !missingNodeIds.includes(parentRef)) {
        return 'thread output omits the requested parentRef node';
      }
      return null;
    }
    case 'read_media': {
      if (output.mediaRef !== input.mediaRef) return 'media: substituted target locator';
      const unread = output.mediaUnread === true;
      const conversion = output.conversion as Record<string, unknown>;
      if (unread && (output.text !== null || output.captions !== null || conversion.state !== 'not_attempted')) {
        return 'unread media cannot carry text, captions or conversions';
      }
      if (conversion.state !== 'not_attempted') {
        if (conversion.authorized !== true || trusted.mediaConversionAuthorized !== true) {
          return 'media conversion requires explicit trusted authorization';
        }
      }
      return requireApplicable(output, 'media');
    }
    case 'read_evidence': {
      const requested = (input.evidence as { evidenceId: string; sourceRevision?: number | null }[]) ?? [];
      const items = output.items as Record<string, unknown>[];
      if (items.length !== requested.length) return 'evidence read-back must return exactly the requested references';
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] as Record<string, unknown>;
        const ref = requested[i] as { evidenceId: string; sourceRevision?: number | null };
        if (item.evidenceId !== ref.evidenceId) return `items[${i}]: substituted evidence reference`;
        if (ref.sourceRevision != null && item.sourceRevision !== ref.sourceRevision) return `items[${i}]: substituted source revision`;
        const violation = requireApplicable(item, `items[${i}]`);
        if (violation) return violation;
      }
      return null;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Capability and cursor gates                                          */
/* ------------------------------------------------------------------ */

/** Tools whose operations carry sort/date/depth capability semantics. */
const CAPABILITY_GATED: readonly ToolName[] = ['list_posts', 'list_comments', 'read_thread', 'search_web', 'discover_accounts'];

function capabilityFor(trusted: TrustedContext, platform: string, operation: string): CapabilityOperation | null {
  return trusted.capabilities.operations.find((entry) => entry.platform === platform && entry.operation === operation) ?? null;
}

function capabilityRefusal(
  tool: ToolName,
  trusted: TrustedContext,
  input: Record<string, unknown>,
  account: TrustedAccount | null
): { status: ToolEnvelope['status']; reason: string } | null {
  const platform = account ? account.platform : (input.platform as string | undefined) ?? (tool === 'search_web' ? '*' : null);
  const entry = platform ? capabilityFor(trusted, platform, tool) : null;
  if (entry && entry.state === 'unsupported') {
    return { status: 'not_applicable', reason: `capability refused: ${tool} unsupported for ${platform}` };
  }
  if (!CAPABILITY_GATED.includes(tool)) return null;
  // Capability-constrained operations need a supported trusted record; a
  // catalog entry, an unverified record or a bare sortOptions array is never
  // capability confirmation. No record fails closed.
  if (!entry) return { status: 'blocked', reason: `capability refused: no trusted capability record for ${tool} on ${String(platform)}` };
  if (entry.state !== 'supported') {
    return { status: 'blocked', reason: `capability refused: ${tool} capability is ${entry.state}, not confirmed supported` };
  }
  const sort = input.sort as string | null | undefined;
  if (sort != null && !entry.sortOptions.includes(sort)) {
    return { status: 'blocked', reason: `capability refused: sort ${sort} is not confirmed for ${tool}` };
  }
  if ((input.dateFrom != null || input.dateTo != null) && entry.dateRange !== 'supported') {
    return { status: 'blocked', reason: `capability refused: date windows are not confirmed for ${tool}` };
  }
  const depth = input.depth as number | null | undefined;
  if (depth != null && (entry.maxDepth === null || depth > entry.maxDepth)) {
    return { status: 'blocked', reason: `capability refused: depth ${depth} exceeds the confirmed maxDepth` };
  }
  return null;
}

function cursorBindingFor(trusted: TrustedContext, name: ToolName, input: Record<string, unknown>, account: TrustedAccount | null): CursorBinding {
  return {
    caseId: trusted.caseId,
    accountId: account ? account.accountId : null,
    platform: account ? account.platform : (input.platform as string | undefined) ?? (name === 'search_web' ? '*' : null),
    tool: name,
    endpoint: name,
    scopeVersion: trusted.scopeVersion,
    sort: (input.sort as string | null | undefined) ?? null,
    dateFrom: (input.dateFrom as string | null | undefined) ?? null,
    dateTo: (input.dateTo as string | null | undefined) ?? null,
    itemId: (input.itemId as string | null | undefined) ?? null,
    query: (input.query as string | null | undefined) ?? null,
    rules: (input.rules as string | null | undefined) ?? null
  };
}

/* ------------------------------------------------------------------ */
/* Built-in local tool semantics                                       */
/* ------------------------------------------------------------------ */

interface LocalResult {
  status: ToolEnvelope['status'];
  reason: string | null;
  content: unknown;
  staged?: boolean;
}

async function runLocalTool(
  name: ToolName,
  args: AuthorityArgs,
  input: Record<string, unknown>,
  ports: ResearchToolPorts,
  build: BuildContext,
  gate: AuthorityGuard
): Promise<LocalResult> {
  const trusted = args.trusted;
  switch (name) {
    case 'get_platform_capabilities': {
      const platform = input.platform as string;
      const operations = trusted.capabilities.operations.filter((entry) => entry.platform === platform);
      if (operations.length === 0) {
        return { status: 'not_applicable', reason: 'platform is not in the frozen capability registry', content: null };
      }
      return {
        status: 'success',
        reason: null,
        content: {
          registryVersion: trusted.capabilities.registryVersion,
          platform,
          operations: operations.map((entry) => ({
            operation: entry.operation,
            state: entry.state,
            sortOptions: entry.sortOptions,
            dateRange: entry.dateRange,
            maxDepth: entry.maxDepth,
            limitation: entry.limitation,
            metadata: { applicable: false, reason: 'catalog_entry' }
          }))
        }
      };
    }
    case 'read_evidence': {
      const refs = input.evidence as { evidenceId: string; sourceRevision?: number | null; locator?: string | null }[];
      const items: unknown[] = [];
      for (const ref of refs) {
        const access = authorizeEvidenceRef(args, ref);
        if (!access.ok) return { status: 'blocked', reason: access.reason, content: null };
        const found = access.evidence;
        items.push({
          evidenceId: found.evidenceId,
          sourceId: found.sourceId,
          sourceRevision: found.sourceRevision,
          role: found.role,
          quote: found.quote,
          quoteHash: found.quoteHash,
          metadata: {
            applicable: true,
            author: found.source.author,
            originalUrl: found.source.originalUrl,
            publishedAt: found.source.publishedAt,
            retrievedAt: found.source.retrievedAt,
            sourceRevision: found.sourceRevision,
            locator: found.source.locator ?? found.locator
          }
        });
      }
      return { status: 'success', reason: null, content: { items } };
    }
    case 'load_skill': {
      const skills = ports.skills;
      if (!skills) return { status: 'not_implemented', reason: 'skill manifest port unbound', content: null };
      const pin = { skillId: input.skillId as string, version: input.version as string, hash: input.hash as string };
      const trustedPin = trusted.skillPins.find((entry) => entry.skillId === pin.skillId);
      if (!trustedPin || trustedPin.version !== pin.version || trustedPin.hash !== pin.hash) {
        return { status: 'blocked', reason: 'skill refused: request does not match the pinned skill id/version/hash', content: null };
      }
      const manifest = skills.get(pin.skillId, pin.version);
      if (!manifest) return { status: 'not_applicable', reason: 'skill is not in the audited local manifest catalog', content: null };
      if (manifest.hash !== pin.hash) return { status: 'blocked', reason: 'skill refused: manifest hash does not match the pinned hash', content: null };
      return {
        status: 'success',
        reason: null,
        content: {
          skillId: manifest.skillId,
          version: manifest.version,
          hash: manifest.hash,
          body: manifest.body,
          dependencies: manifest.dependencies,
          metadata: { applicable: false, reason: 'local_skill' }
        }
      };
    }
    case 'submit_candidates': {
      const controller = ports.controller;
      if (!controller) return { status: 'not_implemented', reason: 'controller submission port unbound', content: null };
      const candidates = input.candidates as { candidateRef: string; supportEvidenceIds: string[]; counterEvidenceIds: string[] }[];
      const references = candidates.flatMap((candidate) => [
        ...candidate.supportEvidenceIds.map((evidenceId) => ({ evidenceId, polarity: 'support' as const })),
        ...candidate.counterEvidenceIds.map((evidenceId) => ({ evidenceId, polarity: 'counter' as const }))
      ]);
      // Candidate IDs with dependencies can never be accepted unverified.
      if (references.length > 0 && !ports.evidence) {
        return { status: 'blocked', reason: 'candidate evidence refused: evidence read port unbound, dependencies cannot be verified', content: null };
      }
      const dependencies: { evidenceId: string; sourceRevision: number }[] = [];
      const accountIds = new Set<string>();
      for (const ref of references) {
        const access = authorizeEvidenceRef(args, { evidenceId: ref.evidenceId });
        if (!access.ok) return { status: 'blocked', reason: `candidate evidence refused: ${access.reason}`, content: null };
        if (rolePolarity(access.evidence.role) !== ref.polarity) {
          return { status: 'blocked', reason: 'candidate evidence refused: support/counter role mismatch', content: null };
        }
        dependencies.push({ evidenceId: ref.evidenceId, sourceRevision: access.evidence.sourceRevision });
        accountIds.add(access.evidence.accountId);
      }
      // Fresh gate immediately before the side effect: a write never happens
      // under stale scope, withdrawal or cancellation.
      const late = gate([...new Set(dependencies.map((dep) => dep.evidenceId))]);
      if (late) return { status: 'blocked', reason: late, content: null };
      try {
        const result = await controller.submitCandidates({
          commit: {
            ownerId: trusted.ownerId,
            caseId: trusted.caseId,
            expectedScopeVersion: trusted.scopeVersion,
            accountIds: [...accountIds].sort(),
            dependencies
          },
          candidates,
          note: (input.note as string | null | undefined) ?? null
        });
        // Recording candidates never proves identity and never selects accounts.
        return {
          status: 'success',
          reason: null,
          content: {
            batchRef: result.batchRef,
            acceptedCount: candidates.length,
            note: (input.note as string | null | undefined) ?? null,
            metadata: { applicable: false, reason: 'controller_ack' }
          }
        };
      } catch (error) {
        if (error instanceof SubmissionRejectedError) return { status: 'blocked', reason: `commit refused: ${error.code}`, content: null };
        build.gaps.push({ code: 'commit_outcome_unknown', detail: 'controller port failed unexpectedly; the candidate write outcome is unknown' });
        return { status: 'failed', reason: 'controller port failed unexpectedly; write outcome unknown', content: null };
      }
    }
    case 'request_confirmation': {
      const controller = ports.controller;
      if (!controller) return { status: 'not_implemented', reason: 'controller submission port unbound', content: null };
      const question = input.question as string;
      const options = input.options as unknown[];
      const late = gate();
      if (late) return { status: 'blocked', reason: late, content: null };
      try {
        const result = await controller.requestConfirmation({
          commit: {
            ownerId: trusted.ownerId,
            caseId: trusted.caseId,
            expectedScopeVersion: trusted.scopeVersion,
            accountIds: [],
            dependencies: []
          },
          question,
          options,
          note: (input.note as string | null | undefined) ?? null
        });
        return {
          status: 'success',
          reason: null,
          content: {
            confirmationRef: result.confirmationRef,
            question,
            options,
            selectionSemantics: 'records_intent_only',
            metadata: { applicable: false, reason: 'controller_ack' }
          }
        };
      } catch (error) {
        if (error instanceof SubmissionRejectedError) return { status: 'blocked', reason: `commit refused: ${error.code}`, content: null };
        build.gaps.push({ code: 'commit_outcome_unknown', detail: 'controller port failed unexpectedly; the confirmation write outcome is unknown' });
        return { status: 'failed', reason: 'controller port failed unexpectedly; write outcome unknown', content: null };
      }
    }
    case 'save_findings': {
      const submissions = ports.submissions;
      if (!submissions) return { status: 'not_implemented', reason: 'pending submission port unbound', content: null };
      const findings = input.findings as {
        kind: 'collected_finding' | 'verification_check';
        statement: string;
        supportEvidenceIds: string[];
        counterEvidenceIds: string[];
        coverageDelta?: { locator: { accountId: string; sourceId: string; sourceRevision: number }; taskRef: unknown; status: PendingFinding['coverageDelta'][number]['status'] }[];
        note?: string | null;
      }[];
      const commits: PendingFindingCommit[] = [];
      const allDependencyIds: string[] = [];
      for (const finding of findings) {
        if (trusted.phase === 'verify' && finding.kind !== 'verification_check') {
          return { status: 'blocked', reason: 'verify phase refused: only checks against existing evidence may be submitted', content: null };
        }
        if (trusted.phase === 'verify' && finding.coverageDelta && finding.coverageDelta.length > 0) {
          return { status: 'blocked', reason: 'verify phase refused: new sources, bodies or coverage cannot enter verification findings', content: null };
        }
        const dependencies: { evidenceId: string; sourceRevision: number }[] = [];
        // Each finding derives its own authorized account set; multi-account
        // synthesis is explicit and never inherited from the first dependency.
        const accountIds = new Set<string>();
        for (const [ids, polarity] of [[finding.supportEvidenceIds, 'support'], [finding.counterEvidenceIds, 'counter']] as const) {
          for (const evidenceId of ids) {
            const access = authorizeEvidenceRef(args, { evidenceId });
            if (!access.ok) return { status: 'blocked', reason: `finding evidence refused: ${access.reason}`, content: null };
            if (rolePolarity(access.evidence.role) !== polarity) {
              return { status: 'blocked', reason: 'finding evidence refused: support/counter role mismatch', content: null };
            }
            dependencies.push({ evidenceId, sourceRevision: access.evidence.sourceRevision });
            accountIds.add(access.evidence.accountId);
            allDependencyIds.push(evidenceId);
          }
        }
        for (const delta of finding.coverageDelta ?? []) {
          const refusal = authorityRefusal(args, { accountId: delta.locator.accountId, need: 'history' });
          if (refusal) return { status: 'blocked', reason: `coverage refused: ${refusal}`, content: null };
          const source = ports.evidence?.readSourceRevision({
            ownerId: trusted.ownerId,
            caseId: trusted.caseId,
            accountId: delta.locator.accountId,
            sourceId: delta.locator.sourceId,
            sourceRevision: delta.locator.sourceRevision
          });
          if (!source) {
            return { status: 'blocked', reason: 'coverage refused: unknown source revision locator', content: null };
          }
          accountIds.add(delta.locator.accountId);
        }
        commits.push({
          ownerId: trusted.ownerId,
          caseId: trusted.caseId,
          expectedScopeVersion: trusted.scopeVersion,
          accountIds: [...accountIds].sort(),
          finding: {
            kind: finding.kind,
            statement: finding.statement,
            supportEvidenceIds: finding.supportEvidenceIds,
            counterEvidenceIds: finding.counterEvidenceIds,
            coverageDelta: finding.coverageDelta ?? [],
            note: finding.note ?? null
          },
          dependencies
        });
      }
      // Fresh gate before any staging: stale results never write.
      const late = gate([...new Set(allDependencyIds)]);
      if (late) return { status: 'blocked', reason: late, content: null };
      const submitted: { pendingRef: string | null; findingKind: 'collected_finding' | 'verification_check'; accountIds: string[]; dependencyEvidenceIds: string[] }[] = [];
      const notSubmitted: { index: number; reason: string }[] = [];
      for (let index = 0; index < commits.length; index += 1) {
        const commit = commits[index]!;
        if (notSubmitted.length > 0) {
          notSubmitted.push({ index, reason: 'not attempted after an earlier refusal; no automatic whole-batch retry' });
          continue;
        }
        // A preceding commit awaited external work: check the original signal
        // and fresh authority again before starting this independent write.
        let refusal = gate(commit.dependencies.map((dependency) => dependency.evidenceId));
        for (const dependency of commit.dependencies) {
          if (refusal) break;
          const access = authorizeEvidenceRef(args, dependency);
          if (!access.ok) refusal = access.reason;
        }
        for (const delta of commit.finding.coverageDelta) {
          if (refusal) break;
          refusal = authorityRefusal(args, { accountId: delta.locator.accountId, need: 'history' });
        }
        if (refusal) {
          notSubmitted.push({ index, reason: refusal });
          continue;
        }
        // The port must atomically compare owner/case/expectedScopeVersion and
        // dependencies at this actual commit, closing the check-to-write race.
        try {
          const staged = await submissions.stagePendingFinding(commit);
          submitted.push({
            pendingRef: staged.pendingRef,
            findingKind: commit.finding.kind,
            accountIds: commit.accountIds,
            dependencyEvidenceIds: commit.dependencies.map((dep) => dep.evidenceId)
          });
        } catch (error) {
          if (error instanceof SubmissionRejectedError) {
            notSubmitted.push({ index, reason: `commit refused: ${error.code}` });
            continue;
          }
          // The port failed after possibly writing: outcome unknown, never
          // denied and never retried into a duplicate.
          build.gaps.push({ code: 'commit_outcome_unknown', detail: `finding ${index}: submission port failed unexpectedly; the commit outcome is unknown` });
          notSubmitted.push({ index, reason: 'commit outcome unknown: submission port failed unexpectedly' });
        }
      }
      const content = {
        status: 'pending' as const,
        submitted,
        notSubmitted,
        metadata: { applicable: false, reason: 'submission_ack' }
      };
      if (submitted.length === 0) {
        const reason = notSubmitted[0]?.reason ?? 'nothing submitted';
        return {
          status: reason.startsWith('commit outcome unknown') ? 'failed' : 'blocked',
          reason,
          content: null,
          staged: false
        };
      }
      if (notSubmitted.length > 0) {
        // Truthful partial receipt: the accepted pending refs stay visible.
        return {
          status: 'partial',
          reason: `partial submission: ${submitted.length} accepted, ${notSubmitted.length} not submitted (${notSubmitted[0]!.reason})`,
          content,
          staged: true
        };
      }
      return { status: 'success', reason: null, content, staged: true };
    }
    case 'report_progress': {
      // Budget/cost is derived from receipts; model assertions were refused.
      const usage = ports.accounting?.usage ? sanitizeUsage(ports.accounting.usage()) : deriveUsage(build.actions, ports.accounting);
      build.usageOverride = usage;
      const gaps = (input.gaps as string[] | undefined) ?? [];
      const note = (input.note as string | null | undefined) ?? null;
      const controller = ports.controller;
      if (controller) {
        const late = gate();
        if (late) return { status: 'blocked', reason: late, content: null };
        try {
          await controller.reportProgress({
            commit: {
              ownerId: trusted.ownerId,
              caseId: trusted.caseId,
              expectedScopeVersion: trusted.scopeVersion,
              accountIds: [],
              dependencies: []
            },
            note,
            gaps,
            usage
          });
        } catch (error) {
          if (error instanceof SubmissionRejectedError) return { status: 'blocked', reason: `commit refused: ${error.code}`, content: null };
          build.gaps.push({ code: 'commit_outcome_unknown', detail: 'controller port failed unexpectedly; the progress write outcome is unknown' });
          return { status: 'failed', reason: 'controller port failed unexpectedly; write outcome unknown', content: null };
        }
      }
      return {
        status: 'success',
        reason: null,
        content: {
          recorded: Boolean(controller),
          gaps,
          note,
          metadata: { applicable: false, reason: 'progress_receipt' }
        }
      };
    }
    default:
      return { status: 'not_implemented', reason: 'no local implementation', content: null };
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Production dispatcher. Every path returns a schema-valid envelope (except an
 * unknown tool name, which cannot be discriminated and throws
 * ContractViolation).
 */
export async function dispatch(
  trustedContext: TrustedContext,
  modelCall: ModelCall,
  ports: ResearchToolPorts,
  signal: AbortSignal
): Promise<ToolEnvelope> {
  const trusted = trustedContext;
  const build: BuildContext = { actions: [], gaps: [], staged: false };
  const name = modelCall?.tool as ToolName;
  const contract = TOOL_REGISTRY[name];
  if (!contract) throw new ContractViolation('unknown_tool', `unknown tool ${String(modelCall?.tool)}`);
  const args: AuthorityArgs = { trusted, ports, signal, tool: name };

  // 1. Untrusted input: privilege scan, then strict schema (own keys only).
  let input: Record<string, unknown>;
  try {
    assertNoPrivilegeFields(modelCall.input);
    input = contract.input(modelCall.input, 'input') as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof ContractViolation ? `${error.code}: ${error.message}` : 'invalid input';
    return envelope(name, 'blocked', `input refused (${detail})`, null, { token: null, nativeCursor: null }, build, ports);
  }

  // 2. Role x phase matrix (verify is a Fetch phase, not a third role).
  if (!toolAllowedFor(name, trusted.role, trusted.phase)) {
    return envelope(name, 'blocked', `role/phase refused: ${name} is not allowed for role ${trusted.role} phase ${trusted.phase}`, null, { token: null, nativeCursor: null }, build, ports);
  }

  // 3. Consolidated entry authority: fresh Store state is mandatory, the
  // trusted snapshot alone never authorizes. Request subjects must already
  // belong to the trusted account slice.
  const contractAccount = contract.requiresAccount ? trusted.accounts.find((entry) => entry.accountId === input.accountId) ?? null : null;
  const entryRefusal = authorityRefusal(args, {
    accountId: contract.requiresAccount ? (input.accountId as string) : null,
    evidenceIds: collectEvidenceIds(name, input)
  });
  if (entryRefusal) {
    const status: ToolEnvelope['status'] = ports.state ? 'blocked' : 'not_implemented';
    return envelope(name, status, entryRefusal, null, { token: null, nativeCursor: null }, build, ports);
  }
  const account = contractAccount;

  // 4. Trusted capability gates for sort/date/depth before any handler call.
  const capability = capabilityRefusal(name, trusted, input, account);
  if (capability) return envelope(name, capability.status, capability.reason, null, { token: null, nativeCursor: null }, build, ports);

  // 5. Cursor binding from trusted opaque records, never model wrappers.
  let cursorToken: string | null = null;
  let nativeCursor: string | null = null;
  const requestedCursor = (input.cursor as string | null | undefined) ?? null;
  if (contract.usesCursor && requestedCursor !== null) {
    if (!ports.cursors) {
      return envelope(name, 'not_implemented', 'cursor validation port unbound', null, { token: null, nativeCursor: null }, build, ports);
    }
    const binding = cursorBindingFor(trusted, name, input, account);
    nativeCursor = ports.cursors.resolve(requestedCursor, binding);
    if (nativeCursor === null) {
      return envelope(name, 'blocked', 'cursor refused: replay across account/tool/endpoint/item/scope/sort/date/query window', null, { token: null, nativeCursor: null }, build, ports);
    }
    cursorToken = requestedCursor;
  }

  // 6. Port and handler wiring: unwired work is not_implemented, never hidden.
  const isProvider = contract.billing === 'provider';
  const handler = isProvider ? ports.handlers?.[name as ProviderToolName] ?? null : null;
  if (isProvider && !handler) {
    return envelope(name, 'not_implemented', 'provider handler not wired', null, { token: null, nativeCursor: null }, build, ports);
  }
  if (isProvider && !ports.accounting) {
    return envelope(name, 'not_implemented', 'no accounting port means no billable dispatch', null, { token: null, nativeCursor: null }, build, ports);
  }
  if (isProvider && !ports.executor) {
    return envelope(name, 'not_implemented', 'controlled request executor not wired', null, { token: null, nativeCursor: null }, build, ports);
  }

  // 7. Budget gate: a refused reservation means zero handler calls. Local
  // steps keep step/context accounting even with zero provider requests.
  const stepKind: 'provider_step' | 'local_step' = isProvider ? 'provider_step' : 'local_step';
  if (ports.accounting) {
    let stepReservation: RequestReservation;
    try {
      stepReservation = ports.accounting.reserve({ kind: stepKind, tool: name });
    } catch (error) {
      const code = error instanceof BudgetRefusedError ? error.code : 'reserve_failed';
      return envelope(name, 'blocked', `budget refused: ${code}`, null, { token: null, nativeCursor: null }, build, ports);
    }
    const stepAction: ActionReceiptView = {
      actionId: stepReservation.actionId,
      kind: stepKind,
      endpoint: name,
      state: 'completed',
      estimatedUsd: 0,
      credits: 0,
      note: 'tool step accounted'
    };
    build.actions.push(stepAction);
    try {
      await ports.accounting.settle(stepReservation, { state: 'completed', estimatedUsd: 0, credits: 0, note: 'tool step' });
    } catch {
      stepAction.state = 'unreconciled';
      stepAction.note = 'step settlement failed; usage unreconciled';
      build.gaps.push({ code: 'unreconciled', detail: 'accounting settlement failed before execution' });
      return envelope(name, 'failed', 'settlement failed: usage unreconciled, further execution and staging stopped', null, { token: null, nativeCursor: null }, build, ports);
    }
    // Authority is re-checked after the awaited step accounting: a scope
    // change, withdrawal or cancellation there stops all new execution.
    const afterStep = authorityRefusal(args, { accountId: account?.accountId ?? null });
    if (afterStep) {
      return envelope(name, 'blocked', afterStep, null, { token: null, nativeCursor: null }, build, ports);
    }
  }

  const gate: AuthorityGuard = (evidenceIds) => authorityRefusal(args, { accountId: account?.accountId ?? null, evidenceIds });

  // 8. Execute: built-in local semantics or the metered provider handler.
  let output: unknown = null;
  let failureReason: string | null = null;
  let settlementFailed = false;
  let midFlightRefusal: string | null = null;
  let localPartial: string | null = null;
  if (isProvider) {
    const client = new MeteredClient(
      name,
      contract.providerRequests.max,
      ports.accounting as AccountingPort,
      ports.executor as ProviderExecutorPort,
      build.actions,
      build.gaps,
      signal,
      gate
    );
    try {
      output = await (handler as ToolHandler)({
        input,
        trusted,
        cursor: { token: cursorToken, nativeCursor },
        requests: client,
        signal
      });
    } catch (error) {
      if (error instanceof SettlementFailureError) {
        failureReason = 'settlement failed: usage unreconciled, further execution and staging stopped';
      } else if (error instanceof RequestNotDispatchedError && error.code === 'authority') {
        midFlightRefusal = error.message;
      } else if (error instanceof RequestNotDispatchedError) {
        failureReason = 'request not dispatched after fail-stop or budget exhaustion';
      } else if (error instanceof BudgetRefusedError) {
        failureReason = `budget refused mid-call: ${error.code}`;
      } else if (error instanceof ProviderHttpError) {
        failureReason = `provider endpoint failed with status ${String(error.status)}; earlier results stay settled`;
      } else {
        failureReason = `handler failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      }
    }
    // A handler may swallow the settlement error; the dispatch still fail-stops.
    if (client.settleFailures > 0) {
      settlementFailed = true;
      failureReason = 'settlement failed: usage unreconciled, further execution and staging stopped';
    }
    if (!failureReason && !midFlightRefusal && client.executed < contract.providerRequests.min) {
      failureReason = `request count violation: expected at least ${contract.providerRequests.min} underlying request(s)`;
    }
    if (!failureReason && !midFlightRefusal && client.executed > contract.providerRequests.max) {
      failureReason = `request count violation: expected at most ${contract.providerRequests.max} underlying request(s)`;
    }
  } else {
    try {
      const result = await runLocalTool(name, args, input, ports, build, gate);
      if (result.status !== 'success' && result.status !== 'partial') {
        return envelope(name, result.status, result.reason, null, { token: null, nativeCursor: null }, build, ports);
      }
      output = result.content;
      if (result.staged) build.staged = true;
      if (result.status === 'partial') localPartial = result.reason;
    } catch (error) {
      if (error instanceof SettlementFailureError) {
        settlementFailed = true;
        failureReason = 'settlement failed: usage unreconciled, further execution and staging stopped';
      } else {
        failureReason = `handler failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      }
    }
  }

  // 9. Strict output schema, then semantic checks (subject/locator/roles).
  // Executed requests stay settled even when their result is rejected here.
  let status: ToolEnvelope['status'] = 'success';
  let reason: string | null = failureReason;
  if (midFlightRefusal !== null) {
    status = 'blocked';
    reason = midFlightRefusal;
    output = null;
  } else if (reason === null) {
    try {
      output = contract.output(output, 'output');
    } catch (error) {
      const detail = error instanceof ContractViolation ? `${error.code}: ${error.message}` : 'invalid output';
      status = 'failed';
      reason = `output refused (${detail}); executed requests stay settled`;
      output = null;
    }
    if (reason === null && output !== null) {
      const violation = semanticViolation(name, trusted, input, output as Record<string, unknown>);
      if (violation) {
        status = 'failed';
        reason = `output refused (semantic: ${violation}); executed requests stay settled`;
        output = null;
      }
    }
  } else {
    status = 'failed';
    output = null;
  }

  // 10. Late re-authorization before usable content leaves the gateway:
  // settled receipts, no usable stale content after scope change, evidence
  // withdrawal or cancellation. Local write tools return their commit
  // receipts instead: their atomic commit already enforced authority.
  if (output !== null && !settlementFailed && !LOCAL_WRITE_TOOLS.includes(name)) {
    const late = authorityRefusal(args, { accountId: account?.accountId ?? null, evidenceIds: collectEvidenceIds(name, input) });
    if (late) {
      return envelope(name, 'blocked', late, null, { token: null, nativeCursor: null }, build, ports);
    }
  }
  if (reason === null && localPartial !== null) {
    status = 'partial';
    reason = localPartial;
  }
  if (reason === null && build.actions.some((action) => action.kind === 'provider_request' && (action.state === 'failed' || action.state === 'unknown' || action.state === 'unreconciled'))) {
    status = 'partial';
    reason = 'some underlying requests failed; retained results and receipts stay honest';
  }
  if (settlementFailed) {
    status = 'failed';
    output = null;
  }

  // 11. Cursor issuance through the trusted port (binding lives server-side).
  let envelopeCursor: CursorState = { token: cursorToken, nativeCursor };
  if (contract.usesCursor) {
    // A successful terminal page must not advertise its consumed input cursor.
    if (output !== null) envelopeCursor = { token: null, nativeCursor: null };
    const nextNative = (output as Record<string, unknown> | null)?.nativeCursor;
    if (typeof nextNative === 'string' && nextNative.length > 0) {
      if (ports.cursors) {
        const token = ports.cursors.issue(cursorBindingFor(trusted, name, input, account), nextNative);
        envelopeCursor = { token, nativeCursor: nextNative };
      } else {
        build.gaps.push({ code: 'cursor_unavailable', detail: 'continuation cursor could not be bound without a trusted cursor port' });
        envelopeCursor = { token: null, nativeCursor: null };
      }
    }
  }

  return envelope(name, status, reason, output, envelopeCursor, build, ports);
}

function collectEvidenceIds(name: ToolName, input: Record<string, unknown>): string[] {
  if (name === 'read_evidence') {
    return ((input.evidence as { evidenceId: string }[] | undefined) ?? []).map((ref) => ref.evidenceId);
  }
  if (name === 'save_findings') {
    const findings = (input.findings as { supportEvidenceIds?: string[]; counterEvidenceIds?: string[] }[] | undefined) ?? [];
    return findings.flatMap((finding) => [...(finding.supportEvidenceIds ?? []), ...(finding.counterEvidenceIds ?? [])]);
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Reusable server factory                                             */
/* ------------------------------------------------------------------ */

export interface ResearchToolServerOptions {
  store: Store;
  skills?: readonly SkillManifest[];
  submissions?: SubmissionPort | null;
  controller?: ControllerPort | null;
  cursors?: CursorPort | null;
  accounting?: AccountingPort | null;
  executor?: ProviderExecutorPort | null;
  sourceAccess?: SourceAccessPort | null;
  handlers?: Partial<Record<ProviderToolName, ToolHandler>>;
}

export interface ResearchToolServer {
  dispatch(trustedContext: TrustedContext, modelCall: ModelCall, signal: AbortSignal): Promise<ToolEnvelope>;
  ports: ResearchToolPorts;
}

/**
 * Production entry point: real CaseStore evidence adapter, fresh-state reads
 * and the default pinned source-access classifier over the given Store, plus
 * the pinned local skill manifest success path. Provider handlers, metered
 * accounting, cursor, submission and controller ports stay injectable and
 * fail closed when absent.
 */
export function createResearchToolServer(options: ResearchToolServerOptions): ResearchToolServer {
  const skills = createPinnedSkillManifestPort(options.skills ?? []);
  const ports: ResearchToolPorts = {
    accounting: options.accounting ?? null,
    executor: options.executor ?? null,
    cursors: options.cursors ?? createOpaqueCursorPort(),
    evidence: createCaseStoreEvidenceAdapter(options.store),
    sourceAccess: options.sourceAccess ?? createStoreSourceAccessPort(options.store),
    skills,
    submissions: options.submissions ?? null,
    controller: options.controller ?? null,
    state: createStoreFreshStatePort(options.store),
    handlers: options.handlers ?? {}
  };
  return {
    dispatch: (trustedContext, modelCall, signal) => dispatch(trustedContext, modelCall, ports, signal),
    ports
  };
}
