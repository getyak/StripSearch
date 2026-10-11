/**
 * REAL Runner regressions for the frozen first-step input/budget contract
 * (FR-P1-001 / FR-P1-002), all offline with synthetic tools and a transport
 * that must never be called:
 *
 * - A validated long URL input (<= 2048 chars) runs discovery cleanly: read as
 *   supplied, searched only through the explicit bounded hostname + path
 *   query, no manufactured handles, never internal_error.
 * - A restricted-model reserve budget exhaustion (reserved prior model cap 1)
 *   preserves every discovered result and appends ready_for_choice with honest
 *   skipped_budget coverage/gap — no extra model dispatch/reservation, no
 *   fabricated success, never internal_error.
 * - A late abort (cancel while a request is in flight) stays terminal: the
 *   late result is dropped, nothing is ingested and the run never resurrects.
 * - The normal flow is unaffected: default budgets, ready_for_choice, no
 *   budget gaps.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { Runner } from '../server/services/runner.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { ResearchBudgetLimits } from '../shared/types.js';
import type { AppConfig } from '../server/config.js';
import { FIRST_STEP_DEFAULT_BUDGET, classifyFirstStepUrl, firstStepUrlSearchQuery } from '../shared/first-step-discovery.js';
import { waitFor } from './harness.js';

const OWNER = 'contract-owner';
const LONG_URL = `https://probe-lab.dev/${'a'.repeat(700)}`;
const HOME_URL = 'https://fixture-linzhou.org/';
const GITHUB_URL = 'https://github.com/fixture-linzhou';
const HOME_TEXT = 'Lin Zhou maintains the Lantern compiler. My GitHub: https://github.com/fixture-linzhou.';

function memoryRun(options: { question: string; seedUrl: string | null; fingerprint: string }) {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const run = store.insertRun({
    ownerId: OWNER,
    question: options.question,
    seedUrl: options.seedUrl,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: options.fingerprint
  });
  firstStep.attachRun(run);
  return { db, store, firstStep, run };
}

function page(url: string, title: string, text: string, links: string[] = []) {
  return { url, title, text, kind: 'profile' as const, publishedAt: null, links, limitations: [] };
}

function result(pages: ResearchToolResult['pages']): ResearchToolResult {
  return { pages, requests: 1, bytes: 256, estimatedUsd: 0.001, credits: null, limitations: [] };
}

function runnerFor(
  f: ReturnType<typeof memoryRun>,
  tools: ResearchTools,
  limits: ResearchBudgetLimits,
  keys: { deepseekApiKey?: string | null; exaApiKey?: string | null } = {}
) {
  return new Runner({
    ...f,
    config: {
      researchLimits: limits,
      exaApiKey: keys.exaApiKey ?? null,
      deepseekApiKey: keys.deepseekApiKey ?? null,
      firecrawlApiKey: null,
      tikhubApiKey: null,
      githubToken: null
    } as AppConfig,
    providerFactory: () => { throw new Error('unexpected legacy provider'); },
    // Any model/network call in these regressions is a contract violation.
    transport: (async () => { throw new Error('no network allowed'); }) as never,
    researchTools: tools
  });
}

async function runToTerminal(f: ReturnType<typeof memoryRun>, runner: Runner) {
  runner.enqueue(f.run.id);
  await waitFor(() => {
    const run = f.store.getRun(f.run.id);
    return runner.activeCount() === 0 && run !== null && !['queued', 'researching'].includes(run.state);
  });
  return f.store.getRun(f.run.id)!;
}

function firstStepView(f: ReturnType<typeof memoryRun>) {
  const result = f.firstStep.getFirstStepView(OWNER, f.run.id);
  assert.equal(result?.mode, 'first_step');
  if (!result || result.mode !== 'first_step') throw new Error('wrong flow');
  return result.view;
}

const LIMITS: ResearchBudgetLimits = { toolCalls: 40, modelCalls: 8, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 };

test('a valid 2048-class URL input is read as supplied and searched only through the bounded hostname+path query', async (t) => {
  const f = memoryRun({ question: 'Lin Zhou', seedUrl: LONG_URL, fingerprint: 'contract-long-url' });
  t.after(() => f.db.close());
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      if (action.type === 'search') return result([]);
      return result([page(action.url, 'Synthetic probe page', 'Synthetic probe page text.')]);
    }
  };
  const runner = runnerFor(f, tools, LIMITS);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  // FR-P1-001: never failed/internal_error over a route-valid long URL.
  assert.equal(run.state, 'needs_input');
  assert.equal(run.errorCode, null);
  const view = firstStepView(f);
  assert.equal(view.readyForChoice, true);
  assert.equal(view.input.value, LONG_URL, 'the input is kept exactly as supplied');

  const searches = calls.filter((call): call is Extract<ResearchToolAction, { type: 'search' }> => call.type === 'search');
  const reads = calls.filter((call): call is Extract<ResearchToolAction, { url: string }> => call.type === 'read');
  assert.equal(searches.length, 1, 'the URL input keeps its single frozen home family');
  const query = searches[0]!.query;
  assert.ok(query.length <= 600, 'the planned query fits the frozen SEARCH contract');
  assert.equal(query, firstStepUrlSearchQuery(LONG_URL));
  assert.ok(LONG_URL.includes(query), 'the query is only actual URL text from the input');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.url, LONG_URL, 'the source read URL is never rewritten');

  // No manufactured handles: every projected handle comes from the frozen
  // conservative classifier for its own URL, and no path text becomes one.
  assert.ok(view.accounts.length > 0, 'the explicit URL anchor stays an observed lead');
  for (const account of view.accounts) {
    const classified = classifyFirstStepUrl(account.profileUrl);
    assert.ok(classified.ok);
    assert.equal(account.handle, classified.ok ? classified.ref.handle : null);
    assert.ok(!String(account.handle ?? '').includes('a'.repeat(20)), 'no handle is manufactured from the long path');
  }
});

test('a reserved prior model receipt at cap 1 keeps discovered results and appends honest skipped_budget coverage', async (t) => {
  const f = memoryRun({ question: 'Lin Zhou', seedUrl: null, fingerprint: 'contract-model-budget' });
  t.after(() => f.db.close());
  // One settled model receipt from an earlier discovery attempt, exactly as
  // after an expand; the frozen cumulative model ceiling is 1.
  const limits: ResearchBudgetLimits = { ...LIMITS, modelCalls: 1 };
  f.store.research.reserve(f.run.id, 'prior-model-1', 'model', { model: 'probe' }, { inputTokens: 100, outputTokens: 100 }, limits);
  f.store.research.settle(f.run.id, 'prior-model-1', { ok: true }, { inputTokens: 100, outputTokens: 100, estimatedUsd: 0.001, unknownCost: false });

  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      if (action.type === 'search') return result([page(HOME_URL, 'Lin Zhou', HOME_TEXT, [GITHUB_URL])]);
      return result([page(action.url, 'Lin Zhou — Home', action.url === HOME_URL ? HOME_TEXT : 'Lantern compiler repositories.', [])]);
    }
  };
  const runner = runnerFor(f, tools, limits, { deepseekApiKey: 'probe', exaApiKey: 'probe' });
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  // FR-P1-002: the model reserve budget exhaustion never voids the discovery.
  assert.equal(run.state, 'needs_input');
  assert.equal(run.errorCode, null);
  const view = firstStepView(f);
  assert.equal(view.readyForChoice, true, 'ready_for_choice is still appended');
  assert.ok(view.discoveryRevision >= 1, 'a real discovery revision was persisted');

  // Discovered results are preserved.
  assert.ok(view.accounts.some((account) => account.profileUrl === HOME_URL), 'the discovered homepage account survives');
  assert.ok(view.relatedLeads.some((lead) => lead.url === GITHUB_URL), 'the index-only account link survives as an unconfirmed material lead');
  assert.equal(view.accounts.some((account) => account.profileUrl === GITHUB_URL), false, 'an index outlink does not become a selectable account without its own eligibility');
  assert.ok(f.store.research.receipts(f.run.id).some(receipt => JSON.stringify(receipt.result).includes(GITHUB_URL)), 'the original indexed link remains in the actual receipt');

  // No extra model dispatch or reservation beyond the one prior receipt.
  const modelReceipts = f.store.research.receipts(f.run.id).filter((receipt) => receipt.kind === 'model');
  assert.equal(modelReceipts.length, 1, 'no extra model call is dispatched or reserved');
  assert.equal(modelReceipts[0]!.key, 'prior-model-1');

  // Honest skipped_budget coverage and gap; no fabricated success.
  assert.ok(view.routes.some((route) => route.state === 'skipped_budget'), 'uncovered planned routes stay skipped_budget');
  assert.ok(view.gaps.some((gap) => gap.includes('模型预算') && gap.includes('skipped_budget')), 'the model budget gap is explicit and honest');
  for (const route of view.routes) {
    if (route.state === 'found') assert.ok(route.receiptKeys.length > 0, 'a found route always carries real receipts');
    if (route.state === 'skipped_budget') assert.ok(route.note && route.note.includes('skipped_budget'));
  }
});

test('a late abort stays terminal: the late result is dropped and the run never resurrects', async (t) => {
  const f = memoryRun({ question: 'Lin Zhou', seedUrl: null, fingerprint: 'contract-late-abort' });
  t.after(() => f.db.close());
  let runnerRef: Runner | null = null;
  let dispatched = 0;
  const tools: ResearchTools = {
    async execute(action) {
      dispatched++;
      // The user cancels while this request is in flight; its result arrives
      // late and must be dropped, never written.
      runnerRef!.cancel(f.run.id);
      return result([page(action.type === 'search' ? HOME_URL : action.url, 'Lin Zhou', HOME_TEXT, [])]);
    }
  };
  const runner = runnerFor(f, tools, LIMITS);
  runnerRef = runner;
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(dispatched, 1);
  assert.equal(run.state, 'cancelled');
  assert.equal(run.stopReason, 'cancelled');
  assert.equal(run.errorCode, null, 'an actual abort is never internal_error');

  // The late result was dropped: nothing ingested, no ready projection.
  const link = f.firstStep.link(f.run.id)!;
  assert.equal(f.store.cases.listAccounts(OWNER, link.caseId).length, 0, 'late material is never written');
  const view = firstStepView(f);
  assert.equal(view.readyForChoice, false, 'no discovery revision is appended after the abort');

  // The terminal state is stable: a re-enqueue never resurrects the run.
  runner.enqueue(f.run.id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(f.store.getRun(f.run.id)!.state, 'cancelled');
  assert.equal(runner.activeCount(), 0);
});

test('the normal discovery flow is unaffected: default budgets, ready_for_choice, no budget gaps', async (t) => {
  const f = memoryRun({ question: 'Lin Zhou', seedUrl: null, fingerprint: 'contract-normal' });
  t.after(() => f.db.close());
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      if (action.type === 'search') return result([page(HOME_URL, 'Lin Zhou', HOME_TEXT, [GITHUB_URL])]);
      return result([page(action.url, 'Lin Zhou — Home', action.url === HOME_URL ? HOME_TEXT : 'Lantern compiler repositories.', [])]);
    }
  };
  const runner = runnerFor(f, tools, LIMITS);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(run.state, 'needs_input');
  assert.equal(run.errorCode, null);
  const view = firstStepView(f);
  assert.equal(view.readyForChoice, true);
  assert.ok(view.discoveryRevision >= 1);
  assert.ok(view.accounts.length > 0);
  // No budget exhaustion happened: no skipped_budget route and no budget gap.
  assert.ok(view.routes.every((route) => route.state !== 'skipped_budget'), 'normal runs never report skipped_budget');
  assert.ok(view.gaps.every((gap) => !gap.includes('预算')), 'normal runs carry no budget gap');

  const searches = calls.filter((call) => call.type === 'search');
  assert.ok(searches.length >= 9, 'the frozen family coverage runs');
  assert.ok(searches.length <= FIRST_STEP_DEFAULT_BUDGET.maxSearchQueries, 'the default v4 query cap binds');
  for (const call of calls) {
    if (call.type === 'search') assert.ok(call.query.length <= 600, 'every dispatched query fits the SEARCH contract');
    else assert.ok(call.url.length <= 2048, 'reads keep the URL as supplied');
  }
  assert.equal(view.budget.toolCalls, calls.length);
});
