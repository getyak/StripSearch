/**
 * GET-60 research completion policy regressions.
 *
 * Synthetic fixtures only (no network, no real people). Covered with a real
 * SQLite file (close/reopen) and deterministic same-input replay:
 * - no-account full-directory freeze with registry platforms beyond the
 *   initial deep-read samples; empty registry/obligations cannot pass;
 * - caller mutation after freeze, same-version discovery events and reopen
 *   never change a frozen spec, account slice hash or event anchor;
 * - a revise with a foreign account reference rolls version, journal and spec
 *   back together; a valid revise advances exactly one version; old context
 *   is rejected; hard questions cannot be deleted, only frozen as
 *   not_applicable with a reason;
 * - old partial assessments and old questions survive a scope shrink;
 * - sufficient claims/answers still leave unread body, default comment page,
 *   media and selected thread/ancestor obligations partial;
 * - investigated unknown counts only with protocol-conforming investigative
 *   actions and dependencies; unattempted, budget, permission and unsupported
 *   stay distinct and never masquerade as no_match or resolved_unknown;
 * - open cursors/known gaps keep totals unknown; honest endpoint completion
 *   claims only the endpoint-accessible range and a zero denominator never
 *   renders 100%;
 * - source/evidence/identity dependency changes invalidate the current
 *   assessment while historical replay stays possible (never via
 *   personRevision alone);
 * - coverage pins bind exact itemId+revision+locator across accounts, posts
 *   and revisions; foreign/mismatched references are rejected as a whole;
 * - failed/cancelled/needs_input recorded states survive the completion
 *   algorithm and the same persisted input replays identically after reopen.
 *
 * Review repair batch (ordered supersession + dependency validity):
 * - withdrawing the sole supporting/counterevidence/indirect dependency keeps
 *   a fresh assessment from re-declaring completion while old assessments and
 *   replay stay intact; an independent valid alternative restores completion;
 * - failed/cancelled/needs_input answers and blocking stop reasons never
 *   satisfy questions; a later valid success resolves them;
 * - the latest receipt supersedes per obligation in both directions
 *   (exhaustion→new cursor/gap becomes incomplete with unknown denominators;
 *   open cursor→final exhaustion completes) across discovery too;
 * - enumerated items are validated against persisted case/account sources in
 *   the recording transaction (no partial writes);
 * - missing/deleted/hidden parent chains never complete on depth alone and a
 *   later clean read releases earlier gaps with historical limitations kept;
 * - investigated unknowns require the frozen eligible-investigation
 *   protocol plus concrete valid dependencies;
 * - the question-deletion guard selects the previous scope by authoritative
 *   scope_version under same-millisecond and backwards clocks, with full
 *   rollback and version-ordered listings.
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
import {
  CaseNotFoundError,
  ForeignReferenceError,
  StaleScopeError,
  asScopeVersion
} from '../shared/research-case.js';
import type {
  RecordProvenance,
  ResearchCase,
  ScopeAccountSnapshot,
  ScopeVersion,
  SourceRevision
} from '../shared/research-case.js';
import {
  CompletionSpecError,
  ObservationProtocolError
} from '../shared/research-completion.js';
import { COMPLETION_POLICY_VERSION, obligationKey } from '../shared/research-completion.js';
import type {
  CompletionAssessment,
  CompletionDimension,
  CompletionDimensionReport,
  CompletionEvaluation,
  CompletionObservation,
  CompletionObservationDraft,
  CompletionScopeSpec,
  CompletionSnapshot,
  ObligationRef
} from '../shared/research-completion.js';
import { evaluateCompletion } from '../server/research/completion-eval.js';

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

function newCase(store: Store, intent = 'Synthetic completion case'): ResearchCase {
  return store.cases.createCase({ ownerId: OWNER, intent, provenance: PROVENANCE });
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
    originalUrl: 'https://fixture.test/synthetic-post',
    title: 'Synthetic post',
    publishedAt: '2026-03-01',
    retrievedAt: '2026-04-01T00:00:00.000Z',
    locator: 'paragraph 1',
    contentHash: 'a'.repeat(64),
    provenance: PROVENANCE,
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

function currentVersion(store: Store, caseId: string): ScopeVersion {
  const record = store.cases.getCase(OWNER, caseId);
  assert.ok(record);
  return record.scopeVersion;
}

function registry(platforms: Array<[string, string, string?]>) {
  return {
    registryVersion: 'catalog-2026-09-29',
    entries: platforms.map(([platformId, label, applicabilityReason]) => ({
      platformId,
      label,
      applicability: 'applicable' as const,
      applicabilityReason: applicabilityReason ?? '目录内适用平台，冻结为发现义务'
    }))
  };
}

function specFixture(overrides: Partial<CompletionScopeSpec> = {}): CompletionScopeSpec {
  return {
    questions: [
      {
        questionId: 'q-work',
        slot: 'work',
        text: '这个人实际做了什么？',
        applicability: 'applicable',
        applicabilityReason: '核心研究问题'
      },
      {
        questionId: 'q-change',
        slot: 'change',
        text: '公开表达是否变化？',
        applicability: 'applicable',
        applicabilityReason: '长期理解需要'
      }
    ],
    platformRegistry: registry([
      ['x', 'X'],
      ['reddit', 'Reddit'],
      ['github', 'GitHub'],
      ['personal_site', '个人网站'],
      ['video_platform', '视频平台（首批深读样本之外）'],
      ['forum_longtail', '公开长尾论坛（首批深读样本之外）']
    ]),
    accountRange: { mode: 'researched_accounts', accountIds: [] },
    timeRange: { from: '2026-01-01', to: '2026-12-31' },
    threadDepth: 4,
    requiredChecks: [
      { checkId: 'time_coverage', kind: 'time_coverage', required: ['2026-H1', '2026-H2'] },
      { checkId: 'source_diversity', kind: 'source_diversity', required: ['personal_site', 'press'] }
    ],
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

function receipt(
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

function record(
  store: Store,
  caseId: string,
  scopeSpecId: string,
  draft: CompletionObservationDraft
): CompletionObservation {
  return store.completion.recordCompletionObservation({
    ownerId: OWNER,
    caseId,
    expectedScopeVersion: currentVersion(store, caseId),
    scopeSpecId,
    receipt: draft
  });
}

function assess(store: Store, caseId: string, scopeSpecId: string): CompletionAssessment {
  return store.completion.assessCompletion({
    ownerId: OWNER,
    caseId,
    scopeSpecId,
    expectedScopeVersion: currentVersion(store, caseId)
  });
}

function dim(assessment: CompletionAssessment, dimension: CompletionDimension): CompletionDimensionReport {
  const found = assessment.evaluation.dimensions.find((entry) => entry.dimension === dimension);
  assert.ok(found, `missing dimension ${dimension}`);
  return found;
}

function reasonFor(assessment: CompletionAssessment, dimension: CompletionDimension, keyFragment: string): string | undefined {
  const item = dim(assessment, dimension).unresolvedItems.find(
    (entry) => entry.obligationKey.includes(keyFragment) || (entry.detail ?? '').includes(keyFragment)
  );
  return item?.reason;
}

/* ------------------------------------------------------------------ */
/* Repair-batch fixtures: one platform, two questions, one check      */
/* ------------------------------------------------------------------ */

function minimalSpec(overrides: Partial<CompletionScopeSpec> = {}): CompletionScopeSpec {
  return specFixture({
    platformRegistry: registry([['synthetic', 'Synthetic']]),
    requiredChecks: [{ checkId: 'time', kind: 'time_coverage', required: ['2026'] }],
    ...overrides
  });
}

/** Everything complete on one item: used to isolate one defect at a time. */
function setupComplete(
  t: TestContext,
  options: { counterEvidence?: boolean; enumerationCursor?: string; enumerationMedia?: 'none' | 'present' | 'unknown' } = {}
) {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const account = seedResearchAccount(store, record_, 'repair-account');
  const caseCtx = () => ctx(record_, account.accountId, currentVersion(store, record_.caseId));
  const source = store.cases.recordSourceRevision(caseCtx(), sourceDraft({ originalUrl: 'https://fixture.test/repair/post' }));
  const evidence = store.cases.addEvidence(caseCtx(), {
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    role: 'factual_support',
    quote: '合成支持片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  const counter = store.cases.addEvidence(caseCtx(), {
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    role: 'factual_counterevidence',
    quote: '合成反证片段',
    locator: 'paragraph 2',
    provenance: PROVENANCE
  });
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: minimalSpec(),
    reason: 'synthetic repair fixture'
  });
  const rec = (draft: CompletionObservationDraft) => record(store, record_.caseId, frozen.scopeSpecId, draft);
  const refs = (evidenceIds: string[], extra: Record<string, unknown> = {}) => ({
    ...emptyRefs(),
    evidenceIds,
    ...extra
  });
  rec(receipt('discover_platform', 'checked_no_match', { kind: 'platform_discovery', platformId: 'synthetic' }));
  rec(
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [{ sourceId: source.sourceId, sourceRevision: 1, hasMedia: options.enumerationMedia ?? 'none' }],
      nextCursor: options.enumerationCursor ?? null,
      knownGaps: [],
      stopReason: options.enumerationCursor ? null : 'endpoint_exhausted'
    })
  );
  rec(receipt('read_body', 'content_read', {
    kind: 'item_body',
    accountId: account.accountId,
    sourceId: source.sourceId,
    sourceRevision: 1
  }));
  rec(receipt('read_comments', 'comments_read', {
    kind: 'item_comments',
    accountId: account.accountId,
    sourceId: source.sourceId,
    sourceRevision: 1
  }));
  const answerSet = (evidenceIds: string[]) => {
    rec(receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
      explanation: '合成证据支持',
      refs: refs(evidenceIds)
    }));
    rec(
      receipt('answer_question', options.counterEvidence ? 'conflicting' : 'supported', { kind: 'question', questionId: 'q-change' }, {
        explanation: options.counterEvidence ? '支持与反证冲突' : '合成证据支持',
        refs: refs(evidenceIds, options.counterEvidence ? { counterevidenceIds: [counter.evidenceId] } : {})
      })
    );
  };
  answerSet([evidence.evidenceId]);
  rec(receipt('report_required_check', 'observed', { kind: 'required_check', checkId: 'time' }, {
    observed: ['2026'],
    explanation: '按冻结时段统计'
  }));
  return {
    db,
    store,
    record: record_,
    account,
    source,
    evidence,
    counter,
    frozen,
    rec,
    answerSet,
    assess: () => assess(store, record_.caseId, frozen.scopeSpecId)
  };
}

/** Seed one researched account whose allowedScope is public_history. */
function seedResearchAccount(store: Store, record_: ResearchCase, handle: string) {
  const account = store.cases.addAccount(
    {
      ownerId: OWNER,
      caseId: record_.caseId,
      accountId: 'ignored',
      expectedScopeVersion: currentVersion(store, record_.caseId)
    },
    accountDraft({ handle })
  );
  const c = store.cases.getCase(OWNER, record_.caseId);
  assert.ok(c);
  store.cases.applyScopeChange({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: c.scopeVersion,
    reason: 'synthetic confirmation',
    accounts: [
      {
        accountId: account.accountId,
        userSelection: { state: 'selected', note: 'synthetic', recordedAt: '2026-01-02' },
        allowedScope: { state: 'public_history', note: 'synthetic' }
      }
    ]
  });
  return account;
}

test('no-account full-directory freeze keeps every registry platform as a discovery obligation', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);

  // Freeze works before any account exists; no fake account is invented.
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: record_.scopeVersion,
    spec: specFixture(),
    reason: 'synthetic full-directory freeze'
  });
  assert.equal(frozen.scopeVersion, record_.scopeVersion);
  assert.equal(store.cases.listAccounts(OWNER, record_.caseId).length, 0);
  assert.equal(frozen.accountSlice.length, 0);
  assert.equal(frozen.spec.platformRegistry.entries.length, 6);

  // Empty registries / empty global obligations cannot freeze or pass vacuously.
  const other = newCase(store);
  assert.throws(
    () =>
      store.completion.freezeCompletionScope({
        ownerId: OWNER,
        caseId: other.caseId,
        expectedScopeVersion: other.scopeVersion,
        spec: specFixture({ platformRegistry: { registryVersion: 'empty', entries: [] } })
      }),
    CompletionSpecError
  );
  assert.throws(
    () =>
      store.completion.freezeCompletionScope({
        ownerId: OWNER,
        caseId: other.caseId,
        expectedScopeVersion: other.scopeVersion,
        spec: specFixture({ questions: [] })
      }),
    CompletionSpecError
  );
  assert.throws(
    () =>
      store.completion.freezeCompletionScope({
        ownerId: OWNER,
        caseId: other.caseId,
        expectedScopeVersion: other.scopeVersion,
        spec: specFixture({ requiredChecks: [] })
      }),
    CompletionSpecError
  );
  assert.throws(
    () =>
      store.completion.freezeCompletionScope({
        ownerId: OWNER,
        caseId: other.caseId,
        expectedScopeVersion: other.scopeVersion,
        spec: specFixture({
          platformRegistry: {
            registryVersion: 'catalog-2026-09-29',
            entries: registry([
              ['x', 'X', '本研究排除'],
              ['reddit', 'Reddit', '本研究排除']
            ]).entries.map((entry) => ({ ...entry, applicability: 'not_applicable' as const }))
          }
        })
      }),
    CompletionSpecError
  );
  // First freeze binds the version once; re-freezing is rejected.
  assert.throws(
    () =>
      store.completion.freezeCompletionScope({
        ownerId: OWNER,
        caseId: record_.caseId,
        expectedScopeVersion: record_.scopeVersion,
        spec: specFixture()
      }),
    CompletionSpecError
  );

  // Fresh reads enforce owner/case isolation (owner mismatch = not found).
  assert.throws(
    () => store.completion.getCompletionScope('other-owner', record_.caseId, frozen.scopeSpecId),
    CaseNotFoundError
  );
  assert.throws(() => store.completion.listCompletionScopes('other-owner', record_.caseId), CaseNotFoundError);
  assert.throws(
    () => store.completion.getCompletionAssessment('other-owner', record_.caseId, 'any-assessment'),
    CaseNotFoundError
  );
  assert.throws(
    () => store.completion.getCompletionScope(OWNER, 'missing-case', frozen.scopeSpecId),
    CaseNotFoundError
  );

  const assessment = assess(store, record_.caseId, frozen.scopeSpecId);
  assert.equal(assessment.evaluation.verdict, 'incomplete');
  const discovery = dim(assessment, 'platform_discovery');
  assert.equal(discovery.total, 6);
  assert.equal(discovery.unresolved, 6);
  assert.equal(discovery.addressed, 0);
  for (const entry of frozen.spec.platformRegistry.entries) {
    assert.ok(
      discovery.unresolvedItems.some((item) => item.detail === entry.platformId && item.reason === 'unattempted'),
      `platform ${entry.platformId} must stay represented`
    );
  }
  // Zero/unknown denominators never render a percentage (never 100%).
  for (const report of assessment.evaluation.dimensions) {
    if (report.total === 0 || report.total === null || !report.denominatorKnown) {
      assert.equal(report.percent, null, `${report.dimension} must not render a fake percentage`);
    }
  }
  assert.equal(dim(assessment, 'body').percent, null);
});

test('frozen specs deep-copy, survive reopen and ignore later same-version discovery events', () => {
  const dir = tempDir('get60-freeze-');
  const dbPath = path.join(dir, 'completion.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  try {
    const record_ = newCase(store);
    const accountA = store.cases.addAccount(ctx(record_, 'ignored'), accountDraft({ handle: 'account-a' }));
    const spec = specFixture({ accountRange: { mode: 'explicit', accountIds: [accountA.accountId] } });
    const frozen = store.completion.freezeCompletionScope({
      ownerId: OWNER,
      caseId: record_.caseId,
      expectedScopeVersion: record_.scopeVersion,
      spec,
      reason: 'synthetic anchor freeze'
    });
    const expected = JSON.parse(JSON.stringify(frozen)) as typeof frozen;

    // Caller mutation after the freeze must not change the persisted spec.
    spec.questions.push({
      questionId: 'q-injected',
      slot: null,
      text: 'caller mutation',
      applicability: 'applicable',
      applicabilityReason: 'caller mutation'
    });
    spec.platformRegistry.entries.pop();
    spec.timeRange.from = '2020-01-01';
    spec.accountRange.accountIds.push('acct-injected');

    // A discovery candidate appends a scope event at the SAME scopeVersion.
    const accountB = store.cases.addAccount(ctx(record_, 'ignored'), accountDraft({ handle: 'late-candidate' }));
    assert.equal(currentVersion(store, record_.caseId), frozen.scopeVersion);
    assert.equal(store.cases.listAccounts(OWNER, record_.caseId).length, 2);

    const afterDiscovery = store.completion.getCompletionScope(OWNER, record_.caseId, frozen.scopeSpecId);
    assert.ok(afterDiscovery);
    assert.deepEqual(afterDiscovery.spec, expected.spec);
    assert.equal(afterDiscovery.specHash, expected.specHash);
    assert.equal(afterDiscovery.accountSliceHash, expected.accountSliceHash);
    assert.equal(afterDiscovery.registryHash, expected.registryHash);
    assert.equal(afterDiscovery.scopeEventId, expected.scopeEventId);
    assert.equal(afterDiscovery.accountSlice.length, 1);
    assert.equal(afterDiscovery.accountSlice[0]?.accountId, accountA.accountId);
    assert.ok(accountB.accountId !== accountA.accountId);

    // Obligations derive from the frozen slice, not from current rows.
    const assessment = assess(store, record_.caseId, frozen.scopeSpecId);
    assert.equal(dim(assessment, 'history_enumeration').total, 1);

    // Close/reopen: the frozen record is byte-identical.
    db.close();
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    store = new Store(db);
    const reopened = store.completion.getCompletionScope(OWNER, record_.caseId, frozen.scopeSpecId);
    assert.ok(reopened);
    assert.deepEqual(reopened, afterDiscovery);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revise batch with a foreign account reference rolls back version, journal and spec together', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const accountA = store.cases.addAccount(ctx(record_, 'ignored'), accountDraft({ handle: 'account-a' }));
  const foreignCase = newCase(store, 'other synthetic case');
  const foreignAccount = store.cases.addAccount(
    ctx(foreignCase, 'ignored'),
    accountDraft({ handle: 'foreign-account' })
  );
  const spec1 = specFixture({ accountRange: { mode: 'explicit', accountIds: [accountA.accountId] } });
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: record_.scopeVersion,
    spec: spec1,
    reason: 'synthetic v1'
  });
  const historyBefore = store.cases.scopeHistory(OWNER, record_.caseId);
  const scopesBefore = store.completion.listCompletionScopes(OWNER, record_.caseId);

  // Question/time/depth edits plus a SECOND account reference that is foreign.
  const shrunk = specFixture({
    questions: [
      { questionId: 'q-work', slot: 'work', text: '缩小后的主问题', applicability: 'applicable', applicabilityReason: '保留' },
      { questionId: 'q-change', slot: 'change', text: '缩小后的问题', applicability: 'applicable', applicabilityReason: '保留' }
    ],
    timeRange: { from: '2026-01-01', to: '2026-06-30' },
    threadDepth: 2,
    accountRange: { mode: 'explicit', accountIds: [accountA.accountId, foreignAccount.accountId] }
  });
  assert.throws(
    () =>
      store.completion.reviseCompletionScope({
        ownerId: OWNER,
        caseId: record_.caseId,
        expectedScopeVersion: frozen.scopeVersion,
        spec: shrunk,
        reason: 'synthetic invalid revise'
      }),
    ForeignReferenceError
  );
  // Version, journal and spec table all rolled back.
  assert.equal(currentVersion(store, record_.caseId), frozen.scopeVersion);
  assert.deepEqual(store.cases.scopeHistory(OWNER, record_.caseId), historyBefore);
  assert.deepEqual(store.completion.listCompletionScopes(OWNER, record_.caseId), scopesBefore);

  // Deleting a previously frozen question is refused: no after-the-fact deletion.
  assert.throws(
    () =>
      store.completion.reviseCompletionScope({
        ownerId: OWNER,
        caseId: record_.caseId,
        expectedScopeVersion: frozen.scopeVersion,
        spec: specFixture({ questions: [specFixture().questions[0] as CompletionScopeSpec['questions'][number]] }),
        reason: 'synthetic question deletion'
      }),
    CompletionSpecError
  );
  assert.equal(currentVersion(store, record_.caseId), frozen.scopeVersion);

  // A valid revise advances exactly once and persists the new spec.
  const valid = specFixture({
    questions: [
      { questionId: 'q-work', slot: 'work', text: '缩小后的主问题', applicability: 'applicable', applicabilityReason: '保留' },
      { questionId: 'q-change', slot: 'change', text: '缩小后的问题', applicability: 'applicable', applicabilityReason: '保留' }
    ],
    timeRange: { from: '2026-01-01', to: '2026-06-30' },
    threadDepth: 2,
    accountRange: { mode: 'explicit', accountIds: [accountA.accountId] }
  });
  const revised = store.completion.reviseCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: frozen.scopeVersion,
    spec: valid,
    reason: 'synthetic shrink'
  });
  assert.equal(revised.scopeVersion, asScopeVersion(frozen.scopeVersion + 1));
  assert.equal(currentVersion(store, record_.caseId), revised.scopeVersion);
  assert.equal(store.cases.scopeHistory(OWNER, record_.caseId).length, historyBefore.length + 1);
  assert.equal(store.completion.listCompletionScopes(OWNER, record_.caseId).length, 2);

  // Old spec is immutable history; old context writes are rejected.
  const old = store.completion.getCompletionScope(OWNER, record_.caseId, frozen.scopeSpecId);
  assert.ok(old);
  assert.deepEqual(old.spec, expectedSpecCopy(frozen.spec));
  assert.equal(old.isCurrent, false);
  assert.throws(
    () =>
      store.completion.recordCompletionObservation({
        ownerId: OWNER,
        caseId: record_.caseId,
        expectedScopeVersion: frozen.scopeVersion,
        scopeSpecId: frozen.scopeSpecId,
        receipt: receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
          explanation: 'stale context',
          refs: { ...emptyRefs(), evidenceIds: ['ev-none'] }
        })
      }),
    StaleScopeError
  );
  assert.throws(
    () =>
      store.completion.assessCompletion({
        ownerId: OWNER,
        caseId: record_.caseId,
        scopeSpecId: frozen.scopeSpecId,
        expectedScopeVersion: frozen.scopeVersion
      }),
    StaleScopeError
  );
});

function expectedSpecCopy(spec: CompletionScopeSpec): CompletionScopeSpec {
  return JSON.parse(JSON.stringify(spec)) as CompletionScopeSpec;
}

test('an old partial assessment survives a scope shrink and cannot masquerade as the new scope', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const account = seedResearchAccount(store, record_, 'shrinking-account');
  const spec1 = specFixture();
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: spec1,
    reason: 'synthetic v1 full agreement'
  });
  const source = store.cases.recordSourceRevision(
    ctx(record_, account.accountId, currentVersion(store, record_.caseId)),
    sourceDraft({ originalUrl: 'https://fixture.test/a/post-1' })
  );
  const evidence = store.cases.addEvidence(
    ctx(record_, account.accountId, currentVersion(store, record_.caseId)),
    {
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      role: 'factual_support',
      quote: '合成证据片段',
      locator: 'paragraph 1',
      provenance: PROVENANCE
    }
  );
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '有合成证据支持',
    refs: { ...emptyRefs(), evidenceIds: [evidence.evidenceId] }
  }));
  const first = assess(store, record_.caseId, frozen.scopeSpecId);
  assert.equal(first.evaluation.verdict, 'partial');
  const firstView = store.completion.getCompletionAssessment(OWNER, record_.caseId, first.assessmentId);
  assert.ok(firstView);
  assert.equal(firstView.currentValidity, 'valid');

  // Shrink: q-change stays listed as not_applicable with a frozen reason.
  const spec2 = specFixture({
    questions: [
      { questionId: 'q-work', slot: 'work', text: '这个人实际做了什么？', applicability: 'applicable', applicabilityReason: '核心研究问题' },
      {
        questionId: 'q-change',
        slot: 'change',
        text: '公开表达是否变化？',
        applicability: 'not_applicable',
        applicabilityReason: '本轮授权材料不含跨期表达'
      }
    ],
    timeRange: { from: '2026-01-01', to: '2026-06-30' }
  });
  const revised = store.completion.reviseCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: spec2,
    reason: 'synthetic shrink'
  });

  // Old spec and old partial stay readable and unchanged.
  const oldScope = store.completion.getCompletionScope(OWNER, record_.caseId, frozen.scopeSpecId);
  assert.ok(oldScope);
  assert.deepEqual(oldScope.spec.questions, expectedSpecCopy(spec1).questions);
  const oldView = store.completion.getCompletionAssessment(OWNER, record_.caseId, first.assessmentId);
  assert.ok(oldView);
  assert.deepEqual(oldView.evaluation, first.evaluation);
  assert.deepEqual(oldView.input, first.input);
  assert.equal(oldView.currentValidity, 'review');
  assert.ok(oldView.staleReasons.includes('scope_advanced'));

  // The new assessment is explicitly bound to the new scope.
  const second = assess(store, record_.caseId, revised.scopeSpecId);
  assert.equal(second.scopeVersion, revised.scopeVersion);
  assert.equal(second.scopeSpecId, revised.scopeSpecId);
  const questions = dim(second, 'questions');
  assert.equal(questions.total, 1);
  assert.equal(questions.notApplicable, 1);
  assert.ok(questions.notApplicableReasons.some((line) => line.includes('本轮授权材料不含跨期表达')));
  assert.notDeepEqual(second.inputHash, first.inputHash);
});

test('sufficient claims and answers still leave body, comments, media and thread obligations partial', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const account = seedResearchAccount(store, record_, 'claims-account');
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: specFixture(),
    reason: 'synthetic claims fixture'
  });
  const caseCtx = () => ctx(record_, account.accountId, currentVersion(store, record_.caseId));
  const post1 = store.cases.recordSourceRevision(caseCtx(), sourceDraft({ originalUrl: 'https://fixture.test/a/post-1', publishedAt: '2026-03-01' }));
  const post2 = store.cases.recordSourceRevision(caseCtx(), sourceDraft({ originalUrl: 'https://fixture.test/a/post-2', publishedAt: '2026-06-01' }));
  const evidence1 = store.cases.addEvidence(caseCtx(), {
    sourceId: post1.sourceId,
    sourceRevision: post1.sourceRevision,
    role: 'factual_support',
    quote: '合成支持片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  const evidence2 = store.cases.addEvidence(caseCtx(), {
    sourceId: post2.sourceId,
    sourceRevision: post2.sourceRevision,
    role: 'factual_support',
    quote: '合成支持片段二',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  // A conventional GET-58 claim: sufficient on its own terms.
  store.cases.addClaim(caseCtx(), {
    statement: '合成结论',
    kind: 'factual',
    supportIds: [evidence1.evidenceId],
    counterevidenceIds: [],
    limitations: []
  });

  const enumeration = record(
    store,
    record_.caseId,
    frozen.scopeSpecId,
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: post1.sourceId, sourceRevision: 1, hasMedia: 'present' },
        { sourceId: post2.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '有合成证据支持',
    refs: { ...emptyRefs(), evidenceIds: [evidence1.evidenceId] }
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'conflicting', { kind: 'question', questionId: 'q-change' }, {
    explanation: '两个来源相互冲突',
    refs: { ...emptyRefs(), evidenceIds: [evidence2.evidenceId], counterevidenceIds: [] }
  }));
  // conflicting without counterevidence is not conforming; answer it properly.
  const counter = store.cases.addEvidence(caseCtx(), {
    sourceId: post2.sourceId,
    sourceRevision: post2.sourceRevision,
    role: 'factual_counterevidence',
    quote: '合成反证片段',
    locator: 'paragraph 2',
    provenance: PROVENANCE
  });
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'conflicting', { kind: 'question', questionId: 'q-change' }, {
    explanation: '两个来源相互冲突',
    refs: { ...emptyRefs(), evidenceIds: [evidence2.evidenceId], counterevidenceIds: [counter.evidenceId] }
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('report_required_check', 'observed', { kind: 'required_check', checkId: 'time_coverage' }, {
    observed: ['2026-H1', '2026-H2'],
    explanation: '按冻结时段统计'
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('report_required_check', 'observed', { kind: 'required_check', checkId: 'source_diversity' }, {
    observed: ['personal_site', 'press'],
    explanation: '按冻结来源组统计'
  }));
  // One body read, one body unread; one comment page read, one unread.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('read_body', 'content_read', {
    kind: 'item_body',
    accountId: account.accountId,
    sourceId: post1.sourceId,
    sourceRevision: 1
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('read_comments', 'comments_read', {
    kind: 'item_comments',
    accountId: account.accountId,
    sourceId: post1.sourceId,
    sourceRevision: 1
  }));
  // Selected thread branch with a missing parent: context stays explicit.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('select_branch', 'branch_selected', {
    kind: 'thread_branch',
    accountId: account.accountId,
    sourceId: post1.sourceId,
    sourceRevision: 1,
    branchKey: 'thread-1'
  }, {
    parentChain: [{ commentKey: 'c1', depth: 1, state: 'missing' }]
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('read_thread', 'thread_read', {
    kind: 'thread_branch',
    accountId: account.accountId,
    sourceId: post1.sourceId,
    sourceRevision: 1,
    branchKey: 'thread-1'
  }, {
    depthReached: 2,
    blockers: [{ commentKey: 'c1', state: 'missing' }]
  }));

  const assessment = assess(store, record_.caseId, frozen.scopeSpecId);
  assert.equal(assessment.evaluation.verdict, 'partial');
  assert.equal(dim(assessment, 'questions').state, 'complete');
  assert.equal(dim(assessment, 'required_checks').state, 'complete');
  assert.equal(dim(assessment, 'history_enumeration').state, 'complete');

  const body = dim(assessment, 'body');
  assert.equal(body.state, 'partial');
  assert.equal(body.addressed, 1);
  assert.equal(body.unresolved, 1);
  assert.equal(body.total, 2);
  const comments = dim(assessment, 'comments');
  assert.equal(comments.state, 'partial');
  assert.equal(comments.unresolved, 1);
  const media = dim(assessment, 'media');
  assert.equal(media.state, 'partial');
  assert.equal(media.notApplicable, 1);
  assert.ok(media.notApplicableReasons.some((line) => line.includes('no_media')));
  const thread = dim(assessment, 'thread');
  assert.equal(thread.state, 'partial');
  assert.equal(thread.unresolved, 1);
  assert.ok(thread.unresolvedItems[0]?.reason === 'unavailable_content');
  assert.ok(thread.limitations.some((line) => line.includes('missing c1')));

  // A free-text "model completed" note can never establish completion.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('note', 'note_only', { kind: 'note' }, {
    note: 'model declares research completed'
  }));
  const afterNote = assess(store, record_.caseId, frozen.scopeSpecId);
  assert.equal(afterNote.evaluation.verdict, 'partial');
});

test('investigated unknown counts only with protocol-conforming actions; unattempted, budget, permission and unsupported stay distinct', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const account = seedResearchAccount(store, record_, 'unknown-account');
  const spec = specFixture({
    questions: [
      { questionId: 'q-investigated', slot: null, text: '早期活动？', applicability: 'applicable', applicabilityReason: '核心' },
      { questionId: 'q-nodeps', slot: null, text: '无依据未知？', applicability: 'applicable', applicabilityReason: '核心' },
      { questionId: 'q-unattempted', slot: null, text: '未尝试？', applicability: 'applicable', applicabilityReason: '核心' },
      { questionId: 'q-weak', slot: null, text: '弱支持？', applicability: 'applicable', applicabilityReason: '核心' }
    ]
  });
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec,
    reason: 'synthetic unknown fixture'
  });
  const caseCtx = () => ctx(record_, account.accountId, currentVersion(store, record_.caseId));
  const posts = [1, 2, 3].map((n) =>
    store.cases.recordSourceRevision(
      caseCtx(),
      sourceDraft({ originalUrl: `https://fixture.test/a/post-${String(n)}`, publishedAt: `2026-0${String(n + 1)}-01` })
    )
  );
  const evidence = store.cases.addEvidence(caseCtx(), {
    sourceId: posts[0]?.sourceId as string,
    sourceRevision: 1,
    role: 'factual_support',
    quote: '合成支持片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  const enumeration = record(
    store,
    record_.caseId,
    frozen.scopeSpecId,
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
      items: [
        { sourceId: posts[0]?.sourceId as string, sourceRevision: 1, hasMedia: 'present' },
        { sourceId: posts[1]?.sourceId as string, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: posts[2]?.sourceId as string, sourceRevision: 1, hasMedia: 'unknown' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );

  // Genuine investigated unknown: investigation action + dependencies + explicit remainder.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-investigated' }, {
    explanation: '已检查枚举记录与合成证据，仍无法回答 2025 年前的活动',
    remainingUnknown: '2025 年前的活动无法从可访问范围确认',
    refs: {
      ...emptyRefs(),
      evidenceIds: [evidence.evidenceId],
      observationIds: [enumeration.observationId]
    }
  }));
  // Unknown without investigative dependencies never counts as addressed.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-nodeps' }, {
    explanation: '自由文本声称已调查',
    remainingUnknown: '全部未知'
  }));
  // "Supported" without evidence is not conforming either.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-weak' }, {
    explanation: '模型认为已支持'
  }));
  // Body attempts with distinct honest stop reasons.
  const bodyAttempt = (post: SourceRevision, stopReason: string, result = 'unavailable') =>
    record(
      store,
      record_.caseId,
      frozen.scopeSpecId,
      receipt('read_body', result, {
        kind: 'item_body',
        accountId: account.accountId,
        sourceId: post.sourceId,
        sourceRevision: post.sourceRevision
      }, { stopReason })
    );
  bodyAttempt(posts[0] as SourceRevision, 'budget_exhausted');
  bodyAttempt(posts[1] as SourceRevision, 'permission_denied');
  bodyAttempt(posts[2] as SourceRevision, 'unsupported');
  // Comment attempts that ended failed / cancelled / needs_input.
  const commentAttempt = (post: SourceRevision, attemptState: string) =>
    record(
      store,
      record_.caseId,
      frozen.scopeSpecId,
      receipt('read_comments', 'unavailable', {
        kind: 'item_comments',
        accountId: account.accountId,
        sourceId: post.sourceId,
        sourceRevision: post.sourceRevision
      }, { attemptState })
    );
  commentAttempt(posts[0] as SourceRevision, 'failed');
  commentAttempt(posts[1] as SourceRevision, 'cancelled');
  commentAttempt(posts[2] as SourceRevision, 'needs_input');
  // Media: present-but-unread vs unknown applicability stay distinct.
  // Discovery: only a finished check with no match is checked_no_match.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('discover_platform', 'checked_no_match', {
    kind: 'platform_discovery',
    platformId: 'x'
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('discover_platform', 'inaccessible', {
    kind: 'platform_discovery',
    platformId: 'reddit'
  }, { stopReason: 'permission_denied' }));

  const assessment = assess(store, record_.caseId, frozen.scopeSpecId);
  assert.equal(assessment.evaluation.verdict, 'partial');

  // Handled unknown vs unfinished are distinct.
  assert.equal(assessment.evaluation.handledUnknowns.length, 1);
  assert.ok(assessment.evaluation.handledUnknowns[0]?.obligationKey.includes('q-investigated'));
  assert.equal(reasonFor(assessment, 'questions', 'q-investigated'), undefined);
  assert.equal(reasonFor(assessment, 'questions', 'q-nodeps'), 'no_conforming_investigation');
  assert.equal(reasonFor(assessment, 'questions', 'q-unattempted'), 'unattempted');
  assert.equal(reasonFor(assessment, 'questions', 'q-weak'), 'no_conforming_investigation');

  // Budget / permission / unsupported / unattempted never merge or masquerade.
  const [p1, p2, p3] = posts as [SourceRevision, SourceRevision, SourceRevision];
  assert.equal(reasonFor(assessment, 'body', p1.sourceId), 'budget_exhausted');
  assert.equal(reasonFor(assessment, 'body', p2.sourceId), 'permission_denied');
  assert.equal(reasonFor(assessment, 'body', p3.sourceId), 'unsupported');
  assert.equal(reasonFor(assessment, 'comments', p1.sourceId), 'failed');
  assert.equal(reasonFor(assessment, 'comments', p2.sourceId), 'cancelled');
  assert.equal(reasonFor(assessment, 'comments', p3.sourceId), 'needs_input');
  assert.equal(reasonFor(assessment, 'media', p1.sourceId), 'unattempted');
  assert.equal(reasonFor(assessment, 'media', p3.sourceId), 'media_applicability_unknown');

  const discovery = dim(assessment, 'platform_discovery');
  assert.equal(discovery.addressed, 1);
  assert.equal(reasonFor(assessment, 'platform_discovery', 'reddit'), 'permission_denied');
  assert.ok(!discovery.unresolvedItems.some((item) => item.reason === 'unattempted' && item.detail === 'reddit'));

  // failed / cancelled / needs_input are preserved verbatim.
  const states = assessment.evaluation.preservedAttempts.map((entry) => entry.attemptState).sort();
  assert.deepEqual(states, ['cancelled', 'failed', 'needs_input']);
  assert.ok(assessment.evaluation.claimBoundaries.some((line) => line.includes('needs_input')));
});

test('open cursors and known gaps keep totals unknown; honest endpoint completion claims only the accessible range', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());

  // Case A: all known items read, but one cursor is open and one account has gaps.
  const caseA = newCase(store, 'synthetic cursor case');
  const accountA1 = seedResearchAccount(store, caseA, 'cursor-account');
  const accountA2 = seedResearchAccount(store, caseA, 'gap-account');
  const frozenA = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: caseA.caseId,
    expectedScopeVersion: currentVersion(store, caseA.caseId),
    spec: specFixture(),
    reason: 'synthetic cursor fixture'
  });
  const ctxA1 = () => ctx(caseA, accountA1.accountId, currentVersion(store, caseA.caseId));
  const inWindow = store.cases.recordSourceRevision(ctxA1(), sourceDraft({ originalUrl: 'https://fixture.test/a1/p1', publishedAt: '2026-02-01' }));
  const dateUnknown = store.cases.recordSourceRevision(ctxA1(), sourceDraft({ originalUrl: 'https://fixture.test/a1/p2', publishedAt: null }));
  const outOfWindow = store.cases.recordSourceRevision(ctxA1(), sourceDraft({ originalUrl: 'https://fixture.test/a1/p3', publishedAt: '2020-05-01' }));
  record(
    store,
    caseA.caseId,
    frozenA.scopeSpecId,
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: accountA1.accountId }, {
      items: [
        { sourceId: inWindow.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: dateUnknown.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: outOfWindow.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: 'cursor-page-2',
      knownGaps: []
    })
  );
  record(
    store,
    caseA.caseId,
    frozenA.scopeSpecId,
    receipt('enumerate_history', 'no_match', { kind: 'account_history', accountId: accountA2.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: ['2025 年页面不可达'],
      stopReason: 'known_gap'
    })
  );
  // Read every known in-window item.
  for (const post of [inWindow, dateUnknown]) {
    record(
      store,
      caseA.caseId,
      frozenA.scopeSpecId,
      receipt('read_body', 'content_read', {
        kind: 'item_body',
        accountId: accountA1.accountId,
        sourceId: post.sourceId,
        sourceRevision: 1
      })
    );
    record(
      store,
      caseA.caseId,
      frozenA.scopeSpecId,
      receipt('read_comments', 'comments_read', {
        kind: 'item_comments',
        accountId: accountA1.accountId,
        sourceId: post.sourceId,
        sourceRevision: 1
      })
    );
  }
  // Endpoint exhaustion with an open cursor is refused at write time.
  assert.throws(
    () =>
      record(
        store,
        caseA.caseId,
        frozenA.scopeSpecId,
        receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: accountA1.accountId }, {
          items: [],
          nextCursor: 'cursor-still-open',
          knownGaps: [],
          stopReason: 'endpoint_exhausted'
        })
      ),
    ObservationProtocolError
  );

  const assessmentA = assess(store, caseA.caseId, frozenA.scopeSpecId);
  assert.equal(assessmentA.evaluation.verdict, 'partial');
  const historyA = dim(assessmentA, 'history_enumeration');
  assert.equal(historyA.unresolved, 2);
  assert.equal(reasonFor(assessmentA, 'history_enumeration', 'nextCursor'), 'cursor_open');
  assert.equal(reasonFor(assessmentA, 'history_enumeration', '2025 年页面不可达'), 'known_gap');
  const bodyA = dim(assessmentA, 'body');
  assert.equal(bodyA.total, null);
  assert.equal(bodyA.percent, null);
  assert.equal(bodyA.state, 'unknown_denominator');
  assert.equal(bodyA.addressed, 2);
  assert.equal(bodyA.notApplicable, 1);
  assert.ok(bodyA.notApplicableReasons.some((line) => line.includes('out_of_window')));
  // Unknown publication date never silently becomes out-of-window.
  assert.ok(assessmentA.evaluation.claimBoundaries.some((line) => line.includes('发布日期未知')));

  // Case B: true endpoint completion with zero items; still no fake percentage.
  const caseB = newCase(store, 'synthetic empty endpoint case');
  const accountB = seedResearchAccount(store, caseB, 'empty-account');
  const frozenB = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: caseB.caseId,
    expectedScopeVersion: currentVersion(store, caseB.caseId),
    spec: specFixture(),
    reason: 'synthetic zero-item fixture'
  });
  record(
    store,
    caseB.caseId,
    frozenB.scopeSpecId,
    receipt('enumerate_history', 'no_match', { kind: 'account_history', accountId: accountB.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  const assessmentB = assess(store, caseB.caseId, frozenB.scopeSpecId);
  const historyB = dim(assessmentB, 'history_enumeration');
  assert.equal(historyB.state, 'complete');
  assert.equal(historyB.unresolved, 0);
  const bodyB = dim(assessmentB, 'body');
  assert.equal(bodyB.state, 'complete');
  assert.equal(bodyB.total, 0);
  assert.equal(bodyB.percent, null);
  assert.notEqual(bodyB.percent, 100);
  assert.ok(
    assessmentB.evaluation.claimBoundaries.some((line) => line.includes('endpoint-accessible range')),
    'endpoint exhaustion may only claim the endpoint-accessible range'
  );
  // Dimensions stay distinct: no aggregate percentage exists anywhere.
  assert.equal('percent' in assessmentB.evaluation, false);
});

test('source, evidence and identity dependency changes invalidate the current assessment without personRevision', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const account = seedResearchAccount(store, record_, 'dependency-account');
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: specFixture(),
    reason: 'synthetic dependency fixture'
  });
  const caseCtx = () => ctx(record_, account.accountId, currentVersion(store, record_.caseId));
  const post = store.cases.recordSourceRevision(caseCtx(), sourceDraft({ originalUrl: 'https://fixture.test/a/dep-post' }));
  const evidence = store.cases.addEvidence(caseCtx(), {
    sourceId: post.sourceId,
    sourceRevision: post.sourceRevision,
    role: 'factual_support',
    quote: '合成支持片段',
    locator: 'paragraph 1',
    provenance: PROVENANCE
  });
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '有合成证据支持',
    refs: { ...emptyRefs(), evidenceIds: [evidence.evidenceId] }
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-change' }, {
    explanation: '有合成证据支持',
    refs: { ...emptyRefs(), evidenceIds: [evidence.evidenceId] }
  }));

  const a1 = assess(store, record_.caseId, frozen.scopeSpecId);
  assert.equal(store.completion.getCompletionAssessment(OWNER, record_.caseId, a1.assessmentId)?.currentValidity, 'valid');
  const a1Input = JSON.parse(JSON.stringify(a1.input)) as typeof a1.input;
  const a1Evaluation = JSON.parse(JSON.stringify(a1.evaluation)) as typeof a1.evaluation;

  // Evidence INSERTION changes evidenceRevision even though personRevision does not move.
  const personRevisionBefore = store.cases.getCase(OWNER, record_.caseId)?.personRevision;
  const evidence2 = store.cases.addEvidence(caseCtx(), {
    sourceId: post.sourceId,
    sourceRevision: post.sourceRevision,
    role: 'factual_support',
    quote: '新增合成支持片段',
    locator: 'paragraph 2',
    provenance: PROVENANCE
  });
  assert.equal(store.cases.getCase(OWNER, record_.caseId)?.personRevision, personRevisionBefore);
  const view1 = store.completion.getCompletionAssessment(OWNER, record_.caseId, a1.assessmentId);
  assert.ok(view1);
  assert.equal(view1.currentValidity, 'review');
  assert.ok(view1.staleReasons.includes('evidence_changed'));
  // Historical replay stays possible from the stored input.
  const replay1 = store.completion.replayCompletionAssessment(OWNER, record_.caseId, a1.assessmentId);
  assert.equal(replay1.verdictMatches, true);
  assert.equal(replay1.inputHashMatches, true);
  assert.deepEqual(a1.input, a1Input);
  assert.deepEqual(a1.evaluation, a1Evaluation);

  // Withdrawal of a support dependency invalidates the new current assessment.
  const a2 = assess(store, record_.caseId, frozen.scopeSpecId);
  store.cases.revokeEvidence(caseCtx(), evidence.evidenceId);
  const view2 = store.completion.getCompletionAssessment(OWNER, record_.caseId, a2.assessmentId);
  assert.ok(view2);
  assert.equal(view2.currentValidity, 'review');
  assert.ok(view2.staleReasons.includes('evidence_changed'));
  assert.equal(store.completion.replayCompletionAssessment(OWNER, record_.caseId, a2.assessmentId).verdictMatches, true);

  // An identity-support STATE patch (no personRevision bump, no scope bump) also invalidates.
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '撤回后改用新证据',
    refs: { ...emptyRefs(), evidenceIds: [evidence2.evidenceId] }
  }));
  record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-change' }, {
    explanation: '撤回后改用新证据',
    refs: { ...emptyRefs(), evidenceIds: [evidence2.evidenceId] }
  }));
  const a3 = assess(store, record_.caseId, frozen.scopeSpecId);
  const personRevision3 = store.cases.getCase(OWNER, record_.caseId)?.personRevision;
  const scope3 = currentVersion(store, record_.caseId);
  store.cases.updateAccountFacets(ctx(record_, account.accountId, scope3), {
    identitySupport: {
      state: 'disputed',
      evidenceIds: [],
      counterevidenceIds: [],
      policyVersion: 'identity-policy/v1',
      note: 'synthetic identity dispute'
    }
  });
  assert.equal(store.cases.getCase(OWNER, record_.caseId)?.personRevision, personRevision3, 'personRevision must not be the digest alias');
  assert.equal(currentVersion(store, record_.caseId), scope3);
  const view3 = store.completion.getCompletionAssessment(OWNER, record_.caseId, a3.assessmentId);
  assert.ok(view3);
  assert.equal(view3.currentValidity, 'review');
  assert.ok(view3.staleReasons.includes('evidence_changed'));

  // A new source revision (revision + contentHash) invalidates too.
  const a4 = assess(store, record_.caseId, frozen.scopeSpecId);
  store.cases.recordSourceRevision(caseCtx(), sourceDraft({ sourceId: post.sourceId, contentHash: 'b'.repeat(64) }));
  const view4 = store.completion.getCompletionAssessment(OWNER, record_.caseId, a4.assessmentId);
  assert.ok(view4);
  assert.equal(view4.currentValidity, 'review');
  assert.ok(view4.staleReasons.includes('evidence_changed'));
});

test('coverage pins bind exact itemId+revision+locator across accounts, posts and revisions', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const accountA = seedResearchAccount(store, record_, 'coverage-a');
  const accountB = seedResearchAccount(store, record_, 'coverage-b');
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: specFixture(),
    reason: 'synthetic coverage fixture'
  });
  const ctxA = () => ctx(record_, accountA.accountId, currentVersion(store, record_.caseId));
  const ctxB = () => ctx(record_, accountB.accountId, currentVersion(store, record_.caseId));
  const a1 = store.cases.recordSourceRevision(ctxA(), sourceDraft({ originalUrl: 'https://fixture.test/a/post-1' }));
  const a1r2 = store.cases.recordSourceRevision(ctxA(), sourceDraft({ sourceId: a1.sourceId, contentHash: 'b'.repeat(64) }));
  const a2 = store.cases.recordSourceRevision(ctxA(), sourceDraft({ originalUrl: 'https://fixture.test/a/post-2' }));
  const b1 = store.cases.recordSourceRevision(ctxB(), sourceDraft({ originalUrl: 'https://fixture.test/b/post-1' }));
  const work = { kind: 'question_matrix' as const, slot: 'work' as const };
  const locator = (accountId: string, sourceId: string, sourceRevision: number) => ({ accountId, sourceId, sourceRevision });
  const covA1 = store.cases.recordItemCoverage(ctxA(), {
    locator: locator(accountA.accountId, a1.sourceId, 1),
    taskRef: work,
    status: 'unseen',
    evidenceIds: [],
    counterevidenceIds: [],
    note: 'A post 1'
  });
  // Second revision of the same coverage item (immutable history).
  store.cases.recordItemCoverage(ctxA(), {
    locator: locator(accountA.accountId, a1.sourceId, 1),
    taskRef: work,
    status: 'evidence_found',
    evidenceIds: [],
    counterevidenceIds: [],
    note: 'A post 1 updated'
  });
  const covA2 = store.cases.recordItemCoverage(ctxA(), {
    locator: locator(accountA.accountId, a2.sourceId, 1),
    taskRef: work,
    status: 'unseen',
    evidenceIds: [],
    counterevidenceIds: [],
    note: 'A post 2'
  });
  const covB1 = store.cases.recordItemCoverage(ctxB(), {
    locator: locator(accountB.accountId, b1.sourceId, 1),
    taskRef: work,
    status: 'unseen',
    evidenceIds: [],
    counterevidenceIds: [],
    note: 'B post 1'
  });

  record(
    store,
    record_.caseId,
    frozen.scopeSpecId,
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: accountA.accountId }, {
      items: [
        { sourceId: a1.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: a1.sourceId, sourceRevision: 2, hasMedia: 'none' },
        { sourceId: a2.sourceId, sourceRevision: 1, hasMedia: 'none' }
      ],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  record(
    store,
    record_.caseId,
    frozen.scopeSpecId,
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: accountB.accountId }, {
      items: [{ sourceId: b1.sourceId, sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );

  // Valid read pinning an exact HISTORICAL coverage revision.
  record(
    store,
    record_.caseId,
    frozen.scopeSpecId,
    receipt('read_body', 'content_read', {
      kind: 'item_body',
      accountId: accountA.accountId,
      sourceId: a1.sourceId,
      sourceRevision: 1
    }, {
      refs: {
        ...emptyRefs(),
        coverageItems: [
          {
            itemId: covA1.itemId,
            revision: 1,
            locator: locator(accountA.accountId, a1.sourceId, 1)
          }
        ]
      }
    })
  );

  // Unknown coverage revision: whole write rejected.
  assert.throws(
    () =>
      record(
        store,
        record_.caseId,
        frozen.scopeSpecId,
        receipt('read_body', 'content_read', {
          kind: 'item_body',
          accountId: accountA.accountId,
          sourceId: a1.sourceId,
          sourceRevision: 1
        }, {
          refs: {
            ...emptyRefs(),
            coverageItems: [
              { itemId: covA1.itemId, revision: 99, locator: locator(accountA.accountId, a1.sourceId, 1) }
            ]
          }
        })
      ),
    ForeignReferenceError
  );
  // Locator mismatch on a known revision: rejected.
  assert.throws(
    () =>
      record(
        store,
        record_.caseId,
        frozen.scopeSpecId,
        receipt('read_body', 'content_read', {
          kind: 'item_body',
          accountId: accountA.accountId,
          sourceId: a1.sourceId,
          sourceRevision: 1
        }, {
          refs: {
            ...emptyRefs(),
            coverageItems: [
              { itemId: covA1.itemId, revision: 1, locator: locator(accountA.accountId, a1.sourceId, 2) }
            ]
          }
        })
      ),
    ForeignReferenceError
  );
  // Foreign coverage item from another case: rejected.
  const foreignCase = newCase(store, 'foreign coverage case');
  const foreignAccount = store.cases.addAccount(ctx(foreignCase, 'ignored'), accountDraft({ handle: 'foreign' }));
  const foreignSource = store.cases.recordSourceRevision(
    ctx(foreignCase, foreignAccount.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/f/post' })
  );
  const foreignCoverage = store.cases.recordItemCoverage(ctx(foreignCase, foreignAccount.accountId), {
    locator: locator(foreignAccount.accountId, foreignSource.sourceId, 1),
    taskRef: work,
    status: 'unseen',
    evidenceIds: [],
    counterevidenceIds: [],
    note: 'foreign'
  });
  assert.throws(
    () =>
      record(
        store,
        record_.caseId,
        frozen.scopeSpecId,
        receipt('read_body', 'content_read', {
          kind: 'item_body',
          accountId: accountA.accountId,
          sourceId: a1.sourceId,
          sourceRevision: 1
        }, {
          refs: {
            ...emptyRefs(),
            coverageItems: [
              {
                itemId: foreignCoverage.itemId,
                revision: 1,
                locator: locator(foreignAccount.accountId, foreignSource.sourceId, 1)
              }
            ]
          }
        })
      ),
    ForeignReferenceError
  );
  // Cross-account borrowing on an account-scoped obligation: rejected.
  assert.throws(
    () =>
      record(
        store,
        record_.caseId,
        frozen.scopeSpecId,
        receipt('read_body', 'content_read', {
          kind: 'item_body',
          accountId: accountA.accountId,
          sourceId: a2.sourceId,
          sourceRevision: 1
        }, {
          refs: {
            ...emptyRefs(),
            coverageItems: [
              { itemId: covB1.itemId, revision: 1, locator: locator(accountB.accountId, b1.sourceId, 1) }
            ]
          }
        })
      ),
    ForeignReferenceError
  );
  // Obligations never borrow completion across accounts/posts/revisions.
  const assessment = assess(store, record_.caseId, frozen.scopeSpecId);
  const body = dim(assessment, 'body');
  assert.equal(body.addressed, 1);
  assert.equal(body.unresolved, 3);
  const unresolvedKeys = body.unresolvedItems.map((item) => item.obligationKey);
  const bodyKey = (accountId: string, sourceId: string, sourceRevision: number) =>
    obligationKey({ kind: 'item_body', accountId, sourceId, sourceRevision });
  assert.deepEqual(unresolvedKeys.sort(), [
    bodyKey(accountA.accountId, a1.sourceId, 2),
    bodyKey(accountA.accountId, a2.sourceId, 1),
    bodyKey(accountB.accountId, b1.sourceId, 1)
  ].sort());
  assert.ok(!unresolvedKeys.includes(bodyKey(accountA.accountId, a1.sourceId, 1)), 'the read revision must not leak to other revisions');
  // The pinned coverage record is the exact itemId + revision + locator.
  assert.equal(assessment.input.coverage.length, 1);
  const pin = assessment.input.coverage[0];
  assert.ok(pin);
  assert.equal(pin.itemId, covA1.itemId);
  assert.equal(pin.revision, 1);
  assert.deepEqual(pin.locator, locator(accountA.accountId, a1.sourceId, 1));
  assert.equal(pin.status, 'unseen');
  assert.deepEqual(assessment.input.coverage.map((entry) => entry.itemId), [covA1.itemId]);
  void covA2;
});

test('same persisted input replays deterministically across reopen; failed/cancelled/needs_input states survive', () => {
  const dir = tempDir('get60-replay-');
  const dbPath = path.join(dir, 'completion.db');
  let db = openDatabase(dbPath);
  applyCoreSchema(db);
  let store = new Store(db);
  try {
    const record_ = newCase(store);
    const account = seedResearchAccount(store, record_, 'replay-account');
    const frozen = store.completion.freezeCompletionScope({
      ownerId: OWNER,
      caseId: record_.caseId,
      expectedScopeVersion: currentVersion(store, record_.caseId),
      spec: specFixture(),
      reason: 'synthetic replay fixture'
    });
    const caseCtx = () => ctx(record_, account.accountId, currentVersion(store, record_.caseId));
    const post = store.cases.recordSourceRevision(caseCtx(), sourceDraft({ originalUrl: 'https://fixture.test/a/replay-post' }));
    record(
      store,
      record_.caseId,
      frozen.scopeSpecId,
      receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: account.accountId }, {
        items: [{ sourceId: post.sourceId, sourceRevision: 1, hasMedia: 'present' }],
        nextCursor: null,
        knownGaps: [],
        stopReason: 'endpoint_exhausted'
      })
    );
    record(
      store,
      record_.caseId,
      frozen.scopeSpecId,
      receipt('read_body', 'content_read', {
        kind: 'item_body',
        accountId: account.accountId,
        sourceId: post.sourceId,
        sourceRevision: 1
      })
    );
    record(
      store,
      record_.caseId,
      frozen.scopeSpecId,
      receipt('read_comments', 'unavailable', {
        kind: 'item_comments',
        accountId: account.accountId,
        sourceId: post.sourceId,
        sourceRevision: 1
      }, { attemptState: 'failed', stopReason: 'unavailable_content' })
    );
    record(
      store,
      record_.caseId,
      frozen.scopeSpecId,
      receipt('read_media', 'unavailable', {
        kind: 'item_media',
        accountId: account.accountId,
        sourceId: post.sourceId,
        sourceRevision: 1
      }, { attemptState: 'cancelled', stopReason: 'operator_stop' })
    );
    record(store, record_.caseId, frozen.scopeSpecId, receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
      explanation: '部分材料未读取，结论暂缓',
      remainingUnknown: '评论与媒体未读'
    }));
    record(store, record_.caseId, frozen.scopeSpecId, receipt('discover_platform', 'needs_input', {
      kind: 'platform_discovery',
      platformId: 'x'
    }, { attemptState: 'needs_input' }));

    const first = assess(store, record_.caseId, frozen.scopeSpecId);
    const firstInput = JSON.parse(JSON.stringify(first.input)) as typeof first.input;
    const firstEvaluation = JSON.parse(JSON.stringify(first.evaluation)) as typeof first.evaluation;

    db.close();
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    store = new Store(db);

    // The stored input and original verdict survive the reopen unchanged.
    const view = store.completion.getCompletionAssessment(OWNER, record_.caseId, first.assessmentId);
    assert.ok(view);
    assert.deepEqual(view.input, firstInput);
    assert.deepEqual(view.evaluation, firstEvaluation);
    assert.equal(view.currentValidity, 'valid');

    // Deterministic same-input replay: identical semantics and digests.
    const replay = store.completion.replayCompletionAssessment(OWNER, record_.caseId, first.assessmentId);
    assert.equal(replay.verdictMatches, true);
    assert.equal(replay.inputHashMatches, true);
    assert.deepEqual(replay.replayed, firstEvaluation);
    assert.deepEqual(replay.assessment.evaluation, firstEvaluation);

    // Re-assessing unchanged persisted state yields the same digests and verdict.
    const second = assess(store, record_.caseId, frozen.scopeSpecId);
    assert.deepEqual(second.evaluation, firstEvaluation);
    assert.equal(second.inputHash, first.inputHash);
    assert.equal(second.evidenceRevision, first.evidenceRevision);
    assert.notEqual(second.assessmentId, first.assessmentId);

    // failed / cancelled / needs_input are preserved, never erased.
    const states = second.evaluation.preservedAttempts.map((entry) => entry.attemptState).sort();
    assert.deepEqual(states, ['cancelled', 'failed', 'needs_input']);
    assert.ok(second.evaluation.preservedAttempts.some((entry) => entry.stopReason === 'operator_stop'));
    assert.ok(second.evaluation.claimBoundaries.some((line) => line.includes('needs_input')));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Review repair batch: supersession + dependency validity            */
/* ------------------------------------------------------------------ */

test('withdrawn dependencies never re-establish fresh completion; a valid alternative restores it', (t) => {
  // Sole supporting evidence revocation.
  const x = setupComplete(t);
  const before = x.assess();
  assert.equal(before.evaluation.verdict, 'complete');
  const frozenInput = JSON.parse(JSON.stringify(before.input)) as typeof before.input;
  const frozenEvaluation = JSON.parse(JSON.stringify(before.evaluation)) as typeof before.evaluation;
  x.store.cases.revokeEvidence(
    ctx(x.record, x.account.accountId, currentVersion(x.store, x.record.caseId)),
    x.evidence.evidenceId
  );
  const after = x.assess();
  assert.equal(after.evaluation.verdict, 'partial');
  assert.equal(reasonFor(after, 'questions', 'q-work'), 'dependency_withdrawn');
  assert.equal(reasonFor(after, 'questions', 'q-change'), 'dependency_withdrawn');
  // The old assessment keeps its original input/verdict and stays replayable.
  const oldView = x.store.completion.getCompletionAssessment(OWNER, x.record.caseId, before.assessmentId);
  assert.ok(oldView);
  assert.deepEqual(oldView.input, frozenInput);
  assert.deepEqual(oldView.evaluation, frozenEvaluation);
  assert.equal(oldView.currentValidity, 'review');
  const replay = x.store.completion.replayCompletionAssessment(OWNER, x.record.caseId, before.assessmentId);
  assert.equal(replay.verdictMatches, true);
  assert.equal(replay.inputHashMatches, true);
  // An independent valid alternative restores completion.
  const fresh = x.store.cases.addEvidence(
    ctx(x.record, x.account.accountId, currentVersion(x.store, x.record.caseId)),
    {
      sourceId: x.source.sourceId,
      sourceRevision: 1,
      role: 'factual_support',
      quote: '独立替代证据',
      locator: 'paragraph 3',
      provenance: PROVENANCE
    }
  );
  x.answerSet([fresh.evidenceId]);
  assert.equal(x.assess().evaluation.verdict, 'complete');

  // Counterevidence revocation breaks the conflicting answer too.
  const y = setupComplete(t, { counterEvidence: true });
  assert.equal(y.assess().evaluation.verdict, 'complete');
  y.store.cases.revokeEvidence(
    ctx(y.record, y.account.accountId, currentVersion(y.store, y.record.caseId)),
    y.counter.evidenceId
  );
  const yAfter = y.assess();
  assert.equal(yAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(yAfter, 'questions', 'q-change'), 'dependency_withdrawn');
  assert.equal(reasonFor(yAfter, 'questions', 'q-work'), undefined);

  // Indirect dependency through a pinned coverage revision.
  const z = setupComplete(t);
  const covLocator = { accountId: z.account.accountId, sourceId: z.source.sourceId, sourceRevision: 1 };
  const coverageItem = z.store.cases.recordItemCoverage(
    ctx(z.record, z.account.accountId, currentVersion(z.store, z.record.caseId)),
    {
      locator: covLocator,
      taskRef: { kind: 'question_matrix', slot: 'work' },
      status: 'evidence_found',
      evidenceIds: [z.evidence.evidenceId],
      counterevidenceIds: [],
      note: 'synthetic coverage dependency'
    }
  );
  const zRead = z.rec(
    receipt('read_comments', 'comments_read', {
      kind: 'item_comments',
      accountId: z.account.accountId,
      sourceId: z.source.sourceId,
      sourceRevision: 1
    })
  );
  z.rec(
    receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-work' }, {
      explanation: '已读取覆盖记录与评论，剩余未知',
      remainingUnknown: '剩余未知保留',
      refs: {
        ...emptyRefs(),
        sourceRevisions: [{ sourceId: z.source.sourceId, sourceRevision: 1 }],
        coverageItems: [{ itemId: coverageItem.itemId, revision: 1, locator: covLocator }],
        observationIds: [zRead.observationId]
      }
    })
  );
  assert.equal(z.assess().evaluation.verdict, 'complete');
  z.store.cases.revokeEvidence(
    ctx(z.record, z.account.accountId, currentVersion(z.store, z.record.caseId)),
    z.evidence.evidenceId
  );
  const zAfter = z.assess();
  assert.equal(zAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(zAfter, 'questions', 'q-work'), 'dependency_withdrawn');

  // Indirect dependency through a predecessor observation's references.
  const w = setupComplete(t);
  const predecessor = w.rec(
    receipt('read_body', 'content_read', {
      kind: 'item_body',
      accountId: w.account.accountId,
      sourceId: w.source.sourceId,
      sourceRevision: 1
    }, { refs: { ...emptyRefs(), evidenceIds: [w.evidence.evidenceId] } })
  );
  w.rec(
    receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-work' }, {
      explanation: '基于前置阅读与证据，仍有剩余未知',
      remainingUnknown: '剩余未知保留',
      refs: {
        ...emptyRefs(),
        sourceRevisions: [{ sourceId: w.source.sourceId, sourceRevision: 1 }],
        observationIds: [predecessor.observationId]
      }
    })
  );
  assert.equal(w.assess().evaluation.verdict, 'complete');
  w.store.cases.revokeEvidence(
    ctx(w.record, w.account.accountId, currentVersion(w.store, w.record.caseId)),
    w.evidence.evidenceId
  );
  const wAfter = w.assess();
  assert.equal(wAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(wAfter, 'questions', 'q-work'), 'dependency_withdrawn');
});

test('failed/cancelled/needs_input answers and blocking stop reasons never satisfy questions', (t) => {
  for (const [state, reason] of [
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['needs_input', 'needs_input']
  ] as const) {
    const x = setupComplete(t);
    x.rec(
      receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
        attemptState: state,
        explanation: '迟到的失败尝试，带证据也不算完成',
        refs: { ...emptyRefs(), evidenceIds: [x.evidence.evidenceId] }
      })
    );
    const a = x.assess();
    assert.equal(a.evaluation.verdict, 'partial', `${state} answer must not complete`);
    assert.equal(reasonFor(a, 'questions', 'q-work'), reason);
    assert.ok(a.evaluation.preservedAttempts.some((entry) => entry.attemptState === state && entry.action === 'answer_question'));
    // A later valid success resolves the obligation; history is not poisoned.
    x.rec(
      receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
        explanation: '后续有效回答',
        refs: { ...emptyRefs(), evidenceIds: [x.evidence.evidenceId] }
      })
    );
    assert.equal(x.assess().evaluation.verdict, 'complete', `${state} must be recoverable`);
  }

  // A blocking stop reason cannot be promoted to completion.
  const y = setupComplete(t);
  y.rec(
    receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
      stopReason: 'budget_exhausted',
      explanation: '预算耗尽前写下的答案',
      refs: { ...emptyRefs(), evidenceIds: [y.evidence.evidenceId] }
    })
  );
  const yAfter = y.assess();
  assert.equal(yAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(yAfter, 'questions', 'q-work'), 'budget_exhausted');
});

test('ordered supersession: later blockers reopen state and later exhaustion closes it', (t) => {
  // Closed -> open: exhaustion followed by a new cursor/gap becomes incomplete.
  const x = setupComplete(t);
  x.rec(
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: x.account.accountId }, {
      items: [],
      nextCursor: 'later-page',
      knownGaps: ['new gap'],
      stopReason: 'cursor_open'
    })
  );
  const xAfter = x.assess();
  assert.equal(xAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(xAfter, 'history_enumeration', 'nextCursor'), 'cursor_open');
  const xBody = dim(xAfter, 'body');
  assert.equal(xBody.total, null);
  assert.equal(xBody.state, 'unknown_denominator');
  assert.equal(xBody.addressed, 1, 'accumulated items survive an empty later page');

  // Open -> closed: a later final exhaustion completes and keeps earlier items.
  const y = setupComplete(t, { enumerationCursor: 'page-2' });
  const yOpen = y.assess();
  assert.equal(reasonFor(yOpen, 'history_enumeration', 'nextCursor'), 'cursor_open');
  assert.equal(dim(yOpen, 'body').state, 'unknown_denominator');
  y.rec(
    receipt('enumerate_history', 'no_match', { kind: 'account_history', accountId: y.account.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  const yAfter = y.assess();
  assert.equal(yAfter.evaluation.verdict, 'complete');
  assert.equal(dim(yAfter, 'history_enumeration').state, 'complete');
  assert.equal(dim(yAfter, 'body').total, 1);
  assert.equal(dim(yAfter, 'body').state, 'complete');

  // A historical discovery success never hides a newer actual blocker.
  const z = setupComplete(t);
  z.rec(
    receipt('discover_platform', 'inaccessible', { kind: 'platform_discovery', platformId: 'synthetic' }, {
      stopReason: 'permission_denied'
    })
  );
  const zAfter = z.assess();
  assert.equal(zAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(zAfter, 'platform_discovery', 'synthetic'), 'permission_denied');
  z.rec(receipt('discover_platform', 'checked_no_match', { kind: 'platform_discovery', platformId: 'synthetic' }));
  assert.equal(z.assess().evaluation.verdict, 'complete');
});

test('enumerated items must be persisted case/account sources or the whole receipt rolls back', (t) => {
  const x = setupComplete(t);
  const before = x.store.completion.listCompletionObservations(OWNER, x.record.caseId).length;
  const enumerate = (accountId: string, items: Array<{ sourceId: string; sourceRevision: number; hasMedia: 'none' | 'present' | 'unknown' }>) =>
    x.rec(
      receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId }, {
        items,
        nextCursor: null,
        knownGaps: [],
        stopReason: 'endpoint_exhausted'
      })
    );
  // Nonexistent source revision.
  assert.throws(
    () => enumerate(x.account.accountId, [{ sourceId: 'not-a-persisted-source', sourceRevision: 999, hasMedia: 'none' }]),
    ForeignReferenceError
  );
  // Valid first item followed by an invalid item: whole receipt rejected.
  assert.throws(
    () =>
      enumerate(x.account.accountId, [
        { sourceId: x.source.sourceId, sourceRevision: 1, hasMedia: 'none' },
        { sourceId: 'not-a-persisted-source', sourceRevision: 999, hasMedia: 'none' }
      ]),
    ForeignReferenceError
  );
  // Wrong revision of a real source.
  assert.throws(
    () => enumerate(x.account.accountId, [{ sourceId: x.source.sourceId, sourceRevision: 2, hasMedia: 'none' }]),
    ForeignReferenceError
  );
  // Another account's source listed under this account's enumeration.
  const otherAccount = x.store.cases.addAccount(
    {
      ownerId: OWNER,
      caseId: x.record.caseId,
      accountId: 'ignored',
      expectedScopeVersion: currentVersion(x.store, x.record.caseId)
    },
    accountDraft({ handle: 'other-account' })
  );
  const otherSource = x.store.cases.recordSourceRevision(
    ctx(x.record, otherAccount.accountId, currentVersion(x.store, x.record.caseId)),
    sourceDraft({ originalUrl: 'https://fixture.test/other/post' })
  );
  assert.throws(
    () => enumerate(x.account.accountId, [{ sourceId: otherSource.sourceId, sourceRevision: 1, hasMedia: 'none' }]),
    ForeignReferenceError
  );
  // A foreign case's source.
  const foreignCase = newCase(x.store, 'foreign enumeration case');
  const foreignAccount = x.store.cases.addAccount(
    ctx(foreignCase, 'ignored'),
    accountDraft({ handle: 'foreign' })
  );
  const foreignSource = x.store.cases.recordSourceRevision(
    ctx(foreignCase, foreignAccount.accountId),
    sourceDraft({ originalUrl: 'https://fixture.test/foreign/post' })
  );
  assert.throws(
    () => enumerate(x.account.accountId, [{ sourceId: foreignSource.sourceId, sourceRevision: 1, hasMedia: 'none' }]),
    ForeignReferenceError
  );
  // No partial receipt writes: the observation log is unchanged.
  assert.equal(x.store.completion.listCompletionObservations(OWNER, x.record.caseId).length, before);
});

test('missing/deleted/hidden parent chains never complete on depth alone; a clean later read recovers', (t) => {
  for (const state of ['missing', 'deleted', 'hidden'] as const) {
    const x = setupComplete(t);
    const ref = {
      kind: 'thread_branch' as const,
      accountId: x.account.accountId,
      sourceId: x.source.sourceId,
      sourceRevision: 1,
      branchKey: 'branch'
    };
    x.rec(
      receipt('select_branch', 'branch_selected', ref, {
        parentChain: [{ commentKey: 'parent', depth: 1, state }]
      })
    );
    x.rec(
      receipt('read_thread', 'thread_read', ref, {
        depthReached: 4,
        blockers: [{ commentKey: 'parent', state }]
      })
    );
    const a = x.assess();
    assert.equal(a.evaluation.verdict, 'partial', `${state} parent must not complete on depth`);
    const thread = dim(a, 'thread');
    assert.equal(thread.unresolved, 1);
    assert.equal(thread.unresolvedItems[0]?.reason, 'unavailable_content');
    assert.ok(thread.limitations.some((line) => line.includes(`${state} parent`)));
    // Recovery: a later clean read to the frozen depth releases the gap.
    x.rec(receipt('read_thread', 'thread_read', ref, { depthReached: 4, blockers: [] }));
    const b = x.assess();
    assert.equal(b.evaluation.verdict, 'complete', `${state} gap must be recoverable`);
    const recovered = dim(b, 'thread');
    assert.equal(recovered.addressed, 1);
    assert.ok(
      recovered.limitations.some((line) => line.includes(`${state} parent`)),
      'historical limitations stay visible after recovery'
    );
  }

  // A gap revealed by a later selection is not hidden by an earlier clean read.
  const y = setupComplete(t);
  const ref = {
    kind: 'thread_branch' as const,
    accountId: y.account.accountId,
    sourceId: y.source.sourceId,
    sourceRevision: 1,
    branchKey: 'late-gap'
  };
  y.rec(receipt('read_thread', 'thread_read', ref, { depthReached: 4, blockers: [] }));
  y.rec(
    receipt('select_branch', 'branch_selected', ref, {
      parentChain: [{ commentKey: 'late', depth: 1, state: 'missing' }]
    })
  );
  const c = y.assess();
  assert.equal(c.evaluation.verdict, 'partial');
  assert.equal(dim(c, 'thread').unresolvedItems[0]?.reason, 'unavailable_content');
});

test('investigated unknown requires the frozen eligible-investigation protocol', (t) => {
  const unknownAnswer = (x: ReturnType<typeof setupComplete>, observationId: string, extra: Record<string, unknown> = {}) =>
    x.rec(
      receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-work' }, {
        explanation: '声称已充分调查',
        remainingUnknown: '剩余未知保留',
        refs: {
          ...emptyRefs(),
          sourceRevisions: [{ sourceId: x.source.sourceId, sourceRevision: 1 }],
          observationIds: [observationId],
          ...extra
        }
      })
    );

  // A succeeded transport receipt whose outcome is unsupported is not an investigation.
  const x = setupComplete(t);
  const unsupported = x.rec(
    receipt('discover_platform', 'unsupported', { kind: 'platform_discovery', platformId: 'synthetic' }, {
      stopReason: 'unsupported',
      accessBoundary: 'unavailable'
    })
  );
  unknownAnswer(x, unsupported.observationId);
  const xAfter = x.assess();
  assert.equal(xAfter.evaluation.verdict, 'partial');
  assert.equal(reasonFor(xAfter, 'questions', 'q-work'), 'no_conforming_investigation');
  assert.equal(dim(xAfter, 'questions').investigatedUnknown, 0);

  // A blocking stop reason disqualifies the predecessor.
  const y = setupComplete(t);
  const budgeted = y.rec(
    receipt('read_body', 'content_read', {
      kind: 'item_body',
      accountId: y.account.accountId,
      sourceId: y.source.sourceId,
      sourceRevision: 1
    }, { stopReason: 'budget_exhausted' })
  );
  unknownAnswer(y, budgeted.observationId);
  assert.equal(reasonFor(y.assess(), 'questions', 'q-work'), 'no_conforming_investigation');

  // A bounded attempt (access boundary) is blocked work, not investigation.
  const z = setupComplete(t);
  const bounded = z.rec(
    receipt('read_body', 'content_read', {
      kind: 'item_body',
      accountId: z.account.accountId,
      sourceId: z.source.sourceId,
      sourceRevision: 1
    }, { accessBoundary: '仅读到摘要' })
  );
  unknownAnswer(z, bounded.observationId);
  assert.equal(reasonFor(z.assess(), 'questions', 'q-work'), 'no_conforming_investigation');

  // Notes are never investigations.
  const w = setupComplete(t);
  const note = w.rec(receipt('note', 'note_only', { kind: 'note' }, { note: '模型说明' }));
  unknownAnswer(w, note.observationId);
  assert.equal(reasonFor(w.assess(), 'questions', 'q-work'), 'no_conforming_investigation');

  // An eligible predecessor without concrete dependencies is not enough.
  const v = setupComplete(t);
  const bare = v.rec(
    receipt('read_comments', 'comments_read', {
      kind: 'item_comments',
      accountId: v.account.accountId,
      sourceId: v.source.sourceId,
      sourceRevision: 1
    })
  );
  v.rec(
    receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-work' }, {
      explanation: '声称已充分调查但无依赖',
      remainingUnknown: '剩余未知保留',
      refs: { ...emptyRefs(), observationIds: [bare.observationId] }
    })
  );
  assert.equal(reasonFor(v.assess(), 'questions', 'q-work'), 'no_conforming_investigation');

  // A real protocol-conforming investigated unknown counts as addressed.
  const u = setupComplete(t);
  const good = u.rec(
    receipt('read_comments', 'comments_read', {
      kind: 'item_comments',
      accountId: u.account.accountId,
      sourceId: u.source.sourceId,
      sourceRevision: 1
    })
  );
  u.rec(
    receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-work' }, {
      explanation: '已调查可访问范围与证据，剩余未知',
      remainingUnknown: '剩余未知保留',
      refs: {
        ...emptyRefs(),
        evidenceIds: [u.evidence.evidenceId],
        observationIds: [good.observationId]
      }
    })
  );
  const uAfter = u.assess();
  assert.equal(uAfter.evaluation.verdict, 'complete');
  assert.equal(dim(uAfter, 'questions').investigatedUnknown, 1);
  assert.equal(uAfter.evaluation.handledUnknowns.length, 1);
});

test('the question-deletion guard follows scope_version under same-millisecond and backwards clocks', (t) => {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  t.mock.timers.enable({ apis: ['Date'], now: 1_750_000_000_000 });
  const record_ = newCase(store);
  const latestSpec = (): CompletionScopeSpec => {
    const list = store.completion.listCompletionScopes(OWNER, record_.caseId);
    const last = list[list.length - 1];
    assert.ok(last);
    return JSON.parse(JSON.stringify(last.spec)) as CompletionScopeSpec;
  };
  const addQuestion = (questionId: string, spec: CompletionScopeSpec): CompletionScopeSpec => {
    spec.questions.push({
      questionId,
      slot: null,
      text: `附加问题 ${questionId}`,
      applicability: 'applicable',
      applicabilityReason: '新增难题'
    });
    return spec;
  };
  const revise = (spec: CompletionScopeSpec, reason: string) =>
    store.completion.reviseCompletionScope({
      ownerId: OWNER,
      caseId: record_.caseId,
      expectedScopeVersion: currentVersion(store, record_.caseId),
      spec,
      reason
    });

  store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: minimalSpec(),
    reason: 'synthetic ordering fixture'
  });
  // Three revisions in the SAME millisecond.
  for (const questionId of ['q-extra-1', 'q-extra-2', 'q-extra-3']) {
    revise(addQuestion(questionId, latestSpec()), `add ${questionId}`);
  }
  const deletionAttempt = (): void => {
    const reduced = latestSpec();
    const newest = reduced.questions[reduced.questions.length - 1];
    assert.ok(newest);
    reduced.questions = reduced.questions.filter((question) => question.questionId !== newest.questionId);
    revise(reduced, `remove ${newest.questionId}`);
  };
  const versionBefore = currentVersion(store, record_.caseId);
  const historyBefore = store.cases.scopeHistory(OWNER, record_.caseId);
  const scopesBefore = store.completion.listCompletionScopes(OWNER, record_.caseId);
  assert.throws(deletionAttempt, CompletionSpecError);
  // Failed deletion rolls back case version, journal and spec together.
  assert.equal(currentVersion(store, record_.caseId), versionBefore);
  assert.deepEqual(store.cases.scopeHistory(OWNER, record_.caseId), historyBefore);
  assert.deepEqual(store.completion.listCompletionScopes(OWNER, record_.caseId), scopesBefore);

  // Backwards clock: newer versions carry OLDER timestamps.
  t.mock.timers.setTime(1_650_000_000_000);
  revise(addQuestion('q-backwards-1', latestSpec()), 'add q-backwards-1');
  t.mock.timers.setTime(1_550_000_000_000);
  revise(addQuestion('q-backwards-2', latestSpec()), 'add q-backwards-2');
  const versionAfter = currentVersion(store, record_.caseId);
  const historyAfter = store.cases.scopeHistory(OWNER, record_.caseId);
  assert.throws(deletionAttempt, CompletionSpecError, 'backwards clock must not bypass the guard');
  assert.equal(currentVersion(store, record_.caseId), versionAfter);
  assert.deepEqual(store.cases.scopeHistory(OWNER, record_.caseId), historyAfter);

  // Listings follow authoritative versions and keep every question.
  const list = store.completion.listCompletionScopes(OWNER, record_.caseId);
  assert.deepEqual(
    list.map((entry) => entry.scopeVersion),
    [1, 2, 3, 4, 5, 6].map((value) => asScopeVersion(value))
  );
  assert.deepEqual(
    list[list.length - 1]?.spec.questions.map((question) => question.questionId),
    ['q-work', 'q-change', 'q-extra-1', 'q-extra-2', 'q-extra-3', 'q-backwards-1', 'q-backwards-2']
  );
  // A valid revise still advances exactly one version.
  const valid = addQuestion('q-extra-4', latestSpec());
  const revised = revise(valid, 'add q-extra-4');
  assert.equal(revised.scopeVersion, asScopeVersion(7));
  assert.equal(store.completion.listCompletionScopes(OWNER, record_.caseId).length, 7);
});

/* ------------------------------------------------------------------ */
/* Repair batch 2: media metadata merge, payload eligibility,         */
/* transitive account boundaries                                      */
/* ------------------------------------------------------------------ */

test('conservative media metadata merge keeps obligations across enumeration pages', (t) => {
  const enumerate = (x: ReturnType<typeof setupComplete>, hasMedia: 'none' | 'present' | 'unknown', attemptState = 'succeeded') =>
    x.rec(
      receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: x.account.accountId }, {
        items: [{ sourceId: x.source.sourceId, sourceRevision: 1, hasMedia }],
        nextCursor: null,
        knownGaps: [],
        stopReason: 'endpoint_exhausted',
        attemptState
      })
    );

  // none -> present: a new media discovery re-opens the obligation...
  const x = setupComplete(t);
  const xObsBefore = x.store.completion.listCompletionObservations(OWNER, x.record.caseId).length;
  enumerate(x, 'present');
  const xAfter = x.assess();
  assert.equal(xAfter.evaluation.verdict, 'partial');
  const xMedia = dim(xAfter, 'media');
  assert.equal(xMedia.total, 1, 'denominator stays honest');
  assert.equal(xMedia.unresolved, 1);
  assert.equal(reasonFor(xAfter, 'media', x.source.sourceId), 'unattempted');
  assert.equal(dim(xAfter, 'body').total, 1, 'accumulated items stay intact');
  assert.equal(
    x.store.completion.listCompletionObservations(OWNER, x.record.caseId).length,
    xObsBefore + 1,
    'prior observations are intact'
  );
  // ...and a real media read satisfies it while the contradiction stays visible.
  x.rec(
    receipt('read_media', 'media_read', {
      kind: 'item_media',
      accountId: x.account.accountId,
      sourceId: x.source.sourceId,
      sourceRevision: 1
    })
  );
  const xRead = x.assess();
  assert.equal(xRead.evaluation.verdict, 'complete', 'real media handling must not be permanently blocked');
  assert.ok(
    dim(xRead, 'media').limitations.some((line) => line.includes('hasMedia 元数据冲突')),
    'the none/present contradiction remains a truthful limitation'
  );

  // none -> unknown: credible metadata reopens applicability.
  const y = setupComplete(t);
  enumerate(y, 'unknown');
  const yAfter = y.assess();
  assert.equal(yAfter.evaluation.verdict, 'partial');
  assert.equal(dim(yAfter, 'media').total, 1);
  assert.equal(reasonFor(yAfter, 'media', y.source.sourceId), 'media_applicability_unknown');

  // unknown -> none: only credible later metadata resolves it.
  const z = setupComplete(t, { enumerationMedia: 'unknown' });
  enumerate(z, 'none');
  const zAfter = z.assess();
  assert.equal(zAfter.evaluation.verdict, 'complete');
  assert.equal(dim(zAfter, 'media').state, 'not_applicable');

  // unknown -> present: discovered media always wins.
  const w = setupComplete(t, { enumerationMedia: 'unknown' });
  enumerate(w, 'present');
  const wAfter = w.assess();
  assert.equal(dim(wAfter, 'media').total, 1);
  assert.equal(reasonFor(wAfter, 'media', w.source.sourceId), 'unattempted');

  // Failed/blocked none can neither hide known present nor clear unknown
  // (a failed page also keeps the enumeration range honestly unfinished, so
  // item denominators stay unknown while the known work remains obligated).
  const v = setupComplete(t, { enumerationMedia: 'present' });
  enumerate(v, 'none', 'failed');
  const vAfter = v.assess();
  const vMedia = dim(vAfter, 'media');
  assert.equal(vMedia.unresolved, 1, 'known present is never hidden by a failed none');
  assert.equal(vMedia.notApplicable, 0);
  assert.equal(reasonFor(vAfter, 'media', v.source.sourceId), 'unattempted');
  const u = setupComplete(t, { enumerationMedia: 'unknown' });
  enumerate(u, 'none', 'cancelled');
  const uAfter = u.assess();
  assert.equal(dim(uAfter, 'media').unresolved, 1, 'known unknown is never cleared by a failed none');
  assert.equal(reasonFor(uAfter, 'media', u.source.sourceId), 'media_applicability_unknown');

  // A later credible unknown reopens a prior none.
  const s = setupComplete(t);
  enumerate(s, 'unknown');
  assert.equal(reasonFor(s.assess(), 'media', s.source.sourceId), 'media_applicability_unknown');
});

test('access-limited enumeration cannot clear unknown media and clean enumeration can recover', (t) => {
  const x = setupComplete(t, { enumerationMedia: 'unknown' });
  const enumerate = (accessBoundary: string | null) => x.rec(
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: x.account.accountId }, {
      items: [{ sourceId: x.source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted',
      accessBoundary
    })
  );
  const boundary = 'permission denied: media could not be inspected';
  enumerate(boundary);
  const blocked = x.assess();
  assert.equal(blocked.evaluation.verdict, 'partial');
  assert.equal(dim(blocked, 'media').notApplicable, 0);
  assert.equal(reasonFor(blocked, 'media', x.source.sourceId), 'media_applicability_unknown');
  assert.equal(dim(blocked, 'media').denominatorKnown, false);
  assert.equal(dim(blocked, 'media').percent, null);
  assert.equal(reasonFor(blocked, 'history_enumeration', x.account.accountId), 'unavailable_content');
  enumerate(null);
  const recovered = x.assess();
  assert.equal(recovered.evaluation.verdict, 'complete');
  assert.equal(dim(recovered, 'media').state, 'not_applicable');
  assert.ok(dim(recovered, 'history_enumeration').limitations.some((line) => line.includes(boundary)));
  assert.ok(x.store.completion.listCompletionObservations(OWNER, x.record.caseId)
    .some((observation) => observation.accessBoundary === boundary));
});

test('investigated unknown requires complete structured action payloads', (t) => {
  const unknownVia = (x: ReturnType<typeof setupComplete>, observationId: string) =>
    x.rec(
      receipt('answer_question', 'investigated_unknown', { kind: 'question', questionId: 'q-work' }, {
        explanation: '声称已充分调查',
        remainingUnknown: '剩余未知保留',
        refs: {
          ...emptyRefs(),
          sourceRevisions: [{ sourceId: x.source.sourceId, sourceRevision: 1 }],
          observationIds: [observationId]
        }
      })
    );

  // Thread payload negatives: omitted stopReason never erases unfinished work.
  for (const [name, payload] of [
    ['short-depth-blocked', { depthReached: 0, blockers: [{ commentKey: 'parent', state: 'missing' as const }] }],
    ['short-depth-clean', { depthReached: 2, blockers: [] }],
    ['full-depth-blocked', { depthReached: 4, blockers: [{ commentKey: 'parent', state: 'missing' as const }] }]
  ] as const) {
    const x = setupComplete(t);
    const dep = x.rec(
      receipt('read_thread', 'thread_read', {
        kind: 'thread_branch',
        accountId: x.account.accountId,
        sourceId: x.source.sourceId,
        sourceRevision: 1,
        branchKey: 'branch'
      }, payload)
    );
    unknownVia(x, dep.observationId);
    const a = x.assess();
    assert.equal(reasonFor(a, 'questions', 'q-work'), 'no_conforming_investigation', name);
    assert.equal(dim(a, 'questions').investigatedUnknown, 0, name);
  }

  // Enumeration payload negatives: cursor/gaps bypass nothing via null stopReason.
  const cursorCase = setupComplete(t);
  const cursorDep = cursorCase.rec(
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: cursorCase.account.accountId }, {
      items: [],
      nextCursor: 'page-2',
      knownGaps: [],
      stopReason: null
    })
  );
  unknownVia(cursorCase, cursorDep.observationId);
  assert.equal(
    reasonFor(cursorCase.assess(), 'questions', 'q-work'),
    'no_conforming_investigation',
    'open cursor is not sufficient investigation'
  );
  const gapCase = setupComplete(t);
  const gapDep = gapCase.rec(
    receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: gapCase.account.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: ['missing pages'],
      stopReason: null
    })
  );
  unknownVia(gapCase, gapDep.observationId);
  assert.equal(reasonFor(gapCase.assess(), 'questions', 'q-work'), 'no_conforming_investigation');

  // Required-check payload negative: the observed label without required entries.
  const checkCase = setupComplete(t);
  const checkDep = checkCase.rec(
    receipt('report_required_check', 'observed', { kind: 'required_check', checkId: 'time' }, {
      observed: [],
      explanation: '未覆盖要求条目'
    })
  );
  unknownVia(checkCase, checkDep.observationId);
  assert.equal(reasonFor(checkCase.assess(), 'questions', 'q-work'), 'no_conforming_investigation');

  // Real clean positives remain allowed.
  const good = setupComplete(t);
  good.rec(
    receipt('select_branch', 'branch_selected', {
      kind: 'thread_branch',
      accountId: good.account.accountId,
      sourceId: good.source.sourceId,
      sourceRevision: 1,
      branchKey: 'branch'
    }, { parentChain: [{ commentKey: 'c1', depth: 1, state: 'present' }] })
  );
  const cleanThread = good.rec(
    receipt('read_thread', 'thread_read', {
      kind: 'thread_branch',
      accountId: good.account.accountId,
      sourceId: good.source.sourceId,
      sourceRevision: 1,
      branchKey: 'branch'
    }, { depthReached: 4, blockers: [] })
  );
  unknownVia(good, cleanThread.observationId);
  const goodAfter = good.assess();
  assert.equal(goodAfter.evaluation.verdict, 'complete');
  assert.equal(dim(goodAfter, 'questions').investigatedUnknown, 1);

  const enumGood = setupComplete(t);
  const enumDep = enumGood.rec(
    receipt('enumerate_history', 'no_match', { kind: 'account_history', accountId: enumGood.account.accountId }, {
      items: [],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    })
  );
  unknownVia(enumGood, enumDep.observationId);
  assert.equal(enumGood.assess().evaluation.verdict, 'complete');

  const checkGood = setupComplete(t);
  const checkDep2 = checkGood.rec(
    receipt('report_required_check', 'observed', { kind: 'required_check', checkId: 'time' }, {
      observed: ['2026'],
      explanation: '按冻结时段统计'
    })
  );
  unknownVia(checkGood, checkDep2.observationId);
  assert.equal(checkGood.assess().evaluation.verdict, 'complete');
});


/* ------------------------------------------------------------------ */
/* Repair batch 2 (R3): account boundaries across transitive chains   */
/* ------------------------------------------------------------------ */

/** Two researched accounts, both in the frozen slice, with own sources. */
function setupTwoAccounts(t: TestContext) {
  const { db, store } = memoryStore();
  t.after(() => db.close());
  const record_ = newCase(store);
  const accountA = seedResearchAccount(store, record_, 'chain-a');
  const accountB = seedResearchAccount(store, record_, 'chain-b');
  const frozen = store.completion.freezeCompletionScope({
    ownerId: OWNER,
    caseId: record_.caseId,
    expectedScopeVersion: currentVersion(store, record_.caseId),
    spec: minimalSpec(),
    reason: 'synthetic chain fixture'
  });
  const rec = (draft: CompletionObservationDraft) => record(store, record_.caseId, frozen.scopeSpecId, draft);
  const mk = (account: ReturnType<typeof seedResearchAccount>, handle: string) => {
    const source = store.cases.recordSourceRevision(
      ctx(record_, account.accountId, currentVersion(store, record_.caseId)),
      sourceDraft({ originalUrl: `https://fixture.test/${handle}/post` })
    );
    const evidence = store.cases.addEvidence(
      ctx(record_, account.accountId, currentVersion(store, record_.caseId)),
      {
        sourceId: source.sourceId,
        sourceRevision: 1,
        role: 'factual_support',
        quote: `${handle} evidence`,
        locator: null,
        provenance: PROVENANCE
      }
    );
    return { account, source, evidence };
  };
  const a = mk(accountA, 'chain-a');
  const b = mk(accountB, 'chain-b');
  for (const side of [a, b]) {
    rec(
      receipt('enumerate_history', 'items_found', { kind: 'account_history', accountId: side.account.accountId }, {
        items: [{ sourceId: side.source.sourceId, sourceRevision: 1, hasMedia: 'none' }],
        nextCursor: null,
        knownGaps: [],
        stopReason: 'endpoint_exhausted'
      })
    );
  }
  const bodyReceipt = (side: typeof a, extra: Record<string, unknown> = {}) =>
    rec(
      receipt('read_body', 'content_read', {
        kind: 'item_body',
        accountId: side.account.accountId,
        sourceId: side.source.sourceId,
        sourceRevision: 1
      }, extra)
    );
  return {
    db,
    store,
    record: record_,
    a,
    b,
    rec,
    bodyReceipt,
    assess: () => assess(store, record_.caseId, frozen.scopeSpecId)
  };
}

test('account boundaries hold through direct and transitive observation chains', (t) => {
  // Direct cross-account evidence is rejected.
  const x = setupTwoAccounts(t);
  assert.throws(
    () => x.bodyReceipt(x.a, { refs: { ...emptyRefs(), evidenceIds: [x.b.evidence.evidenceId] } }),
    ForeignReferenceError
  );

  // One-hop: a case-level note carrying B evidence cannot serve A's body.
  const noteB = x.rec(receipt('note', 'note_only', { kind: 'note' }, {
    refs: { ...emptyRefs(), evidenceIds: [x.b.evidence.evidenceId] }
  }));
  assert.throws(
    () => x.bodyReceipt(x.a, { refs: { ...emptyRefs(), observationIds: [noteB.observationId] } }),
    ForeignReferenceError
  );

  // Multi-hop: intermediate case-level nodes do not erase the inherited account.
  const noteMid = x.rec(receipt('note', 'note_only', { kind: 'note' }, {
    refs: { ...emptyRefs(), observationIds: [noteB.observationId] }
  }));
  assert.throws(
    () => x.bodyReceipt(x.a, { refs: { ...emptyRefs(), observationIds: [noteMid.observationId] } }),
    ForeignReferenceError
  );

  // A directly nested account node of B is rejected for A, not only its evidence fields.
  const bodyB = x.bodyReceipt(x.b, { refs: { ...emptyRefs(), evidenceIds: [x.b.evidence.evidenceId] } });
  assert.throws(
    () => x.bodyReceipt(x.a, { refs: { ...emptyRefs(), observationIds: [bodyB.observationId] } }),
    ForeignReferenceError
  );

  // Same-account chains are valid and establish the obligation.
  const noteA = x.rec(receipt('note', 'note_only', { kind: 'note' }, {
    refs: { ...emptyRefs(), evidenceIds: [x.a.evidence.evidenceId] }
  }));
  x.bodyReceipt(x.a, { refs: { ...emptyRefs(), observationIds: [noteA.observationId] } });
  const sameAccount = x.assess();
  const bodyDim = dim(sameAccount, 'body');
  assert.equal(bodyDim.addressed, 2, 'A body via same-account note chain and B body directly');
  assert.equal(bodyDim.unresolved, 0);
  const rejectedLandings = x.store.completion
    .listCompletionObservations(OWNER, x.record.caseId)
    .filter((observation) => observation.action === 'read_body');
  assert.equal(rejectedLandings.length, 2, 'cross-account chain writes never landed');

  // Real case-level multi-account aggregation is legitimate.
  x.rec(receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '跨账号汇总的真实综合',
    refs: { ...emptyRefs(), evidenceIds: [x.a.evidence.evidenceId, x.b.evidence.evidenceId] }
  }));
  assert.equal(dim(x.assess(), 'questions').addressed, 1);
});

test('the same intermediate node stays restricted for A in both recording orders', (t) => {
  // Order 1: legitimate contexts recorded first, then the restricted attempt.
  const x = setupTwoAccounts(t);
  const noteB = x.rec(receipt('note', 'note_only', { kind: 'note' }, {
    refs: { ...emptyRefs(), evidenceIds: [x.b.evidence.evidenceId] }
  }));
  x.rec(receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '跨账号汇总',
    refs: { ...emptyRefs(), evidenceIds: [x.a.evidence.evidenceId], observationIds: [noteB.observationId] }
  }));
  x.bodyReceipt(x.b, { refs: { ...emptyRefs(), observationIds: [noteB.observationId] } });
  const before = x.store.completion.listCompletionObservations(OWNER, x.record.caseId).length;
  assert.throws(
    () => x.bodyReceipt(x.a, { refs: { ...emptyRefs(), observationIds: [noteB.observationId] } }),
    ForeignReferenceError
  );
  assert.equal(x.store.completion.listCompletionObservations(OWNER, x.record.caseId).length, before);
  const withGap = x.assess();
  assert.equal(dim(withGap, 'questions').addressed, 1, 'case-level use of the shared node is legitimate');
  assert.equal(dim(withGap, 'body').addressed, 1, 'B body use is legitimate');

  // Order 2: the restricted attempt first, then the legitimate contexts.
  const y = setupTwoAccounts(t);
  const noteB2 = y.rec(receipt('note', 'note_only', { kind: 'note' }, {
    refs: { ...emptyRefs(), evidenceIds: [y.b.evidence.evidenceId] }
  }));
  assert.throws(
    () => y.bodyReceipt(y.a, { refs: { ...emptyRefs(), observationIds: [noteB2.observationId] } }),
    ForeignReferenceError
  );
  y.rec(receipt('answer_question', 'supported', { kind: 'question', questionId: 'q-work' }, {
    explanation: '跨账号汇总',
    refs: { ...emptyRefs(), evidenceIds: [y.a.evidence.evidenceId], observationIds: [noteB2.observationId] }
  }));
  y.bodyReceipt(y.b, { refs: { ...emptyRefs(), observationIds: [noteB2.observationId] } });
  const yView = y.assess();
  assert.equal(dim(yView, 'questions').addressed, 1);
  assert.equal(dim(yView, 'body').addressed, 1);
});

/* ---------------- pure evaluator: context-keyed memo matrix ---------------- */

function evalDim(evaluation: CompletionEvaluation, dimension: CompletionDimension): CompletionDimensionReport {
  const found = evaluation.dimensions.find((entry) => entry.dimension === dimension);
  assert.ok(found, `missing dimension ${dimension}`);
  return found;
}

function boundObservation(id: string, draft: CompletionObservationDraft): CompletionObservation {
  return {
    ...draft,
    observationId: id,
    caseId: 'case-crafted',
    scopeSpecId: 'cspec-crafted',
    scopeVersion: asScopeVersion(1),
    createdAt: '2026-01-01T00:00:00.000Z'
  } as CompletionObservation;
}

function craftedSnapshot(
  observations: CompletionObservation[],
  restrictedId: string,
  freeId: string
): CompletionSnapshot {
  const slice = (accountId: string): ScopeAccountSnapshot => ({
    accountId,
    platform: 'synthetic',
    handle: accountId,
    userSelection: { state: 'selected', note: null, recordedAt: null },
    allowedScope: { state: 'public_history', note: null }
  });
  return {
    policyVersion: COMPLETION_POLICY_VERSION,
    scopeSpecId: 'cspec-crafted',
    scopeVersion: asScopeVersion(1),
    spec: minimalSpec(),
    accountSlice: [slice(restrictedId), slice(freeId)],
    observations,
    coverage: [],
    sources: [
      { sourceId: 'src-restricted', sourceRevision: 1, accountId: restrictedId, publishedAt: '2026-03-01', contentHash: 'a'.repeat(64) },
      { sourceId: 'src-free', sourceRevision: 1, accountId: freeId, publishedAt: '2026-03-02', contentHash: 'b'.repeat(64) }
    ],
    evidence: [
      {
        evidenceId: 'ev-restricted',
        accountId: restrictedId,
        sourceId: 'src-restricted',
        sourceRevision: 1,
        role: 'factual_support',
        quoteHash: 'c'.repeat(64),
        revokedAt: null
      },
      {
        evidenceId: 'ev-free',
        accountId: freeId,
        sourceId: 'src-free',
        sourceRevision: 1,
        role: 'factual_support',
        quoteHash: 'd'.repeat(64),
        revokedAt: null
      }
    ],
    identity: []
  };
}

test('evaluation inherits account boundaries with an (observationId, expectedAccount) memo', (t) => {
  void t;
  // The shared case-level note cites the FREE account's evidence. The free
  // body and the case-level question may legitimately use it; the restricted
  // body must not — in either observation order and whichever side fills the
  // memo first (account id ordering controls processing order).
  const build = (restrictedId: string, freeId: string, noteFirst: boolean): CompletionObservation[] => {
    const note = boundObservation('obs-note', receipt('note', 'note_only', { kind: 'note' }, {
      refs: { ...emptyRefs(), evidenceIds: ['ev-free'] }
    }));
    const enumRestricted = boundObservation('obs-enum-r', receipt('enumerate_history', 'items_found', {
      kind: 'account_history',
      accountId: restrictedId
    }, {
      items: [{ sourceId: 'src-restricted', sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    }));
    const enumFree = boundObservation('obs-enum-f', receipt('enumerate_history', 'items_found', {
      kind: 'account_history',
      accountId: freeId
    }, {
      items: [{ sourceId: 'src-free', sourceRevision: 1, hasMedia: 'none' }],
      nextCursor: null,
      knownGaps: [],
      stopReason: 'endpoint_exhausted'
    }));
    const bodyRestricted = boundObservation('obs-body-r', receipt('read_body', 'content_read', {
      kind: 'item_body',
      accountId: restrictedId,
      sourceId: 'src-restricted',
      sourceRevision: 1
    }, { refs: { ...emptyRefs(), observationIds: ['obs-note'] } }));
    const bodyFree = boundObservation('obs-body-f', receipt('read_body', 'content_read', {
      kind: 'item_body',
      accountId: freeId,
      sourceId: 'src-free',
      sourceRevision: 1
    }, { refs: { ...emptyRefs(), observationIds: ['obs-note'] } }));
    const question = boundObservation('obs-question', receipt('answer_question', 'supported', {
      kind: 'question',
      questionId: 'q-work'
    }, {
      explanation: '跨账号汇总的真实综合',
      refs: { ...emptyRefs(), evidenceIds: ['ev-restricted'], observationIds: ['obs-note'] }
    }));
    const base = [note, enumRestricted, enumFree, bodyRestricted, bodyFree, question];
    return noteFirst ? base : [...base].reverse();
  };

  // 'acct-a' sorts first (restricted fills the memo first); 'acct-z' sorts
  // last (legitimate contexts fill the memo first). Both observation orders.
  for (const [restrictedId, freeId] of [
    ['acct-a', 'acct-b'],
    ['acct-z', 'acct-m']
  ] as const) {
    for (const noteFirst of [true, false]) {
      const label = `${restrictedId}/${noteFirst ? 'note-first' : 'note-last'}`;
      const evaluation = evaluateCompletion(craftedSnapshot(build(restrictedId, freeId, noteFirst), restrictedId, freeId));
      const body = evalDim(evaluation, 'body');
      assert.equal(body.addressed, 1, label);
      const restrictedItem = body.unresolvedItems.find((item) => item.obligationKey.includes('src-restricted'));
      assert.equal(restrictedItem?.reason, 'dependency_withdrawn', label);
      assert.ok(!body.unresolvedItems.some((item) => item.obligationKey.includes('src-free')), label);
      assert.equal(evalDim(evaluation, 'questions').addressed, 1, `case-level aggregation ${label}`);
    }
  }
});
