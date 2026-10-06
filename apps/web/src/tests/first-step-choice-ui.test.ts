/**
 * Choice-page presentation regressions: the chosen person's accounts are the
 * main choices, unconfirmed/unrelated leads live in a clearly labeled collapsed
 * secondary area (same-name selection stays clear), and sourcequote HTML is
 * escaped plain text that never executes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { seedFirstStep } from './first-step-fixtures.js';
import { createFirstStepPanel, type FirstStepPanelApi } from '../client/first-step.js';
import type { FirstStepDiscoveryResponse, FirstStepSelectionPayload, FirstStepSelectionResponse } from '../client/api.js';
import type { FirstStepDiscoveryView, FirstStepPersonClusterView } from '../shared/first-step-discovery.js';

const env = installDom();

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

const XSS_QUOTE = '<img src=x onerror="window.__xss=1"> 本人声明摘录';

test('chosen cluster accounts are the main choices; unconfirmed leads are a collapsed, clearly labeled secondary area', async () => {
  const fixture = seedFirstStep({
    accounts: [
      { url: 'https://github.com/linzhou', identityState: 'supported', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: XSS_QUOTE } },
      { url: 'https://x.com/linzhou', identityState: 'supported', supportedBy: { sourceUrl: 'https://lantern.dev/about', quote: XSS_QUOTE } },
      { url: 'https://github.com/morganchen', identityState: 'proposed' }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [
        {
          clusterId: 'cluster-1',
          displayName: '林舟',
          anchorUrl: 'https://github.com/linzhou',
          anchorLabel: '合成锚点',
          anchorAccountId: view.accounts[0]!.accountId,
          linkage: 'linked',
          anchorBasis: { label: '公开原文中的明确链接', quote: XSS_QUOTE, sourceUrl: 'https://lantern.dev/about' },
          leads: [
            {
              atomId: 'lead-1',
              statement: 'GitHub @linzhou：合成测试研究价值',
              quote: XSS_QUOTE,
              sourceUrl: 'https://lantern.dev/about',
              evidenceIds: []
            }
          ],
          conflicts: [],
          accountIds: [view.accounts[0]!.accountId, view.accounts[1]!.accountId]
        }
      ],
      accounts: view.accounts.map((account, index) =>
        index < 2
          ? {
              ...account,
              identity: {
                ...account.identity,
                evidence: account.identity.evidence.map((item) => ({ ...item, quote: XSS_QUOTE }))
              }
            }
          : account
      )
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const posted: FirstStepSelectionPayload[] = [];
    const panel = createFirstStepPanel({ api: panelApi(fixture, posted), container, runId: fixture.run.id });
    await panel.refresh();
    assert.equal(panel.statusText(), 'ready');
    const clusterButtons = container.querySelectorAll('.first-step-cluster');
    assert.equal(clusterButtons.length, 1);
    const groups = container.querySelectorAll('.first-step-groups');
    const mainCards = groups[0]!.querySelectorAll('.first-step-card');
    assert.equal(mainCards.length, 2, "the chosen cluster's accounts are the main choices");
    // The colleague/unconfirmed lead is preserved but lives in the collapsed
    // secondary area with a clear label — never a wall of raw cards.
    const secondary = container.querySelector<HTMLDetailsElement>('details.first-step-related')!;
    assert.ok(secondary, 'the secondary related-lead area exists');
    assert.equal(secondary.open, false, 'the secondary area is collapsed by default');
    assert.match(secondary.textContent ?? '', /未确认 \/ 不并入人物结论/);
    assert.equal(secondary.querySelectorAll('.first-step-card').length, 1, 'the colleague lead stays available');
    const colleagueCard = secondary.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(colleagueCard.checked, false, 'unconfirmed leads are never default-checked');
    // Sourcequote HTML is escaped plain text; the original stays inspectable
    // and no source HTML ever executes.
    const quotes = container.querySelectorAll('.first-step-original pre');
    assert.ok(quotes.length >= 2, 'exact source quotes remain inspectable');
    assert.match(container.querySelector('blockquote')?.textContent??'',/本人声明摘录/, 'the readable excerpt contains text without executing markup');
    for (const quote of quotes) {
      assert.match(quote.textContent ?? '', /<img src=x onerror=/, 'the original quote is shown as text');
    }
    assert.equal(container.querySelectorAll('img').length, 0, 'sourcequote HTML never becomes live markup');
    assert.equal((env.window as unknown as { __xss?: number }).__xss, undefined);
    // The grounded descriptor keeps its statement and its inspectable source.
    assert.match(clusterButtons[0]!.textContent ?? '', /原文摘录：.*本人声明摘录/);
    assert.doesNotMatch(clusterButtons[0]!.textContent ?? '', /<img/);
    assert.match(container.querySelector('.first-step-cluster-basis')!.textContent ?? '', /合成测试研究价值/);
  } finally {
    fixture.db.close();
    env.document.body.replaceChildren();
  }
});

test('same-name candidates stay clearly selectable: choosing a cluster moves its accounts to the main choices', async () => {
  const fixture = seedFirstStep({
    accounts: [
      { url: 'https://github.com/linzhou', identityState: 'supported', supportedBy: { sourceUrl: 'https://lantern.dev/about' } },
      { url: 'https://github.com/linzhou-two', identityState: 'supported', supportedBy: { sourceUrl: 'https://kepler.dev/about' } },
      { url: 'https://github.com/morganchen', identityState: 'proposed' }
    ]
  });
  try {
    fixture.republish((view) => ({
      ...view,
      clusters: [
        cluster('cluster-1', '林舟', view.accounts[0]!.accountId, [view.accounts[0]!.accountId]),
        cluster('cluster-2', '林舟', view.accounts[1]!.accountId, [view.accounts[1]!.accountId])
      ]
    }));
    const container = env.document.createElement('div');
    env.document.body.appendChild(container);
    const panel = createFirstStepPanel({ api: panelApi(fixture), container, runId: fixture.run.id });
    await panel.refresh();
    const buttons = container.querySelectorAll<HTMLButtonElement>('button.first-step-cluster');
    assert.equal(buttons.length, 2, 'both same-name candidates are presented');
    buttons[1]!.click();
    const pressed = container.querySelectorAll<HTMLButtonElement>('button.first-step-cluster');
    assert.equal(pressed[1]!.getAttribute('aria-pressed'), 'true', 'the chosen candidate is clear');
    const mainCards = container.querySelectorAll('.first-step-groups')[0]!.querySelectorAll('.first-step-card');
    assert.equal(mainCards.length, 1, "the chosen candidate's accounts are the main choices");
    const secondary = container.querySelector<HTMLDetailsElement>('details.first-step-related')!;
    assert.equal(secondary.open, false);
    assert.equal(secondary.querySelectorAll('.first-step-card').length, 1, 'the unconfirmed colleague stays available, collapsed');
    const separate = container.querySelector('.first-step-other-linked')!;
    assert.equal(separate.querySelectorAll('.first-step-card').length, 1, 'the other supported group stays visible with independent scope');
    assert.equal(separate.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
    assert.match(separate.textContent ?? '', /不并入此人的身份结论/);
    assert.match(secondary.textContent ?? '', /未确认 \/ 不并入人物结论/);
  } finally {
    fixture.db.close();
    env.document.body.replaceChildren();
  }
});

test('an explicitly checked account from another supported group reaches the real store only as an independent scope',async()=>{
  const fixture=seedFirstStep({accounts:[
    {url:'https://github.com/linzhou',supportedBy:{sourceUrl:'https://lantern.dev/about'}},
    {url:'https://x.com/linzhou',supportedBy:{sourceUrl:'https://kepler.dev/about'}}
  ]});
  fixture.republish(view=>({...view,clusters:[cluster('primary','林舟',view.accounts[0]!.accountId,[view.accounts[0]!.accountId]),cluster('other','林舟',view.accounts[1]!.accountId,[view.accounts[1]!.accountId])]}));
  const container=env.document.createElement('div');env.document.body.appendChild(container);
  const api=panelApi(fixture);
  api.getFirstStepDiscovery=async()=>({...await panelApi(fixture).getFirstStepDiscovery(fixture.run.id),runRevision:fixture.store.getRun(fixture.run.id)!.revision});
  api.submitFirstStepSelection=async(_id,payload)=>({selection:fixture.firstStep.applyFirstStepSelection(fixture.run.ownerId,fixture.run.id,payload,'actual-independent-ui')});
  const panel=createFirstStepPanel({api,container,runId:fixture.run.id});
  try{
    await panel.refresh();container.querySelector<HTMLButtonElement>('.first-step-cluster')!.click();
    const separate=container.querySelector('.first-step-other-linked')!;
    assert.match(separate.querySelector('h3')!.textContent??'',/单独研究/);
    const checkbox=separate.querySelector<HTMLInputElement>('input[type="checkbox"]')!;assert.equal(checkbox.checked,false);
    checkbox.click();assert.equal(panel.selectedCount(),1);assert.equal(fixture.firstStep.selectionBinding(fixture.run.id),null);
    container.querySelector<HTMLButtonElement>('.first-step-primary')!.click();await new Promise(resolve=>setTimeout(resolve,0));
    const binding=fixture.firstStep.selectionBinding(fixture.run.id)!;assert.ok(binding);
    assert.deepEqual(binding.independentAccountIds,[fixture.accountIdFor(1)]);
    assert.equal(fixture.store.cases.listAccounts(fixture.run.ownerId,fixture.caseId).find(a=>a.accountId===fixture.accountIdFor(0))!.allowedScope.state,'none');
    await panel.refresh();assert.equal(container.querySelector<HTMLInputElement>('.first-step-other-linked input[type="checkbox"]')!.checked,true);
    assert.match(container.querySelector('.first-step-other-linked')!.textContent??'',/范围已提交|需要独立账号范围/);
  }finally{panel.destroy();fixture.close();container.remove();}
});

function cluster(clusterId: string, displayName: string, anchorAccountId: string, accountIds: string[]): FirstStepPersonClusterView {
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
    accountIds
  };
}

test('one grounded target is suggested while alternatives stay available; no authority persists until explicit submit', async () => {
  const fixture = seedFirstStep({accounts:[
    {url:'https://github.com/linzhou',identityState:'supported',supportedBy:{sourceUrl:'https://lantern.dev/about',quote:'My GitHub profile is Lin Zhou.'}},
    {url:'https://github.com/morganchen',identityState:'proposed'}
  ]});
  try {
    fixture.republish(view=>({...view,clusters:[
      {...view.clusters[0]!,clusterId:'linked-person',linkage:'linked',anchorAccountId:view.accounts[0]!.accountId,accountIds:[view.accounts[0]!.accountId],conflicts:[]},
      {...view.clusters[0]!,clusterId:'other-person',displayName:'Morgan Chen',linkage:'unconfirmed',anchorAccountId:view.accounts[1]!.accountId,anchorUrl:view.accounts[1]!.profileUrl,accountIds:[view.accounts[1]!.accountId],leads:[],conflicts:[]}
    ]}));
    const container=env.document.createElement('div');env.document.body.appendChild(container);
    const posted: FirstStepSelectionPayload[]=[];
    const panel=createFirstStepPanel({api:panelApi(fixture,posted),container,runId:fixture.run.id});
    await panel.refresh();
    const alternatives=container.querySelector<HTMLDetailsElement>('details.first-step-other-people')!;
    assert.ok(alternatives);assert.equal(alternatives.open,false);
    assert.equal(container.querySelector('.first-step-cluster.chosen')?.getAttribute('aria-pressed'),'true');
    assert.equal(container.querySelector<HTMLInputElement>('.first-step-groups input[type="checkbox"]')!.checked,true);
    assert.equal(fixture.firstStep.selectionBinding(fixture.run.id),null);
    const actual=fixture.firstStep.getFirstStepView(fixture.run.ownerId,fixture.run.id);
    assert.ok(actual?.mode==='first_step');
    assert.equal(actual.view.selection.submitted,false);
    assert.ok(actual.view.accounts.every(account=>account.userSelection.state==='unanswered'));
    assert.equal(posted.length,0);
    panel.destroy();container.remove();
  } finally {fixture.db.close();}
});


test('a linked cluster for an unrelated name never becomes the recommended target or default scope', async () => {
  const fixture = seedFirstStep({ accounts: [ { url: 'https://github.com/morgan-chen', identityState: 'supported', supportedBy: { sourceUrl: 'https://morgan-site.dev/', quote: 'My GitHub profile: https://github.com/morgan-chen' } } ] });
  fixture.republish(view => ({ ...view, clusters: view.clusters.map(cluster => ({ ...cluster, displayName: 'Morgan Chen', linkage: 'linked' as const })) }));
  const container = env.document.createElement('div');
  const posted: FirstStepSelectionPayload[] = [];
  const panel = createFirstStepPanel({ api: panelApi(fixture, posted), container, runId: fixture.run.id });
  try {
    await panel.refresh();
    assert.equal(panel.selectedCount(), 0);
    assert.equal(container.querySelector('.first-step-cluster')?.getAttribute('aria-pressed'), 'false');
    assert.doesNotMatch(container.textContent ?? '', /建议目标 ·/);
    assert.deepEqual(posted, []);
  } finally { panel.destroy(); fixture.db.close(); }
});

test('literal name matches lead the visible choices while unrelated page titles remain accessible without authority', async () => {
  const fixture = seedFirstStep({ accounts: [{url:'https://github.com/linzhou'}, {url:'https://github.com/morganchen'}] });
  fixture.republish(view => ({...view, input:{...view.input,kind:'name_query',value:'Lin Zhou'}, clusters:[
    cluster('organization', 'Lantern Compiler Data Services', view.accounts[1]!.accountId, [view.accounts[1]!.accountId]),
    cluster('matching', 'Lin Zhou | Synthetic University', view.accounts[0]!.accountId, [view.accounts[0]!.accountId])
  ]}));
  const container = env.document.createElement('div');env.document.body.appendChild(container);
  const posted:FirstStepSelectionPayload[]=[];
  const panel=createFirstStepPanel({api:panelApi(fixture,posted),container,runId:fixture.run.id});
  try {
    await panel.refresh();
    const main=container.querySelector('.first-step-clusters')!;
    const other=main.querySelector<HTMLDetailsElement>('.first-step-other-people')!;
    assert.equal(other.open,false);
    assert.match(other.querySelector('.first-step-cluster')!.textContent??'',/Lantern Compiler Data Services/);
    assert.equal([...main.children].filter(child=>child.matches('button.first-step-cluster')).length,1);
    assert.match(main.querySelector(':scope > button.first-step-cluster')!.textContent??'',/Lin Zhou/);
    assert.equal(panel.selectedCount(),0);
    assert.deepEqual(posted,[]);
    other.open=true;
    other.querySelector<HTMLButtonElement>('.first-step-cluster')!.click();
    assert.match(container.querySelector('.first-step-clusters > button.first-step-cluster.chosen')!.textContent??'',/Lantern Compiler Data Services/);
    assert.equal(fixture.firstStep.selectionBinding(fixture.run.id),null);
  } finally {panel.destroy();fixture.db.close();container.remove();}
});

test('actually read homepage profile links stay visible without ownership or automatic selection',async()=>{
 const fixture=seedFirstStep({accounts:[{url:'https://github.com/linzhou'},{url:'https://x.com/linzhou'},{url:'https://github.com/morganchen'}]});
 fixture.republish(view=>({...view,input:{...view.input,kind:'name_query',value:'Lin Zhou'},clusters:[cluster('primary','Lin Zhou',view.accounts[0]!.accountId,[view.accounts[0]!.accountId])],
  accounts:view.accounts.map((account,index)=>index===1?{...account,profileLinkSources:[{accountId:view.accounts[0]!.accountId,sourceUrl:'https://github.com/linzhou',targetUrl:'https://x.com/linzhou'}]}:account)}));
 const container=env.document.createElement('div');env.document.body.appendChild(container);const posted:FirstStepSelectionPayload[]=[];
 const panel=createFirstStepPanel({api:panelApi(fixture,posted),container,runId:fixture.run.id});
 try{
  await panel.refresh();container.querySelector<HTMLButtonElement>('button.first-step-cluster')!.click();
  const linked=container.querySelector<HTMLElement>('.first-step-profile-links')!;assert.ok(linked);assert.match(linked.textContent??'',/链接本身不能证明归属/);
  const checkbox=linked.querySelector<HTMLInputElement>('input[type="checkbox"]')!;assert.equal(checkbox.checked,false);assert.equal(panel.selectedCount(),0);
  checkbox.click();assert.equal(panel.selectedCount(),1);assert.equal(fixture.firstStep.selectionBinding(fixture.run.id),null);
  container.querySelector<HTMLButtonElement>('.first-step-primary')!.click();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(posted[0]!.accounts.find(a=>a.accountId===fixture.store.cases.listAccounts(fixture.run.ownerId,fixture.caseId)[1]!.accountId)!.selection,'only_this_account');
  assert.ok(posted[0]!.accounts.every(a=>a.selection!=='selected'));assert.equal(container.querySelector('details.first-step-related')!.querySelectorAll('.first-step-card').length,1);
 }finally{panel.destroy();fixture.db.close();container.remove();}
});

 test('observed name-matching profiles stay visible as unchecked independent accounts, with unrelated leads collapsed',async()=>{
  const fixture=seedFirstStep({accounts:[{url:'https://github.com/linzhou'},{url:'https://x.com/linzhou'},{url:'https://github.com/morganchen'}]});
  fixture.republish(view=>({...view,input:{...view.input,kind:'name_query',value:'Lin Zhou'},clusters:[
   cluster('primary','Lin Zhou',view.accounts[0]!.accountId,[view.accounts[0]!.accountId]),
   cluster('name-match','Lin Zhou | Synthetic University',view.accounts[1]!.accountId,[view.accounts[1]!.accountId]),
   cluster('unrelated','Morgan Chen',view.accounts[2]!.accountId,[view.accounts[2]!.accountId])]}));
  const container=env.document.createElement('div');env.document.body.appendChild(container);const posted:FirstStepSelectionPayload[]=[];
  const panel=createFirstStepPanel({api:panelApi(fixture,posted),container,runId:fixture.run.id});
  try{
   await panel.refresh();container.querySelector<HTMLButtonElement>('button.first-step-cluster')!.click();
   const named=container.querySelector<HTMLElement>('.first-step-name-matches')!;assert.ok(named);assert.match(named.textContent??'',/不并入此人的身份结论/);assert.match(named.textContent??'',/Synthetic University/);
   const checkbox=named.querySelector<HTMLInputElement>('input[type="checkbox"]')!;assert.equal(checkbox.checked,false);assert.equal(panel.selectedCount(),0);
   checkbox.click();assert.equal(panel.selectedCount(),1);assert.equal(fixture.firstStep.selectionBinding(fixture.run.id),null);
   const confirm=[...container.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.classList.contains('first-step-primary'))!;confirm.click();await new Promise(resolve=>setTimeout(resolve,0));
   assert.equal(posted[0]!.clusterId,'primary');assert.equal(posted[0]!.accounts.find(a=>a.accountId===fixture.store.cases.listAccounts(fixture.run.ownerId,fixture.caseId)[1]!.accountId)!.selection,'only_this_account');
   assert.ok(posted[0]!.accounts.filter(a=>a.selection==='selected').length===0);assert.ok(container.querySelector('details.first-step-related'));
  }finally{panel.destroy();fixture.db.close();container.remove();}
 });
