/**
 * Shared contract for the first step: name / public URL input -> multi-platform
 * Search discovery -> evidence-aware person & account presentation -> one
 * atomic, version-bound account selection.
 *
 * Authority rules (see docs/superpowers/specs/2026-10-05-search-first-step-design.md):
 * - `ResearchCase / AccountSelection / ScopeVersion / EvidenceRef /
 *   SourceRevision` (research-case.ts) stay the fact store; this module only
 *   defines the presentation projection, the conservative account keys, the
 *   identity-evidence rules and the selection input shape.
 * - Identity support is only granted by an explicit, role-correct association
 *   read from an actual source. Shared handle, shared avatar, name similarity
 *   and search-index snippets only produce candidates. Two observations of the
 *   same source are never independent evidence. A search snippet is never an
 *   original ("搜索索引不当原文").
 * - A user selection never upgrades identity evidence; an exclusion statement
 *   ("不是此人") is recorded separately from an unchecked box and revoking it
 *   never becomes support.
 *
 * This module has no runtime dependencies so server, client and tests share
 * one authority for the shapes and the rules.
 */

import type {
  AllowedScope,
  IdentitySupportState,
  ResearchValue,
  UserSelection,
  AccessCoverage
} from './research-case.js';
import { ACCOUNT_KEY_PREFIX, canonicalJson } from './discovery-plan.js';
import type { DiscoveredAccountIdentity } from './discovery-plan.js';

export const FIRST_STEP_SCHEMA_VERSION = 'stripsearch/first-step-discovery/v1';
export const FIRST_STEP_ACCOUNT_KEY_PREFIX = 'ssfsack/1';
/**
 * Policy v5 (2026-10-06 coverage repair): generic default of at most 11 search
 * queries, 12 results per query, 16 identity-profile reads and 2 restricted
 * model calls per discovery attempt. Operator limits always dominate these
 * defaults; the eight initial query families stay frozen and the remaining
 * query slots cover actual empty-route fallback or observed alias expansion.
 * Up to two identity reads are reserved for leads found by that later wave.
 */
export const FIRST_STEP_POLICY_VERSION = 'first-step/v6';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export type FirstStepInputKind = 'name_query' | 'homepage_url';

export interface FirstStepInput {
  kind: FirstStepInputKind;
  /** Natural name or the exact public URL text the user supplied. */
  value: string;
  /** The user's full question, kept separate from the name clue. */
  question?: string | null;
}

/* ------------------------------------------------------------------ */
/* URL classification and conservative account keys                    */
/* ------------------------------------------------------------------ */

export type FirstStepPlatform =
  | 'personal_site'
  | 'linktree'
  | 'github'
  | 'gitlab'
  | 'huggingface'
  | 'stackoverflow'
  | 'devto'
  | 'x'
  | 'linkedin'
  | 'youtube'
  | 'bilibili'
  | 'tiktok'
  | 'substack'
  | 'medium'
  | 'mastodon'
  | 'bluesky'
  | 'instagram'
  | 'threads'
  | 'facebook'
  | 'reddit'
  | 'hackernews'
  | 'quora'
  | 'telegram'
  | 'pinterest'
  | 'vk'
  | 'google_scholar'
  | 'orcid'
  | 'dblp'
  | 'zhihu'
  | 'weibo'
  | 'douban'
  | 'xiaohongshu'
  | 'jike'
  | 'rss_blog'
  | 'web_page';

export type FirstStepMaterialUse =
  | 'identity_anchor'
  | 'technical_work'
  | 'writing'
  | 'expression'
  | 'video_audio'
  | 'academic'
  | 'community'
  | 'related_material';

export type FirstStepAccountKind = 'person' | 'publication' | 'channel' | 'organization' | 'unknown';

export type FirstStepAccountCategory =
  | 'identity_work'
  | 'writing'
  | 'expression'
  | 'video_audio'
  | 'academic'
  | 'related_material'
  | 'organization';

export interface FirstStepAccountRef {
  platform: FirstStepPlatform;
  platformLabel: string;
  handle: string | null;
  /** Instance / publication domain for instance-scoped platforms. */
  instance: string | null;
  /** Platform-native stable id (YouTube channel id, Scholar user id, ...). */
  stableId: string | null;
  /** This page's canonical URL exactly as classified; never rewritten later. */
  profileUrl: string;
  /**
   * Canonical account/home URL this page is attributable to (GET-92
   * `profileUrlRule` shape). Content pages share their account's URL; an
   * unattributable page keeps its own URL. Never guessed from other authors.
   */
  accountUrl: string;
  /** Conservative canonical key; same referent = same key, never cross-platform. */
  accountKey: string;
  materialUse: FirstStepMaterialUse;
  accountKind: FirstStepAccountKind;
  /** `profile` is an account/home entry; `page` is a content page of an account. */
  entry: 'profile' | 'page';
  /**
   * Whether this page's account/home entry is DOCUMENTED: the platform URL
   * rule derives a distinct account home (a repo -> its owner profile), or the
   * page itself is an account/home entry. Unattributed generic content pages
   * (a third-party news article, a platform login/search/watch/playlist root)
   * are never accounts by assumption: they stay material receipts until an
   * actual observed self-authorial site section documents the account home.
   */
  attributable: boolean;
}

export type FirstStepUrlClassification =
  | { ok: true; ref: FirstStepAccountRef }
  | { ok: false; code: 'unsafe_url' | 'not_a_url'; reason: string };

const KNOWN_HOSTS = new Map<string, FirstStepPlatform>([
  ['github.com', 'github'],
  // Verified instance examples in https://blog.joinmastodon.org/2026/03/a-new-share-button/
  ['mastodon.social','mastodon'], ['hachyderm.io','mastodon'], ['social.coop','mastodon'],
  ['gitlab.com', 'gitlab'],
  ['huggingface.co', 'huggingface'],
  ['stackoverflow.com', 'stackoverflow'],
  ['stackexchange.com', 'stackoverflow'],
  ['dev.to', 'devto'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['linkedin.com', 'linkedin'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['space.bilibili.com', 'bilibili'],
  ['bilibili.com', 'bilibili'],
  ['tiktok.com', 'tiktok'],
  ['substack.com', 'substack'],
  ['medium.com', 'medium'],
  ['bluesky.app', 'bluesky'],
  ['bsky.app', 'bluesky'],
  ['instagram.com', 'instagram'],
  ['threads.net', 'threads'],
  ['threads.com', 'threads'],
  ['facebook.com', 'facebook'],
  ['fb.com', 'facebook'],
  ['reddit.com', 'reddit'],
  ['news.ycombinator.com', 'hackernews'],
  ['quora.com', 'quora'],
  ['t.me', 'telegram'],
  ['pinterest.com', 'pinterest'],
  ['vk.com', 'vk'],
  ['scholar.google.com', 'google_scholar'],
  ['orcid.org', 'orcid'],
  ['dblp.org', 'dblp'],
  ['zhihu.com', 'zhihu'],
  ['weibo.com', 'weibo'],
  ['douban.com', 'douban'],
  ['xiaohongshu.com', 'xiaohongshu'],
  ['okjike.com', 'jike'],
  ['linktr.ee', 'linktree'],
  ['beacons.ai', 'linktree']
]);

/** Host lookup with only the verified common public prefixes, never a guess. */
function hostPlatform(host: string): FirstStepPlatform | null {
  const direct = KNOWN_HOSTS.get(host) ?? KNOWN_HOSTS.get(host.replace(/^www\./, ''));
  if (direct) return direct;
  const stripped = host.replace(/^(?:m|mobile|amp)\./, '');
  return KNOWN_HOSTS.get(stripped) ?? KNOWN_HOSTS.get(stripped.replace(/^www\./, '')) ?? null;
}

const PLATFORM_LABELS: Record<FirstStepPlatform, string> = {
  personal_site: '个人网站',
  linktree: '链接目录',
  github: 'GitHub',
  gitlab: 'GitLab',
  huggingface: 'Hugging Face',
  stackoverflow: 'Stack Overflow',
  devto: 'DEV',
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  tiktok: 'TikTok',
  substack: 'Substack',
  medium: 'Medium',
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  instagram: 'Instagram',
  threads: 'Threads',
  facebook: 'Facebook',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  quora: 'Quora',
  telegram: 'Telegram 公开频道',
  pinterest: 'Pinterest',
  vk: 'VK',
  google_scholar: 'Google Scholar',
  orcid: 'ORCID',
  dblp: 'DBLP',
  zhihu: '知乎',
  weibo: '微博',
  douban: '豆瓣',
  xiaohongshu: '小红书',
  jike: '即刻',
  rss_blog: '独立博客',
  web_page: '公开网页'
};

/** URL shapes the offline checks must never treat as public fetch targets. */
const BLOCKED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'test', 'invalid', 'localdomain', 'example', 'example.com', 'example.org', 'example.net'];
const BLOCKED_HOSTS = new Set(['example.com', 'example.org', 'example.net', 'example.invalid']);

function isBlockedHost(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isLiteralIp(host: string): boolean {
  if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
  return host.includes(':') || /^\[.*\]$/.test(host);
}

/** GET-92-style conservative URL normalization (scheme + authority only). */
function normalizeSchemeHost(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return value;
  const scheme = value.slice(0, schemeEnd).toLowerCase();
  const rest = value.slice(schemeEnd + 3);
  const boundary = rest.search(/[/?#]/);
  const authority = boundary < 0 ? rest : rest.slice(0, boundary);
  const tail = boundary < 0 ? '' : rest.slice(boundary);
  return `${scheme}://${authority.toLowerCase()}${tail}`;
}

/**
 * The GET-58/92 identity projection of one classified reference, so server
 * code can run the verified `canonicalAccountKey` over exactly this identity.
 */
export function firstStepAccountIdentity(ref: {
  platform: FirstStepPlatform;
  instance: string | null;
  accountKind: FirstStepAccountKind;
  handle: string | null;
  accountUrl: string;
}): DiscoveredAccountIdentity {
  return {
    platformId: ref.platform,
    instance: ref.instance === null ? null : ref.instance.toLowerCase(),
    accountKind: ref.accountKind,
    nativeId: null,
    nativeIdIssuer: null,
    profileUrl: ref.accountUrl,
    actorUrl: null,
    handle: ref.handle,
    handleVerified: ref.handle !== null,
    homeInstance: ref.instance === null ? null : ref.instance.toLowerCase(),
    associationProof: null
  };
}

/**
 * Conservative canonical account key, reusing the GET-92 account-key ladder
 * (`ACCOUNT_KEY_PREFIX` + `canonicalJson` in the exact `canonicalAccountKey`
 * URL-fallback shape). Two URLs map to the same key only when they clearly
 * denote the same platform referent; cross-platform merge never happens here,
 * same-platform lookalikes stay distinct, and a content page only shares a key
 * with the account/site it is actually attributable to.
 */
export function firstStepAccountKey(ref: {
  platform: FirstStepPlatform;
  instance: string | null;
  accountKind: FirstStepAccountKind;
  handle: string | null;
  accountUrl: string;
}): string {
  const identity = firstStepAccountIdentity(ref);
  return `${ACCOUNT_KEY_PREFIX}:${canonicalJson({
    v: ACCOUNT_KEY_PREFIX,
    platformId: identity.platformId,
    instance: identity.instance,
    accountKind: identity.accountKind,
    mode: 'url',
    url: normalizeSchemeHost(identity.profileUrl as string)
  })}`;
}

function refOf(
  platform: FirstStepPlatform,
  pageUrl: string,
  parts: {
    /** Canonical account/home URL this page is attributable to. */
    accountUrl?: string;
    handle?: string | null;
    instance?: string | null;
    stableId?: string | null;
    materialUse: FirstStepMaterialUse;
    accountKind?: FirstStepAccountKind;
    entry: 'profile' | 'page';
    /**
     * Override for content pages whose account home is NOT documented by the
     * platform URL rule (generic third-party subpages, platform navigation
     * roots). Defaults to "account/home entry or documented canonicalization".
     */
    attributable?: boolean;
  }
): FirstStepAccountRef {
  const handle = parts.handle ?? null;
  const instance = parts.instance === undefined ? null : parts.instance;
  const stableId = parts.stableId ?? null;
  const accountUrl = parts.accountUrl ?? pageUrl;
  const accountKind = parts.accountKind ?? 'unknown';
  const attributable = parts.attributable ?? (parts.entry === 'profile' || accountUrl !== pageUrl);
  return {
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    handle,
    instance,
    stableId,
    profileUrl: pageUrl,
    accountUrl,
    accountKey: firstStepAccountKey({ platform, instance, accountKind, handle, accountUrl }),
    materialUse: parts.materialUse,
    accountKind,
    entry: parts.entry,
    attributable
  };
}

/**
 * Classify one public URL into an account/page reference. This is pure string
 * work: it performs no network access and never validates that the account
 * exists. Unknown shapes are classified honestly (`web_page`) instead of being
 * dropped by an old allowlist.
 */
const X_RESERVED_SEGMENTS = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'intent', 'login', 'signup', 'share', 'compose']);
const YOUTUBE_CHANNEL_TABS = new Set(['', 'videos', 'shorts', 'streams', 'playlists', 'community', 'about', 'featured', 'channels', 'search']);
/**
 * Platform navigation/login/search/settings/watch/playlist roots are never
 * account handles: they stay material receipts even when their URL shape
 * could otherwise look like a profile segment.
 */
const RESERVED_FIRST_SEGMENTS = new Set(['p', 'pin', 'reel', 'tv', 'stories', 'explore', 'accounts', 'pages', 'groups', 'watch', 'marketplace', 'events', 'photo', 'photo.php', 'story.php', 'user', 'users', 'search', 'settings', 'about', 'help', 'login', 'signup', 'tag', 'tags', 'topics', 'r', 'u', 'notifications', 'features', 'pricing', 'trending', 'collections', 'sponsors', 'codespaces', 'account', 'new', 'messages', 'compose', 'results', 'questions', 'q', 'video', 'playlist', 'feed', 'intent', 'share', 'i', 'home', 'pulls', 'issues', 'discussions', 'orgs', 'enterprises', 'apps', 'stars', 'dashboard', 'session', 'password', 'auth', 'oauth']);

export function classifyFirstStepUrl(raw: unknown): FirstStepUrlClassification {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    return { ok: false, code: 'not_a_url', reason: '链接为空或过长。' };
  }
  const trimmed = raw.trim();
  if (/[\u0000-\u0020\u007f\\]/.test(trimmed)) {
    return { ok: false, code: 'unsafe_url', reason: '链接包含控制字符或空白。' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: 'not_a_url', reason: '不是有效的 URL。' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const unsafe =
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !host.includes('.') ||
    isBlockedHost(host) ||
    isLiteralIp(host);
  if (unsafe) {
    return { ok: false, code: 'unsafe_url', reason: '只接受公开 HTTPS 链接，不能使用本机、内网或示例域名。' };
  }
  const canonical = new URL(url.href);
  canonical.hash = '';
  canonical.hostname = host;
  const href = canonical.href;
  const path = canonical.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);

  // Instance-scoped Mastodon profiles: https://instance/@user or /users/user.
  // Known platforms are matched first so substack.com/@user stays a Substack
  // profile, not an instance account.
  const known = hostPlatform(host);
  const substackHost = /^([a-z0-9-]+)\.substack\.com$/.exec(host);

  if (substackHost) {
    const name = substackHost[1]!;
    const accountUrl = `https://${host}/`;
    if (segments.length === 0) {
      return { ok: true, ref: refOf('substack', accountUrl, { accountUrl, handle: name, instance: host, materialUse: 'writing', accountKind: 'publication', entry: 'profile' }) };
    }
    return {
      ok: true,
      ref: refOf('substack', href, {
        accountUrl,
        handle: name,
        instance: host,
        materialUse: 'writing',
        accountKind: 'publication',
        entry: 'page'
      })
    };
  }

  // Custom Medium publications and Bearblog subdomains are publication-shaped
  // hosts (not Mastodon instances): the host root is the documented account/
  // publication home and its subpages are attributable content of that home.
  const customHostLabel = host.split('.')[0] ?? '';
  const isCustomMedium = host.endsWith('.medium.com') && host !== 'www.medium.com' && customHostLabel.length > 0;
  const isBearblog = (host.endsWith('.bear.blog') || host.endsWith('.bearblog.dev')) && customHostLabel.length > 0;
  if (!known && (isCustomMedium || isBearblog)) {
    // Documented Medium profile URL schemes share the same username. This is
    // a platform URL rule, not cross-platform person identity inference.
    const accountUrl = isCustomMedium ? `https://medium.com/@${customHostLabel}` : `https://${host}/`;
    return {
      ok: true,
      ref: refOf(isCustomMedium ? 'medium' : 'rss_blog', segments.length === 0 ? accountUrl : href, {
        accountUrl,
        handle: customHostLabel,
        instance: isCustomMedium ? null : host,
        materialUse: 'writing',
        accountKind: isCustomMedium ? 'person' : 'publication',
        entry: segments.length === 0 || isBearblog && segments.length === 1 && ['blog', 'about', 'posts'].includes(segments[0]!) ? 'profile' : 'page'
      })
    };
  }

  // /@user is shared by many public platforms: it does not identify the
  // server software. Known instances keep Mastodon; others remain generic
  // public-profile candidates until an actual platform proof exists.
  if ((!known || known==='mastodon') && canonical.pathname.startsWith('/@')) {
    const handle = canonical.pathname.slice(2).split('/')[0] ?? '';
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(handle)) {
      const accountUrl = `https://${host}/@${handle}`;
      return {
        ok: true,
        ref: refOf(known==='mastodon'?'mastodon':'web_page', segments.length > 1 ? href : accountUrl, {
          accountUrl,
          handle,
          instance: host,
          materialUse: 'expression',
          accountKind: 'person',
          entry: segments.length > 1 ? 'page' : 'profile'
        })
      };
    }
  }

  switch (known) {
    case 'github': {
      const handle = segments[0] ?? '';
      if (!/^[A-Za-z0-9-]{1,39}$/.test(handle) || RESERVED_FIRST_SEGMENTS.has(handle.toLowerCase())) {
        return { ok: true, ref: refOf('github', href, { materialUse: 'technical_work', entry: 'page' }) };
      }
      const accountUrl = `https://github.com/${handle}`;
      return {
        ok: true,
        ref: refOf('github', segments.length <= 1 ? accountUrl : href, {
          accountUrl,
          handle,
          materialUse: 'technical_work',
          accountKind: 'person',
          entry: segments.length <= 1 ? 'profile' : 'page'
        })
      };
    }
    case 'x': {
      const handle = segments[0] ?? '';
      const hasHandle = /^[A-Za-z0-9_]{1,15}$/.test(handle) && !X_RESERVED_SEGMENTS.has(handle.toLowerCase());
      const accountUrl = hasHandle ? `https://x.com/${handle}` : href;
      return {
        ok: true,
        ref: refOf('x', hasHandle && segments.length <= 1 ? accountUrl : href, {
          accountUrl,
          handle: hasHandle ? handle : null,
          materialUse: 'expression',
          accountKind: hasHandle ? 'person' : 'unknown',
          entry: hasHandle && segments.length <= 1 ? 'profile' : 'page'
        })
      };
    }
    case 'linkedin': {
      const kind = segments[0] ?? '';
      const slug = segments[1] ?? '';
      if ((kind === 'in' || kind === 'company') && slug) {
        const accountUrl = `https://www.linkedin.com/${kind}/${slug}/`;
        return {
          ok: true,
          ref: refOf('linkedin', segments.length <= 2 ? accountUrl : href, {
            accountUrl,
            handle: slug,
            materialUse: 'identity_anchor',
            accountKind: kind === 'company' ? 'organization' : 'person',
            entry: segments.length <= 2 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('linkedin', href, { materialUse: 'identity_anchor', entry: 'page' }) };
    }
    case 'youtube': {
      const at = canonical.pathname.match(/^\/@([A-Za-z0-9_.-]{1,64})(?:\/(.*))?$/);
      if (at) {
        const accountUrl = `https://www.youtube.com/@${at[1]}`;
        const tab = (at[2] ?? '').split('/')[0] ?? '';
        const isChannelSurface = at[2] === undefined || YOUTUBE_CHANNEL_TABS.has(tab);
        return {
          ok: true,
          ref: refOf('youtube', isChannelSurface ? accountUrl : href, {
            accountUrl,
            handle: at[1],
            materialUse: 'video_audio',
            accountKind: 'channel',
            entry: isChannelSurface ? 'profile' : 'page'
          })
        };
      }
      const channel = segments[0] === 'channel' ? segments[1] ?? '' : '';
      if (/^UC[A-Za-z0-9_-]{10,}$/.test(channel)) {
        const accountUrl = `https://www.youtube.com/channel/${channel}`;
        return {
          ok: true,
          ref: refOf('youtube', segments.length <= 2 ? accountUrl : href, {
            accountUrl,
            stableId: channel,
            materialUse: 'video_audio',
            accountKind: 'channel',
            entry: segments.length <= 2 ? 'profile' : 'page'
          })
        };
      }
      const legacy = segments[0] === 'c' || segments[0] === 'user' ? segments[1] ?? '' : '';
      if (legacy) {
        const accountUrl = `https://www.youtube.com/${segments[0]}/${legacy}`;
        return {
          ok: true,
          ref: refOf('youtube', segments.length <= 2 ? accountUrl : href, {
            accountUrl,
            handle: legacy,
            materialUse: 'video_audio',
            accountKind: 'channel',
            entry: segments.length <= 2 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('youtube', href, { materialUse: 'video_audio', entry: 'page' }) };
    }
    case 'bilibili': {
      const isSpaceHost = host === 'space.bilibili.com' || host === 'www.bilibili.com' && segments[0] === 'space';
      const id = isSpaceHost ? (host === 'space.bilibili.com' ? segments[0] ?? '' : segments[1] ?? '') : '';
      if (/^[0-9]+$/.test(id)) {
        const accountUrl = `https://space.bilibili.com/${id}`;
        return {
          ok: true,
          ref: refOf('bilibili', segments.length <= 1 ? accountUrl : href, {
            accountUrl,
            stableId: id,
            materialUse: 'video_audio',
            accountKind: 'channel',
            entry: segments.length <= 1 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('bilibili', href, { materialUse: 'video_audio', entry: 'page' }) };
    }
    case 'substack': {
      const at = canonical.pathname.match(/^\/@([A-Za-z0-9_.-]{1,64})(?:\/(.*))?$/);
      if (at) {
        const accountUrl = `https://substack.com/@${at[1]}`;
        return {
          ok: true,
          ref: refOf('substack', at[2] === undefined ? accountUrl : href, {
            accountUrl,
            handle: at[1],
            materialUse: 'writing',
            accountKind: 'person',
            entry: at[2] === undefined ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('substack', href, { handle: null, materialUse: 'writing', entry: 'page', attributable: false }) };
    }
    case 'medium': {
      const at = canonical.pathname.match(/^\/@([A-Za-z0-9_.-]{1,64})(?:\/(.*))?$/);
      if (at) {
        const accountUrl = `https://medium.com/@${at[1]}`;
        return {
          ok: true,
          ref: refOf('medium', at[2] === undefined ? accountUrl : href, {
            accountUrl,
            handle: at[1],
            materialUse: 'writing',
            accountKind: 'person',
            entry: at[2] === undefined ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('medium', href, { handle: null, materialUse: 'writing', entry: 'page', attributable: false }) };
    }
    case 'bluesky': {
      // bsky.app profiles live at /profile/<handle|did>; bluesky.app is only a
      // redirect host. Subpaths (feed/post lists) stay attributable pages.
      const profileIndex = segments[0] === 'profile' ? 1 : -1;
      const handle = profileIndex > 0 ? segments[profileIndex] ?? '' : '';
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(handle)) {
        const accountUrl = `https://bsky.app/profile/${handle}`;
        return {
          ok: true,
          ref: refOf('bluesky', segments.length <= 2 ? accountUrl : href, {
            accountUrl,
            handle,
            materialUse: 'expression',
            accountKind: 'person',
            entry: segments.length <= 2 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('bluesky', href, { materialUse: 'expression', entry: 'page' }) };
    }
    case 'instagram':
    case 'threads': {
      const raw = canonical.pathname.replace(/^\//, '');
      const first = raw.split('/')[0] ?? '';
      const handle = first.startsWith('@') ? first.slice(1) : first;
      const isProfile = /^[A-Za-z0-9_.]{1,64}$/.test(handle) && !RESERVED_FIRST_SEGMENTS.has(first.toLowerCase());
      const accountUrl = isProfile
        ? known === 'instagram' ? `https://www.instagram.com/${handle}` : `https://www.threads.net/@${handle}`
        : href;
      return {
        ok: true,
        ref: refOf(known, isProfile && segments.length <= 1 ? accountUrl : href, {
          accountUrl,
          handle: isProfile ? handle : null,
          materialUse: 'expression',
          accountKind: isProfile ? 'person' : 'unknown',
          entry: isProfile && segments.length <= 1 ? 'profile' : 'page'
        })
      };
    }
    case 'facebook': {
      const first = segments[0] ?? '';
      const suppliedId = canonical.searchParams.get('id');
      const id = canonical.pathname === '/profile.php' && suppliedId && /^[0-9]+$/.test(suppliedId) ? suppliedId : null;
      const isProfile = first !== '' && first.toLowerCase() !== 'profile.php' && !RESERVED_FIRST_SEGMENTS.has(first.toLowerCase()) && /^[A-Za-z0-9_.-]{1,80}$/.test(first);
      const accountUrl = id ? `https://www.facebook.com/profile.php?id=${id}`
        : isProfile ? `https://www.facebook.com/${first}` : href;
      return {
        ok: true,
        ref: refOf('facebook', id || (isProfile && segments.length <= 1) ? accountUrl : href, {
          accountUrl,
          handle: isProfile ? first : id ?? null,
          materialUse: 'expression',
          accountKind: isProfile || id ? 'person' : 'unknown',
          entry: (isProfile && segments.length <= 1) || (canonical.pathname === '/profile.php' && id) ? 'profile' : 'page'
        })
      };
    }
    case 'reddit': {
      const user = segments[0] === 'user' || segments[0] === 'u' ? segments[1] ?? '' : '';
      if (/^[A-Za-z0-9_-]{1,64}$/.test(user)) {
        const accountUrl = `https://www.reddit.com/user/${user}/`;
        return {
          ok: true,
          ref: refOf('reddit', segments.length <= 2 ? accountUrl : href, {
            accountUrl,
            handle: user,
            materialUse: 'community',
            accountKind: 'person',
            entry: segments.length <= 2 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('reddit', href, { materialUse: 'community', entry: 'page' }) };
    }
    case 'hackernews': {
      const user = canonical.pathname === '/user' ? canonical.searchParams.get('id') : null;
      if (user && /^[A-Za-z0-9_-]{1,64}$/.test(user)) {
        const accountUrl = `https://news.ycombinator.com/user?id=${user}`;
        return { ok: true, ref: refOf('hackernews', accountUrl, { accountUrl, handle: user, materialUse: 'community', accountKind: 'person', entry: 'profile' }) };
      }
      return { ok: true, ref: refOf('hackernews', href, { materialUse: 'community', entry: 'page' }) };
    }
    case 'quora': {
      const profile = segments[0] === 'profile' ? segments[1] ?? '' : '';
      if (profile) {
        const accountUrl = `https://www.quora.com/profile/${profile}`;
        return {
          ok: true,
          ref: refOf('quora', segments.length <= 2 ? accountUrl : href, {
            accountUrl,
            handle: profile,
            materialUse: 'community',
            accountKind: 'person',
            entry: segments.length <= 2 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('quora', href, { materialUse: 'community', entry: 'page' }) };
    }
    case 'telegram': {
      const channel = segments[0] ?? '';
      if (/^[A-Za-z0-9_]{4,64}$/.test(channel)) {
        const accountUrl = `https://t.me/${channel}`;
        return {
          ok: true,
          ref: refOf('telegram', segments.length <= 1 ? accountUrl : href, {
            accountUrl,
            handle: channel,
            materialUse: 'expression',
            accountKind: 'channel',
            entry: segments.length <= 1 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('telegram', href, { materialUse: 'expression', entry: 'page' }) };
    }
    case 'pinterest':
    case 'vk': {
      const first = segments[0] ?? '';
      const isProfile = first !== '' && !RESERVED_FIRST_SEGMENTS.has(first.toLowerCase()) && /^[A-Za-z0-9_.-]{1,80}$/.test(first);
      const accountUrl = isProfile ? `https://www.${known === 'pinterest' ? 'pinterest.com' : 'vk.com'}/${first}` : href;
      return {
        ok: true,
        ref: refOf(known, isProfile && segments.length <= 1 ? accountUrl : href, {
          accountUrl,
          handle: isProfile ? first : null,
          materialUse: 'expression',
          accountKind: isProfile ? 'person' : 'unknown',
          entry: isProfile && segments.length <= 1 ? 'profile' : 'page'
        })
      };
    }
    case 'google_scholar': {
      const user = canonical.searchParams.get('user');
      if (user && /^[A-Za-z0-9_-]{4,}$/.test(user)) {
        return {
          ok: true,
          ref: refOf('google_scholar', `https://scholar.google.com/citations?user=${encodeURIComponent(user)}`, {
            stableId: user,
            materialUse: 'academic',
            accountKind: 'person',
            entry: 'profile'
          })
        };
      }
      return { ok: true, ref: refOf('google_scholar', href, { materialUse: 'academic', entry: 'page' }) };
    }
    case 'orcid': {
      const id = segments[0] ?? '';
      if (/^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/.test(id)) {
        return {
          ok: true,
          ref: refOf('orcid', `https://orcid.org/${id}`, {
            stableId: id,
            materialUse: 'academic',
            accountKind: 'person',
            entry: 'profile'
          })
        };
      }
      return { ok: true, ref: refOf('orcid', href, { materialUse: 'academic', entry: 'page' }) };
    }
    case 'dblp': {
      const pid = segments[0] === 'pid' ? segments.slice(1).join('/') : '';
      if (pid) {
        return {
          ok: true,
          ref: refOf('dblp', `https://dblp.org/pid/${pid}`, {
            stableId: pid,
            materialUse: 'academic',
            accountKind: 'person',
            entry: 'profile'
          })
        };
      }
      return { ok: true, ref: refOf('dblp', href, { materialUse: 'academic', entry: 'page' }) };
    }
    case 'zhihu':
    case 'douban': {
      const id = segments[0] === 'people' ? segments[1] ?? '' : '';
      if (id) {
        return {
          ok: true,
          ref: refOf(known, `https://www.${host}/people/${id}`, {
            handle: id,
            materialUse: 'expression',
            accountKind: 'person',
            entry: 'profile'
          })
        };
      }
      return { ok: true, ref: refOf(known, href, { materialUse: 'expression', entry: 'page' }) };
    }
    case 'xiaohongshu': {
      const id = segments[0] === 'user' && segments[1] === 'profile' ? segments[2] ?? '' : '';
      if (id) {
        return {
          ok: true,
          ref: refOf('xiaohongshu', `https://www.xiaohongshu.com/user/profile/${id}`, {
            stableId: id,
            materialUse: 'expression',
            accountKind: 'person',
            entry: 'profile'
          })
        };
      }
      return { ok: true, ref: refOf('xiaohongshu', href, { materialUse: 'expression', entry: 'page' }) };
    }
    case 'weibo': {
      const id = segments[0] === 'u' ? segments[1] ?? '' : segments[0] ?? '';
      if (/^[0-9]+$/.test(id)) {
        return {
          ok: true,
          ref: refOf('weibo', `https://weibo.com/u/${id}`, {
            stableId: id,
            materialUse: 'expression',
            accountKind: 'person',
            entry: segments.length <= 1 ? 'profile' : 'page'
          })
        };
      }
      return { ok: true, ref: refOf('weibo', href, { materialUse: 'expression', entry: 'page' }) };
    }
    case 'linktree': {
      const handle = segments[0] ?? '';
      if (handle) {
        return {
          ok: true,
          ref: refOf('linktree', `https://linktr.ee/${handle}`, {
            handle,
            materialUse: 'identity_anchor',
            accountKind: 'person',
            entry: 'profile'
          })
        };
      }
      return { ok: true, ref: refOf('linktree', href, { materialUse: 'identity_anchor', entry: 'page' }) };
    }
    case 'stackoverflow':
    case 'huggingface':
    case 'gitlab':
    case 'devto':
    case 'tiktok':
    case 'jike': {
      const handle = segments[0] ?? '';
      const isProfile = handle !== '' && !RESERVED_FIRST_SEGMENTS.has(handle.toLowerCase()) && !['questions', 'q', 'tags', 'users', 'search', 'video', 'explore'].includes(handle);
      return {
        ok: true,
        ref: refOf(known, href, {
          handle: isProfile ? handle : null,
          materialUse: known === 'tiktok' ? 'video_audio' : known === 'jike' ? 'expression' : 'technical_work',
          accountKind: isProfile && segments.length <= 1 ? 'person' : 'unknown',
          entry: isProfile && segments.length <= 1 ? 'profile' : 'page'
        })
      };
    }
    default:
      break;
  }

  // Stanford Profiles publicly documents /<profile-slug> entries on its
  // directory host (https://profiles.stanford.edu/). Each slug stays separate.
  if (host === 'profiles.stanford.edu' && segments.length === 1 && !RESERVED_FIRST_SEGMENTS.has(segments[0]!.toLowerCase())) {
    const accountUrl = `https://${host}/${segments[0]}`;
    return { ok: true, ref: refOf('personal_site', accountUrl, { accountUrl, handle: segments[0], instance: host, materialUse: 'academic', accountKind: 'unknown', entry: 'profile' }) };
  }

  // A shared host is not one person's account. Common published personal
  // namespaces keep the owner's directory and its descendants separate.
  const personalNamespace = path.match(/^\/(~[^/]+|(?:people|users|faculty|members|authors)\/[^/]+)(?:\/|$)/i);
  const hostedSite = host === 'sites.google.com' ? path.match(/^\/(site|view)\/([^/]+)(?:\/|$)/) : null;
  const namespace = personalNamespace?.[1] ?? (hostedSite ? `${hostedSite[1]}/${hostedSite[2]}` : null);
  if (namespace) {
    const accountUrl = `https://${host}/${namespace}/`;
    const relative = path.slice(namespace.length + 1).replace(/^\/+/, '');
    const home = relative === '' || /^(?:index\.(?:html?|php)|about|bio)$/i.test(relative);
    return { ok: true, ref: refOf('personal_site', home ? accountUrl : href, {
      accountUrl, handle: namespace.split('/').at(-1)!.replace(/^~/, ''), instance: host,
      materialUse: home ? 'identity_anchor' : 'related_material', accountKind: 'unknown', entry: home ? 'profile' : 'page', attributable: true
    }) };
  }

  // Generic public web: a site root, About/Bio/Profile/Home page or blog root
  // is a personal/publication candidate; other pages are content of the same
  // site. Generic content pages are NOT attributable to a whole-domain
  // personal account by assumption (a third-party news subpage stays a
  // material receipt) — only publication-shaped hosts (blog subdomains) and
  // actually observed self-authorial site sections document the account home.
  const lowerPath = path.toLowerCase();
  const isAbout = /^\/(about|bio|profile|home|about\/me)?$/i.test(lowerPath) && segments.length <= 1;
  const isRoot = segments.length === 0;
  const isBlogRoot = segments.length === 1 && ['blog', 'weblog', 'journal', 'essays', 'notes', 'writing', 'posts'].includes(lowerPath.slice(1));
  const publicationShapedHost = /^(?:blog|blogs)\./.test(host);
  const isHomeEntry = isRoot || isAbout || isBlogRoot;
  const blogSection = ['blog', 'weblog', 'journal', 'essays', 'notes', 'writing', 'posts'].includes(segments[0]?.toLowerCase() ?? '') ? segments[0]! : null;
  const blogLike = blogSection !== null || publicationShapedHost;
  const materialUse: FirstStepMaterialUse = isHomeEntry ? (blogLike ? 'writing' : 'identity_anchor') : 'related_material';
  // A selected standalone personal site covers its own writing sections.
  // Eligibility/material grouping does not split that site's account key.
  // Shared-host author namespaces above remain distinct.
  const siteUrl = `https://${host}/`;
  return {
    ok: true,
    ref: refOf('personal_site', href, {
      accountUrl: siteUrl,
      handle: host,
      instance: host,
      materialUse,
      accountKind: 'unknown',
      entry: isHomeEntry ? 'profile' : 'page',
      attributable: isHomeEntry || publicationShapedHost || blogSection !== null
    })
  };
}

/** Display grouping for the account cards ("按研究用途列出账号"). */
export function firstStepAccountCategory(ref: FirstStepAccountRef): FirstStepAccountCategory {
  if (ref.accountKind === 'organization') return 'organization';
  switch (ref.materialUse) {
    case 'identity_anchor':
    case 'technical_work':
      return 'identity_work';
    case 'writing':
      return 'writing';
    case 'expression':
    case 'community':
      return 'expression';
    case 'video_audio':
      return 'video_audio';
    case 'academic':
      return 'academic';
    default:
      return 'related_material';
  }
}

export const FIRST_STEP_CATEGORY_LABELS: Record<FirstStepAccountCategory, string> = {
  identity_work: '身份与作品',
  writing: '文章与通讯',
  expression: '公开表达',
  video_audio: '视频与音频',
  academic: '学术与机构资料',
  related_material: '相关资料',
  organization: '组织与第三方'
};

/* ------------------------------------------------------------------ */
/* Identity evidence rules                                             */
/* ------------------------------------------------------------------ */

/**
 * How an observation was obtained. `indexed` is a search-index snippet (never
 * an original), `link_only` means only a link was seen without reading its
 * target, `read` means the original page text was actually read.
 */
export type FirstStepRetrieval = 'read' | 'indexed' | 'link_only';

export type FirstStepLinkRole =
  | 'self_account_section'
  | 'explicit_directory'
  | 'explicit_claim'
  | 'explicit_denial'
  | 'prose_mention'
  | 'unknown_role';

export interface FirstStepLinkObservation {
  observationId: string;
  /** Case source id this observation was read or indexed from. */
  sourceId: string;
  sourceRevision: number;
  /** The ACTUAL source page URL this observation was read from. */
  sourceUrl: string;
  /** sha256 of the full stored source text; never just the quote. */
  sourceContentHash: string | null;
  sourceRetrievedAt: string | null;
  /** Account key the observed page belongs to; null for third-party pages. */
  fromAccountKey: string | null;
  targetAccountKey: string;
  targetUrl: string;
  linkRole: FirstStepLinkRole;
  direction: 'outbound' | 'inbound';
  retrieval: FirstStepRetrieval;
  quote: string | null;
  /** Precise locator inside the source; never invented. */
  locator: string | null;
  observedAt: string;
}

/** Classification of the OBSERVED extraction context around a link. */
export type FirstStepLinkContextClass = 'ownership' | 'third_party' | 'unknown';

const THIRD_PARTY_MARKERS = /recommend|colleague|friend|advis[eo]r|supervisor|employer|mentor|导师|雇主|朋友|推荐|同事|他们|她们|团队成员|staff|粉丝|fan\b|转载|转发|interview|采访|嘉宾|guest|mentions|cited|inspired by|\bhe\b|\bshe\b|\bhis\b|\bher\b|\btheir\b|他|她/i;
const OWNERSHIP_MARKERS = /\bmy\s+(?:(?:personal|public|official|main|current|first|second|new|old|own|other|original|professional)\s+){0,3}(?:websites?|webpages?|homepages?|sites?|blogs?|channels?|newsletters?|accounts?|profiles?|github|twitter|x|youtube|linkedin|medium|substack|instagram|bluesky|mastodon|rss|notes)\b|\b(?:find|follow|contact|connect with) me\b|\b(?:accounts?|profiles?)\s*:|我的(?:个人|公开|官方|主要|新|旧)?(?:网站|主页|博客|频道|通讯|账号|账户|GitHub|Twitter|YouTube|微博|公众号|小红书)|关注我|联系我|账号[:：]|主页[:：]/i;
/** Prompt-injection / instruction-shaped text never becomes a person
 * descriptor or an action; source text is untrusted data. */
const INSTRUCTION_TEXT_MARKERS = /ignore (?:all |previous |above )*(?:instructions?|prompts?|rules?)|you are (?:now )?(?:a|an)\b|as an ai\b|system prompt|system message|<script|javascript:|忽略(?:此前|以上|先前)?(?:的)?(?:指令|指示|提示)|你现在是|系统提示|请(?:把|将).{0,24}(?:标记|确认|选择|提交)|please (?:mark|confirm|select|submit|treat)/i;

/** True when text looks like instruction-shaped content (injection guard). */
export function isUntrustedInstructionText(text: string | null): boolean {
  return typeof text === 'string' && text.trim().length >= 2 && INSTRUCTION_TEXT_MARKERS.test(text);
}

/**
 * Context classification for one observed link span. Ownership roles require
 * actually observed ownership context; ordinary prose, recommendations and
 * unknown extraction context never grant ownership. A third-party marker wins
 * over an ownership marker in the same span.
 */
export function classifyLinkContext(quote: string | null): FirstStepLinkContextClass {
  if (typeof quote !== 'string' || quote.trim().length < 2) return 'unknown';
  const readable = quote.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ');
  if (THIRD_PARTY_MARKERS.test(readable)) return 'third_party';
  if (OWNERSHIP_MARKERS.test(readable)) return 'ownership';
  return 'unknown';
}

/**
 * Role of one observed link, anchored to the observed extraction context and
 * the observed source page. `link_only`/unknown context stays a candidate;
 * ordinary mentions never become ownership even on a profile page.
 *
 * Semantic ownership guard (same rules for extracted link contexts and for
 * restricted model proposals — no model bypass):
 * - Extraction surfaces `third_party` and `unknown` never grant ownership.
 * - `native_profile_field` from a verified native account is an explicit own
 *   website.
 * - HTML relative/encoded hrefs bind through the extractor record; the href
 *   never has to be visible in the rendered quote and quotes are never
 *   synthesized. The conservative fixture fallback needs an exact-target,
 *   role-correct quote.
 * - Feed/timeline/platform content pages and other authors' first person are
 *   restricted even when the quote says "my"; on platform pages only an
 *   identified profile website/contact/self section may grant linkage.
 * - Colleague references, employers, recommendation sections and third-party
 *   prose never support the homepage owner's account.
 */
export function linkRoleFromContext(input: {
  quote: string | null;
  /** Target URL this context binds; required for the quote fallback path. */
  targetUrl?: string | null;
  /** Extraction binding/surface of the retained original, when observed. */
  binding?: 'html_anchor' | 'html_rel_me' | 'markdown_link' | 'native_profile_field' | null;
  surface?: 'authorial' | 'profile_field' | 'third_party' | 'unknown' | null;
  sourceIsOwnProfilePage: boolean;
  sourceIsDirectory: boolean;
  /** The adapter verified this native account; its website field is self-supplied. */
  sourceIsNativeAccount?: boolean;
  /** Feed/timeline/multi-author/platform content page: prose never grants ownership. */
  sourceIsRestrictedSurface?: boolean;
  /** Known social/platform page: only an identified website/contact/self section links. */
  sourceIsSocialPlatform?: boolean;
}): { role: FirstStepLinkRole; retrieval: 'read' | 'link_only' } {
  const quote = input.quote;
  if (typeof quote !== 'string' || quote.trim().length < 2) return { role: 'unknown_role', retrieval: 'link_only' };
  // Ownership of a work does not establish ownership of its hosting account.
  const target = classifyFirstStepUrl(input.targetUrl);
  if (target.ok && target.ref.entry !== 'profile') return { role: 'unknown_role', retrieval: 'link_only' };
  // The observed extraction context decides first; a claimed role or quote
  // marker can never override a third-party/unknown surface.
  if (input.surface === 'third_party') return { role: 'prose_mention', retrieval: 'read' };
  if (input.binding === 'native_profile_field' && input.surface === 'profile_field' && input.sourceIsNativeAccount === true) {
    return { role: 'self_account_section', retrieval: 'read' };
  }
  if (input.surface === 'unknown') return { role: 'unknown_role', retrieval: 'link_only' };
  // Conservative fixture fallback (no extraction context): only an exact
  // target-bound, role-correct quote is ever considered.
  if (input.surface === null || input.surface === undefined) {
    const target = (input.targetUrl ?? '').replace(/\/+$/, '');
    if (target.length === 0 || !quote.includes(target) && !quote.includes(input.targetUrl ?? '')) {
      return { role: 'unknown_role', retrieval: 'link_only' };
    }
  }
  if (input.sourceIsOwnProfilePage && !input.sourceIsRestrictedSurface &&
      (!input.sourceIsSocialPlatform || input.surface === 'profile_field') && isExplicitDenialQuote(quote, input.binding === 'html_rel_me' ? null : input.targetUrl ?? null)) {
    return { role: 'explicit_denial', retrieval: 'read' };
  }
  const context = classifyLinkContext(quote);
  if (context === 'third_party') return { role: 'prose_mention', retrieval: 'read' };
  if(input.binding==='html_rel_me'&&input.surface==='authorial'&&input.sourceIsOwnProfilePage&&!input.sourceIsRestrictedSurface&&!input.sourceIsSocialPlatform){
    return isUntrustedInstructionText(quote) ? {role:'unknown_role',retrieval:'link_only'} : {role:'self_account_section',retrieval:'read'};
  }
  if (context === 'unknown') return { role: 'unknown_role', retrieval: 'link_only' };
  // Restricted surfaces (feeds, timelines, platform content pages) never
  // grant ownership from prose, even first person.
  if (input.sourceIsRestrictedSurface === true) return { role: 'unknown_role', retrieval: 'link_only' };
  // A multi-author platform page only links through an identified profile
  // website/contact/self section — never arbitrary first-person prose.
  if (input.sourceIsSocialPlatform === true && !input.sourceIsDirectory && input.surface !== 'profile_field') {
    return { role: 'unknown_role', retrieval: 'link_only' };
  }
  if (input.sourceIsDirectory) return { role: 'explicit_directory', retrieval: 'read' };
  if (input.sourceIsOwnProfilePage) return { role: 'self_account_section', retrieval: 'read' };
  return { role: 'unknown_role', retrieval: 'link_only' };
}

export type FirstStepIdentityBasis =
  | 'explicit_self_link'
  | 'explicit_directory_link'
  | 'explicit_claim'
  | 'mutual_link'
  | 'shared_handle'
  | 'shared_avatar'
  | 'name_similarity'
  | 'search_index'
  | 'explicit_denial'
  | 'none';

export interface FirstStepIdentityAssessment {
  accountKey: string;
  state: IdentitySupportState;
  /** Strongest observed basis; the presentation label derives from it. */
  basis: FirstStepIdentityBasis;
  /** Observation ids counted as identity support (role-checked, read only). */
  supportObservationIds: string[];
  /** Observation ids counted as identity counterevidence. */
  counterevidenceObservationIds: string[];
  /** Distinct source ids among the supports; same source never counts twice. */
  independentSources: number;
  /** Weak candidate observations (handle/avatar/name/index similarity). */
  candidateObservationIds: string[];
  conflicts: string[];
}

function hasStoredQuote(observation: FirstStepLinkObservation): boolean {
  return typeof observation.quote === 'string' && observation.quote.trim().length >= 2;
}

const DENIAL_MARKERS = /不是|否认|并非|不是我|与[^。.]{0,12}无关|不相关|非本人|冒充|假账号|山寨|impersonat|\bnot me\b|\bnot my\b|\bnot affiliated\b|\bno affiliation\b|\bdenies\b|\bdispute[sd]?\b|\bfake\b|\bscam\b/i;

/**
 * An explicit denial needs actual negative association text with the target;
 * an ordinary mention can never become a denial (and a denial can never be
 * fabricated from role labels or ordinary prose).
 */
export function isExplicitDenialQuote(quote: string | null, targetUrl: string | null = null): boolean {
  if (typeof quote !== 'string' || quote.trim().length < 2) return false;
  if (targetUrl !== null && !quote.includes(targetUrl) && !quote.includes(targetUrl.replace(/\/+$/, ''))) return false;
  return DENIAL_MARKERS.test(quote);
}

function basisOf(observation: FirstStepLinkObservation): FirstStepIdentityBasis {
  // A search snippet is never an original: indexed claims AND indexed denials
  // can never be promoted to original evidence.
  if (observation.retrieval === 'indexed') return 'search_index';
  // A link without readable context stays a candidate with no basis at all.
  if (observation.retrieval === 'link_only') return 'none';
  // Denials and explicit associations need actually stored quoted text read
  // from the original page; a role label alone invents nothing, and one
  // observed direction never counts as both pages mutually linking.
  if (observation.linkRole === 'explicit_denial') {
    // The observation record binds the quote to its target; a denial still
    // needs actual negative association text.
    return hasStoredQuote(observation) && isExplicitDenialQuote(observation.quote) ? 'explicit_denial' : 'none';
  }
  switch (observation.linkRole) {
    case 'self_account_section':
      return observation.direction === 'outbound' && hasStoredQuote(observation) ? 'explicit_self_link' : 'none';
    case 'explicit_directory':
      return observation.direction === 'outbound' && hasStoredQuote(observation) ? 'explicit_directory_link' : 'none';
    case 'explicit_claim':
      return hasStoredQuote(observation) ? 'explicit_claim' : 'none';
    default:
      return 'none';
  }
}

const SUPPORTING_BASES: ReadonlySet<FirstStepIdentityBasis> = new Set([
  'explicit_self_link',
  'explicit_directory_link',
  'explicit_claim'
]);

/**
 * Identity-link assessment for one account. Only explicit, role-correct
 * associations actually read from a source support identity; shared handle,
 * avatar or name similarity and search-index snippets stay candidates.
 */
export function assessIdentityLink(
  accountKey: string,
  observations: readonly FirstStepLinkObservation[]
): FirstStepIdentityAssessment {
  const relevant = observations.filter((o) => o.targetAccountKey === accountKey);
  const support: string[] = [];
  const counterevidence: string[] = [];
  const candidates: string[] = [];
  const conflicts: string[] = [];
  // Independence groups by the SOURCE ACCOUNT/owner of the observed page (a
  // third-party page without an owning account groups by its source id): two
  // pages of one source account are one basis, never two independent sources.
  const supportSources = new Set<string>();
  const groupOf = (o: FirstStepLinkObservation): string =>
    o.fromAccountKey !== null ? `account:${o.fromAccountKey}` : `source:${o.sourceId}`;
  let strongest: FirstStepIdentityBasis = 'none';
  for (const observation of relevant) {
    const basis = basisOf(observation);
    if (basis === 'explicit_denial') {
      counterevidence.push(observation.observationId);
      continue;
    }
    if (SUPPORTING_BASES.has(basis)) {
      supportSources.add(groupOf(observation));
      support.push(observation.observationId);
      if (!SUPPORTING_BASES.has(strongest) || strongest === 'mutual_link') strongest = basis;
      continue;
    }
    candidates.push(observation.observationId);
    if (strongest === 'none') strongest = basis;
    if (basis === 'shared_handle' || basis === 'shared_avatar' || basis === 'name_similarity') {
      conflicts.push(`观察 ${observation.observationId} 只有相似线索（${basis}），不能作为身份依据。`);
    }
  }
  let state: IdentitySupportState = 'proposed';
  if (counterevidence.length > 0 && support.length > 0) state = 'disputed';
  else if (counterevidence.length > 0) state = 'rejected';
  else if (support.length > 0 && supportSources.size >= 1) state = 'supported';
  return {
    accountKey,
    state,
    basis: strongest,
    supportObservationIds: support,
    counterevidenceObservationIds: counterevidence,
    independentSources: supportSources.size,
    candidateObservationIds: candidates,
    conflicts
  };
}

export const FIRST_STEP_BASIS_LABELS: Record<FirstStepIdentityBasis, string> = {
  explicit_self_link: '本人公开页面明确链接',
  explicit_directory_link: '公开链接目录明确列出',
  explicit_claim: '原文明确声明关联',
  mutual_link: '双方页面互链',
  shared_handle: '仅有相同 handle 线索',
  shared_avatar: '仅有相同头像线索',
  name_similarity: '仅有名字相似线索',
  search_index: '仅搜索索引可见',
  explicit_denial: '原文明确否认关联',
  none: '没有可核对的归属依据'
};

/* ------------------------------------------------------------------ */
/* Default suggestions                                                 */
/* ------------------------------------------------------------------ */

export interface FirstStepSuggestionPolicy {
  /** Organizations/fan pages never get a default person suggestion. */
  allowAccountKinds: ReadonlyArray<FirstStepAccountKind>;
  policyVersion: string;
}

export const FIRST_STEP_SUGGESTION_POLICY: FirstStepSuggestionPolicy = {
  allowAccountKinds: ['person', 'publication', 'channel'],
  policyVersion: FIRST_STEP_POLICY_VERSION
};

export interface FirstStepSuggestion {
  suggested: boolean;
  reason: string;
}

/**
 * Default checkbox suggestion. Only a supported account with actual source
 * receipts, no conflict and an allowed account kind may be pre-checked. The
 * user's persisted selection stays `unanswered` until they submit.
 */
export function firstStepDefaultSuggestion(
  assessment: FirstStepIdentityAssessment,
  accountKind: FirstStepAccountKind,
  access: { readable: boolean; note: string | null },
  policy: FirstStepSuggestionPolicy = FIRST_STEP_SUGGESTION_POLICY
): FirstStepSuggestion {
  if (assessment.state === 'disputed' || assessment.state === 'rejected' || assessment.state === 'revoked') {
    return { suggested: false, reason: '存在冲突或否认依据，不形成勾选建议。' };
  }
  if (assessment.state !== 'supported') {
    return { suggested: false, reason: '归属线索不足，默认不勾选。' };
  }
  if (assessment.supportObservationIds.length === 0) {
    return { suggested: false, reason: '支持状态缺少实际来源依据，默认不勾选。' };
  }
  if (!policy.allowAccountKinds.includes(accountKind)) {
    return { suggested: false, reason: accountKind === 'unknown' ? '账号类型尚未确认，请按原文依据自行选择。' : '组织/第三方账号不作为本人研究的默认勾选。' };
  }
  // Access limits are shown honestly and never prove or disprove identity.
  return {
    suggested: true,
    reason: access.readable
      ? '归属依据完整且无冲突，建议纳入研究范围。'
      : `归属依据完整且无冲突；访问受限（${access.note ?? '受限'}）不影响归属判断。`
  };
}

/* ------------------------------------------------------------------ */
/* Evidence projection                                                 */
/* ------------------------------------------------------------------ */

export interface FirstStepEvidenceView {
  evidenceId: string;
  /** Real case source id + revision; never invented by the projection. */
  sourceId: string;
  sourceRevision: number;
  /** Authoritative source-revision metadata for inspection. */
  sourceUrl: string;
  sourceTitle: string;
  sourceLocator: string | null;
  sourceRetrievedAt: string;
  role: 'identity_support' | 'identity_counterevidence';
  /** Precise short supporting span exactly as stored. */
  quote: string | null;
  locator: string | null;
  retrieval: FirstStepRetrieval;
  /** Short human label of what this evidence shows. */
  label: string;
  /** Honest limitation of this evidence; never omitted. */
  limitation: string;
  observedAt: string;
}

export type FirstStepAccessLabel = '原文可读' | '仅索引可见' | '仅见链接' | '读取受限' | '尚未检查';

export interface FirstStepAccountView {
  accountId: string;
  caseId: string;
  accountKey: string;
  platform: string;
  platformLabel: string;
  displayName: string | null;
  handle: string | null;
  instance: string | null;
  profileUrl: string | null;
  category: FirstStepAccountCategory;
  materialUse: FirstStepMaterialUse;
  accountKind: FirstStepAccountKind;
  identity: {
    state: IdentitySupportState;
    /** Contradictory actual native IDs: independent scope only, including anchors. */
    nativeIdConflict?: boolean;
    /** Current dependency validity, separate from the immutable stored facet. */
    validity?: 'valid' | 'review';
    reviewReason?: string | null;
    basis: FirstStepIdentityBasis;
    basisLabel: string;
    evidence: FirstStepEvidenceView[];
    counterevidence: FirstStepEvidenceView[];
    conflicts: string[];
  };
  /** Persisted facets, verbatim. A suggestion never lands here. */
  userSelection: UserSelection;
  allowedScope: AllowedScope;
  researchValue: ResearchValue;
  accessCoverage: AccessCoverage;
  /** What researching this account can reveal (a value claim, not a fact). */
  researchSummary: string;
  accessLabel: FirstStepAccessLabel;
  defaultSuggestion: FirstStepSuggestion;
  /** True for accounts kept out of same-person conclusions. */
  requiresIndependentScope: boolean;
}

export interface FirstStepPersonAtomView {
  atomId: string;
  /** Concise grounded descriptor text; never a raw URL dump. */
  statement: string;
  /** Exact source span backing this descriptor; inspectable, never executed. */
  quote?: string | null;
  /** Real source URL of the quote; kept out of the statement text. */
  sourceUrl?: string | null;
  /** Evidence ids with role identity_support or factual provenance slots. */
  evidenceIds: string[];
}

export interface FirstStepPersonClusterView {
  clusterId: string;
  displayName: string;
  anchorUrl: string | null;
  anchorLabel: string;
  /** The cluster's own anchor account id (inspectable), never a global set. */
  anchorAccountId?: string | null;
  /**
   * `linked` = at least one valid original linkage connects this cluster;
   * `unconfirmed` = a single unlinked lead (e.g. a same-name hit) that never
   * masquerades as a confident person. Same-name candidates stay distinct.
   */
  linkage?: 'linked' | 'unconfirmed';
  /** Inspectable linkage basis of the anchor (real span + source), or null. */
  anchorBasis?: { label: string; quote: string | null; sourceUrl: string | null } | null;
  leads: FirstStepPersonAtomView[];
  conflicts: string[];
  accountIds: string[];
}

/**
 * A real observed tool result link / material receipt that is NOT a person
 * account entry (platform navigation/login/search/watch/playlist roots,
 * unattributed third-party articles). Kept available as a related lead; it
 * never becomes a selectable person account card.
 */
export interface FirstStepRelatedLeadView {
  url: string;
  title: string | null;
  reason: 'navigation' | 'content_page';
  note: string;
  observedAt: string;
}

export type FirstStepRouteState =
  | 'planned'
  | 'running'
  | 'found'
  | 'not_found'
  | 'no_clue'
  | 'unsupported'
  | 'no_adapter'
  | 'access_limited'
  | 'rate_limited'
  | 'timeout'
  | 'deferred'
  | 'skipped_budget'
  | 'unknown';

export interface FirstStepRouteStatusView {
  routeId: string;
  platform: string;
  platformLabel: string;
  materialUse: FirstStepMaterialUse;
  state: FirstStepRouteState;
  note: string | null;
  /** Real request receipt keys for this route; empty = nothing was requested. */
  receiptKeys: string[];
}

export interface FirstStepReceiptView {
  requestKey: string;
  kind: 'search' | 'profile_read' | 'model';
  state: 'inflight' | 'completed' | 'failed';
  /** indexed = search result; read = fetched original; link_only = link seen. */
  retrieval: FirstStepRetrieval;
  target: string;
  observedAt: string;
  estimatedUsd: number | null;
  unknownCost: boolean;
}

export type FirstStepPhase =
  | 'freezing'
  | 'finding_home'
  | 'expanding_accounts'
  | 'verifying_attribution'
  | 'ready_for_choice'
  | 'awaiting_selection'
  | 'fetching'
  | 'done'
  | 'blocked'
  | 'cancelled';

export interface FirstStepSelectionStateView {
  /**
   * Authoritative CURRENT CaseStore scope version. Before submission this is
   * the live version the selection must echo; it is never a hidden zero.
   */
  scopeVersion: number;
  /** Frozen scope version of a submitted selection; null before submission. */
  frozenScopeVersion: number | null;
  submitted: boolean;
  submittedAt: string | null;
  selectedAccountIds: string[];
  excludedAccountIds: string[];
}

export interface FirstStepDiscoveryView {
  schemaVersion: typeof FIRST_STEP_SCHEMA_VERSION;
  runId: string;
  caseId: string;
  discoveryRevision: number;
  inputRevision: number;
  registryVersion: string;
  /** Bound catalog content hash; null when no catalog snapshot was bound. */
  catalogHash: string | null;
  policyVersion: string;
  phase: FirstStepPhase;
  stopReason: string | null;
  readyForChoice: boolean;
  input: FirstStepInput;
  clusters: FirstStepPersonClusterView[];
  accounts: FirstStepAccountView[];
  /** Non-account tool result links kept available; never selectable accounts. */
  relatedLeads: FirstStepRelatedLeadView[];
  routes: FirstStepRouteStatusView[];
  gaps: string[];
  receipts: FirstStepReceiptView[];
  budget: {
    toolCalls: number;
    modelCalls: number;
    estimatedUsd: number;
    unknownCost: boolean;
  };
  selection: FirstStepSelectionStateView;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Frozen initial obligations                                          */
/* ------------------------------------------------------------------ */

export interface FirstStepRouteObligation {
  routeId: string;
  platform: string;
  platformLabel: string;
  materialUse: FirstStepMaterialUse;
  /** `initial_wave` is frozen before any IO; later routes need a real clue. */
  trigger: 'initial_wave' | 'anchor_expansion' | 'manual_hint';
  requires: 'search' | 'profile_read';
  /** `catalog` obligations come from the bound platform catalog snapshot. */
  source: 'generic' | 'catalog';
  /** Honest initial status before any observation: never fake success. */
  initialState: FirstStepRouteState;
  note: string;
}

export interface FirstStepBudgetPolicy {
  maxSearchQueries: number;
  maxSearchResults: number;
  maxProfileReads: number;
  maxModelCalls: number;
  policyVersion: string;
}

export const FIRST_STEP_DEFAULT_BUDGET: FirstStepBudgetPolicy = {
  maxSearchQueries: 11,
  maxSearchResults: 12,
  maxProfileReads: 16,
  maxModelCalls: 2,
  policyVersion: FIRST_STEP_POLICY_VERSION
};

/**
 * Frozen SEARCH query contract: every planned query fits this bound because
 * the checked Search surface refuses longer queries as an input decision
 * error. The seed URL itself is never cut — it is read exactly as supplied;
 * only its derived discovery query is bounded.
 */
export const FIRST_STEP_SEARCH_QUERY_MAX = 600;

/**
 * Explicit bounded SEARCH query for a validated public URL input. The URL is
 * read, classified and displayed exactly as supplied; only the discovery
 * query is derived from its hostname plus the real bounded path/query text.
 * Never a guessed handle or alias: the query contains only actual URL text
 * taken from the input (hostname + a real path prefix).
 */
export function firstStepUrlSearchQuery(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  const host = parsed?.hostname ?? '';
  if (host.length === 0) return trimmed.slice(0, FIRST_STEP_SEARCH_QUERY_MAX);
  const path = parsed!.pathname === '/' ? '' : parsed!.pathname;
  const search = parsed!.search && parsed!.search !== '?' ? parsed!.search : '';
  let tail = `${path}${search}`;
  const bound = Math.max(0, FIRST_STEP_SEARCH_QUERY_MAX - host.length);
  if (tail.length > bound) {
    const cut = tail.slice(0, bound);
    // Keep whole path segments when one fits; otherwise a real input prefix.
    const lastSlash = cut.lastIndexOf('/');
    tail = lastSlash > 0 ? cut.slice(0, lastSlash) : cut;
  }
  return `${host}${tail}`.slice(0, FIRST_STEP_SEARCH_QUERY_MAX);
}

/** Deliberate query families covering home/work/writing/social/academic/video. */
export const FIRST_STEP_QUERY_FAMILIES: ReadonlyArray<{ family: string; build: (value: string) => string; includeDomains?: readonly string[]; provider?: 'bluesky' }> = [
  { family: 'home', build: (value) => `${value}` },
  { family: 'work', build: (value) => `${value} works projects` },
  { family: 'writing', build: (value) => `${value} blog newsletter` },
  { family: 'social', build: (value) => `${value} Twitter X profile`, includeDomains: ['x.com', 'twitter.com'] },
  { family: 'visual_social', build: (value) => `${value} Instagram Threads profile`, includeDomains: ['instagram.com', 'threads.net', 'threads.com'] },
  { family: 'federated_social', build: (value) => `${value} Bluesky Mastodon profile`, includeDomains: ['bsky.app', 'mastodon.social'] },
  { family: 'academic', build: (value) => `${value} scholar publications` },
  { family: 'video', build: (value) => `${value} video channel` },
  { family: 'native_bluesky', build: (value) => value, provider: 'bluesky' }
];

/**
 * Frozen query plan: deliberate coverage per family first, then ACTUAL
 * observed alias/coverage expansion with the reserved remaining budget (the
 * default reserves its last two queries for this). No guessed
 * usernames, no fabricated aliases, no human-gold seeding.
 */
export function firstStepQueryPlan(
  input: FirstStepInput,
  budget: FirstStepBudgetPolicy,
  observedAliases: readonly string[] = []
): Array<{ query: string; family: string; includeDomains?: readonly string[]; provider?: 'bluesky' }> {
  const value = input.value.trim();
  if (value.length === 0) return [];
  const plan: Array<{ query: string; family: string; includeDomains?: readonly string[]; provider?: 'bluesky' }> = [];
  const max = budget.maxSearchQueries > 0 ? budget.maxSearchQueries : 0;
  if (max === 0) return plan;
  const families = input.kind === 'name_query' ? FIRST_STEP_QUERY_FAMILIES : FIRST_STEP_QUERY_FAMILIES.slice(0, 1);
  const suppliedNames = input.kind === 'name_query' ? value.split(/\s*[\/／]\s*/).map(name => name.trim()).filter(Boolean) : [value];
  const firstName=suppliedNames[0]??value;
  // A homepage URL is READ exactly as supplied; only its SEARCH query is the
  // explicit bounded hostname + real path form — never the raw up-to-2048-char
  // URL and never a manufactured handle. Names keep the actual input text.
  const seedValue = input.kind === 'homepage_url' ? firstStepUrlSearchQuery(value) : firstName;
  // A mixed-script input already contains this name; use its complete Latin
  // spelling for domain-constrained retrieval, without inventing an alias.
  const latinName=/[\u3400-\u9fff]/u.test(firstName)?firstName.match(/[A-Za-z][A-Za-z .’'\-]*[A-Za-z]/u)?.[0]?.trim():undefined;

  for (const entry of families) {
    if (plan.length >= max) break;
    const query = entry.build(input.kind === 'homepage_url' ? seedValue : ((entry.includeDomains || entry.provider) && latinName ? latinName : firstName));
    // Every planned query must satisfy the frozen SEARCH contract; validated
    // name inputs are structurally bounded, this guard keeps the plan honest
    // for any caller (an over-long query would only become an input error).
    if (query.length > FIRST_STEP_SEARCH_QUERY_MAX) continue;
    if (!plan.some((item) => item.query === query && JSON.stringify(item.includeDomains) === JSON.stringify(entry.includeDomains) && item.provider === entry.provider)) plan.push({ query, family: entry.family, ...(entry.includeDomains ? { includeDomains: entry.includeDomains } : {}),...(entry.provider?{provider:entry.provider}:{}) });
  }
  let aliasSlots = 0;
  const providedAliases = input.kind === 'name_query' ? value.split(/\s*[\/／]\s*/).slice(1) : [];
  for (const alias of [...providedAliases, ...observedAliases]) {
    if (plan.length >= max || aliasSlots >= 2) break;
    const trimmed = alias.trim();
    if (trimmed.length < 2 || trimmed.length > 120) continue;
    const query = `${trimmed} public profile`;
    if (query.length > FIRST_STEP_SEARCH_QUERY_MAX) continue;
    if (!plan.some((item) => item.query === query && item.includeDomains === undefined)) {
      plan.push({ query, family: 'alias' });
      aliasSlots++;
    }
  }
  return plan;
}

export interface FirstStepFrozenPlan {
  frozenAt: string;
  input: FirstStepInput;
  registryVersion: string;
  /** `sha256:<hex>` of the bound catalog content; null when no catalog. */
  contentHash: string | null;
  policyVersion: string;
  budget: FirstStepBudgetPolicy;
  obligations: FirstStepRouteObligation[];
}

/**
 * Freeze the initial obligation set before any IO. The initial wave covers the
 * anchor, technical-work and expression/writing routes that already have
 * tooling; academic/video routes are declared and stay explicitly deferred
 * until a real clue or adapter exists — never silently completed. Nothing here
 * enumerates the whole platform catalog.
 */
export function freezeFirstStepObligations(
  input: FirstStepInput,
  options: {
    registryVersion: string;
    contentHash?: string | null;
    budget?: FirstStepBudgetPolicy;
    now?: string;
    extraRoutes?: FirstStepRouteObligation[];
  }
): FirstStepFrozenPlan {
  const budget = options.budget ?? FIRST_STEP_DEFAULT_BUDGET;
  const obligations: FirstStepRouteObligation[] = [
    {
      routeId: 'web-search',
      platform: 'web_search',
      platformLabel: '公开网页检索',
      materialUse: 'identity_anchor',
      trigger: 'initial_wave',
      requires: 'search',
      source: 'generic',
      initialState: 'planned',
      note: '按姓名或实际观察别名做普通网页检索；不从姓名拼用户名。'
    },
    {
      routeId: 'anchor-home',
      platform: 'personal_site',
      platformLabel: '个人站 / 机构资料',
      materialUse: 'identity_anchor',
      trigger: 'initial_wave',
      requires: 'profile_read',
      source: 'generic',
      initialState: 'planned',
      note: '读取公开身份所需的最小原文与实际外链。'
    },
    {
      routeId: 'work-github',
      platform: 'github',
      platformLabel: 'GitHub / 技术作品',
      materialUse: 'technical_work',
      trigger: 'initial_wave',
      requires: 'search',
      source: 'generic',
      initialState: 'planned',
      note: '从主页或已观察账号线索扩展；仓库与组织不自动成为本人账号。'
    },
    {
      routeId: 'expression',
      platform: 'x',
      platformLabel: '公开表达',
      materialUse: 'expression',
      trigger: 'initial_wave',
      requires: 'search',
      source: 'generic',
      initialState: 'planned',
      note: '仅同 handle/头像只产生候选；受限照实显示。'
    },
    {
      routeId: 'writing',
      platform: 'substack',
      platformLabel: '文章与通讯',
      materialUse: 'writing',
      trigger: 'initial_wave',
      requires: 'search',
      source: 'generic',
      initialState: 'planned',
      note: '账号、出版物与文章分开；同一平台多个账号都保留。'
    },
    {
      routeId: 'academic',
      platform: 'google_scholar',
      platformLabel: '学术记录',
      materialUse: 'academic',
      trigger: 'initial_wave',
      requires: 'search',
      source: 'generic',
      initialState: 'deferred',
      note: '需要平台专属规则；无论文端点验收前按受支持范围如实受限。'
    },
    {
      routeId: 'video-audio',
      platform: 'youtube',
      platformLabel: '视频与音频',
      materialUse: 'video_audio',
      trigger: 'initial_wave',
      requires: 'search',
      source: 'generic',
      initialState: 'planned',
      note: '区分本人频道、访谈嘉宾、转载与粉丝频道。'
    },
    ...(options.extraRoutes ?? [])
  ];
  return {
    frozenAt: options.now ?? new Date().toISOString(),
    input,
    registryVersion: options.registryVersion,
    contentHash: options.contentHash ?? null,
    policyVersion: FIRST_STEP_POLICY_VERSION,
    budget,
    obligations
  };
}

/* ------------------------------------------------------------------ */
/* Selection input                                                     */
/* ------------------------------------------------------------------ */

export type FirstStepAccountDecisionSelection = 'selected' | 'not_selected' | 'only_this_account' | 'unanswered';

export interface FirstStepAccountDecision {
  accountId: string;
  /** Intent only; never evidence and never an identity upgrade. */
  selection: FirstStepAccountDecisionSelection;
  /** Explicit user statement "不是此人"; distinct from an unchecked box. */
  excluded: boolean;
  note?: string | null;
}

export interface FirstStepSelectionInput {
  expectedRunRevision: number;
  expectedScopeVersion: number;
  discoveryRevision: number;
  /** Selected person cluster; null = "都不是 / 独立账号范围". */
  clusterId: string | null;
  accounts: FirstStepAccountDecision[];
}

export type FirstStepSelectionValidation =
  | { ok: true; input: FirstStepSelectionInput }
  | { ok: false; error: string };

function readInt(raw: unknown, field: string): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return null;
  void field;
  return raw;
}

/**
 * Strict validation of one batch selection request. Every account must appear
 * exactly once; mixed "exclude + select" decisions are rejected so a batch can
 * never half-mean two things.
 */
export function validateFirstStepSelectionInput(raw: unknown): FirstStepSelectionValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '选择内容必须是对象。' };
  }
  const body = raw as Record<string, unknown>;
  const expectedRunRevision = readInt(body.expectedRunRevision, 'expectedRunRevision');
  const expectedScopeVersion = readInt(body.expectedScopeVersion, 'expectedScopeVersion');
  const discoveryRevision = readInt(body.discoveryRevision, 'discoveryRevision');
  if (expectedRunRevision === null || expectedScopeVersion === null || discoveryRevision === null) {
    return { ok: false, error: '缺少合法的版本字段。' };
  }
  if (body.clusterId !== null && typeof body.clusterId !== 'string') {
    return { ok: false, error: '人物选择无效。' };
  }
  // Malformed oversized identity is REJECTED, never silently truncated into a
  // different cluster id.
  if (typeof body.clusterId === 'string' && body.clusterId.length > 120) {
    return { ok: false, error: '人物簇 id 过长或格式无效。' };
  }
  const clusterId = typeof body.clusterId === 'string' ? body.clusterId : null;
  if (!Array.isArray(body.accounts)) return { ok: false, error: '缺少账号选择列表。' };
  const seen = new Set<string>();
  const accounts: FirstStepAccountDecision[] = [];
  for (const item of body.accounts) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: '账号选择项无效。' };
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.accountId !== 'string' || entry.accountId.length === 0 || entry.accountId.length > 120) {
      return { ok: false, error: '账号 id 无效。' };
    }
    if (seen.has(entry.accountId)) return { ok: false, error: '同一账号不能出现两次。' };
    seen.add(entry.accountId);
    const selection = entry.selection;
    if (
      selection !== 'selected' &&
      selection !== 'not_selected' &&
      selection !== 'only_this_account' &&
      selection !== 'unanswered'
    ) {
      return { ok: false, error: '账号选择状态无效。' };
    }
    if (entry.excluded !== undefined && typeof entry.excluded !== 'boolean') {
      return { ok: false, error: '排除声明无效。' };
    }
    const excluded = entry.excluded === true;
    if (excluded && selection === 'selected') {
      return { ok: false, error: '排除声明与选择互相冲突。' };
    }
    const note = typeof entry.note === 'string' ? entry.note.slice(0, 500) : null;
    accounts.push({ accountId: entry.accountId, selection, excluded, note });
  }
  return {
    ok: true,
    input: { expectedRunRevision, expectedScopeVersion, discoveryRevision, clusterId, accounts }
  };
}

/**
 * Per-account scope rule for one decision. Uncertain or disputed accounts can
 * only be researched under an explicit independent scope (`only_this_account`)
 * and never join same-person conclusions. The chosen cluster's anchor account
 * is the person home the user just confirmed, so it may join the person scope
 * as user intent (identity evidence is still never upgraded). A user selection
 * never touches identity support.
 */
export function validateSelectionDecision(
  account: Pick<FirstStepAccountView, 'accountId' | 'identity'>,
  decision: FirstStepAccountDecision,
  options?: { anchorAccountIds?: ReadonlySet<string> }
): { ok: true; allowedScope: AllowedScope['state'] } | { ok: false; error: string } {
  const state = account.identity.state;
  if (decision.excluded && decision.selection === 'selected') {
    return { ok: false, error: '排除声明与选择互相冲突。' };
  }
  if (decision.selection === 'unanswered' || decision.selection === 'not_selected') {
    return { ok: true, allowedScope: 'none' };
  }
  if (state === 'rejected' || state === 'revoked') {
    return { ok: false, error: '该账号的归属依据已被否定，不能加入研究范围。' };
  }
  if (decision.selection === 'only_this_account') {
    // Independent account scope: researched alone, never merged into the
    // person conclusions with the other selected accounts.
    return { ok: true, allowedScope: 'public_history' };
  }
  if (account.identity.nativeIdConflict === true) {
    return {ok:false,error:'实际原生 ID 冲突，只能作为独立账号研究，不能并入人物结论。'};
  }
  if (account.identity.validity === 'review') {
    return { ok: false, error: '该账号的归属依据已失效，只能作为独立账号研究，不能并入人物结论。' };
  }
  if (state === 'supported' || state === 'proposed' && options?.anchorAccountIds?.has(account.accountId) === true) {
    return { ok: true, allowedScope: 'public_history' };
  }
  return {
    ok: false,
    error: '归属未定的账号只能以独立账号范围（only_this_account）研究，不能并入同一人物结论。'
  };
}

/**
 * Full-state decision batch: every account of the CURRENT discovery revision
 * must appear exactly once. Omitted accounts can never silently preserve stale
 * selections or exclusions.
 */
export function validateDecisionCompleteness(
  accounts: ReadonlyArray<Pick<FirstStepAccountView, 'accountId'>>,
  decisions: readonly FirstStepAccountDecision[]
): { ok: true } | { ok: false; error: string } {
  const expected = new Set(accounts.map((account) => account.accountId));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (!expected.has(decision.accountId)) {
      return { ok: false, error: `账号 ${decision.accountId} 不属于当前发现结果。` };
    }
    if (seen.has(decision.accountId)) {
      return { ok: false, error: `账号 ${decision.accountId} 重复出现。` };
    }
    seen.add(decision.accountId);
  }
  for (const accountId of expected) {
    if (!seen.has(accountId)) {
      return { ok: false, error: `账号 ${accountId} 缺少明确决定；所有当前账号必须逐个表态。` };
    }
  }
  return { ok: true };
}

export interface FirstStepClusterChoiceResult {
  ok: boolean;
  error?: string;
  cluster: FirstStepPersonClusterView | null;
  /** Same-person (cluster-joined) selections. */
  joinedAccountIds: string[];
  /** Explicit independent-account scopes, kept isolated from person claims. */
  independentAccountIds: string[];
}

/**
 * Bind the person cluster: a nonexistent cluster is rejected, `selected`
 * accounts must all belong to the chosen cluster (no same-name cross-cluster
 * merge), and with `clusterId: null` only explicit independent-account scopes
 * are allowed. Independent accounts are returned separately so they stay
 * isolated evidence through Fetch and reporting and are never labeled as the
 * same person.
 */
export function validateClusterChoice(
  clusters: readonly FirstStepPersonClusterView[],
  accounts: ReadonlyArray<Pick<FirstStepAccountView, 'accountId'>>,
  decisions: readonly FirstStepAccountDecision[],
  clusterId: string | null
): FirstStepClusterChoiceResult {
  const accountIds = new Set(accounts.map((account) => account.accountId));
  const joined = decisions.filter((decision) => decision.selection === 'selected');
  const independent = decisions.filter((decision) => decision.selection === 'only_this_account');
  for (const decision of [...joined, ...independent]) {
    if (!accountIds.has(decision.accountId)) {
      return { ok: false, error: `账号 ${decision.accountId} 不在当前候选内。`, cluster: null, joinedAccountIds: [], independentAccountIds: [] };
    }
  }
  if (clusterId === null) {
    if (joined.length > 0) {
      return {
        ok: false,
        error: '没有选择人物簇时只能使用独立账号范围（only_this_account），不能并入同一人物结论。',
        cluster: null,
        joinedAccountIds: [],
        independentAccountIds: []
      };
    }
    return { ok: true, cluster: null, joinedAccountIds: [], independentAccountIds: independent.map((d) => d.accountId) };
  }
  const cluster = clusters.find((candidate) => candidate.clusterId === clusterId) ?? null;
  if (!cluster) {
    return { ok: false, error: `人物簇 ${clusterId} 不存在，请刷新后重新选择。`, cluster: null, joinedAccountIds: [], independentAccountIds: [] };
  }
  const members = new Set(cluster.accountIds);
  for (const decision of joined) {
    if (!members.has(decision.accountId)) {
      return {
        ok: false,
        error: `账号 ${decision.accountId} 不属于所选人物簇；不同簇的账号不能因同名合并。`,
        cluster,
        joinedAccountIds: [],
        independentAccountIds: []
      };
    }
  }
  return {
    ok: true,
    cluster,
    joinedAccountIds: joined.map((d) => d.accountId),
    independentAccountIds: independent.map((d) => d.accountId)
  };
}
