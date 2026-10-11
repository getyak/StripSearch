/**
 * Shared URL normalization and host-rule DATA (pure; no Node dependencies —
 * this module is bundled into the client through `shared/first-step-discovery`).
 *
 * Only the rule data and pure predicates live here. Each security layer keeps
 * its own composition and strictness (see docs/code-maintenance.md):
 * input acceptance (`validation.isPublicHttpsUrl`), first-step classification
 * (`isBlockedHost`), tool egress (`toolkit.publicUrl`) and GET-92 planning
 * (`staticHttpsUrlPreflight`) are explicit policy boundaries and are NOT
 * merged.
 */

/** Lowercase the scheme://host portion only; path/query/fragment stay verbatim. */
export function normalizeSchemeHost(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return value;
  const scheme = value.slice(0, schemeEnd).toLowerCase();
  const rest = value.slice(schemeEnd + 3);
  const boundary = rest.search(/[/?#]/);
  const authority = boundary < 0 ? rest : rest.slice(0, boundary);
  const tail = boundary < 0 ? '' : rest.slice(boundary);
  return `${scheme}://${authority.toLowerCase()}${tail}`;
}

/** Hostname of a URL, or the raw value when it does not parse. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Host suffixes that static/offline classification must never treat as public
 * fetch targets (fixture and non-public namespaces included).
 */
export const NON_PUBLIC_HOST_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'test',
  'invalid',
  'localdomain',
  'example',
  'example.com',
  'example.org',
  'example.net'
];

/**
 * Egress-layer subset (`toolkit.publicUrl`): non-public host suffixes only.
 * Fixture `example.*` hosts are guarded by the offline test layers on that
 * chain, and bare hosts without a dot are refused separately there — keep the
 * subset explicit instead of silently widening or narrowing the rule.
 */
export const EGRESS_NON_PUBLIC_HOST_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'test',
  'invalid'
];

/** Suffix rule shared by the strict layers: exact host or a subdomain of it. */
export function matchesNonPublicHostSuffix(
  host: string,
  suffixes: readonly string[] = NON_PUBLIC_HOST_SUFFIXES
): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Literal-IP shape check (first-step semantics): dotted quads (regardless of
 * range validity), anything containing `:` and bracketed IPv6 forms. Layers
 * that need full IP parsing keep their own `node:net` checks.
 */
export function isLiteralIpHost(host: string): boolean {
  if (/^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(host)) return true;
  return host.includes(':') || /^\[.*\]$/.test(host);
}
