import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiError } from '../client/api.js';
import { installFetch, jsonResponse } from './dom-env.js';

test('person entry sends one raw input and reuses a supplied idempotency key', async () => {
  const requests: { url: string; body: unknown; key: string | null }[] = [];
  installFetch((url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') });
    return jsonResponse({ run: { runId: 'same-run' }, idempotent: requests.length > 1 });
  });
  const api = new ApiClient();
  await api.createResearch('https://example.org/person/synthetic', 'one-intent');
  await api.createResearch('https://example.org/person/synthetic', 'one-intent');
  assert.deepEqual(requests.map(r => r.body), [{ input: 'https://example.org/person/synthetic' }, { input: 'https://example.org/person/synthetic' }]);
  assert.ok(requests.every(r => r.url === '/api/runs' && r.key === 'one-intent'));
});

test('PDF export retains binary bytes and pins the requested revision', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 128, 10]);
  let requested = '';
  installFetch(url => { requested = url; return new Response(bytes, { headers: { 'content-type': 'application/pdf' } }); });
  const blob = await new ApiClient().exportBlob('run/a', 'pdf', 4);
  assert.match(requested, /run%2Fa\/export\?format=pdf&revision=4$/);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(blob.type, 'application/pdf');
});

test('export preserves the typed unavailable error for a readable recovery message', async () => {
  installFetch(() => jsonResponse({ error: { code: 'pdf_unavailable', message: 'PDF 暂时不可用，请下载 HTML。' } }, 503));
  await assert.rejects(new ApiClient().exportBlob('r', 'pdf', 2), (error: unknown) => error instanceof ApiError && error.code === 'pdf_unavailable' && error.message.includes('HTML'));
});
