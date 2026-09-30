/**
 * GET-90 shared contract: the versioned platform catalog and its axes
 * ("platform-catalog/v1").
 *
 * One catalog snapshot produces three explicit projections (built in
 * `server/platforms/catalog.ts`):
 *
 * - the legacy probe registry (`shared/platform-discovery.ts` shapes),
 * - the GET-60 completion registry (`shared/research-completion.ts` shapes),
 * - the GET-59 capability snapshot (`research-tool-dispatch.ts` shapes).
 *
 * Honesty rules baked into these shapes:
 *
 * - Documentation, project integration, access conditions and verification
 *   are four SEPARATE axes. A documented capability is not an integrated one,
 *   and neither promotes itself to `live_verified`: only a bound verification
 *   receipt (`CatalogVerificationRef`) can. Documented rules and the old
 *   GitHub research adapter never leak `live_verified` into new capabilities.
 * - An unknown price is an explicit `null` amount with a public basis.
 *   `null` never means "free".
 * - The two public longtail rule sources (Maigret / WhatsMyName) keep their
 *   actual known state: no frozen version, no captured bytes, null counts —
 *   importing them is GET-91, and nothing here claims rules are enabled.
 * - Applicability for completion is decided by accepted input kinds and the
 *   authorization policy, never by whether an adapter exists: no-adapter
 *   platforms stay in the frozen denominator with an explicit reason.
 *
 * This module has no runtime dependencies so server, client and tests share
 * one authority for the shapes.
 */

import type {
  DiscoverySubjectKind,
  PlatformPostsRule,
  PlatformProbeRule,
  PlatformRegistry as LegacyPlatformRegistryShape,
  ProbeVerification
} from './platform-discovery.js';
import type { PlatformRegistry as CompletionPlatformRegistryShape } from './research-completion.js';

export const PLATFORM_CATALOG_SCHEMA_VERSION = 'stripsearch/platform-catalog/v1';

/** Legacy probe registry projection type (see `shared/platform-discovery.ts`). */
export type LegacyPlatformRegistry = LegacyPlatformRegistryShape;
/** GET-60 completion registry projection type (see `shared/research-completion.ts`). */
export type CompletionPlatformRegistry = CompletionPlatformRegistryShape;

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

export type CatalogInputKind = 'username' | 'email' | 'homepage_url';

/**
 * Which cohort an entry belongs to. The approved spec lists 20 TikHub
 * platforms, 30 alternative platforms and the personal website; `legacy_only`
 * retains pre-catalog probe rules (devto / npm / pypi) so the legacy
 * projection cannot lose old rules.
 */
export type CatalogCohort = 'tikhub' | 'alternative' | 'personal_website' | 'legacy_only';

export type CatalogInstanceScoping = 'required' | 'optional' | 'none';

export type CatalogAccountKind = 'person' | 'publication' | 'channel' | 'organization' | 'unknown';

export interface CatalogApplicabilityPolicy {
  /** Empty list = every authorization is accepted. */
  authorizations: Array<'self' | 'consent_obtained' | 'public_professional'>;
  /** Frozen human-readable applicability conditions (organization vs person, ...). */
  conditions: string[];
}

/** Executable-shape legacy rule data kept verbatim for the legacy projection. */
export interface LegacyRuleCompat {
  category: 'code' | 'writing' | 'social' | 'professional' | 'other';
  subjectKinds: DiscoverySubjectKind[];
  homepage: string;
  probe: PlatformProbeRule | null;
  posts: PlatformPostsRule;
  rateLimitPerMinute: number;
  verification: ProbeVerification;
  verificationNote: string;
  notes: string[];
}

export interface CatalogEntry {
  platformId: string;
  name: string;
  cohort: CatalogCohort;
  /** Alternative slugs for matching imported site names; globally unique. */
  aliases: string[];
  homepage: string;
  /** Canonical profile URL rule (`{username}` / `{instance}` placeholders) or null. */
  profileUrlRule: string | null;
  instance: CatalogInstanceScoping;
  inputKinds: CatalogInputKind[];
  accountKinds: CatalogAccountKind[];
  applicability: CatalogApplicabilityPolicy;
  /** Exactly the seven capability dimensions, one record each. */
  capabilities: CapabilityRecord[];
  routes: DiscoveryRoute[];
  /** Verbatim legacy rule for the probe registry projection, when one exists. */
  legacy: LegacyRuleCompat | null;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Capability records: four separate axes                              */
/* ------------------------------------------------------------------ */

export type CapabilityDimension =
  | 'discovery'
  | 'profile'
  | 'list'
  | 'body'
  | 'media'
  | 'comments'
  | 'pagination';

export const CAPABILITY_DIMENSIONS: readonly CapabilityDimension[] = [
  'discovery',
  'profile',
  'list',
  'body',
  'media',
  'comments',
  'pagination'
];

/** Is the capability written down in reachable public documentation? */
export type CapabilityDocumentation = 'documented' | 'not_documented' | 'unknown';
/** Does THIS project ship an adapter / executable path for it today? */
export type CapabilityIntegration = 'integrated' | 'not_integrated' | 'unsupported';
/** What does the capability need before any request may be sent? */
export type CapabilityAccess =
  | 'public'
  | 'credentials_required'
  | 'authorization_required'
  | 'inaccessible'
  | 'unknown';
/**
 * How was the capability verified? `documented_only` and `offline_verified`
 * can never become `supported` in the GET-59 projection; `live_verified`
 * requires a bound receipt and is rejected by the loader without one.
 */
export type CapabilityVerification = 'documented_only' | 'offline_verified' | 'live_verified';

/** Price facts stay separate from capability facts. Unknown ≠ free. */
export interface CatalogCost {
  provider: string | null;
  unit: string | null;
  currency: string | null;
  /** Explicit null when the price is unknown. Never 0 to mean "free". */
  amount: number | null;
  /** Price query date. */
  asOf: string | null;
  /** Public URL the number (or the unknown) was checked against. */
  source: string | null;
  /** Required public basis text even when `amount` is null. */
  basis: string;
  /** Conditions under which the price holds (free tier, per-endpoint, ...). */
  conditions: string | null;
}

/** A real acceptance receipt binding one capability to a checked endpoint. */
export interface CatalogVerificationRef {
  adapterId: string;
  endpoint: string;
  verifiedAt: string;
  receipt: string;
}

/** Comments additionally record author replies / parent chains. */
export interface CatalogCommentDetails {
  authorReplies: 'supported' | 'unsupported' | 'unknown';
  parentChain: 'supported' | 'unsupported' | 'unknown';
}

/** Pagination additionally records cursor, sort and date-range limits. */
export interface CatalogPaginationDetails {
  /** `offset` = page-number paging; `invalid` = documented broken cursors. */
  cursor: 'supported' | 'offset' | 'invalid' | 'unsupported' | 'unknown';
  sortOptions: string[] | null;
  dateRange: 'supported' | 'unsupported' | 'unknown';
}

export interface CapabilityRecord {
  dimension: CapabilityDimension;
  documentation: CapabilityDocumentation;
  /** Public documentation URLs actually checked for this capability. */
  docUrls: string[];
  /** Documented endpoints / request templates (data, never fetched here). */
  endpoints: string[];
  /**
   * Precise original source locator (e.g. `tikhub-path-index:/api/v1/...`,
   * `project-legacy-registry:github`). A `documented` claim requires at
   * least one endpoint fact or a precise locator — a generic provider/developer
   * doc link is not evidence for a dimension.
   */
  sourceLocator: string | null;
  integration: CapabilityIntegration;
  access: CapabilityAccess;
  verification: CapabilityVerification;
  /** Required when `verification === 'live_verified'`, else null. */
  verificationRef: CatalogVerificationRef | null;
  cost: CatalogCost;
  /** Ids into `PlatformCatalogSnapshot.sources`. */
  sourceRefs: string[];
  notes: string[];
  comments?: CatalogCommentDetails;
  pagination?: CatalogPaginationDetails;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export type CatalogRouteKind =
  | 'selflink'
  | 'username_probe'
  | 'platform_search'
  | 'official_search'
  | 'site_search'
  | 'wechat_search'
  | 'import_report'
  | 'none';

export type CatalogRouteRequirement =
  | 'public_network'
  | 'provider_key'
  | 'login'
  | 'authorization'
  | 'instance_hint';

export interface DiscoveryRoute {
  routeId: string;
  kind: CatalogRouteKind;
  /** Stable operation id (never executes anything by itself). */
  operation: string;
  /** Implemented adapter in this repo, or null. */
  adapterId: string | null;
  /** Documented request template / endpoint (public data, not fetched here). */
  endpoint: string | null;
  requires: CatalogRouteRequirement[];
  availability: 'integrated' | 'not_integrated' | 'unsupported' | 'unknown';
  /** Frozen reason for the availability, or why no route exists. */
  reason: string;
  sourceRefs: string[];
}

/* ------------------------------------------------------------------ */
/* Source manifests                                                    */
/* ------------------------------------------------------------------ */

export type CatalogSourceKind =
  | 'provider_openapi'
  | 'provider_pricing'
  | 'official_documentation'
  | 'public_rule_dataset'
  | 'project_baseline';

export interface CatalogSourceManifest {
  sourceId: string;
  kind: CatalogSourceKind;
  title: string;
  /** Public URL or null for project baselines. Private URLs never appear. */
  url: string | null;
  license: string | null;
  /** sha256 hex of the LICENSE text, when captured. */
  licenseHash: string | null;
  /** Frozen upstream commit/version, or null when nothing was frozen yet. */
  upstreamVersion: string | null;
  /**
   * Actual known state: `metadata_only_not_imported`, `not_imported`,
   * `checked_unfrozen`, `frozen`, ... Never claims a retrieval or import that
   * did not happen. Source dataset record counts are NOT import counts and
   * never fill `counts`.
   */
  upstreamState: string;
  capturedAt: string | null;
  /** sha256 hex of captured source bytes, or null when no bytes were captured. */
  contentHash: string | null;
  /** Size of the captured source bytes when captured. */
  bytes: number | null;
  importerVersion: string | null;
  /** raw = loaded + excluded when counts are known; null when not imported. */
  counts: { raw: number | null; loaded: number | null; excluded: number | null };
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

export interface PlatformCatalogSnapshot {
  schemaVersion: string;
  registryVersion: string;
  /** `sha256:<hex>` over the canonical content; verified at load. */
  contentHash: string;
  generatedAt: string;
  sources: CatalogSourceManifest[];
  entries: CatalogEntry[];
}

/* ------------------------------------------------------------------ */
/* Projection inputs (server-owned; never owner/email material)        */
/* ------------------------------------------------------------------ */

export interface CatalogApplicabilityInput {
  /** Input kinds accepted for this round (username / email / homepage_url). */
  acceptedKinds: CatalogInputKind[];
  /** Per-platform instance hints (e.g. a Mastodon host). */
  instanceHints: Record<string, string | null>;
  /** Declared research authorization policy for the round. */
  authorization: 'self' | 'consent_obtained' | 'public_professional';
}

/** Currently held credentials/authorization per platform. No owner data. */
export interface CatalogAccessGrant {
  credentials: boolean;
  authorization: boolean;
}

export interface CatalogAccessContext {
  grants: Record<string, CatalogAccessGrant>;
}

/* ------------------------------------------------------------------ */
/* GET-59 capability projection shapes (structurally identical)        */
/* ------------------------------------------------------------------ */

export type CatalogCapabilityState = 'supported' | 'unsupported' | 'unverified';

export interface CatalogCapabilityOperation {
  platform: string;
  operation: string;
  state: CatalogCapabilityState;
  sortOptions: string[];
  dateRange: 'supported' | 'unsupported';
  maxDepth: number | null;
  limitation: string | null;
}

export interface CatalogCapabilitySnapshot {
  registryVersion: string;
  operations: CatalogCapabilityOperation[];
}

/**
 * Exact state mapping (documented in docs/platform-catalog.md):
 *
 * 1. `unsupported` when the platform does not offer the capability, the
 *    project has no adapter (`not_integrated` — GET-59 `not_implemented`), or
 *    the capability is `inaccessible`.
 * 2. `unverified` when access is `unknown`.
 * 3. `unsupported` when required credentials/authorization are not currently
 *    held (missing key ≠ endpoint failure, but the op cannot run now).
 * 4. `supported` only for `live_verified` records WITH a bound receipt and
 *    satisfied access. Everything else — `documented_only`, `offline_verified`
 *    — is `unverified`. Credentials can never promote `documented_only`.
 */
export function capabilityStateFor(
  record: CapabilityRecord,
  grant: CatalogAccessGrant | null
): CatalogCapabilityState {
  if (record.integration === 'unsupported') return 'unsupported';
  if (record.integration === 'not_integrated') return 'unsupported';
  if (record.access === 'inaccessible') return 'unsupported';
  if (record.access === 'unknown') return 'unverified';
  if (record.access === 'credentials_required' && grant?.credentials !== true) return 'unsupported';
  if (record.access === 'authorization_required' && grant?.authorization !== true) return 'unsupported';
  if (record.verification === 'live_verified' && record.verificationRef !== null) return 'supported';
  return 'unverified';
}

/** Deterministic limitation text for non-supported capability states. */
export function capabilityLimitation(record: CapabilityRecord, state: CatalogCapabilityState): string | null {
  if (state === 'supported') return null;
  const parts = [`verification=${record.verification}`, `access=${record.access}`, `integration=${record.integration}`];
  if (record.cost.amount === null) parts.push('price=unknown');
  return parts.join(';');
}

/* ------------------------------------------------------------------ */
/* Summary and gaps                                                    */
/* ------------------------------------------------------------------ */

export interface CatalogSummary {
  registryVersion: string;
  contentHash: string;
  platformCount: number;
  routeCount: number;
  sourceCount: number;
  capabilityRecordCount: number;
  cohorts: Record<CatalogCohort, number>;
  legacyRuleCount: number;
  liveVerifiedCapabilityCount: number;
  unknownPriceCount: number;
}

export type CatalogGapKind = 'no_adapter' | 'unverified_capability' | 'unknown_price' | 'access_limited';

export interface CatalogGap {
  kind: CatalogGapKind;
  detail: string;
}
