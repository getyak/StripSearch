/**
 * GET-99 real GitHub Fetch acquisition tests (phase 1) over REAL SQLite with
 * an injected offline HttpTransport. No external network, no paid calls.
 *
 * Covers the confirmed acceptance boundaries: explicit permission before any
 * HTTP, real canonicalized Link pagination across pages (numeric
 * /repositories/{verified id}/issues + after cursors), exact complete body
 * hashes including bodies beyond the old truncation windows, same-source
 * dedupe with per-comment original attribution (third-party/unknown roles),
 * strict public-only targets, late pause/resume and scope-change packets
 * never persisted, unknown outcomes stopping before any next HTTP with
 * explicit retry/skip reconciliation only, restart fail-stop, and zero
 * repeated successful HTTP after close/reopen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FetchGithubStore } from '../server/research/fetch-github-store.js';
import { FetchGithubRunner } from '../server/research/fetch-github-runner.js';
import {
  executeAcquisitionQuantum,
  freezeSnapshot,
  parseCommentRow,
  planNextRequest
} from '../server/research/fetch-github-acquisition.js';
import { buildGithubSnapshotCatalog, createCachedGithubHandlers } from '../server/research/fetch-github-catalog.js';
import type { HttpResponseLike, HttpTransport } from '../server/adapters/types.js';
import { deferred } from './fakes.js';

const ARTIFACT = process.env.STRIPSEARCH_TEST_ARTIFACT_DIR ?? tmpdir();

interface StubCall {
  url: string;
  headers: Record<string, string>;
}

interface StubRoute {
  status?: number;
  body: unknown;
  link?: string | null;
  /** Defer this response until manually released. */
  gate?: Promise<void>;
  /** Throw a transport-level fault (unknown outcome). */
  fault?: 'io';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Stub routing key: pathname + canonically sorted query, so generated
 * canonical URLs and real Link continuations match the same fixture.
 */
function normalizeKey(url: string): string {
  const parsed = new URL(url, 'https://api.github.com');
  const entries = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return parsed.pathname + (entries ? `?${entries}` : '');
}

function makeTransport(routes: Map<string, StubRoute>, calls: StubCall[]): HttpTransport {
  const normalized = new Map([...routes].map(([key, route]) => [normalizeKey(`https://api.github.com${key}`), route]));
  return {
    async fetch(url, init): Promise<HttpResponseLike> {
      calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      const route = normalized.get(normalizeKey(url));
      if (!route) throw new Error(`unexpected stub URL ${url}`);
      if (route.gate) await route.gate;
      if (route.fault === 'io') throw new Error('synthetic transport fault');
      const text = JSON.stringify(route.body);
      return {
        status: route.status ?? 200,
        ok: (route.status ?? 200) < 300,
        redirected: false,
        headers: {
          get(name: string): string | null {
            if (name.toLowerCase() === 'link') return route.link ?? null;
            if (name.toLowerCase() === 'x-github-api-version') return '2026-03-10';
            return null;
          }
        },
        text: async () => text
      };
    }
  };
}

const REPO_ID = 1378367626;

function repoRoutes(options: { commentsBody?: unknown; issueBody?: unknown } = {}): Map<string, StubRoute> {
  const issueBody = options.issueBody ?? 'Synthetic exact issue body';
  return new Map<string, StubRoute>([
    ['/users/fixture', { body: { login: 'fixture', id: 42, type: 'User' } }],
    [
      '/repos/fixture/repo',
      { body: { id: REPO_ID, name: 'repo', private: false, owner: { login: 'fixture' }, html_url: 'https://github.com/fixture/repo' } }
    ],
    [
      '/repos/fixture/repo/issues?state=all&sort=created&direction=asc&per_page=30',
      {
        body: [
          {
            number: 1,
            html_url: 'https://github.com/fixture/repo/issues/1',
            title: 'Synthetic issue',
            body: issueBody,
            user: { login: 'writer', id: 44 },
            comments: 1
          },
          {
            number: 2,
            html_url: 'https://github.com/fixture/repo/pull/2',
            title: 'Synthetic pull request',
            body: 'Synthetic PR body',
            user: null,
            pull_request: {},
            comments: 1
          }
        ],
        // The REAL canonicalized continuation observed on 2026-03-10
        // responses: numeric repository id + bounded after cursor.
        link: `<https://api.github.com/repositories/${String(REPO_ID)}/issues?state=all&sort=created&direction=asc&per_page=30&page=2&after=Y3Vyc29yOnYyOpLPAAABoMHAUxDPAAAAAUkjHco%3D>; rel="next"`
      }
    ],
    [
      `/repositories/${String(REPO_ID)}/issues?state=all&sort=created&direction=asc&per_page=30&page=2&after=Y3Vyc29yOnYyOpLPAAABoMHAUxDPAAAAAUkjHco%3D`,
      {
        body: [
          {
            number: 3,
            html_url: 'https://github.com/fixture/repo/issues/3',
            title: 'Synthetic second page issue',
            body: 'Synthetic second page body',
            user: { login: 'fixture', id: 42 },
            comments: 1
          }
        ]
      }
    ],
    [
      '/repos/fixture/repo/issues/1/comments?per_page=30',
      {
        body: [
          {
            id: 9001,
            html_url: 'https://github.com/fixture/repo/issues/1#issuecomment-9001',
            user: { login: 'writer', id: 44 },
            body: 'Synthetic third-party comment body',
            created_at: '2026-03-01T00:00:00Z'
          },
          {
            id: 9002,
            html_url: 'https://github.com/fixture/repo/issues/1#issuecomment-9002',
            user: null,
            body: 'Synthetic unknown-author comment body',
            created_at: '2026-03-02T00:00:00Z'
          }
        ]
      }
    ],
    ['/repos/fixture/repo/issues/2/comments?per_page=30', { body: options.commentsBody ?? [] }],
    [
      '/repos/fixture/repo/issues/3/comments?per_page=30',
      {
        body: [
          {
            id: 9003,
            html_url: 'https://github.com/fixture/repo/issues/3#issuecomment-9003',
            user: { login: 'fixture', id: 42 },
            body: 'Synthetic subject comment body',
            created_at: '2026-03-03T00:00:00Z'
          }
        ]
      }
    ]
  ]);
}

interface Fixture {
  db: DB;
  store: Store;
  journal: FetchGithubStore;
  dir: string;
  dbPath: string;
}

function openFixture(): Fixture {
  const dir = mkdtempSync(path.join(ARTIFACT, 'fetch-acq-'));
  const dbPath = path.join(dir, 'fetch.db');
  const db = openDatabase(dbPath);
  applyCoreSchema(db);
  return { db, store: new Store(db), journal: new FetchGithubStore(db, new Store(db)), dir, dbPath };
}

function makeRunner(db: DB, store: Store, transport: HttpTransport, githubToken: string | null = null): FetchGithubRunner {
  return new FetchGithubRunner({ db, store, transport, githubToken, pollIntervalMs: 5 });
}

function startRepoRun(runner: FetchGithubRunner, question = 'Synthetic repository question'): string {
  const targetUrl = 'https://github.com/fixture/repo';
  const view = runner.start({
    ownerId: 'synthetic-owner-a',
    targetUrl,
    question,
    accessScope: 'github_public_repository',
    confirmation: true,
    confirmedTarget: targetUrl,
    confirmedQuestion: question,
    confirmedAccessScope: 'github_public_repository'
  });
  return view.runId;
}

async function drainAcquisition(
  store: Store,
  journal: FetchGithubStore,
  runId: string,
  transport: HttpTransport,
  limit = 12,
  githubToken: string | null = null
): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    const run = journal.requireRun(runId);
    if (run.checkpoint.snapshot.frozen) return;
    const result = await executeAcquisitionQuantum(
      run,
      { store, journal, transport, githubToken },
      new AbortController().signal
    );
    if (result.outcome === 'done') {
      const fresh = journal.requireRun(runId);
      if (journal.listUnresolvedRequests(runId).length === 0) freezeSnapshot(fresh, journal);
      return;
    }
    if (result.outcome === 'stopped') return;
    if (result.unknownOutcome) return;
  }
}

test('real Link pagination captures both pages with exact body hashes and per-comment attribution', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const transport = makeTransport(repoRoutes(), calls);
  const runner = makeRunner(fixture.db, fixture.store, transport);
  const runId = startRepoRun(runner);
  await drainAcquisition(fixture.store, fixture.journal, runId, transport);

  const run = fixture.journal.requireRun(runId);
  assert.equal(run.checkpoint.snapshot.frozen, true, 'snapshot freezes after the real two-page Link chain');
  const items = fixture.journal.listItems(runId);
  assert.deepEqual(
    items.map((item) => item.itemKey).sort(),
    ['issue:fixture/repo#1', 'issue:fixture/repo#2', 'issue:fixture/repo#3'],
    'issues INCLUDING pull requests are captured across both Link pages'
  );

  // Exact complete returned bodies are journaled and hashed exactly.
  const requests = fixture.journal.listRequests(runId);
  const pageOne = requests.find((request) => request.url.includes('/repos/fixture/repo/issues?'))!;
  assert.equal(pageOne.state, 'succeeded');
  assert.equal(pageOne.bodyHash, sha256(pageOne.body ?? ''), 'exact complete returned body hash');
  assert.ok((pageOne.body ?? '').includes('Synthetic exact issue body'), 'body preserved without truncation');

  // Same-source dedupe: one frozen capture per item key.
  const issueOne = items.find((item) => item.itemKey === 'issue:fixture/repo#1')!;
  assert.equal(issueOne.bodyHash, sha256('Synthetic exact issue body'));
  const again = fixture.journal.putItem({
    runId,
    itemKey: 'issue:fixture/repo#1',
    kind: 'issue',
    accountId: issueOne.accountId,
    title: 'Synthetic issue',
    originalUrl: 'https://github.com/fixture/repo/issues/1',
    authorLogin: 'writer',
    authorId: 44,
    publishedAt: null,
    fulltext: 'Synthetic exact issue body',
    bodyHash: issueOne.bodyHash,
    sourceId: issueOne.sourceId,
    sourceRevision: issueOne.sourceRevision,
    requestKey: 'x',
    processingEligible: true,
    processingGap: null
  });
  assert.equal(again.outcome, 'duplicate', 'identical recapture dedupes; a changed hash keeps the first frozen capture');

  // Per-comment original attribution: actual login/id, original permalink,
  // complete body, third-party/unknown roles preserved.
  const comments = fixture.journal.listComments(runId, 'issue:fixture/repo#1');
  assert.equal(comments.length, 2);
  const third = comments.find((comment) => comment.commentId === 'issuecomment-9001')!;
  assert.equal(third.authorLogin, 'writer');
  assert.equal(third.authorId, 44);
  assert.equal(third.authorRole, 'third_party');
  assert.equal(third.originalUrl, 'https://github.com/fixture/repo/issues/1#issuecomment-9001');
  assert.equal(third.body, 'Synthetic third-party comment body');
  const unknown = comments.find((comment) => comment.commentId === 'issuecomment-9002')!;
  assert.equal(unknown.authorRole, 'unknown');
  assert.equal(unknown.authorLogin, null);
  const subject = fixture.journal.listComments(runId, 'issue:fixture/repo#3')[0]!;
  assert.equal(subject.authorRole, 'subject');

  // Persisted successful requests are never repeated.
  const before = calls.length;
  await drainAcquisition(fixture.store, fixture.journal, runId, transport);
  assert.equal(calls.length, before, 'zero repeated successful HTTP after the plan drained');
  await runner.stopAll();
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});

test('long bodies keep exact hashes across close/reopen with no repeated successful HTTP', async () => {
  const fixture = openFixture();
  const longBody = `Synthetic long body ${'x'.repeat(20_000)} end`;
  const calls: StubCall[] = [];
  const transport = makeTransport(repoRoutes({ issueBody: longBody }), calls);
  const runner = makeRunner(fixture.db, fixture.store, transport);
  const runId = startRepoRun(runner);

  // Interrupt mid-acquisition, then close the database file.
  await executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );
  await executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );
  const succeededBefore = fixture.journal
    .listRequests(runId)
    .filter((request) => request.state === 'succeeded')
    .map((request) => request.requestKey);
  assert.equal(succeededBefore.length, 2, 'two settled requests before the interruption');
  await runner.stopAll();
  fixture.db.close();

  // Reopen the SAME file: recovery is explicit and resumable.
  const db2 = openDatabase(fixture.dbPath);
  const store2 = new Store(db2);
  const journal2 = new FetchGithubStore(db2, store2);
  const runner2 = makeRunner(db2, store2, makeTransport(repoRoutes({ issueBody: longBody }), calls));
  assert.equal(runner2.recoverInterrupted(), 1, 'the interrupted run stops honestly at boot');
  assert.equal(journal2.requireRun(runId).state, 'paused', 'restart without in-flight outcomes pauses, never replays');
  runner2.resume(runId, 'synthetic-owner-a', { reconcileUnknown: 'skip' });
  await drainAcquisition(store2, journal2, runId, makeTransport(repoRoutes({ issueBody: longBody }), calls));

  const item = journal2.listItems(runId).find((entry) => entry.itemKey === 'issue:fixture/repo#1')!;
  assert.equal(item.fulltext, longBody, 'complete long body preserved exactly beyond any truncation window');
  assert.equal(item.bodyHash, sha256(longBody), 'exact hash over the complete body, not a truncation');
  const succeededAfter = journal2
    .listRequests(runId)
    .filter((request) => request.state === 'succeeded')
    .map((request) => request.requestKey);
  for (const key of succeededBefore) {
    assert.equal(succeededAfter.filter((entry) => entry === key).length, 1, `succeeded ${key} exactly once`);
    assert.ok(succeededAfter.includes(key), `persisted successful ${key} is never repeated or lost`);
  }
  assert.equal(journal2.requireRun(runId).checkpoint.snapshot.frozen, true);
  assert.equal(planNextRequest(journal2.requireRun(runId), journal2), null);
  db2.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});

test('malformed comment pages and rows stay explicit gaps, never a fabricated empty capture', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const transport = makeTransport(repoRoutes({ commentsBody: { message: 'Synthetic malformed 200 comment page' } }), calls);
  const runner = makeRunner(fixture.db, fixture.store, transport);
  const runId = startRepoRun(runner);
  await drainAcquisition(fixture.store, fixture.journal, runId, transport);
  const run = fixture.journal.requireRun(runId);

  const commentRequest = fixture.journal
    .listRequests(runId)
    .find((request) => request.url.includes('/issues/2/comments'))!;
  assert.equal(commentRequest.state, 'succeeded', 'HTTP settlement stays truthful');
  assert.equal(commentRequest.semanticState, 'invalid', 'semantic capture is separate from HTTP settlement');
  assert.ok(run.checkpoint.gaps.some((gap) => gap.code === 'comment_shape_invalid'));

  const built = buildGithubSnapshotCatalog(fixture.journal, run);
  assert.equal(built.commentCapture.get('issue:fixture/repo#2'), 'invalid', 'malformed page is not a captured comment page');

  // The cached handler refuses instead of returning a successful empty page.
  const handlers = createCachedGithubHandlers({
    store: fixture.store,
    journal: fixture.journal,
    run,
    catalog: built.catalog,
    commentCapture: built.commentCapture
  });
  const item = fixture.journal.listItems(runId).find((entry) => entry.itemKey === 'issue:fixture/repo#2')!;
  await assert.rejects(
    () =>
      handlers.list_comments!({
        input: { accountId: item.accountId, itemId: item.itemKey },
        trusted: {} as never,
        cursor: { token: null, nativeCursor: null },
        requests: {} as never,
        signal: new AbortController().signal
      }),
    /comment page not captured/,
    'cached processing refuses an uncaptured comment page'
  );

  // A numeric/structured comment body is unparseable material: rejected row,
  // never a fabricated empty full text.
  const malformedRow = parseCommentRow(
    { id: 10, html_url: 'https://github.com/fixture/repo/issues/1#issuecomment-10', user: { login: 'writer', id: 44 }, body: 123 },
    'fixture',
    'repo',
    1,
    'fixture'
  );
  assert.equal(malformedRow, null, 'non-string comment body is refused');
  await runner.stopAll();
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});

test('pause->resume fences the outstanding response: no body, no capture, no automatic retry', async () => {
  const fixture = openFixture();
  const release = deferred<void>();
  const routes = repoRoutes();
  routes.set('/users/fixture', { body: { login: 'fixture', id: 42, type: 'User' }, gate: release.promise });
  const calls: StubCall[] = [];
  const transport = makeTransport(routes, calls);
  const runner = makeRunner(fixture.db, fixture.store, transport);
  const runId = startRepoRun(runner);

  const quantum = executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Control fence: pause bumps the run revision while the response is still
  // outstanding; resume advances to a new generation and explicitly
  // reconciles the unknown outcome as skip.
  runner.pause(runId, 'synthetic-owner-a');
  runner.resume(runId, 'synthetic-owner-a', { reconcileUnknown: 'skip' });
  release.resolve();
  const result = await quantum;
  assert.equal(result.outcome, 'stopped', 'the old-generation packet is rejected');
  const requests = fixture.journal.listRequests(runId);
  const profile = requests.find((request) => request.kind === 'profile')!;
  assert.equal(profile.body, null, 'late packet body is never persisted');
  assert.equal(profile.state, 'unknown', 'the fenced request outcome is unknown, never a silent success');
  assert.ok(
    fixture.journal.requireRun(runId).checkpoint.gaps.some((gap) => gap.code === 'late_packet_rejected'),
    'the rejection is an explicit gap'
  );

  // Skip reconciliation: the unknown outcome is never automatically retried;
  // the rest of the plan proceeds.
  await drainAcquisition(fixture.store, fixture.journal, runId, transport);
  const profileCalls = calls.filter((call) => call.url.includes('/users/fixture')).length;
  assert.equal(profileCalls, 1, 'a skip-reconciled unknown outcome is never automatically retried');
  assert.ok(calls.length > 1, 'other planned requests still proceed');
  await runner.stopAll();
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});

test('unknown outcomes stop before any next HTTP until explicit retry; restart stays unreconciled', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const routes = repoRoutes();
  routes.set('/users/fixture', { body: { login: 'fixture', id: 42, type: 'User' }, fault: 'io' });
  const transport = makeTransport(routes, calls);
  const runner = makeRunner(fixture.db, fixture.store, transport);
  const runId = startRepoRun(runner);

  await executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );
  assert.equal(fixture.journal.listUnresolvedRequests(runId).length, 1, 'unknown outcome stays unresolved');
  const afterFault = calls.length;
  const blocked = await executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );
  assert.equal(blocked.outcome, 'stopped', 'no next HTTP before explicit reconciliation');
  assert.equal(calls.length, afterFault, 'zero requests dispatched while an outcome is unknown');

  // Restart with the unresolved outcome: the run stops as unreconciled.
  await runner.stopAll();
  fixture.db.close();
  const db2 = openDatabase(fixture.dbPath);
  const store2 = new Store(db2);
  const journal2 = new FetchGithubStore(db2, store2);
  const runner2 = makeRunner(db2, store2, transport);
  assert.equal(runner2.recoverInterrupted(), 1);
  assert.equal(journal2.requireRun(runId).state, 'unreconciled', 'unresolved in-flight outcome stops as unreconciled');

  // Explicit retry: a fresh journaled attempt with the prior cost unknown.
  runner2.resume(runId, 'synthetic-owner-a', { reconcileUnknown: 'retry' });
  await executeAcquisitionQuantum(
    journal2.requireRun(runId),
    { store: store2, journal: journal2, transport, githubToken: null },
    new AbortController().signal
  );
  const profileAttempts = journal2.listRequests(runId).filter((request) => request.kind === 'profile');
  assert.equal(profileAttempts.length, 2, 'the retry is a new journaled attempt, not a blind replay');
  assert.equal(profileAttempts[0]!.state, 'unknown', 'prior unknown outcome and cost stay honest');
  assert.equal(profileAttempts[1]!.attempt, 2);
  await runner2.stopAll();
  db2.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});

test('changed CaseStore scope blocks before HTTP and forbids the late packet', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const transport = makeTransport(repoRoutes(), calls);
  const runner = makeRunner(fixture.db, fixture.store, transport);
  const runId = startRepoRun(runner);
  await executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );

  // A new authoritative scope version freezes the run out.
  const run = fixture.journal.requireRun(runId);
  fixture.store.cases.applyScopeChange({
    ownerId: run.ownerId,
    caseId: run.caseId,
    expectedScopeVersion: fixture.store.cases.getCase(run.ownerId, run.caseId)!.scopeVersion,
    reason: 'synthetic scope drift',
    accounts: []
  });
  const before = calls.length;
  const result = await executeAcquisitionQuantum(
    fixture.journal.requireRun(runId),
    { store: fixture.store, journal: fixture.journal, transport, githubToken: null },
    new AbortController().signal
  );
  assert.equal(result.outcome, 'stopped', 'scope drift stops the acquisition');
  assert.equal(calls.length, before, 'scope drift blocks BEFORE any HTTP request');
  await runner.stopAll();
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});

test('private targets stay gaps even with a token; only generated api.github.com URLs carry credentials', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const routes = new Map<string, StubRoute>([
    ['/users/fixture', { body: { login: 'fixture', id: 42, type: 'User' } }],
    [
      '/repos/fixture/repo',
      { body: { id: REPO_ID, name: 'repo', private: true, owner: { login: 'fixture' }, html_url: 'https://github.com/fixture/repo' } }
    ]
  ]);
  const transport = makeTransport(routes, calls);
  const runner = makeRunner(fixture.db, fixture.store, transport, 'synthetic-token');
  const runId = startRepoRun(runner, 'Synthetic private target question');
  await drainAcquisition(fixture.store, fixture.journal, runId, transport, 12, 'synthetic-token');
  const run = fixture.journal.requireRun(runId);
  assert.ok(run.checkpoint.gaps.some((gap) => gap.code === 'private_target'), 'private target stays an explicit gap');
  assert.equal(fixture.journal.listItems(runId).length, 0, 'no material is captured from a private target');
  assert.equal(fixture.journal.listRequests(runId).filter((request) => request.kind === 'issues_list').length, 0);

  for (const call of calls) {
    assert.ok(call.url.startsWith('https://api.github.com/'), 'only generated api.github.com paths reach the transport');
    assert.equal(call.headers.authorization, 'Bearer synthetic-token', 'token routed only to validated api.github.com URLs');
  }
  await runner.stopAll();
  fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
});
