/**
 * GET-91 repair-3 regressions (Task 2 credential-bearing templates + strict
 * loader). Reproduces the confirmed upstream-credential-in-URL finding
 * BEFORE the fix. Synthetic FAKE tokens only — no upstream credential value
 * is ever copied into tests, logs or outputs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PublicRuleSourceInput } from '../shared/public-discovery-rules.js';
import { compilePublicRules, loadPublicRuleBundle } from '../server/platforms/public-rules.js';

const CC_TEXT = 'Copyright (C) 2015-2026 Micah Hoffman\n\nThis work is licensed under CC BY-SA 4.0\n';

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

const FAKE_TOKEN = 'FAKE_SYNTHETIC_TOKEN_0123456789abcdef0123456789abcdef0123456789ab';

function wmnInput(sites: Array<Record<string, unknown>>): PublicRuleSourceInput {
  const bytes = Buffer.from(JSON.stringify({ license: ['CC'], sites }), 'utf8');
  return {
    sourceId: 'whatsmyname',
    kind: 'whatsmyname_sites',
    bytes,
    licenseText: CC_TEXT,
    manifest: {
      repository: 'https://github.com/WebBreacher/WhatsMyName',
      sourceUrl: 'https://raw.githubusercontent.com/WebBreacher/WhatsMyName/pinned/wmn-data.json',
      commit: '062bcfe48df79fa618e96edc79dc9673f3fe5643',
      retrievedAt: '2026-09-30T05:31:03.956135+00:00',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/'
    }
  };
}

const BASE = { e_code: 200, e_string: 'specific-profile-marker', m_code: 404, m_string: 'site-specific-absence' };

test('P1-4 credential-bearing request templates are excluded before serialization, values never leak', () => {
  const imported = compilePublicRules(
    wmnInput([
      {
        name: 'CredApi',
        uri_check: `https://credapi.example.test/api/3.0/users/details?api_key=${FAKE_TOKEN}&user={account}`,
        ...BASE
      },
      {
        name: 'CredEncoded',
        uri_check: `https://credencoded.example.test/u?api%5Fkey=${FAKE_TOKEN}&id={account}`,
        ...BASE
      },
      {
        name: 'CredUpper',
        uri_check: `https://credupper.example.test/u?API_KEY=${FAKE_TOKEN}&id={account}`,
        ...BASE
      },
      {
        name: 'CredInPretty',
        uri_check: 'https://credpretty.example.test/u?id={account}',
        uri_pretty: `https://credpretty.example.test/p?access_token=${FAKE_TOKEN}&id={account}`,
        ...BASE
      },
      {
        name: 'LegitProfile',
        uri_check: 'https://legit.example.test/u?id={account}&tab=posts',
        ...BASE
      }
    ])
  );
  for (const name of ['CredApi', 'CredEncoded', 'CredUpper', 'CredInPretty']) {
    const receipt = imported.exclusions.find((item) => item.rowId === name);
    assert.ok(receipt, `${name} must be excluded`);
    assert.equal(receipt.reason, 'credential_bearing_template');
    assert.deepEqual(Object.keys(receipt).sort(), ['reason', 'rowId', 'rowSha256']);
    assert.match(receipt.rowSha256, /^[0-9a-f]{64}$/);
  }
  const legit = imported.rules.find((candidate) => candidate.sourceName === 'LegitProfile');
  assert.ok(legit, 'legitimate username/profile query semantics stay loaded');
  assert.match(legit.requestTemplate, /id=\{username\}&tab=posts$/);
  // The credential VALUE never reaches any serialized output.
  const serialized = JSON.stringify({ rules: imported.rules, exclusions: imported.exclusions, source: imported.source });
  assert.equal(serialized.includes(FAKE_TOKEN), false, 'no credential value may be copied anywhere');
});

test('P1-4 credential-bearing templates in Maigret urlMain/urlSubpath substitution are excluded too', () => {
  const bytes = Buffer.from(
    JSON.stringify({
      engines: {},
      tags: [],
      sites: {
        Substituted: {
          url: '{urlMain}/users/{username}',
          urlMain: `https://sub.example.test/api?key=${FAKE_TOKEN}`
        },
        Plain: {
          url: 'https://plain.example.test/u/{username}',
          urlMain: 'https://plain.example.test',
          checkType: 'message',
          presenseStrs: ['specific-profile-marker']
        }
      }
    }),
    'utf8'
  );
  const imported = compilePublicRules({
    sourceId: 'maigret',
    kind: 'maigret_sites',
    bytes,
    licenseText: 'MIT License\n\nCopyright (c) 2020-2026 Soxoj\n\nPermission...\n',
    manifest: {
      repository: 'https://github.com/soxoj/maigret',
      sourceUrl: 'https://raw.githubusercontent.com/soxoj/maigret/pinned/maigret/resources/data.json',
      commit: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
      retrievedAt: '2026-09-30T05:30:59.298392+00:00',
      license: 'MIT',
      licenseUrl: 'https://github.com/soxoj/maigret/blob/pinned/LICENSE'
    }
  });
  assert.equal(
    imported.exclusions.find((item) => item.rowId === 'Substituted')?.reason,
    'credential_bearing_template',
    'substituted urlMain credentials are caught after substitution'
  );
  assert.ok(imported.rules.some((candidate) => candidate.sourceRef.rowId === 'Plain'));
  assert.equal(JSON.stringify(imported).includes(FAKE_TOKEN), false);
});

test('P1-4 strict loader refuses a credential-bearing normalized rule even with valid hashes', (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'repair3-cred-loader-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const dir = path.join(workDir, 'data', 'platforms');
  const bundleDir = path.join(dir, 'public-rules');
  mkdirSync(bundleDir, { recursive: true });
  const rule = {
    ruleId: `pr-${sha256Hex('cred').slice(0, 16)}`,
    sourceRef: { sourceId: 'maigret', rowId: 'row-1', rowSha256: sha256Hex('row-1') },
    sourceName: 'Site',
    canonicalProfileTemplate: 'https://site.example.test/{username}',
    requestTemplate: `https://site.example.test/u?api_key=${FAKE_TOKEN}&id={username}`,
    instanceHost: 'site.example.test',
    accountKind: 'unknown',
    detection: {
      kind: 'bounded_strings',
      presentStatus: null,
      presentAny: ['unique-proof'],
      nonProofPresentAny: [],
      absentStatus: 404,
      absentAny: [],
      boundedPositive: true,
      boundedNegative: true
    },
    caseSensitive: true,
    ratePerMinute: null,
    protections: [],
    errorMarkers: [],
    safeHeaders: {}
  };
  writeFileSync(path.join(bundleDir, 'rules.json'), `${JSON.stringify({ schemaVersion: 'stripsearch/public-rules/v1', rules: [rule] }, null, 1)}\n`);
  writeFileSync(
    path.join(bundleDir, 'exclusions.json'),
    `${JSON.stringify({ schemaVersion: 'stripsearch/public-rules/v1', sources: [
      { sourceId: 'maigret', exclusions: [{ rowId: 'row-2', rowSha256: sha256Hex('row-2'), reason: 'disabled_rule' }] },
      { sourceId: 'whatsmyname', exclusions: [{ rowId: 'row-3', rowSha256: sha256Hex('row-3'), reason: 'disabled_rule' }] }
    ] }, null, 1)}\n`
  );
  writeFileSync(path.join(bundleDir, 'maigret-LICENSE.txt'), 'MIT License\n\nCopyright (c) 2020-2026 Soxoj\n\nPermission...\n');
  writeFileSync(path.join(bundleDir, 'whatsmyname-LICENSE.txt'), CC_TEXT);
  writeFileSync(path.join(bundleDir, 'maigret-NOTICE.md'), '# maigret notice\n\nCopyright: Copyright (c) 2020-2026 Soxoj\n');
  writeFileSync(path.join(bundleDir, 'whatsmyname-NOTICE.md'), '# whatsmyname notice\n');
  writeFileSync(path.join(bundleDir, 'LICENSE-DATASETS.md'), '# dataset licensing\n');
  const files = ['rules.json', 'exclusions.json', 'maigret-LICENSE.txt', 'whatsmyname-LICENSE.txt', 'maigret-NOTICE.md', 'whatsmyname-NOTICE.md', 'LICENSE-DATASETS.md'].map((file) => {
    const bytes = readFileSync(path.join(bundleDir, file));
    return { path: file, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  });
  const manifest = {
    schemaVersion: 'stripsearch/public-rules-manifest/v1',
    importerVersion: 'get91-public-rule-importer/1',
    generatedAt: '2026-09-30T05:31:03.956135+00:00',
    files,
    sources: [
      {
        sourceId: 'maigret',
        kind: 'maigret_sites',
        repository: 'https://github.com/soxoj/maigret',
        sourceUrl: 'https://raw.githubusercontent.com/soxoj/maigret/pinned/maigret/resources/data.json',
        commit: 'b6642744988e7e6c2d21f75db60ec3093019ba25',
        retrievedAt: '2026-09-30T05:30:59.298392+00:00',
        contentHash: sha256Hex('bytes'),
        bytes: 10,
        license: 'MIT',
        licenseUrl: 'https://github.com/soxoj/maigret/blob/pinned/LICENSE',
        licenseHash: sha256Hex('MIT License\n\nCopyright (c) 2020-2026 Soxoj\n\nPermission...\n'),
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
        contentHash: sha256Hex('bytes2'),
        bytes: 20,
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        licenseHash: sha256Hex(CC_TEXT),
        importerVersion: 'get91-public-rule-importer/1',
        counts: { raw: 1, loaded: 0, excluded: 1 },
        exclusionsByReason: { disabled_rule: 1 },
        notice: 'whatsmyname-NOTICE.md',
        licenseFile: 'whatsmyname-LICENSE.txt'
      }
    ],
    counts: { sourceRows: 3, loaded: 1, excluded: 2 }
  };
  writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  assert.throws(
    () => loadPublicRuleBundle(dir),
    (error: unknown) => /credential/i.test((error as Error).message),
    'the loader must refuse credential-bearing rules even when hashes are recomputed'
  );
});
