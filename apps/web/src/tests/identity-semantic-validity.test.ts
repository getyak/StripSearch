import test from 'node:test';
import assert from 'node:assert/strict';
import {seedFirstStep} from './first-step-fixtures.js';
import type {FirstStepBinding} from '../server/research/research-store.js';

const home='https://mira-semantic-fixture.dev/',book='https://github.com/book-publisher';
const bad='<p>I am the author of the book <a href="https://github.com/book&#45;publisher">Synthetic Book</a>.<br>When not working, find me reading.</p>';

test('historical wrong ownership is review-only in current UI, selection and frozen Fetch without rewriting evidence',()=>{
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home,quote:bad}}]});
 try{
  const raw=f.firstStep.currentDiscovery(f.run.id)!;const historical=JSON.stringify(raw);
  const evidenceBefore=JSON.stringify(f.store.cases.reportView(f.run.ownerId,f.caseId).evidence);
  const projected=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;assert.equal(projected.mode,'first_step');if(projected.mode!=='first_step')throw Error('mode');
  const target=projected.view.accounts.find(a=>a.profileUrl===book)!;
  assert.equal(target.identity.validity,'review');assert.equal(target.defaultSuggestion.suggested,false);assert.equal(target.requiresIndependentScope,true);
  const binding:FirstStepBinding={caseId:f.caseId,discoveryRevision:f.discoveryRevision,scopeVersion:projected.view.selection.scopeVersion,clusterId:'cluster-1',displayName:'Mira',anchorUrl:home,selectedAccountIds:[f.accountIdFor(0),target.accountId],independentAccountIds:[],identityDependencyAccountIds:[target.accountId],accountKeys:{[target.accountKey]:target.accountId},accounts:[{accountId:target.accountId,accountKey:target.accountKey,profileUrl:book,allowedScope:'public_history',independent:false,accessCoverage:'unassessed'}]};
  f.store.research.save(f.run.id,{phase:'fetching',steps:0,startedAt:Date.now(),elapsedMs:0,anchorUrl:home,identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null,firstStep:binding});
  assert.equal(f.store.isFirstStepIdentityActive(f.run.ownerId,binding),false);
  assert.throws(()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent(),/归属依据已失效/);
  assert.throws(()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).resolveUrl(book),/归属依据已失效/);
  const base={expectedRunRevision:f.store.getRun(f.run.id)!.revision,expectedScopeVersion:projected.view.selection.scopeVersion,discoveryRevision:projected.view.discoveryRevision,clusterId:'cluster-1',accounts:projected.view.accounts.map(a=>({accountId:a.accountId,selection:'selected' as const,excluded:false}))};
  assert.throws(()=>f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,base,'bad-person-selection'));
  assert.equal(JSON.stringify(f.firstStep.currentDiscovery(f.run.id)),historical);assert.equal(JSON.stringify(f.store.cases.reportView(f.run.ownerId,f.caseId).evidence),evidenceBefore);
  f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,{...base,clusterId:null,accounts:base.accounts.map(a=>({...a,selection:a.accountId===target.accountId?'only_this_account':'not_selected'}))},'independent-safe');
  assert.deepEqual(f.firstStep.selectionBinding(f.run.id)!.independentAccountIds,[target.accountId]);f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent();
 }finally{f.close();}
});

test('current semantic recheck preserves a legitimate encoded self-link and conflicting linkage stays unselected',()=>{
 const good='<p>My GitHub profile is at <a href="https://github.com/book&#45;publisher">GitHub</a></p>';
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home,quote:good}}]});
 try{
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');const account=view.view.accounts.find(a=>a.profileUrl===book)!;assert.equal(account.identity.validity,'valid');
  f.republish(v=>({...v,accounts:v.accounts.map(a=>a.accountId===account.accountId?{...a,identity:{...a.identity,conflicts:['Two disconnected person clusters link here.']}}:a)}));
  const conflicted=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(conflicted.mode!=='first_step')throw Error('mode');const current=conflicted.view.accounts.find(a=>a.profileUrl===book)!;assert.equal(current.defaultSuggestion.suggested,false);assert.equal(current.requiresIndependentScope,true);assert.equal(current.identity.conflicts.length,1);
 }finally{f.close();}
});
