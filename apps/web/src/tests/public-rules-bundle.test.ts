/**
 * GET-91 bundle tests: the normalized public-rule bundle must ship with the
 * production build (never the whole local `data/` tree), must pass its own
 * normalized hash verification in `build:data`, and must be loaded by the
 * compiled production module from an arbitrary cwd outside the repository.
 * Corrupted bundles fail closed instead of silently loading.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadPublicRuleBundle } from '../server/platforms/public-rules.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourceDataDir = path.join(appRoot, 'data', 'platforms');

async function runCopy(pkg: string, workDir: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [path.join(pkg, 'scripts', 'copy-platform-data.mjs')], { cwd: workDir });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code: number | null = await new Promise((resolve) => child.on('close', resolve));
  return { code, stderr };
}

function makePackage(name: string, t: { after: (fn: () => void) => void }): string {
  const workDir = mkdtempSync(path.join(tmpdir(), `public-rules-bundle-${name}-`));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const pkg = path.join(workDir, 'pkg');
  mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  mkdirSync(path.join(pkg, 'data', 'platforms'), { recursive: true });
  cpSync(path.join(appRoot, 'scripts', 'copy-platform-data.mjs'), path.join(pkg, 'scripts', 'copy-platform-data.mjs'));
  cpSync(sourceDataDir, path.join(pkg, 'data', 'platforms'), { recursive: true });
  return pkg;
}

test('build:data refuses to bundle when normalized public rule files are missing', async (t) => {
  for (const missing of ['public-rules/rules.json', 'public-rules/manifest.json', 'public-rules/maigret-NOTICE.md']) {
    const pkg = makePackage('missing', t);
    const workDir = path.dirname(pkg);
    rmSync(path.join(pkg, 'data', 'platforms', missing));
    const { code, stderr } = await runCopy(pkg, workDir);
    assert.notEqual(code, 0, `missing ${missing} must fail the build`);
    assert.match(stderr, /required public catalog file is missing/);
    assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'platforms', 'public-rules', 'rules.json')), false);
  }
});

test('build:data verifies normalized public rule hashes before copying anything', async (t) => {
  const pkg = makePackage('tamper', t);
  const workDir = path.dirname(pkg);
  const rulesPath = path.join(pkg, 'data', 'platforms', 'public-rules', 'rules.json');
  const tampered = readFileSync(rulesPath, 'utf8').replace('pr-', 'px-');
  writeFileSync(rulesPath, tampered);
  const { code, stderr } = await runCopy(pkg, workDir);
  assert.notEqual(code, 0, 'a tampered rule file must fail normalized hash verification');
  assert.match(stderr, /normalized hash verification/);
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'platforms', 'public-rules')), false, 'refused run copies nothing');
});

test('build:data ships exactly the normalized public rule bundle alongside the catalog', async (t) => {
  const pkg = makePackage('ship', t);
  const workDir = path.dirname(pkg);
  writeFileSync(path.join(pkg, 'data', 'private-canary.sqlite'), 'synthetic-canary-not-a-real-db');
  const { code, stderr } = await runCopy(pkg, workDir);
  assert.equal(code, 0, `copy failed: ${stderr}`);
  const bundled = path.join(pkg, 'dist', 'data', 'platforms', 'public-rules');
  for (const name of [
    'manifest.json',
    'rules.json',
    'exclusions.json',
    'maigret-NOTICE.md',
    'maigret-LICENSE.txt',
    'whatsmyname-NOTICE.md',
    'whatsmyname-LICENSE.txt',
    'LICENSE-DATASETS.md'
  ]) {
    assert.ok(existsSync(path.join(bundled, name)), `bundle must ship ${name}`);
  }
  // The bundled copy is byte-identical and passes the loader's own verification.
  const bundledRules = readFileSync(path.join(bundled, 'rules.json'));
  const sourceRules = readFileSync(path.join(sourceDataDir, 'public-rules', 'rules.json'));
  assert.equal(createHash('sha256').update(bundledRules).digest('hex'), createHash('sha256').update(sourceRules).digest('hex'));
  assert.equal(existsSync(path.join(pkg, 'dist', 'data', 'private-canary.sqlite')), false, 'local stores never ship');
});

test('the loader refuses a bundle whose normalized rules were modified', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'public-rules-tamper-load-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const dataDir = path.join(workDir, 'data', 'platforms');
  cpSync(sourceDataDir, dataDir, { recursive: true });
  const rulesPath = path.join(dataDir, 'public-rules', 'rules.json');
  writeFileSync(rulesPath, readFileSync(rulesPath, 'utf8').replace('"ruleId"', '"ruleId "'));
  assert.throws(
    () => loadPublicRuleBundle(dataDir),
    (error: unknown) => (error as { code?: string }).code === 'file_hash_mismatch'
  );
});

test(
  'compiled production module loads the bundled public rules from a cwd outside the repository',
  {
    skip: existsSync(path.join(appRoot, 'dist', 'server', 'platforms', 'catalog.js'))
      ? false
      : 'run `npm --prefix apps/web run build` first'
  },
  async (t) => {
    const distDir = path.join(appRoot, 'dist');
    assert.ok(
      existsSync(path.join(distDir, 'data', 'platforms', 'public-rules', 'manifest.json')),
      'npm run build must copy the public-rule bundle into dist'
    );
    const workDir = mkdtempSync(path.join(tmpdir(), 'public-rules-copy-'));
    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    const copyRoot = path.join(workDir, 'copied-build');
    const cwdDir = path.join(workDir, 'elsewhere');
    mkdirSync(cwdDir, { recursive: true });
    cpSync(distDir, path.join(copyRoot, 'dist'), { recursive: true });

    const script = `
      const catalog = await import(${JSON.stringify(`file://${path.join(copyRoot, 'dist', 'server', 'platforms', 'catalog.js')}`)});
      const rules = await import(${JSON.stringify(`file://${path.join(copyRoot, 'dist', 'server', 'platforms', 'public-rules.js')}`)});
      const dataDir = catalog.defaultCatalogDataDir();
      const snapshot = catalog.loadPlatformCatalog(dataDir);
      const bundle = rules.loadPublicRuleBundle(dataDir);
      const summary = catalog.catalogSummary(snapshot);
      console.log(JSON.stringify({
        dataDir,
        summary,
        bundleCounts: bundle.counts
      }));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: cwdDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, `copied build failed to load normalized rules: ${stderr}`);

    const result = JSON.parse(stdout.trim()) as {
      dataDir: string;
      summary: { platformCount: number; publicRuleSourceRows: number; publicRuleCount: number; unionPlatformCount: number };
      bundleCounts: { sourceRows: number; loaded: number; excluded: number };
    };
    assert.ok(
      result.dataDir.startsWith(copyRoot),
      `production must read bundled rules inside the copied build, got ${result.dataDir}`
    );
    assert.equal(result.bundleCounts.sourceRows, 6923);
    assert.equal(result.bundleCounts.sourceRows, result.bundleCounts.loaded + result.bundleCounts.excluded);
    assert.equal(result.summary.publicRuleSourceRows, 6923);
    assert.equal(result.summary.publicRuleCount, result.bundleCounts.loaded);
    assert.ok(result.summary.unionPlatformCount > 4000, 'the copied production build sees the full union');
    assert.ok(result.summary.platformCount > 4000, 'composed catalog includes the union entries');
  }
);
