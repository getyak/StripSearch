import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestServer } from './harness.js';

test('root serves the current index from a hidden checkout directory', async (t) => {
  const clientDir = mkdtempSync(path.join(tmpdir(), '.stripsearch-client-'));
  writeFileSync(path.join(clientDir, 'index.html'), '<main>first build</main>');
  const server = await startTestServer({ clientDir });
  t.after(async () => { await server.close(); rmSync(clientDir, { recursive: true }); });
  const first = await fetch(server.baseUrl);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.match(await first.text(), /first build/);
  writeFileSync(path.join(clientDir, 'index.html'), '<main>next build</main>');
  const next = await fetch(server.baseUrl, { headers: { 'If-None-Match': first.headers.get('etag')! } });
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('cache-control'), 'no-store');
  assert.match(await next.text(), /next build/);
});

test('document entrypoints and release metadata stay fresh while assets retain caching', async (t) => {
  const clientDir = mkdtempSync(path.join(tmpdir(), '.stripsearch-cache-'));
  mkdirSync(path.join(clientDir, 'assets'));
  writeFileSync(path.join(clientDir, 'index.html'), '<main>current release</main>');
  writeFileSync(path.join(clientDir, 'release.json'), JSON.stringify({ revision: 'first-revision' }));
  writeFileSync(path.join(clientDir, 'assets', 'index-fixture.css'), 'body { color: green; }');
  const server = await startTestServer({ clientDir });
  t.after(async () => { await server.close(); rmSync(clientDir, { recursive: true }); });

  for (const pathname of ['/', '/index.html', '/workspace/report', '/release.json']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(server.baseUrl + pathname, { method });
      assert.equal(response.status, 200, `${method} ${pathname}`);
      assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${pathname}`);
      await response.arrayBuffer();
    }
  }
  const first = await fetch(server.baseUrl + '/release.json');
  assert.deepEqual(await first.json(), { revision: 'first-revision' });
  writeFileSync(path.join(clientDir, 'release.json'), JSON.stringify({ revision: 'new-release-revision' }));
  const next = await fetch(server.baseUrl + '/release.json', {
    headers: { 'If-None-Match': first.headers.get('etag')! }
  });
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await next.json(), { revision: 'new-release-revision' });

  const asset = await fetch(server.baseUrl + '/assets/index-fixture.css');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await asset.text(), /color: green/);
});

test('closed native drawers have an explicit author-level display rule', () => {
  const css = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');
  // jsdom UA cascade cannot reproduce Safari display:flex overriding native dialog hiding.
  assert.match(css, /dialog:not\(\[open\]\)\s*\{\s*display:\s*none;/);
});
