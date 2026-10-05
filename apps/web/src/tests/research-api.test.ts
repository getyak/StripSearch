import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient, waitFor } from './harness.js';
import type { CanonicalView } from '../shared/types.js';
import type { ResearchPage, ResearchTools, ResearchToolAction } from '../server/research/tool-contracts.js';
import type { ResearchPlanner } from '../server/research/planner.js';
import type { FirstStepDiscoveryView } from '../shared/first-step-discovery.js';

const profile = (handle: string, url = `https://github.com/${handle}`): ResearchPage => ({
  url,
  title: handle,
  text: `${handle} builds synthetic compilers.`,
  kind: 'profile',
  publishedAt: null,
  links: [],
  limitations: [],
  account: { platform: 'github', handle, id: handle, profileUrl: url }
});
const planner: ResearchPlanner = {
  async decide(input) {
    if (input.mode === 'verify') return { supported: [0], rejected: [] };
    return { action: 'finish', claims: [{ sourceKey: 'S1', quote: input.checkpoint.pages[0]!.text }], unknowns: [] };
  }
};
function tools(): ResearchTools {
  return {
    async execute(action) {
      return {
        pages: action.type === 'search' ? [profile('ada-a'), profile('ada-b')] : [profile(new URL(action.url).pathname.slice(1))],
        requests: 1,
        bytes: 80,
        estimatedUsd: 0.001,
        credits: null,
        limitations: []
      };
    }
  };
}

test('new input defaults to research and does not silently replace unavailable providers', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());
  await server.client.signUp('research-unavailable@example.test');
  const response = await server.client.json<{ error: { code: string } }>('/api/runs', { json: { input: 'Research Ada Fixture' } });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'provider_unavailable');
});

test('fresh name runs use the first step: discovery, one atomic selection, then scope-limited fetch', async (t) => {
  const server = await startTestServer(
    { researchTools: tools(), researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('first-step-owner@example.test');
  const made = await server.client.json<{ run: CanonicalView }>('/api/runs', { json: { input: 'Research Ada Fixture' } });
  assert.equal(made.status, 201);
  const id = made.body.run.runId;
  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');

  const discovery = await server.client.json<{ mode: string; view: FirstStepDiscoveryView }>(`/api/runs/${id}/first-step/discovery`);
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.mode, 'first_step');
  const view = discovery.body.view;
  assert.ok(view.accounts.length >= 2, 'multi-platform candidates are projected');
  assert.equal(view.selection.submitted, false);
  assert.ok(view.selection.scopeVersion >= 1, 'the authoritative live scope version is exposed');
  for (const account of view.accounts) assert.equal(account.userSelection.state, 'unanswered');

  const cluster = view.clusters[0]!;
  const selected = cluster.accountIds.map((accountId) => ({ accountId, selection: 'selected', excluded: false }));
  for (const account of view.accounts) {
    if (!cluster.accountIds.includes(account.accountId)) selected.push({ accountId: account.accountId, selection: 'not_selected', excluded: false });
  }
  const payload = {
    expectedRunRevision: (await server.client.json<{ runRevision: number }>(`/api/runs/${id}/first-step/discovery`)).body.runRevision,
    expectedScopeVersion: view.selection.scopeVersion,
    discoveryRevision: view.discoveryRevision,
    clusterId: view.clusters[0]?.clusterId ?? null,
    accounts: selected
  };
  const foreign = new TestClient(server.baseUrl, server.origin);
  await foreign.signUp('first-step-foreign@example.test');
  assert.equal((await foreign.json(`/api/runs/${id}/first-step/selection`, { json: payload })).status, 404);

  const submitted = await server.client.json<{ selection: { scopeVersion: number; idempotent: boolean } }>(
    `/api/runs/${id}/first-step/selection`,
    { json: payload, headers: { 'idempotency-key': 'submit-1' } }
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.selection.idempotent, false);
  // Double click: the same key and payload replays, nothing advances twice.
  const replay = await server.client.json<{ selection: { idempotent: boolean; scopeVersion: number } }>(
    `/api/runs/${id}/first-step/selection`,
    { json: payload, headers: { 'idempotency-key': 'submit-1' } }
  );
  assert.equal(replay.body.selection.idempotent, true);
  assert.equal(replay.body.selection.scopeVersion, submitted.body.selection.scopeVersion);
  // A stale revision can never write.
  assert.equal((await server.client.json(`/api/runs/${id}/first-step/selection`, { json: payload })).status, 409);

  await waitFor(() => ['partial', 'completed', 'failed'].includes(server.store.getRun(id)?.state ?? ''));
  const done = (await server.client.json<{ run: CanonicalView }>(`/api/runs/${id}`)).body.run;
  assert.notEqual(done.state, 'failed');
  assert.ok(done.identity.profileUrl);
  assert.equal(done.state, 'partial');
});

test('profile URL input reaches scope confirmation before any cross-platform deep read', async (t) => {
  const calls: ResearchToolAction[] = [];
  const selected = tools();
  const server = await startTestServer(
    {
      researchTools: {
        async execute(action, signal) {
          calls.push(action);
          return selected.execute(action, signal);
        }
      },
      researchPlanner: planner
    },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('first-step-url@example.test');
  const made = await server.client.json<{ run: CanonicalView }>('/api/runs', { json: { input: 'https://github.com/ada-a' } });
  assert.equal(made.status, 201);
  const id = made.body.run.runId;
  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');
  assert.equal(calls.every((action) => action.type === 'search' || action.type === 'read' || action.type === 'github_profile' || action.type === 'social_profile'), true);
  assert.equal(calls.some((action) => action.type === 'social_posts' || action.type === 'firecrawl'), false, 'no posts deep-read before selection');
  const discovery = await server.client.json<{ mode: string; view: FirstStepDiscoveryView }>(`/api/runs/${id}/first-step/discovery`);
  assert.equal(discovery.body.mode, 'first_step');
  assert.equal(discovery.body.view.selection.submitted, false);
  assert.equal(discovery.body.view.accounts.some((account) => account.profileUrl === 'https://github.com/ada-a'), true, 'the explicit URL is retained as an observed lead');
});

test('legacy paused jobs keep their candidates and resume; explicit expand starts a new discovery revision', async (t) => {
  const server = await startTestServer(
    { researchTools: tools(), researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('legacy-owner@example.test');
  const session = await server.client.json<{ user: { id: string } }>('/api/auth/get-session');
  const ownerId = session.body.user.id;
  // Simulate a historical job exactly as it was persisted before this feature.
  const run = server.store.insertRun({
    ownerId,
    question: 'Research Ada Fixture',
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'legacy-fixture'
  });
  server.store.research.save(run.id, {
    phase: 'needs_input',
    steps: 1,
    startedAt: Date.now(),
    elapsedMs: 5,
    anchorUrl: null,
    identity: null,
    candidates: [{ candidateId: 'candidate_legacy', label: 'Ada Legacy', detail: 'https://github.com/ada-a', profileUrl: 'https://github.com/ada-a' }],
    pages: [],
    claims: [],
    unknowns: [],
    stopReason: null
  });
  server.store.updateRun(run.id, { state: 'needs_input' });

  const legacy = await server.client.json<{ mode: string; candidates: unknown[]; canExpand: boolean }>(
    `/api/runs/${run.id}/first-step/discovery`
  );
  assert.equal(legacy.body.mode, 'legacy');
  assert.equal(legacy.body.candidates.length, 1);
  assert.equal(legacy.body.canExpand, true);

  // The legacy single-candidate resume stays readable for historical jobs.
  const resumed = await server.client.json(`/api/runs/${run.id}/resume`, {
    json: { candidateId: 'candidate_legacy', expectedRevision: server.store.getRun(run.id)!.revision }
  });
  assert.equal(resumed.status, 200);
  await waitFor(() => server.store.getRun(run.id)?.state !== 'queued');

  // An explicit legacy expand uses a NEW discovery revision on the new flow.
  server.store.updateRun(run.id, { state: 'needs_input' });
  const expanded = await server.client.json<{ queued: boolean; discoveryRevision: number }>(
    `/api/runs/${run.id}/first-step/expand`,
    { json: {}, headers: { 'idempotency-key': 'expand-legacy-1' } }
  );
  assert.equal(expanded.status, 202);
  assert.equal(expanded.body.queued, true);
  await waitFor(() => server.store.getRun(run.id)?.state === 'needs_input');
  const after = await server.client.json<{ mode: string; view: FirstStepDiscoveryView }>(`/api/runs/${run.id}/first-step/discovery`);
  assert.equal(after.body.mode, 'first_step');
  assert.ok(after.body.view.discoveryRevision >= 1);
});

test('cancel mid-flow is honored and the first-step phase reflects it', async (t) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = tools();
  const server = await startTestServer(
    {
      researchTools: {
        async execute(action, signal) {
          if (action.type === 'search') await gate;
          return inner.execute(action, signal);
        }
      },
      researchPlanner: planner
    },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('first-step-cancel@example.test');
  const made = await server.client.json<{ run: CanonicalView }>('/api/runs', { json: { input: 'Research Ada Fixture' } });
  const id = made.body.run.runId;
  const cancelled = await server.client.json<{ run: CanonicalView | null }>(`/api/runs/${id}/cancel`, { json: {} });
  assert.equal(cancelled.status, 200);
  release();
  await waitFor(() => server.store.getRun(id)?.state === 'cancelled');
  const view = await server.client.json<{ mode: string; view: FirstStepDiscoveryView }>(`/api/runs/${id}/first-step/discovery`);
  assert.equal(view.body.mode, 'first_step');
  assert.equal(view.body.view.discoveryRevision, 0, 'late results after cancel are never published');
});

test('followups require a frozen parent scope and inherit it instead of bypassing the first step', async (t) => {
  const server = await startTestServer(
    { researchTools: tools(), researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('followup-owner@example.test');
  // An orphan followup flag can never bypass the first-step flow.
  const orphan = await server.client.json<{ error: { code: string } }>('/api/runs', {
    json: { input: 'Research Ada Fixture', followup: true }
  });
  assert.equal(orphan.status, 400);
  assert.equal(orphan.body.error.code, 'invalid_parent');

  const made = await server.client.json<{ run: CanonicalView }>('/api/runs', { json: { input: 'Research Ada Fixture' } });
  const parentId = made.body.run.runId;
  await waitFor(() => server.store.getRun(parentId)?.state === 'needs_input');
  const ownerId = server.store.getRun(parentId)!.ownerId;
  const wrongProviderParent = server.store.insertRun({ ownerId, question: 'Legacy GitHub metadata', seedUrl: null, provider: 'github',
    parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'legacy-github' });
  const wrongProvider = await server.client.json<{error:{code:string}}>('/api/runs', {
    json: {input:'Research another public person', provider:'research', followup:true, parentRunId:wrongProviderParent.id}
  });
  assert.equal(wrongProvider.status, 409);
  assert.equal(wrongProvider.body.error.code, 'invalid_parent_provider');
  // Before the parent's scope is frozen, no follow-up child may start.
  const early = await server.client.json<{ error: { code: string } }>(`/api/runs/${parentId}/followup`, {
    json: { question: 'Please summarize their public work' }
  });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'parent_scope_not_frozen');

  // Freeze the parent scope through the atomic selection.
  const discovery = await server.client.json<{ view: FirstStepDiscoveryView; runRevision: number }>(
    `/api/runs/${parentId}/first-step/discovery`
  );
  const view = discovery.body.view;
  const cluster = view.clusters[0]!;
  await server.client.json(`/api/runs/${parentId}/first-step/selection`, {
    json: {
      expectedRunRevision: discovery.body.runRevision,
      expectedScopeVersion: view.selection.scopeVersion,
      discoveryRevision: view.discoveryRevision,
      clusterId: cluster.clusterId,
      accounts: view.accounts.map((account) => ({
        accountId: account.accountId,
        selection: cluster.accountIds.includes(account.accountId) ? 'selected' : 'not_selected',
        excluded: false
      }))
    }
  });

  // A legitimate report follow-up within the frozen scope works without re-confirmation.
  const followup = await server.client.json<{ run: CanonicalView }>(`/api/runs/${parentId}/followup`, {
    json: { question: 'Please summarize their public work' }
  });
  assert.equal(followup.status, 201);
  const childId = followup.body.run.runId;
  const childView = await server.client.json<{ mode: string; view: FirstStepDiscoveryView }>(
    `/api/runs/${childId}/first-step/discovery`
  );
  assert.equal(childView.body.mode, 'first_step');
  assert.equal(childView.body.view.selection.submitted, true, 'the child inherits the frozen scope instead of asking again');
  const binding = server.boot.firstStep.selectionBinding(childId)!;
  assert.equal(childView.body.view.caseId, binding.caseId);
  assert.equal(childView.body.view.selection.scopeVersion, binding.scopeVersion);
  assert.equal(server.boot.firstStep.link(childId)!.caseId, server.boot.firstStep.link(parentId)!.caseId);
  await waitFor(() => ['partial', 'completed', 'failed', 'needs_input'].includes(server.store.getRun(childId)?.state ?? ''));
  assert.notEqual(server.store.getRun(childId)?.state, 'needs_input', 'no repeated scope confirmation for an inherited scope');
});
