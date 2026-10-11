import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFirstStepUrl } from '../shared/first-step-discovery.js';
import { seedFirstStep } from './first-step-fixtures.js';

function classify(url: string) {
  const result = classifyFirstStepUrl(url); assert.equal(result.ok, true); if (!result.ok) throw new Error('invalid fixture'); return result.ref;
}

test('generic shared hosts retain distinct personal namespaces and attributable descendants', () => {
  for (const prefix of ['~', 'users/', 'people/', 'faculty/', 'authors/']) {
    const home = classify(`https://faculty.fixture-university.org/${prefix}lin/`);
    const other = classify(`https://faculty.fixture-university.org/${prefix}morgan/`);
    const article = classify(`https://faculty.fixture-university.org/${prefix}lin/papers/article`);
    assert.notEqual(home.accountKey, other.accountKey);
    assert.equal(home.accountKey, article.accountKey);
    assert.equal(home.entry, 'profile'); assert.equal(article.entry, 'page');
    assert.equal(classify(`https://faculty.fixture-university.org/${prefix}lin/index.html`).accountKey, home.accountKey);
    assert.notEqual(classify('https://faculty.fixture-university.org/').accountKey, home.accountKey);
  }
  assert.notEqual(classify('https://sites.google.com/view/lin/').accountKey, classify('https://sites.google.com/view/morgan/').accountKey);
});

test('selecting one shared-host personal directory authorizes its content and refuses other authors', t => {
  const home = 'https://faculty.fixture-university.org/~lin/';
  const f = seedFirstStep({ accounts: [{ url: home }, { url: 'https://faculty.fixture-university.org/~morgan/' }] });
  t.after(() => f.close());
  const result = f.firstStep.getFirstStepView('user-owner', f.run.id)!; assert.equal(result.mode, 'first_step'); if (result.mode !== 'first_step') throw new Error('wrong mode');
  const view = result.view;
  f.firstStep.applyFirstStepSelection('user-owner', f.run.id, { expectedRunRevision: f.store.getRun(f.run.id)!.revision, expectedScopeVersion: view.selection.scopeVersion, discoveryRevision: view.discoveryRevision, clusterId: null,
    accounts: view.accounts.map((account, i) => ({ accountId: account.accountId, selection: i === 0 ? 'only_this_account' : 'not_selected', excluded: false })) }, 'shared-host');
  const guard = f.firstStep.scopeGuard('user-owner', f.run.id);
  guard.assertDispatch({ type: 'read', url: `${home}papers/article` });
  assert.throws(() => guard.assertDispatch({ type: 'read', url: 'https://faculty.fixture-university.org/~morgan/papers/article' }), /不属于任何已选账号/);
  assert.throws(() => guard.assertIngest([{ url: 'https://faculty.fixture-university.org/~morgan/papers/article', links: [] }]), /不属于任何已选账号/);
});
