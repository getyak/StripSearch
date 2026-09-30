/**
 * GET-91 full pinned source audit for the compiled public-rule bundle.
 *
 * Two layers:
 *
 * 1. ALWAYS RUN — reconciles the committed bundle against independently
 *    pinned constants: source byte hashes, per-source raw row counts
 *    (6206 Maigret / 717 WhatsMyName), raw = loaded + excluded, complete
 *    exclusion receipts and deterministic ids.
 * 2. MAINTAINER BYTE AUDIT — set `PUBLIC_RULE_SOURCE_DIR` to the local
 *    pinned source cache to re-hash the actual upstream bytes and recompile
 *    them in-memory, asserting byte-identical normalized output. This is the
 *    only part that needs the private byte cache (which must never enter
 *    Git), so it reports `skip` without that explicit local input.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  compilePublicRules,
  loadPublicRuleBundle,
  knownPlatformTemplateMap,
  unionFromBundle
} from '../server/platforms/public-rules.js';
import type { PublicRuleSourceInput } from '../shared/public-discovery-rules.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = path.join(appRoot, 'data', 'platforms');

/** Independently frozen upstream facts (never derived from the bundle). */
const PINNED = {
  maigret: {
    sha256: '3ac973e44f765c1c2b851571bd165f45145d0a00231c8ea97fb479e93f6aa289',
    bytes: 2496965,
    records: 6206,
    commit: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
    licenseHash: '9748c279c95c58e64cc9e538e8c717ae9dce66bbed1d69e7d3e77e431d7e582d'
  },
  whatsmyname: {
    sha256: '507d2f8aa5b1297ae2d713634ccc7ce08357fed85b1d40130585810f456c1cfe',
    bytes: 259104,
    records: 717,
    commit: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
    licenseHash: '3eab49aa5cabc24918c11aab97dfe8873e0641317b898d989c993c4283a4d84b'
  }
};

function sha256Hex(input: Buffer | string | Uint8Array): string {
  return createHash('sha256').update(input as Buffer).digest('hex');
}

test('committed bundle reconciles every pinned source row: raw = loaded + excluded', () => {
  const bundle = loadPublicRuleBundle(dataDir);
  assert.equal(bundle.counts.sourceRows, 6923, '6206 Maigret + 717 WhatsMyName source rows');
  assert.equal(bundle.counts.loaded, bundle.rules.length);
  assert.equal(bundle.counts.excluded, bundle.exclusionsBySource.reduce((total, group) => total + group.exclusions.length, 0));
  assert.equal(bundle.counts.sourceRows, bundle.counts.loaded + bundle.counts.excluded);

  const bySource = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  for (const [sourceId, pinned] of Object.entries(PINNED)) {
    const source = bySource.get(sourceId as 'maigret' | 'whatsmyname');
    assert.ok(source, `missing source record ${sourceId}`);
    assert.equal(source.contentHash, pinned.sha256, `${sourceId} pinned byte hash`);
    assert.equal(source.bytes, pinned.bytes, `${sourceId} pinned byte count`);
    assert.equal(source.commit, pinned.commit, `${sourceId} pinned commit`);
    assert.equal(source.licenseHash, pinned.licenseHash, `${sourceId} license hash`);
    assert.equal(source.counts.raw, pinned.records, `${sourceId} full row count (no default-500)`);
    assert.equal(source.counts.raw, source.counts.loaded + source.counts.excluded, `${sourceId} raw = loaded + excluded`);
    assert.ok(source.counts.loaded > 0 && source.counts.excluded > 0, `${sourceId} keeps honest loaded/excluded splits`);
    const reasonTotal = Object.values(source.exclusionsByReason).reduce((total, count) => total + (count ?? 0), 0);
    assert.equal(reasonTotal, source.counts.excluded, `${sourceId} every exclusion has a counted reason`);
  }
});

test('exclusion receipts are complete, minimal and never carry source payloads', () => {
  const bundle = loadPublicRuleBundle(dataDir);
  const sourceById = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  for (const group of bundle.exclusionsBySource) {
    const source = sourceById.get(group.sourceId);
    assert.ok(source, `exclusions for unknown source ${group.sourceId}`);
    assert.equal(group.exclusions.length, source.counts.excluded, `${group.sourceId} receipts cover every excluded row`);
    const rowIds = new Set<string>();
    for (const receipt of group.exclusions) {
      assert.deepEqual(Object.keys(receipt).sort(), ['reason', 'rowId', 'rowSha256'], 'receipts stay minimal');
      assert.match(receipt.rowSha256, /^[0-9a-f]{64}$/);
      assert.ok(receipt.rowId.length > 0);
      assert.equal(rowIds.has(receipt.rowId), false, `duplicate receipt rowId ${receipt.rowId}`);
      rowIds.add(receipt.rowId);
      const serialized = JSON.stringify(receipt);
      // Credential VALUES never land in receipts (platform names may legally
      // contain words like "secret" — value-shaped patterns are the signal).
      assert.equal(
        /bearer\s+\S+|session=|cookie\s*[:=]|authorization\s*[:=]|eyJ[A-Za-z0-9_-]{10,}|-----BEGIN/i.test(serialized),
        false,
        'receipts never carry credential values'
      );
    }
    // Loaded rules account for the remaining rows of the same source.
    const loadedRows = bundle.rules.filter((rule) => rule.sourceRef.sourceId === group.sourceId);
    assert.equal(loadedRows.length, source.counts.loaded);
    for (const rule of loadedRows) {
      assert.equal(rowIds.has(rule.sourceRef.rowId), false, `row ${rule.sourceRef.rowId} is both loaded and excluded`);
    }
  }
});

test('bundle union is deterministic and mapping stays exact-template only', () => {
  const bundle = loadPublicRuleBundle(dataDir);
  const catalog = JSON.parse(readFileSync(path.join(dataDir, 'catalog.json'), 'utf8')) as {
    entries: Array<{ platformId: string; profileUrlRule: string | null }>;
  };
  const known = knownPlatformTemplateMap(catalog.entries);
  const first = unionFromBundle(bundle, known);
  const second = unionFromBundle(bundle, known);
  assert.deepEqual(first.groups.map((group) => group.groupId), second.groups.map((group) => group.groupId));
  assert.deepEqual(first.counts, second.counts);
  assert.equal(first.rules.length, bundle.rules.length);
  for (const group of first.groups) {
    assert.match(group.groupId, /^pug-[0-9a-f]{12}$/);
    if (group.knownPlatformId === null) assert.match(group.platformId, /^pub-[0-9a-f]{12}$/);
    else assert.equal(group.platformId, group.knownPlatformId);
    assert.ok(group.rules.length > 0);
    assert.ok(group.requestTemplates.length > 0);
  }
  // Known mappings come from explicit curated profile templates only.
  assert.ok(first.counts.knownMappedGroups > 0, 'some exact templates map into curated platforms');
  assert.equal(first.counts.knownMappedGroups + first.counts.generatedPlatforms, first.groups.length);
  for (const group of first.groups) {
    if (group.knownPlatformId !== null) {
      assert.equal(known.get(group.canonicalProfileTemplate), group.knownPlatformId, 'mapping is exact-template');
    }
  }
});

test('maintainer byte audit: recompile the pinned upstream bytes byte-identically', (t) => {
  const sourceDir = process.env.PUBLIC_RULE_SOURCE_DIR;
  if (!sourceDir) {
    t.skip('maintainer byte audit: set PUBLIC_RULE_SOURCE_DIR to the local pinned public-sources cache');
    return;
  }
  const inputs: PublicRuleSourceInput[] = [
    {
      sourceId: 'maigret',
      kind: 'maigret_sites',
      bytes: readFileSync(path.join(sourceDir, 'maigret-data.json')),
      licenseText: readFileSync(path.join(sourceDir, 'maigret-LICENSE.txt'), 'utf8'),
      manifest: {
        repository: 'https://github.com/soxoj/maigret',
        sourceUrl: 'https://raw.githubusercontent.com/soxoj/maigret/pinned/maigret/resources/data.json',
        commit: PINNED.maigret.commit,
        retrievedAt: '2026-09-30T05:30:59.298392+00:00',
        license: 'MIT',
        licenseUrl: `https://github.com/soxoj/maigret/blob/${PINNED.maigret.commit}/LICENSE`,
        sha256: PINNED.maigret.sha256,
        bytes: PINNED.maigret.bytes,
        recordCount: PINNED.maigret.records
      }
    },
    {
      sourceId: 'whatsmyname',
      kind: 'whatsmyname_sites',
      bytes: readFileSync(path.join(sourceDir, 'whatsmyname-data.json')),
      licenseText: readFileSync(path.join(sourceDir, 'whatsmyname-LICENSE.txt'), 'utf8'),
      manifest: {
        repository: 'https://github.com/WebBreacher/WhatsMyName',
        sourceUrl: 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/pinned/wmn-data.json',
        commit: PINNED.whatsmyname.commit,
        retrievedAt: '2026-09-30T05:31:03.956135+00:00',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        sha256: PINNED.whatsmyname.sha256,
        bytes: PINNED.whatsmyname.bytes,
        recordCount: PINNED.whatsmyname.records
      }
    }
  ];
  for (const input of inputs) {
    assert.equal(sha256Hex(input.bytes), PINNED[input.sourceId].sha256, `${input.sourceId} pinned bytes unchanged`);
    assert.equal(input.bytes.byteLength, PINNED[input.sourceId].bytes);
    assert.equal(sha256Hex(input.licenseText), PINNED[input.sourceId].licenseHash, `${input.sourceId} license bytes unchanged`);
    const imported = compilePublicRules(input);
    assert.deepEqual(imported.verification.mismatch, [], `${input.sourceId} byte/count verification`);
    assert.equal(imported.counts.raw, PINNED[input.sourceId].records, `${input.sourceId} every row accounted for`);
    // The committed normalized output must be reproducible from the bytes.
    const committedRules = JSON.parse(readFileSync(path.join(dataDir, 'public-rules', 'rules.json'), 'utf8')) as {
      rules: unknown[];
    };
    const committedExclusions = JSON.parse(readFileSync(path.join(dataDir, 'public-rules', 'exclusions.json'), 'utf8')) as {
      sources: Array<{ sourceId: string; exclusions: unknown[] }>;
    };
    const committedRuleSubset = committedRules.rules.filter(
      (rule) => (rule as { sourceRef: { sourceId: string } }).sourceRef.sourceId === input.sourceId
    );
    assert.equal(JSON.stringify(committedRuleSubset), JSON.stringify(imported.rules), `${input.sourceId} rules reproducible`);
    const committedGroup = committedExclusions.sources.find((group) => group.sourceId === input.sourceId);
    assert.ok(committedGroup);
    assert.equal(
      JSON.stringify(committedGroup.exclusions),
      JSON.stringify(imported.exclusions),
      `${input.sourceId} exclusion receipts reproducible`
    );
  }
});
