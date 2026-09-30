/**
 * GET-91 Task 3: standalone bounded public-rule executor.
 *
 * `evaluateRule` is pure data evaluation with an explicit precedence:
 *
 * 1. rules without bounded proof (`status_only`, `url_redirect`) end
 *    `unknown` — a 200 alone is never a candidate, a redirect never identity;
 * 2. truncated / invalid-UTF-8 / unsupported (content-)encoding stay `unknown`;
 * 3. PRIMARY PAGE evidence (parse5 structure: login form, known challenge
 *    page) blocks BEFORE positivity AND negativity — a login wall can neither
 *    confirm nor refute an account, while an ordinary profile with a sidebar
 *    login widget / CDN footer / bio text keeps its independent proof;
 * 4. error statuses (401/403/429/5xx) never produce candidate/no-match;
 * 5. generic soft-404 / placeholder page ambiguity (approved spec §5) wins
 *    over a source-owned absence marker — those pages prove nothing;
 * 6. only the rule's OWN declared bounded absence proof (marker, or declared
 *    NON-success absence status) yields `checked_no_match`, and only its
 *    bounded presence markers (never generic login-form literals) yield a
 *    `candidate` clue — never an identity claim.
 *
 * `executeDiscoveryRequest` runs one shared request for several rules with
 * injectable ports and ONE absolute deadline taken at execution entry: it
 * covers the queue, authority refreshes, initial DNS, every redirect and the
 * commit — it is never reset after queueing. A single idempotent settlement
 * releases limiter capacity exactly once and settles usage receipts exactly
 * once (authority throw/stall is failure, never proof; late DNS/results can
 * never dispatch, return candidates or write the cache). Every real send
 * leases its ACTUAL validated origin through the transport gate (released per
 * hop before the next acquire) and 429/503 Retry-After is recorded for the
 * actual response origin before that slot is released. Cache keys isolate
 * owner/case/inputVersion/registry/policy with a server-owned TTL on the
 * injectable clock; only reliable outcomes are reused (original `observedAt`,
 * zero new request/fee receipts). Persistent scheduling/restart recovery
 * stays with Task 5 — ports are exposed honestly, not pretended.
 */

import { createHash } from 'node:crypto';
import { parse as parseHtml } from 'parse5';

import type {
  BoundedDiscoveryResponse,
  DnsResolver,
  DiscoveryTargetPolicy,
  ValidatedDiscoveryTarget
} from './request-policy.js';
import { DiscoveryTargetError, PUBLIC_HTTPS_TARGET_POLICY, validateDiscoveryTarget } from './request-policy.js';
import type { PinnedRequestOptions, SendGate } from './pinned-transport.js';
import type { PublicDiscoveryRule } from '../../shared/public-discovery-rules.js';

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

export interface DiscoveryClock {
  now(): number;
}

export interface DiscoveryTransport {
  request(target: ValidatedDiscoveryTarget, options: PinnedRequestOptions): Promise<BoundedDiscoveryResponse>;
}

export type DiscoveryScopeStage = 'dispatch' | 'send' | 'commit' | 'cache_hit';

/** Scope/authority refresh port (server-owned; never model-supplied). */
export interface DiscoveryAuthorityPort {
  refresh(stage: DiscoveryScopeStage): boolean | Promise<boolean>;
}

export interface DiscoveryScopeSnapshot {
  owner: string;
  caseId: string;
  inputVersion: string;
  registryHash: string;
  policyHash: string;
}

/**
 * Cache entry. The port is MEMORY-ONLY (Task 5 owns persistence): raw third
 * party bodies must never be persisted through this interface.
 */
export interface CachedDiscoveryResponse {
  response: BoundedDiscoveryResponse;
  observedAt: string;
  expiresAt: number;
}

export interface DiscoveryResponseCache {
  get(key: string): CachedDiscoveryResponse | null;
  set(key: string, entry: CachedDiscoveryResponse): void;
}

export type DiscoveryReceiptOutcome = 'sent_completed' | 'sent_failed' | 'cancelled' | 'unknown' | 'not_sent';

export interface DiscoveryRequestReceipt {
  requestKey: string;
  requestSent: boolean;
  sendCount: number;
  outcome: DiscoveryReceiptOutcome;
  /** Unknown cost is an explicit null amount — never a "free" claim. */
  cost: { amount: null; basis: string };
  observedAt: string;
}

export interface DiscoveryReceiptPort {
  record(receipt: DiscoveryRequestReceipt): void;
}

export interface OriginRateLimiter {
  /** Serial per origin; resolves with a release function when dispatched. */
  acquire(origin: string, options: { signal: AbortSignal; deadlineAt: number; minIntervalMs?: number }): Promise<() => void>;
  /** Retry-After (429/503) pushes the origin's next dispatch back. */
  noteRetryAfter(origin: string, retryAfterMs: number): void;
}

export interface DiscoveryRequestLimits {
  timeoutMs: number;
  maxBytes: number;
  /** Server-owned bounded cache TTL; unknown/timeout results are never cached. */
  cacheTtlMs: number;
}

export interface DiscoveryRequestContext {
  signal: AbortSignal;
  clock: DiscoveryClock;
  policy: DiscoveryTargetPolicy;
  dns: DnsResolver;
  transport: DiscoveryTransport;
  authority: DiscoveryAuthorityPort;
  rateLimiter: OriginRateLimiter;
  cache: DiscoveryResponseCache;
  receipts: DiscoveryReceiptPort;
  rules: Map<string, PublicDiscoveryRule>;
  scope: DiscoveryScopeSnapshot;
  limits: DiscoveryRequestLimits;
}

export interface PlannedDiscoveryRequest {
  requestKey: string;
  origin: string;
  url: string;
  headers: Record<string, string>;
  ruleIds: string[];
}

/* ------------------------------------------------------------------ */
/* Outcomes                                                            */
/* ------------------------------------------------------------------ */

export type RuleOutcomeKind = 'candidate' | 'checked_no_match' | 'inaccessible' | 'unknown';

export interface RuleOutcome {
  ruleId: string;
  outcome: RuleOutcomeKind;
  reasonCode: string;
  /** Locatable match anchor (marker/status), never the whole body. */
  locator: string | null;
  /** Short locatable excerpt around the match; the body is never persisted. */
  excerpt: string | null;
}

export interface DiscoveryRequestOutcome {
  requestKey: string;
  status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  detailCode: string;
  observedAt: string;
  reused: boolean;
  /** Connector dispatches made for THIS execution (0 for cache replay). */
  sendCount: number;
  response: BoundedDiscoveryResponse | null;
  ruleOutcomes: RuleOutcome[];
}

/* ------------------------------------------------------------------ */
/* Page evidence (bounded, structural — never a naked word list)        */
/* ------------------------------------------------------------------ */

/** Strong multi-word phrases only: single ambiguous words never wall a page. */
export const CAPTCHA_MARKERS: readonly string[] = [
  'checking your browser',
  'verify you are human',
  'complete the captcha',
  'security check to access'
];

export const ACCESS_WALL_MARKERS: readonly string[] = [
  'log in to view',
  'login to view',
  'sign in to continue',
  'you must be logged in',
  'you must be logged in to',
  '\u0432\u044b \u0434\u043e\u043b\u0436\u043d\u044b \u0431\u044b\u0442\u044c \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d\u044b'
];

export const SOFT_404_MARKERS: readonly string[] = [
  "this page isn't available",
  'this page is not available',
  'the link you followed may be broken'
];

export const GENERIC_PLACEHOLDER_MARKERS: readonly string[] = ['lorem ipsum', 'welcome to our default page'];

const LOGIN_TOKEN = /log[\s_-]?in|sign[\s_-]?in|signin|anmelden|connexion|\u0432\u0445\u043e\u0434|\u767b\u5f55|\u767b\u5165/i;
const CHALLENGE_TOKEN = /cf-chl|challenge-platform|hcaptcha|recaptcha|g-recaptcha|cf_chl|turnstile/i;
const NOT_FOUND_TOKEN = /\b404\b|not found|isn't available|is not available|no longer available/i;
const PLACEHOLDER_TOKEN = /coming soon|under construction|lorem ipsum|welcome to (our|the) (default|new) (page|site)/i;

export interface PageEvidence {
  titleHeading: string;
  headings: string[];
  hasPasswordForm: boolean;
  passwordFormIsLogin: boolean;
  challengeEvidence: boolean;
}

const MAX_PARSED_NODES = 50_000;

/** Bounded structural analysis of a page (parse5, no new dependency). */
export function analyzePageEvidence(bodyText: string): PageEvidence {
  const evidence: PageEvidence = {
    titleHeading: '',
    headings: [],
    hasPasswordForm: false,
    passwordFormIsLogin: false,
    challengeEvidence: false
  };
  let document: unknown;
  try {
    document = parseHtml(bodyText.slice(0, 200_000));
  } catch {
    return evidence;
  }
  let nodes = 0;
  let titleDone = false;
  const walk = (node: unknown, context: { inTitle: boolean; inHeading: boolean; inSecondary: boolean; form: { password: boolean; login: boolean; secondary: boolean } | null }): void => {
    if (nodes > MAX_PARSED_NODES || node === null || typeof node !== 'object') return;
    nodes += 1;
    const current = node as { nodeName?: string; tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[]; value?: string };
    const attrs = new Map((current.attrs ?? []).map((attr) => [attr.name.toLowerCase(), attr.value]));
    const tag = (current.tagName ?? '').toLowerCase();
    let next = context;
    if (current.nodeName === '#text' && typeof current.value === 'string') {
      const text = current.value;
      if (context.inTitle && !titleDone) {
        evidence.titleHeading = text.trim().toLowerCase().slice(0, 200);
        titleDone = true;
      }
      if (context.inHeading) evidence.headings.push(text.trim().toLowerCase().slice(0, 200));
      return;
    }
    if (tag === 'title') next = { ...context, inTitle: true };
    if (tag === 'h1' || tag === 'h2') next = { ...context, inHeading: true };
    // Sidebar/nav/footer chrome is never PRIMARY page evidence: a password
    // form there (login widget) must not wall an independent profile.
    if (tag === 'aside' || tag === 'nav' || tag === 'footer') next = { ...context, inSecondary: true };
    const attrBlob = `${attrs.get('id') ?? ''} ${attrs.get('class') ?? ''} ${attrs.get('action') ?? ''} ${attrs.get('src') ?? ''}`;
    if (!context.inSecondary && CHALLENGE_TOKEN.test(attrBlob)) evidence.challengeEvidence = true;
    if (tag === 'form') {
      next = {
        ...context,
        form: {
          password: false,
          secondary: context.inSecondary,
          login: LOGIN_TOKEN.test(`${attrs.get('action') ?? ''} ${attrs.get('id') ?? ''} ${attrs.get('class') ?? ''}`)
        }
      };
    }
    if (tag === 'input' && (attrs.get('type') ?? '').toLowerCase() === 'password' && next.form) {
      next.form.password = true;
      if (!next.form.secondary) evidence.hasPasswordForm = true;
    }
    if (tag === 'script' && !context.inSecondary && CHALLENGE_TOKEN.test(attrs.get('src') ?? '')) evidence.challengeEvidence = true;
    for (const child of current.childNodes ?? []) walk(child, next);
    if (tag === 'form' && next.form?.password && !next.form.secondary && next.form.login) evidence.passwordFormIsLogin = true;
  };
  walk(document, { inTitle: false, inHeading: false, inSecondary: false, form: null });
  const headingBlob = `${evidence.titleHeading} ${evidence.headings.join(' ')}`;
  if (/just a moment|attention required|checking your browser|verify you are human/i.test(headingBlob)) {
    evidence.challengeEvidence = true;
  }
  if (evidence.hasPasswordForm && (LOGIN_TOKEN.test(headingBlob) || evidence.passwordFormIsLogin)) {
    evidence.passwordFormIsLogin = true;
  }
  return evidence;
}

function findMarker(body: string, markers: readonly string[]): string | null {
  for (const marker of markers) {
    if (body.includes(marker)) return marker;
  }
  return null;
}

function findMarkerLower(bodyLower: string, markers: readonly string[]): string | null {
  for (const marker of markers) {
    if (bodyLower.includes(marker.toLowerCase())) return marker;
  }
  return null;
}

const EXCERPT_HALF = 80;

function excerptAround(body: string, index: number, length: number): string | null {
  const start = Math.max(0, index - EXCERPT_HALF);
  const end = Math.min(body.length, index + length + EXCERPT_HALF);
  return body.slice(start, end);
}

/* ------------------------------------------------------------------ */
/* evaluateRule                                                        */
/* ------------------------------------------------------------------ */

export function evaluateRule(rule: PublicDiscoveryRule, response: BoundedDiscoveryResponse): RuleOutcome {
  const base = (outcome: RuleOutcomeKind, reasonCode: string, locator: string | null, excerpt: string | null): RuleOutcome => ({
    ruleId: rule.ruleId,
    outcome,
    reasonCode,
    locator,
    excerpt
  });

  const detection = rule.detection;
  if (detection.kind === 'url_redirect') return base('unknown', 'no_bounded_proof', null, null);
  if (!detection.boundedPositive && !detection.boundedNegative) return base('unknown', 'no_bounded_proof', null, null);
  if (response.truncated) return base('unknown', 'response_truncated', null, null);
  if (response.utf8Valid === false) return base('unknown', 'invalid_utf8', null, null);
  if (response.encoding !== 'utf-8') return base('unknown', 'unsupported_encoding', null, null);
  if (response.contentEncoding !== null && response.contentEncoding.trim() !== '' && response.contentEncoding.trim().toLowerCase() !== 'identity') {
    return base('unknown', 'unsupported_content_encoding', null, null);
  }

  const body = response.bodyText;
  const bodyLower = body.toLowerCase();

  // (3) PRIMARY PAGE evidence first: a login wall / challenge page can neither
  // confirm nor refute an account. Structural evidence (title/h1/main form,
  // known challenge markup) outweighs naked words — an ordinary profile with a
  // sidebar login widget, CDN footer or bio text keeps its independent proof.
  const evidence = analyzePageEvidence(body);
  if (evidence.hasPasswordForm && evidence.passwordFormIsLogin) {
    return base('inaccessible', 'login_page', 'primary password form', excerptAround(bodyLower, bodyLower.indexOf('password'), 8));
  }
  if (evidence.challengeEvidence) {
    return base('inaccessible', 'challenge_page', 'challenge markup', null);
  }
  const wall = findMarkerLower(bodyLower, ACCESS_WALL_MARKERS);
  if (wall !== null) return base('inaccessible', 'access_wall', wall, excerptAround(body, body.toLowerCase().indexOf(wall.toLowerCase()), wall.length));
  const captcha = findMarkerLower(bodyLower, CAPTCHA_MARKERS);
  if (captcha !== null) return base('inaccessible', 'captcha_wall', captcha, excerptAround(body, body.toLowerCase().indexOf(captcha.toLowerCase()), captcha.length));

  // (4) Error/rate-limit/server statuses never prove existence or absence.
  if (response.status === 429) return base('inaccessible', 'rate_limited', null, null);
  if (response.status === 401 || response.status === 403) return base('inaccessible', 'access_limited', null, null);
  if (response.status >= 500) return base('unknown', 'server_error', null, null);
  const statusOk = response.status >= 200 && response.status < 300;

  // (4b) Rule-specific upstream error markers are COUNTEREVIDENCE and keep
  // precedence over BOTH positive and absence evaluation: a mixed
  // error+positive or error+negative body is never candidate/no-match.
  const errorMarker = findMarker(body, rule.errorMarkers);
  if (errorMarker !== null) {
    return base('inaccessible', 'upstream_error_marker', errorMarker, excerptAround(body, body.indexOf(errorMarker), errorMarker.length));
  }

  const positiveMatches = ((): string | null => {
    if (!detection.boundedPositive) return null;
    if (detection.presentStatus !== null && response.status !== detection.presentStatus) return null;
    if (detection.presentStatus === null && !statusOk) return null;
    return findMarker(body, detection.presentAny);
  })();

  // (5) GENERIC page ambiguity (approved spec §5) precedes negativity and
  // positivity: soft-404 / placeholder pages prove nothing either way.
  const headingBlob = `${evidence.titleHeading} ${evidence.headings.join(' ')}`;
  const genericPage = NOT_FOUND_TOKEN.test(headingBlob) || PLACEHOLDER_TOKEN.test(headingBlob)
    ? 'structural'
    : findMarkerLower(bodyLower, SOFT_404_MARKERS) ?? (statusOk ? findMarkerLower(bodyLower, GENERIC_PLACEHOLDER_MARKERS) : null);
  if (genericPage !== null && !(response.status >= 400 && response.status < 500)) {
    const soft = NOT_FOUND_TOKEN.test(headingBlob) || findMarkerLower(bodyLower, SOFT_404_MARKERS) !== null;
    return base('unknown', soft ? 'soft_404' : 'generic_placeholder', typeof genericPage === 'string' ? genericPage : 'generic page structure', null);
  }

  // (6) The rule's OWN bounded absence proof (marker or declared NON-success
  // absence status) — a bare 2xx absence status is never proof.
  const negativeMatches = ((): string | null => {
    if (!detection.boundedNegative) return null;
    if (detection.absentStatus !== null && response.status !== detection.absentStatus) return null;
    if (detection.absentStatus === null && !statusOk) return null;
    if (detection.absentAny.length === 0) {
      return detection.absentStatus !== null && !(detection.absentStatus >= 200 && detection.absentStatus < 300)
        ? `status:${detection.absentStatus}`
        : null;
    }
    return findMarker(body, detection.absentAny);
  })();

  if (positiveMatches !== null && negativeMatches !== null) {
    return base('unknown', 'disputed_match', positiveMatches, excerptAround(body, body.indexOf(positiveMatches), positiveMatches.length));
  }
  if (negativeMatches !== null) {
    const index = negativeMatches.startsWith('status:') ? 0 : body.indexOf(negativeMatches);
    return base(
      'checked_no_match',
      negativeMatches.startsWith('status:') ? 'absent_status' : 'absent_marker',
      negativeMatches,
      excerptAround(body, index, negativeMatches.length)
    );
  }
  if (positiveMatches !== null) {
    return base('candidate', 'present_marker', positiveMatches, excerptAround(body, body.indexOf(positiveMatches), positiveMatches.length));
  }
  return base('unknown', 'no_bounded_match', null, null);
}

/* ------------------------------------------------------------------ */
/* Rate limiter (per-origin serial + Retry-After + global cap)          */
/*                                                                     */
/* Queued entries settle on their OWN abort/deadline even while busy;    */
/* unexpired timing state (lastStart interval / Retry-After cooldown)   */
/* survives idle cleanup and other-origin activity; tickers and abort   */
/* listeners are cleaned up without weakening rate caps.                */
/* ------------------------------------------------------------------ */

interface QueuedAcquire {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  deadlineAt: number;
  minIntervalMs: number;
  onAbort: () => void;
  settled: boolean;
}

interface OriginState {
  busy: boolean;
  blockedUntil: number;
  lastStart: number;
  lastTouched: number;
  queue: QueuedAcquire[];
}

function limiterError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const RETAINED_TIMING_MS = 60_000;

export function createInMemoryRateLimiter(options: {
  clock: DiscoveryClock;
  globalMaxConcurrent?: number;
}): OriginRateLimiter {
  const clock = options.clock;
  const globalMax = options.globalMaxConcurrent ?? 4;
  if (!Number.isInteger(globalMax) || globalMax < 1) {
    throw new Error('rate limiter: globalMaxConcurrent must be a positive integer');
  }
  const origins = new Map<string, OriginState>();
  let globalInFlight = 0;
  let ticker: NodeJS.Timeout | null = null;

  const stateFor = (origin: string): OriginState => {
    const existing = origins.get(origin);
    if (existing) return existing;
    const state: OriginState = { busy: false, blockedUntil: 0, lastStart: 0, lastTouched: clock.now(), queue: [] };
    origins.set(origin, state);
    return state;
  };

  const settle = (entry: QueuedAcquire, action: () => void): void => {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal.removeEventListener('abort', entry.onAbort);
    action();
  };

  const cleanupIdle = (): void => {
    const now = clock.now();
    for (const [origin, state] of [...origins.entries()]) {
      const timingExpiry = Math.max(state.blockedUntil, state.lastStart + RETAINED_TIMING_MS, state.lastTouched + RETAINED_TIMING_MS);
      if (!state.busy && state.queue.length === 0 && now >= timingExpiry) origins.delete(origin);
    }
  };

  const stopTickerIfIdle = (): void => {
    if (ticker !== null && [...origins.values()].every((state) => state.queue.length === 0)) {
      clearInterval(ticker);
      ticker = null;
    }
    cleanupIdle();
  };

  const pumpOrigin = (state: OriginState): void => {
    // Expired/aborted queue entries settle FIRST — even while the origin is
    // busy, blocked by Retry-After or when the global cap is held.
    const now = clock.now();
    while (state.queue.length > 0) {
      const head = state.queue[0]!;
      if (head.settled) {
        state.queue.shift();
        continue;
      }
      if (head.signal.aborted) {
        state.queue.shift();
        settle(head, () => head.reject(limiterError('cancelled')));
        continue;
      }
      if (now >= head.deadlineAt) {
        state.queue.shift();
        settle(head, () => head.reject(limiterError('deadline_exceeded')));
        continue;
      }
      break;
    }
    if (state.busy || globalInFlight >= globalMax || state.queue.length === 0) return;
    const next = state.queue[0]!;
    if (now < state.blockedUntil || now < state.lastStart + next.minIntervalMs) return;
    state.queue.shift();
    state.busy = true;
    state.lastStart = now;
    state.lastTouched = now;
    globalInFlight += 1;
    let released = false;
    settle(next, () =>
      next.resolve(() => {
        if (released) return;
        released = true;
        state.busy = false;
        state.lastTouched = clock.now();
        globalInFlight -= 1;
        kick();
      })
    );
  };

  const pumpAll = (): void => {
    for (const state of origins.values()) pumpOrigin(state);
    stopTickerIfIdle();
  };

  const kick = (): void => {
    if (ticker === null) ticker = setInterval(pumpAll, 5);
    pumpAll();
  };

  return {
    acquire(origin, acquireOptions) {
      if (acquireOptions.minIntervalMs !== undefined && (!Number.isInteger(acquireOptions.minIntervalMs) || acquireOptions.minIntervalMs < 0)) {
        return Promise.reject(new Error('rate limiter: minIntervalMs must be a non-negative integer'));
      }
      const state = stateFor(origin);
      state.lastTouched = clock.now();
      return new Promise<() => void>((resolve, reject) => {
        const entry: QueuedAcquire = {
          resolve,
          reject,
          signal: acquireOptions.signal,
          deadlineAt: acquireOptions.deadlineAt,
          minIntervalMs: acquireOptions.minIntervalMs ?? 0,
          onAbort: () => settle(entry, () => reject(limiterError('cancelled'))),
          settled: false
        };
        acquireOptions.signal.addEventListener('abort', entry.onAbort, { once: true });
        state.queue.push(entry);
        kick();
      });
    },
    noteRetryAfter(origin, retryAfterMs) {
      if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return;
      const state = stateFor(origin);
      state.blockedUntil = Math.max(state.blockedUntil, clock.now() + retryAfterMs);
      state.lastTouched = clock.now();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Cache keys                                                          */
/* ------------------------------------------------------------------ */

/** owner / case / inputVersion / registry / policy isolated cache key. */
export function discoveryCacheKey(scope: DiscoveryScopeSnapshot, requestKey: string): string {
  const material = [scope.owner, scope.caseId, scope.inputVersion, scope.registryHash, scope.policyHash, requestKey].join('\n');
  return `dk1:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/* ------------------------------------------------------------------ */
/* executeDiscoveryRequest                                             */
/* ------------------------------------------------------------------ */

const COST_BASIS_UNKNOWN = 'provider cost unknown; the receipt records a null amount (null is not a measured zero price)';

function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - now);
  return null;
}

/** Internal settlement failure carrying the outcome + receipt decision. */
class ExecutionFailure extends Error {
  constructor(
    readonly status: DiscoveryRequestOutcome['status'],
    readonly detailCode: string,
    readonly receipt: { requestSent: boolean; sendCount: number; outcome: DiscoveryRequestReceipt['outcome'] } | null
  ) {
    super(detailCode);
    this.name = 'ExecutionFailure';
  }
}

/** Share one idempotent release between late-grant cleanup and settlement. */
function onceLeaseRelease(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

export async function executeDiscoveryRequest(
  request: PlannedDiscoveryRequest,
  context: DiscoveryRequestContext
): Promise<DiscoveryRequestOutcome> {
  const { clock, limits } = context;
  const observedNow = (): string => new Date(clock.now()).toISOString();
  const outcomes = (code: string, outcome: RuleOutcomeKind = 'unknown'): RuleOutcome[] =>
    request.ruleIds.map((ruleId) => ({ ruleId, outcome, reasonCode: code, locator: null, excerpt: null }));
  const receipt = (
    requestSent: boolean,
    sendCount: number,
    outcome: DiscoveryRequestReceipt['outcome']
  ): DiscoveryRequestReceipt => ({
    requestKey: request.requestKey,
    requestSent,
    sendCount,
    outcome,
    cost: { amount: null, basis: COST_BASIS_UNKNOWN },
    observedAt: observedNow()
  });

  // ONE absolute deadline from execution entry — never reset after queueing.
  const deadlineAt = clock.now() + limits.timeoutMs;
  const controller = new AbortController();
  let settled = false;
  let release: (() => void) | null = null;
  const releaseOnce = (): void => {
    const owned = release;
    release = null;
    owned?.();
  };
  let deadlineTimer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - clock.now()));
  let dispatched = false;
  let dispatchedSendCount = 0;
  let dispatchCancelled = false;
  let settleReject: ((error: Error) => void) | null = null;
  const onAbort = (): void => {
    const cancelled = context.signal.aborted;
    settled = true;
    dispatchCancelled = dispatchCancelled || cancelled;
    settleReject?.(new ExecutionFailure(cancelled ? 'cancelled' : 'unknown', cancelled ? 'cancelled' : 'deadline_exceeded', null));
  };
  // External cancellation propagates SYNCHRONOUSLY into the internal
  // controller so the transport aborts/destroys any pending request.
  const onExternalAbort = (): void => {
    controller.abort();
  };
  const rejection = new Promise<never>((_resolve, reject) => {
    settleReject = reject;
  });
  if (context.signal.aborted) {
    onAbort();
  } else {
    context.signal.addEventListener('abort', onAbort, { once: true });
    context.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  controller.signal.addEventListener('abort', onAbort, { once: true });
  rejection.catch(() => undefined);
  const race = async <T>(work: Promise<T>): Promise<T> => await Promise.race([work, rejection]);
  const checkActive = (): void => {
    if (context.signal.aborted) throw new ExecutionFailure('cancelled', 'cancelled', null);
    if (clock.now() >= deadlineAt) throw new ExecutionFailure('unknown', 'deadline_exceeded', null);
  };
  const safeRefresh = async (stage: DiscoveryScopeStage): Promise<boolean> => {
    try {
      return (await race(Promise.resolve(context.authority.refresh(stage)))) === true;
    } catch (error) {
      if (error instanceof ExecutionFailure) throw error;
      // Authority failure/stall is never proof: fail closed.
      throw new ExecutionFailure('failed', 'scope_refresh_error', null);
    }
  };

  try {
    checkActive();
    const dispatchAllowed = await safeRefresh('dispatch');
    if (!dispatchAllowed) throw new ExecutionFailure('failed', 'scope_refresh_refused', null);

    const cacheKey = discoveryCacheKey(context.scope, request.requestKey);
    const cached = context.cache.get(cacheKey);
    if (cached && cached.expiresAt > clock.now()) {
      const cacheAllowed = await safeRefresh('cache_hit');
      checkActive();
      if (!cacheAllowed) throw new ExecutionFailure('failed', 'scope_refresh_refused', null);
      // A fresh cache hit after caller abort/deadline must refuse.
      settled = true;
      return {
        requestKey: request.requestKey,
        status: 'completed',
        detailCode: 'cache_hit',
        observedAt: cached.observedAt,
        reused: true,
        sendCount: 0,
        response: cached.response,
        ruleOutcomes: request.ruleIds.map((ruleId) => {
          const rule = context.rules.get(ruleId);
          return rule
            ? evaluateRule(rule, cached.response)
            : { ruleId, outcome: 'unknown' as const, reasonCode: 'rule_missing', locator: null, excerpt: null };
        })
      };
    }

    const minIntervalMs = request.ruleIds
      .map((ruleId) => context.rules.get(ruleId)?.ratePerMinute ?? null)
      .reduce<number>((interval, rate) => (rate === null ? interval : Math.max(interval, Math.ceil(60_000 / rate))), 0);

    // Per-actual-target send lease for the entry request (its host is the
    // first hop's actual target). It is held across queue+DNS, reused for
    // hop 1 through the transport gate and released exactly once; redirect
    // hops acquire their own lease AFTER the previous release (no nested
    // global-token deadlock).
    let leaseHost = '';
    try {
      leaseHost = new URL(request.url).hostname.toLowerCase();
    } catch {
      throw new ExecutionFailure('failed', 'target_refused', { requestSent: false, sendCount: 0, outcome: 'not_sent' });
    }
    const entryAcquire = context.rateLimiter.acquire(`https://${leaseHost}`, {
      signal: controller.signal,
      deadlineAt,
      minIntervalMs
    }).then(onceLeaseRelease);
    entryAcquire.then((releaseFn) => {
      // A lease granted after settlement is released at once and can never
      // lead to a dispatch.
      if (settled) releaseFn();
    }).catch(() => undefined);
    release = await race(entryAcquire);

    // Authority is rechecked immediately before EVERY actual dispatch —
    // including the first hop AFTER the queue and DNS — and cancellation/
    // deadline are re-checked too (the transport gate repeats this per hop).
    let target: ValidatedDiscoveryTarget;
    try {
      target = await race(validateDiscoveryTarget(request.url, context.policy, context.dns));
    } catch (error) {
      if (error instanceof ExecutionFailure) throw error;
      throw new ExecutionFailure('failed', 'target_refused', { requestSent: false, sendCount: 0, outcome: 'not_sent' });
    }
    // FRESH authority + cancellation recheck after the queue and DNS: a
    // revocation during the DNS wait must never dispatch (leases may be
    // reused, authorization may not).
    const sendAllowedAfterDns = await safeRefresh('send');
    if (!sendAllowedAfterDns) throw new ExecutionFailure('failed', 'scope_refresh_refused', null);
    checkActive();

    let gateUsed = false;
    const entryGate: SendGate = {
      allowed: true,
      release: () => releaseOnce()
    };
    const beforeSend = async (info: { attempt: number; target: ValidatedDiscoveryTarget }): Promise<SendGate> => {
      // (1) resolve the actual-origin lease FIRST (entry lease reused for
      //     hop 1; redirect hops acquire after the previous release), then
      // (2) FRESH authority + cancellation/deadline recheck immediately
      //     before the real dispatch: a reused lease is NOT reused authority.
      let leaseRelease: () => void;
      if (!gateUsed) {
        gateUsed = true;
        leaseRelease = () => releaseOnce();
      } else {
        const hopAcquire = context.rateLimiter.acquire(`https://${info.target.hostname}`, {
          signal: controller.signal,
          deadlineAt,
          minIntervalMs
        }).then(onceLeaseRelease);
        hopAcquire.then((releaseFn) => {
          if (settled) releaseFn();
        }).catch(() => undefined);
        const hopRelease = await race(hopAcquire);
        let released = false;
        leaseRelease = () => {
          if (released) return;
          released = true;
          hopRelease();
        };
      }
      try {
        checkActive();
        const allowed = await safeRefresh('send');
        checkActive();
        if (!allowed) return { allowed: false, release: leaseRelease };
      } catch (error) {
        // Refusal/throw/stall/abort after the lease is granted releases it
        // exactly once and never dispatches.
        leaseRelease();
        throw error;
      }
      return { allowed: true, release: leaseRelease };
    };
    // Dispatch accounting happens AT the actual connector.request boundary
    // (reported synchronously by the production transport): gate entry, DNS
    // and lease waits never inflate the count.
    const onDispatch = (): void => {
      dispatched = true;
      dispatchedSendCount += 1;
    };
    let hopResponseSeen = false;
    const onHopResponse = (info: { target: ValidatedDiscoveryTarget; response: BoundedDiscoveryResponse }): void => {
      // 429/503 Retry-After is recorded for the ACTUAL response origin before
      // that send slot is released and queued contenders wake up.
      hopResponseSeen = true;
      const status = info.response.status;
      if (status === 429 || status === 503) {
        const retryAfterMs = parseRetryAfterMs(info.response.retryAfter, clock.now());
        if (retryAfterMs !== null) context.rateLimiter.noteRetryAfter(`https://${info.target.hostname}`, retryAfterMs);
      }
    };

    let response: BoundedDiscoveryResponse;
    try {
      response = await race(
        context.transport.request(target, {
          method: 'GET',
          headers: request.headers,
          signal: controller.signal,
          deadlineAt,
          now: () => clock.now(),
          maxBytes: limits.maxBytes,
          policy: context.policy,
          dns: context.dns,
          beforeSend,
          onHopResponse,
          onDispatch
        })
      );
      dispatched = true;
      dispatchedSendCount = Math.max(dispatchedSendCount, response.sendCount ?? 1);
    } catch (error) {
      if (error instanceof ExecutionFailure) throw error;
      const code = (error as { code?: string }).code ?? 'transport_error';
      const sendCount = typeof (error as { sendCount?: number }).sendCount === 'number' ? (error as { sendCount: number }).sendCount : 1;
      const cancelled = code === 'cancelled' || context.signal.aborted;
      const unknownResult = code === 'deadline_exceeded' || code === 'byte_cap';
      dispatched = dispatched || sendCount > 0;
      dispatchedSendCount = Math.max(dispatchedSendCount, sendCount);
      dispatchCancelled = cancelled;
      const receiptOutcome: DiscoveryRequestReceipt['outcome'] =
        sendCount === 0 ? (cancelled ? 'cancelled' : 'not_sent') : cancelled ? 'cancelled' : unknownResult ? 'unknown' : 'sent_failed';
      throw new ExecutionFailure(
        cancelled ? 'cancelled' : unknownResult ? 'unknown' : 'failed',
        cancelled ? 'cancelled' : code,
        { requestSent: sendCount > 0, sendCount, outcome: receiptOutcome }
      );
    }
    checkActive();

    // Fallback Retry-After settlement for transports without the per-hop
    // hook (the pinned transport records it before slot release).
    if (!hopResponseSeen && (response.status === 429 || response.status === 503)) {
      const retryAfterMs = parseRetryAfterMs(response.retryAfter, clock.now());
      if (retryAfterMs !== null) context.rateLimiter.noteRetryAfter(`https://${target.hostname}`, retryAfterMs);
    }

    const observedAt = observedNow();
    const sendCount = response.sendCount ?? 1;
    const ruleOutcomes: RuleOutcome[] =
      response.status === 429
        ? outcomes('rate_limited', 'inaccessible')
        : request.ruleIds.map((ruleId) => {
            const rule = context.rules.get(ruleId);
            return rule
              ? evaluateRule(rule, response)
              : { ruleId, outcome: 'unknown' as const, reasonCode: 'rule_missing', locator: null, excerpt: null };
          });

    // Authority is refreshed again before COMMIT. Refusal/throw means an
    // explicit scope failure — never completed/ok/candidate — with no
    // reusable response; the real sent usage receipt is preserved.
    const commitAllowed = await safeRefresh('commit');
    checkActive();
    if (!commitAllowed) {
      context.receipts.record(receipt(true, sendCount, 'sent_completed'));
      return {
        requestKey: request.requestKey,
        status: 'failed',
        detailCode: 'scope_refresh_refused',
        observedAt,
        reused: false,
        sendCount,
        response: null,
        ruleOutcomes: outcomes('scope_refresh_refused')
      };
    }
    const reliable =
      response.encoding === 'utf-8' &&
      response.utf8Valid !== false &&
      !response.truncated &&
      response.status >= 200 &&
      response.status < 300 &&
      ruleOutcomes.some((outcome) => outcome.outcome === 'candidate' || outcome.outcome === 'checked_no_match');
    if (reliable) {
      context.cache.set(cacheKey, { response, observedAt, expiresAt: clock.now() + limits.cacheTtlMs });
    }
    context.receipts.record(receipt(true, sendCount, 'sent_completed'));
    settled = true;
    return {
      requestKey: request.requestKey,
      status: 'completed',
      detailCode: 'ok',
      observedAt,
      reused: false,
      sendCount,
      response,
      ruleOutcomes
    };
  } catch (error) {
    settled = true;
    const failure = error instanceof ExecutionFailure
      ? error
      : new ExecutionFailure('failed', (error as { code?: string }).code ?? 'execution_error', null);
    // Exactly-once usage settlement: dispatched attempts always keep a
    // receipt (sent/unknown/cancelled); pre-dispatch cancellation and
    // authority failure keep an honest not-sent receipt; a plain dispatch
    // authority REFUSAL records nothing (zero requests, zero receipts).
    const fallback = dispatched
      ? {
          requestSent: true,
          sendCount: dispatchedSendCount,
          outcome: (dispatchCancelled || failure.status === 'cancelled'
            ? 'cancelled'
            : failure.detailCode === 'deadline_exceeded' || failure.detailCode === 'byte_cap'
              ? 'unknown'
              : 'sent_completed') as DiscoveryRequestReceipt['outcome']
        }
      : failure.detailCode === 'scope_refresh_refused'
        ? null
        : {
            requestSent: false,
            sendCount: 0,
            outcome: (failure.status === 'cancelled' ? 'cancelled' : 'not_sent') as DiscoveryRequestReceipt['outcome']
          };
    const receiptInfo = failure.receipt ?? fallback;
    if (receiptInfo) context.receipts.record(receipt(receiptInfo.requestSent, receiptInfo.sendCount, receiptInfo.outcome));
    return {
      requestKey: request.requestKey,
      status: failure.status,
      detailCode: failure.detailCode,
      observedAt: observedNow(),
      reused: false,
      sendCount: receiptInfo?.sendCount ?? 0,
      response: null,
      ruleOutcomes: outcomes(failure.detailCode)
    };
  } finally {
    settled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    // Remove every execution-scoped listener from the CALLER signal (and the
    // internal one): settled runs must never leak abort listeners.
    context.signal.removeEventListener('abort', onAbort);
    context.signal.removeEventListener('abort', onExternalAbort);
    controller.signal.removeEventListener('abort', onAbort);
    releaseOnce();
  }
}

export type { PinnedRequestOptions, SendGate };
export { PUBLIC_HTTPS_TARGET_POLICY };
