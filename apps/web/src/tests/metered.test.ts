import assert from 'node:assert/strict';
import test from 'node:test';
import {seedFirstStep} from './first-step-fixtures.js';
import {meteredInvoke} from '../server/research/metered.js';

test('failed metered calls preserve optional safe metadata and replay it without dispatch',async t=>{
 const f=seedFirstStep({accounts:[{url:'https://x.com/synthetic'}]});t.after(()=>f.close());
 let calls=0;
 const metadata={version:'dsh-failure/v1',code:'invalid_decision_json',usageKnown:true};
 const options={ledger:f.store.research,runId:f.run.id,key:'synthetic-model-failure',kind:'model' as const,request:{purpose:'synthetic'},reservation:{inputTokens:10,outputTokens:10},limits:{toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0},allowSettledFailure:true,
  execute:async()=>{calls++;throw new Error('synthetic private failure');},usageOf:()=>({estimatedUsd:0}),failureUsage:()=>({inputTokens:10,outputTokens:5,estimatedUsd:0.000009,unknownCost:false}),settleFailure:()=>true,
  failureResult:()=>metadata,replayFailure:(receipt:import('../server/research/research-store.js').ActionReceipt)=>{assert.deepEqual(receipt.result,metadata);return new Error('safe replay refusal');}};
 await assert.rejects(meteredInvoke(options),/synthetic private failure/);
 assert.deepEqual(f.store.research.receipt(f.run.id,options.key)!.result,metadata);
 await assert.rejects(meteredInvoke(options),/safe replay refusal/);assert.equal(calls,1);
});

test('metered callers without failure metadata retain the existing null failure result',async t=>{
 const f=seedFirstStep({accounts:[{url:'https://x.com/synthetic'}]});t.after(()=>f.close());
 await assert.rejects(meteredInvoke({ledger:f.store.research,runId:f.run.id,key:'default-null',kind:'tool',request:{},reservation:{inputTokens:0,outputTokens:0},limits:{toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0},allowSettledFailure:true,execute:async()=>{throw new Error('failed');},usageOf:()=>({}),failureUsage:()=>({estimatedUsd:null,unknownCost:true}),settleFailure:()=>true,replayFailure:()=>new Error('refused')}));
 assert.equal(f.store.research.receipt(f.run.id,'default-null')!.result,null);
});
