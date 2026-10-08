/**
 * GET-99 chunked stage/verify regression tests (offline, synthetic).
 *
 * Planner level (pure): the review-confirmed payload truncation defects are
 * reproduced against the REAL GET-59 input validators (over-bound payloads
 * fail validation; the old silent `.slice(0, 100 / 10)` losses are covered by
 * exact-once partition assertions), then the deterministic chunk plans are
 * shown to respect every per-call/per-finding bound while preserving every
 * dependency and coverage identity exactly once.
 *
 * Execution level (real SQLite + the real GET-59 dispatch gateway, no fake
 * gateways): targeted prepared-data runs (>100 same-account identities and
 * dependencies; >50 stage findings) execute the chunked save_findings /
 * read_evidence calls, are interrupted after the first stage / verify chunk,
 * closed and reopened, and finish the remaining chunks with zero omissions
 * and zero duplicate successful calls.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import type { FetchSourceCatalog } from '../server/research/fetch-pipeline.js';
import {
  READ_EVIDENCE_BOUND,
  SAVE_FINDINGS_BOUNDS,
  planEvidenceReadCalls,
  planStageFindings,
  planStageSaveFindingsCalls,
  planVerificationFindings,
  planVerificationSaveFindingsCalls,
  remainingStageMaterial
} from '../server/research/fetch-pipeline-plan.js';
import type { StageAccountUnit, StageIdentityUnit } from '../server/research/fetch-pipeline-plan.js';
import { toolInputs } from '../server/research/research-tool-contracts.js';
import { SubmissionRejectedError } from '../server/research/research-tool-dispatch.js';
import type { PendingFindingCommit } from '../server/research/research-tool-dispatch.js';
import {
  buildSyntheticCorpus,
  createPlanModel,
  openSyntheticHarness
} from '../server/research/fetch-pipeline-synthetic.js';
import type { SyntheticHarness } from '../server/research/fetch-pipeline-synthetic.js';
import type { RecordProvenance } from '../shared/research-case.js';
import type { FetchPipelineSummary } from '../shared/research-fetch-pipeline.js';
import { fetchPlanStepKey } from '../shared/research-fetch-pipeline.js';

// Offline by construction: any accidental request fails loudly.
globalThis.fetch = (() => {
  throw new Error('fetch-pipeline chunk tests are offline: real network/fetch is disabled');
}) as typeof globalThis.fetch;

function tempBase(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tempBase(), prefix));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Planner level: reproduced bounds + chunk invariants (pure)          */
/* ------------------------------------------------------------------ */

function identity(
  accountId: string,
  index: number,
  supportIds: string[] = [`sup-${String(index)}`],
  counterIds: string[] = [`cnt-${String(index)}`]
): StageIdentityUnit {
  return { accountId, sourceId: `src-${String(index)}`, sourceRevision: 1, supportIds, counterIds };
}

function flattenFindings(calls: Record<string, unknown>[]): Record<string, unknown>[] {
  return calls.flatMap((call) => (call.findings as Record<string, unknown>[]).slice());
}

function assertWithinSaveBounds(findings: Record<string, unknown>[]): void {
  for (const finding of findings) {
    assert.ok((finding.supportEvidenceIds as string[]).length <= SAVE_FINDINGS_BOUNDS.supportPerFinding);
    assert.ok((finding.counterEvidenceIds as string[]).length <= SAVE_FINDINGS_BOUNDS.counterPerFinding);
    // verification_check findings carry no coverageDelta (verify phase).
    const coverage = (finding.coverageDelta as unknown[] | undefined) ?? [];
    assert.ok(coverage.length <= SAVE_FINDINGS_BOUNDS.coveragePerFinding, 'coverageDelta within the GET-59 per-finding bound');
  }
}

function assertExactOnce(values: string[], expected: string[], label: string): void {
  assert.equal(values.length, expected.length, `${label}: count matches (no slice losses)`);
  assert.deepEqual([...values].sort(), [...expected].sort(), `${label}: every value preserved`);
  assert.equal(new Set(values).size, values.length, `${label}: every value appears exactly once`);
}

test('reproduced: the pre-chunking payloads violate the real GET-59 bounds', () => {
  // buildStageInput used to map ALL identities into ONE coverageDelta and all
  // accounts into ONE findings array: over-bound payloads fail validation.
  const coverage = Array.from({ length: 101 }, (_, index) => ({
    locator: { accountId: 'a', sourceId: `src-${String(index)}`, sourceRevision: 1 },
    taskRef: { kind: 'question_matrix', slot: 'work' },
    status: 'evidence_found'
  }));
  assert.throws(
    () =>
      toolInputs.save_findings(
        {
          findings: [
            {
              kind: 'collected_finding',
              statement: 's',
              supportEvidenceIds: [],
              counterEvidenceIds: [],
              coverageDelta: coverage,
              note: null
            }
          ]
        },
        'save_findings'
      ),
    'more than 100 coverage identities in one finding is refused by GET-59'
  );
  assert.throws(
    () =>
      toolInputs.save_findings(
        {
          findings: Array.from({ length: 51 }, () => ({
            kind: 'collected_finding',
            statement: 's',
            supportEvidenceIds: [],
            counterEvidenceIds: [],
            coverageDelta: [],
            note: null
          }))
        },
        'save_findings'
      ),
    'more than 50 findings in one save_findings call is refused by GET-59'
  );
  assert.throws(
    () =>
      toolInputs.save_findings(
        {
          findings: [
            {
              kind: 'collected_finding',
              statement: 's',
              supportEvidenceIds: Array.from({ length: 150 }, (_, index) => `sup-${String(index)}`),
              counterEvidenceIds: [],
              coverageDelta: [],
              note: null
            }
          ]
        },
        'save_findings'
      ),
    'more than 100 support references in one finding is refused by GET-59'
  );
  assert.throws(
    () =>
      toolInputs.read_evidence(
        { evidence: Array.from({ length: 101 }, (_, index) => ({ evidenceId: `e${String(index)}` })) },
        'read_evidence'
      ),
    'more than 100 evidence references in one read_evidence call is refused by GET-59'
  );
});

test('>100 same-account identities and dependencies are chunked without any silent slice', () => {
  // 250 identities with 250 support + 150 counter refs, plus one identity
  // whose own material exceeds a per-finding bound (250 + 250).
  const identities: StageIdentityUnit[] = [];
  const expectedSupport: string[] = [];
  const expectedCounter: string[] = [];
  for (let index = 1; index <= 250; index += 1) {
    const support = [`sup-${String(index)}`];
    const counter = index <= 150 ? [`cnt-${String(index)}`] : [];
    identities.push(identity('acct-a', index, support, counter));
    expectedSupport.push(...support);
    expectedCounter.push(...counter);
  }
  const heavy = identity(
    'acct-a',
    999,
    Array.from({ length: 250 }, (_, index) => `sup-heavy-${String(index)}`),
    Array.from({ length: 250 }, (_, index) => `cnt-heavy-${String(index)}`)
  );
  identities.push(heavy);
  expectedSupport.push(...(heavy.supportIds as string[]));
  expectedCounter.push(...(heavy.counterIds as string[]));

  const calls = planStageSaveFindingsCalls([{ accountId: 'acct-a', identities }]);
  for (const call of calls) toolInputs.save_findings(call, 'save_findings');
  assert.ok(calls.every((call) => (call.findings as unknown[]).length <= SAVE_FINDINGS_BOUNDS.findingsPerCall));
  const findings = flattenFindings(calls);
  assertWithinSaveBounds(findings);
  assertExactOnce(findings.flatMap((f) => f.supportEvidenceIds as string[]), expectedSupport, 'support refs');
  assertExactOnce(findings.flatMap((f) => f.counterEvidenceIds as string[]), expectedCounter, 'counter refs');
  const coverage = findings.flatMap((f) =>
    (f.coverageDelta as { locator: { accountId: string; sourceId: string; sourceRevision: number } }[]).map(
      (delta) => `${delta.locator.accountId}|${delta.locator.sourceId}|${String(delta.locator.sourceRevision)}`
    )
  );
  assertExactOnce(coverage, identities.map((entry) => `${entry.accountId}|${entry.sourceId}|${String(entry.sourceRevision)}`), 'coverage identities');
  // Statement counts never exceed the actual references of that finding.
  for (const finding of findings) {
    const counts = /（支持 (\d+) 条、反证 (\d+) 条）/.exec(String(finding.statement));
    assert.ok(counts, 'stage statement carries exact reference counts');
    assert.equal(Number(counts![1]), (finding.supportEvidenceIds as string[]).length);
    assert.equal(Number(counts![2]), (finding.counterEvidenceIds as string[]).length);
    const coverageCount = /已处理 (\d+) 个枚举条目/.exec(String(finding.statement));
    if ((finding.coverageDelta as unknown[]).length > 0) {
      assert.ok(coverageCount, 'coverage claim present exactly when the finding references coverage');
      assert.equal(Number(coverageCount![1]), (finding.coverageDelta as unknown[]).length);
    } else {
      assert.equal(coverageCount, null, 'evidence-only chunks claim no coverage count');
    }
  }
});

test('>50 stage findings are split into bounded save_findings calls without omissions', () => {
  // (a) >50 accounts → more than one call (the old single findings array
  // crossed the 50-per-call bound and failed validation).
  const accounts: StageAccountUnit[] = Array.from({ length: 55 }, (_, index) => ({
    accountId: `acct-${String(index).padStart(2, '0')}`,
    identities: [identity(`acct-${String(index).padStart(2, '0')}`, index)]
  }));
  const accountCalls = planStageSaveFindingsCalls(accounts);
  assert.equal(accountCalls.length, 2);
  assert.deepEqual(accountCalls.map((call) => (call.findings as unknown[]).length), [50, 5]);
  for (const call of accountCalls) toolInputs.save_findings(call, 'save_findings');
  assertExactOnce(
    flattenFindings(accountCalls).flatMap((f) => f.supportEvidenceIds as string[]),
    accounts.map((account) => account.identities[0]!.supportIds[0]!),
    'per-account support refs'
  );

  // (b) one account whose identity count alone exceeds 50 findings.
  const identities = Array.from({ length: 5100 }, (_, index) =>
    identity('acct-huge', index, [], [])
  );
  const hugeCalls = planStageSaveFindingsCalls([{ accountId: 'acct-huge', identities }]);
  assert.deepEqual(hugeCalls.map((call) => (call.findings as unknown[]).length), [50, 1]);
  for (const call of hugeCalls) toolInputs.save_findings(call, 'save_findings');
  const coverage = flattenFindings(hugeCalls).flatMap((f) =>
    (f.coverageDelta as { locator: { sourceId: string } }[]).map((delta) => delta.locator.sourceId)
  );
  assertExactOnce(coverage, identities.map((entry) => entry.sourceId), 'huge-account coverage identities');
});

test('verify read batches and verification findings preserve every dependency with exact counts', () => {
  const supportIds = Array.from({ length: 250 }, (_, index) => `sup-${String(index)}`);
  const counterIds = Array.from({ length: 150 }, (_, index) => `cnt-${String(index)}`);
  const all = [...supportIds, ...counterIds];

  // Read-back: every staged dependency in bounded batches, exactly once.
  const readCalls = planEvidenceReadCalls(all);
  assert.equal(readCalls.length, Math.ceil(all.length / READ_EVIDENCE_BOUND));
  for (const call of readCalls) {
    toolInputs.read_evidence(call, 'read_evidence');
    assert.ok((call.evidence as unknown[]).length <= READ_EVIDENCE_BOUND);
  }
  assertExactOnce(readCalls.flatMap((call) => (call.evidence as { evidenceId: string }[]).map((entry) => entry.evidenceId)), all, 'read-back refs');

  // Verification findings reference EXACTLY the given read-back set.
  const findings = planVerificationFindings({ supportIds, counterIds, unverifiedDependencies: 0 });
  assertWithinSaveBounds(findings);
  assertExactOnce(findings.flatMap((f) => f.supportEvidenceIds as string[]), supportIds, 'verified support refs');
  assertExactOnce(findings.flatMap((f) => f.counterEvidenceIds as string[]), counterIds, 'verified counter refs');
  for (const finding of findings) {
    const match = /核验：(\d+) 条支持与 (\d+) 条反证/.exec(String(finding.statement));
    assert.ok(match, 'verification statement carries exact counts');
    assert.equal(Number(match![1]), (finding.supportEvidenceIds as string[]).length);
    assert.equal(Number(match![2]), (finding.counterEvidenceIds as string[]).length);
    assert.ok(!String(finding.statement).includes('partial'), 'complete read-back claims no partial marker');
  }

  // Honest partial: unverified dependencies are disclosed in the note only,
  // never as verified statement counts or semantic facts/quality claims.
  const partial = planVerificationFindings({ supportIds: supportIds.slice(0, 3), counterIds: [], unverifiedDependencies: 397 });
  assert.equal(partial.length, 1);
  assert.deepEqual(partial[0]!.supportEvidenceIds, supportIds.slice(0, 3));
  assert.match(String(partial[0]!.note), /397 条 staged 依赖未能回读/);
  assert.match(String(partial[0]!.note), /partial/);

  // More than 50 verification findings also split into bounded calls.
  const huge = planVerificationSaveFindingsCalls({
    supportIds: Array.from({ length: 5100 }, (_, index) => `sup-${String(index)}`),
    counterIds: [],
    unverifiedDependencies: 0
  });
  assert.deepEqual(huge.map((call) => (call.findings as unknown[]).length), [50, 1]);
  for (const call of huge) toolInputs.save_findings(call, 'save_findings');
});

test('staged material is never re-staged: the remainder keeps only unstaged identities and refs', () => {
  const units: StageAccountUnit[] = [
    {
      accountId: 'acct-a',
      identities: [
        identity('acct-a', 1, ['sup-1'], ['cnt-1']),
        identity('acct-a', 2, ['sup-2a', 'sup-2b'], ['cnt-2']),
        identity('acct-a', 3, ['sup-3'], [])
      ]
    }
  ];
  const remainder = remainingStageMaterial(units, {
    coverage: [{ accountId: 'acct-a', sourceId: 'src-1', sourceRevision: 1 }],
    dependencyIds: ['sup-1', 'cnt-1', 'sup-2a']
  });
  assert.equal(remainder.length, 1);
  assert.deepEqual(
    remainder[0]!.identities.map((entry) => entry.sourceId),
    ['src-2', 'src-3']
  );
  assert.deepEqual(remainder[0]!.identities[0]!.supportIds, ['sup-2b']);
  assert.deepEqual(remainder[0]!.identities[0]!.counterIds, ['cnt-2']);
  // Re-planning the remainder produces the same deterministic inputs.
  assert.deepEqual(planStageSaveFindingsCalls(remainder), planStageSaveFindingsCalls(remainder));
  // Everything staged → empty remainder → no further stage calls.
  assert.deepEqual(
    remainingStageMaterial(units, {
      coverage: [
        { accountId: 'acct-a', sourceId: 'src-1', sourceRevision: 1 },
        { accountId: 'acct-a', sourceId: 'src-2', sourceRevision: 1 },
        { accountId: 'acct-a', sourceId: 'src-3', sourceRevision: 1 }
      ],
      dependencyIds: ['sup-1', 'cnt-1', 'sup-2a', 'sup-2b', 'cnt-2', 'sup-3']
    }),
    []
  );
});

/* ------------------------------------------------------------------ */
/* Execution level: real SQLite + real GET-59 chunk execution          */
/* ------------------------------------------------------------------ */

const PREPARED_PROVENANCE: RecordProvenance = { authorization: 'not_recorded', collector: 'chunk-test', note: null };

function preparedCatalog(accounts: { accountId: string; items: number }[]): FetchSourceCatalog {
  return {
    registryVersion: 'prepared-chunk-catalog/2026-10-08',
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      platform: 'synthetic_alpha',
      handle: `handle-${account.accountId}`,
      profileUrl: `https://fixture.test/handle-${account.accountId}`,
      pages: [
        Array.from({ length: account.items }, (_, index) => {
          const itemId = `itm-${account.accountId}-${String(index + 1).padStart(3, '0')}`;
          const title = `Prepared post ${itemId}`;
          const fulltext = `Prepared synthetic body for ${itemId} (offline fixture).`;
          return {
            accountId: account.accountId,
            itemId,
            sourceId: `src-${itemId}`,
            sourceRevision: 1,
            title,
            publishedAt: '2026-03-01T00:00:00.000Z',
            fulltext,
            contentHash: sha256(fulltext),
            hasMedia: 'none' as const,
            mediaRef: null,
            mediaText: null,
            mediaCaptions: null,
            mediaUnread: false,
            comments: [],
            branches: []
          };
        })
      ],
      pageCursors: [null]
    }))
  };
}

/**
 * Targeted prepared data (same authoritative stores and gateway as the full
 * chain): every enumerated identity already has its body/comment evidence and
 * its fetch-phase steps durably folded, so the run under test executes the
 * chunked stage/verify plan through the REAL GET-59 dispatch.
 */
function prepareStageInput(harness: SyntheticHarness): { supportIds: string[]; counterIds: string[] } {
  const { store, runs } = harness;
  const supportIds: string[] = [];
  const counterIds: string[] = [];
  const doneSteps: string[] = [];
  for (const account of harness.catalog.accounts) {
    const items = account.pages.flat();
    store.completion.recordCompletionObservation({
      ownerId: harness.ownerId,
      caseId: harness.caseId,
      expectedScopeVersion: harness.setup.scopeVersion,
      scopeSpecId: harness.scopeSpecId,
      receipt: {
        obligationRef: { kind: 'account_history', accountId: account.accountId },
        action: 'enumerate_history',
        result: 'items_found',
        attemptState: 'succeeded',
        stopReason: 'endpoint_exhausted',
        accessBoundary: null,
        remainingUnknown: null,
        note: 'prepared enumeration receipt (fixture)',
        refs: {
          accountIds: [],
          sourceRevisions: [],
          evidenceIds: [],
          counterevidenceIds: [],
          coverageItems: [],
          observationIds: []
        },
        items: items.map((item) => ({
          sourceId: item.sourceId,
          sourceRevision: item.sourceRevision,
          hasMedia: item.hasMedia
        })),
        nextCursor: null,
        knownGaps: [],
        synthetic: true,
        provenance: PREPARED_PROVENANCE
      }
    } as never);
    for (const item of items) {
      const ctx = {
        ownerId: harness.ownerId,
        caseId: harness.caseId,
        accountId: account.accountId,
        expectedScopeVersion: harness.setup.scopeVersion
      };
      supportIds.push(
        store.cases.addEvidence(ctx, {
          sourceId: item.sourceId,
          sourceRevision: item.sourceRevision,
          role: 'factual_support',
          quote: `prepared support ${item.itemId}`,
          locator: item.itemId,
          provenance: PREPARED_PROVENANCE
        }).evidenceId
      );
      counterIds.push(
        store.cases.addEvidence(ctx, {
          sourceId: item.sourceId,
          sourceRevision: item.sourceRevision,
          role: 'factual_counterevidence',
          quote: `prepared counter ${item.itemId}`,
          locator: item.itemId,
          provenance: PREPARED_PROVENANCE
        }).evidenceId
      );
      doneSteps.push(
        fetchPlanStepKey(
          'read_post',
          { accountId: account.accountId, itemId: item.itemId },
          { sourceId: item.sourceId, sourceRevision: item.sourceRevision }
        ),
        fetchPlanStepKey(
          'list_comments',
          { accountId: account.accountId, itemId: item.itemId },
          { sourceId: item.sourceId, sourceRevision: item.sourceRevision }
        )
      );
    }
  }
  const checkpoint = runs.loadCheckpoint(harness.runId);
  assert.ok(checkpoint);
  checkpoint!.accounts = checkpoint!.accounts.map((entry) => ({ ...entry, enumeration: 'exhausted' as const }));
  checkpoint!.doneSteps = [...doneSteps].sort();
  runs.updateCheckpoint(harness.runId, checkpoint!);
  return { supportIds, counterIds };
}

interface PreparedFixture {
  harness: SyntheticHarness;
  prepared: { supportIds: string[]; counterIds: string[] };
  close(): void;
  reopen(): SyntheticHarness;
}

function preparedFixture(t: TestContext, accounts: { accountId: string; items: number }[]): PreparedFixture {
  const dir = tempDir('fetch-chunks-');
  const dbPath = path.join(dir, 'chunks.db');
  let db: DB = openDatabase(dbPath);
  applyCoreSchema(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  let harness = openSyntheticHarness(db, { catalog: preparedCatalog(accounts), model: createPlanModel() });
  const prepared = prepareStageInput(harness);
  return {
    get harness() {
      return harness;
    },
    prepared,
    close: () => db.close(),
    reopen: () => {
      db = openDatabase(dbPath);
      applyCoreSchema(db);
      harness = openSyntheticHarness(db, {
        catalog: preparedCatalog(accounts),
        model: createPlanModel(),
        resumeRunId: harness.runId
      });
      return harness;
    }
  };
}

interface ToolEventPayload {
  stepKey: string;
  tool: string;
  input: Record<string, unknown>;
  envelope: { status: string; content: unknown };
}

function toolEvents(harness: SyntheticHarness, tool: string, status?: string): ToolEventPayload[] {
  return harness.runs
    .listEvents(harness.runId)
    .filter((event) => event.kind === 'tool')
    .map((event) => event.payload as ToolEventPayload)
    .filter((payload) => payload.tool === tool && (status === undefined || payload.envelope.status === status));
}

function assertNoDuplicateSuccessfulCalls(harness: SyntheticHarness): void {
  const successful = harness.runs
    .listEvents(harness.runId)
    .filter((event) => event.kind === 'tool')
    .map((event) => event.payload as ToolEventPayload)
    .filter((payload) => payload.envelope.status === 'success' || payload.envelope.status === 'partial');
  assert.equal(new Set(successful.map((payload) => payload.stepKey)).size, successful.length, 'no step is dispatched twice');
}

function assertStatementCounts(findings: { statement: string; supportEvidenceIds: string[]; counterEvidenceIds: string[] }[]): void {
  for (const finding of findings) {
    const match = /核验：(\d+) 条支持与 (\d+) 条反证/.exec(finding.statement);
    assert.ok(match, 'verification statement carries exact counts');
    assert.equal(Number(match![1]), finding.supportEvidenceIds.length);
    assert.equal(Number(match![2]), finding.counterEvidenceIds.length);
  }
}

test('prepared >100 same-account identities: chunked stage/verify resumes after the first verify chunk with no omissions or duplicate calls', async (t) => {
  const fx = preparedFixture(t, [{ accountId: 'acct-prep-a', items: 120 }]);
  const { supportIds, counterIds } = fx.prepared;
  const allRefs = [...supportIds, ...counterIds];
  assert.equal(allRefs.length, 240);

  // Interrupted pass: exactly one durable step per run until the FIRST
  // verify read-back chunk has settled — then the database is closed.
  let first: FetchPipelineSummary | null = null;
  for (let round = 0; round < 40; round += 1) {
    first = await fx.harness.run({ maxStepsPerBatch: 1, maxBatches: 1 });
    if (toolEvents(fx.harness, 'read_evidence', 'success').length >= 1) break;
  }
  assert.ok(first);
  assert.equal(toolEvents(fx.harness, 'read_evidence', 'success').length, 1, 'exactly one verify chunk before interruption');
  assert.equal(first!.state, 'running');
  assert.ok(first!.openSteps > 0, 'remaining verify chunks stay open');

  // Close/reopen on the same database: the remaining chunks must finish
  // without repeating any successful call.
  fx.close();
  const reopened = fx.reopen();
  const final = await reopened.run({ maxStepsPerBatch: 4 });
  assert.equal(final.runId, first!.runId);
  assert.equal(final.state, 'finished');
  assert.equal(final.stopReason, 'obligations_processed');
  assert.equal(final.openSteps, 0);

  // Stage: every identity and dependency preserved exactly once.
  const findings = reopened.runs.listFindings(final.runId);
  const collected = findings.filter((finding) => finding.kind === 'collected_finding');
  const verified = findings.filter((finding) => finding.kind === 'verification_check');
  assert.equal(collected.length, 2, '120 identities split into two bounded findings');
  assertExactOnce(
    collected.flatMap((finding) => finding.supportEvidenceIds),
    supportIds,
    'staged support refs'
  );
  assertExactOnce(
    collected.flatMap((finding) => finding.counterEvidenceIds),
    counterIds,
    'staged counter refs'
  );
  const coverage = collected.flatMap((finding) =>
    finding.coverageDelta.map(
      (delta) => `${delta.locator.accountId}|${delta.locator.sourceId}|${String(delta.locator.sourceRevision)}`
    )
  );
  assertExactOnce(
    coverage,
    fx.harness.catalog.accounts
      .flatMap((account) => account.pages.flat())
      .map((item) => `${item.accountId}|${item.sourceId}|${String(item.sourceRevision)}`),
    'staged coverage identities'
  );

  // Verify: read_evidence batches partition ALL staged dependencies exactly
  // once, through the real GET-59 input validation.
  const reads = toolEvents(reopened, 'read_evidence', 'success');
  assert.equal(reads.length, 3, '240 dependencies read back in three bounded batches');
  for (const read of reads) toolInputs.read_evidence(read.input, 'read_evidence');
  assertExactOnce(
    reads.flatMap((read) => (read.input.evidence as { evidenceId: string }[]).map((entry) => entry.evidenceId)),
    allRefs,
    'read-back refs'
  );
  // Verification findings reference exactly the successfully pinned set.
  assert.equal(verified.length, 2);
  assertExactOnce(
    verified.flatMap((finding) => [...finding.supportEvidenceIds, ...finding.counterEvidenceIds]),
    allRefs,
    'verification refs'
  );
  assertStatementCounts(verified);
  assert.equal(final.counts.verificationsStaged, verified.length);
  assert.equal(final.counts.findingsStaged, collected.length);
  assertNoDuplicateSuccessfulCalls(reopened);
  assert.equal(final.providerProfilesVerified, 0);
});

test('prepared >50 stage findings: chunked save_findings calls resume after the first stage chunk with no omissions or duplicate calls', async (t) => {
  const fx = preparedFixture(
    t,
    Array.from({ length: 55 }, (_, index) => ({ accountId: `acct-prep-${String(index + 1).padStart(2, '0')}`, items: 2 }))
  );
  const { supportIds, counterIds } = fx.prepared;
  const allRefs = [...supportIds, ...counterIds];
  assert.equal(allRefs.length, 220);

  // Interrupted pass: stop right after the FIRST stage chunk settles.
  let first: FetchPipelineSummary | null = null;
  for (let round = 0; round < 40; round += 1) {
    first = await fx.harness.run({ maxStepsPerBatch: 1, maxBatches: 1 });
    if (toolEvents(fx.harness, 'save_findings', 'success').length >= 1) break;
  }
  assert.ok(first);
  const stageChunks = toolEvents(fx.harness, 'save_findings', 'success');
  assert.equal(stageChunks.length, 1, 'exactly one stage chunk before interruption');
  assert.equal((stageChunks[0]!.input.findings as unknown[]).length, 50);
  assert.equal(first!.state, 'running');
  assert.ok(first!.openSteps > 0);

  fx.close();
  const reopened = fx.reopen();
  const final = await reopened.run({ maxStepsPerBatch: 4 });
  assert.equal(final.state, 'finished');
  assert.equal(final.stopReason, 'obligations_processed');
  assert.equal(final.openSteps, 0);

  // Two bounded stage calls (50 + 5 findings), all real GET-59 validated.
  const allStageCalls = toolEvents(reopened, 'save_findings', 'success').filter((event) =>
    ((event.input.findings as { kind: string }[])[0]?.kind ?? '') === 'collected_finding'
  );
  assert.equal(allStageCalls.length, 2);
  assert.deepEqual(allStageCalls.map((event) => (event.input.findings as unknown[]).length), [50, 5]);
  for (const call of allStageCalls) toolInputs.save_findings(call.input, 'save_findings');

  const findings = reopened.runs.listFindings(final.runId);
  const collected = findings.filter((finding) => finding.kind === 'collected_finding');
  const verified = findings.filter((finding) => finding.kind === 'verification_check');
  assert.equal(collected.length, 55, 'one staged finding per account');
  assertExactOnce(
    collected.flatMap((finding) => finding.supportEvidenceIds),
    supportIds,
    'staged support refs'
  );
  assertExactOnce(
    collected.flatMap((finding) => finding.counterEvidenceIds),
    counterIds,
    'staged counter refs'
  );
  const coverage = collected.flatMap((finding) =>
    finding.coverageDelta.map(
      (delta) => `${delta.locator.accountId}|${delta.locator.sourceId}|${String(delta.locator.sourceRevision)}`
    )
  );
  assertExactOnce(
    coverage,
    fx.harness.catalog.accounts
      .flatMap((account) => account.pages.flat())
      .map((item) => `${item.accountId}|${item.sourceId}|${String(item.sourceRevision)}`),
    'staged coverage identities'
  );

  // Verify chunks finish after the resume: read batches + verification findings.
  const reads = toolEvents(reopened, 'read_evidence', 'success');
  assert.equal(reads.length, 3, '220 dependencies read back in three bounded batches');
  assertExactOnce(
    reads.flatMap((read) => (read.input.evidence as { evidenceId: string }[]).map((entry) => entry.evidenceId)),
    allRefs,
    'read-back refs'
  );
  assert.equal(verified.length, 2);
  assertExactOnce(
    verified.flatMap((finding) => [...finding.supportEvidenceIds, ...finding.counterEvidenceIds]),
    allRefs,
    'verification refs'
  );
  assertStatementCounts(verified);
  assertNoDuplicateSuccessfulCalls(reopened);
});

test('a failed verify read-back chunk stays honest partial: never finished, no verification claim beyond real read-backs', async (t) => {
  const fx = preparedFixture(t, [{ accountId: 'acct-prep-f', items: 75 }]);
  const { supportIds, counterIds } = fx.prepared;
  const allRefs = [...supportIds, ...counterIds];
  assert.equal(allRefs.length, 150);
  // The first read-back batch fails (unavailable gateway response): it must
  // settle as an explicit refusal and never be auto-retried.
  let failedOnce = false;
  const summary = await fx.harness.run({
    maxStepsPerBatch: 4,
    tools: {
      dispatch: async (context, call, signal) => {
        const envelope = await fx.harness.tools.dispatch(context, call, signal);
        if (!failedOnce && call.tool === 'read_evidence') {
          failedOnce = true;
          (envelope as { status: string; content: unknown }).status = 'failed';
          (envelope as { content: unknown }).content = null;
        }
        return envelope;
      }
    }
  });
  // Honest partial: the run is NEVER marked finished.
  assert.equal(summary.state, 'stopped');
  assert.equal(summary.stopReason, 'verify_readback_incomplete');
  assert.ok(summary.remainingGaps.some((line) => line.includes('partial')));
  // The failed batch is refused, not replayed: exactly two batches attempted.
  const reads = toolEvents(fx.harness, 'read_evidence');
  assert.equal(reads.length, 2);
  const succeededRefs = reads
    .filter((read) => read.envelope.status === 'success')
    .flatMap((read) => (read.input.evidence as { evidenceId: string }[]).map((entry) => entry.evidenceId));
  assert.equal(succeededRefs.length, 50);
  // Verification findings reference EXACTLY the successfully pinned subset.
  const verified = fx.harness.runs
    .listFindings(summary.runId)
    .filter((finding) => finding.kind === 'verification_check');
  assert.equal(verified.length, 1);
  assertExactOnce(verified.flatMap((finding) => [...finding.supportEvidenceIds, ...finding.counterEvidenceIds]), succeededRefs, 'partial verification refs');
  assertStatementCounts(verified);
  assert.match(String(verified[0]!.note), /100 条 staged 依赖未能回读/);
  // No semantic fact or quality claim is ever created.
  for (const finding of fx.harness.runs.listFindings(summary.runId)) {
    assert.equal(finding.state, 'pending');
    assert.ok(!finding.statement.includes('质量'));
  }
  assert.equal(summary.counts.verificationsStaged, 1);
  assertNoDuplicateSuccessfulCalls(fx.harness);
});

/* ------------------------------------------------------------------ */
/* Review counterexample regressions (real SQLite/GET-59/GET-95)       */
/* ------------------------------------------------------------------ */

/**
 * Light end-to-end fixture: one account, N stripped items, the full real
 * chain through GET-59 dispatch, the real SubmissionPort and GET-95 receipts
 * (no fake gateways, no simulated success receipts).
 */
function lightFixture(t: TestContext, count = 1): PreparedFixture {
  const dir = tempDir('fetch-review-');
  const dbPath = path.join(dir, 'review.db');
  let db: DB = openDatabase(dbPath);
  applyCoreSchema(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const makeCatalog = (): FetchSourceCatalog => {
    const catalog = buildSyntheticCorpus();
    catalog.accounts = catalog.accounts.slice(0, 1);
    for (const account of catalog.accounts) {
      account.pages = [account.pages[0]!.slice(0, count)];
      account.pageCursors = [null];
      for (const item of account.pages.flat()) {
        item.comments = [];
        item.branches = [];
        item.hasMedia = 'none';
        item.mediaRef = null;
      }
    }
    return catalog;
  };
  let harness = openSyntheticHarness(db, { catalog: makeCatalog(), model: createPlanModel() });
  return {
    get harness() {
      return harness;
    },
    prepared: { supportIds: [], counterIds: [] },
    close: () => db.close(),
    reopen: () => {
      db = openDatabase(dbPath);
      applyCoreSchema(db);
      harness = openSyntheticHarness(db, {
        catalog: makeCatalog(),
        model: createPlanModel(),
        resumeRunId: harness.runId
      });
      return harness;
    }
  };
}

function collectedFindings(harness: SyntheticHarness) {
  return harness.runs.listFindings(harness.runId).filter((finding) => finding.kind === 'collected_finding');
}

function verificationFindings(harness: SyntheticHarness) {
  return harness.runs.listFindings(harness.runId).filter((finding) => finding.kind === 'verification_check');
}

function stageCallsOf(harness: SyntheticHarness) {
  return toolEvents(harness, 'save_findings').filter(
    (event) => ((event.input.findings as { kind: string }[])[0]?.kind ?? '') === 'collected_finding'
  );
}

function verificationCallsOf(harness: SyntheticHarness) {
  return toolEvents(harness, 'save_findings').filter(
    (event) => ((event.input.findings as { kind: string }[])[0]?.kind ?? '') === 'verification_check'
  );
}

test('counterexample: partial stage refusal cannot retry material under a new key or duplicate coverage', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  const item = h.catalog.accounts[0]!.pages[0]![0]!;
  for (let index = 0; index < 150; index += 1) {
    h.store.cases.addEvidence(
      {
        ownerId: h.ownerId,
        caseId: h.caseId,
        accountId: item.accountId,
        expectedScopeVersion: h.setup.scopeVersion
      },
      {
        sourceId: item.sourceId,
        sourceRevision: item.sourceRevision,
        role: 'factual_support',
        quote: `Synthetic prepared support ${String(index)}`,
        locator: `review:${String(index)}`,
        provenance: PREPARED_PROVENANCE
      }
    );
  }
  const submissions = h.tools.ports.submissions!;
  const original = submissions.stagePendingFinding;
  let calls = 0;
  let refusedRefs: string[] = [];
  submissions.stagePendingFinding = async (commit: PendingFindingCommit) => {
    if (commit.finding.kind === 'collected_finding') {
      calls += 1;
      if (calls === 2) {
        refusedRefs = [...commit.finding.supportEvidenceIds];
        throw new SubmissionRejectedError('review_rejected', 'Synthetic explicit stage refusal');
      }
    }
    return original(commit);
  };
  const result = await h.run({ maxStepsPerBatch: 1 });
  const events = stageCallsOf(h);
  const retried = events
    .slice(1)
    .flatMap((event) => event.input.findings as { supportEvidenceIds: string[] }[])
    .flatMap((finding) => finding.supportEvidenceIds)
    .filter((evidenceId) => refusedRefs.includes(evidenceId));
  const coverage = collectedFindings(h).flatMap((finding) => finding.coverageDelta);
  assert.ok(refusedRefs.length > 0, 'the second finding submission is refused');
  assert.equal(retried.length, 0, 'Refused material cannot be dispatched again under a repacked key.');
  assert.equal(coverage.length, 1, 'The already-staged coverage identity cannot be staged twice.');
  assert.notEqual(result.state, 'finished');
  assert.equal(result.stopReason, 'stage_incomplete');
  assert.ok(result.remainingGaps.some((line) => line.includes('stage')));
});

test('counterexample: all-refused stage cannot claim no unstaged material or finished', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  h.tools.ports.submissions!.stagePendingFinding = async () => {
    throw new SubmissionRejectedError('review_rejected', 'Synthetic explicit stage refusal');
  };
  const result = await h.run({ maxStepsPerBatch: 1 });
  assert.equal(collectedFindings(h).length, 0);
  assert.equal(stageCallsOf(h).length, 1, 'the frozen manifest call is attempted exactly once');
  assert.notEqual(result.state, 'finished');
  assert.equal(result.stopReason, 'stage_incomplete');
  assert.ok(result.remainingGaps.some((line) => line.includes('stage')));
});

test('counterexample: revoked evidence cannot remain verified merely because its id is cached', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  const dispatch = h.tools.dispatch;
  let revoked: string | null = null;
  const result = await h.run({
    maxStepsPerBatch: 1,
    tools: {
      dispatch: async (ctx, call, signal) => {
        const envelope = await dispatch(ctx, call, signal);
        if (call.tool === 'read_evidence' && revoked === null) {
          revoked = (call.input as { evidence: { evidenceId: string }[] }).evidence[0]!.evidenceId;
          const row = h.store.cases
            .reportView(h.ownerId, h.caseId)
            .evidence.find((entry) => entry.evidenceId === revoked);
          h.store.cases.revokeEvidence(
            {
              ownerId: h.ownerId,
              caseId: h.caseId,
              accountId: row!.accountId,
              expectedScopeVersion: h.setup.scopeVersion
            },
            row!.evidenceId
          );
        }
        return envelope;
      }
    }
  });
  assert.ok(revoked);
  assert.notEqual(result.state, 'finished', 'a revoked staged dependency stays verify-incomplete');
  assert.equal(result.stopReason, 'verify_readback_incomplete');
  assert.equal(verificationFindings(h).length, 0, 'no verification claim is staged on revoked evidence');
});

test('counterexample: shared support/counter refs appear exactly once across identity material', () => {
  const material = remainingStageMaterial(
    [
      {
        accountId: 'a',
        identities: [
          { accountId: 'a', sourceId: 's1', sourceRevision: 1, supportIds: ['sup1'], counterIds: ['shared-counter'] },
          { accountId: 'a', sourceId: 's2', sourceRevision: 1, supportIds: ['sup2'], counterIds: ['shared-counter'] }
        ]
      }
    ],
    { coverage: [], dependencyIds: [] }
  );
  const calls = planStageSaveFindingsCalls(material);
  calls.forEach((call) => toolInputs.save_findings(call, 'review'));
  const ids = calls.flatMap((call) => call.findings as { counterEvidenceIds: string[] }[]).flatMap((f) => f.counterEvidenceIds);
  assert.equal(ids.filter((id) => id === 'shared-counter').length, 1);
  const support = calls.flatMap((call) => call.findings as { supportEvidenceIds: string[] }[]).flatMap((f) => f.supportEvidenceIds);
  assert.equal(support.filter((id) => id === 'sup1').length + support.filter((id) => id === 'sup2').length, 2);
});

test('counterexample: a covered identity with an unstaged evidence lane stages refs without re-emitting coverage', () => {
  const id = { accountId: 'a', sourceId: 's', sourceRevision: 1, supportIds: ['new-ref'], counterIds: [] };
  const remainder = remainingStageMaterial([{ accountId: 'a', identities: [id] }], { coverage: [id], dependencyIds: [] });
  const calls = planStageSaveFindingsCalls(remainder);
  assert.equal(calls.flatMap((call) => call.findings as { coverageDelta: unknown[] }[]).flatMap((f) => f.coverageDelta).length, 0);
  assert.deepEqual(
    calls.flatMap((call) => call.findings as { supportEvidenceIds: string[] }[]).flatMap((f) => f.supportEvidenceIds),
    ['new-ref']
  );
});

test('counterexample: coverage remainder uses collision-free identity tuples admitted by GET-59', () => {
  const first = { accountId: 'a|b', sourceId: 'c', sourceRevision: 1, supportIds: [], counterIds: [] };
  const second = { accountId: 'a', sourceId: 'b|c', sourceRevision: 1, supportIds: [], counterIds: [] };
  const material = [
    { accountId: first.accountId, identities: [first] },
    { accountId: second.accountId, identities: [second] }
  ];
  planStageSaveFindingsCalls(material).forEach((call) => toolInputs.save_findings(call, 'review'));
  const remainder = remainingStageMaterial(material, { coverage: [first], dependencyIds: [] });
  assert.equal(remainder.length, 1, 'Distinct schema-valid identity tuples must not remove each other as staged.');
  assert.equal(remainder[0]!.identities[0]!.sourceId, 'b|c');
});

test('counterexample: a shared counter from valid GET-95 receipts is staged once in real SQLite findings', async (t) => {
  const fx = lightFixture(t, 2);
  const h = fx.harness;
  const items = h.catalog.accounts[0]!.pages[0]!;
  const counter = h.store.cases.addEvidence(
    {
      ownerId: h.ownerId,
      caseId: h.caseId,
      accountId: items[0]!.accountId,
      expectedScopeVersion: h.setup.scopeVersion
    },
    {
      sourceId: items[0]!.sourceId,
      sourceRevision: items[0]!.sourceRevision,
      role: 'factual_counterevidence',
      quote: 'One synthetic counterclaim relevant to two items',
      locator: 'review:shared-counter',
      provenance: PREPARED_PROVENANCE
    }
  );
  for (const item of items) {
    h.store.fetchCoverage.recordFetchReceipt({
      ownerId: h.ownerId,
      caseId: h.caseId,
      expectedScopeVersion: h.setup.scopeVersion,
      receipt: {
        receiptKey: `review:shared:${item.itemId}`,
        content: { accountId: item.accountId, sourceId: item.sourceId, sourceRevision: item.sourceRevision },
        dimension: { name: 'comments' },
        state: 'read',
        reason: null,
        parents: [],
        evidenceIds: [],
        counterevidenceIds: [counter.evidenceId],
        occurredAt: '2026-04-01T00:00:00Z',
        note: null,
        synthetic: true,
        provenance: PREPARED_PROVENANCE
      }
    });
  }
  const result = await h.run({ maxStepsPerBatch: 1 });
  const findings = collectedFindings(h);
  const ids = findings.flatMap((finding) => finding.counterEvidenceIds);
  assert.equal(ids.filter((id) => id === counter.evidenceId).length, 1, 'one shared counterclaim is one dependency');
  // Statement counts equal the unique references of each finding.
  for (const finding of findings) {
    const match = /（支持 (\d+) 条、反证 (\d+) 条）/.exec(finding.statement);
    assert.ok(match);
    assert.equal(Number(match![1]), finding.supportEvidenceIds.length);
    assert.equal(Number(match![2]), finding.counterEvidenceIds.length);
  }
});

test('counterexample: a wrong returned sourceRevision cannot create a pin-verified finding', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  const dispatch = h.tools.dispatch;
  const result = await h.run({
    maxStepsPerBatch: 1,
    tools: {
      dispatch: async (ctx, call, signal) => {
        const envelope = await dispatch(ctx, call, signal);
        if (call.tool === 'read_evidence') {
          for (const item of (envelope.content as { items: { sourceRevision: number }[] }).items) {
            item.sourceRevision += 100;
          }
        }
        return envelope;
      }
    }
  });
  const findings = verificationFindings(h);
  assert.equal(findings.length, 0, 'matching evidenceId/applicable is insufficient when the pin differs');
  assert.notEqual(result.state, 'finished');
  assert.equal(result.stopReason, 'verify_readback_incomplete');
  assert.ok(result.remainingGaps.some((line) => line.includes('readback_pin_mismatch')));
});

/* ------------------------------------------------------------------ */
/* Partial verification-save refusal/reopen and legacy boundaries      */
/* ------------------------------------------------------------------ */

test('partial verification-save refusal survives reopen without retries and stays honest partial', async (t) => {
  const fx = preparedFixture(t, [{ accountId: 'acct-prep-v', items: 120 }]);
  const { supportIds, counterIds } = fx.prepared;
  const allRefs = [...supportIds, ...counterIds];
  assert.equal(allRefs.length, 240);
  // Phase 1: run one durable step per batch until the read manifest settles.
  for (let round = 0; round < 40; round += 1) {
    await fx.harness.run({ maxStepsPerBatch: 1, maxBatches: 1 });
    if (fx.harness.runs.loadCheckpoint(fx.harness.runId)!.evidenceReadBack.length >= 240) break;
  }
  assert.equal(fx.harness.runs.loadCheckpoint(fx.harness.runId)!.evidenceReadBack.length, 240);
  assert.equal(verificationFindings(fx.harness).length, 0);
  fx.close();

  // Phase 2 (after reopen): the second verification finding submission is
  // explicitly refused inside the SAME call — a partial submission.
  const second = fx.reopen();
  const submissions = second.tools.ports.submissions!;
  const original = submissions.stagePendingFinding;
  let verificationCommits = 0;
  submissions.stagePendingFinding = async (commit: PendingFindingCommit) => {
    if (commit.finding.kind === 'verification_check') {
      verificationCommits += 1;
      if (verificationCommits === 2) {
        throw new SubmissionRejectedError('review_rejected', 'Synthetic verification refusal');
      }
    }
    return original(commit);
  };
  const partial = await second.run({ maxStepsPerBatch: 4 });
  assert.equal(verificationCallsOf(second).length, 1, 'the verification-save manifest call is attempted exactly once');
  assert.equal(verificationFindings(second).length, 1, 'only the accepted finding is staged');
  assert.equal(partial.state, 'stopped');
  assert.equal(partial.stopReason, 'verify_readback_incomplete');
  fx.close();

  // Phase 3 (after a second reopen): no auto-retry of the refused material.
  const third = fx.reopen();
  const intentsBefore = third.runs.listIntents(third.runId).length;
  const final = await third.run({ maxStepsPerBatch: 4 });
  assert.equal(third.runs.listIntents(third.runId).length, intentsBefore, 'resume dispatches nothing new');
  assert.equal(verificationCallsOf(third).length, 1, 'the refused verification material is never re-packed or retried');
  const verified = verificationFindings(third);
  assert.equal(verified.length, 1);
  assertExactOnce(
    verified.flatMap((finding) => [...finding.supportEvidenceIds, ...finding.counterEvidenceIds]),
    verified.flatMap((finding) => [...finding.supportEvidenceIds, ...finding.counterEvidenceIds]),
    'staged verification refs stay unique'
  );
  assert.equal(verified.flatMap((finding) => [...finding.supportEvidenceIds, ...finding.counterEvidenceIds]).length, 200);
  assertStatementCounts(verified);
  assert.equal(final.state, 'stopped');
  assert.equal(final.stopReason, 'verify_readback_incomplete');
  assert.ok(final.remainingGaps.some((line) => line.includes('verify')));
  assertNoDuplicateSuccessfulCalls(third);
});

test('finished old-style checkpoints restore read-only: no dispatches, events, checkpoint writes or assessments', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  h.runs.finishRun(h.runId, 'finished', 'obligations_processed');
  const eventsBefore = h.runs.listEvents(h.runId).length;
  const intentsBefore = h.runs.listIntents(h.runId).length;
  const assessmentsBefore = h.store.completion.listCompletionAssessments(h.ownerId, h.caseId, h.scopeSpecId).length;
  const checkpointBefore = JSON.stringify(h.runs.loadCheckpoint(h.runId));
  const summary = await h.run({ maxStepsPerBatch: 4 });
  assert.equal(summary.state, 'finished');
  assert.equal(summary.stopReason, 'obligations_processed');
  assert.equal(summary.openSteps, 0);
  assert.equal(h.runs.listEvents(h.runId).length, eventsBefore, 'zero new events');
  assert.equal(h.runs.listIntents(h.runId).length, intentsBefore, 'zero new dispatches');
  assert.equal(
    h.store.completion.listCompletionAssessments(h.ownerId, h.caseId, h.scopeSpecId).length,
    assessmentsBefore,
    'zero new GET-60 assessments'
  );
  assert.equal(JSON.stringify(h.runs.loadCheckpoint(h.runId)), checkpointBefore, 'zero checkpoint updates');
  assert.match(summary.remainingGaps.join('\n'), /只读恢复/);
});

test('legacy mid-run checkpoints that attempted stage/verify fail closed with an explicit upgrade gap', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  // Simulate a legacy (pre-manifest) mid-run checkpoint that already
  // attempted staging: a historical save_findings intent, no manifests.
  const intent = h.runs.beginIntent({ runId: h.runId, stepKey: 'legacy-stage', tool: 'save_findings', input: { findings: [] } });
  h.runs.recordOutcome(intent.intentId, { status: 'success' }, 'reported');
  const eventsBefore = h.runs.listEvents(h.runId).length;
  const intentsBefore = h.runs.listIntents(h.runId).length;
  const summary = await h.run({ maxStepsPerBatch: 4 });
  assert.equal(summary.state, 'stopped');
  assert.equal(summary.stopReason, 'upgrade_required');
  assert.equal(h.runs.listIntents(h.runId).length, intentsBefore, 'historical material is never retried');
  assert.equal(h.runs.listEvents(h.runId).length, eventsBefore, 'zero new events on the fail-closed path');
  assert.ok(summary.remainingGaps.some((line) => line.includes('upgrade')));
});

test('legacy unfinished runs before stage enter the new planner without replaying settled actions', async (t) => {
  const fx = lightFixture(t);
  const h = fx.harness;
  // Historical fetch-phase progress on an old-style checkpoint (no manifests,
  // no stage/verify attempts): enumeration recorded and every body/comment
  // step durably folded with its evidence.
  prepareStageInput(h);
  const summary = await h.run({ maxStepsPerBatch: 4 });
  // The settled enumeration/body/comment actions are never replayed.
  assert.equal(toolEvents(h, 'read_post').length, 0);
  assert.equal(toolEvents(h, 'list_comments').length, 0);
  assert.equal(toolEvents(h, 'list_posts').length, 0);
  // The new planner freezes fresh manifests and completes the run honestly.
  const persisted = h.runs.loadCheckpoint(h.runId)!;
  assert.ok(persisted.stageManifest, 'the new planner freezes a stage manifest');
  assert.equal(persisted.stageManifest!.planner, 'fetch-pipeline-plan/v2-immutable-manifests');
  assert.equal(summary.state, 'finished');
  assert.equal(summary.stopReason, 'obligations_processed');
  assert.equal(collectedFindings(h).length, 1);
});
