import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, TestClient, waitFor } from './harness.js';
import type { CanonicalView } from '../shared/types.js';
import type { ResearchPage, ResearchTools } from '../server/research/tool-contracts.js';
import type { ResearchPlanner } from '../server/research/planner.js';
const profile=(handle:string):ResearchPage=>({url:`https://github.com/${handle}`,title:handle,text:`${handle} builds synthetic compilers.`,kind:'profile',publishedAt:null,links:[],limitations:[],account:{platform:'github',handle,id:handle,profileUrl:`https://github.com/${handle}`}});
const planner:ResearchPlanner={async decide(input){if(input.mode==='verify')return {supported:[0],rejected:[]};return {action:'finish',claims:[{sourceKey:'S1',quote:input.checkpoint.pages[0]!.text}],unknowns:[]};}};
function tools():ResearchTools{return {async execute(action){return {pages:action.type==='search'?[profile('ada-a'),profile('ada-b')]:[profile(new URL(action.url).pathname.slice(1))],requests:1,bytes:80,estimatedUsd:.001,credits:null,limitations:[]};}};}

test('new input defaults to research and does not silently replace unavailable providers',async t=>{
 const server=await startTestServer();t.after(()=>server.close());await server.client.signUp('research-unavailable@example.test');
 const response=await server.client.json<{error:{code:string}}>('/api/runs',{json:{input:'Research Ada Fixture'}});
 assert.equal(response.status,409);assert.equal(response.body.error.code,'provider_unavailable');
});

test('stored identity candidates survive refresh; ownership and stale revision are enforced',async t=>{
 const server=await startTestServer({researchTools:tools(),researchPlanner:planner},{DEEPSEEK_API_KEY:'offline-fixture',EXA_API_KEY:'offline-fixture'});t.after(()=>server.close());
 await server.client.signUp('research-owner@example.test');
 const made=await server.client.json<{run:CanonicalView}>('/api/runs',{json:{input:'Research Ada Fixture'}});assert.equal(made.status,201);const id=made.body.run.runId;
 await waitFor(()=>server.store.getRun(id)?.state==='needs_input');
 const refreshed=await server.client.json<{run:CanonicalView}>(`/api/runs/${id}`);const run=refreshed.body.run;const chosen=run.identity.candidates[0]!;
 assert.equal(run.provider,'research');assert.ok(chosen.candidateId);assert.equal(run.identity.candidates.length,2);
 const sse=await server.client.request(`/api/runs/${id}/events`);const stream=await sse.text();assert.match(stream,/event: snapshot/);assert.ok(stream.includes(chosen.candidateId!));assert.match(stream,/"state":"needs_input"/);
 const foreign=new TestClient(server.baseUrl,server.origin);await foreign.signUp('research-foreign@example.test');
 assert.equal((await foreign.json(`/api/runs/${id}/resume`,{json:{candidateId:chosen.candidateId,expectedRevision:run.revision}})).status,404);
 assert.equal((await server.client.json(`/api/runs/${id}/resume`,{json:{candidateId:chosen.candidateId,expectedRevision:run.revision-1}})).status,409);
 assert.equal((await server.client.json(`/api/runs/${id}/resume`,{json:{candidateId:'invented',expectedRevision:run.revision}})).status,400);
 assert.equal((await server.client.json(`/api/runs/${id}/resume`,{json:{candidateId:chosen.candidateId,expectedRevision:run.revision}})).status,200);
 await waitFor(()=>server.store.getRun(id)?.state==='partial');
 const done=(await server.client.json<{run:CanonicalView}>(`/api/runs/${id}`)).body.run;
 assert.equal(done.identity.profileUrl,chosen.profileUrl);assert.ok(done.personObject?.person.id);assert.equal(done.research?.budget.toolCalls,2);
 const excluded=(await server.client.json<{run:CanonicalView}>(`/api/runs/${id}/sources/S1/exclude`,{json:{expectedRevision:done.revision}})).body.run;
 assert.equal(excluded.personObject,undefined);assert.equal(excluded.identity.status,'ambiguous');assert.equal(excluded.observations[0]?.validity,'review');
});

test('profile URL input is fetched directly without name search',async t=>{
 let calls=0;const selected=tools();
 const server=await startTestServer({researchTools:{async execute(action,signal){calls++;assert.notEqual(action.type,'search');return selected.execute(action,signal);}},researchPlanner:planner},{DEEPSEEK_API_KEY:'offline-fixture',EXA_API_KEY:'offline-fixture'});t.after(()=>server.close());
 await server.client.signUp('research-url@example.test');
 const made=await server.client.json<{run:CanonicalView}>('/api/runs',{json:{input:'https://github.com/ada-a'}});assert.equal(made.status,201);
 await waitFor(()=>server.store.getRun(made.body.run.runId)?.state==='partial');assert.equal(calls,1);
});
