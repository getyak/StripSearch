import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { runResearch } from '../server/research/controller.js';
import { renderJson } from '../shared/canonical.js';
import type { CanonicalView } from '../shared/types.js';
import type { ResearchPage } from '../server/research/tool-contracts.js';

test('withdrawing an earlier source preserves surviving Person Object references', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  applyCoreSchema(db);
  const store = new Store(db);
  const run = store.insertRun({
    ownerId: 'synthetic-owner', question: 'Synthetic reference stability',
    seedUrl: 'https://github.com/ada-fixture', provider: 'research',
    parentRunId: null, retryOf: null, followup: false,
    idempotencyKey: null, bodyFingerprint: 'reference-stability'
  });
  const first: ResearchPage = {
    url: 'https://fixture.test/first', title: 'First synthetic work',
    text: 'The first synthetic work is a compiler experiment.', kind: 'third_party',
    publishedAt: null, links: [], limitations: []
  };
  const second: ResearchPage = {
    ...first, url: 'https://fixture.test/second', title: 'Second synthetic work',
    text: 'The second synthetic work is a parser experiment.'
  };
  const profile: ResearchPage = {
    url: run.seedUrl!, title: 'Synthetic Ada', text: 'Synthetic Ada builds compilers.',
    kind: 'profile', publishedAt: null, links: [first.url, second.url], limitations: [],
    account: { platform: 'github', handle: 'ada-fixture', id: 'synthetic-ada', profileUrl: run.seedUrl! }
  };
  let decisions = 0;
  let requests = 0;
  const result = await runResearch({
    store, run, signal: new AbortController().signal,
    tools: { async execute(action) {
      requests += 1;
      return {
        pages: [action.type === 'github_profile' ? profile : 'url' in action && action.url === first.url ? first : second],
        requests: 1, bytes: 100, estimatedUsd: null, credits: null, limitations: []
      };
    } },
    planner: { async decide(input) {
      if (input.mode === 'verify') return { supported: [0, 1], rejected: [] };
      decisions += 1;
      if (decisions < 3) return { action: 'read', url: decisions === 1 ? first.url : second.url };
      return { action: 'finish', claims: [
        { sourceKey: 'S2', quote: first.text }, { sourceKey: 'S3', quote: second.text }
      ], unknowns: [] };
    } }
  });
  assert.equal(requests, 3);
  store.updateRun(run.id, { identity_json: JSON.stringify(result.identity) });
  const before = store.buildCanonicalView(store.getRun(run.id)!).personObject!;
  assert.deepEqual(before.claims.map(claim => claim.id), ['C1', 'C2']);
  assert.deepEqual(before.evidence.map(evidence => evidence.id), ['E1', 'E2']);

  store.setSourceExcluded(run.id, 'S2', true);
  const reloadedStore = new Store(db);
  const after = reloadedStore.buildCanonicalView(reloadedStore.getRun(run.id)!);
  assert.deepEqual(after.personObject!.claims, [before.claims[1]]);
  assert.deepEqual(after.personObject!.evidence, [before.evidence[1]]);
  const exported = JSON.parse(renderJson(after)) as CanonicalView;
  assert.deepEqual(exported.personObject, after.personObject);
  assert.deepEqual(exported.personObject!.claims[0]!.evidenceIds, ['E2']);

  store.setSourceExcluded(run.id, 'S2', false);
  const restored = store.buildCanonicalView(store.getRun(run.id)!).personObject!;
  assert.deepEqual(restored.claims, before.claims);
  assert.deepEqual(restored.evidence, before.evidence);
});
