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

test('withdrawing an unselected intermediate anchor invalidates downstream person attribution and an existing report', t => {
  const f = seedFirstStep({ accounts: [{ url: 'https://fixture-first-home.org/' },
    { url: 'https://fixture-second-home.org/', supportedBy: { sourceUrl: 'https://fixture-first-home.org/', quote: 'My other home: https://fixture-second-home.org/.' } },
    { url: 'https://github.com/fixture-linked', supportedBy: { sourceUrl: 'https://fixture-second-home.org/', quote: 'My GitHub: https://github.com/fixture-linked.' } }] });
  t.after(() => f.close());
  const current = view(f); const payload: FirstStepSelectionInput = {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision, expectedScopeVersion: current.selection.scopeVersion,
    discoveryRevision: current.discoveryRevision, clusterId: current.clusters[0]!.clusterId,
    accounts: current.accounts.map((account, i) => ({ accountId: account.accountId, selection: i === 2 ? 'selected' : 'not_selected', excluded: false })) };
  f.firstStep.applyFirstStepSelection('user-owner', f.run.id, payload, 'choose-linked');
  assert.ok(f.firstStep.selectionBinding(f.run.id)!.identityDependencyAccountIds?.includes(f.accountIds[1]!));
  const quote = 'I write public notes about compilers.';
  const checkpoint = f.store.research.checkpoint(f.run.id)!;
  checkpoint.anchorUrl = 'https://github.com/fixture-linked';
  checkpoint.pages = [{ sourceKey: 'S1', url: checkpoint.anchorUrl, title: 'Synthetic public profile', text: quote, kind: 'profile', publishedAt: null, links: [], limitations: [], retrieval: 'profile' }];
  checkpoint.claims = [{ sourceKey: 'S1', quote, statement: 'Writes public compiler notes.', kind: 'attributed_statement', section: 'work' }];
  f.store.research.save(f.run.id, checkpoint);
  f.store.addSource(f.run.id, { key: 'S1', url: checkpoint.anchorUrl, title: 'Synthetic public profile', kind: 'profile', publishedAt: null,
    excerpt: quote, excerptLocator: 'Synthetic bio', identityLabel: 'Synthetic selected person', identityConfirmed: true, fetchStatus: 'ok', limits: [] }, 0);
  f.store.updateRun(f.run.id, { state: 'completed', identity_json: JSON.stringify({ displayName: 'Lin Zhou', handle: null, profileUrl: checkpoint.anchorUrl, status: 'resolved', note: null, candidates: [] }),
    answer_json: JSON.stringify([{ id: 'work', heading: 'Public work', body: '', bullets: [{ text: 'Writes public compiler notes.', sourceKeys: ['S1'], kind: 'attributed_statement' }] }]) });
  assert.ok(f.store.buildCanonicalView(f.store.getRun(f.run.id)!).personObject);
  const middle = f.store.cases.listAccounts('user-owner', f.caseId)[1]!;
  f.store.cases.revokeEvidence({ ownerId: 'user-owner', caseId: f.caseId, accountId: middle.accountId,
    expectedScopeVersion: f.store.cases.getCase('user-owner', f.caseId)!.scopeVersion }, middle.identitySupport.evidenceIds[0]!);
  const derived = view(f).accounts[2]!;
  assert.equal(derived.identity.state, 'supported', 'account-own evidence remains historical support');
  assert.equal(derived.identity.validity, 'review'); assert.equal(derived.defaultSuggestion.suggested, false); assert.equal(derived.requiresIndependentScope, true);
  assert.throws(() => f.firstStep.scopeGuard('user-owner', f.run.id).assertDispatch({ type: 'read', url: `${checkpoint.anchorUrl}/project` }), /归属依据已失效/);
  assert.throws(() => f.firstStep.scopeGuard('user-owner', f.run.id).assertIngest([{ url: `${checkpoint.anchorUrl}/project`, links: [] }]), /归属依据已失效/);
  const report = f.store.buildCanonicalView(f.store.getRun(f.run.id)!);
  assert.equal(report.identity.status, 'ambiguous'); assert.equal(report.personObject, undefined);
  assert.equal(report.answer[0]!.bullets[0]!.validity, 'review'); assert.equal(report.sources[0]!.identityConfirmed, false);
  assert.equal(report.sources[0]!.excerpt, quote); assert.equal(report.sources[0]!.fetchStatus, 'ok', 'own public source remains accessible material');
  assert.equal(f.store.getRun(f.run.id)!.identity.status, 'resolved', 'historical report identity is not overwritten');
  assert.equal(f.store.listSources(f.run.id)[0]!.identityConfirmed, true, 'historical source facet is not rewritten');
});

test('a disputed anchor cannot use the anchor-intent exception to merge person facts', t => {
  const home = 'https://fixture-disputed-home.org/';
  const f = seedFirstStep({ accounts: [{ url: home, supportedBy: { sourceUrl: 'https://fixture-linking-home.org/', quote: `My website: ${home}` },
    deniedBy: { sourceUrl: 'https://fixture-denial-home.org/', quote: `This is not my website: ${home}` } }] });
  t.after(() => f.close()); const current = view(f);
  const payload: FirstStepSelectionInput = { expectedRunRevision: f.store.getRun(f.run.id)!.revision, expectedScopeVersion: current.selection.scopeVersion,
    discoveryRevision: current.discoveryRevision, clusterId: current.clusters[0]!.clusterId, accounts: [{ accountId: f.accountIds[0]!, selection: 'selected', excluded: false }] };
  assert.equal(current.accounts[0]!.identity.state, 'disputed');
  assert.throws(() => f.firstStep.applyFirstStepSelection('user-owner', f.run.id, payload, 'disputed-merged'), /独立账号/);
  assert.equal(f.firstStep.selectionBinding(f.run.id), null);
  payload.clusterId = null; payload.accounts[0]!.selection = 'only_this_account';
  f.firstStep.applyFirstStepSelection('user-owner', f.run.id, payload, 'disputed-independent');
  f.firstStep.scopeGuard('user-owner', f.run.id).assertDispatch({ type: 'read', url: home });
});
