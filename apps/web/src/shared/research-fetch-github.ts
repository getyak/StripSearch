/**
 * GET-99 real GitHub Fetch contract (shared, pure): the typed request/view
 * contract for the authenticated `/api/fetch` API and its Web Fetch entry, the
 * strict github.com target parser and the bounded continuation (Link)
 * validator for the live public REST slice.
 *
 * Boundary (see docs/fetch-integration.md): this slice reads only public
 * GitHub resources through `https://api.github.com` paths GENERATED from the
 * frozen, explicitly confirmed target. Account targets read the public
 * user/org profile, the public owned repository listing (real Link
 * pagination) and each owned repository's README / current public work
 * snapshot — explicitly NOT a whole contribution history. Repository targets
 * enumerate issues INCLUDING pull requests (`state=all`, real Link
 * continuation), capturing each issue/PR body and the FIRST page of issue
 * comments with actual login/id attribution and original permalinks. No
 * review threads, media, code or personal contribution coverage is invented,
 * and account research never asserts same-person linkage: organization and
 * repository authors are never assumed to be the subject.
 *
 * Confirmation: no HTTP request may happen before the user explicitly
 * confirms the exact target GitHub account or repository, the frozen question
 * and the supported access scope. The session owner comes only from
 * middleware; every run stays owner-scoped in the API.
 *
 * Continuation safety: a Link `next` URL is followed only when it is the
 * exact same endpoint family under the frozen target — same host (no
 * credentials, no port substitution), same path form (the named form or the
 * numeric-id form bound to the PUBLICLY VERIFIED repository/account id) and
 * the exact same frozen non-pagination query values plus one bounded
 * pagination continuation (`page` / `after` / `before` / `since` syntax
 * checked, cyclic/duplicate continuations kept as explicit gaps). A foreign
 * host, a substituted state/sort/window or an unverified numeric id is
 * always refused: credentials are never forwarded to redirects or to
 * substituted Link URLs.
 */

export const FETCH_GITHUB_API_ORIGIN = 'https://api.github.com';

/** API version pinned in the captured requests (official docs sample). */
export const FETCH_GITHUB_API_VERSION = '2026-03-10';

export const FETCH_GITHUB_REGISTRY_VERSION = 'github-public/2026-03-10';

/** Opaque continuation bounds: bounded syntax, never arbitrary URLs. */
export const FETCH_GITHUB_CONTINUATION_MAX = 2000;
export const FETCH_GITHUB_CURSOR_MAX = 256;
export const FETCH_GITHUB_QUERY_KEYS_MAX = 8;

/* ------------------------------------------------------------------ */
/* Targets (strict github.com public profile / owner/repo parser)     */
/* ------------------------------------------------------------------ */

export type FetchGithubTarget =
  | { kind: 'account'; login: string; canonicalUrl: string }
  | { kind: 'repository'; owner: string; name: string; canonicalUrl: string };

export type FetchGithubAccessScope = 'github_public_account' | 'github_public_repository';

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function validLogin(segment: string): boolean {
  return LOGIN_RE.test(segment) && !segment.includes('--');
}

function validRepo(segment: string): boolean {
  return REPO_RE.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * Strict parser: only `https://github.com/<login>` and
 * `https://github.com/<owner>/<name>`. https only, exact host, no
 * credentials, no explicit port, no query, no fragment, no extra segments.
 */
export function parseFetchGithubTarget(raw: unknown): { ok: true; target: FetchGithubTarget } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: '请填写 https://github.com/<账号> 或 https://github.com/<账号>/<仓库> 形式的公开链接。' };
  }
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: '目标链接无法解析，请填写标准 GitHub 公开链接。' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: '只接受 https 链接。' };
  if (url.hostname.toLowerCase() !== 'github.com') return { ok: false, error: '只接受 github.com 的公开主页或仓库链接。' };
  if (url.username || url.password) return { ok: false, error: '链接不能携带凭据。' };
  if (url.port) return { ok: false, error: '链接不能指定端口。' };
  if (url.search || url.hash) return { ok: false, error: '链接不能携带查询参数或片段。' };
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  if (segments.length === 1 && url.pathname === `/${segments[0]}`) {
    const login = segments[0] as string;
    if (!validLogin(login)) return { ok: false, error: 'GitHub 账号名格式无效。' };
    return { ok: true, target: { kind: 'account', login, canonicalUrl: `https://github.com/${login}` } };
  }
  if (segments.length === 2 && url.pathname === `/${segments[0]}/${segments[1]}`) {
    const owner = segments[0] as string;
    const name = segments[1] as string;
    if (!validLogin(owner)) return { ok: false, error: 'GitHub 仓库所属账号名格式无效。' };
    if (!validRepo(name)) return { ok: false, error: 'GitHub 仓库名格式无效。' };
    return {
      ok: true,
      target: { kind: 'repository', owner, name, canonicalUrl: `https://github.com/${owner}/${name}` }
    };
  }
  return { ok: false, error: '只接受账号主页或 owner/仓库 两种公开链接。' };
}

export function accessScopeFor(target: FetchGithubTarget): FetchGithubAccessScope {
  return target.kind === 'account' ? 'github_public_account' : 'github_public_repository';
}

/* ------------------------------------------------------------------ */
/* Case/item identities (stable, deterministic)                        */
/* ------------------------------------------------------------------ */

/**
 * CaseStore account identity for the confirmed target account, bound to
 * exactly ONE case: the same GitHub login in two different cases never
 * collides on the global account primary key and is never merged.
 */
export function fetchGithubAccountId(caseId: string, login: string): string {
  return `ghacct:${caseId}:${login.toLowerCase()}`;
}

export function fetchGithubRepoItemKey(owner: string, name: string): string {
  return `repo:${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function fetchGithubIssueItemKey(owner: string, name: string, issueNumber: number): string {
  return `issue:${owner.toLowerCase()}/${name.toLowerCase()}#${String(issueNumber)}`;
}

/* ------------------------------------------------------------------ */
/* Frozen request generation (the ONLY legal URL shapes)              */
/* ------------------------------------------------------------------ */

export type FetchGithubRequestKind =
  | 'profile'
  | 'repos_list'
  | 'repo_meta'
  | 'repo_readme'
  | 'issues_list'
  | 'issue_comments';

export interface FetchGithubRequestDescriptor {
  kind: FetchGithubRequestKind;
  method: 'GET';
  /** Generated https://api.github.com URL (or a validated continuation). */
  url: string;
}

function apiUrl(pathname: string, query: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) params.set(key, query[key] as string);
  const search = params.toString();
  return `${FETCH_GITHUB_API_ORIGIN}${pathname}${search ? `?${search}` : ''}`;
}

/** Frozen non-pagination query values per request kind (never substituted). */
export function frozenQueryFor(kind: FetchGithubRequestKind): Record<string, string> {
  switch (kind) {
    case 'profile':
    case 'repo_meta':
    case 'repo_readme':
      return {};
    case 'repos_list':
      // `type=owner` applies to the user form; the org form enumerates the
      // org's own repositories by definition.
      return { per_page: '30' };
    case 'issues_list':
      return { state: 'all', sort: 'created', direction: 'asc', per_page: '30' };
    case 'issue_comments':
      return { per_page: '30' };
  }
}

/**
 * Generate the only legal request URLs under the frozen target. Continuation
 * pages never come through here: they must pass
 * `validateGithubContinuation` first and then carry their exact URL.
 */
export function buildFetchGithubRequest(
  kind: FetchGithubRequestKind,
  params: {
    login?: string;
    owner?: string;
    name?: string;
    issueNumber?: number;
    userType?: 'user' | 'org';
  }
): { ok: true; request: FetchGithubRequestDescriptor } | { ok: false; error: string } {
  const login = params.login ?? '';
  const owner = params.owner ?? '';
  const name = params.name ?? '';
  switch (kind) {
    case 'profile': {
      if (!validLogin(login)) return { ok: false, error: '账号名无效。' };
      return { ok: true, request: { kind, method: 'GET', url: apiUrl(`/users/${encodeURIComponent(login)}`, {}) } };
    }
    case 'repos_list': {
      if (!validLogin(login)) return { ok: false, error: '账号名无效。' };
      const query = { ...frozenQueryFor('repos_list') };
      if (params.userType === 'user') query.type = 'owner';
      const pathname = params.userType === 'org' ? `/orgs/${encodeURIComponent(login)}/repos` : `/users/${encodeURIComponent(login)}/repos`;
      return { ok: true, request: { kind, method: 'GET', url: apiUrl(pathname, query) } };
    }
    case 'repo_meta': {
      if (!validLogin(owner) || !validRepo(name)) return { ok: false, error: '仓库目标无效。' };
      return { ok: true, request: { kind, method: 'GET', url: apiUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {}) } };
    }
    case 'repo_readme': {
      if (!validLogin(owner) || !validRepo(name)) return { ok: false, error: '仓库目标无效。' };
      return { ok: true, request: { kind, method: 'GET', url: apiUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`, {}) } };
    }
    case 'issues_list': {
      if (!validLogin(owner) || !validRepo(name)) return { ok: false, error: '仓库目标无效。' };
      return {
        ok: true,
        request: { kind, method: 'GET', url: apiUrl(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`, frozenQueryFor('issues_list')) }
      };
    }
    case 'issue_comments': {
      if (!validLogin(owner) || !validRepo(name)) return { ok: false, error: '仓库目标无效。' };
      if (!Number.isSafeInteger(params.issueNumber) || (params.issueNumber ?? -1) < 1) {
        return { ok: false, error: 'issue 编号无效。' };
      }
      return {
        ok: true,
        request: {
          kind,
          method: 'GET',
          url: apiUrl(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${String(params.issueNumber)}/comments`,
            frozenQueryFor('issue_comments')
          )
        }
      };
    }
  }
}

/**
 * Deterministic request identity: exact kind + method + origin + path +
 * canonical sorted query. Persisted successful requests are never repeated.
 */
export function fetchGithubRequestKey(request: FetchGithubRequestDescriptor): string {
  const url = new URL(request.url);
  const params = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params.map(([key, value]) => `${key}=${value}`).join('&');
  return `${request.kind}|${request.method}|${url.protocol}//${url.host}${url.pathname}${search ? `?${search}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* Link continuation validation (bounded, exact endpoint family)      */
/* ------------------------------------------------------------------ */

/** Parse a `Link` header into rel -> url (first entry per rel wins). */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string' || header.trim().length === 0) return out;
  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (!match) continue;
    const url = (match[1] ?? '').trim();
    const rel = (match[2] ?? '').trim();
    if (url.length > 0 && rel.length > 0 && !(rel in out)) out[rel] = url;
  }
  return out;
}

/**
 * The single `rel="next"` target of a Link header. A header with zero next
 * entries reports `url: null` (explicit terminal); a header with MORE THAN
 * ONE next entry is ambiguous and reports `ambiguous: true` — it is never
 * silently resolved to one of the candidates.
 */
export function linkHeaderNext(header: string | null | undefined): { url: string | null; ambiguous: boolean } {
  if (typeof header !== 'string' || header.trim().length === 0) return { url: null, ambiguous: false };
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (!match) continue;
    const url = (match[1] ?? '').trim();
    const rel = (match[2] ?? '').trim();
    if (url.length > 0 && rel === 'next') candidates.push(url);
  }
  if (candidates.length === 0) return { url: null, ambiguous: false };
  if (candidates.length > 1) return { url: null, ambiguous: true };
  return { url: candidates[0] ?? null, ambiguous: false };
}

export type GithubContinuationKind = 'repos_list' | 'issues_list';

export interface GithubContinuationContext {
  kind: GithubContinuationKind;
  target: FetchGithubTarget;
  /**
   * PUBLICLY VERIFIED numeric ids from metadata settled earlier in the run
   * (profile / repository metadata). A numeric-id path form is accepted only
   * when it matches one of these; arbitrary numeric ids are refused.
   */
  verified: { accountId: number | null; repoId: number | null };
  /** Exact frozen non-pagination query values of the original request. */
  frozenQuery: Record<string, string>;
  /** Continuation identities already issued for this listing (cycle check). */
  seenContinuations: readonly string[];
}

export interface GithubContinuation {
  url: string;
  /** Stable identity of the pagination state (cycle detection). */
  continuationId: string;
  pagination: Record<string, string>;
}

const PAGINATION_KEYS = new Set(['page', 'after', 'before', 'since']);
const PAGE_RE = /^[0-9]{1,12}$/;
const SINCE_RE = /^[0-9]{1,12}$/;
const CURSOR_RE = /^[A-Za-z0-9._%+/=-]{1,256}$/;
const HEX_RE = /%[0-9A-Fa-f]{2}/;

function paginationValueOf(params: [string, string][], key: string): string | null {
  return params.find(([name]) => name === key)?.[1] ?? null;
}

function cursorSyntaxOk(value: string): boolean {
  if (value.length === 0 || value.length > FETCH_GITHUB_CURSOR_MAX) return false;
  if (!CURSOR_RE.test(value)) return false;
  if (value.includes('..')) return false;
  // Percent-escapes must be well-formed; no raw control characters.
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === '%') {
      if (!HEX_RE.test(value.slice(index, index + 3))) return false;
      index += 2;
    }
  }
  return true;
}

function pathMatches(kind: GithubContinuationKind, pathname: string, ctx: GithubContinuationContext): boolean {
  const segments = pathname.split('/').filter((part) => part.length > 0);
  const sameLogin = (value: string) =>
    ctx.target.kind === 'account'
      ? value.toLowerCase() === ctx.target.login.toLowerCase()
      : value.toLowerCase() === ctx.target.owner.toLowerCase();
  if (kind === 'repos_list') {
    if (segments.length === 3 && segments[0] === 'users' && segments[2] === 'repos') {
      return sameLogin(segments[1] ?? '');
    }
    if (segments.length === 3 && segments[0] === 'orgs' && segments[2] === 'repos') {
      return sameLogin(segments[1] ?? '');
    }
    // Canonical numeric-id form: only the PUBLICLY VERIFIED account id.
    if (segments.length === 3 && segments[0] === 'organizations' && segments[2] === 'repos') {
      return ctx.verified.accountId !== null && segments[1] === String(ctx.verified.accountId);
    }
    return false;
  }
  // issues_list: /repos/<owner>/<name>/issues or /repositories/<verified id>/issues
  if (segments.length === 4 && segments[0] === 'repos' && segments[3] === 'issues') {
    if (ctx.target.kind !== 'repository') return false;
    return (
      (segments[1] ?? '').toLowerCase() === ctx.target.owner.toLowerCase() &&
      (segments[2] ?? '').toLowerCase() === ctx.target.name.toLowerCase()
    );
  }
  if (segments.length === 3 && segments[0] === 'repositories' && segments[2] === 'issues') {
    return ctx.verified.repoId !== null && segments[1] === String(ctx.verified.repoId);
  }
  return false;
}

/**
 * Validate one Link continuation URL against the frozen target and endpoint
 * family. Accepts the real GitHub canonicalized forms (the numeric
 * `/repositories/{verified repo id}/issues` continuation observed on
 * 2026-03-10 responses) ONLY after binding to publicly verified metadata.
 * Exact host/port/credentials checks, exact frozen non-pagination query
 * values, bounded pagination syntax and cyclic-token detection: a refused or
 * cyclic continuation stays an explicit listing gap and is never followed.
 */
export function validateGithubContinuation(
  rawUrl: string,
  ctx: GithubContinuationContext
): { ok: true; continuation: GithubContinuation } | { ok: false; reason: string } {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return { ok: false, reason: 'empty continuation url' };
  const text = rawUrl.trim();
  if (text.length > FETCH_GITHUB_CONTINUATION_MAX) return { ok: false, reason: 'continuation url exceeds bounds' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'continuation url does not parse' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'continuation must be https' };
  if (url.hostname.toLowerCase() !== 'api.github.com') return { ok: false, reason: 'continuation host is not api.github.com' };
  if (url.username || url.password) return { ok: false, reason: 'continuation must not carry credentials' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'continuation must not substitute the port' };
  if (url.hash) return { ok: false, reason: 'continuation must not carry a fragment' };
  if (url.pathname.includes('//') || url.pathname.includes('..')) {
    return { ok: false, reason: 'continuation path is not canonical' };
  }
  if (!pathMatches(ctx.kind, url.pathname, ctx)) {
    return { ok: false, reason: 'continuation path is outside the frozen endpoint family or target id' };
  }
  const params = [...url.searchParams.entries()];
  if (params.length === 0 || params.length > FETCH_GITHUB_QUERY_KEYS_MAX) {
    return { ok: false, reason: 'continuation query arity out of bounds' };
  }
  const seenKeys = new Set<string>();
  const pagination: Record<string, string> = {};
  for (const [key, value] of params) {
    if (seenKeys.has(key)) return { ok: false, reason: `duplicate query parameter ${key}` };
    seenKeys.add(key);
    if (PAGINATION_KEYS.has(key)) {
      if (key === 'page' || key === 'since') {
        if (!PAGE_RE.test(value) && !(key === 'since' && SINCE_RE.test(value))) {
          return { ok: false, reason: `pagination parameter ${key} has invalid syntax` };
        }
      } else if (!cursorSyntaxOk(value)) {
        return { ok: false, reason: `pagination parameter ${key} has invalid cursor syntax` };
      }
      pagination[key] = value;
      continue;
    }
    // Non-pagination parameters must be the EXACT frozen values: state, sort,
    // direction, window and per_page can never be substituted.
    if (!(key in ctx.frozenQuery) || ctx.frozenQuery[key] !== value) {
      return { ok: false, reason: `query parameter ${key} differs from the frozen request` };
    }
  }
  // EVERY frozen non-pagination parameter must remain present exactly once:
  // a missing parameter is substitution just like a changed value (dropping
  // state=all silently reverts to state=open and must never be followed).
  for (const key of Object.keys(ctx.frozenQuery)) {
    if (!seenKeys.has(key)) return { ok: false, reason: `frozen query parameter ${key} is missing (substitution)` };
    if (ctx.frozenQuery[key] !== paginationValueOf(params, key)) {
      return { ok: false, reason: `query parameter ${key} differs from the frozen request` };
    }
  }
  if (Object.keys(pagination).length === 0) {
    return { ok: false, reason: 'continuation lacks a pagination parameter' };
  }
  const continuationId = Object.keys(pagination)
    .sort()
    .map((key) => `${key}=${pagination[key] as string}`)
    .join('&');
  if (ctx.seenContinuations.includes(continuationId)) {
    return { ok: false, reason: 'cyclic or duplicate continuation token' };
  }
  return {
    ok: true,
    continuation: {
      url: `${FETCH_GITHUB_API_ORIGIN}${url.pathname}${url.search}`,
      continuationId,
      pagination
    }
  };
}

/* ------------------------------------------------------------------ */
/* Request/view contract for /api/fetch                               */
/* ------------------------------------------------------------------ */

export type FetchGithubRunState =
  /** Phase 1: real provider acquisition in progress (resumable quanta). */
  | 'acquiring'
  /** User paused; resume continues from the durable checkpoint. */
  | 'paused'
  /** Durable in-flight request(s) with unknown outcome: stopped, never replayed. */
  | 'unreconciled'
  /** Snapshot frozen; phase 2 cached processing over the immutable capture. */
  | 'processing'
  /**
   * Processing quanta drained. NOT a research completion claim: the GET-60
   * assessment (usually partial) and the frozen questions stay authoritative.
   */
  | 'finished'
  /** Explicit user stop (terminal for this run; late commits are rejected). */
  | 'stopped';

export type FetchGithubRunPhase = 'acquire' | 'process';

export type FetchGithubRequestState = 'in_flight' | 'succeeded' | 'failed' | 'unknown' | 'rejected';

export interface FetchGithubGapView {
  code: string;
  detail: string;
}

export interface FetchGithubRequestView {
  requestKey: string;
  kind: FetchGithubRequestKind;
  url: string;
  state: FetchGithubRequestState;
  status: number | null;
  bodyBytes: number | null;
  /** SHA-256 of the exact complete returned body (never a truncation). */
  bodyHash: string | null;
  attempt: number;
  createdAt: string;
  settledAt: string | null;
  gap: string | null;
}

export interface FetchGithubCommentView {
  commentId: string;
  authorLogin: string | null;
  authorId: number | null;
  authorRole: 'subject' | 'third_party' | 'unknown';
  /** Original permalink preserved from the provider response. */
  originalUrl: string | null;
  bodyHash: string;
  /** Complete captured body (plain text; never rendered as HTML). */
  body: string;
  /** Bounded excerpt used by processing; the body above stays complete. */
  excerpt: string;
  createdAt: string | null;
}

export interface FetchGithubItemView {
  itemKey: string;
  kind: 'readme' | 'issue' | 'pull_request';
  title: string;
  originalUrl: string | null;
  authorLogin: string | null;
  publishedAt: string | null;
  /** SHA-256 over the complete captured body text. */
  contentHash: string;
  /** Complete captured body text (plain text). */
  fulltext: string;
  bodyBytes: number;
  sourceId: string;
  sourceRevision: number;
  comments: FetchGithubCommentView[];
  /** False when the body cannot enter phase 2 (explicit gap, never dropped). */
  processingEligible: boolean;
  processingGap: string | null;
}

export interface FetchGithubPendingEvidenceView {
  evidenceId: string;
  accountId: string;
  sourceId: string;
  sourceRevision: number;
  role: string;
  /** Plain-text quote; rendered as text, never as raw HTML. */
  quote: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  author: string | null;
  publishedAt: string | null;
  retrievedAt: string | null;
  revokedAt: string | null;
}

export interface FetchGithubProcessingView {
  pipelineRunId: string | null;
  state: string;
  stopReason: string;
  openSteps: number;
  counts: {
    toolActions: number;
    providerRequests: number;
    listedItems: number;
    bodiesRead: number;
    commentsRead: number;
    findingsStaged: number;
    verificationsStaged: number;
    /** External LLM calls: always zero for the deterministic scheduler. */
    modelCalls: number;
    /**
     * Local deterministic scheduler decisions (NOT model use). External
     * model accounting stays honest zero; never presented as real LLM use.
     */
    schedulerDecisions: number;
    modelInputTokens: number | null;
    modelOutputTokens: number | null;
    modelEstimatedUsd: number | null;
  } | null;
  assessment: { verdict: string; dimensions: { dimension: string; state: string; unresolved: number }[] } | null;
  pendingFindings: { pendingRef: string; kind: string; accountIds: string[]; dependencyEvidenceIds: string[] }[];
  remainingGaps: string[];
}

export interface FetchGithubRunView {
  runId: string;
  revision: number;
  state: FetchGithubRunState;
  /** Current unresolved intents; excludes previously reconciled unknown outcomes. */
  needsReconciliation?: boolean;
  phase: FetchGithubRunPhase;
  target: FetchGithubTarget;
  accessScope: FetchGithubAccessScope;
  /** Frozen question; the research question stays unanswered without a verifier. */
  question: string;
  /** What the user explicitly confirmed before any HTTP request. */
  confirmation: { target: string; question: string; accessScope: FetchGithubAccessScope; confirmedAt: string };
  scopeSpecId: string;
  scopeVersion: number;
  createdAt: string;
  updatedAt: string;
  snapshot: { frozen: boolean; digest: string | null; frozenAt: string | null };
  progress: {
    requests: {
      total: number;
      succeeded: number;
      failed: number;
      unknown: number;
      rejected: number;
      inFlight: number;
    };
    listingPages: { repos: number; issues: number };
    items: number;
    comments: number;
  };
  requests: FetchGithubRequestView[];
  items: FetchGithubItemView[];
  pendingEvidence: FetchGithubPendingEvidenceView[];
  gaps: FetchGithubGapView[];
  /** Precise frozen provider limitations; always exposed with the run. */
  limitations: string[];
  processing: FetchGithubProcessingView | null;
}

export interface FetchGithubRunSummary {
  runId: string;
  revision: number;
  state: FetchGithubRunState;
  phase: FetchGithubRunPhase;
  targetUrl: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  snapshotFrozen: boolean;
  progress: { requests: number; items: number; comments: number; gaps: number };
}

/** The start request must echo the exact confirmed contract. */
export interface FetchGithubStartRequest {
  targetUrl: string;
  question: string;
  accessScope: FetchGithubAccessScope;
  /** Must be true: explicit confirmation is required before any HTTP. */
  confirmation: boolean;
  confirmedTarget: string;
  confirmedQuestion: string;
  confirmedAccessScope: FetchGithubAccessScope;
}

export interface FetchGithubResumeRequest {
  /**
   * Explicit handling of requests whose outcome is unknown after a durable
   * interruption. Nothing is retried automatically: `retry` re-issues the
   * unknown request as a fresh journaled attempt with unknown prior cost,
   * `skip` keeps it as a permanent honest gap.
   */
  reconcileUnknown?: 'retry' | 'skip';
  expectedRevision?: number;
}

/* ------------------------------------------------------------------ */
/* Frozen scope + limitations                                         */
/* ------------------------------------------------------------------ */

export const FETCH_GITHUB_ACCOUNT_LIMITATIONS: readonly string[] = [
  '账号切片只读取公开用户/组织资料、公开自有仓库列表（真实 Link 分页）与每个仓库的 README / 当前公开工作快照。',
  'README 快照不是完整贡献历史：不抓取 commit、贡献者、star 或个人参与度。',
  '仓库归属该账号不代表个人贡献；组织/仓库作者不假定为研究对象；账号研究不认定同一人关联。'
];

export const FETCH_GITHUB_REPOSITORY_LIMITATIONS: readonly string[] = [
  '仓库切片只枚举 issues（含 PR，state=all，真实 Link 分页），保存 issue/PR 正文与每个条目的首页 issue 评论。',
  '不抓取 review 线程、完整评论线程、代码或媒体；评论只保留第一页，分页余量显式记为缺口。',
  '评论归属以实际 login/id 记录，保留原始 permalink 与完整正文；第三方/未知角色原样保留。',
  '仓库与组织作者不假定为研究对象；仓库枚举穷尽不代表个人历史完整。'
];

export const FETCH_GITHUB_COMMON_LIMITATIONS: readonly string[] = [
  `只读取 GitHub 公开 API（api.github.com，版本 ${FETCH_GITHUB_API_VERSION}）中 private=false 的公开资源；即使配置令牌也不读取私有资源。`,
  '不做语义综合或质量判断；研究问题保持未回答，除非有已实现的验证器支持。',
  '失败/限流/超限/私有/缺失的读取保留为显式缺口，不计为零结果，也不作完成声明。',
  '阶段 1（真实抓取）与阶段 2（冻结快照处理）分离：快照冻结后处理阶段零新 HTTP 请求、不重复计费。',
  '确定性调度器零外部模型请求/令牌，不代表真实 LLM 使用。'
];

export function fetchGithubLimitations(target: FetchGithubTarget): string[] {
  return [
    ...(target.kind === 'account' ? FETCH_GITHUB_ACCOUNT_LIMITATIONS : FETCH_GITHUB_REPOSITORY_LIMITATIONS),
    ...FETCH_GITHUB_COMMON_LIMITATIONS
  ];
}

export interface FetchGithubScopeSpecInput {
  question: string;
  target: FetchGithubTarget;
}

/** Question slot for the frozen user question (free-form, no slot mapping). */
export interface FetchGithubScopeQuestion {
  questionId: string;
  slot: null;
  text: string;
  applicability: 'applicable';
  applicabilityReason: string;
}

export function fetchGithubScopeQuestion(question: string): FetchGithubScopeQuestion {
  return {
    questionId: 'q-fetch-goal',
    slot: null,
    text: question,
    applicability: 'applicable',
    applicabilityReason: '用户在开始抓取前显式确认并冻结的研究问题'
  };
}

/** One required check the frozen scope must carry (stays unresolved here). */
export function fetchGithubRequiredCheck(): { checkId: string; kind: 'source_diversity'; required: string[] } {
  return {
    checkId: 'github-public-capture',
    kind: 'source_diversity',
    required: ['github:public-capture']
  };
}
