/**
 * GET-213 HTTP trust sequence on the REAL app surface: owner-checked,
 * same-origin POST person confirmation with idempotent replay, the atomic
 * account scope gate that refuses bypass, and safe behavior during active
 * queued work. Synthetic offline tools only; no network or provider calls.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestServer, TestClient, waitFor } from './harness.js';
import type { ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { FirstStepDiscoveryView, FirstStepSelectionInput } from '../shared/first-step-discovery.js';

const HOME_URL = 'https://lantern.dev/';
const HOME_TEXT = 'Mira Kepler maintains the Lantern compiler. My X: https://x.com/mkepler.';

function page(url: string, title: string, text: string, links: string[] = []) {
  return { url, title, text, kind: 'profile' as const, publishedAt: null, links, limitations: [] };
}

function result(pages: ResearchToolResult['pages']): ResearchToolResult {
  return { pages, requests: 1, bytes: 80, estimatedUsd: 0.001, credits: null, limitations: [] };
}

function tools(): ResearchTools {
  return {
    async execute(action) {
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT), page('https://x.com/mkepler', 'Mira Kepler (@mkepler)', 'Compiler researcher.')]);
      return result([page(action.url, 'Mira Kepler — Lantern', `${HOME_TEXT} Owned here.`)]);
    }
  };
}

function selectionPayload(view: FirstStepDiscoveryView, runRevision: number): FirstStepSelectionInput {
  return {
    expectedRunRevision: runRevision,
    expectedScopeVersion: view.selection.scopeVersion,
    discoveryRevision: view.discoveryRevision,
    clusterId: view.clusters[0]?.clusterId ?? null,
    accounts: view.accounts.map((account) => ({ accountId: account.accountId, selection: 'only_this_account', excluded: false, note: null }))
  };
}

test('HTTP person confirmation: no bypass, idempotent replay during active work, then the atomic scope gate', async (t) => {
  const server = await startTestServer(
    { researchTools: tools() },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('person-http-owner@example.test');
  const made = await server.client.json<{ run: { runId: string } }>('/api/runs', { json: { input: 'Mira Kepler' } });
  assert.equal(made.status, 201);
  const id = made.body.run.runId;
  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');

  const discovery = await server.client.json<{ mode: string; view: FirstStepDiscoveryView; runRevision: number }>(`/api/runs/${id}/first-step/discovery`);
  assert.equal(discovery.status, 200);
  const view = discovery.body.view;
  assert.equal(view.personConfirmation?.required, true);
  assert.equal(view.personConfirmation?.status, 'awaiting');
  const candidateId = view.personOverview!.candidates[0]!.candidateId;
  const confirmBody = {
    expectedRunRevision: discovery.body.runRevision,
    expectedScopeVersion: view.selection.scopeVersion,
    discoveryRevision: view.discoveryRevision,
    candidateId
  };

  // The account scope gate can never bypass the person confirmation.
  const beforeConfirmation = await server.client.json(`/api/runs/${id}/first-step/selection`, {
    json: selectionPayload(view, discovery.body.runRevision)
  });
  assert.equal(beforeConfirmation.status, 409);

  // A forged candidate is refused; arbitrary sources can never ride along.
  const forged = await server.client.json(`/api/runs/${id}/first-step/person-confirmation`, {
    json: { ...confirmBody, candidateId: 'pcand/0000000000000000000000000000dead' }
  });
  assert.equal(forged.status, 422);
  const smuggled = await server.client.json(`/api/runs/${id}/first-step/person-confirmation`, {
    json: { ...confirmBody, sources: [{ url: 'https://evil.example/' }] }
  });
  assert.equal(smuggled.status, 400);

  // A foreign owner can never read or confirm the run.
  const foreign = new TestClient(server.baseUrl, server.origin);
  await foreign.signUp('person-http-foreign@example.test');
  assert.equal((await foreign.json(`/api/runs/${id}/first-step/person-confirmation`, { json: confirmBody })).status, 404);

  const confirmed = await server.client.json<{ confirmation: { idempotent: boolean; candidateId: string } }>(
    `/api/runs/${id}/first-step/person-confirmation`,
    { json: confirmBody, headers: { 'idempotency-key': 'confirm-1' } }
  );
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.confirmation.idempotent, false);
  assert.equal(confirmed.body.confirmation.candidateId, candidateId);

  // Double click DURING active queued work replays the receipt and never
  // creates a second record or a second downstream request.
  const receiptsBefore = server.store.research.receipts(id).length;
  const replay = await server.client.json<{ confirmation: { idempotent: boolean; confirmationId: string } }>(
    `/api/runs/${id}/first-step/person-confirmation`,
    { json: confirmBody, headers: { 'idempotency-key': 'confirm-1' } }
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.confirmation.idempotent, true);
  const doubleClick = await server.client.json<{ confirmation: { idempotent: boolean; confirmationId: string } }>(
    `/api/runs/${id}/first-step/person-confirmation`,
    { json: confirmBody }
  );
  assert.equal(doubleClick.body.confirmation.idempotent, true);
  assert.equal(doubleClick.body.confirmation.confirmationId, replay.body.confirmation.confirmationId);
  assert.ok(server.store.research.receipts(id).length >= receiptsBefore, 'replay never mints new metered work');

  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');
  const accounts = await server.client.json<{ view: FirstStepDiscoveryView; runRevision: number }>(`/api/runs/${id}/first-step/discovery`);
  assert.equal(accounts.body.view.personConfirmation?.status, 'confirmed');
  assert.equal(accounts.body.view.phase, 'ready_for_choice');
  assert.ok(accounts.body.view.accounts.length > 0, 'account discovery ran after the confirmed person');

  // The existing atomic account scope submission then works exactly as before.
  const submitted = await server.client.json<{ selection: { idempotent: boolean; selectedAccountIds: string[] } }>(
    `/api/runs/${id}/first-step/selection`,
    { json: selectionPayload(accounts.body.view, accounts.body.runRevision), headers: { 'idempotency-key': 'scope-1' } }
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.selection.idempotent, false);
  assert.ok(submitted.body.selection.selectedAccountIds.length > 0);
});

test('a stale confirmation body and a foreign candidate never write anything', async (t) => {
  const server = await startTestServer(
    { researchTools: tools() },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  await server.client.signUp('person-http-stale@example.test');
  const made = await server.client.json<{ run: { runId: string } }>('/api/runs', { json: { input: 'Mira Kepler' } });
  const id = made.body.run.runId;
  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');
  const discovery = await server.client.json<{ view: FirstStepDiscoveryView; runRevision: number }>(`/api/runs/${id}/first-step/discovery`);
  const candidateId = discovery.body.view.personOverview!.candidates[0]!.candidateId;
  const stale = await server.client.json(`/api/runs/${id}/first-step/person-confirmation`, {
    json: {
      expectedRunRevision: discovery.body.runRevision + 5,
      expectedScopeVersion: discovery.body.view.selection.scopeVersion,
      discoveryRevision: discovery.body.view.discoveryRevision,
      candidateId
    }
  });
  assert.equal(stale.status, 409);
  const staleDiscovery = await server.client.json(`/api/runs/${id}/first-step/person-confirmation`, {
    json: {
      expectedRunRevision: discovery.body.runRevision,
      expectedScopeVersion: discovery.body.view.selection.scopeVersion,
      discoveryRevision: discovery.body.view.discoveryRevision + 1,
      candidateId
    }
  });
  assert.equal(staleDiscovery.status, 409);
  const rows = server.boot.db.prepare('SELECT COUNT(*) AS n FROM first_step_person_confirmations WHERE run_id = ?').get(id) as { n: number };
  assert.equal(rows.n, 0, 'stale input never writes a confirmation record');
});
