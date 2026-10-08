/**
 * GET-99 `/api/fetch` authenticated HTTP API tests (offline, real SQLite via
 * the test server): session owner isolation, same-origin Origin enforcement,
 * explicit confirmation before any HTTP, invalid scope refusal, request
 * shape + idempotency + version-conflict behavior matching the existing
 * routes, rate/start bounds, control paths never collapsing into 500, and
 * the health capability surface exposing real fetch GitHub separately from
 * the legacy research configuration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TestClient, startTestServer, waitFor } from './harness.js';
import type { HttpResponseLike, HttpTransport } from '../server/adapters/types.js';

interface StubCall {
  url: string;
}

function jsonResponse(body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status: 200,
    ok: true,
    redirected: false,
    headers: { get: () => null },
    text: async () => text
  };
}

/**
 * Abort-aware gated stub: responses stay pending until released or the
 * request is aborted, so run states are deterministic for control paths and
 * an aborted quantum always unwinds.
 */
function gated(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('synthetic abort'));
      return;
    }
    const timer = setTimeout(resolve, 3000);
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('synthetic abort'));
      },
      { once: true }
    );
  });
}

function stubTransport(calls: StubCall[]): HttpTransport {
  return {
    async fetch(url, init): Promise<HttpResponseLike> {
      calls.push({ url });
      await gated(init?.signal ?? undefined);
      const pathname = new URL(url).pathname;
      if (pathname === '/users/fixture') return jsonResponse({ login: 'fixture', id: 42, type: 'User' });
      if (pathname === '/repos/fixture/repo') {
        return jsonResponse({
          id: 1378367626,
          name: 'repo',
          private: false,
          owner: { login: 'fixture' },
          html_url: 'https://github.com/fixture/repo'
        });
      }
      if (pathname === '/repos/fixture/repo/issues') {
        return jsonResponse([
          {
            number: 1,
            html_url: 'https://github.com/fixture/repo/issues/1',
            title: 'Synthetic issue',
            body: 'Synthetic exact body',
            user: { login: 'writer', id: 44 },
            comments: 0
          }
        ]);
      }
      if (pathname.endsWith('/comments')) return jsonResponse([]);
      return jsonResponse({ message: 'Synthetic not found' });
    }
  };
}

interface StartBody {
  [key: string]: unknown;
}

function startBody(question = 'Synthetic repository question'): StartBody {
  const targetUrl = 'https://github.com/fixture/repo';
  return {
    targetUrl,
    question,
    accessScope: 'github_public_repository',
    confirmation: true,
    confirmedTarget: targetUrl,
    confirmedQuestion: question,
    confirmedAccessScope: 'github_public_repository'
  };
}

test('authenticated /api/fetch: confirmation, ownership, idempotency and version conflicts', async () => {
  const calls: StubCall[] = [];
  const server = await startTestServer({ transport: stubTransport(calls) });
  try {
    // Unauthenticated access is refused (session owner comes from middleware).
    const anonymous = await server.client.json('/api/fetch/runs');
    assert.equal(anonymous.status, 401);

    await server.client.signUp('owner-a@example.test');
    const health = await server.client.json<{ capabilities: Record<string, unknown> }>('/api/health');
    assert.equal(health.body.capabilities.fetchGithub, true, 'real fetch GitHub capability is exposed');
    assert.equal(health.body.capabilities.research, false, 'legacy research stays separately gated');

    // Same-origin enforcement on the mutating endpoint.
    const foreignOrigin = await server.client.json('/api/fetch/start', {
      method: 'POST',
      json: startBody(),
      origin: 'https://attacker.example.test'
    });
    assert.equal(foreignOrigin.status, 403, 'foreign Origin is rejected before anything else');

    // No explicit confirmation -> 400 and ZERO provider requests.
    const before = calls.length;
    const unconfirmed = await server.client.json('/api/fetch/start', {
      method: 'POST',
      json: { ...startBody(), confirmation: false }
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal(calls.length, before, 'no HTTP happens without explicit confirmation');

    // Confirmation echo mismatch is refused as well.
    const mismatched = await server.client.json('/api/fetch/start', {
      method: 'POST',
      json: { ...startBody(), confirmedQuestion: 'Synthetic different question' }
    });
    assert.equal(mismatched.status, 400);
    assert.equal(calls.length, before, 'still zero provider requests');

    // Invalid access scope for the target shape is refused.
    const invalidScope = await server.client.json('/api/fetch/start', {
      method: 'POST',
      json: { ...startBody(), accessScope: 'github_public_account', confirmedAccessScope: 'github_public_account' }
    });
    assert.equal(invalidScope.status, 422, 'repository target cannot claim the account scope');

    // Normal start really dispatches the first request.
    const created = await server.client.json<{ run: { runId: string; state: string } }>('/api/fetch/start', {
      method: 'POST',
      json: startBody()
    });
    assert.equal(created.status, 201);
    await waitFor(() => calls.some((call) => call.url.includes('/users/fixture')), 5000, 5);
    assert.ok(calls.every((call) => call.url.startsWith('https://api.github.com/')));

    // Idempotency: the same key with the same normalized request returns the
    // SAME run; a reused key with a different request is a 409 conflict.
    const replay = await server.client.json<{ run: { runId: string }; idempotent: boolean }>('/api/fetch/start', {
      method: 'POST',
      json: startBody(),
      headers: { 'idempotency-key': 'synthetic-key-1' }
    });
    assert.equal(replay.status, 201);
    const conflict = await server.client.json('/api/fetch/start', {
      method: 'POST',
      json: startBody('Synthetic other question'),
      headers: { 'idempotency-key': 'synthetic-key-1' }
    });
    assert.equal(conflict.status, 409, 'a reused key with a different request is a conflict');
    const sameAgain = await server.client.json<{ run: { runId: string }; idempotent: boolean }>('/api/fetch/start', {
      method: 'POST',
      json: startBody(),
      headers: { 'idempotency-key': 'synthetic-key-1' }
    });
    assert.equal(sameAgain.status, 200);
    assert.equal(sameAgain.body.idempotent, true);
    assert.equal(sameAgain.body.run.runId, replay.body.run.runId, 'same key + same request resolves to the same run');

    // Foreign runs are 404 for other owners (no probing), never 500.
    const foreignClient = new TestClient(server.baseUrl, server.origin);
    await foreignClient.signUp('owner-b@example.test');
    const foreignRead = await foreignClient.json(`/api/fetch/runs/${created.body.run.runId}`);
    assert.equal(foreignRead.status, 404, 'foreign run reads are 404, not 500');
    const foreignList = await foreignClient.json<{ runs: unknown[] }>('/api/fetch/runs');
    assert.deepEqual(foreignList.body.runs, []);

    // Same owner same target twice + a second owner: distinct run and case
    // identities, no collision/merge on the case-bound account id.
    const second = await server.client.json<{ run: { runId: string } }>('/api/fetch/start', {
      method: 'POST',
      json: startBody('Synthetic second question'),
      headers: { 'idempotency-key': 'synthetic-key-2' }
    });
    const third = await foreignClient.json<{ run: { runId: string } }>('/api/fetch/start', {
      method: 'POST',
      json: startBody(),
      headers: { 'idempotency-key': 'synthetic-key-3' }
    });
    assert.notEqual(second.body.run.runId, created.body.run.runId);
    assert.notEqual(third.body.run.runId, created.body.run.runId);

    // Control paths: pause/resume/stop behave with real 4xx conflicts instead
    // of collapsing into 500, and stale revisions are 409.
    const pause = await server.client.json<{ run: { state: string; revision: number } }>(
      `/api/fetch/runs/${created.body.run.runId}/pause`,
      { method: 'POST', json: {} }
    );
    assert.equal(pause.status, 200);
    const stale = await server.client.json(`/api/fetch/runs/${created.body.run.runId}/pause`, {
      method: 'POST',
      json: { expectedRevision: pause.body.run.revision + 5 }
    });
    assert.equal(stale.status, 409, 'stale revision is a version conflict, not a 500');
    const resume = await server.client.json(
      `/api/fetch/runs/${created.body.run.runId}/resume`,
      { method: 'POST', json: { reconcileUnknown: 'skip' } }
    );
    assert.equal(resume.status, 200);
    const stop = await server.client.json(`/api/fetch/runs/${created.body.run.runId}/stop`, {
      method: 'POST',
      json: {}
    });
    assert.equal(stop.status, 200);
    const stopAgain = await server.client.json(`/api/fetch/runs/${created.body.run.runId}/stop`, {
      method: 'POST',
      json: {}
    });
    assert.equal(stopAgain.status, 409, 'a finished/stopped run is a 409 conflict, not a 500');
    const unknownRun = await server.client.json('/api/fetch/runs/fetchgh_missing/stop', { method: 'POST', json: {} });
    assert.equal(unknownRun.status, 404, 'unknown run controls are 404, not 500');
  } finally {
    await server.close();
  }
});

test('start rate bounds match the existing routes and never surface as 500', async () => {
  const calls: StubCall[] = [];
  const server = await startTestServer({ transport: stubTransport(calls) });
  try {
    await server.client.signUp('rate-owner@example.test');
    let limited = 0;
    for (let index = 0; index < 12; index += 1) {
      const response = await server.client.json('/api/fetch/start', {
        method: 'POST',
        json: startBody(`Synthetic rate question ${String(index)}`),
        headers: { 'idempotency-key': `synthetic-rate-${String(index)}` }
      });
      if (response.status === 429) limited += 1;
      else assert.equal(response.status, 201, 'starts are either created or rate limited');
    }
    assert.ok(limited >= 1, 'the per-user start rate bound applies');
  } finally {
    await server.close();
  }
});
