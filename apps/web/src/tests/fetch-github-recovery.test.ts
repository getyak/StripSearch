/** Real journal/worker regressions with synthetic responses; zero external HTTP. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FetchGithubStore } from '../server/research/fetch-github-store.js';
import { FetchGithubRunner } from '../server/research/fetch-github-runner.js';
import { executeAcquisitionQuantum } from '../server/research/fetch-github-acquisition.js';
import type { HttpResponseLike, HttpTransport } from '../server/adapters/types.js';

function response(body: unknown, status = 200): HttpResponseLike {
  return { status, ok: status >= 200 && status < 300, redirected: false,
    headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function fixture(transport: HttpTransport) {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db), journal = new FetchGithubStore(db, store);
  const runner = new FetchGithubRunner({ db, store, transport, githubToken: null, pollIntervalMs: 2 });
  const ownerId = 'synthetic-recovery-owner', targetUrl = 'https://github.com/fixture/repo';
  const question = 'Synthetic durable recovery acceptance';
  const run = runner.start({ ownerId, targetUrl, question, accessScope: 'github_public_repository',
    confirmation: true, confirmedTarget: targetUrl, confirmedQuestion: question,
    confirmedAccessScope: 'github_public_repository' });
  return { db, store, journal, runner, id: run.runId,
    step: () => executeAcquisitionQuantum(journal.requireRun(run.runId),
      { store, journal, transport, githubToken: null }, new AbortController().signal),
    reconcile: (choice: 'retry' | 'skip') => {
      runner.pause(run.runId, ownerId);
      runner.resume(run.runId, ownerId, { reconcileUnknown: choice });
    },
    close: async () => { await runner.stopAll(); db.close(); }
  };
}

for (const status of [404, 429, 500]) {
  test(`one authorized retry ending HTTP ${status} never dispatches that key again`, async () => {
    const calls: string[] = [];
    const f = fixture({ fetch: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw new Error('Synthetic dispatched IO fault');
      // Check the durable permission BEFORE the second actual dispatch.
      assert.equal(f.journal.requireRun(f.id).checkpoint.retryRequestKeys.length, 0);
      return response({ message: 'Synthetic settled failure' }, status);
    } });
    try {
      await f.step(); f.reconcile('retry'); await f.step();
      for (let i = 0; i < 4; i++) await f.step();
      assert.equal(calls.filter((url) => url.endsWith('/users/fixture')).length, 2);
      const attempts = f.journal.listRequests(f.id).filter((r) => r.kind === 'profile');
      assert.deepEqual(attempts.map((r) => r.state), ['unknown', 'failed']);
    } finally { await f.close(); }
  });
}

test('retry that becomes unknown again cannot override a subsequent explicit skip', async () => {
  const calls: string[] = [];
  const f = fixture({ fetch: async (url) => {
    calls.push(url);
    if (url.endsWith('/users/fixture')) throw new Error('Synthetic dispatched IO fault');
    return response({ message: 'Synthetic later failure' }, 404);
  } });
  try {
    await f.step(); f.reconcile('retry'); await f.step();
    const before = calls.length;
    await f.step();
    assert.equal(calls.length, before, 'new unknown requires another explicit choice');
    f.reconcile('skip');
    for (let i = 0; i < 4; i++) await f.step();
    assert.equal(calls.filter((url) => url.endsWith('/users/fixture')).length, 2);
    assert.equal(f.journal.listUnresolvedRequests(f.id).length, 0);
  } finally { await f.close(); }
});

test('worker shutdown AbortError keeps the dispatched outcome unknown across recovery', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const f = fixture({ fetch: async (_url, init) => new Promise<HttpResponseLike>((_resolve, reject) => {
    entered();
    const abort = () => reject(new DOMException('Synthetic shutdown abort', 'AbortError'));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener('abort', abort, { once: true });
  }) });
  try {
    f.runner.ensureRunning(); await ready; await f.runner.stopAll();
    const request = f.journal.listRequests(f.id)[0]!;
    assert.equal(request.state, 'unknown'); assert.equal(request.body, null);
    const restarted = new FetchGithubRunner({ db: f.db, store: f.store, githubToken: null,
      transport: { fetch: async () => { throw new Error('No blind replay permitted'); } } });
    restarted.recoverInterrupted();
    assert.equal(f.journal.requireRun(f.id).state, 'unreconciled');
    assert.equal(f.journal.listUnresolvedRequests(f.id).length, 1);
    await restarted.stopAll();
  } finally { await f.close(); }
});

test('a body transport fault after successful headers is unknown, never a definite failed read', async () => {
  const f = fixture({ fetch: async () => ({ ...response({}), text: async () => {
    throw new DOMException('Synthetic incomplete body', 'AbortError');
  } }) });
  try {
    await f.step();
    assert.equal(f.journal.listRequests(f.id)[0]!.state, 'unknown');
    assert.equal(f.journal.listRequests(f.id)[0]!.body, null);
    assert.equal(f.journal.listUnresolvedRequests(f.id).length, 1);
  } finally { await f.close(); }
});

test('a failed reconciliation transaction keeps the unknown request unresolved and permission unspent', async () => {
  const f = fixture({ fetch: async () => { throw new Error('Synthetic dispatched IO fault'); } });
  try {
    await f.step();
    f.runner.pause(f.id, 'synthetic-recovery-owner');
    f.db.exec(`CREATE TEMP TRIGGER fail_recovery_checkpoint
      BEFORE UPDATE OF checkpoint_json ON research_fetch_github_runs
      BEGIN SELECT RAISE(ABORT, 'Synthetic checkpoint failure'); END;`);
    assert.throws(() => f.runner.resume(f.id, 'synthetic-recovery-owner', { reconcileUnknown: 'retry' }),
      /Synthetic checkpoint failure/);
    assert.equal(f.journal.listUnresolvedRequests(f.id).length, 1, 'reconciliation row rolled back with checkpoint');
    assert.equal(f.journal.requireRun(f.id).state, 'paused');
    assert.deepEqual(f.journal.requireRun(f.id).checkpoint.retryRequestKeys, []);
    f.db.exec('DROP TRIGGER fail_recovery_checkpoint');
    f.runner.resume(f.id, 'synthetic-recovery-owner', { reconcileUnknown: 'retry' });
    await f.step();
    assert.equal(f.journal.listRequests(f.id).length, 2);
    assert.deepEqual(f.journal.requireRun(f.id).checkpoint.retryRequestKeys, []);
  } finally { await f.close(); }
});

for (const choice of ['retry', 'skip'] as const) {
  test(`legacy unversioned retry keys fail closed until a fresh explicit ${choice}`, async () => {
    const calls: string[] = [];
    const f = fixture({ fetch: async (url) => {
      calls.push(url);
      if (url.endsWith('/users/fixture')) throw new Error('Synthetic dispatched IO fault');
      return response({ message: 'Synthetic missing metadata' }, 404);
    } });
    try {
      await f.step(); f.reconcile('retry'); await f.step(); f.reconcile('skip');
      // Synthetic serialized legacy format: old retry -> unknown -> skip kept
      // a bare key. An independent oracle also uses actual frozen old modules.
      const cp = f.journal.requireRun(f.id).checkpoint;
      delete cp.retryAuthorizationVersion;
      cp.retryRequestKeys = [f.journal.listRequests(f.id)[0]!.requestKey];
      f.journal.updateCheckpoint(f.id, cp);
      f.runner.recoverInterrupted();
      assert.equal(f.journal.requireRun(f.id).state, 'unreconciled');
      assert.equal(f.runner.view(f.id, 'synthetic-recovery-owner')!.needsReconciliation, true);
      assert.throws(() => f.runner.resume(f.id, 'synthetic-recovery-owner', {}), /显式选择/);
      await f.step();
      assert.equal(calls.length, 2, 'ambiguous legacy key cannot authorize any dispatch');
      f.runner.resume(f.id, 'synthetic-recovery-owner', { reconcileUnknown: choice });
      await f.step();
      assert.equal(calls.filter((url) => url.endsWith('/users/fixture')).length, choice === 'retry' ? 3 : 2);
      assert.deepEqual(f.journal.requireRun(f.id).checkpoint.retryRequestKeys, []);
      assert.equal(f.journal.requireRun(f.id).checkpoint.retryAuthorizationVersion, 2);
      if (choice === 'retry') {
        await f.step();
        assert.equal(calls.length, 3, 'a newly unknown authorized attempt requires another explicit choice');
      }
    } finally { await f.close(); }
  });
}

for (const changed of [false, true]) {
  test(`duplicate comment ${changed ? 'changed body records a gap' : 'same body dedupes without a spurious gap'}`, async () => {
    const row = (body: string) => ({ id: 91, html_url: 'https://github.com/fixture/repo/issues/1#issuecomment-91',
      user: { login: 'writer', id: 44 }, body, created_at: '2026-03-01T00:00:00Z' });
    const f = fixture({ fetch: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/users/fixture') return response({ login: 'fixture', id: 42, type: 'User' });
      if (pathname === '/repos/fixture/repo') return response({ id: 777, name: 'repo', private: false,
        owner: { login: 'fixture' }, html_url: 'https://github.com/fixture/repo' });
      if (pathname.endsWith('/issues/1/comments')) return response([row('Synthetic first comment'),
        row(changed ? 'Synthetic edited comment' : 'Synthetic first comment')]);
      return response([{ number: 1, html_url: 'https://github.com/fixture/repo/issues/1', title: 'Synthetic issue',
        body: 'Synthetic body', user: { login: 'writer', id: 44 }, comments: 2 }]);
    } });
    try {
      for (let i = 0; i < 4; i++) await f.step();
      const comments = f.journal.listComments(f.id);
      assert.equal(comments.length, 1); assert.equal(comments[0]!.body, 'Synthetic first comment');
      assert.equal(f.journal.requireRun(f.id).checkpoint.gaps.some((g) => g.code === 'source_changed'), changed);
      const request = f.journal.listRequests(f.id).find((r) => r.kind === 'issue_comments')!;
      assert.equal(request.semanticState, changed ? 'partial' : 'valid');
    } finally { await f.close(); }
  });
}
