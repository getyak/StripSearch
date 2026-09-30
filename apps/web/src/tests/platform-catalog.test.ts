/**
 * GET-90 platform catalog contract tests: versioned catalog data, loader
 * validation (hashes, duplicates, source refs, shapes, evidence rules), the
 * three explicit projections (legacy probe registry, GET-60 completion
 * registry, GET-59 capability snapshot), the extended
 * `/api/discovery/registry` surface and production data packaging.
 *
 * Everything here is offline: the catalog is data on disk, no provider or
 * public documentation is fetched while testing, and packaging tests use
 * synthetic canary files only.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CAPABILITY_DIMENSIONS,
  capabilityStateFor
} from '../shared/platform-catalog.js';
import type {
  CatalogAccessContext,
  CatalogApplicabilityInput,
  CatalogCapabilityState,
  CapabilityRecord,
  DiscoveryRoute,
  PlatformCatalogSnapshot
} from '../shared/platform-catalog.js';
import {
  CatalogLoadError,
  catalogContentHash,
  catalogSnapshotFromJson,
  catalogSummary,
  defaultCatalogDataDir,
  loadPlatformCatalog,
  platformGaps,
  toCapabilitySnapshot,
  toCompletionRegistry,
  toLegacyRegistry
} from '../server/platforms/catalog.js';
import { BUILTIN_PLATFORM_REGISTRY, registrySummary } from '../server/platforms/registry.js';
import type { CapabilitySnapshot as Get59CapabilitySnapshot } from '../server/research/research-tool-dispatch.js';
import { startTestServer } from './harness.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourceDataDir = path.join(appRoot, 'data', 'platforms');

/* ------------------------------------------------------------------ */
/* Independent expectations copied from the approved spec (§4)         */
/* ------------------------------------------------------------------ */

const SPEC_TIKHUB_IDS = [
  'douyin', 'tiktok', 'xiaohongshu', 'lemon8', 'bilibili', 'kuaishou', 'pipixia', 'weibo',
  'wechat-mp', 'wechat-channels', 'toutiao', 'xigua', 'instagram', 'youtube', 'x', 'threads',
  'reddit', 'linkedin', 'telegram', 'zhihu'
];

const SPEC_ALTERNATIVE_IDS = [
  'facebook', 'pinterest', 'snapchat', 'bluesky', 'mastodon', 'github', 'gitlab', 'hackernews',
  'stackoverflow', 'huggingface', 'medium', 'substack', 'twitch', 'steam', 'naver', 'vk',
  'spotify', 'soundcloud', 'kick', 'rumble', 'truth-social', 'linktree', 'quora', 'douban',
  'baidu-tieba', 'jike', 'xiaoyuzhou', 'whatsapp', 'line', 'discord'
];

const SPEC_PERSONAL_WEBSITE_ID = 'personal-website';

/* Independently frozen public-source values (retrieved by the parent task
 * into the private cache; hardcoded here so the test cannot drift with the
 * data it checks). */
const EXPECTED_SOURCES = {
  maigret: {
    upstreamVersion: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
    contentHash: '3ac973e44f765c1c2b851571bd165f45145d0a00231c8ea97fb479e93f6aa289',
    license: 'MIT',
    licenseHash: '9748c279c95c58e64cc9e538e8c717ae9dce66bbed1d69e7d3e77e431d7e582d',
    capturedAt: '2026-09-30T05:30:59.298392+00:00',
    sourceRecords: 6206
  },
  whatsmyname: {
    upstreamVersion: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
    contentHash: '507d2f8aa5b1297ae2d713634ccc7ce08357fed85b1d40130585810f456c1cfe',
    license: 'CC BY-SA 4.0',
    licenseHash: '3eab49aa5cabc24918c11aab97dfe8873e0641317b898d989c993c4283a4d84b',
    capturedAt: '2026-09-30T05:31:03.956135+00:00',
    sourceRecords: 717
  },
  'tikhub-openapi': {
    upstreamVersion: 'V5.3.2',
    contentHash: 'b97eb0f6331b5709da1ab789359d48efabe177c4ebdcd83078b7e57e9b8709c5',
    capturedAt: '2026-09-30T05:29:49.939125+00:00'
  },
  'tikhub-endpoint-pricing': {
    upstreamVersion: null,
    contentHash: '859e6687762f4b4c54324f6d15165c85b0ae4d1668cd7b9d29601297b3cda882',
    capturedAt: '2026-09-30T05:29:52.873261+00:00'
  }
};

function loadSourceCatalog(): PlatformCatalogSnapshot {
  return loadPlatformCatalog(sourceDataDir);
}

function entryById(snapshot: PlatformCatalogSnapshot, platformId: string) {
  const found = snapshot.entries.find((entry) => entry.platformId === platformId);
  assert.ok(found, `missing entry ${platformId}`);
  return found;
}

function capabilityOf(entry: PlatformCatalogSnapshot['entries'][number], dimension: CapabilityRecord['dimension']): CapabilityRecord {
  const found = entry.capabilities.find((record) => record.dimension === dimension);
  assert.ok(found, `${entry.platformId} missing ${dimension}`);
  return found;
}

/* ------------------------------------------------------------------ */
/* Synthetic catalog fixture (test-only builder)                       */
/* ------------------------------------------------------------------ */

function costFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: null,
    unit: null,
    currency: null,
    amount: null,
    asOf: '2026-09-30',
    source: null,
    basis: '公开定价页未列出该项（2026-09-30 核对）',
    conditions: null,
    ...over
  };
}

function operationFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: 'fixture-op',
    kind: 'tikhub_documented',
    method: 'GET',
    endpoint: '/fixture/endpoint',
    requestBody: null,
    integrated: false,
    access: 'public',
    cost: costFixture(),
    sourceRefs: ['src-public'],
    sourceLocator: 'fixture:doc',
    notes: [],
    ...over
  };
}

function capabilityFixture(
  dimension: CapabilityRecord['dimension'],
  over: Partial<CapabilityRecord> = {}
): Record<string, unknown> {
  return {
    dimension,
    documentation: 'documented',
    docUrls: ['https://public.example.test/docs'],
    endpoints: ['GET /fixture/endpoint'],
    sourceLocator: 'fixture:doc',
    integration: 'not_integrated',
    access: 'public',
    verification: 'documented_only',
    verificationRef: null,
    cost: costFixture(),
    sourceRefs: ['src-public'],
    operations: [operationFixture()],
    notes: [],
    ...(dimension === 'comments'
      ? { comments: { authorReplies: 'unknown', parentChain: 'unknown' } }
      : {}),
    ...(dimension === 'pagination'
      ? { pagination: { cursor: 'unknown', sortOptions: null, dateRange: 'unknown' } }
      : {}),
    ...over
  };
}

function routeFixture(over: Partial<DiscoveryRoute> = {}): Record<string, unknown> {
  return {
    routeId: 'r-fixture',
    kind: 'username_probe',
    operation: 'probe:username',
    adapterId: null,
    endpoint: null,
    requires: ['public_network'],
    availability: 'not_integrated',
    reason: '合成夹具路线，未接入。',
    sourceRefs: ['src-public'],
    ...over
  };
}

function entryFixture(platformId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platformId,
    name: `Synthetic ${platformId}`,
    cohort: 'alternative',
    aliases: [],
    homepage: 'https://public.example.test',
    profileUrlRule: 'https://public.example.test/{username}',
    instance: 'none',
    inputKinds: ['username'],
    accountKinds: ['person'],
    applicability: { authorizations: [], conditions: [] },
    capabilities: CAPABILITY_DIMENSIONS.map((dimension) => capabilityFixture(dimension)),
    routes: [routeFixture()],
    legacy: null,
    notes: [],
    ...over
  };
}

function syntheticRaw(mutate?: (raw: Record<string, unknown>) => void): Record<string, unknown> {
  const content = {
    schemaVersion: 'stripsearch/platform-catalog/v1',
    registryVersion: 'synthetic-1',
    generatedAt: '2026-09-30',
    sources: [
      {
        sourceId: 'src-public',
        kind: 'official_documentation',
        title: 'Synthetic public source',
        url: 'https://public.example.test/docs',
        license: null,
        licenseHash: null,
        upstreamVersion: null,
        upstreamState: 'checked_unfrozen',
        capturedAt: '2026-09-30',
        contentHash: null,
        bytes: null,
        importerVersion: null,
        counts: { raw: null, loaded: null, excluded: null },
        notes: []
      }
    ],
    entries: [entryFixture('synthetic-one'), entryFixture('synthetic-two')]
  };
  const raw: Record<string, unknown> = {
    ...content,
    contentHash: catalogContentHash(content as never)
  };
  mutate?.(raw);
  return raw;
}

function rehash(raw: Record<string, unknown>): void {
  raw.contentHash = catalogContentHash({
    schemaVersion: raw.schemaVersion,
    registryVersion: raw.registryVersion,
    generatedAt: raw.generatedAt,
    sources: raw.sources,
    entries: raw.entries
  } as never);
}

function writeCatalogDir(raw: Record<string, unknown>, manifestMutate?: (m: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'catalog-data-'));
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const manifest: Record<string, unknown> = {
    schemaVersion: 'stripsearch/platform-catalog-manifest/v1',
    registryVersion: raw.registryVersion,
    files: [{ path: 'catalog.json', sha256: fileHash }],
    counts: { platforms: (raw.entries as unknown[]).length }
  };
  manifestMutate?.(manifest);
  writeFileSync(path.join(dir, 'catalog.json'), bytes);
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function expectLoadError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CatalogLoadError, `expected CatalogLoadError, got ${String(error)}`);
    assert.equal(error.code, code, `${error.code}: ${error.detail}`);
    return;
  }
  assert.fail(`expected load to fail with ${code}`);
}

/* ------------------------------------------------------------------ */
/* Catalog data: independent cohort listing and per-entry shapes       */
/* ------------------------------------------------------------------ */

test('spec cohorts register 20 TikHub platforms, 30 alternatives, the personal website and the retained legacy platforms', () => {
  const snapshot = loadSourceCatalog();
  const byId = new Map(snapshot.entries.map((entry) => [entry.platformId, entry]));

  for (const platformId of SPEC_TIKHUB_IDS) {
    assert.equal(byId.get(platformId)?.cohort, 'tikhub', `missing TikHub platform ${platformId}`);
  }
  for (const platformId of SPEC_ALTERNATIVE_IDS) {
    assert.equal(byId.get(platformId)?.cohort, 'alternative', `missing alternative platform ${platformId}`);
  }
  assert.equal(byId.get(SPEC_PERSONAL_WEBSITE_ID)?.cohort, 'personal_website');

  const summary = catalogSummary(snapshot);
  assert.equal(summary.cohorts.tikhub, 20);
  assert.equal(summary.cohorts.alternative, 30);
  assert.equal(summary.cohorts.personal_website, 1);
  // The legacy probe registry keeps devto / npm / pypi rules; they are
  // registered separately instead of silently dropped from the projection.
  assert.equal(summary.cohorts.legacy_only, 3);
  assert.equal(summary.platformCount, 54);
});

test('every catalog entry carries exactly the seven capability dimensions', () => {
  const snapshot = loadSourceCatalog();
  for (const entry of snapshot.entries) {
    const dimensions = entry.capabilities.map((record) => record.dimension);
    assert.deepEqual(
      [...dimensions].sort(),
      [...CAPABILITY_DIMENSIONS].sort(),
      `${entry.platformId} capability dimensions`
    );
    assert.equal(new Set(dimensions).size, dimensions.length, `${entry.platformId} duplicate dimension`);
    const comments = capabilityOf(entry, 'comments');
    assert.ok(comments.comments, `${entry.platformId} comments record must note author replies / parent chain`);
    const pagination = capabilityOf(entry, 'pagination');
    assert.ok(pagination.pagination, `${entry.platformId} pagination record must note cursor / sort / date range`);
  }
});

test('unknown prices are explicit null with a public basis and never claim free', () => {
  const snapshot = loadSourceCatalog();
  let unknownPrices = 0;
  for (const entry of snapshot.entries) {
    for (const record of entry.capabilities) {
      const { amount, basis, source } = record.cost;
      if (amount === null) {
        unknownPrices += 1;
        assert.ok(basis.trim().length > 0, `${entry.platformId}/${record.dimension}: null price needs an explicit public basis`);
        assert.ok(
          !['free', '免费', '0', '0.0', '0.00'].includes(basis.trim().toLowerCase()),
          'unknown price must not be recorded as free'
        );
        assert.match(basis, /未知|未核对|未建立|无从|null/i, 'basis must state explicitly that the price is unknown');
      } else {
        assert.equal(typeof amount, 'number');
        assert.ok(amount > 0, 'a recorded price is a real positive number');
        assert.ok(basis.trim().length > 0 && source !== null, 'recorded prices cite a public source');
      }
    }
  }
  const summary = catalogSummary(snapshot);
  assert.equal(summary.unknownPriceCount, summary.capabilityRecordCount, 'Task 1 ships no measured prices: all unknown');
  assert.equal(summary.unknownPriceCount, unknownPrices);
});

test('catalog documents the frozen Telegram / Threads / publication-account boundaries', () => {
  const snapshot = loadSourceCatalog();
  const threadsNotes = entryById(snapshot, 'threads').notes.join(' ');
  assert.match(threadsNotes, /游标/, 'Threads invalid-cursor limitation must survive');
  const telegram = entryById(snapshot, 'telegram');
  assert.ok((telegram.notes.join(' ') + telegram.capabilities.map((c) => c.notes.join(' ')).join(' ')).includes('频道'),
    'Telegram channel vs person must stay explicit');
  assert.ok((telegram.accountKinds ?? []).includes('channel') && (telegram.accountKinds ?? []).includes('person'));
  assert.match(entryById(snapshot, 'wechat-mp').notes.join(' '), /出版账号|自然人/, 'publication vs person boundary must survive');
  const threadsPagination = capabilityOf(entryById(snapshot, 'threads'), 'pagination');
  assert.equal(threadsPagination.pagination?.cursor, 'invalid', 'Threads cursor limitation is recorded, not smoothed');
  assert.match(threadsPagination.notes.join(' ') + (threadsPagination.sourceLocator ?? ''), /fetch_user_posts|无分页/, 'the limit cites its documented endpoint');
});

/* ------------------------------------------------------------------ */
/* Frozen public-source metadata (independently asserted)               */
/* ------------------------------------------------------------------ */

test('public source manifests keep independently frozen versions, hashes and retrieval state', () => {
  const snapshot = loadSourceCatalog();
  const byId = new Map(snapshot.sources.map((source) => [source.sourceId, source]));

  for (const [sourceId, expected] of Object.entries(EXPECTED_SOURCES)) {
    const source = byId.get(sourceId);
    assert.ok(source, `missing source ${sourceId}`);
    assert.equal(source.upstreamVersion, expected.upstreamVersion, sourceId);
    assert.equal(source.contentHash, expected.contentHash, sourceId);
    assert.equal(source.capturedAt, expected.capturedAt, sourceId);
  }

  const maigret = byId.get('maigret')!;
  const wmn = byId.get('whatsmyname')!;
  for (const [source, expected] of [[maigret, EXPECTED_SOURCES.maigret], [wmn, EXPECTED_SOURCES.whatsmyname]] as const) {
    assert.equal(source.kind, 'public_rule_dataset');
    assert.equal(source.license, expected.license);
    assert.equal(source.licenseHash, expected.licenseHash);
    assert.equal(source.upstreamState, 'metadata_only_not_imported');
    assert.equal(source.importerVersion, null);
    // Import counts stay null: the Task 2 compiler has not run. Source dataset
    // record counts are NOT import counts and must not land in `counts`.
    assert.deepEqual(source.counts, { raw: null, loaded: null, excluded: null });
    const notes = source.notes.join(' ');
    assert.match(notes, new RegExp(String(expected.sourceRecords)), 'source record count is recorded as source metadata');
    assert.match(notes, /不是导入数/, 'source record count must be labeled as not an import count');
    assert.match(notes, /未导入|没有导入/, 'not imported');
    assert.doesNotMatch(notes, /已启用|已导入|enabled/i, 'no enabled/imported claim');
    assert.ok(!source.url?.includes('/Users/'), 'no local paths in public metadata');
  }

  const pricing = byId.get('tikhub-endpoint-pricing')!;
  assert.match(pricing.notes.join(' '), /request_id/, 'the varying payload wrapper is documented as not a cost receipt');
  for (const source of snapshot.sources) {
    if (source.counts.raw !== null) {
      assert.equal(source.counts.raw, (source.counts.loaded ?? 0) + (source.counts.excluded ?? 0), 'raw = loaded + excluded');
    }
  }
});

test('loader rejects documented capability claims without per-axis evidence', () => {
  // A generic provider/developer doc link cannot establish a dimension.
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      const caps = entries[0]!.capabilities as Record<string, unknown>[];
      for (const cap of caps) {
        cap.documentation = 'documented';
        cap.docUrls = ['https://public.example.test/docs'];
        cap.endpoints = [];
        cap.sourceLocator = null;
      }
    })),
    'invalid_shape'
  );
  // A precise source locator is enough evidence for a documented claim.
  const ok = catalogSnapshotFromJson(syntheticRaw((raw) => {
    const entries = raw.entries as Record<string, unknown>[];
    const caps = entries[0]!.capabilities as Record<string, unknown>[];
    for (const cap of caps) {
      cap.documentation = 'documented';
      cap.endpoints = [];
      cap.sourceLocator = 'doc:precise-locator';
    }
    rehash(raw);
  }));
  assert.equal(ok.entries[0]?.capabilities[0]?.sourceLocator, 'doc:precise-locator');
});

test('generic doc links never make all seven dimensions documented', () => {
  const snapshot = loadSourceCatalog();
  // Platforms with only a generic developer-doc entry point stay unknown.
  for (const platformId of ['spotify', 'line', 'quora', 'snapchat']) {
    const entry = entryById(snapshot, platformId);
    for (const record of entry.capabilities) {
      assert.notEqual(record.documentation, 'documented', `${platformId}/${record.dimension} has no per-axis evidence`);
    }
  }
  // Every documented claim in the shipped data carries per-axis evidence.
  for (const entry of snapshot.entries) {
    for (const record of entry.capabilities) {
      if (record.documentation === 'documented') {
        assert.ok(
          record.endpoints.length > 0 || (record.sourceLocator ?? '').length > 0,
          `${entry.platformId}/${record.dimension}: documented without endpoints or precise locator`
        );
      }
    }
  }
  // GitHub documents discovery/profile/list/pagination only — not body/media/comments.
  const github = entryById(snapshot, 'github');
  for (const dimension of ['body', 'media', 'comments'] as const) {
    assert.notEqual(capabilityOf(github, dimension).documentation, 'documented', `github ${dimension}`);
  }
});

test('canonical profile patterns stay null unless explicitly documented', () => {
  const snapshot = loadSourceCatalog();
  for (const platformId of ['spotify', 'youtube', 'telegram', 'zhihu', 'douban', 'bilibili', 'quora', 'devto', 'x']) {
    assert.equal(entryById(snapshot, platformId).profileUrlRule, null, `${platformId} pattern is not documented; it must stay null`);
  }
  for (const platformId of ['gitlab', 'medium', 'hackernews', 'reddit', 'github', 'npm', 'pypi', 'mastodon', 'bluesky']) {
    assert.ok(entryById(snapshot, platformId).profileUrlRule, `${platformId} has a documented pattern`);
  }
  // An explicitly null pattern is never synthesized by the loader.
  const snapshotFromJson = catalogSnapshotFromJson(syntheticRaw((raw) => {
    const entries = raw.entries as Record<string, unknown>[];
    entries[1]!.profileUrlRule = null;
    rehash(raw);
  }));
  assert.equal(snapshotFromJson.entries[1]?.profileUrlRule, null);
});

test('legacy existence probes do not imply profile reading', () => {
  const snapshot = loadSourceCatalog();
  for (const platformId of ['hackernews', 'npm', 'pypi', 'devto', 'gitlab', 'huggingface', 'bluesky', 'medium']) {
    const entry = entryById(snapshot, platformId);
    assert.equal(capabilityOf(entry, 'discovery').integration, 'integrated', `${platformId} has an existence probe`);
    assert.notEqual(capabilityOf(entry, 'profile').integration, 'integrated', `${platformId}: existence probe is not a profile reader`);
  }
  // Concrete profile paths that DO exist stay new-path unverified.
  const githubProfile = capabilityOf(entryById(snapshot, 'github'), 'profile');
  assert.equal(githubProfile.integration, 'integrated');
  assert.equal(githubProfile.verification, 'documented_only');
  const xProfile = capabilityOf(entryById(snapshot, 'x'), 'profile');
  assert.equal(xProfile.integration, 'integrated', 'TikHub X profile tool is a concrete path');
  assert.equal(xProfile.verification, 'documented_only', 'the new execution path stays unverified');
  // The GitHub research adapter reads first-page owned repos with caps.
  const githubList = capabilityOf(entryById(snapshot, 'github'), 'list');
  assert.equal(githubList.integration, 'integrated');
  assert.match(githubList.notes.join(' '), /首页|上限|cap/i, 'its cap/pagination limits are recorded');
});

test('mixed-source platforms keep access and price per operation, never inherited', () => {
  const snapshot = loadSourceCatalog();
  const reddit = entryById(snapshot, 'reddit');
  // Anonymous legacy probe route is public…
  assert.equal(capabilityOf(reddit, 'discovery').access, 'public');
  // …while the same platform's TikHub-backed dims need the provider key.
  assert.equal(capabilityOf(reddit, 'body').access, 'credentials_required');
  assert.equal(capabilityOf(reddit, 'body').cost.provider, 'tikhub');

  // TikHub pricing is only attached to dims with actual TikHub endpoints.
  for (const entry of snapshot.entries) {
    for (const record of entry.capabilities) {
      if (record.cost.provider === 'tikhub') {
        assert.ok(record.endpoints.some((endpoint) => endpoint.includes('/api/v1/')), `${entry.platformId}/${record.dimension}: tikhub price without tikhub endpoint`);
        assert.ok(record.sourceRefs.includes('tikhub-openapi'));
      }
    }
  }
  // A legacy-only platform has public discovery but unknown price basis.
  const npm = entryById(snapshot, 'npm');
  const npmDiscovery = capabilityOf(npm, 'discovery');
  assert.equal(npmDiscovery.access, 'public');
  assert.equal(npmDiscovery.cost.provider, null);
  assert.equal(npmDiscovery.cost.amount, null);
  assert.ok(npmDiscovery.cost.basis.trim().length > 0);
  // Dims without an established operation are unknown, not public.
  assert.equal(capabilityOf(npm, 'body').access, 'unknown');
  // X is key-gated everywhere its concrete TikHub path runs.
  const x = entryById(snapshot, 'x');
  assert.equal(capabilityOf(x, 'profile').access, 'credentials_required');
  assert.equal(capabilityOf(x, 'list').access, 'credentials_required');
});

test('mixed dimensions expose per-operation access/cost/integration evidence', () => {
  const snapshot = loadSourceCatalog();
  const reddit = entryById(snapshot, 'reddit');

  // Reddit pagination actually runs only on the TikHub cursor endpoint: the
  // anonymous legacy listing has no paging at all.
  const pagination = capabilityOf(reddit, 'pagination');
  assert.equal(pagination.access, 'credentials_required');
  assert.equal(pagination.cost.provider, 'tikhub');
  assert.ok(pagination.operations.length > 0);
  for (const op of pagination.operations) {
    assert.equal(op.access, 'credentials_required', op.operationId);
    assert.equal(op.cost.provider, 'tikhub', op.operationId);
    assert.ok(op.endpoint.includes('/api/v1/reddit/'), op.operationId);
  }
  assert.equal(pagination.operations.some((op) => op.endpoint.includes('submitted.json')), false,
    'the paging-less legacy listing is not a pagination operation');

  // Reddit list combines both routes and must express them separately.
  const list = capabilityOf(reddit, 'list');
  const legacyList = list.operations.find((op) => op.endpoint.includes('submitted.json'));
  const tikhubList = list.operations.find((op) => op.endpoint.includes('/api/v1/reddit/'));
  assert.ok(legacyList && tikhubList);
  assert.equal(legacyList.integrated, true);
  assert.equal(legacyList.access, 'public');
  assert.equal(legacyList.cost.provider, null);
  assert.equal(tikhubList.integrated, false);
  assert.equal(tikhubList.access, 'credentials_required');
  assert.equal(tikhubList.cost.provider, 'tikhub');
  // Aggregate follows the operation that actually runs today.
  assert.equal(list.integration, 'integrated');
  assert.equal(list.access, legacyList.access);

  // Global coherence: aggregates always derive from real operations.
  for (const entry of snapshot.entries) {
    for (const record of entry.capabilities) {
      const integrated = record.operations.filter((op) => op.integrated);
      if (record.integration === 'integrated') {
        assert.ok(integrated.length > 0, `${entry.platformId}/${record.dimension}: integrated without an integrated operation`);
        assert.ok(integrated.some((op) => op.access === record.access), `${entry.platformId}/${record.dimension}: access not from an integrated operation`);
        assert.ok(integrated.some((op) => op.cost.provider === record.cost.provider), `${entry.platformId}/${record.dimension}: price not from an integrated operation`);
      } else {
        assert.equal(integrated.length, 0, `${entry.platformId}/${record.dimension}: hidden integrated operation`);
      }
    }
  }
});

test('loader rejects aggregates that contradict their operations', () => {
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      const cap = (entries[0]!.capabilities as Record<string, unknown>[])[0]!;
      cap.integration = 'integrated'; // no integrated operation exists
      rehash(raw);
    })),
    'invalid_shape'
  );
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      const cap = (entries[0]!.capabilities as Record<string, unknown>[])[0]!;
      (cap.operations as Record<string, unknown>[]).push(operationFixture({ integrated: true, operationId: 'hidden-op' }));
      rehash(raw);
    })),
    'invalid_shape'
  );
});

test('selected TikHub operations match the frozen OpenAPI facts', () => {
  const snapshot = loadSourceCatalog();
  // Facts transcribed independently from the pinned V5.3.2 OpenAPI document
  // (method + requestBody schema ref), not from the generator tables.
  const FIXED_FACTS = [
    { path: '/api/v1/douyin/douplus/search_user_v2', method: 'POST', requestBody: 'UserSearchV2Request' },
    { path: '/api/v1/wechat_mp/v2/fetch_account_articles', method: 'POST', requestBody: 'FetchAccountArticlesRequest' },
    { path: '/api/v1/wechat_mp/v2/fetch_article_detail', method: 'POST', requestBody: 'FetchArticleDetailRequest' },
    { path: '/api/v1/wechat_channels/v2/fetch_user_profile', method: 'POST', requestBody: 'FetchUserProfileRequest' },
    { path: '/api/v1/wechat_channels/v2/fetch_video_detail', method: 'POST', requestBody: 'FetchVideoDetailRequest' },
    { path: '/api/v1/instagram/v1/fetch_post_comments_v2', method: 'GET', requestBody: null },
    { path: '/api/v1/threads/web/fetch_user_posts', method: 'GET', requestBody: null },
    { path: '/api/v1/reddit/app/fetch_user_comments', method: 'GET', requestBody: null }
  ] as const;
  const allOps = snapshot.entries.flatMap((entry) => entry.capabilities.flatMap((record) => record.operations));
  for (const fact of FIXED_FACTS) {
    const ops = allOps.filter((op) => op.endpoint === fact.path);
    assert.ok(ops.length > 0, `catalog must register ${fact.path}`);
    for (const op of ops) {
      assert.equal(op.method, fact.method, fact.path);
      assert.equal(op.requestBody, fact.requestBody, fact.path);
    }
  }
  // The absent Instagram path is never cited.
  assert.equal(allOps.some((op) => op.endpoint.includes('/api/v1/instagram/v2/fetch_post_comments_v2')), false);
  // Wechat-mp articles paginate via the base64 offset cursor; page_size is ignored.
  const wechatMp = entryById(snapshot, 'wechat-mp');
  const wechatPagination = capabilityOf(wechatMp, 'pagination');
  assert.equal(wechatPagination.pagination?.cursor, 'supported');
  const wechatNotes = wechatPagination.notes.join(' ');
  assert.match(wechatNotes, /offset|next_offset/);
  assert.match(wechatNotes, /page_size.*忽略|忽略.*page_size/);
});

test('reddit bounds stay per-route: sort enum, no date-range import, key-gated paging', () => {
  const snapshot = loadSourceCatalog();
  const reddit = capabilityOf(entryById(snapshot, 'reddit'), 'pagination');
  // The TikHub reddit endpoints expose sort NEW/TOP/HOT/CONTROVERSIAL and no
  // date-range parameter; official after/before semantics are a different
  // route and are never imported here (see docs/platforms/reddit-routes.md).
  assert.deepEqual(reddit.pagination?.sortOptions, ['NEW', 'TOP', 'HOT', 'CONTROVERSIAL']);
  assert.equal(reddit.pagination?.dateRange, 'unsupported');
  assert.equal(reddit.pagination?.cursor, 'supported');
  assert.match(reddit.notes.join(' '), /reddit-routes|跨路线|不照搬/);
  const pagingOp = reddit.operations.find((op) => op.endpoint.includes('/api/v1/reddit/app/fetch_user_comments'));
  assert.ok(pagingOp);
  assert.equal(pagingOp.access, 'credentials_required');
  assert.equal(pagingOp.cost.provider, 'tikhub');
});

test('X routes describe only the implemented known-handle handler, never people search', () => {
  const snapshot = loadSourceCatalog();
  const x = entryById(snapshot, 'x');
  const integrated = x.routes.filter((route) => route.availability === 'integrated');
  for (const route of integrated) {
    assert.notEqual(route.kind, 'platform_search', 'profile reads cannot back people search');
  }
  const handleRoute = x.routes.find((route) => route.adapterId === 'tikhub-x' && route.availability === 'integrated');
  assert.ok(handleRoute);
  // Matches the real toolkit handler (social_profile), nothing broader.
  assert.equal(handleRoute.kind, 'username_probe');
  assert.equal(handleRoute.operation, 'tikhub-x:fetch_user_profile');
  assert.equal(handleRoute.endpoint, 'https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name={screen_name}');
  assert.ok(handleRoute.reason.includes('handle'));
  const searchRoute = x.routes.find((route) => route.kind === 'platform_search');
  assert.ok(searchRoute);
  assert.equal(searchRoute.availability, 'not_integrated');
  assert.equal(searchRoute.adapterId, null);
  assert.equal(searchRoute.endpoint, null);
  assert.match(searchRoute.reason, /未接入|搜索/);
});

test('read_thread never borrows comments evidence: own integration, access and receipt required', () => {
  const threadCase = (thread: Record<string, unknown>, commentsOver: Record<string, unknown> = {}) => {
    const snapshot = catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      const caps = entries[0]!.capabilities as Record<string, unknown>[];
      const comments = caps.find((cap) => cap.dimension === 'comments')!;
      comments.comments = { authorReplies: 'supported', parentChain: 'supported' };
      comments.thread = thread;
      Object.assign(comments, commentsOver);
      if (commentsOver.integration === 'integrated') {
        (comments.operations as Record<string, unknown>[]).push(operationFixture({ operationId: 'live-comments', integrated: true, access: 'public' }));
      }
      rehash(raw);
    }));
    return toCapabilitySnapshot(snapshot, { grants: {} }).operations.find((op) => op.operation === 'read_thread')!;
  };
  const ownReceipt = {
    operation: 'read_thread',
    adapterId: 'thread-adapter',
    endpoint: 'https://public.example.test/thread',
    verifiedAt: '2026-09-30',
    receipt: 'receipt-thread-3',
    verifiedMaxDepth: 3
  };

  // (a) integrated + live COMMENTS receipt + arbitrary provenance text, but
  // NO own thread receipt: text alone is never an acceptance receipt.
  const borrowed = threadCase(
    { integration: 'integrated', access: 'public', verification: 'documented_only', verificationRef: null, maxDepth: null, notes: ['自述读到深度 3（纯文本，无回执）'] },
    { integration: 'integrated', verification: 'live_verified', verificationRef: { adapterId: 'a', endpoint: 'e', verifiedAt: '2026-09-30', receipt: 'r' } }
  );
  assert.equal(borrowed.state, 'unverified');
  assert.equal(borrowed.maxDepth, null);

  // (b) own thread without an adapter: GET-59 unsupported, not unverified.
  assert.equal(threadCase({ integration: 'not_integrated', access: 'unknown', verification: 'documented_only', verificationRef: null, maxDepth: null, notes: [] }).state, 'unsupported');

  // (c) own live receipt but missing credentials cannot run.
  const gated = threadCase({ integration: 'integrated', access: 'credentials_required', verification: 'live_verified', verificationRef: ownReceipt, maxDepth: 3, notes: [] });
  assert.equal(gated.state, 'unsupported');
  assert.equal(gated.maxDepth, null);

  // (d) offline-only proof stays unverified with no depth.
  const offline = threadCase({ integration: 'integrated', access: 'public', verification: 'offline_verified', verificationRef: null, maxDepth: null, notes: [] });
  assert.equal(offline.state, 'unverified');
  assert.equal(offline.maxDepth, null);

  // (e) a valid OWN verified thread with a provenance-bound depth confirms it.
  const confirmed = threadCase({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: ownReceipt, maxDepth: 3, notes: [] });
  assert.equal(confirmed.state, 'supported');
  assert.equal(confirmed.maxDepth, 3, 'depth comes from the thread receipt bound, never a design default');

  // Shipped catalog: no thread adapters, no receipts -> unsupported everywhere.
  const snapshot = loadSourceCatalog();
  for (const entry of snapshot.entries) {
    const readThread = toCapabilitySnapshot({ ...snapshot, entries: [entry] }, { grants: {} })
      .operations.find((op) => op.operation === 'read_thread');
    assert.equal(readThread?.state, 'unsupported', entry.platformId);
    assert.equal(readThread?.maxDepth, null, entry.platformId);
  }
});

test('thread loader rejects live claims without their own receipt or a matching bound', () => {
  const withThread = (thread: Record<string, unknown>) => catalogSnapshotFromJson(syntheticRaw((raw) => {
    const entries = raw.entries as Record<string, unknown>[];
    const comments = (entries[0]!.capabilities as Record<string, unknown>[]).find((cap) => cap.dimension === 'comments')!;
    comments.thread = thread;
    rehash(raw);
  }));
  const receipt = {
    operation: 'read_thread',
    adapterId: 'thread-adapter',
    endpoint: 'https://public.example.test/thread',
    verifiedAt: '2026-09-30',
    receipt: 'receipt-thread-3',
    verifiedMaxDepth: 3
  };
  // live_verified without its own structured receipt.
  expectLoadError(
    () => withThread({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: null, maxDepth: null, notes: ['文本自称已验证'] }),
    'invalid_shape'
  );
  // depth bound without live verification.
  expectLoadError(
    () => withThread({ integration: 'integrated', access: 'public', verification: 'documented_only', verificationRef: null, maxDepth: 3, notes: [] }),
    'invalid_shape'
  );
  // bound must not mismatch the verified bound.
  expectLoadError(
    () => withThread({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: receipt, maxDepth: 5, notes: [] }),
    'invalid_shape'
  );
  // invalid verified bound.
  expectLoadError(
    () => withThread({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: { ...receipt, verifiedMaxDepth: 0 }, maxDepth: 0, notes: [] }),
    'invalid_shape'
  );
  // the receipt must bind the read_thread operation, not any other receipt.
  expectLoadError(
    () => withThread({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: { ...receipt, operation: 'list_comments' }, maxDepth: 3, notes: [] }),
    'invalid_shape'
  );
  // valid own receipt + matching bound loads.
  assert.equal(withThread({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: receipt, maxDepth: 3, notes: [] }).entries[0]?.capabilities.find((cap) => cap.dimension === 'comments')?.thread?.maxDepth, 3);
});

test('loader rejects duplicate platform ids and conflicting aliases', () => {
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      (raw.entries as Record<string, unknown>[]).push(entryFixture('synthetic-one'));
    })),
    'duplicate_platform_id'
  );
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      entries[0]!.aliases = ['same-alias'];
      entries[1]!.aliases = ['same-alias'];
    })),
    'duplicate_alias'
  );
  // An alias colliding with another entry's platform id is also a conflict.
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      entries[0]!.aliases = ['synthetic-two'];
    })),
    'duplicate_alias'
  );
});

test('loader validates content hashes, file hashes and source references', () => {
  const good = syntheticRaw();
  assert.equal(typeof catalogSnapshotFromJson(good).contentHash, 'string');

  // Content mutated after hashing must not load.
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      (raw.entries as Record<string, unknown>[])[0]!.name = 'tampered';
    })),
    'content_hash_mismatch'
  );

  // Byte-level tampering is caught by the manifest file hash.
  const dir = writeCatalogDir(good);
  try {
    const bytes = readFileSync(path.join(dir, 'catalog.json'), 'utf8');
    writeFileSync(path.join(dir, 'catalog.json'), bytes.replace('synthetic-one', 'synthetic-1x'));
    expectLoadError(() => loadPlatformCatalog(dir), 'file_hash_mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Unknown source refs fail closed.
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      const first = entries[0]!.capabilities as Record<string, unknown>[];
      first[0]!.sourceRefs = ['no-such-source'];
    })),
    'source_ref'
  );
});

test('legacy probe loader rejects non-GET methods instead of normalizing them', () => {
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      entries[0]!.legacy = {
        category: 'social',
        subjectKinds: ['username'],
        homepage: 'https://public.example.test',
        probe: {
          kind: 'http_status',
          method: 'POST',
          urlTemplate: 'https://public.example.test/users/{username}',
          foundStatuses: [200],
          notFoundStatuses: [404],
          blockedStatuses: [403, 429],
          foundMarker: null,
          notFoundMarker: null,
          transport: 'api_http'
        },
        posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { id: null, url: null, title: null, publishedAt: null, excerpt: null } },
        rateLimitPerMinute: 10,
        verification: 'live_unverified',
        verificationNote: '合成夹具',
        notes: []
      };
      rehash(raw);
    })),
    'invalid_shape'
  );
  // The 13 real legacy rules still load unchanged (covered by the projection
  // test above); a valid GET probe remains accepted.
  const ok = catalogSnapshotFromJson(syntheticRaw((raw) => {
    const entries = raw.entries as Record<string, unknown>[];
    entries[0]!.legacy = {
      category: 'social',
      subjectKinds: ['username'],
      homepage: 'https://public.example.test',
      probe: {
        kind: 'http_status',
        method: 'GET',
        urlTemplate: 'https://public.example.test/users/{username}',
        foundStatuses: [200],
        notFoundStatuses: [404],
        blockedStatuses: [403, 429],
        foundMarker: null,
        notFoundMarker: null,
        transport: 'api_http'
      },
      posts: { kind: 'none', urlTemplate: '', maxPages: 0, itemsPath: '', fields: { id: null, url: null, title: null, publishedAt: null, excerpt: null } },
      rateLimitPerMinute: 10,
      verification: 'live_unverified',
      verificationNote: '合成夹具',
      notes: []
    };
    rehash(raw);
  }));
  assert.equal(ok.entries[0]?.legacy?.probe?.method, 'GET');
});

test('loader validates shapes: seven dimensions, enum values, live_verified receipts and routes', () => {
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      entries[0]!.capabilities = (entries[0]!.capabilities as unknown[]).slice(0, 6);
    })),
    'invalid_shape'
  );
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      (entries[0]!.capabilities as Record<string, unknown>[])[0]!.integration = 'sometimes';
    })),
    'invalid_shape'
  );
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      (entries[0]!.capabilities as Record<string, unknown>[])[0]!.cost = costFixture({ amount: 'free' });
    })),
    'invalid_shape'
  );
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      (entries[0]!.capabilities as Record<string, unknown>[])[0]!.verification = 'live_verified';
    })),
    'invalid_shape'
  );
  expectLoadError(
    () => catalogSnapshotFromJson(syntheticRaw((raw) => {
      const entries = raw.entries as Record<string, unknown>[];
      entries[0]!.routes = [];
    })),
    'invalid_shape'
  );
});

test('frozen snapshots are isolated from and immune to input mutation', () => {
  const raw = syntheticRaw();
  const snapshot = catalogSnapshotFromJson(raw);

  // Mutating the parsed input afterwards cannot reach the snapshot.
  (raw.entries as Record<string, unknown>[])[0]!.name = 'mutated-later';
  const firstAgain = snapshot.entries[0];
  assert.ok(firstAgain);
  assert.equal(firstAgain.name, 'Synthetic synthetic-one');

  // The snapshot itself is deep frozen.
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(firstAgain), true);
  assert.equal(Object.isFrozen(firstAgain.capabilities[0]), true);
  assert.throws(() => {
    (firstAgain as { name: string }).name = 'frozen';
  });
  assert.equal(firstAgain.name, 'Synthetic synthetic-one');

  // A second load is an independent snapshot with its own version/hash.
  const other = catalogSnapshotFromJson(syntheticRaw((r) => {
    r.registryVersion = 'synthetic-2';
    const content = {
      schemaVersion: r.schemaVersion,
      registryVersion: r.registryVersion,
      generatedAt: r.generatedAt,
      sources: r.sources,
      entries: r.entries
    };
    r.contentHash = catalogContentHash(content as never);
  }));
  assert.equal(other.registryVersion, 'synthetic-2');
  assert.notEqual(other.contentHash, snapshot.contentHash);
  assert.equal(snapshot.registryVersion, 'synthetic-1');
});

/* ------------------------------------------------------------------ */
/* Projections                                                         */
/* ------------------------------------------------------------------ */

test('legacy projection keeps every old rule, probe, posts and verification semantic', () => {
  const snapshot = loadSourceCatalog();
  const legacy = toLegacyRegistry(snapshot);
  const expected = new Map(BUILTIN_PLATFORM_REGISTRY.rules.map((rule) => [rule.platformId, rule]));
  assert.equal(legacy.rules.length, BUILTIN_PLATFORM_REGISTRY.rules.length);
  for (const rule of legacy.rules) {
    assert.deepEqual(rule, expected.get(rule.platformId), `legacy rule ${rule.platformId} changed`);
  }
  // Labels stay where they were: GitHub's old rule keeps its live_verified
  // note while the three import-only platforms keep probe: null.
  assert.equal(legacy.rules.find((rule) => rule.platformId === 'github')?.verification, 'live_verified');
  for (const platformId of ['x', 'instagram', 'bilibili']) {
    assert.equal(legacy.rules.find((rule) => rule.platformId === platformId)?.probe, null);
  }
  assert.equal(catalogSummary(snapshot).legacyRuleCount, 13);
  assert.deepEqual(
    { ...registrySummary(legacy), version: null, generatedAt: null },
    { ...registrySummary(BUILTIN_PLATFORM_REGISTRY), version: null, generatedAt: null },
    'legacy rule counts unchanged'
  );
  // All projections carry the same catalog version.
  assert.equal(legacy.version, snapshot.registryVersion);
});

test('catalog capabilities never inherit live_verified from documented rules or the old GitHub adapter', () => {
  const snapshot = loadSourceCatalog();
  for (const entry of snapshot.entries) {
    for (const record of entry.capabilities) {
      assert.notEqual(record.verification, 'live_verified', `${entry.platformId}/${record.dimension} has no live receipt`);
      if (record.verification === 'documented_only') {
        assert.equal(record.verificationRef, null);
      }
    }
  }
  assert.equal(catalogSummary(snapshot).liveVerifiedCapabilityCount, 0);
  // …while the legacy projection still preserves the old GitHub label as-is.
  assert.equal(
    toLegacyRegistry(snapshot).rules.find((rule) => rule.platformId === 'github')?.verification,
    'live_verified'
  );
});

test('completion projection keeps no-adapter platforms and freezes applicability reasons', () => {
  const snapshot = loadSourceCatalog();
  const input: CatalogApplicabilityInput = {
    acceptedKinds: ['username'],
    instanceHints: {},
    authorization: 'public_professional'
  };
  const registry = toCompletionRegistry(snapshot, input);
  assert.equal(registry.registryVersion, snapshot.registryVersion);
  assert.equal(registry.entries.length, snapshot.entries.length, 'every catalog item stays represented');

  const byId = new Map(registry.entries.map((entry) => [entry.platformId, entry]));
  // A platform without any adapter is still an applicable discovery obligation.
  const discord = byId.get('discord');
  assert.ok(discord);
  assert.equal(discord.applicability, 'applicable');
  assert.ok(discord.applicabilityReason.trim().length > 0);

  // Instance-scoped platforms need their instance hint.
  const mastodon = byId.get('mastodon');
  assert.equal(mastodon?.applicability, 'not_applicable');
  assert.match(mastodon?.applicabilityReason ?? '', /实例/);

  // Private-communication platforms stay out of public-professional rounds.
  const whatsapp = byId.get('whatsapp');
  assert.equal(whatsapp?.applicability, 'not_applicable');
  assert.match(whatsapp?.applicabilityReason ?? '', /授权/);

  // Personal website accepts a homepage input, not a bare username.
  assert.equal(byId.get('personal-website')?.applicability, 'not_applicable');

  // The projection is deterministic and the reasons are frozen strings.
  assert.deepEqual(toCompletionRegistry(snapshot, input), registry);
  const hinted = toCompletionRegistry(snapshot, {
    acceptedKinds: ['username'],
    instanceHints: { mastodon: 'mastodon.social' },
    authorization: 'self'
  });
  const hintedMastodon = hinted.entries.find((entry) => entry.platformId === 'mastodon');
  assert.equal(hintedMastodon?.applicability, 'applicable');
  assert.ok(hintedMastodon?.applicabilityReason.trim().length > 0);
});

test('capability projection maps GET-59 supported / unsupported / unverified exactly', () => {
  const grant = (over: { credentials?: boolean; authorization?: boolean } = {}) => ({
    credentials: false,
    authorization: false,
    ...over
  });
  const record = (over: Partial<CapabilityRecord>): CapabilityRecord => {
    const base = capabilityFixture('list', over) as unknown as CapabilityRecord;
    return base;
  };
  const cases: Array<[CatalogCapabilityState, CapabilityRecord, { credentials?: boolean; authorization?: boolean } | null]> = [
    ['unsupported', record({ integration: 'unsupported' }), null],
    ['unsupported', record({ integration: 'not_integrated' }), null],
    ['unsupported', record({ integration: 'integrated', access: 'inaccessible' }), null],
    ['unsupported', record({ integration: 'integrated', access: 'credentials_required', verification: 'live_verified', verificationRef: { adapterId: 'a', endpoint: 'e', verifiedAt: '2026-09-30', receipt: 'r' } }), null],
    ['unsupported', record({ integration: 'integrated', access: 'authorization_required', verification: 'live_verified', verificationRef: { adapterId: 'a', endpoint: 'e', verifiedAt: '2026-09-30', receipt: 'r' } }), grant({ credentials: true })],
    ['unverified', record({ integration: 'integrated', access: 'unknown' }), null],
    ['unverified', record({ integration: 'integrated', access: 'public', verification: 'documented_only' }), grant({ credentials: true, authorization: true })],
    ['unverified', record({ integration: 'integrated', access: 'public', verification: 'offline_verified' }), null],
    ['unverified', record({ integration: 'integrated', access: 'credentials_required', verification: 'documented_only' }), grant({ credentials: true })],
    ['supported', record({ integration: 'integrated', access: 'public', verification: 'live_verified', verificationRef: { adapterId: 'a', endpoint: 'e', verifiedAt: '2026-09-30', receipt: 'r' } }), null],
    ['supported', record({ integration: 'integrated', access: 'credentials_required', verification: 'live_verified', verificationRef: { adapterId: 'a', endpoint: 'e', verifiedAt: '2026-09-30', receipt: 'r' } }), grant({ credentials: true })]
  ];
  for (const [expected, capability, currentGrant] of cases) {
    const verificationBefore = capability.verification;
    const state = capabilityStateFor(capability, currentGrant ? grant(currentGrant) : null);
    assert.equal(state, expected, `${JSON.stringify({ integration: capability.integration, access: capability.access, verification: capability.verification })} vs ${JSON.stringify(currentGrant)}`);
    // Grants never rewrite the verification axis.
    assert.equal(capability.verification, verificationBefore);
    if (expected === 'supported') assert.equal(capability.verification, 'live_verified');
    if (verificationBefore === 'documented_only') assert.notEqual(state, 'supported');
  }

  // The catalog projection emits the GET-59 capability snapshot shape.
  const snapshot = loadSourceCatalog();
  const access: CatalogAccessContext = {
    grants: { github: { credentials: true, authorization: true }, x: { credentials: true, authorization: true } }
  };
  const projected: Get59CapabilitySnapshot = toCapabilitySnapshot(snapshot, access);
  assert.equal(projected.registryVersion, snapshot.registryVersion);
  const githubDiscovery = projected.operations.find(
    (operation) => operation.platform === 'github' && operation.operation === 'discover_accounts'
  );
  assert.ok(githubDiscovery);
  assert.equal(githubDiscovery.state, 'unverified', 'old GitHub adapter verification cannot promote the new path');
  const githubList = projected.operations.find(
    (operation) => operation.platform === 'github' && operation.operation === 'list_posts'
  );
  assert.equal(githubList?.state, 'unverified', 'the research-adapter list path keeps its unverified label');
  // Every catalog entry contributes exactly the seven GET-59 platform ops.
  for (const entry of snapshot.entries.slice(0, 3)) {
    const ops = projected.operations.filter((operation) => operation.platform === entry.platformId);
    assert.deepEqual(
      ops.map((operation) => operation.operation).sort(),
      ['discover_accounts', 'list_comments', 'list_posts', 'read_media', 'read_post', 'read_profile', 'read_thread'].sort()
    );
    for (const operation of ops) {
      assert.ok(
        operation.state === 'supported' || operation.state === 'unsupported' || operation.state === 'unverified'
      );
      if (operation.state !== 'supported') {
        assert.ok(operation.limitation && operation.limitation.length > 0, 'gaps carry a limitation');
      }
    }
  }
});

test('catalogSummary counts platforms, routes and source records separately', () => {
  const snapshot = loadSourceCatalog();
  const summary = catalogSummary(snapshot);
  assert.equal(summary.platformCount, snapshot.entries.length);
  assert.equal(summary.sourceCount, snapshot.sources.length);
  assert.equal(summary.routeCount, snapshot.entries.reduce((total, entry) => total + entry.routes.length, 0));
  assert.ok(summary.routeCount > summary.platformCount, 'routes and platforms are counted separately');
  assert.equal(summary.capabilityRecordCount, snapshot.entries.length * 7);
  assert.equal(summary.legacyRuleCount, BUILTIN_PLATFORM_REGISTRY.rules.length);
});

test('gaps stay honest per platform: no adapter, unverified and unknown price are never hidden', () => {
  const snapshot = loadSourceCatalog();
  const byId = new Map(snapshot.entries.map((entry) => [entry.platformId, entry]));
  const discordGaps = platformGaps(byId.get('discord')!);
  assert.ok(discordGaps.some((gap) => gap.kind === 'no_adapter'));
  assert.ok(discordGaps.some((gap) => gap.kind === 'unknown_price'));
  const githubGaps = platformGaps(byId.get('github')!);
  assert.ok(githubGaps.some((gap) => gap.kind === 'unverified_capability'));
});

/* ------------------------------------------------------------------ */
/* HTTP surface: old fields preserved, catalog gaps added              */
/* ------------------------------------------------------------------ */

test('GET /api/discovery/registry keeps old fields and adds the catalog gap surface', async (t) => {
  const server = await startTestServer({ discoveryCatalog: loadSourceCatalog() });
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('catalog-route@example.test');
  const { status, body } = await server.client.json<{
    registry: typeof BUILTIN_PLATFORM_REGISTRY;
    summary: ReturnType<typeof registrySummary>;
    catalog: {
      registryVersion: string;
      contentHash: string;
      summary: { platformCount: number; routeCount: number; sourceCount: number };
      sources: Array<{
        sourceId: string;
        upstreamVersion: string | null;
        contentHash: string | null;
        license: string | null;
        licenseHash: string | null;
        upstreamState: string;
        counts: { raw: number | null; loaded: number | null; excluded: number | null };
      }>;
      platforms: Array<{
        platformId: string;
        gaps: Array<{ kind: string; detail: string }>;
        routes: Array<{ routeId: string; kind: string; operation: string; adapterId: string | null; endpoint: string | null; requires: string[]; availability: string; reason: string; sourceRefs: string[] }>;
        capabilities: Array<{
          dimension: string;
          docUrls: string[];
          endpoints: string[];
          sourceRefs: string[];
          sourceLocator: string | null;
          verificationRef: unknown;
          cost: { provider: string | null; amount: number | null; basis: string; conditions: string | null };
          comments?: { authorReplies: string; parentChain: string };
          pagination?: { cursor: string; sortOptions: string[] | null; dateRange: string };
          operations: Array<{ operationId: string; method: string | null; endpoint: string; requestBody: string | null; integrated: boolean; access: string; cost: { provider: string | null } }>;
        }>;
      }>;
    };
  }>('/api/discovery/registry');
  assert.equal(status, 200);
  assert.deepEqual(
    { ...registrySummary(body.registry), version: null, generatedAt: null },
    { ...registrySummary(BUILTIN_PLATFORM_REGISTRY), version: null, generatedAt: null },
    'old registry rule counts unchanged'
  );
  assert.deepEqual(body.summary, registrySummary(body.registry), 'old summary field unchanged');
  assert.ok(body.catalog);
  assert.equal(body.catalog.registryVersion, body.registry.version, 'all projections carry the same version');
  assert.match(body.catalog.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(body.catalog.summary.platformCount, 54);
  assert.ok(body.catalog.summary.routeCount > 54);
  assert.equal(body.catalog.summary.sourceCount, 8);

  // Independent reads of the frozen public-source metadata through the API.
  const sourcesById = new Map(body.catalog.sources.map((source) => [source.sourceId, source]));
  const maigret = sourcesById.get('maigret');
  assert.equal(maigret?.upstreamVersion, EXPECTED_SOURCES.maigret.upstreamVersion);
  assert.equal(maigret?.contentHash, EXPECTED_SOURCES.maigret.contentHash);
  assert.equal(maigret?.license, 'MIT');
  assert.equal(maigret?.licenseHash, EXPECTED_SOURCES.maigret.licenseHash);
  assert.equal(maigret?.upstreamState, 'metadata_only_not_imported');
  assert.deepEqual(maigret?.counts, { raw: null, loaded: null, excluded: null });
  assert.equal(sourcesById.get('tikhub-openapi')?.upstreamVersion, 'V5.3.2');
  assert.equal(sourcesById.get('tikhub-openapi')?.contentHash, EXPECTED_SOURCES['tikhub-openapi'].contentHash);

  // The explicit Threads cursor limit is readable through the API surface.
  const threads = body.catalog.platforms.find((platform) => platform.platformId === 'threads');
  assert.ok(threads);
  const threadsPagination = threads.capabilities.find((capability) => capability.dimension === 'pagination');
  assert.equal(threadsPagination?.pagination?.cursor, 'invalid');
  assert.ok((threadsPagination?.sourceLocator ?? '').includes('fetch_user_posts'));

  // Per-operation evidence is retained through the API (mixed dimensions).
  const redditPagination = body.catalog.platforms
    .find((platform) => platform.platformId === 'reddit')
    ?.capabilities.find((capability) => capability.dimension === 'pagination');
  assert.ok(redditPagination);
  assert.equal(redditPagination.cost.provider, 'tikhub');
  assert.ok(redditPagination.operations.length > 0);
  assert.equal(redditPagination.operations.every((op) => op.access === 'credentials_required'), true);
  assert.equal(redditPagination.operations.every((op) => op.method === 'GET'), true);
  const wechatArticles = body.catalog.platforms
    .find((platform) => platform.platformId === 'wechat-mp')
    ?.capabilities.find((capability) => capability.dimension === 'list')
    ?.operations.find((op) => op.endpoint.includes('fetch_account_articles'));
  assert.equal(wechatArticles?.method, 'POST');
  assert.equal(wechatArticles?.requestBody, 'FetchAccountArticlesRequest');

  // Route provenance (operation + source refs) is retained through the API.
  const xHandleRoute = body.catalog.platforms
    .find((platform) => platform.platformId === 'x')
    ?.routes.find((route) => route.routeId === 'x-tikhub-handle');
  assert.ok(xHandleRoute);
  assert.equal(xHandleRoute.operation, 'tikhub-x:fetch_user_profile');
  assert.ok(xHandleRoute.sourceRefs.includes('tikhub-openapi'));
  for (const platform of body.catalog.platforms) {
    for (const route of platform.routes) {
      assert.ok(route.operation.length > 0, `${platform.platformId}/${route.routeId}: operation dropped`);
      assert.ok(route.sourceRefs.length > 0, `${platform.platformId}/${route.routeId}: sourceRefs dropped`);
    }
  }

  // Public provenance details travel with every capability record.
  const githubList = body.catalog.platforms
    .find((platform) => platform.platformId === 'github')
    ?.capabilities.find((capability) => capability.dimension === 'list');
  assert.ok(githubList);
  assert.ok(githubList.sourceRefs.length > 0);
  assert.ok((githubList.sourceLocator ?? '').length > 0 || githubList.endpoints.length > 0);
  assert.ok(githubList.cost.basis.length > 0);

  const discord = body.catalog.platforms.find((platform) => platform.platformId === 'discord');
  assert.ok(discord && discord.gaps.length > 0);
  assert.ok(discord.gaps.some((gap) => gap.kind === 'unknown_price'));
});

test('GET /api/discovery/registry without a catalog stays byte-compatible for old callers', async (t) => {
  const server = await startTestServer({ discoveryCatalog: null });
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('catalog-none@example.test');
  const { body } = await server.client.json<Record<string, unknown>>('/api/discovery/registry');
  assert.deepEqual(Object.keys(body).sort(), ['registry', 'summary']);
  assert.deepEqual(
    { ...registrySummary(body.registry as typeof BUILTIN_PLATFORM_REGISTRY), version: null, generatedAt: null },
    { ...registrySummary(BUILTIN_PLATFORM_REGISTRY), version: null, generatedAt: null }
  );
});

/* ------------------------------------------------------------------ */
/* Production data packaging (synthetic canary only)                   */
/* ------------------------------------------------------------------ */

test('build:data copies only data/platforms, never sibling local stores', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'catalog-packaging-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const pkg = path.join(workDir, 'pkg');
  mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  mkdirSync(path.join(pkg, 'data', 'platforms'), { recursive: true });
  cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
  cpSync(sourceDataDir, path.join(pkg, 'data', 'platforms'), { recursive: true });
  // Synthetic canaries standing in for a local SQLite/user-research store.
  writeFileSync(path.join(pkg, 'data', 'private-canary.sqlite'), 'synthetic-canary-not-a-real-db');
  writeFileSync(path.join(pkg, 'data', 'research-notes.json'), '{"synthetic": true}');

  const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, `copy script failed: ${stderr}`);

  // Required platform catalog is bundled…
  assert.ok(existsSync(path.join(pkg, 'dist', 'data', 'platforms', 'manifest.json')));
  assert.ok(existsSync(path.join(pkg, 'dist', 'data', 'platforms', 'catalog.json')));
  // …and sibling local data never ships.
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'private-canary.sqlite')), false, 'canary sqlite leaked into dist');
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'research-notes.json')), false, 'local research notes leaked into dist');
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'data')), false);
});

test('build:data normalizes the public bundle to world-readable modes without touching sources', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'catalog-modes-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const pkg = path.join(workDir, 'pkg');
  mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  mkdirSync(path.join(pkg, 'data', 'platforms'), { recursive: true });
  cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
  cpSync(sourceDataDir, path.join(pkg, 'data', 'platforms'), { recursive: true });
  writeFileSync(path.join(pkg, 'data', 'private-canary.sqlite'), 'synthetic-canary-not-a-real-db');
  // Restrictive source modes: what cpSync would happily preserve into dist.
  chmodSync(path.join(pkg, 'data'), 0o700);
  chmodSync(path.join(pkg, 'data', 'platforms'), 0o700);
  for (const name of readdirSync(path.join(pkg, 'data', 'platforms'))) {
    chmodSync(path.join(pkg, 'data', 'platforms', name), 0o600);
  }
  chmodSync(path.join(pkg, 'data', 'private-canary.sqlite'), 0o600);

  const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0, `copy script failed: ${stderr}`);

  // The PUBLIC bundle must be readable/traversable by a non-owner (Docker
  // runs as USER node against root-owned files), including its ancestors.
  const bundleRoot = path.join(pkg, 'dist', 'data', 'platforms');
  assert.equal(statSync(path.join(pkg, 'dist')).mode & 0o777, 0o755, 'generated dist root must be 755');
  assert.equal(statSync(path.join(pkg, 'dist', 'data')).mode & 0o777, 0o755, 'generated dist/data must be 755');
  assert.equal(statSync(bundleRoot).mode & 0o777, 0o755, 'bundle dir must be 755');
  for (const name of readdirSync(bundleRoot)) {
    assert.equal(statSync(path.join(bundleRoot, name)).mode & 0o777, 0o644, `${name} must be 644`);
  }
  // Sources and private siblings keep their restrictive modes and stay put.
  assert.equal(statSync(path.join(pkg, 'data', 'platforms')).mode & 0o777, 0o700, 'source dir mode changed');
  assert.equal(statSync(path.join(pkg, 'data', 'platforms', 'catalog.json')).mode & 0o777, 0o600, 'source file mode changed');
  assert.equal(statSync(path.join(pkg, 'data', 'private-canary.sqlite')).mode & 0o777, 0o600, 'private sibling mode changed');
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'private-canary.sqlite')), false);
});

test('build:data normalizes generated public ancestors under restrictive umask', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'catalog-umask-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const pkg = path.join(workDir, 'pkg');
  mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  mkdirSync(path.join(pkg, 'data', 'platforms'), { recursive: true });
  cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
  cpSync(sourceDataDir, path.join(pkg, 'data', 'platforms'), { recursive: true });
  // Pre-existing restrictive generated ancestors (umask 077 reality).
  mkdirSync(path.join(pkg, 'dist', 'data'), { recursive: true, mode: 0o700 });
  chmodSync(path.join(pkg, 'dist'), 0o700);
  chmodSync(path.join(pkg, 'dist', 'data'), 0o700);

  const previousUmask = process.umask(0o077);
  let exitCode: number | null = null;
  let stderr = '';
  try {
    const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    exitCode = await new Promise((resolve) => child.on('close', resolve));
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(exitCode, 0, `copy script failed: ${stderr}`);

  for (const dir of ['dist', path.join('dist', 'data'), path.join('dist', 'data', 'platforms')]) {
    const mode = statSync(path.join(pkg, dir)).mode & 0o777;
    assert.equal(mode, 0o755, `${dir} must be traversable (755), got ${mode.toString(8)}`);
  }
  const catalogPath = path.join(pkg, 'dist', 'data', 'platforms', 'catalog.json');
  assert.equal(statSync(catalogPath).mode & 0o777, 0o644);
  const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { entries: unknown[] };
  assert.ok(parsed.entries.length > 0, 'catalog must be readable in the bundle');
});

test('build:data refuses symlinks in source and generated ancestors without touching canaries', async (t) => {
  const CANARY = 'synthetic-private-canary-do-not-leak';
  const makeFixture = (name: string) => {
    const workDir = mkdtempSync(path.join(tmpdir(), `catalog-symlink-${name}-`));
    const pkg = path.join(workDir, 'pkg');
    mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    mkdirSync(path.join(pkg, 'data', 'platforms'), { recursive: true });
    cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
    cpSync(sourceDataDir, path.join(pkg, 'data', 'platforms'), { recursive: true });
    writeFileSync(path.join(pkg, 'data', 'private-canary.txt'), CANARY);
    chmodSync(path.join(pkg, 'data', 'private-canary.txt'), 0o600);
    return { workDir, pkg };
  };
  const run = async (pkg: string, workDir: string) => {
    const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code: number | null = await new Promise((resolve) => child.on('close', resolve));
    return { code, stderr };
  };
  const assertUntouched = (pkg: string) => {
    const canary = path.join(pkg, 'data', 'private-canary.txt');
    assert.equal(readFileSync(canary, 'utf8'), CANARY, 'canary content changed');
    assert.equal(statSync(canary).mode & 0o777, 0o600, 'canary mode changed (chmod escaped the bundle)');
  };

  // (a) source FILE symlink pointing at the private canary.
  {
    const { workDir, pkg } = makeFixture('file');
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    // A pre-existing artifact must survive a refused run.
    mkdirSync(path.join(pkg, 'dist', 'data', 'platforms'), { recursive: true });
    writeFileSync(path.join(pkg, 'dist', 'data', 'platforms', 'previous.txt'), 'previous-artifact');
    symlinkSync(path.join(pkg, 'data', 'private-canary.txt'), path.join(pkg, 'data', 'platforms', 'leak.txt'));
    const { code } = await run(pkg, workDir);
    assert.notEqual(code, 0, 'file symlink must be refused');
    assertUntouched(pkg);
    assert.equal(readFileSync(path.join(pkg, 'dist', 'data', 'platforms', 'previous.txt'), 'utf8'), 'previous-artifact', 'previous artifact was modified');
    assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'platforms', 'catalog.json')), false, 'refused run must not copy');
  }
  // (b) source DIRECTORY symlink and source ROOT symlink.
  {
    const { workDir, pkg } = makeFixture('dir');
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(path.join(pkg, 'data', 'private-dir'), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(pkg, 'data', 'private-dir', 'inside.txt'), CANARY);
    chmodSync(path.join(pkg, 'data', 'private-dir', 'inside.txt'), 0o600);
    symlinkSync(path.join(pkg, 'data', 'private-dir'), path.join(pkg, 'data', 'platforms', 'sub'));
    const first = await run(pkg, workDir);
    assert.notEqual(first.code, 0, 'directory symlink must be refused');
    assertUntouched(pkg);
    rmSync(path.join(pkg, 'data', 'platforms', 'sub'));
    // Now make the whole source root a symlink.
    const real = path.join(workDir, 'real-platforms');
    cpSync(path.join(pkg, 'data', 'platforms'), real, { recursive: true });
    rmSync(path.join(pkg, 'data', 'platforms'), { recursive: true, force: true });
    symlinkSync(real, path.join(pkg, 'data', 'platforms'));
    const second = await run(pkg, workDir);
    assert.notEqual(second.code, 0, 'source root symlink must be refused');
    assert.equal(statSync(path.join(pkg, 'data', 'private-canary.txt')).mode & 0o777, 0o600);
  }
  // A link in the data ancestor must not redirect the source outside the package.
  {
    const { workDir, pkg } = makeFixture('source-ancestor');
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    const externalData = path.join(workDir, 'external-data');
    cpSync(path.join(pkg, 'data'), externalData, { recursive: true });
    rmSync(path.join(pkg, 'data'), { recursive: true, force: true });
    symlinkSync(externalData, path.join(pkg, 'data'));
    const { code } = await run(pkg, workDir);
    assert.notEqual(code, 0, 'symlinked source ancestor must be refused');
    assertUntouched(pkg);
    assert.equal(existsSync(path.join(pkg, 'dist')), false, 'refused source must not create an artifact');
  }
  // (c) generated DEST/ancestor symlink redirecting writes outside the package.
  {
    const { workDir, pkg } = makeFixture('dest');
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    symlinkSync(path.join(pkg, 'data'), path.join(pkg, 'dist', 'data'));
    const { code } = await run(pkg, workDir);
    assert.notEqual(code, 0, 'symlinked generated ancestor must be refused');
    assertUntouched(pkg);
    assert.equal(existsSync(path.join(pkg, 'data', 'platforms', 'catalog.json')), true, 'source was modified');
  }
});

test('build:data refuses incomplete source catalogs before touching previous artifacts', async (t) => {
  for (const missing of ['catalog.json', 'manifest.json']) {
    const workDir = mkdtempSync(path.join(tmpdir(), 'catalog-incomplete-'));
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    const pkg = path.join(workDir, 'pkg');
    mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
    cpSync(sourceDataDir, path.join(pkg, 'data', 'platforms'), { recursive: true });
    rmSync(path.join(pkg, 'data', 'platforms', missing));
    mkdirSync(path.join(pkg, 'dist', 'data', 'platforms'), { recursive: true });
    const previous = path.join(pkg, 'dist', 'data', 'platforms', 'previous.txt');
    writeFileSync(previous, 'previous-artifact');
    const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir, stdio: 'ignore' });
    const code: number | null = await new Promise((resolve) => child.on('close', resolve));
    assert.notEqual(code, 0, `missing ${missing} must fail the build`);
    assert.equal(readFileSync(previous, 'utf8'), 'previous-artifact');
  }
});

/* ------------------------------------------------------------------ */
/* Compiled runtime: bundled data loads outside the repository cwd     */
/* ------------------------------------------------------------------ */

test(
  'compiled runtime fails closed when the bundled data is missing',
  {
    skip: existsSync(path.join(appRoot, 'dist', 'server', 'platforms', 'catalog.js'))
      ? false
      : 'run `npm --prefix apps/web run build` first'
  },
  async (t) => {
    const distDir = path.join(appRoot, 'dist');
    const workDir = mkdtempSync(path.join(tmpdir(), 'catalog-missing-'));
    const copyRoot = path.join(workDir, 'copied-build');
    const cwdDir = path.join(workDir, 'elsewhere');
    mkdirSync(cwdDir, { recursive: true });
    // A complete dist EXCEPT its data bundle, plus a source-style catalog in
    // the ancestor layout: the loader must not fall back to it.
    cpSync(distDir, path.join(copyRoot, 'dist'), {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}dist${path.sep}data`)
    });
    assert.equal(existsSync(path.join(copyRoot, 'dist', 'data')), false);
    cpSync(sourceDataDir, path.join(copyRoot, 'data', 'platforms'), { recursive: true });
    t.after(() => rmSync(workDir, { recursive: true, force: true }));

    const script = `
      const catalog = await import(${JSON.stringify(`file://${path.join(copyRoot, 'dist', 'server', 'platforms', 'catalog.js')}`)});
      try {
        const dir = catalog.defaultCatalogDataDir();
        console.log(JSON.stringify({ resolved: dir }));
      } catch (error) {
        console.log(JSON.stringify({ errorCode: error.code ?? null, name: error.name }));
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: cwdDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, `copied build crashed: ${stderr}`);
    const result = JSON.parse(stdout.trim()) as { resolved?: string; errorCode?: string | null; name?: string };
    assert.equal(result.resolved, undefined, `missing bundle must not resolve to ${String(result.resolved)}`);
    assert.equal(result.errorCode, 'data_not_found');
  }
);

test(
  'compiled runtime loads the bundled catalog copy from an arbitrary cwd',
  {
    skip: existsSync(path.join(appRoot, 'dist', 'server', 'platforms', 'catalog.js'))
      ? false
      : 'run `npm --prefix apps/web run build` first'
  },
  async (t) => {
    const distDir = path.join(appRoot, 'dist');
    assert.ok(
      existsSync(path.join(distDir, 'data', 'platforms', 'manifest.json')),
      'npm run build must copy data/platforms into dist/data/platforms'
    );
    assert.equal(
      existsSync(path.join(distDir, 'data', 'platforms', 'private-canary.sqlite')),
      false,
      'production dist must not carry local stores'
    );
    const workDir = mkdtempSync(path.join(tmpdir(), 'catalog-copy-'));
    const copyRoot = path.join(workDir, 'copied-build');
    const cwdDir = path.join(workDir, 'elsewhere');
    mkdirSync(cwdDir, { recursive: true });
    cpSync(distDir, path.join(copyRoot, 'dist'), { recursive: true });
    t.after(() => rmSync(workDir, { recursive: true, force: true }));

    const script = `
      const catalog = await import(${JSON.stringify(`file://${path.join(copyRoot, 'dist', 'server', 'platforms', 'catalog.js')}`)});
      const dataDir = catalog.defaultCatalogDataDir();
      const snapshot = catalog.loadPlatformCatalog(dataDir);
      console.log(JSON.stringify({
        dataDir,
        entries: snapshot.entries.length,
        contentHash: snapshot.contentHash,
        registryVersion: snapshot.registryVersion
      }));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: cwdDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, `copied build failed to load catalog: ${stderr}`);

    const result = JSON.parse(stdout.trim()) as { dataDir: string; entries: number; contentHash: string; registryVersion: string };
    assert.ok(
      result.dataDir.startsWith(copyRoot),
      `production must read bundled data inside the copied build, got ${result.dataDir}`
    );
    assert.equal(result.entries, 54);
    assert.match(result.contentHash, /^sha256:[0-9a-f]{64}$/);
    const source = loadSourceCatalog();
    assert.equal(result.contentHash, source.contentHash, 'compiled and source data copies agree');
    assert.equal(result.registryVersion, source.registryVersion);
  }
);
