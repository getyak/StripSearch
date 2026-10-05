import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { seedFirstStep } from './first-step-fixtures.js';
import { createFirstStepPanel, type FirstStepPanelApi } from '../client/first-step.js';
import { clearFirstStepDrafts, firstStepDraftCache } from '../client/first-step-draft-storage.js';
import type { FirstStepDiscoveryResponse } from '../client/api.js';

function seed() {
  return seedFirstStep({ accounts: [
    { url: 'https://github.com/fixture-linzhou', supportedBy: { sourceUrl: 'https://fixture-linzhou.org/', quote: 'My GitHub: https://github.com/fixture-linzhou.' } },
    { url: 'https://x.com/fixture_lin', supportedBy: { sourceUrl: 'https://fixture-linzhou.org/', quote: 'My X: https://x.com/fixture_lin.' } }
  ] });
}

test('browser reload retains owner-isolated input and the same failed selection intent without granting authority', async t => {
  const env = installDom(), f = seed(); t.after(() => f.close());
  const result = f.firstStep.getFirstStepView('user-owner', f.run.id)!; assert.equal(result.mode, 'first_step'); if (result.mode !== 'first_step') throw new Error('wrong mode');
  let view = result.view; const requests: string[] = [];
  const api: FirstStepPanelApi = { async getFirstStepDiscovery() { return { mode: 'first_step', view, runRevision: 1 }; },
    async submitFirstStepSelection(_run, _payload, key) { requests.push(key); throw new Error('synthetic lost response'); }, async expandFirstStep() { return { queued: true }; } };
  const container = env.document.createElement('section'); env.document.body.appendChild(container);
  const deps = { api, container, runId: f.run.id, ownerId: 'user-owner', now: () => 1234 };
  const before = createFirstStepPanel(deps); await before.refresh(); assert.equal(before.selectedCount(), 2);
  container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
  const hint = container.querySelector<HTMLInputElement>('[aria-label="补线索"]')!;
  hint.value = 'User typed distinguishing clue'; hint.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await before.submit(); before.destroy();
  const newcomer = { ...view.accounts[0]!, accountId: 'new-after-reload', accountKey: 'new-after-reload', handle: 'new-after-reload' };
  view = { ...view, accounts: [...view.accounts, newcomer] };
  const after = createFirstStepPanel(deps); await after.refresh();
  assert.equal(after.selectedCount(), 1);
  assert.equal(after.draft().get(newcomer.accountId)?.selection, 'unanswered', 'newly arrived suggestions are not checked by reloading');
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="补线索"]')!.value, 'User typed distinguishing clue');
  // The new account changes the payload, so this request must rotate the key.
  await after.submit(); assert.notEqual(requests[0], requests[1]); after.destroy();
  const restored = createFirstStepPanel(deps); await restored.refresh(); await restored.submit();
  assert.equal(requests[1], requests[2], 'same payload after reload reuses the failed request key');
  assert.equal(f.firstStep.selectionBinding(f.run.id), null, 'local drafts never freeze backend scope'); restored.destroy();
  const other = createFirstStepPanel({ ...deps, ownerId: 'other-owner' }); await other.refresh();
  assert.equal(container.querySelector<HTMLInputElement>('[aria-label="补线索"]')!.value, '', 'another owner cannot load prior private input'); other.destroy();
  clearFirstStepDrafts('user-owner');
  assert.equal(firstStepDraftCache('user-owner', f.run.id).read(view.caseId, view.selection.scopeVersion), null);
});

test('a disposed panel ignores late private discovery responses after switching context', async t => {
  const env = installDom(), f = seed(); t.after(() => f.close());
  const response = f.firstStep.getFirstStepView('user-owner', f.run.id)!; if (response.mode !== 'first_step') throw new Error('wrong mode');
  const oldView = { ...response.view, clusters: response.view.clusters.map(c => ({ ...c, displayName: 'Previous private person' })) };
  const newView = { ...response.view, runId: 'current-run', clusters: response.view.clusters.map(c => ({ ...c, displayName: 'Current visible person' })) };
  let release!: (value: FirstStepDiscoveryResponse) => void;
  const pending = new Promise<FirstStepDiscoveryResponse>(resolve => { release = resolve; });
  const container = env.document.createElement('section'); env.document.body.appendChild(container);
  const api: FirstStepPanelApi = { getFirstStepDiscovery: async () => pending, async submitFirstStepSelection() { throw new Error('unused'); }, async expandFirstStep() { return { queued: true }; } };
  const oldPanel = createFirstStepPanel({ api, container, runId: f.run.id }); const refresh = oldPanel.refresh(); oldPanel.destroy();
  const current = createFirstStepPanel({ api: { ...api, async getFirstStepDiscovery() { return { mode: 'first_step', view: newView }; } }, container, runId: 'current-run' });
  await current.refresh(); release({ mode: 'first_step', view: oldView }); await refresh;
  assert.ok(container.textContent?.includes('Current visible person'));
  assert.ok(!container.textContent?.includes('Previous private person'));
  current.destroy();
});
