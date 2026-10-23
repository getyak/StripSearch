/**
 * Account comparison workspace (2026-10-21) renderer regressions: aligned
 * account rows with fixed account/content/basis/status/selection columns, a
 * compact person summary above the list, honest label separation, inline
 * evidence disclosure isolation, and presentation-only filter/search.
 *
 * All state is synthetic; no invented people, external requests or fixtures
 * fetched from the network.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { seedFirstStep } from './first-step-fixtures.js';
import { createFirstStepPanel, type FirstStepPanelApi } from '../client/first-step.js';
import type { FirstStepDiscoveryResponse, FirstStepSelectionPayload, FirstStepSelectionResponse } from '../client/api.js';
import type { FirstStepAccountView, FirstStepDiscoveryView, FirstStepPersonClusterView } from '../shared/first-step-discovery.js';

const env = installDom();

test('closing person choices stays closed through account selection, filters and refreshed data', async () => {
  const fixture = eightAccounts();
  try {
    fixture.republish(view => ({ ...view, clusters: [
      cluster('person-a', 'Lin Zhou', view.accounts[0]!.accountId, [view.accounts[0]!.accountId]),
      cluster('person-b', 'Morgan Chen', view.accounts[1]!.accountId, [view.accounts[1]!.accountId])
    ] }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({api: panelApi(fixture), container, runId: fixture.run.id});
    await panel.refresh();
    container.querySelector<HTMLDetailsElement>('details.first-step-other-people')!.open = false;
    const checkbox = container.querySelector<HTMLInputElement>('.first-step-accounts input[type="checkbox"]')!;
    checkbox.focus();
    const focusKey = checkbox.dataset.focusKey;
    checkbox.click();
    assert.equal(container.querySelector<HTMLDetailsElement>('details.first-step-other-people')!.open, false, 'selection must respect explicitly closed person choices');
    assert.equal((env.document.activeElement as HTMLElement).dataset.focusKey, focusKey);
    container.querySelector<HTMLButtonElement>('[data-filter="selected"]')!.click();
    assert.equal(container.querySelector<HTMLDetailsElement>('details.first-step-other-people')!.open, false);
    const response = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
    assert.ok(response?.mode === 'first_step');
    panel.applyView({...response.view, updatedAt:'2026-10-22T02:00:00.000Z'}, 2);
    assert.equal(container.querySelector<HTMLDetailsElement>('details.first-step-other-people')!.open, false, 'fresh data must not reopen a closed disclosure');
    panel.destroy();
  } finally { fixture.close(); env.document.body.replaceChildren(); }
});

test('reading an account row does not change its checkbox and secondary actions require an explicit menu', async () => {
  const fixture = eightAccounts();
  try {
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({api:panelApi(fixture),container,runId:fixture.run.id});
    await panel.refresh();
    const row = container.querySelector<HTMLElement>('.first-step-card')!;
    const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const checked = checkbox.checked;
    row.querySelector<HTMLElement>('.first-step-cell-content')!.click();
    assert.equal(container.querySelector<HTMLInputElement>('.first-step-card input[type="checkbox"]')!.checked, checked, 'reading and selecting are separate actions');
    const menu = container.querySelector<HTMLDetailsElement>('.first-step-row-menu')!;
    assert.ok(menu, 'exceptional actions have their own menu');
    assert.equal(menu.open, false);
    assert.ok(menu.querySelector('button[aria-label^="声明"]'));
    menu.open = true;
    menu.querySelector('button')!.dispatchEvent(new env.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert.equal(menu.open,false);
    assert.equal(env.document.activeElement,menu.querySelector('summary'));
    panel.destroy();
  } finally { fixture.close(); env.document.body.replaceChildren(); }
});

test('completing a secondary action returns keyboard focus to the visible row menu trigger', async () => {
  const fixture=eightAccounts();
  try {
    const container=env.document.createElement('div');env.document.body.appendChild(container);
    const panel=createFirstStepPanel({api:panelApi(fixture),container,runId:fixture.run.id});await panel.refresh();
    const menu=container.querySelector<HTMLDetailsElement>('.first-step-row-menu')!;
    menu.open=true;
    const action=menu.querySelector<HTMLButtonElement>('button[aria-label^="声明"]')!;
    action.focus();action.click();
    const next=container.querySelector<HTMLDetailsElement>('.first-step-row-menu')!;
    assert.equal(next.open,false,'the completed action closes its menu');
    assert.equal(env.document.activeElement,next.querySelector('summary'),'focus returns to a visible control rather than a hidden action');
    panel.destroy();
  } finally {fixture.close();env.document.body.replaceChildren();}
});

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

function cluster(clusterId: string, displayName: string, anchorAccountId: string, accountIds: string[], extra: Partial<FirstStepPersonClusterView> = {}): FirstStepPersonClusterView {
  return {
    clusterId,
    displayName,
    anchorUrl: null,
    anchorLabel: '合成锚点',
    anchorAccountId,
    linkage: 'unconfirmed',
    anchorBasis: null,
    leads: [],
    conflicts: [],
    accountIds,
    ...extra
  };
}

/** Eight synthetic accounts across platforms: 5 supported, 3 independent. */
function eightAccounts() {
  return seedFirstStep({
    input: { kind: 'name_query', value: 'Lin Zhou', question: '研究这位创作者的公开作品' },
    accounts: [
      { url: 'https://linzhou-fixture.dev/', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about', quote: '<p>My site: <a href="https://linzhou-fixture.dev/">home</a></p>' } },
      { url: 'https://github.com/fixture-linzhou', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://github.com/fixture-lantern', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://x.com/fixture_lin', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://medium.com/@linzhou', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://mastodon.social/@fixture-lin' },
      { url: 'https://hachyderm.io/@fixture-lin' },
      { url: 'https://www.youtube.com/@linzhou' }
    ]
  });
}

test('eight accounts render as aligned rows with fixed columns and one compact person summary above', async () => {
  const fixture = eightAccounts();
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [
        cluster('person-a', 'Lin Zhou', view.accounts[0]!.accountId, view.accounts.slice(0, 7).map((a) => a.accountId), { linkage: 'linked' }),
        cluster('person-b', 'Morgan Chen Video', view.accounts[7]!.accountId, [view.accounts[7]!.accountId])
      ]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();

    const rows = container.querySelectorAll('.first-step-accounts .first-step-card');
    assert.equal(rows.length, 8, 'all eight accounts are rows in the comparison list');
    const head = container.querySelector('.first-step-row-head')!;
    assert.equal(
      [...head.querySelectorAll('span')].map((span) => span.textContent).join(','),
      '账号,能了解什么,归属依据,状态,选择',
      'the five comparison columns are fixed and aligned'
    );
    for (const row of rows) {
      const cells = row.querySelectorAll(':scope > .first-step-cell');
      assert.equal(cells.length, 5, 'every row carries exactly the five column cells');
      assert.ok(row.querySelector(':scope > details.first-step-evidence'), 'the disclosure expands under its own row');
    }
    // Person summary is a compact horizontal card ABOVE the account list.
    const children = [...container.children];
    const personIndex = children.findIndex((el) => el.classList.contains('first-step-clusters'));
    const accountsIndex = children.findIndex((el) => el.classList.contains('first-step-accounts'));
    assert.ok(personIndex >= 0 && personIndex < accountsIndex, 'the person summary sits above the account list');
    const summary = container.querySelector('.first-step-candidate.chosen.first-step-person')!;
    assert.ok(summary, 'the chosen person is one compact summary card');
    assert.match(summary.textContent ?? '', /已选择为目标/);
    assert.match(container.querySelector('.first-step-other-people')?.textContent ?? '', /更换目标人物/, 'competing people stay behind one explicit disclosure');
    // Selection semantics are explained once; no decorative frames remain.
    assert.equal(container.querySelectorAll('.first-step-scope-note').length, 1);
    assert.match(container.querySelector('.first-step-scope-note')!.textContent ?? '', /勾选只决定本轮读取范围/);
    assert.equal(container.querySelectorAll('.first-step-watermark, .first-step-avatar, .first-step-person-image').length, 0, 'large watermarks and decorative blocks are gone');
    assert.equal(container.querySelectorAll('img').length, 0);
    // Supported accounts are suggested once; independent rows stay unchecked.
    assert.equal(container.querySelectorAll('.first-step-card.checked').length, 5);
    assert.equal(panel.selectedCount(), 5);
    assert.equal(fixture.firstStep.selectionBinding(fixture.run.id), null, 'rendering never persists authority');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('long page titles, handles and URLs stay literal with the full original inside the disclosure', async () => {
  const longTitle = 'Lin Zhou | Synthetic University Press · 第二版序言、致谢与长期项目档案 2026';
  const longUrl = 'https://fixture-archive.example.test/research/public/2026/10/21/an-extremely-long-source-path-that-must-stay-inspectable?edition=2&lang=zh';
  const fixture = seedFirstStep({
    input: { kind: 'name_query', value: 'Lin Zhou', question: '研究这位创作者的公开作品' },
    accounts: [
      { url: 'https://linzhou-fixture.dev/', supportedBy: { sourceUrl: longUrl, quote: '<p>My site: <a href="https://linzhou-fixture.dev/">home</a></p>' } },
      { url: 'https://github.com/fixture-with-a-very-long-handle', identityState: 'proposed' }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [
        cluster('primary', longTitle, view.accounts[1]!.accountId, [view.accounts[1]!.accountId], { linkage: 'linked' }),
        cluster('other', 'Lin Zhou', view.accounts[0]!.accountId, [view.accounts[0]!.accountId])
      ],
      accounts: view.accounts.map((account, index) =>
        index === 0 ? { ...account, displayName: longTitle } : account
      )
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    // The literal page title is never cut into a name: the summary labels the
    // person by handle and keeps the title verbatim beside it.
    const summary = container.querySelector('.first-step-candidate.chosen')!;
    assert.match(summary.textContent ?? '', /页面标题：Lin Zhou \| Synthetic University Press · 第二版序言、致谢与长期项目档案 2026/);
    assert.doesNotMatch(summary.querySelector('strong')!.textContent ?? '', /\||第二版/, 'the name slot never holds a cut page title');
    assert.match(summary.querySelector('strong')!.textContent ?? '', /fixture-with-a-very-long-handle/, 'the handle label stays literal');
    const chooser = container.querySelector('details.first-step-other-people')!;
    assert.match(chooser.textContent ?? '', /Lin Zhou/);
    assert.doesNotMatch(chooser.querySelector('strong')!.textContent ?? '', /\|/, 'the other candidate is labelled by query, not by a cut title');
    // The long handle row keeps its literal handle; full URLs stay inspectable.
    const rows = [...container.querySelectorAll('.first-step-accounts .first-step-card')];
    const handleRow = rows.find((row) => /fixture-with-a-very-long-handle/.test(row.textContent ?? ''))!;
    assert.ok(handleRow, 'the long handle stays literal in its row');
    const titledRow = rows.find((row) => /linzhou-fixture\.dev/.test(row.textContent ?? ''))!;
    const evidence = titledRow.querySelector<HTMLDetailsElement>('details.first-step-evidence')!;
    assert.match(evidence.textContent ?? '', new RegExp(longUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the full original URL stays in the evidence details');
    assert.match(evidence.textContent ?? '', /页面标题：Lin Zhou \| Synthetic University Press/, 'literal page titles are labelled, not renamed');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('same-name people stay separate with honest labels and literal titles', async () => {
  const fixture = seedFirstStep({
    input: { kind: 'name_query', value: 'Lin Zhou', question: '研究这位创作者的公开作品' },
    accounts: [
      { url: 'https://linzhou-fixture.dev/', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://github.com/linzhou-kepler', supportedBy: { sourceUrl: 'https://kepler-fixture.dev/about' } }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [
        cluster('kepler', 'Lin Zhou · Kepler Lab', view.accounts[1]!.accountId, [view.accounts[1]!.accountId]),
        cluster('lantern', 'Lin Zhou | Synthetic University', view.accounts[0]!.accountId, [view.accounts[0]!.accountId], { linkage: 'linked' })
      ],
      accounts: view.accounts.map((account, index) =>
        index === 0
          ? {
              ...account,
              identity: {
                ...account.identity,
                ownerAnchor: {
                  state: 'self_declared' as const,
                  personLabel: 'Lin Zhou',
                  policyVersion: 'named-owner/v1' as const,
                  claims: [],
                  counterevidenceIds: []
                },
                ownerValidity: 'valid' as const,
                ownerEvidence: [{ evidenceId: 'oe-1', quote: '我叫林舟', sourceUrl: 'https://lantern-fixture.dev/about', sourceTitle: '合成 About', revoked: false }]
              }
            }
          : account
      )
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    const chooser = container.querySelector<HTMLDetailsElement>('details.first-step-other-people')!;
    assert.match(chooser.textContent ?? '', /同名不合并/, 'the change-person trigger states that candidates are not merged');
    assert.match(chooser.textContent ?? '', /其它候选 1 个/);
    // Source-backed owner label for the chosen candidate; the twin stays a handle.
    const summary = container.querySelector('.first-step-candidate.chosen')!;
    assert.equal(summary.querySelector('strong')!.textContent, 'Lin Zhou');
    assert.match(summary.textContent ?? '', /账号自述姓名 · 尚未独立验证/);
    assert.match(summary.textContent ?? '', /页面标题：Lin Zhou \| Synthetic University/);
    const twin = chooser.querySelector('article.first-step-candidate')!;
    assert.match(twin.textContent ?? '', /Lin Zhou · Kepler Lab/, 'the same-name candidate keeps its literal page title');
    assert.match(twin.textContent ?? '', /@linzhou-kepler/, 'and is labelled by handle, never by a stripped title');
    assert.equal(twin.querySelector('button.first-step-cluster')!.getAttribute('aria-pressed'), 'false');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('selected, uncertain, conflicted and revoked rows keep identity state separate from selection state', async () => {
  const fixture = seedFirstStep({
    input: { kind: 'name_query', value: 'Lin Zhou', question: '研究这位创作者的公开作品' },
    accounts: [
      { url: 'https://linzhou-fixture.dev/', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://x.com/fixture_lin' },
      { url: 'https://github.com/fixture-linzhou' },
      { url: 'https://www.reddit.com/user/fixture_lin/', identityState: 'revoked' }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [cluster('primary', 'Lin Zhou', view.accounts[0]!.accountId, view.accounts.map((a) => a.accountId), { linkage: 'linked' })]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    // The live projection re-derives identity state from the case store; these
    // synthetic conflicted/revoked states are fed to the RENDERER only — no
    // identity classifier or server gate is weakened.
    const projected = (fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id) as { view: FirstStepDiscoveryView }).view;
    panel.applyView({
      ...projected,
      accounts: projected.accounts.map((account) => {
        if (account.handle === 'fixture-linzhou') {
          return { ...account, identity: { ...account.identity, state: 'disputed' as const, nativeIdConflict: true, conflicts: ['实际原生 ID 冲突，只能独立研究。'] } };
        }
        if (account.profileUrl?.includes('reddit')) {
          return { ...account, identity: { ...account.identity, state: 'revoked' as const } };
        }
        return account;
      })
    }, 2);
    const rows = [...container.querySelectorAll('.first-step-accounts .first-step-card')];
    const rowFor = (needle: string) => rows.find((row) => new RegExp(needle).test(row.textContent ?? ''))!;
    const badge = (row: Element) => row.querySelector('.first-step-badge')!.textContent;
    assert.equal(badge(rowFor('linzhou-fixture\\.dev')), '原文支持账号关联');
    assert.equal(badge(rowFor('fixture_lin')), '可能相关');
    assert.equal(badge(rowFor('fixture-linzhou')), '存在冲突');
    assert.equal(badge(rowFor('reddit')), '依据已撤回');
    // The account-specific conflict is the row's main clue, not a generic summary.
    const conflictRow = rowFor('fixture-linzhou');
    assert.match(conflictRow.querySelector('.first-step-cell-content')!.textContent ?? '', /实际原生 ID 冲突/);
    assert.doesNotMatch(conflictRow.querySelector('.first-step-cell-content')!.textContent ?? '', /合成测试研究价值/);
    // Selection state stays a separate column: only the settled row is checked.
    assert.equal(rowFor('linzhou-fixture\\.dev').querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true);
    const revokedRow = rowFor('reddit');
    assert.equal(revokedRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
    assert.match(revokedRow.textContent ?? '', /独立账号范围/, 'the revoked row keeps a concise independent-scope indicator');
    assert.match(revokedRow.querySelector('details.first-step-evidence')!.textContent ?? '', /单独研究，不并入人物结论。/, 'and the complete boundary stays inspectable');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('row evidence expansion never changes the selection and keeps originals inspectable', async () => {
  const rawQuote = '<p>My account: <a href="https://github.com/fixture-linzhou">link</a> 合成依据摘录。</p>';
  const fixture = seedFirstStep({
    input: { kind: 'name_query', value: 'Lin Zhou', question: '研究这位创作者的公开作品' },
    accounts: [
      { url: 'https://linzhou-fixture.dev/', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about', quote: rawQuote } },
      { url: 'https://github.com/fixture-linzhou', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [cluster('primary', 'Lin Zhou', view.accounts[0]!.accountId, view.accounts.map((a) => a.accountId), { linkage: 'linked' })]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    const row = container.querySelector<HTMLElement>('.first-step-accounts .first-step-card')!;
    const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const before = checkbox.checked;
    const draftBefore = JSON.stringify([...panel.draft()]);
    const evidence = row.querySelector<HTMLDetailsElement>('details.first-step-evidence')!;
    evidence.open = true;
    assert.match(evidence.querySelector('.first-step-source-preview')!.textContent ?? '', /My account: link 合成依据摘录。/, 'one source excerpt is visible at the first disclosure level');
    const sources = evidence.querySelector<HTMLElement>('.first-step-sources')!;
    assert.ok(sources, 'heavy originals live in one nested disclosure');
    sources.querySelector<HTMLButtonElement>('button.first-step-sources-toggle')!.click();
    assert.equal(sources.querySelector<HTMLElement>('.first-step-sources-list')!.hidden, false);
    const sourceList = sources.querySelector<HTMLElement>('.first-step-sources-list')!;
    const original = sourceList.querySelector<HTMLElement>('.first-step-original')!;
    assert.ok(original, 'the raw excerpt stays inspectable');
    assert.equal(original.querySelector('pre')!.textContent, rawQuote, 'the exact original is preserved byte-for-byte');
    assert.equal(original.querySelector('img'), null);
    sourceList.querySelector<HTMLElement>('blockquote, .first-step-evidence-item, p')!.click();
    evidence.querySelector('p')!.click();
    assert.equal(checkbox.checked, before, 'evidence interaction never toggles the checkbox');
    assert.equal(JSON.stringify([...panel.draft()]), draftBefore, 'nor the draft');
    // Opening the nested sources survives a draft re-render without touching scope.
    const accountId = checkbox.dataset.focusKey!.replace(/^account-/, '');
    container.querySelector<HTMLInputElement>('.first-step-accounts input[type="checkbox"]')!.click();
    const reRendered = container.querySelector<HTMLElement>('.first-step-accounts .first-step-card')!;
    assert.equal(reRendered.querySelector<HTMLElement>('.first-step-sources-list')!.hidden, false, 'the disclosure state survives draft re-renders');
    assert.equal(panel.draft().get(accountId)!.selection, 'only_this_account', 'only the explicit checkbox changed the draft');
    // Esc closes the live disclosure and returns focus to its trigger.
    const liveEvidence = reRendered.querySelector<HTMLDetailsElement>('details.first-step-evidence')!;
    liveEvidence.open = true;
    const liveSummary = liveEvidence.querySelector<HTMLElement>('summary')!;
    liveSummary.focus();
    liveEvidence.dispatchEvent(new (env.window as unknown as { KeyboardEvent: new (type: string, init: { key: string }) => Event }).KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(liveEvidence.open, false, 'Esc closes the evidence panel');
    assert.equal(env.document.activeElement, liveSummary, 'focus returns to the trigger');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('unsupported and other-person accounts can only be selected as independent scopes', async () => {
  const fixture = seedFirstStep({
    input: { kind: 'name_query', value: 'Lin Zhou', question: '研究这位创作者的公开作品' },
    accounts: [
      { url: 'https://linzhou-fixture.dev/', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://github.com/fixture-linzhou', supportedBy: { sourceUrl: 'https://lantern-fixture.dev/about' } },
      { url: 'https://x.com/fixture_other' }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [cluster('primary', 'Lin Zhou', view.accounts[0]!.accountId, [view.accounts[0]!.accountId, view.accounts[1]!.accountId], { linkage: 'linked' })]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const posted: FirstStepSelectionPayload[] = [];
    const panel = createFirstStepPanel({ api: panelApi(fixture, posted), container, runId: fixture.run.id });
    await panel.refresh();
    // The unconfirmed account sits outside the person's main choices.
    const independentRow = [...container.querySelectorAll('.first-step-accounts .first-step-card')].find((row) =>
      /fixture_other/.test(row.textContent ?? '')
    )!;
    assert.ok(independentRow);
    const independentBox = independentRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const independentId = independentBox.dataset.focusKey!.replace(/^account-/, '');
    independentBox.click();
    assert.equal(panel.draft().get(independentId)!.selection, 'only_this_account');
    container.querySelector<HTMLButtonElement>('.first-step-primary')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(posted.length, 1);
    const decisions = posted[0]!.accounts;
    assert.equal(decisions.filter((d) => d.selection === 'only_this_account').length, 1, 'the uncertain account is an explicit independent scope');
    assert.ok(decisions.filter((d) => d.selection === 'selected').length >= 1, 'the chosen cluster keeps its person scope');
    assert.equal(decisions.every((d) => !(d.selection === 'selected' && d.accountId === fixture.accountIdFor(2))), true);
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('filter and search are presentation-only windows that keep drafts and the selection count', async () => {
  const fixture = eightAccounts();
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [cluster('person-a', 'Lin Zhou', view.accounts[0]!.accountId, view.accounts.map((a) => a.accountId), { linkage: 'linked' })]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    const draftBefore = JSON.stringify([...panel.draft()]);
    const countBefore = panel.selectedCount();
    assert.equal(countBefore, 5);

    const visibleRows = () => [...container.querySelectorAll<HTMLElement>('.first-step-accounts .first-step-card')].filter((row) => !row.hidden);
    // 已选 filter shows exactly the selected rows; nothing mutates the draft.
    container.querySelector<HTMLButtonElement>('button[data-filter="selected"]')!.click();
    assert.equal(visibleRows().length, 5);
    assert.equal(container.querySelector<HTMLButtonElement>('button[data-filter="selected"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(JSON.stringify([...panel.draft()]), draftBefore);
    assert.equal(panel.selectedCount(), countBefore, 'hidden selected accounts still count');
    // Search narrows over platform/handle/host and interacts with the filter.
    const typeSearch = (value: string) => {
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      input.value = value;
      input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    };
    typeSearch('GitHub');
    assert.equal(visibleRows().length, 2, 'the two GitHub rows match the search');
    assert.equal(panel.selectedCount(), countBefore);
    // An empty result explains itself without touching the draft or scope.
    typeSearch('zzz-no-such-account');
    assert.equal(visibleRows().length, 0);
    assert.match(container.textContent ?? '', /没有符合当前筛选或搜索的账号/);
    assert.equal(JSON.stringify([...panel.draft()]), draftBefore);
    // Clearing restores all eight rows under the all-filter.
    typeSearch('');
    container.querySelector<HTMLButtonElement>('button[data-filter="all"]')!.click();
    assert.equal(visibleRows().length, 8);
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('search keeps the editing range and completes IME composition before replacing its input', async () => {
  const fixture = eightAccounts();
  const container = env.document.createElement('div');
  env.document.body.appendChild(container);
  const panel = createFirstStepPanel({api:panelApi(fixture),container,runId:fixture.run.id});
  try {
    await panel.refresh();
    const draft = JSON.stringify([...panel.draft()]);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.focus();
    input.value = 'github';
    input.setSelectionRange(1,3,'backward');
    input.dispatchEvent(new env.window.Event('input',{bubbles:true}));
    const replacement = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.equal(env.document.activeElement,replacement);
    assert.deepEqual([replacement.selectionStart,replacement.selectionEnd,replacement.selectionDirection],[1,3,'backward']);
    replacement.dispatchEvent(new env.window.Event('compositionstart',{bubbles:true}));
    replacement.value = '林';
    replacement.dispatchEvent(new env.window.Event('input',{bubbles:true}));
    await panel.refresh();
    assert.equal(container.querySelector('input[type="search"]'),replacement,'SSE/refresh cannot interrupt an active IME composition');
    replacement.value = '林舟';
    replacement.setSelectionRange(2,2);
    replacement.dispatchEvent(new env.window.Event('compositionend',{bubbles:true}));
    const completed = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.notEqual(completed,replacement);
    assert.equal(completed.value,'林舟');
    assert.equal(completed.selectionStart,2);
    assert.equal(JSON.stringify([...panel.draft()]),draft);
  } finally {panel.destroy();fixture.close();container.remove();}
});

test('SSE/refresh keeps drafts, filter/search state and never auto-selects newcomers', async () => {
  const fixture = eightAccounts();
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [cluster('person-a', 'Lin Zhou', view.accounts[0]!.accountId, view.accounts.map((a) => a.accountId), { linkage: 'linked' })]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'GitHub';
    search.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    const draftBefore = JSON.stringify([...panel.draft()]);
    const view = (fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id) as { view: FirstStepDiscoveryView }).view;
    const newcomer: FirstStepAccountView = {
      ...view.accounts[0]!,
      accountId: 'acct_fs_newcomer',
      accountKey: 'github:newcomer',
      profileUrl: 'https://github.com/newcomer',
      handle: 'newcomer',
      displayName: 'newcomer',
      defaultSuggestion: { suggested: true, reason: '建议默认勾选' }
    };
    panel.applyView({ ...view, accounts: [...view.accounts, newcomer] }, 2);
    assert.equal(JSON.stringify([...panel.draft()].filter(([id]) => id !== newcomer.accountId)), draftBefore, 'the server push never overwrites the draft');
    assert.equal(panel.draft().get(newcomer.accountId)!.selection, 'unanswered', 'a newcomer is never auto-checked');
    assert.equal(panel.selectedCount(), 5);
    assert.equal(container.querySelector<HTMLInputElement>('input[type="search"]')!.value, 'GitHub', 'the comparison window survives re-renders');
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('exclusion undo is not a selection and a submitted scope becomes read-only', async () => {
  const fixture = eightAccounts();
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [cluster('person-a', 'Lin Zhou', view.accounts[0]!.accountId, view.accounts.map((a) => a.accountId), { linkage: 'linked' }),
        cluster('person-b','Other person',view.accounts[1]!.accountId,[view.accounts[1]!.accountId])]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const posted: FirstStepSelectionPayload[] = [];
    const api = panelApi(fixture, posted);
    const panel = createFirstStepPanel({ api, container, runId: fixture.run.id });
    await panel.refresh();
    const firstKey = [...panel.draft().keys()][0]!;
    const exclude = [...container.querySelectorAll<HTMLButtonElement>('button.text-button')].find((b) => b.textContent === '不是此人')!;
    exclude.click();
    assert.equal(panel.draft().get(firstKey)!.excluded, true);
    assert.equal(panel.draft().get(firstKey)!.selection, 'not_selected');
    assert.match(container.textContent ?? '', /已声明“不是此人”/);
    const undo = [...container.querySelectorAll<HTMLButtonElement>('button.text-button')].find((b) => b.textContent === '撤销排除声明')!;
    undo.click();
    assert.equal(panel.draft().get(firstKey)!.excluded, false);
    assert.equal(panel.draft().get(firstKey)!.selection, 'unanswered', 'undo never selects the account');
    // Submit, then the server marks the scope frozen: the UI becomes read-only.
    api.submitFirstStepSelection = async (_runId, payload) => {
      posted.push(payload);
      return {
        selection: {
        runRevision: 2, scopeVersion: 2, discoveryRevision: 1, clusterId: payload.clusterId,
        selectedAccountIds: payload.accounts.filter((a) => a.selection === 'selected').map((a) => a.accountId),
        independentAccountIds: payload.accounts.filter((a) => a.selection === 'only_this_account').map((a) => a.accountId),
        excludedAccountIds: payload.accounts.filter((a) => a.excluded).map((a) => a.accountId),
        idempotent: false
      },
      view: {
        ...(fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id) as { view: FirstStepDiscoveryView }).view,
        selection: {
          scopeVersion: 2, frozenScopeVersion: 2, submitted: true, submittedAt: '2026-10-21T00:00:00.000Z',
          selectedAccountIds: [], excludedAccountIds: []
        }
      }
      };
    };
    await panel.submit();
    const submittedDraft = JSON.stringify([...panel.draft()]);
    const chosenBefore = container.querySelector('.first-step-candidate.chosen strong')!.textContent;
    for (const candidate of container.querySelectorAll<HTMLButtonElement>('button.first-step-cluster')) {
      assert.equal(candidate.disabled,true);
      candidate.dispatchEvent(new env.window.Event('click',{bubbles:true}));
    }
    assert.equal(container.querySelector('.first-step-candidate.chosen strong')!.textContent,chosenBefore);
    container.querySelector<HTMLElement>('.first-step-card .first-step-cell-content')!.click();
    assert.equal(JSON.stringify([...panel.draft()]), submittedDraft, 'clicking a submitted row cannot change the frozen draft');
    for (const box of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      assert.equal(box.disabled, true, 'submitted rows are read-only');
    }
    assert.equal([...container.querySelectorAll('button.text-button')].length, 0, 'no exclusion or independent-scope actions remain');
    assert.match(container.textContent ?? '', /范围已提交/);
    assert.match(container.querySelector('.first-step-accounts')!.textContent ?? '', /独立账号范围|范围已提交/);
    assert.equal(posted.length, 1);
  } finally {
    fixture.close();
    env.document.body.replaceChildren();
  }
});

test('a linked X account can explicitly become an independent research scope without changing the person choice',async()=>{
 const fixture=eightAccounts();
 try{
  fixture.republish(view=>({...view,clusters:[cluster('linked-person','Lin Zhou',view.accounts[0]!.accountId,view.accounts.map(a=>a.accountId),{linkage:'linked'})]}));
  const container=env.document.createElement('div');env.document.body.appendChild(container);
  const panel=createFirstStepPanel({api:panelApi(fixture),container,runId:fixture.run.id});await panel.refresh();
  container.querySelector<HTMLButtonElement>('.first-step-cluster')!.click();
  const account=container.querySelector<HTMLInputElement>('input[aria-label="选择 X fixture_lin · x.com/fixture_lin"]')!;
  const id=account.dataset.focusKey!.replace('account-','');
  const action=[...account.closest('article')!.querySelectorAll('button')].find(b=>b.textContent==='仅研究这个公开账号');
  assert.ok(action,'linked evidence must not force the user to research a person');action.click();
  assert.equal(panel.draft().get(id)!.selection,'only_this_account');assert.ok(container.querySelector('.first-step-cluster.chosen[data-focus-key="cluster-linked-person"]'));
  panel.destroy();
 }finally{fixture.close();env.document.body.replaceChildren();}
});
