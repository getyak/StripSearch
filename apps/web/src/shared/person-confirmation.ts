/**
 * Shared contract for staged name discovery: versioned person overview +
 * explicit person confirmation BEFORE any social/account/history expansion.
 *
 * Authority rules (GET-213, docs/design/name-confirmation-2026-10-21.md):
 * - NEW name-only attempts run bounded general-web recall plus minimal identity
 *   source reads first, and present separate source-backed person candidates.
 *   The overview is a PROJECTION of real checked receipts: every quote/hash
 *   points at a retained original or an indexed search receipt. Search-index
 *   snippets stay indexed clues, never original or ownership evidence.
 * - The confirmation is USER INTENT, never factual identity support. The
 *   server validates the candidate against the PERSISTED authoritative
 *   overview; the client submits only versions plus one immutable candidate
 *   id and can never submit arbitrary sources, URLs or text.
 * - Ordinary third-party biographies may identify a candidate without ever
 *   becoming selectable person-owned accounts. Same-name candidates are never
 *   merged by name or handle and uncertainty stays visible.
 * - Explicit social-profile input (homepage_url) keeps its direct account
 *   target flow and requires no person confirmation; it is never proof of
 *   real-world identity. Historic attempts keep their policy, receipt keys
 *   and behavior.
 *
 * This module has no runtime dependencies beyond sibling shared modules so
 * server, client and tests share one authority for the shapes and the rules.
 */

import { classifyFirstStepUrl } from './first-step-discovery.js';

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

export const PERSON_CONFIRMATION_SCHEMA_VERSION = 'stripsearch/person-confirmation/v1';
export const PERSON_CONFIRMATION_POLICY_VERSION = 'person-confirmation/v1';
/**
 * New staged attempts freeze a NEW first-step policy version. Old completed
 * and in-flight attempts keep their stored policy version, receipt keys and
 * restart behavior; they are never silently re-run or rewritten.
 */
export const FIRST_STEP_STAGED_POLICY_VERSION = 'first-step/v11';

/* ------------------------------------------------------------------ */
/* Safe structured provider failures                                   */
/* ------------------------------------------------------------------ */

export type FirstStepFailureCode =
  | 'provider_billing'
  | 'provider_rate_limited'
  | 'provider_access'
  | 'provider_timeout'
  | 'provider_network'
  | 'provider_unavailable'
  | 'provider_unknown';

/**
 * A SAFE structured failure fact: fixed code, transient flag and a fixed
 * human detail. Provider bodies, tokens and credentials never enter this
 * shape. A billing failure is a NON-TRANSIENT service error: nothing retries
 * it automatically and unknown costs stay unknown.
 */
export interface FirstStepFailureView {
  code: FirstStepFailureCode;
  transient: boolean;
  /** True for supplier-side service failures (billing/unavailable/unknown). */
  serviceError: boolean;
  /** Fixed safe text; never provider body text or credentials. */
  safeDetail: string;
}

const FAILURE_TEXT: Record<FirstStepFailureCode, string> = {
  provider_billing: '供应商计费/额度失败（HTTP 402）：服务计费问题，需要运营方处理供应商账单后手动重试；本次不自动重试，费用未知。',
  provider_rate_limited: '供应商限流：本次未取得结果；稍后可手动重试，不代表没有资料。',
  provider_access: '供应商拒绝了该请求凭据或权限：需要运营方检查访问授权；不代表没有资料。',
  provider_timeout: '供应商请求超时：本次未取得结果；不代表没有资料。',
  provider_network: '网络传输失败：本次未取得结果；不代表没有资料。',
  provider_unavailable: '供应商/适配器未配置或不可用：该路线未真正请求。',
  provider_unknown: '供应商返回未分类失败：结果未知，保留缺口。'
};

export function firstStepFailure(code: FirstStepFailureCode): FirstStepFailureView {
  return {
    code,
    transient: code === 'provider_rate_limited' || code === 'provider_timeout' || code === 'provider_network',
    serviceError: code === 'provider_billing' || code === 'provider_unavailable' || code === 'provider_unknown',
    safeDetail: FAILURE_TEXT[code]
  };
}

/**
 * Classify one provider failure into the safe structured shape. Codes come
 * from the checked adapters (`ProviderErrorCode`) or an HTTP status; free-form
 * message text only breaks ties and is NEVER copied into the safe detail.
 */
export function classifyFirstStepFailure(input: { code?: string | null; status?: number | null; message?: string | null }): FirstStepFailureView {
  const code = input.code ?? '';
  const status = typeof input.status === 'number' ? input.status : null;
  const message = input.message ?? '';
  if (code === 'provider_billing' || status === 402 || /\b402\b|payment required/i.test(message)) return firstStepFailure('provider_billing');
  if (code === 'provider_rate_limited' || status === 429) return firstStepFailure('provider_rate_limited');
  if (code === 'provider_forbidden' || code === 'provider_access' || status === 401 || status === 403) return firstStepFailure('provider_access');
  if (code === 'provider_timeout') return firstStepFailure('provider_timeout');
  if (code === 'provider_unavailable') return firstStepFailure('provider_unavailable');
  if (code === 'provider_network' || (status === null && /network|econn|enotfound|fetch failed/i.test(message))) return firstStepFailure('provider_network');
  return firstStepFailure('provider_unknown');
}

/**
 * Legacy presentation aid: old immutable failed receipts keep null results
 * and no structured error code. New presentation may ACCURATELY explain their
 * recorded route note (e.g. the recorded HTTP 402) without rewriting the
 * historical record or manufacturing a result.
 */
export function classifyRecordedFailureNote(note: string | null | undefined): FirstStepFailureView | null {
  if (typeof note !== 'string' || note.length === 0) return null;
  if (/\b402\b/.test(note)) return firstStepFailure('provider_billing');
  if (/\b429\b|限流/.test(note)) return firstStepFailure('provider_rate_limited');
  if (/\b401\b|\b403\b|forbidden/i.test(note)) return firstStepFailure('provider_access');
  return null;
}

/* ------------------------------------------------------------------ */
/* Versioned person overview (source-backed candidates)                */
/* ------------------------------------------------------------------ */

export type PersonSourceRetrieval = 'read' | 'indexed';

/** One observed source of a person candidate, bound to its real retrieval. */
export interface PersonSourceView {
  /** Immutable key inside one overview (`psrc/<digest>`). */
  sourceKey: string;
  url: string;
  title: string | null;
  /**
   * `read` = the original was actually read and retains a content hash;
   * `indexed` = search-index clue only, NEVER original or ownership evidence.
   */
  retrieval: PersonSourceRetrieval;
  /** `sha256:<hex>` of the retained original; null for indexed clues. */
  contentHash: string | null;
  retrievedAt: string | null;
  /** Exact span of the retained original; indexed clues never carry one. */
  quote: string | null;
  locator: string | null;
  /** Honest limitation of this source; never omitted. */
  note: string;
}

/** Concise deterministic descriptor atom; never free-form unsourced biography. */
export interface PersonDescriptorAtomView {
  atomId: string;
  statement: string;
  kind: 'source_title' | 'source_excerpt';
  sourceKey: string;
  quote: string | null;
  locator: string | null;
}

export interface PersonCandidateView {
  /** Immutable candidate id (`pcand/<digest>`); the client submits only this. */
  candidateId: string;
  displayName: string;
  /** The exact query label this candidate was observed under. */
  queryLabel: string;
  anchorSourceKey: string;
  sources: PersonSourceView[];
  descriptors: PersonDescriptorAtomView[];
  /** Observed contradiction/limitation facts; never silently dropped. */
  counterevidence: string[];
  unknowns: string[];
}

export interface PersonCoverageQueryView {
  family: string;
  state: 'completed' | 'failed' | 'deferred' | 'skipped_budget' | 'not_planned';
  note: string;
}

export interface PersonOverviewCoverageView {
  queryFamilies: PersonCoverageQueryView[];
  sourcesRead: number;
  sourcesIndexed: number;
  /** Suppliers stopped this attempt (e.g. billing); remaining routes stay gaps. */
  attemptsStopped: Array<{ supplier: string; failure: FirstStepFailureView; note: string }>;
}

export type PersonOverviewStatus = 'awaiting_confirmation' | 'no_candidates' | 'service_error';

export interface PersonOverviewView {
  schemaVersion: typeof PERSON_CONFIRMATION_SCHEMA_VERSION;
  policyVersion: string;
  attemptId: string;
  queryLabel: string;
  status: PersonOverviewStatus;
  /** Same-name candidates stay separate; ordering is presentation only. */
  candidates: PersonCandidateView[];
  coverage: PersonOverviewCoverageView;
  gaps: string[];
  /** Safe structured supplier failure (billing etc.); never provider body text. */
  serviceError: FirstStepFailureView | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Confirmation state and input                                        */
/* ------------------------------------------------------------------ */

export interface PersonConfirmationStateView {
  /** True when this discovery revision still awaits explicit person intent. */
  required: boolean;
  status: 'awaiting' | 'confirmed' | 'not_required';
  confirmedCandidateId: string | null;
  confirmedAt: string | null;
  /** Monotonic confirmation receipt counter of the run; null before submit. */
  confirmationRevision: number | null;
}

/**
 * The whole confirmation request. There is deliberately NO source/url/text
 * field: the client cannot submit arbitrary sources and the server always
 * resolves the candidate against the persisted authoritative overview.
 */
export interface PersonConfirmationInput {
  expectedRunRevision: number;
  expectedScopeVersion: number;
  discoveryRevision: number;
  candidateId: string;
}

export type PersonConfirmationValidation =
  | { ok: true; input: PersonConfirmationInput }
  | { ok: false; error: string };

const CONFIRMATION_FIELDS = new Set(['expectedRunRevision', 'expectedScopeVersion', 'discoveryRevision', 'candidateId']);
export const PERSON_CANDIDATE_ID_MAX = 120;

function readRevision(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * Strict validation: only the four binding fields are accepted. Any extra
 * source/url/quote/text field is REJECTED (the client can never smuggle
 * arbitrary sources into the authoritative record).
 */
export function validatePersonConfirmationInput(raw: unknown): PersonConfirmationValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '确认内容必须是对象。' };
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!CONFIRMATION_FIELDS.has(key)) {
      return { ok: false, error: `确认请求不允许携带字段 ${key}；来源与原文只能来自服务端权威记录。` };
    }
  }
  const expectedRunRevision = readRevision(body.expectedRunRevision);
  const expectedScopeVersion = readRevision(body.expectedScopeVersion);
  const discoveryRevision = readRevision(body.discoveryRevision);
  if (expectedRunRevision === null || expectedScopeVersion === null || discoveryRevision === null) {
    return { ok: false, error: '缺少合法的版本字段。' };
  }
  const candidateId = body.candidateId;
  if (typeof candidateId !== 'string' || candidateId.length === 0 || candidateId.length > PERSON_CANDIDATE_ID_MAX) {
    return { ok: false, error: '人物候选 id 无效。' };
  }
  if (!/^pcand\/[0-9a-f]{16,64}$/.test(candidateId)) {
    return { ok: false, error: '人物候选 id 格式无效；只能确认权威概览中的候选。' };
  }
  return { ok: true, input: { expectedRunRevision, expectedScopeVersion, discoveryRevision, candidateId } };
}

export type PersonCandidateGate =
  | { ok: true; candidate: PersonCandidateView }
  | { ok: false; code: 'unknown_candidate' | 'revoked_candidate'; error: string };

/**
 * Candidate gate against the PERSISTED overview only. A candidate missing from
 * the authoritative overview is forged/unknown; explicitly revoked candidate
 * ids are refused as well. No client URL/text ever reaches this check.
 *
 * Production revocation is authoritative in the STORE: source dependencies
 * revalidated against the immutable receipt ledger (missing/changed/withdrawn
 * evidence fails closed) plus `revoked_at` confirmation rows. `revokedCandidateIds`
 * is only for projections that already carry a revocation list.
 */
export function gatePersonCandidate(
  overview: PersonOverviewView | null | undefined,
  candidateId: string,
  options?: { revokedCandidateIds?: ReadonlySet<string> }
): PersonCandidateGate {
  if (!overview) {
    return { ok: false, code: 'unknown_candidate', error: '本次发现没有权威人物概览；不能确认候选。' };
  }
  if (options?.revokedCandidateIds?.has(candidateId)) {
    return { ok: false, code: 'revoked_candidate', error: '该人物候选已被撤销；请刷新后重新确认。' };
  }
  const candidate = overview.candidates.find((item) => item.candidateId === candidateId) ?? null;
  if (!candidate) {
    return { ok: false, code: 'unknown_candidate', error: '人物候选不在权威概览内；不能用自定义来源或地址确认。' };
  }
  return { ok: true, candidate };
}

/**
 * Whether this projection still requires explicit person confirmation before
 * account selection. Legacy projections without the staged fields and explicit
 * profile-input attempts keep their existing flow (`required: false`).
 */
export function personConfirmationRequired(view: { personConfirmation?: PersonConfirmationStateView | null } | null | undefined): boolean {
  return view?.personConfirmation?.required === true && view.personConfirmation.status !== 'confirmed' && view.personConfirmation.status !== 'not_required';
}

/** Explicit profile/social-account input is a direct account target: no person confirmation stage. */
export function personConfirmationRequiredForInput(input: { kind: string }): boolean {
  return input.kind === 'name_query';
}

/* ------------------------------------------------------------------ */
/* Staged query plan: bounded general-web recall first                  */
/* ------------------------------------------------------------------ */

export interface FirstStepStageBudget {
  maxSearchQueries: number;
  maxSearchResults: number;
  maxProfileReads: number;
  maxModelCalls: number;
  policyVersion: string;
}

/**
 * Overview-stage budget: bounded general-web recall + minimal identity source
 * reads. No model calls: descriptors are deterministic labels and literal
 * source excerpts only. The account stage keeps the normal frozen budget.
 */
export const FIRST_STEP_OVERVIEW_BUDGET: FirstStepStageBudget = {
  maxSearchQueries: 4,
  maxSearchResults: 12,
  maxProfileReads: 4,
  maxModelCalls: 0,
  policyVersion: FIRST_STEP_STAGED_POLICY_VERSION
};

/**
 * Overview query families: plain general-web queries only. Social/platform
 * account search (domain-constrained social families and native social
 * providers) and channel expansion belong to the ACCOUNT stage after the
 * person confirmation.
 */
export const FIRST_STEP_OVERVIEW_FAMILIES: readonly string[] = ['home', 'work', 'writing', 'academic'];

/** Account-search families that must never dispatch before person confirmation. */
export const FIRST_STEP_SOCIAL_FAMILIES: readonly string[] = ['social', 'visual_social', 'federated_social', 'video', 'native_bluesky'];

export function isOverviewFamily(family: string): boolean {
  return FIRST_STEP_OVERVIEW_FAMILIES.includes(family);
}

export function isSocialFamily(family: string): boolean {
  return FIRST_STEP_SOCIAL_FAMILIES.includes(family);
}

export interface FirstStepStageQuery {
  query: string;
  family: string;
  includeDomains?: readonly string[];
  provider?: 'bluesky';
}

/**
 * Stage-filtered plan over the one frozen query-family authority. The overview
 * stage keeps only unfiltered general-web families; the accounts stage runs
 * the full frozen family coverage (shared queries replay their real receipts
 * instead of being re-billed).
 */
export function firstStepStageQueryPlan(
  plan: readonly FirstStepStageQuery[],
  stage: 'overview' | 'accounts' | 'full'
): FirstStepStageQuery[] {
  if (stage !== 'overview') return [...plan];
  return plan.filter((item) => isOverviewFamily(item.family));
}

/* ------------------------------------------------------------------ */
/* Deterministic descriptor excerpts                                   */
/* ------------------------------------------------------------------ */

const SENTENCE_DELIMITERS = '.。！？!?\n;；';

/** Only alternatives explicitly supplied by the user, matching the query plan. */
export function suppliedPersonLabels(label: string): string[] {
  return [...new Set(label.split(/\s*[\/／]\s*/).map((name) => name.trim()).filter(Boolean))];
}

/**
 * Deterministic sentence-bounded excerpt around an observed name mention in a
 * RETAINED original, with a real character locator. Never a model summary and
 * never synthesized text; an absent mention yields nothing.
 */
export function excerptAroundLabel(text: string, label: string): { quote: string; locator: string } | null {
  const haystack = text.normalize('NFKC').toLowerCase();
  const match = suppliedPersonLabels(label)
    .map((name) => name.normalize('NFKC').toLowerCase())
    .map((needle) => ({ needle, index: haystack.indexOf(needle) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index || b.needle.length - a.needle.length)[0];
  if (!match) return null;
  const { needle, index } = match;
  // Normalization can expand ligatures or compose combining marks. Map the
  // normalized match back to original grapheme boundaries before slicing.
  let normalizedOffset = 0;
  let start = -1;
  let end = -1;
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  for (const item of segmenter.segment(text)) {
    const next = normalizedOffset + item.segment.normalize('NFKC').toLowerCase().length;
    if (start < 0 && next > index) start = item.index;
    if (next >= index + needle.length) {
      end = item.index + item.segment.length;
      break;
    }
    normalizedOffset = next;
  }
  if (start < 0 || end < 0) return null;
  const matchStart = start;
  const matchEnd = end;
  while (start > 0 && !SENTENCE_DELIMITERS.includes(text[start - 1]!)) start--;
  while (end < text.length && !SENTENCE_DELIMITERS.includes(text[end]!)) end++;
  if (end < text.length) end++;
  // The projected quote has a 400-character bound. Keep the name in the
  // window and describe the displayed original span, including long sentences.
  if (end - start > 400) {
    if (matchEnd - matchStart > 400) return null;
    start = Math.max(start, matchStart - Math.floor((400 - (matchEnd - matchStart)) / 2));
    end = Math.min(end, start + 400);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!) && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start++;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  }
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  const quote = text.slice(start, end).trim();
  if (quote.length < 2) return null;
  return { quote, locator: `原文第 ${String(start + 1)}–${String(end)} 字符` };
}

/**
 * Overview-stage identity source: an actually observed PUBLIC non-social page
 * (third-party biography, article, encyclopedia entry, personal site) that may
 * be read for disambiguation ONLY. Never a social/profile/history target and
 * never an owned account; the legacy global classifiers stay untouched.
 */
export function isFirstStepOverviewIdentityUrl(value: string): boolean {
  const classified = classifyFirstStepUrl(value);
  if (!classified.ok) return false;
  if (!['web_page', 'personal_site', 'rss_blog', 'linktree'].includes(classified.ref.platform)) return false;
  if (classified.ref.platform === 'rss_blog' || classified.ref.platform === 'linktree') return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)) return false;
    // A third-party article/encyclopedia page needs a real path; a personal
    // site root is already its own account/home entry.
    return classified.ref.platform === 'personal_site' || url.pathname.length > 1;
  } catch {
    return false;
  }
}

/** Human label making the quoted-vs-indexed distinction explicit. */
export function personSourceAccessLabel(source: Pick<PersonSourceView, 'retrieval'>): string {
  return source.retrieval === 'read' ? '原文已读取' : '仅搜索索引可见';
}
