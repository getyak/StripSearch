/**
 * Workspace-polish DOM regressions (Figma 251:4082 adaptation):
 * - combined candidate card: the choice button and its expandable provenance
 *   share ONE compact article; provenance/evidence actions never change the
 *   person or account selection;
 * - external first-step-actions footer host outside the scrollable work-body:
 *   lifecycle (create/destroy), live count and stale-response safety.
 * All state is synthetic; no invented people or fake evidence beyond the
 * existing first-step fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { seedFirstStep } from './first-step-fixtures.js';
import { createFirstStepPanel, type FirstStepPanelApi } from '../client/first-step.js';
import type { FirstStepDiscoveryResponse, FirstStepSelectionPayload, FirstStepSelectionResponse } from '../client/api.js';
import type { FirstStepDiscoveryView, FirstStepPersonClusterView } from '../shared/first-step-discovery.js';

const env = installDom();

function cluster(clusterId: string, displayName: string, anchorAccountId: string, accountIds: string[]): FirstStepPersonClusterView {
  return {
    clusterId,
    displayName,
    anchorUrl: null,
    anchorLabel: '合成锚点',
    anchorAccountId,
    linkage: 'unconfirmed',
    anchorBasis: {
      label: '公开原文中的明确链接',
      quote: '<p>合成依据摘录：公开原文写明这个账号入口。</p>',
      sourceUrl: 'https://lantern.dev/about'
    },
    leads: [
      {
        atomId: `lead-${clusterId}`,
        statement: `${displayName}：合成线索陈述`,
        quote: '<p>合成线索摘录：页面自述提到这个账号。</p>',
        sourceUrl: 'https://lantern.dev/about',
        evidenceIds: []
      }
    ],
    conflicts: [],
    accountIds
  };
}

function panelApi(fixture: ReturnType<typeof seedFirstStep>, posted: FirstStepSelectionPayload[] = []): FirstStepPanelApi {
  return {
    async getFirstStepDiscovery(): Promise<FirstStepDiscoveryResponse> {
      const result = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
      assert.ok(result && result.mode === 'first_step');
      return { mode: 'first_step', view: (result as { view: FirstStepDiscoveryView }).view, runRevision: 1 };
    },
    async submitFirstStepSelection(_runId: string, payload: FirstStepSelectionPayload): Promise<FirstStepSelectionResponse> {
      posted.push(payload);
      return {
        selection: {
          runRevision: 2,
          scopeVersion: 2,
          discoveryRevision: 1,
          clusterId: payload.clusterId,
          selectedAccountIds: payload.accounts.filter((a) => a.selection === 'selected').map((a) => a.accountId),
          independentAccountIds: payload.accounts.filter((a) => a.selection === 'only_this_account').map((a) => a.accountId),
          excludedAccountIds: payload.accounts.filter((a) => a.excluded).map((a) => a.accountId),
          idempotent: false
        }
      };
    },
    async expandFirstStep(): Promise<{ queued: boolean }> {
      return { queued: true };
    }
  };
}

function twoSameNameFixture() {
  return seedFirstStep({
    accounts: [
      { url: 'https://github.com/linzhou', identityState: 'supported', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: '<p>My GitHub: <a href="https://github.com/linzhou">account</a> 合成依据摘录。</p>' } },
      { url: 'https://x.com/linzhou', identityState: 'supported', supportedBy: { sourceUrl: 'https://kepler.dev/about', quote: '<p>My X: https://x.com/linzhou. 合成依据摘录。</p>' } }
    ]
  });
}

test('the dedicated actions host is registered outside the scrollable work-body', () => {
  // Structural contract of the app shell: checked before any test cleanup can
  // remove the static shell nodes from the shared document.
  const shellHost = env.document.getElementById('first-step-actions');
  const workBody = env.document.getElementById('work-body');
  assert.ok(shellHost, 'index.html provides the dedicated first-step-actions host');
  assert.ok(workBody && !workBody.contains(shellHost), 'the actions host is outside the scrollable work-body');
  assert.ok(env.document.getElementById('chat-dock'), 'the chat dock is a single hideable host');
});

test('one compact card per candidate holds button + provenance; provenance actions never change the selection', async () => {
  const fixture = twoSameNameFixture();
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [
        cluster('person-a', '林舟', view.accounts[0]!.accountId, [view.accounts[0]!.accountId]),
        cluster('person-b', '林舟', view.accounts[1]!.accountId, [view.accounts[1]!.accountId])
      ]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();

    // Combined card: exactly one article frame per candidate, holding BOTH the
    // aria-pressed choice button and the expandable provenance details.
    const cards = container.querySelectorAll('article.first-step-candidate');
    assert.equal(cards.length, 2, 'same-name candidates stay separate compact cards');
    for (const card of cards) {
      assert.equal(card.querySelectorAll(':scope > button.first-step-cluster').length, 1, 'the choice button lives inside the candidate card');
      assert.equal(card.querySelectorAll(':scope > details.first-step-cluster-basis').length, 1, 'provenance lives inside the same card');
      const button = card.querySelector<HTMLButtonElement>('button.first-step-cluster')!;
      assert.ok(button.dataset.focusKey?.startsWith('cluster-'), 'stable focus key survives');
      assert.ok(['true', 'false'].includes(button.getAttribute('aria-pressed')!), 'aria-pressed stays explicit');
      assert.ok(button.querySelector('strong'), 'the candidate name stays readable in the button');
      assert.match(card.textContent ?? '', /辨识依据与出处/, 'the provenance disclosure is part of the card');
    }
    assert.equal(container.querySelectorAll('img').length, 0, 'no image is fabricated for people or platforms');

    // Explicit selection shows meaningful visible text.
    const firstButton = container.querySelector<HTMLButtonElement>('button.first-step-cluster')!;
    const firstKey = firstButton.dataset.focusKey;
    firstButton.click();
    assert.match(container.querySelector('.first-step-candidate.chosen')?.textContent ?? '', /已选择为目标/);

    // Provenance actions are selection-isolated: opening the disclosure and
    // clicking quoted evidence must not change who is chosen.
    const chosenBefore = container.querySelector<HTMLButtonElement>('button.first-step-cluster[aria-pressed="true"]')!;
    assert.equal(chosenBefore.dataset.focusKey, firstKey);
    const provenance = chosenBefore.closest('article')!.querySelector<HTMLDetailsElement>('details.first-step-cluster-basis')!;
    provenance.querySelector<HTMLElement>('summary')!.click(); // user opens the provenance
    provenance.open = true;
    provenance.querySelector<HTMLElement>('blockquote')!.click();
    provenance.querySelector<HTMLElement>('.first-step-evidence-item')!.click();
    const pressed = container.querySelectorAll<HTMLButtonElement>('button.first-step-cluster[aria-pressed="true"]');
    assert.equal(pressed.length, 1, 'exactly one person choice stays active');
    assert.equal(pressed[0]!.dataset.focusKey, firstKey, 'evidence actions cannot trigger selection');
    assert.equal(provenance.open, true, 'the provenance stays open');

    // The card body does choose, and only one candidate stays pressed.
    const other = [...container.querySelectorAll<HTMLElement>('article.first-step-candidate')].find(
      (card) => card.querySelector<HTMLButtonElement>('button.first-step-cluster')!.dataset.focusKey !== firstKey
    )!;
    other.click();
    const pressedAfter = container.querySelectorAll<HTMLButtonElement>('button.first-step-cluster[aria-pressed="true"]');
    assert.equal(pressedAfter.length, 1);
    assert.notEqual(pressedAfter[0]!.dataset.focusKey, firstKey, 'the explicit card action moved the person choice');
    assert.equal(fixture.firstStep.selectionBinding(fixture.run.id), null, 'nothing is persisted before the atomic submit');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('account disclosure inside its card never toggles the account selection', async () => {
  const fixture = twoSameNameFixture();
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  try {
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    container.querySelector<HTMLButtonElement>('button.first-step-cluster')!.click();
    const card = container.querySelector<HTMLElement>('.first-step-accounts .first-step-card')!;
    assert.ok(card, 'the chosen target shows its accounts');
    const checkbox = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const accountId = checkbox.dataset.focusKey!.replace(/^account-/, '');
    assert.equal(checkbox.checked, true, 'the suggested account of the chosen target is visibly selected');
    const disclosure = card.querySelector<HTMLDetailsElement>('details.first-step-evidence')!;
    assert.ok(disclosure, 'provenance disclosure lives inside the account card');
    disclosure.open = true;
    disclosure.querySelector<HTMLElement>('summary')!.click();
    disclosure.querySelector<HTMLElement>('blockquote, .first-step-evidence-item, p')!.click();
    assert.equal(card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true, 'evidence actions cannot trigger selection');
    assert.notEqual(panel.draft().get(accountId)!.selection, 'not_selected');
    // The visible selection affordance is text, not only the checkbox chrome.
    assert.match(card.textContent ?? '', /已加入/);
    // Clicking the select control still toggles explicitly.
    card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    assert.equal(container.querySelector<HTMLInputElement>(`input[data-focus-key="account-${accountId}"]`)!.checked, false);
    assert.equal(panel.draft().get(accountId)!.selection, 'not_selected');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('external first-step-actions host: lifecycle, live count and stale-refresh preservation', async () => {
  const fixture = twoSameNameFixture();
  const container = env.document.createElement('section');
  const host = env.document.createElement('div');
  env.document.body.append(container, host);
  try {
    const posted: FirstStepSelectionPayload[] = [];
    let failed = false;
    const api = panelApi(fixture);
    const panel = createFirstStepPanel({
      api: {
        ...api,
        async submitFirstStepSelection(runId, payload, key) {
          posted.push(payload);
          if (failed) throw new Error('synthetic lost response');
          return {
            selection: {
              runRevision: 2,
              scopeVersion: 2,
              discoveryRevision: 1,
              clusterId: payload.clusterId,
              selectedAccountIds: payload.accounts.filter((a) => a.selection === 'selected').map((a) => a.accountId),
              independentAccountIds: payload.accounts.filter((a) => a.selection === 'only_this_account').map((a) => a.accountId),
              excludedAccountIds: payload.accounts.filter((a) => a.excluded).map((a) => a.accountId),
              idempotent: false
            }
          };
        }
      },
      container,
      runId: fixture.run.id,
      footerContainer: host
    });
    await panel.refresh();
    assert.ok(host.querySelector('.first-step-footer'), 'the confirmation footer renders in the dedicated host');
    assert.equal(container.querySelector('.first-step-footer'), null, 'the footer is not left inside the scrollable column');

    // Zero selection keeps the action disabled but visible in the host.
    let checked = container.querySelector<HTMLInputElement>('.first-step-accounts input[type="checkbox"]:checked');
    while (checked) {
      checked.click();
      checked = container.querySelector<HTMLInputElement>('.first-step-accounts input[type="checkbox"]:checked');
    }
    assert.match(host.textContent ?? '', /还没有选择研究账号/);
    assert.equal(host.querySelector<HTMLButtonElement>('.first-step-primary')!.disabled, true);
    assert.equal(panel.selectedCount(), 0);

    // Count and enabled state update in the host as the user selects.
    container.querySelector<HTMLInputElement>('.first-step-accounts input[type="checkbox"]')!.click();
    assert.match(host.textContent ?? '', /已选 1 个账号/);
    assert.equal(host.querySelector<HTMLButtonElement>('.first-step-primary')!.disabled, false);

    // A later server push preserves the count and never auto-checks newcomers.
    const view = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id)! as { view: FirstStepDiscoveryView };
    const newcomer = { ...view.view.accounts[0]!, accountId: 'acct-newcomer', accountKey: 'github:newcomer', profileUrl: 'https://github.com/newcomer', handle: 'newcomer', defaultSuggestion: { suggested: true, reason: '建议默认勾选' } };
    panel.applyView({ ...view.view, accounts: [...view.view.accounts, newcomer] }, 2);
    assert.match(host.textContent ?? '', /已选 1 个账号/, 'the visible count survives re-renders and stale refreshes');
    assert.equal(panel.draft().get('acct-newcomer')!.selection, 'unanswered', 'a later-discovered account is never auto-checked');

    // A failed submit keeps the count and surfaces the error in the host.
    failed = true;
    await panel.submit();
    assert.match(host.textContent ?? '', /已选 1 个账号/);
    assert.match(host.textContent ?? '', /synthetic lost response/, 'errors stay visible beside the action');
    assert.equal(posted.length, 1, 'the failed attempt still sent exactly the one atomic payload');

    // Lifecycle: destroy (run switch / logout) clears the host completely.
    panel.destroy();
    assert.equal(host.textContent?.trim(), '', 'no stale count/error/action survives panel destroy');
    assert.equal(container.textContent?.trim(), '', 'the panel column is cleared too');

    // Stale discovery responses after destroy can never repaint the host.
    let release!: (value: FirstStepDiscoveryResponse) => void;
    const pending = new Promise<FirstStepDiscoveryResponse>((resolve) => { release = resolve; });
    const stalePanel = createFirstStepPanel({
      api: { ...api, getFirstStepDiscovery: async () => pending },
      container,
      runId: fixture.run.id,
      footerContainer: host
    });
    const refreshing = stalePanel.refresh();
    stalePanel.destroy();
    release({ mode: 'first_step', view: view.view, runRevision: 3 });
    await refreshing;
    assert.equal(host.textContent?.trim(), '', 'a stale response cannot resurrect footer actions');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});
