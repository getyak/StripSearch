import assert from 'node:assert/strict';
import test from 'node:test';
import {seedFirstStep,type SeededFirstStep} from './first-step-fixtures.js';
import {waitFor,offlineTestTransport} from './harness.js';
import {Runner} from '../server/services/runner.js';
import type {AppConfig} from '../server/config.js';
import type {ResearchBudgetLimits} from '../shared/types.js';
import type {XAccountModel,XAccountProvider,XNativePost,XReadRequest,XReadResult} from '../server/research/x-account-contracts.js';
import {renderMarkdown} from '../shared/canonical.js';
import {renderReportHtml} from '../shared/report-html.js';
import {productionModel} from '../server/research/x-account-research.js';
import {DshProtocolRepairExhaustedError} from '../server/research/dsh-decision.js';
import type {HttpTransport} from '../server/adapters/types.js';
import {createHash} from 'node:crypto';

const ACCOUNT={nativeId:'42',handle:'runner_fixture',name:'Synthetic account',description:'Synthetic public account description.',url:'https://x.com/runner_fixture'};
const ORIGINAL='I built a synthetic tool to organize reading notes.';
const STATEMENT='该账号自述制作了一款用于整理阅读笔记的合成工具。';
const UNLIMITED:ResearchBudgetLimits={toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0};

function originalPost(id='101',text=ORIGINAL):XNativePost {
  return {id,url:`https://x.com/runner_fixture/status/${id}`,authorId:'42',authorHandle:'runner_fixture',text,publishedAt:'2026-10-01T00:00:00Z',kind:'original',parentId:null,quotedId:null,conversationId:id,replyCount:0,textField:'text',truncated:false};
}
function pageResult(posts:XNativePost[]=[],nextCursor:string|null=null):XReadResult {
  return {posts,nextCursor,cursorState:nextCursor?'more':'end',recordCount:posts.length,requests:1,bytes:200,estimatedUsd:0,endpoint:'/synthetic-x-read',limitations:[]};
}
function selectedFixture():SeededFirstStep {
  const f=seedFirstStep({question:'分析这个账号的公开作品与观点',input:{kind:'homepage_url',value:ACCOUNT.url},accounts:[{url:ACCOUNT.url}]});
  const current=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id);
  if(!current||current.mode!=='first_step')throw new Error('first-step fixture missing');
  f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,{expectedRunRevision:f.store.getRun(f.run.id)!.revision,expectedScopeVersion:current.view.selection.scopeVersion,discoveryRevision:current.view.discoveryRevision,clusterId:null,accounts:[{accountId:f.accountIdFor(0),selection:'only_this_account',excluded:false}]},'x-runner-independent-selection');
  const binding=f.firstStep.selectionBinding(f.run.id)!;
  assert.equal(binding.accounts[0]!.allowedScope,'public_history');
  assert.deepEqual(binding.independentAccountIds,[f.accountIdFor(0)]);
  return f;
}
function recordingProvider(change?:(request:XReadRequest,signal:AbortSignal)=>Promise<XReadResult|undefined>|XReadResult|undefined) {
  const calls:XReadRequest[]=[];
  const provider:XAccountProvider={async execute(request,signal){
    calls.push(request);
    const changed=await change?.(request,signal);if(changed)return changed;
    if(request.type==='profile')return {...pageResult(),account:ACCOUNT};
    if(request.type==='timeline')return pageResult([originalPost()]);
    if(request.type==='replies')return pageResult();
    throw new Error('unexpected contextual request');
  }};
  return {calls,provider};
}
function chineseModel(onCall?:(purpose:string)=>void) {
  const purposes:string[]=[];
  const model:XAccountModel=async input=>{
    purposes.push(input.purpose);onCall?.(input.purpose);
    const data=JSON.parse(input.prompt.slice(input.prompt.indexOf('\nDATA\n')+6)) as {organizationStage?:string;items?:Array<{id:string;section:string}>;findings?:Array<{id:string}>;materials?:Array<{sourceKey:string;role:string;text:string}>};
    if(data.organizationStage)return {groups:[{section:'work',title:'Synthetic work',ids:data.items!.map(item=>item.id)}]};
    if(input.purpose.includes('verify'))return {verdicts:(data.findings??[]).map(f=>({id:f.id,supported:true,reason:'该条完整原文直接支持这项账号自述。'}))};
    const material=data.materials?.find(m=>m.role==='target'&&m.text.includes(ORIGINAL));
    return {findings:material?[{section:'work',statement:STATEMENT,kind:'attributed_statement',evidence:[{sourceKey:material.sourceKey,quote:ORIGINAL}]}]:[]};
  };
  return {purposes,model};
}
function makeRunner(f:SeededFirstStep,provider:XAccountProvider,model?:XAccountModel,limits=UNLIMITED) {
  return new Runner({store:f.store,firstStep:f.firstStep,config:{researchLimits:limits,deepseekApiKey:null,exaApiKey:null,firecrawlApiKey:null,tikhubApiKey:null,githubToken:null} as AppConfig,
    providerFactory:()=>{throw new Error('legacy provider must not run');},transport:offlineTestTransport,researchTools:{async execute(){throw new Error('legacy tools must not run');}},xAccountProvider:provider,...(model?{xAccountModel:model}:{})});
}
async function terminal(f:SeededFirstStep,runner:Runner) {
  runner.enqueue(f.run.id);
  await waitFor(()=>runner.activeCount()===0&&!['queued','researching'].includes(f.store.getRun(f.run.id)!.state));
  return f.store.getRun(f.run.id)!;
}
function assertPreserved(f:SeededFirstStep) {
  const cp=f.store.research.checkpoint(f.run.id)!;
  assert.ok(cp.pages.some(p=>p.text===ORIGINAL),'already read original survives in the durable checkpoint');
  assert.ok(f.store.listSources(f.run.id).some(p=>p.excerpt===ORIGINAL),'already read original remains inspectable');
  return cp;
}

test('Runner publishes independently verified Chinese findings for the selected independent X account',async t=>{
  const f=selectedFixture();const p=recordingProvider();const m=chineseModel();const runner=makeRunner(f,p.provider,m.model);
  t.after(()=>{runner.stopAll();f.close();});
  const run=await terminal(f,runner);
  assert.equal(run.state,'completed');assert.equal(run.stopReason,'x_account_research_complete');assert.equal(run.errorCode,null);
  assert.deepEqual(p.calls.map(r=>r.type),['profile','timeline','replies']);
  assert.deepEqual(m.purposes,['x-account-analyze','x-account-synthesize','x-account-synthesize','x-account-verify-synthesis']);
  const view=f.store.buildCanonicalView(run);
  assert.equal(view.personObject,undefined,'an independent account is never promoted into a person object');
  assert.equal(view.accountObject!.account.nativeId,'42');assert.equal(view.accountObject!.claims.length,1);
  assert.equal(view.accountObject!.claims[0]!.statement,STATEMENT);assert.equal(view.accountObject!.claims[0]!.evidence[0]!.quote,ORIGINAL);
  assert.ok(view.answer.some(s=>s.bullets.some(b=>b.text===STATEMENT)));
  for(const output of [renderMarkdown(view),renderReportHtml(view)])assert.ok(output.includes(STATEMENT));
  assertPreserved(f);
});

test('Runner tool-budget exhaustion retains read pages and reports budget_exhausted instead of internal_error',async t=>{
  const f=selectedFixture();const p=recordingProvider();const m=chineseModel();const runner=makeRunner(f,p.provider,m.model,{...UNLIMITED,toolCalls:2});
  t.after(()=>{runner.stopAll();f.close();});
  const run=await terminal(f,runner);
  assert.equal(run.state,'partial');assert.equal(run.stopReason,'budget_exhausted');assert.notEqual(run.errorCode,'internal_error');
  assert.equal(p.calls.length,2,'no third provider call is dispatched after the two-call ceiling');
  assert.equal(f.store.research.receipts(f.run.id).length,2);assertPreserved(f);
  assert.equal(f.store.buildCanonicalView(run).research!.accountResearch!.targetPosts,1);
});

test('Runner recovery retains an unknown inflight receipt without repeating the paid provider action',async t=>{
  const f=selectedFixture();let held=false;
  const p=recordingProvider((request,signal)=>{
    if(request.type!=='timeline')return undefined;
    if(request.cursor===null)return pageResult([originalPost()],'second-page');
    held=true;
    return new Promise<XReadResult>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason??new Error('worker interrupted')),{once:true}));
  });
  const first=makeRunner(f,p.provider,chineseModel().model);let restarted:Runner|undefined;
  t.after(()=>{first.stopAll();restarted?.stopAll();f.close();});
  first.enqueue(f.run.id);await waitFor(()=>held);first.abort(f.run.id);await waitFor(()=>first.activeCount()===0);first.stopAll();
  assert.equal(p.calls.length,3);assertPreserved(f);
  const inflight=f.store.research.receipts(f.run.id).filter(r=>r.state==='inflight');assert.equal(inflight.length,1);
  assert.equal(f.store.recoverInterruptedRuns(),1);assert.equal(f.store.getRun(f.run.id)!.stopReason,'unknown_inflight');
  // An explicit recovery attempt must still respect the same durable unknown receipt.
  f.store.updateRun(f.run.id,{state:'queued',error_code:null,error_message:null,stop_reason:null});
  restarted=makeRunner(f,p.provider,chineseModel().model);
  const run=await terminal(f,restarted);
  assert.equal(run.state,'partial');assert.equal(run.stopReason,'unknown_inflight');assert.notEqual(run.errorCode,'internal_error');
  assert.equal(p.calls.length,3,'the uncertain second page is not dispatched again');
  assert.equal(f.store.research.receipt(f.run.id,inflight[0]!.key)!.state,'inflight');assertPreserved(f);
});

test('a drained service upgrade resumes the same X checkpoint and reuses a late settled page',async t=>{
  const f=selectedFixture();let held=false;let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const p=recordingProvider(async request=>{
    if(request.type!=='timeline')return undefined;
    if(request.cursor===null)return pageResult([originalPost()],'second-page');
    held=true;await gate;return pageResult([originalPost('102','A second synthetic account note.')]);
  });
  const first=makeRunner(f,p.provider,chineseModel().model);let restarted:Runner|undefined;
  t.after(()=>{release();first.stopAll();restarted?.stopAll();f.close();});
  first.enqueue(f.run.id);await waitFor(()=>held);
  f.store.updateRun(f.run.id,{state:'partial',stop_reason:'deployment_pause'});
  release();await waitFor(()=>first.activeCount()===0);first.stopAll();
  assert.equal(f.store.getRun(f.run.id)!.stopReason,'deployment_pause');
  assert.equal(f.store.research.receipts(f.run.id).filter(r=>r.state==='inflight').length,0);
  assert.equal(f.store.research.checkpoint(f.run.id)!.xAccountResearch!.history.timeline.pages,1);
  assert.ok(!f.store.research.checkpoint(f.run.id)!.xAccountResearch!.posts.some(p=>p.id==='102'),'a late page is settled without late ingestion');
  f.store.updateRun(f.run.id,{state:'queued',stop_reason:null,error_code:null,error_message:null});
  assert.equal(f.store.recoverInterruptedRuns(),0);
  restarted=makeRunner(f,p.provider,chineseModel().model);
  assert.equal((await terminal(f,restarted)).state,'completed');
  assert.equal(p.calls.length,4,'profile, two timeline pages and replies are each bought once');
  assert.equal(f.store.research.checkpoint(f.run.id)!.xAccountResearch!.history.timeline.pages,2);
  assert.ok(f.store.research.checkpoint(f.run.id)!.xAccountResearch!.posts.some(p=>p.id==='102'));
  assertPreserved(f);
});

test('Runner preserves prior originals and blocks late ingestion when selected account scope is withdrawn',async t=>{
  const f=selectedFixture();const m=chineseModel();
  const p=recordingProvider(request=>{
    if(request.type!=='replies')return undefined;
    f.db.prepare('INSERT INTO first_step_exclusions (id,run_id,case_id,account_id,statement,recorded_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)').run('withdraw-x-account',f.run.id,f.caseId,f.accountIdFor(0),'用户撤回此账号研究范围。',new Date().toISOString());
    return pageResult([originalPost('999','LATE_WITHDRAWN_MATERIAL')]);
  });
  const runner=makeRunner(f,p.provider,m.model);t.after(()=>{runner.stopAll();f.close();});
  const run=await terminal(f,runner);
  assert.equal(run.state,'partial');assert.equal(run.stopReason,'scope_changed');assert.notEqual(run.errorCode,'internal_error');
  const cp=assertPreserved(f);assert.ok(!cp.pages.some(p=>p.text.includes('LATE_WITHDRAWN_MATERIAL')));assert.equal(m.purposes.length,0);
  const view=f.store.buildCanonicalView(run);assert.equal(view.state,'partial');assert.equal(view.accountObject!.claims.length,0);assert.match(view.limitations.join(' '),/复核|撤回/);
  assert.equal(f.firstStep.link(f.run.id)!.phase,'blocked');
});

test('Runner source withdrawal during analysis yields an explicit review partial and no stale finding',async t=>{
  const f=selectedFixture();const p=recordingProvider();let excludedKey:string|undefined;
  const m=chineseModel(()=>{
    if(excludedKey)return;
    excludedKey=f.store.listSources(f.run.id).find(s=>s.excerpt===ORIGINAL)!.sourceKey;
    assert.equal(f.store.setSourceExcluded(f.run.id,excludedKey,true),true);
  });
  const runner=makeRunner(f,p.provider,m.model);t.after(()=>{runner.stopAll();f.close();});
  const run=await terminal(f,runner);
  assert.equal(run.state,'partial');assert.equal(run.stopReason,'source_revoked');assert.notEqual(run.errorCode,'internal_error');assertPreserved(f);
  assert.equal(m.purposes.length,1,'no verifier or synthesis runs after withdrawal');
  const view=f.store.buildCanonicalView(run);assert.equal(view.accountObject!.claims.length,0);assert.ok(view.sources.find(s=>s.sourceKey===excludedKey)!.excluded);assert.match(view.limitations.join(' '),/复核|撤回/);
  assert.ok(!renderMarkdown(view).includes(STATEMENT));assert.equal(f.firstStep.link(f.run.id)!.phase,'blocked');
});

test('Runner with unavailable model preserves the collected account corpus as a partial report',async t=>{
  const f=selectedFixture();const p=recordingProvider();const runner=makeRunner(f,p.provider);
  t.after(()=>{runner.stopAll();f.close();});
  const run=await terminal(f,runner);
  assert.equal(run.state,'partial');assert.equal(run.stopReason,'model_unavailable');assert.notEqual(run.errorCode,'internal_error');assertPreserved(f);
  assert.deepEqual(p.calls.map(r=>r.type),['profile','timeline','replies']);
  const view=f.store.buildCanonicalView(run);assert.equal(view.accountObject!.claims.length,0);assert.match(view.limitations.join(' '),/分析|核验|模型/);
});

test('Runner retains changed live source text and invalidates retained candidate indices during global planning',async t=>{
  const f=selectedFixture();const p=recordingProvider();let changedKey:string|undefined;
  const m=chineseModel(purpose=>{
    if(purpose!=='x-account-synthesize')return;
    changedKey=f.store.listSources(f.run.id).find(s=>s.excerpt===ORIGINAL)!.sourceKey;
    f.db.prepare('UPDATE sources SET excerpt=? WHERE run_id=? AND source_key=?').run('Revised synthetic source: the earlier statement was withdrawn.',f.run.id,changedKey);
  });
  const runner=makeRunner(f,p.provider,m.model);t.after(()=>{runner.stopAll();f.close();});
  const run=await terminal(f,runner);
  assert.equal(run.state,'partial');assert.equal(run.stopReason,'source_revoked');
  assert.ok(changedKey);assert.match(f.store.getSource(f.run.id,changedKey)!.excerpt!,/earlier statement was withdrawn/,'terminal finalization must preserve the changed live source');
  assert.ok(f.store.research.checkpoint(f.run.id)!.xAccountResearch!.analysis.findings.some(f=>f.id.startsWith('batch:')&&!f.verified),'earlier unverified research index is retained for audit');
  const view=f.store.buildCanonicalView(run);assert.equal(view.accountObject!.claims.length,0);assert.ok(!renderMarkdown(view).includes(STATEMENT));
});

function retryFixture(f:SeededFirstStep):SeededFirstStep {
 const run=f.store.insertRun({ownerId:f.run.ownerId,question:f.run.question,seedUrl:f.run.seedUrl,provider:'research',parentRunId:null,retryOf:f.run.id,followup:false,idempotencyKey:null,bodyFingerprint:'synthetic-explicit-x-retry'});
 f.firstStep.inheritFirstStepScope(f.run.ownerId,run,f.run.id);return{...f,run};
}
test('explicit same-scope X retry reuses successful paid reads and retries only settled failed pages',async t=>{
 const f=selectedFixture();let failed=true;const m=chineseModel();
 const p=recordingProvider(request=>{if(request.type!=='timeline')return undefined;if(request.cursor===null)return pageResult([originalPost()],'next-page');if(failed){failed=false;throw new Error('synthetic known read failure');}return pageResult([originalPost('102')]);});
 // The actual provider uses ProviderError for a settled read failure.
 const original=p.provider.execute;p.provider.execute=async(r,s)=>{try{return await original(r,s);}catch{const {ProviderError}=await import('../server/adapters/types.js');throw new ProviderError('provider_bad_response','合成返回结构不符合契约。');}};
 const first=makeRunner(f,p.provider,m.model);let second:Runner|undefined;t.after(()=>{first.stopAll();second?.stopAll();f.close();});
 assert.equal((await terminal(f,first)).state,'partial');const paid=p.calls.length;
 const retry=retryFixture(f);second=makeRunner(retry,p.provider,m.model);const run=await terminal(retry,second);
 assert.equal(run.state,'completed');assert.deepEqual(p.calls.slice(paid),[{type:'timeline',handle:ACCOUNT.handle,nativeId:ACCOUNT.nativeId,cursor:'next-page'}],'known successful reads are not paid again');
 const reused=f.store.research.receipts(run.id).filter(r=>(r.request as {reusedFromRunId?:string}).reusedFromRunId===f.run.id);
 assert.equal(reused.length,3);assert.equal(f.store.listSources(run.id).find(s=>s.excerpt===ORIGINAL)!.retrievedAt,f.store.listSources(f.run.id).find(s=>s.excerpt===ORIGINAL)!.retrievedAt,'reused evidence is never presented as freshly fetched');assert.ok(reused.every(r=>r.usage?.estimatedUsd===0&&r.usage.bytes===0));assert.equal(f.store.research.receipts(f.run.id).filter(r=>r.state==='failed').length,1);
});
test('explicit X retry cannot bypass a parent unknown inflight request',async t=>{
 const f=selectedFixture();let held=false;
 const p=recordingProvider((request,signal)=>{if(request.type!=='timeline')return undefined;if(request.cursor===null)return pageResult([originalPost()],'held');held=true;return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('interrupted')),{once:true}));});
 const first=makeRunner(f,p.provider,chineseModel().model);let second:Runner|undefined;t.after(()=>{first.stopAll();second?.stopAll();f.close();});
 first.enqueue(f.run.id);await waitFor(()=>held);first.abort(f.run.id);await waitFor(()=>first.activeCount()===0);assert.equal(f.store.recoverInterruptedRuns(),1);
 const paid=p.calls.length;const retry=retryFixture(f);second=makeRunner(retry,p.provider,chineseModel().model);const run=await terminal(retry,second);
 assert.equal(run.state,'partial');assert.equal(run.stopReason,'unknown_inflight');assert.equal(p.calls.length,paid);
 const again=retryFixture(retry);const third=makeRunner(again,p.provider,chineseModel().model);t.after(()=>third.stopAll());const blocked=await terminal(again,third);assert.equal(blocked.state,'partial');assert.equal(blocked.stopReason,'unknown_inflight');assert.equal(p.calls.length,paid,'repeated retry cannot bypass an uncertain ancestor');
});
test('explicit X retry refuses a withdrawn parent corpus before replay or paid reads',async t=>{
 const f=selectedFixture();const p=recordingProvider();const first=makeRunner(f,p.provider,chineseModel().model);let second:Runner|undefined;t.after(()=>{first.stopAll();second?.stopAll();f.close();});
 await terminal(f,first);const key=f.store.listSources(f.run.id).find(s=>s.excerpt===ORIGINAL)!.sourceKey;f.store.setSourceExcluded(f.run.id,key,true);
 const paid=p.calls.length,retry=retryFixture(f);second=makeRunner(retry,p.provider,chineseModel().model);const run=await terminal(retry,second);
 assert.equal(run.state,'partial');assert.equal(run.stopReason,'source_revoked');assert.equal(p.calls.length,paid);assert.equal(f.store.research.receipts(run.id).length,0);
});


test('completed X retry findings follow source withdrawal and text changes through all retry ancestors',async t=>{
 const f=selectedFixture();const p=recordingProvider();const first=makeRunner(f,p.provider,chineseModel().model);let second:Runner|undefined,third:Runner|undefined;t.after(()=>{first.stopAll();second?.stopAll();third?.stopAll();f.close();});
 await terminal(f,first);const retry=retryFixture(f);second=makeRunner(retry,p.provider,chineseModel().model);await terminal(retry,second);
 const again=retryFixture(retry);third=makeRunner(again,p.provider,chineseModel().model);const run=await terminal(again,third);assert.equal(run.state,'completed');
 const key=f.store.listSources(f.run.id).find(s=>s.excerpt===ORIGINAL)!.sourceKey;
 const view=()=>f.store.buildCanonicalView(f.store.getRun(run.id)!);assert.equal(view().accountObject!.claims.length,1);
 f.store.setSourceExcluded(f.run.id,key,true);assert.equal(view().accountObject!.claims.length,0,'grandparent exclusion invalidates the entire dependent finding');assert.ok(!renderMarkdown(view()).includes(STATEMENT));assert.ok(!renderReportHtml(view()).includes(STATEMENT));
 f.store.setSourceExcluded(f.run.id,key,false);assert.equal(view().accountObject!.claims.length,1);
 f.db.prepare('UPDATE sources SET excerpt=? WHERE run_id=? AND source_key=?').run('Changed synthetic original.',f.run.id,key);assert.equal(view().accountObject!.claims.length,0,'grandparent content changes invalidate inherited evidence');
 f.db.prepare('UPDATE sources SET excerpt=?,url=? WHERE run_id=? AND source_key=?').run(ORIGINAL,'https://x.com/other_fixture/status/101',f.run.id,key);assert.equal(view().accountObject!.claims.length,0,'grandparent source URL changes invalidate inherited evidence');
});

test('explicit X retry also refuses an unknown ancestor model charge',async t=>{
 const f=selectedFixture();const p=recordingProvider();let held=false;
 const first=makeRunner(f,p.provider,async(input,signal)=>{
  f.store.research.reserve(f.run.id,'synthetic-real-model-reservation','model',{purpose:input.purpose},{inputTokens:10,outputTokens:10},UNLIMITED);held=true;
  return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('model interrupted')),{once:true}));
 });let second:Runner|undefined;t.after(()=>{first.stopAll();second?.stopAll();f.close();});
 first.enqueue(f.run.id);await waitFor(()=>held);first.abort(f.run.id);await waitFor(()=>first.activeCount()===0);f.store.recoverInterruptedRuns();
 const retry=retryFixture(f),m=chineseModel();second=makeRunner(retry,p.provider,m.model);const run=await terminal(retry,second);
 assert.equal(run.state,'partial');assert.equal(run.stopReason,'unknown_inflight');assert.equal(m.purposes.length,0,'an explicit retry cannot ignore an unknown model charge');
});

function modelStream(value:unknown,ending:'complete'|'missing-stop'|'error'='complete'):string {
 const events:unknown[]=[{type:'message_start',message:{id:'synthetic-model',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:40,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-tool',name:'submit_decision',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({decision:value})}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:12}}];
 if(ending==='complete'||ending==='error')events.push({type:'message_stop'});
 if(ending==='error')events.push({type:'error',error:{type:'api_error',message:'PRIVATE_PROVIDER_TEXT'}});
 return events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
}
const PORT_INPUT={purpose:'x-account-analyze',prompt:'Use all supplied synthetic materials. PRIVATE_SOURCE_TEXT',schema:{type:'object',required:['findings'],properties:{findings:{type:'array'}}},maxTokens:1000};
function productionPort(t:{after:(fn:()=>void)=>void},response:(index:number)=>string|Promise<string>,limits=UNLIMITED,status=200){
 const f=selectedFixture();t.after(()=>f.close());
 const cp=f.store.research.checkpoint(f.run.id)!;cp.limits=limits;f.store.research.save(f.run.id,cp);
 let calls=0;
 const requests:Record<string,unknown>[]=[];
 const transport:HttpTransport={async fetch(_url,init){requests.push(JSON.parse(init!.body!));const body=await response(calls++);return new Response(body,{status,headers:{'content-type':'text/event-stream'}});}};
 const options={store:f.store,run:f.run,binding:f.firstStep.selectionBinding(f.run.id)!,provider:recordingProvider().provider,signal:new AbortController().signal,transport,apiKey:'synthetic-offline-only',modelName:'deepseek-flash',assertScope:()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent()};
 return {f,requests,calls:()=>calls,model:()=>productionModel(options,cp,()=>{f.store.research.assertActive(f.run.id);options.assertScope();})};
}

test('production model repairs a fully observed protocol failure with a new metered prompt and replays both receipts', {timeout:30_000},async t=>{
 const p=productionPort(t,index=>modelStream(index===0?'PRIVATE_BAD_JSON':{findings:[]}),{...UNLIMITED,modelCalls:2,outputTokens:24});
 assert.deepEqual(await p.model()(PORT_INPUT,new AbortController().signal),{findings:[]});
 const receipts=p.f.store.research.receipts(p.f.run.id);assert.equal(receipts.length,2);assert.equal(receipts.filter(r=>r.state==='failed').length,1);
 const failed=receipts.find(r=>r.state==='failed')!;const metadata=failed.result as Record<string,unknown>;
 assert.equal(metadata.code,'invalid_decision_json');assert.equal(metadata.status,200);assert.equal(metadata.messageStop,true);assert.equal(metadata.upstreamError,false);assert.equal(metadata.usageKnown,true);assert.match(String(metadata.responseHash),/^[a-f0-9]{64}$/);assert.ok(Number(metadata.bytes)>0);
 assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE_|"prompt"|"body"|SyntaxError/);
 assert.equal(failed.usage!.inputTokens,40);assert.equal(failed.usage!.outputTokens,12);assert.equal(failed.usage!.unknownCost,false);assert.ok(Math.abs(failed.usage!.estimatedUsd!-0.0000264)<1e-12);
 const prompts=receipts.map(r=>(r.request as {prompt:string}).prompt);assert.ok(prompts.every(prompt=>prompt.startsWith(PORT_INPUT.prompt)));assert.notEqual(prompts[0],prompts[1]);assert.ok(receipts.every(r=>JSON.stringify((r.request as {schema:unknown}).schema)===JSON.stringify(PORT_INPUT.schema)));
 assert.deepEqual(await p.model()(PORT_INPUT,new AbortController().signal),{findings:[]});assert.equal(p.calls(),2,'restart replays the same failure/repair chain without buying it again');
});

test('production model bounds completed protocol repairs at three separately metered attempts', {timeout:30_000},async t=>{
 const p=productionPort(t,()=>modelStream(null));
 await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal),error=>error instanceof DshProtocolRepairExhaustedError&&error.attemptCount===3);
 assert.equal(p.calls(),3);const receipts=p.f.store.research.receipts(p.f.run.id);assert.equal(receipts.length,3);assert.equal(new Set(receipts.map(r=>r.key)).size,3);assert.ok(receipts.every(r=>r.state==='failed'&&r.usage?.unknownCost===false));
});

test('production model never repairs incomplete or errored streams and refuses old failed-null replays', {timeout:45_000},async t=>{
 for(const ending of ['missing-stop','error']as const){
  const p=productionPort(t,()=>modelStream('PRIVATE_BAD_JSON',ending));
  await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));assert.equal(p.calls(),1);
  const receipt=p.f.store.research.receipts(p.f.run.id)[0]!;assert.equal(receipt.state,'failed');assert.equal((receipt.result as {usageKnown:boolean}).usageKnown,false);assert.equal(receipt.usage!.estimatedUsd,null);assert.equal(receipt.usage!.unknownCost,true);
  p.f.db.prepare('UPDATE research_actions SET result_json=NULL WHERE run_id=? AND action_key=?').run(p.f.run.id,receipt.key);
  await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal),/model_request_failed/);assert.equal(p.calls(),1);
 }
});

test('production model preserves unknown transport failures without repair or private diagnostics', {timeout:30_000},async t=>{
 const p=productionPort(t,()=>{throw new Error('PRIVATE_TRANSPORT_ERROR');});
 await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));assert.equal(p.calls(),1);
 const receipt=p.f.store.research.receipts(p.f.run.id)[0]!;assert.equal((receipt.result as {code:string}).code,'model_failure_unknown');assert.doesNotMatch(JSON.stringify(receipt.result),/PRIVATE_|"prompt"|"body"/);assert.equal(receipt.usage!.unknownCost,true);
 await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal),/model_request_failed/);assert.equal(p.calls(),1);
});

test('production model repair attempts respect the existing shared model budget', {timeout:30_000},async t=>{
 const p=productionPort(t,()=>modelStream(null),{...UNLIMITED,modelCalls:1});
 await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal),/budget_exhausted/);assert.equal(p.calls(),1);assert.equal(p.f.store.research.receipts(p.f.run.id).length,1);
});

test('production model refuses repair for non-2xx responses even with complete usage', {timeout:30_000},async t=>{
 const p=productionPort(t,()=>modelStream(null),UNLIMITED,500);
 await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));assert.equal(p.calls(),1);
 assert.equal((p.f.store.research.receipts(p.f.run.id)[0]!.result as {status:number}).status,500);
});

test('production model cancellation and lost run authority never dispatch a protocol repair', {timeout:30_000},async t=>{
 const cancelled=productionPort(t,()=>modelStream(null));const controller=new AbortController();const reason=new Error('synthetic cancellation');controller.abort(reason);
 await assert.rejects(cancelled.model()(PORT_INPUT,controller.signal),error=>error===reason);assert.equal(cancelled.calls(),0);assert.equal(cancelled.f.store.research.receipts(cancelled.f.run.id).length,0);
 const inactive=productionPort(t,()=>{inactive.f.store.updateRun(inactive.f.run.id,{state:'partial',stop_reason:'synthetic_pause'});return modelStream(null);});
 await assert.rejects(inactive.model()(PORT_INPUT,new AbortController().signal),/run_inactive/);assert.equal(inactive.calls(),1);assert.equal(inactive.f.store.research.receipts(inactive.f.run.id).length,1);
});

function legacyModelKey(input:typeof PORT_INPUT):string{return 'x-account:model:v1:'+createHash('sha256').update(JSON.stringify({input,model:'deepseek-flash'})).digest('hex');}
test('X verification and synthesis use reasoning while old off receipts remain separate', {timeout:30_000},async t=>{
 for(const purpose of ['x-account-verify-batch','x-account-verify-synthesis','x-account-synthesize']){
  const input={...PORT_INPUT,purpose};const p=productionPort(t,()=>modelStream({fresh:true}));
  const oldKey=legacyModelKey(input);p.f.store.research.reserve(p.f.run.id,oldKey,'model',{purpose},{inputTokens:0,outputTokens:0},UNLIMITED);p.f.store.research.settle(p.f.run.id,oldKey,{legacyOff:true},{inputTokens:0,outputTokens:0,estimatedUsd:0,unknownCost:false});
  assert.deepEqual(await p.model()(input,new AbortController().signal),{fresh:true});assert.equal(p.calls(),1,'old off verification cannot satisfy a high-reasoning request');
  assert.deepEqual(p.requests[0]!.thinking,{type:'enabled'});assert.deepEqual(p.requests[0]!.output_config,{effort:'high'});assert.equal(p.requests[0]!.max_tokens,16384);
  assert.equal(p.f.store.research.receipts(p.f.run.id).length,2);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,oldKey)!.result,{legacyOff:true});
 }
});

test('X generation reuses its legacy off receipt and reasoning respects remaining output budget', {timeout:30_000},async t=>{
 const generated=productionPort(t,()=>{throw new Error('legacy generation must be replayed');});const key=legacyModelKey(PORT_INPUT);
 generated.f.store.research.reserve(generated.f.run.id,key,'model',{purpose:PORT_INPUT.purpose},{inputTokens:0,outputTokens:0},UNLIMITED);generated.f.store.research.settle(generated.f.run.id,key,{generated:true},{estimatedUsd:0,unknownCost:false});
 assert.deepEqual(await generated.model()(PORT_INPUT,new AbortController().signal),{generated:true});assert.equal(generated.calls(),0);
 const bounded=productionPort(t,()=>modelStream({verified:true}),{...UNLIMITED,outputTokens:40});const input={...PORT_INPUT,purpose:'x-account-verify-batch'};
 assert.deepEqual(await bounded.model()(input,new AbortController().signal),{verified:true});assert.equal(bounded.requests[0]!.max_tokens,40);
 assert.equal(bounded.f.store.research.receipts(bounded.f.run.id)[0]!.usage!.outputTokens,12);
 assert.deepEqual(await bounded.model()(input,new AbortController().signal),{verified:true});assert.equal(bounded.calls(),1,'changing remaining balance cannot create a second request key');
});

test('native reasoning remains out of successful and failed model receipts while usage stays cumulative', {timeout:30_000},async t=>{
 const p=productionPort(t,index=>{
  const events=modelStream(index===0?null:{verified:true}).trim().split('\n\n').map(line=>JSON.parse(line.slice(6)) as Record<string,unknown>);
  for(const event of events)if(typeof event.index==='number')event.index++;
  events.splice(1,0,{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'PRIVATE_REASONING_ONLY'}},{type:'content_block_stop',index:0});
  return events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
 });
 assert.deepEqual(await p.model()({...PORT_INPUT,purpose:'x-account-verify-batch'},new AbortController().signal),{verified:true});
 const receipts=p.f.store.research.receipts(p.f.run.id);assert.equal(receipts.length,2);assert.doesNotMatch(JSON.stringify(receipts),/PRIVATE_REASONING_ONLY/);assert.ok(receipts.every(receipt=>receipt.usage!.outputTokens===12&&receipt.usage!.unknownCost===false));
});

test('high auto plan preserves a failed named-tool receipt and makes one distinct request', {timeout:30_000},async t=>{
 const input={...PORT_INPUT,purpose:'x-account-verify-batch'};const p=productionPort(t,()=>modelStream({verified:true}));
 const oldKey='x-account:model:v1:'+createHash('sha256').update(JSON.stringify({input,model:'deepseek-flash',reasoningEffort:'high',outputCap:16384,timeoutMs:210000,decisionTimeoutMs:240000})).digest('hex');
 p.f.store.research.reserve(p.f.run.id,oldKey,'model',{purpose:input.purpose,reasoningEffort:'high'},{inputTokens:10,outputTokens:16384},UNLIMITED);
 p.f.store.research.settle(p.f.run.id,oldKey,null,{estimatedUsd:null,unknownCost:true},'failed');const before=p.f.store.research.receipt(p.f.run.id,oldKey);
 assert.deepEqual(await p.model()(input,new AbortController().signal),{verified:true});assert.equal(p.calls(),1);assert.deepEqual(p.requests[0]!.tool_choice,{type:'auto'});
 assert.deepEqual(p.f.store.research.receipt(p.f.run.id,oldKey),before,'the old failed/unknown receipt stays unchanged');
 const next=p.f.store.research.receipts(p.f.run.id).find(receipt=>receipt.key!==oldKey)!;assert.equal((next.request as {toolChoice:string}).toolChoice,'auto');assert.equal(next.state,'completed');
});

test('high auto prose cannot publish a decision and exhausts only two separately metered repairs', {timeout:30_000},async t=>{
 const p=productionPort(t,()=>{
  const events=modelStream(null).trim().split('\n\n').map(line=>JSON.parse(line.slice(6)) as {type:string;content_block?:unknown;delta?:unknown});
  for(const event of events){if(event.type==='content_block_start')event.content_block={type:'text',text:''};if(event.type==='content_block_delta')event.delta={type:'text_delta',text:'Synthetic prose without a structured submission.'};if(event.type==='message_delta')event.delta={stop_reason:'end_turn'};}
  return events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
 });
 await assert.rejects(p.model()({...PORT_INPUT,purpose:'x-account-verify-batch'},new AbortController().signal),error=>error instanceof DshProtocolRepairExhaustedError&&error.code==='missing_structured_decision'&&error.attemptCount===3);
 assert.equal(p.calls(),3);assert.ok(p.requests.every(request=>(request.tool_choice as {type:string}).type==='auto'&&(request.tools as unknown[]).length===1));
 const receipts=p.f.store.research.receipts(p.f.run.id);assert.equal(receipts.length,3);assert.ok(receipts.every(receipt=>receipt.state==='failed'&&(receipt.result as {usageKnown:boolean}).usageKnown&&receipt.usage!.unknownCost===false));
});
