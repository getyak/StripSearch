/**
 * Native platform probe engine and deep post tracker.
 *
 * Boundaries enforced here:
 *
 * - Only registry rule templates are fetched. The subject is URL-encoded into
 *   a fixed template; the resolved URL must stay on the template's own https
 *   origin, so no user-supplied URL is ever fetched.
 * - Redirects are never followed: a 3xx degrades the result to `unknown`
 *   instead of silently chasing a target we did not authorize.
 * - Bodies are read with a hard byte cap. Status semantics win over body
 *   guesswork: `http_marker` probes only report `found` when the expected
 *   marker is actually present, everything else degrades to `unknown`.
 * - Post extraction keeps a short excerpt and a locator, never full text.
 */

import { asArray, asNumber, asRecord, asString, readBoundedBody } from './http.js';
import { ProviderError } from './types.js';
import type { HttpTransport } from './types.js';
import type {
  DiscoverySubject,
  PlatformPostsRule,
  PlatformProbeRule,
  PlatformRule,
  ProbeResultDraft,
  TrackedPostDraft
} from '../../shared/platform-discovery.js';
import { nativeReceipt, trackedPostKey } from '../../shared/platform-discovery.js';

export const PROBE_MAX_BYTES = 256 * 1024;
export const POSTS_MAX_BYTES = 512 * 1024;
export const POST_EXCERPT_MAX = 200;
export const POSTS_MAX_ITEMS = 25;

export interface ProbeContext {
  transport: HttpTransport;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ProbeRunResult {
  result: ProbeResultDraft;
  requests: number;
  bytes: number;
  outcomeUnknown: boolean;
}

export interface PostsRunResult {
  posts: TrackedPostDraft[];
  nextCursor: string | null;
  requests: number;
  bytes: number;
  warnings: string[];
  limits: string[];
}

interface BoundedResponse {
  status: number;
  text: string;
  bytes: number;
  contentType: string | null;
}

/** Build the request URL from a rule template; throws on template misuse. */
export function resolveRuleUrl(template: string, subjectValue: string, page?: number): string {
  const encoded = encodeURIComponent(subjectValue);
  const resolved = template
    .replace('{username}', encoded)
    .replace('{page}', String(page ?? 1));
  if (resolved.includes('{username}') || resolved.includes('{page}')) {
    throw new ProviderError('provider_bad_response', '规则模板占位符未被完整替换。');
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new ProviderError('provider_bad_response', '规则模板不是有效 URL。');
  }
  if (url.protocol !== 'https:') {
    throw new ProviderError('provider_bad_response', '规则模板必须是 https 端点。');
  }
  return url.toString();
}

function templateOrigin(template: string): string | null {
  const base = template.replace('{username}', 'x').replace('{page}', '1');
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export async function fetchBounded(
  url: string,
  expectedOrigin: string | null,
  context: ProbeContext,
  maxBytes: number
): Promise<BoundedResponse> {
  const parsed = new URL(url);
  if (expectedOrigin && parsed.origin !== expectedOrigin) {
    throw new ProviderError('provider_bad_response', '解析出的端点与规则来源不一致。');
  }
  // Hard timeout independent of the caller's abort: a hung platform must not
  // hold a task slot forever, and an abandoned request may still be billed.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, context.timeoutMs);
  const onAbort = () => controller.abort();
  if (context.signal.aborted) controller.abort();
  context.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await context.transport.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal
    });
    if (response.redirected) {
      throw new ProviderError('provider_redirect', '平台响应发生了未授权重定向。');
    }
    const text = await readBoundedBody(response, maxBytes);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      throw new ProviderError('provider_response_too_large', '平台响应超过大小上限。');
    }
    return { status: response.status, text, bytes, contentType: response.headers.get('content-type') };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (timedOut) throw new ProviderError('provider_timeout', '平台请求超时。');
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);
  }
}

function excerptAround(text: string, marker: string): string | null {
  const index = text.indexOf(marker);
  if (index < 0) return null;
  const start = Math.max(0, index - 80);
  const slice = text.slice(start, index + marker.length + 80).replace(/\s+/g, ' ').trim();
  return slice.slice(0, 160);
}

/**
 * Run one probe against one platform. Never throws for platform-side answers:
 * every outcome is a ProbeResultDraft. Transport failures become `error` with
 * an `outcomeUnknown` flag when the request may still have been billed.
 */
export async function probePlatform(
  rule: PlatformRule,
  subject: DiscoverySubject,
  context: ProbeContext
): Promise<ProbeRunResult> {
  const probe = rule.probe as PlatformProbeRule;
  const baseLimitations: string[] = [];
  const verificationNote = rule.verification === 'live_verified' ? [] : ['rule_live_unverified'];
  const make = (
    status: ProbeResultDraft['status'],
    limitations: string[],
    evidence: ProbeResultDraft['evidence'],
    bytes: number,
    outcomeUnknown = false
  ): ProbeRunResult => ({
    result: {
      platformId: rule.platformId,
      method: probe.transport === 'api_http' ? 'api_http' : 'profile_http',
      status,
      handle: status === 'found' ? subject.kind === 'username' ? subject.value : null : null,
      profileUrl: evidence?.url ?? null,
      evidence,
      verification: rule.verification === 'live_verified' ? 'live_verified' : 'live_unverified',
      receipt: nativeReceipt(`native-${probe.kind}`),
      limitations: [...baseLimitations, ...verificationNote, ...limitations],
      requests: 1,
      bytes
    },
    requests: 1,
    bytes,
    outcomeUnknown
  });

  let url: string;
  try {
    url = resolveRuleUrl(probe.urlTemplate, subject.value);
  } catch {
    return make('error', ['invalid_rule_template'], null, 0);
  }

  let response: BoundedResponse;
  try {
    response = await fetchBounded(url, templateOrigin(probe.urlTemplate), context, PROBE_MAX_BYTES);
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.code === 'provider_timeout') {
        return make('error', ['timeout', 'billing_outcome_unknown'], null, 0, true);
      }
      if (error.code === 'provider_response_too_large') {
        return make('unknown', ['response_too_large'], null, 0);
      }
      return make('error', [error.code], null, 0);
    }
    return make(context.signal.aborted ? 'unknown' : 'error', ['transport_error'], null, 0, true);
  }

  const evidence = { url, excerpt: null, locator: `http-status:${response.status}` };
  if (probe.blockedStatuses.includes(response.status)) {
    return make('blocked', ['platform_blocked'], evidence, response.bytes);
  }
  if (probe.notFoundStatuses.includes(response.status)) {
    return make('not_found', [], evidence, response.bytes);
  }
  if (response.status >= 300 && response.status < 400) {
    return make('unknown', ['redirect_not_followed'], evidence, response.bytes);
  }
  if (response.status >= 500) {
    return make('error', ['platform_error'], evidence, response.bytes);
  }
  if (!probe.foundStatuses.includes(response.status)) {
    return make('unknown', ['unexpected_status'], evidence, response.bytes);
  }
  if (probe.kind === 'http_marker') {
    if (probe.notFoundMarker && response.text.includes(probe.notFoundMarker)) {
      return make('not_found', ['not_found_marker'], evidence, response.bytes);
    }
    if (probe.foundMarker && response.text.includes(probe.foundMarker)) {
      return make(
        'found',
        ['marker_matched'],
        { url, excerpt: excerptAround(response.text, probe.foundMarker), locator: 'response-marker' },
        response.bytes
      );
    }
    return make('unknown', ['marker_mismatch'], evidence, response.bytes);
  }
  return make('found', [], evidence, response.bytes);
}

function getByPath(item: unknown, dotted: string | null): unknown {
  if (!dotted) return item;
  let current: unknown = item;
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizePublishedAt(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = asString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
}

function stripMarkup(text: string): string {
  return text
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function extractRssItems(text: string, fields: PlatformPostsRule['fields']): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const itemPattern = /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = text.match(itemPattern) ?? [];
  for (const block of blocks.slice(0, POSTS_MAX_ITEMS)) {
    const pick = (tag: string): string | null => {
      const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return match?.[1] ? stripMarkup(match[1]) : null;
    };
    // Emit items keyed by the rule's own field names so the shared mapper
    // works identically for JSON lists and RSS.
    const item: Record<string, unknown> = {};
    if (fields.id) item[fields.id] = pick(fields.id);
    if (fields.url) item[fields.url] = pick(fields.url);
    if (fields.title) item[fields.title] = pick(fields.title);
    if (fields.publishedAt) item[fields.publishedAt] = pick(fields.publishedAt);
    if (fields.excerpt) item[fields.excerpt] = pick(fields.excerpt);
    items.push(item);
  }
  return items;
}

function toTrackedPost(
  raw: Record<string, unknown>,
  rule: PlatformRule,
  accountLinkId: string,
  fields: PlatformPostsRule['fields'],
  warnings: string[]
): TrackedPostDraft | null {
  const url = asString(fields.url ? getByPath(raw, fields.url) : null);
  const remoteId = asString(fields.id ? getByPath(raw, fields.id) : null) ?? url;
  if (!url || !remoteId) {
    warnings.push('存在缺少链接或标识的条目，已跳过。');
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    warnings.push('存在无法解析的条目链接，已跳过。');
    return null;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    warnings.push('存在非 http(s) 条目链接，已跳过。');
    return null;
  }
  const rawTitle = asString(fields.title ? getByPath(raw, fields.title) : null);
  const rawExcerpt = asString(fields.excerpt ? getByPath(raw, fields.excerpt) : null);
  return {
    postKey: trackedPostKey(rule.platformId, remoteId),
    accountLinkId,
    platformId: rule.platformId,
    url,
    title: (rawTitle ?? '（无标题）').slice(0, 200),
    publishedAt: normalizePublishedAt(fields.publishedAt ? getByPath(raw, fields.publishedAt) : null),
    excerpt: truncate(stripMarkup(rawExcerpt ?? ''), POST_EXCERPT_MAX),
    excerptLocator: 'post-listing-item',
    fetchStatus: 'ok',
    limits: ['listing_excerpt_only', 'full_text_not_fetched']
  };
}

/**
 * Fetch one page of posts for an account link. `cursor` is the page number as
 * a string (registry rules are page-numbered); `nextCursor` is null when the
 * listing is exhausted or the rule allows no further pages.
 */
export async function fetchPostsPage(
  rule: PlatformRule,
  accountLinkId: string,
  subjectValue: string,
  cursor: string | null,
  context: ProbeContext
): Promise<PostsRunResult> {
  const postsRule = rule.posts;
  const warnings: string[] = [];
  const limits: string[] = [];
  if (postsRule.kind === 'none') {
    return { posts: [], nextCursor: null, requests: 0, bytes: 0, warnings, limits: ['posts_unsupported'] };
  }
  const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1;
  let url: string;
  try {
    url = resolveRuleUrl(postsRule.urlTemplate, subjectValue, page);
  } catch {
    return { posts: [], nextCursor: null, requests: 0, bytes: 0, warnings, limits: ['invalid_rule_template'] };
  }

  let response: BoundedResponse;
  try {
    response = await fetchBounded(url, templateOrigin(postsRule.urlTemplate), context, POSTS_MAX_BYTES);
  } catch (error) {
    const message = error instanceof ProviderError ? error.code : 'transport_error';
    return {
      posts: [],
      nextCursor: null,
      requests: 1,
      bytes: 0,
      warnings,
      limits: [message, 'posts_fetch_failed']
    };
  }
  if (response.status !== 200) {
    return {
      posts: [],
      nextCursor: null,
      requests: 1,
      bytes: response.bytes,
      warnings,
      limits: [`http_status:${response.status}`, 'posts_fetch_failed']
    };
  }

  let rawItems: Record<string, unknown>[] = [];
  if (postsRule.kind === 'rss') {
    rawItems = extractRssItems(response.text, postsRule.fields);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      return {
        posts: [],
        nextCursor: null,
        requests: 1,
        bytes: response.bytes,
        warnings,
        limits: ['unparsable_body', 'posts_fetch_failed']
      };
    }
    const container = getByPath(parsed, postsRule.itemsPath);
    if (!Array.isArray(container)) {
      return {
        posts: [],
        nextCursor: null,
        requests: 1,
        bytes: response.bytes,
        warnings,
        limits: ['items_path_mismatch', 'posts_fetch_failed']
      };
    }
    rawItems = container.filter(asRecord).slice(0, POSTS_MAX_ITEMS) as Record<string, unknown>[];
  }

  const posts: TrackedPostDraft[] = [];
  for (const item of rawItems) {
    const post = toTrackedPost(item, rule, accountLinkId, postsRule.fields, warnings);
    if (post) posts.push(post);
  }

  const canPage = postsRule.urlTemplate.includes('{page}') && page < postsRule.maxPages;
  const nextCursor = canPage && rawItems.length > 0 ? String(page + 1) : null;
  return { posts, nextCursor, requests: 1, bytes: response.bytes, warnings, limits };
}

export { asArray, asNumber, asRecord, asString };
