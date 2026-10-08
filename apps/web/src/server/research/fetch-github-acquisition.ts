/**
 * GET-99 real GitHub Fetch acquisition (phase 1): one controlled transport,
 * durable per-request intent BEFORE any HTTP, and an atomic settle + fold +
 * checkpoint commit per response. Everything here operates on untrusted
 * provider data: parsed fields are validated against the frozen target and
 * anything that fails validation becomes an explicit gap, never a fabricated
 * result.
 *
 * Rules enforced here:
 * - Only GENERATED `https://api.github.com` paths under the frozen,
 *   explicitly confirmed target may reach the network. Link continuation URLs
 *   are used only after `validateGithubContinuation` binds them to the same
 *   endpoint family, the exact frozen non-pagination query values and the
 *   publicly verified numeric ids. Credentials are attached only to those
 *   validated api.github.com URLs and never follow redirects (redirects are
 *   refused outright).
 * - A persisted SUCCESSFUL request is never repeated (request-key dedupe).
 *   Failed/rate-limited/oversize/private/missing reads stay explicit gaps;
 *   unknown outcomes are never retried automatically — only an explicit user
 *   resume may re-issue them as a fresh journaled attempt.
 * - There is no cumulative request/item/history cap: planning is derived from
 *   the durable journal and checkpoint, so any number of requests is
 *   resumable across close/reopen and pause/resume.
 */

import { createHash } from 'node:crypto';
import { LIMITS } from '../../shared/limits.js';
import type { RecordProvenance } from '../../shared/research-case.js';
import type { ScopeVersion } from '../../shared/research-case.js';
import {
  FETCH_GITHUB_API_VERSION,
  fetchGithubIssueItemKey,
  fetchGithubRepoItemKey,
  frozenQueryFor,
  linkHeaderNext,
  parseLinkHeader,
  validateGithubContinuation,
  buildFetchGithubRequest,
  fetchGithubRequestKey,
  type FetchGithubRequestDescriptor,
  type FetchGithubTarget
} from '../../shared/research-fetch-github.js';
import { readBoundedBody } from '../adapters/http.js';
import { ProviderError } from '../adapters/types.js';
import type { HttpTransport, HttpHeadersLike } from '../adapters/types.js';
import { sha256Hex } from './completion-eval.js';
import type { Store } from '../store.js';
import type {
  FetchGithubCheckpoint,
  FetchGithubRunRecord,
  FetchGithubStore
} from './fetch-github-store.js';

export const FETCH_GITHUB_ACQUISITION_PROVENANCE: RecordProvenance = {
  authorization: 'user_confirmed',
  collector: 'fetch-github',
  note: null
};

/** read_post tool bound: bodies beyond it stay journal-only with a gap. */
const PROCESSING_TEXT_MAX = 100_000;
const COMMENT_EXCERPT_MAX = 8_000;
const TITLE_MAX = 500;

export class TransportRefusedError extends Error {
  constructor(readonly detail: string) {
    super(`transport refused: ${detail}`);
    this.name = 'TransportRefusedError';
  }
}

/* ------------------------------------------------------------------ */
/* Controlled transport (the only path to real HTTP)                   */
/* ------------------------------------------------------------------ */

const API_PATH_PREFIXES = ['/users/', '/orgs/', '/organizations/', '/repos/', '/repositories/'];

export function isGeneratedApiGithubUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname.toLowerCase() !== 'api.github.com') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  if (url.hash) return false;
  if (url.pathname.includes('..') || url.pathname.includes('//')) return false;
  return API_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

export interface ControlledGithubTransportOptions {
  base: HttpTransport;
  githubToken: string | null;
  /**
   * Extra journal guard: the URL must match a durable in-flight request row
   * ("never prefetch outside the journal"). Absent = pure URL-shape guard.
   */
  allowUrl?: (url: string) => boolean;
}

/**
 * The single controlled transport for phase 1. Handlers never receive raw
 * fetch access: only validated generated api.github.com URLs go out, the
 * optional token is attached only to those exact URLs (never to redirects or
 * substituted Link hosts), and redirects are refused outright.
 */
export function createControlledGithubTransport(options: ControlledGithubTransportOptions): HttpTransport {
  return {
    async fetch(url, init) {
      if (!isGeneratedApiGithubUrl(url)) {
        throw new TransportRefusedError(`url outside the generated api.github.com surface`);
      }
      if (options.allowUrl && !options.allowUrl(url)) {
        throw new TransportRefusedError('url is not a durable in-flight journal request');
      }
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'StripSearch-Alpha',
        'x-github-api-version': FETCH_GITHUB_API_VERSION,
        ...((init?.headers as Record<string, string> | undefined) ?? {})
      };
      if (options.githubToken) headers.authorization = `Bearer ${options.githubToken}`;
      const response = await options.base.fetch(url, {
        ...init,
        headers,
        // Never follow a redirect: no credential forwarding, no host or
        // query substitution through redirect targets.
        redirect: 'error'
      });
      if (response.redirected) throw new ProviderError('provider_redirect', '供应商重定向已被拒绝。', response.status);
      return response;
    }
  };
}

export interface GithubAcquisitionResponse {
  status: number;
  body: string;
  bodyHash: string;
  bodyBytes: number;
  linkHeader: string | null;
  apiVersion: string | null;
  rateRemaining: string | null;
}

export interface ExecuteGithubRequestOptions {
  transport: HttpTransport;
  url: string;
  githubToken: string | null;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
}

/**
 * One provider request with the existing provider timeout/byte limits and
 * caller abort. Returns the EXACT complete body for every status so the
 * journal can hash what the provider actually sent. Timeout and transport
 * faults throw `ProviderError('provider_timeout' | 'provider_error')` and are
 * classified as UNKNOWN outcomes by the caller (the request may have
 * executed; its cost stays unknown).
 */
export async function executeGithubRequest(options: ExecuteGithubRequestOptions): Promise<GithubAcquisitionResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal.aborted) controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const transport = createControlledGithubTransport({
      base: options.transport,
      githubToken: options.githubToken,
      allowUrl: () => true
    });
    let response;
    try {
      response = await transport.fetch(options.url, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof TransportRefusedError) throw error;
      if (error instanceof ProviderError) throw error;
      if (options.signal.aborted) {
        throw new ProviderError('provider_error', '请求已取消，结果未知。');
      }
      if (timedOut || controller.signal.aborted) {
        throw new ProviderError('provider_timeout', '供应商请求超时。');
      }
      // A transport-level fault may still have executed remotely: unknown.
      throw new ProviderError('provider_error', '供应商请求失败，结果未知。');
    }
    const body = await readBoundedBody(response, options.maxBytes);
    return {
      status: response.status,
      body,
      bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      linkHeader: headerOf(response.headers, 'link'),
      apiVersion: headerOf(response.headers, 'x-github-api-version'),
      rateRemaining: headerOf(response.headers, 'x-ratelimit-remaining')
    };
  } catch (error) {
    // Body reads can fail/abort after headers arrive too. Dispatch already
    // happened, so an unclassified transport fault never means definite failure.
    if (error instanceof ProviderError || error instanceof TransportRefusedError) throw error;
    throw new ProviderError(
      timedOut ? 'provider_timeout' : 'provider_error',
      timedOut ? '供应商请求超时。' : '供应商请求失败，结果未知。'
    );
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

function headerOf(headers: HttpHeadersLike, name: string): string | null {
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Untrusted response parsing (validated against the frozen target)    */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sameGithubRepoUrl(url: string | null, owner: string, name: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    const segments = parsed.pathname.split('/').filter(Boolean);
    return (
      segments.length === 2 &&
      (segments[0] ?? '').toLowerCase() === owner.toLowerCase() &&
      (segments[1] ?? '').toLowerCase() === name.toLowerCase()
    );
  } catch {
    return false;
  }
}

export interface ParsedProfile {
  login: string;
  numericId: number | null;
  accountKind: 'user' | 'org';
}

export function parseProfileResponse(raw: unknown, expectedLogin: string): ParsedProfile | null {
  const object = asRecord(raw);
  const login = asString(object.login);
  if (!login || login.toLowerCase() !== expectedLogin.toLowerCase()) return null;
  const type = asString(object.type);
  if (type !== 'User' && type !== 'Organization') return null;
  return { login, numericId: asNumber(object.id), accountKind: type === 'Organization' ? 'org' : 'user' };
}

export interface ParsedRepoRow {
  rowKey: string;
  repoId: number | null;
  ownerLogin: string;
  name: string;
  fullName: string;
  private: boolean;
  fork: boolean;
  htmlUrl: string | null;
  pushedAt: string | null;
  description: string | null;
}

export function parseRepoRow(raw: unknown, expectedOwner: string): ParsedRepoRow | null {
  const object = asRecord(raw);
  const name = asString(object.name);
  const owner = asRecord(object.owner);
  const ownerLogin = asString(owner.login);
  if (!name || !ownerLogin || ownerLogin.toLowerCase() !== expectedOwner.toLowerCase()) return null;
  const htmlUrl = asString(object.html_url);
  if (htmlUrl && !sameGithubRepoUrl(htmlUrl, ownerLogin, name)) return null;
  // Strict public-only authorization: `private` must be an ACTUAL boolean.
  // Missing or non-boolean privacy can never normalize to public (false).
  if (typeof object.private !== 'boolean') return null;
  return {
    rowKey: fetchGithubRepoItemKey(ownerLogin, name),
    repoId: asNumber(object.id),
    ownerLogin,
    name,
    fullName: `${ownerLogin}/${name}`,
    private: object.private,
    fork: object.fork === true,
    htmlUrl,
    pushedAt: asString(object.pushed_at),
    description: asString(object.description)
  };
}

export interface ParsedIssueRow {
  rowKey: string;
  issueNumber: number;
  kind: 'issue' | 'pull_request';
  title: string;
  body: string | null;
  authorLogin: string | null;
  authorId: number | null;
  htmlUrl: string | null;
  createdAt: string | null;
  commentCount: number | null;
}

export function parseIssueRow(raw: unknown, owner: string, name: string): ParsedIssueRow | null {
  const object = asRecord(raw);
  const number = asNumber(object.number);
  if (number === null || number < 1) return null;
  const htmlUrl = asString(object.html_url);
  if (htmlUrl) {
    try {
      const parsed = new URL(htmlUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const valid =
        parsed.protocol === 'https:' &&
        parsed.hostname.toLowerCase() === 'github.com' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        segments.length === 4 &&
        (segments[0] ?? '').toLowerCase() === owner.toLowerCase() &&
        (segments[1] ?? '').toLowerCase() === name.toLowerCase() &&
        (segments[2] === 'issues' || segments[2] === 'pull') &&
        segments[3] === String(number);
      if (!valid) return null;
    } catch {
      return null;
    }
  }
  const user = asRecord(object.user);
  const isPull = object.pull_request !== undefined && object.pull_request !== null;
  return {
    rowKey: fetchGithubIssueItemKey(owner, name, number),
    issueNumber: number,
    kind: isPull ? 'pull_request' : 'issue',
    title: asString(object.title) ?? `#${String(number)}`,
    body: typeof object.body === 'string' ? object.body : object.body === null ? '' : null,
    authorLogin: asString(user.login),
    authorId: asNumber(user.id),
    htmlUrl,
    createdAt: asString(object.created_at),
    commentCount: asNumber(object.comments)
  };
}

export interface ParsedCommentRow {
  commentId: string;
  authorLogin: string | null;
  authorId: number | null;
  authorRole: 'subject' | 'third_party' | 'unknown';
  originalUrl: string | null;
  body: string;
  bodyHash: string;
  excerpt: string;
  commentCreatedAt: string | null;
}

/**
 * One first-page issue comment: attribution is the ACTUAL provider login/id,
 * the original permalink and complete body are preserved, and third-party or
 * unknown roles stay explicit — an organization/repository author is never
 * assumed to be the subject.
 */
export function parseCommentRow(
  raw: unknown,
  owner: string,
  name: string,
  issueNumber: number,
  subjectLogin: string
): ParsedCommentRow | null {
  const object = asRecord(raw);
  const id = asNumber(object.id);
  if (id === null || id < 1) return null;
  const userRaw = object.user;
  const user = userRaw === null || userRaw === undefined ? null : asRecord(userRaw);
  const login = user ? asString(user.login) : null;
  // The captured body must be an ACTUAL string: a numeric/structured body is
  // unparseable material and becomes an explicit gap, never a fabricated
  // empty full text.
  if (typeof object.body !== 'string') return null;
  const body = object.body;
  // The permalink must bind to the EXACT requested issue/PR number and the
  // EXACT comment fragment; a same-repo substring match is never accepted.
  let originalUrl = asString(object.html_url);
  if (originalUrl) {
    try {
      const parsed = new URL(originalUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const ok =
        parsed.protocol === 'https:' &&
        parsed.hostname.toLowerCase() === 'github.com' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        segments.length === 4 &&
        (segments[0] ?? '').toLowerCase() === owner.toLowerCase() &&
        (segments[1] ?? '').toLowerCase() === name.toLowerCase() &&
        (segments[2] === 'issues' || segments[2] === 'pull') &&
        segments[3] === String(issueNumber) &&
        parsed.hash === `#issuecomment-${String(id)}`;
      if (!ok) originalUrl = null;
    } catch {
      originalUrl = null;
    }
  }
  const authorRole: ParsedCommentRow['authorRole'] =
    login === null ? 'unknown' : login.toLowerCase() === subjectLogin.toLowerCase() ? 'subject' : 'third_party';
  return {
    commentId: `issuecomment-${String(id)}`,
    authorLogin: login,
    authorId: user ? asNumber(user.id) : null,
    authorRole,
    originalUrl,
    body,
    bodyHash: sha256Hex(body),
    excerpt: body.slice(0, COMMENT_EXCERPT_MAX),
    commentCreatedAt: asString(object.created_at)
  };
}

export interface ParsedReadme {
  fulltext: string;
  htmlUrl: string | null;
  path: string | null;
  size: number | null;
  blobSha: string | null;
}

export function parseReadmeResponse(raw: unknown, owner: string, name: string): ParsedReadme | null {
  const object = asRecord(raw);
  if (asString(object.type) !== 'file') return null;
  const encoding = asString(object.encoding);
  const content = asString(object.content);
  if (encoding !== 'base64' || content === null) return null;
  // Strict base64: canonical alphabet only and a canonical round-trip, so
  // corrupted bytes are never silently accepted or fabricated as text.
  const packed = content.replace(/\n/g, '');
  if (packed.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packed)) return null;
  const bytes = Buffer.from(packed, 'base64');
  if (bytes.toString('base64') !== packed) return null;
  // Valid UTF-8 only: invalid sequences reject the body instead of decoding
  // to replacement characters (a fabricated full text).
  let fulltext: string;
  try {
    fulltext = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // The declared byte size must match the decoded body exactly.
  const declaredSize = asNumber(object.size);
  if (declaredSize === null || declaredSize !== bytes.byteLength) return null;
  const htmlUrl = asString(object.html_url);
  if (htmlUrl) {
    try {
      const parsed = new URL(htmlUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const ok =
        parsed.protocol === 'https:' &&
        parsed.hostname.toLowerCase() === 'github.com' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        segments.length >= 4 &&
        (segments[0] ?? '').toLowerCase() === owner.toLowerCase() &&
        (segments[1] ?? '').toLowerCase() === name.toLowerCase();
      if (!ok) return null;
    } catch {
      return null;
    }
  }
  return {
    fulltext,
    htmlUrl,
    path: asString(object.path),
    size: asNumber(object.size),
    blobSha: asString(object.sha)
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic planning (derived from the durable journal)           */
/* ------------------------------------------------------------------ */

export type AcquisitionPurpose =
  | 'profile'
  | 'repo_meta'
  | 'repos_list'
  | 'repos_next'
  | 'repo_readme'
  | 'issues_list'
  | 'issues_next'
  | 'issue_comments';

export interface PlannedRequest {
  descriptor: FetchGithubRequestDescriptor;
  purpose: AcquisitionPurpose;
  /** Target item for per-material requests (readme / comments). */
  itemKey?: string;
}

function targetLogin(target: FetchGithubTarget): string {
  return target.kind === 'account' ? target.login : target.owner;
}

function reposFrozenQuery(cp: FetchGithubCheckpoint): Record<string, string> {
  return cp.accountKind === 'user' ? { per_page: '30', type: 'owner' } : { ...frozenQueryFor('repos_list') };
}

/**
 * The next acquisition request, derived deterministically from the durable
 * journal + checkpoint. Request keys with ANY prior attempt are never
 * re-planned unless the user explicitly authorised a retry of an unknown
 * outcome (`checkpoint.retryRequestKeys`); persisted successful requests are
 * never repeated.
 */
export function planNextRequest(
  run: FetchGithubRunRecord,
  journal: FetchGithubStore
): PlannedRequest | null {
  const cp = run.checkpoint;
  if (cp.snapshot.frozen) return null;
  if (cp.gaps.some((gap) => gap.code === 'private_target')) return null;
  const requests = journal.listRequests(run.runId);
  const attempted = new Map<string, boolean>();
  for (const request of requests) attempted.set(request.requestKey, true);
  const retryKeys = new Set(cp.retryRequestKeys ?? []);
  const canIssue = (descriptor: FetchGithubRequestDescriptor): boolean => {
    const key = fetchGithubRequestKey(descriptor);
    const latest = requests.filter((r) => r.requestKey === key).sort((a, b) => b.attempt - a.attempt)[0];
    return !attempted.has(key) ||
      (cp.retryAuthorizationVersion === 2 && retryKeys.has(key) && latest?.state === 'unknown' && latest.reconciledAt !== null &&
        !requests.some((r) => r.requestKey === key && r.state === 'succeeded'));
  };
  const succeeded = (kind: string): boolean => requests.some((request) => request.kind === kind && request.state === 'succeeded');
  const login = targetLogin(cp.target);

  // 1. Public profile first: it verifies the account identity/numeric id the
  //    Link id-forms and the user/org listing distinction are bound to.
  const profileBuild = buildFetchGithubRequest('profile', { login });
  if (profileBuild.ok && canIssue(profileBuild.request)) return { descriptor: profileBuild.request, purpose: 'profile' };

  // 2. Repository target: authoritative repo metadata (id + private=false)
  //    before any issues enumeration.
  if (cp.target.kind === 'repository') {
    const { owner, name } = cp.target;
    const metaBuild = buildFetchGithubRequest('repo_meta', { owner, name });
    if (metaBuild.ok && canIssue(metaBuild.request)) return { descriptor: metaBuild.request, purpose: 'repo_meta' };
    if (succeeded('repo_meta') && cp.verified.repoId !== null && cp.publicConfirmed === true) {
      const listing = planListingContinuation(run.runId, 'issues', cp, journal, canIssue);
      if (listing) return listing;
      if (cp.listings.issues?.done === true) {
        const comments = planIssueComments(run.runId, cp, journal, canIssue);
        if (comments) return comments;
      }
    }
    return null;
  }

  // 3. Account target: public owned repositories (real Link pagination),
  //    then each owned repository's README / current public work snapshot.
  if (succeeded('profile')) {
    const listing = planListingContinuation(run.runId, 'repos', cp, journal, canIssue);
    if (listing) return listing;
    if (cp.listings.repos?.done === true) {
      const readme = planReadmes(run.runId, cp, journal, canIssue);
      if (readme) return readme;
    }
  }
  return null;
}

function planListingContinuation(
  runId: string,
  kind: 'repos' | 'issues',
  cp: FetchGithubCheckpoint,
  journal: FetchGithubStore,
  canIssue: (descriptor: FetchGithubRequestDescriptor) => boolean
): PlannedRequest | null {
  void runId;
  const cursor = cp.listings[kind];
  const requestKind = kind === 'repos' ? 'repos_list' : 'issues_list';
  if (cursor === null || cursor === undefined) {
    if (cp.target.kind === 'repository') {
      const build = buildFetchGithubRequest('issues_list', { owner: cp.target.owner, name: cp.target.name });
      return build.ok && canIssue(build.request) ? { descriptor: build.request, purpose: 'issues_list' } : null;
    }
    const build = buildFetchGithubRequest('repos_list', {
      login: cp.target.login,
      userType: cp.accountKind === 'org' ? 'org' : 'user'
    });
    return build.ok && canIssue(build.request) ? { descriptor: build.request, purpose: 'repos_list' } : null;
  }
  if (cursor.done || cursor.nextUrl === null) return null;
  const descriptor: FetchGithubRequestDescriptor = { kind: requestKind, method: 'GET', url: cursor.nextUrl };
  return canIssue(descriptor) ? { descriptor, purpose: kind === 'repos' ? 'repos_next' : 'issues_next' } : null;
}

function planReadmes(
  runId: string,
  cp: FetchGithubCheckpoint,
  journal: FetchGithubStore,
  canIssue: (descriptor: FetchGithubRequestDescriptor) => boolean
): PlannedRequest | null {
  if (cp.target.kind !== 'account') return null;
  const rows = journal
    .listListingRows(runId, 'repos')
    .map((row) => row.row)
    .filter((row) => row.private !== true)
    .map((row) => ({ owner: String(row.ownerLogin ?? ''), name: String(row.name ?? '') }))
    .filter((row) => row.owner.length > 0 && row.name.length > 0)
    .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  for (const row of rows) {
    const build = buildFetchGithubRequest('repo_readme', { owner: row.owner, name: row.name });
    if (!build.ok) continue;
    if (!canIssue(build.request)) continue;
    return { descriptor: build.request, purpose: 'repo_readme', itemKey: fetchGithubRepoItemKey(row.owner, row.name) };
  }
  return null;
}

function planIssueComments(
  runId: string,
  cp: FetchGithubCheckpoint,
  journal: FetchGithubStore,
  canIssue: (descriptor: FetchGithubRequestDescriptor) => boolean
): PlannedRequest | null {
  if (cp.target.kind !== 'repository') return null;
  const rows = journal
    .listListingRows(runId, 'issues')
    .map((row) => row.row)
    .map((row) => ({ number: Number(row.issueNumber ?? 0) }))
    .filter((row) => Number.isSafeInteger(row.number) && row.number > 0)
    .sort((a, b) => a.number - b.number);
  for (const row of rows) {
    const build = buildFetchGithubRequest('issue_comments', {
      owner: cp.target.owner,
      name: cp.target.name,
      issueNumber: row.number
    });
    if (!build.ok) continue;
    if (!canIssue(build.request)) continue;
    return {
      descriptor: build.request,
      purpose: 'issue_comments',
      itemKey: fetchGithubIssueItemKey(cp.target.owner, cp.target.name, row.number)
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* One acquisition quantum (durable intent -> HTTP -> atomic fold)     */
/* ------------------------------------------------------------------ */

export interface AcquisitionPorts {
  store: Store;
  journal: FetchGithubStore;
  transport: HttpTransport;
  githubToken: string | null;
  timeoutMs?: number;
  maxBytes?: number;
}

export type AcquisitionQuantumResult =
  | { outcome: 'settled'; requestKey: string; unknownOutcome: boolean }
  | { outcome: 'done' }
  | { outcome: 'stopped'; reason: string };

/**
 * Authoritative current case state (owner / case / frozen scope version /
 * selected allowed account) read FRESH from the Store before every HTTP
 * reservation and again inside the atomic settle/fold. The run's journal
 * version of the scope is never its own authority.
 */
export function acquisitionAuthorityRefusal(store: Store, run: FetchGithubRunRecord): string | null {
  const record = store.cases.getCase(run.ownerId, run.caseId);
  if (!record) return 'case refused: unknown to current store state';
  if (record.ownerId !== run.ownerId || record.caseId !== run.caseId) return 'scope refused: owner/case drift';
  if (record.scopeVersion !== run.scopeVersion) return 'scope refused: frozen run scope is stale against current store state';
  const account = store.cases.listAccounts(run.ownerId, run.caseId).find((entry) => entry.accountId === run.checkpoint.accountId);
  if (!account) return 'scope refused: authorized account disappeared from the case';
  if (account.userSelection.state !== 'selected' && account.userSelection.state !== 'only_this_account') {
    return 'scope refused: target account is no longer explicitly selected';
  }
  if (account.allowedScope.state !== 'public_history') {
    return 'scope refused: target account no longer has public_history scope';
  }
  return null;
}

/**
 * Execute ONE planned request. The durable intent row is written BEFORE any
 * HTTP; the settle + fold + checkpoint commit atomically. Current Store
 * authority is re-read before the request and inside the settle transaction;
 * any control fence (revision bump from pause/resume/stop), state change,
 * owner/case/scope drift or authority refusal rejects the late packet WITHOUT
 * persisting its body or any capture — for every request kind. An unknown
 * outcome (timeout / transport fault after dispatch) settles as `unknown`,
 * stops the run as unreconciled and is never retried automatically.
 */
export async function executeAcquisitionQuantum(
  run: FetchGithubRunRecord,
  ports: AcquisitionPorts,
  signal: AbortSignal
): Promise<AcquisitionQuantumResult> {
  const { journal } = ports;
  const freshAtStart = journal.requireRun(run.runId);
  if (freshAtStart.state !== 'acquiring') return { outcome: 'stopped', reason: `run state ${freshAtStart.state}` };
  // An unknown outcome stops the acquisition BEFORE any next HTTP until the
  // user explicitly reconciles it (retry/skip) — never an automatic retry.
  if (journal.listUnresolvedRequests(run.runId).length > 0) {
    return { outcome: 'stopped', reason: 'unresolved request outcomes require explicit reconciliation' };
  }
  // Frozen authority BEFORE any request: the current Store case state, not
  // the journal's own recorded scope version.
  const entryRefusal = acquisitionAuthorityRefusal(ports.store, freshAtStart);
  if (entryRefusal !== null) {
    journal.inTransaction(() => {
      const cp = journal.requireRun(run.runId).checkpoint;
      cp.gaps.push({ code: 'authority_refused', detail: entryRefusal });
      journal.updateCheckpoint(run.runId, cp);
      journal.updateRun(run.runId, { state: 'stopped', stopReason: 'scope_changed' });
    });
    journal.appendEvent(run.runId, 'authority_refused', { detail: entryRefusal });
    return { outcome: 'stopped', reason: entryRefusal };
  }
  const plan = planNextRequest(freshAtStart, journal);
  if (plan === null) return { outcome: 'done' };

  const requestKey = fetchGithubRequestKey(plan.descriptor);
  // Control fencing: a pause/resume/stop bumps the run revision; a response
  // belonging to an older generation is rejected, never folded.
  const startRevision = freshAtStart.revision;
  // Durable intent BEFORE any HTTP ("never prefetch outside the journal").
  const request = journal.inTransaction(() => {
    const { request: attempt } = journal.beginRequest({
      runId: run.runId,
      requestKey,
      kind: plan.descriptor.kind,
      url: plan.descriptor.url
    });
    // One explicit choice authorizes ONE attempt, consumed with its durable
    // intent. A failed/unknown retry cannot inherit that choice on restart.
    const checkpoint = journal.requireRun(run.runId).checkpoint;
    checkpoint.retryRequestKeys = checkpoint.retryRequestKeys.filter((key) => key !== requestKey);
    journal.updateCheckpoint(run.runId, checkpoint);
    journal.appendEvent(run.runId, 'request_intent', {
      requestKey,
      kind: plan.descriptor.kind,
      purpose: plan.purpose,
      attempt: attempt.attempt
    });
    return attempt;
  });

  let response: GithubAcquisitionResponse | null = null;
  let failure: unknown = null;
  try {
    response = await executeGithubRequest({
      transport: ports.transport,
      url: plan.descriptor.url,
      githubToken: ports.githubToken,
      timeoutMs: ports.timeoutMs ?? LIMITS.providerTimeoutMs,
      maxBytes: ports.maxBytes ?? LIMITS.providerMaxBytes,
      signal
    });
  } catch (error) {
    failure = error;
  }

  // Fence + late-packet rejection BEFORE anything else: explicit
  // pause/resume/stop (control revision bump), state change, owner/case/scope
  // drift or authority refusal means NO body and NO capture persistence —
  // for profile / repos / README / issues / comments alike.
  const fresh = journal.requireRun(run.runId);
  const fenceDrift =
    fresh.revision !== startRevision ||
    fresh.state !== 'acquiring' ||
    fresh.ownerId !== freshAtStart.ownerId ||
    fresh.caseId !== freshAtStart.caseId ||
    fresh.scopeVersion !== freshAtStart.scopeVersion;
  const lateAuthority = acquisitionAuthorityRefusal(ports.store, fresh);
  if (fenceDrift || lateAuthority !== null) {
    const reason = lateAuthority ?? `control fence: run advanced to revision ${String(fresh.revision)}`;
    journal.inTransaction(() => {
      journal.settleRequest(request.requestId, {
        // The request went out: its outcome is unknown and its cost stays
        // unknown. Nothing of the late packet is persisted.
        state: 'unknown',
        status: null,
        body: null,
        bodyHash: null,
        bodyBytes: null,
        linkHeader: null,
        apiVersion: null,
        gap: `late_packet_rejected: ${reason}`
      });
      const cp = journal.requireRun(run.runId).checkpoint;
      cp.gaps.push({ code: 'late_packet_rejected', detail: `${requestKey}: ${reason}` });
      journal.updateCheckpoint(run.runId, cp);
    });
    journal.appendEvent(run.runId, 'request_rejected', { requestKey, reason });
    return { outcome: 'stopped', reason };
  }

  if (response === null) {
    const error = failure;
    const unknown =
      error instanceof ProviderError &&
      (error.code === 'provider_timeout' || error.code === 'provider_error');
    const oversize = error instanceof ProviderError && error.code === 'provider_response_too_large';
    const redirect = error instanceof ProviderError && error.code === 'provider_redirect';
    const gap = oversize
      ? 'oversize_response'
      : redirect
        ? 'redirect_refused'
        : unknown
          ? 'outcome_unknown'
          : error instanceof TransportRefusedError
            ? 'transport_refused'
            : 'request_failed';
    journal.inTransaction(() => {
      journal.settleRequest(request.requestId, {
        // A timeout/transport fault may have executed remotely: honest unknown.
        state: unknown ? 'unknown' : 'failed',
        status: error instanceof ProviderError && typeof error.status === 'number' ? error.status : null,
        body: null,
        bodyHash: null,
        bodyBytes: null,
        linkHeader: null,
        apiVersion: null,
        gap
      });
      const cp = journal.requireRun(run.runId).checkpoint;
      cp.gaps.push({
        code: gap,
        detail: `${plan.descriptor.kind} ${requestKey}: ${error instanceof Error ? error.message : 'request failed'}`
      });
      journal.updateCheckpoint(run.runId, cp);
    });
    journal.appendEvent(run.runId, 'request_outcome', { requestKey, state: unknown ? 'unknown' : 'failed', gap });
    return { outcome: 'settled', requestKey, unknownOutcome: unknown };
  }

  const succeeded = response.status >= 200 && response.status < 300;
  journal.inTransaction(() => {
    // Authority re-check INSIDE the atomic settle/fold: a scope change while
    // the response was in flight forbids the raw body persistence too.
    const innerAuthority = acquisitionAuthorityRefusal(ports.store, journal.requireRun(run.runId));
    if (innerAuthority !== null) {
      journal.settleRequest(request.requestId, {
        state: 'unknown',
        status: null,
        body: null,
        bodyHash: null,
        bodyBytes: null,
        linkHeader: null,
        apiVersion: null,
        gap: `late_packet_rejected: ${innerAuthority}`
      });
      const innerCp = journal.requireRun(run.runId).checkpoint;
      innerCp.gaps.push({ code: 'late_packet_rejected', detail: `${requestKey}: ${innerAuthority}` });
      journal.updateCheckpoint(run.runId, innerCp);
      return;
    }
    journal.settleRequest(request.requestId, {
      state: succeeded ? 'succeeded' : 'failed',
      status: response!.status,
      body: response!.body,
      bodyHash: response!.bodyHash,
      bodyBytes: response!.bodyBytes,
      linkHeader: response!.linkHeader,
      apiVersion: response!.apiVersion,
      gap: succeeded ? null : statusGap(response!.status)
    });
    const cp = journal.requireRun(run.runId).checkpoint;
    if (succeeded) {
      // HTTP settlement and validated SEMANTIC capture are separate facts:
      // a 200 with a malformed payload is recorded 'invalid'/'partial' and
      // never becomes a successful captured read.
      const semantic = foldResponse(journal, ports.store, fresh, plan, response!, cp);
      journal.setRequestSemantic(request.requestId, semantic);
    } else {
      cp.gaps.push({ code: statusGap(response!.status), detail: `${plan.descriptor.kind} ${requestKey}: HTTP ${String(response!.status)}` });
    }
    journal.updateCheckpoint(run.runId, cp);
  });
  journal.appendEvent(run.runId, 'request_outcome', {
    requestKey,
    state: succeeded ? 'succeeded' : 'failed',
    status: response.status,
    bodyHash: response.bodyHash
  });
  return { outcome: 'settled', requestKey, unknownOutcome: false };
}

function statusGap(status: number): string {
  if (status === 404) return 'missing';
  if (status === 403) return 'forbidden_or_rate_limited';
  if (status === 429) return 'rate_limited';
  if (status === 451) return 'unavailable';
  if (status >= 500) return 'provider_error';
  return 'bad_response';
}

/* ------------------------------------------------------------------ */
/* Folding (atomic with the settle)                                    */
/* ------------------------------------------------------------------ */

/**
 * Fold one settled response. Returns the VALIDATED SEMANTIC capture outcome
 * ('valid' | 'partial' | 'invalid') — separate from the HTTP settlement: a
 * 200 with a non-array/unparseable payload or unparseable rows is never a
 * successful captured read.
 */
function foldResponse(
  journal: FetchGithubStore,
  store: Store,
  run: FetchGithubRunRecord,
  plan: PlannedRequest,
  response: GithubAcquisitionResponse,
  cp: FetchGithubCheckpoint
): 'valid' | 'partial' | 'invalid' {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    cp.gaps.push({ code: 'unparseable_body', detail: `${plan.purpose} ${plan.descriptor.url} returned non-JSON content` });
    return 'invalid';
  }
  const subjectLogin = targetLogin(cp.target);
  switch (plan.purpose) {
    case 'profile': {
      const profile = parseProfileResponse(parsed, subjectLogin);
      if (!profile) {
        cp.gaps.push({ code: 'profile_mismatch', detail: '公开资料与目标账号不一致，未采信' });
        return 'invalid';
      }
      cp.accountKind = profile.accountKind;
      cp.verified = { ...cp.verified, accountId: profile.numericId };
      return 'valid';
    }
    case 'repo_meta': {
      if (cp.target.kind !== 'repository') return 'invalid';
      const row = parseRepoRow(parsed, cp.target.owner);
      if (!row || row.name.toLowerCase() !== cp.target.name.toLowerCase()) {
        cp.gaps.push({ code: 'repo_meta_mismatch', detail: '仓库元数据与目标仓库不一致，未采信' });
        return 'invalid';
      }
      if (row.private !== false) {
        // Strictly public targets only, even with a token configured.
        cp.gaps.push({ code: 'private_target', detail: '目标仓库不是公开仓库（private≠false），已停止抓取' });
        return 'valid';
      }
      cp.verified = { ...cp.verified, repoId: row.repoId };
      cp.publicConfirmed = true;
      return 'valid';
    }
    case 'repos_list':
    case 'repos_next': {
      if (!Array.isArray(parsed)) {
        cp.gaps.push({ code: 'listing_shape_invalid', detail: `${plan.purpose} 返回的顶层不是数组，未按空页处理` });
        foldListingCursor(journal, run, cp, 'repos', response, true);
        return 'invalid';
      }
      const rows = asArray(parsed)
        .map((entry) => parseRepoRow(entry, subjectLogin))
        .filter((entry): entry is ParsedRepoRow => entry !== null);
      for (const row of rows) {
        if (row.private === true) {
          // Never a zero result: explicitly skipped private material.
          cp.gaps.push({ code: 'private_skipped', detail: `${row.fullName} 为私有仓库，未读取` });
          continue;
        }
        journal.putListingRow({
          runId: run.runId,
          listingKind: 'repos',
          rowKey: row.rowKey,
          requestKey: fetchGithubRequestKey(plan.descriptor),
          row: { ...row }
        });
      }
      const rejected = asArray(parsed).length - rows.length;
      if (rejected > 0) {
        cp.gaps.push({ code: 'listing_row_rejected', detail: '仓库列表页存在与目标账号/URL 不一致的行，未采信' });
      }
      foldListingCursor(journal, run, cp, 'repos', response);
      return rejected > 0 ? 'partial' : 'valid';
    }
    case 'issues_list':
    case 'issues_next': {
      if (cp.target.kind !== 'repository') return 'invalid';
      if (!Array.isArray(parsed)) {
        cp.gaps.push({ code: 'listing_shape_invalid', detail: `${plan.purpose} 返回的顶层不是数组，未按空页处理` });
        foldListingCursor(journal, run, cp, 'issues', response, true);
        return 'invalid';
      }
      const issueTarget = { owner: cp.target.owner, name: cp.target.name };
      const rows = asArray(parsed)
        .map((entry) => parseIssueRow(entry, issueTarget.owner, issueTarget.name))
        .filter((entry): entry is ParsedIssueRow => entry !== null);
      for (const row of rows) {
        // The enumerated row is ALWAYS kept (even without a readable body),
        // so unprocessed rows stay visible as explicit gaps instead of being
        // dropped and then asserted as a known-complete denominator.
        journal.putListingRow({
          runId: run.runId,
          listingKind: 'issues',
          rowKey: row.rowKey,
          requestKey: fetchGithubRequestKey(plan.descriptor),
          row: { ...row }
        });
        if (row.body === null) {
          // Unparseable body text: explicit unreadable gap, no fabricated
          // empty full text and no fake body pin.
          cp.gaps.push({ code: 'row_body_unreadable', detail: `${row.rowKey}: issue/PR 正文不是可解析文本，保留为缺口` });
          continue;
        }
        captureItem(journal, store, run, cp, {
          itemKey: row.rowKey,
          kind: row.kind,
          title: row.title.slice(0, TITLE_MAX),
          originalUrl: row.htmlUrl,
          requestUrl: plan.descriptor.url,
          authorLogin: row.authorLogin,
          authorId: row.authorId,
          publishedAt: row.createdAt,
          fulltext: row.body,
          requestKey: fetchGithubRequestKey(plan.descriptor)
        });
      }
      const rejected = asArray(parsed).length - rows.length;
      if (rejected > 0) {
        cp.gaps.push({ code: 'listing_row_rejected', detail: 'issues 列表页存在与目标仓库不一致的行，未采信' });
      }
      const unreadable = rows.filter((row) => row.body === null).length;
      foldListingCursor(journal, run, cp, 'issues', response);
      return rejected > 0 || unreadable > 0 ? 'partial' : 'valid';
    }
    case 'repo_readme': {
      // Owner/name binding for the README target comes from the request URL.
      const target = readmeTargetFromUrl(plan.descriptor.url, subjectLogin);
      const readme = target ? parseReadmeResponse(parsed, target.owner, target.name) : null;
      if (!target || !readme) {
        cp.gaps.push({ code: 'readme_unreadable', detail: `README 无法解析或不是 base64 文件：${plan.descriptor.url}` });
        return 'invalid';
      }
      captureItem(journal, store, run, cp, {
        itemKey: plan.itemKey ?? fetchGithubRepoItemKey(target.owner, target.name),
        kind: 'readme',
        title: `${target.owner}/${target.name}`,
        originalUrl: readme.htmlUrl,
        requestUrl: plan.descriptor.url,
        // README authorship is NOT the repository owner's: unknown stays null.
        authorLogin: null,
        authorId: null,
        publishedAt: null,
        fulltext: readme.fulltext,
        requestKey: fetchGithubRequestKey(plan.descriptor)
      });
      return 'valid';
    }
    case 'issue_comments': {
      if (cp.target.kind !== 'repository') return 'invalid';
      const commentTarget = { owner: cp.target.owner, name: cp.target.name };
      const itemKey = plan.itemKey ?? '';
      if (!Array.isArray(parsed)) {
        // A malformed 200 body is an explicit gap, never a successful empty
        // comment page.
        cp.gaps.push({ code: 'comment_shape_invalid', detail: `${itemKey} 评论响应的顶层不是数组，未按空页处理` });
        return 'invalid';
      }
      const requestedNumber = Number(itemKey.split('#').pop() ?? '0');
      const rows = asArray(parsed)
        .map((entry) => parseCommentRow(entry, commentTarget.owner, commentTarget.name, requestedNumber, subjectLogin))
        .filter((entry): entry is ParsedCommentRow => entry !== null);
      let changed = 0;
      for (const row of rows) {
        const result = journal.putComment({
          runId: run.runId,
          itemKey,
          commentId: row.commentId,
          authorLogin: row.authorLogin,
          authorId: row.authorId,
          authorRole: row.authorRole,
          originalUrl: row.originalUrl,
          body: row.body,
          bodyHash: row.bodyHash,
          excerpt: row.excerpt,
          commentCreatedAt: row.commentCreatedAt
        });
        if (result === 'hash_changed') {
          changed += 1;
          cp.gaps.push({ code: 'source_changed', detail: `${itemKey} 评论 ${String(row.commentId)} 正文发生冲突；保留首次捕获，未替换来源。` });
        }
      }
      const rejected = asArray(parsed).length - rows.length;
      if (rejected > 0) {
        cp.gaps.push({ code: 'comment_row_rejected', detail: `issue 评论页存在无法绑定的行：${itemKey}` });
      }
      // First page only is in scope: any further Link stays an explicit gap.
      const links = parseLinkHeader(response.linkHeader);
      if (links.next) {
        cp.gaps.push({
          code: 'comments_pagination_not_followed',
          detail: `${itemKey} 的评论超出首页（存在 next Link）；本切片只读取首页评论`
        });
      }
      return rejected > 0 || changed > 0 ? 'partial' : 'valid';
    }
  }
}

function readmeTargetFromUrl(url: string, expectedLogin: string): { owner: string; name: string } | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'repos' || segments.length !== 4 || segments[3] !== 'readme') return null;
    const owner = segments[1] ?? '';
    const name = segments[2] ?? '';
    if (owner.toLowerCase() !== expectedLogin.toLowerCase()) return null;
    return { owner, name };
  } catch {
    return null;
  }
}

function foldListingCursor(
  journal: FetchGithubStore,
  run: FetchGithubRunRecord,
  cp: FetchGithubCheckpoint,
  kind: 'repos' | 'issues',
  response: GithubAcquisitionResponse,
  shapeInvalid = false
): void {
  void journal;
  void run;
  const cursor =
    cp.listings[kind] ?? { done: false, pagesDone: 0, nextUrl: null, seenContinuations: ['page=1'], gaps: [] };
  cursor.pagesDone += 1;
  if (shapeInvalid) {
    // Malformed page: stop this listing with an explicit gap — never a clean
    // terminal boundary and never a manufactured empty result.
    cursor.done = true;
    cursor.nextUrl = null;
    cursor.gaps.push('listing_shape_invalid: page body was not a JSON array');
    cp.listings[kind] = cursor;
    return;
  }
  const nextLink = linkHeaderNext(response.linkHeader);
  if (nextLink.ambiguous) {
    // Two or more rel="next" candidates: ambiguous and never silently
    // resolved. The listing stops with an explicit gap.
    cursor.done = true;
    cursor.nextUrl = null;
    const gap = { code: 'link_rejected', detail: `${kind} continuation refused: ambiguous duplicate rel=next Link header` };
    cursor.gaps.push(`${gap.code}: ${gap.detail}`);
    cp.gaps.push(gap);
    cp.listings[kind] = cursor;
    return;
  }
  const next = nextLink.url;
  if (typeof next !== 'string' || next.length === 0) {
    // Terminal boundary: the provider sent no further continuation.
    cursor.done = true;
    cursor.nextUrl = null;
    cp.listings[kind] = cursor;
    return;
  }
  const validated = validateGithubContinuation(next, {
    kind: kind === 'repos' ? 'repos_list' : 'issues_list',
    target: cp.target,
    verified: cp.verified,
    frozenQuery: kind === 'repos' ? reposFrozenQuery(cp) : frozenQueryFor('issues_list'),
    seenContinuations: cursor.seenContinuations
  });
  if (!validated.ok) {
    // Untrusted/foreign/cyclic continuations are NEVER followed: the listing
    // stops here and the lost range stays an explicit gap.
    cursor.done = true;
    cursor.nextUrl = null;
    const gap = { code: 'link_rejected', detail: `${kind} continuation refused: ${validated.reason}` };
    cursor.gaps.push(`${gap.code}: ${gap.detail}`);
    cp.gaps.push(gap);
    cp.listings[kind] = cursor;
    return;
  }
  cursor.nextUrl = validated.continuation.url;
  cursor.seenContinuations = [...cursor.seenContinuations, validated.continuation.continuationId];
  cp.listings[kind] = cursor;
}

interface CaptureItemInput {
  itemKey: string;
  kind: 'readme' | 'issue' | 'pull_request';
  title: string;
  originalUrl: string | null;
  requestUrl: string;
  authorLogin: string | null;
  authorId: number | null;
  publishedAt: string | null;
  fulltext: string;
  requestKey: string;
}

/**
 * Capture one material body: the exact complete body text with its SHA-256
 * and an immutable CaseStore source revision (the exact source pin phase 2
 * processes against). Same-source dedupe keeps one frozen capture per item;
 * a changed hash is an explicit gap and never silently overwrites the pin.
 */
function captureItem(
  journal: FetchGithubStore,
  store: Store,
  run: FetchGithubRunRecord,
  cp: FetchGithubCheckpoint,
  input: CaptureItemInput
): void {
  const contentHash = sha256Hex(input.fulltext);
  const eligible = input.fulltext.length <= PROCESSING_TEXT_MAX;
  // The FROZEN run scope version is the authority here — never a refreshed
  // current scope version (which would bypass the frozen run).
  const revision = store.cases.recordSourceRevision(
    {
      ownerId: run.ownerId,
      caseId: run.caseId,
      accountId: fetchAccountIdOf(run),
      expectedScopeVersion: run.scopeVersion as ScopeVersion
    },
    {
      // Unknown author stays unknown: repository ownership never implies
      // authorship (no owner-author fallback).
      author: input.authorLogin ?? null,
      originalUrl: input.originalUrl ?? input.requestUrl,
      title: input.title,
      publishedAt: input.publishedAt,
      retrievedAt: new Date().toISOString(),
      locator: input.itemKey,
      contentHash,
      provenance: {
        ...FETCH_GITHUB_ACQUISITION_PROVENANCE,
        note: JSON.stringify({
          captureType: 'github_public_body',
          itemKey: input.itemKey,
          requestKey: input.requestKey,
          apiVersion: FETCH_GITHUB_API_VERSION
        })
      }
    }
  );
  const result = journal.putItem({
    runId: run.runId,
    itemKey: input.itemKey,
    kind: input.kind,
    accountId: run.checkpoint.accountId,
    title: input.title,
    originalUrl: input.originalUrl,
    authorLogin: input.authorLogin,
    authorId: input.authorId,
    publishedAt: input.publishedAt,
    fulltext: input.fulltext,
    bodyHash: contentHash,
    sourceId: revision.sourceId,
    sourceRevision: revision.sourceRevision,
    requestKey: input.requestKey,
    processingEligible: eligible,
    processingGap: eligible ? null : 'body exceeds the processing text window; exact body kept in the journal only'
  });
  if (result.outcome === 'hash_changed') {
    cp.gaps.push({ code: 'source_changed', detail: result.detail });
  } else if (result.outcome === 'duplicate') {
    cp.gaps.push({ code: 'source_deduped', detail: `${input.itemKey} 重复返回，已去重保留同一冻结捕获` });
  }
}

function fetchAccountIdOf(run: FetchGithubRunRecord): string {
  // Case-bound account identity persisted in the checkpoint at start.
  return run.checkpoint.accountId;
}

/* ------------------------------------------------------------------ */
/* Snapshot freeze                                                     */
/* ------------------------------------------------------------------ */

export interface FrozenSnapshot {
  digest: string;
  itemCount: number;
  commentCount: number;
  frozenAt: string;
}

/**
 * Freeze the immutable captured snapshot once the acquisition plan is
 * drained. Phase 2 processes exactly these rows with zero new HTTP; the
 * digest pins what was captured so completed snapshot/source pins cannot
 * silently change. The freeze + phase handoff commit atomically and REFUSE
 * while any request outcome is unresolved: an unknown outcome must stop the
 * run as unreconciled before any snapshot freeze or phase handoff.
 */
export function freezeSnapshot(run: FetchGithubRunRecord, journal: FetchGithubStore): FrozenSnapshot {
  const unresolved = journal.listUnresolvedRequests(run.runId);
  if (unresolved.length > 0) {
    throw new Error(
      `fetch github: refusing to freeze snapshot with ${String(unresolved.length)} unresolved request outcome(s)`
    );
  }
  const items = journal.listItems(run.runId).slice().sort((a, b) => (a.itemKey < b.itemKey ? -1 : 1));
  const comments = journal.listComments(run.runId);
  const digest = sha256Hex(
    JSON.stringify(
      items.map((item) => ({
        itemKey: item.itemKey,
        bodyHash: item.bodyHash,
        sourceId: item.sourceId,
        sourceRevision: item.sourceRevision,
        comments: comments
          .filter((comment) => comment.itemKey === item.itemKey)
          .map((comment) => [comment.commentId, comment.bodyHash])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      }))
    )
  );
  const frozenAt = new Date().toISOString();
  return journal.inTransaction(() => {
    const cp = journal.requireRun(run.runId).checkpoint;
    cp.snapshot = { frozen: true, digest, frozenAt };
    journal.updateCheckpoint(run.runId, cp);
    journal.updateRun(run.runId, { phase: 'process', state: 'processing', snapshotFrozenAt: frozenAt });
    journal.appendEvent(run.runId, 'snapshot_frozen', {
      digest,
      itemCount: items.length,
      commentCount: comments.length
    });
    return { digest, itemCount: items.length, commentCount: comments.length, frozenAt };
  });
}
