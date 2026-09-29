import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer, waitFor } from './harness.js';
import { defaultRoutes, startDiscoveryServer, FakeTransport, FIXTURE_REGISTRY, type TaskDetail } from './discovery-fixtures.js';
import type { HttpResponseLike } from '../server/adapters/types.js';

test('a stale attempt finishing cannot remove the replacement task from the running set', async (t) => {
  const seedUrl = 'https://fixturecode.example.test/about/alice';
  const pending: Array<() => void> = [];
  const base = new FakeTransport(defaultRoutes());
  const server = await startTestServer({ discoveryRegistry: FIXTURE_REGISTRY, transport: {
    fetch(url, init) {
      if (url !== seedUrl) return base.fetch(url, init);
      return new Promise<HttpResponseLike>(resolve => pending.push(() => resolve({
        status: 200, ok: true, headers: { get: () => 'text/html' },
        text: async () => '<a rel="me" href="https://fixturecode.example.test/users/alice">Me</a>'
      })));
    }
  } });
  t.after(async () => { pending.forEach(resolve => resolve()); await server.close(); });
  await server.client.signUp('stale-attempt@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    json: { subject: { kind: 'username', value: 'alice' }, seedUrl, authorization: 'consent_obtained' }
  });
  const taskId = created.body.task.taskId;
  await waitFor(() => pending.length === 1);
  server.boot.discoveryStore.recoverInterruptedTasks();
  assert.equal(server.boot.discoveryRunner.resume(taskId), true);
  await waitFor(() => pending.length === 2);
  pending[0]!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(server.boot.discoveryRunner.isRunning(taskId), true);
  pending[1]!();
  await waitFor(() => !server.boot.discoveryRunner.isRunning(taskId));
  assert.equal(server.boot.discoveryStore.getTask(taskId)?.state, 'completed');
});

test('failed correction batches leave links, revisions and events unchanged', async (t) => {
  const { server } = await startDiscoveryServer(defaultRoutes());
  t.after(() => server.close());
  await server.client.signUp('batch-rollback@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    json: { subject: { kind: 'username', value: 'alice' }, authorization: 'consent_obtained' }
  });
  const taskId = created.body.task.taskId;
  await waitFor(async () => (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body.task.state === 'needs_input');
  const before = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  const response = await server.client.json(`/api/discovery/tasks/${taskId}/corrections`, { json: {
    decisions: [
      { linkId: before.links[0]!.id, action: 'confirm', basis: ['manual_review'] },
      { linkId: 'missing-link', action: 'confirm', basis: ['manual_review'] }
    ]
  } });
  assert.equal(response.status, 404);
  const after = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.deepEqual(after.links, before.links);
  assert.deepEqual(after.events, before.events);
  assert.equal(after.task.revision, before.task.revision);
});

test('seed checks reject untrusted hosts, error pages and non-exact self links', async (t) => {
  const cases = [
    { name: 'untrusted', url: 'https://seed.example.test/p', status: 200, body: '<a rel="me" href="https://fixturecode.example.test/users/alice">Me</a>', requests: 0 },
    { name: 'error', url: 'https://fixturecode.example.test/about/alice', status: 404, body: '<a rel="me" href="https://fixturecode.example.test/users/alice">Me</a>', requests: 1 },
    { name: 'prefix', url: 'https://fixturecode.example.test/about/alice', status: 200, body: '<a rel="me" href="https://fixturecode.example.test/users/alice-other">Me</a>', requests: 1 },
    { name: 'mention', url: 'https://fixturecode.example.test/about/alice', status: 200, body: '<p>See https://fixturecode.example.test/users/alice</p>', requests: 1 },
    { name: 'not-self', url: 'https://fixturecode.example.test/about/alice', status: 200, body: '<a href="https://fixturecode.example.test/users/alice">Someone else</a>', requests: 1 },
    { name: 'comment', url: 'https://fixturecode.example.test/about/alice', status: 200, body: '<!-- <a rel="me" href="https://fixturecode.example.test/users/alice">Me</a> -->', requests: 1 },
    { name: 'script', url: 'https://fixturecode.example.test/about/alice', status: 200, body: '<script>const s = \'<a rel="me" href="https://fixturecode.example.test/users/alice">Me</a>\';</script>', requests: 1 },
    { name: 'json', url: 'https://fixturecode.example.test/about/alice', status: 200, body: '<a rel="me" href="https://fixturecode.example.test/users/alice">Me</a>', contentType: 'application/json', requests: 1 }
  ];
  const fixtures = cases.map(fixture => ({ ...fixture, url: `${fixture.url}?case=${fixture.name}` }));
  const { server, transport } = await startDiscoveryServer(defaultRoutes(Object.fromEntries(
    fixtures.map(fixture => [fixture.url, { contentType: 'text/html', ...fixture }])
  )));
  t.after(() => server.close());
  assert.equal((await server.client.signUp('seed-cases@example.test')).status, 200);
  for (const fixture of fixtures) await t.test(fixture.name, async () => {
    const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
      json: { subject: { kind: 'username', value: 'alice' }, seedUrl: fixture.url, authorization: 'consent_obtained' }
    });
    const taskId = created.body.task.taskId;
    await waitFor(async () => ['completed', 'needs_input'].includes((await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body.task.state));
    const detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
    assert.equal(detail.links[0]?.state, 'proposed');
    assert.equal(transport.count(fixture.url), fixture.requests);
  });
});

test('cancelling a pending seed check cannot auto-confirm links or publish posts', async (t) => {
  const seedUrl = 'https://fixturecode.example.test/about/alice';
  const { server, transport } = await startDiscoveryServer(defaultRoutes({ [seedUrl]: {
    status: 200, contentType: 'text/html', delayMs: 2000,
    body: '<a rel="me" href="https://fixturecode.example.test/users/alice">Me</a>'
  } }));
  t.after(() => server.close());
  await server.client.signUp('cancel-seed@example.test');
  const created = await server.client.json<{ task: { taskId: string } }>('/api/discovery/tasks', {
    json: { subject: { kind: 'username', value: 'alice' }, seedUrl, mode: 'discover_and_track', authorization: 'consent_obtained' }
  });
  const taskId = created.body.task.taskId;
  await waitFor(() => transport.count(seedUrl) === 1);
  await server.client.json(`/api/discovery/tasks/${taskId}/cancel`, { json: {} });
  await waitFor(() => !server.boot.discoveryRunner.isRunning(taskId));
  const detail = (await server.client.json<TaskDetail>(`/api/discovery/tasks/${taskId}`)).body;
  assert.equal(detail.task.state, 'cancelled');
  assert.equal(detail.links[0]?.state, 'proposed');
  assert.equal(detail.links[0]?.revisions.length, 0);
  assert.equal(detail.posts.length, 0);
  assert.equal(transport.count('/posts?'), 0);
});
