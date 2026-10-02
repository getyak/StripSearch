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
