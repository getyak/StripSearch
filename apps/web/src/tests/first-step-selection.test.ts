import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFirstStep } from './first-step-fixtures.js';
import { FirstStepSelectionError } from '../server/research/first-step-store.js';
import type { FirstStepSelectionInput } from '../shared/first-step-discovery.js';
import type { AccountSelection } from '../shared/research-case.js';

function baseInput(seeded: { run: { revision: number }; discoveryRevision: number }, accounts: FirstStepSelectionInput['accounts']): Record<string, unknown> {
  return {
    expectedRunRevision: seeded.run.revision,
    expectedScopeVersion: 1,
    discoveryRevision: seeded.discoveryRevision,
    clusterId: 'cluster-1',
    accounts
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof FirstStepSelectionError, `expected FirstStepSelectionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

test('one atomic submit binds run, scope and discovery versions and freezes the fetch scope', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://github.com/linzhou-lantern', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: 'My GitHub: https://github.com/linzhou-lantern' } },
      { url: 'https://x.com/linzhou_public' }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    const result = seeded.firstStep.applyFirstStepSelection(
      'user-owner',
      seeded.run.id,
      baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
        { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
        { accountId: seeded.accountIdFor(1), selection: 'selected', excluded: false },
        { accountId: seeded.accountIdFor(2), selection: 'not_selected', excluded: false }
      ]),
      'key-1'
    );
    assert.equal(result.idempotent, false);
    assert.equal(result.scopeVersion, 2);
    assert.equal(result.runRevision, run.revision + 1);
    assert.deepEqual(result.selectedAccountIds, [seeded.accountIdFor(0), seeded.accountIdFor(1)]);

    const updated = seeded.store.getRun(seeded.run.id)!;
    assert.equal(updated.state, 'queued', 'selected scope proceeds to fetch');
    assert.equal(updated.revision, result.runRevision);
    const binding = seeded.firstStep.selectionBinding(seeded.run.id)!;
    assert.equal(binding.scopeVersion, 2);
    assert.equal(binding.discoveryRevision, seeded.discoveryRevision);
    assert.deepEqual(binding.selectedAccountIds, [seeded.accountIdFor(0), seeded.accountIdFor(1)]);
    assert.equal(Object.keys(binding.accountKeys).length, 2);

    const accounts = seeded.store.cases.listAccounts('user-owner', seeded.caseId);
    const byId = new Map(accounts.map((account) => [account.accountId, account]));
    assert.equal(byId.get(seeded.accountIdFor(0))!.userSelection.state, 'selected');
    assert.equal(byId.get(seeded.accountIdFor(2))!.userSelection.state, 'not_selected');
    assert.equal(byId.get(seeded.accountIdFor(2))!.allowedScope.state, 'none', 'unselected account has no read scope');

    // The view reflects the live user facets and the submitted state.
    const view = seeded.firstStep.getFirstStepView('user-owner', seeded.run.id);
    assert.ok(view && view.mode === 'first_step');
    assert.equal(view.view.selection.submitted, true);
    assert.equal(view.view.selection.scopeVersion, 2);
  } finally {
    seeded.close();
  }
});

test('owner isolation: a foreign owner cannot read or submit', () => {
  const seeded = seedFirstStep({ accounts: [{ url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } }] });
  try {
    assert.equal(seeded.firstStep.getFirstStepView('someone-else', seeded.run.id), null);
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'someone-else',
          seeded.run.id,
          baseInput({ run: seeded.store.getRun(seeded.run.id)!, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false }
          ]),
          null
        ),
      'run_not_found'
    );
  } finally {
    seeded.close();
  }
});

test('foreign accounts and stale run/scope/discovery versions fail closed with no writes', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://x.com/linzhou_public' }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: 'acct_fs_foreign', selection: 'selected', excluded: false }
          ]),
          null
        ),
      'foreign_account'
    );
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          { ...baseInput({ run, discoveryRevision: seeded.discoveryRevision }, []), expectedRunRevision: run.revision - 1 },
          null
        ),
      'stale_run_revision'
    );
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          { ...baseInput({ run, discoveryRevision: seeded.discoveryRevision }, []), expectedScopeVersion: 9 },
          null
        ),
      'stale_scope_version'
    );
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          { ...baseInput({ run, discoveryRevision: seeded.discoveryRevision }, []), discoveryRevision: seeded.discoveryRevision + 5 },
          null
        ),
      'stale_discovery_revision'
    );
    // Nothing moved: run and case versions are untouched, no receipt exists.
    assert.equal(seeded.store.getRun(seeded.run.id)!.revision, run.revision);
    assert.equal(seeded.store.getRun(seeded.run.id)!.state, 'needs_input');
    assert.equal(seeded.store.cases.getCase('user-owner', seeded.caseId)!.scopeVersion, 1);
    assert.equal(seeded.firstStep.selectionBinding(seeded.run.id), null);
  } finally {
    seeded.close();
  }
});

test('idempotency: the same key and payload replays, a different payload conflicts', () => {
  const seeded = seedFirstStep({ accounts: [{ url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } }] });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    const input = baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
      { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false }
    ]);
    const first = seeded.firstStep.applyFirstStepSelection('user-owner', seeded.run.id, input, 'key-idem');
    assert.equal(first.idempotent, false);
    const replay = seeded.firstStep.applyFirstStepSelection('user-owner', seeded.run.id, input, 'key-idem');
    assert.equal(replay.idempotent, true);
    assert.equal(replay.scopeVersion, first.scopeVersion);
    assert.equal(seeded.store.cases.getCase('user-owner', seeded.caseId)!.scopeVersion, 2, 'replay never advances scope again');
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          { ...input, clusterId: 'cluster-other' },
          'key-idem'
        ),
      'idempotency_conflict'
    );
  } finally {
    seeded.close();
  }
});

test('zero selection is rejected and a batch rolls back atomically', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://x.com/linzhou_public' }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: seeded.accountIdFor(0), selection: 'not_selected', excluded: false },
            { accountId: seeded.accountIdFor(1), selection: 'unanswered', excluded: false }
          ]),
          null
        ),
      'empty_selection'
    );
    // Whole-batch rollback: the valid entry must not survive the invalid one.
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
            { accountId: seeded.accountIdFor(1), selection: 'selected', excluded: false }
          ]),
          null
        ),
      'invalid_decision',
    );
    const accounts = seeded.store.cases.listAccounts('user-owner', seeded.caseId);
    for (const account of accounts as AccountSelection[]) {
      assert.equal(account.userSelection.state, 'unanswered', `account ${account.accountId} must be untouched`);
      assert.equal(account.allowedScope.state, 'none');
    }
    assert.equal(seeded.store.cases.getCase('user-owner', seeded.caseId)!.scopeVersion, 1);
  } finally {
    seeded.close();
  }
});

test('selection never upgrades identity evidence and uncertain accounts need independent scope', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://x.com/linzhou_public' }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    const before = seeded.store.cases.listAccounts('user-owner', seeded.caseId)[1]!;
    assert.equal(before.identitySupport.state, 'proposed');
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
            { accountId: seeded.accountIdFor(1), selection: 'selected', excluded: false }
          ]),
          null
        ),
      'invalid_decision'
    );
    const result = seeded.firstStep.applyFirstStepSelection(
      'user-owner',
      seeded.run.id,
      baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
        { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
        { accountId: seeded.accountIdFor(1), selection: 'only_this_account', excluded: false }
      ]),
      null
    );
    assert.deepEqual(result.independentAccountIds, [seeded.accountIdFor(1)]);
    const after = seeded.store.cases.listAccounts('user-owner', seeded.caseId);
    const uncertain = after.find((account) => account.accountId === seeded.accountIdFor(1))!;
    assert.equal(uncertain.identitySupport.state, 'proposed', 'selection never upgrades identity support');
    assert.deepEqual(uncertain.identitySupport.evidenceIds, []);
    assert.equal(uncertain.userSelection.state, 'only_this_account', 'uncertain account stays an independent scope');
    const supported = after.find((account) => account.accountId === seeded.accountIdFor(0))!;
    assert.equal(supported.identitySupport.state, 'supported');
    assert.ok(supported.identitySupport.evidenceIds.length === 1);
  } finally {
    seeded.close();
  }
});

test('explicit exclusion is recorded, revocable and never becomes identity support', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://x.com/linzhou_public' }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    const result = seeded.firstStep.applyFirstStepSelection(
      'user-owner',
      seeded.run.id,
      baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
        { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
        { accountId: seeded.accountIdFor(1), selection: 'not_selected', excluded: true, note: '不是此人' }
      ]),
      null
    );
    assert.deepEqual(result.excludedAccountIds, [seeded.accountIdFor(1)]);
    assert.deepEqual(seeded.firstStep.activeExclusions(seeded.run.id).map((e) => e.accountId), [seeded.accountIdFor(1)]);
    const excluded = seeded.store.cases.listAccounts('user-owner', seeded.caseId).find((a) => a.accountId === seeded.accountIdFor(1))!;
    assert.equal(excluded.userSelection.state, 'not_selected');
    assert.equal(excluded.identitySupport.state, 'proposed');

    // A new discovery revision lets the user revoke the exclusion explicitly.
    const revision = seeded.republish();
    const rerun = seeded.store.getRun(seeded.run.id)!;
    seeded.store.updateRun(seeded.run.id, { state: 'needs_input' });
    const second = seeded.firstStep.applyFirstStepSelection(
      'user-owner',
      seeded.run.id,
      {
        expectedRunRevision: seeded.store.getRun(seeded.run.id)!.revision,
        expectedScopeVersion: 2,
        discoveryRevision: revision,
        clusterId: 'cluster-1',
        accounts: [
          { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
          { accountId: seeded.accountIdFor(1), selection: 'not_selected', excluded: false }
        ]
      },
      null
    );
    void rerun;
    assert.deepEqual(second.excludedAccountIds, []);
    assert.deepEqual(seeded.firstStep.activeExclusions(seeded.run.id), [], 'revoked exclusion is no longer active');
    const revoked = seeded.store.cases.listAccounts('user-owner', seeded.caseId).find((a) => a.accountId === seeded.accountIdFor(1))!;
    assert.equal(revoked.identitySupport.state, 'proposed', 'revocation never becomes identity support');
    assert.deepEqual(revoked.identitySupport.evidenceIds, []);
  } finally {
    seeded.close();
  }
});

test('a run that is not waiting for confirmation refuses selection', () => {
  const seeded = seedFirstStep({ accounts: [{ url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } }] });
  try {
    seeded.store.updateRun(seeded.run.id, { state: 'researching' });
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          baseInput({ run: seeded.store.getRun(seeded.run.id)!, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false }
          ]),
          null
        ),
      'run_not_waiting'
    );
  } finally {
    seeded.close();
  }
});

test('incomplete decision batches are rejected; every current account answers exactly once', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://github.com/linzhou-lantern', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: 'My GitHub: https://github.com/linzhou-lantern' } }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          baseInput({ run, discoveryRevision: seeded.discoveryRevision }, [
            { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false }
          ]),
          'missing-account'
        ),
      'incomplete_batch'
    );
    // Omitted accounts never keep stale state: nothing moved.
    const accounts = seeded.store.cases.listAccounts('user-owner', seeded.caseId);
    for (const account of accounts) assert.equal(account.userSelection.state, 'unanswered');
    assert.equal(seeded.store.cases.getCase('user-owner', seeded.caseId)!.scopeVersion, 1);
  } finally {
    seeded.close();
  }
});

test('person cluster binding: nonexistent clusters and cross-cluster same-person merges are rejected', () => {
  const seeded = seedFirstStep({
    accounts: [
      { url: 'https://lantern.dev/', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://github.com/linzhou-lantern', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: 'My GitHub: https://github.com/linzhou-lantern' } }
    ]
  });
  try {
    const run = seeded.store.getRun(seeded.run.id)!;
    const both = [
      { accountId: seeded.accountIdFor(0), selection: 'selected' as const, excluded: false },
      { accountId: seeded.accountIdFor(1), selection: 'selected' as const, excluded: false }
    ];
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          { ...baseInput({ run, discoveryRevision: seeded.discoveryRevision }, both), clusterId: 'nonexistent-person' },
          'foreign-cluster'
        ),
      'invalid_cluster'
    );
    // Same-person joins need a bound cluster: null only allows independent scopes.
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          { ...baseInput({ run, discoveryRevision: seeded.discoveryRevision }, both), clusterId: null },
          'null-cluster'
        ),
      'invalid_cluster'
    );
    // Cross-cluster merge: cluster-2's account cannot join cluster-1.
    const revision = seeded.republish((view) => ({
      ...view,
      clusters: [
        { clusterId: 'cluster-1', displayName: '林舟', anchorUrl: null, anchorLabel: '锚点一', leads: [], conflicts: [], accountIds: [seeded.accountIdFor(0)] },
        { clusterId: 'cluster-2', displayName: '同名另一个人', anchorUrl: null, anchorLabel: '锚点二', leads: [], conflicts: [], accountIds: [seeded.accountIdFor(1)] }
      ]
    }));
    seeded.store.updateRun(seeded.run.id, { state: 'needs_input' });
    expectCode(
      () =>
        seeded.firstStep.applyFirstStepSelection(
          'user-owner',
          seeded.run.id,
          {
            expectedRunRevision: seeded.store.getRun(seeded.run.id)!.revision,
            expectedScopeVersion: 1,
            discoveryRevision: revision,
            clusterId: 'cluster-1',
            accounts: both
          },
          'cross-cluster'
        ),
      'invalid_cluster'
    );
    // A valid binding: cluster-1 person plus explicit independent material.
    const ok = seeded.firstStep.applyFirstStepSelection(
      'user-owner',
      seeded.run.id,
      {
        expectedRunRevision: seeded.store.getRun(seeded.run.id)!.revision,
        expectedScopeVersion: 1,
        discoveryRevision: revision,
        clusterId: 'cluster-1',
        accounts: [
          { accountId: seeded.accountIdFor(0), selection: 'selected', excluded: false },
          { accountId: seeded.accountIdFor(1), selection: 'only_this_account', excluded: false }
        ]
      },
      null
    );
    assert.equal(ok.clusterId, 'cluster-1');
    assert.deepEqual(ok.selectedAccountIds, [seeded.accountIdFor(0), seeded.accountIdFor(1)]);
    assert.deepEqual(ok.independentAccountIds, [seeded.accountIdFor(1)], 'independent material stays isolated');
    const binding = seeded.firstStep.selectionBinding(seeded.run.id)!;
    assert.equal(binding.clusterId, 'cluster-1');
    assert.deepEqual(binding.independentAccountIds, [seeded.accountIdFor(1)]);
  } finally {
    seeded.close();
  }
});
