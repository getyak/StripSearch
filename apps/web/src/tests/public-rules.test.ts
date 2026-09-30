/**
 * GET-91 Task 2 contract tests: offline compilation of pinned public rule
 * datasets (Maigret / WhatsMyName shapes) into normalized public discovery
 * rules, exclusion receipts and the catalog union.
 *
 * Everything here is offline and synthetic: no upstream bytes are fetched and
 * no site is ever requested. The full pinned-bytes audit lives in
 * `public-rules-source-audit.test.ts` and runs against maintainer-cached
 * source bytes via an explicit local path.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  PublicDetection,
  PublicDiscoveryRule,
  PublicRuleExclusion,
  PublicRuleImport,
  PublicRuleSourceInput,
  PublicRuleUnion
} from '../shared/public-discovery-rules.js';
import {
  PUBLIC_RULES_SCHEMA_VERSION,
  canonicalPublicTemplate
} from '../shared/public-discovery-rules.js';
import {
  compilePublicRules,
  mergePublicRules,
  publicRuleCatalogEntries,
  publicRuleUnionGroups
} from '../server/platforms/public-rules.js';
import type { PlatformCatalogSnapshot } from '../shared/platform-catalog.js';
import { catalogSnapshotFromJson, catalogContentHash, catalogSummary } from '../server/platforms/catalog.js';

const MIT_LICENSE = 'MIT License\n\nCopyright (c) 2020-2026 Soxoj\n\nPermission is hereby granted...\n';
const CC_LICENSE =
  'Copyright (C) 2015-2026 Micah Hoffman\n\nThis work is licensed under the Creative Commons Attribution-ShareAlike\n4.0 International License. To view a copy of this license, visit\nhttp://creativecommons.org/licenses/by-sa/4.0/\n';

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Synthetic pinned inputs (original fixtures, shaped like upstream)    */
/* ------------------------------------------------------------------ */

function maigretBytes(): Buffer {
  const data = {
    engines: {
      TestEngine: {
        name: 'TestEngine',
        site: {
          checkType: 'status_code',
          url: '{urlMain}/u/{username}'
        }
      },
      MarkerEngine: {
        name: 'MarkerEngine',
        presenseStrs: ['engine-login-wall-marker'],
        site: {
          checkType: 'message',
          url: '{urlMain}/members/?username={username}'
        }
      }
    },
    tags: ['test'],
    sites: {
      Alpha: {
        url: 'https://alpha.example.test/{username}',
        urlMain: 'https://alpha.example.test',
        checkType: 'message',
        presenseStrs: ['profile-of-user'],
        absenceStrs: ['no-such-user-here'],
        usernameClaimed: 'CLAIMED-RAW-USERNAME',
        usernameUnclaimed: 'UNCLAIMED-RAW-USERNAME',
        tags: ['social']
      },
      Beta: {
        engine: 'TestEngine',
        urlMain: 'https://beta.example.test',
        usernameClaimed: 'RAW-BETA',
        usernameUnclaimed: 'RAW-BETA-NO'
      },
      Gamma: {
        url: 'https://gamma.example.test/{username}',
        urlMain: 'https://gamma.example.test',
        checkType: 'message',
        presenseStrs: ['x'],
        disabled: true
      },
      Delta: {
        url: 'https://delta.example.test/{username}',
        urlMain: 'https://delta.example.test',
        checkType: 'message',
        regexCheck: '^\\d+$',
        presenseStrs: ['y']
      },
      Epsilon: {
        url: 'https://epsilon.example.test/{username}',
        urlMain: 'https://epsilon.example.test',
        checkType: 'status_code',
        requestMethod: 'POST',
        requestPayload: 'q={username}'
      },
      Zeta: {
        url: 'https://zeta.example.test/{username}',
        urlMain: 'https://zeta.example.test',
        checkType: 'status_code',
        headers: { authorization: 'Bearer SECRET-TOKEN-VALUE', cookie: 'session=SECRET-COOKIE-VALUE' }
      },
      Eta: {
        url: 'http://eta.example.test/{username}',
        urlMain: 'http://eta.example.test',
        checkType: 'status_code'
      },
      Theta: {
        url: 'https://theta.example.test/find?q={{"author":"{username}"}',
        urlMain: 'https://theta.example.test',
        checkType: 'message',
        presenseStrs: ['z']
      },
      Iota: {
        url: 'https://iota.example.test/{username}',
        urlMain: 'https://iota.example.test',
        checkType: 'status_code',
        type: 'steam_id'
      },
      Kappa: {
        url: 'https://kappa.example.test/{username}',
        urlMain: 'https://kappa.example.test',
        checkType: 'message'
      },
      Lambda: {
        url: 'https://lambda.example.test/{username}',
        urlMain: 'https://lambda.example.test',
        checkType: 'status_code',
        protocol: 'tor'
      },
      Mu: {
        engine: 'MarkerEngine',
        urlMain: 'https://mu.example.test',
        presenseStrs: ['site-marker-wins']
      },
      Nu: {
        url: 'https://nu.example.test/{username}',
        urlMain: 'https://nu.example.test',
        checkType: 'message',
        presenseStrs: ['nu-present'],
        absenceStrs: ['nu-absent']
      },
      GitHub: {
        url: 'https://git-hub.example.test/{username}',
        urlMain: 'https://git-hub.example.test',
        checkType: 'message',
        presenseStrs: ['fake-github-present']
      },
      RealGithub: {
        url: 'https://github.com/{username}',
        urlMain: 'https://github.com',
        checkType: 'message',
        presenseStrs: ['gh-present'],
        absenceStrs: ['gh-absent']
      },
      SafeHeaders: {
        url: 'https://safe.example.test/{username}',
        urlMain: 'https://safe.example.test',
        checkType: 'message',
        presenseStrs: ['safe-present'],
        headers: { accept: 'text/html', 'accept-language': 'en' }
      },
      LongMarker: {
        url: 'https://long.example.test/{username}',
        urlMain: 'https://long.example.test',
        checkType: 'message',
        presenseStrs: ['m'.repeat(2000)]
      },
      Probe: {
        url: 'https://probe.example.test/{username}',
        urlMain: 'https://probe.example.test',
        urlProbe: 'https://probe.example.test/api/user/{username}',
        checkType: 'message',
        presenseStrs: ['probe-present'],
        absenceStrs: ['probe-absent']
      }
    }
  };
  return Buffer.from(JSON.stringify(data), 'utf8');
}

function wmnBytes(): Buffer {
  const data = {
    license: ['Copyright (C) 2015-2026 Micah Hoffman', 'CC BY-SA 4.0'],
    authors: ['synthetic'],
    categories: ['social'],
    sites: [
      {
        name: 'Alpha',
        uri_check: 'https://alpha.example.test/{account}',
        e_code: 200,
        e_string: 'wmn-present',
        m_code: 404,
        m_string: 'wmn-absent',
        known: ['RAW-WMN-USERNAME-EXAMPLE'],
        cat: 'social'
      },
      {
        name: 'Nu',
        uri_check: 'https://nu.example.test/{account}',
        e_code: 200,
        e_string: 'wmn-nu-present',
        m_code: 404,
        m_string: 'wmn-nu-absent',
        known: []
      },
      {
        name: 'GitHub',
        uri_check: 'https://github.example.test/{account}',
        e_code: 200,
        e_string: 'wmn-gh-present',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'PostBody',
        uri_check: 'https://postbody.example.test/graphql',
        post_body: '{"query":"{account}"}',
        headers: { 'Content-Type': 'application/json' },
        e_code: 200,
        e_string: 'x',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'NoPlaceholder',
        uri_check: 'https://noplace.example.test/static',
        e_code: 200,
        e_string: 'x',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'HostOverride',
        uri_check: 'https://hostover.example.test/{account}',
        headers: { Host: 'spoof.example.test', Cookie: 'session=SECRET-WMN-COOKIE' },
        e_code: 200,
        e_string: 'x',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'SafeHeaders',
        uri_check: 'https://safe.example.test/{account}',
        uri_pretty: 'https://safe.example.test/u/{account}',
        headers: { Accept: 'text/html' },
        e_code: 200,
        e_string: 'wmn-safe-present',
        m_code: 404,
        m_string: 'wmn-safe-absent'
      },
      {
        name: 'StatusOnly',
        uri_check: 'https://statusonly.example.test/{account}',
        e_code: 200,
        e_string: '',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'StripChars',
        uri_check: 'https://strip.example.test/{account}',
        strip_bad_char: '.',
        e_code: 200,
        e_string: 'x',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'HttpOnly',
        uri_check: 'http://httponly.example.test/{account}',
        e_code: 200,
        e_string: 'x',
        m_code: 404,
        m_string: ''
      }
    ]
  };
  return Buffer.from(JSON.stringify(data), 'utf8');
}

function sourceInput(
  sourceId: 'maigret' | 'whatsmyname',
  bytes: Buffer,
  licenseText: string
): PublicRuleSourceInput {
  const isMaigret = sourceId === 'maigret';
  return {
    sourceId,
    kind: isMaigret ? 'maigret_sites' : 'whatsmyname_sites',
    bytes,
    licenseText,
    manifest: {
      repository: isMaigret ? 'https://github.com/soxoj/maigret' : 'https://github.com/WebBreacher/WhatsMyName',
      sourceUrl: isMaigret
        ? 'https://raw.githubusercontent.com/soxoj/maigret/pinned/maigret/resources/data.json'
        : 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/pinned/wmn-data.json',
      commit: isMaigret ? 'b6642744988e7e6c2d21f75db60ec3093019ba25' : '062bcfe48df79fa618e96edc79dc9673f3fe5643',
      retrievedAt: isMaigret ? '2026-09-30T05:30:59.298392+00:00' : '2026-09-30T05:31:03.956135+00:00',
      license: isMaigret ? 'MIT' : 'CC BY-SA 4.0',
      licenseUrl: isMaigret
        ? 'https://github.com/soxoj/maigret/blob/pinned/LICENSE'
        : 'https://creativecommons.org/licenses/by-sa/4.0/'
    }
  };
}

function compileSynthetic(): { maigret: PublicRuleImport; wmn: PublicRuleImport } {
  return {
    maigret: compilePublicRules(sourceInput('maigret', maigretBytes(), MIT_LICENSE)),
    wmn: compilePublicRules(sourceInput('whatsmyname', wmnBytes(), CC_LICENSE))
  };
}

function ruleById(union: PublicRuleUnion, ruleId: string): PublicDiscoveryRule {
  const rule = union.rules.find((candidate) => candidate.ruleId === ruleId);
  assert.ok(rule, `missing rule ${ruleId}`);
  return rule;
}

function exclusionFor(imported: PublicRuleImport, rowId: string): PublicRuleExclusion {
  const receipt = imported.exclusions.find((item) => item.rowId === rowId);
  assert.ok(receipt, `expected an exclusion receipt for ${rowId}`);
  return receipt;
}

function ruleFor(imported: PublicRuleImport, name: string): PublicDiscoveryRule {
  const rule = imported.rules.find((candidate) => candidate.sourceName === name);
  assert.ok(rule, `expected a loaded rule for ${name}`);
  return rule;
}

const KNOWN_TEMPLATES = new Map([['https://github.com/{username}', 'github']]);

function mergeSynthetic(): PublicRuleUnion {
  const { maigret, wmn } = compileSynthetic();
  return mergePublicRules([maigret, wmn], { knownTemplates: KNOWN_TEMPLATES });
}

/* ------------------------------------------------------------------ */
/* Count reconciliation: every row loaded or explicitly excluded        */
/* ------------------------------------------------------------------ */

test('every source row is loaded or explicitly excluded and raw = loaded + excluded', () => {
  const { maigret, wmn } = compileSynthetic();
  for (const imported of [maigret, wmn]) {
    const raw = imported.counts.raw;
    assert.equal(raw, imported.rules.length + imported.exclusions.length, `${imported.sourceId} rows must all be accounted for`);
    assert.equal(raw, imported.counts.loaded + imported.counts.excluded, `${imported.sourceId} raw = loaded + excluded`);
    assert.equal(imported.counts.loaded, imported.rules.length, `${imported.sourceId} loaded count`);
    assert.equal(imported.counts.excluded, imported.exclusions.length, `${imported.sourceId} excluded count`);
    assert.ok(raw > 0);
  }
  // The synthetic Maigret fixture has 18 rows, the WMN fixture 10.
  assert.equal(maigret.counts.raw, 18);
  assert.equal(wmn.counts.raw, 10);
});

test('exclusion receipts store only rowId, row hash and a bounded reason', () => {
  const { maigret, wmn } = compileSynthetic();
  for (const imported of [maigret, wmn]) {
    for (const receipt of imported.exclusions) {
      assert.deepEqual(Object.keys(receipt).sort(), ['reason', 'rowId', 'rowSha256'], 'receipts must stay minimal');
      assert.match(receipt.rowSha256, /^[0-9a-f]{64}$/);
      assert.ok(receipt.reason.length > 0);
      const serialized = JSON.stringify(receipt);
      assert.doesNotMatch(serialized, /SECRET|Bearer|Cookie|cookie|token/i, 'no header values or tokens in receipts');
    }
  }
});

test('normalized outputs never carry raw username examples, tags or upstream descriptions', () => {
  const { maigret, wmn } = compileSynthetic();
  const serialized = JSON.stringify({ rules: maigret.rules.concat(wmn.rules), exclusions: maigret.exclusions.concat(wmn.exclusions) });
  for (const rawValue of [
    'CLAIMED-RAW-USERNAME',
    'UNCLAIMED-RAW-USERNAME',
    'RAW-BETA',
    'RAW-WMN-USERNAME-EXAMPLE',
    'SECRET-TOKEN-VALUE',
    'SECRET-COOKIE-VALUE',
    'SECRET-WMN-COOKIE',
    'Bearer '
  ]) {
    assert.equal(serialized.includes(rawValue), false, `normalized output leaked ${rawValue}`);
  }
});

/* ------------------------------------------------------------------ */
/* Maigret normalization                                               */
/* ------------------------------------------------------------------ */

test('Maigret sites inherit engine site fields and the site record overrides the engine', () => {
  const { maigret } = compileSynthetic();
  // Beta inherits checkType + url template from TestEngine (status-only).
  const beta = ruleFor(maigret, 'Beta');
  assert.equal(beta.requestTemplate, 'https://beta.example.test/u/{username}');
  assert.equal(beta.detection.kind, 'status_only');
  assert.equal(beta.detection.boundedPositive, false, 'status-only rules have no bounded positive proof');
  assert.equal(beta.detection.boundedNegative, false, 'status-only rules have no bounded negative proof');
  // Mu inherits MarkerEngine's message check but its own presenseStrs win.
  const mu = ruleFor(maigret, 'Mu');
  assert.deepEqual(mu.detection.presentAny, ['site-marker-wins']);
  assert.equal(mu.detection.kind, 'bounded_strings');
});

test('supported placeholders are substituted, unsupported template shapes are excluded', () => {
  const { maigret } = compileSynthetic();
  const theta = exclusionFor(maigret, 'Theta');
  assert.equal(theta.reason, 'unsupported_template');
  const probe = ruleFor(maigret, 'Probe');
  assert.equal(probe.requestTemplate, 'https://probe.example.test/api/user/{username}', 'urlProbe is the request template');
  assert.equal(probe.canonicalProfileTemplate, 'https://probe.example.test/{username}', 'url is the profile template');
});

test('unsafe headers are rejected with explicit reasons while safe literal subsets survive', () => {
  const { maigret, wmn } = compileSynthetic();
  assert.equal(exclusionFor(maigret, 'Zeta').reason, 'unsafe_header');
  assert.equal(exclusionFor(wmn, 'HostOverride').reason, 'unsafe_header');
  const safeM = ruleFor(maigret, 'SafeHeaders');
  assert.deepEqual(safeM.safeHeaders, { accept: 'text/html', 'accept-language': 'en' });
  const safeW = ruleFor(wmn, 'SafeHeaders');
  assert.deepEqual(safeW.safeHeaders, { accept: 'text/html' });
});

test('non-HTTPS, non-HTTP protocols, non-GET methods and ID-kind rows are excluded, not silently dropped', () => {
  const { maigret, wmn } = compileSynthetic();
  assert.equal(exclusionFor(maigret, 'Eta').reason, 'non_https_template');
  assert.equal(exclusionFor(maigret, 'Lambda').reason, 'unsupported_protocol');
  assert.equal(exclusionFor(maigret, 'Epsilon').reason, 'unsupported_method');
  assert.equal(exclusionFor(maigret, 'Iota').reason, 'unsupported_id_kind');
  assert.equal(exclusionFor(wmn, 'HttpOnly').reason, 'non_https_template');
});

test('disabled, regex, activation, similar-search and unknown-predicate rows get explicit exclusion reasons', () => {
  const { maigret, wmn } = compileSynthetic();
  assert.equal(exclusionFor(maigret, 'Gamma').reason, 'disabled_rule');
  assert.equal(exclusionFor(maigret, 'Delta').reason, 'unsupported_regex_predicate');
  assert.equal(exclusionFor(maigret, 'Kappa').reason, 'missing_detection_predicate');
  assert.equal(exclusionFor(maigret, 'LongMarker').reason, 'unsupported_marker_length');
});

test('WhatsMyName post_body, placeholder-less and strip-transform rows are classified with bounded reasons', () => {
  const { wmn } = compileSynthetic();
  assert.equal(exclusionFor(wmn, 'PostBody').reason, 'unsupported_post_body');
  assert.equal(exclusionFor(wmn, 'NoPlaceholder').reason, 'missing_account_placeholder');
  assert.equal(exclusionFor(wmn, 'StripChars').reason, 'unsupported_username_transform');
});

/* ------------------------------------------------------------------ */
/* Predicates: bounded vs unbounded                                    */
/* ------------------------------------------------------------------ */

test('WMN e/m predicates stay distinct: presence and absence proofs are separate', () => {
  const { wmn } = compileSynthetic();
  const alpha = ruleFor(wmn, 'Alpha');
  assert.equal(alpha.detection.kind, 'bounded_strings');
  assert.equal(alpha.detection.presentStatus, 200);
  assert.deepEqual(alpha.detection.presentAny, ['wmn-present']);
  assert.equal(alpha.detection.absentStatus, 404);
  assert.deepEqual(alpha.detection.absentAny, ['wmn-absent']);
  assert.equal(alpha.detection.boundedPositive, true);
  assert.equal(alpha.detection.boundedNegative, true);
  // e_string === '' means the positive side is status-only: never a candidate.
  const statusOnly = ruleFor(wmn, 'StatusOnly');
  assert.deepEqual(statusOnly.detection.presentAny, []);
  assert.equal(statusOnly.detection.presentStatus, 200);
  assert.equal(statusOnly.detection.boundedPositive, false);
  // m_code alone still gives bounded negative proof (documented absence response).
  assert.equal(statusOnly.detection.absentStatus, 404);
  assert.equal(statusOnly.detection.boundedNegative, true);
});

test('Maigret response_url rules are loaded as unbounded redirect semantics', () => {
  const bytes = Buffer.from(
    JSON.stringify({
      engines: { RedirectEngine: { name: 'RedirectEngine', site: { checkType: 'response_url' } } },
      tags: [],
      sites: {
        Redirected: {
          engine: 'RedirectEngine',
          url: 'https://redirect.example.test/{username}',
          urlMain: 'https://redirect.example.test'
        }
      }
    }),
    'utf8'
  );
  const imported = compilePublicRules(sourceInput('maigret', bytes, MIT_LICENSE));
  const rule = ruleFor(imported, 'Redirected');
  assert.equal(rule.detection.kind, 'url_redirect');
  assert.equal(rule.detection.boundedPositive, false, 'a redirect can never prove account identity');
  assert.equal(rule.detection.boundedNegative, false);
});

/* ------------------------------------------------------------------ */
/* Determinism and hashing                                             */
/* ------------------------------------------------------------------ */

test('compilation is deterministic: shuffled input rows produce byte-identical output', () => {
  const original = compilePublicRules(sourceInput('maigret', maigretBytes(), MIT_LICENSE));
  const parsed = JSON.parse(maigretBytes().toString('utf8')) as { sites: Record<string, unknown> };
  const shuffled = Object.fromEntries(Object.entries(parsed.sites).reverse());
  const reordered = compilePublicRules(
    sourceInput('maigret', Buffer.from(JSON.stringify({ ...parsed, sites: shuffled }), 'utf8'), MIT_LICENSE)
  );
  assert.equal(JSON.stringify(reordered.rules), JSON.stringify(original.rules), 'rules must be order-independent');
  assert.equal(JSON.stringify(reordered.exclusions), JSON.stringify(original.exclusions));
  assert.deepEqual(reordered.counts, original.counts);
});

test('rule ids are deterministic ASCII hashes and unknown sites never collapse to normalizePlatformId', () => {
  const first = mergeSynthetic();
  const second = mergeSynthetic();
  assert.deepEqual(
    first.groups.map((group) => group.platformId),
    second.groups.map((group) => group.platformId),
    'group ids must be reproducible'
  );
  for (const rule of first.rules) {
    assert.match(rule.ruleId, /^pr-[0-9a-f]{16}$/, 'rule ids are deterministic ASCII hashes');
    assert.equal(ruleById(second, rule.ruleId).ruleId, rule.ruleId);
  }
  for (const group of first.groups) {
    if (group.knownPlatformId === null) {
      assert.match(group.platformId, /^pub-[0-9a-f]{12}$/, 'unknown sites get deterministic hash ids');
    }
  }
  // Two distinct unknown sites must never share an id (no unknown-platform
  // collapse): Alpha / Beta / Nu / GitHub-fake are all distinct groups.
  const ids = first.groups.map((group) => group.platformId);
  assert.equal(new Set(ids).size, ids.length, 'platform ids must be unique');
  const names = first.groups.map((group) => group.name);
  assert.ok(names.includes('Alpha') && names.includes('Beta'), 'unknown sites stay represented');
});

test('known platforms merge only on exact canonical profile templates, never by name or TLD', () => {
  const union = mergeSynthetic();
  // Exact template match maps into the curated platform id.
  const real = union.groups.find((group) => group.canonicalProfileTemplate === 'https://github.com/{username}');
  assert.ok(real);
  assert.equal(real.knownPlatformId, 'github');
  assert.equal(real.platformId, 'github');
  // Same DISPLAY NAME, different template: never merged into the known platform.
  const fake = union.groups.find((group) => group.name === 'GitHub');
  assert.ok(fake);
  assert.equal(fake.knownPlatformId, null);
  assert.notEqual(fake.platformId, 'github');
});

test('groups merge only on exact canonical profile template + instance + account kind; differing predicates stay independent rules with one shared request', () => {
  const union = mergeSynthetic();
  // Alpha arrives from both sources: {account} canonicalizes to {username}.
  const alpha = union.groups.find((group) => group.canonicalProfileTemplate === 'https://alpha.example.test/{username}');
  assert.ok(alpha, 'both sources must merge on the exact canonical template');
  assert.equal(alpha.rules.length, 2, 'differing predicates stay independent rules');
  const kinds = alpha.rules.map((rule) => rule.detection.kind).sort();
  assert.deepEqual(kinds, ['bounded_strings', 'bounded_strings']);
  const requestTemplates = new Set(alpha.rules.map((rule) => rule.requestTemplate));
  assert.equal(requestTemplates.size, 1, 'merged rules share one request template');
  // Both provenance refs survive the overlap.
  assert.deepEqual(alpha.sourceIds.sort(), ['maigret', 'whatsmyname']);
  for (const rule of alpha.rules) {
    assert.ok(rule.sourceRef.rowId.length > 0);
    assert.match(rule.sourceRef.rowSha256, /^[0-9a-f]{64}$/);
  }
  // Nu exists in both sources with the SAME template but stays one group with
  // two rules (provenance preserved per rule).
  const nu = union.groups.find((group) => group.canonicalProfileTemplate === 'https://nu.example.test/{username}');
  assert.ok(nu);
  assert.equal(nu.rules.length, 2);
});

/* ------------------------------------------------------------------ */
/* Union → catalog entries                                             */
/* ------------------------------------------------------------------ */

function minimalCostBasis(): string {
  return '未建立对应操作端点，费用无从核对；金额保持 null；null 不等于免费';
}

function minimalEntry(platformId: string): Record<string, unknown> {
  const capability = (dimension: string): Record<string, unknown> => ({
    dimension,
    documentation: 'unknown',
    docUrls: [],
    endpoints: [],
    sourceLocator: null,
    integration: 'not_integrated',
    access: 'unknown',
    verification: 'documented_only',
    verificationRef: null,
    cost: {
      provider: null,
      unit: null,
      currency: null,
      amount: null,
      asOf: null,
      source: null,
      basis: minimalCostBasis(),
      conditions: null
    },
    sourceRefs: ['maigret'],
    operations: [],
    notes: [],
    ...(dimension === 'comments' ? { comments: { authorReplies: 'unknown', parentChain: 'unknown' } } : {}),
    ...(dimension === 'pagination' ? { pagination: { cursor: 'unknown', sortOptions: null, dateRange: 'unknown' } } : {})
  });
  return {
    platformId,
    name: platformId,
    cohort: 'alternative',
    aliases: [],
    homepage: 'https://synthetic.example.test',
    profileUrlRule: null,
    instance: 'none',
    inputKinds: ['username'],
    accountKinds: ['unknown'],
    applicability: { authorizations: [], conditions: [] },
    capabilities: ['discovery', 'profile', 'list', 'body', 'media', 'comments', 'pagination'].map(capability),
    routes: [
      {
        routeId: 'synthetic-route',
        kind: 'none',
        operation: 'synthetic:none',
        adapterId: null,
        endpoint: null,
        requires: [],
        availability: 'unsupported',
        reason: 'synthetic fixture entry',
        sourceRefs: ['maigret']
      }
    ],
    legacy: null,
    notes: []
  };
}

function syntheticCatalogSnapshot(): PlatformCatalogSnapshot {
  const raw = {
    schemaVersion: 'stripsearch/platform-catalog/v1',
    registryVersion: '2026-09-30.1',
    generatedAt: '2026-09-30',
    sources: [
      {
        sourceId: 'maigret',
        kind: 'public_rule_dataset',
        title: 'Maigret',
        url: 'https://github.com/soxoj/maigret',
        license: 'MIT',
        licenseHash: sha256Hex(MIT_LICENSE),
        upstreamVersion: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
        upstreamState: 'metadata_only_not_imported',
        capturedAt: '2026-09-30T05:30:59.298392+00:00',
        contentHash: sha256Hex(maigretBytes()),
        bytes: maigretBytes().byteLength,
        importerVersion: null,
        counts: { raw: null, loaded: null, excluded: null },
        notes: ['6206 条来源站点记录，不是导入数；未导入']
      },
      {
        sourceId: 'whatsmyname',
        kind: 'public_rule_dataset',
        title: 'WhatsMyName',
        url: 'https://github.com/WebBreacher/WhatsMyName',
        license: 'CC BY-SA 4.0',
        licenseHash: sha256Hex(CC_LICENSE),
        upstreamVersion: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
        upstreamState: 'metadata_only_not_imported',
        capturedAt: '2026-09-30T05:31:03.956135+00:00',
        contentHash: sha256Hex(wmnBytes()),
        bytes: wmnBytes().byteLength,
        importerVersion: null,
        counts: { raw: null, loaded: null, excluded: null },
        notes: ['717 条来源站点记录，不是导入数；未导入']
      }
    ],
    entries: [minimalEntry('synthetic-one')]
  };
  const withHash = {
    ...raw,
    contentHash: catalogContentHash({
      schemaVersion: raw.schemaVersion,
      registryVersion: raw.registryVersion,
      generatedAt: raw.generatedAt,
      sources: raw.sources,
      entries: raw.entries
    })
  };
  return catalogSnapshotFromJson(withHash);
}

test('public rule union entries are honest, compact and carry rule ids plus source links', () => {
  const union = mergeSynthetic();
  const snapshot = syntheticCatalogSnapshot();
  const entries = publicRuleCatalogEntries(union, snapshot.sources);
  assert.ok(entries.length > 0);
  const seenIds = new Set<string>();
  for (const entry of entries) {
    assert.equal(seenIds.has(entry.platformId), false, 'entry ids must be unique');
    seenIds.add(entry.platformId);
    assert.equal(entry.cohort, 'public_rule');
    assert.equal(entry.legacy, null, 'public rule entries never enter the legacy projection');
    assert.equal(entry.capabilities.length, 7);
    assert.ok(entry.routes.length > 0);
    for (const route of entry.routes) {
      assert.equal(route.kind, 'username_probe');
      assert.ok((route.ruleIds ?? []).length > 0, 'routes carry shared rule ids');
      assert.ok(route.sourceRefs.length > 0, 'routes carry source links');
      assert.ok(route.endpoint === null || route.endpoint.includes('{username}'));
    }
    for (const record of entry.capabilities) {
      assert.equal(record.cost.amount, null, 'unknown costs stay null');
      assert.match(record.cost.basis, /未知|未核对|null/i);
      assert.equal(record.verificationRef, null);
      assert.notEqual(record.verification, 'live_verified', 'no live verification is claimed');
      assert.notEqual(record.integration, 'integrated', 'standalone executor is not wired into the legacy runner');
    }
    const discovery = entry.capabilities.find((record) => record.dimension === 'discovery');
    assert.ok(discovery && discovery.sourceLocator?.startsWith('public-rule:'), 'discovery cites the rule source locator');
  }
  // Known-mapped groups never produce duplicate curated entries.
  assert.equal(entries.some((entry) => entry.platformId === 'github'), false);
});

test('public rule summary counts source rows, rules, union platforms/instances and routes as separate metrics', () => {
  const union = mergeSynthetic();
  const snapshot = syntheticCatalogSnapshot();
  const entries = publicRuleCatalogEntries(union, snapshot.sources);
  const composed = { ...snapshot, entries: [...snapshot.entries, ...entries] };
  const summary = catalogSummary(composed, union);
  assert.equal(summary.platformCount, snapshot.entries.length + entries.length, 'generated entries are catalog platforms');
  assert.equal(summary.cohorts.public_rule, entries.length);
  assert.equal(summary.publicRuleSourceRows, 28, 'source rows = 18 Maigret + 10 WMN');
  assert.equal(summary.publicRuleCount, union.rules.length, 'compiled rules are counted from the union');
  assert.equal(summary.publicRuleExcludedCount, union.counts.excluded);
  assert.equal(summary.unionPlatformCount, union.counts.unionPlatforms);
  assert.equal(summary.unionInstanceCount, union.counts.unionInstances);
  assert.equal(summary.unionRouteCount, union.counts.unionRoutes);
  // The metrics are derived separately and must not be conflated.
  assert.notEqual(summary.publicRuleCount, summary.publicRuleSourceRows, 'rules ≠ source rows');
  assert.notEqual(summary.publicRuleCount, summary.unionPlatformCount, 'rules ≠ union platforms');
  assert.notEqual(summary.unionRouteCount, summary.publicRuleSourceRows, 'routes ≠ source rows');
  assert.ok(summary.unionInstanceCount >= summary.unionPlatformCount, 'instances cover at least one per platform');
  assert.ok(summary.routeCount >= summary.unionRouteCount, 'total routes include union routes');
});

test('group ids and platform ids are stable ASCII and grouping ignores display name', () => {
  const union = mergeSynthetic();
  for (const group of union.groups) {
    assert.match(group.groupId, /^pug-[0-9a-f]{12}$/);
    assert.equal(group.instanceHost.length > 0, true);
  }
  assert.ok(publicRuleUnionGroups(union.rules, KNOWN_TEMPLATES).length === union.groups.length);
});

test('compile rejects malformed source bytes and missing license text explicitly', () => {
  assert.throws(
    () => compilePublicRules({ ...sourceInput('maigret', Buffer.from('not-json'), MIT_LICENSE) }),
    (error: unknown) => error instanceof Error && /malformed|parse/i.test(error.message)
  );
  assert.throws(
    () => compilePublicRules({ ...sourceInput('maigret', maigretBytes(), '   ') }),
    (error: unknown) => error instanceof Error && /license/i.test(error.message)
  );
  const wrongRoot = Buffer.from(JSON.stringify({ sites: [] }), 'utf8');
  assert.throws(
    () => compilePublicRules(sourceInput('whatsmyname', wrongRoot, CC_LICENSE)),
    (error: unknown) => error instanceof Error && /shape|sites/i.test(error.message)
  );
});

test('compile verifies the pinned byte hash and record count against its own manifest', () => {
  const input = sourceInput('maigret', maigretBytes(), MIT_LICENSE);
  const imported = compilePublicRules({
    ...input,
    manifest: { ...input.manifest, sha256: 'f'.repeat(64), bytes: 1, recordCount: 999 }
  });
  assert.ok(imported.verification.mismatch.includes('byte_hash'));
  assert.ok(imported.verification.mismatch.includes('bytes'));
  assert.ok(imported.verification.mismatch.includes('record_count'));
  const clean = compilePublicRules({
    ...input,
    manifest: { ...input.manifest, sha256: sha256Hex(maigretBytes()), bytes: maigretBytes().byteLength, recordCount: 18 }
  });
  assert.deepEqual(clean.verification.mismatch, []);
  assert.equal(clean.verification.byteHashVerified, true);
});

test('schema constants stay explicit and rules never embed code or unbounded regex', () => {
  assert.equal(PUBLIC_RULES_SCHEMA_VERSION, 'stripsearch/public-rules/v1');
  const union = mergeSynthetic();
  for (const rule of union.rules) {
    const serialized = JSON.stringify(rule);
    assert.equal(serialized.includes('eval('), false);
    assert.equal(serialized.includes('function'), false);
    for (const marker of rule.detection.presentAny.concat(rule.detection.absentAny)) {
      assert.ok(marker.length <= 200, 'markers stay bounded literals');
    }
    assert.equal(rule.caseSensitive, true, 'literal matching is case-sensitive by documented policy');
    assert.equal(rule.ratePerMinute, null, 'sources record no rate bound: unknown stays null');
    assert.equal(rule.accountKind, 'unknown', 'sources do not classify account kinds; nothing is fabricated');
  }
});

test('canonical templates normalize {account} to {username} and host case while keeping exact path semantics', () => {
  assert.equal(canonicalPublicTemplate('https://GitHub.com/User/{account}/'), 'https://github.com/User/{username}/', 'trailing slashes are preserved');
  assert.equal(canonicalPublicTemplate('http://github.com/{username}'), null, 'non-https templates are not canonicalizable');
  assert.equal(canonicalPublicTemplate('https://github.com/find'), 'https://github.com/find');
  assert.equal(canonicalPublicTemplate('https://{instance}/@{username}'), null, 'instance placeholders cannot be pinned');
});
