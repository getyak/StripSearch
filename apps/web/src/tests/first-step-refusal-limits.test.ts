/**
 * Scope-refusal regressions for the LEGACY direct controller path and the
 * REAL operator caps: guard refusals never change legacy behavior (third-party
 * discovered material is still read and provider failures are still counted
 * gaps) and never bill, raise or bypass a configured ceiling.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { runResearch } from '../server/research/controller.js';
import { ProviderError } from '../server/adapters/types.js';
import type { ResearchPage, ResearchToolAction, ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { PlannerInput, ResearchPlanner } from '../server/research/planner.js';
import type { ResearchBudgetLimits } from '../shared/types.js';
import { isTerminalState } from '../shared/types.js';
import type { AppConfig } from '../server/config.js';
import type { FirstStepSelectionInput } from '../shared/first-step-discovery.js';
import { seedFirstStep, type SeededFirstStep } from './first-step-fixtures.js';
import { Runner } from '../server/services/runner.js';
import { waitFor } from './harness.js';

const OWNER = 'user-owner';
const HOME_URL = 'https://fixture-linzhou.org/';
const CONTENT_URL = 'https://fixture-linzhou.org/projects';
const GITHUB_URL = 'https://github.com/fixture-linzhou';
const INERT_URL = 'https://press-fixture.org/lanzhou-story';
const HOME_TEXT = 'Lin Zhou maintains the Lantern compiler and publishes its release notes.';
const GITHUB_TEXT = 'Lantern compiler repositories owned by Lin Zhou.';
const CLAIM = 'Maintains the Lantern compiler.';

/* ------------------------------------------------------------------ */
/* Legacy direct controller                                           */
/* ------------------------------------------------------------------ */

function legacySetup() {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const run = store.insertRun({ ownerId: 'owner-a', question: 'Research Ada Fixture', seedUrl: 'https://github.com/ada-fixture',
    provider: 'research', parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'legacy-refusal' });
  return { db, store, run };
}

const profile: ResearchPage = { url: 'https://github.com/ada-fixture', title: 'Ada Fixture', text: 'Ada Fixture builds open source compilers.',
  kind: 'profile', publishedAt: null, links: ['https://fixture.test/interview'], limitations: [],
  account: { platform: 'github', handle: 'ada-fixture', id: '123', profileUrl: 'https://github.com/ada-fixture' } };
const interview: ResearchPage = { url: 'https://fixture.test/interview', title: 'An interview', text: 'Ada Fixture started the compiler project in 2020.',
  kind: 'third_party', publishedAt: null, links: [], limitations: [] };

test('legacy direct controller still reads third-party discovered material with no scope guard involved', async () => {
  const { db, store, run } = legacySetup();
  let decisions = 0;
  const result = await runResearch({
    store, run, signal: new AbortController().signal,
    tools: { async execute(action) { return { pages: [action.type === 'github_profile' ? profile : interview], requests: 1, bytes: 120, estimatedUsd: 0.001, credits: null, limitations: [] }; } },
    planner: { async decide(input) {
      if (input.mode === 'verify') return { supported: [0], rejected: [] };
      decisions++;
      return decisions === 1
        ? { action: 'read', url: interview.url }
        : { action: 'finish', claims: [{ sourceKey: 'S2', quote: interview.text, statement: interview.text, kind: 'page_statement' }] };
    } }
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.sources.length, 2, 'third-party material is still ingested on the legacy path');
  assert.equal(result.observations[0]?.statement, interview.text);
  assert.equal(result.stopReason, 'limited_evidence');
  db.close();
});

test('legacy direct controller keeps provider failures as counted gaps without stopping or retrying', async () => {
  const { db, store, run } = legacySetup();
  const attempts: string[] = [];
  const result = await runResearch({
    store, run, signal: new AbortController().signal,
    tools: { async execute(action) {
      attempts.push(action.type);
      if (action.type === 'read') throw new ProviderError('provider_unavailable', 'synthetic adapter outage');
      return { pages: [profile], requests: 1, bytes: 120, estimatedUsd: 0.001, credits: null, limitations: [] };
    } },
    planner: { async decide(input) {
      if (input.mode === 'verify') return { supported: [0], rejected: [] };
      return input.checkpoint.pages.length > 1 || attempts.length > 1
        ? { action: 'finish', claims: [{ sourceKey: 'S1', quote: profile.text }] }
        : { action: 'read', url: interview.url };
    } }
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.sources.length, 1);
  assert.equal(result.observations[0]?.statement, profile.text, 'useful material survives the failed branch');
  assert.ok(result.limitations.some((line) => line.includes('资料分支未读成功')), 'the failure is a visible gap');
  assert.equal(attempts.length, 2, 'the settled failure is never retried');
  db.close();
});

/* ------------------------------------------------------------------ */
/* Real operator caps                                                 */
/* ------------------------------------------------------------------ */

function scopedFixture() {
  return seedFirstStep({
    accounts: [
      { url: HOME_URL },
      { url: GITHUB_URL, supportedBy: { sourceUrl: HOME_URL, quote: 'My GitHub: https://github.com/fixture-linzhou.' } }
    ]
  });
}

function select(f: SeededFirstStep) {
  const result = f.firstStep.getFirstStepView(OWNER, f.run.id);
  assert.equal(result?.mode, 'first_step');
  if (!result || result.mode !== 'first_step') throw new Error('wrong flow');
  const input: FirstStepSelectionInput = {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: result.view.selection.scopeVersion,
    discoveryRevision: result.view.discoveryRevision,
    clusterId: result.view.clusters[0]!.clusterId,
    accounts: result.view.accounts.map((account) => ({ accountId: account.accountId, selection: 'selected', excluded: false }))
  };
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, input, 'refusal-limits-select');
}

function sourceKeyFor(input: PlannerInput, url: string): string {
  return input.checkpoint.pages.find((page) => page.url === url)?.sourceKey ?? 'S1';
}

test('refused predispatch proposals never bill and never raise the real operator caps', async (t) => {
  const f = scopedFixture();
  t.after(() => f.close());
  select(f);
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action): Promise<ResearchToolResult> {
      calls.push(action);
      const url = action.type === 'search' ? HOME_URL : action.url;
      return {
        pages: [{ url, title: 'Synthetic fixture page', text: url === HOME_URL ? HOME_TEXT : GITHUB_TEXT,
          kind: url === HOME_URL ? 'profile' : 'work', publishedAt: null,
          links: url === HOME_URL ? [INERT_URL, CONTENT_URL] : [], limitations: [] }],
        requests: 1, bytes: 256, estimatedUsd: 0.001, credits: null, limitations: []
      };
    }
  };
  let planCalls = 0;
  const planner: ResearchPlanner = {
    async decide(input) {
      if (input.mode === 'verify') return { supported: [0], rejected: [] };
      planCalls++;
      if (planCalls === 1) return { action: 'read', url: INERT_URL };
      if (planCalls === 2) return { action: 'read', url: CONTENT_URL };
      if (planCalls === 3) return { action: 'read', url: GITHUB_URL };
      return { action: 'finish', claims: [{ sourceKey: sourceKeyFor(input, HOME_URL), quote: HOME_TEXT, statement: CLAIM, kind: 'page_statement' }] };
    }
  };
  // Freeze the total ceiling including the already completed discovery original.
  const limits: ResearchBudgetLimits = { toolCalls: f.initialToolCalls + 3, modelCalls: 8, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 };
  const runner = new Runner({
    store: f.store,
    config: { researchLimits: limits, exaApiKey: null, deepseekApiKey: null, firecrawlApiKey: null, tikhubApiKey: null, githubToken: null } as AppConfig,
    providerFactory: () => { throw new Error('unexpected legacy provider'); },
    transport: (async () => { throw new Error('no network'); }) as never,
    researchTools: tools,
    researchPlanner: planner,
    firstStep: f.firstStep
  });
  t.after(() => runner.stopAll());
  runner.enqueue(f.run.id);
  await waitFor(() => {
    const run = f.store.getRun(f.run.id);
    return runner.activeCount() === 0 && run !== null && isTerminalState(run.state);
  });
  const run = f.store.getRun(f.run.id)!;

  assert.equal(run.state, 'partial');
  assert.equal(calls.length, 3, 'two seed reads plus one real read; the refused and the capped dispatch never reach the provider');
  assert.ok(!calls.some((call) => 'url' in call && call.url === INERT_URL), 'the refused target is never fetched');
  const receipts = f.store.research.receipts(f.run.id);
  assert.equal(receipts.length, f.initialToolCalls + 3);
  assert.ok(receipts.every((receipt) => receipt.state !== 'inflight'));
  const budget = f.store.research.budget(f.run.id);
  assert.equal(budget.toolCalls, limits.toolCalls, 'the refused proposal is unbilled and the configured ceiling is unchanged');
  assert.equal(budget.unknownCost, false);
  assert.ok(run.limitations.some((line) => line.includes(INERT_URL)), 'the refusal gap stays visible');
  assert.ok(run.limitations.some((line) => line.includes('额度已用完')), 'the exhausted cap stays visible');
  assert.equal(f.store.listObservations(f.run.id)[0]?.statement, CLAIM, 'retained material still supports the claim');
});
