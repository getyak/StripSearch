import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFirstStep } from './first-step-fixtures.js';
import { FirstStepSelectionError } from '../server/research/first-step-store.js';
import { classifyFirstStepUrl } from '../shared/first-step-discovery.js';
import { asScopeVersion } from '../shared/research-case.js';

function accountKeyFor(url: string): string {
  const classified = classifyFirstStepUrl(url);
  if (!classified.ok) throw new Error(`classify failed: ${url}`);
  return classified.ref.accountKey;
}

function expectOut(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof FirstStepSelectionError, `expected FirstStepSelectionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

/** Seed two selected accounts (one joined, one independent) plus one unselected. */
function seedSelected() {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://x.com/selected_author', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: 'Accounts: @selected_author' } },
      { url: 'https://x.com/unselected_auth' },
      { url: 'https://medium.com/@excluded_writer' }
    ]
  });
  const run = seeded.store.getRun(seeded.run.id)!;
  seeded.firstStep.applyFirstStepSelection(
    'user-owner',
    seeded.run.id,
    {
      expectedRunRevision: run.revision,
      expectedScopeVersion: 1,
      discoveryRevision: seeded.discoveryRevision,
      clusterId: 'cluster-1',
      accounts: [
        { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
        { accountId: seeded.accountIdFor(1), selection: 'only_this_account', excluded: false },
        { accountId: seeded.accountIdFor(2), selection: 'not_selected', excluded: false },
        { accountId: seeded.accountIdFor(3), selection: 'not_selected', excluded: true, note: '不是此人' }
      ]
    },
    'scope-key'
  );
  return seeded;
}

test('links never grant authority: linked unselected and linked excluded accounts are refused', () => {
  const seeded = seedSelected();
  try {
    const guard = seeded.firstStep.scopeGuard('user-owner', seeded.run.id);
    // The in-scope account is readable and its content may expand locally.
    const accepted = guard.assertIngest([
      { url: 'https://x.com/selected_author', links: ['https://x.com/unselected_auth', 'https://medium.com/@excluded_writer'] }
    ]);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.accountId, seeded.accountIdFor(1));
    // A link from a selected page cannot authorize an unselected account.
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://x.com/unselected_auth' }), 'out_of_scope');
    // ...nor an account the user explicitly excluded.
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://medium.com/@excluded_writer' }), 'out_of_scope');
    // Ingestion re-checks too, before anything is accepted.
    expectOut(
      () =>
        guard.assertIngest([
          { url: 'https://x.com/selected_author' },
          { url: 'https://x.com/unselected_auth' }
        ]),
      'out_of_scope'
    );
  } finally {
    seeded.close();
  }
});

test('later-discovered accounts, unsafe links and shared hosts cannot pass the scope guard', () => {
  const seeded = seedSelected();
  try {
    const guard = seeded.firstStep.scopeGuard('user-owner', seeded.run.id);
    // A brand-new account discovered during fetch has no frozen scope.
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://x.com/late_discovery' }), 'out_of_scope');
    // Unsafe or invalid URLs are refused outright.
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'http://lantern.dev/about' }), 'out_of_scope');
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://127.0.0.1/x' }), 'out_of_scope');
    // Same host but a different author is never attributable to the selected one.
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://medium.com/@selected_author_moments' }), 'out_of_scope');
    // Attributable content of the selected accounts stays readable.
    assert.ok(guard.assertDispatch({ type: 'read', url: 'https://lantern.dev/works/compiler' }));
    assert.ok(guard.assertDispatch({ type: 'read', url: 'https://x.com/selected_author/status/1' }));
  } finally {
    seeded.close();
  }
});

test('after selection public_history permits real content operations on the selected account only', () => {
  const seeded = seedSelected();
  try {
    const guard = seeded.firstStep.scopeGuard('user-owner', seeded.run.id);
    // Posts of the selected X account are an allowed content operation.
    const posts = guard.assertDispatch({ type: 'social_posts', url: 'https://x.com/selected_author' });
    assert.ok(posts && posts.accountId === seeded.accountIdFor(1));
    // Posts of an unselected account remain refused.
    expectOut(() => guard.assertDispatch({ type: 'social_posts', url: 'https://x.com/unselected_auth' }), 'out_of_scope');
    // The X Firecrawl prohibition stays in force even inside the scope.
    expectOut(() => guard.assertDispatch({ type: 'firecrawl', url: 'https://x.com/selected_author' }), 'out_of_scope');
    // Search stays allowed and only re-checks the frozen scope.
    assert.equal(guard.assertDispatch({ type: 'search' }), null);
  } finally {
    seeded.close();
  }
});

test('scope version changes invalidate the frozen fetch scope before dispatch and ingestion', () => {
  const seeded = seedSelected();
  try {
    const guard = seeded.firstStep.scopeGuard('user-owner', seeded.run.id);
    assert.ok(guard.assertDispatch({ type: 'read', url: 'https://lantern.dev/about' }));
    // The user changes the case scope after the selection was frozen.
    seeded.store.cases.advanceScope(
      { ownerId: 'user-owner', caseId: seeded.caseId, accountId: seeded.accountIdFor(0), expectedScopeVersion: asScopeVersion(2) },
      'user changed scope after selection'
    );
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://lantern.dev/about' }), 'scope_changed');
    expectOut(() => guard.assertIngest([{ url: 'https://lantern.dev/about' }]), 'scope_changed');
  } finally {
    seeded.close();
  }
});

test('an exclusion recorded after the freeze blocks reading before dispatch and ingestion', () => {
  const seeded = seedSelected();
  try {
    const guard = seeded.firstStep.scopeGuard('user-owner', seeded.run.id);
    assert.ok(guard.assertDispatch({ type: 'read', url: 'https://x.com/selected_author' }));
    // Simulate a later explicit exclusion statement for the frozen account.
    seeded.db
      .prepare(
        'INSERT INTO first_step_exclusions (id, run_id, case_id, account_id, statement, recorded_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
      )
      .run('excl_late', seeded.run.id, seeded.caseId, seeded.accountIdFor(1), '用户声明：不是此人。', new Date().toISOString());
    expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://x.com/selected_author' }), 'out_of_scope');
    expectOut(() => guard.assertIngest([{ url: 'https://x.com/selected_author/status/2' }]), 'out_of_scope');
  } finally {
    seeded.close();
  }
});

test('the frozen binding keeps independent account material isolated with its own scope', () => {
  const seeded = seedSelected();
  try {
    const binding = seeded.firstStep.selectionBinding(seeded.run.id)!;
    assert.equal(binding.clusterId, 'cluster-1');
    assert.deepEqual(binding.independentAccountIds, [seeded.accountIdFor(1)]);
    assert.equal(binding.accountKeys[accountKeyFor('https://x.com/selected_author')], seeded.accountIdFor(1));
    assert.ok(Object.keys(binding.accountKeys).length === 2, 'only the chosen accounts are frozen in');
    assert.equal(binding.accountKeys[accountKeyFor('https://x.com/unselected_auth')], undefined);
  } finally {
    seeded.close();
  }
});


test('retry lineage retains later exclusions from the retried run and its follow-up ancestors', t => {
  const seeded = seedSelected(); t.after(() => seeded.close());
  const child = seeded.store.insertRun({ ownerId: 'user-owner', question: 'retry selected scope', seedUrl: null,
    provider: 'research', parentRunId: null, retryOf: seeded.run.id, followup: false, idempotencyKey: null, bodyFingerprint: 'scope-retry' });
  seeded.firstStep.inheritFirstStepScope('user-owner', child, seeded.run.id);
  const guard = seeded.firstStep.scopeGuard('user-owner', child.id);
  guard.assertDispatch({ type: 'read', url: 'https://x.com/selected_author' });
  seeded.db.prepare('INSERT INTO first_step_exclusions (id, run_id, case_id, account_id, statement, recorded_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
    .run('exclude-before-retry-read', seeded.run.id, seeded.caseId, seeded.accountIdFor(1), '用户声明：不是此人。', new Date().toISOString());
  expectOut(() => guard.assertDispatch({ type: 'read', url: 'https://x.com/selected_author' }), 'out_of_scope');
  expectOut(() => guard.assertIngest([{ url: 'https://x.com/selected_author/status/2' }]), 'out_of_scope');
});
