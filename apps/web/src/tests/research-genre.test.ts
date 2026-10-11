import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,applyCoreSchema} from '../server/db/index.js';
import {Store} from '../server/store.js';
import {runResearch,buildResearchReport} from '../server/research/controller.js';
import {buildResearchPrompt,createDshPlanner,researchDecisionSchema} from '../server/research/planner.js';
import {bindGenreReview,genreReviewIssue} from '../server/research/quote-genre.js';
import type {ResearchClaim,ResearchCheckpoint} from '../server/research/research-store.js';
import type {ResearchPage} from '../server/research/tool-contracts.js';
const quote='I wrote a small compiler to understand type checking.';
const claim:ResearchClaim={sourceKey:'S1',quote,statement:'该段自述为理解类型检查而编写了一个小型编译器。',kind:'attributed_statement',section:'work',facet:'work'};
const page:ResearchPage={url:'https://github.com/genre-fixture',title:'Fixture',text:quote,kind:'profile',publishedAt:null,links:[],limitations:[]};
const limits={toolCalls:10,modelCalls:2,inputTokens:150000,outputTokens:10000,elapsedMs:60000};
const scope={selectedAccountKeys:new Set(['fixture']),independentAccountKeys:new Set<string>(),accountKeyOf:()=> 'fixture'};
function setup(){const db=openDatabase(':memory:');applyCoreSchema(db);const store=new Store(db);const run=store.insertRun({ownerId:'owner',question:'Research fixture',seedUrl:page.url,provider:'research',parentRunId:null,retryOf:null,followup:false,idempotencyKey:null,bodyFingerprint:'genre'});return {db,store,run};}

for(const decision of ['literal_relevant','exclude','uncertain','missing','duplicate','out_of_range','unknown'] as const)test(`genre verification ${decision} controls publication and coverage, even when quote support is positive`,async()=>{
 const {db,store,run}=setup();
 const decisions=decision==='missing'?undefined:decision==='duplicate'?[{index:0,decision:'literal_relevant'},{index:0,decision:'literal_relevant'}]:[{index:decision==='out_of_range'?1:0,decision:decision==='unknown'?'yes':decision}];
 const result=await runResearch({store,run,limits,signal:new AbortController().signal,firstStepScope:scope,
 tools:{async execute(){return {pages:[page],requests:1,bytes:page.text.length,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{genreReviewPolicy:'genre_context/v1',async decide(input){return input.mode==='verify'?{supported:[0],rejected:[],genreDecisions:decisions}:{action:'finish',claims:[{...claim,genreReview:{policy:'genre_context/v1',decision:'literal_relevant',sourceContentHash:'forged'}}]};}}});
 const cp=store.research.checkpoint(run.id)!;assert.equal(cp.quoteGenrePolicy,'genre_context/v1');assert.equal(cp.pages[0]!.text,quote);
 assert.equal(result.observations.length,decision==='literal_relevant'?1:0);assert.equal(result.answer.flatMap(s=>s.bullets).length,decision==='literal_relevant'?1:0);
 assert.equal(cp.claims.length,decision==='literal_relevant'?1:0);
 if(decision==='literal_relevant'){assert.equal(genreReviewIssue(cp.claims[0]!,cp.pages[0],cp.quoteGenrePolicy),null);assert.notEqual(cp.claims[0]!.genreReview!.sourceContentHash,'forged');}else assert.equal(result.state,'partial');
 db.close();
});

test('literal genre approval never overrides semantic rejection and retains the rejected proposal',async()=>{
 const {db,store,run}=setup();const result=await runResearch({store,run,limits,signal:new AbortController().signal,firstStepScope:scope,
 tools:{async execute(){return {pages:[page],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},
 planner:{genreReviewPolicy:'genre_context/v1',async decide(input){return input.mode==='verify'?{supported:[],rejected:[{index:0,reason:'Invented year is absent from quote.'}],genreDecisions:[{index:0,decision:'literal_relevant'}]}:{action:'finish',claims:[{...claim,statement:'该段自述于2020年编写了一个小型编译器。'}]};}}});
 assert.equal(result.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.verificationHistory![0]!.rejections.length,1);db.close();
});

test('genre context exposes fantasy for exclusion, without supplying an adjacent year to fact verification',()=>{
 const text='In 2011 this happened in a fictional kingdom. '+quote+' I then rode a dragon.';
 const checkpoint:ResearchCheckpoint={phase:'verifying',steps:1,startedAt:0,elapsedMs:0,anchorUrl:page.url,identity:null,candidates:[],pages:[{...page,text,sourceKey:'S1',retrieval:'read'}],claims:[],unknowns:[],stopReason:null,quoteSupportPolicy:'exact_quote/v1',quoteGenrePolicy:'genre_context/v1'};
 const data=JSON.parse(buildResearchPrompt({mode:'verify',question:'Fixture',checkpoint,claims:[claim],remainingTools:2,remainingModels:1}));
 assert.equal(data.claims[0].sourceContext.text,quote);assert.equal(data.claims[0].genreContext.text,text);assert.equal(data.claims[0].genreContext.notFactEvidence,true);assert.match(data.genreInstruction,/NOT additional factual evidence/);assert.match(data.quotedSupportInstruction,/only this claim exact quote/);
 assert.equal(createDshPlanner().genreReviewPolicy,'genre_context/v1');assert.ok((researchDecisionSchema('verify',true).required as string[]).includes('genreDecisions'));assert.equal(data.claims[0].genreContext.quoteOffset,text.indexOf(quote));
});

for(const changed of ['page','source','url','revoked','binding'] as const)test(`terminal report and exports withdraw ${changed} genre support without rewriting historical records`,()=>{
 const {db,store,run}=setup();const text='A real project diary. '+quote+' This is real compiler work.';
 const approved={...claim,verified:true,genreReview:bindGenreReview(claim,{...page,text})};
 const cp:ResearchCheckpoint={phase:'done',steps:2,startedAt:0,elapsedMs:0,anchorUrl:page.url,identity:{displayName:'Fixture',handle:'genre-fixture',profileUrl:page.url,status:'resolved',note:'Synthetic',candidates:[]},candidates:[],pages:[{...page,text,sourceKey:'S1',retrieval:'read'}],claims:[approved],unknowns:[],stopReason:null,quoteGenrePolicy:'genre_context/v1'};
 store.addSource(run.id,{key:'S1',url:page.url,title:'Fixture',kind:'profile',publishedAt:null,excerpt:text,excerptLocator:'synthetic',identityLabel:'synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);
 const result=buildResearchReport({store,run,checkpoint:cp,limits},'limited_evidence','partial');store.research.save(run.id,cp);store.addObservation(run.id,result.observations[0]!,0);store.updateRun(run.id,{state:'partial',answer_json:JSON.stringify(result.answer),identity_json:JSON.stringify(cp.identity)});
 assert.equal(store.buildCanonicalView(store.getRunForOwner(run.id,'owner')!).observations.length,1);assert.equal(store.buildCanonicalView(store.getRunForOwner(run.id,'owner')!).personObject!.claims.length,1);
 if(changed==='page'){cp.pages[0]!.text='Fantasy diary. '+quote+' Dragon work.';db.prepare('UPDATE research_checkpoints SET data_json=? WHERE run_id=?').run(JSON.stringify(cp),run.id);}
 if(changed==='source')db.prepare('UPDATE sources SET excerpt=? WHERE run_id=?').run('Fantasy diary. '+quote+' Dragon work.',run.id);
 if(changed==='url')db.prepare('UPDATE sources SET url=? WHERE run_id=?').run('https://other-genre-fixture.dev/',run.id);
 if(changed==='revoked')store.setSourceExcluded(run.id,'S1',true);
 if(changed==='binding'){cp.claims[0]!.genreReview!.contextOffset++;db.prepare('UPDATE research_checkpoints SET data_json=? WHERE run_id=?').run(JSON.stringify(cp),run.id);}
 const before=db.prepare('SELECT data_json FROM research_checkpoints WHERE run_id=?').get(run.id);
 const view=store.buildCanonicalView(store.getRunForOwner(run.id,'owner')!);assert.equal(view.observations.length,0);assert.equal(view.answer.flatMap(s=>s.bullets).length,0);assert.equal((view.personObject?.claims??[]).length,0);assert.equal(view.research?.coverage?.length,5);assert.ok(view.research?.coverage?.every(c=>c.state==='gap'));
 assert.deepEqual(db.prepare('SELECT data_json FROM research_checkpoints WHERE run_id=?').get(run.id),before);db.close();
});

test('legacy checkpoints keep their original genre scope instead of being marked newly reviewed',()=>{
 assert.equal(genreReviewIssue(claim,page,undefined),null);assert.ok(genreReviewIssue(claim,page,'genre_context/v1'));
});

test('new genre verification uses a distinct metered request key without replaying old quote-only approval',async()=>{
 const {db,store,run}=setup();const cp:ResearchCheckpoint={phase:'verifying',steps:0,startedAt:0,elapsedMs:0,anchorUrl:page.url,identity:{displayName:'Fixture',handle:'genre-fixture',profileUrl:page.url,status:'resolved',note:'Synthetic',candidates:[]},candidates:[],pages:[{...page,sourceKey:'S1',retrieval:'read'}],claims:[],pendingClaims:[claim],unknowns:[],stopReason:null,quoteGenrePolicy:'genre_context/v1',limits:{...limits,modelCalls:10}};
 store.addSource(run.id,{key:'S1',url:page.url,title:'Fixture',kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'synthetic',identityLabel:'synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);store.research.save(run.id,cp);
 const oldKey='model:0:quote_only_v1:attribution_v1:literal_terms_v1:preserve_actor_v1';store.research.reserve(run.id,oldKey,'model',{model:'deepseek-flash'},{inputTokens:10,outputTokens:2500},cp.limits!);store.research.settle(run.id,oldKey,{status:200,body:'OLD_APPROVAL',headers:{}},{inputTokens:10,outputTokens:1,estimatedUsd:0});let sends=0;
 await runResearch({store,run,limits,signal:new AbortController().signal,firstStepScope:scope,deepseekApiKey:'synthetic',transport:{async fetch(){sends++;return {status:200,ok:true,headers:{get(){return 'text/event-stream';}},async text(){return 'NEW_GENRE_RECEIPT';}};}},tools:{async execute(){throw Error('unexpected tool');}},planner:{genreReviewPolicy:'genre_context/v1',async decide(input,signal,invoke){assert.equal(input.mode,'verify');const raw=await invoke({path:'/v1/messages',body:{model:'deepseek-flash',max_tokens:2500},signal} as Parameters<typeof invoke>[0]);assert.equal(raw.body,'NEW_GENRE_RECEIPT');return {supported:[0],rejected:[],genreDecisions:[{index:0,decision:'literal_relevant'}]};}}});
 assert.equal(sends,1);const receipts=store.research.receipts(run.id);assert.equal((receipts.find(r=>r.key===oldKey)!.result as {body:string}).body,'OLD_APPROVAL');assert.equal((receipts.find(r=>r.key.startsWith(oldKey+':genre_context_v1:binding_'))!.request as {genrePolicy:string}).genrePolicy,'genre_context/v1');assert.equal(store.research.budget(run.id,cp.limits!).modelCalls,2);db.close();
});

test('genre-unavailable verification keeps originals but cannot publish unreviewed literal excerpts as person claims',async()=>{
 const {db,store,run}=setup();const result=await runResearch({store,run,limits:{...limits,modelCalls:1},signal:new AbortController().signal,firstStepScope:scope,tools:{async execute(){return {pages:[page],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{genreReviewPolicy:'genre_context/v1',async decide(){return {action:'finish',claims:[claim]};}}});
 assert.equal(result.stopReason,'budget_exhausted');assert.equal(result.observations.length,0);assert.equal(result.sources.length,1);assert.equal(store.research.checkpoint(run.id)!.pages[0]!.text,quote);db.close();
});

for(const changed of ['context','claim'] as const)test(`a completed genre receipt cannot be rebound to changed ${changed} at the same step and quote`,async()=>{
 const {db,store,run}=setup();let sends=0,verifyRound=0;const original='Real compiler diary. '+quote+' Actual type checking work.';
 const transport={async fetch(){sends++;return {status:200,ok:true,headers:{get(){return 'text/event-stream';}},async text(){return 'GENRE_RECEIPT_'+sends;}};}};
 const planner={genreReviewPolicy:'genre_context/v1' as const,async decide(input:Parameters<ReturnType<typeof createDshPlanner>['decide']>[0],signal:AbortSignal,invoke:Parameters<ReturnType<typeof createDshPlanner>['decide']>[2]){
  if(input.mode!=='verify')return {action:'finish',claims:[claim]};
  verifyRound++;const raw=await invoke({path:'/v1/messages',body:{model:'deepseek-flash',max_tokens:2500,messages:[{role:'user',content:'Synthetic fixed-body probe; server must bind claims independently.'}]},signal} as Parameters<typeof invoke>[0]);assert.equal(raw.body,'GENRE_RECEIPT_'+verifyRound);
  return verifyRound===1?{supported:[0],rejected:[],genreDecisions:[{index:0,decision:'literal_relevant'}]}:{supported:[],rejected:[{index:0,reason:changed==='context'?'This is fantasy.':'The new claim invents a year.'}],genreDecisions:[{index:0,decision:changed==='context'?'exclude':'literal_relevant'}]};
 }};
 const options={store,run,limits:{...limits,modelCalls:10},signal:new AbortController().signal,firstStepScope:scope,deepseekApiKey:'synthetic',transport,tools:{async execute(){return {pages:[{...page,text:original}],requests:1,bytes:original.length,estimatedUsd:0,credits:null,limitations:[]};}},planner};
 const first=await runResearch(options);assert.equal(first.observations.length,1);assert.equal(sends,1);const oldReceipt=store.research.receipts(run.id).find(r=>r.kind==='model')!;
 const cp=store.research.checkpoint(run.id)!;cp.steps=1;cp.phase='verifying';cp.claims=[];cp.pendingClaims=[changed==='claim'?{...claim,statement:'该段自述于2020年编写编译器。'}:claim];cp.claimRepairRounds=2;
 if(changed==='context'){cp.pages[0]!.text='Fictional kingdom. '+quote+' I ride dragons.';db.prepare('UPDATE sources SET excerpt=? WHERE run_id=?').run(cp.pages[0]!.text,run.id);}
 store.research.save(run.id,cp);const second=await runResearch(options);assert.equal(sends,2);assert.equal(second.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.claims.length,0);
 const receipts=store.research.receipts(run.id).filter(r=>r.kind==='model');assert.equal(receipts.length,2);assert.notEqual(receipts[0]!.key,receipts[1]!.key);assert.deepEqual(store.research.receipts(run.id).find(r=>r.key===oldReceipt.key),oldReceipt);db.close();
});

test('a withdrawn pending quote stops before the planner or any new paid reservation',async()=>{
 const {db,store,run}=setup();const cp:ResearchCheckpoint={phase:'verifying',steps:1,startedAt:0,elapsedMs:0,anchorUrl:page.url,identity:{displayName:'Fixture',handle:'genre-fixture',profileUrl:page.url,status:'resolved',note:'Synthetic',candidates:[]},candidates:[],pages:[{...page,sourceKey:'S1',retrieval:'read'}],claims:[],pendingClaims:[claim],unknowns:[],stopReason:null,quoteGenrePolicy:'genre_context/v1'};
 store.addSource(run.id,{key:'S1',url:page.url,title:'Fixture',kind:'profile',publishedAt:null,excerpt:quote,excerptLocator:'synthetic',identityLabel:'synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},0);store.research.save(run.id,cp);store.setSourceExcluded(run.id,'S1',true);let plans=0,sends=0;
 const result=await runResearch({store,run,limits,signal:new AbortController().signal,firstStepScope:scope,deepseekApiKey:'synthetic',transport:{async fetch(){sends++;throw Error('must not transmit');}},tools:{async execute(){throw Error('must not fetch');}},planner:{genreReviewPolicy:'genre_context/v1',async decide(){plans++;throw Error('must not expose quote to planner');}}});
 assert.equal(plans,0);assert.equal(sends,0);assert.equal(store.research.receipts(run.id).length,0);assert.equal(result.stopReason,'source_revoked');assert.equal(result.observations.length,0);assert.equal(store.research.checkpoint(run.id)!.pendingClaims![0]!.quote,quote);db.close();
});

test('withdrawal between planner input and model invocation prevents transmission and reservation',async()=>{
 const {db,store,run}=setup();let sends=0;const result=await runResearch({store,run,limits,signal:new AbortController().signal,firstStepScope:scope,deepseekApiKey:'synthetic',transport:{async fetch(){sends++;throw Error('must not transmit');}},tools:{async execute(){return {pages:[page],requests:1,bytes:10,estimatedUsd:0,credits:null,limitations:[]};}},planner:{genreReviewPolicy:'genre_context/v1',async decide(input,signal,invoke){if(input.mode!=='verify')return {action:'finish',claims:[claim]};store.setSourceExcluded(run.id,'S1',true);await invoke({path:'/v1/messages',body:{model:'deepseek-flash',max_tokens:2500},signal} as Parameters<typeof invoke>[0]);throw Error('must stop before result');}}});
 assert.equal(sends,0);assert.equal(store.research.receipts(run.id).filter(r=>r.kind==='model').length,0);assert.equal(result.stopReason,'source_revoked');assert.equal(result.observations.length,0);db.close();
});
