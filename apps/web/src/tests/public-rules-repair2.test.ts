/**
 * GET-91 repair-2 regressions (Task 2 compiler / strict loader / notice /
 * packaging). Reproduces confirmed native-review findings BEFORE the fix.
 * Offline synthetic fixtures only.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { PublicRuleSourceInput } from '../shared/public-discovery-rules.js';
import { compilePublicRules, loadPublicRuleBundle, extractRequiredCopyright, buildSourceNotice } from '../server/platforms/public-rules.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));

const MIT_CRLF = 'MIT License\r\n\r\nCopyright (c) 2020-2026 Soxoj\r\n\r\nPermission is hereby granted...\r\n';
const CC_TEXT = 'Copyright (C) 2015-2026 Micah Hoffman\n\nThis work is licensed under the Creative Commons Attribution-ShareAlike\n4.0 International License. To view a copy of this license, visit\nhttp://creativecommons.org/licenses/by-sa/4.0/\n';

function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function maigretInput(sites: Record<string, unknown>, licenseText: string = MIT_CRLF): PublicRuleSourceInput {
  const bytes = Buffer.from(JSON.stringify({ engines: {}, tags: [], sites }), 'utf8');
  return {
    sourceId: 'maigret',
    kind: 'maigret_sites',
    bytes,
    licenseText,
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

/* ------------------------------------------------------------------ */
/* P1-9: 2xx absence status without marker is not bounded negative     */
/* ------------------------------------------------------------------ */

test('P1-9 compiler: empty absence marker + 2xx status never becomes boundedNegative', () => {
  const imported = compilePublicRules(
    wmnInput([
      {
        name: 'Evolution CMS',
        uri_check: 'https://evolution.example.test/{account}',
        e_code: 200,
        e_string: 'specific-profile-marker',
        m_code: 200,
        m_string: '',
        known: ['RAW-USERNAME-EXAMPLE']
      },
      {
        name: 'Missing404',
        uri_check: 'https://missing404.example.test/{account}',
        e_code: 200,
        e_string: 'specific-profile-marker',
        m_code: 404,
        m_string: ''
      },
      {
        name: 'Marked200',
        uri_check: 'https://marked200.example.test/{account}',
        e_code: 200,
        e_string: 'specific-profile-marker',
        m_code: 200,
        m_string: 'site-specific-absence'
      }
    ])
  );
  const evolution = imported.rules.find((candidate) => candidate.sourceName === 'Evolution CMS')!;
  assert.equal(evolution.detection.boundedNegative, false, '2xx absence status alone is not proof');
  assert.equal(evolution.detection.absentStatus, 200, 'the source literal status is preserved as metadata');
  const missing = imported.rules.find((candidate) => candidate.sourceName === 'Missing404')!;
  assert.equal(missing.detection.boundedNegative, true, 'a declared non-success absence status is genuine proof');
  const marked = imported.rules.find((candidate) => candidate.sourceName === 'Marked200')!;
  assert.equal(marked.detection.boundedNegative, true, 'a declared absence marker is genuine proof');
});

/* ------------------------------------------------------------------ */
/* P1-8: generic login-form markers are never bounded account proof    */
/* ------------------------------------------------------------------ */

test('P1-8 compiler: login-form literals are preserved but never bounded positive proof', () => {
  const imported = compilePublicRules(
    maigretInput({
      LoginWall: {
        url: 'https://loginwall.example.test/{username}',
        urlMain: 'https://loginwall.example.test',
        checkType: 'message',
        presenseStrs: ['Dernier Login', 'LOGIN']
      },
      Mixed: {
        url: 'https://mixed.example.test/{username}',
        urlMain: 'https://mixed.example.test',
        checkType: 'message',
        presenseStrs: ['data-template="login"', 'unique-profile-chunk']
      }
    })
  );
  const loginWall = imported.rules.find((candidate) => candidate.sourceRef.rowId === 'LoginWall')!;
  assert.deepEqual(loginWall.detection.presentAny, [], 'generic login-form markers never prove an account');
  assert.deepEqual(
    [...loginWall.detection.nonProofPresentAny].sort(),
    ['Dernier Login', 'LOGIN'].sort(),
    'source literals stay preserved as metadata'
  );
  assert.equal(loginWall.detection.boundedPositive, false);
  const mixed = imported.rules.find((candidate) => candidate.sourceRef.rowId === 'Mixed')!;
  assert.deepEqual(mixed.detection.presentAny, ['unique-profile-chunk'], 'specific markers still provide proof');
  assert.deepEqual(mixed.detection.nonProofPresentAny, ['data-template="login"']);
  assert.equal(mixed.detection.boundedPositive, true);
});

/* ------------------------------------------------------------------ */
/* P2-10: strict loader must not silently repair shapes                */
/* ------------------------------------------------------------------ */

function writeMinimalBundle(dir: string, mutateRule?: (rule: Record<string, unknown>) => void, mutateManifest?: (manifest: Record<string, unknown>) => void): void {
  const bundleDir = path.join(dir, 'public-rules');
  mkdirSync(bundleDir, { recursive: true });
  const rule = {
    ruleId: `pr-${sha256Hex('r1').slice(0, 16)}`,
    sourceRef: { sourceId: 'maigret', rowId: 'row-1', rowSha256: sha256Hex('row-1') },
    sourceName: 'Site',
    canonicalProfileTemplate: 'https://site.example.test/{username}',
    requestTemplate: 'https://site.example.test/{username}',
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
  mutateRule?.(rule);
  writeFileSync(path.join(bundleDir, 'rules.json'), `${JSON.stringify({ schemaVersion: 'stripsearch/public-rules/v1', rules: [rule] }, null, 1)}\n`);
  writeFileSync(
    path.join(bundleDir, 'exclusions.json'),
    `${JSON.stringify({ schemaVersion: 'stripsearch/public-rules/v1', sources: [
      { sourceId: 'maigret', exclusions: [{ rowId: 'row-2', rowSha256: sha256Hex('row-2'), reason: 'disabled_rule' }] },
      { sourceId: 'whatsmyname', exclusions: [{ rowId: 'row-3', rowSha256: sha256Hex('row-3'), reason: 'disabled_rule' }] }
    ] }, null, 1)}\n`
  );
  writeFileSync(path.join(bundleDir, 'maigret-LICENSE.txt'), MIT_CRLF);
  writeFileSync(path.join(bundleDir, 'whatsmyname-LICENSE.txt'), CC_TEXT);
  writeFileSync(path.join(bundleDir, 'maigret-NOTICE.md'), '# maigret notice\n\nCopyright: Copyright (c) 2020-2026 Soxoj\n');
  writeFileSync(path.join(bundleDir, 'whatsmyname-NOTICE.md'), '# whatsmyname notice\n');
  writeFileSync(path.join(bundleDir, 'LICENSE-DATASETS.md'), '# dataset licensing\n');
  const files = ['rules.json', 'exclusions.json', 'maigret-LICENSE.txt', 'whatsmyname-LICENSE.txt', 'maigret-NOTICE.md', 'whatsmyname-NOTICE.md', 'LICENSE-DATASETS.md'].map((file) => {
    const bytes = readFileSync(path.join(bundleDir, file));
    return { path: file, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  });
  const manifest: Record<string, unknown> = {
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
        licenseHash: sha256Hex(MIT_CRLF),
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
  mutateManifest?.(manifest);
  writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
}

function withBundle(name: string, t: { after: (fn: () => void) => void }, build: (dir: string) => void): string {
  const workDir = mkdtempSync(path.join(tmpdir(), `repair2-bundle-${name}-`));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const dir = path.join(workDir, 'data', 'platforms');
  mkdirSync(dir, { recursive: true });
  build(dir);
  return dir;
}

test('P2-10 loader refuses caseSensitive:false, wrong instanceHost and wrong per-source counts', (t) => {
  const falseCase = withBundle('false-case', t, (dir) => writeMinimalBundle(dir, (rule) => {
    rule.caseSensitive = false;
  }));
  assert.throws(
    () => loadPublicRuleBundle(falseCase),
    (error: unknown) => (error as { code?: string }).code === 'invalid_shape',
    'caseSensitive:false must be refused, never cast back to true'
  );

  const wrongInstance = withBundle('wrong-instance', t, (dir) => writeMinimalBundle(dir, (rule) => {
    rule.instanceHost = 'unrelated.example.test';
  }));
  assert.throws(
    () => loadPublicRuleBundle(wrongInstance),
    (error: unknown) => (error as { code?: string }).code === 'invalid_shape',
    'instanceHost must be derived from the canonical profile template'
  );

  const wrongCounts = withBundle('wrong-counts', t, (dir) => writeMinimalBundle(dir, undefined, (manifest) => {
    const sources = manifest.sources as Array<{ counts: { raw: number; loaded: number; excluded: number } }>;
    sources[0]!.counts = { raw: 2, loaded: 2, excluded: 0 };
    sources[1]!.counts = { raw: 1, loaded: -0, excluded: 1 };
  }));
  assert.throws(
    () => loadPublicRuleBundle(wrongCounts),
    (error: unknown) => /count|exclusion|loaded/i.test((error as Error).message),
    'per-source counts must match the actual rule/exclusion sets'
  );

  const duplicateRule = withBundle('duplicate-rule', t, (dir) => writeMinimalBundle(dir, undefined, (manifest) => {
    const files = manifest.files as Array<{ path: string; sha256: string; bytes: number }>;
    void files;
  }));
  // Duplicate (sourceId,rowId) across rules and exclusions must be refused.
  const bundleDir = path.join(duplicateRule, 'public-rules');
  const exclusions = JSON.parse(readFileSync(path.join(bundleDir, 'exclusions.json'), 'utf8')) as { sources: Array<{ exclusions: Array<Record<string, unknown>> }> };
  exclusions.sources[0]!.exclusions[0]!.rowId = 'row-1';
  writeFileSync(path.join(bundleDir, 'exclusions.json'), JSON.stringify(exclusions, null, 1));
  const manifest = JSON.parse(readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8')) as { files: Array<{ path: string; sha256: string; bytes: number }> };
  const bytes = readFileSync(path.join(bundleDir, 'exclusions.json'));
  manifest.files = manifest.files.map((file) => (file.path === 'exclusions.json' ? { path: file.path, sha256: sha256Hex(bytes), bytes: bytes.byteLength } : file));
  writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  assert.throws(
    () => loadPublicRuleBundle(duplicateRule),
    (error: unknown) => /duplicate|unique/i.test((error as Error).message),
    'a row can never be both loaded and excluded'
  );
});

test('P2-10 loader refuses traversal, duplicate and unknown manifest paths', (t) => {
  for (const [name, mutate] of [
    ['traversal', (manifest: Record<string, unknown>) => {
      const files = manifest.files as Array<{ path: string }>;
      files[0]!.path = '../catalog.json';
    }],
    ['duplicate-path', (manifest: Record<string, unknown>) => {
      const files = manifest.files as Array<{ path: string }>;
      files.push({ ...files[0]! });
    }],
    ['unknown-path', (manifest: Record<string, unknown>) => {
      const files = manifest.files as Array<{ path: string; sha256: string; bytes: number }>;
      files.push({ path: 'extra-notes.md', sha256: 'a'.repeat(64), bytes: 1 });
    }]
  ] as Array<[string, (manifest: Record<string, unknown>) => void]>) {
    const dir = withBundle(name, t, (target) => writeMinimalBundle(target, undefined, mutate));
    assert.throws(
      () => loadPublicRuleBundle(dir),
      (error: unknown) => typeof (error as { code?: string }).code === 'string',
      `${name} must be refused`
    );
  }
});

/* ------------------------------------------------------------------ */
/* P2-11: notice carries the real Copyright line, never a blank line   */
/* ------------------------------------------------------------------ */

test('P2-11 notice extracts the real Copyright line and refuses attribution-less licenses', () => {
  const copyright = extractRequiredCopyright(MIT_CRLF);
  assert.equal(copyright, 'Copyright (c) 2020-2026 Soxoj', 'CRLF licenses must not yield a blank line');
  assert.equal(extractRequiredCopyright(CC_TEXT), 'Copyright (C) 2015-2026 Micah Hoffman');
  assert.throws(
    () => extractRequiredCopyright('MIT License\n\nPermission is hereby granted...\n'),
    (error: unknown) => /copyright/i.test((error as Error).message),
    'a missing copyright line must block attribution generation'
  );
  const notice = buildSourceNotice({
    sourceId: 'maigret',
    source: {
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
      licenseHash: sha256Hex(MIT_CRLF),
      importerVersion: 'get91-public-rule-importer/1',
      counts: { raw: 2, loaded: 1, excluded: 1 },
      exclusionsByReason: {}
    },
    copyrightLine: copyright,
    licenseFile: 'maigret-LICENSE.txt'
  });
  assert.match(notice, /Copyright \(c\) 2020-2026 Soxoj/, 'the notice carries the real copyright content');
  assert.doesNotMatch(notice, /^.*[ \t]+$/m, 'no trailing whitespace lines (diff --check clean)');
});

/* ------------------------------------------------------------------ */
/* P1-6: packaging copies only the fixed public inventory              */
/* ------------------------------------------------------------------ */

async function runCopy(pkg: string, workDir: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code: number | null = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr };
}

function makePackage(name: string, t: { after: (fn: () => void) => void }): string {
  const workDir = mkdtempSync(path.join(tmpdir(), `repair2-pack-${name}-`));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const pkg = path.join(workDir, 'pkg');
  mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  mkdirSync(path.join(pkg, 'data', 'platforms'), { recursive: true });
  cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
  cpSync(path.join(appRoot, 'data', 'platforms'), path.join(pkg, 'data', 'platforms'), { recursive: true });
  return pkg;
}

test('P1-6 packaging refuses unknown source entries before touching artifacts', async (t) => {
  const pkg = makePackage('unknown-file', t);
  const workDir = path.dirname(pkg);
  const canary = path.join(pkg, 'data', 'platforms', 'raw-source-private-canary.json');
  writeFileSync(canary, '{"synthetic":"canary"}');
  const canaryModeBefore = statSync(canary).mode & 0o777;
  const first = await runCopy(pkg, workDir);
  assert.notEqual(first.code, 0, 'unknown source entries must refuse the copy');
  assert.match(first.stderr, /unknown|inventory/i);
  assert.equal(statSync(canary).mode & 0o777, canaryModeBefore, 'source canary mode untouched');
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'platforms', 'raw-source-private-canary.json')), false, 'unknown files never ship');

  const pkgDir = makePackage('unknown-dir', t);
  const workDir2 = path.dirname(pkgDir);
  mkdirSync(path.join(pkgDir, 'data', 'platforms', 'sneaky-dir'), { recursive: true });
  writeFileSync(path.join(pkgDir, 'data', 'platforms', 'sneaky-dir', 'x.json'), '{}');
  const second = await runCopy(pkgDir, workDir2);
  assert.notEqual(second.code, 0, 'unknown directories must refuse the copy');
});
