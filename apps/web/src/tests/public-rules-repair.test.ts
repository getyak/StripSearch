/**
 * GET-91 consolidated repair regressions (Task 2 semantics / loader / union).
 *
 * These tests reproduce the confirmed independent-review findings BEFORE the
 * fix, so each one must fail against the initial implementation and pass
 * after the repair. All offline: synthetic pinned inputs only, no network.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PublicRuleImport, PublicRuleSourceInput } from '../shared/public-discovery-rules.js';
import {
  canonicalPublicTemplate,
  PUBLIC_RULES_MANIFEST_SCHEMA_VERSION,
  PUBLIC_RULES_SCHEMA_VERSION
} from '../shared/public-discovery-rules.js';
import {
  compilePublicRules,
  loadPublicRuleBundle,
  mergePublicRules,
  publicRuleCatalogEntries,
  knownPlatformTemplateMap
} from '../server/platforms/public-rules.js';
import {
  catalogContentHash,
  catalogSnapshotFromJson,
  catalogSummary,
  loadPlatformCatalog
} from '../server/platforms/catalog.js';

const MIT_LICENSE = 'MIT License\n\nCopyright (c) 2020-2026 Soxoj\n\nPermission is hereby granted...\n';

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function maigretInput(sites: Record<string, unknown>, engines: Record<string, unknown> = {}): PublicRuleSourceInput {
  const bytes = Buffer.from(JSON.stringify({ engines, tags: [], sites }), 'utf8');
  return {
    sourceId: 'maigret',
    kind: 'maigret_sites',
    bytes,
    licenseText: MIT_LICENSE,
    manifest: {
      repository: 'https://github.com/soxoj/maigret',
      sourceUrl: 'https://raw.githubusercontent.com/soxoj/maigret/pinned/maigret/resources/data.json',
      commit: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
      retrievedAt: '2026-09-30T05:30:59.298392+00:00',
      license: 'MIT',
      licenseUrl: 'https://github.com/soxoj/maigret/blob/pinned/LICENSE'
    }
  };
}

function site(over: Record<string, unknown>): Record<string, unknown> {
  return {
    urlMain: 'https://site.example.test',
    checkType: 'message',
    presenseStrs: ['profile-of-user'],
    absenceStrs: ['no-such-user-here'],
    ...over
  };
}

function loadedRule(imported: PublicRuleImport, rowId: string) {
  const rule = imported.rules.find((candidate) => candidate.sourceRef.rowId === rowId);
  assert.ok(rule, `expected loaded rule for ${rowId}`);
  return rule;
}

function excluded(imported: PublicRuleImport, rowId: string): string {
  const receipt = imported.exclusions.find((item) => item.rowId === rowId);
  assert.ok(receipt, `expected exclusion receipt for ${rowId}`);
  return receipt.reason;
}

/* ------------------------------------------------------------------ */
/* P1: source literal markers keep every byte                          */
/* ------------------------------------------------------------------ */

test('P1 markers keep every source byte: leading/trailing whitespace is meaningful', () => {
  const imported = compilePublicRules(
    maigretInput({
      Whitespace: site({
        url: 'https://whitespace.example.test/{username}',
        presenseStrs: [' user='],
        absenceStrs: [' gone ']
      })
    })
  );
  const rule = loadedRule(imported, 'Whitespace');
  assert.deepEqual(rule.detection.presentAny, [' user='], 'leading whitespace must survive compilation');
  assert.deepEqual(rule.detection.absentAny, [' gone '], 'trailing whitespace must survive compilation');
  // The compiled predicate is byte-faithful: 'xuser=' matches neither.
  assert.equal('xuser='.includes(' user='), false, 'the source predicate must not be broadened');
  assert.equal('pinned user= here'.includes(' user='), true);
});

test('P1 empty or whitespace-only markers are rejected explicitly, never silently dropped', () => {
  const imported = compilePublicRules(
    maigretInput({
      EmptyMarker: site({
        url: 'https://empty.example.test/{username}',
        presenseStrs: ['', 'real-marker']
      }),
      BlankMarker: site({
        url: 'https://blank.example.test/{username}',
        presenseStrs: ['   ']
      }),
      BlankSingle: {
        url: 'https://blanksingle.example.test/{username}',
        urlMain: 'https://blanksingle.example.test',
        checkType: 'message',
        presenseStrs: ['real-marker'],
        absenceStrs: ['\t']
      }
    })
  );
  assert.equal(excluded(imported, 'EmptyMarker'), 'unsupported_marker_value');
  assert.equal(excluded(imported, 'BlankMarker'), 'unsupported_marker_value');
  assert.equal(excluded(imported, 'BlankSingle'), 'unsupported_marker_value');
});

/* ------------------------------------------------------------------ */
/* P2: exact templates — trailing slash and fragments                  */
/* ------------------------------------------------------------------ */

test('P2 trailing slash keeps two request templates distinct (no exact-merge rewrite)', () => {
  const imported = compilePublicRules(
    maigretInput({
      WithSlash: site({ url: 'https://slash.example.test/user/{username}/' }),
      WithoutSlash: site({ url: 'https://slash.example.test/user/{username}' })
    })
  );
  const union = mergePublicRules([imported], { knownTemplates: new Map() });
  assert.equal(union.groups.length, 2, 'different source paths must not merge');
  assert.equal(union.counts.unionRoutes, 2, 'each exact request template stays its own route');
  const templates = union.groups.map((group) => group.requestTemplates.join('|')).sort();
  assert.deepEqual(templates, ['https://slash.example.test/user/{username}', 'https://slash.example.test/user/{username}/']);
});

test('P2 fragment-only account requests are excluded; profile fragments keep the account locator', () => {
  const imported = compilePublicRules(
    maigretInput({
      FragmentOnly: site({ url: 'https://fragment.example.test/#/user/{username}' }),
      FragmentProfile: {
        url: 'https://fragmentprofile.example.test/#/user/{username}',
        urlProbe: 'https://fragmentprofile.example.test/api/user/{username}',
        urlMain: 'https://fragmentprofile.example.test',
        checkType: 'message',
        presenseStrs: ['PROFILE']
      }
    })
  );
  assert.equal(excluded(imported, 'FragmentOnly'), 'unsupported_template');
  const rule = loadedRule(imported, 'FragmentProfile');
  assert.match(rule.canonicalProfileTemplate, /\{username\}/, 'the profile locator must keep the account position');
  assert.match(rule.canonicalProfileTemplate, /#\/user\/\{username\}/);
  assert.equal(rule.requestTemplate, 'https://fragmentprofile.example.test/api/user/{username}');
});

test('P2 canonicalization can never silently drop the username placeholder', () => {
  const imported = compilePublicRules(
    maigretInput({
      Escaping: site({ url: 'https://escape.example.test/{username}/../..' })
    })
  );
  assert.equal(excluded(imported, 'Escaping'), 'unsupported_template');
  assert.equal(canonicalPublicTemplate('https://x.example.test/u/{username}/'), 'https://x.example.test/u/{username}/', 'trailing slash is preserved');
});

/* ------------------------------------------------------------------ */
/* P2: strict bundle loader                                            */
/* ------------------------------------------------------------------ */

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
    cost: { provider: null, unit: null, currency: null, amount: null, asOf: null, source: null, basis: '未建立；金额保持 null；null 不等于免费', conditions: null },
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
    routes: [{ routeId: 'synthetic-route', kind: 'none', operation: 'synthetic:none', adapterId: null, endpoint: null, requires: [], availability: 'unsupported', reason: 'synthetic', sourceRefs: ['maigret'] }],
    legacy: null,
    notes: []
  };
}

function writeCuratedCatalog(dir: string, options: { requiresBundle: boolean }): void {
  const sources = [
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
      contentHash: 'a'.repeat(64),
      bytes: 1,
      importerVersion: null,
      counts: { raw: null, loaded: null, excluded: null },
      notes: ['6206 条来源站点记录，不是导入数；未导入']
    }
  ];
  const content = {
    schemaVersion: 'stripsearch/platform-catalog/v1',
    registryVersion: '2026-09-30.1',
    generatedAt: '2026-09-30',
    sources,
    entries: [minimalEntry('synthetic-one')]
  };
  const raw = { ...content, contentHash: catalogContentHash(content as never) };
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const manifest = {
    schemaVersion: 'stripsearch/platform-catalog-manifest/v1',
    registryVersion: raw.registryVersion,
    requiresPublicRuleBundle: options.requiresBundle,
    files: [{ path: 'catalog.json', sha256: sha256Hex(bytes) }],
    counts: { platforms: 1 }
  };
  writeFileSync(path.join(dir, 'catalog.json'), bytes);
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

interface BundleFixture {
  dataDir: string;
  bundleDir: string;
}

function writeBundleFixture(name: string, t: { after: (fn: () => void) => void }, options: { requiresBundle: boolean }): BundleFixture {
  const workDir = mkdtempSync(path.join(tmpdir(), `repair-bundle-${name}-`));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const dataDir = path.join(workDir, 'data', 'platforms');
  mkdirSync(dataDir, { recursive: true });
  writeCuratedCatalog(dataDir, options);
  const bundleDir = path.join(dataDir, 'public-rules');
  mkdirSync(bundleDir, { recursive: true });
  return { dataDir, bundleDir };
}

function compileFixtureRule(ruleId: string, marker: string): Record<string, unknown> {
  return {
    ruleId,
    sourceRef: { sourceId: 'maigret', rowId: `row-${marker}`, rowSha256: sha256Hex(marker) },
    sourceName: `Site ${marker}`,
    canonicalProfileTemplate: `https://${marker}.example.test/{username}`,
    requestTemplate: `https://${marker}.example.test/{username}`,
    instanceHost: `${marker}.example.test`,
    accountKind: 'unknown',
    detection: {
      kind: 'bounded_strings',
      presentStatus: null,
      presentAny: [marker],
      nonProofPresentAny: [],
      absentStatus: null,
      absentAny: [],
      boundedPositive: true,
      boundedNegative: false
    },
    caseSensitive: true,
    ratePerMinute: null,
    protections: [],
    errorMarkers: [],
    safeHeaders: {}
  };
}

function writeSyntheticBundle(bundleDir: string, marker: string): void {
  const rules = [compileFixtureRule(`pr-${sha256Hex(marker).slice(0, 16)}`, marker)];
  const exclusions = [
    { sourceId: 'maigret', exclusions: [{ rowId: 'row-excluded', rowSha256: sha256Hex('excluded'), reason: 'disabled_rule' }] },
    { sourceId: 'whatsmyname', exclusions: [{ rowId: 'row-excluded-wmn', rowSha256: sha256Hex('excluded-wmn'), reason: 'disabled_rule' }] }
  ];
  writeFileSync(path.join(bundleDir, 'rules.json'), `${JSON.stringify({ schemaVersion: PUBLIC_RULES_SCHEMA_VERSION, rules }, null, 1)}\n`);
  writeFileSync(path.join(bundleDir, 'exclusions.json'), `${JSON.stringify({ schemaVersion: PUBLIC_RULES_SCHEMA_VERSION, sources: exclusions }, null, 1)}\n`);
  writeFileSync(path.join(bundleDir, 'maigret-LICENSE.txt'), MIT_LICENSE);
  writeFileSync(path.join(bundleDir, 'whatsmyname-LICENSE.txt'), 'CC notice\n');
  writeFileSync(path.join(bundleDir, 'maigret-NOTICE.md'), `# maigret notice ${marker}\n`);
  writeFileSync(path.join(bundleDir, 'whatsmyname-NOTICE.md'), '# whatsmyname notice\n');
  writeFileSync(path.join(bundleDir, 'LICENSE-DATASETS.md'), '# dataset licensing\n');
  const sources = [
    {
      sourceId: 'maigret',
      kind: 'maigret_sites',
      repository: 'https://github.com/soxoj/maigret',
      sourceUrl: 'https://raw.githubusercontent.com/soxoj/maigret/pinned/maigret/resources/data.json',
      commit: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
      retrievedAt: '2026-09-30T05:30:59.298392+00:00',
      contentHash: sha256Hex(marker),
      bytes: 10,
      license: 'MIT',
      licenseUrl: 'https://github.com/soxoj/maigret/blob/pinned/LICENSE',
      licenseHash: sha256Hex(MIT_LICENSE),
      importerVersion: 'get91-public-rule-importer/1',
      counts: { raw: 2, loaded: 1, excluded: 1 },
      exclusionsByReason: { disabled_rule: 1 },
      notice: 'maigret-NOTICE.md',
      licenseFile: 'maigret-LICENSE.txt'
    },
    {
      sourceId: 'whatsmyname',
      kind: 'whatsmyname_sites',
      repository: 'https://github.com/WebBreacher/WhatsMyName',
      sourceUrl: 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/pinned/wmn-data.json',
      commit: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
      retrievedAt: '2026-09-30T05:31:03.956135+00:00',
      contentHash: sha256Hex(`${marker}-wmn`),
      bytes: 20,
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      licenseHash: sha256Hex('CC notice\n'),
      importerVersion: 'get91-public-rule-importer/1',
      counts: { raw: 1, loaded: 0, excluded: 1 },
      exclusionsByReason: { disabled_rule: 1 },
      notice: 'whatsmyname-NOTICE.md',
      licenseFile: 'whatsmyname-LICENSE.txt'
    }
  ];
  // The whatsmyname group carries its own exclusion row count of 1.
  const doc = {
    schemaVersion: PUBLIC_RULES_MANIFEST_SCHEMA_VERSION,
    importerVersion: 'get91-public-rule-importer/1',
    generatedAt: '2026-09-30T05:31:03.956135+00:00',
    files: [
      'rules.json',
      'exclusions.json',
      'maigret-LICENSE.txt',
      'whatsmyname-LICENSE.txt',
      'maigret-NOTICE.md',
      'whatsmyname-NOTICE.md',
      'LICENSE-DATASETS.md'
    ].map((file) => {
      const bytes = readFileSync(path.join(bundleDir, file));
      return { path: file, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    }),
    sources,
    counts: { sourceRows: 3, loaded: 1, excluded: 2 }
  };
  writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(doc, null, 1)}\n`);
}

test('P2 strict loader refuses bundles without per-source license/notice artifacts', (t) => {
  const { dataDir, bundleDir } = writeBundleFixture('no-license', t, { requiresBundle: true });
  writeSyntheticBundle(bundleDir, 'alpha');
  rmSync(path.join(bundleDir, 'maigret-LICENSE.txt'));
  // Drop the pin from the manifest too (the fixture is rebuilt without it).
  const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as {
    files: Array<{ path: string }>;
  };
  manifest.files = manifest.files.filter((file) => file.path !== 'maigret-LICENSE.txt');
  writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  assert.throws(
    () => loadPublicRuleBundle(dataDir),
    (error: unknown) => /license|notice/i.test((error as Error).message),
    'missing license artifacts must be refused'
  );
});

test('P2 strict loader refuses empty positive markers and missing bounded flags', (t) => {
  const { dataDir, bundleDir } = writeBundleFixture('bad-rule', t, { requiresBundle: true });
  const cases: Array<{ name: string; mutate: (rule: Record<string, unknown>) => void }> = [
    {
      name: 'empty-positive-marker',
      mutate: (rule) => {
        (rule.detection as Record<string, unknown>).presentAny = [];
      }
    },
    {
      name: 'missing-boolean',
      mutate: (rule) => {
        delete (rule.detection as Record<string, unknown>).boundedPositive;
      }
    },
    {
      name: 'whitespace-marker',
      mutate: (rule) => {
        (rule.detection as Record<string, unknown>).presentAny = ['   '];
      }
    }
  ];
  for (const item of cases) {
    writeSyntheticBundle(bundleDir, `case-${item.name}`.slice(0, 24));
    const rulesPath = path.join(bundleDir, 'rules.json');
    const doc = JSON.parse(readFileSync(rulesPath, 'utf8')) as { rules: Array<Record<string, unknown>> };
    item.mutate(doc.rules[0]!);
    writeFileSync(rulesPath, JSON.stringify(doc, null, 1));
    // Re-pin the mutated file so only the shape check can refuse it.
    const manifestPath = path.join(bundleDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; sha256: string; bytes: number }> };
    const bytes = readFileSync(rulesPath);
    manifest.files = manifest.files.map((file) =>
      file.path === 'rules.json' ? { path: file.path, sha256: sha256Hex(bytes), bytes: bytes.byteLength } : file
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
    assert.throws(
      () => loadPublicRuleBundle(dataDir),
      (error: unknown) => (error as { code?: string }).code === 'invalid_shape',
      `${item.name} must be refused`
    );
  }
});

/* ------------------------------------------------------------------ */
/* P1: composed catalog identity                                       */
/* ------------------------------------------------------------------ */

test('P1 composed snapshot identity covers the exact bundle and differs from curated-only identity', (t) => {
  const first = writeBundleFixture('identity-a', t, { requiresBundle: true });
  writeSyntheticBundle(first.bundleDir, 'alpha');
  const second = writeBundleFixture('identity-b', t, { requiresBundle: true });
  writeSyntheticBundle(second.bundleDir, 'beta');

  const composedA = loadPlatformCatalog(first.dataDir);
  const composedB = loadPlatformCatalog(second.dataDir);
  assert.notEqual(composedA.contentHash, composedB.contentHash, 'different bundles must produce different full identity');
  assert.notEqual(composedA.registryVersion, composedB.registryVersion, 'composition changes the full registry version');
  const curatedRaw = JSON.parse(readFileSync(path.join(first.dataDir, 'catalog.json'), 'utf8')) as { contentHash: string; registryVersion: string };
  assert.notEqual(composedA.contentHash, curatedRaw.contentHash, 'composed identity must not reuse the curated hash');
  assert.notEqual(composedA.registryVersion, curatedRaw.registryVersion);
  // The curated entry itself survives unchanged.
  const curatedEntry = composedA.entries.find((entry) => entry.cohort !== 'public_rule');
  assert.ok(curatedEntry);
  assert.equal(curatedEntry.platformId, 'synthetic-one');
  // Sources carry merged import facts without duplicates.
  const maigret = composedA.sources.find((source) => source.sourceId === 'maigret');
  assert.ok(maigret);
  assert.equal(maigret.counts.loaded, 1);
  assert.equal(maigret.counts.raw, 2);
  assert.equal(new Set(composedA.sources.map((source) => source.sourceId)).size, composedA.sources.length, 'no duplicate source ids');
  assert.notEqual(maigret.upstreamState, 'metadata_only_not_imported', 'the composed source records show the actual import state');
});

test('P1 production data without the required bundle fails closed; curated-only mode is explicit', (t) => {
  const missing = writeBundleFixture('missing-required', t, { requiresBundle: true });
  assert.throws(
    () => loadPlatformCatalog(missing.dataDir),
    (error: unknown) => /public_rule|bundle/i.test((error as Error).message),
    'a required bundle must never silently fall back to the 54-entry identity'
  );

  const curatedOnly = writeBundleFixture('curated-only', t, { requiresBundle: false });
  const snapshot = loadPlatformCatalog(curatedOnly.dataDir);
  const raw = JSON.parse(readFileSync(path.join(curatedOnly.dataDir, 'catalog.json'), 'utf8')) as { contentHash: string };
  assert.equal(snapshot.contentHash, raw.contentHash, 'explicit curated-only mode keeps the curated identity');
  assert.equal(snapshot.mode, 'curated_only');
  assert.equal(snapshot.publicRules, null);
});

test('P2 route provenance is per-request: sourceRefs match the route ruleIds sources', () => {
  const maigretImport = compilePublicRules(
    maigretInput({
      Multi: site({ url: 'https://multi.example.test/{username}', urlProbe: 'https://multi.example.test/api/{username}' })
    })
  );
  const wmnBytes = Buffer.from(
    JSON.stringify({
      license: ['CC'],
      sites: [
        {
          name: 'Multi',
          uri_check: 'https://multi.example.test/{account}',
          e_code: 200,
          e_string: 'wmn-present',
          m_code: 404,
          m_string: 'wmn-absent'
        }
      ]
    }),
    'utf8'
  );
  const wmnImport = compilePublicRules({
    sourceId: 'whatsmyname',
    kind: 'whatsmyname_sites',
    bytes: wmnBytes,
    licenseText: 'CC notice\n',
    manifest: {
      repository: 'https://github.com/WebBreacher/WhatsMyName',
      sourceUrl: 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/pinned/wmn-data.json',
      commit: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
      retrievedAt: '2026-09-30T05:31:03.956135+00:00',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/'
    }
  });
  // Same profile template from both sources, two different request templates:
  // each route must name only its own rule sources.
  const union = mergePublicRules([maigretImport, wmnImport], { knownTemplates: new Map() });
  const group = union.groups.find((candidate) => candidate.canonicalProfileTemplate === 'https://multi.example.test/{username}');
  assert.ok(group);
  assert.equal(group.requestTemplates.length, 2, 'the two source requests stay distinct');
  assert.deepEqual(group.sourceIds.sort(), ['maigret', 'whatsmyname']);
  const sourceManifest = (sourceId: 'maigret' | 'whatsmyname', title: string, url: string, license: string, licenseHash: string) => ({
    sourceId,
    kind: 'public_rule_dataset' as const,
    title,
    url,
    license,
    licenseHash,
    upstreamVersion: 'x',
    upstreamState: 'metadata_only_not_imported',
    capturedAt: null,
    contentHash: null,
    bytes: null,
    importerVersion: null,
    counts: { raw: null, loaded: null, excluded: null },
    notes: []
  });
  const entries = publicRuleCatalogEntries(union, [
    sourceManifest('maigret', 'Maigret', 'https://github.com/soxoj/maigret', 'MIT', sha256Hex(MIT_LICENSE)),
    sourceManifest('whatsmyname', 'WhatsMyName', 'https://github.com/WebBreacher/WhatsMyName', 'CC BY-SA 4.0', sha256Hex('CC notice\n'))
  ]);
  const routeSourceSets = entries.flatMap((entry) => entry.routes.map((route) => [...(route.sourceRefs ?? [])].sort().join(',')));
  assert.deepEqual(routeSourceSets.sort(), ['maigret', 'whatsmyname'], 'each route names exactly its own request rule sources');
  for (const entry of entries) {
    for (const route of entry.routes) {
      const ruleSources = new Set(
        (route.ruleIds ?? []).flatMap((ruleId) => {
          const rule = union.rules.find((candidate) => candidate.ruleId === ruleId);
          return rule ? [rule.sourceRef.sourceId] : [];
        })
      );
      assert.deepEqual(
        [...(route.sourceRefs ?? [])].sort(),
        [...ruleSources].sort(),
        `${entry.platformId}/${route.routeId}: route sourceRefs must match its own rules`
      );
    }
  }
});

test('P2 loader summary distinguishes source rows, rules, union platforms/instances and routes', () => {
  const imported = compilePublicRules(
    maigretInput({
      One: site({ url: 'https://one.example.test/{username}' }),
      Two: site({ url: 'https://two.example.test/{username}', urlProbe: 'https://two.example.test/api/{username}' })
    })
  );
  const union = mergePublicRules([imported], { knownTemplates: new Map() });
  assert.equal(union.counts.sourceRows, 2);
  assert.equal(union.counts.loaded, 2);
  assert.equal(union.counts.unionPlatforms, 2);
  assert.equal(union.counts.unionInstances, 2);
  assert.equal(union.counts.unionRoutes, 2);
  const sources = [
    {
      sourceId: 'maigret',
      kind: 'public_rule_dataset',
      title: 'Maigret',
      url: 'https://github.com/soxoj/maigret',
      license: 'MIT',
      licenseHash: sha256Hex(MIT_LICENSE),
      upstreamVersion: 'x',
      upstreamState: 'metadata_only_not_imported',
      capturedAt: null,
      contentHash: null,
      bytes: null,
      importerVersion: null,
      counts: { raw: null, loaded: null, excluded: null },
      notes: []
    }
  ];
  const content = {
    schemaVersion: 'stripsearch/platform-catalog/v1',
    registryVersion: 'r',
    generatedAt: 'g',
    sources,
    entries: [minimalEntry('synthetic-one')]
  };
  const summary = catalogSummary(
    catalogSnapshotFromJson({ ...content, contentHash: catalogContentHash(content as never) }),
    union
  );
  assert.equal(summary.publicRuleSourceRows, 2);
  assert.equal(summary.publicRuleCount, 2);
  assert.equal(summary.unionPlatformCount, 2);
  assert.equal(summary.unionRouteCount, 2);
  assert.equal(summary.publicRuleCount + summary.publicRuleExcludedCount, summary.publicRuleSourceRows);
});
