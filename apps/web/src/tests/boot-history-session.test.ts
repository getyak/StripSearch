import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, installFetch, jsonResponse } from './dom-env.js';
import { deferred } from './fakes.js';
import { waitFor } from './harness.js';
import { SCHEMA_VERSION,type CanonicalView } from '../shared/types.js';

const env=installDom();env.window.location.hash='#/app';const history=deferred<Response>();const requests:string[]=[];
const saved:CanonicalView={schemaVersion:SCHEMA_VERSION,runId:'latest-saved',state:'completed',revision:1,question:'合成最近研究',seedUrl:null,provider:'github',parentRunId:null,retryOf:null,followup:false,createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:00:00Z',interrupted:false,stopReason:null,identity:{displayName:'合成研究对象',handle:null,profileUrl:null,status:'resolved',note:null,candidates:[]},sources:[],observations:[],answer:[{id:'saved',heading:'已保存内容',body:'用于裸入口恢复的合成报告。',bullets:[]}],limitations:[],usage:{provider:'github',requests:0,bytes:0,elapsedMs:0,measurement:'observed'},reviewCount:0};
installFetch(url=>{requests.push(url);if(url.includes('/api/auth/get-session'))return jsonResponse({user:{id:'bare-owner',email:'bare@example.test',name:'Synthetic owner'},session:{id:'bare-session'}});if(url.endsWith('/api/runs'))return history.promise;if(url.includes('/api/runs/latest-saved?'))return jsonResponse({run:saved,events:[],latestSeq:0});return jsonResponse({capabilities:{github:true,exa:false}});});
const main=await import('../client/main.js');

test('a bare app bookmark restores its latest saved report after background history completes',async()=>{
 await waitFor(()=>main.__test.state.user?.id==='bare-owner'&&env.document.querySelector('.app-opening')===null);assert.equal(main.__test.state.run,null);assert.equal(env.document.getElementById('view-app')!.hidden,false);
 history.resolve(jsonResponse({runs:[{runId:saved.runId,question:saved.question,state:saved.state,provider:saved.provider,revision:saved.revision,createdAt:saved.createdAt,updatedAt:saved.updatedAt,sourceCount:0,reviewCount:0}]}));
 await waitFor(()=>main.__test.state.run?.runId==='latest-saved');assert.equal(env.window.location.hash,'#/app/latest-saved');assert.ok(env.document.getElementById('view-app')!.textContent!.includes('用于裸入口恢复的合成报告。'));assert.equal(requests.filter(url=>url.includes('/api/runs/latest-saved?')).length,1);
});
