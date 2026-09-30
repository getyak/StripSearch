/**
 * GET-92 route planner tests: the pure full-catalog discovery round plan,
 * opaque request keys and shared-request lineage.
 *
 * Everything here is offline: `planDiscoveryRound` is data-only — it never
 * fetches, resolves DNS, calls providers, mutates state or registers model
 * tools, and an executable plan is not a send. The tests cover:
 *
 * - the REAL 4421-entry composed catalog planned in full (no four-platform
 *   cap, no first-API-page truncation) with explicit no-adapter / name_query
 *   gaps and zero denominator collapse;
 * - name text, numeric native ids and email prefixes never becoming
 *   username template values; authorized email = zero operations and no
 *   address material; unclassified/empty text = explicit invalid input;
 * - traceable selflinks mapped only by strict template/instance matching;
 * - route priority order (selflink → username probe → platform search →
 *   official search → site search) through a trusted injectable operation
 *   inventory that exercises the real request contract but cannot promote
 *   catalog facts;
 * - different predicates sharing one exact request while every rule/route/
 *   source origin stays independent;
 * - safe URLs/headers only, credentials refused;
 * - opaque request keys binding owner/case/input/registry/rule/policy/
 *   authority/access/page/method/body with object-order-only equality.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type {
  CatalogAccessContext,
  CatalogEntry,
  DiscoveryRoute,
  PlatformCatalogSnapshot
} from '../shared/platform-catalog.js';
import type { PublicDiscoveryRule, PublicRuleUnion } from '../shared/public-discovery-rules.js';
import { canonicalJson } from '../shared/discovery-plan.js';
import type {
  CatalogDiscoveryInput,
  DiscoveryBinding,
  DiscoveryInputHint,
  DiscoveryRoundPlan,
  DiscoveryRoutePlan,
  MatchedSelflink,
  PlannedDiscoveryRequest,
  PlannedRequestDraft
} from '../shared/discovery-plan.js';
import {
  DEFAULT_DISCOVERY_OPERATION_INVENTORY,
  DiscoveryPlanInputError,
  discoveryRequestKey,
  planDiscoveryRound
} from '../server/discovery/route-planner.js';
import type {
  DiscoveryOperationHandler,
  DiscoveryOperationInventory,
  DiscoveryRequestBuildContext
} from '../server/discovery/route-planner.js';
import { loadPlatformCatalog } from '../server/platforms/catalog.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourceDataDir = path.join(appRoot, 'data', 'platforms');

/* ------------------------------------------------------------------ */
/* Synthetic fixtures (test-only builders)                             */
/* ------------------------------------------------------------------ */

function capabilityFixture(dimension: CatalogEntry['capabilities'][number]['dimension']) {
  return {
    dimension,
    documentation: 'documented' as const,
    docUrls: [],
    endpoints: ['GET /fixture'],
    sourceLocator: 'fixture:doc',
    integration: 'not_integrated' as const,
    access: 'public' as const,
    verification: 'documented_only' as const,
    verificationRef: null,
    cost: {
      provider: null,
      unit: null,
      currency: null,
      amount: null,
      asOf: null,
      source: null,
      basis: '合成夹具无价格依据；null 不等于免费。',
      conditions: null
    },
    sourceRefs: ['src-fixture'],
    operations: [],
    notes: []
  };
}

function routeFixture(over: Partial<DiscoveryRoute> = {}): DiscoveryRoute {
  return {
    routeId: 'r-fixture',
    kind: 'username_probe',
    operation: 'probe:username',
    adapterId: null,
    endpoint: 'https://site.test/u/{username}',
    requires: ['public_network'],
    availability: 'not_integrated',
    reason: '合成夹具路线。',
    sourceRefs: ['src-fixture'],
    ...over
  };
}

function entryFixture(platformId: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    platformId,
    name: `Synthetic ${platformId}`,
    cohort: 'alternative',
    aliases: [],
    homepage: 'https://site.test',
    profileUrlRule: 'https://site.test/{username}',
    instance: 'none',
    inputKinds: ['username'],
    accountKinds: ['person'],
    applicability: { authorizations: [], conditions: [] },
    capabilities: [
      capabilityFixture('discovery'),
      capabilityFixture('profile'),
      capabilityFixture('list'),
      capabilityFixture('body'),
      capabilityFixture('media'),
      capabilityFixture('comments'),
      capabilityFixture('pagination')
    ],
    routes: [routeFixture({ routeId: `${platformId}-probe` })],
    legacy: null,
    notes: [],
    ...over
  };
}

function snapshotFixture(entries: CatalogEntry[], publicRules: PublicRuleUnion | null = null): PlatformCatalogSnapshot {
  return {
    schemaVersion: 'stripsearch/platform-catalog/v1',
    registryVersion: '2026-09-30.fixture',
    contentHash: 'sha256:' + '0'.repeat(64),
    generatedAt: '2026-09-30T00:00:00Z',
    sources: [],
    entries,
    mode: 'curated_only',
    publicRules
  };
}

function ruleFixture(ruleId: string, over: Partial<PublicDiscoveryRule> = {}): PublicDiscoveryRule {
  return {
    ruleId,
    sourceRef: { sourceId: 'maigret', rowId: `row-${ruleId}`, rowSha256: 'a'.repeat(64) },
    sourceName: 'Synthetic',
    canonicalProfileTemplate: 'https://site.test/{username}',
    requestTemplate: 'https://site.test/u/{username}',
    instanceHost: 'site.test',
    accountKind: 'unknown',
    detection: {
      kind: 'bounded_strings',
      presentStatus: 200,
      presentAny: ['FOUND'],
      nonProofPresentAny: [],
      absentStatus: 404,
      absentAny: ['MISSING'],
      boundedPositive: true,
      boundedNegative: true
    },
    caseSensitive: true,
    ratePerMinute: null,
    protections: [],
    errorMarkers: [],
    safeHeaders: { accept: 'text/html' },
    ...over
  };
}

function unionFixture(rules: PublicDiscoveryRule[]): PublicRuleUnion {
  return {
    schemaVersion: 'stripsearch/public-rules/v1',
    importerVersion: 'get91-public-rule-importer/1',
    rules,
    groups: [],
    counts: {
      sourceRows: rules.length,
      loaded: rules.length,
      excluded: 0,
      unionPlatforms: 0,
      unionInstances: 0,
      unionRoutes: 0,
      generatedPlatforms: 0,
      knownMappedGroups: 0
    }
  };
}

function baseInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputRevision: 'input-1',
    authorization: 'public_professional',
    instanceHints: {},
    accountKinds: null,
    hints: [] as DiscoveryInputHint[],
    ...over
  };
}

function usernameInput(over: Record<string, unknown> = {}): CatalogDiscoveryInput {
  return baseInput({ classification: 'username', username: 'alice', ...over }) as unknown as CatalogDiscoveryInput;
}

function nameQueryInput(over: Record<string, unknown> = {}): CatalogDiscoveryInput {
  return baseInput({ classification: 'name_query', nameQuery: 'Alice Smith', ...over }) as unknown as CatalogDiscoveryInput;
}

const emptyAccess: CatalogAccessContext = { grants: {} };

/** A trusted test handler exercising the real planned-request contract. */
function handlerFixture(over: Partial<DiscoveryOperationHandler> = {}): DiscoveryOperationHandler {
  return {
    handlerId: 'test-handler',
    routeKinds: ['platform_search'],
    accepts: ['name_query', 'username'],
    ruleBacked: false,
    callable: true,
    productionWired: false,
    buildRequest: (context: DiscoveryRequestBuildContext): PlannedRequestDraft[] | null => [
      {
        request: {
          adapterId: 'test-handler',
          operation: context.route.operation,
          method: 'GET',
          url: `https://search.test/find?target=${encodeURIComponent(context.entry.platformId)}`,
          headers: { accept: 'application/json' },
          body: null,
          pageScope: { page: 1, pageSize: null }
        },
        ruleIds: []
      }
    ],
    ...over
  };
}

function inventoryFixture(handlers: DiscoveryOperationHandler[]): DiscoveryOperationInventory {
  return { handlers };
}

function planOf(snapshot: PlatformCatalogSnapshot, input: CatalogDiscoveryInput, access: CatalogAccessContext = emptyAccess, inventory?: DiscoveryOperationInventory): DiscoveryRoundPlan {
  return planDiscoveryRound(snapshot, input, access, inventory ? { inventory } : undefined);
}

function planJson(plan: DiscoveryRoundPlan): string {
  return JSON.stringify(plan);
}

/* ------------------------------------------------------------------ */
/* Full real catalog: no cap, no denominator collapse                   */
/* ------------------------------------------------------------------ */

test('name_query round plans the full real 4421-entry catalog with explicit gaps and zero denominator collapse', () => {
  const snapshot = loadPlatformCatalog(sourceDataDir);
  assert.equal(snapshot.entries.length, 4421, 'frozen composed catalog identity');
  assert.equal(snapshot.registryVersion, '2026-09-30.1+pr.810481dbf9fd');

  const plan = planOf(snapshot, nameQueryInput({ authorization: 'self' }));
  assert.equal(plan.schemaVersion, 'stripsearch/discovery-plan/v1');
  assert.equal(plan.platforms.length, snapshot.entries.length, 'every catalog entry keeps a plan row');
  assert.deepEqual(
    plan.platforms.map((platform) => platform.platformId),
    snapshot.entries.map((entry) => entry.platformId),
    'full snapshot order — not a four-platform cap or first API page'
  );

  // name_query obligations never shrink to zero: no entry becomes not_applicable
  // just because only username operations exist.
  assert.equal(plan.totals.platforms, 4421);
  assert.equal(plan.totals.obligations, 4421, 'name_query keeps every entry an obligation');
  assert.equal(plan.totals.notApplicable, 0);
  assert.equal(plan.totals.planned, 0, 'no name handler exists — nothing is silently planned');
  assert.equal(plan.requests.length, 0, 'zero dispatchable operations');
  assert.equal(
    plan.platforms.reduce((total, platform) => total + platform.operations.length, 0),
    0
  );

  for (const platform of plan.platforms) {
    assert.equal(platform.status, 'no_executable_route');
    assert.ok(platform.reasonCode.length > 0 && platform.reason.trim().length > 0, `${platform.platformId} keeps an explicit reason`);
    for (const route of platform.routes) {
      assert.equal(route.status, 'blocked');
      assert.equal(route.requestIds.length, 0);
    }
  }
  const codes = new Set(plan.platforms.map((platform) => platform.reasonCode));
  assert.ok(codes.has('name_query_no_handler'), 'username-only entries keep an explicit name_query gap');
  assert.ok(codes.has('credentials_missing') || codes.has('no_safe_handler') || codes.has('no_adapter'), 'no-adapter gaps stay explicit');

  // No fabricated results, coverage percentages or cost claims.
  const serialized = planJson(plan);
  assert.ok(!serialized.includes('checked_no_match'), 'failures/unknown/plans are never checked_no_match');
  assert.ok(!serialized.includes('"coverage') && !serialized.includes('percent'), 'no fake coverage percentage');
  assert.ok(!serialized.includes('"amount":0'), 'no fabricated free cost');
});

test('username round plans real rule-backed probes but never routes legacy default fetch or provider research as safe handlers', () => {
  const snapshot = loadPlatformCatalog(sourceDataDir);
  const plan = planOf(snapshot, usernameInput({ authorization: 'self' }), {
    grants: { x: { credentials: true, authorization: true } }
  });

  // The default inventory is ONLY the GET-91 standalone rule executor.
  assert.equal(DEFAULT_DISCOVERY_OPERATION_INVENTORY.handlers.length, 1);
  const handler = DEFAULT_DISCOVERY_OPERATION_INVENTORY.handlers[0];
  assert.ok(handler);
  assert.equal(handler.handlerId, 'get91-rule-executor');
  assert.equal(handler.callable, true);
  assert.equal(handler.productionWired, false, 'the safe port exists but is explicitly not production wired');
  assert.equal(handler.ruleBacked, true);

  // Real public-rule username probes are planned as data.
  assert.ok(plan.requests.length > 1000, 'the full rule union plans real requests');
  assert.ok(
    (plan.totals.gapCounts.unsupported_route ?? 0) > 2000,
    'rules without bounded positive proof stay explicit unsupported gaps, never candidates'
  );
  for (const record of plan.requests) {
    assert.equal(record.handlerId, 'get91-rule-executor');
    assert.equal(record.productionWired, false);
    assert.equal(record.cost.amount, null);
    assert.ok(record.cost.basis.length > 0);
    assert.equal(record.request.method, 'GET');
  }

  // Legacy probe / TikHub tool / Exa-site routes are explicit gaps, not handlers.
  const byId = new Map(plan.platforms.map((platform) => [platform.platformId, platform]));
  const github = byId.get('github');
  assert.ok(github);
  const probeRoute = github.routes.find((route) => route.routeId === 'github-probe');
  assert.equal(probeRoute?.status, 'blocked');
  assert.equal(probeRoute?.reasonCode, 'no_safe_handler', 'legacy default fetch is not a safe round handler');
  const x = byId.get('x');
  assert.ok(x);
  for (const routeId of ['x-tikhub-handle', 'x-tikhub-search', 'x-site-search']) {
    const route: DiscoveryRoutePlan | undefined = x.routes.find((item) => item.routeId === routeId);
    assert.equal(route?.status, 'blocked', `${routeId} must stay unexecutable`);
    assert.ok(['no_safe_handler', 'no_adapter', 'manual_import_not_planned'].includes(route?.reasonCode ?? ''));
  }

  // Planning never promotes catalog facts.
  for (const entry of snapshot.entries.slice(0, 5)) {
    for (const record of entry.capabilities) {
      assert.notEqual(record.verification, 'live_verified', 'a plan is data, never a live verification receipt');
    }
  }
});

/* ------------------------------------------------------------------ */
/* Synthetic scale and explicit gaps                                   */
/* ------------------------------------------------------------------ */

test('a synthetic large catalog plans every entry with no four-platform cap', () => {
  const entries = Array.from({ length: 300 }, (_unused, index) =>
    entryFixture(`plat-${String(index).padStart(3, '0')}`)
  );
  const plan = planOf(snapshotFixture(entries), usernameInput(), emptyAccess, inventoryFixture([
    handlerFixture({ routeKinds: ['username_probe'], accepts: ['username'] })
  ]));
  assert.equal(plan.platforms.length, 300);
  assert.equal(plan.totals.planned, 300);
  assert.equal(plan.requests.length, 300, 'one planned request per entry');
  for (const platform of plan.platforms) {
    assert.equal(platform.operations.length, 1);
  }
});

test('missing provider key, login and authorization are explicit gaps, never silent skips', () => {
  const entries = [
    entryFixture('need-key', {
      routes: [routeFixture({ routeId: 'need-key-r', requires: ['provider_key'] })]
    }),
    entryFixture('need-login', {
      routes: [routeFixture({ routeId: 'need-login-r', requires: ['login'] })]
    }),
    entryFixture('need-auth', {
      routes: [routeFixture({ routeId: 'need-auth-r', requires: ['authorization'] })]
    })
  ];
  const snapshot = snapshotFixture(entries);
  const strict = planOf(snapshot, usernameInput(), emptyAccess, inventoryFixture([
    handlerFixture({ routeKinds: ['username_probe'], accepts: ['username'] })
  ]));
  const strictById = new Map(strict.platforms.map((platform) => [platform.platformId, platform]));
  assert.equal(strictById.get('need-key')?.routes[0]?.reasonCode, 'credentials_missing');
  assert.equal(strictById.get('need-login')?.routes[0]?.reasonCode, 'login_required');
  assert.equal(strictById.get('need-auth')?.routes[0]?.reasonCode, 'authorization_missing');
  assert.equal(strict.requests.length, 0);

  const granted = planOf(
    snapshot,
    usernameInput(),
    {
      grants: {
        'need-key': { credentials: true, authorization: true },
        'need-login': { credentials: true, authorization: true },
        'need-auth': { credentials: true, authorization: true }
      }
    },
    inventoryFixture([handlerFixture({ routeKinds: ['username_probe'], accepts: ['username'] })])
  );
  const grantedById = new Map(granted.platforms.map((platform) => [platform.platformId, platform]));
  assert.equal(grantedById.get('need-key')?.status, 'planned', 'a held key satisfies provider_key');
  assert.equal(grantedById.get('need-login')?.routes[0]?.reasonCode, 'login_required', 'no login automation exists in this batch');
  assert.equal(grantedById.get('need-auth')?.status, 'planned', 'a held authorization satisfies authorization');
});

test('an authorized email plans zero operations and never leaks address material', () => {
  const snapshot = snapshotFixture([
    entryFixture('alpha'),
    entryFixture('beta', { routes: [routeFixture({ routeId: 'beta-r', requires: ['provider_key'] })] })
  ]);
  // The email variant cannot carry an address: only the authorization basis.
  const input: CatalogDiscoveryInput = {
    inputRevision: 'input-email',
    authorization: 'self',
    instanceHints: {},
    accountKinds: null,
    hints: [],
    classification: 'email'
  };
  const plan = planOf(snapshot, input);
  assert.equal(plan.input.status, 'unsupported');
  assert.equal(plan.input.reasonCode, 'email_input_unsupported_privacy');
  assert.equal(plan.requests.length, 0, 'email dispatch is zero');
  assert.equal(plan.totals.admissibleOperations, 0);
  for (const platform of plan.platforms) {
    assert.equal(platform.status, 'not_applicable');
    assert.equal(platform.reasonCode, 'email_input_unsupported_privacy');
    assert.equal(platform.operations.length, 0);
  }
  const serialized = planJson(plan);
  assert.ok(!serialized.includes('alice'), 'no raw address');
  assert.ok(!serialized.includes('a1b2c3d4'), 'no address hash');
  assert.ok(!serialized.toLowerCase().includes('mailto'), 'no unsafe links');
});

test('name text, numeric native ids and email prefixes never fill username templates', () => {
  const entry = entryFixture('probe-only', {
    routes: [routeFixture({ routeId: 'probe-only-r', endpoint: 'https://site.test/u/{username}' })]
  });
  const snapshot = snapshotFixture([entry]);
  const inventory = inventoryFixture([handlerFixture({ routeKinds: ['username_probe'], accepts: ['username'] })]);

  // A name query is never coerced into a username template.
  const byName = planOf(snapshot, nameQueryInput({ nameQuery: 'Alice Smith' }), emptyAccess, inventory);
  assert.equal(byName.requests.length, 0);
  assert.equal(byName.platforms[0]?.routes[0]?.reasonCode, 'name_query_no_handler');

  // A numeric native id is never a handle.
  const byId = planOf(
    snapshot,
    {
      inputRevision: 'input-native',
      authorization: 'public_professional',
      instanceHints: {},
      accountKinds: null,
      hints: [],
      classification: 'native_id',
      nativeId: '123456789012345678',
      nativeIdIssuer: 'api.probe-only.example',
      platformHint: 'probe-only'
    },
    emptyAccess,
    inventory
  );
  assert.equal(byId.requests.length, 0);
  assert.equal(byId.platforms[0]?.routes[0]?.reasonCode, 'native_id_not_a_handle');
  assert.ok(!planJson(byId).includes('u/123456789012345678'), 'the id never renders into the username template');

  // Native id without an issuer stays unresolved evidence, never guessed.
  const unresolved = planOf(
    snapshot,
    {
      inputRevision: 'input-native-2',
      authorization: 'public_professional',
      instanceHints: {},
      accountKinds: null,
      hints: [],
      classification: 'native_id',
      nativeId: '42',
      nativeIdIssuer: null,
      platformHint: null
    },
    emptyAccess,
    inventory
  );
  assert.equal(unresolved.requests.length, 0);
  assert.equal(unresolved.platforms[0]?.reasonCode, 'native_id_issuer_unresolved');

  // A platform-scoped native id excludes other platforms explicitly.
  assert.equal(byId.platforms.length, 1);
  const scoped = planOf(
    snapshotFixture([entry, entryFixture('other')]),
    {
      inputRevision: 'input-native-3',
      authorization: 'public_professional',
      instanceHints: {},
      accountKinds: null,
      hints: [],
      classification: 'native_id',
      nativeId: '42',
      nativeIdIssuer: 'api.probe-only.example',
      platformHint: 'probe-only'
    },
    emptyAccess,
    inventory
  );
  assert.equal(scoped.platforms[1]?.status, 'not_applicable');
  assert.equal(scoped.platforms[1]?.reasonCode, 'native_id_scope_mismatch');
});

test('unclassified and empty text are explicit invalid input, never an implicit username', () => {
  const snapshot = snapshotFixture([entryFixture('alpha')]);
  assert.throws(
    () =>
      planOf(snapshot, {
        inputRevision: 'input-x',
        authorization: 'public_professional',
        instanceHints: {},
        accountKinds: null,
        hints: [],
        classification: 'unclassified_text',
        invalid: 'unclassified'
      }),
    (error: unknown) => error instanceof DiscoveryPlanInputError && error.reasonCode === 'invalid_input_unclassified'
  );
  assert.throws(
    () => planOf(snapshot, usernameInput({ username: '   ' })),
    (error: unknown) => error instanceof DiscoveryPlanInputError && error.reasonCode === 'invalid_input_empty'
  );
  assert.throws(
    () => planOf(snapshot, nameQueryInput({ nameQuery: '' })),
    (error: unknown) => error instanceof DiscoveryPlanInputError && error.reasonCode === 'invalid_input_empty'
  );
});

/* ------------------------------------------------------------------ */
/* Traceable selflinks: strict template/instance only                   */
/* ------------------------------------------------------------------ */

test('selflinks map only by deterministic template and instance matches, preserving the URL verbatim', () => {
  const entries = [
    entryFixture('alpha', { profileUrlRule: 'https://a.test/{username}' }),
    entryFixture('beta', { profileUrlRule: 'https://b.test/{username}' }),
    entryFixture('slashy', { profileUrlRule: 'https://d.test/u/{username}/' }),
    entryFixture('query', { profileUrlRule: 'https://e.test/user?id={username}' }),
    entryFixture('fedi', {
      profileUrlRule: 'https://{instance}/@{username}',
      instance: 'required'
    })
  ];
  const snapshot = snapshotFixture(entries);
  const hints: DiscoveryInputHint[] = [
    { hintId: 'h-1', kind: 'selflink', url: 'https://a.test/SomeUser#bio', origin: 'public-page:1' },
    { hintId: 'h-2', kind: 'selflink', url: 'https://b.test/SomeUser', origin: 'public-page:2' },
    { hintId: 'h-3', kind: 'selflink', url: 'https://d.test/u/x', origin: 'public-page:3' },
    { hintId: 'h-4', kind: 'selflink', url: 'https://d.test/u/x/', origin: 'public-page:4' },
    { hintId: 'h-5', kind: 'selflink', url: 'https://e.test/user?id=Bob&x=1', origin: 'public-page:5' },
    { hintId: 'h-6', kind: 'selflink', url: 'https://e.test/user?id=Bob', origin: 'public-page:6' },
    { hintId: 'h-7', kind: 'selflink', url: 'https://fedi.test/@alice', origin: 'public-page:7' },
    { hintId: 'h-8', kind: 'selflink', url: 'http://a.test/other', origin: 'public-page:8' },
    { hintId: 'h-9', kind: 'selflink', url: 'https://a.test/', origin: 'public-page:9' },
    { hintId: 'h-10', kind: 'selflink', url: 'https://b.test/a/b', origin: 'public-page:10' }
  ];
  const plan = planOf(snapshot, usernameInput({ hints }));
  const byId = new Map(plan.platforms.map((platform) => [platform.platformId, platform]));

  const alpha = byId.get('alpha')?.selflinks ?? [];
  assert.equal(alpha.length, 1, 'h-1 matches alpha only (strict template, no TLD/name matching)');
  assert.equal(alpha[0]?.extractedValue, 'SomeUser', 'case is preserved verbatim');
  assert.equal(alpha[0]?.url, 'https://a.test/SomeUser#bio', 'the identity-bearing fragment stays on the URL');
  assert.equal(alpha[0]?.matchBasis, 'exact_template');

  assert.deepEqual((byId.get('beta')?.selflinks ?? []).map((item) => item.hintId), ['h-2'], 'h-2 lands on beta, not alpha');
  assert.deepEqual((byId.get('slashy')?.selflinks ?? []).map((item) => item.hintId), ['h-4'], 'trailing slash is identity');
  assert.deepEqual((byId.get('query')?.selflinks ?? []).map((item) => item.hintId), ['h-6'], 'extra query values never match');

  // Instance-pinned template needs its instance hint; without it nothing maps.
  assert.deepEqual(byId.get('fedi')?.selflinks ?? [], []);
  const fediPlan = planOf(
    snapshot,
    usernameInput({ instanceHints: { fedi: 'fedi.test' }, hints })
  );
  const fediLinks: MatchedSelflink[] = fediPlan.platforms.find((platform) => platform.platformId === 'fedi')?.selflinks ?? [];
  assert.equal(fediLinks.length, 1);
  assert.equal(fediLinks[0]?.hintId, 'h-7');
  assert.equal(fediLinks[0]?.matchBasis, 'instance_pinned_template');
  assert.equal(fediLinks[0]?.matchedTemplate, 'https://fedi.test/@{username}');
  assert.equal(fediLinks[0]?.extractedValue, 'alice');

  // Unmatched and unsafe hints keep explicit reasons.
  const unmatched = new Map(plan.unmatchedHints.map((hint) => [hint.hintId, hint.reasonCode]));
  assert.equal(unmatched.get('h-3'), 'no_template_match', 'missing trailing slash never maps');
  assert.equal(unmatched.get('h-5'), 'no_template_match', 'identity query matching is exact');
  assert.equal(unmatched.get('h-8'), 'unsafe_link', 'plain http links are refused');
  assert.equal(unmatched.get('h-9'), 'no_template_match', 'empty substitution values never map');
  assert.equal(unmatched.get('h-10'), 'no_template_match', 'path segments never split across a template');
});

/* ------------------------------------------------------------------ */
/* Routing order and trusted operation inventory                       */
/* ------------------------------------------------------------------ */

test('routes are ordered selflink → username probe → platform search → official search → site search', () => {
  const entry = entryFixture('ordered', {
    profileUrlRule: 'https://a.test/{username}',
    routes: [
      routeFixture({ routeId: 'r-site', kind: 'site_search', operation: 'search:site', endpoint: null, availability: 'integrated' }),
      routeFixture({ routeId: 'r-platform', kind: 'platform_search', operation: 'search:platform', endpoint: null, availability: 'integrated' }),
      routeFixture({ routeId: 'r-probe', kind: 'username_probe', operation: 'probe:username', availability: 'integrated' }),
      routeFixture({ routeId: 'r-official', kind: 'official_search', operation: 'search:official', endpoint: null, availability: 'integrated' })
    ]
  });
  const inventory = inventoryFixture([
    handlerFixture({ handlerId: 'h-search', routeKinds: ['platform_search', 'official_search', 'site_search'], accepts: ['name_query', 'username'] }),
    handlerFixture({ handlerId: 'h-probe', routeKinds: ['username_probe'], accepts: ['username'] })
  ]);
  const plan = planOf(
    snapshotFixture([entry]),
    usernameInput({
      hints: [{ hintId: 'h-1', kind: 'selflink', url: 'https://a.test/Alice', origin: 'public-page:1' }]
    }),
    emptyAccess,
    inventory
  );
  const platform = plan.platforms[0];
  assert.ok(platform);
  assert.equal(platform.status, 'planned');
  assert.deepEqual(
    platform.routes.map((route) => [route.kind, route.priority, route.status]),
    [
      ['username_probe', 1, 'admissible'],
      ['platform_search', 2, 'admissible'],
      ['official_search', 3, 'admissible'],
      ['site_search', 4, 'admissible']
    ],
    'route plans carry the frozen spec §6 priority bands'
  );
  assert.deepEqual(
    platform.operations.map((operation) => operation.priority),
    [0, 1, 2, 3, 4],
    'selflink clues come first, then the ordered route operations'
  );
  assert.equal(platform.operations[0]?.kind, 'selflink');
  assert.deepEqual(
    platform.operations.slice(1).map((operation) => (operation.kind === 'request' ? operation.routeKind : '')),
    ['username_probe', 'platform_search', 'official_search', 'site_search']
  );
});

test('a trusted injected inventory exercises the request contract without promoting catalog facts', () => {
  const entry = entryFixture('guarded', {
    routes: [routeFixture({ routeId: 'guarded-r', availability: 'not_integrated', reason: '目录保持 not_integrated。' })]
  });
  const snapshot = snapshotFixture([entry]);
  const plan = planOf(snapshot, usernameInput(), emptyAccess, inventoryFixture([
    handlerFixture({ routeKinds: ['username_probe'], accepts: ['username'] })
  ]));
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0]?.productionWired, false);
  assert.equal(plan.requests[0]?.cost.amount, null);
  // Catalog facts are untouched: the descriptor still says not_integrated.
  assert.equal(snapshot.entries[0]?.routes[0]?.availability, 'not_integrated');
  assert.equal(snapshot.entries[0]?.capabilities[0]?.verification, 'documented_only');

  // An entry with NO routes is still an explicit obligation gap.
  const empty = planOf(snapshotFixture([entryFixture('no-routes', { routes: [] })]), usernameInput());
  assert.equal(empty.platforms[0]?.obligation.state, 'applicable', 'adapter absence never removes an obligation');
  assert.equal(empty.platforms[0]?.status, 'no_executable_route');
  assert.equal(empty.platforms[0]?.reasonCode, 'no_route_registered');
});

/* ------------------------------------------------------------------ */
/* Shared responses with independent lineage                           */
/* ------------------------------------------------------------------ */

test('different predicates share one exact request while rule/route/source lineage stays independent', () => {
  const r1 = ruleFixture('pr-0000000000000001');
  const r2 = ruleFixture('pr-0000000000000002', {
    sourceRef: { sourceId: 'whatsmyname', rowId: 'row-2', rowSha256: 'b'.repeat(64) },
    detection: { ...r1.detection, presentAny: ['OTHER MARKER'] }
  });
  // Same template but DIFFERENT safe headers → its own exact request.
  const r3 = ruleFixture('pr-0000000000000003', { safeHeaders: { accept: 'application/json' } });
  const entry = entryFixture('shared', {
    routes: [
      routeFixture({
        routeId: 'shared-r',
        kind: 'username_probe',
        operation: 'public-rule:route-shared',
        endpoint: 'https://site.test/u/{username}',
        ruleIds: ['pr-0000000000000001', 'pr-0000000000000002', 'pr-0000000000000003'],
        sourceRefs: ['maigret', 'whatsmyname']
      })
    ]
  });
  const snapshot = snapshotFixture([entry], unionFixture([r1, r2, r3]));
  const plan = planOf(snapshot, usernameInput());
  assert.equal(plan.requests.length, 2, 'exact method+URL+headers+body+page scope grouping only');

  const shared = plan.requests.find((record) => record.ruleIds.length === 2);
  assert.ok(shared);
  assert.deepEqual(shared.ruleIds, ['pr-0000000000000001', 'pr-0000000000000002']);
  assert.equal(shared.request.url, 'https://site.test/u/alice');
  assert.deepEqual(shared.request.headers, { accept: 'text/html' });
  assert.equal(shared.consumers.length, 2);
  const ruleOne = shared.consumers.find((consumer) => consumer.ruleId === 'pr-0000000000000001');
  const ruleTwo = shared.consumers.find((consumer) => consumer.ruleId === 'pr-0000000000000002');
  assert.deepEqual(ruleOne?.sourceRefs, ['maigret']);
  assert.deepEqual(ruleTwo?.sourceRefs, ['whatsmyname'], 'independent source origins survive the shared response');
  assert.equal(ruleOne?.routeId, 'shared-r');
  assert.equal(ruleOne?.platformId, 'shared');

  const solo = plan.requests.find((record) => record.ruleIds.length === 1);
  assert.deepEqual(solo?.ruleIds, ['pr-0000000000000003']);
  assert.deepEqual(solo?.request.headers, { accept: 'application/json' });
});

test('one exact request can serve several platform plans without collapsing their obligations', () => {
  const build = (platformId: string, routeId: string): CatalogEntry =>
    entryFixture(platformId, {
      routes: [
        routeFixture({
          routeId,
          kind: 'username_probe',
          operation: 'probe:shared',
          endpoint: 'https://shared.test/{username}',
          availability: 'integrated'
        })
      ]
    });
  const snapshot = snapshotFixture([build('one', 'one-r'), build('two', 'two-r')]);
  const inventory = inventoryFixture([
    handlerFixture({
      handlerId: 'h-shared',
      routeKinds: ['username_probe'],
      accepts: ['username'],
      buildRequest: (context: DiscoveryRequestBuildContext): PlannedRequestDraft[] => [
        {
          request: {
            adapterId: 'h-shared',
            operation: context.route.operation,
            method: 'GET',
            url: 'https://shared.test/u/alice',
            headers: { accept: 'text/html' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: []
        }
      ]
    })
  ]);
  const plan = planOf(snapshot, usernameInput(), emptyAccess, inventory);
  assert.equal(plan.requests.length, 1, 'identical request identity dedupes');
  const record = plan.requests[0];
  assert.ok(record);
  assert.deepEqual(
    record.consumers.map((consumer) => [consumer.platformId, consumer.routeId]),
    [
      ['one', 'one-r'],
      ['two', 'two-r']
    ],
    'every platform obligation stays an independent consumer'
  );
  assert.equal(plan.platforms.filter((platform) => platform.status === 'planned').length, 2);
});

/* ------------------------------------------------------------------ */
/* Safe requests, exact escaping and credential refusal                */
/* ------------------------------------------------------------------ */

test('planned requests are https-only with exact username escaping and refuse credential material', () => {
  const snapshot = snapshotFixture(
    [entryFixture('escaping', { routes: [routeFixture({ routeId: 'escaping-r', endpoint: 'https://site.test/u/{username}', ruleIds: ['pr-0000000000000001'] })] })],
    unionFixture([ruleFixture('pr-0000000000000001')])
  );
  const plan = planOf(snapshot, usernameInput({ username: 'A b/c+d?e#f' }));
  assert.equal(plan.requests.length, 1);
  assert.equal(
    plan.requests[0]?.request.url,
    'https://site.test/u/A%20b%2Fc%2Bd%3Fe%23f',
    'the explicit username is escaped exactly — literal plus and space never collapse'
  );

  // Unsafe templates and handler requests are refused, never planned.
  const unsafeTemplate = ruleFixture('pr-0000000000000002', {
    requestTemplate: 'https://site.test/u/{username}?api_key=abc'
  });
  const unsafeSnapshot = snapshotFixture(
    [entryFixture('unsafe', { routes: [routeFixture({ routeId: 'unsafe-r', endpoint: 'https://site.test/u/{username}?api_key=abc', ruleIds: ['pr-0000000000000002'] })] })],
    unionFixture([unsafeTemplate])
  );
  const unsafePlan = planOf(unsafeSnapshot, usernameInput());
  assert.equal(unsafePlan.requests.length, 0);
  assert.equal(unsafePlan.platforms[0]?.routes[0]?.reasonCode, 'unsafe_template');

  const badHandler = planOf(snapshotFixture([entryFixture('bad-handler')]), usernameInput(), emptyAccess, inventoryFixture([
    handlerFixture({
      routeKinds: ['username_probe'],
      accepts: ['username'],
      buildRequest: () => [
        {
          request: {
            adapterId: 'bad',
            operation: 'probe:username',
            method: 'GET',
            url: 'https://site.test/u/alice?token=secret',
            headers: { accept: 'text/html' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: []
        }
      ]
    })
  ]));
  assert.equal(badHandler.requests.length, 0);
  assert.equal(badHandler.platforms[0]?.routes[0]?.reasonCode, 'unsafe_template');

  const badHeader = planOf(snapshotFixture([entryFixture('bad-header')]), usernameInput(), emptyAccess, inventoryFixture([
    handlerFixture({
      routeKinds: ['username_probe'],
      accepts: ['username'],
      buildRequest: () => [
        {
          request: {
            adapterId: 'bad',
            operation: 'probe:username',
            method: 'GET',
            url: 'https://site.test/u/alice',
            headers: { cookie: 'session=1' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: []
        }
      ]
    })
  ]));
  assert.equal(badHeader.requests.length, 0);
  assert.equal(badHeader.platforms[0]?.routes[0]?.reasonCode, 'unsafe_template');
});

test('conflicting username hints are explicit gaps and never guessed', () => {
  const entry = entryFixture('hints');
  const snapshot = snapshotFixture([entry]);
  const inventory = inventoryFixture([handlerFixture({ routeKinds: ['username_probe'], accepts: ['username'] })]);
  const conflicting = planOf(
    snapshot,
    usernameInput({
      hints: [
        { hintId: 'h-1', kind: 'username', platformId: 'hints', value: 'alice' },
        { hintId: 'h-2', kind: 'username', platformId: 'hints', value: 'bob' }
      ]
    }),
    emptyAccess,
    inventory
  );
  assert.equal(conflicting.requests.length, 0);
  assert.equal(conflicting.platforms[0]?.routes[0]?.reasonCode, 'conflicting_username_hints');

  const agreeing = planOf(
    snapshot,
    usernameInput({
      hints: [
        { hintId: 'h-1', kind: 'username', platformId: 'hints', value: 'alice' },
        { hintId: 'h-2', kind: 'username', platformId: 'hints', value: 'alice' }
      ]
    }),
    emptyAccess,
    inventory
  );
  assert.equal(agreeing.requests.length, 1, 'identical hints dedupe');
});

test('known-mapped public rules link to their curated platform without losing rule or route origins', () => {
  const snapshot = loadPlatformCatalog(sourceDataDir);
  const plan = planOf(snapshot, usernameInput({ authorization: 'self' }));
  const gitlab = plan.platforms.find((platform) => platform.platformId === 'gitlab');
  assert.ok(gitlab);
  const derived = gitlab.routes.filter((route) => route.routeId.startsWith('prr-'));
  assert.equal(derived.length, 1, 'exact-template-mapped rules attach as derived rule routes');
  assert.equal(derived[0]?.status, 'admissible');
  assert.ok((derived[0]?.ruleIds.length ?? 0) > 0);
  // The curated legacy probe keeps its own explicit gap: the plan never
  // promotes it and never reroutes it through the legacy default fetch.
  const legacy = gitlab.routes.find((route) => route.routeId === 'gitlab-probe');
  assert.equal(legacy?.status, 'blocked');
  assert.equal(legacy?.reasonCode, 'no_safe_handler');
  // Every rule behind the derived route keeps its own lineage in a request.
  const covered = new Set(plan.requests.flatMap((record) => record.ruleIds));
  for (const ruleId of derived[0]?.ruleIds ?? []) {
    assert.ok(covered.has(ruleId), `rule ${ruleId} keeps its request lineage`);
  }
});

/* ------------------------------------------------------------------ */
/* Opaque request keys                                                 */
/* ------------------------------------------------------------------ */

function bindingFixture(over: Partial<DiscoveryBinding> = {}): DiscoveryBinding {
  return {
    owner: 'owner-1',
    caseId: 'case-1',
    inputRevision: 'input-1',
    registryHash: 'sha256:registry',
    ruleHash: 'sha256:rules',
    policyHash: 'sha256:policy',
    authorityVersion: 'scope-1',
    accessIdentity: 'grant-1',
    ...over
  };
}

function requestFixture(over: Partial<PlannedDiscoveryRequest> = {}): PlannedDiscoveryRequest {
  return {
    adapterId: 'get91-rule-executor',
    operation: 'public-rule:route-1',
    method: 'GET',
    url: 'https://site.test/u?u=alice&u=alicia',
    headers: { accept: 'text/html' },
    body: null,
    pageScope: { page: 1, pageSize: null },
    ...over
  };
}

test('request keys are stable hashes binding owner/case/input/registry/rule/policy/authority/access/page/method/body', () => {
  const base = discoveryRequestKey(requestFixture(), bindingFixture());
  assert.ok(base.startsWith('sdrk/1:'), 'opaque versioned key');
  assert.equal(discoveryRequestKey(requestFixture(), bindingFixture()), base, 'deterministic');

  const differences: Array<[string, DiscoveryBinding, PlannedDiscoveryRequest]> = [
    ['owner', bindingFixture({ owner: 'owner-2' }), requestFixture()],
    ['case', bindingFixture({ caseId: 'case-2' }), requestFixture()],
    ['input', bindingFixture({ inputRevision: 'input-2' }), requestFixture()],
    ['registry', bindingFixture({ registryHash: 'sha256:other' }), requestFixture()],
    ['rule', bindingFixture({ ruleHash: 'sha256:other' }), requestFixture()],
    ['policy', bindingFixture({ policyHash: 'sha256:other' }), requestFixture()],
    ['authority', bindingFixture({ authorityVersion: 'scope-2' }), requestFixture()],
    ['access', bindingFixture({ accessIdentity: 'grant-2' }), requestFixture()],
    ['page', bindingFixture(), requestFixture({ pageScope: { page: 2, pageSize: null } })],
    ['pageSize', bindingFixture(), requestFixture({ pageScope: { page: 1, pageSize: 50 } })],
    ['method', bindingFixture(), requestFixture({ method: 'POST' })],
    ['body', bindingFixture(), requestFixture({ method: 'POST', body: 'a=1' })],
    ['operation', bindingFixture(), requestFixture({ operation: 'public-rule:route-2' })],
    ['adapter', bindingFixture(), requestFixture({ adapterId: 'other' })]
  ];
  for (const [label, binding, request] of differences) {
    assert.notEqual(discoveryRequestKey(request, binding), base, `${label} must change the key`);
  }

  // Body semantics: null vs empty vs literal are distinct, bodies stay opaque.
  assert.notEqual(
    discoveryRequestKey(requestFixture({ method: 'POST', body: null }), bindingFixture()),
    discoveryRequestKey(requestFixture({ method: 'POST', body: '' }), bindingFixture())
  );
  assert.notEqual(
    discoveryRequestKey(requestFixture({ method: 'POST', body: '{"a":1,"b":2}' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ method: 'POST', body: '{"b":2,"a":1}' }), bindingFixture()),
    'request bodies are literal bytes — never re-canonicalized'
  );
});

test('request keys canonicalize object key order only and preserve query/URL semantics', () => {
  const base = discoveryRequestKey(requestFixture(), bindingFixture());
  // Object key order is the ONLY thing canonicalized.
  assert.equal(
    discoveryRequestKey(
      requestFixture({ headers: { 'accept-language': 'en', accept: 'text/html' }, pageScope: { pageSize: null, page: 1 } }),
      bindingFixture({ accessIdentity: 'grant-1', owner: 'owner-1', caseId: 'case-1', inputRevision: 'input-1', registryHash: 'sha256:registry', ruleHash: 'sha256:rules', policyHash: 'sha256:policy', authorityVersion: 'scope-1' })
    ),
    discoveryRequestKey(
      requestFixture({ headers: { accept: 'text/html', 'accept-language': 'en' }, pageScope: { page: 1, pageSize: null } }),
      bindingFixture()
    ),
    'plain object key order never changes identity'
  );

  // Duplicate query keys and their ORDER are preserved.
  assert.notEqual(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u?u=alice&u=alicia' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u?u=alicia&u=alice' }), bindingFixture())
  );
  assert.notEqual(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u?u=alice&u=alicia' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u?u=alice' }), bindingFixture())
  );
  // Encoded slash, path case, trailing slash and literal plus stay verbatim.
  assert.notEqual(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/a%2Fb' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/a/b' }), bindingFixture())
  );
  assert.notEqual(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/Path' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/path' }), bindingFixture())
  );
  assert.notEqual(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u/' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u' }), bindingFixture())
  );
  assert.notEqual(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u?q=a+b' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u?q=a%20b' }), bindingFixture()),
    'literal plus and percent-space are different requests'
  );
  // Only the HTTP fragment is excluded from the actual request identity.
  assert.equal(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u#one' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u#two' }), bindingFixture())
  );
  assert.equal(
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u#one' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ url: 'https://site.test/u' }), bindingFixture())
  );
});

test('request keys refuse credential and secret material instead of serializing it', () => {
  assert.throws(
    () => discoveryRequestKey(requestFixture({ url: 'https://site.test/u?api_key=abc' }), bindingFixture()),
    (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError'
  );
  assert.throws(
    () => discoveryRequestKey(requestFixture({ url: 'https://user:pass@site.test/u' }), bindingFixture()),
    (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError'
  );
  assert.throws(
    () => discoveryRequestKey(requestFixture({ headers: { authorization: 'Bearer x' } }), bindingFixture()),
    (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError'
  );
  assert.throws(
    () => discoveryRequestKey(requestFixture({ headers: { cookie: 'session=1' } }), bindingFixture()),
    (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError'
  );
  assert.throws(
    () => discoveryRequestKey(requestFixture({ headers: { 'x-api-key': 'x' } }), bindingFixture()),
    (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError'
  );
  // Binding access identity is opaque: the raw credential never enters the key.
  const key = discoveryRequestKey(requestFixture(), bindingFixture({ accessIdentity: 'grant-1' }));
  assert.ok(!key.includes('grant-1'), 'keys stay opaque hashes');
});

test('canonical JSON preserves arrays, types and null while sorting object keys', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }), 'object key order only');
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }), 'value types are preserved');
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}), 'explicit null ≠ absent');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'array order is preserved');
  assert.notEqual(canonicalJson(['1', '2']), canonicalJson([1, 2]), 'array types are preserved');
  assert.equal(canonicalJson({ a: [1, null, 'x'] }), '{"a":[1,null,"x"]}');
  assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError);
});

/* ------------------------------------------------------------------ */
/* Independent review regressions (GET-92 repair 1)                    */
/* ------------------------------------------------------------------ */

function alteredHttpUrl(url: string): boolean {
  let href = '';
  try {
    href = new URL(url).href;
  } catch {
    return true;
  }
  return href.split('#')[0] !== url.split('#')[0];
}

function bodyPlan(body: string): DiscoveryRoundPlan {
  return planOf(
    snapshotFixture([entryFixture('bad-body')]),
    usernameInput(),
    emptyAccess,
    inventoryFixture([
      handlerFixture({
        routeKinds: ['username_probe'],
        accepts: ['username'],
        buildRequest: () => [
          {
            request: {
              adapterId: 'bad',
              operation: 'probe:username',
              method: 'POST',
              url: 'https://site.test/u/alice',
              headers: { accept: 'text/html' },
              body,
              pageScope: { page: 1, pageSize: null }
            },
            ruleIds: []
          }
        ]
      })
    ])
  );
}

test('credential material in request bodies never enters public plans or request keys', () => {
  const credentialBodies = [
    'api_key=synthetic-not-a-secret',
    'API_KEY=synthetic-not-a-secret',
    'api%5Fkey=synthetic-not-a-secret',
    'api_key[0]=synthetic-not-a-secret',
    'credentials[api_key]=synthetic-not-a-secret',
    'payload%5BAPI%5FKEY%5D=synthetic-not-a-secret',
    'payload[auth][refresh_token]=synthetic-not-a-secret',
    JSON.stringify({ api_key: 'synthetic-not-a-secret' }),
    JSON.stringify({ API_KEY: 'synthetic-not-a-secret' }),
    JSON.stringify({ nested: { access_token: 'synthetic-not-a-secret' } }),
    JSON.stringify([{ session: 'synthetic-not-a-secret' }]),
    JSON.stringify({ deep: [{ cookie: 'synthetic-not-a-secret' }] })
  ];
  for (const body of credentialBodies) {
    assert.throws(
      () => discoveryRequestKey(requestFixture({ method: 'POST', body }), bindingFixture()),
      (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError',
      `request key must refuse: ${body}`
    );
    const plan = bodyPlan(body);
    assert.equal(plan.requests.length, 0, `plan must refuse: ${body}`);
    assert.equal(plan.platforms[0]?.routes[0]?.reasonCode, 'unsafe_template');
    assert.ok(!planJson(plan).includes('synthetic-not-a-secret'), 'no synthetic credential value is materialized');
  }

  // Ordinary text mentioning token and safe literal bodies stay valid and
  // byte exact — the validator never reorders or strips and relabels.
  for (const body of ['please read about token economics', 'q=reset my token', '{"summary":"api key rotation"}', 'a=1', 'payload[page_token]=opaque-cursor', 'q=credentials[api_key] docs', '{"query":"payload[api_key]"}']) {
    assert.ok(discoveryRequestKey(requestFixture({ method: 'POST', body }), bindingFixture()), body);
    assert.equal(bodyPlan(body).requests.length, 1, body);
  }
  assert.notEqual(
    discoveryRequestKey(requestFixture({ method: 'POST', body: '{"a":1,"b":2}' }), bindingFixture()),
    discoveryRequestKey(requestFixture({ method: 'POST', body: '{"b":2,"a":1}' }), bindingFixture()),
    'JSON string bodies stay literal bytes'
  );
});

test('dot usernames never change the actual HTTP request location', () => {
  const snapshot = loadPlatformCatalog(sourceDataDir);
  for (const username of ['.', '..']) {
    const plan = planOf(snapshot, usernameInput({ username, authorization: 'self' }));
    const altered = plan.requests.filter((record) => alteredHttpUrl(record.request.url));
    assert.equal(altered.length, 0, `username ${username}: planned URLs must survive HTTP parsing unchanged`);
    assert.ok(
      (plan.totals.gapCounts.input_location_not_preserved ?? 0) > 0,
      `username ${username}: non-preserving templates keep an explicit gap`
    );
    for (const platform of plan.platforms) {
      for (const route of platform.routes) {
        if (route.status === 'admissible') assert.ok(route.reasonCode === 'planned');
      }
    }
  }

  // Ordinary dotted names and query usernames stay valid.
  const dotted = planOf(snapshot, usernameInput({ username: 'a.b', authorization: 'self' }));
  assert.ok(dotted.requests.length > 1000, 'ordinary dotted names still plan');
  assert.equal(dotted.requests.filter((record) => alteredHttpUrl(record.request.url)).length, 0);

  const queryRule = ruleFixture('pr-0000000000000001', {
    requestTemplate: 'https://site.test/user?id={username}',
    canonicalProfileTemplate: 'https://site.test/user?id={username}'
  });
  const queryEntry = entryFixture('query-user', {
    routes: [routeFixture({ routeId: 'query-user-r', endpoint: 'https://site.test/user?id={username}', ruleIds: ['pr-0000000000000001'] })]
  });
  const queryPlan = planOf(snapshotFixture([queryEntry], unionFixture([queryRule])), usernameInput({ username: '.' }));
  assert.equal(queryPlan.requests.length, 1, 'query-context usernames accept dots');
  assert.equal(queryPlan.requests[0]?.request.url, 'https://site.test/user?id=.');
  const dottedEntry = entryFixture('dotted-user', {
    routes: [routeFixture({ routeId: 'dotted-user-r', endpoint: 'https://site.test/u/{username}', ruleIds: ['pr-0000000000000001'] })]
  });
  const dottedPlan = planOf(
    snapshotFixture([dottedEntry], unionFixture([ruleFixture('pr-0000000000000001', { requestTemplate: 'https://site.test/u/{username}' })])),
    usernameInput({ username: 'a.b' })
  );
  assert.equal(dottedPlan.requests.length, 1, 'ordinary dotted path names are preserved');
  assert.equal(dottedPlan.requests[0]?.request.url, 'https://site.test/u/a.b');

  // Full real catalogue invariant: a normal username keeps its location.
  const normal = planOf(snapshot, usernameInput({ username: 'alice', authorization: 'self' }));
  assert.ok(normal.requests.length > 1500);
  assert.equal(normal.requests.filter((record) => alteredHttpUrl(record.request.url)).length, 0);
  for (const record of normal.requests.slice(0, 50)) {
    assert.ok(record.request.url.includes('alice'), record.request.url);
  }
});

test('fragment variants share one request while every consumer and clue fragment is preserved', () => {
  const r1 = ruleFixture('pr-0000000000000001', {
    sourceRef: { sourceId: 'maigret', rowId: 'row-1', rowSha256: 'a'.repeat(64) }
  });
  const r2 = ruleFixture('pr-0000000000000002', {
    sourceRef: { sourceId: 'whatsmyname', rowId: 'row-2', rowSha256: 'b'.repeat(64) }
  });
  const entry = entryFixture('fragments', {
    profileUrlRule: 'https://site.test/u/{username}',
    routes: [
      routeFixture({
        routeId: 'fragments-r',
        kind: 'username_probe',
        operation: 'probe:fragments',
        endpoint: 'https://site.test/u/{username}#x',
        availability: 'integrated',
        ruleIds: ['pr-0000000000000001', 'pr-0000000000000002']
      })
    ]
  });
  const snapshot = snapshotFixture([entry], unionFixture([r1, r2]));
  const inventory = inventoryFixture([
    handlerFixture({
      handlerId: 'fragment-handler',
      routeKinds: ['username_probe'],
      accepts: ['username'],
      buildRequest: () => [
        {
          request: {
            adapterId: 'fragment-handler',
            operation: 'probe:fragments',
            method: 'GET',
            url: 'https://site.test/u/alice#first',
            headers: { accept: 'text/html' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: ['pr-0000000000000001']
        },
        {
          request: {
            adapterId: 'fragment-handler',
            operation: 'probe:fragments',
            method: 'GET',
            url: 'https://site.test/u/alice#second',
            headers: { accept: 'text/html' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: ['pr-0000000000000002']
        }
      ]
    })
  ]);
  const plan = planOf(snapshot, usernameInput(), emptyAccess, inventory);
  assert.equal(plan.requests.length, 1, 'the HTTP fragment is not sent: one shared request');
  const record = plan.requests[0];
  assert.ok(record);
  assert.deepEqual(record.ruleIds, ['pr-0000000000000001', 'pr-0000000000000002'], 'all rule predicates keep lineage');
  assert.equal(record.consumers.length, 2);
  assert.deepEqual(record.consumers.map((consumer) => consumer.sourceRefs), [['maigret'], ['whatsmyname']]);
  assert.deepEqual(
    record.urlVariants,
    ['https://site.test/u/alice#first', 'https://site.test/u/alice#second'],
    'original identity-bearing URL fragments are preserved'
  );
  // The opaque key uses the same fragment-excluded HTTP material.
  assert.equal(
    discoveryRequestKey(record.request, bindingFixture()),
    discoveryRequestKey(
      requestFixture({ adapterId: 'fragment-handler', operation: 'probe:fragments', url: 'https://site.test/u/alice' }),
      bindingFixture()
    )
  );
  // Selflink clue fragments are identity and stay untouched.
  const cluePlan = planOf(
    snapshotFixture([entryFixture('clue', { profileUrlRule: 'https://site.test/u/{username}' })]),
    usernameInput({ hints: [{ hintId: 'h-frag', kind: 'selflink', url: 'https://site.test/u/alice#bio', origin: 'public-page:1' }] })
  );
  assert.equal(cluePlan.platforms[0]?.selflinks[0]?.url, 'https://site.test/u/alice#bio');

  // Distinct query order still never merges.
  const ordered = inventoryFixture([
    handlerFixture({
      handlerId: 'ordered-handler',
      routeKinds: ['username_probe'],
      accepts: ['username'],
      buildRequest: () => [
        {
          request: {
            adapterId: 'ordered-handler',
            operation: 'probe:fragments',
            method: 'GET',
            url: 'https://site.test/u?x=1&x=2',
            headers: { accept: 'text/html' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: []
        },
        {
          request: {
            adapterId: 'ordered-handler',
            operation: 'probe:fragments',
            method: 'GET',
            url: 'https://site.test/u?x=2&x=1',
            headers: { accept: 'text/html' },
            body: null,
            pageScope: { page: 1, pageSize: null }
          },
          ruleIds: []
        }
      ]
    })
  ]);
  const orderedPlan = planOf(snapshotFixture([entryFixture('ordered-query')]), usernameInput(), emptyAccess, ordered);
  assert.equal(orderedPlan.requests.length, 2, 'query duplicate order is identity');
});

test('the shared static URL preflight refuses localhost, loopback, invalid and control URLs at every entry', () => {
  const unsafeUrls = [
    'https://localhost/u/alice',
    'https://sub.localhost/u/alice',
    'https://127.0.0.1/u/alice',
    'https://10.0.0.1/u/alice',
    'https://[::1]/u/alice',
    'https://bad host/u/alice',
    'https://site.test/u/\nalice',
    'https://site.test/u/alice#access_token=synthetic-not-a-secret',
    'https://site.test/u/alice#?access_token=synthetic-not-a-secret',
    'https://site.test/u/alice#/callback?api_key=synthetic-not-a-secret',
    'https://site.test/u/alice#/callback?payload[api_key]=synthetic-not-a-secret',
    'https://site.test/u/..'
  ];
  for (const url of unsafeUrls) {
    assert.throws(
      () => discoveryRequestKey(requestFixture({ url }), bindingFixture()),
      (error: unknown) => error instanceof Error && error.name === 'DiscoveryRequestKeyError',
      url
    );
    const plan = planOf(
      snapshotFixture([entryFixture('unsafe-target')]),
      usernameInput(),
      emptyAccess,
      inventoryFixture([
        handlerFixture({
          routeKinds: ['username_probe'],
          accepts: ['username'],
          buildRequest: () => [
            {
              request: {
                adapterId: 'unsafe',
                operation: 'probe:username',
                method: 'GET',
                url,
                headers: { accept: 'text/html' },
                body: null,
                pageScope: { page: 1, pageSize: null }
              },
              ruleIds: []
            }
          ]
        })
      ])
    );
    assert.equal(plan.requests.length, 0, url);
    assert.equal(plan.platforms[0]?.routes[0]?.reasonCode, 'unsafe_template', url);
    const selflinked = planOf(
      snapshotFixture([entryFixture('selflink-target', { profileUrlRule: 'https://site.test/u/{username}' })]),
      usernameInput({ hints: [{ hintId: 'h-bad', kind: 'selflink', url, origin: 'public-page:1' }] })
    );
    assert.equal(selflinked.unmatchedHints.find((hint) => hint.hintId === 'h-bad')?.reasonCode, 'unsafe_link', url);
  }

  // Valid public raw bytes are preserved exactly at the key layer.
  for (const url of [
    'https://site.test/u/a%2Fb',
    'https://site.test/u?x=a+b',
    'https://site.test/u?x=a%20b',
    'https://site.test:8443/u/a',
    'https://site.test/u/a.b',
    'https://site.test/u/Alice#bio',
    'https://site.test/u/'
  ]) {
    assert.ok(discoveryRequestKey(requestFixture({ url }), bindingFixture()), url);
  }
});

test('email privacy refusal happens before any hint is adopted', () => {
  const hints: DiscoveryInputHint[] = [
    { hintId: 'h-selflink', kind: 'selflink', url: 'https://a.test/SomeUser', origin: 'public-page:1' },
    { hintId: 'h-username', kind: 'username', platformId: null, value: 'SomeUser' },
    { hintId: 'h-instance', kind: 'instance', platformId: 'alpha', instance: 'a.test' }
  ];
  const emailInput = (extra: Record<string, unknown> = {}): CatalogDiscoveryInput =>
    baseInput({ classification: 'email', hints, ...extra }) as unknown as CatalogDiscoveryInput;

  const synthetic = planOf(
    snapshotFixture([entryFixture('alpha', { profileUrlRule: 'https://a.test/{username}' })]),
    emailInput()
  );
  assert.equal(synthetic.requests.length, 0);
  assert.equal(synthetic.totals.admissibleOperations, 0);
  assert.equal(synthetic.platforms[0]?.selflinks.length, 0, 'selflink hints are never adopted');
  assert.equal(synthetic.unmatchedHints.length, 0, 'no hint material leaks into the public plan');
  assert.ok(!planJson(synthetic).includes('SomeUser'));

  // Full real catalogue with combined hints: directory rows retained, all
  // operations/selflinks/requests empty.
  const real = planOf(loadPlatformCatalog(sourceDataDir), emailInput());
  assert.equal(real.platforms.length, 4421);
  assert.equal(real.requests.length, 0);
  assert.equal(real.totals.admissibleOperations, 0);
  for (const platform of real.platforms) {
    assert.equal(platform.selflinks.length, 0);
    assert.equal(platform.operations.length, 0);
    assert.equal(platform.reasonCode, 'email_input_unsupported_privacy');
  }
  assert.equal(real.unmatchedHints.length, 0);
  assert.ok(!planJson(real).includes('SomeUser'));
});

// Independent replay on the frozen original helper fails the two refusal cases.
test('canonicalJson refuses Date instead of silently treating it as an empty object', () => {
  assert.throws(() => canonicalJson(new Date('2020-01-01T00:00:00Z')), TypeError);
});
test('canonicalJson refuses Map, Set and class instances, including nested values', () => {
  class EmptyValue {}
  for (const value of [new Map(), new Set(), new EmptyValue(), { nested: new Map() }, [new Date('2020-01-01T00:00:00Z')]]) {
    assert.throws(() => canonicalJson(value), TypeError);
  }
});
test('canonicalJson accepts plain and null-prototype JSON objects with key-order normalization', () => {
  const value = Object.assign(Object.create(null), { b: [null, 'x', 1], a: true });
  assert.equal(canonicalJson(value), canonicalJson({ a: true, b: [null, 'x', 1] }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({}));
});


test('safe fragment navigation and parameter values remain byte exact', () => {
  for (const url of [
    'https://site.test/u/alice#/bio?tab=posts',
    'https://site.test/u/alice#?tab=profile',
    'https://site.test/u/alice#q=why?api_key=value'
  ]) {
    assert.ok(discoveryRequestKey(requestFixture({ url }), bindingFixture()));
  }
});
