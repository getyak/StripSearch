/**
 * GET-58 research-case domain contract regressions.
 *
 * Covered with synthetic fixtures only (no network, no real people):
 * two candidates on one platform; user selection never promoting identity
 * support; atomic immutable scope snapshots with stale-write rejection and
 * batch rollback; evidence reference integrity (existence, owner/case/account
 * provenance and role compatibility) on every write; revocation dependencies
 * for factual support, counterevidence and identity support; export semantic
 * parity between canonical JSON and Markdown; stable ids under withdrawal;
 * source revision history across reopen; old-database migration and report
 * readability with legacy/no-authorization provenance; distinct
 * run.revision / personRevision / scopeVersion / sourceRevision dimensions;
 * typed task references with stable per-item coverage records.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import type { AccountDraft, CaseWriteContext } from '../server/research/case-store.js';
import {
  CaseNotFoundError,
  EvidenceRoleError,
  ForeignReferenceError,
  ScopeBypassError,
  StaleScopeError,
  asScopeVersion,
  legacyNoAuthorizationProvenance,
  taskRefKey
} from '../shared/research-case.js';
import type {
  AccountSelection,
  CaseReportView,
  RecordProvenance,
  ResearchCase,
  ScopeVersion
} from '../shared/research-case.js';
import { renderCaseJson, renderCaseMarkdown, renderJson, renderMarkdown } from '../shared/canonical.js';

const OWNER = 'owner-synthetic';
const PROVENANCE: RecordProvenance = {
  authorization: 'not_recorded',
  collector: 'synthetic-fixture',
  note: null
};

function tempBase(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tempBase(), prefix));
}

function memoryStore(): { db: DB; store: Store } {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  return { db, store: new Store(db) };
}

function newCase(store: Store, ownerId = OWNER, intent = 'Synthetic research case'): ResearchCase {
  return store.cases.createCase({ ownerId, intent, provenance: PROVENANCE });
}

function draft(overrides: Partial<AccountDraft> = {}): AccountDraft {
  return {
    platform: 'synthetic',
    handle: 'synthetic-handle',
    profileUrl: 'https://fixture.test/synthetic-handle',
    identitySupport: {
      state: 'proposed',
      evidenceIds: [],
      counterevidenceIds: [],
      policyVersion: 'identity-policy/v1',
      note: null
    },
    userSelection: { state: 'unanswered', note: null, recordedAt: null },
    allowedScope: { state: 'none', note: null },
    researchValue: { state: 'unassessed', rationale: null },
    accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null },
    ...overrides
  };
}

function ctx(caseRecord: ResearchCase, accountId: string, expectedScopeVersion?: ScopeVersion): CaseWriteContext {
  return {
    ownerId: caseRecord.ownerId,
    caseId: caseRecord.caseId,
    accountId,
    expectedScopeVersion: expectedScopeVersion ?? caseRecord.scopeVersion
  };
}

function sourceDraft(overrides: Record<string, unknown> = {}) {
  return {
    author: 'Synthetic Author',
    originalUrl: 'https://fixture.test/synthetic-source',
    title: 'Synthetic source',
    publishedAt: '2026-01-01',
    retrievedAt: '2026-01-02T00:00:00.000Z',
    locator: 'paragraph 1',
    contentHash: 'a'.repeat(64),
    provenance: PROVENANCE,
    ...overrides
  };
}

test('two candidates on the same platform stay independent unselected accounts', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const first = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'first' }));
  const second = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'second' }));

  assert.notEqual(first.accountId, second.accountId);
  const accounts = store.cases.listAccounts(OWNER, record.caseId);
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.platform), ['synthetic', 'synthetic']);
  // Discovery never implies a user selection for either candidate.
  for (const account of accounts) {
    assert.equal(account.userSelection.state, 'unanswered');
    assert.equal(account.identitySupport.state, 'proposed');
  }
});

test('user selection is a scope change and never promotes identity support', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
  const identityBefore = account.identitySupport;

  // One-submit selection of the candidate: scope path, version advances.
  const change = store.cases.applyScopeChange({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: record.scopeVersion,
    reason: 'synthetic one-submit confirmation',
    accounts: [{ accountId: account.accountId, userSelection: { state: 'selected', note: 'synthetic choice', recordedAt: '2026-01-03' } }]
  });
  assert.equal(change.case.scopeVersion, 2);
  const selected = change.accounts[0] as AccountSelection;
  assert.equal(selected.userSelection.state, 'selected');
  // Selection is intent only: identity evidence support is untouched.
  assert.deepEqual(selected.identitySupport, identityBefore);
  assert.equal(selected.identitySupport.state, 'proposed');

  // Identity facet updates never touch the user selection either.
  const updated = store.cases.updateAccountFacets(ctx(change.case, account.accountId), {
    identitySupport: { ...identityBefore, note: 'synthetic identity note' }
  });
  assert.equal(updated.identitySupport.note, 'synthetic identity note');
  assert.equal(updated.userSelection.state, 'selected');

  // Creating an account with a user selection must use the scope path.
  assert.throws(
    () =>
      store.cases.addAccount(
        ctx(record, 'ignored', change.case.scopeVersion),
        draft({ userSelection: { state: 'selected', note: null, recordedAt: '2026-01-03' } })
      ),
    ScopeBypassError
  );
});

test('scope mutations are atomic, snapshotted verbatim and versioned across reopen', () => {
  const dir = tempDir('get58-scope-');
  const dbPath = path.join(dir, 'case.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  try {
    const record = newCase(store);
    const first = store.cases.addAccount(
      ctx(record, 'ignored'),
      draft({ allowedScope: { state: 'profile_only', note: null } })
    );
    const second = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'other' }));
    assert.equal(store.cases.getCase(OWNER, record.caseId)?.scopeVersion, 1);

    // Widening allowedScope is a scope mutation: version advances atomically.
    store.cases.updateAccountFacets(ctx(record, first.accountId), {
      allowedScope: { state: 'public_history', note: 'synthetic wider range' }
    });
    assert.equal(store.cases.getCase(OWNER, record.caseId)?.scopeVersion, 2);

    const history = store.cases.scopeHistory(OWNER, record.caseId);
    assert.equal(history.length, 4); // case_created + two account baselines + scope change
    const changeEntry = history[3];
    assert.ok(changeEntry);
    assert.equal(changeEntry.reason, 'account_scope_updated');
    assert.equal(changeEntry.scopeVersion, 2);
    const beforeById = new Map(changeEntry.before.map((entry) => [entry.accountId, entry]));
    const afterById = new Map(changeEntry.after.map((entry) => [entry.accountId, entry]));
    assert.deepEqual(
      [beforeById.get(first.accountId)?.userSelection.state, beforeById.get(first.accountId)?.allowedScope.state],
      ['unanswered', 'profile_only']
    );
    assert.deepEqual(
      [beforeById.get(second.accountId)?.userSelection.state, beforeById.get(second.accountId)?.allowedScope.state],
      ['unanswered', 'none']
    );
    assert.deepEqual(
      [afterById.get(first.accountId)?.userSelection.state, afterById.get(first.accountId)?.allowedScope.state],
      ['unanswered', 'public_history']
    );
    assert.deepEqual(
      [afterById.get(second.accountId)?.userSelection.state, afterById.get(second.accountId)?.allowedScope.state],
      ['unanswered', 'none']
    );
    assert.deepEqual(
      changeEntry.before.map((entry) => entry.accountId).sort(),
      changeEntry.after.map((entry) => entry.accountId).sort()
    );

    // Old-scope writes are rejected; same-scope writes still work.
    assert.throws(
      () => store.cases.recordSourceRevision(ctx(record, first.accountId, asScopeVersion(1)), sourceDraft()),
      StaleScopeError
    );
    const accepted = store.cases.recordSourceRevision(
      ctx(record, first.accountId, asScopeVersion(2)),
      sourceDraft()
    );
    assert.equal(accepted.sourceRevision, 1);

    // Batch selection through the atomic path: one version, full snapshots.
    const batch = store.cases.applyScopeChange({
      ownerId: OWNER,
      caseId: record.caseId,
      expectedScopeVersion: asScopeVersion(2),
      reason: 'synthetic batch confirmation',
      accounts: [
        { accountId: first.accountId, userSelection: { state: 'only_this_account', note: null, recordedAt: '2026-01-04' } },
        { accountId: second.accountId, allowedScope: { state: 'profile_only', note: null } }
      ]
    });
    assert.equal(batch.case.scopeVersion, 3);
    assert.equal(batch.snapshot.before.length, 2);
    assert.equal(batch.snapshot.after.length, 2);

    // Reopen: history and old scope snapshots are preserved verbatim.
    db.close();
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    store = new Store(db);
    const reopened = store.cases.scopeHistory(OWNER, record.caseId);
    assert.deepEqual(reopened, history.concat(batch.snapshot));
    // Old scope stays readable after the newer scope exists.
    const oldScope = reopened.filter((entry) => entry.scopeVersion <= 2).slice(-1)[0];
    assert.ok(oldScope);
    assert.equal(oldScope.after.find((entry) => entry.accountId === first.accountId)?.allowedScope.state, 'public_history');
    assert.equal(oldScope.after.find((entry) => entry.accountId === second.accountId)?.allowedScope.state, 'none');
    assert.throws(
      () => store.cases.recordSourceRevision(ctx(record, first.accountId, asScopeVersion(2)), sourceDraft()),
      StaleScopeError
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mixed valid/invalid scope batch leaves no partial changes', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const first = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'first' }));
  const second = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'second' }));
  const historyBefore = store.cases.scopeHistory(OWNER, record.caseId);

  assert.throws(
    () =>
      store.cases.applyScopeChange({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: record.scopeVersion,
        reason: 'synthetic mixed batch',
        accounts: [
          { accountId: first.accountId, userSelection: { state: 'selected', note: null, recordedAt: '2026-01-05' } },
          { accountId: 'acct_does_not_exist', userSelection: { state: 'selected', note: null, recordedAt: '2026-01-05' } },
          { accountId: second.accountId, allowedScope: { state: 'public_history', note: null } }
        ]
      }),
    ForeignReferenceError
  );

  // Nothing from the batch survives: no scope bump, no selection, no journal row.
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.scopeVersion, 1);
  const accounts = store.cases.listAccounts(OWNER, record.caseId);
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.userSelection.state), ['unanswered', 'unanswered']);
  assert.deepEqual(accounts.map((account) => account.allowedScope.state), ['none', 'none']);
  assert.deepEqual(store.cases.scopeHistory(OWNER, record.caseId), historyBefore);
});

test('every write validates evidence existence, provenance and role compatibility', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
  const writeCtx = ctx(record, account.accountId);
  const source = store.cases.recordSourceRevision(writeCtx, sourceDraft());
  const factual = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    role: 'factual_support',
    quote: 'Synthetic factual excerpt.',
    locator: 'paragraph 2',
    provenance: PROVENANCE
  });
  const identity = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    role: 'identity_support',
    quote: 'Synthetic identity link.',
    locator: 'profile links',
    provenance: PROVENANCE
  });

  // Identity evidence can never back a factual claim.
  assert.throws(
    () =>
      store.cases.addClaim(writeCtx, {
        statement: 'Synthetic factual statement.',
        kind: 'factual',
        supportIds: [identity.evidenceId],
        counterevidenceIds: [],
        limitations: []
      }),
    EvidenceRoleError
  );

  // One valid + one nonexistent reference: the claim must roll back whole.
  assert.throws(
    () =>
      store.cases.addClaim(writeCtx, {
        statement: 'Synthetic mixed statement.',
        kind: 'factual',
        supportIds: [factual.evidenceId, 'ev_nonexistent'],
        counterevidenceIds: [],
        limitations: []
      }),
    ForeignReferenceError
  );
  assert.deepEqual(store.cases.listClaims(OWNER, record.caseId), []);

  // Dangling identity references are rejected, never silently dropped.
  assert.throws(
    () =>
      store.cases.updateAccountFacets(writeCtx, {
        identitySupport: {
          state: 'supported',
          evidenceIds: ['unowned-nonexistent-evidence'],
          counterevidenceIds: [],
          policyVersion: 'identity-policy/v1',
          note: null
        }
      }),
    ForeignReferenceError
  );
  assert.deepEqual(
    store.cases.listAccounts(OWNER, record.caseId)[0]?.identitySupport,
    draft().identitySupport
  );

  // Wrong-role identity references are rejected as well.
  assert.throws(
    () =>
      store.cases.updateAccountFacets(writeCtx, {
        identitySupport: {
          state: 'supported',
          evidenceIds: [factual.evidenceId],
          counterevidenceIds: [],
          policyVersion: 'identity-policy/v1',
          note: null
        }
      }),
    EvidenceRoleError
  );

  // "supported" without any identity evidence is rejected.
  assert.throws(
    () =>
      store.cases.updateAccountFacets(writeCtx, {
        identitySupport: { state: 'supported', evidenceIds: [], counterevidenceIds: [], policyVersion: 'identity-policy/v1', note: null }
      }),
    ForeignReferenceError
  );

  // Account creation cannot carry invented identity evidence either.
  assert.throws(
    () =>
      store.cases.addAccount(
        ctx(record, 'ignored'),
        draft({
          accountId: 'acct_with_dangling',
          identitySupport: {
            state: 'supported',
            evidenceIds: [identity.evidenceId],
            counterevidenceIds: [],
            policyVersion: 'identity-policy/v1',
            note: null
          }
        })
      ),
    ForeignReferenceError
  );
  assert.equal(store.cases.listAccounts(OWNER, record.caseId).length, 1);

  // Valid identity support works only with real same-account identity evidence.
  const supported = store.cases.updateAccountFacets(writeCtx, {
    identitySupport: {
      state: 'supported',
      evidenceIds: [identity.evidenceId],
      counterevidenceIds: [],
      policyVersion: 'identity-policy/v1',
      note: null
    }
  });
  assert.equal(supported.identitySupport.state, 'supported');
  assert.deepEqual(supported.identitySupport.evidenceIds, [identity.evidenceId]);
});

test('owner, case and account boundaries reject foreign ids', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const mine = newCase(store, 'owner-a', 'Synthetic case A');
  const theirs = newCase(store, 'owner-b', 'Synthetic case B');
  const myAccount = store.cases.addAccount(ctx(mine, 'ignored'), draft({ handle: 'mine' }));
  const theirAccount = store.cases.addAccount(ctx(theirs, 'ignored'), draft({ handle: 'theirs' }));
  const theirSource = store.cases.recordSourceRevision(ctx(theirs, theirAccount.accountId), sourceDraft());
  const theirEvidence = store.cases.addEvidence(ctx(theirs, theirAccount.accountId), {
    sourceId: theirSource.sourceId,
    sourceRevision: theirSource.sourceRevision,
    role: 'factual_support',
    quote: 'Foreign synthetic excerpt.',
    locator: null,
    provenance: PROVENANCE
  });

  // Tenant boundary: another owner sees nothing.
  assert.equal(store.cases.getCase('owner-b', mine.caseId), null);
  assert.deepEqual(store.cases.listCases('owner-b').map((record) => record.caseId), [theirs.caseId]);
  assert.throws(
    () =>
      store.cases.recordSourceRevision(
        { ownerId: 'owner-b', caseId: mine.caseId, accountId: myAccount.accountId, expectedScopeVersion: mine.scopeVersion },
        sourceDraft()
      ),
    CaseNotFoundError
  );
  assert.throws(
    () =>
      store.cases.addClaim(
        { ownerId: 'owner-a', caseId: theirs.caseId, accountId: theirAccount.accountId, expectedScopeVersion: theirs.scopeVersion },
        { statement: 'x', kind: 'factual', supportIds: [], counterevidenceIds: [], limitations: [] }
      ),
    CaseNotFoundError
  );

  // Account boundary: an account never crosses cases.
  assert.throws(
    () =>
      store.cases.addClaim(
        { ownerId: 'owner-a', caseId: mine.caseId, accountId: theirAccount.accountId, expectedScopeVersion: mine.scopeVersion },
        { statement: 'x', kind: 'factual', supportIds: [], counterevidenceIds: [], limitations: [] }
      ),
    ForeignReferenceError
  );

  // Evidence provenance: foreign evidence is never usable, even in a mixed list.
  const ownSource = store.cases.recordSourceRevision(ctx(mine, myAccount.accountId), sourceDraft());
  const ownEvidence = store.cases.addEvidence(ctx(mine, myAccount.accountId), {
    sourceId: ownSource.sourceId,
    sourceRevision: ownSource.sourceRevision,
    role: 'factual_support',
    quote: 'Own synthetic excerpt.',
    locator: null,
    provenance: PROVENANCE
  });
  assert.throws(
    () =>
      store.cases.addClaim(ctx(mine, myAccount.accountId), {
        statement: 'Synthetic statement.',
        kind: 'factual',
        supportIds: [ownEvidence.evidenceId, theirEvidence.evidenceId],
        counterevidenceIds: [],
        limitations: []
      }),
    ForeignReferenceError
  );
  assert.deepEqual(store.cases.listClaims(OWNER, mine.caseId), []);

  // Same-case second account also keeps its own evidence private to itself.
  const secondAccount = store.cases.addAccount(ctx(mine, 'ignored'), draft({ handle: 'second' }));
  assert.throws(
    () =>
      store.cases.addClaim(ctx(mine, secondAccount.accountId), {
        statement: 'Synthetic statement.',
        kind: 'factual',
        supportIds: [ownEvidence.evidenceId],
        counterevidenceIds: [],
        limitations: []
      }),
    ForeignReferenceError
  );
});

test('withdrawing E1 keeps E2 and C2 identities unchanged across JSON and Markdown exports', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
  const writeCtx = ctx(record, account.accountId);
  const source = store.cases.recordSourceRevision(writeCtx, sourceDraft());
  const evidence = (evidenceId: string, role: 'factual_support' | 'factual_counterevidence' | 'identity_support', quote: string) =>
    store.cases.addEvidence(writeCtx, {
      evidenceId,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      role,
      quote,
      locator: 'synthetic locator',
      provenance: PROVENANCE
    });
  const e1 = evidence('E1', 'factual_support', 'Synthetic excerpt one.');
  const e2 = evidence('E2', 'factual_support', 'Synthetic excerpt two.');
  const e3 = evidence('E3', 'factual_counterevidence', 'Synthetic counter excerpt.');
  const e4 = evidence('E4', 'identity_support', 'Synthetic identity link.');
  store.cases.addClaim(writeCtx, {
    claimId: 'C1', statement: 'Synthetic claim one.', kind: 'factual',
    supportIds: [e1.evidenceId], counterevidenceIds: [], limitations: []
  });
  store.cases.addClaim(writeCtx, {
    claimId: 'C2', statement: 'Synthetic claim two.', kind: 'factual',
    supportIds: [e2.evidenceId], counterevidenceIds: [], limitations: []
  });
  store.cases.addClaim(writeCtx, {
    claimId: 'C3', statement: 'Synthetic claim three.', kind: 'inference',
    supportIds: [e2.evidenceId], counterevidenceIds: [e3.evidenceId], limitations: []
  });
  store.cases.updateAccountFacets(writeCtx, {
    identitySupport: {
      state: 'supported', evidenceIds: [e4.evidenceId], counterevidenceIds: [],
      policyVersion: 'identity-policy/v1', note: null
    }
  });

  const before = store.cases.reportView(OWNER, record.caseId);
  const beforeJson = renderCaseJson(before);
  const beforeMarkdown = renderCaseMarkdown(before);
  const c2LineBefore = beforeMarkdown.split('\n').find((line) => line.includes('（C2）'));
  assert.ok(c2LineBefore);

  // Withdraw E1: only its own record changes.
  store.cases.revokeEvidence(writeCtx, e1.evidenceId);
  const after = store.cases.reportView(OWNER, record.caseId);
  const afterJson = renderCaseJson(after);
  const afterMarkdown = renderCaseMarkdown(after);

  const parsedBefore = JSON.parse(beforeJson) as CaseReportView;
  const parsedAfter = JSON.parse(afterJson) as CaseReportView;
  // Surviving records keep their identities and content byte-for-byte.
  assert.deepEqual(
    parsedAfter.evidence.find((entry) => entry.evidenceId === 'E2'),
    parsedBefore.evidence.find((entry) => entry.evidenceId === 'E2')
  );
  assert.deepEqual(
    parsedAfter.claims.find((entry) => entry.claimId === 'C2'),
    parsedBefore.claims.find((entry) => entry.claimId === 'C2')
  );
  const c2LineAfter = afterMarkdown.split('\n').find((line) => line.includes('（C2）'));
  assert.equal(c2LineAfter, c2LineBefore);
  // Withdrawn E1 keeps its id and becomes visible as withdrawn, never renumbered.
  assert.equal(parsedAfter.evidence.find((entry) => entry.evidenceId === 'E1')?.revokedAt !== null, true);
  assert.deepEqual(parsedAfter.evidence.map((entry) => entry.evidenceId), ['E1', 'E2', 'E3', 'E4']);
  assert.deepEqual(parsedAfter.claims.map((entry) => entry.claimId), ['C1', 'C2', 'C3']);
  const c1 = parsedAfter.claims.find((entry) => entry.claimId === 'C1');
  assert.equal(c1?.validity, 'review');
  assert.match(c1?.reviewReason ?? '', /E1 已撤回/);

  // A withdrawn counterevidence dependency also forces review.
  store.cases.revokeEvidence(writeCtx, e3.evidenceId);
  const counterView = store.cases.reportView(OWNER, record.caseId);
  const c3 = counterView.claims.find((entry) => entry.claimId === 'C3');
  assert.equal(c3?.validity, 'review');
  assert.match(c3?.reviewReason ?? '', /E3 已撤回/);
  assert.deepEqual(counterView.claims.find((entry) => entry.claimId === 'C2')?.supportIds ?? [], ['E2']);

  // Identity support that leaned on withdrawn identity evidence is invalidated.
  store.cases.revokeEvidence(writeCtx, e4.evidenceId);
  const identityView = store.cases.reportView(OWNER, record.caseId);
  const identityAccount = identityView.accounts[0];
  assert.ok(identityAccount);
  // The stored record keeps its original state and ids; the view marks it.
  assert.equal(identityAccount.identitySupport.state, 'supported');
  assert.deepEqual(identityAccount.identitySupport.evidenceIds, ['E4']);
  assert.equal(identityAccount.identityValidity, 'review');
  assert.match(identityAccount.identityReviewReason ?? '', /E4 已撤回/);
  assert.match(renderCaseMarkdown(identityView), /需重新评估/);
});

test('claim kinds keep their meaning and reference semantics across exports', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
  const writeCtx = ctx(record, account.accountId);
  const source = store.cases.recordSourceRevision(writeCtx, sourceDraft());
  const support = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId, sourceRevision: source.sourceRevision, role: 'factual_support',
    quote: 'Synthetic support excerpt.', locator: null, provenance: PROVENANCE
  });
  const counter = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId, sourceRevision: source.sourceRevision, role: 'factual_counterevidence',
    quote: 'Synthetic counter excerpt.', locator: null, provenance: PROVENANCE
  });
  store.cases.addClaim(writeCtx, {
    claimId: 'CI', statement: 'Synthetic inferred interpretation.', kind: 'inference',
    supportIds: [support.evidenceId], counterevidenceIds: [counter.evidenceId], limitations: ['Synthetic limitation.']
  });
  store.cases.addClaim(writeCtx, {
    claimId: 'CA', statement: 'Synthetic self statement.', kind: 'attributed_statement',
    supportIds: [support.evidenceId], counterevidenceIds: [], limitations: []
  });

  const view = store.cases.reportView(OWNER, record.caseId);
  const json = renderCaseJson(view);
  const markdown = renderCaseMarkdown(view);
  const parsed = JSON.parse(json) as CaseReportView;
  assert.equal(parsed.claims.find((claim) => claim.claimId === 'CI')?.kind, 'inference');
  assert.equal(parsed.claims.find((claim) => claim.claimId === 'CA')?.kind, 'attributed_statement');

  const inferenceLine = markdown.split('\n').find((line) => line.includes('（CI）'));
  assert.ok(inferenceLine);
  assert.match(inferenceLine, /【推断】/);
  assert.doesNotMatch(inferenceLine, /【查到的事实】/);
  assert.match(inferenceLine, /支持 \[.*\]/);
  assert.match(inferenceLine, /反证 \[.*\]/);

  const selfLine = markdown.split('\n').find((line) => line.includes('（CA）'));
  assert.ok(selfLine);
  assert.match(selfLine, /【本人自述】/);
});

test('source updates create immutable revisions preserved after reopen', () => {
  const dir = tempDir('get58-sources-');
  const dbPath = path.join(dir, 'case.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  try {
    const record = newCase(store);
    const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
    const writeCtx = ctx(record, account.accountId);
    const first = store.cases.recordSourceRevision(
      writeCtx,
      sourceDraft({ locator: 'paragraph 1', contentHash: '1'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z' })
    );
    store.cases.recordSourceRevision(
      writeCtx,
      sourceDraft({
        sourceId: first.sourceId,
        author: 'Synthetic Author (revised)',
        locator: 'paragraph 4',
        contentHash: '2'.repeat(64),
        retrievedAt: '2026-01-08T00:00:00.000Z'
      })
    );

    db.close();
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    store = new Store(db);
    const revisions = store.cases.listSourceRevisions(OWNER, record.caseId, account.accountId, first.sourceId);
    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions.map((revision) => revision.sourceRevision), [1, 2]);
    // The old revision is immutable: original URL, locator, hash and time intact.
    assert.equal(revisions[0]?.contentHash, '1'.repeat(64));
    assert.equal(revisions[0]?.locator, 'paragraph 1');
    assert.equal(revisions[0]?.retrievedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(revisions[0]?.originalUrl, 'https://fixture.test/synthetic-source');
    assert.equal(revisions[0]?.publishedAt, '2026-01-01');
    assert.equal(revisions[1]?.contentHash, '2'.repeat(64));
    assert.equal(revisions[1]?.author, 'Synthetic Author (revised)');
    const view = store.cases.reportView(OWNER, record.caseId);
    assert.equal(view.sources[0]?.latestRevision, 2);
    assert.equal(view.sources[0]?.revisions.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const LEGACY_SCHEMA_SQL = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_run_id TEXT, retry_of TEXT,
  followup INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, question TEXT NOT NULL,
  seed_url TEXT, provider TEXT NOT NULL, idempotency_key TEXT, body_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, identity_json TEXT NOT NULL, answer_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL, usage_json TEXT NOT NULL, stop_reason TEXT, error_code TEXT,
  error_message TEXT, interrupted INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, deleted_at TEXT
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source_key TEXT NOT NULL, url TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL, published_at TEXT, retrieved_at TEXT NOT NULL,
  fetch_status TEXT NOT NULL, excerpt TEXT, excerpt_locator TEXT, identity_label TEXT NOT NULL,
  identity_confirmed INTEGER NOT NULL DEFAULT 0, limits_json TEXT NOT NULL DEFAULT '[]',
  excluded INTEGER NOT NULL DEFAULT 0, excluded_at TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE(run_id, source_key)
);
CREATE TABLE observations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, statement TEXT NOT NULL, kind TEXT NOT NULL,
  source_keys_json TEXT NOT NULL, limitations_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, seq)
);
CREATE TABLE research_checkpoints (
  run_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE research_actions (
  run_id TEXT NOT NULL, action_key TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  request_json TEXT NOT NULL, result_json TEXT, usage_json TEXT,
  reserved_input INTEGER NOT NULL DEFAULT 0, reserved_output INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, settled_at TEXT, PRIMARY KEY (run_id, action_key)
);
`;

test('old databases migrate additively and old reports stay readable with legacy provenance', () => {
  const dir = tempDir('get58-legacy-');
  const dbPath = path.join(dir, 'legacy.db');
  const db = openDatabase(dbPath);
  try {
    // A database created before GET-58: only the legacy alpha tables exist.
    db.exec(LEGACY_SCHEMA_SQL);
    const identity = {
      displayName: 'Synthetic Ada', handle: 'ada-fixture', profileUrl: 'https://fixture.test/ada',
      status: 'resolved', note: null, candidates: []
    };
    db.prepare(
      `INSERT INTO runs (id, owner_id, parent_run_id, retry_of, followup, state, question, seed_url, provider,
        idempotency_key, body_fingerprint, revision, identity_json, answer_json, limitations_json, usage_json,
        stop_reason, error_code, error_message, interrupted, cancel_requested, created_at, updated_at,
        started_at, finished_at, deleted_at)
       VALUES ('run_legacy', 'synthetic-owner', NULL, NULL, 0, 'completed', 'Synthetic legacy question',
        'https://fixture.test/ada', 'research', NULL, 'legacy-fingerprint', 3, ?, '[]', '[]',
        '{"provider":"research","requests":2,"bytes":10,"elapsedMs":null,"measurement":"observed"}',
        'done', NULL, NULL, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL)`
    ).run(JSON.stringify(identity));
    const insertSource = db.prepare(
      `INSERT INTO sources (id, run_id, source_key, url, title, kind, published_at, retrieved_at, fetch_status,
        excerpt, excerpt_locator, identity_label, identity_confirmed, limits_json, excluded, excluded_at,
        sort_order, created_at)
       VALUES (?, 'run_legacy', ?, ?, ?, ?, NULL, '2026-01-02T00:00:00.000Z', 'ok', ?, 'synthetic locator',
        'synthetic label', 1, '[]', 0, NULL, ?, '2026-01-02T00:00:00.000Z')`
    );
    insertSource.run('src_legacy_1', 'S1', 'https://fixture.test/ada', 'Synthetic Ada · profile', 'profile', 'Synthetic Ada builds compilers.', 0);
    insertSource.run('src_legacy_2', 'S2', 'https://fixture.test/w1', 'First synthetic work', 'work', 'Synthetic excerpt first quote text.', 1);
    insertSource.run('src_legacy_3', 'S3', 'https://fixture.test/w2', 'Second synthetic work', 'work', 'Synthetic excerpt second quote text.', 2);
    const checkpoint = {
      phase: 'done', steps: 3, startedAt: 0, elapsedMs: 5,
      anchorUrl: 'https://fixture.test/ada',
      identity,
      candidates: [],
      pages: [
        {
          url: 'https://fixture.test/ada', title: 'Synthetic Ada', text: 'Synthetic Ada builds compilers.',
          kind: 'profile', publishedAt: null, links: [], limitations: [], sourceKey: 'S1'
        },
        {
          url: 'https://fixture.test/w1', title: 'First synthetic work', text: 'Synthetic excerpt first quote text.',
          kind: 'work', publishedAt: null, links: [], limitations: [], sourceKey: 'S2'
        },
        {
          url: 'https://fixture.test/w2', title: 'Second synthetic work', text: 'Synthetic excerpt second quote text.',
          kind: 'work', publishedAt: null, links: [], limitations: [], sourceKey: 'S3'
        }
      ],
      claims: [
        { sourceKey: 'S2', quote: 'first quote', statement: 'First synthetic claim.', kind: 'page_statement', section: 'work' },
        { sourceKey: 'S3', quote: 'second quote', statement: 'Second synthetic claim.', kind: 'page_statement', section: 'work' }
      ],
      unknowns: ['Synthetic open question.'],
      stopReason: null
    };
    db.prepare('INSERT INTO research_checkpoints (run_id, data_json, updated_at) VALUES (?, ?, ?)')
      .run('run_legacy', JSON.stringify(checkpoint), '2026-01-02T00:00:00.000Z');

    // Additive migration: the new domain tables appear alongside the old ones.
    applyCoreSchema(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name);
    for (const table of ['research_cases', 'research_case_scope_versions', 'research_case_source_revisions', 'research_case_evidence']) {
      assert.ok(tables.includes(table), `missing additive table ${table}`);
    }

    const store = new Store(db);
    const run = store.getRun('run_legacy');
    assert.ok(run);
    assert.equal(run.revision, 3);
    const view = store.buildCanonicalView(run);
    assert.equal(view.state, 'completed');
    // Old Person Object ids keep their original checkpoint ordinals.
    assert.deepEqual(view.personObject?.claims.map((claim) => claim.id), ['C1', 'C2']);
    assert.deepEqual(view.personObject?.evidence.map((entry) => entry.id), ['E1', 'E2']);
    const json = renderJson(view);
    const markdown = renderMarkdown(view);
    assert.ok(json.includes('run_legacy'));
    assert.ok(markdown.includes('Synthetic Ada'));
    assert.ok(markdown.includes('https://fixture.test/w1'));

    // Legacy material adopted into the new domain keeps honest provenance.
    const legacyProvenance = legacyNoAuthorizationProvenance();
    assert.equal(legacyProvenance.authorization, 'legacy_no_authorization');
    const record = store.cases.createCase({
      ownerId: 'synthetic-owner',
      intent: 'Synthetic legacy adoption',
      provenance: legacyProvenance
    });
    const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
    const source = store.cases.recordSourceRevision(
      ctx(record, account.accountId),
      sourceDraft({ provenance: legacyProvenance })
    );
    const adopted = store.cases.reportView(record.ownerId, record.caseId);
    assert.equal(adopted.case.provenance.authorization, 'legacy_no_authorization');
    assert.equal(adopted.sources[0]?.revisions[0]?.provenance.authorization, 'legacy_no_authorization');
    assert.notEqual(adopted.case.provenance.authorization, 'user_confirmed');
    assert.notEqual(source.provenance.authorization, 'user_confirmed');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run revision, person revision, scope version and source revision stay distinct', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const run = store.insertRun({
    ownerId: OWNER,
    question: 'Synthetic revision dimensions',
    seedUrl: null,
    provider: 'github',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'revision-dimensions'
  });
  const record = newCase(store);
  const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
  const writeCtx = ctx(record, account.accountId);
  const source = store.cases.recordSourceRevision(writeCtx, sourceDraft());
  store.cases.recordSourceRevision(writeCtx, sourceDraft({ sourceId: source.sourceId, contentHash: 'b'.repeat(64) }));
  const evidence = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId, sourceRevision: 2, role: 'factual_support',
    quote: 'Synthetic excerpt.', locator: null, provenance: PROVENANCE
  });

  // Source revisions advance alone.
  assert.equal(source.sourceRevision, 1);
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.scopeVersion, 1);
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.personRevision, 1);

  // Scope advances alone.
  store.cases.advanceScope(writeCtx, 'synthetic scope reason');
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.scopeVersion, 2);
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.personRevision, 1);

  // Withdrawal advances the person revision alone.
  store.cases.revokeEvidence({ ...writeCtx, expectedScopeVersion: asScopeVersion(2) }, evidence.evidenceId);
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.personRevision, 2);
  assert.equal(store.cases.getCase(OWNER, record.caseId)?.scopeVersion, 2);

  // The legacy run revision never moves with any domain counter.
  assert.equal(store.getRun(run.id)?.revision, 1);
});

type RawCoverageRow = { id: string; task_ref_key: string; task_ref_json: string; latest_revision: number };

function rawCoverage(db: DB, itemId: string): RawCoverageRow {
  return db
    .prepare('SELECT id, task_ref_key, task_ref_json, latest_revision FROM research_case_item_coverage WHERE id = ?')
    .get(itemId) as RawCoverageRow;
}

test('per-content coverage locators keep accounts, posts and revisions distinct across reopen', () => {
  const dir = tempDir('get58-coverage-');
  const dbPath = path.join(dir, 'case.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  try {
    const record = newCase(store);
    const accountA = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'account-a' }));
    const accountB = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'account-b' }));
    const ctxA = ctx(record, accountA.accountId);
    const ctxB = ctx(record, accountB.accountId);
    const sourceA1 = store.cases.recordSourceRevision(ctxA, sourceDraft({ originalUrl: 'https://fixture.test/a/post-1' }));
    const sourceA2 = store.cases.recordSourceRevision(ctxA, sourceDraft({ originalUrl: 'https://fixture.test/a/post-2' }));
    const sourceA1r2 = store.cases.recordSourceRevision(
      ctxA,
      sourceDraft({ sourceId: sourceA1.sourceId, contentHash: 'b'.repeat(64) })
    );
    const sourceB1 = store.cases.recordSourceRevision(ctxB, sourceDraft({ originalUrl: 'https://fixture.test/b/post-1' }));
    const work = { kind: 'question_matrix' as const, slot: 'work' as const };
    const at = (accountId: string, sourceId: string, sourceRevision: number) => ({ accountId, sourceId, sourceRevision });

    // Unseen without evidence is allowed: the source revision is enough.
    const aWork = store.cases.recordItemCoverage(ctxA, {
      locator: at(accountA.accountId, sourceA1.sourceId, 1), taskRef: work,
      status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'A work'
    });
    // Same question, different account: never shares A's record.
    const bWork = store.cases.recordItemCoverage(ctxB, {
      locator: at(accountB.accountId, sourceB1.sourceId, 1), taskRef: work,
      status: 'blocked', evidenceIds: [], counterevidenceIds: [], note: 'B work'
    });
    assert.notEqual(bWork.itemId, aWork.itemId);
    // Same account, different post.
    const a2Work = store.cases.recordItemCoverage(ctxA, {
      locator: at(accountA.accountId, sourceA2.sourceId, 1), taskRef: work,
      status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'A second post'
    });
    assert.notEqual(a2Work.itemId, aWork.itemId);
    // Same account and post, different source revision.
    const a1r2Work = store.cases.recordItemCoverage(ctxA, {
      locator: at(accountA.accountId, sourceA1.sourceId, sourceA1r2.sourceRevision), taskRef: work,
      status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'A post revision 2'
    });
    assert.notEqual(a1r2Work.itemId, aWork.itemId);

    // Repeating the same (locator, taskRef) keeps the item id and appends history.
    const aWorkUpdate = store.cases.recordItemCoverage(ctxA, {
      locator: at(accountA.accountId, sourceA1.sourceId, 1), taskRef: work,
      status: 'evidence_found', evidenceIds: [], counterevidenceIds: [], note: 'A work updated'
    });
    assert.equal(aWorkUpdate.itemId, aWork.itemId);
    assert.equal(aWorkUpdate.revision, 2);

    const orderedBefore = store.cases.listItemCoverage(OWNER, record.caseId).map((item) => [
      item.itemId, item.status, item.locator.accountId, item.locator.sourceId, item.locator.sourceRevision
    ]);

    db.close();
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    store = new Store(db);
    const items = store.cases.listItemCoverage(OWNER, record.caseId);
    // Exact ids, statuses and locators in stable insertion order survive reopen.
    assert.deepEqual(
      items.map((item) => [item.itemId, item.status, item.locator.accountId, item.locator.sourceId, item.locator.sourceRevision]),
      orderedBefore
    );
    assert.deepEqual(items.map((item) => item.itemId), [aWork.itemId, bWork.itemId, a2Work.itemId, a1r2Work.itemId]);
    assert.deepEqual(
      items.map((item) => [item.itemId, item.status]),
      [
        [aWork.itemId, 'evidence_found'],
        [bWork.itemId, 'blocked'],
        [a2Work.itemId, 'unseen'],
        [a1r2Work.itemId, 'unseen']
      ]
    );
    // The first write is preserved as history, not overwritten.
    assert.deepEqual(
      store.cases.listItemCoverageHistory(OWNER, record.caseId, aWork.itemId).map((entry) => [entry.revision, entry.status, entry.note]),
      [[1, 'unseen', 'A work'], [2, 'evidence_found', 'A work updated']]
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit coverage itemIds reject rebinding and invalid writes roll back atomically', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const accountA = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'account-a' }));
  const accountB = store.cases.addAccount(ctx(record, 'ignored'), draft({ handle: 'account-b' }));
  const ctxA = ctx(record, accountA.accountId);
  const ctxB = ctx(record, accountB.accountId);
  const sourceA = store.cases.recordSourceRevision(ctxA, sourceDraft({ originalUrl: 'https://fixture.test/a/post' }));
  const sourceB = store.cases.recordSourceRevision(ctxB, sourceDraft({ originalUrl: 'https://fixture.test/b/post' }));
  const work = { kind: 'question_matrix' as const, slot: 'work' as const };
  const expression = { kind: 'question_matrix' as const, slot: 'expression' as const };
  const locatorA = { accountId: accountA.accountId, sourceId: sourceA.sourceId, sourceRevision: sourceA.sourceRevision };
  const locatorB = { accountId: accountB.accountId, sourceId: sourceB.sourceId, sourceRevision: sourceB.sourceRevision };
  const first = store.cases.recordItemCoverage(ctxA, {
    locator: locatorA, taskRef: work, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'work note'
  });

  // Rebind attempt: existing itemId plus a different (not yet existing) taskRef.
  const rawBefore = rawCoverage(db, first.itemId);
  const listBefore = store.cases.listItemCoverage(OWNER, record.caseId);
  assert.throws(
    () =>
      store.cases.recordItemCoverage(ctxA, {
        locator: locatorA, taskRef: expression, itemId: first.itemId,
        status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'rebind attempt'
      }),
    ForeignReferenceError
  );
  // Raw row and list are byte-identical; key and JSON stay consistent.
  assert.deepEqual(rawCoverage(db, first.itemId), rawBefore);
  assert.equal(rawBefore.task_ref_key, taskRefKey(JSON.parse(rawBefore.task_ref_json) as Parameters<typeof taskRefKey>[0]));
  assert.deepEqual(store.cases.listItemCoverage(OWNER, record.caseId), listBefore);

  // The original binding survives: a normal work update keeps the id.
  const workUpdate = store.cases.recordItemCoverage(ctxA, {
    locator: locatorA, taskRef: work, itemId: first.itemId,
    status: 'evidence_found', evidenceIds: [], counterevidenceIds: [], note: null
  });
  assert.equal(workUpdate.itemId, first.itemId);
  assert.equal(workUpdate.revision, 2);
  // expression independently gets its own item.
  const expressionItem = store.cases.recordItemCoverage(ctxA, {
    locator: locatorA, taskRef: expression, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: null
  });
  assert.notEqual(expressionItem.itemId, first.itemId);

  // B reusing A's itemId with B's locator is rejected; B's own write works.
  assert.throws(
    () =>
      store.cases.recordItemCoverage(ctxB, {
        locator: locatorB, taskRef: work, itemId: first.itemId,
        status: 'blocked', evidenceIds: [], counterevidenceIds: [], note: null
      }),
    ForeignReferenceError
  );
  const bItem = store.cases.recordItemCoverage(ctxB, {
    locator: locatorB, taskRef: work, status: 'blocked', evidenceIds: [], counterevidenceIds: [], note: null
  });
  assert.notEqual(bItem.itemId, first.itemId);

  // Foreign source and mismatched locator account are rejected.
  assert.throws(
    () =>
      store.cases.recordItemCoverage(ctxA, {
        locator: { accountId: accountA.accountId, sourceId: sourceB.sourceId, sourceRevision: 1 },
        taskRef: work, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: null
      }),
    ForeignReferenceError
  );
  assert.throws(
    () =>
      store.cases.recordItemCoverage(ctxA, {
        locator: { accountId: accountB.accountId, sourceId: sourceA.sourceId, sourceRevision: sourceA.sourceRevision },
        taskRef: work, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: null
      }),
    ForeignReferenceError
  );

  // Mixed valid/invalid evidence rolls the whole create back: no item row.
  const support = store.cases.addEvidence(ctxA, {
    sourceId: sourceA.sourceId, sourceRevision: sourceA.sourceRevision, role: 'factual_support',
    quote: 'Synthetic support excerpt.', locator: null, provenance: PROVENANCE
  });
  const counter = store.cases.addEvidence(ctxA, {
    sourceId: sourceA.sourceId, sourceRevision: sourceA.sourceRevision, role: 'factual_counterevidence',
    quote: 'Synthetic counter excerpt.', locator: null, provenance: PROVENANCE
  });
  const countBefore = (db.prepare('SELECT COUNT(*) AS n FROM research_case_item_coverage').get() as { n: number }).n;
  assert.throws(
    () =>
      store.cases.recordItemCoverage(ctxA, {
        locator: locatorA, taskRef: { kind: 'question_matrix', slot: 'change' },
        status: 'unseen', evidenceIds: [support.evidenceId, 'ev_nonexistent'], counterevidenceIds: [], note: null
      }),
    ForeignReferenceError
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM research_case_item_coverage').get() as { n: number }).n, countBefore);
  // Coverage evidence polarity is still enforced.
  assert.throws(
    () =>
      store.cases.recordItemCoverage(ctxA, {
        locator: locatorA, taskRef: { kind: 'question_matrix', slot: 'change' },
        status: 'unseen', evidenceIds: [counter.evidenceId], counterevidenceIds: [], note: null
      }),
    EvidenceRoleError
  );

  // A stale scope context is rejected after the case advances.
  const staleCtx = ctx(record, accountA.accountId, record.scopeVersion);
  store.cases.advanceScope(ctxA, 'synthetic scope advance');
  assert.throws(
    () =>
      store.cases.recordItemCoverage(staleCtx, {
        locator: locatorA, taskRef: work, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: null
      }),
    StaleScopeError
  );
});

test('taskRef keys are injective for arbitrary legal strings and survive reopen', () => {
  const dir = tempDir('get58-taskref-');
  const dbPath = path.join(dir, 'case.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  try {
    const record = newCase(store);
    const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
    const writeCtx = ctx(record, account.accountId);
    const source = store.cases.recordSourceRevision(writeCtx, sourceDraft());
    const locator = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: source.sourceRevision };
    const firstRef = { kind: 'research_task' as const, taskId: 'alpha#beta', checkId: 'gamma' };
    const secondRef = { kind: 'research_task' as const, taskId: 'alpha', checkId: 'beta#gamma' };
    const first = store.cases.recordItemCoverage(writeCtx, {
      locator, taskRef: firstRef, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'first task'
    });
    const second = store.cases.recordItemCoverage(writeCtx, {
      locator, taskRef: secondRef, status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'second task'
    });
    assert.notEqual(taskRefKey(firstRef), taskRefKey(secondRef));
    assert.notEqual(first.itemId, second.itemId);
    // Each logical task keeps its own item id on repeat writes.
    assert.equal(
      store.cases.recordItemCoverage(writeCtx, {
        locator, taskRef: firstRef, status: 'evidence_found', evidenceIds: [], counterevidenceIds: [], note: null
      }).itemId,
      first.itemId
    );
    assert.equal(
      store.cases.recordItemCoverage(writeCtx, {
        locator, taskRef: secondRef, status: 'blocked', evidenceIds: [], counterevidenceIds: [], note: null
      }).itemId,
      second.itemId
    );

    db.close();
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    store = new Store(db);
    const items = store.cases.listItemCoverage(OWNER, record.caseId);
    assert.deepEqual(items.map((item) => [item.itemId, item.taskRef]), [
      [first.itemId, firstRef],
      [second.itemId, secondRef]
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverage exports keep per-item scope versions honest across a scope transition', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const account = store.cases.addAccount(ctx(record, 'ignored'), draft());
  const writeCtx = ctx(record, account.accountId);
  const source = store.cases.recordSourceRevision(writeCtx, sourceDraft());
  const support = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId, sourceRevision: source.sourceRevision, role: 'factual_support',
    quote: 'Synthetic support excerpt.', locator: null, provenance: PROVENANCE
  });
  const counter = store.cases.addEvidence(writeCtx, {
    sourceId: source.sourceId, sourceRevision: source.sourceRevision, role: 'factual_counterevidence',
    quote: 'Synthetic counter excerpt.', locator: null, provenance: PROVENANCE
  });
  const locator = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: source.sourceRevision };
  const workItem = store.cases.recordItemCoverage(writeCtx, {
    locator, taskRef: { kind: 'question_matrix', slot: 'work' },
    status: 'conflicting', evidenceIds: [support.evidenceId], counterevidenceIds: [counter.evidenceId], note: 'v1 note'
  });
  // Scope advances to v2; a new item is written under the current scope.
  const advanced = store.cases.advanceScope(writeCtx, 'synthetic scope transition');
  assert.equal(advanced.scopeVersion, 2);
  const currentCtx = ctx(record, account.accountId, advanced.scopeVersion);
  const expressionItem = store.cases.recordItemCoverage(currentCtx, {
    locator, taskRef: { kind: 'question_matrix', slot: 'expression' },
    status: 'unseen', evidenceIds: [], counterevidenceIds: [], note: 'v2 note'
  });

  const view = store.cases.reportView(OWNER, record.caseId);
  const json = renderCaseJson(view);
  const markdown = renderCaseMarkdown(view);
  const parsed = JSON.parse(json) as CaseReportView;
  const stale = parsed.coverage.find((item) => item.itemId === workItem.itemId);
  const current = parsed.coverage.find((item) => item.itemId === expressionItem.itemId);
  // JSON carries the per-item scope version, not the current case version.
  assert.equal(stale?.scopeVersion, 1);
  assert.equal(current?.scopeVersion, 2);
  assert.equal(parsed.case.scopeVersion, 2);

  // The view marks old-scope coverage for re-checking; no runtime policy invented.
  assert.equal(view.coverage.find((item) => item.itemId === workItem.itemId)?.scopeValidity, 'review');
  assert.match(view.coverage.find((item) => item.itemId === workItem.itemId)?.scopeReviewReason ?? '', /v1/);
  assert.equal(view.coverage.find((item) => item.itemId === expressionItem.itemId)?.scopeValidity, 'valid');

  // Markdown shows the item's own version, labels the stale one, keeps support
  // and counterevidence apart, and the footer version never replaces item versions.
  const lines = markdown.split('\n');
  const workLine = lines.find((line) => line.includes(workItem.itemId.replaceAll('_', '\\_')));
  const expressionLine = lines.find((line) => line.includes(expressionItem.itemId.replaceAll('_', '\\_')));
  assert.ok(workLine && expressionLine);
  assert.match(workLine, /范围 v1/);
  assert.match(workLine, /待复核/);
  assert.match(workLine, /支持 \[/);
  assert.match(workLine, /反证 \[/);
  assert.match(expressionLine, /范围 v2/);
  assert.doesNotMatch(expressionLine, /待复核/);
  assert.ok(lines.some((line) => line.includes('范围版本 v2') && line.includes('本导出由 StripSearch')));

  // Updating the old item under the new scope keeps the v1 revision as history.
  const updated = store.cases.recordItemCoverage(currentCtx, {
    locator, taskRef: { kind: 'question_matrix', slot: 'work' }, itemId: workItem.itemId,
    status: 'evidence_found', evidenceIds: [], counterevidenceIds: [], note: 'v2 update'
  });
  assert.equal(updated.itemId, workItem.itemId);
  assert.equal(updated.scopeVersion, 2);
  assert.deepEqual(
    store.cases.listItemCoverageHistory(OWNER, record.caseId, workItem.itemId).map((entry) => [entry.revision, entry.scopeVersion, entry.status, entry.note]),
    [[1, 1, 'conflicting', 'v1 note'], [2, 2, 'evidence_found', 'v2 update']]
  );
  const afterView = store.cases.reportView(OWNER, record.caseId);
  assert.equal(afterView.coverage.find((item) => item.itemId === workItem.itemId)?.scopeValidity, 'valid');
});


test('caller-supplied identifiers remain data in Markdown exports', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const hostile = '\n\n## FORGED\n<strong>FALSE</strong>\n[link](javascript:alert)';
  const record = store.cases.createCase({
    ownerId: OWNER, intent: 'Synthetic export', provenance: PROVENANCE,
    caseId: `case${hostile}`, personId: `person${hostile}`
  });
  const account = store.cases.addAccount(ctx(record, 'new'), draft({ accountId: `account${hostile}` }));
  const context = ctx(record, account.accountId);
  const source = store.cases.recordSourceRevision(context, sourceDraft());
  const evidence = store.cases.addEvidence(context, {
    sourceId: source.sourceId, sourceRevision: source.sourceRevision,
    evidenceId: `evidence${hostile}`, role: 'factual_support',
    quote: 'Synthetic evidence', locator: null, provenance: PROVENANCE
  });
  const claim = store.cases.addClaim(context, {
    claimId: `claim${hostile}`, statement: 'Synthetic statement', kind: 'factual',
    supportIds: [evidence.evidenceId], counterevidenceIds: [], limitations: []
  });
  store.cases.recordItemCoverage(context, {
    locator: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: source.sourceRevision },
    taskRef: { kind: 'question_matrix', slot: 'work' }, status: 'evidence_found',
    evidenceIds: [evidence.evidenceId], counterevidenceIds: [], note: null
  });
  const view = store.cases.reportView(OWNER, record.caseId);
  const json = JSON.parse(renderCaseJson(view)) as CaseReportView;
  assert.equal(json.case.caseId, record.caseId);
  assert.equal(json.accounts[0]?.accountId, account.accountId);
  assert.equal(json.claims[0]?.claimId, claim.claimId);
  assert.equal(json.claims[0]?.supportIds[0], evidence.evidenceId);
  const markdown = renderCaseMarkdown(view);
  assert.doesNotMatch(markdown, /^## FORGED/m);
  assert.ok(!markdown.includes('<strong>FALSE</strong>'));
  assert.ok(!markdown.includes('[link](javascript:alert)'));
  for (const prefix of ['case', 'person', 'account', 'evidence', 'claim']) {
    assert.ok(markdown.includes(`${prefix} ## FORGED &lt;strong&gt;FALSE&lt;/strong&gt;`));
  }
});
