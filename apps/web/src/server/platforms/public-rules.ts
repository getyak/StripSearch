/**
 * GET-91 Task 2: offline compiler for pinned public rule datasets.
 *
 * `compilePublicRules` consumes FIXED local source bytes (Maigret sites /
 * WhatsMyName sites) plus their pinned manifest facts and produces:
 *
 * - normalized `PublicDiscoveryRule[]` (restricted data — no code, no regex,
 *   no raw username examples, no header values/tokens, no upstream prose);
 * - `PublicRuleExclusion[]` receipts carrying ONLY rowId + row hash + reason;
 * - reconciled counts (raw = loaded + excluded) and per-source attribution
 *   facts (commit, byte hash, license text hash, retrieval time).
 *
 * Nothing here touches the network: importing upstream bytes is an explicit
 * parent/maintenance action (see `scripts/import-public-rules.ts`), offline
 * tests and production startup never download anything.
 *
 * Merge semantics live in `shared/public-discovery-rules.ts`: rules group only
 * on the exact canonical profile template + instance host + account kind;
 * differing predicates stay independent rules sharing one response request.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PUBLIC_MARKER_MAX_LENGTH,
  PUBLIC_RULE_IMPORTER_VERSION,
  PUBLIC_RULES_MANIFEST_SCHEMA_VERSION,
  PUBLIC_RULES_SCHEMA_VERSION,
  canonicalPublicTemplate,
  canonicalTemplateHost,
  publicRuleGroupKey,
  templateHasCredentialQuery,
  usernamePlaceholderCount
} from '../../shared/public-discovery-rules.js';
import type {
  PublicDetection,
  PublicDiscoveryRule,
  PublicRuleExclusion,
  PublicRuleExclusionReason,
  PublicRuleGroup,
  PublicRuleImport,
  PublicRuleSourceExclusions,
  PublicRuleSourceId,
  PublicRuleSourceInput,
  PublicRuleSourceRecord,
  PublicRuleUnion,
  PublicRuleUnionCounts
} from '../../shared/public-discovery-rules.js';
import type {
  CatalogCost,
  CatalogEntry,
  CatalogSourceManifest,
  CapabilityRecord,
  DiscoveryRoute
} from '../../shared/platform-catalog.js';

/** Header keys whose literal values may be preserved on rules. */
export const SAFE_RULE_HEADERS: readonly string[] = ['accept', 'accept-language'];

/* ------------------------------------------------------------------ */
/* Deterministic ids (server-side hashing)                             */
/* ------------------------------------------------------------------ */

function digestHex(input: string, length: number): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length);
}

export function publicRuleId(ref: { sourceId: string; rowId: string; rowSha256: string }, contentKey: string): string {
  return `pr-${digestHex(`${ref.sourceId}\n${ref.rowId}\n${ref.rowSha256}\n${contentKey}`, 16)}`;
}

export function publicRuleGroupId(key: string): string {
  return `pug-${digestHex(key, 12)}`;
}

export function publicRulePlatformId(key: string): string {
  return `pub-${digestHex(key, 12)}`;
}

/**
 * Group rules into the union. Merging requires the EXACT canonical profile
 * template + instance host + account kind; display names and TLDs never
 * merge. Known platforms join only through the explicit exact-template map
 * (canonical template -> curated platform id).
 */
export function publicRuleUnionGroups(
  rules: PublicDiscoveryRule[],
  knownTemplates: Map<string, string>
): PublicRuleGroup[] {
  const buckets = new Map<string, PublicDiscoveryRule[]>();
  for (const rule of [...rules].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1))) {
    const key = publicRuleGroupKey(rule.canonicalProfileTemplate, rule.instanceHost, rule.accountKind);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(rule);
    else buckets.set(key, [rule]);
  }
  const groups: PublicRuleGroup[] = [];
  for (const key of [...buckets.keys()].sort()) {
    const members = buckets.get(key)!;
    const first = members.reduce((best, candidate) =>
      `${candidate.sourceRef.sourceId}:${candidate.sourceRef.rowId}` < `${best.sourceRef.sourceId}:${best.sourceRef.rowId}`
        ? candidate
        : best
    );
    const knownPlatformId = knownTemplates.get(first.canonicalProfileTemplate) ?? null;
    const requestTemplates = [...new Set(members.map((rule) => rule.requestTemplate))].sort();
    groups.push({
      groupId: publicRuleGroupId(key),
      platformId: knownPlatformId ?? publicRulePlatformId(key),
      knownPlatformId,
      name: first.sourceName,
      instanceHost: first.instanceHost,
      accountKind: first.accountKind,
      canonicalProfileTemplate: first.canonicalProfileTemplate,
      requestTemplates,
      rules: members,
      ruleIds: members.map((rule) => rule.ruleId),
      sourceIds: [...new Set(members.map((rule) => rule.sourceRef.sourceId))].sort()
    });
  }
  return groups;
}

export class PublicRuleBundleError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PublicRuleBundleError';
  }
}

function fail(code: string, detail: string): never {
  throw new PublicRuleBundleError(code, detail);
}

function sha256Hex(input: Buffer | string | Uint8Array): string {
  return createHash('sha256').update(input as Buffer).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical JSON (sorted keys) so row hashes are order-independent. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/* ------------------------------------------------------------------ */
/* Row-level helpers                                                   */
/* ------------------------------------------------------------------ */

type Disposition =
  | { ok: true; rule: Omit<PublicDiscoveryRule, 'ruleId'> }
  | { ok: false; reason: PublicRuleExclusionReason };

function readMarkers(value: unknown): { ok: true; markers: string[] } | { ok: false; reason: PublicRuleExclusionReason } {
  if (value === undefined || value === null) return { ok: true, markers: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'unsupported_marker_value' };
  const markers: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, reason: 'unsupported_marker_value' };
    // Trimming only TESTS emptiness — the literal bytes (leading/trailing
    // whitespace included) are preserved, because source semantics match
    // exactly (`' user='` must not match `xuser=`).
    if (item.trim().length === 0) return { ok: false, reason: 'unsupported_marker_value' };
    if (item.length > PUBLIC_MARKER_MAX_LENGTH) return { ok: false, reason: 'unsupported_marker_length' };
    markers.push(item);
  }
  return { ok: true, markers };
}

function readSingleMarker(value: unknown): { ok: true; markers: string[] } | { ok: false; reason: PublicRuleExclusionReason } {
  // `''` is the documented "no marker declared" sentinel (e.g. WhatsMyName
  // e_string/m_string): the side becomes explicitly unbounded instead of
  // silently rewritten. Whitespace-only non-empty markers are rejected.
  if (value === undefined || value === null || value === '') return { ok: true, markers: [] };
  if (typeof value !== 'string') return { ok: false, reason: 'unsupported_marker_value' };
  return readMarkers([value]);
}

/**
 * Header preflight: keys are inspected (never values). Rows carrying any key
 * outside the safe literal subset are excluded — credentials, cookies, Host
 * overrides and anti-abuse headers are never copied into rules or receipts.
 */
function readSafeHeaders(
  value: unknown
): { ok: true; headers: Record<string, string> } | { ok: false; reason: PublicRuleExclusionReason } {
  if (value === undefined || value === null) return { ok: true, headers: {} };
  if (!isRecord(value)) return { ok: false, reason: 'unsafe_header' };
  const headers: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = key.trim().toLowerCase();
    const raw = value[key];
    if (!SAFE_RULE_HEADERS.includes(normalized)) return { ok: false, reason: 'unsafe_header' };
    if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, reason: 'unsafe_header' };
    if (raw.length > PUBLIC_MARKER_MAX_LENGTH) return { ok: false, reason: 'unsafe_header' };
    headers[normalized] = raw.trim();
  }
  return { ok: true, headers };
}

const PLACEHOLDER_RE = /\{[^{}]*\}/;

type TemplateOutcome = { ok: true; canonical: string } | { ok: false; reason: PublicRuleExclusionReason };

/**
 * Substitute the supported placeholders (`{urlMain}` / `{urlSubpath}` are
 * substituted from the row before the scheme check) and canonicalize EXACTLY:
 * trailing slashes and fragment locators are preserved. Only `{username}`
 * survives into the template; its count must survive canonicalization too —
 * a request whose account position lives only in a fragment (never sent over
 * HTTP) is an explicit exclusion, never a generic root-page request.
 */
function buildTemplate(
  rawTemplate: unknown,
  substitutes: { urlMain?: string | null; urlSubpath?: string | null },
  options: { placeholderName: '{username}' | '{account}'; kind: 'request' | 'profile' }
): TemplateOutcome {
  if (typeof rawTemplate !== 'string' || rawTemplate.trim().length === 0) {
    return { ok: false, reason: 'unsupported_template' };
  }
  let template = rawTemplate.trim();
  if (template.includes('{urlMain}')) {
    if (typeof substitutes.urlMain !== 'string' || substitutes.urlMain.trim() === '') {
      return { ok: false, reason: 'missing_template_substitution' };
    }
    template = template.split('{urlMain}').join(substitutes.urlMain.trim());
  }
  if (template.includes('{urlSubpath}')) {
    if (typeof substitutes.urlSubpath !== 'string' || substitutes.urlSubpath.trim() === '') {
      return { ok: false, reason: 'missing_template_substitution' };
    }
    template = template.split('{urlSubpath}').join(substitutes.urlSubpath.trim());
  }
  const placeholder = options.placeholderName === '{username}' ? '{username}' : '{account}';
  const hashIndex = template.indexOf('#');
  const fragment = hashIndex >= 0 ? template.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? template.slice(0, hashIndex) : template;
  const placeholderInBase = base.includes(placeholder);
  const placeholderInFragment = fragment.includes(placeholder);
  if (options.kind === 'request') {
    if (!placeholderInBase) {
      if (placeholderInFragment) {
        // A fragment-only account position cannot ride a request (fragments
        // are never sent over HTTP): never a generic root-page probe.
        return { ok: false, reason: 'unsupported_template' };
      }
      return { ok: false, reason: 'missing_account_placeholder' };
    }
  } else if (!placeholderInBase && !placeholderInFragment) {
    // A profile locator must keep the account position (fragment locators
    // preserve it verbatim); without one it is not an account locator.
    return { ok: false, reason: 'missing_account_placeholder' };
  }
  const stripped = template.split('{username}').join('u').split('{account}').join('u');
  if (PLACEHOLDER_RE.test(stripped) || stripped.includes('{') || stripped.includes('}')) {
    return { ok: false, reason: 'unsupported_template' };
  }
  // Credential-bearing query carriers (incl. case/percent-encoded names and
  // substituted urlMain/urlSubpath) are EXCLUDED before normalization — never
  // stripped and re-labelled public. Values never leave the source row.
  if (templateHasCredentialQuery(template)) {
    return { ok: false, reason: 'credential_bearing_template' };
  }
  const beforeCount = (template.match(/\{username\}|\{account\}/g) ?? []).length;
  const canonical = canonicalPublicTemplate(template);
  if (canonical === null) {
    // Distinguish "not https" from "not a usable template".
    let scheme = '';
    try {
      scheme = new URL(stripped).protocol;
    } catch {
      return { ok: false, reason: 'unsupported_template' };
    }
    return { ok: false, reason: scheme === 'http:' ? 'non_https_template' : 'unsupported_template' };
  }
  // Re-check the placeholder count AFTER canonicalization: URL normalization
  // must never silently drop the account position.
  const afterCount = usernamePlaceholderCount(canonical);
  if (afterCount < 1 || afterCount !== beforeCount) {
    return { ok: false, reason: 'unsupported_template' };
  }
  return { ok: true, canonical };
}

/**
 * Generic login-form phrases are preserved as source literals but can never
 * prove an account (they match login walls, not profiles).
 */
const LOGIN_FORM_TOKEN = /log[\s_-]?in|sign[\s_-]?in|signin|anmelden|connexion|\u0432\u0445\u043e\u0434|\u767b\u5f55|\u767b\u5165/i;

export function isGenericLoginMarker(marker: string): boolean {
  return LOGIN_FORM_TOKEN.test(marker);
}

/**
 * Build the detection predicate from preserved source literals:
 *
 * - positive proof = NON-login-form literals only (generic login phrases are
 *   kept as `nonProofPresentAny` metadata);
 * - negative proof = declared absence literals, or a declared NON-success
 *   absence status. A bare 2xx "absence status" with no marker is NOT bounded
 *   negative proof (e.g. WhatsMyName Evolution CMS).
 */
function detectionFromMarkers(args: {
  kind: PublicDetection['kind'];
  presentStatus: number | null;
  presentMarkers: string[];
  absentStatus: number | null;
  absentAny: string[];
}): PublicDetection {
  const presentAny = args.presentMarkers.filter((marker) => !isGenericLoginMarker(marker));
  const nonProofPresentAny = args.presentMarkers.filter((marker) => isGenericLoginMarker(marker));
  const nonSuccessAbsenceStatus =
    args.absentStatus !== null && !(args.absentStatus >= 200 && args.absentStatus < 300);
  return {
    kind: args.kind,
    presentStatus: args.presentStatus,
    presentAny,
    nonProofPresentAny,
    absentStatus: args.absentStatus,
    absentAny: args.absentAny,
    boundedPositive: presentAny.length > 0,
    boundedNegative: args.absentAny.length > 0 || nonSuccessAbsenceStatus
  };
}

/* ------------------------------------------------------------------ */
/* Maigret normalization                                               */
/* ------------------------------------------------------------------ */

function compileMaigretRow(
  rowId: string,
  raw: unknown,
  rowSha256: string,
  engines: Record<string, unknown>
): Disposition {
  if (!isRecord(raw)) return { ok: false, reason: 'malformed_record' };
  const engineName = typeof raw.engine === 'string' ? raw.engine : null;
  if (raw.engine !== undefined && engineName === null) return { ok: false, reason: 'malformed_record' };
  const effective: Record<string, unknown> = {};
  if (engineName !== null) {
    const engine = engines[engineName];
    if (!isRecord(engine)) return { ok: false, reason: 'malformed_record' };
    const site = engine.site;
    if (site !== undefined && !isRecord(site)) return { ok: false, reason: 'malformed_record' };
    if (isRecord(site)) Object.assign(effective, site);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'engine') effective[key] = value;
  }

  if (effective.disabled === true) return { ok: false, reason: 'disabled_rule' };
  if (effective.activation !== undefined) return { ok: false, reason: 'activation_required' };
  if (effective.requestPayload !== undefined) return { ok: false, reason: 'unsupported_method' };
  if (effective.requestHeadOnly === true) return { ok: false, reason: 'unsupported_method' };
  if (effective.requestMethod !== undefined && effective.requestMethod !== 'GET') {
    return { ok: false, reason: 'unsupported_method' };
  }
  if (effective.type !== undefined) return { ok: false, reason: 'unsupported_id_kind' };
  if (effective.protocol !== undefined) return { ok: false, reason: 'unsupported_protocol' };
  if (effective.regexCheck !== undefined) return { ok: false, reason: 'unsupported_regex_predicate' };
  if (effective.similarSearch === true) return { ok: false, reason: 'unsupported_similar_search' };
  if (effective.errorUrl !== undefined) return { ok: false, reason: 'unsupported_error_url' };
  if (effective.encoding !== undefined) return { ok: false, reason: 'unsupported_encoding' };

  const headers = readSafeHeaders(effective.headers);
  if (!headers.ok) return { ok: false, reason: headers.reason };

  const urlMain = typeof effective.urlMain === 'string' ? effective.urlMain : null;
  const urlSubpath = typeof effective.urlSubpath === 'string' ? effective.urlSubpath : null;
  const substitutes = { urlMain, urlSubpath };
  const profile = buildTemplate(effective.url, substitutes, { placeholderName: '{username}', kind: 'profile' });
  if (!profile.ok) return { ok: false, reason: profile.reason };
  const request = buildTemplate(effective.urlProbe ?? effective.url, substitutes, { placeholderName: '{username}', kind: 'request' });
  if (!request.ok) return { ok: false, reason: request.reason };

  const present = readMarkers(effective.presenseStrs);
  if (!present.ok) return { ok: false, reason: present.reason };
  const absent = readMarkers(effective.absenceStrs);
  if (!absent.ok) return { ok: false, reason: absent.reason };
  const errors = readMarkers(effective.errors === undefined ? undefined : Object.keys(isRecord(effective.errors) ? effective.errors : {}));
  if (!errors.ok) return { ok: false, reason: errors.reason };
  const protections = readMarkers(effective.protection);
  if (!protections.ok) return { ok: false, reason: 'malformed_record' };

  const checkType = typeof effective.checkType === 'string' ? effective.checkType : null;
  let detection: PublicDetection;
  if (checkType === 'message') {
    if (present.markers.length === 0 && absent.markers.length === 0) {
      return { ok: false, reason: 'missing_detection_predicate' };
    }
    detection = detectionFromMarkers({
      kind: 'bounded_strings',
      presentStatus: null,
      presentMarkers: present.markers,
      absentStatus: null,
      absentAny: absent.markers
    });
  } else if (checkType === 'status_code') {
    // Upstream semantics: HTTP status equality alone claims existence. A 200
    // alone is NOT bounded positive proof, and the source documents no absence
    // semantics — unless literal markers are present alongside.
    const hasMarkers = present.markers.length > 0 || absent.markers.length > 0;
    detection = detectionFromMarkers({
      kind: hasMarkers ? 'bounded_strings' : 'status_only',
      presentStatus: 200,
      presentMarkers: present.markers,
      absentStatus: null,
      absentAny: absent.markers
    });
  } else if (checkType === 'response_url') {
    // Upstream matches final response URLs; that cannot be bounded to literal
    // body markers and a redirect is never account identity. Loaded as
    // unbounded: evaluation always returns explicit `unknown`.
    detection = detectionFromMarkers({
      kind: 'url_redirect',
      presentStatus: null,
      presentMarkers: [],
      absentStatus: null,
      absentAny: []
    });
  } else {
    return { ok: false, reason: 'unsupported_check_type' };
  }

  return {
    ok: true,
    rule: {
      sourceRef: { sourceId: 'maigret', rowId, rowSha256 },
      sourceName: rowId,
      canonicalProfileTemplate: profile.canonical,
      requestTemplate: request.canonical,
      instanceHost: canonicalTemplateHost(profile.canonical),
      accountKind: 'unknown',
      detection,
      caseSensitive: true,
      ratePerMinute: null,
      protections: protections.markers.slice(0, 8),
      errorMarkers: errors.markers,
      safeHeaders: headers.headers
    }
  };
}

/* ------------------------------------------------------------------ */
/* WhatsMyName normalization                                           */
/* ------------------------------------------------------------------ */

function compileWmnRow(rowId: string, raw: unknown, rowSha256: string): Disposition {
  if (!isRecord(raw)) return { ok: false, reason: 'malformed_record' };
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : null;
  if (name === null) return { ok: false, reason: 'malformed_record' };
  if (raw.post_body !== undefined) return { ok: false, reason: 'unsupported_post_body' };
  if (raw.strip_bad_char !== undefined) return { ok: false, reason: 'unsupported_username_transform' };
  const headers = readSafeHeaders(raw.headers);
  if (!headers.ok) return { ok: false, reason: headers.reason };

  const profileSource = raw.uri_pretty ?? raw.uri_check;
  const substitutes = {};
  const request = buildTemplate(raw.uri_check, substitutes, { placeholderName: '{account}', kind: 'request' });
  if (!request.ok) return { ok: false, reason: request.reason };
  const profile = buildTemplate(profileSource, substitutes, { placeholderName: '{account}', kind: 'profile' });
  if (!profile.ok) return { ok: false, reason: profile.reason };

  const eCode = raw.e_code;
  const mCode = raw.m_code;
  if (typeof eCode !== 'number' || !Number.isInteger(eCode)) return { ok: false, reason: 'malformed_record' };
  if (mCode !== undefined && (typeof mCode !== 'number' || !Number.isInteger(mCode))) {
    return { ok: false, reason: 'malformed_record' };
  }
  const present = readSingleMarker(raw.e_string);
  if (!present.ok) return { ok: false, reason: present.reason };
  const absent = readSingleMarker(raw.m_string);
  if (!absent.ok) return { ok: false, reason: absent.reason };
  const protections = readMarkers(raw.protection);
  if (!protections.ok) return { ok: false, reason: 'malformed_record' };

  const detection = detectionFromMarkers({
    kind: present.markers.length > 0 || absent.markers.length > 0 ? 'bounded_strings' : 'status_only',
    presentStatus: eCode,
    presentMarkers: present.markers,
    absentStatus: typeof mCode === 'number' ? mCode : null,
    absentAny: absent.markers
  });

  return {
    ok: true,
    rule: {
      sourceRef: { sourceId: 'whatsmyname', rowId, rowSha256 },
      sourceName: name,
      canonicalProfileTemplate: profile.canonical,
      requestTemplate: request.canonical,
      instanceHost: canonicalTemplateHost(profile.canonical),
      accountKind: 'unknown',
      detection,
      caseSensitive: true,
      ratePerMinute: null,
      protections: protections.markers.slice(0, 8),
      errorMarkers: [],
      safeHeaders: headers.headers
    }
  };
}

/* ------------------------------------------------------------------ */
/* compilePublicRules                                                  */
/* ------------------------------------------------------------------ */

export function compilePublicRules(input: PublicRuleSourceInput): PublicRuleImport {
  const licenseText = typeof input.licenseText === 'string' ? input.licenseText : '';
  if (licenseText.trim().length === 0) {
    throw new PublicRuleBundleError('license_missing', `source ${input.sourceId}: license text is required before import`);
  }
  let root: unknown;
  try {
    root = JSON.parse(Buffer.from(input.bytes).toString('utf8'));
  } catch (error) {
    throw new PublicRuleBundleError(
      'malformed_source_bytes',
      `source ${input.sourceId}: malformed source bytes: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(root) || !isRecord(root.sites) && !Array.isArray(root.sites)) {
    throw new PublicRuleBundleError('invalid_shape', `source ${input.sourceId}: root must carry a sites collection`);
  }

  const contentHash = sha256Hex(input.bytes);
  const verification: { byteHashVerified: boolean; mismatch: string[] } = { byteHashVerified: false, mismatch: [] };
  if (input.manifest.sha256 !== undefined && input.manifest.sha256 !== contentHash) {
    verification.mismatch.push('byte_hash');
  }
  if (input.manifest.bytes !== undefined && input.manifest.bytes !== input.bytes.byteLength) {
    verification.mismatch.push('bytes');
  }

  const rules: PublicDiscoveryRule[] = [];
  const exclusions: PublicRuleExclusion[] = [];

  if (input.sourceId === 'maigret') {
    const engines = isRecord(root.engines) ? root.engines : {};
    const sites = root.sites;
    if (!isRecord(sites)) {
      throw new PublicRuleBundleError('invalid_shape', 'maigret: sites must be an object keyed by site name');
    }
    const rowIds = Object.keys(sites).sort();
    if (rowIds.length === 0) {
      throw new PublicRuleBundleError('invalid_shape', 'maigret: sites collection is empty (a full import is required)');
    }
    for (const rowId of rowIds) {
      const raw = sites[rowId];
      const rowSha256 = sha256Hex(canonicalJson(raw));
      const disposition = compileMaigretRow(rowId, raw, rowSha256, engines);
      if (disposition.ok) {
        rules.push({ ruleId: publicRuleId(disposition.rule.sourceRef, templateKey(disposition.rule)), ...disposition.rule });
      } else {
        exclusions.push({ rowId, rowSha256, reason: disposition.reason });
      }
    }
  } else {
    const sites = root.sites;
    if (!Array.isArray(sites)) {
      throw new PublicRuleBundleError('invalid_shape', 'whatsmyname: sites must be an array');
    }
    if (sites.length === 0) {
      throw new PublicRuleBundleError('invalid_shape', 'whatsmyname: sites collection is empty (a full import is required)');
    }
    const nameCounts = new Map<string, number>();
    for (const raw of sites) {
      const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name.trim() : '';
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const seenNames = new Map<string, number>();
    sites.forEach((raw, index) => {
      const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name.trim() : '';
      const seen = (seenNames.get(name) ?? 0) + 1;
      seenNames.set(name, seen);
      // Row identity is the upstream site name; duplicate names disambiguate
      // deterministically instead of collapsing.
      const rowId = name.length === 0
        ? `row-${String(index).padStart(4, '0')}`
        : (nameCounts.get(name) ?? 0) > 1
          ? `${name}#${seen}`
          : name;
      const rowSha256 = sha256Hex(canonicalJson(raw));
      const disposition = compileWmnRow(rowId, raw, rowSha256);
      if (disposition.ok) {
        rules.push({ ruleId: publicRuleId(disposition.rule.sourceRef, templateKey(disposition.rule)), ...disposition.rule });
      } else {
        exclusions.push({ rowId, rowSha256, reason: disposition.reason });
      }
    });
  }

  if (input.manifest.recordCount !== undefined) {
    const actual = rules.length + exclusions.length;
    if (input.manifest.recordCount !== actual) verification.mismatch.push('record_count');
  }
  verification.byteHashVerified = verification.mismatch.length === 0;

  rules.sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
  exclusions.sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));

  const exclusionsByReason: Partial<Record<PublicRuleExclusionReason, number>> = {};
  for (const receipt of exclusions) {
    exclusionsByReason[receipt.reason] = (exclusionsByReason[receipt.reason] ?? 0) + 1;
  }

  const source: PublicRuleSourceRecord = {
    sourceId: input.sourceId,
    kind: input.kind,
    repository: input.manifest.repository,
    sourceUrl: input.manifest.sourceUrl,
    commit: input.manifest.commit,
    retrievedAt: input.manifest.retrievedAt,
    contentHash,
    bytes: input.bytes.byteLength,
    license: input.manifest.license,
    licenseUrl: input.manifest.licenseUrl,
    licenseHash: sha256Hex(licenseText),
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    counts: { raw: rules.length + exclusions.length, loaded: rules.length, excluded: exclusions.length },
    exclusionsByReason
  };

  return {
    schemaVersion: PUBLIC_RULES_SCHEMA_VERSION,
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    sourceId: input.sourceId,
    source,
    rules,
    exclusions,
    counts: source.counts,
    verification
  };
}

function templateKey(rule: Omit<PublicDiscoveryRule, 'ruleId'> | PublicDiscoveryRule): string {
  return `${rule.canonicalProfileTemplate}\n${rule.requestTemplate}\n${JSON.stringify(rule.detection)}`;
}

/* ------------------------------------------------------------------ */
/* mergePublicRules                                                    */
/* ------------------------------------------------------------------ */

export function mergePublicRules(
  imports: PublicRuleImport[],
  options: { knownTemplates: Map<string, string> }
): PublicRuleUnion {
  const rules = imports
    .flatMap((imported) => imported.rules)
    .sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
  const groups = publicRuleUnionGroups(rules, options.knownTemplates);
  const seen = new Set<string>();
  for (const group of groups) {
    if (seen.has(group.platformId)) {
      fail('platform_id_collision', `union produced duplicate platform id ${group.platformId}`);
    }
    seen.add(group.platformId);
  }
  const counts: PublicRuleUnionCounts = {
    sourceRows: imports.reduce((total, imported) => total + imported.counts.raw, 0),
    loaded: rules.length,
    excluded: imports.reduce((total, imported) => total + imported.counts.excluded, 0),
    unionPlatforms: new Set(groups.map((group) => group.platformId)).size,
    unionInstances: groups.length,
    unionRoutes: groups.reduce((total, group) => total + group.requestTemplates.length, 0),
    generatedPlatforms: groups.filter((group) => group.knownPlatformId === null).length,
    knownMappedGroups: groups.filter((group) => group.knownPlatformId !== null).length
  };
  return {
    schemaVersion: PUBLIC_RULES_SCHEMA_VERSION,
    importerVersion: PUBLIC_RULE_IMPORTER_VERSION,
    rules,
    groups,
    counts
  };
}

/* ------------------------------------------------------------------ */
/* Known platform mapping (explicit exact templates only)              */
/* ------------------------------------------------------------------ */

/**
 * Map canonical profile templates to curated platform ids — EXACT template
 * equality only. Display names and TLDs never map a rule onto a platform.
 */
export function knownPlatformTemplateMap(entries: Array<{ platformId: string; profileUrlRule: string | null }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.profileUrlRule === null) continue;
    const canonical = canonicalPublicTemplate(entry.profileUrlRule);
    if (canonical === null) continue;
    const existing = map.get(canonical);
    if (existing !== undefined && existing !== entry.platformId) {
      fail('known_template_conflict', `template ${canonical} maps to both ${existing} and ${entry.platformId}`);
    }
    map.set(canonical, entry.platformId);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Union → catalog entries                                             */
/* ------------------------------------------------------------------ */

const PUBLIC_RULE_COST_BASIS =
  '来源公共规则数据集未记录费用，金额保持 null（null 不等于免费）；执行属独立受限执行器，未产生费用回执';

function publicRuleCost(): CatalogCost {
  return {
    provider: null,
    unit: null,
    currency: null,
    amount: null,
    asOf: null,
    source: null,
    basis: PUBLIC_RULE_COST_BASIS,
    conditions: null
  };
}

const NOT_WIRED_NOTE =
  'GET-91 独立受限执行器离线可用（未接入 legacy 探测/研究运行时与模型工具面；接入属 GET-63）；未 live 验证';

/**
 * Materialize catalog entries for union groups WITHOUT a curated platform.
 * Known-mapped groups never create duplicate entries: their rules link to the
 * curated platform id through the shared rule ids / source refs instead.
 */
export function publicRuleCatalogEntries(union: PublicRuleUnion, sources: CatalogSourceManifest[]): CatalogEntry[] {
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const entries: CatalogEntry[] = [];
  for (const group of union.groups) {
    if (group.knownPlatformId !== null) continue;
    for (const sourceId of group.sourceIds) {
      if (!sourceIds.has(sourceId)) fail('source_ref', `union references unknown source ${sourceId}`);
    }
    const routes: DiscoveryRoute[] = group.requestTemplates.map((requestTemplate, index) => {
      const requestRules = group.rules.filter((rule) => rule.requestTemplate === requestTemplate);
      const ruleIds = requestRules.map((rule) => rule.ruleId).sort();
      // Route provenance names exactly the sources of THIS request's rules,
      // not the whole group's sources.
      const sourceRefs = [...new Set(requestRules.map((rule) => rule.sourceRef.sourceId))].sort();
      const bounded = requestRules.some((rule) => rule.detection.boundedPositive);
      return {
        routeId: `prr-${hash12(`${group.groupId}\n${requestTemplate}`)}`,
        kind: 'username_probe',
        operation: `public-rule:route-${hash12(`${group.groupId}:${index}`)}`,
        adapterId: null,
        endpoint: requestTemplate,
        requires: ['public_network'],
        availability: bounded ? 'not_integrated' : 'unsupported',
        reason: bounded
          ? 'GET-91 独立受限执行器（离线验证）可执行该受限检测，但尚未接入 legacy 发现运行时（接入属 GET-63）'
          : '规则缺少受限正向判定（status-only / redirect 语义），显式记 unsupported，不产出候选',
        sourceRefs,
        ruleIds
      };
    });

    const capability = (args: {
      dimension: CapabilityRecord['dimension'];
      documentation: CapabilityRecord['documentation'];
      endpoints: string[];
      sourceLocator: string | null;
      access: CapabilityRecord['access'];
      notes?: string[];
      comments?: CapabilityRecord['comments'];
      pagination?: CapabilityRecord['pagination'];
    }): CapabilityRecord => ({
      dimension: args.dimension,
      documentation: args.documentation,
      docUrls: [],
      endpoints: args.endpoints,
      sourceLocator: args.sourceLocator,
      integration: 'not_integrated',
      access: args.access,
      verification: 'documented_only',
      verificationRef: null,
      cost: publicRuleCost(),
      sourceRefs: group.sourceIds,
      operations: [],
      notes: args.notes ?? [NOT_WIRED_NOTE],
      ...(args.comments ? { comments: args.comments } : {}),
      ...(args.pagination ? { pagination: args.pagination } : {})
    });

    const firstRule = group.rules[0] as PublicDiscoveryRule;
    const locator = `public-rule:${firstRule.sourceRef.sourceId}:${firstRule.sourceRef.rowId}`;
    const homepage = `https://${group.instanceHost}`;

    entries.push({
      platformId: group.platformId,
      name: group.name,
      cohort: 'public_rule',
      aliases: [],
      homepage,
      profileUrlRule: group.canonicalProfileTemplate,
      instance: 'none',
      inputKinds: ['username'],
      accountKinds: ['unknown'],
      applicability: { authorizations: [], conditions: [] },
      capabilities: [
        capability({
          dimension: 'discovery',
          documentation: 'documented',
          endpoints: [...group.requestTemplates],
          sourceLocator: locator,
          access: 'public'
        }),
        capability({
          dimension: 'profile',
          documentation: 'documented',
          endpoints: [group.canonicalProfileTemplate],
          sourceLocator: locator,
          access: 'unknown'
        }),
        capability({ dimension: 'list', documentation: 'unknown', endpoints: [], sourceLocator: null, access: 'unknown' }),
        capability({ dimension: 'body', documentation: 'unknown', endpoints: [], sourceLocator: null, access: 'unknown' }),
        capability({ dimension: 'media', documentation: 'unknown', endpoints: [], sourceLocator: null, access: 'unknown' }),
        capability({
          dimension: 'comments',
          documentation: 'unknown',
          endpoints: [],
          sourceLocator: null,
          access: 'unknown',
          comments: { authorReplies: 'unknown', parentChain: 'unknown' }
        }),
        capability({
          dimension: 'pagination',
          documentation: 'unknown',
          endpoints: [],
          sourceLocator: null,
          access: 'unknown',
          pagination: { cursor: 'unknown', sortOptions: null, dateRange: 'unknown' }
        })
      ],
      routes,
      legacy: null,
      notes: [`公共规则来源站点（${group.sourceIds.join('/')}）；账号类型来源未标注，记 unknown`]
    });
  }
  return entries;
}

function hash12(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Bundle loading (data/platforms/public-rules)                        */
/* ------------------------------------------------------------------ */

export interface PublicRuleBundle {
  schemaVersion: string;
  importerVersion: string;
  generatedAt: string;
  /** sha256 of the exact manifest bytes (covers every pinned artifact hash). */
  manifestHash: string;
  sources: PublicRuleSourceRecord[];
  rules: PublicDiscoveryRule[];
  exclusionsBySource: PublicRuleSourceExclusions[];
  counts: { sourceRows: number; loaded: number; excluded: number };
}

interface PublicRuleManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Load and VERIFY the compiled bundle: every file listed in the manifest must
 * exist with its exact byte hash. A tampered bundle is refused, never
 * silently repaired.
 */
export function loadPublicRuleBundle(dataDir: string): PublicRuleBundle {
  const bundleDir = path.join(dataDir, 'public-rules');
  const manifestPath = path.join(bundleDir, 'manifest.json');
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail('manifest_invalid', `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(manifestRaw)) fail('manifest_invalid', 'public rule manifest must be an object');
  if (manifestRaw.schemaVersion !== PUBLIC_RULES_MANIFEST_SCHEMA_VERSION) {
    fail('schema_version', `public rule manifest schema ${String(manifestRaw.schemaVersion)}`);
  }
  const files = manifestRaw.files;
  if (!Array.isArray(files) || files.length === 0) fail('manifest_invalid', 'public rule manifest must list files');
  const PUBLIC_INVENTORY = new Set([
    'rules.json',
    'exclusions.json',
    'maigret-NOTICE.md',
    'maigret-LICENSE.txt',
    'whatsmyname-NOTICE.md',
    'whatsmyname-LICENSE.txt',
    'LICENSE-DATASETS.md'
  ]);
  const byPath = new Map<string, PublicRuleManifestFile>();
  for (const item of files) {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || typeof item.bytes !== 'number') {
      fail('manifest_invalid', 'public rule manifest file entries need path/sha256/bytes');
    }
    // Exact safe allowlist: no traversal, no duplicates, no unknown names.
    if (item.path !== path.basename(item.path) || item.path.includes('..') || item.path.startsWith('/') || item.path.includes('\\')) {
      fail('manifest_invalid', `public rule manifest path must be a plain safe file name: ${item.path}`);
    }
    if (!PUBLIC_INVENTORY.has(item.path)) {
      fail('manifest_invalid', `public rule manifest pins an unknown file: ${item.path}`);
    }
    if (byPath.has(item.path)) {
      fail('manifest_invalid', `public rule manifest pins a duplicate file: ${item.path}`);
    }
    const target = path.join(bundleDir, item.path);
    if (!existsSync(target)) fail('file_missing', `required public rule file missing: ${item.path}`);
    const bytes = readFileSync(target);
    if (bytes.byteLength !== item.bytes) fail('file_hash_mismatch', `public rule file ${item.path} byte length changed`);
    const hash = sha256Hex(bytes);
    if (hash !== item.sha256) fail('file_hash_mismatch', `public rule file ${item.path} sha256 mismatch`);
    byPath.set(item.path, { path: item.path, sha256: item.sha256, bytes: item.bytes });
  }
  for (const required of ['rules.json', 'exclusions.json', 'LICENSE-DATASETS.md']) {
    if (!byPath.has(required)) fail('manifest_invalid', `public rule manifest must pin ${required}`);
  }
  const rulesDoc = JSON.parse(readFileSync(path.join(bundleDir, 'rules.json'), 'utf8'));
  const exclusionsDoc = JSON.parse(readFileSync(path.join(bundleDir, 'exclusions.json'), 'utf8'));
  if (!isRecord(rulesDoc) || rulesDoc.schemaVersion !== PUBLIC_RULES_SCHEMA_VERSION || !Array.isArray(rulesDoc.rules)) {
    fail('invalid_shape', 'rules.json must carry schemaVersion and rules array');
  }
  if (!isRecord(exclusionsDoc) || exclusionsDoc.schemaVersion !== PUBLIC_RULES_SCHEMA_VERSION || !Array.isArray(exclusionsDoc.sources)) {
    fail('invalid_shape', 'exclusions.json must carry schemaVersion and per-source exclusions');
  }
  const rules = rulesDoc.rules.map((raw: unknown, index: number) => validateRuleShape(raw, `rules[${index}]`));
  const exclusionsBySource = exclusionsDoc.sources.map((group: unknown, groupIndex: number) => {
    if (!isRecord(group) || (group.sourceId !== 'maigret' && group.sourceId !== 'whatsmyname') || !Array.isArray(group.exclusions)) {
      fail('invalid_shape', `exclusions.sources[${groupIndex}] must carry sourceId and exclusions`);
    }
    const exclusions = group.exclusions.map((raw: unknown, index: number) => {
      if (!isRecord(raw)) fail('invalid_shape', `exclusions[${groupIndex}][${index}] must be an object`);
      const keys = Object.keys(raw).sort().join(',');
      if (keys !== 'reason,rowId,rowSha256') {
        fail('invalid_shape', `exclusions[${groupIndex}][${index}] must carry exactly rowId/rowSha256/reason`);
      }
      if (typeof raw.rowId !== 'string' || typeof raw.rowSha256 !== 'string' || typeof raw.reason !== 'string') {
        fail('invalid_shape', `exclusions[${groupIndex}][${index}] values must be strings`);
      }
      return raw as unknown as PublicRuleExclusion;
    });
    return { sourceId: group.sourceId as PublicRuleSourceId, exclusions };
  });
  const sourcesRaw = manifestRaw.sources;
  if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) fail('manifest_invalid', 'public rule manifest must record sources');
  const sources = sourcesRaw.map((raw, index) => {
    if (!isRecord(raw)) fail('invalid_shape', `sources[${index}] must be an object`);
    return raw as unknown as PublicRuleSourceRecord;
  });
  const seenSources = new Set<string>();
  for (const source of sources) {
    if (seenSources.has(source.sourceId)) fail('invalid_shape', `duplicate source id ${source.sourceId}`);
    seenSources.add(source.sourceId);
    if (typeof source.counts?.raw !== 'number' || typeof source.counts.loaded !== 'number' || typeof source.counts.excluded !== 'number') {
      fail('invalid_shape', `source ${source.sourceId} must carry raw/loaded/excluded counts`);
    }
    if (source.counts.raw !== source.counts.loaded + source.counts.excluded) {
      fail('invalid_shape', `source ${source.sourceId} counts must reconcile raw = loaded + excluded`);
    }
    if (typeof source.licenseHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.licenseHash)) {
      fail('invalid_shape', `source ${source.sourceId} must pin its license hash`);
    }
    // Per-source LICENSE and NOTICE artifacts are REQUIRED and hash-bound.
    for (const artifact of [source.notice, source.licenseFile]) {
      if (typeof artifact !== 'string' || artifact.length === 0) {
        fail('invalid_shape', `source ${source.sourceId} must reference its notice and license artifacts`);
      }
      if (!byPath.has(artifact)) {
        fail('manifest_invalid', `public rule manifest must pin source artifact ${artifact}`);
      }
    }
    const licenseBytes = readFileSync(path.join(bundleDir, source.licenseFile as string));
    if (sha256Hex(licenseBytes) !== source.licenseHash) {
      fail('file_hash_mismatch', `source ${source.sourceId} licenseHash does not match ${String(source.licenseFile)}`);
    }
  }
  const countsRaw = manifestRaw.counts;
  const counts = isRecord(countsRaw) && typeof countsRaw.sourceRows === 'number' && typeof countsRaw.loaded === 'number' && typeof countsRaw.excluded === 'number'
    ? { sourceRows: countsRaw.sourceRows, loaded: countsRaw.loaded, excluded: countsRaw.excluded }
    : fail('manifest_invalid', 'public rule manifest must reconcile counts');
  if (counts.sourceRows !== counts.loaded + counts.excluded) {
    fail('manifest_invalid', 'public rule manifest counts must reconcile raw = loaded + excluded');
  }
  if (counts.loaded !== rules.length || counts.excluded !== exclusionsBySource.reduce((total, group) => total + group.exclusions.length, 0)) {
    fail('manifest_invalid', 'public rule manifest counts must match the rule/exclusion files');
  }
  // Per-source counts must match the ACTUAL rule/exclusion sets (no silent
  // redistribution between sources); rule ids and row identities stay unique.
  const ruleIds = new Set<string>();
  const rowKeys = new Set<string>();
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  for (const rule of rules) {
    if (ruleIds.has(rule.ruleId)) fail('invalid_shape', `duplicate rule id ${rule.ruleId}`);
    ruleIds.add(rule.ruleId);
    if (!sourceIds.has(rule.sourceRef.sourceId)) {
      fail('invalid_shape', `rule ${rule.ruleId} references unknown source ${rule.sourceRef.sourceId}`);
    }
    const rowKey = `${rule.sourceRef.sourceId}:${rule.sourceRef.rowId}`;
    if (rowKeys.has(rowKey)) fail('invalid_shape', `duplicate source row ${rowKey}`);
    rowKeys.add(rowKey);
  }
  for (const group of exclusionsBySource) {
    if (!sourceIds.has(group.sourceId)) fail('invalid_shape', `exclusions reference unknown source ${group.sourceId}`);
    for (const receipt of group.exclusions) {
      const rowKey = `${group.sourceId}:${receipt.rowId}`;
      if (rowKeys.has(rowKey)) fail('invalid_shape', `duplicate source row ${rowKey}: loaded and excluded`);
      rowKeys.add(rowKey);
    }
  }
  for (const source of sources) {
    const loaded = rules.filter((rule) => rule.sourceRef.sourceId === source.sourceId).length;
    const excluded = exclusionsBySource.find((group) => group.sourceId === source.sourceId)?.exclusions.length ?? 0;
    if (loaded !== source.counts.loaded || excluded !== source.counts.excluded) {
      fail(
        'invalid_shape',
        `source ${source.sourceId} counts do not match its actual rules (${loaded} vs ${source.counts.loaded}) and exclusions (${excluded} vs ${source.counts.excluded})`
      );
    }
  }
  return {
    schemaVersion: String(manifestRaw.schemaVersion),
    importerVersion: String(manifestRaw.importerVersion),
    generatedAt: String(manifestRaw.generatedAt),
    manifestHash: sha256Hex(readFileSync(manifestPath)),
    sources,
    rules,
    exclusionsBySource,
    counts
  };
}

const RULE_ID_RE = /^pr-[0-9a-f]{16}$/;

function validateRuleShape(raw: unknown, where: string): PublicDiscoveryRule {
  if (!isRecord(raw)) fail('invalid_shape', `${where} must be an object`);
  const ruleId = typeof raw.ruleId === 'string' ? raw.ruleId : fail('invalid_shape', `${where}.ruleId`);
  if (!RULE_ID_RE.test(ruleId)) fail('invalid_shape', `${where}.ruleId must be pr-<16 hex>`);
  const sourceRef = raw.sourceRef;
  if (!isRecord(sourceRef) || typeof sourceRef.rowId !== 'string' || sourceRef.rowId.length === 0 || sourceRef.rowId.length > 300 || typeof sourceRef.rowSha256 !== 'string') {
    fail('invalid_shape', `${where}.sourceRef must carry rowId and rowSha256`);
  }
  if (!/^[0-9a-f]{64}$/.test(sourceRef.rowSha256)) fail('invalid_shape', `${where}.sourceRef.rowSha256 must be a sha256 hex digest`);
  if (sourceRef.sourceId !== 'maigret' && sourceRef.sourceId !== 'whatsmyname') {
    fail('invalid_shape', `${where}.sourceRef.sourceId`);
  }
  const canonicalProfileTemplate = typeof raw.canonicalProfileTemplate === 'string' ? raw.canonicalProfileTemplate : '';
  const requestTemplate = typeof raw.requestTemplate === 'string' ? raw.requestTemplate : '';
  if (canonicalPublicTemplate(canonicalProfileTemplate) !== canonicalProfileTemplate) {
    fail('invalid_shape', `${where}.canonicalProfileTemplate is not canonical https`);
  }
  if (canonicalPublicTemplate(requestTemplate) !== requestTemplate) {
    fail('invalid_shape', `${where}.requestTemplate is not canonical https`);
  }
  if (usernamePlaceholderCount(requestTemplate) < 1 || usernamePlaceholderCount(canonicalProfileTemplate) < 1) {
    fail('invalid_shape', `${where}: request and profile templates must keep their account placeholder`);
  }
  // The loader independently refuses credential-bearing templates even when
  // the manifest hashes were recomputed.
  if (templateHasCredentialQuery(requestTemplate) || templateHasCredentialQuery(canonicalProfileTemplate)) {
    fail('credential_bearing_template', `${where}: request/profile templates must not carry credential-bearing query parameters`);
  }
  const instanceHost = typeof raw.instanceHost === 'string' ? raw.instanceHost : '';
  if (instanceHost.length === 0 || instanceHost !== instanceHost.toLowerCase()) {
    fail('invalid_shape', `${where}.instanceHost must be a normalized host`);
  }
  // The instance host must be DERIVED from the canonical profile template —
  // never an unrelated value silently accepted.
  const profileHost = canonicalTemplateHost(canonicalProfileTemplate);
  if (instanceHost !== profileHost) {
    fail('invalid_shape', `${where}.instanceHost must equal the canonical profile template host (${profileHost})`);
  }
  const detection = raw.detection;
  if (!isRecord(detection)) fail('invalid_shape', `${where}.detection`);
  if (!['bounded_strings', 'status_only', 'url_redirect'].includes(String(detection.kind))) {
    fail('invalid_shape', `${where}.detection.kind`);
  }
  for (const key of ['presentStatus', 'absentStatus'] as const) {
    const value = detection[key];
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599)) {
      fail('invalid_shape', `${where}.detection.${key} must be null or an HTTP status`);
    }
  }
  for (const key of ['presentAny', 'nonProofPresentAny', 'absentAny'] as const) {
    const list = detection[key];
    if (!Array.isArray(list)) fail('invalid_shape', `${where}.detection.${key}`);
    for (const marker of list) {
      if (typeof marker !== 'string' || marker.trim().length === 0 || marker.length > PUBLIC_MARKER_MAX_LENGTH) {
        fail('invalid_shape', `${where}.detection.${key} markers must be non-empty bounded literals`);
      }
    }
  }
  const boundedPositive = detection.boundedPositive;
  const boundedNegative = detection.boundedNegative;
  if (typeof boundedPositive !== 'boolean' || typeof boundedNegative !== 'boolean') {
    fail('invalid_shape', `${where}.detection bounded flags are required`);
  }
  const presentAny = detection.presentAny as unknown[];
  const nonProofPresentAny = detection.nonProofPresentAny as unknown[];
  const absentAny = detection.absentAny as unknown[];
  if (boundedPositive !== (presentAny.length > 0)) {
    fail('invalid_shape', `${where}.detection.boundedPositive must match its bounded presence markers`);
  }
  // Negative proof = declared absence literals, or a declared NON-success
  // absence status. A bare 2xx absence status is never bounded proof.
  const nonSuccessAbsenceStatus =
    detection.absentStatus !== null && !(Number(detection.absentStatus) >= 200 && Number(detection.absentStatus) < 300);
  if (boundedNegative !== (absentAny.length > 0 || nonSuccessAbsenceStatus)) {
    fail('invalid_shape', `${where}.detection.boundedNegative must match its declared absence proof`);
  }
  if (detection.kind === 'url_redirect' && (boundedPositive || boundedNegative)) {
    fail('invalid_shape', `${where}.detection url_redirect rules stay unbounded`);
  }
  for (const marker of presentAny as string[]) {
    if (typeof marker === 'string' && isGenericLoginMarker(marker)) {
      fail('invalid_shape', `${where}.detection.presentAny must not carry generic login-form literals (use nonProofPresentAny)`);
    }
  }
  const ratePerMinute = raw.ratePerMinute;
  if (ratePerMinute !== null && (typeof ratePerMinute !== 'number' || !Number.isInteger(ratePerMinute) || ratePerMinute < 1 || ratePerMinute > 60_000)) {
    fail('invalid_shape', `${where}.ratePerMinute must be null or a positive integer`);
  }
  const readBoundedList = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value)) fail('invalid_shape', `${where}.${field}`);
    return value.map((item) => {
      if (typeof item !== 'string' || item.trim().length === 0 || item.length > PUBLIC_MARKER_MAX_LENGTH) {
        fail('invalid_shape', `${where}.${field} entries must be bounded literals`);
      }
      return item;
    });
  };
  const safeHeaders = raw.safeHeaders;
  if (!isRecord(safeHeaders)) fail('invalid_shape', `${where}.safeHeaders`);
  for (const key of Object.keys(safeHeaders)) {
    if (!SAFE_RULE_HEADERS.includes(key)) fail('invalid_shape', `${where}.safeHeaders.${key} is not a safe literal header`);
    const value = safeHeaders[key];
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > PUBLIC_MARKER_MAX_LENGTH) {
      fail('invalid_shape', `${where}.safeHeaders.${key} must be a bounded literal value`);
    }
  }
  if (raw.caseSensitive !== true) {
    fail('invalid_shape', `${where}.caseSensitive must be true (literal matching policy); unsupported values are refused, never rewritten`);
  }
  return {
    ruleId,
    sourceRef: sourceRef as unknown as PublicDiscoveryRule['sourceRef'],
    sourceName: typeof raw.sourceName === 'string' && raw.sourceName.length > 0 ? raw.sourceName : fail('invalid_shape', `${where}.sourceName`),
    canonicalProfileTemplate,
    requestTemplate,
    instanceHost,
    accountKind: raw.accountKind === 'unknown' ? 'unknown' : fail('invalid_shape', `${where}.accountKind`),
    detection: detection as unknown as PublicDetection,
    caseSensitive: true,
    ratePerMinute: ratePerMinute as number | null,
    protections: readBoundedList(raw.protections ?? [], 'protections'),
    errorMarkers: readBoundedList(raw.errorMarkers ?? [], 'errorMarkers'),
    safeHeaders: safeHeaders as Record<string, string>
  };
}

/** Union from a verified bundle + explicit known exact-template map. */
export function unionFromBundle(bundle: PublicRuleBundle, knownTemplates: Map<string, string>): PublicRuleUnion {
  return mergePublicRules(
    [
      {
        schemaVersion: PUBLIC_RULES_SCHEMA_VERSION,
        importerVersion: bundle.importerVersion,
        sourceId: 'maigret',
        source: bundle.sources[0] as PublicRuleSourceRecord,
        rules: bundle.rules,
        exclusions: bundle.exclusionsBySource.flatMap((group) => group.exclusions),
        counts: { raw: bundle.counts.sourceRows, loaded: bundle.counts.loaded, excluded: bundle.counts.excluded },
        verification: { byteHashVerified: true, mismatch: [] }
      }
    ],
    { knownTemplates }
  );
}

/* ------------------------------------------------------------------ */
/* Attribution notices                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extract the REQUIRED Copyright line from fixed license text (handles CRLF
 * and blank lines). A license without a Copyright line blocks attribution —
 * never a blank "Copyright:" line or a guessed array position.
 */
export function extractRequiredCopyright(licenseText: string): string {
  for (const rawLine of licenseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^copyright\s*[\(\u00a9]?/i.test(line) && line.toLowerCase().startsWith('copyright')) {
      return line;
    }
  }
  return fail('license_missing_copyright', 'license text carries no Copyright line for the required attribution');
}

/** Per-source derived-dataset notice (no trailing whitespace on any line). */
export function buildSourceNotice(args: {
  sourceId: PublicRuleSourceId;
  source: PublicRuleSourceRecord;
  copyrightLine: string;
  licenseFile: string;
}): string {
  const { source, copyrightLine, licenseFile } = args;
  const lines = [
    `# ${args.sourceId} derived dataset notice`,
    '',
    `- Upstream project: ${source.repository}`,
    `- Pinned source: ${source.sourceUrl}`,
    `- Pinned commit: ${source.commit}`,
    `- Retrieved (pinned manifest): ${source.retrievedAt}`,
    `- Source bytes: ${source.bytes} bytes, sha256 \`${source.contentHash}\``,
    `- Importer: ${source.importerVersion}`,
    `- Rows: raw ${source.counts.raw} = loaded ${source.counts.loaded} + excluded ${source.counts.excluded}`,
    '',
    `Copyright: ${copyrightLine}`,
    '',
    `License: ${source.license} - ${source.licenseUrl}`,
    `The exact license text captured at the pinned commit is in \`${licenseFile}\`.`,
    '',
    'Modifications: this directory contains a DERIVED DATASET, not the upstream',
    'dataset. The importer normalized request/profile templates, kept only bounded',
    'detection predicates (literal markers and documented status codes), replaced',
    'source row ids with row hashes for exclusions, dropped raw username examples,',
    'descriptions, third-party full text and all header/token values, and excluded',
    'inadmissible rows with explicit per-row reasons (`exclusions.json`). No',
    'upstream code is copied. Redistribution of these derived data files stays under',
    `${source.license} terms; see \`LICENSE-DATASETS.md\`.`
  ];
  return `${lines.join('\n')}\n`;
}
