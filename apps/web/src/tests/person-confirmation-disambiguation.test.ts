import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { PersonConfirmationStore } from '../server/research/person-confirmation.js';
import { createFirstStepCheckedSearch, discoverFirstStep } from '../server/research/first-step-discovery.js';
import { Runner } from '../server/services/runner.js';
import type { AppConfig } from '../server/config.js';
import type { ResearchTools } from '../server/research/tool-contracts.js';
import { excerptAroundLabel, FIRST_STEP_OVERVIEW_BUDGET, type PersonCandidateView } from '../shared/person-confirmation.js';
import { waitFor } from './harness.js';

function fixture(query: string) {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db), firstStep = new FirstStepStore(db, store);
  const persons = new PersonConfirmationStore(db, store, firstStep);
  const run = store.insertRun({ ownerId: 'disambiguation-owner', question: query, seedUrl: null,
    provider: 'research', parentRunId: null, retryOf: null, followup: false,
    idempotencyKey: null, bodyFingerprint: 'synthetic-disambiguation' });
  firstStep.attachRun(run);
  return { db, store, firstStep, persons, run };
}

function toolsFor(documents: Array<{ url: string; text: string }>): ResearchTools {
  return { async execute(action) {
    const docs = action.type === 'search' ? documents : documents.filter(d => d.url === action.url);
    return { pages: docs.map(d => ({ ...d, title: 'Mira Kepler', kind: 'profile' as const,
      publishedAt: null, links: [], limitations: [] })), requests: 1, bytes: 200,
      estimatedUsd: 0, credits: null, limitations: [] };
  } };
}

async function overview(f: ReturnType<typeof fixture>, tools: ResearchTools) {
  return discoverFirstStep({ store: f.store, firstStep: f.firstStep, ownerId: f.run.ownerId,
    runId: f.run.id, input: { kind: 'name_query', value: f.run.question },
    search: createFirstStepCheckedSearch({ store: f.store, runId: f.run.id, tools,
      attemptId: 'input-1', stage: 'overview', budget: FIRST_STEP_OVERVIEW_BUDGET }), stage: 'overview',
    signal: new AbortController().signal, registryVersion: 'synthetic', catalog: null });
}

for (const directory of ['staff', 'wiki']) test(`same-name ${directory} pages on one host remain independently selectable people`, async t => {
  const f = fixture('Mira Kepler');t.after(() => f.db.close());
  const documents = [
    { url: `https://profiles.lantern.dev/${directory}/mira-compiler`, text: 'Mira Kepler researches compilers.' },
    { url: `https://profiles.lantern.dev/${directory}/mira-marine`, text: 'Mira Kepler researches marine biology.' }
  ];
  const view = await overview(f, toolsFor(documents));
  assert.equal(view.personOverview?.candidates.length, 2, 'A shared website does not prove the same person');
  assert.equal(new Set(view.personOverview!.candidates.map(c => c.candidateId)).size, 2);
  for (const document of documents) {
    const candidate: PersonCandidateView | undefined = view.personOverview!.candidates.find(c => c.sources.some(s => s.url === document.url));
    assert.ok(candidate);
    assert.equal(candidate.sources.length, 1, 'A different person original cannot enter this candidate');
    assert.equal(candidate.sources[0]!.retrieval, 'read');
    assert.equal(candidate.sources[0]!.quote, document.text);
    assert.ok(!candidate.descriptors.some(d => d.statement.includes(document.url.endsWith('marine') ? 'compilers' : 'marine biology')));
  }
});

for (const separator of [' / ', ' ／ ']) test(`supplied bilingual names with ${separator.trim()} retain an original matching either name`, async t => {
  const f = fixture('Mira Kepler' + separator + '米拉·开普勒');t.after(() => f.db.close());
  const original = { url: 'https://lantern.dev/people/mira', text: 'Mira Kepler researches compilers.' };
  const view = await overview(f, toolsFor([original]));
  assert.equal(view.personOverview?.status, 'awaiting_confirmation');
  assert.equal(view.personOverview?.candidates.length, 1);
  assert.equal(view.personOverview!.candidates[0]!.sources[0]!.quote, original.text);
  assert.equal(view.personOverview!.queryLabel, f.run.question, 'The displayed user input remains intact');
});

test('bilingual original excerpts locate an actually supplied name without inventing the combined label', () => {
  const text = '背景。米拉·开普勒研究编译器。另一个人。';
  assert.deepEqual(excerptAroundLabel(text, 'Mira Kepler / 米拉·开普勒'), {
    quote: '米拉·开普勒研究编译器。', locator: '原文第 4–15 字符'
  });
});

test('real configured Runner enables Search Agent after overview and replays its frozen account strategy', { timeout: 30000 }, async t => {
  const f = fixture('Mira Kepler');t.after(() => f.db.close());
  let blockedModelCalls = 0;
  const runner = new Runner({ store: f.store, firstStep: f.firstStep, personConfirmation: f.persons,
    config: { researchLimits: { toolCalls: 40, modelCalls: 8, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 },
      exaApiKey: 'synthetic', deepseekApiKey: 'synthetic', firecrawlApiKey: null,
      tikhubApiKey: null, githubToken: null } as AppConfig,
    providerFactory: () => { throw new Error('Unexpected legacy provider'); },
    transport: { async fetch() { blockedModelCalls++; throw new Error('Synthetic rejecting transport; no network'); } },
    researchTools: toolsFor([{ url: 'https://lantern.dev/', text: 'Mira Kepler researches compilers.' }]) });
  t.after(() => runner.stopAll());
  const advance = async () => { runner.enqueue(f.run.id);await waitFor(() => runner.activeCount() === 0 && f.store.getRun(f.run.id)?.state === 'needs_input', 30000); };
  await advance();assert.equal(blockedModelCalls, 0, 'Overview has no model calls');
  const pending = f.firstStep.getFirstStepView(f.run.ownerId, f.run.id)!;
  assert.equal(pending.mode, 'first_step');if (pending.mode !== 'first_step') throw new Error('Wrong flow');
  f.persons.applyConfirmation(f.run.ownerId, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: pending.view.selection.scopeVersion,
    discoveryRevision: pending.view.discoveryRevision,
    candidateId: pending.view.personOverview!.candidates[0]!.candidateId
  }, 'confirm-agent-person');
  await advance();
  const marker = f.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='first_step_strategy'").get(f.run.id) as { payload_json: string };
  assert.equal(JSON.parse(marker.payload_json).agent, true, 'Overview receipts must not freeze a new account phase to the old proposer');
  const models = f.store.research.receipts(f.run.id).filter(r => r.kind === 'model');
  assert.equal(models.length, 1);assert.match(models[0]!.key, /:v11:agent:/);
  assert.equal(blockedModelCalls, 1);
  f.store.updateRun(f.run.id, { state: 'queued' });await advance();
  assert.equal(blockedModelCalls, 1, 'Restart never repays the settled agent request');
  assert.deepEqual(f.store.research.receipts(f.run.id).filter(r => r.kind === 'model'), models);
});
