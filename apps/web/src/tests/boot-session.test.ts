import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, installFetch, jsonResponse } from './dom-env.js';
import { deferred } from './fakes.js';
import { waitFor } from './harness.js';
import { SCHEMA_VERSION,type CanonicalView } from '../shared/types.js';

const env=installDom();
env.window.location.hash='#/app/boot-saved-run';
const session=deferred<Response>();
const history=deferred<Response>();const requests:string[]=[];
const saved:CanonicalView={schemaVersion:SCHEMA_VERSION,runId:'boot-saved-run',state:'completed',revision:1,question:'合成已保存研究',seedUrl:null,provider:'github',parentRunId:null,retryOf:null,followup:false,createdAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:00:00Z',interrupted:false,stopReason:null,identity:{displayName:'合成研究对象',handle:null,profileUrl:null,status:'resolved',note:null,candidates:[]},sources:[],observations:[],answer:[{id:'saved',heading:'已保存内容',body:'这是一份用于入口回归的合成报告。',bullets:[]}],limitations:[],usage:{provider:'github',requests:0,bytes:0,elapsedMs:0,measurement:'observed'},reviewCount:0};
installFetch(url=>{requests.push(url);if(url.includes('/api/auth/get-session'))return session.promise;if(url.endsWith('/api/runs'))return history.promise;if(url.includes('/api/runs/boot-saved-run?'))return jsonResponse({run:saved,events:[],latestSeq:0});return jsonResponse({capabilities:{github:true,exa:false}});});
const main=await import('../client/main.js');

test('a protected saved report opens after session recovery while its history request is still pending',async()=>{
 assert.equal(env.document.getElementById('view-home')!.hidden,true);
 assert.match(env.document.querySelector('[aria-label="恢复研究"]')!.textContent??'',/正在打开已保存研究/);
 assert.equal(env.document.querySelector('dialog[open]'),null);
 assert.equal(main.__test.state.user,null);
 session.resolve(jsonResponse({user:{id:'boot-owner',email:'boot-owner@example.test',name:'Synthetic owner'},session:{id:'boot-session'}}));
 await waitFor(()=>main.__test.state.user?.id==='boot-owner'&&main.__test.state.run?.runId==='boot-saved-run'&&env.document.querySelector('.app-opening')===null);
 assert.equal(env.document.getElementById('view-app')!.hidden,false);
 assert.equal(env.document.getElementById('view-home')!.hidden,true);
 assert.equal(env.window.location.hash,'#/app/boot-saved-run');
 assert.equal(env.document.querySelector('dialog[open]'),null);
 assert.ok(env.document.getElementById('view-app')!.textContent!.includes('这是一份用于入口回归的合成报告。'));
 assert.ok(requests.findIndex(url=>url.includes('/api/runs/boot-saved-run?'))<requests.findIndex(url=>url.endsWith('/api/runs')),'the requested report starts before background history');
 assert.deepEqual(main.__test.state.runs,[]);
});

test('late boot history cannot restore the previous owner after logout',async()=>{
 await main.__test.signOut();history.resolve(jsonResponse({runs:[{runId:'private-previous-history',question:'合成私有历史',state:'completed',provider:'github',revision:1,createdAt:'',updatedAt:'',sourceCount:0,reviewCount:0}]}));
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(main.__test.state.user,null);assert.deepEqual(main.__test.state.runs,[]);assert.equal(env.document.body.textContent!.includes('合成私有历史'),false);
});
