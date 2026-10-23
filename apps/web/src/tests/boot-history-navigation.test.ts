import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, installFetch, jsonResponse } from './dom-env.js';
import { deferred } from './fakes.js';
import { waitFor } from './harness.js';

const env=installDom();env.window.location.hash='#/app';const history=deferred<Response>();const requests:string[]=[];
installFetch(url=>{requests.push(url);if(url.includes('/api/auth/get-session'))return jsonResponse({user:{id:'new-owner',email:'new@example.test',name:'Synthetic owner'},session:{id:'new-session'}});if(url.endsWith('/api/runs'))return history.promise;return jsonResponse({capabilities:{github:true,exa:false}});});
const main=await import('../client/main.js');

test('background boot history cannot replace a new research intent even after returning to the bare app route',async()=>{
 await waitFor(()=>main.__test.state.user?.id==='new-owner'&&env.document.querySelector('.app-opening')===null);env.document.getElementById('new-research')!.click();env.document.getElementById('open-app')!.click();
 await new Promise<void>(resolve=>setTimeout(resolve,30));assert.equal(env.window.location.hash,'#/app');assert.equal(main.__test.state.activeRunId,null);
 history.resolve(jsonResponse({runs:[{runId:'previous-saved',question:'合成历史',state:'completed',provider:'github',revision:1,createdAt:'',updatedAt:'',sourceCount:0,reviewCount:0}]}));
 await waitFor(()=>main.__test.state.runs.length===1);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(main.__test.state.run,null);assert.equal(main.__test.state.activeRunId,null);assert.equal(env.window.location.hash,'#/app');assert.equal(requests.some(url=>url.includes('/api/runs/previous-saved?')),false);
});
