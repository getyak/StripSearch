/**
 * GET-91 shared contract: normalized public account discovery rules
 * ("public-rules/v1").
 *
 * The two pinned public rule datasets (Maigret MIT, WhatsMyName CC BY-SA 4.0)
 * are compiled into RESTRICTED DATA — never code. A rule carries:
 *
 * - a deterministic ASCII rule id and its source row reference (row id +
 *   row hash) so every normalized rule stays traceable to its pinned row;
 * - a canonical HTTPS request template and canonical profile template with
 *   exactly one supported placeholder (`{username}`); instance hosts are
 *   pinned inside the template;
 * - a detection predicate that names its bounded proof explicitly. Only
 *   bounded literal markers (with their documented status codes) can ever
 *   decide `candidate` / `checked_no_match`; status-only and redirect
 *   semantics are marked unbounded and evaluate to explicit `unknown`.
 *
 * Merge rules (see `publicRuleUnionGroups`): rules merge into one union group
 * ONLY on the exact canonical profile template + instance host + account
 * kind. Differing predicates stay independent rules that share one response
 * request. Known platforms are joined only through EXACT canonical profile
 * templates (never display name or TLD). Unknown sites get deterministic
 * hash ids — never `normalizePlatformId`-style collapses.
 *
 * This module is dependency-free (pure data + URL canonicalization) so the
 * client, server and tests share one authority for the shapes. Hashing and
 * id derivation live in `server/platforms/public-rules.ts`.
 */

export const PUBLIC_RULES_SCHEMA_VERSION = 'stripsearch/public-rules/v1';
export const PUBLIC_RULES_MANIFEST_SCHEMA_VERSION = 'stripsearch/public-rules-manifest/v1';
/** Importer identity recorded in manifests; bumped on semantics changes. */
export const PUBLIC_RULE_IMPORTER_VERSION = 'get91-public-rule-importer/1';

/** Literal markers longer than this are refused instead of evaluated. */
export const PUBLIC_MARKER_MAX_LENGTH = 200;

export type PublicRuleSourceId = 'maigret' | 'whatsmyname';
export type PublicRuleSourceKind = 'maigret_sites' | 'whatsmyname_sites';

/** Traceable provenance: which pinned source row produced a rule/receipt. */
export interface PublicRuleSourceRef {
  sourceId: PublicRuleSourceId;
  rowId: string;
  /** sha256 hex over the canonical JSON of the raw source row. */
  rowSha256: string;
}

export type PublicDetectionKind = 'bounded_strings' | 'status_only' | 'url_redirect';

/**
 * Restricted detection predicate (data only):
 *
 * - `presentStatus` / `presentAny`: bounded positive proof — expected status
 *   (when the source documents one) AND at least one literal body marker.
 *   A 200 without a marker is never positive proof.
 * - `absentStatus` / `absentAny`: bounded negative proof — documented absence
 *   response (status and/or literal marker).
 * - `boundedPositive` / `boundedNegative`: whether that side has bounded
 *   proof at all. `status_only` and `url_redirect` rules have no bounded
 *   positive proof; a redirect is never account identity.
 */
export interface PublicDetection {
  kind: PublicDetectionKind;
  presentStatus: number | null;
  /** Bounded positive proof literals (never generic login-form phrases). */
  presentAny: string[];
  /**
   * Source literals preserved verbatim as metadata that can NEVER prove an
   * account (generic login-form phrases like `LOGIN` / `data-template="login"`
   * match login walls, not accounts).
   */
  nonProofPresentAny: string[];
  absentStatus: number | null;
  absentAny: string[];
  boundedPositive: boolean;
  boundedNegative: boolean;
}

export type PublicRuleAccountKind = 'unknown';

/** One normalized public discovery rule. Data only: no code, no regex. */
export interface PublicDiscoveryRule {
  /** Deterministic ASCII id, `pr-<16 hex>`. */
  ruleId: string;
  sourceRef: PublicRuleSourceRef;
  /** Upstream display name of the site (public platform name). */
  sourceName: string;
  /** Canonical profile URL template, exactly one `{username}` placeholder. */
  canonicalProfileTemplate: string;
  /** Canonical HTTPS request template actually fetched (may differ). */
  requestTemplate: string;
  /** Host pinned inside the templates; instance-scoped hosts stay distinct. */
  instanceHost: string;
  accountKind: PublicRuleAccountKind;
  detection: PublicDetection;
  /** Literal matching is case-sensitive (documented normalized semantics). */
  caseSensitive: true;
  /** Sources record no request rate bound; unknown stays null (never 0). */
  ratePerMinute: number | null;
  /** Short upstream protection flags (captcha/cloudflare/...) for context. */
  protections: string[];
  /** Upstream error-page markers: a match is never a candidate. */
  errorMarkers: string[];
  /** Safe literal header subset only (never credentials or Host overrides). */
  safeHeaders: Record<string, string>;
}

export type PublicRuleExclusionReason =
  | 'malformed_record'
  | 'disabled_rule'
  | 'activation_required'
  | 'unsupported_method'
  | 'unsupported_id_kind'
  | 'unsupported_protocol'
  | 'unsupported_regex_predicate'
  | 'unsupported_similar_search'
  | 'unsupported_error_url'
  | 'unsupported_encoding'
  | 'unsafe_header'
  | 'unsupported_template'
  | 'non_https_template'
  | 'credential_bearing_template'
  | 'missing_template_substitution'
  | 'missing_account_placeholder'
  | 'missing_detection_predicate'
  | 'unsupported_check_type'
  | 'unsupported_marker_length'
  | 'unsupported_marker_value'
  | 'unsupported_post_body'
  | 'unsupported_username_transform';

/**
 * Exclusion receipt: row identity, row hash and an explicit reason ONLY.
 * No header values, tokens, usernames or raw source rows ever land here.
 * Source attribution is structural (receipts live under their source).
 */
export interface PublicRuleExclusion {
  rowId: string;
  rowSha256: string;
  reason: PublicRuleExclusionReason;
}

/** Exclusion receipts grouped under their pinned source. */
export interface PublicRuleSourceExclusions {
  sourceId: PublicRuleSourceId;
  exclusions: PublicRuleExclusion[];
}

export interface PublicRuleManifestFacts {
  repository: string;
  sourceUrl: string;
  commit: string;
  retrievedAt: string;
  license: string;
  licenseUrl: string;
  /** Optional pinned byte hash/count to verify the fixed input against. */
  sha256?: string;
  bytes?: number;
  recordCount?: number;
}

export interface PublicRuleSourceInput {
  sourceId: PublicRuleSourceId;
  kind: PublicRuleSourceKind;
  /** Fixed local source bytes. No network happens inside compilation. */
  bytes: Uint8Array;
  /** Exact upstream license text (required; missing license blocks import). */
  licenseText: string;
  manifest: PublicRuleManifestFacts;
}

export interface PublicRuleSourceRecord {
  sourceId: PublicRuleSourceId;
  kind: PublicRuleSourceKind;
  repository: string;
  sourceUrl: string;
  commit: string;
  retrievedAt: string;
  /** sha256 hex of the pinned source bytes actually compiled. */
  contentHash: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  /** sha256 hex of the exact license text used for attribution. */
  licenseHash: string;
  importerVersion: string;
  counts: { raw: number; loaded: number; excluded: number };
  exclusionsByReason: Partial<Record<PublicRuleExclusionReason, number>>;
  /** Bundle artifact file names (required in the shipped bundle manifest). */
  notice?: string;
  licenseFile?: string;
}

export interface PublicRuleImport {
  schemaVersion: string;
  importerVersion: string;
  sourceId: PublicRuleSourceId;
  source: PublicRuleSourceRecord;
  rules: PublicDiscoveryRule[];
  exclusions: PublicRuleExclusion[];
  counts: { raw: number; loaded: number; excluded: number };
  /**
   * Pinned-bytes verification: when the caller passes `sha256` / `bytes` /
   * `recordCount`, mismatches are reported here instead of silently ignored.
   */
  verification: { byteHashVerified: boolean; mismatch: string[] };
}

/** One union group = canonical profile template + instance host + account kind. */
export interface PublicRuleGroup {
  /** Deterministic ASCII id, `pug-<12 hex>`. */
  groupId: string;
  /** Catalog platform id: curated id when mapped, else `pub-<12 hex>`. */
  platformId: string;
  /** Curated platform id when an exact template match mapped the group. */
  knownPlatformId: string | null;
  name: string;
  instanceHost: string;
  accountKind: PublicRuleAccountKind;
  canonicalProfileTemplate: string;
  /** Distinct canonical request templates (one shared response each). */
  requestTemplates: string[];
  rules: PublicDiscoveryRule[];
  ruleIds: string[];
  sourceIds: PublicRuleSourceId[];
}

export interface PublicRuleUnionCounts {
  /** Raw source rows across all imported sources. */
  sourceRows: number;
  loaded: number;
  excluded: number;
  /** Distinct catalog platform ids covered by the union. */
  unionPlatforms: number;
  /** Distinct platform + instance pairs (= union groups). */
  unionInstances: number;
  /** Distinct request templates across groups (= shared response requests). */
  unionRoutes: number;
  generatedPlatforms: number;
  knownMappedGroups: number;
}

export interface PublicRuleUnion {
  schemaVersion: string;
  importerVersion: string;
  rules: PublicDiscoveryRule[];
  groups: PublicRuleGroup[];
  counts: PublicRuleUnionCounts;
}

/* ------------------------------------------------------------------ */
/* Canonical templates                                                 */
/* ------------------------------------------------------------------ */

const USERNAME_PLACEHOLDER = '{username}';
const SENTINEL = '__stripsearch_username__';

/**
 * Canonicalize a public profile/request template EXACTLY — path semantics
 * (including trailing slashes) and fragment locators are preserved, because
 * `/user/{username}` and `/user/{username}/` are different source requests:
 *
 * - `{account}` (WhatsMyName) canonicalizes to `{username}`;
 * - only https templates with a concrete host are canonicalizable —
 *   `{instance}`-style templates cannot be pinned and return null;
 * - scheme/host case is normalized (host case is not identity), path, query
 *   and fragment stay verbatim; the `{username}` placeholder must survive
 *   canonicalization unchanged (callers re-check the count afterwards).
 */
export function canonicalPublicTemplate(raw: string): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let template = raw.trim().replace(/\{account\}/g, USERNAME_PLACEHOLDER);
  if (template.includes('{urlMain}') || template.includes('{urlSubpath}') || template.includes('{instance}')) return null;
  const probe = template.replace(/\{username\}/g, SENTINEL);
  if (probe.includes('{') || probe.includes('}')) return null;
  let parsed: URL;
  try {
    parsed = new URL(probe);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0 || host.includes('{')) return null;
  const port = parsed.port === '443' || parsed.port === '' ? '' : `:${parsed.port}`;
  const canonical = `https://${host}${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return canonical.split(SENTINEL).join(USERNAME_PLACEHOLDER);
}

/** Count validated `{username}` occurrences in a template. */
export function usernamePlaceholderCount(template: string): number {
  return template.split(USERNAME_PLACEHOLDER).length - 1;
}

/**
 * Credential-bearing query parameter names (decoded, case-insensitive).
 * Templates carrying them are EXCLUDED before serialization — never stripped
 * and re-labelled as public. Legitimate username/profile query semantics
 * (id/user/username/q/tab/page/...) stay untouched.
 */
const CREDENTIAL_QUERY_PARAM =
  /^(api[_-]?)?(key|token|secret)$|^(access[_-]?token|auth|authorization|password|passwd|session|session[_-]?id|sid|client[_-]?secret|private[_-]?key|app[_-]?token|guest[_-]?token|api[_-]?secret|api[_-]?key)$/i;

/** True when the template's query carries a credential-bearing parameter. */
export function templateHasCredentialQuery(template: string): boolean {
  const hashIndex = template.indexOf('#');
  const queryIndex = template.indexOf('?');
  if (queryIndex < 0) return false;
  const query = template.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined);
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const rawName = eq >= 0 ? pair.slice(0, eq) : pair;
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
    if (CREDENTIAL_QUERY_PARAM.test(name.trim())) return true;
  }
  return false;
}

/** Host pinned inside a canonical template (instance identity). */
export function canonicalTemplateHost(canonicalTemplate: string): string {
  const host = new URL(canonicalTemplate.replace(/\{username\}/g, SENTINEL)).hostname.toLowerCase();
  return host;
}

/* ------------------------------------------------------------------ */
/* Union construction                                                  */
/* ------------------------------------------------------------------ */

export type PublicRuleGroupBuilder = (
  rules: PublicDiscoveryRule[],
  knownTemplates: Map<string, string>
) => PublicRuleGroup[];

export function publicRuleGroupKey(profile: string, instanceHost: string, accountKind: string): string {
  return `${profile}\n${instanceHost}\n${accountKind}`;
}

/**
 * Group rules into the union. Merging requires the EXACT canonical profile
 * template + instance host + account kind; display names and TLDs never
 * merge. Known platforms join only through the explicit exact-template map
 * (canonical template -> curated platform id).
 *
 * Id derivation is server-side (`publicRuleUnionGroups` in
 * `server/platforms/public-rules.ts`) so this shared contract stays pure.
 */
export interface PublicRuleGroupIds {
  groupId: string;
  platformId: string;
}
