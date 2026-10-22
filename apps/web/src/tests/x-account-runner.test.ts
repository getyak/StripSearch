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
    const data=JSON.parse(input.prompt.slice(input.prompt.indexOf('\nDATA\n')+6)) as {findings?:Array<{id:string}>;materials?:Array<{sourceKey:string;role:string;text:string}>};
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
  assert.deepEqual(m.purposes,['x-account-analyze','x-account-verify-batch','x-account-synthesize','x-account-verify-synthesis']);
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

test('Runner retains changed live source text and invalidates already verified batch findings during synthesis',async t=>{
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
  assert.ok(f.store.research.checkpoint(f.run.id)!.xAccountResearch!.analysis.findings.some(f=>f.verified),'earlier batch analysis is retained for audit');
  const view=f.store.buildCanonicalView(run);assert.equal(view.accountObject!.claims.length,0);assert.ok(!renderMarkdown(view).includes(STATEMENT));
});
