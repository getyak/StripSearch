import test from 'node:test';
import { renderJson, renderMarkdown } from '../shared/canonical.js';
import { renderReportHtml } from '../shared/report-html.js';
import assert from 'node:assert/strict';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { runResearch } from '../server/research/controller.js';
import { buildResearchReport } from '../server/research/controller.js';
import { RESEARCH_LIMITS, type ResearchCheckpoint } from '../server/research/research-store.js';
import { claimScopeIssue } from '../shared/research-depth.js';
import type { ResearchTools, ResearchPage } from '../server/research/tool-contracts.js';
function setup() {
 const db=openDatabase(':memory:');applyCoreSchema(db);const store=new Store(db);
 const run=store.insertRun({ownerId:'owner-a',question:'Research Ada Fixture',seedUrl:'https://github.com/ada-fixture',provider:'research',parentRunId:null,retryOf:null,followup:false,idempotencyKey:null,bodyFingerprint:'test'});
 return {db,store,run};
}
const profile:ResearchPage={url:'https://github.com/ada-fixture',title:'Ada Fixture',text:'Ada Fixture builds open source compilers.',kind:'profile',publishedAt:null,links:['https://fixture.test/interview'],limitations:[],account:{platform:'github',handle:'ada-fixture',id:'123',profileUrl:'https://github.com/ada-fixture'}};
const interview:ResearchPage={url:'https://fixture.test/interview',title:'An interview',text:'Ada Fixture started the compiler project in 2020.',kind:'third_party',publishedAt:null,links:[],limitations:[]};
test('scope checks distinguish an individual work from corpus or lifetime summaries and require literal quote binding',()=>{
 const quote='A toy compiler is useful for learning.';
 for(const statement of ['其博客的核心观点是学习编译原理。','长期主张只用玩具例子。','所有作品都关注编译器。',"The blog's central philosophy is learning compilers.",'The author consistently argues for toy examples.',"His blog's core viewpoint is compilers.",'The central viewpoint of his blog is compilers.'])assert.ok(claimScopeIssue({statement,quote}));
 for(const statement of ['这篇文章的核心观点是用玩具例子学习。','这篇文章中，其核心观点是编译原理。','本人喜欢玩具例子。','The core idea of this article is learning with toy examples.','In this article, his core viewpoint is compilers.'])assert.equal(claimScopeIssue({statement,quote}),null);
 const source='His core philosophy is learning compilers.';
 assert.equal(claimScopeIssue({statement:source,quote:source}),null);
 assert.ok(claimScopeIssue({statement:source,quote:'HIS CORE PHILOSOPHY IS LEARNING COMPILERS.'}));
});
test('a blanket model support verdict cannot promote one blog entry into a corpus viewpoint',async()=>{
 const {db,store,run}=setup();
 const quote='The tiny compiler demo trains in twenty lines.';
 const page={...profile,text:`Ada Fixture blog index. March: ${quote} February: a different topic.`,links:[]};
 const broad='其个人博客的核心观点是：用二十行训练编译器。';
 const narrow='该条目介绍了一个二十行的编译器训练示例。';
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[page],requests:1,bytes:page.text.length,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[0,1],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote,statement:broad,kind:'page_statement',facet:'expression'},{sourceKey:'S1',quote,statement:narrow,kind:'page_statement',facet:'expression'}]};}}});
 assert.equal(result.state,'partial');assert.equal(result.observations.length,1);assert.equal(result.observations[0]!.statement,narrow);
 assert.equal(JSON.stringify(result).includes(broad),false);assert.match(result.limitations.join(' '),/单条来源摘录/);
 assert.equal(store.research.checkpoint(run.id)!.claims[0]!.verified,true);assert.equal(store.research.checkpoint(run.id)!.pages[0]!.text,page.text);db.close();
});
test('a literal scoped source assertion survives the scope guard without becoming an independent fact',async()=>{
 const {db,store,run}=setup();const quote='我的博客的核心观点是：用玩具例子学习编译原理。';
 const page={...profile,text:quote,links:[]};
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[page],requests:1,bytes:quote.length,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[0],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote,statement:quote,kind:'attributed_statement'}]};}}});
 assert.equal(result.observations[0]!.statement,quote);assert.equal(result.observations[0]!.kind,'attributed_statement');db.close();
});
test('canonical rejects historical verified scope inflation and a fabricated literal exemption while preserving originals',()=>{
 const {db,store,run}=setup();const quote='The tiny compiler demo trains in twenty lines.';
 const broad='其个人博客的核心观点是：用二十行训练编译器。';
 store.addSource(run.id,{key:'S1',url:profile.url,title:profile.title,kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'合成原文',identityLabel:'合成来源',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 const checkpoint:ResearchCheckpoint={phase:'done',steps:0,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[{...profile,sourceKey:'S1',text:quote,retrieval:'read'}],claims:[{sourceKey:'S1',quote,statement:broad,kind:'page_statement',section:'expression',facet:'expression',verified:true},{sourceKey:'S1',quote:broad,statement:broad,kind:'page_statement',section:'expression',facet:'expression',verified:true}],unknowns:[],stopReason:null};
 const originalClaims=JSON.stringify(checkpoint.claims);const originalText=checkpoint.pages[0]!.text;
 const result=buildResearchReport({store,run,checkpoint,limits:RESEARCH_LIMITS},'research_complete','completed');
 assert.equal(result.state,'partial');assert.equal(result.observations.length,0);assert.equal(result.answer.length,0);
 assert.match(result.limitations.join(' '),/原文材料|原作与观点/);assert.match(result.limitations.join(' '),/引用不在该来源原文/);
 assert.equal(JSON.stringify(checkpoint.claims),originalClaims);assert.equal(checkpoint.pages[0]!.text,originalText);assert.equal(result.sources.length,1);db.close();
});
for(const reason of ['scope_changed','source_revoked'])test(`canonical claim rejection preserves the higher-priority ${reason} notice`,()=>{
 const {db,store,run}=setup();const quote='The tiny compiler demo trains in twenty lines.';
 store.addSource(run.id,{key:'S1',url:profile.url,title:profile.title,kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'合成原文',identityLabel:'合成来源',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 const checkpoint:ResearchCheckpoint={phase:'done',steps:0,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:{displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:profile.url,status:'resolved',note:'Synthetic selection',candidates:[]},candidates:[],pages:[{...profile,sourceKey:'S1',text:quote,retrieval:'read'}],claims:[{sourceKey:'S1',quote,statement:'其个人博客的核心观点是编译原理。',kind:'page_statement',section:'expression',verified:true}],unknowns:[],stopReason:null};
 const result=buildResearchReport({store,run,checkpoint,limits:RESEARCH_LIMITS},reason,'partial');
 assert.equal(result.stopReason,reason);assert.equal(checkpoint.stopReason,reason);assert.match(result.identity.note!,new RegExp(reason));assert.match(result.limitations.join(' '),/冻结范围已失效或撤回/);assert.match(result.limitations.join(' '),/单条来源摘录/);assert.equal(result.observations.length,0);db.close();
});
test('research follows a discovered evidence gap and publishes only validated quotes',async()=>{
 const {db,store,run}=setup();let calls=0;let decisions=0;
 const tools:ResearchTools={async execute(action){calls++;return {pages:[action.type==='github_profile'?profile:interview],requests:1,bytes:120,estimatedUsd:.001,credits:null,limitations:[]};}};
 const result=await runResearch({store,run,tools,signal:new AbortController().signal,planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};decisions++;return decisions===1?{action:'read',url:interview.url,reason:'check project history'}:{action:'finish',claims:[{sourceKey:'S2',quote:interview.text}],unknowns:['No independent employment record.']};}}});
 assert.equal(calls,2);assert.equal(result.state,'partial');assert.equal(result.observations[0]?.statement,interview.text);assert.equal(result.sources.length,2);db.close();
});
test('unknown citations stop as partial without publishing model facts',async()=>{
 const {db,store,run}=setup();const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){return {action:'finish',claims:[{sourceKey:'S99',quote:'Invented prize'}],unknowns:[]};}}});
 assert.equal(result.state,'partial');assert.equal(result.stopReason,'invalid_evidence');assert.equal(result.observations.length,0);db.close();
});
test('restart with an unacknowledged charged action never repeats the request',async()=>{
 const {db,store,run}=setup();store.research.reserve(run.id,'tool:unknown','tool',{type:'read',url:profile.url},{inputTokens:0,outputTokens:0});let calls=0;
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){calls++;throw new Error('must not call');}},planner:{async decide(){throw new Error('must not plan');}}});
 assert.equal(calls,0);assert.equal(result.stopReason,'unknown_inflight');assert.equal(result.state,'partial');db.close();
});

test('cancelled research records late usage but publishes no late source',async()=>{
 const {db,store,run}=setup();let release!:(value:import('../server/research/tool-contracts.js').ResearchToolResult)=>void;
 const pending=new Promise<import('../server/research/tool-contracts.js').ResearchToolResult>(resolve=>{release=resolve;});
 const abort=new AbortController();
 const task=runResearch({store,run,signal:abort.signal,tools:{async execute(){return pending;}},planner:{async decide(){throw new Error('must not plan');}}});
 store.requestCancel(run.id);abort.abort(new Error('cancelled fixture'));
 release({pages:[profile],requests:1,bytes:123,estimatedUsd:.017,credits:null,limitations:[]});
 await assert.rejects(task);assert.equal(store.listSources(run.id).length,0);assert.equal(store.research.budget(run.id).estimatedUsd,.017);assert.equal(store.research.receipts(run.id)[0]?.state,'completed');db.close();
});

test('tool budget stops before an extra request and preserves collected evidence',async()=>{
 const {db,store,run}=setup();let calls=0;
 const result=await runResearch({store,run,signal:new AbortController().signal,limits:{toolCalls:1,modelCalls:8,inputTokens:150000,outputTokens:16000,elapsedMs:240000},tools:{async execute(){calls++;return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){return {action:'read',url:interview.url};}}});
 assert.equal(result.stopReason,'budget_exhausted');assert.equal(calls,1);assert.equal(result.sources.length,1);db.close();
});

test('a completed receipt is reused on restart without repeating a tool call',async()=>{
 const {db,store,run}=setup();const response={pages:[profile],requests:1,bytes:10,estimatedUsd:.001,credits:null,limitations:[]};
 const first=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return response;}},planner:{async decide(input){return input.mode==='verify'?{supported:[0],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text}],unknowns:[]};}}});
 assert.equal(first.state,'partial');let calls=0;
 const second=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){calls++;throw new Error('must not fetch');}},planner:{async decide(input){return input.mode==='verify'?{supported:[0],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text}],unknowns:[]};}}});
 assert.equal(calls,0);assert.equal(second.sources.length,1);assert.equal(store.research.budget(run.id).toolCalls,1);db.close();
});

test('independent verifier can reject a claim whose quote exists but does not support its assertion',async()=>{
 const {db,store,run}=setup();
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[],rejected:[{index:0,reason:'Building compilers does not establish winning a prize.'}]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text,statement:'Ada won a major prize.',kind:'page_statement'}],unknowns:[]};}}});
 assert.equal(result.observations.length,0);assert.equal(result.state,'partial');assert.ok(result.limitations.some(s=>s.includes('does not establish')));db.close();
});

for(const mode of ['withdraw','delete'] as const)test(`three-generation follow-up becomes invalid after ancestor ${mode}`,async()=>{
 const {db,store,run}=setup();
 await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[0],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text}],unknowns:[]};}}});
 let parent=run;
 for(let i=0;i<2;i++){
  const child=store.insertRun({ownerId:'owner-a',question:'Follow up',seedUrl:profile.url,provider:'research',parentRunId:parent.id,retryOf:null,followup:true,idempotencyKey:null,bodyFingerprint:`child${i}`});
  const cp=store.research.checkpoint(parent.id)!;
  store.research.save(child.id,{...cp,pages:cp.pages.map(p=>({...p,inheritedFrom:{runId:parent.id,sourceKey:p.sourceKey}}))});
  const source=store.listSources(parent.id)[0]!;
  store.addSource(child.id,{key:'S1',url:source.url,title:source.title,kind:source.kind,publishedAt:null,excerpt:source.excerpt,excerptLocator:source.excerptLocator,identityLabel:'inherited',identityConfirmed:true,fetchStatus:'ok',limits:[]},0);
  store.updateRun(child.id,{identity_json:JSON.stringify(cp.identity)});
  parent=store.getRun(child.id)!;
 }
 assert.equal(store.isResearchSourceActive(parent.id,'S1','owner-a'),true);
 const previousRevision=store.getRun(parent.id)!.revision;
 if(mode==='withdraw')store.setSourceExcluded(run.id,'S1',true);else store.deleteRun(run.id);
 assert.equal(store.isResearchSourceActive(parent.id,'S1','owner-a'),false);
 assert.equal(store.getRun(parent.id)!.revision,previousRevision+1);
 assert.equal(store.buildCanonicalView(parent).sources[0]?.excluded,true);
 assert.equal(store.buildCanonicalView(parent).personObject,undefined);db.close();
});

test('a single search result for another name still requires identity confirmation',async()=>{
 const {db,store,run}=setup();store.updateRun(run.id,{seed_url:null,question:'Research Grace Fixture'});
 await assert.rejects(runResearch({store,run:store.getRun(run.id)!,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){throw new Error('must not plan');}}}),error=>error instanceof Error&&error.name==='NeedsInputError');
 assert.equal(store.research.checkpoint(run.id)?.identity,null);assert.equal(store.research.checkpoint(run.id)?.candidates.length,1);db.close();
});

test('a new follow-up cannot reuse identity after its parent anchor was withdrawn',async()=>{
 const {db,store,run}=setup();
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[0],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text}],unknowns:[]};}}});
 store.updateRun(run.id,{identity_json:JSON.stringify(result.identity)});store.setSourceExcluded(run.id,'S1',true);
 const child=store.insertRun({ownerId:'owner-a',question:'Follow up',seedUrl:profile.url,provider:'research',parentRunId:run.id,retryOf:null,followup:true,idempotencyKey:null,bodyFingerprint:'revoked-child'});
 let calls=0;
 await assert.rejects(runResearch({store,run:child,signal:new AbortController().signal,tools:{async execute(){calls++;throw new Error('must not fetch');}},planner:{async decide(){throw new Error('must not plan');}}}),error=>error instanceof Error&&error.name==='NeedsInputError');
 assert.equal(calls,0);assert.equal(store.research.checkpoint(child.id)?.identity,null);assert.equal(store.buildCanonicalView(child).personObject,undefined);db.close();
});

for(const [label,verdict] of [
 ['overlapping',{supported:[0],rejected:[{index:0,reason:'wrong person'}]}],
 ['out-of-range',{supported:[1],rejected:[]}],
 ['malformed',{supported:[0]}],
] as const)test(`${label} verification preserves only exact quotes, never the proposed synthesis`,async()=>{
 const {db,store,run}=setup();
 const unsupported='Ada won a major prize.';
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?verdict:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text,statement:unsupported,kind:'attributed_statement'}],unknowns:[]};}}});
 assert.equal(result.stopReason,'verification_unavailable');assert.equal(result.state,'partial');
 assert.deepEqual(result.observations.map(o=>({statement:o.statement,kind:o.kind})),[{statement:profile.text,kind:'page_statement'}]);
 assert.equal(JSON.stringify(result).includes(unsupported),false);
 assert.ok(result.limitations.some(s=>s.includes('未通过')&&s.includes('摘录')));
 assert.equal(store.research.checkpoint(run.id)?.pendingClaims,undefined);db.close();
});

for(const mode of ['abort','store'] as const)test(`cancel during verification (${mode}) cannot publish fallback excerpts`,async()=>{
 const {db,store,run}=setup();const abort=new AbortController();
 const task=runResearch({store,run,signal:abort.signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){
  if(input.mode==='verify'){store.requestCancel(run.id);if(mode==='abort')abort.abort(new Error('cancelled verification'));return {supported:[1],rejected:[]};}
  return {action:'finish',claims:[{sourceKey:'S1',quote:profile.text,statement:'Ada won a major prize.'}],unknowns:[]};
 }}});
 await assert.rejects(task);assert.deepEqual(store.research.checkpoint(run.id)?.claims,[]);db.close();
});


test('a read batch records separate receipts and continues after a failed independent branch',async()=>{
 const {db,store,run}=setup();const {ProviderError}=await import('../server/adapters/types.js');
 const bad='https://fixture.test/unavailable';const own={...profile,links:[bad,interview.url]};let calls=0,round=0;
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){calls++;if(action.type!=='search'&&action.url===bad)throw new ProviderError('provider_forbidden','blocked');return {pages:[calls===1?own:interview],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};return ++round===1?{action:'batch',actions:[{action:'read',url:bad},{action:'read',url:interview.url}]}:{action:'finish',claims:[{sourceKey:'S2',quote:interview.text,facet:'background'}],unknowns:[]};}}});
 assert.equal(calls,3);assert.equal(result.sources.length,2);assert.equal(result.state,'partial');assert.equal(store.research.receipts(run.id).filter(r=>r.kind==='tool').length,3);assert.ok(result.limitations.some(l=>l.includes('provider_forbidden')));db.close();
});

test('search discoveries must be fetched before they can support report claims',async()=>{
 const {db,store,run}=setup();let round=0;
 const tools:ResearchTools={async execute(action){return {pages:[action.type==='github_profile'?profile:{...interview,retrieval:'search'}],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}};
 const result=await runResearch({store,run,tools,signal:new AbortController().signal,planner:{async decide(){return ++round===1?{action:'search',query:'dated original interview'}:{action:'finish',claims:[{sourceKey:'S2',quote:interview.text,facet:'background'}],unknowns:[]};}}});
 assert.equal(result.stopReason,'invalid_evidence');assert.equal(result.observations.length,0);db.close();
});

test('tool exhaustion inside a batch preserves one final synthesis and verification',async()=>{
 const {db,store,run}=setup();let calls=0,round=0,verified=false;
 const other='https://fixture.test/another';const own={...profile,links:[interview.url,other]};
 const result=await runResearch({store,run,signal:new AbortController().signal,limits:{toolCalls:2,modelCalls:8,inputTokens:150000,outputTokens:16000,elapsedMs:240000},tools:{async execute(){return {pages:[++calls===1?own:interview],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify'){verified=true;return {supported:[0],rejected:[]};}return ++round===1?{action:'batch',actions:[{action:'read',url:interview.url},{action:'read',url:other}]}:{action:'finish',claims:[{sourceKey:'S2',quote:interview.text,facet:'background'}],unknowns:[]};}}});
 assert.equal(calls,2);assert.equal(verified,true);assert.equal(result.observations.length,1);assert.equal(result.state,'partial');db.close();
});

test('runtime limits are frozen in the checkpoint and canonical usage after restart',async()=>{
 const {db,store,run}=setup();const frozen={toolCalls:3,modelCalls:4,inputTokens:150000,outputTokens:16000,elapsedMs:240000};
 const options={store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input:import('../server/research/planner.js').PlannerInput){return input.mode==='verify'?{supported:[0],rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text,facet:'work'}],unknowns:[]};}}};
 await runResearch({...options,limits:frozen});await runResearch({...options,limits:{...frozen,toolCalls:99}});
 assert.deepEqual(store.research.checkpoint(run.id)?.limits,frozen);assert.deepEqual(store.buildCanonicalView(run).research?.budget.limits,frozen);db.close();
});

test('withdrawing a supporting source clears only its question evidence from canonical coverage',async()=>{
 const {db,store,run}=setup();let round=0;
 await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){return {pages:[action.type==='github_profile'?profile:interview],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0,1],rejected:[]};return ++round===1?{action:'read',url:interview.url}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text,facet:'work'},{sourceKey:'S2',quote:interview.text,facet:'background'}],unknowns:[]};}}});
 assert.equal(store.buildCanonicalView(run).research?.coverage?.find(c=>c.id==='background')?.state,'evidence_found');
 store.setSourceExcluded(run.id,'S2',true);const coverage=store.buildCanonicalView(run).research!.coverage!;
 assert.equal(coverage.find(c=>c.id==='background')?.state,'gap');assert.equal(coverage.find(c=>c.id==='work')?.state,'evidence_found');db.close();
});


test('quote fallback never labels unverified excerpts as verified question evidence',async()=>{
 const {db,store,run}=setup();
 await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:'malformed',rejected:[]}:{action:'finish',claims:[{sourceKey:'S1',quote:profile.text,facet:'work'}],unknowns:[]};}}});
 assert.equal(store.research.checkpoint(run.id)?.claims.length,1);assert.equal(store.buildCanonicalView(run).research?.coverage?.find(c=>c.id==='work')?.state,'gap');db.close();
});

test('later search cannot erase a fetched original or its discovered links',async()=>{
 const {db,store,run}=setup();let step=0;let calls=0;
 const original={...interview,links:['https://fixture.test/child']};
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){calls++;return {pages:[action.type==='github_profile'?profile:action.type==='search'?{...interview,text:'Search description',links:[]}:original],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};step++;return step===1?{action:'read',url:interview.url}:step===2?{action:'search',query:'compiler history'}:step===3?{action:'read',url:interview.url}:{action:'finish',claims:[{sourceKey:'S2',quote:interview.text,facet:'work'}]};}}});
 assert.equal(calls,3);assert.equal(result.observations[0]?.statement,interview.text);
 const page=store.research.checkpoint(run.id)!.pages[1]!;assert.equal(page.retrieval,'read');assert.deepEqual(page.links,original.links);db.close();
});

test('a withdrawn discovery parent cannot authorize a new child request',async()=>{
 const {db,store,run}=setup();let step=0;let calls=0;const child='https://fixture.test/child';
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){calls++;return {pages:[action.type==='github_profile'?profile:{...interview,links:[child]}],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){step++;if(step===1)return {action:'read',url:interview.url};store.setSourceExcluded(run.id,'S2',true);return {action:'batch',actions:[{action:'read',url:child}]};}}});
 assert.equal(calls,2);assert.equal(result.stopReason,'url_not_discovered');assert.equal(store.getSource(run.id,'S3'),null);db.close();
});

test('withdrawing a discovery parent revokes already fetched descendants and their coverage',async()=>{
 const {db,store,run}=setup();let step=0;const child={...interview,url:'https://fixture.test/child',text:'Compiler release in 2021.'};
 await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){return {pages:[action.type==='github_profile'?profile:action.type!=='search'&&action.url===interview.url?{...interview,links:[child.url]}:child],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};step++;return step===1?{action:'read',url:interview.url}:step===2?{action:'read',url:child.url+'#section'}:{action:'finish',claims:[{sourceKey:'S3',quote:child.text,facet:'work'}]};}}});
 assert.equal(store.isResearchSourceActive(run.id,'S3',run.ownerId),true);store.setSourceExcluded(run.id,'S2',true);
 assert.equal(store.isResearchSourceActive(run.id,'S3',run.ownerId),false);assert.equal(store.buildCanonicalView(run).research?.coverage?.find(c=>c.id==='work')?.state,'gap');db.close();
});

test('revocation during a charged child request retains receipt but cannot ingest evidence',async()=>{
 const {db,store,run}=setup();let step=0;const child='https://fixture.test/child';
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){if(action.type!=='search'&&action.url===child)store.setSourceExcluded(run.id,'S2',true);return {pages:[action.type==='github_profile'?profile:action.type!=='search'&&action.url===interview.url?{...interview,links:[child]}:{...interview,url:child}],requests:1,bytes:10,estimatedUsd:.001,credits:null,limitations:[]};}},planner:{async decide(){step++;return {action:'read',url:step===1?interview.url:child};}}});
 assert.equal(result.stopReason,'source_revoked');assert.equal(store.research.budget(run.id).toolCalls,3);assert.equal(store.getSource(run.id,'S3'),null);db.close();
});

test('legacy checkpoint freezes historical limits instead of taking a larger deployment budget',async()=>{
 const {db,store,run}=setup();store.research.save(run.id,{phase:'identity',steps:0,startedAt:Date.now(),elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null});
 await runResearch({store,run,signal:new AbortController().signal,limits:{toolCalls:100,modelCalls:50,inputTokens:1000000,outputTokens:200000,elapsedMs:1000000},tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){return input.mode==='verify'?{supported:[],rejected:[]}:{action:'finish',claims:[]};}}});
 assert.equal(store.research.checkpoint(run.id)!.limits!.toolCalls,12);db.close();
});

test('follow-up preserves active discovery-only search links without turning them into evidence',async()=>{
 const {db,store,run}=setup();let step=0;const discovered={...interview,url:'https://fixture.test/search-hit',text:'Search snippet',links:[interview.url]};
 const result=await runResearch({store,run,signal:new AbortController().signal,tools:{async execute(action){return {pages:[action.type==='github_profile'?profile:discovered],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[],rejected:[]};step++;return step===1?{action:'search',query:'compiler'}:{action:'finish',claims:[]};}}});
 store.updateRun(run.id,{identity_json:JSON.stringify(result.identity)});
 const child=store.insertRun({ownerId:run.ownerId,question:'Read next',seedUrl:profile.url,provider:'research',parentRunId:run.id,retryOf:null,followup:true,idempotencyKey:null,bodyFingerprint:'discovery-child'});let calls=0;let childStep=0;
 const next=await runResearch({store,run:child,signal:new AbortController().signal,tools:{async execute(){calls++;return {pages:[interview],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};childStep++;return childStep===1?{action:'read',url:interview.url}:{action:'finish',claims:[{sourceKey:'S3',quote:interview.text}]};}}});
 assert.equal(calls,1);assert.equal(next.observations[0]?.statement,interview.text);assert.equal(store.research.checkpoint(child.id)!.pages.find(p=>p.url===discovered.url)?.retrieval,'search');db.close();
});

test('withdrawing a linked social account revokes its posts rather than only checking its upstream homepage',async()=>{
 const {db,store,run}=setup();let step=0;const account={...profile,url:'https://x.com/ada-fixture',account:{...profile.account!,platform:'x' as const,profileUrl:'https://x.com/ada-fixture'}};
 const post={...interview,url:'https://x.com/ada-fixture/status/123',text:'I changed the compiler after failing tests.'};
 await runResearch({store,run,socialAvailable:true,signal:new AbortController().signal,tools:{async execute(action){return {pages:[action.type==='github_profile'?{...profile,links:[account.url]}:action.type==='social_profile'?account:post],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};step++;return step===1?{action:'social',url:account.url}:step===2?{action:'social_posts',url:account.url}:{action:'finish',claims:[{sourceKey:'S3',quote:post.text,facet:'expression'}]};}}});
 assert.equal(store.isResearchSourceActive(run.id,'S3',run.ownerId),true);assert.deepEqual(store.research.checkpoint(run.id)!.pages[2]!.discoveredFrom,['S2']);
 store.setSourceExcluded(run.id,'S2',true);assert.equal(store.isResearchSourceActive(run.id,'S3',run.ownerId),false);assert.equal(store.buildCanonicalView(run).research?.coverage?.find(c=>c.id==='expression')?.state,'gap');db.close();
});

test('all pages beyond 24 remain available and a new linked original can be read',async()=>{
 const {db,store,run}=setup();let round=0,calls=0;
 const pages=Array.from({length:31},(_,i)=>({...interview,url:`https://fixture.test/page-${i}`,links:['https://fixture.test/overflow']}));
 const result=await runResearch({store,run,limits:{toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0},signal:new AbortController().signal,
 tools:{async execute(action){calls++;return {pages:action.type==='github_profile'?[profile]:action.type==='search'?pages:[{...interview,url:'https://fixture.test/overflow'}],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};return ++round===1?{action:'search',query:'all authored sources'}:round===2?{action:'read',url:'https://fixture.test/overflow'}:{action:'finish',claims:[{sourceKey:'S33',quote:interview.text}]};}}});
 assert.equal(calls,3);assert.equal(result.sources.length,33);assert.equal(result.observations.length,1);assert.ok(!result.limitations.some(s=>s.includes('24 个页面')));db.close();
});

const unlimited={toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0};
test('unlimited controller passes old 12 tools and 8 planning rounds and remains cancellable',async()=>{
 const {db,store,run}=setup();const abort=new AbortController();let calls=0,rounds=0;
 await assert.rejects(runResearch({store,run,limits:unlimited,signal:abort.signal,
 tools:{async execute(action){calls++;return {pages:action.type==='github_profile'?[profile]:[],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){assert.equal(input.remainingTools,null);assert.equal(input.remainingModels,null);if(++rounds===18){store.requestCancel(run.id);abort.abort(new Error('cancelled after old thresholds'));}return {action:'search',query:`unique round ${rounds}`};}}}));
 assert.equal(calls,18);assert.equal(rounds,18);assert.equal(store.research.budget(run.id).toolCalls,18);db.close();
});
test('unlimited reservation accounts for model and tool usage beyond old totals',()=>{
 const {db,store,run}=setup();
 for(let i=0;i<15;i++)for(const kind of ['tool','model'] as const){store.research.reserve(run.id,`${kind}:${i}`,kind,{}, {inputTokens:30000,outputTokens:6000},unlimited);store.research.settle(run.id,`${kind}:${i}`,{}, {inputTokens:30000,outputTokens:6000,estimatedUsd:0});}
 assert.equal(store.research.budget(run.id,unlimited).modelCalls,15);assert.equal(store.research.budget(run.id,unlimited).inputTokens,900000);db.close();
});
test('local inspect retains large originals, costs no tool request and removes revoked selection',async()=>{
 const {db,store,run}=setup();let round=0,calls=0;const body='x'.repeat(70000)+'Ada Fixture original ending.';
 await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,
 tools:{async execute(action){calls++;return {pages:[action.type==='github_profile'?profile:{...interview,text:body}],requests:1,bytes:body.length,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){round++;if(round===1)return {action:'read',url:interview.url};if(round===2)return {action:'inspect',sourceKey:'S2',offset:70000};if(round===3){const {buildResearchPrompt}=await import('../server/research/planner.js');const prompt=JSON.parse(buildResearchPrompt(input));assert.equal(prompt.inspect.text,'Ada Fixture original ending.');assert.equal(prompt.inspect.textLength,body.length);store.setSourceExcluded(run.id,'S2',true);return {action:'search',query:'another known source'};}
 const {buildResearchPrompt}=await import('../server/research/planner.js');assert.equal(JSON.parse(buildResearchPrompt(input)).inspect,undefined);return {action:'finish',claims:[]};}}});
 assert.equal(calls,3);assert.equal(store.research.checkpoint(run.id)?.pages.find(p=>p.sourceKey==='S2')?.text,body);assert.equal(store.research.checkpoint(run.id)?.inspect,undefined);db.close();
});
for(const local of [false,true])test(`unlimited repeated ${local?'inspect':'tool'} stops without another paid action`,async()=>{
 const {db,store,run}=setup();let calls=0,rounds=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(action){calls++;return {pages:[action.type==='github_profile'?profile:interview],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){assert.ok(++rounds<5);return local?{action:'inspect',sourceKey:'S1',offset:0}:{action:'read',url:interview.url};}}});
 assert.equal(result.stopReason,'no_new_evidence');assert.equal(rounds,2);assert.equal(calls,local?1:2);db.close();
});
test('historical checkpoint without limits keeps finite policy after fresh zero configuration',async()=>{
 const {db,store,run}=setup();store.research.save(run.id,{phase:'planning',steps:8,startedAt:Date.now(),elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null});
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(){throw new Error('must not fetch');}},planner:{async decide(){throw new Error('must not plan');}}});
 assert.equal(store.research.checkpoint(run.id)?.limits?.modelCalls,8);assert.notEqual(result.stopReason,'research_complete');db.close();
});


test('revisiting a local window cycle stops unlimited paid planning',async()=>{
 const {db,store,run}=setup();let rounds=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(){return {pages:[{...profile,text:'a'.repeat(4000)+'b'.repeat(4000)+'a'.repeat(2000)}],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){assert.ok(++rounds<6);return {action:'inspect',sourceKey:'S1',offset:rounds%2?0:4000};}}});
 assert.equal(rounds,3);assert.equal(result.stopReason,'no_new_evidence');db.close();
});


test('out-of-range catalog offsets normalize to a real window and cannot loop forever',async()=>{
 const {db,store,run}=setup();let rounds=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(){return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){assert.ok(++rounds<5);return {action:'catalog',offset:1000+rounds,linkOffset:1000+rounds,unknownOffset:1000+rounds};}}});
 assert.equal(rounds,2);assert.equal(result.stopReason,'no_new_evidence');db.close();
});
for(const nextCursor of [null,'pending-next-page'])test(`provider coverage gaps keep all-five-facet synthesis partial (${nextCursor})`,async()=>{
 const {db,store,run}=setup();let rounds=0;
 const own={...profile,links:[interview.url]};const original={...interview,text:'Ada Fixture started in 2020. Ada Fixture wrote a compiler. Ada Fixture published an essay. Ada Fixture answered a reviewer. Ada Fixture corrected a mistake.',links:[]};
 const facets=['background','work','expression','interaction','counterevidence'] as const;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(action){return {pages:[action.type==='github_profile'?own:original],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:['Costs are estimates.'],...(action.type!=='github_profile'?{nextCursor,coverageGaps:['Comments have not been read.']}: {})};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[0,1,2,3,4],rejected:[]};return ++rounds===1?{action:'read',url:interview.url}:{action:'finish',claims:facets.map(facet=>({sourceKey:'S2',quote:original.text,facet}))};}}});
 assert.equal(result.state,'partial');assert.equal(result.observations.length,5);assert.ok(result.limitations.includes('Comments have not been read.'));assert.deepEqual(store.research.checkpoint(run.id)?.unknowns,[]);db.close();
});


test('whitespace variants of a failed search cannot create another charged request',async()=>{
 const {db,store,run}=setup();let rounds=0,calls=0;const {ProviderError}=await import('../server/adapters/types.js');
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(action){calls++;if(action.type==='search')throw new ProviderError('provider_timeout','unknown outcome');return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){return {action:'search',query:++rounds===1?'Ada works':' Ada works '};}}});
 assert.equal(calls,2);assert.equal(result.stopReason,'no_new_evidence');assert.equal(store.research.receipts(run.id).filter(r=>r.request&&r.kind==='tool').length,2);db.close();
});
test('revocation during model preparation prevents sending its stale prompt',async()=>{
 const {db,store,run}=setup();let rounds=0,modelCalls=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,deepseekApiKey:'synthetic',transport:{async fetch(){modelCalls++;throw new Error('must never send');}},tools:{async execute(action){return {pages:[action.type==='github_profile'?profile:interview],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(_input,signal,invoke){if(++rounds===1)return {action:'read',url:interview.url};store.setSourceExcluded(run.id,'S2',true);await invoke({path:'/v1/messages',body:{max_tokens:2500},signal} as Parameters<typeof invoke>[0]);return {action:'finish',claims:[]};}}});
 assert.equal(modelCalls,0);assert.equal(result.stopReason,'source_revoked');db.close();
});


test('explicit tool cap with unlimited model calls stops when further planning cannot collect evidence',async()=>{
 const {db,store,run}=setup();let rounds=0,calls=0;
 const result=await runResearch({store,run,limits:{...unlimited,toolCalls:1},signal:new AbortController().signal,tools:{async execute(){calls++;return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){assert.ok(++rounds<3);return {action:'read',url:interview.url};}}});
 assert.equal(calls,1);assert.equal(rounds,1);assert.equal(result.stopReason,'budget_exhausted');db.close();
});

test('identical source excerpts at shifted offsets do not buy more unlimited planning',async()=>{
 const {db,store,run}=setup();let rounds=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,tools:{async execute(){return {pages:[{...profile,text:'a'.repeat(10000)}],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(){assert.ok(++rounds<5);return {action:'inspect',sourceKey:'S1',offset:rounds-1};}}});
 assert.equal(rounds,2);assert.equal(result.stopReason,'no_new_evidence');assert.equal(store.research.checkpoint(run.id)?.pages[0]?.text.length,10000);db.close();
});


test('all four batch inspect windows persist, reach next planner and exclude revoked sources',async()=>{
 const {db,store,run}=setup();let round=0,calls=0;
 const other={...interview,url:'https://fixture.test/other',text:'Another exact original.'};
 const long={...interview,text:'A'.repeat(4000)+'B'.repeat(4000)};
 await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,
 tools:{async execute(action){calls++;return {pages:[action.type==='github_profile'?{...profile,links:[interview.url,other.url]}:action.type!=='search'&&action.url===other.url?other:long],requests:1,bytes:8000,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){
  if(++round===1)return {action:'batch',actions:[{action:'read',url:interview.url},{action:'read',url:other.url}]};
  if(round===2)return {action:'batch',actions:[{action:'inspect',sourceKey:'S1',offset:0},{action:'inspect',sourceKey:'S2',offset:0},{action:'inspect',sourceKey:'S2',offset:4000},{action:'inspect',sourceKey:'S3',offset:0}]};
  const {buildResearchPrompt}=await import('../server/research/planner.js');const data=JSON.parse(buildResearchPrompt(input));
  if(round===3){
   assert.equal(data.inspects.length,4);assert.equal(data.inspects[1].text,'A'.repeat(4000));assert.equal(data.inspects[2].text,'B'.repeat(4000));assert.equal(data.inspects[3].text,other.text);
   assert.equal(store.research.checkpoint(run.id)!.inspectWindows!.length,4);
   assert.ok(store.research.checkpoint(run.id)!.inspectWindows!.every(w=>!('text' in w)));
   store.setSourceExcluded(run.id,'S2',true);return {action:'catalog',offset:0};
  }
  assert.deepEqual(data.inspects.map((w:{sourceKey:string})=>w.sourceKey),['S1','S3']);
  return {action:'finish',claims:[]};
 }}});
 assert.equal(calls,3);assert.equal(store.research.checkpoint(run.id)!.pages.find(p=>p.sourceKey==='S2')!.text,long.text);
 assert.deepEqual(store.research.checkpoint(run.id)!.inspectWindows!.map(w=>w.sourceKey),['S1','S3']);db.close();
});
for(const total of [0,10])test(`scoped undiscovered reads get one correction then stop without dispatch under model cap ${total}`,async()=>{
 const {db,store,run}=setup();let round=0,calls=0;
 const result=await runResearch({store,run,limits:{...unlimited,modelCalls:total},signal:new AbortController().signal,
 firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){calls++;return {pages:[profile],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){
  assert.ok(++round<=2);if(round===2){assert.equal(input.checkpoint.lastBatchOutcomes![0]!.status,'url_not_discovered');assert.equal(input.checkpoint.noProgressBatches,1);}
  return {action:'read',url:`https://fixture.test/unobserved-${round}`};
 }}});
 assert.equal(calls,1);assert.equal(round,2);assert.equal(result.stopReason,'no_new_evidence');
 assert.equal(store.research.receipts(run.id).filter(r=>r.kind==='tool').length,1);assert.equal(store.research.checkpoint(run.id)!.limits!.modelCalls,total);db.close();
});

for(const total of [0,10])test(`scoped empty discovered pages stop after two attempts under model cap ${total}`,async()=>{
 const {db,store,run}=setup();let round=0,calls=0;
 const urls=[1,2,3].map(i=>`https://fixture.test/empty-${i}`);
 const result=await runResearch({store,run,limits:{...unlimited,modelCalls:total},signal:new AbortController().signal,
 firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(action){calls++;return {pages:[action.type==='github_profile'?{...profile,links:urls}:{...interview,url:urls[calls-2]!,text:'  ',links:[]}],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){
  assert.ok(++round<=2);if(round===2){assert.equal(input.checkpoint.lastBatchOutcomes![0]!.status,'no_new_material');assert.equal(input.checkpoint.noProgressBatches,1);}
  return {action:'read',url:urls[round-1]!};
 }}});
 assert.equal(calls,3);assert.equal(round,2);assert.equal(result.stopReason,'no_new_evidence');
 assert.equal(store.research.checkpoint(run.id)!.pages.length,3);assert.equal(store.research.checkpoint(run.id)!.noProgressBatches,2);
 assert.equal(store.research.receipts(run.id).filter(r=>r.kind==='tool').length,3);db.close();
});

for(const facetsFound of [4,5])test(`scoped five-facet synthesis preserves missing-dimension gap (${facetsFound})`,async()=>{
 const {db,store,run}=setup();let round=0;
 const original={...interview,text:'Ada Fixture started in 2020. Ada Fixture wrote a compiler. Ada Fixture published an essay. Ada Fixture answered a reviewer. Ada Fixture corrected a mistake.',links:[]};
 const facets=['background','work','expression','interaction','counterevidence'] as const;
 const quotes=original.text.split('. ').map(s=>s.endsWith('.')?s:s+'.');
 const {researchDecisionSchema}=await import('../server/research/planner.js');
 const schema=researchDecisionSchema() as {properties:{claims:{maxItems:number;items:{required:string[];properties:{facet:{enum:string[]}}}}}};
 const proposed=facets.slice(0,facetsFound).map((facet,i)=>({sourceKey:'S2',quote:quotes[i]!,statement:quotes[i]!,facet,kind:'page_statement',section:'work'}));
 assert.ok(proposed.length<=schema.properties.claims.maxItems,'all five evidenced dimensions fit the actual model schema');
 for(const claim of proposed){assert.ok(schema.properties.claims.items.required.includes('facet'));assert.ok(schema.properties.claims.items.properties.facet.enum.includes(claim.facet));}
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,
 firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(action){return {pages:[action.type==='github_profile'?profile:original],requests:1,bytes:original.text.length,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify')return {supported:proposed.map((_,i)=>i),rejected:[]};return ++round===1?{action:'read',url:interview.url}:{action:'finish',claims:proposed};}}});
 assert.equal(result.observations.length,facetsFound);assert.equal(result.state,facetsFound===5?'completed':'partial');
 assert.equal(store.buildCanonicalView(run).research!.coverage!.find(f=>f.id==='counterevidence')!.state,facetsFound===5?'evidence_found':'gap');db.close();
});


test('scoped quote-only policy rejects unsupported years even when verifier erroneously supports the claim',async()=>{
 const {db,store,run}=setup();let round=0;
 const original={...interview,text:'In 2011 I began doctoral work. I completed my MSc research.',links:[]};
 const claim={sourceKey:'S2',quote:'I completed my MSc research.',statement:'In 2011 I began doctoral work and completed an MSc.',kind:'attributed_statement',section:'background',facet:'background'};
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,
 firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(action){return {pages:[action.type==='github_profile'?profile:original],requests:1,bytes:original.text.length,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){assert.equal(input.checkpoint.quoteSupportPolicy,'exact_quote/v1');return {supported:[0],rejected:[]};}return ++round===1?{action:'read',url:interview.url}:{action:'finish',claims:[claim]};}}});
 assert.equal(result.state,'partial');assert.equal(result.observations.length,0);assert.ok(result.limitations.some(n=>n.includes('年份')));assert.ok(result.limitations.every(n=>!n.endsWith('：null')));
 const cp=store.research.checkpoint(run.id)!;assert.equal(cp.quoteSupportPolicy,'exact_quote/v1');assert.equal(cp.pages[1]!.text,original.text);
 const {buildResearchReport}=await import('../server/research/controller.js');
 const replay={...cp,claims:[{...claim,kind:'attributed_statement' as const,section:'background' as const,facet:'background' as const,verified:true}]};
 const rebuilt=buildResearchReport({store,run,checkpoint:replay,limits:unlimited},'research_complete','completed');assert.equal(rebuilt.observations.length,0);assert.equal(rebuilt.state,'partial');assert.equal(replay.claims.length,1);
 db.close();
});

test('literal years must bind the same quoted year without substring or neighbouring-page support',async()=>{
 const {claimQuotedYearIssue}=await import('../shared/research-depth.js');
 assert.equal(claimQuotedYearIssue({statement:'2020年开始研究。',quote:'Started research in 2020.'}),null);
 assert.equal(claimQuotedYearIssue({statement:'讲授200行的例子。',quote:'A 200-line example.'}),null);
 assert.ok(claimQuotedYearIssue({statement:'2020年开始研究。',quote:'Document ID 120201.'}));
 assert.ok(claimQuotedYearIssue({statement:'2005–2009本科，2011–2015博士。',quote:'BSc 2005–2009; MSc 2009–2011.'}));
});


test('reopening a completed quote-policy checkpoint guards actual Store canonical and all exports without rewriting stored claims',()=>{
 const {db,store,run}=setup();const quote='I completed my MSc research.';const statement='In 2011 I began a PhD and completed my MSc.';
 store.addSource(run.id,{key:'S1',url:profile.url,title:profile.title,kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'Synthetic original',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 store.addObservation(run.id,{statement,kind:'attributed_statement',sourceKeys:['S1'],limitations:[]},0);
 const checkpoint:ResearchCheckpoint={phase:'done',steps:2,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[{...profile,sourceKey:'S1',text:quote,retrieval:'read'}],claims:[{sourceKey:'S1',quote,statement,kind:'attributed_statement',section:'background',facet:'background',verified:true}],unknowns:[],stopReason:'research_complete',quoteSupportPolicy:'exact_quote/v1'};
 store.research.save(run.id,checkpoint);const original=JSON.stringify(checkpoint);
 store.updateRun(run.id,{state:'completed',stop_reason:'research_complete',identity_json:JSON.stringify({displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:profile.url,status:'resolved',note:'Synthetic',candidates:[]}),answer_json:JSON.stringify([{id:'background',heading:'Background',body:'',bullets:[{text:statement,sourceKeys:['S1'],kind:'attributed_statement'}]}])});
 const view=store.buildCanonicalView(store.getRun(run.id)!);assert.equal(view.state,'partial');assert.equal(view.stopReason,'claim_scope_unverified');assert.equal(view.observations.length,0);assert.equal(view.answer.length,0);assert.equal(view.personObject!.claims.length,0);assert.equal(view.personObject!.evidence.length,0);assert.ok(view.personObject!.unknowns.some(n=>n.includes('年份')));assert.equal(view.research!.coverage!.find(f=>f.id==='background')!.state,'gap');
 const claims=view.personObject!.claims;assert.equal(JSON.stringify({observations:view.observations,answer:view.answer,claims,coverage:view.research!.coverage}).includes(statement),false);
 for(const rendered of [renderJson(view),renderMarkdown(view),renderReportHtml(view)])assert.equal(rendered.includes(statement),false);
 assert.equal(store.listObservations(run.id)[0]!.statement,statement);assert.equal(JSON.stringify(store.research.checkpoint(run.id)),original);assert.equal(store.getRun(run.id)!.state,'completed');assert.equal(view.sources[0]!.excerpt,quote);
 // Historical checkpoints never gain the new policy or a quote-only pass.
 const legacy={...checkpoint};delete legacy.quoteSupportPolicy;db.prepare('UPDATE research_checkpoints SET data_json=? WHERE run_id=?').run(JSON.stringify(legacy),run.id);assert.equal(store.buildCanonicalView(store.getRun(run.id)!).observations.length,1);assert.equal(store.research.checkpoint(run.id)!.quoteSupportPolicy,undefined);
 db.close();
});

test('resuming scoped pending claims cannot relabel a completed legacy verifier receipt as quote-only attribution',async()=>{
 const {db,store,run}=setup();const quote='I wrote a compiler.';
 store.addSource(run.id,{key:'S1',url:profile.url,title:profile.title,kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'Synthetic original',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 const cp:ResearchCheckpoint={phase:'verifying',steps:0,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:{displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:profile.url,status:'resolved',note:'Synthetic',candidates:[]},candidates:[],pages:[{...profile,sourceKey:'S1',text:quote,retrieval:'read'}],claims:[],pendingClaims:[{sourceKey:'S1',quote,statement:quote,kind:'attributed_statement',section:'work'}],unknowns:[],stopReason:null};
 store.research.save(run.id,cp);store.research.reserve(run.id,'model:0','model',{model:'deepseek-flash',path:'/v1/messages'},{inputTokens:10,outputTokens:2500},unlimited);store.research.settle(run.id,'model:0',{status:200,body:'LEGACY_CONTEXT_RESULT',headers:{'content-type':'text/event-stream'}},{inputTokens:10,outputTokens:1,estimatedUsd:0});let sends=0;
 await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},deepseekApiKey:'synthetic',
 transport:{async fetch(){sends++;return {status:200,ok:true,headers:{get(){return 'text/event-stream';}},async text(){return 'NEW_QUOTE_ONLY_RESULT';}};}},
 tools:{async execute(){throw new Error('no tool dispatch needed for pending claims');}},planner:{async decide(input,signal,invoke){assert.equal(input.mode,'verify');const raw=await invoke({path:'/v1/messages',body:{model:'deepseek-flash',max_tokens:2500},signal} as Parameters<typeof invoke>[0]);assert.equal(raw.body,'NEW_QUOTE_ONLY_RESULT');return {supported:[0],rejected:[]};}}});
 assert.equal(sends,1);const receipts=store.research.receipts(run.id);assert.equal(receipts.length,2);assert.equal(receipts[0]!.key,'model:0');assert.equal((receipts[0]!.result as {body:string}).body,'LEGACY_CONTEXT_RESULT');const current=receipts.find(r=>r.key==='model:0:quote_only_v1:attribution_v1:literal_terms_v1')!;assert.equal((current.request as {verificationPolicy:string}).verificationPolicy,'exact_quote/v1');assert.equal((current.request as {attributionPolicy:string}).attributionPolicy,'quote_attribution/v1');assert.equal((current.request as {lexicalPolicy:string}).lexicalPolicy,'literal_terms/v1');assert.equal(store.research.budget(run.id,unlimited).modelCalls,2);assert.equal(store.research.checkpoint(run.id)!.quoteSupportPolicy,'exact_quote/v1');db.close();
});


test('canonical multi-source statement keeps valid support and removes only the rejected citation binding',()=>{
 const {db,store,run}=setup();const badQuote='I completed an MSc.',goodQuote='In 2011 I began doctoral work.',statement='2011年开始博士研究。';
 for(const [i,quote] of [badQuote,goodQuote].entries())store.addSource(run.id,{key:`S${i+1}`,url:i?interview.url:profile.url,title:'Synthetic',kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'Synthetic original',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},i);
 store.addObservation(run.id,{statement,kind:'attributed_statement',sourceKeys:['S1','S2'],limitations:[]},0);
 const cp:ResearchCheckpoint={phase:'done',steps:2,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[{...profile,sourceKey:'S1',text:badQuote,retrieval:'read'},{...interview,sourceKey:'S2',text:goodQuote,retrieval:'read'}],claims:[{sourceKey:'S1',quote:badQuote,statement,kind:'attributed_statement',section:'background',facet:'background',verified:true},{sourceKey:'S2',quote:goodQuote,statement,kind:'attributed_statement',section:'background',facet:'background',verified:true}],unknowns:[],stopReason:'research_complete',quoteSupportPolicy:'exact_quote/v1'};store.research.save(run.id,cp);
 store.updateRun(run.id,{state:'completed',identity_json:JSON.stringify({displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:profile.url,status:'resolved',note:'Synthetic',candidates:[]}),answer_json:JSON.stringify([{id:'background',heading:'Background',body:statement,bullets:[{text:statement,sourceKeys:['S1','S2'],kind:'attributed_statement'}]}])});
 const view=store.buildCanonicalView(store.getRun(run.id)!);assert.equal(view.observations.length,1);assert.deepEqual(view.observations[0]!.sourceKeys,['S2']);assert.equal(view.answer[0]!.body,statement);assert.deepEqual(view.answer[0]!.bullets[0]!.sourceKeys,['S2']);assert.deepEqual(view.personObject!.claims.map(c=>c.id),['C2']);assert.deepEqual(view.research!.coverage!.find(c=>c.id==='background')!.sourceKeys,['S2']);assert.deepEqual(store.listObservations(run.id)[0]!.sourceKeys,['S1','S2']);assert.equal(store.research.checkpoint(run.id)!.claims.length,2);
 store.setSourceExcluded(run.id,'S2',true);const revoked=store.buildCanonicalView(store.getRun(run.id)!);assert.equal(revoked.observations.length,0);assert.equal(revoked.answer.length,0);assert.equal(revoked.personObject!.claims.length,0);assert.equal(revoked.research!.coverage!.find(c=>c.id==='background')!.state,'gap');db.close();
});


test('scoped seeded original links retain exact article transport addresses and deny unobserved slash variants',async()=>{
 const {db,store,run}=setup();const literal='https://fixture.test/Writing/Article/?lang=zh';const original={...profile,sourceKey:'S1',retrieval:'profile' as const,links:[literal+'#details']};
 store.addSource(run.id,{key:'S1',url:original.url,title:original.title,kind:'profile',publishedAt:null,excerpt:original.text,excerptLocator:'Synthetic',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 store.research.save(run.id,{phase:'planning',steps:0,startedAt:0,elapsedMs:0,anchorUrl:original.url,identity:{displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:original.url,status:'resolved',note:'Synthetic',candidates:[]},candidates:[],pages:[original],claims:[],unknowns:[],stopReason:null});
 const dispatched:string[]=[];let rounds=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(action){assert.notEqual(action.type,'search');if(action.type==='search')throw new Error('search refused');dispatched.push(action.url);return {pages:[{...interview,url:literal,links:[]}],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};rounds++;return rounds===1?{action:'read',url:'https://fixture.test/Writing/Article?lang=zh'}:rounds===2?{action:'read',url:literal+'#details'}:{action:'finish',claims:[{sourceKey:'S2',quote:interview.text,statement:interview.text,kind:'page_statement',section:'work'}]};}}});
 assert.deepEqual(dispatched,[literal]);assert.ok(result.limitations.some(n=>n.includes('拒绝未在已读资料中发现')));assert.equal(store.research.checkpoint(run.id)!.pages[1]!.url,literal);assert.equal(store.research.checkpoint(run.id)!.pages[0]!.links[0],literal+'#details');assert.equal(store.research.receipts(run.id).filter(r=>r.kind==='tool').length,1);db.close();
});

test('scoped rejected synthesis is rewritten and independently reverified while approved claims survive',async()=>{
 const {db,store,run}=setup();let plans=0,verifications=0;
 const good={sourceKey:'S1',quote:profile.text,statement:profile.text,kind:'page_statement',section:'work'};
 const corrected={sourceKey:'S1',quote:'I wrote the parser.',statement:'作者自述编写了解析器。',kind:'attributed_statement',section:'work'};
 const bad={...corrected,statement:'In 2020 Ada Fixture invented every compiler.'};
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[{...profile,text:profile.text+' I wrote the parser.'}],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){verifications++;return verifications===1?{supported:[0],rejected:[{index:1,reason:'The quote has no year or invention claim.'}]}:{supported:[0],rejected:[]};}plans++;if(plans===2){assert.equal(input.checkpoint.claimRepairRounds,1);assert.equal(input.checkpoint.claims.length,1);assert.equal(input.checkpoint.verificationFeedback![0]!.claim.statement,bad.statement);}return {action:'finish',claims:plans===1?[good,bad]:[corrected]};}}});
 assert.equal(plans,2);assert.equal(verifications,2);assert.equal(result.observations.length,2);assert.equal(result.observations.some(o=>o.statement===bad.statement),false);assert.ok(store.research.checkpoint(run.id)!.claims.every(c=>c.verified===true));assert.equal(store.research.checkpoint(run.id)!.claimRepairRounds,1);db.close();
});

test('scoped perpetual rejection stops after exactly two repair rounds even with unlimited budget',async()=>{
 const {db,store,run}=setup();let plans=0,verifications=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[profile],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){verifications++;return {supported:[],rejected:[{index:0,reason:'Unsupported invention claim.'}]};}plans++;return {action:'finish',claims:[{sourceKey:'S1',quote:profile.text,statement:'Ada Fixture invented every compiler.'}]};}}});
 assert.equal(plans,3);assert.equal(verifications,3);assert.equal(result.state,'partial');assert.equal(result.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.claimRepairRounds,2);db.close();
});

test('scoped rejection does not spend a correction round without room for another verification',async()=>{
 const {db,store,run}=setup();let plans=0;
 const result=await runResearch({store,run,limits:{...unlimited,modelCalls:3},signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[profile],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify')return {supported:[],rejected:[{index:0,reason:'No evidence.'}]};plans++;return {action:'finish',claims:[{sourceKey:'S1',quote:profile.text}]};}}});
 assert.equal(plans,1);assert.equal(result.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.claimRepairRounds,undefined);db.close();
});


test('revocation during rejected verification stops before any synthesis repair',async()=>{
 const {db,store,run}=setup();let plans=0;
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[profile],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){store.setSourceExcluded(run.id,'S1',true);return {supported:[],rejected:[{index:0,reason:'No evidence.'}]};}plans++;return {action:'finish',claims:[{sourceKey:'S1',quote:profile.text}]};}}});
 assert.equal(plans,1);assert.equal(result.stopReason,'source_revoked');assert.equal(result.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.claimRepairRounds,undefined);db.close();
});


for(const [limit,expected] of [[4,2],[6,3]] as const)test(`scoped repair can use exactly the remaining plan and verify slots (${limit})`,async()=>{
 const {db,store,run}=setup();let plans=0,verifications=0;
 const result=await runResearch({store,run,limits:{...unlimited,modelCalls:limit},signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[profile],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){verifications++;return {supported:[],rejected:[{index:0,reason:'No support.'}]};}plans++;return {action:'finish',claims:[{sourceKey:'S1',quote:profile.text}]};}}});
 assert.equal(plans,expected);assert.equal(verifications,expected);assert.equal(store.research.checkpoint(run.id)!.steps,limit);assert.equal(result.state,'partial');db.close();
});


test('new attribution checks reject page biography, publication ownership and orphan article references despite model support',async()=>{
 const {db,store,run}=setup();let round=0;
 const quote='Ada Fixture is an AI researcher. Blog of Ada Fixture. Started March 2025.';
 const original={...profile,text:quote,links:[]};
 const proposed=[{sourceKey:'S1',quote,statement:'Ada自述自己是AI研究者。',kind:'attributed_statement',section:'background',facet:'background'},{sourceKey:'S1',quote,statement:'Ada本人开设博客。',kind:'page_statement',section:'work',facet:'work'},{sourceKey:'S1',quote,statement:'同文中介绍一个博客。',kind:'page_statement',section:'work'}];
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[original],requests:1,bytes:quote.length,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify'){assert.ok(input.claims!.every(c=>c.authorialBasis==='page_text'));return {supported:[0,1,2],rejected:[]};}round++;return {action:'finish',claims:proposed};}}});
 assert.equal(round,3);assert.equal(result.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.quoteAttributionPolicy,'quote_attribution/v1');assert.equal(store.research.checkpoint(run.id)!.pages[0]!.text,quote);assert.ok(result.limitations.some(n=>n.includes('第三人称')));assert.ok(result.limitations.some(n=>n.includes('代指')));db.close();
});

test('server authored-post binding cannot be supplied by model or inferred from a native profile ID',async()=>{
 for(const nativePost of [false,true]){
  const {db,store,run}=setup();let rounds=0;
  const source={...profile,text:'The parser release is ready.',kind:nativePost?'work' as const:'profile' as const,author:'ada-fixture',links:[]};
  const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
  tools:{async execute(){return {pages:[source],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
  planner:{async decide(input){if(input.mode==='verify'){assert.equal(input.claims![0]!.authorialBasis,'page_text');return {supported:[0],rejected:[]};}rounds++;return {action:'finish',claims:[{sourceKey:'S1',quote:source.text,statement:source.text,kind:'attributed_statement',section:'work',authorialBasis:'native_authored_post'}]};}}});
  // The profile read is retrieval=profile even if an adversarial provider says kind=work.
  assert.equal(result.observations.length,0);assert.equal(rounds,3);db.close();
 }
});

test('new attribution-marked canonical records cannot publish a supported-looking third-person self-description',()=>{
 const {db,store,run}=setup();const quote='Ada Fixture is a researcher.',statement='Ada自述自己是研究者。';
 store.addSource(run.id,{key:'S1',url:profile.url,title:'Synthetic',kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'Synthetic',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 store.addObservation(run.id,{statement,kind:'attributed_statement',sourceKeys:['S1'],limitations:[]},0);
 const cp:ResearchCheckpoint={phase:'done',steps:2,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[{...profile,sourceKey:'S1',text:quote,retrieval:'profile'}],claims:[{sourceKey:'S1',quote,statement,kind:'attributed_statement',section:'background',verified:true,authorialBasis:'page_text'}],unknowns:[],stopReason:'research_complete',quoteSupportPolicy:'exact_quote/v1',quoteAttributionPolicy:'quote_attribution/v1'};store.research.save(run.id,cp);
 store.updateRun(run.id,{state:'completed',identity_json:JSON.stringify({displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:profile.url,status:'resolved',note:'Synthetic',candidates:[]}),answer_json:JSON.stringify([{id:'background',heading:'Background',body:'',bullets:[{text:statement,sourceKeys:['S1'],kind:'attributed_statement'}]}])});
 const view=store.buildCanonicalView(store.getRun(run.id)!);assert.equal(view.state,'partial');assert.equal(view.observations.length,0);assert.equal(view.answer.length,0);assert.equal(view.personObject!.claims.length,0);for(const rendered of [renderJson(view),renderMarkdown(view),renderReportHtml(view)])assert.equal(rendered.includes(statement),false);assert.equal(store.listObservations(run.id)[0]!.statement,statement);assert.equal(store.research.checkpoint(run.id)!.claims[0]!.statement,statement);db.close();
});

test('attribution and quantity guards preserve explicit page attribution, first-person quotations and historical records',async()=>{
 const {claimAuthorialIssue,quoteHasFirstPerson}=await import('../shared/research-depth.js');
 const quote='Ada Fixture is a researcher.';
 assert.equal(claimAuthorialIssue({statement:'页面介绍Ada为研究者。',quote,kind:'page_statement',authorialBasis:'page_text'}),null);
 assert.equal(claimAuthorialIssue({statement:'Ada自述是研究者。',quote,kind:'attributed_statement'}),null);
 assert.ok(claimAuthorialIssue({statement:'此前约两年多。',quote:'The other ~2 years.',authorialBasis:'quote_first_person'}));
 assert.equal(claimAuthorialIssue({statement:'此前约两年。',quote:'The other ~2 years.',authorialBasis:'quote_first_person'}),null);
 assert.ok(claimAuthorialIssue({statement:'想成为某角色。',quote:'I wanted to be like a fictional character.',authorialBasis:'quote_first_person'}));
 assert.equal(claimAuthorialIssue({statement:'想像某角色一样。',quote:'I wanted to be like a fictional character.',authorialBasis:'quote_first_person'}),null);
 assert.ok(claimAuthorialIssue({statement:'喜欢训练网络。',quote:'I like to train networks.',facet:'background',authorialBasis:'quote_first_person'}));
 assert.equal(quoteHasFirstPerson('<a href="https://fixture.test/i/">Ada is a researcher.</a>'),false);assert.equal(quoteHasFirstPerson('I wrote the parser.'),true);
 assert.equal(quoteHasFirstPerson('我写了解析器。'),true);assert.equal(quoteHasFirstPerson('我想像某角色一样。'),true);assert.equal(quoteHasFirstPerson('他写了解析器，他想像某角色一样。'),false);assert.equal(quoteHasFirstPerson('<a href="https://fixture.test/我写">页面介绍Ada。</a>'),false);
});

test('original native authored posts support attribution without requiring first-person wording',async()=>{
 const {db,store,run}=setup();let plans=0;const accountUrl='https://x.com/adafixture';
 const post={...interview,url:accountUrl+'/status/123',text:'The parser release is ready.',kind:'work' as const,author:'adafixture',account:{platform:'x' as const,handle:'adafixture',id:'888',profileUrl:accountUrl},links:[]};
 const result=await runResearch({store,run,limits:unlimited,socialAvailable:true,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(action){return {pages:[action.type==='github_profile'?{...profile,links:[accountUrl]}:post],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){assert.equal(input.claims![0]!.authorialBasis,'native_authored_post');return {supported:[0],rejected:[]};}plans++;return plans===1?{action:'social_posts',url:accountUrl}:{action:'finish',claims:[{sourceKey:'S2',quote:post.text,statement:post.text,kind:'attributed_statement',section:'expression'}]};}}});
 assert.equal(result.observations.length,1);assert.equal(store.research.checkpoint(run.id)!.claims[0]!.authorialBasis,'native_authored_post');db.close();
});


test('new mixed-language named terms stay inside their own quote and source locator',async()=>{
 const {claimLiteralTermIssue,claimAuthorialIssue}=await import('../shared/research-depth.js');const policy={quoteLexicalPolicy:'literal_terms/v1' as const};
 assert.ok(claimLiteralTermIssue({...policy,statement:'他把Nimbus的不均衡与经济联系起来。',quote:'Here I expand on this as having to do with economics.'}));
 assert.equal(claimLiteralTermIssue({...policy,statement:'他把Nimbus的不均衡与经济联系起来。',quote:'Nimbus has jagged performance, which I associate with economics.'}),null);
 assert.equal(claimLiteralTermIssue({...policy,statement:'fixture.test页面介绍LLM及CS231n。',quote:'LLMs and CS 231n.',sourceReadUrl:'https://fixture.test/'}),null);
 assert.ok(claimLiteralTermIssue({...policy,statement:'another.test页面介绍LLM。',quote:'LLMs.',sourceReadUrl:'https://fixture.test/'}));
 for(const url of ['https://untrusted-fixture.test/','https://fixture.test.evil/'])assert.ok(claimLiteralTermIssue({...policy,statement:`他提到${url}。`,quote:'I described an untrusted HTTPS endpoint and evil content.',sourceReadUrl:'https://fixture.test/'}));
 assert.equal(claimLiteralTermIssue({...policy,statement:'fixture.test页面提到https://fixture.test/。',quote:'A page.',sourceReadUrl:'https://fixture.test/'}),null);
 assert.equal(claimLiteralTermIssue({statement:'他把Nimbus与经济联系起来。',quote:'This involves economics.'}),null);
 assert.equal(claimAuthorialIssue({statement:'同一帖中他介绍解析器。',quote:'I wrote a parser.',authorialBasis:'quote_first_person'}),null);assert.ok(claimLiteralTermIssue({...policy,statement:'同一帖中他介绍解析器。',quote:'I wrote a parser.'}));
 assert.ok(claimLiteralTermIssue({...policy,statement:'页面介绍首位课程设计者。',quote:'He designed the first deep learning course.'}));
 assert.equal(claimLiteralTermIssue({...policy,statement:'页面介绍首门课程的设计者。',quote:'He designed the first deep learning course.'}),null);
 assert.ok(claimLiteralTermIssue({...policy,statement:'索引介绍解析器。',quote:'It takes 20 lines. I cannot make it shorter.',facet:'work',sourceReadKind:'profile'}));
 assert.equal(claimLiteralTermIssue({...policy,statement:'页面称本人设计了解析器。',quote:'I designed the parser.',facet:'work',sourceReadKind:'profile'}),null);
 assert.equal(claimLiteralTermIssue({...policy,statement:'该页介绍CS 231n。',quote:'CS 231n.'}),null);assert.equal(claimLiteralTermIssue({...policy,statement:'该页介绍CS 231n。',quote:'CS231n.'}),null);
 assert.equal(claimLiteralTermIssue({...policy,statement:'该账号讨论AI音频偏好。',quote:'AIs prefer audio.'}),null);assert.equal(claimLiteralTermIssue({...policy,statement:'该账号讨论AIs音频偏好。',quote:'AI prefers audio.'}),null);assert.ok(claimLiteralTermIssue({...policy,statement:'该账号讨论AS音频偏好。',quote:'AIs prefer audio.'}));
 for(const quote of ['I write parsers.','I develop parsers.','I am writing parsers.','I have developed parsers.'])assert.equal(claimLiteralTermIssue({...policy,statement:'他自述开发解析器。',quote,facet:'work',sourceReadKind:'profile'}),null);
 for(const quote of ['I like to develop parsers.','I do not write parsers.','I cannot make this shorter.'])assert.ok(claimLiteralTermIssue({...policy,statement:'他自述开发解析器。',quote,facet:'work',sourceReadKind:'profile'}));
});

test('server lexical guard rejects missing topics then re-verifies a corrected original without rewriting history',async()=>{
 const {db,store,run}=setup();let plans=0,verifications=0;const text='Here I expand on this as having to do with economics.';
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(){return {pages:[{...profile,text,links:[]}],requests:1,bytes:text.length,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{async decide(input){if(input.mode==='verify'){verifications++;assert.equal(input.claims![0]!.quoteLexicalPolicy,'literal_terms/v1');assert.equal(input.claims![0]!.sourceReadUrl,profile.url);return {supported:[0],rejected:[]};}plans++;return {action:'finish',claims:[{sourceKey:'S1',quote:text,statement:plans===1?'该账号把Nimbus与经济联系起来。':'该账号原话提到经济因素。',kind:'attributed_statement',section:'expression',facet:'expression',sourceReadUrl:'https://spoof.test/',quoteLexicalPolicy:null}]};}}});
 assert.equal(plans,2);assert.equal(verifications,2);assert.equal(result.observations.length,1);assert.equal(result.observations[0]!.statement,'该账号原话提到经济因素。');assert.ok(store.research.checkpoint(run.id)!.verificationHistory![0]!.rejections[0]!.reason.includes('命名词'));assert.equal(result.limitations.some(n=>n.includes('命名词')),false);assert.equal(result.sources[0]!.identityConfirmed,false);assert.ok(result.sources[0]!.identityLabel.includes('归属依据见第一步'));assert.equal(store.research.checkpoint(run.id)!.pages[0]!.text,text);db.close();
});

test('persisted lexical policy filters unsupported named terms from every canonical export',()=>{
 const {db,store,run}=setup();const quote='I expand on this with economics.',statement='他把Nimbus与经济联系起来。';
 store.addSource(run.id,{key:'S1',url:profile.url,title:'Synthetic',kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'Synthetic',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);store.addObservation(run.id,{statement,kind:'attributed_statement',sourceKeys:['S1'],limitations:[]},0);
 const cp:ResearchCheckpoint={phase:'done',steps:2,startedAt:0,elapsedMs:0,anchorUrl:profile.url,identity:null,candidates:[],pages:[{...profile,sourceKey:'S1',text:quote,retrieval:'profile'}],claims:[{sourceKey:'S1',quote,statement,kind:'attributed_statement',section:'expression',facet:'expression',verified:true,authorialBasis:'quote_first_person',quoteLexicalPolicy:'literal_terms/v1',sourceReadKind:'profile',sourceReadUrl:profile.url}],unknowns:[],stopReason:'research_complete',quoteSupportPolicy:'exact_quote/v1',quoteAttributionPolicy:'quote_attribution/v1',quoteLexicalPolicy:'literal_terms/v1'};store.research.save(run.id,cp);
 store.updateRun(run.id,{state:'completed',identity_json:JSON.stringify({displayName:'Ada Fixture',handle:'ada-fixture',profileUrl:profile.url,status:'resolved',note:'Synthetic',candidates:[]}),answer_json:JSON.stringify([{id:'expression',heading:'Expression',body:'',bullets:[{text:statement,sourceKeys:['S1'],kind:'attributed_statement'}]}])});
 const view=store.buildCanonicalView(store.getRun(run.id)!);assert.equal(view.state,'partial');assert.equal(view.observations.length,0);assert.equal(view.answer.length,0);assert.equal(view.personObject!.claims.length,0);assert.equal(view.research!.coverage!.find(c=>c.id==='expression')!.state,'gap');for(const rendered of [renderJson(view),renderMarkdown(view),renderReportHtml(view)])assert.equal(rendered.includes(statement),false);assert.equal(store.listObservations(run.id)[0]!.statement,statement);assert.equal(store.research.checkpoint(run.id)!.claims[0]!.statement,statement);db.close();
});


for(const genuineGap of [false,true])test(`repaired proposal history does not act as a current gap; real gap=${genuineGap}`,async()=>{
 const {db,store,run}=setup();let plans=0;
 const passages=['In 2020 I designed a parser.','I wrote that explicit syntax helps parser composition.','I replied to a reader: nested input fails, so I recommended simpler input.'];const text=passages.join(' ');
 const claims=[{quote:passages[0],statement:'他自述2020年设计了解析器。',section:'background',facet:'background'},{quote:passages[0],statement:'他自述设计了解析器。',section:'work',facet:'work'},{quote:passages[1],statement:'他写道显式语法有助于解析器组合。',section:'expression',facet:'expression'},{quote:passages[2],statement:'他自述向读者建议使用较简单的输入。',section:'expression',facet:'interaction'},{quote:passages[2],statement:'他在回应读者时指出嵌套输入会失败。',section:'analysis',facet:'counterevidence'}];
 const result=await runResearch({store,run,limits:unlimited,signal:new AbortController().signal,firstStepScope:{selectedAccountKeys:new Set(['selected']),independentAccountKeys:new Set(),accountKeyOf:()=> 'selected'},
 tools:{async execute(action){return {pages:[action.type==='github_profile'?{...profile,text}:interview],requests:1,bytes:40,estimatedUsd:0,credits:null,limitations:[],...(genuineGap?{coverageGaps:['Actual unread supplier continuation remains.']}: {})};}},
 planner:{async decide(input){if(input.mode==='verify')return {supported:input.claims!.map((_,i)=>i),rejected:[]};plans++;if(plans===1)return {action:'read',url:interview.url};return {action:'finish',claims:plans===2?[{sourceKey:'S1',quote:text,statement:'他把Nimbus与经济联系起来。',kind:'attributed_statement',section:'expression'}]:claims.map(c=>({...c,sourceKey:'S1',kind:'attributed_statement'}))};}}});
 const cp=store.research.checkpoint(run.id)!;assert.equal(plans,3);assert.equal(cp.claims.length,5);assert.equal(result.observations.length,5);assert.equal(cp.verificationHistory![0]!.rejections.length,1);assert.ok(cp.verificationHistory![0]!.rejections[0]!.claim.statement.includes('Nimbus'));assert.equal(cp.unknowns.length,0);assert.equal(result.limitations.some(n=>n.includes('命名词')),false);assert.equal(result.state,genuineGap?'partial':'completed');assert.equal(result.stopReason,genuineGap?'limited_evidence':'research_complete');assert.equal(cp.coverageGaps!.length,genuineGap?1:0);db.close();
});
