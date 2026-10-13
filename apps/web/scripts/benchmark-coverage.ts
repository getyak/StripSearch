/** Offline production-projection benchmark. Fixture setup and serialization are not timed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openDatabase, applyCoreSchema } from '../src/server/db/index.js';
import { CaseStore } from '../src/server/research/case-store.js';
import { CompletionStore } from '../src/server/research/completion-store.js';
import { FetchCoverageStore } from '../src/server/research/fetch-coverage-store.js';
import type { AccountDraft } from '../src/server/research/case-store.js';
import type { CompletionObservationDraft, CompletionScopeSpec } from '../src/shared/research-completion.js';
import type { FetchCoverageView, FetchProcessingReceiptDraft } from '../src/shared/research-fetch-coverage.js';

export const BASELINE_REVISION = '0017e11';
const OWNER = 'synthetic-coverage-owner';
const PROVENANCE = { authorization: 'not_recorded' as const, collector: 'synthetic-coverage-benchmark', note: null };
const root = fileURLToPath(new URL('../../../', import.meta.url));
globalThis.fetch = (() => { throw new Error('coverage benchmark is offline'); }) as typeof globalThis.fetch;

/** Load exact historical implementation beside its imports; .env.* is already ignored. */
export async function loadBaseline(): Promise<typeof FetchCoverageStore> {
  const filename = resolve(root, `apps/web/src/server/research/.env.coverage-baseline-${process.pid}.ts`);
  const source = execFileSync('git', ['show', `${BASELINE_REVISION}:apps/web/src/server/research/fetch-coverage-store.ts`],
    { cwd: root, encoding: 'utf8' });
  writeFileSync(filename, source, { flag: 'wx' });
  try {
    const loaded = await import(pathToFileURL(filename).href) as { FetchCoverageStore: typeof FetchCoverageStore };
    return loaded.FetchCoverageStore;
  } finally {
    unlinkSync(filename);
  }
}

export interface FixtureOptions {
  accounts: number;
  itemsPerAccount: number;
  branches?: number;
  enumeration?: 'exhausted' | 'unknown' | 'none';
}

/** Public stores populate a real SQLite database; no provider or network is involved. */
export function coverageFixture(options: FixtureOptions) {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const cases = new CaseStore(db);
  const completion = new CompletionStore(db, cases);
  const coverage = new FetchCoverageStore(db, cases, completion);
  const record = cases.createCase({ ownerId: OWNER, caseId: 'coverage-benchmark', intent: 'Synthetic coverage', provenance: PROVENANCE });
  const accountDraft = (index: number): AccountDraft => ({
    accountId: `synthetic-account-${String(index).padStart(4, '0')}`,
    platform: index % 2 === 0 ? 'synthetic-a' : 'synthetic-b', handle: `synthetic-${index}`,
    profileUrl: `https://fixture.test/account/${index}`,
    identitySupport: { state: 'proposed', evidenceIds: [], counterevidenceIds: [], policyVersion: 'identity-policy/v1', note: null },
    userSelection: { state: 'selected', note: 'synthetic', recordedAt: '2026-01-01' },
    allowedScope: { state: 'public_history', note: 'synthetic' },
    researchValue: { state: 'unassessed', rationale: null },
    accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null }
  });
  const selected = cases.applyScopeChange({ ownerId: OWNER, caseId: record.caseId, expectedScopeVersion: record.scopeVersion,
    reason: 'synthetic selected accounts', accounts: Array.from({ length: options.accounts }, (_, i) => ({ create: accountDraft(i) })) });
  const spec: CompletionScopeSpec = {
    questions: [{ questionId: 'work', slot: 'work', text: 'Synthetic work?', applicability: 'applicable', applicabilityReason: 'synthetic' }],
    platformRegistry: { registryVersion: 'synthetic/v1', entries: ['synthetic-a', 'synthetic-b'].map(platformId => ({
      platformId, label: platformId, applicability: 'applicable', applicabilityReason: 'synthetic'
    })) },
    accountRange: { mode: 'researched_accounts', accountIds: [] }, timeRange: { from: '2026-01-01', to: '2026-12-31' },
    threadDepth: 4, requiredChecks: [{ checkId: 'time', kind: 'time_coverage', required: ['2026'] }]
  };
  const frozen = completion.freezeCompletionScope({ ownerId: OWNER, caseId: record.caseId,
    expectedScopeVersion: selected.case.scopeVersion, spec, reason: 'synthetic frozen scope' });
  const context = { ownerId: OWNER, caseId: record.caseId, expectedScopeVersion: frozen.scopeVersion };
  const emptyRefs = () => ({ accountIds: [], sourceRevisions: [], evidenceIds: [], counterevidenceIds: [], coverageItems: [], observationIds: [] });
  const sources: Array<{ accountId: string; sourceId: string; evidenceId: string }> = [];
  const drafts: FetchProcessingReceiptDraft[] = [];
  const observation = (draft: CompletionObservationDraft) => completion.recordCompletionObservation({ ...context,
    scopeSpecId: frozen.scopeSpecId, receipt: draft });
  db.transaction(() => {
    for (const account of selected.accounts) {
      const items: Array<{ sourceId: string; sourceRevision: number; hasMedia: 'none' | 'present' | 'unknown' }> = [];
      for (let i = 0; i < options.itemsPerAccount; i += 1) {
        const sourceDraft = {
          author: 'Synthetic author', originalUrl: `https://fixture.test/${account.accountId}/${i}`, title: `Synthetic ${i}`,
          publishedAt: i % 11 === 0 ? null : i % 13 === 0 ? '2025-01-01' : '2026-05-01', retrievedAt: '2026-06-01T00:00:00.000Z',
          locator: 'synthetic paragraph', contentHash: 'a'.repeat(64), provenance: PROVENANCE
        };
        const ctx = { ...context, accountId: account.accountId };
        const source = cases.recordSourceRevision(ctx, sourceDraft);
        const evidence = cases.addEvidence(ctx, { sourceId: source.sourceId, sourceRevision: 1,
          role: 'factual_support', quote: 'Original synthetic statement.', locator: 'synthetic paragraph', provenance: PROVENANCE });
        sources.push({ accountId: account.accountId, sourceId: source.sourceId, evidenceId: evidence.evidenceId });
        if (i % 17 === 0) cases.recordSourceRevision(ctx, { ...sourceDraft, sourceId: source.sourceId, contentHash: 'b'.repeat(64) });
        const content = { accountId: account.accountId, sourceId: source.sourceId, sourceRevision: 1 };
        const receipt = (suffix: string, overrides: Partial<FetchProcessingReceiptDraft> = {}) => {
          const draft: FetchProcessingReceiptDraft = {
            receiptKey: `${account.accountId}/${i}/${suffix}`, content, dimension: { name: 'body' }, state: 'read', reason: null,
            parents: [], evidenceIds: [evidence.evidenceId], counterevidenceIds: [], occurredAt: '2026-05-01T00:00:00.000Z',
            note: null, synthetic: true, provenance: PROVENANCE, ...overrides
          };
          drafts.push(draft);
        };
        receipt('body');
        if (i % 5 === 0) receipt('body-reopened', { state: 'failed', reason: 'synthetic later failure', occurredAt: '2020-01-01T00:00:00.000Z' });
        receipt('comments', { dimension: { name: 'comments' } });
        if (i % 3 === 0) receipt('media', { dimension: { name: 'media' } });
        for (let b = 0; b < (options.branches ?? 3); b += 1) {
          const branchKey = `branch:${b}`;
          if (b === 0) observation({ obligationRef: { kind: 'thread_branch', ...content, branchKey }, action: 'select_branch',
            result: 'branch_selected', attemptState: 'succeeded', stopReason: null, accessBoundary: null, remainingUnknown: null,
            note: null, synthetic: true, provenance: PROVENANCE, refs: emptyRefs(),
            parentChain: [{ commentKey: 'parent', depth: 1, state: 'deleted' }] });
          receipt(`branch-${b}`, { dimension: { name: 'thread_branch', branchKey },
            state: b === 0 ? 'context_missing' : 'read', reason: b === 0 ? 'synthetic missing context' : null,
            parents: [{ commentKey: 'parent', state: b === 0 ? 'hidden' : 'present' }] });
          if (b === 0) receipt('branch-0-latest', { dimension: { name: 'thread_branch', branchKey },
            parents: [{ commentKey: 'parent', state: 'missing' }], occurredAt: '2019-01-01T00:00:00.000Z' });
        }
        // Last item is receipt-only; duplicate page records conflicting media for the first item.
        if (i < options.itemsPerAccount - 1) items.push({ sourceId: source.sourceId, sourceRevision: 1,
          hasMedia: i % 3 === 0 ? 'present' : i % 3 === 1 ? 'none' : 'unknown' });
      }
      if (options.enumeration !== 'none') {
        const draft: CompletionObservationDraft = {
          obligationRef: { kind: 'account_history', accountId: account.accountId }, action: 'enumerate_history', result: items.length ? 'items_found' : 'no_match',
          attemptState: 'succeeded', stopReason: null, accessBoundary: null, remainingUnknown: null, note: null, synthetic: true,
          provenance: PROVENANCE, refs: emptyRefs(), items, nextCursor: 'synthetic-page-2', knownGaps: []
        };
        const dependency = sources.find(source => source.accountId === account.accountId);
        if (dependency) draft.refs.evidenceIds.push(dependency.evidenceId);
        const previous = observation(draft);
        observation({ ...draft, items: items.map((item, i) => i === 0 ? { ...item, hasMedia: 'none' } : item),
          refs: { ...emptyRefs(), observationIds: [previous.observationId] },
          nextCursor: options.enumeration === 'unknown' ? 'synthetic-page-3' : null,
          stopReason: options.enumeration === 'unknown' ? null : 'endpoint_exhausted' });
      }
    }
    if (drafts.length) {
      coverage.recordFetchBatch({ ...context, receipts: drafts });
      coverage.recordFetchBatch({ ...context, receipts: drafts.slice(0, 2) }); // Replay is a no-op.
    }
  })();
  return { db, cases, completion, coverage, ownerId: OWNER, caseId: record.caseId, frozen, sources, drafts,
    read: (store: FetchCoverageStore = coverage): FetchCoverageView => {
      const view = store.getFetchCoverageView(OWNER, record.caseId, frozen.scopeSpecId);
      assert.ok(view);
      return view;
    },
    revoke: () => {
      const first = sources[0]; assert.ok(first);
      cases.revokeEvidence({ ...context, accountId: first.accountId }, first.evidenceId);
    },
    stale: () => cases.applyCaseScopeMutation({ ...context, advance: true, reason: 'synthetic scope change' })
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const Baseline = await loadBaseline();
  const results = [];
  for (const options of [{ accounts: 12, itemsPerAccount: 20, branches: 3 }, { accounts: 60, itemsPerAccount: 40, branches: 3 }]) {
    const fixture = coverageFixture(options);
    try {
      const baseline = new Baseline(fixture.db, fixture.cases, fixture.completion);
      const expected = JSON.stringify(fixture.read(baseline));
      assert.equal(JSON.stringify(fixture.read()), expected, 'full serialized projection differs from baseline');
      for (let i = 0; i < 3; i += 1) { fixture.read(baseline); fixture.read(); }
      const before: number[] = [], after: number[] = [];
      // Alternate measurement order to reduce systematic warm-cache/order bias.
      for (let i = 0; i < 9; i += 1) {
        for (const kind of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
          const start = performance.now();
          const view = fixture.read(kind === 'before' ? baseline : fixture.coverage);
          (kind === 'before' ? before : after).push(performance.now() - start);
          assert.equal(JSON.stringify(view), expected, 'a repeated projection changed');
        }
      }
      const counts = (store: FetchCoverageStore) => {
        let reads = 0;
        const prepare = fixture.db.prepare;
        fixture.db.prepare = ((sql: string) => {
          if (/^SELECT\b/i.test(sql.trim())) reads += 1;
          return prepare.call(fixture.db, sql);
        }) as typeof prepare;
        try { fixture.read(store); return reads; } finally { fixture.db.prepare = prepare; }
      };
      results.push({ fixture: options, receipts: fixture.drafts.length, outputBytes: Buffer.byteLength(expected),
        outputSha256: createHash('sha256').update(expected).digest('hex'), byteEquivalent: true,
        baselineSelects: counts(baseline), modifiedSelects: counts(fixture.coverage),
        baselineMs: { samples: before, median: median(before) }, modifiedMs: { samples: after, median: median(after) },
        speedup: median(before) / median(after) });
      console.error(`coverage ${options.accounts * options.itemsPerAccount} items: ${median(before).toFixed(2)} -> ${median(after).toFixed(2)} ms`);
    } finally { fixture.db.close(); }
  }
  const result = { schemaVersion: 1, baselineRevision: BASELINE_REVISION, node: process.version,
    modifiedSourceSha256: createHash('sha256').update(readFileSync(new URL('../src/server/research/fetch-coverage-store.ts', import.meta.url))).digest('hex'),
    harnessSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    platform: process.platform, arch: process.arch, createdAt: new Date().toISOString(),
    scope: 'Offline synthetic SQLite in-memory production getFetchCoverageView; setup, stringify and instrumentation excluded from timing; no network or production-latency claim.',
    warmups: 3, repetitions: 9, results };
  const serialized = JSON.stringify(result, null, 2) + '\n';
  if (outputIndex >= 0) {
    const output = args[outputIndex + 1]; assert.ok(output, '--output needs a filename');
    mkdirSync(dirname(resolve(output)), { recursive: true }); writeFileSync(output, serialized);
  } else process.stdout.write(serialized);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
