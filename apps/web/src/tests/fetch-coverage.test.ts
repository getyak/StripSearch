/**
 * GET-95 fetch processing coverage regressions (first batch).
 *
 * Synthetic fixtures only (no network, no real people) with real SQLite,
 * including a file-backed close/reopen case; global fetch is disabled for the
 * whole file so an accidental request fails loudly. Covered here:
 * - independent body/media/default-comment-page/selected-thread-branch
 *   dimensions with mandatory reasons on every non-success state;
 * - receipt replay identity (same key + body no-op, same key + different body
 *   conflict) and duplicate pages/receipts never double counting;
 * - unknown/zero denominators and percent=null rules, with enumeration
 *   exhaustion only from protocol-conforming GET-60 observations;
 * - owner/scope/permission refusal (profile_only/none histories, stale and
 *   future scopes), mixed account/case references and role mismatch;
 * - source revision changes staying explicit, append-order supersession under
 *   backwards clocks, later failed/inaccessible regressions reopening success;
 * - evidence withdrawal preserved as history without counting as valid reads,
 *   atomic batch rollback and stale-scope records;
 * - unknown/out-of-window publication dates, conservative media metadata
 *   merging (conflict and credible absence), persistence and aggregates;
 * - processing receipts never changing frozen completion rules, identity or
 *   publication state (no observation/assessment/claim/report writes).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import type { AccountDraft, CaseWriteContext } from '../server/research/case-store.js';
import type { FetchReceiptResult } from '../server/research/fetch-coverage-store.js';
import type {
  AccountSelection,
  RecordProvenance,
  ResearchCase,
  ScopeVersion,
  SourceRevision
} from '../shared/research-case.js';
import {
  CaseNotFoundError,
  EvidenceRoleError,
  ForeignReferenceError,
  StaleScopeError,
  asScopeVersion
} from '../shared/research-case.js';
import type {
  CompletionObservation,
  CompletionObservationDraft,
  CompletionScopeSpec,
  FrozenCompletionScope,
  ObligationRef
} from '../shared/research-completion.js';
import {
  FetchReceiptConflictError,
  FetchReceiptProtocolError,
  FetchScopeDeniedError,
  fetchDimensionKey,
  inFrozenPublicationWindow,
  validateFetchReceiptDraft
} from '../shared/research-fetch-coverage.js';
import type {
  FetchAccountCoverage,
  FetchCoverageItemView,
  FetchCoverageView,
  FetchDimensionCounter,
  FetchDimensionName,
  FetchDimensionRef,
  FetchDimensionView,
  FetchProcessingReceiptDraft,
  ParentContextEntry
} from '../shared/research-fetch-coverage.js';

// Offline by construction: any accidental request fails loudly.
globalThis.fetch = (() => {
  throw new Error('fetch-coverage tests are offline: real network/fetch is disabled');
}) as typeof globalThis.fetch;

const OWNER = 'owner-synthetic-fetch';
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

function newCase(store: Store): ResearchCase {
  return store.cases.createCase({ ownerId: OWNER, intent: 'Synthetic fetch coverage case', provenance: PROVENANCE });
}

function accountDraft(overrides: Partial<AccountDraft> = {}): AccountDraft {
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

function sourceDraft(overrides: Record<string, unknown> = {}) {
  return {
    author: 'Synthetic Author',
    originalUrl: 'https://fixture.test/fetch/post',
    title: 'Synthetic post',
    publishedAt: '2026-03-01',
    retrievedAt: '2026-04-01T00:00:00.000Z',
    locator: 'paragraph 1',
    contentHash: 'a'.repeat(64),
    provenance: PROVENANCE,
    ...overrides
  };
}

function currentVersion(store: Store, caseId: string): ScopeVersion {
  const record = store.cases.getCase(OWNER, caseId);
  assert.ok(record);
  return record.scopeVersion;
}

function caseCtx(store: Store, record: ResearchCase, accountId: string): CaseWriteContext {
  return {
    ownerId: OWNER,
    caseId: record.caseId,
    accountId,
    expectedScopeVersion: currentVersion(store, record.caseId)
  };
}

/** Add an account and set its allowed scope atomically through the scope path. */
function addAccount(
  store: Store,
  record: ResearchCase,
  handle: string,
  allowed: AccountSelection['allowedScope']['state']
): AccountSelection {
  const created = store.cases.addAccount(
    {
      ownerId: OWNER,
      caseId: record.caseId,
      accountId: 'ignored',
      expectedScopeVersion: currentVersion(store, record.caseId)
    },
    accountDraft({ handle })
  );
  if (allowed === 'none') return created;
  store.cases.applyScopeChange({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    reason: 'synthetic allowed scope',
    accounts: [
      {
        accountId: created.accountId,
        userSelection: { state: 'selected', note: 'synthetic', recordedAt: '2026-01-02' },
        allowedScope: { state: allowed, note: 'synthetic' }
      }
    ]
  });
  const accounts = store.cases.listAccounts(OWNER, record.caseId);
  const updated = accounts.find((entry) => entry.accountId === created.accountId);
  assert.ok(updated);
  return updated;
}

function minimalSpec(overrides: Partial<CompletionScopeSpec> = {}): CompletionScopeSpec {
  return {
    questions: [
      {
        questionId: 'q-work',
        slot: 'work',
        text: '这个人实际做了什么？',
        applicability: 'applicable',
        applicabilityReason: '核心研究问题'
      }
    ],
    platformRegistry: {
      registryVersion: 'catalog-2026-09-29',
      entries: [
        {
          platformId: 'synthetic',
          label: 'Synthetic',
          applicability: 'applicable',
          applicabilityReason: '目录内适用平台，冻结为发现义务'
        }
      ]
    },
    accountRange: { mode: 'researched_accounts', accountIds: [] },
    timeRange: { from: '2026-01-01', to: '2026-12-31' },
    threadDepth: 4,
    requiredChecks: [{ checkId: 'time', kind: 'time_coverage', required: ['2026'] }],
    ...overrides
  };
}

function emptyRefs() {
  return {
    accountIds: [] as string[],
    sourceRevisions: [] as Array<{ sourceId: string; sourceRevision: number }>,
    evidenceIds: [] as string[],
    counterevidenceIds: [] as string[],
    coverageItems: [] as Array<{
      itemId: string;
      revision: number;
      locator: { accountId: string; sourceId: string; sourceRevision: number };
    }>,
    observationIds: [] as string[]
  };
}

function obsDraft(
  action: CompletionObservation['action'],
  result: string,
  obligationRef: ObligationRef,
  extra: Record<string, unknown> = {}
): CompletionObservationDraft {
  return {
    obligationRef,
    action,
    result,
    attemptState: 'succeeded',
    stopReason: null,
    accessBoundary: null,
    remainingUnknown: null,
    note: null,
    synthetic: true,
    provenance: PROVENANCE,
    refs: emptyRefs(),
    ...extra
  } as unknown as CompletionObservationDraft;
}

type EnumItem = { sourceId: string; sourceRevision: number; hasMedia: 'none' | 'present' | 'unknown' };

function receiptDraft(overrides: Partial<FetchProcessingReceiptDraft> = {}): FetchProcessingReceiptDraft {
  const base: FetchProcessingReceiptDraft = {
    receiptKey: 'receipt-1',
    content: { accountId: 'acc', sourceId: 'src', sourceRevision: 1 },
    dimension: { name: 'body' },
    state: 'read',
    reason: null,
    parents: [],
    evidenceIds: [],
    counterevidenceIds: [],
    occurredAt: '2026-05-01T00:00:00.000Z',
    note: null,
    synthetic: true,
    provenance: PROVENANCE
  };
  return { ...base, ...overrides };
}

interface Fixture {
  db: DB;
  store: Store;
  record: ResearchCase;
  account: AccountSelection;
  frozen: FrozenCompletionScope;
  source: SourceRevision;
  recordObs: (draft: CompletionObservationDraft) => CompletionObservation;
  recordFetch: (draft: FetchProcessingReceiptDraft) => FetchReceiptResult;
  view: () => FetchCoverageView;
}

/**
 * Base fixture: one case, one public_history account, one source revision and
 * a frozen GET-60 scope. The caller records its own GET-60 observations and
 * fetch receipts, so each test controls its own coverage state.
 */
function baseFixture(
  t: TestContext,
  options: { window?: { from: string | null; to: string | null } } = {}
): Fixture {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record = newCase(store);
  const account = addAccount(store, record, 'synthetic-handle', 'public_history');
  const source = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-a', publishedAt: '2026-03-01' })
  );
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    spec: minimalSpec(
      options.window ? { timeRange: { from: options.window.from, to: options.window.to } } : {}
    ),
    reason: 'synthetic fetch fixture'
  });
  return {
    db,
    store,
    record,
    account,
    frozen,
    source,
    recordObs: (draft) =>
      store.completion.recordCompletionObservation({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        scopeSpecId: frozen.scopeSpecId,
        receipt: draft
      }),
    recordFetch: (draft) =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipt: draft
      }),
    view: () => {
      const result = store.fetchCoverage.getFetchCoverageView(OWNER, record.caseId, frozen.scopeSpecId);
      assert.ok(result);
      return result;
    }
  };
}

function itemOf(
  view: FetchCoverageView,
  accountId: string,
  sourceId: string,
  sourceRevision: number
): FetchCoverageItemView {
  const found = view.items.find(
    (entry) =>
      entry.content.accountId === accountId &&
      entry.content.sourceId === sourceId &&
      entry.content.sourceRevision === sourceRevision
  );
  assert.ok(found, `missing item ${sourceId}@${String(sourceRevision)}`);
  return found;
}

function dimOf(item: FetchCoverageItemView, ref: FetchDimensionRef): FetchDimensionView {
  const key = fetchDimensionKey(ref);
  const found = item.dimensions.find((entry) => fetchDimensionKey(entry.dimension) === key);
  assert.ok(found, `missing dimension ${key}`);
  return found;
}

function accountOf(view: FetchCoverageView, accountId: string): FetchAccountCoverage {
  const found = view.accounts.find((entry) => entry.accountId === accountId);
  assert.ok(found, `missing account ${accountId}`);
  return found;
}

function counterOf(account: FetchAccountCoverage, name: FetchDimensionName): FetchDimensionCounter {
  const found = account.dimensions.find((entry) => entry.dimension === name);
  assert.ok(found, `missing counter ${name}`);
  return found;
}

/* ------------------------------------------------------------------ */
/* Independent dimensions and mandatory reasons                       */
/* ------------------------------------------------------------------ */

test('body, media, default comment page and thread dimensions stay independent', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, frozen, recordObs, recordFetch } = fixture;
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'present' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'body-1',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
      dimension: { name: 'body' }
    })
  );

  let view = fixture.view();
  let item = itemOf(view, account.accountId, source.sourceId, 1);
  assert.equal(dimOf(item, { name: 'body' }).state, 'read');
  assert.equal(dimOf(item, { name: 'body' }).countsAsValidRead, true);
  assert.equal(dimOf(item, { name: 'media' }).state, 'unread');
  assert.equal(dimOf(item, { name: 'comments' }).state, 'unread');
  assert.equal(item.dimensions.length, 3);

  recordFetch(
    receiptDraft({
      receiptKey: 'media-1',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
      dimension: { name: 'media' },
      state: 'skipped',
      reason: '合成跳过：媒体为重复模板图'
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'comments-1',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
      dimension: { name: 'comments' }
    })
  );

  view = fixture.view();
  item = itemOf(view, account.accountId, source.sourceId, 1);
  assert.equal(dimOf(item, { name: 'body' }).state, 'read');
  assert.equal(dimOf(item, { name: 'media' }).state, 'skipped');
  assert.match(dimOf(item, { name: 'media' }).reason ?? '', /模板/);
  assert.equal(dimOf(item, { name: 'media' }).countsAsValidRead, false);
  assert.equal(dimOf(item, { name: 'comments' }).state, 'read');

  const accountView = accountOf(view, account.accountId);
  assert.equal(counterOf(accountView, 'body').states.read, 1);
  assert.equal(counterOf(accountView, 'body').percent, 100);
  assert.equal(counterOf(accountView, 'media').states.skipped, 1);
  assert.equal(counterOf(accountView, 'media').percent, 0);
  assert.equal(counterOf(accountView, 'comments').percent, 100);
  assert.equal(view.window.from, '2026-01-01');
  assert.equal(view.window.to, '2026-12-31');
  assert.equal(view.threadDepth, 4);
  assert.equal(view.currentScopeVersion, currentVersion(store, record.caseId));
  assert.equal(frozen.scopeSpecId, view.scopeSpecId);
});

test('reasons are mandatory for every non-success state and forbidden on read', (t) => {
  const fixture = baseFixture(t);
  const { account, source, recordFetch, store, record } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  assert.throws(
    () => recordFetch(receiptDraft({ receiptKey: 'bad-1', content, state: 'skipped', reason: null })),
    FetchReceiptProtocolError
  );
  assert.throws(
    () => recordFetch(receiptDraft({ receiptKey: 'bad-2', content, state: 'read', reason: '不该有原因' })),
    FetchReceiptProtocolError
  );
  assert.throws(
    () => validateFetchReceiptDraft(receiptDraft({ content, state: 'failed', reason: '' })),
    FetchReceiptProtocolError
  );
  // Malformed drafts: parent context on a non-thread dimension, unknown keys,
  // missing branch key and bad parent states are all rejected.
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'bad-3',
          content,
          parents: [{ commentKey: 'c-1', state: 'missing' }]
        })
      ),
    FetchReceiptProtocolError
  );
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'bad-4',
          content,
          dimension: { name: 'thread_branch', branchKey: '' },
          reason: null,
          state: 'read'
        })
      ),
    FetchReceiptProtocolError
  );
  assert.throws(
    () =>
      validateFetchReceiptDraft({
        ...receiptDraft({ content }),
        ownerId: 'smuggled'
      } as unknown as FetchProcessingReceiptDraft),
    FetchReceiptProtocolError
  );
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'bad-5',
          content,
          dimension: { name: 'thread_branch', branchKey: 'c-1' },
          state: 'context_missing',
          reason: '父节点缺失',
          parents: [{ commentKey: 'c-0', state: 'gone' } as unknown as ParentContextEntry]
        })
      ),
    FetchReceiptProtocolError
  );
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchBatch({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipts: []
      }),
    FetchReceiptProtocolError
  );
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 0);
});

/* ------------------------------------------------------------------ */
/* Selected thread branches                                           */
/* ------------------------------------------------------------------ */

test('selected thread branches carry explicit parent context and stay independent', (t) => {
  const fixture = baseFixture(t);
  const { account, source, recordObs, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordObs(
    obsDraft('select_branch', 'branch_selected', {
      kind: 'thread_branch',
      accountId: account.accountId,
      sourceId: source.sourceId,
      sourceRevision: 1,
      branchKey: 'c-1'
    }, {
      parentChain: [
        { commentKey: 'c-root', depth: 1, state: 'present' },
        { commentKey: 'c-mid', depth: 2, state: 'deleted' }
      ]
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'thread-c1',
      content,
      dimension: { name: 'thread_branch', branchKey: 'c-1' },
      state: 'context_missing',
      reason: '父节点删除，上下文不足',
      parents: [{ commentKey: 'c-mid', state: 'deleted' }]
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'thread-c2',
      content,
      dimension: { name: 'thread_branch', branchKey: 'c-2' },
      parents: [{ commentKey: 'c-root', state: 'present' }]
    })
  );

  const view = fixture.view();
  const item = itemOf(view, account.accountId, source.sourceId, 1);
  const branchOne = dimOf(item, { name: 'thread_branch', branchKey: 'c-1' });
  const branchTwo = dimOf(item, { name: 'thread_branch', branchKey: 'c-2' });
  assert.equal(branchOne.state, 'context_missing');
  assert.equal(branchOne.branchSelected, true);
  assert.equal(branchTwo.state, 'read');
  assert.equal(branchTwo.branchSelected, false);
  assert.equal(branchOne.countsAsValidRead, false);
  assert.equal(branchTwo.countsAsValidRead, true);
  // Missing/deleted/hidden parents stay explicit and contradictory states are kept.
  assert.ok(branchOne.parents.some((entry) => entry.commentKey === 'c-mid' && entry.state === 'deleted'));
  assert.ok(branchOne.parents.some((entry) => entry.commentKey === 'c-root' && entry.state === 'present'));
  assert.ok(item.limitations.some((line) => line.includes('父链包含缺失/删除/隐藏节点')));
  assert.ok(item.limitations.some((line) => line.includes('无 GET-60 select_branch 选择记录')));

  const accountView = accountOf(view, account.accountId);
  assert.equal(counterOf(accountView, 'thread_branch').instances, 2);
  assert.equal(counterOf(accountView, 'thread_branch').validReads, 1);
  assert.equal(counterOf(accountView, 'thread_branch').percent, 50);
});

/* ------------------------------------------------------------------ */
/* Replay identity, duplicate pages, conflicts                        */
/* ------------------------------------------------------------------ */

test('receipt replay is a no-op and the same key with a different body conflicts', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  const draft = receiptDraft({ receiptKey: 'replay-1', content });
  const first = recordFetch(draft);
  assert.equal(first.replayed, false);
  const replay = recordFetch(receiptDraft({ receiptKey: 'replay-1', content }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptId, first.receipt.receiptId);
  assert.equal(replay.receipt.seq, first.receipt.seq);
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 1);

  // Same key + different body (state, note, deps or clock) is a conflict.
  for (const changed of [
    receiptDraft({ receiptKey: 'replay-1', content, state: 'skipped', reason: '不同正文' }),
    receiptDraft({ receiptKey: 'replay-1', content, note: '不同备注' }),
    receiptDraft({ receiptKey: 'replay-1', content, occurredAt: '2026-05-02T00:00:00.000Z' })
  ]) {
    assert.throws(() => recordFetch(changed), FetchReceiptConflictError);
  }
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 1);
});

test('duplicate listing pages and repeated receipts never double count', (t) => {
  const fixture = baseFixture(t);
  const { account, source, recordObs, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  for (const key of ['page-a-item', 'page-b-item']) {
    recordObs(
      obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
        items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
        nextCursor: key === 'page-a-item' ? 'cursor-2' : null,
        knownGaps: [],
        stopReason: key === 'page-a-item' ? null : 'endpoint_exhausted'
      })
    );
    recordFetch(
      receiptDraft({
        receiptKey: key,
        content,
        dimension: { name: 'body' },
        state: 'listed',
        reason: '已入索引，等待深读批次'
      })
    );
  }
  const view = fixture.view();
  const accountView = accountOf(view, account.accountId);
  assert.equal(accountView.enumeratedItems, 1);
  assert.equal(accountView.receiptOnlyItems, 0);
  const body = counterOf(accountView, 'body');
  assert.equal(body.instances, 1);
  assert.equal(body.states.listed, 1);
  const item = itemOf(view, account.accountId, source.sourceId, 1);
  assert.equal(dimOf(item, { name: 'body' }).history.length, 2);
  assert.equal(view.items.length, 1);
});

/* ------------------------------------------------------------------ */
/* Denominators and exhaustion protocol                               */
/* ------------------------------------------------------------------ */

test('unknown and zero denominators never fake percentages', (t) => {
  // (a) open cursor
  const open = baseFixture(t);
  open.recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: open.account.accountId }, {
      items: [{ sourceId: open.source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: 'cursor-open',
      knownGaps: [],
      stopReason: 'cursor_open'
    })
  );
  open.recordFetch(
    receiptDraft({
      receiptKey: 'open-1',
      content: { accountId: open.account.accountId, sourceId: open.source.sourceId, sourceRevision: 1 }
    })
  );
  let view = open.view();
  let accountView = accountOf(view, open.account.accountId);
  assert.equal(accountView.enumeration.exhausted, false);
  assert.equal(accountView.enumeration.basis, 'cursor_open');
  assert.equal(accountView.enumeration.openCursor, true);
  assert.equal(accountView.denominatorKnown, false);
  assert.equal(accountView.total, null);
  for (const counter of accountView.dimensions) assert.equal(counter.percent, null);
  assert.ok(accountView.limitations.some((line) => line.includes('percent 为 null')));

  // (b) known gaps keep the denominator unknown
  const gaps = baseFixture(t);
  gaps.recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: gaps.account.accountId }, {
      items: [{ sourceId: gaps.source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: ['2025 年之前的页未取到'],
      stopReason: 'known_gap'
    })
  );
  view = gaps.view();
  accountView = accountOf(view, gaps.account.accountId);
  assert.equal(accountView.enumeration.basis, 'known_gap');
  assert.deepEqual(accountView.enumeration.knownGaps, ['2025 年之前的页未取到']);
  assert.equal(accountView.denominatorKnown, false);
  assert.equal(counterOf(accountView, 'body').percent, null);

  // (c) honest zero denominator: exhausted with zero items -> percent null
  const zero = baseFixture(t);
  zero.recordObs(
    obsDraft('enumerate_history', 'no_match', { kind: 'account_history', accountId: zero.account.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  view = zero.view();
  accountView = accountOf(view, zero.account.accountId);
  assert.equal(accountView.enumeration.exhausted, true);
  assert.equal(accountView.total, 0);
  assert.equal(counterOf(accountView, 'body').instances, 0);
  assert.equal(counterOf(accountView, 'body').percent, null);

  // (d) known denominator: percent reflects valid reads only
  const known = baseFixture(t);
  known.store.cases.recordSourceRevision(
    caseCtx(known.store, known.record, known.account.accountId),
    sourceDraft({ sourceId: known.source.sourceId, originalUrl: 'https://fixture.test/fetch/post-a#2' })
  );
  known.recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: known.account.accountId }, {
      items: [
        { sourceId: known.source.sourceId, sourceRevision: 1, hasMedia: 'unknown' },
        { sourceId: known.source.sourceId, sourceRevision: 2, hasMedia: 'unknown' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  known.recordFetch(
    receiptDraft({
      receiptKey: 'known-1',
      content: { accountId: known.account.accountId, sourceId: known.source.sourceId, sourceRevision: 1 }
    })
  );
  view = known.view();
  accountView = accountOf(view, known.account.accountId);
  assert.equal(accountView.denominatorKnown, true);
  assert.equal(accountView.total, 2);
  assert.equal(counterOf(accountView, 'body').percent, 50);
  assert.equal(counterOf(accountView, 'media').percent, 0);
});

test('exhaustion only comes from protocol-conforming GET-60 observations', (t) => {
  const fixture = baseFixture(t);
  const { account, source, recordObs, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  // A null cursor alone is not exhaustion.
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: null
    })
  );
  let view = fixture.view();
  let accountView = accountOf(view, account.accountId);
  assert.equal(accountView.enumeration.exhausted, false);
  assert.equal(accountView.enumeration.basis, 'not_exhausted');
  assert.equal(counterOf(accountView, 'body').percent, null);

  // The explicit exhaustion receipt closes the range (open cursor -> exhausted).
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordFetch(receiptDraft({ receiptKey: 'exh-1', content }));
  view = fixture.view();
  accountView = accountOf(view, account.accountId);
  assert.equal(accountView.enumeration.exhausted, true);
  assert.equal(accountView.enumeration.basis, 'endpoint_exhausted');
  assert.equal(accountView.enumeration.observationId !== null, true);
  assert.equal(counterOf(accountView, 'body').percent, 100);

  // A later cursor/gap reopens the range even after a claimed exhaustion.
  fixture.store.cases.recordSourceRevision(
    caseCtx(fixture.store, fixture.record, account.accountId),
    sourceDraft({ sourceId: source.sourceId, originalUrl: 'https://fixture.test/fetch/post-a#2' })
  );
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 2, hasMedia: 'none' }],
      nextCursor: 'cursor-late',
      knownGaps: [],
      stopReason: 'cursor_open'
    })
  );
  view = fixture.view();
  accountView = accountOf(view, account.accountId);
  assert.equal(accountView.enumeration.exhausted, false);
  assert.equal(accountView.enumeration.basis, 'cursor_open');
  assert.equal(accountView.total, null);
  assert.equal(counterOf(accountView, 'body').percent, null);
});

/* ------------------------------------------------------------------ */
/* Owner / scope / permission refusals                                */
/* ------------------------------------------------------------------ */

test('owner, scope and permission refusals fail closed without writes', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, frozen, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  const draft = receiptDraft({ receiptKey: 'refuse-1', content });

  // Owner and case boundaries.
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: 'other-owner',
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipt: draft
      }),
    CaseNotFoundError
  );
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: OWNER,
        caseId: 'case-does-not-exist',
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipt: draft
      }),
    CaseNotFoundError
  );

  // Stale and future scopes are both refused.
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: asScopeVersion(currentVersion(store, record.caseId) - 1),
        receipt: draft
      }),
    StaleScopeError
  );
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: asScopeVersion(currentVersion(store, record.caseId) + 1),
        receipt: draft
      }),
    StaleScopeError
  );

  // profile_only and none accounts cannot record history processing.
  const restricted = addAccount(store, record, 'profile-only-handle', 'profile_only');
  const denied = addAccount(store, record, 'no-scope-handle', 'none');
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'refuse-2',
          content: {
            accountId: restricted.accountId,
            sourceId: 'never-checked',
            sourceRevision: 1
          }
        })
      ),
    FetchScopeDeniedError
  );
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'refuse-3',
          content: { accountId: denied.accountId, sourceId: 'never-checked', sourceRevision: 1 }
        })
      ),
    FetchScopeDeniedError
  );

  // Unknown reads report "not found" semantics.
  assert.equal(store.fetchCoverage.getFetchCoverageView('other-owner', record.caseId, frozen.scopeSpecId), null);
  assert.equal(store.fetchCoverage.getFetchCoverageView(OWNER, record.caseId, 'scope-missing'), null);
  assert.equal(store.fetchCoverage.listFetchReceipts('other-owner', record.caseId).length, 0);
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 0);
});

/* ------------------------------------------------------------------ */
/* Foreign references and atomic batches                              */
/* ------------------------------------------------------------------ */

test('mixed account/case refs, role mismatches and invalid batches roll back fully', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, recordFetch } = fixture;
  const other = addAccount(store, record, 'second-handle', 'public_history');
  const otherSource = store.cases.recordSourceRevision(
    caseCtx(store, record, other.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-b' })
  );
  const evidence = store.cases.addEvidence(caseCtx(store, record, account.accountId), {
    sourceId: source.sourceId,
    sourceRevision: 1,
    role: 'factual_support',
    quote: '合成支持片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  const counterEvidence = store.cases.addEvidence(caseCtx(store, record, account.accountId), {
    sourceId: source.sourceId,
    sourceRevision: 1,
    role: 'factual_counterevidence',
    quote: '合成反证片段',
    locator: 'paragraph 2',
    provenance: PROVENANCE
  });

  const foreignCase = newCase(store);
  const foreignAccount = addAccount(store, foreignCase, 'foreign-handle', 'public_history');
  const foreignSource = store.cases.recordSourceRevision(
    caseCtx(store, foreignCase, foreignAccount.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-foreign' })
  );
  const foreignEvidence = store.cases.addEvidence(caseCtx(store, foreignCase, foreignAccount.accountId), {
    sourceId: foreignSource.sourceId,
    sourceRevision: 1,
    role: 'factual_support',
    quote: '跨案例片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });

  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  // Cross-account source binding.
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'foreign-1',
          content: { accountId: account.accountId, sourceId: otherSource.sourceId, sourceRevision: 1 }
        })
      ),
    ForeignReferenceError
  );
  // Cross-case source binding.
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'foreign-2',
          content: {
            accountId: account.accountId,
            sourceId: foreignSource.sourceId,
            sourceRevision: 1
          }
        })
      ),
    ForeignReferenceError
  );
  // Cross-account and cross-case evidence dependencies.
  const otherEvidence = store.cases.addEvidence(caseCtx(store, record, other.accountId), {
    sourceId: otherSource.sourceId,
    sourceRevision: 1,
    role: 'factual_support',
    quote: '另一账号片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({ receiptKey: 'foreign-3', content, evidenceIds: [otherEvidence.evidenceId] })
      ),
    ForeignReferenceError
  );
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({ receiptKey: 'foreign-4', content, evidenceIds: [foreignEvidence.evidenceId] })
      ),
    ForeignReferenceError
  );
  // Polarity mismatch: support-role evidence cannot sit in counterevidenceIds.
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({
          receiptKey: 'foreign-5',
          content,
          counterevidenceIds: [evidence.evidenceId]
        })
      ),
    EvidenceRoleError
  );
  assert.throws(
    () =>
      recordFetch(
        receiptDraft({ receiptKey: 'foreign-6', content, evidenceIds: [counterEvidence.evidenceId] })
      ),
    EvidenceRoleError
  );
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 0);

  // Batch with one invalid reference rolls the whole batch back.
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchBatch({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipts: [
          receiptDraft({ receiptKey: 'batch-1', content }),
          receiptDraft({
            receiptKey: 'batch-2',
            content,
            dimension: { name: 'comments' },
            state: 'unread',
            reason: '待下一批次'
          }),
          receiptDraft({
            receiptKey: 'batch-3',
            content: { accountId: account.accountId, sourceId: otherSource.sourceId, sourceRevision: 1 }
          })
        ]
      }),
    ForeignReferenceError
  );
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 0);
  const row = fixture.db
    .prepare('SELECT COUNT(*) AS n FROM research_case_fetch_receipts')
    .get() as { n: number };
  assert.equal(row.n, 0);

  // Intra-batch replay conflict also rolls the whole batch back.
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchBatch({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipts: [
          receiptDraft({ receiptKey: 'batch-4', content }),
          receiptDraft({ receiptKey: 'batch-4', content, state: 'failed', reason: '批次内冲突' })
        ]
      }),
    FetchReceiptConflictError
  );
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 0);

  // A replayed no-op inside a batch cannot mask an invalid sibling.
  recordFetch(receiptDraft({ receiptKey: 'batch-5', content }));
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchBatch({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipts: [
          receiptDraft({ receiptKey: 'batch-5', content }),
          receiptDraft({
            receiptKey: 'batch-6',
            content: { accountId: account.accountId, sourceId: otherSource.sourceId, sourceRevision: 1 }
          })
        ]
      }),
    ForeignReferenceError
  );
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 1);
  // Valid batch commits all-or-nothing with replayed flags.
  const ok = store.fetchCoverage.recordFetchBatch({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    receipts: [
      receiptDraft({ receiptKey: 'batch-5', content }),
      receiptDraft({ receiptKey: 'batch-7', content, evidenceIds: [evidence.evidenceId] })
    ]
  });
  assert.equal(ok.results.length, 2);
  assert.equal(ok.results[0]?.replayed, true);
  assert.equal(ok.results[1]?.replayed, false);
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 2);
});

/* ------------------------------------------------------------------ */
/* Source revisions                                                   */
/* ------------------------------------------------------------------ */

test('new source revisions are explicit and never inherit old processing', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, recordObs, recordFetch } = fixture;
  recordFetch(
    receiptDraft({
      receiptKey: 'rev1-body',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 }
    })
  );
  const revisionTwo = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ sourceId: source.sourceId, originalUrl: 'https://fixture.test/fetch/post-a#2' })
  );
  assert.equal(revisionTwo.sourceRevision, 2);
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: source.sourceId, sourceRevision: 2, hasMedia: 'none' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );

  const view = fixture.view();
  const first = itemOf(view, account.accountId, source.sourceId, 1);
  const second = itemOf(view, account.accountId, source.sourceId, 2);
  assert.equal(first.newerRevisionAvailable, 2);
  assert.ok(first.limitations.some((line) => line.includes('不传递到新 revision')));
  assert.equal(second.newerRevisionAvailable, null);
  assert.equal(dimOf(first, { name: 'body' }).state, 'read');
  assert.equal(dimOf(second, { name: 'body' }).state, 'unread');
  const accountView = accountOf(view, account.accountId);
  assert.equal(accountView.enumeratedItems, 2);
  assert.equal(counterOf(accountView, 'body').states.read, 1);
  assert.equal(counterOf(accountView, 'body').states.unread, 1);
});

/* ------------------------------------------------------------------ */
/* Append order under a backwards clock and later regressions         */
/* ------------------------------------------------------------------ */

test('supersession follows append order, not occurredAt or created_at', (t) => {
  const fixture = baseFixture(t);
  const { db, account, source, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  recordFetch(
    receiptDraft({
      receiptKey: 'clock-a',
      content,
      occurredAt: '2026-05-05T00:00:00.000Z'
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'clock-b',
      content,
      state: 'failed',
      reason: '合成失败：抓取中断',
      occurredAt: '2026-05-01T00:00:00.000Z'
    })
  );
  // Push the later receipt's wall clock backwards; ordering must not change.
  db.prepare('UPDATE research_case_fetch_receipts SET created_at = ? WHERE receipt_key = ?').run(
    '2000-01-01T00:00:00.000Z',
    'clock-b'
  );
  let view = fixture.view();
  let item = itemOf(view, account.accountId, source.sourceId, 1);
  let body = dimOf(item, { name: 'body' });
  assert.equal(body.state, 'failed');
  assert.deepEqual(
    body.history.map((entry) => entry.receiptKey),
    ['clock-a', 'clock-b']
  );
  assert.equal((body.history[0]?.seq ?? 0) < (body.history[1]?.seq ?? 0), true);

  // A third receipt appended later wins even with the oldest clock of all.
  recordFetch(
    receiptDraft({
      receiptKey: 'clock-c',
      content,
      occurredAt: '2019-01-01T00:00:00.000Z'
    })
  );
  view = fixture.view();
  item = itemOf(view, account.accountId, source.sourceId, 1);
  body = dimOf(item, { name: 'body' });
  assert.equal(body.state, 'read');
  assert.equal(body.countsAsValidRead, true);
});

test('later failed or inaccessible receipts reopen a prior success', (t) => {
  const fixture = baseFixture(t);
  const { account, source, recordObs, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'unknown' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordFetch(receiptDraft({ receiptKey: 'reg-1', content }));
  assert.equal(counterOf(accountOf(fixture.view(), account.accountId), 'body').percent, 100);

  recordFetch(
    receiptDraft({
      receiptKey: 'reg-2',
      content,
      state: 'failed',
      reason: '合成失败：正文解析异常'
    })
  );
  let view = fixture.view();
  let body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.state, 'failed');
  assert.equal(body.countsAsValidRead, false);
  assert.equal(body.history.length, 2);
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').percent, 0);

  recordFetch(
    receiptDraft({
      receiptKey: 'reg-3',
      content,
      state: 'inaccessible',
      reason: '合成受限：接口拒绝'
    })
  );
  view = fixture.view();
  body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.state, 'inaccessible');
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').states.inaccessible, 1);

  // A clean later read restores coverage without erasing the failures.
  recordFetch(receiptDraft({ receiptKey: 'reg-4', content }));
  view = fixture.view();
  body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.state, 'read');
  assert.equal(body.countsAsValidRead, true);
  assert.equal(body.history.length, 4);
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').percent, 100);
});

/* ------------------------------------------------------------------ */
/* Dependency withdrawal and stale scope                              */
/* ------------------------------------------------------------------ */

test('withdrawn evidence stops counting as a valid read but history survives', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, recordObs, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  const evidence = store.cases.addEvidence(caseCtx(store, record, account.accountId), {
    sourceId: source.sourceId,
    sourceRevision: 1,
    role: 'factual_support',
    quote: '合成支持片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  const counterEvidence = store.cases.addEvidence(caseCtx(store, record, account.accountId), {
    sourceId: source.sourceId,
    sourceRevision: 1,
    role: 'factual_counterevidence',
    quote: '合成反证片段',
    locator: 'paragraph 2',
    provenance: PROVENANCE
  });
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'unknown' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordFetch(
    receiptDraft({ receiptKey: 'dep-1', content, evidenceIds: [evidence.evidenceId] })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'dep-2',
      content,
      dimension: { name: 'comments' },
      counterevidenceIds: [counterEvidence.evidenceId]
    })
  );
  let view = fixture.view();
  let body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.dependencyValidity, 'valid');
  assert.equal(body.countsAsValidRead, true);
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').validReads, 1);

  store.cases.revokeEvidence(caseCtx(store, record, account.accountId), evidence.evidenceId);
  store.cases.revokeEvidence(caseCtx(store, record, account.accountId), counterEvidence.evidenceId);
  view = fixture.view();
  const item = itemOf(view, account.accountId, source.sourceId, 1);
  body = dimOf(item, { name: 'body' });
  assert.equal(body.state, 'read');
  assert.equal(body.dependencyValidity, 'review');
  assert.equal(body.countsAsValidRead, false);
  assert.ok(body.staleReasons.some((line) => line.includes('已撤回')));
  assert.equal(body.history.length, 1);
  assert.equal(body.history[0]?.dependencyValidity, 'review');
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').validReads, 0);
  assert.equal(counterOf(accountOf(view, account.accountId), 'comments').validReads, 0);
  assert.ok(view.limitations.some((line) => line.includes('依赖已撤回')));

  // An independent valid read restores coverage; the withdrawn one stays history.
  recordFetch(receiptDraft({ receiptKey: 'dep-3', content }));
  view = fixture.view();
  body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.countsAsValidRead, true);
  assert.equal(body.history.length, 2);
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').validReads, 1);

  // Already-revoked dependencies are refused on write.
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipt: receiptDraft({ receiptKey: 'dep-4', content, evidenceIds: [evidence.evidenceId] })
      }),
    ForeignReferenceError
  );
});

test('stale-scope receipts are preserved but never count as valid reads', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, recordObs, recordFetch } = fixture;
  const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'unknown' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordFetch(receiptDraft({ receiptKey: 'stale-1', content }));
  assert.equal(counterOf(accountOf(fixture.view(), account.accountId), 'body').validReads, 1);

  store.cases.applyScopeChange({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    reason: 'synthetic scope advance',
    accounts: [
      {
        accountId: account.accountId,
        userSelection: { state: 'only_this_account', note: 'synthetic', recordedAt: '2026-02-01' }
      }
    ]
  });
  let view = fixture.view();
  let body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.state, 'read');
  assert.equal(body.scopeValidity, 'review');
  assert.equal(body.countsAsValidRead, false);
  assert.ok(body.staleReasons.some((line) => line.includes('范围')));
  assert.equal(body.history.length, 1);
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').validReads, 0);
  assert.ok(view.limitations.some((line) => line.includes('旧范围')));

  // New work at the new scope supersedes and counts again.
  recordFetch(receiptDraft({ receiptKey: 'stale-2', content }));
  view = fixture.view();
  body = dimOf(itemOf(view, account.accountId, source.sourceId, 1), { name: 'body' });
  assert.equal(body.scopeValidity, 'valid');
  assert.equal(body.countsAsValidRead, true);
  assert.equal(body.history.length, 2);
  assert.equal(body.history[0]?.scopeValidity, 'review');
  assert.equal(counterOf(accountOf(view, account.accountId), 'body').validReads, 1);
});

/* ------------------------------------------------------------------ */
/* Publication windows and media metadata                             */
/* ------------------------------------------------------------------ */

test('unknown and out-of-window publication dates stay explicit', (t) => {
  const fixture = baseFixture(t, { window: { from: '2026-01-01', to: '2026-06-30' } });
  const { store, record, account, source, recordObs, recordFetch } = fixture;
  const outOfWindow = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-late', publishedAt: '2026-08-01' })
  );
  const unknownDate = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-unknown', publishedAt: null })
  );
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: outOfWindow.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: unknownDate.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'window-1',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 }
    })
  );

  const view = fixture.view();
  assert.deepEqual(view.window, { from: '2026-01-01', to: '2026-06-30' });
  const inScope = itemOf(view, account.accountId, source.sourceId, 1);
  const outside = itemOf(view, account.accountId, outOfWindow.sourceId, 1);
  const unknown = itemOf(view, account.accountId, unknownDate.sourceId, 1);
  assert.equal(inScope.inWindow, true);
  assert.equal(outside.inWindow, false);
  assert.equal(unknown.inWindow, true);
  assert.equal(unknown.dateKnown, false);
  assert.ok(unknown.limitations.some((line) => line.includes('发布日期未知')));
  assert.ok(view.limitations.some((line) => line.includes('发布日期未知')));

  const accountView = accountOf(view, account.accountId);
  assert.equal(accountView.outOfWindowItems, 1);
  assert.equal(accountView.unknownDateItems, 1);
  assert.equal(accountView.inWindowItems, 2);
  assert.equal(accountView.total, 2);
  assert.equal(counterOf(accountView, 'body').instances, 2);
  assert.equal(counterOf(accountView, 'body').percent, 50);
  assert.ok(accountView.limitations.some((line) => line.includes('超出冻结时间窗')));

  // Pure window semantics: date granularity and unknown dates stay in scope.
  assert.equal(inFrozenPublicationWindow('2026-01-01', view.window), true);
  assert.equal(inFrozenPublicationWindow('2026-06-30', view.window), true);
  assert.equal(inFrozenPublicationWindow('2025-12-31', view.window), false);
  assert.equal(inFrozenPublicationWindow(null, view.window), true);
});

test('media metadata merges conservatively: conflict, unknown and credible absence', (t) => {
  const fixture = baseFixture(t);
  const { store, record, account, source, recordObs } = fixture;
  const second = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-b' })
  );
  const third = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-c' })
  );
  const fourth = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-d' })
  );
  // A failed page records non-credible metadata; later pages disagree.
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: second.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: fourth.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: 'cursor-2',
      knownGaps: [],
      stopReason: null,
      attemptState: 'failed'
    })
  );
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: second.sourceId, sourceRevision: 1, hasMedia: 'present' },
        { sourceId: third.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );

  const view = fixture.view();
  const conflicted = itemOf(view, account.accountId, second.sourceId, 1);
  assert.equal(conflicted.media.applicability, 'present');
  assert.equal(conflicted.media.conflict, true);
  assert.deepEqual(conflicted.media.recorded, ['none', 'present']);
  assert.ok(conflicted.limitations.some((line) => line.includes('hasMedia 元数据冲突')));

  // Unknown media is never completed; absence needs credible metadata.
  const unknownMedia = itemOf(view, account.accountId, fourth.sourceId, 1);
  assert.equal(unknownMedia.media.applicability, 'unknown');
  const credibleAbsent = itemOf(view, account.accountId, third.sourceId, 1);
  assert.equal(credibleAbsent.media.applicability, 'none');
  const absentOne = itemOf(view, account.accountId, source.sourceId, 1);
  assert.equal(absentOne.media.applicability, 'none');

  const accountView = accountOf(view, account.accountId);
  const media = counterOf(accountView, 'media');
  assert.equal(media.instances, 4);
  assert.equal(media.satisfiedByAbsence, 2);
  assert.equal(media.satisfied, 2);
  assert.equal(media.percent, 50);
  assert.ok(view.limitations.some((line) => line.includes('hasMedia 元数据冲突')));
});

/* ------------------------------------------------------------------ */
/* Persistence, aggregates and side-effect isolation                  */
/* ------------------------------------------------------------------ */

test('aggregates survive a real SQLite close/reopen with replay identity intact', (t) => {
  const dir = tempDir('get95-fetch-');
  const dbPath = path.join(dir, 'fetch-coverage.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const record = newCase(store);
  const account = addAccount(store, record, 'synthetic-handle', 'public_history');
  const source = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-a', publishedAt: '2026-03-01' })
  );
  const second = store.cases.recordSourceRevision(
    caseCtx(store, record, account.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/fetch/post-b', publishedAt: null })
  );
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    spec: minimalSpec(),
    reason: 'synthetic persistence fixture'
  });
  const recordObs = (draft: CompletionObservationDraft) =>
    store.completion.recordCompletionObservation({
      ownerId: OWNER,
      caseId: record.caseId,
      expectedScopeVersion: currentVersion(store, record.caseId),
      scopeSpecId: frozen.scopeSpecId,
      receipt: draft
    });
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'present' },
        { sourceId: second.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  recordObs(
    obsDraft('select_branch', 'branch_selected', {
      kind: 'thread_branch',
      accountId: account.accountId,
      sourceId: source.sourceId,
      sourceRevision: 1,
      branchKey: 'c-1'
    }, {
      parentChain: [{ commentKey: 'c-root', depth: 1, state: 'hidden' }]
    })
  );
  const receipts: FetchProcessingReceiptDraft[] = [
    receiptDraft({
      receiptKey: 'persist-body',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 }
    }),
    receiptDraft({
      receiptKey: 'persist-media',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
      dimension: { name: 'media' },
      state: 'truncated',
      reason: '合成截断：字幕只取到一半'
    }),
    receiptDraft({
      receiptKey: 'persist-thread',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
      dimension: { name: 'thread_branch', branchKey: 'c-1' },
      state: 'context_missing',
      reason: '父节点隐藏',
      parents: [{ commentKey: 'c-root', state: 'hidden' }]
    }),
    receiptDraft({
      receiptKey: 'persist-comments',
      content: { accountId: account.accountId, sourceId: second.sourceId, sourceRevision: 1 },
      dimension: { name: 'comments' }
    })
  ];
  store.fetchCoverage.recordFetchBatch({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    receipts
  });
  const before = store.fetchCoverage.getFetchCoverageView(OWNER, record.caseId, frozen.scopeSpecId);
  assert.ok(before);

  db.close();
  db = openDatabase(dbPath);
  store = new Store(db);
  const after = store.fetchCoverage.getFetchCoverageView(OWNER, record.caseId, frozen.scopeSpecId);
  assert.ok(after);
  assert.deepEqual(after, before);

  // Aggregates are persisted and honest.
  const accountView = accountOf(after, account.accountId);
  assert.equal(accountView.total, 2);
  assert.equal(accountView.unknownDateItems, 1);
  assert.equal(counterOf(accountView, 'body').percent, 50);
  assert.equal(counterOf(accountView, 'media').states.truncated, 1);
  assert.equal(counterOf(accountView, 'comments').percent, 50);
  assert.equal(counterOf(accountView, 'thread_branch').instances, 1);
  assert.equal(counterOf(accountView, 'thread_branch').states.context_missing, 1);

  // Replay identity survives reopen: same key + body is a no-op ...
  const replay = store.fetchCoverage.recordFetchReceipt({
    ownerId: OWNER,
    caseId: record.caseId,
    expectedScopeVersion: currentVersion(store, record.caseId),
    receipt: receipts[0] as FetchProcessingReceiptDraft
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptKey, 'persist-body');
  // ... and the same key with a different body is still a conflict.
  assert.throws(
    () =>
      store.fetchCoverage.recordFetchReceipt({
        ownerId: OWNER,
        caseId: record.caseId,
        expectedScopeVersion: currentVersion(store, record.caseId),
        receipt: receiptDraft({
          receiptKey: 'persist-body',
          content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
          state: 'skipped',
          reason: '重开后冲突'
        })
      }),
    FetchReceiptConflictError
  );
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 4);
  assert.deepEqual(
    store.fetchCoverage.getFetchCoverageView(OWNER, record.caseId, frozen.scopeSpecId),
    before
  );
});

test('processing receipts never change completion, identity or publication state', (t) => {
  const fixture = baseFixture(t);
  const { db, store, record, account, source, frozen, recordObs, recordFetch } = fixture;
  recordObs(
    obsDraft('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: 'present' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  const snapshot = () => ({
    scopeVersion: currentVersion(store, record.caseId),
    personRevision: (() => {
      const row = db.prepare('SELECT person_revision AS n FROM research_cases WHERE id = ?').get(record.caseId) as {
        n: number;
      };
      return row.n;
    })(),
    scopeJournal: (
      db.prepare('SELECT COUNT(*) AS n FROM research_case_scope_versions').get() as { n: number }
    ).n,
    observations: (
      db.prepare('SELECT COUNT(*) AS n FROM research_case_completion_observations').get() as { n: number }
    ).n,
    assessments: (
      db.prepare('SELECT COUNT(*) AS n FROM research_case_completion_assessments').get() as { n: number }
    ).n,
    frozenScopes: (
      db.prepare('SELECT COUNT(*) AS n FROM research_case_completion_scopes').get() as { n: number }
    ).n,
    claims: (db.prepare('SELECT COUNT(*) AS n FROM research_case_claims').get() as { n: number }).n,
    coverage: (db.prepare('SELECT COUNT(*) AS n FROM research_case_item_coverage').get() as { n: number }).n,
    report: JSON.stringify(store.cases.reportView(OWNER, record.caseId))
  });
  const before = snapshot();

  recordFetch(
    receiptDraft({
      receiptKey: 'iso-1',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 }
    })
  );
  recordFetch(
    receiptDraft({
      receiptKey: 'iso-2',
      content: { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 },
      dimension: { name: 'media' },
      state: 'skipped',
      reason: '合成跳过：无授权转写'
    })
  );
  fixture.view();
  fixture.view();
  const after = snapshot();
  assert.deepEqual(after, before);
  assert.equal(store.fetchCoverage.listFetchReceipts(OWNER, record.caseId).length, 2);
  assert.equal(frozen.scopeSpecId, fixture.view().scopeSpecId);
});
