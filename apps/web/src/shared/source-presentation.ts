/**
 * Shared pure source presentation projection (contract:
 * docs/design/platform-source-reading-2026-10-23.md).
 *
 * Presentation only: every value is derived on the fly from fields already
 * observed on a source (URL, source kind, fetch status). It never mutates
 * retained sources, never adds facts, and old canonical reports keep working
 * without any migration because unknown or missing fields fall back safely.
 *
 * Conservative rules enforced here:
 * - a platform label comes from the link host only (exact domain or a real
 *   subdomain of it) and is never identity, capability or completeness proof;
 * - confusing suffix hosts (`github.com.evil.example`, `fakegithub.com`) and
 *   malformed/unsafe URLs (non-http(s), unparseable, embedded credentials)
 *   refuse the match and fall back to a generic website / plain text;
 * - content-form labels are derived from observed URL shapes only (a video
 *   PAGE is labelled as a page, media is explicitly unread);
 * - "obtained material" is claimed only for fetchStatus 'ok', and never as
 *   complete platform or source history.
 */

import { SOURCE_KIND_LABELS } from './canonical.js';
import type { SourceKind } from './types.js';
import { isPrivateHost } from './validation.js';

export type SourcePlatformId =
  | 'github'
  | 'x'
  | 'bluesky'
  | 'threads'
  | 'reddit'
  | 'youtube'
  | 'bilibili'
  | 'xiaohongshu'
  | 'douyin'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'zhihu'
  | 'wechat'
  | 'website';

export const SOURCE_PLATFORM_LABELS: Record<SourcePlatformId, string> = {
  github: 'GitHub',
  x: 'X（Twitter）',
  bluesky: 'Bluesky',
  threads: 'Threads',
  reddit: 'Reddit',
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  xiaohongshu: '小红书',
  douyin: '抖音',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  zhihu: '知乎',
  wechat: '微信公众号',
  website: '网站'
};

/**
 * Known platform domains. A host matches only when it equals the domain or is
 * a real subdomain of it (`host === domain || host.endsWith('.' + domain)`),
 * which is what refuses confusing suffix hosts. Never guess beyond this table.
 */
const PLATFORM_DOMAINS: readonly (readonly [string, SourcePlatformId])[] = [
  ['github.com', 'github'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['bsky.app', 'bluesky'],
  ['bluesky.app', 'bluesky'],
  ['threads.net', 'threads'],
  ['threads.com', 'threads'],
  ['reddit.com', 'reddit'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['bilibili.com', 'bilibili'],
  ['xiaohongshu.com', 'xiaohongshu'],
  ['douyin.com', 'douyin'],
  ['tiktok.com', 'tiktok'],
  ['instagram.com', 'instagram'],
  ['facebook.com', 'facebook'],
  ['zhihu.com', 'zhihu'],
  ['weixin.qq.com', 'wechat']
];

const PLATFORM_LIMIT = '平台标签只按链接主机推断，不是身份归属、能力支持或已读完的证明。';
const NOTE_PAGE = '只按链接形状标注，不代表内容已读取或已核对。';
const NOTE_ACCOUNT = '只按链接形状标注，不代表账号归属已确认。';
const NOTE_MEDIA = '只按链接形状标注；图片、音视频未读取，不代表已观看。';

export interface SourcePlatformPresentation {
  /** Presentation platform id; `website` is the safe generic fallback. */
  id: SourcePlatformId;
  label: string;
  /** True only for an exact-domain / real-subdomain match of a known platform. */
  matched: boolean;
  /** Normalized display host, or null when the URL is missing or unusable. */
  host: string | null;
  /** Quiet domain text always safe to show, with an honest fallback. */
  hostLabel: string;
  /** Content form observed from the URL shape only; null when not observed. */
  contentFormLabel: string | null;
  contentFormNote: string | null;
  /** Absolute safe http(s) URL for navigation, or null (render as plain text). */
  safeHref: string | null;
  /** Presentation limits that must stay visible next to the platform context. */
  limits: string[];
}

interface ContentForm {
  label: string;
  note: string;
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function contentFormFor(id: SourcePlatformId, host: string, path: string): ContentForm | null {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const step = (index: number): string => (segments[index] ?? '').toLowerCase();
  const first = step(0);
  const account = (): ContentForm => ({ label: '账号页面', note: NOTE_ACCOUNT });
  const page = (label: string): ContentForm => ({ label, note: NOTE_PAGE });
  const media = (label: string): ContentForm => ({ label, note: NOTE_MEDIA });
  switch (id) {
    case 'github':
      if (host === 'gist.github.com') return segments.length > 0 ? page('代码片段页面') : null;
      if (segments.length === 1) return first ? account() : null;
      if (segments.length === 2) return page('仓库页面');
      if (['issues', 'pull', 'pulls', 'discussions'].includes(step(2))) return page('讨论页面');
      return null;
    case 'x':
      if (step(1) === 'status') return page('帖子页面');
      if (segments.length === 1 && first && !['home', 'notifications', 'explore', 'search', 'settings', 'messages', 'i', 'login', 'signup', 'intent', 'share', 'hashtag', 'compose'].includes(first)) {
        return account();
      }
      return null;
    case 'bluesky':
      if (step(0) === 'profile') return step(2) === 'post' ? page('帖子页面') : account();
      return null;
    case 'threads':
      if (first.startsWith('@')) return step(1) === 'post' ? page('帖子页面') : account();
      return null;
    case 'reddit':
      if (step(0) === 'r' && segments.length >= 2) return step(2) === 'comments' ? page('帖子页面') : page('版块页面');
      if ((step(0) === 'user' || step(0) === 'u') && segments.length >= 2) return account();
      if (step(0) === 'comments') return page('帖子页面');
      return null;
    case 'youtube':
      if (first === 'watch') return media('视频页面');
      if (first === 'shorts' || first === 'live') return media('短视频页面');
      if (first === 'playlist') return page('列表页面');
      if (first.startsWith('@') || ['channel', 'c', 'user'].includes(first)) return account();
      return null;
    case 'bilibili':
      if (first === 'video') return media('视频页面');
      if (first === 'space' || host === 'space.bilibili.com') return account();
      if (first === 'read') return page('文章页面');
      if (first === 'bangumi') return media('番剧页面');
      return null;
    case 'xiaohongshu':
      if (first === 'explore') return page('笔记页面');
      if (first === 'user' && step(1) === 'profile') return account();
      return null;
    case 'douyin':
      if (first.startsWith('@')) return step(1) === 'video' ? media('视频页面') : account();
      if (first === 'video') return media('视频页面');
      if (first === 'user') return account();
      return null;
    case 'tiktok':
      if (first.startsWith('@')) {
        if (step(1) === 'video') return media('视频页面');
        if (step(1) === 'photo') return media('图片页面');
        return account();
      }
      return null;
    case 'instagram':
      if (first === 'p') return page('帖子页面');
      if (first === 'reel' || first === 'reels' || first === 'tv') return media('短视频页面');
      if (segments.length === 1 && first && !['explore', 'stories', 'about', 'developer', 'legal', 'accounts', 'directory'].includes(first)) {
        return account();
      }
      return null;
    case 'facebook':
      if (first === 'watch') return media('视频页面');
      if (['photo', 'photo.php', 'video', 'video.php', 'story', 'story.php', 'posts', 'permalink', 'reel'].includes(first)) {
        return page('帖子页面');
      }
      if (first === 'profile.php') return account();
      if (segments.length === 1 && first && !['pages', 'groups', 'events', 'marketplace', 'gaming', 'friends', 'messages', 'settings', 'help', 'login', 'recover', 'search', 'bookmarks'].includes(first)) {
        return account();
      }
      return null;
    case 'zhihu':
      if (host === 'zhuanlan.zhihu.com' && first === 'p') return page('文章页面');
      if (first === 'question') return page('问题页面');
      if (first === 'people' || first === 'org') return account();
      if (first === 'pin') return page('想法页面');
      return null;
    case 'wechat':
      if (first === 's') return page('文章页面');
      return null;
    default:
      return null;
  }
}

function fallback(hostLabel: string, limits: string[], host: string | null = null, safeHref: string | null = null): SourcePlatformPresentation {
  return {
    id: 'website',
    label: SOURCE_PLATFORM_LABELS.website,
    matched: false,
    host,
    hostLabel,
    contentFormLabel: null,
    contentFormNote: null,
    safeHref,
    limits
  };
}

/**
 * Conservative URL projection. Any doubt falls back to a generic website with
 * honest limit text; an unusable URL never becomes a live link.
 */
export function sourcePlatformFromUrl(url: unknown): SourcePlatformPresentation {
  if (typeof url !== 'string' || url.trim() === '') {
    return fallback('未提供链接', ['链接缺失，只按原文展示。']);
  }
  const value = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fallback('链接无法解析', ['链接无法解析，只按原文展示，不生成可点击链接。']);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fallback('链接协议不受支持', ['链接不是 http(s) 地址，只按原文展示，不生成可点击链接。']);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) {
    return fallback('链接缺少主机', ['链接缺少主机，只按原文展示，不生成可点击链接。']);
  }
  if (!host.includes('.') || isPrivateHost(host)) {
    // Single-label hosts (no dot) are not public domains: refuse the link.
    return fallback(host, ['链接主机不是公开域名，只按原文展示，不生成可点击链接。'], host, null);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return fallback(host, ['链接包含内嵌凭据，不生成可点击链接。'], host, null);
  }
  const safeHref = value;
  for (const [domain, id] of PLATFORM_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      const form = contentFormFor(id, host, parsed.pathname);
      return {
        id,
        label: SOURCE_PLATFORM_LABELS[id],
        matched: true,
        host,
        hostLabel: host,
        contentFormLabel: form?.label ?? null,
        contentFormNote: form?.note ?? null,
        safeHref,
        limits: [PLATFORM_LIMIT]
      };
    }
  }
  const generic = fallback(host, [], host, safeHref);
  generic.contentFormLabel = null;
  return generic;
}

/** Human source-kind label with an honest fallback for unknown historical values. */
export function sourceKindLabel(kind: unknown): string {
  if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_KIND_LABELS, kind)) {
    return SOURCE_KIND_LABELS[kind as SourceKind];
  }
  return '类型未知';
}

/** Fetch-status label; unknown historical values never claim material. */
export function sourceFetchStatusLabel(fetchStatus: unknown): string {
  if (fetchStatus === 'ok') return '已读取';
  if (fetchStatus === 'truncated') return '被截断';
  if (fetchStatus === 'inaccessible') return '未能读取';
  if (fetchStatus === 'excluded') return '已不采用';
  return '状态未知';
}

export interface SourcePresentationInput {
  url?: unknown;
  kind?: unknown;
  fetchStatus?: unknown;
  excluded?: unknown;
}

export interface SourcePresentation extends SourcePlatformPresentation {
  kindLabel: string;
  statusLabel: string;
  /** True only when fetchStatus is 'ok' and the source is not excluded. */
  obtainedMaterial: boolean;
  /** Honest material statement shown next to excerpts and status rows. */
  materialNote: string;
}

/**
 * Row/detail projection of one source. "Obtained material" is claimed only for
 * fetchStatus 'ok', and even then never as complete history.
 */
export function sourcePresentation(source: SourcePresentationInput): SourcePresentation {
  const platform = sourcePlatformFromUrl(source?.url);
  const statusLabel = sourceFetchStatusLabel(source?.fetchStatus);
  const excluded = source?.excluded === true;
  const obtainedMaterial = source?.fetchStatus === 'ok' && !excluded;
  const materialNote = obtainedMaterial
    ? '获取状态：已读取。已取得材料，不代表该来源或该平台的全部历史已读完。'
    : excluded
      ? '已不采用这条来源；摘录仅按现存记录保留，不作为已采用材料。'
      : `获取状态：${statusLabel}。未确认已取得材料，摘录仅按现存记录展示。`;
  return {
    ...platform,
    kindLabel: sourceKindLabel(source?.kind),
    statusLabel,
    obtainedMaterial,
    materialNote
  };
}

export interface PlatformCoverageEntry {
  id: SourcePlatformId;
  label: string;
  total: number;
  obtained: number;
  excluded: number;
}

export interface PlatformCoverageSummary {
  entries: PlatformCoverageEntry[];
  totalSources: number;
  obtainedSources: number;
  note: string;
}

export const PLATFORM_COVERAGE_NOTE =
  '只统计这次研究已有来源的平台与条数，与当前筛选和已选平台无关；未列出的平台不代表被搜索过，任何平台都不代表全部历史已读完。';

/**
 * Coverage summary over the actual run sources only. Deliberately independent
 * of the first-step selection, the discovery catalog and the active source
 * filter: it reports what material this run actually has.
 */
export function platformCoverageFromSources(sources: readonly SourcePresentationInput[]): PlatformCoverageSummary {
  const entries = new Map<SourcePlatformId, PlatformCoverageEntry>();
  let totalSources = 0;
  let obtainedSources = 0;
  for (const source of sources ?? []) {
    totalSources += 1;
    const presentation = sourcePresentation(source);
    if (presentation.obtainedMaterial) obtainedSources += 1;
    const entry = entries.get(presentation.id) ?? {
      id: presentation.id,
      label: presentation.label,
      total: 0,
      obtained: 0,
      excluded: 0
    };
    entry.total += 1;
    if (presentation.obtainedMaterial) entry.obtained += 1;
    if (source?.excluded === true) entry.excluded += 1;
    entries.set(presentation.id, entry);
  }
  return { entries: [...entries.values()], totalSources, obtainedSources, note: PLATFORM_COVERAGE_NOTE };
}

const URL_IN_TEXT = /https?:\/\/[^\s\u3400-\u9fff\u3000-\u303f\uFF01-\uFF60]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"`]+$/;
const PREVIEW_TEXT_LIMIT = 120;
const PREVIEW_PATH_LIMIT = 28;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function compressUrlForPreview(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
    if (!host) return truncate(url, PREVIEW_PATH_LIMIT);
    const path = parsed.pathname
      .split('/')
      .map(safeDecodeSegment)
      .join('/')
      .replace(/\/+$/, '');
    return `${host}${truncate(path, PREVIEW_PATH_LIMIT)}`;
  } catch {
    return truncate(url, PREVIEW_PATH_LIMIT);
  }
}

/**
 * History preview label: compress every embedded URL to "host + short path"
 * (query/fragment dropped, percent-encoding decoded) so a question of URL plus
 * prose never renders an enormous encoded path. The full question stays in the
 * accessible name and title; this string is display-only.
 */
export function historyPreviewLabel(question: unknown): string {
  if (typeof question !== 'string' || question.trim() === '') return '未命名研究';
  const preview = question.trim().replace(URL_IN_TEXT, (match) => {
    let url = match;
    let tail = '';
    const trailing = TRAILING_PUNCTUATION.exec(url);
    if (trailing) {
      tail = trailing[0];
      url = url.slice(0, url.length - tail.length);
    }
    return `${compressUrlForPreview(url)}${tail}`;
  });
  return preview.length > PREVIEW_TEXT_LIMIT ? `${preview.slice(0, PREVIEW_TEXT_LIMIT).trimEnd()}…` : preview;
}
