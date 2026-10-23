import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { createFirstStepCheckedSearch } from '../server/research/first-step-discovery.js';
import { FIRST_STEP_DEFAULT_BUDGET } from '../shared/first-step-discovery.js';
import { startTestServer, waitFor } from './harness.js';
import type { FirstStepDiscoveryView } from '../shared/first-step-discovery.js';

function recoveryStore(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:'); applyCoreSchema(db); t.after(() => db.close());
  const store = new Store(db); const firstStep = new FirstStepStore(db, store);
  const make = (linked: boolean, state: 'queued' | 'researching' = 'researching') => {
    const run = store.insertRun({ ownerId: 'synthetic-startup', question: 'Synthetic recovery', seedUrl: null, provider: 'research', parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'startup-metadata' });
    if (linked) firstStep.attachRun(run);
    store.updateRun(run.id, { state }); return run;
  };
  const action = (runId: string, key: string, state: 'completed' | 'failed' | 'inflight') => {
    store.research.reserve(runId, key, 'tool', { type: 'search', query: 'Synthetic public material', numResults: 1 }, { inputTokens: 11, outputTokens: 7 });
    if (state !== 'inflight') store.research.settle(runId, key, { retained: true }, { inputTokens: 11, outputTokens: 7, estimatedUsd: state === 'failed' ? null : 0.01, bytes: 123, unknownCost: state === 'failed' }, state);
  };
  const snapshot = () => db.prepare('SELECT * FROM research_actions ORDER BY run_id,action_key').all();
  return { db, store, make, action, snapshot };
}

test('startup recovery requeues settled first-step actions without decoding large unrelated receipt JSON', t => {
  const f = recoveryStore(t); const runs = ['queued', 'researching'].map(state => f.make(true, state as 'queued' | 'researching'));
  const columns = ['request_json', 'result_json', 'usage_json'] as const;
  for (const run of runs) for (const state of ['completed', 'failed'] as const) for (const column of columns) f.action(run.id, `${state}-${column}`, state);
  const unrelated = '{"unused":"' + 'x'.repeat(256 * 1024);
  for (const run of runs) for (const state of ['completed', 'failed']) for (const column of columns) f.db.prepare(`UPDATE research_actions SET ${column}=? WHERE run_id=? AND action_key=?`).run(unrelated, run.id, `${state}-${column}`);
  const before = f.snapshot(); assert.equal(f.store.recoverInterruptedRuns(), 0);
  for (const run of runs) { const restored = f.store.getRun(run.id)!; assert.equal(restored.state, 'queued'); assert.equal(restored.interrupted, true); assert.notEqual(restored.stopReason, 'unknown_inflight'); assert.equal(f.store.listEvents(run.id).filter(event => event.type === 'interrupted').length, 0); }
  assert.deepEqual(f.snapshot(), before, 'receipt state, raw payload bytes, usage, reservations and settlement metadata stay unchanged');
});

test('startup recovery blocks first-step inflight requests without decoding or changing their receipts', t => {
  const f = recoveryStore(t); const run = f.make(true); f.action(run.id, 'settled', 'completed'); f.action(run.id, 'unresolved', 'inflight');
  const unrelated = '{"unused":"' + 'x'.repeat(256 * 1024);
  f.db.prepare('UPDATE research_actions SET request_json=?,result_json=?,usage_json=? WHERE run_id=?').run(unrelated, unrelated, unrelated, run.id);
  const before = f.snapshot(); assert.equal(f.store.recoverInterruptedRuns(), 1); const restored = f.store.getRun(run.id)!;
  assert.equal(restored.state, 'partial'); assert.equal(restored.stopReason, 'unknown_inflight'); assert.equal(restored.errorCode, 'interrupted'); assert.equal(restored.interrupted, true); assert.equal(restored.errorMessage, '上次调用的计费结果不明，已保留材料；不会自动重复调用。');
  assert.equal(f.store.listEvents(run.id).filter(event => event.type === 'interrupted').length, 1); assert.equal(f.store.recoverInterruptedRuns(), 0); assert.deepEqual(f.snapshot(), before);
});

test('startup legacy recovery blocks every non-completed state and requeues completed-only runs with or without the first-step table', t => {
  for (const table of ['present', 'absent']) {
    const f = recoveryStore(t); if (table === 'absent') f.db.exec('DROP TABLE first_step_links');
    const runs = ['completed', 'failed', 'inflight', 'unrecognized_state'].map(state => { const run = f.make(false); f.action(run.id, 'action', state === 'unrecognized_state' ? 'failed' : state as 'completed' | 'failed' | 'inflight'); if (state === 'unrecognized_state') f.db.prepare('UPDATE research_actions SET state=? WHERE run_id=?').run(state, run.id); return { run, state }; });
    const empty = f.make(false, 'queued'); const unrelated = '{"unused":"' + 'x'.repeat(256 * 1024);
    f.db.prepare('UPDATE research_actions SET request_json=?,result_json=?,usage_json=?').run(unrelated, unrelated, unrelated); const before = f.snapshot();
    assert.equal(f.store.recoverInterruptedRuns(), 3, table);
    for (const { run, state } of runs) { const restored = f.store.getRun(run.id)!; assert.equal(restored.state, state === 'completed' ? 'queued' : 'partial', `${table}: ${state}`); assert.equal(restored.interrupted, true); assert.equal(restored.stopReason, state === 'completed' ? null : 'unknown_inflight'); assert.equal(f.store.listEvents(run.id).filter(event => event.type === 'interrupted').length, state === 'completed' ? 0 : 1); }
    assert.equal(f.store.getRun(empty.id)!.state, 'queued'); assert.deepEqual(f.snapshot(), before, 'legacy recovery never rewrites receipts or unknown cost metadata');
  }
});

test('first-step recovery distinguishes a settled failure from an unresolved inflight request', async (t) => {
  const db = openDatabase(':memory:'); applyCoreSchema(db); t.after(() => db.close());
  const store = new Store(db); const firstStep = new FirstStepStore(db, store);
  const make = () => {
    const run = store.insertRun({ ownerId: 'synthetic-recovery', question: 'Lin Zhou', seedUrl: null, provider: 'research', parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'recovery' });
    firstStep.attachRun(run); store.updateRun(run.id, { state: 'researching' }); return run;
  };
  const settled = make();
  const action = { type: 'search', query: 'Lin Zhou', numResults:12 };
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
  // GET-213: confirm the source-backed person before the account scope step.
  const overview = await server.client.json<{ view: FirstStepDiscoveryView; runRevision: number }>(`/api/runs/${retryId}/first-step/discovery`);
  assert.equal((await server.client.json(`/api/runs/${retryId}/first-step/person-confirmation`, {
    json: {
      expectedRunRevision: overview.body.runRevision,
      expectedScopeVersion: overview.body.view.selection.scopeVersion,
      discoveryRevision: overview.body.view.discoveryRevision,
      candidateId: overview.body.view.personOverview!.candidates[0]!.candidateId
    },
    headers: { 'idempotency-key': 'retry-confirm-1' }
  })).status, 200);
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
