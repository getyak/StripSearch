/**
 * REAL Runner + controller regressions for first-step scope-refusal handling.
 *
 * - A model proposal that reaches an inert out-of-scope link is a fail-closed,
 *   honest, visible gap: the target is never fetched, never billed and never
 *   retried, while planning continues under the same model/tool/elapsed caps
 *   with every already-read source retained.
 * - Scope withdrawal (mid-seed or during a model step) stops work safely with
 *   an explicit scope reason and a paused review report over the preserved
 *   checkpoint: no late material, no new claims, the original source unchanged,
 *   never internal_error and never a needs_input screen over a stale binding.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFirstStep, type SeededFirstStep } from './first-step-fixtures.js';
import { Runner } from '../server/services/runner.js';
import type { PlannerInput, ResearchPlanner } from '../server/research/planner.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { ResearchBudgetLimits } from '../shared/types.js';
import { isTerminalState } from '../shared/types.js';
import type { AppConfig } from '../server/config.js';
import type { FirstStepSelectionInput } from '../shared/first-step-discovery.js';
import { waitFor } from './harness.js';

const OWNER = 'user-owner';
const HOME_URL = 'https://fixture-linzhou.org/';
const CONTENT_URL = 'https://fixture-linzhou.org/projects';
const GITHUB_URL = 'https://github.com/fixture-linzhou';
const THIRD_URL = 'https://lantern-depot-fixture.org/';
/** An inert third-party link observed on the selected homepage seed. */
const INERT_URL = 'https://press-fixture.org/lanzhou-story';
const HOME_TEXT = 'Lin Zhou maintains the Lantern compiler and publishes its release notes.';
const GITHUB_TEXT = 'Lantern compiler repositories owned by Lin Zhou.';
const LATE_TEXT = 'Late material that must never join the corpus after scope withdrawal.';
const CLAIM = 'Maintains the Lantern compiler.';

const LIMITS: ResearchBudgetLimits = { toolCalls: 12, modelCalls: 8, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 };

function fixture(extraAccounts: Array<{ url: string; supportedBy?: { sourceUrl: string; quote?: string } }> = []) {
  return seedFirstStep({
    accounts: [
      { url: HOME_URL },
      { url: GITHUB_URL, supportedBy: { sourceUrl: HOME_URL, quote: 'My GitHub: https://github.com/fixture-linzhou.' } },
      ...extraAccounts
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
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, input, 'scope-refusal-select');
}

/** Withdraw the attribution evidence the frozen identity path depends on. */
function withdraw(f: SeededFirstStep) {
  const account = f.store.cases.listAccounts(OWNER, f.caseId)[1]!;
  f.store.cases.revokeEvidence({
    ownerId: OWNER,
    caseId: f.caseId,
    accountId: account.accountId,
    expectedScopeVersion: f.store.cases.getCase(OWNER, f.caseId)!.scopeVersion
  }, account.identitySupport.evidenceIds[0]!);
}

function recordingTools(onExecute?: (action: ResearchToolAction) => void) {
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action): Promise<ResearchToolResult> {
      calls.push(action);
      onExecute?.(action);
      const url = action.type === 'search' ? HOME_URL : action.url;
      const text = url === HOME_URL ? HOME_TEXT : url === CONTENT_URL ? LATE_TEXT : GITHUB_TEXT;
      return {
        pages: [{ url, title: 'Synthetic fixture page', text, kind: url === HOME_URL ? 'profile' : 'work', publishedAt: null,
          links: url === HOME_URL ? [INERT_URL, CONTENT_URL] : [], limitations: [] }],
        requests: 1, bytes: 256, estimatedUsd: 0.001, credits: null, limitations: []
      };
    }
  };
  return { calls, tools };
}

function runnerFor(f: SeededFirstStep, tools: ResearchTools, planner: ResearchPlanner, limits: ResearchBudgetLimits = LIMITS) {
  return new Runner({
    store: f.store,
    config: { researchLimits: limits, exaApiKey: null, deepseekApiKey: null, firecrawlApiKey: null, tikhubApiKey: null, githubToken: null } as AppConfig,
    providerFactory: () => { throw new Error('unexpected legacy provider'); },
    transport: (async () => { throw new Error('no network'); }) as never,
    researchTools: tools,
    researchPlanner: planner,
    firstStep: f.firstStep
  });
}

async function runToTerminal(f: SeededFirstStep, runner: Runner) {
  runner.enqueue(f.run.id);
  await waitFor(() => {
    const run = f.store.getRun(f.run.id);
    return runner.activeCount() === 0 && run !== null && isTerminalState(run.state);
  });
  return f.store.getRun(f.run.id)!;
}

function sourceKeyFor(input: PlannerInput, url: string): string {
  return input.checkpoint.pages.find((page) => page.url === url)?.sourceKey ?? 'S1';
}

test('a model proposal onto an inert out-of-scope link is an honest gap and research keeps planning', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  select(f);
  const { calls, tools } = recordingTools();
  let planCalls = 0;
  let verifyCalls = 0;
  const planner: ResearchPlanner = {
    async decide(input) {
      if (input.mode === 'verify') { verifyCalls++; return { supported: [0], rejected: [] }; }
      planCalls++;
      // The planner first follows the inert third-party link found on the seed…
      if (planCalls === 1) return { action: 'read', url: INERT_URL };
      // …then keeps planning: a cited claim from the seed material and finish.
      return { action: 'finish', claims: [{ sourceKey: sourceKeyFor(input, HOME_URL), quote: HOME_TEXT, statement: CLAIM, kind: 'page_statement' }] };
    }
  };
  const runner = runnerFor(f, tools, planner);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(run.state, 'partial');
  assert.equal(run.stopReason, 'limited_evidence');
  assert.equal(run.errorCode, null);
  // Refused target never fetched and never retried: only selected-account seed reads ran.
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((call) => 'url' in call && call.url === INERT_URL), 'the refused target is never fetched');
  // Useful continuation: the refusal did not end the run; planning and the independent verify both ran.
  assert.ok(planCalls >= 2, 'planning continues after the refusal');
  assert.equal(verifyCalls, 1);
  assert.equal(f.store.listObservations(f.run.id)[0]?.statement, CLAIM);
  // Explicit, visible gap naming the refused target.
  assert.ok(run.limitations.some((line) => line.includes(INERT_URL) && line.includes('未发送请求')), 'the gap names the never-fetched target');
  // Original permitted material retained.
  const view = f.store.buildCanonicalView(run);
  assert.ok(view.sources.some((source) => source.excerpt === HOME_TEXT));
  // The rejected predispatch action is unbilled and leaves no orphan inflight.
  const receipts = f.store.research.receipts(f.run.id);
  assert.ok(receipts.every((receipt) => receipt.state !== 'inflight'));
  assert.ok(!receipts.some((receipt) => JSON.stringify(receipt.request).includes(INERT_URL)), 'no receipt exists for the refused proposal');
  assert.equal(f.store.research.budget(f.run.id).toolCalls, 2);
});

test('mid-seed scope withdrawal stops safely and preserves the original source without late material', async (t) => {
  const f = fixture([{ url: THIRD_URL, supportedBy: { sourceUrl: HOME_URL, quote: 'My depot: https://lantern-depot-fixture.org/.' } }]);
  t.after(() => f.close());
  select(f);
  const { calls, tools } = recordingTools((action) => {
    // The withdrawal lands while the second selected account is in flight.
    if ('url' in action && action.url === GITHUB_URL) withdraw(f);
  });
  let planCalls = 0;
  const planner: ResearchPlanner = {
    async decide() {
      planCalls++;
      return { action: 'finish', claims: [] };
    }
  };
  const runner = runnerFor(f, tools, planner);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(run.state, 'partial');
  assert.equal(run.stopReason, 'scope_changed', 'explicit scope reason');
  assert.equal(run.errorCode, null, 'never internal_error');
  assert.notEqual(run.state, 'needs_input', 'no confirmation screen over a stale binding');
  assert.equal(f.firstStep.link(f.run.id)!.phase, 'blocked', 'the paused run is reviewable, not done');
  // Safe stop: planning never starts and the remaining account is never dispatched.
  assert.equal(planCalls, 0);
  assert.equal(calls.length, 2, 'no further seed read after the withdrawal');
  const view = f.store.buildCanonicalView(run);
  assert.equal(view.sources.length, 1);
  assert.equal(view.sources[0]!.excerpt, HOME_TEXT, 'original source unchanged');
  assert.ok(!JSON.stringify(view.sources).includes(LATE_TEXT) && !JSON.stringify(view.sources).includes(GITHUB_TEXT), 'late material is never ingested');
  assert.equal(view.sources[0]!.identityConfirmed, false, 'review-paused report');
  assert.equal(f.store.listObservations(f.run.id).length, 0, 'no new claims');
  assert.ok(run.limitations.some((line) => line.includes('冻结范围')), 'honest scope gap');
  assert.ok(run.limitations.some((line) => line.includes('重新开始')), 'restart guidance for the user');
  const receipts = f.store.research.receipts(f.run.id);
  assert.ok(receipts.every((receipt) => receipt.state !== 'inflight'), 'no orphan inflight');
});

test('model-step scope withdrawal refuses the late result and pauses with the explicit scope reason', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  select(f);
  const { calls, tools } = recordingTools((action) => {
    // The withdrawal lands while the model-planned read is in flight.
    if ('url' in action && action.url === CONTENT_URL) withdraw(f);
  });
  let planCalls = 0;
  const planner: ResearchPlanner = {
    async decide(input) {
      if (input.mode === 'verify') return { supported: [0], rejected: [] };
      planCalls++;
      return planCalls === 1
        ? { action: 'read', url: CONTENT_URL }
        : { action: 'finish', claims: [{ sourceKey: sourceKeyFor(input, HOME_URL), quote: HOME_TEXT, statement: CLAIM, kind: 'page_statement' }] };
    }
  };
  const runner = runnerFor(f, tools, planner);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(run.state, 'partial');
  assert.equal(run.stopReason, 'scope_changed', 'explicit scope reason');
  assert.equal(run.errorCode, null, 'never internal_error');
  assert.notEqual(run.state, 'needs_input', 'no confirmation screen over a stale binding');
  assert.equal(f.firstStep.link(f.run.id)!.phase, 'blocked');
  assert.equal(planCalls, 1, 'work stops at the withdrawal');
  const view = f.store.buildCanonicalView(run);
  assert.equal(view.sources.length, 2, 'only the two completed seed reads landed');
  assert.ok(view.sources.some((source) => source.excerpt === HOME_TEXT), 'original source unchanged');
  assert.ok(!JSON.stringify(view.sources).includes(LATE_TEXT), 'the late result is never ingested');
  assert.equal(f.store.listObservations(f.run.id).length, 0, 'no new claims');
  assert.ok(run.limitations.some((line) => line.includes('冻结范围')));
  const receipts = f.store.research.receipts(f.run.id);
  assert.equal(receipts.length, 3, 'seed reads plus the one dispatched attempt');
  assert.ok(receipts.every((receipt) => receipt.state !== 'inflight'));
  // The dispatched request is metered honestly; its refused result is not a success.
  assert.equal(f.store.research.budget(f.run.id).estimatedUsd, 0.003);
  assert.equal(f.store.research.budget(f.run.id).unknownCost, false);
});

test('a model-step dispatch attempted after withdrawal is refused unbilled and stops safely', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  select(f);
  const { calls, tools } = recordingTools();
  let planCalls = 0;
  const planner: ResearchPlanner = {
    async decide() {
      planCalls++;
      // The model step only ever sees a scope that is already withdrawn.
      withdraw(f);
      return { action: 'read', url: CONTENT_URL };
    }
  };
  const runner = runnerFor(f, tools, planner);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(run.state, 'partial');
  assert.equal(run.stopReason, 'scope_changed');
  assert.equal(run.errorCode, null, 'never internal_error');
  assert.equal(planCalls, 1);
  assert.equal(calls.length, 2, 'the refused dispatch never reaches the provider');
  const receipts = f.store.research.receipts(f.run.id);
  assert.equal(receipts.length, 2, 'the rejected predispatch action leaves no receipt');
  assert.ok(receipts.every((receipt) => receipt.state !== 'inflight'));
  const view = f.store.buildCanonicalView(run);
  assert.equal(view.sources.length, 2, 'only the two completed seed reads landed');
  assert.ok(view.sources.some((source) => source.excerpt === HOME_TEXT), 'original source unchanged');
  assert.ok(!JSON.stringify(view.sources).includes(LATE_TEXT), 'the refused target is never ingested');
  assert.equal(f.store.listObservations(f.run.id).length, 0, 'no new claims');
  assert.ok(run.limitations.some((line) => line.includes('冻结范围')));
});
test('an undiscovered URL in a batch never dispatches or aborts the permitted branch', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  select(f);
  const { calls, tools } = recordingTools();
  let planCalls = 0;
  let verifyCalls = 0;
  const planner: ResearchPlanner = {
    async decide(input) {
      if (input.mode === 'verify') { verifyCalls++; return { supported: [0], rejected: [] }; }
      planCalls++;
      // The planner first follows the inert third-party link found on the seed…
      if (planCalls === 1) return { action: 'batch', actions: [{action:'read',url:'https://never-discovered-fixture.org/'},{action:'read',url:CONTENT_URL}] };
      // …then keeps planning: a cited claim from the seed material and finish.
      return { action: 'finish', claims: [{ sourceKey: sourceKeyFor(input, HOME_URL), quote: HOME_TEXT, statement: CLAIM, kind: 'page_statement' }] };
    }
  };
  const runner = runnerFor(f, tools, planner);
  t.after(() => runner.stopAll());
  const run = await runToTerminal(f, runner);

  assert.equal(run.state, 'partial');
  assert.equal(run.stopReason, 'limited_evidence');
  assert.equal(run.errorCode, null);
  // Refused target never fetched and never retried: only selected-account seed reads ran.
  assert.equal(calls.length, 3);
  assert.ok(!calls.some((call) => 'url' in call && call.url === INERT_URL), 'the refused target is never fetched');
  // Useful continuation: the refusal did not end the run; planning and the independent verify both ran.
  assert.ok(planCalls >= 2, 'planning continues after the refusal');
  assert.equal(verifyCalls, 1);
  assert.equal(f.store.listObservations(f.run.id)[0]?.statement, CLAIM);
  // Explicit, visible gap naming the refused target.
  assert.ok(run.limitations.some((line) => line.includes('https://never-discovered-fixture.org/') && line.includes('未发送请求')), 'the gap names the never-fetched target');
  // Original permitted material retained.
  const view = f.store.buildCanonicalView(run);
  assert.ok(view.sources.some((source) => source.excerpt === HOME_TEXT));
  // The rejected predispatch action is unbilled and leaves no orphan inflight.
  const receipts = f.store.research.receipts(f.run.id);
  assert.ok(receipts.every((receipt) => receipt.state !== 'inflight'));
  assert.ok(!receipts.some((receipt) => JSON.stringify(receipt.request).includes('https://never-discovered-fixture.org/')), 'no receipt exists for the refused proposal');
  assert.equal(f.store.research.budget(f.run.id).toolCalls, 3);
});

