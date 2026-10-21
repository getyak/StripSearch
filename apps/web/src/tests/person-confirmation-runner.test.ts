/**
 * GET-213 trust boundaries on the REAL production path: Runner +
 * PersonConfirmationStore + FirstStepStore + checked receipts.
 *
 * Asserted here (all synthetic, zero network/provider/model calls):
 * - the staged vertical sequence runs through the real Runner: overview ->
 *   persisted person confirmation -> account discovery -> atomic scope gate;
 * - billing (HTTP 402) stops same-supplier dispatch for the ATTEMPT with safe
 *   structured metadata tied to the real receipt across restart; an explicit
 *   NEW attempt after operator recovery may dispatch again and an unrelated
 *   authorized supplier stays available;
 * - prefrozen v10 history keeps its full unstaged flow even on the production
 *   Runner (checked surface and coordinator agree on one frozen stage);
 * - changed/withdrawn source originals fail closed; cancelled/deleted runs and
 *   wrong owners can never confirm or resurrect a permission.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore, FirstStepSelectionError } from '../server/research/first-step-store.js';
import {
  PersonConfirmationStore,
  PersonConfirmationError,
  activePersonConfirmation
} from '../server/research/person-confirmation.js';
import { Runner } from '../server/services/runner.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { AppConfig } from '../server/config.js';
import { ProviderError } from '../server/adapters/types.js';
import type { FirstStepDiscoveryView, FirstStepSelectionInput } from '../shared/first-step-discovery.js';
import { waitFor } from './harness.js';

const OWNER = 'runner-gate-owner';
const HOME_URL = 'https://lantern.dev/';
const HOME_TEXT = 'Mira Kepler maintains the Lantern compiler. My X: https://x.com/mkepler.';

function fixture() {
  const db: DB = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const persons = new PersonConfirmationStore(db, store, firstStep);
  const run = store.insertRun({
    ownerId: OWNER,
    question: 'Mira Kepler',
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'fp-runner-gate'
  });
  firstStep.attachRun(run);
  return { db, store, firstStep, persons, run };
}

function page(url: string, title: string, text: string, links: string[] = []) {
  return { url, title, text, kind: 'profile' as const, publishedAt: null, links, limitations: [] };
}

function result(pages: ResearchToolResult['pages']): ResearchToolResult {
  return { pages, requests: 1, bytes: 256, estimatedUsd: 0.001, credits: null, limitations: [] };
}

function runnerFor(f: ReturnType<typeof fixture>, tools: ResearchTools, keys: { exa?: boolean; firecrawl?: boolean } = {}) {
  return new Runner({
    store: f.store,
    firstStep: f.firstStep,
    personConfirmation: f.persons,
    config: {
      researchLimits: { toolCalls: 40, modelCalls: 8, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 },
      exaApiKey: keys.exa === false ? null : 'offline-fixture',
      deepseekApiKey: null,
      firecrawlApiKey: keys.firecrawl ? 'offline-fixture' : null,
      tikhubApiKey: 'offline-fixture',
      githubToken: null
    } as AppConfig,
    providerFactory: () => { throw new Error('unexpected legacy provider'); },
    // Any model/network call in these regressions is a contract violation.
    transport: (async () => { throw new Error('no network allowed'); }) as never,
    researchTools: tools
  });
}

async function runToWait(f: ReturnType<typeof fixture>, runner: Runner): Promise<void> {
  runner.enqueue(f.run.id);
  await waitFor(() => {
    const run = f.store.getRun(f.run.id);
    return runner.activeCount() === 0 && run !== null && run.state === 'needs_input';
  });
}

function view(f: ReturnType<typeof fixture>): FirstStepDiscoveryView {
  const result = f.firstStep.getFirstStepView(OWNER, f.run.id);
  assert.equal(result?.mode, 'first_step');
  if (!result || result.mode !== 'first_step') throw new Error('wrong flow');
  return result.view;
}

function confirmInput(f: ReturnType<typeof fixture>): Record<string, unknown> {
  const current = view(f);
  return {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: current.selection.scopeVersion,
    discoveryRevision: current.discoveryRevision,
    candidateId: current.personOverview!.candidates[0]!.candidateId
  };
}

test('a persisted cancel flag rejects both fresh and keyless replay confirmation without writes', async t => {
  const f = fixture();t.after(() => f.db.close());
  const tools: ResearchTools = { async execute(action) {
    return result([page(action.type === 'search' ? HOME_URL : action.url, 'Mira Kepler', HOME_TEXT)]);
  } };
  const runner = runnerFor(f, tools);t.after(() => runner.stopAll());
  await runToWait(f, runner);
  const input = confirmInput(f), before = f.store.research.receipts(f.run.id);
  f.store.updateRun(f.run.id, { cancel_requested: 1 });
  assert.throws(() => f.persons.applyConfirmation(OWNER, f.run.id, input, 'fresh-cancel-flag'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'run_not_waiting');
  const count = f.db.prepare('SELECT COUNT(*) n FROM first_step_person_confirmations WHERE run_id=?').get(f.run.id) as { n: number };
  assert.equal(count.n, 0);assert.equal(f.persons.active(f.run.id), null);
  assert.equal(f.store.getRun(f.run.id)!.cancelRequested, true);
  assert.deepEqual(f.store.research.receipts(f.run.id), before);
  // Restore only this synthetic fixture to exercise a separate keyless replay.
  f.store.updateRun(f.run.id, { cancel_requested: 0 });
  f.persons.applyConfirmation(OWNER, f.run.id, input, null);
  f.store.updateRun(f.run.id, { cancel_requested: 1, state: 'cancelled' });
  assert.throws(() => f.persons.applyConfirmation(OWNER, f.run.id, input, null),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'run_not_waiting');
});

for (const hint of ['Lantern Institute', 'https://lantern.dev/people/mira']) test(`real Runner keeps the person name when expanding with ${hint}`, async t => {
  const f = fixture();t.after(() => f.db.close());
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = { async execute(action) {
    calls.push(action);
    assert.ok(action.type === 'search' || action.type === 'read', 'Receipt-bound overview leads use read even with Firecrawl configured');
    return result([page(action.type === 'search' ? HOME_URL : action.url, 'Mira Kepler', HOME_TEXT)]);
  } };
  const runner = runnerFor(f, tools, { firecrawl: true });t.after(() => runner.stopAll());
  await runToWait(f, runner);
  const prior = f.store.research.receipts(f.run.id);
  f.firstStep.applyFirstStepExpand(OWNER, f.run.id, hint, 'hint-' + hint);
  calls.length = 0;await runToWait(f, runner);
  const expanded = view(f);
  assert.equal(expanded.personOverview!.queryLabel, 'Mira Kepler');
  assert.ok(expanded.personOverview!.candidates.some(c => c.sources.some(s => s.retrieval === 'read' && s.quote?.includes('Mira Kepler'))));
  assert.ok(calls.some(a => a.type === 'search' && a.query.includes('Mira Kepler') && a.query.includes(hint)), 'The clue actually guides bounded search without replacing the person');
  assert.ok(calls.filter(a => a.type === 'search').length <= 4);
  const after = f.store.research.receipts(f.run.id);
  for (const receipt of prior) assert.deepEqual(after.find(r => r.key === receipt.key), receipt);
  const settledCalls = calls.length;
  f.store.updateRun(f.run.id, { state: 'queued' });await runToWait(f, runner);
  assert.equal(calls.length, settledCalls, 'The expanded name+hint attempt replays without new IO');
});

test('a frozen v10 hint attempt keeps its original input and exact receipts on real Runner recovery', async t => {
  const f = fixture();t.after(() => f.db.close());
  const hint = 'Lantern Institute';f.firstStep.setHint(f.run.id, hint);
  const tools: ResearchTools = { async execute(action) {
    return result([page(action.type === 'search' ? HOME_URL : action.url, 'Mira Kepler — Lantern Institute', HOME_TEXT)]);
  } };
  const { createFirstStepCheckedSearch, discoverFirstStep, firstStepAttemptId } = await import('../server/research/first-step-discovery.js');
  const input = { kind: 'name_query' as const, value: hint, question: f.run.question };
  const attemptId = firstStepAttemptId(f.firstStep.link(f.run.id)!, input, hint);
  const budget = { maxSearchQueries: 11, maxSearchResults: 12, maxProfileReads: 16, maxModelCalls: 2, policyVersion: 'first-step/v10' };
  await discoverFirstStep({ store: f.store, firstStep: f.firstStep, ownerId: OWNER, runId: f.run.id, input, hint,
    search: createFirstStepCheckedSearch({ tools, store: f.store, runId: f.run.id, attemptId, budget }),
    signal: new AbortController().signal, registryVersion: 'registry-test/v1', catalog: null, budget });
  const before = f.store.research.receipts(f.run.id);assert.ok(before.length > 0);
  const runner = runnerFor(f, tools);t.after(() => runner.stopAll());
  f.store.updateRun(f.run.id, { state: 'queued' });await runToWait(f, runner);
  assert.equal(view(f).personOverview, undefined);
  assert.deepEqual(f.store.research.receipts(f.run.id), before);
});

test('the real Runner runs overview -> persisted confirmation -> account discovery -> scope gate', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT), page('https://x.com/mkepler', 'Mira Kepler (@mkepler)', 'Compiler researcher.')]);
      return result([page(action.url, 'Mira Kepler — Lantern', `Mira Kepler owns this page. My X: https://x.com/mkepler.`)]);
    }
  };
  const runner = runnerFor(f, tools);
  t.after(() => runner.stopAll());

  await runToWait(f, runner);
  const overview = view(f);
  assert.equal(overview.phase, 'awaiting_person_confirmation');
  assert.equal(overview.personConfirmation?.required, true);
  assert.equal(calls.every((call) => call.type === 'search' || call.type === 'read'), true, 'no social/account dispatch before confirmation');
  assert.equal(calls.some((call) => call.type === 'social_profile' || call.type === 'social_posts' || call.type === 'github_profile'), false);

  // Account selection is refused BEFORE the person confirmation.
  const preConfirmation = {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: overview.selection.scopeVersion,
    discoveryRevision: overview.discoveryRevision,
    clusterId: null,
    accounts: overview.accounts.map((account) => ({ accountId: account.accountId, selection: 'only_this_account', excluded: false }))
  };
  assert.throws(
    () => f.firstStep.applyFirstStepSelection(OWNER, f.run.id, preConfirmation, 'key-pre'),
    (error: unknown) => error instanceof FirstStepSelectionError && error.code === 'person_confirmation_required'
  );

  const confirmation = f.persons.applyConfirmation(OWNER, f.run.id, confirmInput(f), 'key-confirm');
  assert.equal(confirmation.idempotent, false);
  await runToWait(f, runner);
  const accountsView = view(f);
  assert.equal(accountsView.phase, 'ready_for_choice');
  assert.equal(accountsView.personConfirmation?.status, 'confirmed');
  assert.ok(accountsView.accounts.length > 0, 'account discovery ran after the confirmed person');
  const afterConfirmation = calls.slice();
  assert.ok(afterConfirmation.some((call) => call.type === 'search'), 'the account stage dispatches account search');

  // The existing atomic account scope gate then freezes the real scope.
  const selection: FirstStepSelectionInput = {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: accountsView.selection.scopeVersion,
    discoveryRevision: accountsView.discoveryRevision,
    clusterId: accountsView.clusters[0]?.clusterId ?? null,
    accounts: accountsView.accounts.map((account) => ({ accountId: account.accountId, selection: 'only_this_account', excluded: false, note: null }))
  };
  const submitted = f.firstStep.applyFirstStepSelection(OWNER, f.run.id, selection, 'key-scope');
  assert.equal(submitted.idempotent, false);
  assert.ok(f.firstStep.selectionBinding(f.run.id) !== null);
});

test('billing stops same-supplier dispatch per attempt; restart replays; a NEW attempt may dispatch again', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const calls: string[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action.type);
      if (action.type === 'firecrawl') return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
      throw new ProviderError('provider_billing', '供应商计费/额度不足（HTTP 402）。', 402);
    }
  };
  const runner = runnerFor(f, tools, { firecrawl: true });
  t.after(() => runner.stopAll());

  await runToWait(f, runner);
  assert.deepEqual(calls, ['search'], 'exactly one supplier call before the same-supplier stop');
  const first = view(f);
  assert.equal(first.personOverview?.serviceError?.code, 'provider_billing');
  assert.equal(first.personOverview?.serviceError?.transient, false);
  // Safe structured failure metadata is tied to its real receipt.
  const failed = f.store.research.receipts(f.run.id).filter((receipt) => receipt.state === 'failed');
  assert.equal(failed.length, 1);
  const projected = first.receipts.find((receipt) => receipt.state === 'failed');
  assert.equal(projected?.error?.code, 'provider_billing', 'the failure classification survives on the receipt projection');

  // Restart of the SAME attempt never re-dispatches the stopped supplier.
  f.store.updateRun(f.run.id, { state: 'queued' });
  await runToWait(f, runner);
  assert.deepEqual(calls, ['search'], 'a same-attempt restart leaves no new supplier dispatch');
  const replayed = view(f);
  assert.equal(replayed.receipts.find((receipt) => receipt.state === 'failed')?.error?.code, 'provider_billing', 'replayed failures keep their safe code');
  assert.equal(replayed.personOverview?.coverage.queryFamilies.filter((family) => family.state === 'completed').length, 0, 'untried families are never claimed as completed');

  // An explicit NEW attempt after operator recovery may dispatch again.
  f.store.updateRun(f.run.id, { state: 'needs_input' });
  const expand = f.firstStep.applyFirstStepExpand(OWNER, f.run.id, 'Mira Kepler works', 'key-expand');
  assert.equal(expand.idempotent, false);
  await runToWait(f, runner);
  assert.deepEqual(calls, ['search', 'search'], 'a NEW attempt owns fresh receipts; the old stop never blocks it');
});

test('an unrelated authorized supplier stays available while the billing-failed supplier is stopped', async () => {
  const f = fixture();
  const calls: string[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action.type);
      if (action.type === 'firecrawl') return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
      throw new ProviderError('provider_billing', '供应商计费/额度不足（HTTP 402）。', 402);
    }
  };
  const { createFirstStepCheckedSearch } = await import('../server/research/first-step-discovery.js');
  const search = createFirstStepCheckedSearch({
    tools,
    store: f.store,
    runId: f.run.id,
    attemptId: 'attempt-unrelated',
    budget: { maxSearchQueries: 11, maxSearchResults: 12, maxProfileReads: 16, maxModelCalls: 2, policyVersion: 'first-step/v11' },
    stage: 'accounts'
  });
  const signal = new AbortController().signal;
  await search.search('firststep:probe:v11:search:1', 'Mira Kepler', 5, signal).catch(() => undefined);
  await assert.rejects(() => search.readIdentity('firststep:probe:v11:profile:2', { type: 'read', url: HOME_URL }, signal));
  assert.deepEqual(calls, ['search'], 'the same-supplier read is stopped BEFORE dispatch: no call, no receipt');
  // Firecrawl is a different supplier: still dispatched when authorized.
  await search.readIdentity('firststep:probe:v11:profile:3', { type: 'firecrawl', url: HOME_URL }, signal);
  assert.deepEqual(calls, ['search', 'firecrawl'], 'an unrelated authorized supplier is not collateral damage');
});

test('prefrozen v10 history keeps the full unstaged flow on the production Runner', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT), page('https://x.com/mkepler', 'Mira Kepler (@mkepler)', 'Compiler researcher.')]);
      return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
    }
  };
  // Prefrozen old-policy history: a completed v10 attempt with real receipts
  // under the SAME attempt identity the production Runner derives.
  const { createFirstStepCheckedSearch, discoverFirstStep } = await import('../server/research/first-step-discovery.js');
  const prior = await discoverFirstStep({
    store: f.store,
    firstStep: f.firstStep,
    ownerId: OWNER,
    runId: f.run.id,
    input: { kind: 'name_query', value: 'Mira Kepler', question: 'Mira Kepler' },
    search: createFirstStepCheckedSearch({
      tools,
      store: f.store,
      runId: f.run.id,
      attemptId: 'input-1',
      budget: { maxSearchQueries: 11, maxSearchResults: 12, maxProfileReads: 16, maxModelCalls: 2, policyVersion: 'first-step/v10' }
    }),
    signal: new AbortController().signal,
    registryVersion: 'registry-test/v1',
    catalog: null
  });
  assert.equal(prior.readyForChoice, true);
  const receiptsBefore = f.store.research.receipts(f.run.id).map((receipt) => receipt.key);

  // The production Runner resumes this prefrozen attempt: the ONE frozen
  // stage decision keeps the checked surface AND the coordinator unstaged.
  const runner = runnerFor(f, tools);
  t.after(() => runner.stopAll());
  f.store.updateRun(f.run.id, { state: 'queued' });
  await runToWait(f, runner);
  const resumed = view(f);
  assert.equal(resumed.personConfirmation, undefined, 'old attempts are never silently re-staged');
  assert.equal(resumed.readyForChoice, true, 'the prefrozen attempt resumes straight to its choice screen');
  assert.deepEqual(f.store.research.receipts(f.run.id).map((receipt) => receipt.key), receiptsBefore, 'immutable receipts stay untouched');
  assert.equal(activePersonConfirmation(f.db, f.run.id, null), null);
});

test('changed or withdrawn source originals fail closed before confirmation and before account expansion', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const tools: ResearchTools = {
    async execute(action) {
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT)]);
      return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
    }
  };
  const runner = runnerFor(f, tools);
  t.after(() => runner.stopAll());
  await runToWait(f, runner);
  const before = view(f);
  const candidate = before.personOverview!.candidates[0]!;
  const readSource = candidate.sources.find((source) => source.retrieval === 'read');
  assert.ok(readSource?.contentHash, 'the read source carries a real content hash');

  // Simulate a changed/withdrawn original: the retained text no longer
  // matches the recorded hash (or the receipt is gone entirely).
  f.db.prepare(`UPDATE research_actions SET result_json = ? WHERE run_id = ? AND result_json LIKE ?`)
    .run(JSON.stringify({ pages: [{ url: HOME_URL, title: 'Changed', text: 'withdrawn content', kind: 'profile', publishedAt: null, links: [], limitations: [] }], requests: 1, bytes: 1, estimatedUsd: null, credits: null, limitations: [] }),
      f.run.id, `%${HOME_URL}%`);
  assert.throws(
    () => f.persons.applyConfirmation(OWNER, f.run.id, confirmInput(f), 'key-withdrawn'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'revoked_candidate'
  );
  assert.equal(activePersonConfirmation(f.db, f.run.id, null), null, 'nothing is confirmed over a withdrawn source');
});

test('cancelled or foreign runs can never confirm or resurrect a permission', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const tools: ResearchTools = {
    async execute(action) {
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT)]);
      return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
    }
  };
  const runner = runnerFor(f, tools);
  t.after(() => runner.stopAll());
  await runToWait(f, runner);
  const input = confirmInput(f);

  // Wrong owner is refused before anything is written.
  assert.throws(
    () => f.persons.applyConfirmation('someone-else', f.run.id, input, 'key-foreign'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'run_not_found'
  );
  const first = f.persons.applyConfirmation(OWNER, f.run.id, input, 'key-cancel-case');
  assert.equal(first.idempotent, false);

  // Cancelling the run freezes the permission: a replay can never resurrect
  // it and the runner never dispatches again.
  runner.cancel(f.run.id);
  assert.throws(
    () => f.persons.applyConfirmation(OWNER, f.run.id, input, 'key-cancel-case'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'run_not_waiting',
    'a cancelled run refuses replay as a live permission'
  );
  assert.notEqual(activePersonConfirmation(f.db, f.run.id, f.firstStep.link(f.run.id)!.inputRevision), null, 'history is preserved');
  const before = f.store.research.receipts(f.run.id).length;
  runner.enqueue(f.run.id);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(f.store.getRun(f.run.id)!.state, 'cancelled');
  assert.equal(f.store.research.receipts(f.run.id).length, before, 'a cancelled run never dispatches again');

  // Deleting the run cascades its confirmation rows entirely.
  f.db.prepare('DELETE FROM runs WHERE id = ?').run(f.run.id);
  assert.throws(
    () => f.persons.applyConfirmation(OWNER, f.run.id, input, 'key-deleted'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'run_not_found'
  );
});
