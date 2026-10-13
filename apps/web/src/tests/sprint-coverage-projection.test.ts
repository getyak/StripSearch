import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageFixture, loadBaseline } from '../../scripts/benchmark-coverage.js';
import type { FixtureOptions } from '../../scripts/benchmark-coverage.js';
import type { TestContext } from 'node:test';

// Normal CI also runs in shallow clones. The explicit offline differential run
// additionally loads the frozen revision; it must fail if that revision is absent.
const Baseline = process.env.STRIPSEARCH_COVERAGE_BASELINE_COMPARE === '1' ? await loadBaseline() : null;
function fixture(t: TestContext, options: FixtureOptions = { accounts: 2, itemsPerAccount: 4 }) {
  const value = coverageFixture(options);
  t.after(() => value.db.close());
  const baseline = Baseline ? new Baseline(value.db, value.cases, value.completion) : null;
  return { ...value, baseline, equivalent: () => {
    const actual = value.read();
    const expected = JSON.stringify(value.read(baseline ?? value.coverage));
    assert.equal(JSON.stringify(actual), expected, 'including serialized property/array order and receipt history');
    return actual;
  } };
}

test('production projection preserves duplicate pages/replays, receipt-only, unknown dates, revision and parent history', t => {
  const f = fixture(t);
  const view = f.equivalent();
  assert.equal(view.items.length, 8);
  assert.equal(f.coverage.listFetchReceipts(f.ownerId, f.caseId).length, f.drafts.length);
  const first = f.sources[0]; assert.ok(first);
  const item = view.items.find(entry => entry.content.sourceId === first.sourceId); assert.ok(item);
  assert.equal(item.newerRevisionAvailable, 2);
  assert.equal(item.dateKnown, false);
  assert.equal(item.inWindow, true);
  assert.equal(item.media.conflict, true);
  const body = item.dimensions[0]; assert.ok(body);
  assert.equal(body.state, 'failed');
  assert.deepEqual(body.history.map(entry => entry.state), ['read', 'failed']);
  assert.ok(body.history[0]!.occurredAt > body.history[1]!.occurredAt);
  assert.deepEqual(item.dimensions[3]!.parents, [{ commentKey: 'parent', state: 'missing' }, { commentKey: 'parent', state: 'deleted' }]);
  assert.equal(item.dimensions[3]!.history.length, 2);
  assert.equal(item.dimensions[4]!.branchSelected, false);
  for (const account of view.accounts) {
    assert.equal(account.enumeratedItems, 3);
    assert.equal(account.receiptOnlyItems, 1);
    assert.equal(account.total, 4);
    assert.equal(account.denominatorKnown, true);
  }
});

for (const enumeration of ['exhausted', 'unknown', 'none'] as const) {
  test(`empty ${enumeration} projection retains zero/unknown denominator and null percentages`, t => {
    const f = fixture(t, { accounts: 1, itemsPerAccount: 0, enumeration });
    const view = f.equivalent();
    assert.equal(view.items.length, 0);
    assert.equal(view.accounts[0]!.total, enumeration === 'exhausted' ? 0 : null);
    assert.ok(view.accounts[0]!.dimensions.every(dimension => dimension.percent === null));
  });
}

test('open cursor and receipt-only projections retain unknown denominators', t => {
  for (const enumeration of ['unknown', 'none'] as const) {
    const f = fixture(t, { accounts: 1, itemsPerAccount: 3, enumeration });
    const view = f.equivalent();
    assert.equal(view.accounts[0]!.denominatorKnown, false);
    assert.ok(view.accounts[0]!.dimensions.every(dimension => dimension.percent === null));
    if (enumeration === 'none') assert.ok(view.items.every(item => !item.enumerated));
  }
});

test('successive reads derive evidence revocation and transitive enumeration withdrawal without an authority cache', t => {
  const f = fixture(t);
  f.equivalent();
  f.revoke();
  const view = f.equivalent();
  const source = f.sources[0]!;
  assert.equal(view.accounts.find(account => account.accountId === source.accountId)!.enumeration.basis, 'dependency_withdrawn');
  const item = view.items.find(entry => entry.content.sourceId === source.sourceId)!;
  assert.ok(item.dimensions.every(dimension => !dimension.countsAsValidRead));
  assert.equal(item.dimensions[0]!.dependencyValidity, 'review');
  assert.ok(item.dimensions[0]!.history[0]!.dependencyReviewReason!.includes('已撤回'));
});

test('stale frozen scope retains old/current receipt histories but cannot regain denominator from a later scope', t => {
  const f = fixture(t);
  f.equivalent();
  const current = f.stale();
  f.coverage.recordFetchReceipt({ ownerId: f.ownerId, caseId: f.caseId, expectedScopeVersion: current.case.scopeVersion,
    receipt: { ...f.drafts[0]!, receiptKey: 'new-scope-receipt' } });
  const view = f.equivalent();
  assert.equal(view.scopeStale, true);
  assert.ok(view.accounts.every(account => account.total === null));
  assert.ok(view.items.every(item => item.dimensions.every(dimension => !dimension.countsAsValidRead)));
  const item = view.items.find(entry => entry.content.sourceId === f.sources[0]!.sourceId)!;
  assert.equal(item.dimensions[0]!.history.length, 3);
  assert.equal(item.dimensions[0]!.state, 'failed'); // Frozen-scope history still wins over newer-scope read.
});

for (const corruption of ['role', 'account', 'case', 'missing-evidence', 'missing-revision', 'missing-source', 'malformed-metadata'] as const) {
  test(`persisted ${corruption} retains baseline validity and serialized projection`, t => {
    const f = fixture(t);
    const first = f.sources[0]!;
    const initial = JSON.stringify(f.read());
    // Deliberate damaged-storage characterization, never a production write path.
    f.db.pragma('foreign_keys = OFF');
    if (corruption === 'role') f.db.prepare('UPDATE research_case_evidence SET role = ? WHERE id = ?').run('attributed_statement', first.evidenceId);
    if (corruption === 'account') f.db.prepare('UPDATE research_case_evidence SET account_id = ? WHERE id = ?').run('foreign-account', first.evidenceId);
    if (corruption === 'case') f.db.prepare('UPDATE research_case_evidence SET case_id = ? WHERE id = ?').run('foreign-case', first.evidenceId);
    if (corruption === 'missing-evidence') f.db.prepare('DELETE FROM research_case_evidence WHERE id = ?').run(first.evidenceId);
    if (corruption === 'missing-revision') f.db.prepare('DELETE FROM research_case_source_revisions WHERE source_id = ? AND revision = 1').run(first.sourceId);
    if (corruption === 'missing-source') f.db.prepare('DELETE FROM research_case_sources WHERE id = ?').run(first.sourceId);
    if (corruption === 'malformed-metadata') {
      f.db.prepare('UPDATE research_case_source_revisions SET provenance_json = ? WHERE source_id = ?').run('{', first.sourceId);
      f.db.prepare('UPDATE research_case_evidence SET provenance_json = ? WHERE id = ?').run('{', first.evidenceId);
    }
    f.db.pragma('foreign_keys = ON');
    const view = f.equivalent();
    const item = view.items.find(entry => entry.content.sourceId === first.sourceId)!;
    if (['role', 'account', 'case', 'missing-evidence'].includes(corruption)) assert.equal(item.dimensions[1]!.dependencyValidity, 'review');
    if (['missing-source', 'missing-revision'].includes(corruption)) assert.equal(item.publishedAt, null);
    if (corruption === 'malformed-metadata') assert.equal(JSON.stringify(view), initial);
  });
}

test('owner/case/spec miss reads preserve null boundaries', t => {
  const f = fixture(t);
  for (const store of [f.coverage, ...(f.baseline ? [f.baseline] : [])]) {
    assert.equal(store.getFetchCoverageView('foreign-owner', f.caseId, f.frozen.scopeSpecId), null);
    assert.equal(store.getFetchCoverageView(f.ownerId, 'missing-case', f.frozen.scopeSpecId), null);
    assert.equal(store.getFetchCoverageView(f.ownerId, f.caseId, 'missing-spec'), null);
  }
});
