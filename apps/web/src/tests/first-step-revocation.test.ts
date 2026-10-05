import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFirstStep } from './first-step-fixtures.js';
import type { FirstStepSelectionInput } from '../shared/first-step-discovery.js';

function fixture() {
  return seedFirstStep({ accounts: [{ url: 'https://fixture-linzhou.org/' },
    { url: 'https://github.com/fixture-linzhou', supportedBy: { sourceUrl: 'https://fixture-linzhou.org/', quote: 'My GitHub: https://github.com/fixture-linzhou.' } }] });
}
function view(f: ReturnType<typeof fixture>) {
  const result = f.firstStep.getFirstStepView('user-owner', f.run.id)!;
  assert.equal(result.mode, 'first_step'); if (result.mode !== 'first_step') throw new Error('wrong flow'); return result.view;
}
function decisions(f: ReturnType<typeof fixture>): FirstStepSelectionInput {
  const current = view(f);
  return { expectedRunRevision: f.store.getRun(f.run.id)!.revision, expectedScopeVersion: current.selection.scopeVersion,
    discoveryRevision: current.discoveryRevision, clusterId: current.clusters[0]!.clusterId,
    accounts: current.accounts.map(account => ({ accountId: account.accountId, selection: 'selected', excluded: false })) };
}
function withdraw(f: ReturnType<typeof fixture>) {
  const account = f.store.cases.listAccounts('user-owner', f.caseId)[1]!;
  f.store.cases.revokeEvidence({ ownerId: 'user-owner', caseId: f.caseId, accountId: account.accountId,
    expectedScopeVersion: f.store.cases.getCase('user-owner', f.caseId)!.scopeVersion }, account.identitySupport.evidenceIds[0]!);
}

test('withdrawn evidence invalidates current recommendation and merged selection without rewriting stored facets', t => {
  const f = fixture(); t.after(() => f.close()); withdraw(f);
  const account = view(f).accounts[1]!;
  assert.equal(account.identity.state, 'supported', 'stored historical facet remains unchanged');
  assert.equal(account.identity.validity, 'review');
  assert.equal(account.identity.evidence.length, 0);
  assert.equal(account.defaultSuggestion.suggested, false);
  assert.equal(account.requiresIndependentScope, true);
  const scopeBefore = f.store.cases.getCase('user-owner', f.caseId)!.scopeVersion;
  assert.throws(() => f.firstStep.applyFirstStepSelection('user-owner', f.run.id, decisions(f), 'merged-withdrawn'), /归属依据已失效/);
  assert.equal(f.store.cases.getCase('user-owner', f.caseId)!.scopeVersion, scopeBefore);
  assert.equal(f.firstStep.selectionBinding(f.run.id), null);
});

test('withdrawal after selection rejects dispatch and late ingestion; independent account scope remains separate', t => {
  const f = fixture(); t.after(() => f.close());
  f.firstStep.applyFirstStepSelection('user-owner', f.run.id, decisions(f), 'choose');
  const guard = f.firstStep.scopeGuard('user-owner', f.run.id);
  guard.assertDispatch({ type: 'read', url: 'https://github.com/fixture-linzhou/project' });
  withdraw(f);
  assert.throws(() => guard.assertDispatch({ type: 'read', url: 'https://github.com/fixture-linzhou/project' }), /归属依据已失效/);
  assert.throws(() => guard.assertIngest([{ url: 'https://github.com/fixture-linzhou/project', links: [] }]), /归属依据已失效/);

  const independent = fixture(); t.after(() => independent.close()); withdraw(independent);
  const payload = decisions(independent); payload.clusterId = null;
  payload.accounts = payload.accounts.map((item, i) => ({ ...item, selection: i === 1 ? 'only_this_account' : 'not_selected' }));
  independent.firstStep.applyFirstStepSelection('user-owner', independent.run.id, payload, 'independent');
  const binding = independent.firstStep.selectionBinding(independent.run.id)!;
  assert.deepEqual(binding.independentAccountIds, [independent.accountIds[1]]);
  independent.firstStep.scopeGuard('user-owner', independent.run.id).assertDispatch({ type: 'read', url: 'https://github.com/fixture-linzhou/project' });
});
