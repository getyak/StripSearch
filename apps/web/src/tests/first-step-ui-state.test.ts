import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom} from './dom-env.js';
import {seedFirstStep} from './first-step-fixtures.js';
import {createFirstStepPanel, type FirstStepPanelApi} from '../client/first-step.js';
import type {FirstStepSelectionPayload} from '../client/api.js';

test('choice revisions preserve focus, input, evidence, and payload-bound retries', async (t) => {
const env=installDom(),fixture=seedFirstStep({accounts:[{url:'https://github.com/linzhou',supportedBy:{sourceUrl:'https://fixture-linzhou.org/',quote:'My GitHub: https://github.com/linzhou.'}},{url:'https://x.com/linzhou',supportedBy:{sourceUrl:'https://fixture-linzhou.org/',quote:'My X: https://x.com/linzhou.'}}]}),response=fixture.firstStep.getFirstStepView(fixture.run.ownerId,fixture.run.id);assert.ok(response && response.mode === 'first_step'); let view=response.view;const requests: Array<{payload: FirstStepSelectionPayload; key: string}> = [];
t.after(() => fixture.close());
const container=env.document.createElement('section');env.document.body.appendChild(container);let expanded=0;
const api: FirstStepPanelApi = {getFirstStepDiscovery:async()=>({mode:'first_step',view,runRevision:1}),submitFirstStepSelection:async(_run: string,payload: FirstStepSelectionPayload,key: string)=>{requests.push({payload,key});throw new Error('synthetic request failure')},expandFirstStep:async()=>{expanded++;return{queued:true}}};
const panel=createFirstStepPanel({api,container,runId:fixture.run.id,now:()=>1234});await panel.refresh();const check=(name: string,passed: boolean,_observed: unknown)=>assert.ok(passed,name);
check('only eligible suggested accounts are initially checked without saving authority',panel.selectedCount()===2&&fixture.firstStep.selectionBinding(fixture.run.id)===null,{checked:panel.selectedCount()});
let box=container.querySelector<HTMLInputElement>('input[type=checkbox]')!;const key=box.dataset.focusKey;box.focus();box.click();check('checkbox keeps keyboard focus after selection render',(env.document.activeElement as HTMLElement | null)?.dataset.focusKey===key,{active:env.document.activeElement?.tagName});
const evidence=container.querySelector<HTMLDetailsElement>('details.first-step-evidence')!;evidence.open=true;const hint=container.querySelector<HTMLInputElement>('[aria-label="补线索"]')!;hint.value='synthetic draft';hint.dispatchEvent(new env.window.Event('input',{bubbles:true}));const hintDetails=hint.closest<HTMLDetailsElement>('details')!;hintDetails.open=true;hint.focus();
view={...view,updatedAt:'2026-10-05T12:00:00.000Z'};panel.applyView(view,2);check('new view preserves typed hint and focus',container.querySelector<HTMLInputElement>('[aria-label="补线索"]')!.value==='synthetic draft'&&(env.document.activeElement as HTMLElement | null)?.dataset.focusKey==='hint',{});check('new view preserves evidence and secondary disclosure',container.querySelector<HTMLDetailsElement>('details.first-step-evidence')!.open&&container.querySelector<HTMLDetailsElement>('.first-step-secondary')!.open,{});
const newcomer={...view.accounts[0]!,accountId:'new-suggested-account',accountKey:'github:new',profileUrl:'https://github.com/newcomer',handle:'newcomer'};panel.applyView({...view,accounts:[...view.accounts,newcomer]},3);check('new suggested account remains unchecked after user draft exists',panel.draft().get(newcomer.accountId)!.selection==='unanswered',{});
await panel.submit();await panel.submit();check('same failed request intent reuses idempotency key',requests.length===2&&requests[0]!.key===requests[1]!.key,{});container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();await panel.submit();check('edited intent rotates idempotency key even with same clock value',requests.length===3&&requests[2]!.key!==requests[1]!.key,{keys:requests.map(r=>r.key)});
panel.renderLegacy({mode:'legacy',canExpand:true,candidates:[],prompt:'Legacy synthetic run'});const legacy=container.querySelector<HTMLButtonElement>('button.primary');legacy?.click();await Promise.resolve();await Promise.resolve();check('legacy paused research has an actionable explicit discovery upgrade',expanded===1,{expanded});

});
