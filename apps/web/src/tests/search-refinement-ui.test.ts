import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom} from './dom-env.js';
import {seedFirstStep} from './first-step-fixtures.js';
import {createFirstStepPanel} from '../client/first-step.js';

const env=installDom();
test('Same Mastodon handle keeps instance visible and organization selection stays independent',()=>{
 const home='https://mira-kepler.dev/';
 const f=seedFirstStep({input:{kind:'name_query',value:'Mira Kepler'},accounts:[{url:home},{url:'https://mastodon.social/@mira',supportedBy:{sourceUrl:home}},{url:'https://hachyderm.io/@mira',supportedBy:{sourceUrl:home}},{url:'https://github.com/mira-lab'}]});
 try{
  f.republish(view=>({...view,clusters:view.clusters.map(c=>({...c,displayName:'Mira Kepler',accountIds:c.accountIds.filter(id=>id!==f.accountIdFor(3))})),accounts:view.accounts.map(a=>a.accountId===f.accountIdFor(3)?{...a,accountKind:'organization',category:'organization',requiresIndependentScope:true}:a)}));
  const response=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(response.mode!=='first_step')throw Error('mode');
  const container=env.document.createElement('div');env.document.body.append(container);
  const panel=createFirstStepPanel({container,runId:f.run.id,api:{async getFirstStepDiscovery(){throw Error('not used');},async submitFirstStepSelection(){throw Error('not used');},async expandFirstStep(){throw Error('not used');}}});
  try{
   panel.applyView(response.view,f.store.getRun(f.run.id)!.revision);
   const labels=[...container.querySelectorAll('.first-step-handle')].map(el=>el.textContent);
   assert.ok(labels.includes('@mira · mastodon.social'));assert.ok(labels.includes('@mira · hachyderm.io'));
   const details=container.querySelector<HTMLDetailsElement>('details[data-detail-key="organizations"]')!;assert.ok(details);assert.equal(details.open,false);
   details.open=true;const checkbox=details.querySelector<HTMLInputElement>('input[type="checkbox"]')!;checkbox.click();
   assert.equal(panel.draft().get(f.accountIdFor(3))?.selection,'only_this_account');
   assert.equal(container.querySelector<HTMLDetailsElement>('details[data-detail-key="organizations"]')!.open,true,'expanded state survives a draft rerender');
  }finally{panel.destroy();container.remove();}
 }finally{f.close();}
});
