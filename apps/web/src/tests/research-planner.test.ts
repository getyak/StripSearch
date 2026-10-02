import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessagesUsage } from '../server/research/planner.js';
test('Messages cumulative usage snapshots are counted once',()=>{
 const body='data: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:380,output_tokens:0}}})+'\n\ndata: '+JSON.stringify({type:'message_delta',usage:{input_tokens:380,output_tokens:52}})+'\ndata: '+JSON.stringify({type:'message_stop'})+'\n';
 assert.deepEqual(parseMessagesUsage(body),{inputTokens:380,outputTokens:52,known:true});
});

test('cost estimates use the selected route and unknown models are not silently priced as Flash',async()=>{
 const {estimateModelUsd}=await import('../server/research/planner.js');
 assert.equal(estimateModelUsd('deepseek-flash',1e6,1e6),1.5);
 assert.equal(estimateModelUsd('deepseek-pro',1e6,1e6),5.28);
 assert.equal(estimateModelUsd('unknown-route',10,10),null);
});


test('truncated Messages streams retain unknown usage instead of settling output to zero',()=>{
 const body='data: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:380,output_tokens:0}}})+'\n';
 assert.equal(parseMessagesUsage(body).known,false);
});


test('planning exposes research questions, retrieval provenance and independent batch reading',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:'https://github.com/fixture',identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null};
 const data=JSON.parse(buildResearchPrompt({question:'fixture',checkpoint,remainingModels:5,remainingTools:6}));
 assert.equal(data.researchQuestions.length,5);assert.match(data.contract,/batch/);assert.match(data.contract,/retrieval=search/);assert.match(data.task,/identity JSON.*untrusted/);
});


test('source/link/unknown catalog windows keep the model context bounded without losing corpus',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');
 const pages=Array.from({length:200},(_,i)=>({sourceKey:`S${i}`,url:`https://synthetic-author.dev/${i}`,title:'Synthetic',text:'x'.repeat(50000),kind:'work' as const,publishedAt:null,links:Array.from({length:1000},(_,j)=>`https://synthetic-author.dev/${i}/${j}`),limitations:[]}));
 const checkpoint={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:null,identity:null,candidates:[],pages,claims:[],unknowns:Array.from({length:300},(_,i)=>`gap ${i}`),stopReason:null,catalog:{offset:30,linkOffset:100,unknownOffset:60}};
 const data=JSON.parse(buildResearchPrompt({question:'fixture',checkpoint,remainingTools:null,remainingModels:null}));assert.equal(data.sources.length,12);assert.equal(data.sourceCatalog.total,200);assert.equal(data.sources[0].sourceKey,'S30');assert.equal(data.sources[0].links.length,20);assert.equal(data.sources[0].links[0],pages[30]!.links[100]);assert.equal(data.unknowns[0],'gap 60');assert.equal(data.unknownsTotal,300);assert.ok(JSON.stringify(data).length<40000);assert.equal(pages[30]!.text.length,50000);
});
test('legacy inspect cache is reconstructed from active pages and never trusted as text',async()=>{
 const {buildResearchPrompt}=await import('../server/research/planner.js');const base={phase:'planning',steps:1,startedAt:0,elapsedMs:0,anchorUrl:null,identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null,inspect:{sourceKey:'S2',offset:0,text:'REVOKED_SYNTHETIC_TEXT'}};
 assert.doesNotMatch(buildResearchPrompt({question:'fixture',checkpoint:base,remainingTools:null,remainingModels:null}),/REVOKED_SYNTHETIC_TEXT/);
});
