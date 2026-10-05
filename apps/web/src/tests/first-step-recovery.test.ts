import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { createFirstStepCheckedSearch } from '../server/research/first-step-discovery.js';
import { FIRST_STEP_DEFAULT_BUDGET } from '../shared/first-step-discovery.js';
import { startTestServer, waitFor } from './harness.js';
import type { FirstStepDiscoveryView } from '../shared/first-step-discovery.js';

test('first-step recovery distinguishes a settled failure from an unresolved inflight request', async (t) => {
  const db = openDatabase(':memory:'); applyCoreSchema(db); t.after(() => db.close());
  const store = new Store(db); const firstStep = new FirstStepStore(db, store);
  const make = () => {
    const run = store.insertRun({ ownerId: 'synthetic-recovery', question: 'Lin Zhou', seedUrl: null, provider: 'research', parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'recovery' });
    firstStep.attachRun(run); store.updateRun(run.id, { state: 'researching' }); return run;
  };
  const settled = make();
  const action = { type: 'search', query: 'Lin Zhou' };
  store.research.reserve(settled.id, 'failed-read', 'tool', action, { inputTokens: 0, outputTokens: 0 });
  store.research.settle(settled.id, 'failed-read', null, { estimatedUsd: null, unknownCost: true }, 'failed');
  const unresolved = make();
  store.research.reserve(unresolved.id, 'pending-read', 'tool', action, { inputTokens: 0, outputTokens: 0 });
  assert.equal(store.recoverInterruptedRuns(), 1);
  assert.equal(store.getRun(settled.id)?.state, 'queued');
  assert.notEqual(store.getRun(settled.id)?.stopReason, 'unknown_inflight');
  assert.equal(store.getRun(unresolved.id)?.stopReason, 'unknown_inflight');
  assert.equal(store.research.reserve(settled.id, 'failed-read', 'tool', action, { inputTokens: 0, outputTokens: 0 }, undefined, true)?.state, 'failed');
  let calls = 0;
  const search = createFirstStepCheckedSearch({ store, runId: settled.id, attemptId: 'synthetic', budget: FIRST_STEP_DEFAULT_BUDGET,
    tools: { async execute() { calls++; throw new Error('must not replay'); } } });
  await assert.rejects(search.search('failed-read', 'Lin Zhou', 12, new AbortController().signal), /已结算失败/);
  assert.equal(calls, 0);
  assert.equal(search.receipts()[0]?.state, 'failed');
  assert.equal(store.research.receipts(settled.id).length, 1);
});

test('retry API preserves first-step discovery and a submitted frozen scope', async (t) => {
  const home = 'https://fixture-linzhou.org/'; const github = 'https://github.com/fixture-linzhou';
  const server = await startTestServer({ researchTools: { async execute(action) {
    const url = action.type === 'search' ? home : action.url;
    return { pages: [{ url, title: 'Lin Zhou', text: url === home ? `My GitHub: ${github}.` : 'Lin Zhou writes compilers.', kind: 'profile', publishedAt: null, links: url === home ? [github] : [], limitations: [], retrieval: action.type === 'search' ? 'search' : 'read' }], requests: 1, bytes: 100, estimatedUsd: 0, credits: null, limitations: [] };
  } }, researchPlanner: { async decide() { return { action: 'finish', claims: [], unknowns: ['synthetic limited scope'] }; } } },
  { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' });
  t.after(() => server.close()); await server.client.signUp('retry-first-step@example.test');
  const made = await server.client.json<{ run: { runId: string } }>('/api/runs', { json: { input: 'Lin Zhou' } });
  const firstId = made.body.run.runId; await waitFor(() => server.store.getRun(firstId)?.state === 'needs_input');
  await server.client.json(`/api/runs/${firstId}/cancel`, { json: {} });
  const retried = await server.client.json<{ run: { runId: string } }>(`/api/runs/${firstId}/retry`, { json: {} });
  assert.equal(retried.status, 201); const retryId = retried.body.run.runId;
  await waitFor(() => server.store.getRun(retryId)?.state === 'needs_input');
  const discovery = await server.client.json<{ mode: string; view: FirstStepDiscoveryView; runRevision: number }>(`/api/runs/${retryId}/first-step/discovery`);
  assert.equal(discovery.body.mode, 'first_step');
  assert.ok(discovery.body.view.discoveryRevision > 0);
  const view = discovery.body.view;
  const chosen = view.accounts.find(account => account.profileUrl === github)!;
  assert.ok(chosen); const cluster = view.clusters.find(item => item.accountIds.includes(chosen.accountId))!;
  const selected = await server.client.json(`/api/runs/${retryId}/first-step/selection`, { json: { expectedRunRevision: discovery.body.runRevision, expectedScopeVersion: view.selection.scopeVersion, discoveryRevision: view.discoveryRevision, clusterId: cluster.clusterId, accounts: view.accounts.map(account => ({ accountId: account.accountId, selection: account.accountId === chosen.accountId ? 'selected' : 'not_selected', excluded: false })) } });
  assert.equal(selected.status, 200);
  await waitFor(() => server.store.getRun(retryId)?.state === 'partial');
  const binding = server.store.research.checkpoint(retryId)!.firstStep!;
  const again = await server.client.json<{ run: { runId: string } }>(`/api/runs/${retryId}/retry`, { json: {} });
  assert.equal(again.status, 201);
  const nextId = again.body.run.runId;
  assert.deepEqual(server.store.research.checkpoint(nextId)!.firstStep, binding);
  assert.equal(server.store.getRun(nextId)?.retryOf, retryId);
  await waitFor(() => server.store.getRun(nextId)?.state === 'partial');
});
