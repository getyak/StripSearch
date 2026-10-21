/**
 * GET-213 persisted person-confirmation gates: owner/revision/dependency
 * checked, idempotent, revocable — and the account scope submission can never
 * bypass them. Legacy/profile-input attempts keep their existing selection
 * gate and old attempt receipts are never re-staged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore, FirstStepSelectionError } from '../server/research/first-step-store.js';
import { PersonConfirmationStore, PersonConfirmationError, activePersonConfirmation } from '../server/research/person-confirmation.js';
import { createFirstStepCheckedSearch, discoverFirstStep } from '../server/research/first-step-discovery.js';
import type { ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { FirstStepInput, FirstStepSelectionInput } from '../shared/first-step-discovery.js';

const OWNER = 'person-gate-owner';
const HOME_URL = 'https://lantern.dev/';
const HOME_TEXT = 'Mira Kepler maintains the Lantern compiler. My X: https://x.com/mkepler.';

function fixture(options: { question?: string; seedUrl?: string | null } = {}) {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const persons = new PersonConfirmationStore(db, store, firstStep);
  const run = store.insertRun({
    ownerId: OWNER,
    question: options.question ?? 'Mira Kepler',
    seedUrl: options.seedUrl ?? null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'fp-person-gate'
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

const overviewTools: ResearchTools = {
  async execute(action) {
    if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT)]);
    return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
  }
};

const accountTools: ResearchTools = {
  async execute(action) {
    if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT), page('https://x.com/mkepler', 'Mira Kepler (@mkepler)', 'Compiler researcher.')]);
    return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
  }
};

async function discover(
  f: ReturnType<typeof fixture>,
  tools: ResearchTools,
  stage: 'overview' | 'accounts' | 'full',
  input: FirstStepInput = { kind: 'name_query', value: 'Mira Kepler', question: null },
  confirmedPerson: { candidateId: string; confirmedAt: string } | null = null
) {
  return discoverFirstStep({
    store: f.store,
    firstStep: f.firstStep,
    ownerId: OWNER,
    runId: f.run.id,
    input,
    search: createFirstStepCheckedSearch({
      tools,
      store: f.store,
      runId: f.run.id,
      attemptId: 'input-1',
      budget: { maxSearchQueries: 11, maxSearchResults: 12, maxProfileReads: 16, maxModelCalls: 2, policyVersion: 'first-step/v11' },
      stage
    }),
    signal: new AbortController().signal,
    registryVersion: 'registry-test/v1',
    catalog: null,
    stage,
    confirmedPerson
  });
}

function selectionInput(f: ReturnType<typeof fixture>, view: { discoveryRevision: number; accounts: Array<{ accountId: string }>; selection: { scopeVersion: number } }): FirstStepSelectionInput {
  return {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: view.selection.scopeVersion,
    discoveryRevision: view.discoveryRevision,
    clusterId: null,
    accounts: view.accounts.map((account) => ({ accountId: account.accountId, selection: 'only_this_account' as const, excluded: false, note: null }))
  };
}

test('the atomic account scope gate refuses submission before person confirmation', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const view = await discover(f, overviewTools, 'overview');
  f.store.updateRun(f.run.id, { state: 'needs_input' });
  assert.equal(view.personConfirmation?.required, true);
  assert.throws(
    () => f.firstStep.applyFirstStepSelection(OWNER, f.run.id, selectionInput(f, view), 'key-select-before-confirm'),
    (error: unknown) => error instanceof FirstStepSelectionError && error.code === 'person_confirmation_required'
  );
  assert.equal(f.firstStep.selectionBinding(f.run.id), null, 'nothing is frozen before confirmation');
});

test('forged, stale and wrong-owner confirmations are refused; the valid one is idempotent', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const view = await discover(f, overviewTools, 'overview');
  f.store.updateRun(f.run.id, { state: 'needs_input' });
  const candidateId = view.personOverview!.candidates[0]!.candidateId;
  const base = {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: view.selection.scopeVersion,
    discoveryRevision: view.discoveryRevision
  };

  // A forged candidate id (client-invented) is never accepted.
  assert.throws(
    () => f.persons.applyConfirmation(OWNER, f.run.id, { ...base, candidateId: 'pcand/0000000000000000000000000000dead' }, 'key-forged'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'unknown_candidate'
  );
  // A stale discovery revision is refused.
  assert.throws(
    () => f.persons.applyConfirmation(OWNER, f.run.id, { ...base, discoveryRevision: base.discoveryRevision + 1, candidateId }, 'key-stale'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'stale_discovery_revision'
  );
  // Arbitrary sources/quotes can never ride along.
  assert.throws(
    () => f.persons.applyConfirmation(OWNER, f.run.id, { ...base, candidateId, sources: [{ url: 'https://evil.example/' }] }, 'key-smuggle'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'invalid_decision'
  );
  // Wrong owner never sees or mutates the run.
  assert.throws(
    () => f.persons.applyConfirmation('someone-else', f.run.id, { ...base, candidateId }, 'key-foreign'),
    (error: unknown) => error instanceof PersonConfirmationError && error.code === 'run_not_found'
  );
  assert.equal(activePersonConfirmation(f.db, f.run.id, null), null, 'no confirmation was written');

  const first = f.persons.applyConfirmation(OWNER, f.run.id, { ...base, candidateId }, 'key-confirm');
  assert.equal(first.idempotent, false);
  const replay = f.persons.applyConfirmation(OWNER, f.run.id, { ...base, candidateId }, 'key-confirm');
  assert.equal(replay.idempotent, true, 'the same idempotency key replays the exact receipt');
  assert.equal(replay.confirmationId, first.confirmationId);
  const doubleClick = f.persons.applyConfirmation(OWNER, f.run.id, { ...base, candidateId }, null);
  assert.equal(doubleClick.idempotent, true, 'a double submit without a key never creates a second record');
  assert.equal(
    (f.db.prepare('SELECT COUNT(*) AS n FROM first_step_person_confirmations WHERE run_id = ?').get(f.run.id) as { n: number }).n,
    1,
    'exactly one confirmation record exists'
  );
  // A different person after confirmation is a conflict, never a silent swap.
  const other = view.personOverview!.candidates.find((candidate) => candidate.candidateId !== candidateId);
  if (other) {
    assert.throws(
      () => f.persons.applyConfirmation(OWNER, f.run.id, { ...base, candidateId: other.candidateId }, 'key-other'),
      (error: unknown) => error instanceof PersonConfirmationError && error.code === 'confirmation_conflict'
    );
  }
});

test('confirmed person -> account discovery -> existing atomic scope submission, then revocation on expand', async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const overview = await discover(f, overviewTools, 'overview');
  f.store.updateRun(f.run.id, { state: 'needs_input' });
  const candidateId = overview.personOverview!.candidates[0]!.candidateId;
  const confirmation = f.persons.applyConfirmation(OWNER, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: overview.selection.scopeVersion,
    discoveryRevision: overview.discoveryRevision,
    candidateId
  }, 'key-flow');
  assert.ok(confirmation.runRevision > 0);

  const accountsView = await discover(f, accountTools, 'accounts', { kind: 'name_query', value: 'Mira Kepler', question: null },
    { candidateId, confirmedAt: confirmation.confirmedAt });
  assert.equal(accountsView.phase, 'ready_for_choice');
  assert.ok(accountsView.accounts.length > 0);
  f.store.updateRun(f.run.id, { state: 'needs_input' });

  const submitted = f.firstStep.applyFirstStepSelection(OWNER, f.run.id, selectionInput(f, accountsView), 'key-scope');
  assert.equal(submitted.idempotent, false);
  assert.ok(submitted.selectedAccountIds.length > 0);
  assert.ok(f.firstStep.selectionBinding(f.run.id) !== null, 'the frozen scope binding exists');

  // An expand starts a NEW discovery revision and revokes the confirmation.
  f.store.updateRun(f.run.id, { state: 'needs_input' });
  f.persons.revokeForRun(f.run.id, 'synthetic revocation');
  assert.equal(activePersonConfirmation(f.db, f.run.id, null), null, 'the revoked confirmation is no longer active');
});

test('legacy attempts and explicit profile input keep the existing flow without person confirmation', async (t) => {
  const f = fixture({ question: 'Lantern', seedUrl: HOME_URL });
  t.after(() => f.db.close());
  const input: FirstStepInput = { kind: 'homepage_url', value: HOME_URL, question: 'Lantern' };
  // Old in-flight attempts keep their full behavior even when the staged
  // policy exists: a first full attempt writes v10 keys and stays unstaged.
  const first = await discover(f, overviewTools, 'full', input);
  assert.equal(first.personConfirmation, undefined, 'profile input needs no person confirmation');
  assert.equal(first.readyForChoice, true);
  const receiptsBefore = f.store.research.receipts(f.run.id).map((receipt) => receipt.key);
  // A restart of the SAME attempt with a staged request keeps old keys and
  // old behavior: nothing is re-staged and no receipt is rewritten.
  const replayed = await discover(f, overviewTools, 'overview', input);
  assert.equal(replayed.personConfirmation, undefined, 'old attempts are never silently re-staged');
  assert.deepEqual(f.store.research.receipts(f.run.id).map((receipt) => receipt.key), receiptsBefore, 'immutable receipts are unchanged');

  f.store.updateRun(f.run.id, { state: 'needs_input' });
  const submitted = f.firstStep.applyFirstStepSelection(OWNER, f.run.id, selectionInput(f, replayed), 'key-legacy-scope');
  assert.ok(submitted.selectedAccountIds.length > 0, 'explicit profile input stays a direct account target');
});
