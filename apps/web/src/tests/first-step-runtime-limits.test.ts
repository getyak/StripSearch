import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { Runner } from '../server/services/runner.js';
import { createFirstStepCheckedSearch } from '../server/research/first-step-discovery.js';
import { FIRST_STEP_DEFAULT_BUDGET } from '../shared/first-step-discovery.js';
import type { ResearchBudgetLimits } from '../shared/types.js';
import type { AppConfig } from '../server/config.js';
import { waitFor } from './harness.js';

function memoryRun() {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const run = store.insertRun({ ownerId: 'synthetic-limits', question: 'Lin Zhou', seedUrl: null, provider: 'research',
    parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'limits' });
  firstStep.attachRun(run);
  return { db, store, firstStep, run };
}

test('first-step deadline aborts actual pending discovery and preserves actionable state', async (t) => {
  const fixture = memoryRun();
  t.after(() => fixture.db.close());
  const limits: ResearchBudgetLimits = { toolCalls: 8, modelCalls: 2, inputTokens: 100000, outputTokens: 5000, elapsedMs: 25 };
  let calls = 0;
  let aborted = false;
  const runner = new Runner({ ...fixture, config: { researchLimits: limits, exaApiKey: 'synthetic', deepseekApiKey: null } as AppConfig,
    researchTools: { async execute(_action, signal) {
      calls++;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { aborted = true; reject(signal.reason); return; }
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      });
      throw new Error('The pending tool cannot finish after abortion');
    } }, providerFactory: () => { throw new Error('unexpected legacy provider'); }, transport: (async () => { throw new Error('no network'); }) as never });
  t.after(() => runner.stopAll());
  runner.enqueue(fixture.run.id);
  await waitFor(() => runner.activeCount() === 0 && fixture.store.getRun(fixture.run.id)?.state === 'needs_input');
  const after = fixture.store.getRun(fixture.run.id)!;
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal(after.stopReason, 'budget_exhausted');
  assert.deepEqual(fixture.store.research.checkpoint(after.id)?.limits, limits);
  assert.equal(fixture.store.buildCanonicalView(after).sources.length, 0);
  assert.match(fixture.firstStep.getFirstStepView(after.ownerId, after.id)!.mode, /first_step/);
});

test('model token reservation blocks dispatch before a configured token ceiling is crossed', async (t) => {
  const fixture = memoryRun();
  t.after(() => fixture.db.close());
  fixture.store.updateRun(fixture.run.id, { state: 'researching' });
  const search = createFirstStepCheckedSearch({ store: fixture.store, runId: fixture.run.id, attemptId: 'synthetic',
    tools: { async execute() { throw new Error('not a tool test'); } }, budget: FIRST_STEP_DEFAULT_BUDGET,
    limits: { toolCalls: 8, modelCalls: 2, inputTokens: 100, outputTokens: 10, elapsedMs: 0 } });
  let calls = 0;
  await assert.rejects(search.withModel('model-reservation', async () => { calls++; return { proposals: [] }; },
    { inputTokens: 101, outputTokens: 1200 }), /budget_exhausted/);
  assert.equal(calls, 0);
  assert.equal(fixture.store.research.receipts(fixture.run.id).length, 0);
});
