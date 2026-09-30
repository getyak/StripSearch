/**
 * GET-90 platform catalog loader and projections.
 *
 * `loadPlatformCatalog(dataDir)` reads the versioned catalog data and
 * validates it strictly: manifest file hash, self content hash, duplicate
 * platform ids / conflicting aliases, source references and full shapes
 * (seven capability dimensions, enum values, price basis, verification
 * receipts, routes). A failure throws `CatalogLoadError` — the loader never
 * silently repairs or drops entries.
 *
 * One snapshot produces three explicit projections:
 *
 * - `toLegacyRegistry`  → old probe registry (`PlatformRule` shapes). It must
 *   keep every old rule's probe / posts / verification semantics byte-for-byte
 *   (asserted against `BUILTIN_PLATFORM_REGISTRY` in tests).
 * - `toCompletionRegistry` → GET-60 completion registry. Applicability follows
 *   input kinds + authorization policy only; no-adapter platforms stay in the
 *   frozen denominator with deterministic reasons.
 * - `toCapabilitySnapshot` → GET-59 capability snapshot with the exact
 *   supported/unsupported/unverified mapping of `capabilityStateFor`.
 *
 * Data paths are module-relative (or passed in), so the compiled server reads
 * the bundled `dist/data/platforms` copy outside the repository cwd.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITY_DIMENSIONS,
  PLATFORM_CATALOG_SCHEMA_VERSION,
  capabilityLimitation,
  capabilityStateFor
} from '../../shared/platform-catalog.js';
import type {
  CatalogAccessContext,
  CatalogApplicabilityInput,
  CatalogCost,
  CatalogEntry,
  CatalogGap,
  CatalogSourceManifest,
  CatalogSummary,
  CapabilityRecord,
  CompletionPlatformRegistry,
  DiscoveryRoute,
  LegacyPlatformRegistry,
  LegacyRuleCompat,
  PlatformCatalogSnapshot
} from '../../shared/platform-catalog.js';
import type { PlatformRule } from '../../shared/platform-discovery.js';
import { DEFAULT_THREAD_DEPTH } from '../../shared/research-completion.js';
import type { CapabilitySnapshot } from '../research/research-tool-dispatch.js';

export class CatalogLoadError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CatalogLoadError';
  }
}

/* ------------------------------------------------------------------ */
/* Hashing                                                             */
/* ------------------------------------------------------------------ */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

export function canonicalCatalogJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export interface CatalogContent {
  schemaVersion: string;
  registryVersion: string;
  generatedAt: string;
  sources: unknown;
  entries: unknown;
}

export function catalogContentHash(content: CatalogContent): string {
  const digest = createHash('sha256')
    .update(
      canonicalCatalogJson({
        schemaVersion: content.schemaVersion,
        registryVersion: content.registryVersion,
        generatedAt: content.generatedAt,
        sources: content.sources,
        entries: content.entries
      }),
      'utf8'
    )
    .digest('hex');
  return `sha256:${digest}`;
}

/* ------------------------------------------------------------------ */
/* Shape validation                                                    */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: string, detail: string): never {
  throw new CatalogLoadError(code, detail);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('invalid_shape', `${where} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, where: string): string | null {
  if (value === null) return null;
  return requireString(value, where);
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], where: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    fail('invalid_shape', `${where} must be one of ${values.join(', ')}`);
  }
  return value as T;
}

function requireStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail('invalid_shape', `${where} must be an array`);
  return value.map((item, index) => requireString(item, `${where}[${index}]`));
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

const COHORTS = ['tikhub', 'alternative', 'personal_website', 'legacy_only'] as const;
const INPUT_KINDS = ['username', 'email', 'homepage_url'] as const;
const INSTANCE_VALUES = ['required', 'optional', 'none'] as const;
const ACCOUNT_KINDS = ['person', 'publication', 'channel', 'organization', 'unknown'] as const;
const AUTHORIZATIONS = ['self', 'consent_obtained', 'public_professional'] as const;
const DOCUMENTATION = ['documented', 'not_documented', 'unknown'] as const;
const INTEGRATION = ['integrated', 'not_integrated', 'unsupported'] as const;
const ACCESS = ['public', 'credentials_required', 'authorization_required', 'inaccessible', 'unknown'] as const;
const VERIFICATION = ['documented_only', 'offline_verified', 'live_verified'] as const;
const ROUTE_KINDS = [
  'selflink', 'username_probe', 'platform_search', 'official_search',
  'site_search', 'wechat_search', 'import_report', 'none'
] as const;
const ROUTE_REQUIRES = ['public_network', 'provider_key', 'login', 'authorization', 'instance_hint'] as const;
const ROUTE_AVAILABILITY = ['integrated', 'not_integrated', 'unsupported', 'unknown'] as const;
const SOURCE_KINDS = [
  'provider_openapi', 'provider_pricing', 'official_documentation', 'public_rule_dataset', 'project_baseline'
] as const;
const SUPPORT = ['supported', 'unsupported', 'unknown'] as const;

function validateCost(raw: unknown, where: string): CatalogCost {
  if (!isRecord(raw)) fail('invalid_shape', `${where} must be an object`);
  const { amount, basis } = raw;
  if (amount !== null) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      fail('invalid_shape', `${where}.amount must be null (unknown) or a positive number`);
    }
  }
  const basisText = requireString(basis, `${where}.basis`);
  if (amount === null && basisText.trim().toLowerCase() === 'free') {
    fail('invalid_shape', `${where}: an unknown price must not claim free`);
  }
  return {
    provider: optionalString(raw.provider, `${where}.provider`),
    unit: optionalString(raw.unit, `${where}.unit`),
    currency: optionalString(raw.currency, `${where}.currency`),
    amount: amount as number | null,
    asOf: optionalString(raw.asOf, `${where}.asOf`),
    source: optionalString(raw.source, `${where}.source`),
    basis: basisText,
    conditions: optionalString(raw.conditions, `${where}.conditions`)
  };
}

function validateCapability(raw: unknown, where: string, sourceIds: Set<string>): CapabilityRecord {
  if (!isRecord(raw)) fail('invalid_shape', `${where} must be an object`);
  const dimension = requireEnum(raw.dimension, CAPABILITY_DIMENSIONS, `${where}.dimension`);
  const verification = requireEnum(raw.verification, VERIFICATION, `${where}.verification`);
  const rawRef = raw.verificationRef ?? null;
  let verificationRef: CapabilityRecord['verificationRef'] = null;
  if (verification === 'live_verified') {
    if (!isRecord(rawRef)) fail('invalid_shape', `${where}: live_verified requires a verification receipt`);
    verificationRef = {
      adapterId: requireString(rawRef.adapterId, `${where}.verificationRef.adapterId`),
      endpoint: requireString(rawRef.endpoint, `${where}.verificationRef.endpoint`),
      verifiedAt: requireString(rawRef.verifiedAt, `${where}.verificationRef.verifiedAt`),
      receipt: requireString(rawRef.receipt, `${where}.verificationRef.receipt`)
    };
  } else if (rawRef !== null) {
    fail('invalid_shape', `${where}: verification receipts are only allowed with live_verified`);
  }
  const docUrls = requireStringArray(raw.docUrls, `${where}.docUrls`);
  for (const url of docUrls) {
    if (!url.startsWith('https://')) fail('invalid_shape', `${where}.docUrls must be public https URLs`);
  }
  const endpoints = requireStringArray(raw.endpoints, `${where}.endpoints`);
  const sourceLocator = optionalString(raw.sourceLocator, `${where}.sourceLocator`);
  const documentation = requireEnum(raw.documentation, DOCUMENTATION, `${where}.documentation`);
  if (documentation === 'documented' && endpoints.length === 0 && sourceLocator === null) {
    fail('invalid_shape', `${where}: documented claims need endpoint facts or a precise source locator`);
  }
  const sourceRefs = requireStringArray(raw.sourceRefs, `${where}.sourceRefs`);
  if (sourceRefs.length === 0) fail('invalid_shape', `${where}.sourceRefs must not be empty`);
  for (const ref of sourceRefs) {
    if (!sourceIds.has(ref)) fail('source_ref', `${where} references unknown source ${ref}`);
  }
  const record: CapabilityRecord = {
    dimension,
    documentation,
    docUrls,
    endpoints,
    sourceLocator,
    integration: requireEnum(raw.integration, INTEGRATION, `${where}.integration`),
    access: requireEnum(raw.access, ACCESS, `${where}.access`),
    verification,
    verificationRef,
    cost: validateCost(raw.cost, `${where}.cost`),
    sourceRefs,
    notes: requireStringArray(raw.notes, `${where}.notes`)
  };
  if (dimension === 'comments') {
    const details = raw.comments;
    if (!isRecord(details)) fail('invalid_shape', `${where}.comments details are required for the comments dimension`);
    record.comments = {
      authorReplies: requireEnum(details.authorReplies, SUPPORT, `${where}.comments.authorReplies`),
      parentChain: requireEnum(details.parentChain, SUPPORT, `${where}.comments.parentChain`)
    };
  }
  if (dimension === 'pagination') {
    const details = raw.pagination;
    if (!isRecord(details)) fail('invalid_shape', `${where}.pagination details are required for the pagination dimension`);
    record.pagination = {
      cursor: requireEnum(details.cursor, ['supported', 'offset', 'invalid', 'unsupported', 'unknown'] as const, `${where}.pagination.cursor`),
      sortOptions: details.sortOptions === null ? null : requireStringArray(details.sortOptions, `${where}.pagination.sortOptions`),
      dateRange: requireEnum(details.dateRange, SUPPORT, `${where}.pagination.dateRange`)
    };
  }
  return record;
}

function validateRoute(raw: unknown, where: string, sourceIds: Set<string>): DiscoveryRoute {
  if (!isRecord(raw)) fail('invalid_shape', `${where} must be an object`);
  const requires = requireStringArray(raw.requires, `${where}.requires`);
  for (const requirement of requires) {
    if (!ROUTE_REQUIRES.includes(requirement as (typeof ROUTE_REQUIRES)[number])) {
      fail('invalid_shape', `${where}.requires contains unknown requirement ${requirement}`);
    }
  }
  const sourceRefs = requireStringArray(raw.sourceRefs, `${where}.sourceRefs`);
  for (const ref of sourceRefs) {
    if (!sourceIds.has(ref)) fail('source_ref', `${where} references unknown source ${ref}`);
  }
  return {
    routeId: requireString(raw.routeId, `${where}.routeId`),
    kind: requireEnum(raw.kind, ROUTE_KINDS, `${where}.kind`),
    operation: requireString(raw.operation, `${where}.operation`),
    adapterId: optionalString(raw.adapterId, `${where}.adapterId`),
    endpoint: optionalString(raw.endpoint, `${where}.endpoint`),
    requires: requires as DiscoveryRoute['requires'],
    availability: requireEnum(raw.availability, ROUTE_AVAILABILITY, `${where}.availability`),
    reason: requireString(raw.reason, `${where}.reason`),
    sourceRefs
  };
}

function validateLegacyRule(raw: unknown, where: string): LegacyRuleCompat {
  if (!isRecord(raw)) fail('invalid_shape', `${where} must be an object or null`);
  const probeRaw = raw.probe ?? null;
  let probe: LegacyRuleCompat['probe'] = null;
  if (probeRaw !== null) {
    if (!isRecord(probeRaw)) fail('invalid_shape', `${where}.probe must be an object or null`);
    const numArray = (value: unknown, name: string): number[] => {
      if (!Array.isArray(value)) fail('invalid_shape', `${where}.probe.${name} must be an array`);
      return value.map((item) => {
        if (typeof item !== 'number' || !Number.isInteger(item)) fail('invalid_shape', `${where}.probe.${name} must be integers`);
        return item;
      });
    };
    probe = {
      kind: requireEnum(probeRaw.kind, ['http_status', 'http_marker'] as const, `${where}.probe.kind`),
      method: 'GET',
      urlTemplate: requireString(probeRaw.urlTemplate, `${where}.probe.urlTemplate`),
      foundStatuses: numArray(probeRaw.foundStatuses, 'foundStatuses'),
      notFoundStatuses: numArray(probeRaw.notFoundStatuses, 'notFoundStatuses'),
      blockedStatuses: numArray(probeRaw.blockedStatuses, 'blockedStatuses'),
      foundMarker: optionalString(probeRaw.foundMarker, `${where}.probe.foundMarker`),
      notFoundMarker: optionalString(probeRaw.notFoundMarker, `${where}.probe.notFoundMarker`),
      transport: requireEnum(probeRaw.transport, ['api_http', 'profile_http'] as const, `${where}.probe.transport`)
    };
  }
  const postsRaw = raw.posts;
  if (!isRecord(postsRaw) || !isRecord(postsRaw.fields)) fail('invalid_shape', `${where}.posts must carry fields`);
  if (typeof postsRaw.urlTemplate !== 'string') fail('invalid_shape', `${where}.posts.urlTemplate must be a string`);
  if (typeof postsRaw.itemsPath !== 'string') fail('invalid_shape', `${where}.posts.itemsPath must be a string`);
  const posts: LegacyRuleCompat['posts'] = {
    kind: requireEnum(postsRaw.kind, ['none', 'json_list', 'rss'] as const, `${where}.posts.kind`),
    urlTemplate: postsRaw.urlTemplate,
    maxPages: typeof postsRaw.maxPages === 'number' && Number.isInteger(postsRaw.maxPages)
      ? postsRaw.maxPages
      : fail('invalid_shape', `${where}.posts.maxPages must be an integer`),
    itemsPath: postsRaw.itemsPath,
    fields: {
      id: optionalString(postsRaw.fields.id, `${where}.posts.fields.id`),
      url: optionalString(postsRaw.fields.url, `${where}.posts.fields.url`),
      title: optionalString(postsRaw.fields.title, `${where}.posts.fields.title`),
      publishedAt: optionalString(postsRaw.fields.publishedAt, `${where}.posts.fields.publishedAt`),
      excerpt: optionalString(postsRaw.fields.excerpt, `${where}.posts.fields.excerpt`)
    }
  };
  return {
    category: requireEnum(raw.category, ['code', 'writing', 'social', 'professional', 'other'] as const, `${where}.category`),
    subjectKinds: requireStringArray(raw.subjectKinds, `${where}.subjectKinds`) as LegacyRuleCompat['subjectKinds'],
    homepage: requireString(raw.homepage, `${where}.homepage`),
    probe,
    posts,
    rateLimitPerMinute: typeof raw.rateLimitPerMinute === 'number' && Number.isFinite(raw.rateLimitPerMinute)
      ? raw.rateLimitPerMinute
      : fail('invalid_shape', `${where}.rateLimitPerMinute must be a number`),
    verification: requireEnum(raw.verification, ['offline_fixture', 'live_verified', 'live_unverified'] as const, `${where}.verification`),
    verificationNote: requireString(raw.verificationNote, `${where}.verificationNote`),
    notes: requireStringArray(raw.notes, `${where}.notes`)
  };
}

function validateSources(raw: unknown): CatalogSourceManifest[] {
  if (!Array.isArray(raw) || raw.length === 0) fail('invalid_shape', 'sources must be a non-empty array');
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const where = `sources[${index}]`;
    if (!isRecord(item)) fail('invalid_shape', `${where} must be an object`);
    const sourceId = requireString(item.sourceId, `${where}.sourceId`);
    if (seen.has(sourceId)) fail('invalid_shape', `duplicate source id ${sourceId}`);
    seen.add(sourceId);
    const countsRaw = item.counts;
    if (!isRecord(countsRaw)) fail('invalid_shape', `${where}.counts must be an object`);
    const num = (value: unknown, name: string): number | null => {
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        fail('invalid_shape', `${where}.counts.${name} must be null or a non-negative integer`);
      }
      return value;
    };
    const counts = {
      raw: num(countsRaw.raw, 'raw'),
      loaded: num(countsRaw.loaded, 'loaded'),
      excluded: num(countsRaw.excluded, 'excluded')
    };
    if (counts.raw !== null && counts.raw !== (counts.loaded ?? 0) + (counts.excluded ?? 0)) {
      fail('invalid_shape', `${where}.counts must reconcile raw = loaded + excluded`);
    }
    const contentHash = optionalString(item.contentHash, `${where}.contentHash`);
    if (contentHash !== null && !/^[0-9a-f]{64}$/.test(contentHash)) {
      fail('invalid_shape', `${where}.contentHash must be a sha256 hex digest`);
    }
    const licenseHash = optionalString(item.licenseHash, `${where}.licenseHash`);
    if (licenseHash !== null && !/^[0-9a-f]{64}$/.test(licenseHash)) {
      fail('invalid_shape', `${where}.licenseHash must be a sha256 hex digest`);
    }
    const bytes = item.bytes ?? null;
    if (bytes !== null && (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0)) {
      fail('invalid_shape', `${where}.bytes must be null or a non-negative integer`);
    }
    return {
      sourceId,
      kind: requireEnum(item.kind, SOURCE_KINDS, `${where}.kind`),
      title: requireString(item.title, `${where}.title`),
      url: optionalString(item.url, `${where}.url`),
      license: optionalString(item.license, `${where}.license`),
      licenseHash,
      upstreamVersion: optionalString(item.upstreamVersion, `${where}.upstreamVersion`),
      upstreamState: requireString(item.upstreamState, `${where}.upstreamState`),
      capturedAt: optionalString(item.capturedAt, `${where}.capturedAt`),
      contentHash,
      bytes,
      importerVersion: optionalString(item.importerVersion, `${where}.importerVersion`),
      counts,
      notes: requireStringArray(item.notes, `${where}.notes`)
    };
  });
}

function validateEntry(raw: unknown, index: number, sourceIds: Set<string>): CatalogEntry {
  const where = `entries[${index}]`;
  if (!isRecord(raw)) fail('invalid_shape', `${where} must be an object`);
  const platformId = requireString(raw.platformId, `${where}.platformId`);
  if (!SLUG_RE.test(platformId)) fail('invalid_shape', `${where}.platformId must be a lowercase slug`);
  const aliases = requireStringArray(raw.aliases, `${where}.aliases`);
  for (const alias of aliases) {
    if (!SLUG_RE.test(alias)) fail('invalid_shape', `${where}.aliases must be lowercase slugs`);
  }
  const inputKinds = requireStringArray(raw.inputKinds, `${where}.inputKinds`);
  if (inputKinds.length === 0) fail('invalid_shape', `${where}.inputKinds must not be empty`);
  for (const kind of inputKinds) {
    if (!INPUT_KINDS.includes(kind as (typeof INPUT_KINDS)[number])) {
      fail('invalid_shape', `${where}.inputKinds contains unknown kind ${kind}`);
    }
  }
  const accountKinds = requireStringArray(raw.accountKinds, `${where}.accountKinds`);
  for (const kind of accountKinds) {
    if (!ACCOUNT_KINDS.includes(kind as (typeof ACCOUNT_KINDS)[number])) {
      fail('invalid_shape', `${where}.accountKinds contains unknown kind ${kind}`);
    }
  }
  const applicabilityRaw = raw.applicability;
  if (!isRecord(applicabilityRaw)) fail('invalid_shape', `${where}.applicability must be an object`);
  const authorizations = requireStringArray(applicabilityRaw.authorizations, `${where}.applicability.authorizations`);
  for (const authorization of authorizations) {
    if (!AUTHORIZATIONS.includes(authorization as (typeof AUTHORIZATIONS)[number])) {
      fail('invalid_shape', `${where}.applicability.authorizations contains unknown value ${authorization}`);
    }
  }
  const capabilitiesRaw = raw.capabilities;
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length !== CAPABILITY_DIMENSIONS.length) {
    fail('invalid_shape', `${where}.capabilities must carry exactly the seven dimensions`);
  }
  const capabilities = capabilitiesRaw.map((item, position) =>
    validateCapability(item, `${where}.capabilities[${position}]`, sourceIds)
  );
  const dimensions = new Set(capabilities.map((record) => record.dimension));
  if (dimensions.size !== CAPABILITY_DIMENSIONS.length) {
    fail('invalid_shape', `${where}.capabilities must cover each dimension exactly once`);
  }
  for (const dimension of CAPABILITY_DIMENSIONS) {
    if (!dimensions.has(dimension)) fail('invalid_shape', `${where}.capabilities is missing ${dimension}`);
  }
  const routesRaw = raw.routes;
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    fail('invalid_shape', `${where}.routes must carry at least one route (or an explicit none route with a reason)`);
  }
  const routes = routesRaw.map((item, position) => validateRoute(item, `${where}.routes[${position}]`, sourceIds));
  return {
    platformId,
    name: requireString(raw.name, `${where}.name`),
    cohort: requireEnum(raw.cohort, COHORTS, `${where}.cohort`),
    aliases,
    homepage: requireString(raw.homepage, `${where}.homepage`),
    profileUrlRule: optionalString(raw.profileUrlRule, `${where}.profileUrlRule`),
    instance: requireEnum(raw.instance, INSTANCE_VALUES, `${where}.instance`),
    inputKinds: inputKinds as CatalogEntry['inputKinds'],
    accountKinds: accountKinds as CatalogEntry['accountKinds'],
    applicability: {
      authorizations: authorizations as CatalogEntry['applicability']['authorizations'],
      conditions: requireStringArray(applicabilityRaw.conditions, `${where}.applicability.conditions`)
    },
    capabilities,
    routes,
    legacy: raw.legacy === null ? null : validateLegacyRule(raw.legacy, `${where}.legacy`),
    notes: requireStringArray(raw.notes, `${where}.notes`)
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

/**
 * Validate a parsed catalog document and return a deep-frozen, deep-copied
 * snapshot. Mutating the input afterwards cannot change the snapshot.
 */
export function catalogSnapshotFromJson(raw: unknown): PlatformCatalogSnapshot {
  if (!isRecord(raw)) fail('catalog_parse', 'catalog document must be an object');
  const schemaVersion = requireString(raw.schemaVersion, 'schemaVersion');
  if (schemaVersion !== PLATFORM_CATALOG_SCHEMA_VERSION) {
    fail('schema_version', `expected ${PLATFORM_CATALOG_SCHEMA_VERSION}, got ${schemaVersion}`);
  }
  const registryVersion = requireString(raw.registryVersion, 'registryVersion');
  const generatedAt = requireString(raw.generatedAt, 'generatedAt');
  const contentHash = requireString(raw.contentHash, 'contentHash');
  if (!HASH_RE.test(contentHash)) fail('invalid_shape', 'contentHash must be sha256:<hex>');
  const sources = validateSources(raw.sources);
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    fail('invalid_shape', 'entries must be a non-empty array');
  }
  const entries = raw.entries.map((item, index) => validateEntry(item, index, sourceIds));
  const platformIds = new Set<string>();
  for (const entry of entries) {
    if (platformIds.has(entry.platformId)) fail('duplicate_platform_id', `duplicate platform id ${entry.platformId}`);
    platformIds.add(entry.platformId);
  }
  const aliases = new Set<string>();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (aliases.has(alias) || platformIds.has(alias)) {
        fail('duplicate_alias', `conflicting alias ${alias}`);
      }
      aliases.add(alias);
    }
  }
  // Self content hash is checked after the shapes so tampered *values* fail
  // with `content_hash_mismatch` while structural corruption fails earlier.
  const expected = catalogContentHash({
    schemaVersion,
    registryVersion,
    generatedAt,
    sources: raw.sources,
    entries: raw.entries
  });
  if (expected !== contentHash) {
    fail('content_hash_mismatch', `declared ${contentHash}, computed ${expected}`);
  }
  return deepFreeze(structuredClone({
    schemaVersion,
    registryVersion,
    contentHash,
    generatedAt,
    sources,
    entries
  }));
}

/* ------------------------------------------------------------------ */
/* File loading                                                        */
/* ------------------------------------------------------------------ */

export function loadPlatformCatalog(dataDir: string): PlatformCatalogSnapshot {
  const manifestPath = path.join(dataDir, 'manifest.json');
  const catalogPath = path.join(dataDir, 'catalog.json');
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail('manifest_invalid', `cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(manifestRaw) || !Array.isArray(manifestRaw.files)) {
    fail('manifest_invalid', 'manifest must carry a files array');
  }
  const catalogFile = manifestRaw.files.find(
    (file) => isRecord(file) && file.path === 'catalog.json'
  );
  if (!isRecord(catalogFile) || typeof catalogFile.sha256 !== 'string') {
    fail('manifest_invalid', 'manifest must record the catalog.json sha256');
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(catalogPath);
  } catch (error) {
    fail('manifest_invalid', `cannot read ${catalogPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  if (fileHash !== catalogFile.sha256) {
    fail('file_hash_mismatch', `catalog.json sha256 ${fileHash} != manifest ${String(catalogFile.sha256)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail('catalog_parse', error instanceof Error ? error.message : String(error));
  }
  return catalogSnapshotFromJson(raw);
}

/**
 * Default data directory: walk up from this module looking for the bundled
 * `data/platforms/manifest.json`. The compiled build ships the data inside
 * `dist/data`, so production reads the bundled copy from any cwd.
 */
export function defaultCatalogDataDir(fromModuleUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(fromModuleUrl));
  for (;;) {
    const candidate = path.join(dir, 'data', 'platforms');
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail('data_not_found', 'no data/platforms/manifest.json found above the catalog module');
}

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

/** Legacy probe registry projection: keeps executable old probe shapes. */
export function toLegacyRegistry(snapshot: PlatformCatalogSnapshot): LegacyPlatformRegistry {
  const rules: PlatformRule[] = snapshot.entries
    .filter((entry) => entry.legacy !== null)
    .map((entry) => {
      const legacy = entry.legacy as LegacyRuleCompat;
      return {
        platformId: entry.platformId,
        name: entry.name,
        category: legacy.category,
        subjectKinds: legacy.subjectKinds,
        homepage: legacy.homepage,
        probe: legacy.probe,
        posts: legacy.posts,
        rateLimitPerMinute: legacy.rateLimitPerMinute,
        verification: legacy.verification,
        verificationNote: legacy.verificationNote,
        notes: legacy.notes
      };
    });
  return {
    version: snapshot.registryVersion,
    generatedAt: snapshot.generatedAt,
    rules
  };
}

interface ApplicabilityDecision {
  applicability: 'applicable' | 'not_applicable';
  reason: string;
}

function applicabilityFor(entry: CatalogEntry, input: CatalogApplicabilityInput): ApplicabilityDecision {
  const kinds = input.acceptedKinds.filter((kind) => entry.inputKinds.includes(kind));
  if (kinds.length === 0) {
    return {
      applicability: 'not_applicable',
      reason: `输入种类不匹配：目录支持 ${entry.inputKinds.join('/')}，本轮输入 ${input.acceptedKinds.join('/') || '（空）'}`
    };
  }
  if (entry.instance === 'required' && !input.instanceHints[entry.platformId]) {
    return {
      applicability: 'not_applicable',
      reason: `实例限定平台缺少实例提示（${entry.platformId}）`
    };
  }
  const authorizations = entry.applicability.authorizations;
  if (authorizations.length > 0 && !authorizations.includes(input.authorization)) {
    return {
      applicability: 'not_applicable',
      reason: `授权策略不满足：需要 ${authorizations.join('/')}，当前 ${input.authorization}`
    };
  }
  return {
    applicability: 'applicable',
    reason: `目录内适用平台：输入 ${kinds.join('/')}，授权 ${input.authorization}，冻结为发现义务`
  };
}

/**
 * GET-60 completion registry projection. Every catalog entry stays
 * represented — no-adapter platforms included — with a frozen reason.
 * Applicability follows input kinds and authorization policy only.
 */
export function toCompletionRegistry(
  snapshot: PlatformCatalogSnapshot,
  input: CatalogApplicabilityInput
): CompletionPlatformRegistry {
  return {
    registryVersion: snapshot.registryVersion,
    entries: snapshot.entries.map((entry) => {
      const decision = applicabilityFor(entry, input);
      return {
        platformId: entry.platformId,
        label: entry.name,
        applicability: decision.applicability,
        applicabilityReason: decision.reason
      };
    })
  };
}

/**
 * GET-59 capability projection. Seven operations per platform; the exact
 * state mapping lives in `capabilityStateFor` and can only produce
 * `supported` from a receipt-bound `live_verified` record.
 */
export function toCapabilitySnapshot(
  snapshot: PlatformCatalogSnapshot,
  access: CatalogAccessContext
): CapabilitySnapshot {
  const operations: CapabilitySnapshot['operations'] = [];
  for (const entry of snapshot.entries) {
    const grant = access.grants[entry.platformId] ?? null;
    const byDimension = new Map(entry.capabilities.map((record) => [record.dimension, record]));
    const comments = byDimension.get('comments') as CapabilityRecord;
    const pagination = byDimension.get('pagination') as CapabilityRecord;
    const sortOptions = pagination.pagination?.sortOptions ?? [];
    const dateRange: 'supported' | 'unsupported' =
      pagination.pagination?.dateRange === 'supported' ? 'supported' : 'unsupported';
    const push = (
      operation: string,
      record: CapabilityRecord,
      over: { sortOptions?: string[]; dateRange?: 'supported' | 'unsupported'; maxDepth?: number | null; limitation?: string | null } = {}
    ): void => {
      const state = capabilityStateFor(record, grant);
      operations.push({
        platform: entry.platformId,
        operation,
        state,
        sortOptions: over.sortOptions ?? [],
        dateRange: over.dateRange ?? 'unsupported',
        maxDepth: over.maxDepth ?? null,
        limitation: over.limitation ?? capabilityLimitation(record, state)
      });
    };
    push('discover_accounts', byDimension.get('discovery') as CapabilityRecord);
    push('read_profile', byDimension.get('profile') as CapabilityRecord);
    push('list_posts', byDimension.get('list') as CapabilityRecord, { sortOptions, dateRange });
    push('read_post', byDimension.get('body') as CapabilityRecord);
    push('read_media', byDimension.get('media') as CapabilityRecord);
    push('list_comments', comments, { sortOptions, dateRange });

    // read_thread follows the comments capability plus its parent-chain limit.
    const commentsState = capabilityStateFor(comments, grant);
    const parentChain = comments.comments?.parentChain ?? 'unknown';
    const state: CapabilitySnapshot['operations'][number]['state'] =
      commentsState === 'unsupported'
        ? 'unsupported'
        : parentChain === 'supported'
          ? commentsState
          : parentChain === 'unsupported'
            ? 'unsupported'
            : 'unverified';
    operations.push({
      platform: entry.platformId,
      operation: 'read_thread',
      state,
      sortOptions: [],
      dateRange: 'unsupported',
      maxDepth: state === 'supported' && parentChain === 'supported' ? DEFAULT_THREAD_DEPTH : null,
      limitation:
        state === 'supported'
          ? null
          : `${capabilityLimitation(comments, commentsState) ?? ''};parentChain=${parentChain}`.replace(/^;/, '')
    });
  }
  return {
    registryVersion: snapshot.registryVersion,
    operations
  };
}

/** Counts platforms, routes and source records separately. */
export function catalogSummary(snapshot: PlatformCatalogSnapshot): CatalogSummary {
  const cohorts: CatalogSummary['cohorts'] = {
    tikhub: 0,
    alternative: 0,
    personal_website: 0,
    legacy_only: 0
  };
  let routeCount = 0;
  let capabilityRecordCount = 0;
  let liveVerifiedCapabilityCount = 0;
  let unknownPriceCount = 0;
  for (const entry of snapshot.entries) {
    cohorts[entry.cohort] += 1;
    routeCount += entry.routes.length;
    capabilityRecordCount += entry.capabilities.length;
    for (const record of entry.capabilities) {
      if (record.verification === 'live_verified') liveVerifiedCapabilityCount += 1;
      if (record.cost.amount === null) unknownPriceCount += 1;
    }
  }
  return {
    registryVersion: snapshot.registryVersion,
    contentHash: snapshot.contentHash,
    platformCount: snapshot.entries.length,
    routeCount,
    sourceCount: snapshot.sources.length,
    capabilityRecordCount,
    cohorts,
    legacyRuleCount: snapshot.entries.filter((entry) => entry.legacy !== null).length,
    liveVerifiedCapabilityCount,
    unknownPriceCount
  };
}

/** Honest per-platform gaps: never hide missing adapters or unknown prices. */
export function platformGaps(entry: CatalogEntry): CatalogGap[] {
  const gaps: CatalogGap[] = [];
  const notIntegrated = entry.capabilities
    .filter((record) => record.integration !== 'integrated')
    .map((record) => record.dimension);
  if (notIntegrated.length > 0) {
    gaps.push({ kind: 'no_adapter', detail: `无已接入 adapter 的能力：${notIntegrated.join('/')}` });
  }
  const unverified = entry.capabilities
    .filter((record) => record.verification !== 'live_verified')
    .map((record) => record.dimension);
  if (unverified.length > 0) {
    gaps.push({ kind: 'unverified_capability', detail: `未 live 验证能力：${unverified.join('/')}` });
  }
  if (entry.capabilities.some((record) => record.cost.amount === null)) {
    gaps.push({ kind: 'unknown_price', detail: '费用未知（null 不等于免费）' });
  }
  const limited = entry.capabilities
    .filter((record) => record.access !== 'public')
    .map((record) => record.dimension);
  if (limited.length > 0) {
    gaps.push({ kind: 'access_limited', detail: `访问受限能力：${limited.join('/')}` });
  }
  return gaps;
}
