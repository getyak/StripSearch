import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { startTestServer, waitFor, type TestServer } from './harness.js';
import { createFirstStepPanel, type FirstStepPanelApi } from '../client/first-step.js';
import type { FirstStepDiscoveryResponse, FirstStepSelectionResponse } from '../client/api.js';
import type { FirstStepDiscoveryView } from '../shared/first-step-discovery.js';
import type { ResearchPage, ResearchTools } from '../server/research/tool-contracts.js';
import type { ResearchPlanner } from '../server/research/planner.js';

const env = installDom();

const profile = (handle: string, url = `https://github.com/${handle}`): ResearchPage => ({
  url,
  title: handle,
  text: `${handle} builds synthetic compilers. My GitHub: ${url}. Research Ada Fixture.`,
  kind: 'profile',
  publishedAt: null,
  links: [],
  limitations: []
});
const planner: ResearchPlanner = {
  async decide(input) {
    if (input.mode === 'verify') return { supported: [0], rejected: [] };
    return { action: 'finish', claims: [{ sourceKey: 'S1', quote: 'builds synthetic compilers' }], unknowns: [] };
  }
};
const tools: ResearchTools = {
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

/** Real HTTP adapter: GET/POST go through the actual server routes. */
function realApi(server: TestServer): FirstStepPanelApi {
  return {
    async getFirstStepDiscovery(runId) {
      const response = await server.client.json<FirstStepDiscoveryResponse>(`/api/runs/${runId}/first-step/discovery`);
      return response.body;
    },
    async submitFirstStepSelection(runId, payload, idempotencyKey) {
      const response = await server.client.json<FirstStepSelectionResponse>(`/api/runs/${runId}/first-step/selection`, {
        json: payload,
        headers: { 'idempotency-key': idempotencyKey }
      });
      return response.body;
    },
    async expandFirstStep(runId, body, idempotencyKey) {
      const response = await server.client.json<{ queued: boolean }>(`/api/runs/${runId}/first-step/expand`, {
        json: body,
        headers: { 'idempotency-key': idempotencyKey }
      });
      return response.body;
    }
  };
}

async function freshRun(server: TestServer, email: string): Promise<string> {
  await server.client.signUp(email);
  const made = await server.client.json<{ run: { runId: string } }>('/api/runs', { json: { input: 'Research Ada Fixture' } });
  const id = made.body.run.runId;
  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');
  // GET-213 staged name flow: the account workspace appears AFTER the
  // explicit person confirmation; drive the real confirmation first.
  const overview = await server.client.json<{ view: FirstStepDiscoveryView; runRevision: number }>(`/api/runs/${id}/first-step/discovery`);
  assert.equal(overview.body.view.personConfirmation?.required, true);
  const confirmed = await server.client.json(`/api/runs/${id}/first-step/person-confirmation`, {
    json: {
      expectedRunRevision: overview.body.runRevision,
      expectedScopeVersion: overview.body.view.selection.scopeVersion,
      discoveryRevision: overview.body.view.discoveryRevision,
      candidateId: overview.body.view.personOverview!.candidates[0]!.candidateId
    },
    headers: { 'idempotency-key': `confirm-${email}` }
  });
  assert.equal(confirmed.status, 200);
  await waitFor(() => server.store.getRun(id)?.state === 'needs_input');
  return id;
}

test('real GET/POST integration: render, choose one scope confirmation, fetch starts', async (t) => {
  const server = await startTestServer(
    { researchTools: tools, researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  const runId = await freshRun(server, 'ui-owner@example.test');
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const submitted: FirstStepSelectionResponse[] = [];
  const panel = createFirstStepPanel({
    api: realApi(server),
    container,
    runId,
    onAfterSubmit: (result) => submitted.push(result)
  });
  await panel.refresh();
  assert.equal(panel.statusText(), 'ready');
  const checkboxes = container.querySelectorAll<HTMLInputElement>('.first-step-select input[type="checkbox"]');
  assert.ok(checkboxes.length >= 2, 'account cards render with checkboxes');
  assert.equal(container.querySelectorAll('.first-step-cluster').length >= 1, true, 'person clusters render');
  const primary = container.querySelector<HTMLButtonElement>('.first-step-primary')!;
  assert.ok(primary, 'one primary action exists');
  assert.equal(container.querySelectorAll('.first-step-primary').length, 1);
  assert.equal(primary.disabled, true, 'zero selection disables the primary action');
  assert.match(container.textContent ?? '', /还没有选择研究账号/);

  // Card checkbox enables the submit with a count.
  checkboxes[0]!.click();
  const primary2 = container.querySelector<HTMLButtonElement>('.first-step-primary')!;
  assert.equal(primary2.disabled, false);
  assert.match(primary2.textContent ?? '', /继续研究（1 个账号）/, 'the action keeps the visible selection count');

  // Evidence details carry real source metadata and never toggle selection.
  const before = panel.draft().get([...panel.draft().keys()][0]!)!.selection;
  const summary = container.querySelector<HTMLElement>('.first-step-evidence summary')!;
  summary.click();
  assert.equal(panel.draft().get([...panel.draft().keys()][0]!)!.selection, before, 'evidence entry does not toggle the checkbox');

  // The one atomic submit goes through the real POST route.
  const result = await panel.submit();
  assert.ok(result, 'submit succeeded');
  assert.equal(submitted.length, 1);
  assert.equal(result!.selection.idempotent, false);
  const after = await server.client.json<{ view: FirstStepDiscoveryView }>(`/api/runs/${runId}/first-step/discovery`);
  assert.equal(after.body.view.selection.submitted, true);
  assert.ok(after.body.view.selection.selectedAccountIds.length >= 1);
  await waitFor(() => ['queued', 'researching', 'partial', 'completed', 'failed'].includes(server.store.getRun(runId)?.state ?? ''));
});

test('draft and SSE pushes: server views never overwrite user decisions or auto-check new accounts', async (t) => {
  const server = await startTestServer(
    { researchTools: tools, researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  const runId = await freshRun(server, 'ui-draft@example.test');
  const container = env.document.createElement('div');
  const panel = createFirstStepPanel({ api: realApi(server), container, runId });
  await panel.refresh();
  const keys = [...panel.draft().keys()];
  assert.ok(keys.length >= 2);
  // The user picks an explicit independent scope on the first uncertain card.
  const independentButton = [...container.querySelectorAll<HTMLButtonElement>('button.text-button')].find(
    (button) => button.textContent === '仅研究这个公开账号'
  )!;
  const uncertain = keys[0]!;
  independentButton.click();
  assert.equal(panel.draft().get(uncertain)!.selection, 'only_this_account');
  const chosen = uncertain;

  // A later server push (SSE/refresh) with a NEW account must not touch the
  // draft and must not auto-check the newcomer even with a suggestion.
  const current = container.querySelector('.first-step-accounts');
  assert.ok(current);
  const response = await realApi(server).getFirstStepDiscovery(runId);
  const view = response.view!;
  const extraAccount = {
    ...view.accounts[0]!,
    accountId: 'acct_fs_newcomer',
    accountKey: `${view.accounts[0]!.accountKey}-new`,
    profileUrl: 'https://github.com/newcomer',
    handle: 'newcomer',
    defaultSuggestion: { suggested: true, reason: '建议默认勾选' }
  };
  panel.applyView({ ...view, accounts: [...view.accounts, extraAccount] }, view.discoveryRevision);
  assert.equal(panel.draft().get(uncertain)!.selection, 'only_this_account', 'SSE push never overwrites the user draft');
  assert.equal(panel.draft().get(chosen)!.selection, 'only_this_account');
  assert.equal(panel.draft().get('acct_fs_newcomer')!.selection, 'unanswered', 'a later-discovered account is never auto-checked');
  assert.equal(panel.selectedCount(), 1);
});

test('exclusion is separate from unchecking and revoking it never selects the account', async (t) => {
  const server = await startTestServer(
    { researchTools: tools, researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  const runId = await freshRun(server, 'ui-exclude@example.test');
  const container = env.document.createElement('div');
  const panel = createFirstStepPanel({ api: realApi(server), container, runId });
  await panel.refresh();
  const firstKey = [...panel.draft().keys()][0]!;
  // Unchecking is not a denial.
  panel.draft().get(firstKey)!.selection = 'not_selected';
  assert.equal(panel.draft().get(firstKey)!.excluded, false);

  const excludeButton = [...container.querySelectorAll<HTMLButtonElement>('button.text-button')].find(
    (button) => button.textContent === '不是此人'
  )!;
  excludeButton.click();
  assert.equal(panel.draft().get(firstKey)!.excluded, true, 'the explicit exclusion statement is recorded');
  assert.equal(panel.draft().get(firstKey)!.selection, 'not_selected');

  const revoke = [...container.querySelectorAll<HTMLButtonElement>('button.text-button')].find(
    (button) => button.textContent === '撤销排除声明'
  )!;
  revoke.click();
  assert.equal(panel.draft().get(firstKey)!.excluded, false);
  assert.equal(panel.draft().get(firstKey)!.selection, 'unanswered', 'revocation never becomes a selection');
});

test('zero-selection submit is refused with an explanation and evidence Esc returns focus', async (t) => {
  const server = await startTestServer(
    { researchTools: tools, researchPlanner: planner },
    { DEEPSEEK_API_KEY: 'offline-fixture', EXA_API_KEY: 'offline-fixture' }
  );
  t.after(() => server.close());
  const runId = await freshRun(server, 'ui-zero@example.test');
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  let posted = 0;
  const api = realApi(server);
  const panel = createFirstStepPanel({
    api: {
      ...api,
      async submitFirstStepSelection() {
        posted++;
        throw new Error('must not post');
      }
    },
    container,
    runId
  });
  await panel.refresh();
  const result = await panel.submit();
  assert.equal(result, null);
  assert.equal(posted, 0, 'zero selection never reaches the API');
  assert.match(container.textContent ?? '', /请至少选择一个账号/);

  const details = container.querySelector<HTMLDetailsElement>('.first-step-evidence')!;
  const summary = details.querySelector<HTMLElement>('summary')!;
  details.open = true;
  summary.focus();
  details.dispatchEvent(new (env.window as unknown as { KeyboardEvent: new (type: string, init: { key: string }) => Event }).KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(details.open, false, 'Esc closes the evidence panel');
  assert.equal(env.document.activeElement, summary, 'focus returns to the trigger');
});
