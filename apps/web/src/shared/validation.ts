import { LIMITS } from './limits.js';

export interface ValidationResult {
  ok: boolean;
  error: string | null;
}

const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** GitHub path segments that are not user handles. */
const RESERVED_HANDLES = new Set([
  'about',
  'account',
  'apps',
  'blog',
  'contact',
  'explore',
  'features',
  'issues',
  'login',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'security',
  'settings',
  'signup',
  'site',
  'sponsors',
  'topics',
  'trending'
]);

export function normalizeQuestion(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
}

export function validateQuestion(raw: unknown): ValidationResult {
  const question = normalizeQuestion(raw);
  if (question.length < LIMITS.questionMin) {
    return { ok: false, error: '请写一个具体的研究问题。' };
  }
  if (question.length > LIMITS.questionMax) {
    return { ok: false, error: `研究问题不能超过 ${LIMITS.questionMax} 个字符。` };
  }
  return { ok: true, error: null };
}

/**
 * Strict GitHub handle extraction. Only the canonical
 * `https://github.com/<handle>` form is accepted: https, no credentials,
 * no explicit port, no query or fragment, exactly one path segment.
 */
export function extractGitHubHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  let candidate: string | null = null;
  if (/^https?:\/\//i.test(text)) {
    candidate = text;
  } else {
    const embedded = text.match(/(?:^|\s)(https:\/\/github\.com\/[A-Za-z0-9-]{1,39})(?=[/?#\s]|$)/);
    if (embedded?.[1]) candidate = embedded[1];
  }
  if (!candidate) return null;
  // Reject explicit ports and credentials in the authority up front: URL
  // normalization hides a default ":443" port.
  if (!/^https:\/\/github\.com(?:\/|$)/.test(candidate)) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.origin !== 'https://github.com') return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  if (url.search || url.hash) return null;
  if (url.hostname.toLowerCase() !== 'github.com') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const handle = segments[0] ?? '';
  if (!HANDLE_RE.test(handle)) return null;
  if (RESERVED_HANDLES.has(handle.toLowerCase())) return null;
  return handle;
}

/** Basic http(s) check used by the optional profile field in the UI. */
export function validateSeedUrl(raw: unknown): ValidationResult & { url: string | null } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, error: null, url: null };
  if (typeof raw !== 'string') return { ok: false, error: '主页链接格式不正确。', url: null };
  const text = raw.trim();
  if (text.length > LIMITS.seedUrlMax) {
    return { ok: false, error: '主页链接过长。', url: null };
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, error: '链接不能包含换行或控制字符。', url: null };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: '请输入完整的 http(s) 链接。', url: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '只支持 http 或 https 链接。', url: null };
  }
  if (url.username || url.password) {
    return { ok: false, error: '链接不能包含用户名或密码。', url: null };
  }
  if (!url.hostname) {
    return { ok: false, error: '链接缺少主机名。', url: null };
  }
  return { ok: true, error: null, url: url.toString() };
}

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata',
  '[::1]',
  '::1'
]);

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = parts;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host) return true;
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(':') && isPrivateIpv6(host)) return true;
  return false;
}

/**
 * Source URLs must be absolute public https URLs. javascript:, data:, file:,
 * credentials, private hosts and non-https schemes are rejected before storage.
 */
export function isPublicHttpsUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > LIMITS.seedUrlMax) return false;
  if (/[\u0000-\u0020\u007f]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!url.hostname) return false;
  if (isPrivateHost(url.hostname)) return false;
  return true;
}

const DISALLOWED_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /(住址|家庭住址|具体地址|现住址|居住地址|住在哪里|在哪里住|家庭地址|home\s+address|street\s+address|where\s+.{0,12}\s+lives?|current\s+location|home\s+location)/i,
    reason: '不提供私人住址或居住位置。'
  },
  {
    re: /(定位|行踪|实时位置|轨迹|gps\s*(位置|轨迹|定位)|实时追踪|track\s+location|live\s+location|whereabouts)/i,
    reason: '不提供实时位置或行踪追踪。'
  },
  {
    re: /(手机号|手机号码|电话号码|私人电话|联系电话|微信号|加微信|qq\s*号|私人邮箱|个人邮箱|联系方式|通讯录|phone\s+number|cell\s+number|personal\s+email|private\s+email|contact\s+list|address\s+book)/i,
    reason: '不收集私人联系方式。'
  },
  {
    re: /(人肉|开盒|真实身份|真实姓名|去匿名|匿名身份.*(揭露|确认|查出)|扒出.*(真实|身份)|身份揭露|实名信息|身份证号|deanonym|unmask|doxx|real\s+name\s+of|reveal\s+.{0,12}identity|identity\s+of\s+the\s+anonymous)/i,
    reason: '不提供去匿名化或身份揭露。'
  }
];

export interface ScopeScreen {
  disallowed: boolean;
  reason: string | null;
}

/** Reject clearly disallowed research requests before any provider call. */
export function screenQuestion(...parts: unknown[]): ScopeScreen {
  const combined = parts.filter((part): part is string => typeof part === 'string').join(' \n ');
  for (const pattern of DISALLOWED_PATTERNS) {
    if (pattern.re.test(combined)) {
      return { disallowed: true, reason: pattern.reason };
    }
  }
  return { disallowed: false, reason: null };
}

export function sanitizeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

/** Public person inputs are normalized once for stable anchors and allowlists. */
export function normalizeResearchUrl(raw: unknown): string | null {
  if (!isPublicHttpsUrl(raw)) return null;
  const url = new URL(raw as string);
  if (url.port || /^(?:www\.)?example\.(?:org|com|net)$/.test(url.hostname)) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  if (url.hostname === 'www.github.com') url.hostname = 'github.com';
  if (['www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)) url.hostname = 'x.com';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (['github.com','x.com'].includes(url.hostname) && url.pathname.split('/').filter(Boolean).length === 1) url.pathname = url.pathname.toLowerCase();
  return url.href;
}

export function extractResearchUrl(input: string): string | null {
  const match = input.match(/https:\/\/[^\s<>"'，。；）)]+/i);
  return match ? normalizeResearchUrl(match[0]) : null;
}
