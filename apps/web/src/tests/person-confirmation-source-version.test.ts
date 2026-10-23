import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { PersonConfirmationStore } from '../server/research/person-confirmation.js';
import { FIRST_STEP_DEFAULT_BUDGET, type FirstStepInput } from '../shared/first-step-discovery.js';
import { createFirstStepCheckedSearch, discoverFirstStep, firstStepAttemptId } from '../server/research/first-step-discovery.js';
import type { ResearchTools } from '../server/research/tool-contracts.js';

test('a new attempt can confirm an updated original without rewriting earlier source receipts', async (t) => {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  t.after(() => db.close());
  const store = new Store(db);
  const ownerId = 'synthetic-source-version-owner';
  const run = store.insertRun({ ownerId, question: '林舟', seedUrl: null, provider: 'research', parentRunId: null,
    retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'synthetic-source-version' });
  const firstStep = new FirstStepStore(db, store);
  const persons = new PersonConfirmationStore(db, store, firstStep);
  const input: FirstStepInput = { kind: 'name_query', value: '林舟' };
  const url = 'https://synthetic-campus.dev/people/lin-zhou';
  let original = '林舟维护旧版排版工具。';
  const tools: ResearchTools = {
    async execute(action) {
      return { pages: [{ url, title: '林舟：研究员', text: action.type === 'search' ? '原创合成索引摘要' : original,
        kind: 'profile', publishedAt: null, links: [], limitations: [] }], requests: 1, bytes: 100,
      estimatedUsd: null, credits: null, limitations: [] };
    }
  };
  const discover = async (hint: string | null) => {
    store.updateRun(run.id, { state: 'researching' });
    const link = firstStep.attachRun({ id: run.id, ownerId, question: run.question });
    const search = createFirstStepCheckedSearch({ tools, store, runId: run.id,
      attemptId: firstStepAttemptId(link, input, hint), budget: FIRST_STEP_DEFAULT_BUDGET, stage: 'overview' });
    const view = await discoverFirstStep({ store, firstStep, ownerId, runId: run.id, input, search,
      signal: new AbortController().signal, registryVersion: 'synthetic-source-version/v1', stage: 'overview', hint });
    store.updateRun(run.id, { state: 'needs_input', revision: store.getRun(run.id)!.revision + 1 });
    return view;
  };
  const previous = await discover(null);
  const oldReceipts = store.research.receipts(run.id).map((receipt) => JSON.stringify(receipt));
  firstStep.applyFirstStepExpand(ownerId, run.id, '补充机构线索', 'synthetic-source-version-expand');
  original = '林舟现在研究新版编译器。';
  const current = await discover('补充机构线索');
  assert.notEqual(previous.personOverview!.candidates[0]!.sources[0]!.contentHash,
    current.personOverview!.candidates[0]!.sources[0]!.contentHash);
  const result = persons.applyConfirmation(ownerId, run.id, {
    expectedRunRevision: store.getRun(run.id)!.revision,
    expectedScopeVersion: current.selection.scopeVersion,
    discoveryRevision: current.discoveryRevision,
    candidateId: current.personOverview!.candidates[0]!.candidateId
  }, 'synthetic-source-version-confirm');
  assert.equal(result.idempotent, false);
  const retained = new Set(store.research.receipts(run.id).map((receipt) => JSON.stringify(receipt)));
  assert.ok(oldReceipts.every((receipt) => retained.has(receipt)), 'earlier receipts remain byte-for-byte intact');
});
