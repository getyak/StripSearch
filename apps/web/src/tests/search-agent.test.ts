import assert from 'node:assert/strict';
import test from 'node:test';
import {applyCoreSchema,openDatabase} from '../server/db/index.js';
import {Store} from '../server/store.js';
import {FirstStepStore} from '../server/research/first-step-store.js';
import {createFirstStepCheckedSearch,discoverFirstStep,type FirstStepDiscoverContext,verifyFirstStepModelProposals} from '../server/research/first-step-discovery.js';
import {parseSearchAgentDecision,type SearchAgent,type SearchAgentInput} from '../server/research/search-agent.js';
import {createResearchTools,verifiedNativeAccountKind} from '../server/research/toolkit.js';
import {extractOriginalLinkContexts} from '../server/research/link-context.js';
import {validateSelectionDecision} from '../shared/first-step-discovery.js';
import type {ResearchPage,ResearchToolAction,ResearchToolResult} from '../server/research/tool-contracts.js';
const home='https://mira-kepler.dev/';
const target='https://x.com/mira_k';
const page=(url:string,text:string):ResearchPage=>({url,title:'Mira Kepler',text,kind:'profile',links:extractOriginalLinkContexts(text,url).map(c=>c.url),linkContexts:extractOriginalLinkContexts(text,url),publishedAt:null,limitations:[]});
const result=(pages:ResearchPage[]):ResearchToolResult=>({pages,requests:1,bytes:100,estimatedUsd:0,credits:null,limitations:[]});
function harness(pages:ResearchPage[],agent:SearchAgent,modelCalls=4,execute?:(action:ResearchToolAction)=>Promise<ResearchToolResult>){
 const db=openDatabase(':memory:');applyCoreSchema(db);const store=new Store(db),firstStep=new FirstStepStore(db,store);
 const run=store.insertRun({ownerId:'agent-test',question:'Mira Kepler',seedUrl:home,provider:'research',parentRunId:null,retryOf:null,followup:false,idempotencyKey:null,bodyFingerprint:'synthetic'});
 store.updateRun(run.id,{state:'researching'});
 const calls:ResearchToolAction[]=[];
 const budget={maxSearchQueries:11,maxSearchResults:12,maxProfileReads:16,maxModelCalls:modelCalls,policyVersion:'first-step/v10'};
 const search=createFirstStepCheckedSearch({store,runId:run.id,attemptId:'agent-test',budget,tools:{async execute(action){calls.push(action);if(execute)return execute(action);return result(action.type==='search'?pages.map(p=>({...p,text:'Search index only',retrieval:'search' as const})):pages.filter(p=>p.url===action.url));}}});
 const ctx:FirstStepDiscoverContext={store,firstStep,ownerId:run.ownerId,runId:run.id,input:{kind:'homepage_url',value:home,question:'Mira Kepler'},search,agent,signal:new AbortController().signal,registryVersion:'synthetic',budget};
 return {db,store,firstStep,ctx,calls,run};
}

test('Agent inspects beyond the preview, retains target-bound evidence, and restart does not repay',async()=>{
 const quote=`<p>My account: <a href="${target}">my X account</a></p>`;
 const text='<p>I am Mira Kepler.</p>'+ '<p>Original synthetic historical background.</p>'.repeat(100)+quote;
 const seen:SearchAgentInput[]=[];
 const h=harness([page(home,text)],async(_signal,input)=>{
  seen.push(input);
  if(seen.length===1)return {action:'tools',tools:[{tool:'inspect_source',sourceUrl:home,offset:text.indexOf(quote)}]};
  assert.ok(input.windows.some(w=>w.offset>1500&&w.text.includes(quote)));
  return {action:'finish',proposals:[{fromUrl:home,targetUrl:target,linkRole:'explicit_claim',quote,requestKey:'invented-key'}],leads:[]};
 });
 try{
  const view=await discoverFirstStep(h.ctx);
  const account=view.accounts.find(a=>a.profileUrl===target);assert.ok(account);assert.equal(account.identity.state,'supported');
  assert.ok(account.identity.evidence.some(e=>e.quote===quote));assert.equal(h.store.research.receipts(h.run.id).filter(r=>r.kind==='model').length,2);
  const before=h.calls.length;await discoverFirstStep(h.ctx);assert.equal(h.calls.length,before);assert.equal(seen.length,2);
 }finally{h.db.close();}
});

test('Agent selects a discovered identity page past eighth candidate; arbitrary URL and ungrounded query never dispatch',async()=>{
 const pages=Array.from({length:12},(_,i)=>page(i===0?home:`https://mira-${i}.dev/`,`<p>I am Mira Kepler, synthetic writer ${i}.</p>`));
 let round=0;const h=harness(pages,async(_signal,input)=>{
  round++;
  if(round===1){assert.ok(input.candidates.some(c=>c.url===pages[9]!.url));return {action:'tools',tools:[{tool:'read_identity',url:pages[9]!.url},{tool:'read_identity',url:'https://unobserved.dev/'},{tool:'search',query:'anonymous unknown handle probe'}]};}
  assert.ok(input.catalog.entries.some(e=>e.url===pages[9]!.url));return {action:'finish',proposals:[],leads:[]};
 });
 h.ctx.input={kind:'name_query',value:'Mira Kepler'};
 try{await discoverFirstStep(h.ctx);assert.ok(h.calls.some(a=>a.type!=='search'&&a.url===pages[9]!.url));assert.ok(!h.calls.some(a=>a.type!=='search'&&a.url==='https://unobserved.dev/'));assert.ok(!h.calls.some(a=>a.type==='search'&&a.query==='anonymous unknown handle probe'));}finally{h.db.close();}
});

test('Malformed output, negative offsets and final-only tools preserve honest gaps without unsafe dispatch',async()=>{
 assert.throws(()=>parseSearchAgentDecision({action:'tools',tools:[{tool:'shell',command:'anything'}]}));
 assert.throws(()=>parseSearchAgentDecision({action:'tools',tools:[{tool:'inspect_source',sourceUrl:home,offset:-1}]}));
 const h=harness([page(home,'<p>I am Mira Kepler.</p>')],async()=>({action:'tools',tools:[{tool:'read_identity',url:'https://unobserved.dev/'}]}),1);
 try{const view=await discoverFirstStep(h.ctx);assert.ok(view.gaps.some(g=>g.includes('额度已到')));assert.ok(!h.calls.some(a=>a.type!=='search'&&a.url==='https://unobserved.dev/'));}finally{h.db.close();}
});

test('Cancel between model and tool dispatch retains settlement and refuses late actions',async()=>{
 const controller=new AbortController();const h=harness([page(home,'<p>I am Mira Kepler.</p>')],async()=>{controller.abort();return {action:'tools',tools:[{tool:'search',query:home+' identity'}]};});h.ctx.signal=controller.signal;
 try{await assert.rejects(discoverFirstStep(h.ctx));assert.equal(h.store.research.receipts(h.run.id).filter(r=>r.kind==='model'&&r.state==='completed').length,1);assert.ok(!h.calls.some(a=>a.type==='search'&&a.query===home+' identity'));}finally{h.db.close();}
});

test('Native organization is response-bound and cannot join person scope even as anchor',async()=>{
 const url='https://github.com/mira-lab';
 const tools=createResearchTools({githubToken:null,exaApiKey:null,tikhubApiKey:null,firecrawlApiKey:null,timeoutMs:100,maxBytes:100000,firecrawlIntervalMs:0,transport:{async fetch(){return new Response(JSON.stringify({login:'mira-lab',id:123,html_url:url,name:'Mira Kepler Lab',bio:'Synthetic organization',type:'Organization'}));}}});
 const action={type:'github_profile' as const,url};const original=(await tools.execute(action,new AbortController().signal)).pages[0]!;
 assert.equal(verifiedNativeAccountKind(original,action),'organization');assert.equal(verifiedNativeAccountKind({...original,text:original.text+' changed'},action),null);
 const h=harness([original],async()=>({action:'finish',proposals:[],leads:[]}));h.ctx.input={kind:'homepage_url',value:url};
 try{
  const view=await discoverFirstStep(h.ctx);const account=view.accounts.find(a=>a.profileUrl===url)!;
  assert.equal(account.accountKind,'organization');assert.equal(account.defaultSuggestion.suggested,false);assert.ok(!view.clusters.some(c=>c.accountIds.includes(account.accountId)));
  const selected={accountId:account.accountId,selection:'selected' as const,excluded:false};assert.equal(validateSelectionDecision(account,selected,{anchorAccountIds:new Set([account.accountId])}).ok,false);
  assert.equal(validateSelectionDecision(account,{...selected,selection:'only_this_account'}).ok,true);
 }finally{h.db.close();}
});

test('Organization self-link remains related evidence even when the model claims personal ownership',()=>{
 const org='https://github.com/mira-lab';const quote=`<p>My account: <a href="${target}">our X</a></p>`;
 const verified=verifyFirstStepModelProposals([{targetUrl:target,fromUrl:org,quote,requestKey:'read-org',linkRole:'explicit_claim'}],{receipts:new Map([['read-org',{state:'completed',request:{type:'github_profile',url:org}}]]),readTexts:new Map([[org,quote]]),readContexts:new Map([[org,extractOriginalLinkContexts(quote,org)]]),organizationSourceUrls:new Set([org])});
 assert.equal(verified.accepted[0]?.verifiedRole,'prose_mention');
});


const finish:SearchAgent=async()=>({action:'finish',proposals:[],leads:[]});
const nativeTools=(url:string,empty=false)=>createResearchTools({githubToken:null,exaApiKey:null,tikhubApiKey:null,firecrawlApiKey:null,timeoutMs:100,maxBytes:100000,firecrawlIntervalMs:0,transport:{async fetch(){return new Response(JSON.stringify({login:new URL(url).pathname.slice(1),id:123,html_url:url,type:'Organization',...(empty?{}:{name:'Mira Lab',bio:'Synthetic organization'})}));}}});
function expand(h:ReturnType<typeof harness>){
 h.store.updateRun(h.run.id,{state:'needs_input'});
 h.firstStep.applyFirstStepExpand(h.run.ownerId,h.run.id,null,null);
 h.store.updateRun(h.run.id,{state:'researching'});
}

for(const segment of ['people','faculty'])test(`Institution ${segment} biography is receipt-bound identification material, never personal ownership`,async()=>{
 const bio=`https://synthetic-university.dev/${segment}/mira-kepler`,post='https://synthetic-university.dev/news/mira-kepler';
 const quote=`<p>Mira Kepler researches synthetic compilers. My account: <a href="${target}">our channel</a></p>`;
 const pages=[page(home,'<p>I am Mira Kepler.</p>'),page(bio,quote),page(post,'Synthetic article')];
 let rounds=0;const h=harness(pages,async(_signal,input)=>{
  if(++rounds===1){assert.ok(input.identityLeads?.some(lead=>lead.url===bio));return {action:'tools',tools:[{tool:'read_identity',url:bio},{tool:'read_identity',url:post}]};}
  assert.equal(input.catalog.entries.find(entry=>entry.url===bio)?.sourceRole,'third_party');
  return {action:'finish',proposals:[{fromUrl:bio,targetUrl:target,linkRole:'self_account_section',quote,requestKey:null}],leads:[{fromUrl:bio,quote,statement:'Synthetic compiler researcher'}]};
 });h.ctx.input={kind:'name_query',value:'Mira Kepler'};h.ctx.firecrawlAvailable=true;
 try{
  const view=await discoverFirstStep(h.ctx);
  assert.ok(h.calls.some(a=>a.type==='read'&&a.url===bio));assert.ok(!h.calls.some(a=>a.type==='read'&&a.url===post));
  assert.ok(!view.accounts.some(a=>a.profileUrl===bio||a.profileUrl==='https://synthetic-university.dev/'));assert.ok(!h.calls.some(a=>a.type!=='search'&&a.url==='https://synthetic-university.dev/'));assert.ok(!view.accounts.find(a=>a.profileUrl===target)?.identity.evidence.length);
  assert.ok(view.relatedLeads?.find(lead=>lead.url===bio)?.note.includes('原文记载'));
  const before=h.calls.length;await assert.rejects(h.ctx.search.readIdentity('unbound-read',{type:'read',url:bio},h.ctx.signal,{purpose:'third_party_identity',url:bio,searchReceiptKey:'invented'}));assert.equal(h.calls.length,before);
 }finally{h.db.close();}
});

test('Organization request casing stays organization in an existing case and selection cannot bypass it',async()=>{
 const upper='https://github.com/MIRA-LAB',lower='https://github.com/mira-lab';let second=false;const tools=nativeTools(lower);
 const h=harness([],finish,2,async action=>action.type==='search'?result([]):action.type==='github_profile'?tools.execute(action,new AbortController().signal):result([page(home,second?`<p>My GitHub: <a href="${upper}">GitHub</a></p>`:'<p>Mira Kepler.</p>')]));
 try{
  await discoverFirstStep(h.ctx);expand(h);second=true;
  const view=await discoverFirstStep(h.ctx);
  for(const url of [upper,lower]){
   const account=view.accounts.find(a=>a.profileUrl===url)!;assert.ok(account);assert.equal(account.accountKind,'organization');
   assert.ok(!view.clusters.some(c=>c.accountIds.includes(account.accountId)));assert.equal(validateSelectionDecision(account,{accountId:account.accountId,selection:'selected',excluded:false},{anchorAccountIds:new Set([account.accountId])}).ok,false);
  }
 }finally{h.db.close();}
});

for(const mode of ['failed','missing-type'] as const)test(`Organization metadata survives later ${mode} read and its self-links never grant person support`,async()=>{
 const org='https://github.com/mira-lab',tools=nativeTools(org);let second=false;
 const h=harness([],finish,2,async action=>{
  if(action.type==='search')return result([]);
  if(action.type==='github_profile'&&!second)return tools.execute(action,new AbortController().signal);
  if(action.url===org&&mode==='failed')throw new Error('offline synthetic failure');
  return result([page(action.url,`<p>My account: <a href="${target}">our X</a></p>`)]);
 });h.ctx.input={kind:'homepage_url',value:org};
 try{
  await discoverFirstStep(h.ctx);expand(h);second=true;const view=await discoverFirstStep(h.ctx);
  const account=view.accounts.find(a=>a.profileUrl===org)!;assert.equal(account.accountKind,'organization');assert.equal(account.defaultSuggestion.suggested,false);
  assert.ok(!view.clusters.some(c=>c.accountIds.includes(account.accountId)));assert.ok(!view.accounts.find(a=>a.profileUrl===target)?.identity.evidence.length);
 }finally{h.db.close();}
});

test('Empty native organization original remains hash-bound',async()=>{
 const url='https://github.com/mira-lab',action={type:'github_profile' as const,url};const original=(await nativeTools(url,true).execute(action,new AbortController().signal)).pages[0]!;
 assert.ok(original.text.length);assert.equal(verifiedNativeAccountKind(original,action),'organization');
});

test('Recovery before the first model preserves frozen Agent strategy; old attempts remain sequential',async()=>{
 const controller=new AbortController();let decisions=0;
 const h=harness([],async()=>{decisions++;return {action:'finish',proposals:[],leads:[]};},2,async action=>{if(action.type!=='search')controller.abort();return result(action.type==='search'?[]:[page(home,'Mira Kepler')]);});h.ctx.signal=controller.signal;
 try{
  await assert.rejects(discoverFirstStep(h.ctx));assert.equal(decisions,0);assert.ok(h.store.research.receipts(h.run.id).length>0);
  h.ctx.signal=new AbortController().signal;await discoverFirstStep(h.ctx);assert.equal(decisions,1);
  const marker=h.db.prepare("SELECT payload_json FROM run_events WHERE run_id=? AND type='first_step_strategy'").get(h.run.id) as {payload_json:string};assert.equal(JSON.parse(marker.payload_json).agent,true);
  const other=harness([page(home,'Mira Kepler')],async()=>{throw new Error('old attempt must never acquire Agent');});
  try{
   other.ctx.agent=undefined;await discoverFirstStep(other.ctx);
   other.db.prepare("DELETE FROM run_events WHERE run_id=? AND type='first_step_strategy'").run(other.run.id);
   other.ctx.agent=async()=>{throw new Error('old attempt must never acquire Agent');};await discoverFirstStep(other.ctx);
   assert.equal(other.store.research.receipts(other.run.id).filter(r=>r.kind==='model').length,0);
  }finally{other.db.close();}
 }finally{h.db.close();}
});
