import { isIP } from 'node:net';
import { extractGitHubHandle, isPrivateHost, sanitizeText } from '../../shared/validation.js';
import { asArray, asNumber, asRecord, asString, safeFetchJson } from '../adapters/http.js';
import { ProviderError } from '../adapters/types.js';
import type { HttpRequestInit } from '../adapters/types.js';
import type { ResearchAccount, ResearchPage, ResearchToolAction, ResearchToolResult, ResearchTools, ResearchToolsOptions } from './tool-contracts.js';

const TEXT_LIMIT = 6000;
const USER_AGENT = 'StripSearch/0.2';
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const X_RESERVED = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'intent', 'login', 'signup', 'share']);
function fail(message: string): never { throw new ProviderError('provider_bad_response', message); }

/** Providers fetch URLs remotely; still reject local targets before sending them out. */
function publicUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) fail('资料链接不是有效的公开 HTTPS 地址。');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('资料链接格式无效。'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const literal = host.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') || isIP(literal) || host.includes(':') || isPrivateHost(host) || /\.(?:invalid|test|localhost|local|internal)$/.test(host)) fail('只读取公开网站，不能读取本机或内部地址。');
  url.hostname = host;
  url.hash = '';
  return url.href;
}
function comparable(url: string): string { const parsed = new URL(publicUrl(url)); parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'; return parsed.href; }
function isXHost(host: string): boolean { return host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com'); }
function ordinaryUrl(raw: unknown): string { const url = publicUrl(raw); if (/\.pdf(?:$|\/)/i.test(new URL(url).pathname)) fail('这里只读取普通网页，不转换 PDF 文档。'); if (isXHost(new URL(url).hostname)) fail('X 资料须通过公开账号工具读取，不能使用网页摘要路线。'); return url; }
function linksFrom(text: string, extra: unknown[] = []): string[] {
  const values: unknown[] = [...extra, ...(text.match(/https:\/\/[^\s<>"'\]）)]+/g) ?? []).map(value => value.replace(/[.,;。；]+$/, ''))];
  const links: string[] = [];
  for (const value of values) { try { const url = publicUrl(value); if (!links.includes(url)) links.push(url); } catch { /* Untrusted links are not eligible tool targets. */ } if (links.length >= 24) break; }
  return links;
}
function text(raw: unknown, max = TEXT_LIMIT): string { return sanitizeText(raw, max); }
function profileKind(url: string): ResearchPage['kind'] {
  const parsed = new URL(url);
  if (extractGitHubHandle(url) || (X_HOSTS.has(parsed.hostname) && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(parsed.pathname)) || /(^|\.)linkedin\.com$/.test(parsed.hostname) && /^\/in\/[^/]+\/?$/.test(parsed.pathname) || /^\/(?:about|bio|profile)\/?$/i.test(parsed.pathname)) return 'profile';
  return 'third_party';
}
function result(pages: ResearchPage[], bytes: number, estimatedUsd: number | null, credits: number | null = null, limitations: string[] = [], nextCursor?: string | null): ResearchToolResult {
  return { pages, requests: 1, bytes, estimatedUsd, credits, limitations, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}
function estimate(raw: unknown): number | null { const n = asNumber(raw); return n !== null && n >= 0 ? n : null; }
function xHandle(raw: string): string {
  const url = new URL(publicUrl(raw));
  const handle = url.pathname.replace(/^\/|\/$/g, '');
  if (!X_HOSTS.has(url.hostname) || url.search || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || X_RESERVED.has(handle.toLowerCase())) fail('需要一个有效的 X 公开个人主页链接。');
  return handle;
}
function decimalId(raw: unknown): string | null { return typeof raw === 'string' && /^[0-9]+$/.test(raw) ? raw : null; }
function xAccount(raw: unknown, requestedHandle: string): { data: Record<string, unknown>; account: ResearchAccount } {
  const data = asRecord(raw);
  const handle = asString(data.profile);
  const restId = decimalId(data.rest_id);
  const id = restId ?? decimalId(data.id);
  if (!handle || handle.toLowerCase() !== requestedHandle.toLowerCase() || !id || data.status !== 'active' || data.protected !== false || (data.rest_id !== undefined && !restId) || (data.id !== undefined && decimalId(data.id) !== id)) fail('公开账号的身份或访问状态不匹配，未采用返回资料。');
  return { data, account: { platform: 'x', handle, id, profileUrl: `https://x.com/${handle}` } };
}

/** One action is one metered HTTP request. The controller owns budgets and retries. */
export function createResearchTools(options: ResearchToolsOptions): ResearchTools {
  async function request(url: string, init: HttpRequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await safeFetchJson({ transport: options.transport, url, init: { ...init, headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...init.headers } }, signal, timeoutMs: Math.min(30_000, Math.max(1, options.timeoutMs)), maxBytes: Math.min(2_000_000, Math.max(1, options.maxBytes)) });
    if (response.status !== 200) fail('供应商没有返回成功响应。');
    return { body: asRecord(response.json), bytes: response.bytes };
  }
  function key(value: string | null, name: string): string { if (!value) throw new ProviderError('provider_unavailable', `${name} 资料读取暂不可用。`); return value; }
  async function exa(action: Extract<ResearchToolAction, { type: 'search' }> | { type: 'read'; url: string }, signal: AbortSignal): Promise<ResearchToolResult> {
    const apiKey = key(options.exaApiKey, '网页');
    const searching = action.type === 'search';
    const query = searching ? action.query.trim() : '';
    if (searching && (!query || query.length > 600)) fail('搜索内容为空或过长。');
    const requested = action.type === 'read' ? publicUrl(action.url) : null;
    const payload = searching ? { query, numResults: 5, contents: { text: { maxCharacters: TEXT_LIMIT } } } : { urls: [requested], text: { maxCharacters: TEXT_LIMIT }, maxAgeHours: 24, subpages: 0, livecrawlTimeout: Math.min(10_000, options.timeoutMs) };
    const { body, bytes } = await request(`https://api.exa.ai/${searching ? 'search' : 'contents'}`, { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: JSON.stringify(payload) }, signal);
    if (!Array.isArray(body.results)) fail('网页供应商返回了不支持的数据结构。');
    const pages: ResearchPage[] = [];
    for (const raw of asArray(body.results).slice(0, searching ? 5 : 1)) {
      const item = asRecord(raw);
      const url = publicUrl(item.url);
      if (requested && comparable(url) !== comparable(requested)) fail('返回网页与请求地址不匹配。');
      if (requested) {
        const status = asArray(body.statuses).map(asRecord).find(s => typeof s.id === 'string' && (s.id === item.id || s.id === item.url || s.id === requested));
        if (!status || status.status !== 'success') fail('请求网页没有获得可用正文。');
      }
      const content = text(item.text);
      if (!content) { if (requested) fail('请求网页没有可用正文。'); else continue; }
      const author = text(item.author, 160);
      const limitations = ['网页内容仍需核对人物归属；同名不代表同一人。'];
      if (author) limitations.push(`页面返回的作者署名：${author}；尚未独立核实。`);
      if (typeof item.text === 'string' && item.text.length > TEXT_LIMIT) limitations.push('正文已截取前 6000 个字符。');
      pages.push({ url, title: text(item.title, 200) || url, text: content, kind: profileKind(url), publishedAt: asString(item.publishedDate), links: linksFrom(content), limitations });
    }
    if (requested && pages.length !== 1) fail('请求网页没有返回对应正文。');
    return result(pages, bytes, estimate(asRecord(body.costDollars).total), null, ['网页费用为供应商估算，并非最终账单。']);
  }
  async function firecrawl(urlInput: string, signal: AbortSignal): Promise<ResearchToolResult> {
    const url = ordinaryUrl(urlInput);
    const apiKey = key(options.firecrawlApiKey, '网页');
    const { body, bytes } = await request('https://api.firecrawl.dev/v2/scrape', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ url, formats: ['markdown'], parsers: [], onlyMainContent: true, onlyCleanContent: false, timeout: Math.min(30_000, options.timeoutMs), skipTlsVerification: false }) }, signal);
    const data = asRecord(body.data); const metadata = asRecord(data.metadata);
    if (body.success !== true || metadata.statusCode !== 200 || metadata.error) fail('目标网页未成功返回公开正文。');
    const contentType = asString(metadata.contentType) ?? asString(metadata.mimeType) ?? asString(metadata['content-type']);
    if (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) fail('返回内容不是普通 HTML 网页。');
    const sourceUrl = ordinaryUrl(metadata.sourceURL); const finalUrl = ordinaryUrl(metadata.url);
    if (comparable(sourceUrl) !== comparable(url)) fail('抓取来源与请求地址不匹配。');
    const canonicalHost = (value: string) => new URL(value).hostname.replace(/^www\./, '');
    if (canonicalHost(finalUrl) !== canonicalHost(url)) fail('网页跳转到了其他网站，未采用返回资料。');
    const content = text(data.markdown); if (!content) fail('目标网页没有可用正文。');
    const limitations = ['网页原文仍需核对人物归属。', `请求地址：${sourceUrl}`, `最终地址：${finalUrl}`];
    if (typeof data.markdown === 'string' && data.markdown.length > TEXT_LIMIT) limitations.push('正文已截取前 6000 个字符。');
    return result([{ url: sourceUrl, title: text(metadata.title, 200) || sourceUrl, text: content, kind: profileKind(sourceUrl), publishedAt: null, links: linksFrom(content, [finalUrl]), limitations }], bytes, null, estimate(metadata.creditsUsed), ['费用按返回的 credits 记录，美元成本未确认。']);
  }
  async function social(type: 'social_profile' | 'social_posts', url: string, signal: AbortSignal): Promise<ResearchToolResult> {
    const handle = xHandle(url); const apiKey = key(options.tikhubApiKey, '公开账号');
    const endpoint = type === 'social_profile' ? 'fetch_user_profile' : 'fetch_user_post_tweet';
    const { body, bytes } = await request(`https://api.tikhub.io/api/v1/twitter/web/${endpoint}?screen_name=${encodeURIComponent(handle)}`, { headers: { authorization: `Bearer ${apiKey}` } }, signal);
    if (body.code !== 200) {
      const status = asNumber(body.code) ?? undefined;
      throw new ProviderError(status === 429 ? 'provider_rate_limited' : status === 401 || status === 403 ? 'provider_forbidden' : 'provider_bad_response', '公开账号供应商拒绝或未完成本次读取。', status);
    }
    const data = asRecord(body.data);
    if (type === 'social_posts' && data.status !== 'ok') fail('公开帖子没有返回成功的读取状态。');
    const target = xAccount(type === 'social_profile' ? data : data.user, handle);
    if (type === 'social_profile') {
      const content = [text(target.data.name, 200), text(target.data.desc), asString(target.data.website)].filter(Boolean).join('\n').slice(0, TEXT_LIMIT);
      return result([{ url: target.account.profileUrl, title: text(target.data.name, 200) || handle, text: content || `公开账号 @${handle}`, kind: 'profile', publishedAt: null, account: target.account, links: linksFrom(content, [target.data.website]), limitations: ['账号资料是账号自述；不自动证明跨平台身份。'] }], bytes, .001, null, ['账号读取费用按目录价估算，并非最终账单。']);
    }
    if (!Array.isArray(data.timeline)) fail('公开帖子返回了不支持的数据结构。');
    const pages: ResearchPage[] = [];
    for (const raw of data.timeline) {
      const item = asRecord(raw);
      // Never recursively harvest text: retweets and quoted authors are different evidence.
      if (item.retweeted_tweet || item.retweeted || item.retweet || item.retweeted_status || item.is_retweet === true) continue;
      if (decimalId(asRecord(item.author).rest_id) !== target.account.id) continue;
      const id = decimalId(item.tweet_id); const content = text(item.text);
      if (!id || !content) continue;
      const limitations = ['内容由该账号发布；不代表已经独立验证其中陈述。'];
      if (item.quoted || item.quoted_tweet || item.quoted_status) limitations.push('这条帖子引用了其他内容；这里只保留本人外层文字，不收录被引用作者的陈述。');
      if (item.reply_to) limitations.push('这是一条回复，尚未读取完整上下文。');
      if (typeof item.text === 'string' && item.text.length > TEXT_LIMIT) limitations.push('帖子已截取前 6000 个字符。');
      pages.push({ url: `https://x.com/${target.account.handle}/status/${id}`, title: `@${target.account.handle} 的公开帖子`, text: content, kind: 'work', publishedAt: asString(item.created_at), account: target.account, links: linksFrom(content), limitations });
      if (pages.length === 10) break;
    }
    const nextCursor = asString(data.next_cursor);
    const limitations = ['仅保留已核对账号 ID 的本人帖子；转发与引用原文未混入。', '账号读取费用按目录价估算，并非最终账单。'];
    if (nextCursor || data.timeline.length > pages.length) limitations.push('仅读取一页，最多保留 10 条本人帖子，资料不完整。');
    return result(pages, bytes, .001, null, limitations, nextCursor);
  }
  async function github(raw: string, signal: AbortSignal): Promise<ResearchToolResult> {
    const url = publicUrl(raw); const handle = extractGitHubHandle(url); if (!handle) fail('需要有效的 GitHub 个人主页链接。');
    const { body, bytes } = await request(`https://api.github.com/users/${encodeURIComponent(handle)}`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {}) } }, signal);
    const login = asString(body.login); const returnedUrl = publicUrl(body.html_url);
    const id = decimalId(body.id) ?? (typeof body.id === 'number' && Number.isSafeInteger(body.id) && body.id >= 0 ? String(body.id) : null);
    if (!login || login.toLowerCase() !== handle.toLowerCase() || !id || comparable(returnedUrl).toLowerCase() !== comparable(url).toLowerCase()) fail('返回的 GitHub 账号与请求不匹配。');
    const content = [text(body.name, 200), text(body.bio), text(body.company, 200), asString(body.blog)].filter(Boolean).join('\n').slice(0, TEXT_LIMIT);
    const account: ResearchAccount = { platform: 'github', handle: login, id, profileUrl: returnedUrl };
    return result([{ url: returnedUrl, title: text(body.name, 200) || login, text: content || `GitHub 公开账号 ${login}`, kind: 'profile', publishedAt: null, account, links: linksFrom(content, [body.blog]), limitations: ['公开账号资料为自述；仓库和跨平台身份尚未核实。'] }], bytes, 0);
  }
  return { async execute(action, signal) {
    signal.throwIfAborted();
    switch (action.type) {
      case 'search': return exa(action, signal);
      case 'read': return exa({ type: 'read', url: action.url }, signal);
      case 'firecrawl': return firecrawl(action.url, signal);
      case 'social_profile': case 'social_posts': return social(action.type, action.url, signal);
      case 'github_profile': return github(action.url, signal);
      default: return fail('不支持的资料读取动作。');
    }
  } };
}
