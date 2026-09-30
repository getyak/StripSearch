/**
 * GET-92 shared contract: pure full-catalog discovery route planning,
 * opaque request keys and conservative account keys ("discovery-plan/v1").
 *
 * This module holds the SHARED CONTRACT first — shapes and frozen routing
 * tables — so server, client and tests share one authority. Planning is pure
 * data: `planDiscoveryRound` never fetches, resolves DNS, calls providers,
 * mutates state or registers model tools, and an executable plan is NOT a
 * send. Nothing here promotes catalog facts: a route becoming "planned"
 * never turns a capability into `supported` or `live_verified`.
 *
 * Boundaries baked into these shapes:
 *
 * - Platform discovery obligation is SEPARATE from operation accepted
 *   input (`ROUTE_KIND_ACCEPTED_OPERANDS`). A `name_query` round never
 *   collapses the catalog denominator to zero and never coerces name/text,
 *   numeric native ids or email prefixes into a username template: entries
 *   stay represented with explicit gap reasons (`name_query_no_handler`,
 *   `native_id_not_a_handle`, `input_kind_unsupported`, ...).
 * - An authorized email stays UNSUPPORTED with zero dispatch and no raw
 *   address, address hash or unsafe link anywhere in the public plan; the
 *   type cannot even carry the address. Unknown/empty unclassified text is
 *   explicit invalid input — never an implicit username.
 * - Request identity (`discoveryRequestKey`, implemented in
 *   `server/discovery/route-planner.ts`) binds owner/case/input revision,
 *   catalog/rule/policy context, authority and access identity plus
 *   adapter/operation/method/endpoint/safe headers/body/page window.
 *   Plain-object key ORDER is canonicalized; arrays, types and nulls are
 *   preserved; query duplicate/order, encoded slashes, path case, trailing
 *   slashes and literal `+` vs `%20` are preserved verbatim. Only the HTTP
 *   fragment is excluded (it is never sent); profile identity fragments stay
 *   conservative. Credentials are refused, never serialized.
 * - Account identity (`canonicalAccountKey`, implemented in
 *   `server/discovery/account-key.ts`) is native-id-first ONLY with a
 *   verified issuer namespace, else conservative public-HTTPS URL fallback,
 *   else exact handle + instance + account kind. Opaque ids are strings
 *   (letters/leading zeros/large values preserved); a home instance is never
 *   the native-id issuer; `invalid_handle` placeholders are never verified
 *   handles; remote accts are never emails. Without deterministic
 *   association proof, identities keep separate keys and every conflicting
 *   id/actor/home/kind is retained as an explicit conflict with all
 *   origins — never merged on display name, host, username or similarity.
 */

import type { AllowedScope, IdentitySupport, UserSelection } from './research-case.js';
import type {
  CatalogAccessGrant,
  CatalogAccountKind,
  CatalogEntry,
  CatalogInputKind,
  CatalogRouteKind
} from './platform-catalog.js';

export const DISCOVERY_PLAN_SCHEMA_VERSION = 'stripsearch/discovery-plan/v1';
/** Prefix of opaque stable request keys (`discoveryRequestKey`). */
export const DISCOVERY_REQUEST_KEY_PREFIX = 'sdrk/1';
/** Prefix of canonical account keys (`canonicalAccountKey`). */
export const ACCOUNT_KEY_PREFIX = 'ssack/1';

/* ------------------------------------------------------------------ */
/* Accepted public input classification                                */
/* ------------------------------------------------------------------ */

/**
 * The server-owned trusted classification of a round's public input. The
 * exact GET-62 input adapter waits for its merged contract; this shape is
 * the neutral projection both can map onto.
 */
export type DiscoveryInputClassification =
  | 'username'
  | 'name_query'
  | 'native_id'
  | 'email'
  | 'homepage_url'
  | 'unclassified_text';

export type DiscoveryAuthorization = 'self' | 'consent_obtained' | 'public_professional';

/** Explicit public username. Platform-scoped when `platformId` is set. */
export interface DiscoveryUsernameHint {
  hintId: string;
  kind: 'username';
  platformId: string | null;
  /** Exact observed value; never derived from a name, text, id or email. */
  value: string;
}

/** Traceable selflink (an actually located public link), with provenance. */
export interface DiscoverySelflinkHint {
  hintId: string;
  kind: 'selflink';
  /** Verbatim public URL; unsafe links are refused, never fetched. */
  url: string;
  /** Public provenance locator of the hint (never a private path/URL). */
  origin: string;
}

/** Instance hint for instance-scoped platforms (e.g. a Mastodon host). */
export interface DiscoveryInstanceHint {
  hintId: string;
  kind: 'instance';
  platformId: string;
  instance: string;
}

export type DiscoveryInputHint = DiscoveryUsernameHint | DiscoverySelflinkHint | DiscoveryInstanceHint;

interface CatalogDiscoveryInputBase {
  /** Server-owned opaque revision of the trusted input projection. */
  inputRevision: string;
  /** Declared research authorization policy for the round. */
  authorization: DiscoveryAuthorization;
  /** Server-owned instance hints (hints list may carry more). */
  instanceHints: Record<string, string | null>;
  /**
   * Sought account kinds (GET-62 person/organization ambiguity stays
   * explicit). Entries whose kinds are all non-`unknown` and disjoint are
   * excluded explicitly; `unknown` never shrinks the denominator.
   */
  accountKinds: CatalogAccountKind[] | null;
  /** Explicit public hints only. Never email material or credentials. */
  hints: DiscoveryInputHint[];
}

export interface UsernameDiscoveryInput extends CatalogDiscoveryInputBase {
  classification: 'username';
  /** Explicit public username as accepted; case preserved verbatim. */
  username: string;
}

export interface NameQueryDiscoveryInput extends CatalogDiscoveryInputBase {
  classification: 'name_query';
  /** Explicit name/text query. NEVER a username and never coerced into one. */
  nameQuery: string;
}

export interface NativeIdDiscoveryInput extends CatalogDiscoveryInputBase {
  classification: 'native_id';
  /** Opaque native account id STRING (never Number, never a handle). */
  nativeId: string;
  /** Verified issuer namespace, or null when unresolved (never guessed). */
  nativeIdIssuer: string | null;
  /** Platform the id belongs to when known; null keeps it unresolved. */
  platformHint: string | null;
}

/**
 * An authorized email round. The address itself is NEVER carried here (no
 * raw address, no address hash): the classification is unsupported for
 * dispatch in this batch and produces zero operations.
 */
export interface EmailDiscoveryInput extends CatalogDiscoveryInputBase {
  classification: 'email';
}

export interface HomepageUrlDiscoveryInput extends CatalogDiscoveryInputBase {
  classification: 'homepage_url';
  /** Public HTTPS homepage as accepted (an explicit selflink source). */
  url: string;
}

/** Unknown/empty unclassified text: representable, and explicitly invalid. */
export interface UnclassifiedTextInput extends CatalogDiscoveryInputBase {
  classification: 'unclassified_text';
  invalid: 'empty' | 'unclassified';
}

export type CatalogDiscoveryInput =
  | UsernameDiscoveryInput
  | NameQueryDiscoveryInput
  | NativeIdDiscoveryInput
  | EmailDiscoveryInput
  | HomepageUrlDiscoveryInput
  | UnclassifiedTextInput;

/* ------------------------------------------------------------------ */
/* Operation accepted input (SEPARATE from platform obligation)        */
/* ------------------------------------------------------------------ */

/**
 * Which operand a route operation can consume. This is the operation-level
 * accepted input contract: it never derives from adapter existence and never
 * substitutes one operand for another (names/text/numeric ids/email prefixes
 * are never `username`).
 */
export type DiscoveryOperandKind = 'username' | 'name_query' | 'native_id' | 'selflink_url';

/** Route priority bands, exactly the approved spec §6 order. */
export const ROUTE_KIND_PRIORITY: Readonly<Record<CatalogRouteKind, number>> = {
  selflink: 0,
  username_probe: 1,
  platform_search: 2,
  official_search: 3,
  site_search: 4,
  wechat_search: 5,
  import_report: 9,
  none: 9
};

/**
 * Operation accepted input per route kind. `username_probe` only ever takes
 * an explicit username operand; `name_query` and `native_id` operands are
 * distinct and never fill a username template.
 */
export const ROUTE_KIND_ACCEPTED_OPERANDS: Readonly<Record<CatalogRouteKind, readonly DiscoveryOperandKind[]>> = {
  selflink: ['selflink_url'],
  username_probe: ['username'],
  platform_search: ['name_query', 'username'],
  official_search: ['name_query', 'username'],
  site_search: ['name_query', 'username'],
  wechat_search: ['name_query', 'username'],
  import_report: [],
  none: []
};

/** Search-style route kinds that may consume a name query operand. */
export const NAME_QUERY_ROUTE_KINDS: ReadonlySet<CatalogRouteKind> = new Set<CatalogRouteKind>([
  'platform_search',
  'official_search',
  'site_search',
  'wechat_search'
]);

/* ------------------------------------------------------------------ */
/* Request identity                                                    */
/* ------------------------------------------------------------------ */

/** Page window bound into request identity. Distinct windows never dedupe. */
export interface DiscoveryPageScope {
  /** 1-based page window within the route's enumeration. */
  page: number;
  pageSize: number | null;
}

/**
 * Exact request identity (data, never a send): what `discoveryRequestKey`
 * binds. `url` keeps query duplicates/order, encoded slashes, path case,
 * trailing slashes and literal `+` verbatim; only the HTTP fragment is
 * excluded for the actual request.
 */
export interface PlannedDiscoveryRequest {
  /** Adapter identity behind the request (handler/adapter id), or null. */
  adapterId: string | null;
  /** Stable operation id (catalog route operation), never executes alone. */
  operation: string;
  method: 'GET' | 'POST';
  url: string;
  /** Safe literal headers only (accept/accept-language); never credentials. */
  headers: Record<string, string>;
  /** Literal request body (data); null for GET. Never credential material. */
  body: string | null;
  pageScope: DiscoveryPageScope;
}

/**
 * Neutral server-owned binding. GET-63 maps its finalized GET-62 binding
 * onto this; `authorityVersion` is rechecked before send/commit and
 * `accessIdentity` keeps distinct credential/authorization holders apart
 * (without ever serializing credentials).
 */
export interface DiscoveryBinding {
  owner: string;
  caseId: string;
  inputRevision: string;
  /** Catalog snapshot identity (composed identity covers the rule bundle). */
  registryHash: string;
  /** Public rule bundle identity, or null when no bundle is bound. */
  ruleHash: string | null;
  /** Request policy identity, or null when unbound (runner re-checks). */
  policyHash: string | null;
  /** Actual authority/scope version, or null when none is established. */
  authorityVersion: string | null;
  /** Opaque credential/authorization holder identity. Never a credential. */
  accessIdentity: string | null;
}

/* ------------------------------------------------------------------ */
/* Platform obligation (shared by planner and completion projection)   */
/* ------------------------------------------------------------------ */

/**
 * The platform-level discovery obligation for one round. This is decided
 * ONLY by explicit constraints — account kinds, the authorization policy,
 * accepted catalog input kinds and instance hints — never by whether an
 * adapter exists. `name_query` rounds additionally PRESERVE every public
 * account obligation and report `name_query_no_handler` /
 * `instance_hint_missing` gaps instead of shrinking the denominator.
 */
export function platformObligation(entry: CatalogEntry, ctx: PlatformObligationContext): PlatformObligation {
  // Explicit account-kind constraint. An `unknown` source kind never shrinks
  // the denominator: unknown ≠ proof that the entry is out of scope.
  if (ctx.accountKinds !== null) {
    const overlaps = entry.accountKinds.some((kind) => kind === 'unknown' || ctx.accountKinds?.includes(kind) === true);
    if (!overlaps) {
      return {
        state: 'not_applicable',
        reasonCode: 'account_kind_mismatch',
        reason: `账号种类不匹配：目录 ${entry.accountKinds.join('/')}，本轮 ${ctx.accountKinds.join('/')}`
      };
    }
  }
  const authorizations = entry.applicability.authorizations;
  if (ctx.nameQueryRound) {
    // name_query never collapses the denominator: every remaining entry is a
    // discovery obligation and missing handlers/instances stay explicit gaps.
    if (authorizations.length > 0 && !authorizations.includes(ctx.authorization)) {
      return {
        state: 'not_applicable',
        reasonCode: 'authorization_policy_mismatch',
        reason: `授权策略不满足：需要 ${authorizations.join('/')}，当前 ${ctx.authorization}`
      };
    }
    const constraints: string[] = [];
    if (!entry.routes.some((route) => NAME_QUERY_ROUTE_KINDS.has(route.kind))) {
      constraints.push('目录未登记 name 查询/搜索路线（name_query_no_handler）');
    }
    if (entry.instance === 'required' && !ctx.instanceHints[entry.platformId]) {
      constraints.push('缺实例提示（instance_hint_missing）');
    }
    // Route kinds are catalog DESCRIPTIONS, never proof that a handler
    // exists: this projection does not judge readiness and must not claim an
    // empty gap list. The planner records the actual structured gaps from
    // the trusted operation inventory without shrinking the denominator.
    return {
      state: 'applicable',
      reasonCode: 'name_query_obligation',
      reason:
        'name_query 发现义务保留（分母不缩小）' +
        (constraints.length > 0 ? `；投影级已知约束：${constraints.join('/')}` : '') +
        '；handler/操作准备度不在本投影判定，未执行路线的实际结构化缺口由计划器按操作清单记录'
    };
  }
  // Legacy completion semantics (GET-90/91 compatibility) for the other
  // accepted kinds: exact frozen reasons, adapter existence irrelevant.
  const kinds = ctx.acceptedKinds.filter((kind) => entry.inputKinds.includes(kind));
  if (kinds.length === 0) {
    return {
      state: 'not_applicable',
      reasonCode: 'input_kind_not_accepted',
      reason: `输入种类不匹配：目录支持 ${entry.inputKinds.join('/')}，本轮输入 ${ctx.acceptedKinds.join('/') || '（空）'}`
    };
  }
  if (entry.instance === 'required' && !ctx.instanceHints[entry.platformId]) {
    return {
      state: 'not_applicable',
      reasonCode: 'instance_hint_missing',
      reason: `实例限定平台缺少实例提示（${entry.platformId}）`
    };
  }
  if (authorizations.length > 0 && !authorizations.includes(ctx.authorization)) {
    return {
      state: 'not_applicable',
      reasonCode: 'authorization_policy_mismatch',
      reason: `授权策略不满足：需要 ${authorizations.join('/')}，当前 ${ctx.authorization}`
    };
  }
  return {
    state: 'applicable',
    reasonCode: 'applicable',
    reason: `目录内适用平台：输入 ${kinds.join('/')}，授权 ${ctx.authorization}，冻结为发现义务`
  };
}

export interface PlatformObligationContext {
  /** Catalog-level input kinds accepted for the round. */
  acceptedKinds: CatalogInputKind[];
  instanceHints: Record<string, string | null>;
  authorization: DiscoveryAuthorization;
  /**
   * name_query rounds preserve every public-account obligation and record
   * `name_query_no_handler` / `instance_hint_missing` gaps instead of
   * shrinking the denominator to zero.
   */
  nameQueryRound: boolean;
  /** Sought account kinds, or null for no restriction. */
  accountKinds: CatalogAccountKind[] | null;
}

export type PlatformObligationState = 'applicable' | 'not_applicable';

export interface PlatformObligation {
  state: PlatformObligationState;
  reasonCode: string;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export type DiscoveryPlatformPlanStatus = 'planned' | 'no_executable_route' | 'not_applicable';

/** Structured, explicit gap/refusal reasons. Failures are never results. */
export type DiscoveryGapCode =
  | 'planned'
  | 'input_kind_not_accepted'
  | 'name_query_no_handler'
  | 'native_id_not_a_handle'
  | 'native_id_no_operation'
  | 'native_id_issuer_unresolved'
  | 'native_id_scope_mismatch'
  | 'email_input_unsupported_privacy'
  | 'instance_hint_missing'
  | 'credentials_missing'
  | 'login_required'
  | 'authorization_missing'
  | 'authorization_policy_mismatch'
  | 'account_kind_mismatch'
  | 'input_kind_unsupported'
  | 'no_adapter'
  | 'no_safe_handler'
  | 'no_request_built'
  | 'unsupported_route'
  | 'manual_import_not_planned'
  | 'outside_round'
  | 'conflicting_username_hints'
  | 'unsafe_template'
  | 'unsafe_link'
  | 'missing_rule'
  | 'no_template_match'
  | 'not_applicable'
  | 'no_route_registered'
  | 'input_location_not_preserved';

/**
 * A selflink mapped onto an entry by STRICT deterministic template match
 * only (exact canonical template, instance pinned when the template is
 * instance-scoped). Never TLD/name matching. The extracted value is a
 * template substitution candidate clue — NOT a verified handle — and the
 * URL stays verbatim (case, encoded slash, trailing slash, identity query
 * and fragment preserved).
 */
export interface MatchedSelflink {
  hintId: string | null;
  url: string;
  matchedTemplate: string;
  matchBasis: 'exact_template' | 'instance_pinned_template';
  /** Verbatim template substitution value; never a verified username. */
  extractedValue: string;
}

export interface DiscoveryUnmatchedHint {
  hintId: string;
  kind: DiscoveryInputHint['kind'];
  reasonCode: DiscoveryGapCode;
  reason: string;
}

export interface DiscoveryRoutePlan {
  routeId: string;
  kind: CatalogRouteKind;
  /** Priority band (0 selflink, 1 username probe, 2–4 search, ...). */
  priority: number;
  status: 'admissible' | 'blocked';
  reasonCode: DiscoveryGapCode;
  reason: string;
  /** Planned shared-request ids serving this route (data, not sends). */
  requestIds: string[];
  /** Every rule id behind this route — independent lineage, never merged. */
  ruleIds: string[];
  sourceRefs: string[];
}

export interface DiscoverySelflinkOperation {
  kind: 'selflink';
  priority: 0;
  operationKey: string;
  selflink: MatchedSelflink;
}

export interface DiscoveryRequestOperation {
  kind: 'request';
  priority: number;
  operationKey: string;
  requestId: string;
  routeId: string;
  routeKind: CatalogRouteKind;
  handlerId: string;
  /** Always false in this batch: planning never wires the production run. */
  productionWired: boolean;
  /** Unknown cost is explicit null + basis. `null` never means free. */
  cost: { amount: null; basis: string };
}

export type DiscoveryPlannedOperation = DiscoverySelflinkOperation | DiscoveryRequestOperation;

/** One request the planner may adopt, with the rules it serves exactly. */
export interface PlannedRequestDraft {
  request: PlannedDiscoveryRequest;
  /** Rules whose predicates this exact request serves (shared response). */
  ruleIds: string[];
}

/** Independent lineage of one platform/route obligation behind a request. */
export interface PlannedRequestConsumer {
  platformId: string;
  routeId: string;
  ruleId: string | null;
  sourceRefs: string[];
}

/**
 * One exact shared request. Different detection predicates share the record
 * when method + URL + safe headers + body + page scope match exactly, while
 * every ruleId/routeId/source origin stays an independent consumer.
 */
export interface PlannedRequestRecord {
  requestId: string;
  handlerId: string;
  adapterId: string | null;
  productionWired: boolean;
  request: PlannedDiscoveryRequest;
  /**
   * Original raw request URLs (identity-bearing fragments included) that
   * share this exact HTTP request material. Only the HTTP fragment is
   * excluded from request identity because it is never sent — account and
   * clue identity fragments stay preserved here and in keys/clues.
   */
  urlVariants: string[];
  ruleIds: string[];
  consumers: PlannedRequestConsumer[];
  cost: { amount: null; basis: string };
}

export interface DiscoveryPlatformPlan {
  platformId: string;
  label: string;
  obligation: PlatformObligation;
  status: DiscoveryPlatformPlanStatus;
  reasonCode: DiscoveryGapCode;
  reason: string;
  /** Every catalog route with its explicit admissibility reason. */
  routes: DiscoveryRoutePlan[];
  /** Ordered admissible operations (selflink clues first, then requests). */
  operations: DiscoveryPlannedOperation[];
  /** Deterministic selflink matches for this entry (candidate clues only). */
  selflinks: MatchedSelflink[];
}

export interface DiscoveryPlanInputStatus {
  classification: DiscoveryInputClassification;
  /** `unsupported` = explicit privacy/input refusal (authorized email). */
  status: 'accepted' | 'unsupported';
  reasonCode: string;
  reason: string;
}

/** Counts only — never a coverage percentage and never a cost claim. */
export interface DiscoveryPlanTotals {
  platforms: number;
  obligations: number;
  planned: number;
  noExecutableRoute: number;
  notApplicable: number;
  admissibleOperations: number;
  plannedRequests: number;
  blockedRoutes: number;
  gapCounts: Record<string, number>;
}

export interface DiscoveryRoundPlan {
  schemaVersion: string;
  registryVersion: string;
  /** Catalog snapshot identity; the composed hash covers the rule bundle. */
  registryHash: string;
  inputRevision: string;
  input: DiscoveryPlanInputStatus;
  /** Exactly one plan per catalog entry, in snapshot order (no cap/page). */
  platforms: DiscoveryPlatformPlan[];
  /** Exact shared requests; every consumer lineage stays independent. */
  requests: PlannedRequestRecord[];
  unmatchedHints: DiscoveryUnmatchedHint[];
  totals: DiscoveryPlanTotals;
}

/* ------------------------------------------------------------------ */
/* Account identity and candidate drafts                               */
/* ------------------------------------------------------------------ */

export interface AccountNativeId {
  /** Opaque id as a STRING: never Number, leading zeros/letters preserved. */
  id: string;
  /**
   * Verified issuer API namespace. `null` = NOT verified: the id is kept as
   * unresolved evidence and never claims an issuer (a home instance is not
   * an issuer for remote/federated accounts).
   */
  issuer: string | null;
}

/**
 * Deterministic provider evidence binding a native id to a profile/actor
 * URL. Display names, hosts, usernames and similarity are NEVER proof.
 */
export interface AccountAssociationProof {
  basis: 'same_actor_uri' | 'provider_identity_mapping';
  /** Stable locatable evidence receipt/locator. */
  evidenceRef: string;
  nativeIds: AccountNativeId[];
  urls: string[];
}

export interface DiscoveredAccountIdentity {
  platformId: string;
  /** Instance host[:port] exactly observed (ports/subdomains distinct). */
  instance: string | null;
  accountKind: CatalogAccountKind;
  /** Primary opaque native id (string) or null. */
  nativeId: string | null;
  /** Verified issuer namespace of `nativeId`, or null (never guessed). */
  nativeIdIssuer: string | null;
  /** Public safe HTTPS profile URL evidence (conservative fallback). */
  profileUrl: string | null;
  /** Actor/profile URI evidence when observed. */
  actorUrl: string | null;
  /** Observed handle exactly as seen; never case-folded by default. */
  handle: string | null;
  /** Source placeholders (`invalid_handle`) are never verified handles. */
  handleVerified: boolean;
  /** Account home host when observed; never the native-id issuer. */
  homeInstance: string | null;
  associationProof: AccountAssociationProof | null;
}

export interface CandidateOrigin {
  originId: string;
  observedAt: string;
  provenance: {
    kind: 'selflink' | 'username_probe' | 'platform_search' | 'official_search' | 'site_search' | 'import_report' | 'hint';
    platformId: string;
    routeId: string | null;
    ruleId: string | null;
    requestKey: string | null;
    sourceRefs: string[];
  };
  /** Locatable anchor, never the whole page. */
  locator: string | null;
  excerpt: string | null;
}

export interface CandidateConflict {
  field: 'nativeId' | 'nativeIdIssuer' | 'profileUrl' | 'actorUrl' | 'homeInstance' | 'handle' | 'accountKind' | 'instance';
  existing: string | null;
  incoming: string | null;
  originIds: string[];
  note: string;
}

export type CandidateMergeBasis = 'canonical_key' | 'association_proof';

/**
 * A discovered candidate draft. The three selection facets start
 * `proposed` / `unanswered` / `none` for new candidates: discovery never
 * creates identity support, a user choice or reading scope.
 */
export interface CandidateDraft {
  identity: DiscoveredAccountIdentity;
  /** Canonical account key, or null when no conservative key exists. */
  canonicalKey: string | null;
  mergeBasis: CandidateMergeBasis | null;
  origins: CandidateOrigin[];
  conflicts: CandidateConflict[];
  identitySupport: IdentitySupport;
  userSelection: UserSelection;
  allowedScope: AllowedScope;
}

/* ------------------------------------------------------------------ */
/* Canonical JSON (shared, dependency-free)                            */
/* ------------------------------------------------------------------ */

/**
 * Deterministic canonical JSON: plain-object key ORDER is canonicalized
 * (sorted), while arrays, value types and explicit nulls are preserved
 * verbatim (`{a:null}` ≠ `{}`, `[1,2]` ≠ `[2,1]` ≠ `['1','2']`). Query
 * strings inside URLs are never re-encoded here — URL strings stay byte
 * exact and only lose their HTTP fragment at the request-key layer.
 *
 * Only JSON primitives, arrays and PLAIN objects (Object.prototype or null
 * prototype) are accepted. `Date`, `Map`, `Set`, class instances, functions,
 * `undefined`, non-finite numbers and cycles are refused with a `TypeError`
 * instead of silently colliding on `{}`.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out, []);
  return out.join('');
}

function writeCanonical(value: unknown, out: string[], stack: unknown[]): void {
  if (stack.includes(value)) throw new TypeError('canonicalJson: circular structure');
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported value ${typeof value}`);
  }
  stack.push(value);
  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(',');
      writeCanonical(value[index], out, stack);
    }
    out.push(']');
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: non-plain object is not canonicalizable');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    out.push('{');
    let first = true;
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) {
        throw new TypeError('canonicalJson: undefined is not a canonicalizable value');
      }
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(key), ':');
      writeCanonical(item, out, stack);
    }
    out.push('}');
  }
  stack.pop();
}
