/**
 * End-to-end discovery task tests: durable tasks, one-pass identity
 * correction, deep post tracking, revocation, checkpoint resume, external
 * tool report imports, idempotency and ownership.
 *
 * Everything runs offline through a synthetic transport and a synthetic
 * platform registry. No real platform is contacted and no fixture URL from
 * evals/ is ever fetched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startTestServer, waitFor } from './harness.js';
import { TestClient } from './harness.js';
import { PLATFORM_DISCOVERY_VERSION } from '../shared/platform-discovery.js';
import { DiscoveryStore } from '../server/discovery-store.js';

import { defaultRoutes, startDiscoveryServer, FakeTransport, FIXTURE_REGISTRY, type TaskDetail } from './discovery-fixtures.js';

test('discover → needs_input → one-pass correction → deep tracking → export', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('flow@example.test');

  const created = await server.client.json<{ task: { taskId: string; state: string } }>(
    '/api/discovery/tasks',
    {
      method: 'POST',
      json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover_and_track', authorization: 'public_professional' }
    }
  );
  assert.equal(created.status, 201);
  const taskId = created.body.task.taskId;

  // Exact handle match is NOT identity: the task pauses for a decision.
  await waitFor(async () => {
    const detail = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return detail.body.task.state === 'needs_input';
  });
  let detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.probes.length, 2);
  const foundProbe = detail.probes.find((probe) => probe.platformId === 'fixturecode');
  assert.equal(foundProbe?.status, 'found');
  assert.equal(foundProbe?.method, 'api_http');
  assert.equal(foundProbe?.receipt.tool, 'stripsearch-http-probe');
  assert.ok(foundProbe?.limitations.includes('rule_live_unverified'));
  assert.equal(detail.probes.find((probe) => probe.platformId === 'fixtureblog')?.status, 'not_found');
  assert.equal(detail.links.length, 1);
  assert.equal(detail.links[0]?.state, 'proposed');
  assert.equal(detail.links[0]?.attribution, 'unattributed');
  assert.ok((detail.task.needsInputPrompt ?? '').includes('同一人'));
  assert.ok(detail.events.some((event) => event.type === 'needs_input'));

  // Tracking and resume are blocked while a decision is pending.
  const blocked = await server.client.json(`/api/discovery/tasks/${taskId}/track`, {
    method: 'POST',
    json: {}
  });
  assert.equal(blocked.status, 409);
  const blockedResume = await server.client.json(`/api/discovery/tasks/${taskId}/resume`, {
    method: 'POST',
    json: {}
  });
  assert.equal(blockedResume.status, 409);

  // One-pass correction: a single batched decision with its basis.
  const corrected = await server.client.json<{
    pendingReview: string[];
    links: { state: string; attribution: string }[];
  }>(`/api/discovery/tasks/${taskId}/corrections`, {
    method: 'POST',
    json: {
      decisions: [
        {
          linkId: detail.links[0]?.id,
          action: 'confirm',
          basis: ['manual_review', 'self_declared'],
          note: '已核对主页自述与互链。'
        }
      ]
    }
  });
  assert.equal(corrected.status, 200);
  assert.deepEqual(corrected.body.pendingReview, []);
  assert.equal(corrected.body.links[0]?.attribution, 'linked');

  await waitFor(async () => {
    const snap = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return snap.body.task.state === 'completed';
  });
  detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.task.stage, 'done');
  // Posts were deep-tracked through the confirmed link only.
  assert.equal(detail.posts.length, 3);
  for (const post of detail.posts) {
    assert.equal(post.attribution, 'linked');
    assert.equal(post.valid, true);
    assert.equal(post.excluded, false);
  }
  assert.ok(detail.links[0]?.revisions.some((rev) => rev.actor.startsWith('user:')));
  assert.ok(detail.events.some((event) => event.type === 'track_finished'));

  const exported = await server.client.json<{
    schemaVersion: string;
    posts: { valid: boolean }[];
    probes: { receipt: { reportFormat: string } }[];
    limitations: string[];
  }>(`/api/discovery/tasks/${taskId}/export.json`);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.schemaVersion, PLATFORM_DISCOVERY_VERSION);
  assert.equal(exported.body.posts.length, 3);
  assert.ok(exported.body.posts.every((post) => post.valid));
  assert.ok(exported.body.limitations.length > 0);
});

test('dismissing a link revokes its posts; re-opening restores them', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('revoke@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover_and_track', authorization: 'public_professional' }
  });
  const taskId = created.body.task.taskId;
  await waitFor(async () => {
    const detail = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return detail.body.task.state === 'needs_input';
  });
  let detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  const linkId = detail.links[0]?.id as string;
  await server.client.json(`/api/discovery/tasks/${taskId}/corrections`, {
    method: 'POST',
    json: { decisions: [{ linkId, action: 'confirm', basis: ['manual_review'], note: '确认归属' }] }
  });
  await waitFor(async () => {
    const snap = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return snap.body.task.state === 'completed' && snap.body.posts.length === 3;
  });

  // Revoke: attribution of every tracked post is withdrawn, not deleted.
  const dismissed = await server.client.json<{ links: { state: string; attribution: string }[] }>(
    `/api/discovery/tasks/${taskId}/corrections`,
    {
      method: 'POST',
      json: {
        decisions: [
          {
            linkId,
            action: 'dismiss',
            basis: ['manual_review'],
            note: '同名不同人。',
            counterevidence: '该账号自述指向另一位同名者。'
          }
        ]
      }
    }
  );
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.links[0]?.attribution, 'revoked');

  detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.posts.length, 3);
  for (const post of detail.posts) {
    assert.equal(post.valid, false);
    assert.equal(post.excluded, true);
    assert.equal(post.attribution, 'revoked');
  }
  assert.ok(detail.events.some((event) => event.type === 'attribution_revoked'));

  // Re-open restores the attribution and the posts.
  const reopened = await server.client.json(`/api/discovery/tasks/${taskId}/corrections`, {
    method: 'POST',
    json: { decisions: [{ linkId, action: 'reopen', basis: [], note: '补充证据后再判。' }] }
  });
  assert.equal(reopened.status, 200);
  detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.links[0]?.state, 'proposed');
  for (const post of detail.posts) {
    assert.equal(post.excluded, false);
    assert.equal(post.attribution, 'unattributed');
    assert.equal(post.valid, false);
  }
});

test('cancel is terminal and late probe results never resurrect a task', async (t) => {
  const transport = new FakeTransport({
    'https://fixturecode.example.test/users/alice': {
      status: 200,
      body: '{}',
      delayMs: 400
    },
    'https://fixtureblog.example.test/@alice': { status: 404, body: '' }
  });
  const server = await startTestServer({ transport, discoveryRegistry: FIXTURE_REGISTRY });
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('cancel@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover', authorization: 'public_professional' }
  });
  const taskId = created.body.task.taskId;
  await waitFor(async () => {
    const detail = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return detail.body.task.state === 'discovering';
  });
  const cancelled = await server.client.json<{ task: { state: string } }>(
    `/api/discovery/tasks/${taskId}/cancel`,
    { method: 'POST', json: {} }
  );
  assert.equal(cancelled.body.task.state, 'cancelled');

  // Let the delayed probe answer; the terminal state must survive it.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.task.state, 'cancelled');
  assert.equal(detail.probes.length, 0);
  assert.ok(detail.events.some((event) => event.type === 'cancelled'));

  // Cancelled tasks cannot be resumed.
  const resume = await server.client.json(`/api/discovery/tasks/${taskId}/resume`, {
    method: 'POST',
    json: {}
  });
  assert.equal(resume.status, 409);
});

test('restart pauses at the checkpoint and resume never re-runs finished probes', async (t) => {
  const transport = new FakeTransport({
    'https://fixturecode.example.test/users/alice': {
      status: 404,
      body: ''
    },
    'https://fixtureblog.example.test/@alice': {
      status: 404,
      body: '',
      delayMs: 500
    }
  });
  const server = await startTestServer({ transport, discoveryRegistry: FIXTURE_REGISTRY });
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('restart@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover', authorization: 'public_professional' }
  });
  const taskId = created.body.task.taskId;

  // The fast probe is persisted; the slow one is still in flight.
  await waitFor(() => transport.count('/users/alice') === 1);
  await waitFor(async () => {
    const detail = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return detail.body.probes.length === 1;
  });

  // Simulate a process restart: recovery keeps the checkpoint.
  const recovered = new DiscoveryStore(server.boot.db);
  assert.equal(recovered.recoverInterruptedTasks(), 1);
  const paused = recovered.getTask(taskId);
  assert.equal(paused?.state, 'partial');
  assert.equal(paused?.interrupted, true);
  assert.equal(paused?.checkpoint.completedProbeKeys.length, 1);
  assert.equal(recovered.recoverInterruptedTasks(), 0);

  // Explicit resume continues from the checkpoint.
  const resumed = await server.client.json<{ task: { state: string } }>(
    `/api/discovery/tasks/${taskId}/resume`,
    { method: 'POST', json: {} }
  );
  assert.equal(resumed.status, 200);
  await waitFor(async () => {
    const detail = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return detail.body.task.state === 'completed';
  });

  // Continuity: the already-answered probe was not asked again.
  assert.equal(transport.calls.filter((url) => url.endsWith('/users/alice')).length, 1);
  const detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.probes.length, 2);
  assert.equal(new Set(detail.checkpoint.completedProbeKeys).size, 2);
  assert.ok(detail.events.some((event) => event.type === 'interrupted'));
  assert.ok(detail.events.some((event) => event.type === 'resumed'));
});

test('cross-link evidence auto-confirms without a prompt and tracks posts', async (t) => {
  const { server } = await startDiscoveryServer(
    defaultRoutes({
      'https://fixturecode.example.test/about/alice': {
        status: 200,
        contentType: 'text/html',
        body: '<html><a rel="me" href="https://fixturecode.example.test/users/alice">我的代码主页</a></html>'
      }
    })
  );
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('crosslink@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: {
      subject: { kind: 'username', value: 'alice' },
      seedUrl: 'https://fixturecode.example.test/about/alice',
      mode: 'discover_and_track',
      authorization: 'consent_obtained'
    }
  });
  const taskId = created.body.task.taskId;
  await waitFor(async () => {
    const detail = await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`);
    return detail.body.task.state === 'completed';
  });
  const detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  const link = detail.links.find((item) => item.platformId === 'fixturecode');
  assert.equal(link?.state, 'confirmed');
  assert.ok(link?.basis.includes('cross_link'));
  assert.ok(link?.revisions.some((rev) => rev.actor === 'auto-correction'));
  assert.equal(detail.posts.length, 3);
  assert.ok(detail.events.some((event) => event.type === 'seed_cross_link_checked'));
});

test('importing maigret and holehe reports keeps receipts and drops re-contact fields', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('imports@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'email', value: 'person@example.test' }, mode: 'discover', authorization: 'public_professional' }
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.taskId;

  const maigret = await server.client.json<{
    results: number;
    linked: number;
    warnings: string[];
  }>(`/api/discovery/tasks/${taskId}/imports`, {
    method: 'POST',
    json: {
      tool: 'maigret',
      format: 'simple',
      toolVersion: '0.6.5',
      generatedAt: '2026-09-27T00:00:00Z',
      report: {
        fixturecode: {
          username: 'person',
          url_user: 'https://fixturecode.example.test/person',
          status: { status: 'Claimed', username: 'person', url: 'https://fixturecode.example.test/person' }
        },
        fixtureblog: {
          username: 'person',
          url_user: 'https://fixtureblog.example.test/person',
          status: { status: 'Available' }
        }
      }
    }
  });
  assert.equal(maigret.status, 201);
  assert.equal(maigret.body.results, 2);
  assert.equal(maigret.body.linked, 1);

  const holehe = await server.client.json<{ results: number; warnings: string[] }>(
    `/api/discovery/tasks/${taskId}/imports`,
    {
      method: 'POST',
      json: {
        tool: 'holehe',
        report: [
          {
            name: 'fixture-mail',
            rateLimit: false,
            exists: true,
            emailrecovery: 'ex****e@example.test',
            phoneNumber: null,
            others: null
          }
        ]
      }
    }
  );
  assert.equal(holehe.status, 201);
  assert.equal(holehe.body.results, 1);
  assert.ok(holehe.body.warnings.some((w) => w.includes('已丢弃')));

  const detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.imports.length, 2);
  const external = detail.probes.filter((probe) => probe.method === 'external_report');
  assert.ok(external.length >= 3);
  for (const probe of external) {
    assert.equal(probe.verification, 'live_unverified');
    assert.ok(['maigret', 'holehe'].includes(probe.receipt.tool));
    assert.ok(probe.limitations.includes('not_rechecked_by_stripsearch'));
  }
  // Email findings are candidates, never confirmed identity.
  assert.ok(detail.links.every((link) => link.state === 'proposed'));
  const exported = await server.client.json(`/api/discovery/tasks/${taskId}/export.json`);
  assert.equal(exported.status, 200);
  assert.equal(JSON.stringify(exported.body).includes('ex****e@example.test'), false);

  // Invalid reports are rejected outright.
  const bad = await server.client.json(`/api/discovery/tasks/${taskId}/imports`, {
    method: 'POST',
    json: { tool: 'something-else', report: {} }
  });
  assert.equal(bad.status, 400);
});

test('idempotency replays the same request and rejects a changed one', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('idem@example.test');
  const body = { subject: { kind: 'username', value: 'alice' }, mode: 'discover', authorization: 'public_professional' };
  const first = await server.client.json<{ task: { taskId: string }; replayed: boolean }>(
    '/api/discovery/tasks',
    { method: 'POST', json: body, headers: { 'idempotency-key': 'key-1' } }
  );
  assert.equal(first.status, 201);
  assert.equal(first.body.replayed, false);

  const replay = await server.client.json<{ task: { taskId: string }; replayed: boolean }>(
    '/api/discovery/tasks',
    { method: 'POST', json: body, headers: { 'idempotency-key': 'key-1' } }
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.task.taskId, first.body.task.taskId);

  const conflict = await server.client.json('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'other' }, mode: 'discover', authorization: 'public_professional' },
    headers: { 'idempotency-key': 'key-1' }
  });
  assert.equal(conflict.status, 409);
});

test('tasks are owner-scoped and read endpoints never create work', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('owner@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover', authorization: 'public_professional' }
  });
  const taskId = created.body.task.taskId;

  const other = new TestClient(server.baseUrl, server.origin);
  await other.signUp('other@example.test');
  const denied = await other.json(`/api/discovery/tasks/${taskId}`);
  assert.equal(denied.status, 404);
  const deniedMutation = await other.json(`/api/discovery/tasks/${taskId}/corrections`, {
    method: 'POST',
    json: { decisions: [{ linkId: 'x', action: 'confirm', basis: ['manual_review'] }] }
  });
  assert.equal(deniedMutation.status, 404);
  const list = await other.json<{ tasks: unknown[] }>('/api/discovery/tasks');
  assert.equal(list.status, 200);
  assert.equal(list.body.tasks.length, 0);

  // GET never creates: a missing id is just 404.
  const missing = await server.client.json('/api/discovery/tasks/dtask_missing');
  assert.equal(missing.status, 404);
  const after = await server.client.json<{ tasks: unknown[] }>('/api/discovery/tasks');
  assert.equal(after.body.tasks.length, 1);
});

test('request validation rejects bad subjects, seeds and empty corrections', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(async () => {
    await server.close();
  });
  await server.client.signUp('validate@example.test');

  const badSubject = await server.client.json('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'has space' } }
  });
  assert.equal(badSubject.status, 400);

  const badSeed = await server.client.json('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, seedUrl: 'http://insecure.example.test' }
  });
  assert.equal(badSeed.status, 400);

  const noAuthorization = await server.client.json('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover' }
  });
  assert.equal(noAuthorization.status, 400);

  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    method: 'POST',
    json: { subject: { kind: 'username', value: 'alice' }, mode: 'discover', authorization: 'public_professional' }
  });
  const taskId = created.body.task.taskId;
  const empty = await server.client.json(`/api/discovery/tasks/${taskId}/corrections`, {
    method: 'POST',
    json: { decisions: [] }
  });
  assert.equal(empty.status, 400);

  const noBasis = await server.client.json(`/api/discovery/tasks/${taskId}/corrections`, {
    method: 'POST',
    json: { decisions: [{ linkId: 'x', action: 'confirm', basis: [] }] }
  });
  assert.equal(noBasis.status, 400);
});
