/**
 * GET-91 Task 3: discovery target policy and validated targets.
 *
 * `validateDiscoveryTarget` is the ONLY way to turn a rule/request URL into a
 * `ValidatedDiscoveryTarget`: it enforces the public-HTTPS policy (https only,
 * port 443, no userinfo), refuses loopback/private/link-local/reserved/
 * special IPv4 and IPv6 addresses (including IPv4-mapped mixed forms), and
 * requires EVERY DNS record for the hostname to be safe — never a first-result
 * blanket allow. The validated address is then PINNED into the transport
 * (`pinned-transport.ts`): there is no resolve-check-then-default-fetch path.
 *
 * Official Node references used for the transport boundary (Node 22.23.2):
 * - https://nodejs.org/download/release/v22.23.2/docs/api/http.html#httprequestoptions-callback
 *   (custom `lookup` incl. `options.all`, `agent: false`, `AbortSignal`;
 *   `timeout` alone does NOT abort — `request.destroy` is required)
 * - https://nodejs.org/download/release/v22.23.2/docs/api/https.html#httpsrequestoptions-callback
 *   (HTTPS inherits HTTP/TLS options; `agent: false` opts out of pooling; the
 *   original hostname keeps default certificate/identity verification)
 */

import { isIP } from 'node:net';

import { templateHasCredentialQuery } from '../../shared/public-discovery-rules.js';

export interface DnsRecord {
  address: string;
  family: 4 | 6;
}

/** Injectable DNS resolver; production uses dns.promises.lookup with `all`. */
export interface DnsResolver {
  resolveAll(hostname: string): Promise<DnsRecord[]>;
}

export interface DiscoveryTargetPolicy {
  /** Only these URL ports are ever allowed (production: [443]). */
  allowedPorts: number[];
  /** Redirect hop cap; every hop is revalidated with the same policy. */
  maxRedirects: number;
}

export const PUBLIC_HTTPS_TARGET_POLICY: DiscoveryTargetPolicy = {
  allowedPorts: [443],
  maxRedirects: 3
};

/**
 * Opaque validated target. Only `validateDiscoveryTarget` constructs one; the
 * transport must receive this brand instead of a raw URL.
 */
export interface ValidatedDiscoveryTarget {
  readonly __validatedDiscoveryTarget: 'v1';
  readonly originalUrl: string;
  /** Original hostname — used for TLS SNI/Host and certificate checks. */
  readonly hostname: string;
  readonly port: number;
  /** Path + query of the request target. */
  readonly path: string;
  /** Pinned validated address to connect to (custom lookup returns this). */
  readonly address: string;
  readonly family: 4 | 6;
}

export type AddressCheck = { ok: true } | { ok: false; reason: string };

/**
 * Bounded response capture: safe header fields only, decoded text with an
 * explicit encoding policy, and byte accounting from the streaming reader.
 * `location`/`retryAfter` are kept only to drive bounded redirect/rate
 * handling — no arbitrary upstream headers are persisted.
 */
export interface BoundedDiscoveryResponse {
  status: number;
  finalUrl: string;
  contentType: string | null;
  /** `utf-8` when the upstream charset is supported, else explicit `unsupported`. */
  encoding: 'utf-8' | 'unsupported';
  contentEncoding: string | null;
  retryAfter: string | null;
  location: string | null;
  bodyText: string;
  bytes: number;
  truncated: boolean;
  /** False when the captured bytes are not valid UTF-8 (never a no-match). */
  utf8Valid: boolean;
  /** Connector dispatches made to produce this response (redirect hops count). */
  sendCount: number;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseIpv6(input: string): number[] | null {
  let address = input;
  if (address.includes('%')) return null; // zone ids are never valid targets
  // Embedded IPv4 forms (::ffff:1.2.3.4 / ::1.2.3.4) become hex groups.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) {
    const octets = parseIpv4(dotted[2] as string);
    if (!octets) return null;
    const high = ((octets[0] as number) << 8) | (octets[1] as number);
    const low = ((octets[2] as number) << 8) | (octets[3] as number);
    address = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const expand = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : null;
  if (head === null || (halves.length === 2 && tail === null)) return null;
  const groups = halves.length === 2
    ? [...(head as number[]), ...new Array<number>(8 - (head as number[]).length - (tail as number[]).length).fill(0), ...(tail as number[])]
    : (head as number[]);
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group))) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/** Normalize IPv4-mapped IPv6 back to dotted IPv4 for uniform checks. */
export function normalizeSocketAddress(address: string): string {
  const bytes = parseIpv6(address);
  const at = (index: number): number => bytes?.[index] ?? -1;
  if (bytes && isZeroPrefix(bytes, 10) && at(10) === 0xff && at(11) === 0xff) {
    return `${at(12)}.${at(13)}.${at(14)}.${at(15)}`;
  }
  return address;
}

function isZeroPrefix(bytes: number[], count: number): boolean {
  return bytes.slice(0, count).every((byte) => byte === 0);
}

function v4Unsafe(octets: number[]): string | null {
  const [a, b, c] = octets as [number, number, number, number];
  const inCidr = (value: number, base: number, bits: number): boolean => (value >>> (32 - bits)) === (base >>> (32 - bits));
  const packed = ((octets[0] as number) << 24 | (octets[1] as number) << 16 | (octets[2] as number) << 8 | (octets[3] as number)) >>> 0;
  const blocks: Array<[number, number, string]> = [
    [0x00000000, 8, 'this-network'],
    [0x0a000000, 8, 'private'],
    [0x64400000, 10, 'cgnat'],
    [0x7f000000, 8, 'loopback'],
    [0xa9fe0000, 16, 'link-local'],
    [0xac100000, 12, 'private'],
    [0xc0000000, 24, 'special-protocol'],
    [0xc0000200, 24, 'documentation'],
    [0xc0586300, 24, '6to4-relay-anycast'],
    [0xc0a80000, 16, 'private'],
    [0xc6120000, 15, 'benchmark'],
    [0xc6336400, 24, 'documentation'],
    [0xcb007100, 24, 'documentation'],
    [0xe0000000, 4, 'multicast'],
    [0xf0000000, 4, 'reserved']
  ];
  for (const [base, bits, label] of blocks) {
    if (inCidr(packed, base, bits)) return label;
  }
  if (a === 255 && b === 255 && c === 255) return 'broadcast';
  return null;
}

/**
 * Frozen ordinary allocated IPv6 inventory (IANA IPv6 Unicast Address
 * Assignments, https://www.iana.org/assignments/ipv6-unicast-address-assignments/,
 * registry last updated 2025-10-10, captured 2026-09-30 in
 * get91-iana-global-allocation-review.json). `2000::/3` is only ASSIGNABLE
 * space — it is not proof that every contained address is currently
 * allocated. The inventory is maintained explicitly in source (no runtime
 * download, no auto-update, no new dependency).
 */
const IANA_ALLOCATED_V6_PREFIXES: readonly string[] = [
  '2001:200::/23',
  '2001:400::/23',
  '2001:600::/23',
  '2001:800::/22',
  '2001:c00::/23',
  '2001:e00::/23',
  '2001:1200::/23',
  '2001:1400::/22',
  '2001:1800::/23',
  '2001:1a00::/23',
  '2001:1c00::/22',
  '2001:2000::/19',
  '2001:4000::/23',
  '2001:4200::/23',
  '2001:4400::/23',
  '2001:4600::/23',
  '2001:4800::/23',
  '2001:4a00::/23',
  '2001:4c00::/23',
  '2001:5000::/20',
  '2001:8000::/19',
  '2001:a000::/20',
  '2001:b000::/20',
  '2003::/18',
  '2400::/12',
  '2410::/12',
  '2600::/12',
  '2610::/23',
  '2620::/23',
  '2630::/12',
  '2800::/12',
  '2a00::/12',
  '2a10::/12',
  '2c00::/12'
];

interface V6Prefix {
  bytes: number[];
  bits: number;
}

function parseV6Cidr(cidr: string): V6Prefix {
  const [address, bitsText] = cidr.split('/');
  const bytes = parseIpv6(address as string);
  if (!bytes) throw new Error(`invalid frozen IPv6 prefix ${cidr}`);
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) throw new Error(`invalid frozen IPv6 prefix ${cidr}`);
  return { bytes, bits };
}

const ALLOCATED_V6: readonly V6Prefix[] = IANA_ALLOCATED_V6_PREFIXES.map(parseV6Cidr);

function inV6Prefix(bytes: number[], prefix: V6Prefix): boolean {
  const fullBytes = Math.floor(prefix.bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix.bytes[index]) return false;
  }
  const remainder = prefix.bits % 8;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder) & 0xff;
  return ((bytes[fullBytes] ?? -1) & mask) === ((prefix.bytes[fullBytes] ?? -2) & mask);
}

function v6Unsafe(rawBytes: number[]): string | null {
  const at = (index: number): number => rawBytes[index] ?? -1;
  // Special-purpose denials (existing policy) apply first — including the
  // allocated-but-special 2001::/23 (Teredo/benchmark/…) and 2002::/16 (6to4).
  if ((at(0) & 0xe0) !== 0x20) return 'non-global-unicast';
  if (at(0) === 0x20 && at(1) === 0x01 && (at(2) & 0xfe) === 0x00) return 'ietf-protocol-special'; // 2001::/23
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return 'documentation'; // 2001:db8::/32
  if (at(0) === 0x20 && at(1) === 0x02) return '6to4'; // 2002::/16
  if (at(0) === 0x3f && at(1) === 0xff && (at(2) & 0xf0) === 0x00) return 'documentation'; // 3fff::/20
  if (at(0) === 0x5f && at(1) === 0x00) return 'srv6-sid'; // 5f00::/16
  // Ordinary public space must sit INSIDE a currently allocated prefix;
  // neighbors of allocations are never inferred as allocated.
  if (!ALLOCATED_V6.some((prefix) => inV6Prefix(rawBytes, prefix))) return 'not-allocated-unicast';
  return null;
}

/**
 * Public-address safety for one literal address. IPv4-mapped IPv6 is folded
 * back to IPv4 first ("mixed unsafe" forms are refused by the v4 rules).
 */
export function checkPublicAddress(raw: string): AddressCheck {
  const address = normalizeSocketAddress(raw.trim());
  const v4 = parseIpv4(address);
  if (v4) {
    const unsafe = v4Unsafe(v4);
    return unsafe === null ? { ok: true } : { ok: false, reason: unsafe };
  }
  const v6 = parseIpv6(address);
  if (v6) {
    const unsafe = v6Unsafe(v6);
    return unsafe === null ? { ok: true } : { ok: false, reason: unsafe };
  }
  return { ok: false, reason: 'unparseable_address' };
}

export class DiscoveryTargetError extends Error {
  constructor(
    readonly code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = 'DiscoveryTargetError';
  }
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Validate a discovery URL and pin ONE safe address. Every DNS record must be
 * safe: a single private/reserved record refuses the whole target.
 */
export async function validateDiscoveryTarget(
  rawUrl: string,
  policy: DiscoveryTargetPolicy,
  dns: DnsResolver
): Promise<ValidatedDiscoveryTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DiscoveryTargetError('invalid_target', 'not an absolute URL');
  }
  if (url.protocol !== 'https:') throw new DiscoveryTargetError('invalid_target', 'only https targets are allowed');
  if (url.username !== '' || url.password !== '') {
    throw new DiscoveryTargetError('credential_url', 'credential URLs are refused');
  }
  // Credential-bearing query carriers (case/percent-encoded names included)
  // are refused BEFORE DNS on every request and redirect hop — the query is
  // never stripped and sent as a public target.
  if (templateHasCredentialQuery(rawUrl)) {
    throw new DiscoveryTargetError('credential_target', 'credential-bearing query parameter refused');
  }
  const port = url.port === '' ? 443 : Number(url.port);
  if (!policy.allowedPorts.includes(port)) {
    throw new DiscoveryTargetError('invalid_target', `port ${port} is not allowed`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname.length === 0) throw new DiscoveryTargetError('invalid_target', 'missing hostname');

  let pinned: DnsRecord;
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    // Numeric/hex aliases already normalized by the URL parser; fold mapped
    // forms so literal family and address checks stay consistent.
    const normalized = normalizeSocketAddress(hostname);
    const family = isIP(normalized);
    if (family === 0) throw new DiscoveryTargetError('invalid_target', 'unparseable literal address');
    const check = checkPublicAddress(normalized);
    if (!check.ok) throw new DiscoveryTargetError('unsafe_address', `${hostname}: ${check.reason}`);
    pinned = { address: normalized, family: family === 4 ? 4 : 6 };
  } else {
    if (!HOSTNAME_RE.test(hostname)) throw new DiscoveryTargetError('invalid_target', 'hostname is not a plain DNS name');
    let records: DnsRecord[];
    try {
      records = await dns.resolveAll(hostname);
    } catch (error) {
      throw new DiscoveryTargetError('dns_failed', error instanceof Error ? error.message : String(error));
    }
    if (!Array.isArray(records) || records.length === 0) {
      throw new DiscoveryTargetError('dns_no_records', hostname);
    }
    const normalizedRecords: DnsRecord[] = [];
    for (const record of records) {
      if (!record || typeof record.address !== 'string') {
        throw new DiscoveryTargetError('dns_invalid_record', hostname);
      }
      const normalized = normalizeSocketAddress(record.address.trim());
      const family = isIP(normalized);
      if (family === 0) throw new DiscoveryTargetError('dns_invalid_record', `${hostname}: unparseable address`);
      // The declared resolver family must agree with the normalized address
      // family — a mapped IPv6 record for a v4 address is contradictory and
      // refused (no ambiguous resolver/transport path).
      if ((record.family !== 4 && record.family !== 6) || (family === 4 ? 4 : 6) !== record.family) {
        throw new DiscoveryTargetError('dns_contradictory_record', `${hostname}: family ${String(record.family)} vs ${normalized}`);
      }
      const check = checkPublicAddress(normalized);
      if (!check.ok) {
        throw new DiscoveryTargetError('dns_unsafe_record', `${hostname} resolves to ${normalized} (${check.reason})`);
      }
      normalizedRecords.push({ address: normalized, family: family === 4 ? 4 : 6 });
    }
    const first = normalizedRecords[0]!;
    pinned = { address: first.address, family: first.family };
  }

  return {
    __validatedDiscoveryTarget: 'v1',
    // The original URL text is preserved (host case-insensitivity and all);
    // TLS/Host use the normalized `hostname` and the connection is pinned to
    // `address`.
    originalUrl: rawUrl.trim(),
    hostname,
    port,
    path: `${url.pathname}${url.search}`,
    address: pinned.address,
    family: pinned.family
  };
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
