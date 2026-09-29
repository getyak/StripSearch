/**
 * Built-in platform registry for discovery and post tracking.
 *
 * Honesty contract for every rule in this file:
 *
 * - `verification` describes the RULE, not the result. `live_verified` is only
 *   used for the GitHub users endpoint, whose semantics this repository has
 *   already exercised through the verified GitHub research adapter. Every
 *   other rule is `live_unverified`: written from public API documentation and
 *   NOT yet checked against the live platform by this project. The probe
 *   engine degrades any mismatch to `unknown`, never to `found`.
 * - Rules are facts about public endpoints (URL templates, status semantics).
 *   No third-party page text is copied into this repository.
 * - Platforms whose unauthenticated probing is unreliable behind login walls
 *   (X, Instagram, TikTok, ...) ship with `probe: null`: they are reachable
 *   only through imported external tool reports (maigret / holehe), whose
 *   results keep their own receipts and `live_unverified` labels.
 * - Adding or changing a rule bumps `version`; tasks remember the registry
 *   version they ran against so results stay reproducible.
 */

import type { PlatformRegistry, PlatformRule } from '../../shared/platform-discovery.js';

export const PLATFORM_REGISTRY_VERSION = '2026-09-27.1';
export const PLATFORM_REGISTRY_GENERATED_AT = '2026-09-27';

const JSON_LIST_PAGE_FIELDS = {
  id: null,
  url: null,
  title: null,
  publishedAt: null,
  excerpt: null
} as const;

const RULES: PlatformRule[] = [
  {
    platformId: 'github',
    name: 'GitHub',
    category: 'code',
    subjectKinds: ['username'],
    homepage: 'https://github.com',
    probe: {
      kind: 'http_status',
      transport: 'api_http',
      method: 'GET',
      urlTemplate: 'https://api.github.com/users/{username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [401, 403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 20,
    verification: 'live_verified',
    verificationNote:
      '端点语义（200 存在 / 404 不存在）已在既有 GitHub 研究 adapter 的真实请求中验收；探测引擎路径本身仅离线验证。',
    notes: ['仓库/作品研究仍走 GitHub 研究 adapter；此处只回答账号是否存在。']
  },
  {
    platformId: 'devto',
    name: 'DEV Community',
    category: 'writing',
    subjectKinds: ['username'],
    homepage: 'https://dev.to',
    probe: {
      kind: 'http_status',
      transport: 'api_http',
      method: 'GET',
      urlTemplate: 'https://dev.to/api/users/by_username?url={username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: {
      kind: 'json_list',
      urlTemplate: 'https://dev.to/api/articles?username={username}&page={page}',
      maxPages: 3,
      itemsPath: '',
      fields: { id: 'id', url: 'url', title: 'title', publishedAt: 'published_at', excerpt: 'description' }
    },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '按 DEV 公开 API 文档编写；未做 live 验证，命中语义待实测。',
    notes: ['公开 API，无需密钥。']
  },
  {
    platformId: 'hackernews',
    name: 'Hacker News',
    category: 'social',
    subjectKinds: ['username'],
    homepage: 'https://news.ycombinator.com',
    probe: {
      kind: 'http_marker',
      transport: 'profile_http',
      method: 'GET',
      urlTemplate: 'https://news.ycombinator.com/user?id={username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: 'submissions',
      notFoundMarker: 'No such user'
    },
    posts: {
      kind: 'json_list',
      urlTemplate: 'https://hn.algolia.com/api/v1/search_by_date?tags=author_{username}&hitsPerPage=20&page={page}',
      maxPages: 2,
      itemsPath: 'hits',
      fields: {
        id: 'objectID',
        url: 'url',
        title: 'title',
        publishedAt: 'created_at',
        excerpt: 'story_text'
      }
    },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '页面标记字符串按公开页面预期编写；标记不匹配一律降级为 unknown。',
    notes: ['帖子追踪走 Algolia 公开搜索 API。']
  },
  {
    platformId: 'medium',
    name: 'Medium',
    category: 'writing',
    subjectKinds: ['username'],
    homepage: 'https://medium.com',
    probe: {
      kind: 'http_status',
      transport: 'profile_http',
      method: 'GET',
      urlTemplate: 'https://medium.com/@{username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: {
      kind: 'rss',
      urlTemplate: 'https://medium.com/feed/@{username}',
      maxPages: 1,
      itemsPath: '',
      fields: { id: 'guid', url: 'link', title: 'title', publishedAt: 'pubDate', excerpt: 'description' }
    },
    rateLimitPerMinute: 6,
    verification: 'live_unverified',
    verificationNote: '主页与 RSS 端点按公开约定编写；未做 live 验证。',
    notes: ['RSS 是唯一读取路径；不抓取正文全文。']
  },
  {
    platformId: 'reddit',
    name: 'Reddit',
    category: 'social',
    subjectKinds: ['username'],
    homepage: 'https://www.reddit.com',
    probe: {
      kind: 'http_status',
      transport: 'api_http',
      method: 'GET',
      urlTemplate: 'https://www.reddit.com/user/{username}/about.json',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [401, 403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: {
      kind: 'json_list',
      urlTemplate: 'https://www.reddit.com/user/{username}/submitted.json?limit=25',
      maxPages: 1,
      itemsPath: 'data.children',
      fields: {
        id: 'data.id',
        url: 'data.url',
        title: 'data.title',
        publishedAt: 'data.created_utc',
        excerpt: 'data.selftext'
      }
    },
    rateLimitPerMinute: 4,
    verification: 'live_unverified',
    verificationNote: '未登录请求经常被 403/429 拦截；预期大量 blocked，不做存在性断言。',
    notes: ['被拦截即如实记录 blocked，不改判为 not_found。']
  },
  {
    platformId: 'npm',
    name: 'npm',
    category: 'code',
    subjectKinds: ['username'],
    homepage: 'https://www.npmjs.com',
    probe: {
      kind: 'http_status',
      transport: 'profile_http',
      method: 'GET',
      urlTemplate: 'https://www.npmjs.com/~{username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '按公开站点约定编写；未做 live 验证。',
    notes: []
  },
  {
    platformId: 'pypi',
    name: 'PyPI',
    category: 'code',
    subjectKinds: ['username'],
    homepage: 'https://pypi.org',
    probe: {
      kind: 'http_status',
      transport: 'profile_http',
      method: 'GET',
      urlTemplate: 'https://pypi.org/user/{username}/',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '按公开站点约定编写；未做 live 验证。',
    notes: []
  },
  {
    platformId: 'huggingface',
    name: 'Hugging Face',
    category: 'code',
    subjectKinds: ['username'],
    homepage: 'https://huggingface.co',
    probe: {
      kind: 'http_status',
      transport: 'profile_http',
      method: 'GET',
      urlTemplate: 'https://huggingface.co/{username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '按公开站点约定编写；未做 live 验证。',
    notes: []
  },
  {
    platformId: 'gitlab',
    name: 'GitLab',
    category: 'code',
    subjectKinds: ['username'],
    homepage: 'https://gitlab.com',
    probe: {
      kind: 'http_status',
      transport: 'profile_http',
      method: 'GET',
      urlTemplate: 'https://gitlab.com/{username}',
      foundStatuses: [200],
      notFoundStatuses: [404],
      blockedStatuses: [403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '未做 live 验证；未知跳转/重定向一律降级为 unknown。',
    notes: []
  },
  {
    platformId: 'bluesky',
    name: 'Bluesky',
    category: 'social',
    subjectKinds: ['username'],
    homepage: 'https://bsky.app',
    probe: {
      kind: 'http_status',
      transport: 'api_http',
      method: 'GET',
      urlTemplate: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={username}',
      foundStatuses: [200],
      notFoundStatuses: [400],
      blockedStatuses: [401, 403, 429],
      foundMarker: null,
      notFoundMarker: null
    },
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 10,
    verification: 'live_unverified',
    verificationNote: '按公开 AppView API 编写；handle 需要完整域名形式，纯用户名不保证命中。',
    notes: ['用户需提供完整 handle（如 name.bsky.social）。']
  },
  {
    platformId: 'x',
    name: 'X (Twitter)',
    category: 'social',
    subjectKinds: ['username'],
    homepage: 'https://x.com',
    probe: null,
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 0,
    verification: 'live_unverified',
    verificationNote: '未登录探测会被登录墙拦截，无法区分存在/不存在；仅接受外部工具报告导入。',
    notes: ['导入来源为 maigret 等外部报告；结论保持 live_unverified。']
  },
  {
    platformId: 'instagram',
    name: 'Instagram',
    category: 'social',
    subjectKinds: ['username'],
    homepage: 'https://www.instagram.com',
    probe: null,
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 0,
    verification: 'live_unverified',
    verificationNote: '登录墙与自动化限制导致未登录探测不可靠；仅接受外部工具报告导入。',
    notes: ['不绕过登录、验证码或访问控制。']
  },
  {
    platformId: 'bilibili',
    name: '哔哩哔哩',
    category: 'social',
    subjectKinds: ['username'],
    homepage: 'https://space.bilibili.com',
    probe: null,
    posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { ...JSON_LIST_PAGE_FIELDS } },
    rateLimitPerMinute: 0,
    verification: 'live_unverified',
    verificationNote: '空间页以数字 UID 为主，用户名映射不确定；仅接受外部工具报告导入。',
    notes: []
  }
];

export const BUILTIN_PLATFORM_REGISTRY: PlatformRegistry = {
  version: PLATFORM_REGISTRY_VERSION,
  generatedAt: PLATFORM_REGISTRY_GENERATED_AT,
  rules: RULES
};

export function registrySummary(registry: PlatformRegistry): {
  version: string;
  generatedAt: string;
  ruleCount: number;
  probeCapable: number;
  postsCapable: number;
  importOnly: number;
  liveVerified: number;
} {
  return {
    version: registry.version,
    generatedAt: registry.generatedAt,
    ruleCount: registry.rules.length,
    probeCapable: registry.rules.filter((rule) => rule.probe !== null).length,
    postsCapable: registry.rules.filter((rule) => rule.posts.kind !== 'none').length,
    importOnly: registry.rules.filter((rule) => rule.probe === null).length,
    liveVerified: registry.rules.filter((rule) => rule.verification === 'live_verified').length
  };
}
