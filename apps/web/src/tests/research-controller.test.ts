import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { runResearch } from '../server/research/controller.js';
import type { ResearchTools, ResearchPage } from '../server/research/tool-contracts.js';
function setup() {
 const db=openDatabase(':memory:');applyCoreSchema(db);const store=new Store(db);
 const run=store.insertRun({ownerId:'owner-a',question:'Research Ada Fixture',seedUrl:'https://github.com/ada-fixture',provider:'research',parentRunId:null,retryOf:null,followup:false,idempotencyKey:null,bodyFingerprint:'test'});
 return {db,store,run};
}
const profile:ResearchPage={url:'https://github.com/ada-fixture',title:'Ada Fixture',text:'Ada Fixture builds open source compilers.',kind:'profile',publishedAt:null,links:['https://fixture.test/interview'],limitations:[],account:{platform:'github',handle:'ada-fixture',id:'123',profileUrl:'https://github.com/ada-fixture'}};
const interview:ResearchPage={url:'https://fixture.test/interview',title:'An interview',text:'Ada Fixture started the compiler project in 2020.',kind:'third_party',publishedAt:null,links:[],limitations:[]};
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

test('full page capacity skips new paid reads with an explicit gap',async()=>{
 const {db,store,run}=setup();let step=0;let calls=0;
 const pages=Array.from({length:23},(_,index)=>({...interview,url:`https://fixture.test/page-${index}`,links:['https://fixture.test/overflow']}));
 const result=await runResearch({store,run,limits:{toolCalls:100,modelCalls:10,inputTokens:150000,outputTokens:30000,elapsedMs:240000},signal:new AbortController().signal,tools:{async execute(action){calls++;return {pages:action.type==='github_profile'?[profile]:pages.slice((calls-2)*12,(calls-1)*12),requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{async decide(input){if(input.mode==='verify')return {supported:[],rejected:[]};step++;return step<3?{action:'search',query:`batch ${step}`}:step===3?{action:'read',url:'https://fixture.test/overflow'}:{action:'finish',claims:[]};}}});
 assert.equal(calls,3);assert.equal(result.sources.length,24);assert.ok(result.limitations.some(s=>s.includes('24 个页面')&&s.includes('未请求')));db.close();
});
