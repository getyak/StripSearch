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
import {collectXAccount,productionModel,runXAccountResearch} from '../server/research/x-account-research.js';
import {DshProtocolRepairExhaustedError} from '../server/research/dsh-decision.js';
import {ProviderError,type HttpTransport} from '../server/adapters/types.js';
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
    const data=JSON.parse(input.prompt.slice(input.prompt.indexOf('\nDATA\n')+6)) as {organizationStage?:string;reportStage?:string;items?:Array<{id:string;section:string}>;findings?:Array<{id:string}>;materials?:Array<{sourceKey:string;role:string;text:string}>};
    if(data.organizationStage)return {groups:[{section:'work',title:'Synthetic work',ids:data.items!.map(item=>item.id)}]};
    if(data.reportStage==='select')return {ids:data.items!.map(item=>item.id)};
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
function directResearchOptions(f:SeededFirstStep,provider:XAccountProvider,model?:XAccountModel){
 return{store:f.store,run:f.store.getRun(f.run.id)!,binding:f.firstStep.selectionBinding(f.run.id)!,provider,signal:new AbortController().signal,limits:UNLIMITED,assertScope:()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent(),...(model?{model}:{})};
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
  assert.deepEqual(m.purposes,['x-account-analyze','x-account-synthesize','x-account-synthesize','x-account-write','x-account-verify-synthesis']);
  const view=f.store.buildCanonicalView(run);
  assert.equal(view.personObject,undefined,'an independent account is never promoted into a person object');
  assert.equal(view.accountObject!.account.nativeId,'42');assert.equal(view.accountObject!.claims.length,1);
  assert.equal(view.accountObject!.claims[0]!.statement,STATEMENT);assert.equal(view.accountObject!.claims[0]!.evidence[0]!.quote,ORIGINAL);
  assert.ok(view.answer.some(s=>s.bullets.some(b=>b.text===STATEMENT)));
  for(const output of [renderMarkdown(view),renderReportHtml(view)])assert.ok(output.includes(STATEMENT));
  assertPreserved(f);
});

test('X account finalizes traffic usage without decoding unrelated paid receipt payloads',async t=>{
 const f=selectedFixture(),p=recordingProvider();let retained:unknown;
 const snapshot=()=>f.db.prepare('SELECT * FROM research_actions WHERE run_id=? ORDER BY action_key').all(f.run.id);
 const m=chineseModel(purpose=>{if(purpose!=='x-account-verify-synthesis')return;const unrelated='{"unused":"'+'x'.repeat(256*1024);f.db.prepare('UPDATE research_actions SET request_json=?,result_json=? WHERE run_id=?').run(unrelated,unrelated,f.run.id);retained=snapshot();});
 t.after(()=>f.close());const run=await runXAccountResearch(directResearchOptions(f,p.provider,m.model));
 assert.equal(run.state,'completed');assert.equal(run.stopReason,'x_account_research_complete');assert.equal(run.usage.requests,3);assert.equal(run.usage.bytes,600);assert.equal(p.calls.length,3);assert.deepEqual(snapshot(),retained,'terminal traffic reporting cannot rewrite paid receipts');assertPreserved(f);
});

test('Runner saves model phase progress once across consecutive planning selection and writing calls while retaining findings',async t=>{
 const f=selectedFixture(),p=recordingProvider(),m=chineseModel();const runner=makeRunner(f,p.provider,m.model);t.after(()=>{runner.stopAll();f.close();});
 const writes:Array<{phase:string;content:string;verified:boolean}>=[];const save=f.store.research.save.bind(f.store.research);
 f.store.research.save=(runId,checkpoint)=>{save(runId,checkpoint);const{phase,elapsedMs:_elapsedMs,steps:_steps,...content}=checkpoint;writes.push({phase,content:JSON.stringify(content),verified:checkpoint.xAccountResearch?.analysis.findings.some(finding=>finding.verified)??false});};
 const run=await terminal(f,runner);assert.equal(run.state,'completed');assert.deepEqual(m.purposes,['x-account-analyze','x-account-synthesize','x-account-synthesize','x-account-write','x-account-verify-synthesis']);
 const phaseOnlyWrites=writes.filter((write,index)=>write.phase==='x_synthesis'&&index>0&&write.content===writes[index-1]!.content);
 assert.equal(phaseOnlyWrites.length,1,'planning, selection and writing share one phase-progress checkpoint; their job checkpoints remain separate');
 const stages=f.store.listEvents(f.run.id).filter(event=>event.type==='stage').map(event=>event.payload as {key?:string;status?:string}).filter(stage=>['x_analysis','x_synthesis','x_verify_synthesis'].includes(stage.key??'')&&stage.status==='active');
 assert.deepEqual(stages.map(stage=>stage.key),['x_analysis','x_synthesis','x_verify_synthesis'],'stage switches still publish their active progress');
 assert.ok(writes.some(write=>write.phase==='x_verify_synthesis'&&write.verified),'verified findings are checkpointed before the terminal phase');
 const checkpoint=assertPreserved(f);assert.equal(checkpoint.xAccountResearch!.analysis.synthesisDone,true);assert.ok(checkpoint.xAccountResearch!.analysis.findings.some(finding=>finding.verified&&finding.statement===STATEMENT));
});

test('Runner keeps normal model concurrency three and makes recovery-plan work serial even for an invalid plan',async t=>{
 for(const policy of ['normal','recovery','invalid-plan']){
  const f=selectedFixture();const p=recordingProvider(request=>request.type==='timeline'?pageResult(Array.from({length:85},(_,i)=>originalPost(String(101+i)))):undefined);
  const binding=f.firstStep.selectionBinding(f.run.id)!;await collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider:p.provider,signal:new AbortController().signal,limits:UNLIMITED,assertScope:()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent()});
  const checkpoint=f.store.research.checkpoint(f.run.id)!;
  if(policy!=='normal')checkpoint.xAccountResearch!.modelRecovery={version:'x-model-recovery/v1',id:policy==='invalid-plan'?'invalid-plan':'c1274cbb-ae01-4f16-90f0-c3e68aa0bad9',runId:f.run.id,caseId:binding.caseId,scopeVersion:binding.scopeVersion,accountId:binding.accounts[0]!.accountId,reason:'Synthetic resource scheduling fixture; no matching failed model action.',localFixRevision:'a'.repeat(40),createdAt:new Date().toISOString(),entries:[{failedKey:'x-account:model:v1:'+'a'.repeat(64),settledAt:new Date().toISOString()}]};
  f.store.research.save(f.run.id,checkpoint);const priorReads=p.calls.length;const m=chineseModel();let active=0,peak=0;
  const model:XAccountModel=async(input,signal)=>{active++;peak=Math.max(peak,active);try{await new Promise<void>(resolve=>setImmediate(resolve));return await m.model(input,signal);}finally{active--;}};
  const runner=makeRunner(f,p.provider,model);t.after(()=>{runner.stopAll();f.close();});const run=await terminal(f,runner);
  assert.equal(run.state,'completed',policy);assert.equal(peak,policy==='normal'?3:1,policy);assert.equal(active,0);assert.equal(m.purposes.filter(purpose=>purpose==='x-account-analyze').length,5,'all retained batches are analyzed');assert.ok(m.purposes.includes('x-account-synthesize')&&m.purposes.includes('x-account-write')&&m.purposes.includes('x-account-verify-synthesis'));assert.equal(p.calls.length,priorReads,'resource scheduling does not re-read completed provider pages');assert.equal(f.store.research.checkpoint(f.run.id)!.xAccountResearch!.posts.filter(post=>post.role==='target').length,85);
 }
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
test('X ancestor reuse decodes only the exact read and still blocks unrelated inflight model charges',async t=>{
 for(const state of ['completed','failed','inflight'] as const){
  const f=selectedFixture();t.after(()=>f.close());const p=recordingProvider();await collectXAccount(directResearchOptions(f,p.provider));
  f.store.research.reserve(f.run.id,'unrelated-ancestor-model','model',{purpose:'unrelated'},{inputTokens:11,outputTokens:7},UNLIMITED);
  if(state!=='inflight')f.store.research.settle(f.run.id,'unrelated-ancestor-model',{retained:true},{estimatedUsd:state==='failed'?null:0,unknownCost:state==='failed'},state);
  const unrelated='{"unused":"'+'x'.repeat(256*1024);f.db.prepare('UPDATE research_actions SET request_json=?,result_json=?,usage_json=? WHERE run_id=? AND action_key=?').run(unrelated,unrelated,unrelated,f.run.id,'unrelated-ancestor-model');
  f.store.updateRun(f.run.id,{state:'partial',stop_reason:'synthetic_parent_partial'});const snapshot=()=>f.db.prepare('SELECT * FROM research_actions WHERE run_id=? ORDER BY action_key').all(f.run.id);const before=snapshot(),paid=p.calls.length,retry=retryFixture(f),m=chineseModel();
  const result=await runXAccountResearch(directResearchOptions(retry,p.provider,m.model));assert.equal(result.state,state==='inflight'?'partial':'completed',state);assert.equal(result.stopReason,state==='inflight'?'unknown_inflight':'x_account_research_complete');assert.equal(p.calls.length,paid,'completed provider reads are reused without another paid request');assert.equal(m.purposes.length,state==='inflight'?0:5);
  const reads=f.store.research.receipts(retry.run.id);assert.equal(reads.length,3);assert.ok(reads.every(receipt=>(receipt.request as {reusedFromRunId:string}).reusedFromRunId===f.run.id&&receipt.usage?.estimatedUsd===0&&receipt.usage?.bytes===0));assert.deepEqual(snapshot(),before,'ancestor bytes, usage and unknown charges stay unchanged');
 }
});
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
 return {f,cp,options,requests,calls:()=>calls,model:()=>productionModel(options,cp,()=>{f.store.research.assertActive(f.run.id);options.assertScope();if(!f.store.research.areSourcePagesCurrent(f.run.id,JSON.stringify(cp.pages.map(({sourceKey,url,text})=>({sourceKey,url,text})))))throw Error('source_revoked');})};
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

test('production model retains bounded provider failure codes and status without allowing another request',async t=>{
 for(const [code,status]of [['provider_timeout',504],['provider_response_too_large',413]]as const){
  const p=productionPort(t,()=>{throw new ProviderError(code,'PRIVATE_PROVIDER_BODY synthetic-offline-only PRIVATE_SOURCE_TEXT',status);});
  await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));assert.equal(p.calls(),1);
  const receipt=p.f.store.research.receipts(p.f.run.id)[0]!,metadata=receipt.result as Record<string,unknown>;
  assert.deepEqual(metadata.diagnostic,{errorName:'ProviderError',providerCode:code,providerStatus:status});assert.equal(metadata.code,'model_failure_unknown');assert.equal(metadata.status,null);assert.equal(metadata.usageKnown,false);assert.equal(receipt.usage!.unknownCost,true);
  assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE_|synthetic-offline-only|"message"|"stack"|"prompt"|"body"/);
  await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal),/model_request_failed/);assert.equal(p.calls(),1);assert.deepEqual(p.f.store.research.receipts(p.f.run.id)[0],receipt);
 }
});

test('production model retains only allowlisted native network cause codes and known error names',async t=>{
 for(const causeCode of ['ECONNRESET','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET']){
  const error=new TypeError('PRIVATE_FETCH_MESSAGE synthetic-offline-only',{cause:Object.assign(new Error('PRIVATE_CAUSE_MESSAGE'),{code:causeCode,hostname:'PRIVATE_HOST',request:{body:'PRIVATE_SOURCE_TEXT'}})});
  const p=productionPort(t,()=>{throw error;});await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));assert.equal(p.calls(),1);
  const metadata=p.f.store.research.receipts(p.f.run.id)[0]!.result as Record<string,unknown>;
  assert.deepEqual(metadata.diagnostic,{errorName:'TypeError',causeCode});assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE_|synthetic-offline-only|"message"|"stack"|"cause"|"request"|"hostname"/);
 }
});

test('provider failure classification omits non-HTTP and non-numeric status values',async t=>{
 for(const status of [99,600,Number.NaN,Number.POSITIVE_INFINITY,'PRIVATE_STATUS_CREDENTIAL']){
  const error=Object.assign(new ProviderError('provider_timeout','PRIVATE_PROVIDER_MESSAGE'),{status});
  const p=productionPort(t,()=>{throw error;});await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));
  const metadata=p.f.store.research.receipts(p.f.run.id)[0]!.result as Record<string,unknown>;
  assert.deepEqual(metadata.diagnostic,{errorName:'ProviderError',providerCode:'provider_timeout'});assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE_|"providerStatus"/);
 }
});

test('production model rejects arbitrary diagnostic fields even when they resemble error or network codes',async t=>{
 for(const error of [
  Object.assign(new ProviderError('provider_error','PRIVATE_PROVIDER_MESSAGE'),{name:'PRIVATE_ERROR_NAME',code:'provider_private_credential',status:9999,cause:{code:'ERR_PRIVATE_CREDENTIAL',message:'PRIVATE_CAUSE_MESSAGE'},body:'PRIVATE_BODY',request:{headers:{authorization:'PRIVATE_TOKEN'}}}),
  Object.assign(new Error('PRIVATE_ERROR_MESSAGE'),{name:'PRIVATE_ERROR_NAME',cause:{code:'ECONNRESET PRIVATE_TOKEN'}}),
  {name:'PRIVATE_ERROR_NAME',message:'PRIVATE_THROWN_TEXT',code:'PRIVATE_TOKEN',cause:{code:'UND_ERR_PRIVATE_TOKEN'}}
 ]){
  const p=productionPort(t,()=>{throw error;});await assert.rejects(p.model()(PORT_INPUT,new AbortController().signal));assert.equal(p.calls(),1);
  const metadata=p.f.store.research.receipts(p.f.run.id)[0]!.result as Record<string,unknown>;
  assert.equal(metadata.diagnostic,undefined);assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE_|"message"|"stack"|"body"|"request"|"authorization"/);
 }
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
  assert.equal(p.f.store.research.receipts(p.f.run.id).length,2);assert.ok(p.f.store.research.receipt(p.f.run.id,recoveryFailedKey(input)),'historical high plan and verification keys stay exact');assert.deepEqual(p.f.store.research.receipt(p.f.run.id,oldKey)!.result,{legacyOff:true});
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

const RECOVERY_INPUT={...PORT_INPUT,purpose:'x-account-verify-synthesis'};
const WRITER_RECOVERY_INPUT={...PORT_INPUT,purpose:'x-account-write',maxTokens:6500};
function recoveryRoute(input=RECOVERY_INPUT){return input.purpose==='x-account-write'?{generationMode:'bounded-structured/v1',toolChoice:'submit_decision',outputCap:6500,timeoutMs:150000,decisionTimeoutMs:180000}:{reasoningEffort:'high',toolChoice:'auto',outputCap:16384,timeoutMs:210000,decisionTimeoutMs:240000};}
function recoveryFailedKey(input=RECOVERY_INPUT):string{return 'x-account:model:v1:'+createHash('sha256').update(JSON.stringify({input,model:'deepseek-flash',...recoveryRoute(input)})).digest('hex');}
function authorizeModelRecovery(p:ReturnType<typeof productionPort>,input=RECOVERY_INPUT){
 const key=recoveryFailedKey(input);p.f.store.research.reserve(p.f.run.id,key,'model',{...input,...recoveryRoute(input)},{inputTokens:40,outputTokens:12},UNLIMITED);p.f.store.research.settle(p.f.run.id,key,null,{estimatedUsd:null,unknownCost:true},'failed');
 const settledAt=(p.f.db.prepare('SELECT settled_at AS time FROM research_actions WHERE run_id=? AND action_key=?').get(p.f.run.id,key) as {time:string}).time;
 const binding=p.options.binding;p.cp.xAccountResearch={version:'x-account/v1',accountId:binding.accounts[0]!.accountId,profile:null,history:{timeline:{started:false,cursor:null,done:false,pages:0,cursors:[],pageHashes:[]},replies:{started:false,cursor:null,done:false,pages:0,cursors:[],pageHashes:[]}},posts:[],contextQueue:[],contextDone:[],gaps:[],analysis:{completedBatches:['synthetic-retained-batch','report-plan:v1:synthetic'],findings:[],synthesisDone:false},modelRecovery:{version:'x-model-recovery/v1',id:'c1274cbb-ae01-4f16-90f0-c3e68aa0bad9',runId:p.f.run.id,caseId:binding.caseId,scopeVersion:binding.scopeVersion,accountId:binding.accounts[0]!.accountId,reason:'Explicit operator scope for one failed synthetic action',localFixRevision:'a'.repeat(40),createdAt:new Date().toISOString(),entries:[{failedKey:key,settledAt}]}};
 return {key,plan:p.cp.xAccountResearch.modelRecovery!,before:p.f.store.research.receipt(p.f.run.id,key)};
}
async function rotatedCompletedRecovery(t:{after:(fn:()=>void)=>void},input=WRITER_RECOVERY_INPUT){
 const p=productionPort(t,index=>{assert.equal(index,0,'historical replay must never dispatch another model request');return modelStream({findings:[]});});
 const original=authorizeModelRecovery(p,input);await p.model()(input,new AbortController().signal);
 const childKey='x-account:model-recovery:v1:'+createHash('sha256').update(JSON.stringify({recoveryPlanId:original.plan.id,retryOf:original.key,settledAt:original.plan.entries[0]!.settledAt})).digest('hex');
 const next=authorizeModelRecovery(p,{...input,prompt:'A different synthetic action failed after the successful recovery.'});next.plan.id='af625d4c-d065-4d73-943d-8e944660dbb8';
 return {p,original,childKey};
}
test('rotating a recovery plan replays a prior completed child with no new call or financial changes',async t=>{
 for(const input of [WRITER_RECOVERY_INPUT,RECOVERY_INPUT]){
  const {p,original,childKey}=await rotatedCompletedRecovery(t,input);const budget=p.f.store.research.budget(p.f.run.id,UNLIMITED);
  p.cp.limits={...UNLIMITED,modelCalls:budget.modelCalls,outputTokens:budget.outputTokens};
  const snapshot=()=>p.f.db.prepare('SELECT * FROM research_actions WHERE run_id=? ORDER BY action_key').all(p.f.run.id);const before=snapshot();
  assert.ok(!p.cp.xAccountResearch!.modelRecovery!.entries.some(entry=>entry.failedKey===original.key));
  assert.deepEqual(p.f.store.research.completedModelRecoveryCandidates('another-run',original.key),[],'successful recovery results remain run-scoped');
  p.f.store.research.receipts=()=>{throw Error('historical recovery must not scan the entire receipt ledger');};
  assert.deepEqual(await p.model()(input,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1,'replay adds zero upstream calls');
  assert.deepEqual(snapshot(),before);assert.deepEqual(p.f.store.research.budget(p.f.run.id,UNLIMITED),budget);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,original.key),original.before);assert.equal(p.f.store.research.receipt(p.f.run.id,childKey)!.state,'completed');
 }
});
test('historical recovery refuses changed bindings, original settlement, child identity or request and unsettled children',async t=>{
 for(const defect of ['case','scope','account','original-settlement','original-prompt','original-route','child-failed','child-inflight','child-kind','child-unsettled','retryOf','plan-id','invalid-plan-id','child-key','purpose','prompt','schema','route']as const){
  const {p,original,childKey}=await rotatedCompletedRecovery(t);const row=p.f.store.research.receipt(p.f.run.id,childKey)!;const request=row.request as Record<string,unknown>;let updatedKey=childKey;
  if(defect==='case')p.cp.firstStep!.caseId='another-case';
  else if(defect==='scope')p.cp.firstStep!.scopeVersion++;
  else if(defect==='account')p.cp.xAccountResearch!.accountId='another-account';
  else if(defect==='original-settlement')p.f.db.prepare('UPDATE research_actions SET settled_at=? WHERE run_id=? AND action_key=?').run('2000-01-01T00:00:00.000Z',p.f.run.id,original.key);
  else if(defect==='original-prompt'||defect==='original-route'){const originalRequest={...original.before!.request as Record<string,unknown>,[defect==='original-prompt'?'prompt':'toolChoice']:'changed'};p.f.db.prepare('UPDATE research_actions SET request_json=? WHERE run_id=? AND action_key=?').run(JSON.stringify(originalRequest),p.f.run.id,original.key);}
  else if(defect==='child-failed'||defect==='child-inflight')p.f.db.prepare('UPDATE research_actions SET state=? WHERE run_id=? AND action_key=?').run(defect==='child-failed'?'failed':'inflight',p.f.run.id,childKey);
  else if(defect==='child-kind')p.f.db.prepare("UPDATE research_actions SET kind='tool' WHERE run_id=? AND action_key=?").run(p.f.run.id,childKey);
  else if(defect==='child-unsettled')p.f.db.prepare('UPDATE research_actions SET settled_at=NULL WHERE run_id=? AND action_key=?').run(p.f.run.id,childKey);
  else if(defect==='retryOf')request.retryOf='x-account:model:v1:'+'c'.repeat(64);
  else if(defect==='plan-id')request.recoveryPlanId='b5fb6fa6-1d6a-4568-b999-6f5c4053b2cb';
  else if(defect==='invalid-plan-id'){request.recoveryPlanId='not-a-plan-uuid';updatedKey='x-account:model-recovery:v1:'+createHash('sha256').update(JSON.stringify({recoveryPlanId:request.recoveryPlanId,retryOf:original.key,settledAt:original.before!.settledAt})).digest('hex');}
  else if(defect==='child-key')updatedKey='x-account:model-recovery:v1:'+'d'.repeat(64);
  else if(defect==='purpose')request.purpose='x-account-synthesize';
  else if(defect==='prompt')request.prompt='Different synthetic material.';
  else if(defect==='schema')request.schema={type:'array'};
  else if(defect==='route')request.toolChoice='auto';
  p.f.db.prepare('UPDATE research_actions SET action_key=?,request_json=? WHERE run_id=? AND action_key=?').run(updatedKey,JSON.stringify(request),p.f.run.id,childKey);
  const snapshot=()=>p.f.db.prepare('SELECT * FROM research_actions WHERE run_id=? ORDER BY action_key').all(p.f.run.id);const before=snapshot();
  await assert.rejects(p.model()(WRITER_RECOVERY_INPUT,new AbortController().signal),/model_request_failed|unknown_inflight/,defect);assert.equal(p.calls(),1,defect);assert.deepEqual(snapshot(),before,defect);
 }
});
test('a completed child selected by the current plan also requires the exact original request',async t=>{
 const {p,original,childKey}=await rotatedCompletedRecovery(t);p.cp.xAccountResearch!.modelRecovery=original.plan;
 const request={...p.f.store.research.receipt(p.f.run.id,childKey)!.request as Record<string,unknown>,prompt:'Changed synthetic evidence.'};
 p.f.db.prepare('UPDATE research_actions SET request_json=? WHERE run_id=? AND action_key=?').run(JSON.stringify(request),p.f.run.id,childKey);
 const before=p.f.store.research.receipt(p.f.run.id,childKey);
 await assert.rejects(p.model()(WRITER_RECOVERY_INPUT,new AbortController().signal),/model_request_failed/);assert.equal(p.calls(),1);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,childKey),before);
});
test('historical recovery lookup never decodes unrelated completed action payloads',async t=>{
 const {p,original}=await rotatedCompletedRecovery(t);const unrelated='x-account:model:v1:'+'e'.repeat(64),otherRecovery='x-account:model-recovery:v1:'+'f'.repeat(64);
 for(const key of [unrelated,otherRecovery]){p.f.store.research.reserve(p.f.run.id,key,'model',{retryOf:'different-original'},{inputTokens:0,outputTokens:0},UNLIMITED);p.f.store.research.settle(p.f.run.id,key,{unrelated:true},{estimatedUsd:0,unknownCost:false});p.f.db.prepare('UPDATE research_actions SET result_json=? WHERE run_id=? AND action_key=?').run('unrelated payload must stay unread',p.f.run.id,key);}
 p.f.db.prepare('UPDATE research_actions SET request_json=? WHERE run_id=? AND action_key=?').run('unrelated request must stay unread',p.f.run.id,unrelated);
 assert.deepEqual(await p.model()(WRITER_RECOVERY_INPUT,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,original.key),original.before);
});
test('historical completed recovery still checks live scope and cancellation before replay',async t=>{
 for(const stop of ['scope','cancel']as const){const {p}=await rotatedCompletedRecovery(t);const controller=new AbortController();if(stop==='scope')p.options.assertScope=()=>{throw Error('scope withdrawn before replay');};else controller.abort(Error('cancelled before historical replay'));
  await assert.rejects(p.model()(WRITER_RECOVERY_INPUT,controller.signal),stop==='scope'?/scope withdrawn/:/cancelled before historical replay/);assert.equal(p.calls(),1);
 }
});
test('explicit model recovery makes exactly one child request and preserves original failure and batch identity',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}),{...UNLIMITED,modelCalls:2,outputTokens:24});const {key,plan,before}=authorizeModelRecovery(p);const markers=[...p.cp.xAccountResearch!.analysis.completedBatches];
 assert.deepEqual(await p.model()(RECOVERY_INPUT,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);
 const child=p.f.store.research.receipts(p.f.run.id).find(r=>r.key!==key)!;assert.equal(child.state,'completed');assert.deepEqual((child.request as {retryOf:string}).retryOf,key);assert.equal((child.request as {recoveryPlanId:string}).recoveryPlanId,plan.id);
 assert.deepEqual(await p.model()(RECOVERY_INPUT,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,key),before);assert.equal(before!.usage!.unknownCost,true);assert.deepEqual(p.cp.xAccountResearch!.analysis.completedBatches,markers);
});
test('explicit writer recovery makes one bounded child request and reuses its result without altering the failed original',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}),{...UNLIMITED,modelCalls:2,outputTokens:24});const {key,plan,before}=authorizeModelRecovery(p,WRITER_RECOVERY_INPUT);const markers=[...p.cp.xAccountResearch!.analysis.completedBatches];
 assert.deepEqual(await p.model()(WRITER_RECOVERY_INPUT,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);
 const receipts=p.f.store.research.receipts(p.f.run.id);assert.equal(receipts.length,2);const child=receipts.find(r=>r.key!==key)!;
 assert.equal(child.state,'completed');assert.equal((child.request as {purpose:string}).purpose,'x-account-write');assert.equal((child.request as {retryOf:string}).retryOf,key);assert.equal((child.request as {recoveryPlanId:string}).recoveryPlanId,plan.id);assert.equal((child.request as {generationMode:string}).generationMode,'bounded-structured/v1');
 assert.deepEqual(p.requests[0]!.thinking,{type:'disabled'});assert.deepEqual(p.requests[0]!.tool_choice,{type:'tool',name:'submit_decision'});assert.equal(p.requests[0]!.max_tokens,12,'the recovery shares the remaining output budget');
 assert.deepEqual(await p.model()(WRITER_RECOVERY_INPUT,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,key),before);assert.equal(before!.usage!.unknownCost,true);assert.deepEqual(p.cp.xAccountResearch!.analysis.completedBatches,markers);
});
test('model recovery refuses missing plans, wrong bindings, timestamp mismatch and original inflight',async t=>{
 for(const recoveryInput of [RECOVERY_INPUT,WRITER_RECOVERY_INPUT])for(const change of ['missing','runId','caseId','scopeVersion','accountId','failedKey','settledAt','createdAt','inflight','duplicate','purpose'] as const){
  const p=productionPort(t,()=>modelStream({findings:[]}));const input=change==='purpose'?{...recoveryInput,purpose:'x-account-verify-batch'}:recoveryInput;const {key,plan}=authorizeModelRecovery(p,input);
  if(change==='missing')delete p.cp.xAccountResearch!.modelRecovery;
  else if(change==='inflight')p.f.db.prepare("UPDATE research_actions SET state='inflight' WHERE run_id=? AND action_key=?").run(p.f.run.id,key);
  else if(change==='settledAt')plan.entries[0]!.settledAt='2000-01-01T00:00:00.000Z';
  else if(change==='failedKey')plan.entries[0]!.failedKey='x-account:model:v1:'+'b'.repeat(64);
  else if(change==='createdAt')plan.createdAt='2000-01-01T00:00:00.000Z';
  else if(change==='duplicate')plan.entries.push({...plan.entries[0]!});
  else if(change==='scopeVersion')plan.scopeVersion++;
  else if(change!=='purpose')plan[change]='wrong';
  await assert.rejects(p.model()(input,new AbortController().signal));assert.equal(p.calls(),0,`${input.purpose}: ${change}`);assert.equal(p.f.store.research.receipts(p.f.run.id).length,1);
 }
});
test('model recovery child failure, unknown inflight and exhausted budget cannot dispatch a further attempt',async t=>{
 for(const input of [RECOVERY_INPUT,WRITER_RECOVERY_INPUT])for(const failure of ['transport','protocol','inflight','budget']as const){
  const p=productionPort(t,()=>{if(failure==='transport')throw Error('synthetic unknown transport');return modelStream(null);},failure==='budget'?{...UNLIMITED,modelCalls:1}:UNLIMITED);const {key,plan}=authorizeModelRecovery(p,input);
  if(failure==='inflight'){
   const childKey='x-account:model-recovery:v1:'+createHash('sha256').update(JSON.stringify({recoveryPlanId:plan.id,retryOf:key,settledAt:plan.entries[0]!.settledAt})).digest('hex');p.f.store.research.reserve(p.f.run.id,childKey,'model',{retryOf:key,recoveryPlanId:plan.id},{inputTokens:0,outputTokens:0},UNLIMITED);
  }
  await assert.rejects(p.model()(input,new AbortController().signal));const calls=p.calls();assert.equal(calls,failure==='budget'||failure==='inflight'?0:1,`${input.purpose}: ${failure}`);
  await assert.rejects(p.model()(input,new AbortController().signal));assert.equal(p.calls(),calls,'no automatic child repair or retry');
 }
});
test('explicit model recovery preserves live source authority and caller cancellation',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}));const collected=await collectXAccount(p.options);Object.assign(p.cp,collected.checkpoint);authorizeModelRecovery(p);const source=p.f.store.listSources(p.f.run.id)[0]!;p.f.store.setSourceExcluded(p.f.run.id,source.sourceKey,true);await assert.rejects(p.model()(RECOVERY_INPUT,new AbortController().signal),/source_revoked/);assert.equal(p.calls(),0);
 const cancelled=productionPort(t,()=>modelStream({findings:[]}));authorizeModelRecovery(cancelled);const controller=new AbortController();controller.abort(Error('cancelled explicit recovery'));await assert.rejects(cancelled.model()(RECOVERY_INPUT,controller.signal),/cancelled explicit recovery/);assert.equal(cancelled.calls(),0);
});

test('an explicit recovery plan cannot force a completed original or alter a different model key',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}));const {key}=authorizeModelRecovery(p);p.f.db.prepare("UPDATE research_actions SET state='completed',result_json=? WHERE run_id=? AND action_key=?").run(JSON.stringify({original:true}),p.f.run.id,key);const before=p.f.store.research.receipt(p.f.run.id,key);
 assert.deepEqual(await p.model()(RECOVERY_INPUT,new AbortController().signal),{original:true});assert.equal(p.calls(),0);assert.deepEqual(p.f.store.research.receipt(p.f.run.id,key),before);
 const legacy=legacyModelKey(PORT_INPUT);p.f.store.research.reserve(p.f.run.id,legacy,'model',{purpose:PORT_INPUT.purpose},{inputTokens:0,outputTokens:0},UNLIMITED);p.f.store.research.settle(p.f.run.id,legacy,{retainedGeneration:true},{estimatedUsd:0,unknownCost:false});
 assert.deepEqual(await p.model()(PORT_INPUT,new AbortController().signal),{retainedGeneration:true});assert.equal(p.calls(),0);
});
test('one explicit plan recovers exactly its three synthesis actions once each',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}));const inputs=[RECOVERY_INPUT,{...RECOVERY_INPUT,purpose:'x-account-synthesize'},{...RECOVERY_INPUT,purpose:'x-account-synthesize',prompt:'A second independent synthetic topic'}];const entries=inputs.map(input=>authorizeModelRecovery(p,input).plan.entries[0]!);p.cp.xAccountResearch!.modelRecovery!.entries=entries;const originals=entries.map(entry=>p.f.store.research.receipt(p.f.run.id,entry.failedKey));
 for(const input of inputs)await p.model()(input,new AbortController().signal);assert.equal(p.calls(),3);for(const input of inputs)await p.model()(input,new AbortController().signal);assert.equal(p.calls(),3);assert.deepEqual(entries.map(entry=>p.f.store.research.receipt(p.f.run.id,entry.failedKey)),originals);
});

test('bounded structured writer disables thinking, forces one decision and keeps the same model',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}));const input={...PORT_INPUT,purpose:'x-account-write',maxTokens:6500};
 assert.deepEqual(await p.model()(input,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);const body=p.requests[0]!;
 assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'disabled'});assert.deepEqual(body.tool_choice,{type:'tool',name:'submit_decision'});assert.equal(body.max_tokens,6500);assert.equal(body.output_config,undefined);
 const receipt=p.f.store.research.receipts(p.f.run.id)[0]!;const route={generationMode:'bounded-structured/v1',toolChoice:'submit_decision',outputCap:6500,timeoutMs:150000,decisionTimeoutMs:180000};assert.equal(receipt.key,'x-account:model:v1:'+createHash('sha256').update(JSON.stringify({input,model:'deepseek-flash',...route})).digest('hex'));for(const [key,value]of Object.entries(route))assert.equal((receipt.request as Record<string,unknown>)[key],value);
 assert.deepEqual(await p.model()(input,new AbortController().signal),{findings:[]});assert.equal(p.calls(),1);
 const verification={...PORT_INPUT,purpose:'x-account-verify-synthesis'};await p.model()(verification,new AbortController().signal);assert.deepEqual(p.requests[1]!.thinking,{type:'enabled'});assert.deepEqual(p.requests[1]!.tool_choice,{type:'auto'});assert.deepEqual(p.requests[1]!.output_config,{effort:'high'});
 assert.ok(p.f.store.research.receipt(p.f.run.id,recoveryFailedKey(verification)),'existing high verification identity is unchanged');
});
test('bounded writer respects caller output and shared budget instead of raising either ceiling',async t=>{
 for(const [maxTokens,budget,expected]of [[6500,40,40],[1000,0,1000],[9000,0,6500]]as const){const p=productionPort(t,()=>modelStream({findings:[]}),{...UNLIMITED,outputTokens:budget});await p.model()({...PORT_INPUT,purpose:'x-account-write',maxTokens},new AbortController().signal);assert.equal(p.requests[0]!.max_tokens,expected);}
});
test('new writer leaves the old synthesis failure and its failed recovery child untouched',async t=>{
 const p=productionPort(t,()=>modelStream({findings:[]}));const prior={...RECOVERY_INPUT,purpose:'x-account-synthesize'};const {key,plan}=authorizeModelRecovery(p,prior);const childKey='x-account:model-recovery:v1:'+createHash('sha256').update(JSON.stringify({recoveryPlanId:plan.id,retryOf:key,settledAt:plan.entries[0]!.settledAt})).digest('hex');p.f.store.research.reserve(p.f.run.id,childKey,'model',{retryOf:key,recoveryPlanId:plan.id},{inputTokens:0,outputTokens:0},UNLIMITED);p.f.store.research.settle(p.f.run.id,childKey,null,{estimatedUsd:null,unknownCost:true},'failed');const old=[key,childKey].map(k=>p.f.store.research.receipt(p.f.run.id,k));
 const input={...prior,purpose:'x-account-write',maxTokens:6500};await p.model()(input,new AbortController().signal);assert.equal(p.calls(),1);assert.deepEqual([key,childKey].map(k=>p.f.store.research.receipt(p.f.run.id,k)),old);const written=p.f.store.research.receipts(p.f.run.id).find(r=>r.key!==key&&r.key!==childKey)!;assert.equal((written.request as {generationMode:string}).generationMode,'bounded-structured/v1');assert.equal((written.request as {recoveryPlanId?:string}).recoveryPlanId,undefined);
 await assert.rejects(p.model()(prior,new AbortController().signal),/model_request_failed/);assert.equal(p.calls(),1,'failed old recovery is never resubmitted');
});
