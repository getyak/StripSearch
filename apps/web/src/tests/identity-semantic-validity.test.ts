import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {seedFirstStep} from './first-step-fixtures.js';
import {nativeUsernameLinkContext} from '../server/research/link-context.js';
import type {ResearchPage} from '../server/research/tool-contracts.js';
import type {FirstStepBinding} from '../server/research/research-store.js';

const home='https://mira-semantic-fixture.dev/',book='https://github.com/book-publisher';
const bad='<p>I am the author of the book <a href="https://github.com/book&#45;publisher">Synthetic Book</a>.<br>When not working, find me reading.</p>';

for(const variant of ['exact','wrong-request','wrong-document-binding','valid-redirect','unproved-redirect'])test(`cached original requires actual request/document binding: ${variant}`,()=>{
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home}}]});
 try{
  for(const row of f.store.research.receipts(f.run.id).filter(r=>r.kind==='tool')){
   const result=structuredClone(row.result) as {pages:ResearchPage[]};
   const requested=variant==='wrong-request'?'https://another-author.dev/':variant.endsWith('redirect')?home.replace('https://','https://www.'):home;
   for(const p of result.pages){
    if(variant==='wrong-document-binding')p.documentBinding={requestedUrl:'https://another-author.dev/',returnedUrl:p.url};
    if(variant==='valid-redirect'){p.documentBinding={requestedUrl:requested,returnedUrl:p.url};p.aliasProof={kind:'same_document_redirect',requestedUrl:requested,returnedUrl:p.url};}
   }
   f.db.prepare('UPDATE research_actions SET request_json=?,result_json=? WHERE run_id=? AND action_key=?').run(JSON.stringify({type:'read',url:requested}),JSON.stringify(result),f.run.id,row.key);
  }
  const before=JSON.stringify(f.firstStep.currentDiscovery(f.run.id));
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');
  assert.equal(view.view.accounts.find(a=>a.profileUrl===book)!.identity.validity,['exact','valid-redirect'].includes(variant)?'valid':'review');
  assert.equal(JSON.stringify(f.firstStep.currentDiscovery(f.run.id)),before);
 }finally{f.close();}
});

for(const wrapper of ['p','script','blockquote','q','cite','body hidden','html hidden','p hidden','p aria-hidden="true"','p aria-hidden="TRUE"','p style="display:none"','code','p class="activity-feed"'])test(`cached literal binds a visible authorial text node: ${wrapper}`,()=>{
 const quote=`My GitHub: ${book}`,tag=wrapper.split(' ')[0]!,text=`<${wrapper}>${quote}</${tag}>`;
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home,quote}}]});
 try{
  f.db.prepare('UPDATE research_case_source_revisions SET content_hash=? WHERE original_url=?').run(createHash('sha256').update(text).digest('hex'),home);
  f.store.research.reserve(f.run.id,'node-original','tool',{type:'read',url:home},{inputTokens:0,outputTokens:0});
  f.store.research.settle(f.run.id,'node-original',{pages:[{url:home,text,links:[book],kind:'profile',retrieval:'read'}]},{inputTokens:0,outputTokens:0});
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');
  assert.equal(view.view.accounts.find(a=>a.profileUrl===book)!.identity.validity,wrapper==='p'?'valid':'review');
 }finally{f.close();}
});

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
  const base={expectedRunRevision:f.store.getRun(f.run.id)!.revision,expectedScopeVersion:conflicted.view.selection.scopeVersion,discoveryRevision:conflicted.view.discoveryRevision,clusterId:'cluster-1',accounts:conflicted.view.accounts.map(a=>({accountId:a.accountId,selection:'selected' as const,excluded:false}))};
  assert.throws(()=>f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,base,'conflict-person'),/冲突/);
  const binding:FirstStepBinding={caseId:f.caseId,discoveryRevision:conflicted.view.discoveryRevision,scopeVersion:conflicted.view.selection.scopeVersion,clusterId:'cluster-1',displayName:'Mira',anchorUrl:home,selectedAccountIds:[current.accountId],independentAccountIds:[],identityDependencyAccountIds:[current.accountId],accountKeys:{[current.accountKey]:current.accountId},accounts:[{accountId:current.accountId,accountKey:current.accountKey,profileUrl:book,allowedScope:'public_history',independent:false,accessCoverage:'unassessed'}]};
  assert.equal(f.store.isFirstStepIdentityActive(f.run.ownerId,binding),false);
  assert.equal(f.store.isFirstStepIdentityActive(f.run.ownerId,{...binding,independentAccountIds:[current.accountId]}),true);
 }finally{f.close();}
});

for(const heading of ['My colleague','Not my account; impersonator'])test(`cached narrow paragraph cannot override actual ancestor ${heading}`,()=>{
 const quote=`<p>My GitHub: <a href="${book}">GitHub</a></p>`,text=`<section><h2>${heading}</h2>${quote}</section>`;
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home,quote}}]});
 try{
  f.db.prepare('UPDATE research_case_source_revisions SET content_hash=? WHERE original_url=?').run(createHash('sha256').update(text).digest('hex'),home);
  f.store.research.reserve(f.run.id,'original','tool',{type:'read',url:home},{inputTokens:0,outputTokens:0});
  f.store.research.settle(f.run.id,'original',{pages:[null,{url:home,text,links:[book],kind:'profile',retrieval:'read'}]},{inputTokens:0,outputTokens:0});
  const before=JSON.stringify(f.firstStep.currentDiscovery(f.run.id));
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');
  assert.equal(view.view.accounts.find(a=>a.profileUrl===book)!.identity.validity,'review');
  assert.equal(JSON.stringify(f.firstStep.currentDiscovery(f.run.id)),before);
 }finally{f.close();}
});

for(const variant of ['valid','valid-case-alias','unproved-case-alias','wrong-request','wrong-returned-account','wrong-id','wrong-offset'])test(`cached native username field requires actual profile request and field: ${variant}`,()=>{
 const gh='https://github.com/mira-native-fixture',x='https://x.com/mira_social',quote='twitter_username: mira_social',text='Mira\n'+quote;
 const f=seedFirstStep({accounts:[{url:gh},{url:variant.endsWith('case-alias')?'https://x.com/Mira_Social':x,supportedBy:{sourceUrl:gh,quote}}]});
 try{
  const context={...nativeUsernameLinkContext(text,'mira_social',x,5)!,nativeField:{name:'twitter_username' as const,offset:variant==='wrong-offset'?0:5,nativeId:variant==='wrong-id'?'456':'123'}};
  const page:ResearchPage={url:gh,title:'Synthetic profile',text,kind:'profile',retrieval:'profile',publishedAt:null,links:[x],limitations:[],linkContexts:[context],account:{platform:'github',id:'123',handle:variant==='wrong-returned-account'?'other-person':'mira-native-fixture',profileUrl:variant==='wrong-returned-account'?'https://github.com/other-person':gh}};
  f.db.prepare('UPDATE research_case_source_revisions SET content_hash=? WHERE original_url=?').run(createHash('sha256').update(text).digest('hex'),gh);
  f.store.research.reserve(f.run.id,'native','tool',{type:'github_profile',url:variant==='wrong-request'?'https://github.com/other-person':gh},{inputTokens:0,outputTokens:0});
  f.store.research.settle(f.run.id,'native',{pages:[page]},{inputTokens:0,outputTokens:0});
  if(variant==='valid-case-alias'){
   const returned='https://x.com/Mira_Social';
   f.store.research.reserve(f.run.id,'actual-alias','tool',{type:'social_profile',url:x},{inputTokens:0,outputTokens:0});
   f.store.research.settle(f.run.id,'actual-alias',{pages:[{url:returned,text:'Mira',kind:'profile',retrieval:'profile',account:{platform:'x',id:'789',handle:'Mira_Social',profileUrl:returned},aliasProof:{kind:'native_profile',platform:'x',nativeId:'789',requestedUrl:x,returnedUrl:returned}}]},{inputTokens:0,outputTokens:0});
  }
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');
  assert.equal(view.view.accounts.find(a=>a.accountId===f.accountIdFor(1))!.identity.validity,variant.startsWith('valid')?'valid':'review');
 }finally{f.close();}
});

test('missing completed original makes historical generated plaintext proof review-only',()=>{
 const quote=`I am the author of the book ${book}. When not working, find me reading.`;
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home,quote}}]});
 try{
  f.db.prepare('DELETE FROM research_actions WHERE run_id=?').run(f.run.id);
  const before=JSON.stringify(f.store.cases.reportView(f.run.ownerId,f.caseId).evidence);
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');
  const account=view.view.accounts.find(a=>a.profileUrl===book)!;
  assert.equal(account.identity.validity,'review');assert.equal(account.defaultSuggestion.suggested,false);assert.equal(account.requiresIndependentScope,true);
  assert.equal(JSON.stringify(f.store.cases.reportView(f.run.ownerId,f.caseId).evidence),before);
 }finally{f.close();}
});

for(const heading of ['', 'My colleague', 'Not my account; impersonator'])test(`complete mixed HTML/plain original keeps attribution context: ${heading||'self'}`,()=>{
 const quote=`My GitHub: ${book}`,text=`<section>${heading?`<h2>${heading}</h2>`:''}<p>My website: <a href="${home}">Home</a></p>\n\n${quote}</section>`;
 const f=seedFirstStep({accounts:[{url:home},{url:book,supportedBy:{sourceUrl:home,quote}}]});
 try{
  f.db.prepare('UPDATE research_case_source_revisions SET content_hash=? WHERE original_url=?').run(createHash('sha256').update(text).digest('hex'),home);
  f.store.research.reserve(f.run.id,'mixed-original','tool',{type:'read',url:home},{inputTokens:0,outputTokens:0});
  f.store.research.settle(f.run.id,'mixed-original',{pages:[{url:home,text,links:[book],kind:'profile',retrieval:'read'}]},{inputTokens:0,outputTokens:0});
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(view.mode!=='first_step')throw Error('mode');
  assert.equal(view.view.accounts.find(a=>a.profileUrl===book)!.identity.validity,heading?'review':'valid');
 }finally{f.close();}
});
