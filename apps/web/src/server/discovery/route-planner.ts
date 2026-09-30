/**
 * GET-92 pure full-catalog discovery route planner.
 *
 * `planDiscoveryRound` enumerates the FULL catalog snapshot (never a first
 * API page, never a four-platform cap) and emits one platform plan/status/
 * reason per entry plus ordered admissible route operations. It is pure
 * data: no network, no DNS, no provider calls, no state mutation and no
 * model tool registration — an executable plan is NOT a send. Planning
 * never promotes catalog facts: a planned operation keeps `productionWired:
 * false` and cannot turn a capability into `supported`/`live_verified`.
 *
 * Route priorities follow the approved spec §6: traceable selflinks →
 * known-username rules → integrated platform search → official search →
 * allowed site search. Operation accepted input (`ROUTE_KIND_ACCEPTED_OPERANDS`)
 * is separate from the platform discovery obligation: name text, numeric
 * native ids and email prefixes NEVER fill a username template, and missing
 * keys / login / authorization / handlers are explicit gaps — never a
 * browser or legacy-fetch bypass.
 *
 * The DEFAULT server-owned operation inventory contains exactly one real
 * callable safe port — the GET-91 standalone bounded rule executor — and it
 * is explicitly NOT production wired (wiring belongs to GET-63). Legacy
 * discovery default fetch, the GitHub research adapter and the Exa whole-
 * research provider are not safe round handlers and never become
 * search-people handlers here. Tests may inject a trusted inventory that
 * exercises the real request contract without changing catalog facts.
 */

import { createHash } from 'node:crypto';

import { checkPublicAddress, normalizeSocketAddress } from './request-policy.js';
import type {
  CatalogAccessContext,
  CatalogEntry,
  CatalogRouteKind,
  DiscoveryRoute,
  PlatformCatalogSnapshot
} from '../../shared/platform-catalog.js';
import type { PublicDiscoveryRule } from '../../shared/public-discovery-rules.js';
import { templateHasCredentialQuery } from '../../shared/public-discovery-rules.js';
import type {
  CatalogDiscoveryInput,
  DiscoveryBinding,
  DiscoveryGapCode,
  DiscoveryInputHint,
  DiscoveryOperandKind,
  DiscoveryPlatformPlan,
  DiscoveryPlanTotals,
  DiscoveryPlannedOperation,
  DiscoveryRequestOperation,
  DiscoveryRoundPlan,
  DiscoveryRoutePlan,
  DiscoverySelflinkOperation,
  DiscoveryUnmatchedHint,
  MatchedSelflink,
  PlannedDiscoveryRequest,
  PlannedRequestConsumer,
  PlannedRequestDraft,
  PlannedRequestRecord,
  PlatformObligation
} from '../../shared/discovery-plan.js';
import {
  DISCOVERY_PLAN_SCHEMA_VERSION,
  DISCOVERY_REQUEST_KEY_PREFIX,
  NAME_QUERY_ROUTE_KINDS,
  ROUTE_KIND_ACCEPTED_OPERANDS,
  ROUTE_KIND_PRIORITY,
  canonicalJson,
  platformObligation
} from '../../shared/discovery-plan.js';

export class DiscoveryPlanInputError extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(detail);
    this.name = 'DiscoveryPlanInputError';
  }
}

export class DiscoveryRequestKeyError extends Error {
  constructor(readonly reasonCode: string, detail: string) {
    super(detail);
    this.name = 'DiscoveryRequestKeyError';
  }
}

/* ------------------------------------------------------------------ */
/* Trusted operation inventory                                         */
/* ------------------------------------------------------------------ */

export interface DiscoveryRequestBuildContext {
  entry: CatalogEntry;
  route: DiscoveryRoute;
  /** Rules behind this route (rule-backed handlers); empty otherwise. */
  rules: PublicDiscoveryRule[];
  /** Explicit username operand, or null. Never coerced from other input. */
  username: string | null;
  /** Explicit name query operand, or null. */
  nameQuery: string | null;
}

export interface DiscoveryOperationHandler {
  handlerId: string;
  routeKinds: CatalogRouteKind[];
  /** Operand kinds this handler's request builder can consume. */
  accepts: DiscoveryOperandKind[];
  /** Only serves GET-91 rule-backed routes (shared response requests). */
  ruleBacked: boolean;
  /** A real callable safe port exists today (never a documentation claim). */
  callable: boolean;
  /** Production runtime wiring; always false before GET-63. */
  productionWired: boolean;
  buildRequest(context: DiscoveryRequestBuildContext): PlannedRequestDraft[] | null;
}

export interface DiscoveryOperationInventory {
  handlers: DiscoveryOperationHandler[];
}

/**
 * The one real callable safe port: the GET-91 standalone bounded rule
 * executor (offline verified, explicitly NOT production wired).
 */
function buildPublicRuleRequests(context: DiscoveryRequestBuildContext): PlannedRequestDraft[] | null {
  if (context.username === null || context.rules.length === 0) return null;
  const groups = new Map<string, { template: string; headers: Record<string, string>; ruleIds: string[] }>();
  for (const rule of context.rules) {
    const key = canonicalJson({ headers: rule.safeHeaders, template: rule.requestTemplate });
    const bucket = groups.get(key) ?? {
      template: rule.requestTemplate,
      headers: { ...rule.safeHeaders },
      ruleIds: []
    };
    bucket.ruleIds.push(rule.ruleId);
    groups.set(key, bucket);
  }
  const drafts: PlannedRequestDraft[] = [];
  for (const bucket of groups.values()) {
    const url = renderUsernameTemplate(bucket.template, context.username);
    drafts.push({
      request: {
        adapterId: 'get91-rule-executor',
        operation: context.route.operation,
        method: 'GET',
        url,
        headers: bucket.headers,
        body: null,
        pageScope: { page: 1, pageSize: null }
      },
      ruleIds: [...bucket.ruleIds].sort()
    });
  }
  return drafts;
}

export const GET91_RULE_EXECUTOR_HANDLER: DiscoveryOperationHandler = {
  handlerId: 'get91-rule-executor',
  routeKinds: ['username_probe'],
  accepts: ['username'],
  ruleBacked: true,
  callable: true,
  productionWired: false,
  buildRequest: buildPublicRuleRequests
};

export const DEFAULT_DISCOVERY_OPERATION_INVENTORY: DiscoveryOperationInventory = {
  handlers: [GET91_RULE_EXECUTOR_HANDLER]
};

export interface DiscoveryPlanOptions {
  /** Trusted server-owned operation inventory (tests may inject shapes). */
  inventory?: DiscoveryOperationInventory;
}

/* ------------------------------------------------------------------ */
/* Safe request identity and opaque request keys                       */
/* ------------------------------------------------------------------ */

const SAFE_HEADER_NAMES = new Set(['accept', 'accept-language']);

/** A request builder refuses to render a request (explicit route gap). */
export class DiscoveryRequestBuildError extends Error {
  constructor(readonly reasonCode: DiscoveryGapCode, detail: string) {
    super(detail);
    this.name = 'DiscoveryRequestBuildError';
  }
}

/**
 * Credential-bearing parameter names are the ONE shared GET-91 list
 * (`templateHasCredentialQuery` decodes case/percent-encoded names) plus a
 * documented conservative extension for unambiguous OAuth token grants,
 * secret keys and cookie carriers. This single helper is used for fragment
 * metadata and body keys so every entry point refuses the same material
 * consistently; ordinary parameter names like `page_token`/`q` stay valid.
 */
const EXTRA_CREDENTIAL_KEY_NAMES = new Set([
  'refresh_token',
  'id_token',
  'auth_token',
  'bearer_token',
  'secret_key',
  'access_key',
  'signing_key',
  'cookie',
  'set_cookie',
  'session_cookie',
  'credential',
  'credentials'
]);

function credentialKeyName(rawName: string): boolean {
  const checkSingle = (name: string): boolean => {
    if (EXTRA_CREDENTIAL_KEY_NAMES.has(name.trim().toLowerCase())) return true;
    return templateHasCredentialQuery(`https://credential-check.invalid/?${encodeURIComponent(name)}=1`);
  };
  // Form bracket notation names nested fields/array items; inspect field
  // segments, never the associated value or a substring of normal text.
  const check = (name: string): boolean =>
    [name, ...name.split(/[\[\]]/)].some((segment) => checkSingle(segment));
  if (check(rawName)) return true;
  try {
    return check(decodeURIComponent(rawName));
  } catch {
    return false;
  }
}

/** Query AND fragment credential parameters (fragment metadata included). */
function credentialParamLocation(raw: string): 'query' | 'fragment' | null {
  const hashIndex = raw.indexOf('#');
  const queryIndex = raw.indexOf('?');
  const inQuery = queryIndex >= 0 && (hashIndex < 0 || queryIndex < hashIndex);
  const queryPart = inQuery ? raw.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : '';
  const fragmentPart = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';
  const names = (part: string): string[] =>
    part
      .split('&')
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const eq = pair.indexOf('=');
        return eq >= 0 ? pair.slice(0, eq) : pair;
      });
  if (names(queryPart).some((name) => credentialKeyName(name))) return 'query';
  if (names(fragmentPart.split('#').join('&')).some((name) => credentialKeyName(name))) return 'fragment';
  // OAuth query-prefixed fragments and hash-router paths have their own
  // parameter section. A '?' inside an ordinary parameter value remains
  // part of that value, rather than becoming a new credential key.
  const fragmentQueryIndex = fragmentPart.indexOf('?');
  const fragmentPrefix = fragmentPart.slice(0, fragmentQueryIndex);
  if (
    fragmentQueryIndex >= 0 &&
    (!fragmentPrefix.includes('=') || fragmentPrefix.startsWith('/')) &&
    names(fragmentPart.slice(fragmentQueryIndex + 1)).some((name) => credentialKeyName(name))
  ) return 'fragment';
  return null;
}

/**
 * Credential-bearing BODY keys: JSON (nested objects/arrays, case and
 * percent-encoded names included) and form/query pairs. The validator never
 * sanitizes: it only refuses. Ordinary text that merely mentions a word
 * like "token" and safe literal bodies stay valid and byte exact.
 */
export function bodyCredentialRisk(body: string | null): 'credential_body' | null {
  if (body === null) return null;
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const walk = (value: unknown): boolean => {
        if (value === null || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some((item) => walk(item));
        for (const [key, item] of Object.entries(value)) {
          if (credentialKeyName(key)) return true;
          if (walk(item)) return true;
        }
        return false;
      };
      return walk(parsed) ? 'credential_body' : null;
    }
  }
  for (const pair of body.split(/[&\n]/)) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const name = eq >= 0 ? pair.slice(0, eq) : pair;
    if (credentialKeyName(name.trim())) return 'credential_body';
  }
  return null;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** Mirrors `request-policy` HOSTNAME_RE (read-only reuse; that module is frozen). */
const STRICT_HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Lowercase the scheme://host portion only; path/query/fragment verbatim. */
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

/** Insert the root path an HTTP client would send when the URL has none. */
function withRootPath(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return value;
  const rest = value.slice(schemeEnd + 3);
  const boundary = rest.search(/[/?#]/);
  if (boundary < 0) return `${value}/`;
  return rest[boundary] === '/' ? value : `${value.slice(0, schemeEnd + 3 + boundary)}/${rest.slice(boundary)}`;
}

export type UrlPreflightResult = { ok: true } | { ok: false; code: string; reason: string };

/**
 * Shared offline static URL preflight — ONE consistent validation used by
 * account-key URL fallback, planned requests/public plan materialization,
 * `discoveryRequestKey` and selflink matching. It never performs DNS and
 * never rewrites the URL through parse+serialize: valid raw path/query/
 * profile-fragment bytes, encoded slashes and instance ports stay exactly
 * as given. It refuses control characters, unparseable URLs, invalid
 * authorities, userinfo, localhost and static non-public literal IPs
 * (literal addresses reuse the read-only `checkPublicAddress` policy from
 * `request-policy`), credential-bearing query/fragment parameters, and URLs
 * whose actual HTTP serialization would not preserve the planned bytes.
 * Actual execution still revalidates DNS and authority; structural planning
 * validation is not live verification.
 */
export function staticHttpsUrlPreflight(raw: string): UrlPreflightResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, code: 'invalid_url', reason: 'URL must be a non-empty string' };
  }
  if (CONTROL_CHARACTER.test(raw)) {
    return { ok: false, code: 'control_character', reason: 'control characters are refused' };
  }
  if (!/^https:\/\//i.test(raw)) {
    return { ok: false, code: 'unsafe_scheme', reason: 'only https URLs are accepted' };
  }
  const authority = raw.slice('https://'.length).split(/[/?#]/)[0] ?? '';
  if (authority.length === 0) {
    return { ok: false, code: 'invalid_authority', reason: 'missing authority' };
  }
  if (authority.includes('@')) {
    return { ok: false, code: 'userinfo', reason: 'credential URLs are refused' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_authority', reason: 'URL does not parse' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'unsafe_scheme', reason: 'only https URLs are accepted' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'userinfo', reason: 'credential URLs are refused' };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host.length === 0) {
    return { ok: false, code: 'invalid_authority', reason: 'missing hostname' };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, code: 'non_public_host', reason: 'localhost targets are refused' };
  }
  // Literal addresses (including WHATWG-normalized numeric/hex aliases) go
  // through the existing literal policy; plain DNS names are accepted
  // WITHOUT any resolution here.
  const literal = checkPublicAddress(normalizeSocketAddress(host));
  if (literal.ok) {
    // public literal ✓
  } else if (literal.reason !== 'unparseable_address') {
    return { ok: false, code: 'non_public_host', reason: `non-public literal address (${literal.reason})` };
  } else if (!STRICT_HOSTNAME.test(host)) {
    return { ok: false, code: 'invalid_authority', reason: 'hostname is not a plain DNS name' };
  }
  const credential = credentialParamLocation(raw);
  if (credential !== null) {
    return {
      ok: false,
      code: credential === 'query' ? 'credential_query' : 'credential_fragment',
      reason: `credential-bearing ${credential} parameter refused`
    };
  }
  // The planned bytes must be the bytes actually requested: HTTP
  // normalization (dot-segment elimination, host aliases, default ports)
  // would silently relocate the target otherwise. No rewrite is performed.
  const rawNoFragment = normalizeSchemeHost(raw.split('#')[0] ?? raw);
  const parsedNoFragment = normalizeSchemeHost(url.href.split('#')[0] ?? url.href);
  if (rawNoFragment !== parsedNoFragment && withRootPath(rawNoFragment) !== parsedNoFragment) {
    return { ok: false, code: 'non_preserving_url', reason: 'HTTP parsing would change the planned request bytes' };
  }
  return { ok: true };
}

/**
 * ONE consistent pure validation for planned requests: shared static URL
 * preflight + safe literal headers + credential-bearing body refusal. Used
 * BEFORE public plan materialization and by the request key entry.
 */
export function validatePlannedRequest(
  request: PlannedDiscoveryRequest
): { ok: true } | { ok: false; code: string; reason: string } {
  const urlCheck = staticHttpsUrlPreflight(request.url);
  if (!urlCheck.ok) return urlCheck;
  for (const name of Object.keys(request.headers)) {
    if (!SAFE_HEADER_NAMES.has(name.toLowerCase())) {
      return { ok: false, code: 'unsafe_header', reason: `header ${name.toLowerCase()} is not a safe literal header` };
    }
  }
  const bodyRisk = bodyCredentialRisk(request.body);
  if (bodyRisk !== null) {
    return { ok: false, code: bodyRisk, reason: 'credential-bearing body material is refused' };
  }
  return { ok: true };
}

/**
 * Canonical HTTP request material — exactly what is sent (only the HTTP
 * fragment is excluded). The planner's request sharing and the opaque
 * request key use this SAME material so both see identical identity.
 */
export function discoveryRequestMaterial(request: PlannedDiscoveryRequest): string {
  return canonicalJson({
    adapterId: request.adapterId,
    operation: request.operation,
    method: request.method,
    url: request.url.split('#')[0] ?? request.url,
    headers: request.headers,
    body: request.body,
    pageScope: request.pageScope
  });
}

const LOCATION_SENTINEL = 'sslocprobe9c2f4a1b';

/**
 * Template-context verification that the substitution value keeps its exact
 * location in the ACTUAL HTTP URL (WHATWG serialization). Dots in path
 * positions (`.`/`..`) would be eliminated as dot segments — those inputs
 * are refused, never "fixed" by percent-encoding (encoded dots are
 * eliminated too). Query usernames and ordinary dotted names stay valid.
 */
function usernameLocationPreserved(template: string, rendered: string, encoded: string): boolean {
  const sentinelRender = template.split('{username}').join(LOCATION_SENTINEL);
  try {
    const sentinelHref = new URL(sentinelRender).href.split('#')[0] ?? '';
    const actualHref = new URL(rendered).href.split('#')[0] ?? '';
    const sentinelSer = normalizeSchemeHost(sentinelHref);
    const actualSer = normalizeSchemeHost(actualHref);
    const index = sentinelSer.indexOf(LOCATION_SENTINEL);
    if (index < 0 || sentinelSer.indexOf(LOCATION_SENTINEL, index + 1) >= 0) return false;
    const pre = sentinelSer.slice(0, index);
    const suf = sentinelSer.slice(index + LOCATION_SENTINEL.length);
    if (actualSer.length < pre.length + suf.length) return false;
    if (!actualSer.startsWith(pre) || !actualSer.endsWith(suf)) return false;
    return actualSer.slice(pre.length, actualSer.length - suf.length) === encoded;
  } catch {
    return false;
  }
}

/** Exact template rendering: exactly one `{username}`, exactly escaped. */
function renderUsernameTemplate(template: string, username: string): string {
  const parts = template.split('{username}');
  if (parts.length !== 2) {
    throw new DiscoveryRequestBuildError('unsafe_template', 'rule template must carry exactly one {username} placeholder');
  }
  const encoded = encodeURIComponent(username);
  const rendered = `${parts[0] ?? ''}${encoded}${parts[1] ?? ''}`;
  if (!usernameLocationPreserved(template, rendered, encoded)) {
    throw new DiscoveryRequestBuildError(
      'input_location_not_preserved',
      'the username cannot be preserved at its template location in the actual HTTP URL (dot segments or other HTTP normalization would relocate it)'
    );
  }
  return rendered;
}

function unsafeRequestReason(request: PlannedDiscoveryRequest): DiscoveryGapCode | null {
  return validatePlannedRequest(request).ok ? null : 'unsafe_template';
}

function unsafeLinkReason(url: string): DiscoveryGapCode | null {
  return staticHttpsUrlPreflight(url).ok ? null : 'unsafe_link';
}

/**
 * Opaque stable request key binding the full context: owner/case/input
 * revision, catalog/rule/policy hashes, authority version and access
 * identity, plus adapter/operation/method/endpoint/safe headers/body/page
 * window. Plain-object key ORDER is canonicalized; arrays, types and nulls
 * are preserved; query duplicates/order, encoded slashes, path case,
 * trailing slashes and literal `+` stay byte exact. Only the HTTP fragment
 * is excluded (it is never sent). Credentials — in URL, query, fragment
 * metadata, headers or body — are refused, never serialized.
 */
export function discoveryRequestKey(request: PlannedDiscoveryRequest, binding: DiscoveryBinding): string {
  const validation = validatePlannedRequest(request);
  if (!validation.ok) {
    throw new DiscoveryRequestKeyError(validation.code, validation.reason);
  }
  const material = canonicalJson({
    v: DISCOVERY_REQUEST_KEY_PREFIX,
    binding: {
      owner: binding.owner,
      caseId: binding.caseId,
      inputRevision: binding.inputRevision,
      registryHash: binding.registryHash,
      ruleHash: binding.ruleHash,
      policyHash: binding.policyHash,
      authorityVersion: binding.authorityVersion,
      accessIdentity: binding.accessIdentity
    },
    requestMaterial: discoveryRequestMaterial(request)
  });
  return `${DISCOVERY_REQUEST_KEY_PREFIX}:${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/* ------------------------------------------------------------------ */
/* Strict selflink template matching                                   */
/* ------------------------------------------------------------------ */

interface TemplateMatch {
  matchedTemplate: string;
  matchBasis: MatchedSelflink['matchBasis'];
  extractedValue: string;
}

/**
 * Deterministic template match only (never TLD/name matching): exact
 * template prefix/suffix with a non-empty substitution segment that cannot
 * cross path/query/fragment boundaries. URL case, encoded slashes, trailing
 * slashes and identity queries/fragments stay verbatim.
 */
function matchProfileTemplate(
  profileUrlRule: string | null,
  url: string,
  instance: string | null
): TemplateMatch | null {
  if (profileUrlRule === null) return null;
  let concrete = profileUrlRule;
  let matchBasis: MatchedSelflink['matchBasis'] = 'exact_template';
  if (profileUrlRule.includes('{instance}')) {
    if (instance === null || instance.length === 0) return null;
    concrete = profileUrlRule.split('{instance}').join(instance);
    matchBasis = 'instance_pinned_template';
  }
  const parts = concrete.split('{username}');
  if (parts.length !== 2) return null;
  const prefix = parts[0] ?? '';
  const suffix = parts[1] ?? '';
  // When the template has no fragment locator, the URL fragment is kept on
  // the clue but never part of the substitution value.
  const target = concrete.includes('#') ? url : (url.split('#')[0] ?? url);
  const normalizedPrefix = normalizeSchemeHost(prefix);
  const normalizedTarget = normalizeSchemeHost(target);
  if (!normalizedTarget.startsWith(normalizedPrefix)) return null;
  if (suffix.length > 0 && !normalizedTarget.endsWith(suffix)) return null;
  if (normalizedTarget.length < normalizedPrefix.length + suffix.length) return null;
  const middle = normalizedTarget.slice(normalizedPrefix.length, normalizedTarget.length - suffix.length);
  if (middle.length === 0) return null;
  const forbidden = prefix.includes('?') ? ['/', '?', '#', '&'] : ['/', '?', '#'];
  for (const char of forbidden) {
    if (middle.includes(char)) return null;
  }
  return { matchedTemplate: concrete, matchBasis, extractedValue: middle };
}

/* ------------------------------------------------------------------ */
/* Input operands (never coerced across kinds)                         */
/* ------------------------------------------------------------------ */

interface ResolvedInput {
  classification: CatalogDiscoveryInput['classification'];
  username: string | null;
  nameQuery: string | null;
  homepageUrl: string | null;
  nativePlatformHint: string | null;
  selflinkSources: Array<{ hintId: string | null; url: string }>;
  usernameValues: Map<string | null, string[]>;
  instanceHints: Record<string, string>;
}

function resolveInput(input: CatalogDiscoveryInput): ResolvedInput {
  if (input.inputRevision.trim().length === 0) {
    throw new DiscoveryPlanInputError('invalid_input_empty', 'inputRevision must not be empty');
  }
  if (input.classification === 'unclassified_text') {
    throw new DiscoveryPlanInputError(
      input.invalid === 'empty' ? 'invalid_input_empty' : 'invalid_input_unclassified',
      'unknown/empty unclassified text is explicit invalid input — never an implicit username'
    );
  }
  // Email privacy refusal happens BEFORE any hint is adopted: no selflink,
  // username or instance hint material enters the public plan, no operation
  // becomes executable and no request is planned.
  if (input.classification === 'email') {
    return {
      classification: 'email',
      username: null,
      nameQuery: null,
      homepageUrl: null,
      nativePlatformHint: null,
      selflinkSources: [],
      usernameValues: new Map<string | null, string[]>(),
      instanceHints: {}
    };
  }
  const usernameValues = new Map<string | null, string[]>();
  const pushUsername = (platformId: string | null, value: string): void => {
    const list = usernameValues.get(platformId) ?? [];
    if (!list.includes(value)) list.push(value);
    usernameValues.set(platformId, list);
  };
  const selflinkSources: Array<{ hintId: string | null; url: string }> = [];
  const instanceHints: Record<string, string> = {};
  const collect = (hints: DiscoveryInputHint[]): void => {
    for (const hint of hints) {
      if (hint.kind === 'username') {
        pushUsername(hint.platformId, hint.value);
      } else if (hint.kind === 'selflink') {
        selflinkSources.push({ hintId: hint.hintId, url: hint.url });
      } else {
        instanceHints[hint.platformId] = hint.instance;
      }
    }
  };
  collect(input.hints);

  let username: string | null = null;
  let nameQuery: string | null = null;
  let homepageUrl: string | null = null;
  let nativePlatformHint: string | null = null;
  switch (input.classification) {
    case 'username':
      if (input.username.trim().length === 0) {
        throw new DiscoveryPlanInputError('invalid_input_empty', 'username must not be empty');
      }
      username = input.username;
      pushUsername(null, input.username);
      break;
    case 'name_query':
      if (input.nameQuery.trim().length === 0) {
        throw new DiscoveryPlanInputError('invalid_input_empty', 'nameQuery must not be empty');
      }
      nameQuery = input.nameQuery;
      break;
    case 'native_id':
      if (input.nativeId.trim().length === 0) {
        throw new DiscoveryPlanInputError('invalid_input_empty', 'nativeId must not be empty');
      }
      nativePlatformHint = input.platformHint;
      break;
    case 'homepage_url':
      if (input.url.trim().length === 0) {
        throw new DiscoveryPlanInputError('invalid_input_empty', 'url must not be empty');
      }
      homepageUrl = input.url;
      selflinkSources.push({ hintId: null, url: input.url });
      break;
    default: {
      const exhaustive: never = input;
      throw new DiscoveryPlanInputError('invalid_input_unclassified', `unknown classification ${JSON.stringify(exhaustive)}`);
    }
  }
  for (const [platformId, hint] of Object.entries(input.instanceHints)) {
    if (typeof hint === 'string' && hint.length > 0) instanceHints[platformId] = hint;
  }
  return {
    classification: input.classification,
    username,
    nameQuery,
    homepageUrl,
    nativePlatformHint,
    selflinkSources,
    usernameValues,
    instanceHints
  };
}

type OperandResolution = { ok: true; kind: DiscoveryOperandKind; text: string | null } | { ok: false; gap: DiscoveryGapCode };

function usernameOperand(resolved: ResolvedInput, entry: CatalogEntry): OperandResolution {
  const values = [
    ...(resolved.usernameValues.get(entry.platformId) ?? []),
    ...(resolved.usernameValues.get(null) ?? [])
  ];
  const distinct = [...new Set(values)];
  if (distinct.length === 0) {
    if (resolved.classification === 'name_query') return { ok: false, gap: 'name_query_no_handler' };
    if (resolved.classification === 'native_id') return { ok: false, gap: 'native_id_not_a_handle' };
    return { ok: false, gap: 'input_kind_unsupported' };
  }
  if (distinct.length > 1) return { ok: false, gap: 'conflicting_username_hints' };
  return { ok: true, kind: 'username', text: distinct[0] ?? null };
}

function searchOperand(resolved: ResolvedInput, entry: CatalogEntry): OperandResolution {
  if (resolved.classification === 'name_query') {
    return { ok: true, kind: 'name_query', text: resolved.nameQuery };
  }
  if (resolved.classification === 'native_id') return { ok: false, gap: 'native_id_no_operation' };
  return usernameOperand(resolved, entry);
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

function hash12(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Rule-backed routes contributed by public-rule groups mapped onto an
 * existing curated platform (their rules link through rule ids, so no
 * duplicate entry exists). Route ids/operations use the same deterministic
 * derivation as the generated catalog entries.
 */
function derivedRuleRoutes(entry: CatalogEntry, snapshot: PlatformCatalogSnapshot): DiscoveryRoute[] {
  const union = snapshot.publicRules;
  if (union === null || union === undefined) return [];
  const covered = new Set(entry.routes.flatMap((route) => route.ruleIds ?? []));
  const out: DiscoveryRoute[] = [];
  for (const group of union.groups) {
    if (group.platformId !== entry.platformId) continue;
    group.requestTemplates.forEach((requestTemplate, index) => {
      const rules = group.rules.filter((rule) => rule.requestTemplate === requestTemplate);
      const ruleIds = rules.map((rule) => rule.ruleId).sort();
      if (ruleIds.length === 0 || ruleIds.every((ruleId) => covered.has(ruleId))) return;
      const sourceRefs = [...new Set(rules.map((rule) => rule.sourceRef.sourceId))].sort();
      const bounded = rules.some((rule) => rule.detection.boundedPositive);
      out.push({
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
      });
    });
  }
  return out;
}

function obligationFor(entry: CatalogEntry, input: CatalogDiscoveryInput, resolved: ResolvedInput): PlatformObligation {
  if (input.classification === 'email') {
    return {
      state: 'not_applicable',
      reasonCode: 'email_input_unsupported_privacy',
      reason:
        '授权邮箱输入本批显式不支持（隐私边界）：零派发、无原始地址/地址哈希、无公开计划请求；邮箱解析沿用 GET-62 本地边界，真实邮箱匹配属 GET-66'
    };
  }
  if (input.classification === 'native_id') {
    if (resolved.nativePlatformHint === null) {
      return {
        state: 'applicable',
        reasonCode: 'native_id_issuer_unresolved',
        reason: 'native_id 缺少已验证发行方命名空间：保留未解决身份证据，零派发，不猜发行方、不做 handle 替代'
      };
    }
    if (entry.platformId !== resolved.nativePlatformHint) {
      return {
        state: 'not_applicable',
        reasonCode: 'native_id_scope_mismatch',
        reason: `native_id 归属显式限定在 ${resolved.nativePlatformHint}（已验证发行方命名空间）；本条目记范围外原因，不做 handle 替代`
      };
    }
    return {
      state: 'applicable',
      reasonCode: 'applicable',
      reason: 'native_id 本轮显式归属平台：义务保留，仅真实 documented native_id 操作可执行，不做 handle 替代'
    };
  }
  return platformObligation(entry, {
    acceptedKinds:
      input.classification === 'username'
        ? ['username']
        : input.classification === 'name_query'
          ? ['name_query']
          : ['homepage_url'],
    instanceHints: resolved.instanceHints,
    authorization: input.authorization,
    nameQueryRound: input.classification === 'name_query',
    accountKinds: input.accountKinds
  });
}

export function planDiscoveryRound(
  snapshot: PlatformCatalogSnapshot,
  input: CatalogDiscoveryInput,
  access: CatalogAccessContext,
  options: DiscoveryPlanOptions = {}
): DiscoveryRoundPlan {
  const inventory = options.inventory ?? DEFAULT_DISCOVERY_OPERATION_INVENTORY;
  const resolved = resolveInput(input);
  const rulesById = new Map<string, PublicDiscoveryRule>();
  for (const rule of snapshot.publicRules?.rules ?? []) rulesById.set(rule.ruleId, rule);

  const requestsByKey = new Map<string, PlannedRequestRecord>();
  const recordsById = new Map<string, PlannedRequestRecord>();
  const unmatched = new Map<string, DiscoveryUnmatchedHint>();
  for (const source of resolved.selflinkSources) {
    unmatched.set(source.hintId ?? 'input-url', {
      hintId: source.hintId ?? 'input-url',
      kind: 'selflink',
      reasonCode: 'no_template_match',
      reason: '尚无匹配'
    });
  }
  const matchedHintIds = new Set<string>();
  const instancePinnedMissing = new Set<string>();

  const platforms: DiscoveryPlatformPlan[] = snapshot.entries.map((entry) => {
    const obligation = obligationFor(entry, input, resolved);
    const instance = resolved.instanceHints[entry.platformId] ?? null;

    /* strict selflink matching (candidate clues; zero dispatch) */
    const selflinks: MatchedSelflink[] = [];
    for (const source of resolved.selflinkSources) {
      const unsafe = unsafeLinkReason(source.url);
      const key = source.hintId ?? 'input-url';
      if (unsafe !== null) {
        if (!matchedHintIds.has(key)) {
          unmatched.set(key, { hintId: key, kind: 'selflink', reasonCode: 'unsafe_link', reason: '不安全链接（非 https / 凭据 URL / 凭据查询）明确拒收，不映射、不请求' });
        }
        continue;
      }
      const match = matchProfileTemplate(entry.profileUrlRule, source.url, instance);
      if (match === null) {
        if (entry.profileUrlRule?.includes('{instance}') === true && instance === null) {
          // Only a hint whose own host would satisfy the pinned template is
          // an instance-hint gap; everything else stays no_template_match.
          const host = source.url.split('://')[1]?.split(/[/?#]/)[0]?.split('@').pop() ?? null;
          if (host !== null && matchProfileTemplate(entry.profileUrlRule, source.url, host) !== null) {
            instancePinnedMissing.add(key);
          }
        }
        continue;
      }
      matchedHintIds.add(key);
      selflinks.push({
        hintId: source.hintId,
        url: source.url,
        matchedTemplate: match.matchedTemplate,
        matchBasis: match.matchBasis,
        extractedValue: match.extractedValue
      });
    }

    /* routes: every catalog route plus derived public-rule routes */
    const routes = [...entry.routes, ...derivedRuleRoutes(entry, snapshot)]
      .map((route) => ({ route, priority: ROUTE_KIND_PRIORITY[route.kind] ?? 9 }))
      .sort((a, b) => a.priority - b.priority || (a.route.routeId < b.route.routeId ? -1 : 1));

    const routePlans = routes.map(({ route, priority }) =>
      planRoute(entry, route, priority, obligation, resolved, access, inventory, rulesById, requestsByKey, recordsById)
    );

    const operations: DiscoveryPlannedOperation[] = [
      ...selflinks.map(
        (selflink, index): DiscoverySelflinkOperation => ({
          kind: 'selflink',
          priority: 0,
          operationKey: `selflink:${selflink.hintId ?? 'input-url'}:${index}`,
          selflink
        })
      ),
      ...routePlans
        .flatMap((routePlan) =>
          routePlan.requestIds.map((requestId): DiscoveryRequestOperation => {
            const record = recordsById.get(requestId);
            return {
              kind: 'request',
              priority: routePlan.priority,
              operationKey: `req:${routePlan.routeId}:${requestId}`,
              requestId,
              routeId: routePlan.routeId,
              routeKind: routePlan.kind,
              handlerId: record?.handlerId ?? 'unknown',
              productionWired: record?.productionWired ?? false,
              cost: record?.cost ?? { amount: null, basis: '计划请求无费用回执（null 不等于免费）' }
            };
          })
        )
        .sort((a, b) => a.priority - b.priority || (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : a.operationKey < b.operationKey ? -1 : 1))
    ];

    let status: DiscoveryPlatformPlan['status'];
    let reasonCode: DiscoveryGapCode;
    let reason: string;
    if (obligation.state === 'not_applicable') {
      status = 'not_applicable';
      reasonCode = obligation.reasonCode as DiscoveryGapCode;
      reason = obligation.reason;
    } else if (operations.length > 0) {
      status = 'planned';
      reasonCode = 'planned';
      reason = `有序可执行操作 ${operations.length} 条（计划只是数据，不发送请求）`;
    } else {
      status = 'no_executable_route';
      const dominant = routePlans.filter((routePlan) => routePlan.status === 'blocked').sort((a, b) => a.priority - b.priority || (a.routeId < b.routeId ? -1 : 1))[0];
      const override: DiscoveryGapCode | null =
        input.classification === 'native_id' && resolved.nativePlatformHint === null ? 'native_id_issuer_unresolved' : null;
      reasonCode = override ?? dominant?.reasonCode ?? 'no_route_registered';
      reason = override !== null
        ? obligation.reason
        : routePlans.length === 0
          ? '目录条目无任何已登记路线：保留适用义务与显式缺口，不缩小分母'
          : `无可执行路线；显式缺口：${routePlans
              .filter((routePlan) => routePlan.status === 'blocked')
              .map((routePlan) => `${routePlan.routeId}=${routePlan.reasonCode}`)
              .join('，')}`;
    }

    return {
      platformId: entry.platformId,
      label: entry.name,
      obligation,
      status,
      reasonCode,
      reason,
      routes: routePlans,
      operations,
      selflinks
    };
  });

  /* unmatched hints keep explicit reasons */
  for (const key of matchedHintIds) unmatched.delete(key);
  for (const [key, item] of unmatched) {
    if (item.reasonCode !== 'no_template_match') continue;
    if (instancePinnedMissing.has(key)) {
      unmatched.set(key, {
        ...item,
        reasonCode: 'instance_hint_missing',
        reason: '实例限定模板缺少可信实例提示：不做 TLD/名字猜测映射'
      });
    }
  }
  const unmatchedHints = [...unmatched.values()].sort((a, b) => (a.hintId < b.hintId ? -1 : 1));

  const gapCounts: Record<string, number> = {};
  const countGap = (code: string): void => {
    gapCounts[code] = (gapCounts[code] ?? 0) + 1;
  };
  for (const platform of platforms) {
    for (const route of platform.routes) {
      if (route.status === 'blocked') countGap(route.reasonCode);
    }
  }
  for (const item of unmatchedHints) countGap(item.reasonCode);

  const totals: DiscoveryPlanTotals = {
    platforms: platforms.length,
    obligations: platforms.filter((platform) => platform.obligation.state === 'applicable').length,
    planned: platforms.filter((platform) => platform.status === 'planned').length,
    noExecutableRoute: platforms.filter((platform) => platform.status === 'no_executable_route').length,
    notApplicable: platforms.filter((platform) => platform.status === 'not_applicable').length,
    admissibleOperations: platforms.reduce((total, platform) => total + platform.operations.length, 0),
    plannedRequests: requestsByKey.size,
    blockedRoutes: platforms.reduce(
      (total, platform) => total + platform.routes.filter((route) => route.status === 'blocked').length,
      0
    ),
    gapCounts: Object.fromEntries(Object.entries(gapCounts).sort(([a], [b]) => (a < b ? -1 : 1)))
  };

  return {
    schemaVersion: DISCOVERY_PLAN_SCHEMA_VERSION,
    registryVersion: snapshot.registryVersion,
    registryHash: snapshot.contentHash,
    inputRevision: input.inputRevision,
    input: {
      classification: input.classification,
      status: input.classification === 'email' ? 'unsupported' : 'accepted',
      reasonCode: input.classification === 'email' ? 'email_input_unsupported_privacy' : 'input_accepted',
      reason:
        input.classification === 'email'
          ? '授权邮箱输入本批显式不支持（隐私边界）：零派发、无原始地址/地址哈希'
          : '受信任公开输入分类已接受；精确 GET-62 输入适配器等待其合并契约'
    },
    platforms,
    requests: [...requestsByKey.values()],
    unmatchedHints,
    totals
  };
}

function planRoute(
  entry: CatalogEntry,
  route: DiscoveryRoute,
  priority: number,
  obligation: PlatformObligation,
  resolved: ResolvedInput,
  access: CatalogAccessContext,
  inventory: DiscoveryOperationInventory,
  rulesById: Map<string, PublicDiscoveryRule>,
  requestsByKey: Map<string, PlannedRequestRecord>,
  recordsById: Map<string, PlannedRequestRecord>
): DiscoveryRoutePlan {
  const routeRules = (route.ruleIds ?? [])
    .map((ruleId) => rulesById.get(ruleId))
    .filter((rule): rule is PublicDiscoveryRule => rule !== undefined);
  const finish = (
    status: 'admissible' | 'blocked',
    reasonCode: DiscoveryGapCode,
    reason: string,
    requestIds: string[] = []
  ): DiscoveryRoutePlan => ({
    routeId: route.routeId,
    kind: route.kind,
    priority,
    status,
    reasonCode,
    reason,
    requestIds,
    ruleIds: routeRules.map((rule) => rule.ruleId).sort(),
    sourceRefs: route.sourceRefs
  });

  if (obligation.state === 'not_applicable') {
    return finish('blocked', obligation.reasonCode as DiscoveryGapCode, `平台义务不适用：${obligation.reason}`);
  }
  const acceptedOperands = ROUTE_KIND_ACCEPTED_OPERANDS[route.kind];
  if (acceptedOperands.length === 0) {
    return finish(
      'blocked',
      route.kind === 'import_report' ? 'manual_import_not_planned' : 'outside_round',
      '该路线不属于本轮派发面（外部报告导入是显式维护动作，不进发现队列）'
    );
  }

  /* operation accepted input — never coerced across kinds */
  let operand: OperandResolution;
  if (acceptedOperands.includes('username') && !acceptedOperands.includes('name_query')) {
    operand = usernameOperand(resolved, entry);
  } else if (route.kind === 'selflink') {
    operand =
      resolved.homepageUrl !== null && resolved.classification === 'homepage_url'
        ? { ok: true, kind: 'selflink_url', text: resolved.homepageUrl }
        : { ok: false, gap: 'input_kind_unsupported' };
  } else {
    operand = searchOperand(resolved, entry);
  }
  if (!operand.ok) {
    return finish('blocked', operand.gap, `操作接受输入不满足：${operand.gap}（名字/文本/数字 ID/邮箱前缀永不填充 username 模板）`);
  }
  if (route.availability === 'unsupported') {
    return finish('blocked', 'unsupported_route', route.reason);
  }

  /* explicit requirements */
  const grant = access.grants[entry.platformId] ?? null;
  const needsInstance =
    route.requires.includes('instance_hint') ||
    (entry.instance === 'required' && (route.kind === 'username_probe' || route.kind === 'selflink'));
  if (needsInstance && (resolved.instanceHints[entry.platformId] ?? null) === null) {
    return finish('blocked', 'instance_hint_missing', '实例限定路线缺少可信实例提示（不做 TLD/名字猜测）');
  }
  if (route.requires.includes('provider_key') && grant?.credentials !== true) {
    return finish('blocked', 'credentials_missing', '缺少 provider 凭据；不改用浏览器/legacy fetch 绕过');
  }
  if (route.requires.includes('login')) {
    return finish('blocked', 'login_required', '本批无登录自动化：登录受限路线显式留缺口');
  }
  if (route.requires.includes('authorization') && grant?.authorization !== true) {
    return finish('blocked', 'authorization_missing', '缺少已授予授权：显式缺口');
  }

  /* trusted handler inventory */
  const handlers = inventory.handlers.filter(
    (handler) =>
      handler.callable &&
      handler.routeKinds.includes(route.kind) &&
      handler.accepts.includes(operand.kind) &&
      (!handler.ruleBacked || routeRules.length > 0)
  );
  const handler = handlers[0];
  if (handler === undefined) {
    return finish(
      'blocked',
      route.availability === 'integrated' ? 'no_safe_handler' : 'no_adapter',
      route.availability === 'integrated'
        ? '目录描述的既有 handler 不在安全操作清单内（legacy 默认 fetch / 研究 adapter / 全量研究 provider 均非安全搜索 handler）'
        : '本项目尚无可执行 adapter：目录条目保留为适用义务 + 显式缺口'
    );
  }

  let drafts: PlannedRequestDraft[] | null = null;
  try {
    drafts = handler.buildRequest({
      entry,
      route,
      rules: routeRules,
      username: operand.kind === 'username' ? operand.text : null,
      nameQuery: resolved.nameQuery
    });
  } catch (error) {
    if (error instanceof DiscoveryRequestBuildError) {
      return finish('blocked', error.reasonCode, error.message);
    }
    throw error;
  }
  if (drafts === null || drafts.length === 0) {
    return finish('blocked', 'no_request_built', 'handler 未构建出请求：显式缺口，不虚构端点');
  }
  for (const draft of drafts) {
    const unsafe = unsafeRequestReason(draft.request);
    if (unsafe !== null) {
      return finish(
        'blocked',
        'unsafe_template',
        '拒绝不安全请求（非 https / 控制字符 / 非法 authority / localhost 或非公网字面 IP / 凭据 URL、查询、fragment 或 body / 非安全头 / HTTP 解析会改写计划字节）'
      );
    }
  }

  const requestIds: string[] = [];
  for (const draft of drafts) {
    // Sharing uses the SAME canonical HTTP material as the opaque key:
    // full material string is the equality authority (never a truncated
    // digest), and only the never-sent HTTP fragment is excluded.
    const material = discoveryRequestMaterial(draft.request);
    const consumers: PlannedRequestConsumer[] =
      draft.ruleIds.length > 0
        ? draft.ruleIds.map((ruleId) => ({
            platformId: entry.platformId,
            routeId: route.routeId,
            ruleId,
            sourceRefs: rulesById.has(ruleId) ? [rulesById.get(ruleId)?.sourceRef.sourceId ?? ''] : route.sourceRefs
          }))
        : [
            {
              platformId: entry.platformId,
              routeId: route.routeId,
              ruleId: null,
              sourceRefs: route.sourceRefs
            }
          ];
    const existing = requestsByKey.get(material);
    if (existing === undefined) {
      const requestId = `prq-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
      const record: PlannedRequestRecord = {
        requestId,
        handlerId: handler.handlerId,
        adapterId: draft.request.adapterId,
        productionWired: handler.productionWired,
        request: draft.request,
        urlVariants: [draft.request.url],
        ruleIds: [...new Set(consumers.map((consumer) => consumer.ruleId).filter((ruleId): ruleId is string => ruleId !== null))].sort(),
        consumers,
        cost: { amount: null, basis: '计划请求在派发前没有费用回执；null 不等于免费' }
      };
      requestsByKey.set(material, record);
      recordsById.set(requestId, record);
      requestIds.push(requestId);
    } else {
      if (!existing.urlVariants.includes(draft.request.url)) existing.urlVariants.push(draft.request.url);
      for (const consumer of consumers) {
        const seen = existing.consumers.some((item) => canonicalJson(item) === canonicalJson(consumer));
        if (!seen) existing.consumers.push(consumer);
      }
      existing.ruleIds = [...new Set([...existing.ruleIds, ...consumers.map((consumer) => consumer.ruleId).filter((ruleId): ruleId is string => ruleId !== null)])].sort();
      requestIds.push(existing.requestId);
    }
  }
  return finish('admissible', 'planned', `可执行计划 ${requestIds.length} 条请求（数据，不发送）`, [...new Set(requestIds)]);
}

export type { PlannedRequestDraft };
