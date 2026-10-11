import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, installFetch, jsonResponse } from './dom-env.js';
import { deferred } from './fakes.js';
import { waitFor } from './harness.js';

const env=installDom();
env.window.location.hash='#/app';
const session=deferred<Response>();
installFetch(url=>url.includes('/api/auth/get-session')?session.promise:jsonResponse(url.includes('/api/runs')?{runs:[]}:{capabilities:{github:true,exa:false}}));
const main=await import('../client/main.js');

test('a protected bookmark waits for the actual session without flashing the landing page or prompting login early',async()=>{
 assert.equal(env.document.getElementById('view-home')!.hidden,true);
 assert.match(env.document.querySelector('[aria-label="恢复研究"]')!.textContent??'',/正在打开已保存研究/);
 assert.equal(env.document.querySelector('dialog[open]'),null);
 assert.equal(main.__test.state.user,null);
 session.resolve(jsonResponse({user:{id:'boot-owner',email:'boot-owner@example.test',name:'Synthetic owner'},session:{id:'boot-session'}}));
 await waitFor(()=>main.__test.state.user?.id==='boot-owner'&&env.document.querySelector('.app-opening')===null);
 assert.equal(env.document.getElementById('view-app')!.hidden,false);
 assert.equal(env.document.getElementById('view-home')!.hidden,true);
 assert.equal(env.window.location.hash,'#/app');
 assert.equal(env.document.querySelector('dialog[open]'),null);
});
