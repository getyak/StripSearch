import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { HttpTransport } from '../server/adapters/types.js';
import type { ResearchTools } from '../server/research/tool-contracts.js';
import { offlineTestTransport, startTestServer, waitFor, type TestServer } from './harness.js';

const providerKeys = ['GITHUB_TOKEN', 'EXA_API_KEY', 'DEEPSEEK_API_KEY', 'FIRECRAWL_API_KEY', 'TIKHUB_API_KEY'] as const;
const fakeEnv = Object.fromEntries(providerKeys.map(key => [key, `synthetic-${key.toLowerCase()}`]));
const tools: ResearchTools = { async execute(action) {
  const url = action.type === 'search' ? 'https://synthetic-offline.dev/' : action.url;
  return { pages: [{ url, title: 'Mira Offline', text: '<p>Mira Offline builds synthetic compilers.</p>', kind: 'profile',
    publishedAt: null, links: [], limitations: [], retrieval: action.type === 'search' ? 'search' : 'read' }],
    requests: 1, bytes: 100, estimatedUsd: 0, credits: null, limitations: [] };
} };

/** Ultimate backstop makes the pre-fix regression safe: only the test HTTP server may use fetch. */
function guardGlobalFetch(t: TestContext) {
  const fetch = globalThis.fetch.bind(globalThis);
  const external: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      external.push(url.origin);
      throw new Error('synthetic global backstop: external fetch blocked');
    }
    return fetch(input, init);
  });
  return external;
}
async function startDiscovery(server: TestServer) {
  assert.equal((await server.client.signUp('offline-harness@example.test')).status, 200);
  const created = await server.client.json<{ run: { runId: string } }>('/api/runs', { json: { input: 'Mira Offline' } });
  assert.equal(created.status, 201);
  const runId = created.body.run.runId;
  // This regression includes the real isolated DSH worker startup. Existing
  // workflow waitFor deadlines remain unchanged; this test bounds that worker.
  await waitFor(() => server.store.getRun(runId)?.state === 'needs_input' && server.boot.runner.activeCount() === 0, 30_000);
  // GET-213 staged name flow: the real first-step model role runs in the
  // account stage, so confirm the source-backed person first.
  const overview = await server.client.json<{ view: { personOverview: { candidates: Array<{ candidateId: string }> } | null; personConfirmation: { required: boolean } | null; selection: { scopeVersion: number }; discoveryRevision: number }; runRevision: number }>(`/api/runs/${runId}/first-step/discovery`);
  assert.equal(overview.body.view.personConfirmation?.required, true);
  assert.equal((await server.client.json(`/api/runs/${runId}/first-step/person-confirmation`, {
    json: {
      expectedRunRevision: overview.body.runRevision,
      expectedScopeVersion: overview.body.view.selection.scopeVersion,
      discoveryRevision: overview.body.view.discoveryRevision,
      candidateId: overview.body.view.personOverview!.candidates[0]!.candidateId
    },
    headers: { 'idempotency-key': 'offline-harness-confirm' }
  })).status, 200);
  await waitFor(() => server.store.getRun(runId)?.state === 'needs_input' && server.boot.runner.activeCount() === 0, 30_000);
  return runId;
}
function credentials(server: TestServer) {
  const config = server.boot.config;
  return [config.githubToken, config.exaApiKey, config.deepseekApiKey, config.firecrawlApiKey, config.tikhubApiKey];
}
function finishedDecision(): Response {
  const events = [
    { type: 'message_start', message: { id: 'synthetic-offline', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'synthetic-tool', name: 'submit_decision', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ decision: { action: 'finish', proposals: [], leads: [] } }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' }
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('offline harness rejects first-step model transport by default, including explicit undefined', { timeout: 40_000 }, async t => {
  const external = guardGlobalFetch(t);
  let denied = 0;
  const reject = offlineTestTransport.fetch.bind(offlineTestTransport);
  t.mock.method(offlineTestTransport, 'fetch', async (...args: Parameters<HttpTransport['fetch']>) => { denied++; return reject(...args); });
  const server = await startTestServer({ transport: undefined, researchTools: tools, discoveryCatalog: null }, fakeEnv);
  t.after(() => server.close());
  const runId = await startDiscovery(server);
  const model = server.store.research.receipts(runId).filter(receipt => receipt.kind === 'model');
  assert.equal(denied, 1, 'the real Search Agent must reach the default rejecting transport once');
  assert.deepEqual(external, [], 'no provider request may reach global fetch');
  assert.equal(model.length, 1);
  assert.equal(model[0]!.state, 'failed', 'the rejected model call is settled, never an unknown inflight request');
});

test('offline harness discards all inherited provider credentials before applying explicit fixture overrides', async t => {
  const external = guardGlobalFetch(t);
  const previous = new Map(providerKeys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of providerKeys) process.env[key] = `inherited-synthetic-${key}`;
  const clean = await startTestServer({ discoveryCatalog: null });
  t.after(() => clean.close());
  assert.deepEqual(credentials(clean), [null, null, null, null, null]);
  const explicit = await startTestServer({ discoveryCatalog: null }, fakeEnv);
  t.after(() => explicit.close());
  assert.deepEqual(credentials(explicit), providerKeys.map(key => fakeEnv[key]));
  assert.deepEqual(external, []);
});

test('offline harness preserves an explicitly injected synthetic model transport on the real first-step route', { timeout: 40_000 }, async t => {
  const external = guardGlobalFetch(t);
  let calls = 0;
  const transport: HttpTransport = { async fetch(url, init) {
    assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(init?.method, 'POST');
    calls++;
    return finishedDecision();
  } };
  const server = await startTestServer({ transport, researchTools: tools, discoveryCatalog: null }, fakeEnv);
  t.after(() => server.close());
  const runId = await startDiscovery(server);
  const model = server.store.research.receipts(runId).filter(receipt => receipt.kind === 'model');
  assert.equal(calls, 1);
  assert.deepEqual(external, []);
  assert.equal(model.length, 1);
  assert.equal(model[0]!.state, 'completed');
  assert.deepEqual(model[0]!.usage && { inputTokens: model[0]!.usage.inputTokens, outputTokens: model[0]!.usage.outputTokens }, { inputTokens: 20, outputTokens: 10 });
});
