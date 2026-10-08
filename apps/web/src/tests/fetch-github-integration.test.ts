/**
 * GET-99 real GitHub Fetch end-to-end integration (offline): REAL SQLite,
 * an injected fake HttpTransport and the REAL worker loop — start → public
 * profile/repository metadata → multiple actual Link issue/PR pages → first
 * page comments → frozen snapshot → production cached processing through the
 * real GET-59 dispatch / GET-95 coverage / GET-60 completion stores.
 *
 * Asserts the honest boundaries: pending evidence with source links and
 * exact quotes, unanswered research questions and a non-complete assessment,
 * third-party/unknown authorship preserved with the publisher boundary kept
 * separate, malformed comment pages never becoming successful comments
 * receipts even after the snapshot froze, media never fabricated as absent,
 * and ZERO external HTTP in the processing phase with honest zero external
 * model usage.
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
  buildGithubSnapshotCatalog,
  createCachedGithubHandlers,
  createNoNetworkCachedExecutor
} from '../server/research/fetch-github-catalog.js';
import { createResearchToolServer } from '../server/research/research-tool-dispatch.js';
import type {
  AccountingPort,
  RequestOutcome,
  RequestReservation,
  ReserveRequest,
  TrustedContext
} from '../server/research/research-tool-dispatch.js';
import { createGithubCapabilitySnapshot } from '../server/research/fetch-github-catalog.js';
import type { HttpResponseLike, HttpTransport } from '../server/adapters/types.js';
import { waitFor } from './harness.js';

const ARTIFACT = process.env.STRIPSEARCH_TEST_ARTIFACT_DIR ?? tmpdir();

interface StubCall {
  url: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function jsonResponse(body: unknown, link: string | null = null): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status: 200,
    ok: true,
    redirected: false,
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === 'link') return link;
        return null;
      }
    },
    text: async () => text
  };
}

const REPO_ID = 1378367626;

function normalizeKey(url: string): string {
  const parsed = new URL(url, 'https://api.github.com');
  const entries = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return parsed.pathname + (entries ? `?${entries}` : '');
}

function repoTransport(calls: StubCall[]): HttpTransport {
  const routes = new Map<string, (url: URL) => HttpResponseLike>([
    ['/users/fixture', () => jsonResponse({ login: 'fixture', id: 42, type: 'User' })],
    [
      '/repos/fixture/repo',
      () =>
        jsonResponse({
          id: REPO_ID,
          name: 'repo',
          private: false,
          owner: { login: 'fixture' },
          html_url: 'https://github.com/fixture/repo'
        })
    ],
    [
      '/repos/fixture/repo/issues',
      () =>
        jsonResponse(
          [
            {
              number: 1,
              html_url: 'https://github.com/fixture/repo/issues/1',
              title: 'Synthetic issue by a third party',
              body: `Synthetic long issue body ${'y'.repeat(12_000)} end`,
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
          `<https://api.github.com/repositories/${String(REPO_ID)}/issues?state=all&sort=created&direction=asc&per_page=30&page=2&after=Y3Vyc29yOnYyOpLPAAABoMHAUxDPAAAAAUkjHco%3D>; rel="next"`
        )
    ],
    [
      '/repositories/1378367626/issues',
      () =>
        jsonResponse([
          {
            number: 3,
            html_url: 'https://github.com/fixture/repo/issues/3',
            title: 'Synthetic subject issue',
            body: 'Synthetic subject issue body',
            user: { login: 'fixture', id: 42 },
            comments: 1
          }
        ])
    ],
    [
      '/repos/fixture/repo/issues/1/comments',
      () =>
        jsonResponse([
          {
            id: 9001,
            html_url: 'https://github.com/fixture/repo/issues/1#issuecomment-9001',
            user: { login: 'writer', id: 44 },
            body: 'Synthetic third-party comment body',
            created_at: '2026-03-01T00:00:00Z'
          }
        ])
    ],
    // Confirmed counterexample: a 200 with a non-array comment payload must
    // never become a successful comments read.
    ['/repos/fixture/repo/issues/2/comments', () => jsonResponse({ message: 'Synthetic malformed 200 comment page' })],
    [
      '/repos/fixture/repo/issues/3/comments',
      () =>
        jsonResponse([
          {
            id: 9003,
            html_url: 'https://github.com/fixture/repo/issues/3#issuecomment-9003',
            user: { login: 'fixture', id: 42 },
            body: 'Synthetic subject comment body',
            created_at: '2026-03-03T00:00:00Z'
          }
        ])
    ]
  ]);
  return {
    async fetch(url): Promise<HttpResponseLike> {
      calls.push({ url });
      const parsed = new URL(url);
      const route = routes.get(parsed.pathname) ?? routes.get(normalizeKey(url));
      if (!route) throw new Error(`unexpected stub URL ${url}`);
      return route(parsed);
    }
  };
}

function orgRepoTransport(calls: StubCall[]): HttpTransport {
  const readmeContent = Buffer.from('Synthetic README snapshot text', 'utf8').toString('base64');
  const routes = new Map<string, (url: URL) => HttpResponseLike>([
    ['/users/fixture-org', () => jsonResponse({ login: 'fixture-org', id: 7, type: 'Organization' })],
    [
      '/orgs/fixture-org/repos',
      () =>
        jsonResponse([
          {
            id: 77,
            name: 'toolkit',
            private: false,
            fork: false,
            owner: { login: 'fixture-org' },
            html_url: 'https://github.com/fixture-org/toolkit'
          }
        ])
    ],
    [
      '/repos/fixture-org/toolkit/readme',
      () =>
        jsonResponse({
          name: 'README.md',
          path: 'README.md',
          type: 'file',
          encoding: 'base64',
          content: readmeContent.replace(/(.{60})/g, '$1\n'),
          size: Buffer.byteLength('Synthetic README snapshot text', 'utf8'),
          sha: 'synthetic-blob-sha',
          html_url: 'https://github.com/fixture-org/toolkit/blob/main/README.md'
        })
    ]
  ]);
  return {
    async fetch(url): Promise<HttpResponseLike> {
      calls.push({ url });
      const parsed = new URL(url);
      const route = routes.get(parsed.pathname);
      if (!route) throw new Error(`unexpected stub URL ${url}`);
      return route(parsed);
    }
  };
}

interface Fixture {
  db: DB;
  store: Store;
  journal: FetchGithubStore;
  dir: string;
}

function openFixture(): Fixture {
  const dir = mkdtempSync(path.join(ARTIFACT, 'fetch-int-'));
  const db = openDatabase(path.join(dir, 'fetch.db'));
  applyCoreSchema(db);
  const store = new Store(db);
  return { db, store, journal: new FetchGithubStore(db, store), dir };
}

test('full worker chain: real Link pages -> frozen snapshot -> GET-59/95/60 with honest partial boundaries', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const runner = new FetchGithubRunner({
    db: fixture.db,
    store: fixture.store,
    transport: repoTransport(calls),
    githubToken: null,
    pollIntervalMs: 5
  });
  const targetUrl = 'https://github.com/fixture/repo';
  const question = 'Synthetic repository research question';
  const started = runner.start({
    ownerId: 'synthetic-owner-int',
    targetUrl,
    question,
    accessScope: 'github_public_repository',
    confirmation: true,
    confirmedTarget: targetUrl,
    confirmedQuestion: question,
    confirmedAccessScope: 'github_public_repository'
  });
  runner.ensureRunning();
  try {
    await waitFor(() => runner.view(started.runId, 'synthetic-owner-int')?.state === 'finished', 20_000, 10);
    const view = runner.view(started.runId, 'synthetic-owner-int')!;

    // Phase 1: exactly the scripted acquisition requests, no extras (phase 2
    // is zero-HTTP).
    assert.equal(calls.length, 7, 'profile + repo metadata + 2 issue pages + 3 comment pages only');
    for (const call of calls) assert.ok(call.url.startsWith('https://api.github.com/'));

    // Captured material: issues INCLUDING the pull request across both Link
    // pages, with actual third-party/unknown authors preserved and the
    // publisher boundary kept separate (case-bound account id).
    assert.equal(view.items.length, 3);
    const byKey = new Map(view.items.map((item) => [item.itemKey, item]));
    const issueOne = byKey.get('issue:fixture/repo#1')!;
    assert.equal(issueOne.authorLogin, 'writer', 'actual third-party author is preserved');
    assert.equal(issueOne.fulltext, `Synthetic long issue body ${'y'.repeat(12_000)} end`, 'complete body, no truncation');
    assert.equal(issueOne.contentHash, sha256(issueOne.fulltext), 'exact body hash');
    const issueTwo = byKey.get('issue:fixture/repo#2')!;
    assert.equal(issueTwo.kind, 'pull_request');
    assert.equal(issueTwo.authorLogin, null, 'unknown author stays unknown');
    assert.ok(issueOne.sourceId !== issueTwo.sourceId, 'each material carries its own immutable source pin');

    // Per-comment original attribution with roles and permalinks.
    const comments = issueOne.comments;
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.authorRole, 'third_party');
    assert.equal(comments[0]!.originalUrl, 'https://github.com/fixture/repo/issues/1#issuecomment-9001');

    // Pending evidence: source links and plain quotes from the real captures.
    assert.ok(view.pendingEvidence.length >= 3, 'each captured body becomes pending evidence');
    const evidence = view.pendingEvidence.find((entry) => entry.sourceId === issueOne.sourceId)!;
    assert.equal(evidence.sourceUrl, 'https://github.com/fixture/repo/issues/1');
    assert.ok(evidence.quote.includes('Synthetic long issue body'), 'plain-text quote preserved');
    assert.equal(evidence.revokedAt, null);

    // Frozen limitations stay exposed with the run.
    assert.ok(view.limitations.some((limitation) => limitation.includes('issues（含 PR')));
    assert.ok(view.limitations.some((limitation) => limitation.includes('首页 issue 评论')));
    assert.ok(view.limitations.some((limitation) => limitation.includes('不读取私有资源')));

    // Phase 2 completed through the real pipeline.
    const processing = view.processing!;
    assert.equal(processing.state, 'finished');
    assert.equal(processing.counts!.providerRequests, 0, 'processing performs zero provider requests');
    assert.equal(processing.counts!.modelCalls, 0, 'ZERO external LLM calls for the deterministic scheduler');
    assert.ok(processing.counts!.schedulerDecisions > 0, 'local scheduler decisions reported separately');
    assert.equal(processing.counts!.modelInputTokens, 0);
    assert.equal(processing.counts!.modelOutputTokens, 0);
    assert.equal(processing.counts!.bodiesRead, 3, 'all captured bodies read through source-pinned processing');
    assert.equal(processing.counts!.commentsRead, 2, 'only semantically captured comment pages count as read');

    // Honest completion boundary: questions stay unanswered and the
    // assessment is never complete.
    assert.notEqual(processing.assessment?.verdict, 'complete');
    assert.ok(processing.remainingGaps.length > 0, 'partial boundaries stay explicit');
    assert.ok(processing.pendingFindings.length > 0, 'staged pending evidence is useful output');
    const caseId = fixture.journal.requireRun(started.runId).caseId;
    const observations = fixture.store.completion.listCompletionObservations(
      'synthetic-owner-int',
      caseId,
      view.scopeSpecId
    );
    assert.equal(
      observations.filter((observation) => observation.action === 'answer_question').length,
      0,
      'research questions stay unanswered without an implemented verifier'
    );

    // GET-95 receipts: malformed comment page is NOT a successful comments
    // read even though the snapshot froze; media is unknown, never fabricated
    // as absent.
    const coverage = fixture.store.fetchCoverage.getFetchCoverageView(
      'synthetic-owner-int',
      caseId,
      view.scopeSpecId
    );
    assert.ok(coverage, 'coverage projection exists');
    const coverageItems = coverage!.items;
    const coveredIssueTwo = coverageItems.find((item) => item.content.sourceId === issueTwo.sourceId)!;
    const commentsDimension = coveredIssueTwo.dimensions.find((dimension) => dimension.dimension.name === 'comments')!;
    assert.notEqual(commentsDimension.state, 'read', 'malformed comments request never becomes a successful read receipt');
    assert.ok(
      commentsDimension.state === 'failed' || commentsDimension.state === 'unread',
      `explicit unread/failed boundary, got ${commentsDimension.state}`
    );
    for (const item of coverageItems) {
      const media = item.dimensions.find((dimension) => dimension.dimension.name === 'media');
      if (media) assert.equal(media.state, 'unread', 'media stays explicitly unknown/unread, never fabricated absence');
    }
    assert.equal(view.snapshot.frozen, true, 'snapshot froze despite the comment gap (honest partial, not blocked)');
  } finally {
    await runner.stopAll();
    fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('account scope: org repos + README snapshots, structural comments N/A and media unknown', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const runner = new FetchGithubRunner({
    db: fixture.db,
    store: fixture.store,
    transport: orgRepoTransport(calls),
    githubToken: null,
    pollIntervalMs: 5
  });
  const targetUrl = 'https://github.com/fixture-org';
  const question = 'Synthetic account research question';
  const started = runner.start({
    ownerId: 'synthetic-owner-org',
    targetUrl,
    question,
    accessScope: 'github_public_account',
    confirmation: true,
    confirmedTarget: targetUrl,
    confirmedQuestion: question,
    confirmedAccessScope: 'github_public_account'
  });
  runner.ensureRunning();
  try {
    await waitFor(() => runner.view(started.runId, 'synthetic-owner-org')?.state === 'finished', 20_000, 10);
    const view = runner.view(started.runId, 'synthetic-owner-org')!;

    // Organizations enumerate through /orgs/{login}/repos (user/org endpoint
    // distinction preserved).
    assert.ok(calls.some((call) => call.url.includes('/orgs/fixture-org/repos')), 'org repositories endpoint used');
    assert.ok(!calls.some((call) => call.url.includes('/users/fixture-org/repos')), 'no user repos endpoint for an org');
    assert.equal(view.items.length, 1, 'README snapshot captured');
    const readme = view.items[0]!;
    assert.equal(readme.kind, 'readme');
    assert.equal(readme.fulltext, 'Synthetic README snapshot text');
    assert.equal(readme.authorLogin, null, 'README ownership never implies authorship');

    const processing = view.processing!;
    assert.equal(processing.state, 'finished');
    assert.equal(processing.counts!.modelCalls, 0);
    const run = fixture.journal.requireRun(started.runId);
    const coverage = fixture.store.fetchCoverage.getFetchCoverageView(
      'synthetic-owner-org',
      run.caseId,
      view.scopeSpecId
    )!;
    const readmeItem = coverage.items.find((item) => item.content.sourceId === readme.sourceId)!;
    const comments = readmeItem.dimensions.find((dimension) => dimension.dimension.name === 'comments');
    if (comments) {
      assert.notEqual(comments.state, 'read', 'README comment surface is structural N/A, never a fabricated read');
    }
    const media = readmeItem.dimensions.find((dimension) => dimension.dimension.name === 'media')!;
    assert.equal(media.state, 'unread', 'media unknown stays explicit');
    assert.notEqual(processing.assessment?.verdict, 'complete', 'questions stay unanswered');
  } finally {
    await runner.stopAll();
    fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('gateway source binding: trusted pin + real third-party author accepted; foreign pin/role/mode refused', async () => {
  const fixture = openFixture();
  const calls: StubCall[] = [];
  const runner = new FetchGithubRunner({
    db: fixture.db,
    store: fixture.store,
    transport: repoTransport(calls),
    githubToken: null,
    pollIntervalMs: 5
  });
  const targetUrl = 'https://github.com/fixture/repo';
  const question = 'Synthetic binding question';
  const started = runner.start({
    ownerId: 'synthetic-owner-bind',
    targetUrl,
    question,
    accessScope: 'github_public_repository',
    confirmation: true,
    confirmedTarget: targetUrl,
    confirmedQuestion: question,
    confirmedAccessScope: 'github_public_repository'
  });
  runner.ensureRunning();
  try {
    await waitFor(() => runner.view(started.runId, 'synthetic-owner-bind')?.state === 'finished', 20_000, 10);
    const run = fixture.journal.requireRun(started.runId);
    const built = buildGithubSnapshotCatalog(fixture.journal, run);
    const item = fixture.journal.listItems(started.runId).find((entry) => entry.itemKey === 'issue:fixture/repo#1')!;

    let reservationCount = 0;
    const accounting: AccountingPort = {
      reserve(request: ReserveRequest): RequestReservation {
        reservationCount += 1;
        return {
          actionId: `act-${String(reservationCount)}`,
          tool: request.tool,
          descriptor: 'descriptor' in request ? request.descriptor : { endpoint: request.tool, note: '' }
        };
      },
      settle(_reservation: RequestReservation, _outcome: RequestOutcome): void {
        /* in-memory only */
      }
    };
    const handlers = createCachedGithubHandlers({
      store: fixture.store,
      journal: fixture.journal,
      run,
      catalog: built.catalog,
      commentCapture: built.commentCapture
    });
    const tools = createResearchToolServer({
      store: fixture.store,
      handlers,
      executor: createNoNetworkCachedExecutor(),
      accounting
    });
    const trusted: TrustedContext = {
      ownerId: run.ownerId,
      caseId: run.caseId,
      role: 'fetch',
      phase: 'fetch',
      scopeVersion: run.scopeVersion,
      cancelled: false,
      accounts: [{ accountId: item.accountId, platform: 'github', handle: 'fixture', allowedScope: 'public_history' }],
      capabilities: createGithubCapabilitySnapshot(),
      skillPins: []
    };
    const dispatch = (input: Record<string, unknown>) =>
      tools.dispatch(trusted, { tool: 'read_post', input }, new AbortController().signal);

    // (a) Real cached capture: publisher boundary pin-verified, actual
    // third-party author preserved.
    const ok = await dispatch({ accountId: item.accountId, itemId: item.itemKey });
    assert.equal(ok.status, 'success', 'trusted source pin + third-party author is accepted');
    const okContent = ok.content as { item: { authorAccountId: string; sourceAccountId: string; authorRole: string } };
    assert.equal(okContent.item.authorAccountId, 'github:user:writer', 'actual author preserved in the tool view');
    assert.equal(okContent.item.sourceAccountId, item.accountId, 'publisher boundary stays the authorized account');
    assert.equal(okContent.item.authorRole, 'third_party');

    // (b) Absent/foreign source pin: refused even with a sourceAccountId.
    const forged = createResearchToolServer({
      store: fixture.store,
      handlers: {
        read_post: async () => ({
          item: {
            itemId: item.itemKey,
            sourceId: 'src-never-pinned',
            sourceRevision: 1,
            authorAccountId: 'github:user:writer',
            sourceAccountId: item.accountId,
            authorRole: 'third_party',
            title: 'Synthetic issue by a third party',
            text: 'Synthetic long issue body',
            metadata: {
              applicable: true,
              author: 'writer',
              originalUrl: 'https://github.com/fixture/repo/issues/1',
              publishedAt: null,
              retrievedAt: '2026-04-01T00:00:00.000Z',
              sourceRevision: 1,
              locator: item.itemKey
            }
          }
        })
      },
      executor: createNoNetworkCachedExecutor(),
      accounting
    });
    const forgedEnvelope = await forged.dispatch(
      trusted,
      { tool: 'read_post', input: { accountId: item.accountId, itemId: item.itemKey } },
      new AbortController().signal
    );
    assert.equal(forgedEnvelope.status, 'failed', 'an unproven source pin is refused');
    assert.match(String(forgedEnvelope.reason), /source pin|foreign|boundary|role/i);

    // (c) Wrong role: a foreign author can never declare itself subject.
    const wrongRole = createResearchToolServer({
      store: fixture.store,
      handlers: {
        read_post: async () => ({
          item: {
            itemId: item.itemKey,
            sourceId: item.sourceId,
            sourceRevision: item.sourceRevision,
            authorAccountId: 'github:user:writer',
            sourceAccountId: item.accountId,
            authorRole: 'subject',
            title: 'Synthetic issue by a third party',
            text: item.fulltext.slice(0, 200),
            metadata: {
              applicable: true,
              author: 'writer',
              originalUrl: 'https://github.com/fixture/repo/issues/1',
              publishedAt: null,
              retrievedAt: '2026-04-01T00:00:00.000Z',
              sourceRevision: item.sourceRevision,
              locator: item.itemKey
            }
          }
        })
      },
      executor: createNoNetworkCachedExecutor(),
      accounting
    });
    const wrongRoleEnvelope = await wrongRole.dispatch(
      trusted,
      { tool: 'read_post', input: { accountId: item.accountId, itemId: item.itemKey } },
      new AbortController().signal
    );
    assert.equal(wrongRoleEnvelope.status, 'failed', 'foreign author declared subject is refused');

    // (d) Old account-post mode without sourceAccountId: cross-account reads
    // stay refused exactly as before.
    const legacyForeign = createResearchToolServer({
      store: fixture.store,
      handlers: {
        read_post: async () => ({
          item: {
            itemId: item.itemKey,
            sourceId: item.sourceId,
            sourceRevision: item.sourceRevision,
            authorAccountId: 'github:user:writer',
            title: 'Synthetic issue by a third party',
            text: item.fulltext.slice(0, 200),
            metadata: {
              applicable: true,
              author: 'writer',
              originalUrl: 'https://github.com/fixture/repo/issues/1',
              publishedAt: null,
              retrievedAt: '2026-04-01T00:00:00.000Z',
              sourceRevision: item.sourceRevision,
              locator: item.itemKey
            }
          }
        })
      },
      executor: createNoNetworkCachedExecutor(),
      accounting
    });
    const legacyEnvelope = await legacyForeign.dispatch(
      trusted,
      { tool: 'read_post', input: { accountId: item.accountId, itemId: item.itemKey } },
      new AbortController().signal
    );
    assert.equal(legacyEnvelope.status, 'failed', 'ordinary account-post mode keeps its foreign-author refusal');
    assert.match(String(legacyEnvelope.reason), /foreign account/);
  } finally {
    await runner.stopAll();
    fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
