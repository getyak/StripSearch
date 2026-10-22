import assert from 'node:assert/strict';
import test from 'node:test';
import {seedFirstStep} from './first-step-fixtures.js';
import {collectXAccount,runXAccountResearch} from '../server/research/x-account-research.js';
import {renderJson,renderMarkdown} from '../shared/canonical.js';
import {renderReportHtml} from '../shared/report-html.js';
import {ProviderError} from '../server/adapters/types.js';
import type {XNativePost,XReadRequest,XReadResult,XAccountProvider} from '../server/research/x-account-contracts.js';

const profile={nativeId:'42',handle:'synthetic_x',name:'Synthetic account',description:'Synthetic public work',url:'https://x.com/synthetic_x'};
const unlimited={toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0};
function post(id:string,extra:Partial<XNativePost>={}):XNativePost{return{id,url:`https://x.com/synthetic_x/status/${id}`,authorId:'42',authorHandle:'synthetic_x',text:`Synthetic original post ${id}.`,publishedAt:'2026-10-01T00:00:00Z',kind:'original',parentId:null,quotedId:null,conversationId:id,replyCount:0,textField:'text',truncated:false,...extra};}
function result(posts:XNativePost[]=[],nextCursor:string|null=null):XReadResult{return{posts,nextCursor,cursorState:nextCursor?'more':'end',recordCount:posts.length,limitations:[],requests:1,bytes:100,estimatedUsd:0,endpoint:'synthetic'};}
function setup(){
 const f=seedFirstStep({input:{kind:'homepage_url',value:profile.url,question:'分析这个账号的公开作品与观点'},accounts:[{url:profile.url}]});
 const response=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;if(response.mode!=='first_step')throw Error('wrong fixture');
 f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,{expectedRunRevision:f.store.getRun(f.run.id)!.revision,expectedScopeVersion:response.view.selection.scopeVersion,discoveryRevision:response.view.discoveryRevision,clusterId:response.view.clusters[0]!.clusterId,accounts:[{accountId:f.accountIdFor(0),selection:'only_this_account',excluded:false}]},'x-research-fixture');
 return{f,binding:f.firstStep.selectionBinding(f.run.id)!};
}
test('single independent account enumerates both feeds, deduplicates overlap and follows observed parent and quote IDs',async()=>{
 const{f,binding}=setup();const calls:XReadRequest[]=[];
 const provider:XAccountProvider={async execute(request){calls.push(request);if(request.type==='profile')return{...result(),account:profile};
  if(request.type==='timeline')return request.cursor===null?result([post('101'),post('102',{kind:'reply',parentId:'901'})],'t2'):result([post('102',{kind:'reply',parentId:'901'}),post('103',{kind:'quote',quotedId:'902',replyCount:1})]);
  if(request.type==='replies')return request.cursor===null?result([post('102',{text:'Short preview',truncated:true}),post('800',{authorId:'99',authorHandle:'other'})],'r2'):request.cursor==='r2'?result([],'r3'):result([post('104',{kind:'reply',parentId:'901',truncated:true})]);
  if(request.type==='comments')return result([post('701',{authorId:'88',authorHandle:'commenter',kind:'reply',parentId:'103'})],'unread-comments');
  if(request.type!=='detail')throw Error('unexpected request');
  return result([post(request.tweetId,request.tweetId==='901'||request.tweetId==='902'?{authorId:'99',authorHandle:'other',text:'Third-party contextual original'}:{text:'Full independently fetched reply original',kind:'reply',parentId:'901'})]);
 }};
 try{const {state,checkpoint}=await collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent()});
  assert.equal(state.history.timeline.pages,2);assert.equal(state.history.replies.pages,3);assert.ok(state.history.timeline.done&&state.history.replies.done);
  assert.equal(state.posts.filter(p=>p.role==='target').length,4);
  assert.ok(!state.posts.some(p=>p.id==='800'),'foreign feed items are not target speech');
  assert.equal(state.posts.find(p=>p.id==='102')!.text,'Full independently fetched reply original');
  assert.equal(state.posts.find(p=>p.id==='901')!.role,'parent_context');assert.equal(state.posts.find(p=>p.id==='902')!.role,'quoted_context');
  assert.ok(state.posts.some(p=>p.id==='701'&&p.role==='reply_context'));
  assert.ok(checkpoint.pages.every(p=>p.retrieval==='read'||p.retrieval==='profile'));
  const count=calls.length;await collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}});
  assert.equal(calls.length,count,'recovery reuses completed pages and context');
 }finally{f.close();}
});

test('a repeated cursor stops as a recorded gap rather than pretending history is exhausted',async()=>{
 const{f,binding}=setup();let calls=0;
 const provider:XAccountProvider={async execute(request){calls++;if(request.type==='profile')return{...result(),account:profile};if(request.type==='timeline')return result([post(request.cursor?'102':'101')],'same-cursor');return result();}};
 try{const options={store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}};const {state}=await collectXAccount(options);assert.equal(state.history.timeline.done,false);assert.ok(state.gaps.some(g=>g.code==='cursor_cycle'));assert.ok(calls<10);const count=calls,pages=state.history.timeline.pages;const resumed=await collectXAccount(options);assert.equal(calls,count);assert.equal(resumed.state.history.timeline.pages,pages,'a stopped cursor cannot inflate page counts on recovery');}finally{f.close();}
});

test('source withdrawn during pagination stops before late material or further paid reads',async()=>{
 const{f,binding}=setup();const calls:XReadRequest[]=[];
 const provider:XAccountProvider={async execute(request){calls.push(request);if(request.type==='profile')return{...result(),account:profile};if(request.type==='timeline'&&!request.cursor)return result([post('101')],'next');if(request.type==='timeline'){const source=f.store.listSources(f.run.id).find(s=>s.url.endsWith('/101'))!;f.store.setSourceExcluded(f.run.id,source.sourceKey,true);return result([post('102')]);}return result();}};
 try{await assert.rejects(collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}}),/source_revoked/);assert.ok(!f.store.listSources(f.run.id).some(s=>s.url.endsWith('/102')));assert.ok(!calls.some(c=>c.type==='replies'));}finally{f.close();}
});

test('scope withdrawn during a paid response prevents late material ingestion',async()=>{
 const{f,binding}=setup();let current=true;
 const provider:XAccountProvider={async execute(){current=false;return{...result(),account:profile};}};
 try{await assert.rejects(collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{if(!current)throw new Error('scope withdrawn');}}),/scope withdrawn/);assert.equal(f.store.listSources(f.run.id).length,0);}finally{f.close();}
});

test('an independent X account publishes a verified Chinese account report and source withdrawal invalidates its findings in every format',async()=>{
 const{f,binding}=setup();const purposes:string[]=[];
 const provider:XAccountProvider={async execute(request){if(request.type==='profile')return{...result(),account:profile};if(request.type==='timeline')return result([post('101',{text:'I built a synthetic reading tool.'})]);return result();}};
 try{
  const output=await runXAccountResearch({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>f.firstStep.scopeGuard(f.run.ownerId,f.run.id).assertCurrent(),model:async input=>{
   purposes.push(input.purpose);const data=JSON.parse(input.prompt.split('\nDATA\n')[1]!);
   if(data.organizationStage)return {groups:[{section:'work',title:'Synthetic work',ids:data.items.map((item:{id:string})=>item.id)}]};
  if(input.purpose.includes('verify'))return{verdicts:data.findings.map((finding:{id:string})=>({id:finding.id,supported:true,reason:'这条完整原文明确支持账号的自述。'}))};
   const material=data.materials.find((m:{text:string;role:string})=>m.role==='target'&&m.text.includes('I built a synthetic reading tool.'));
   return{findings:material?[{section:'work',statement:'该账号在这条原帖中自述制作了一个合成阅读工具。',kind:'attributed_statement',evidence:[{sourceKey:material.sourceKey,quote:'I built a synthetic reading tool.'}]}]:[]};
  }});
  assert.equal(output.state,'completed');assert.ok(output.answer.some(s=>s.bullets.some(b=>b.text.includes('阅读工具'))));
  assert.ok(purposes.includes('x-account-analyze')&&!purposes.includes('x-account-verify-batch')&&purposes.includes('x-account-synthesize')&&purposes.includes('x-account-verify-synthesis'));
  f.store.updateRun(f.run.id,{state:output.state,identity_json:JSON.stringify(output.identity),answer_json:JSON.stringify(output.answer),limitations_json:JSON.stringify(output.limitations),stop_reason:output.stopReason});
  output.observations.forEach((o,index)=>f.store.addObservation(f.run.id,o,index));
  const view=()=>f.store.buildCanonicalView(f.store.getRun(f.run.id)!);const current=view();
  assert.equal(current.personObject,undefined);assert.equal(current.accountObject!.account.nativeId,'42');assert.equal(current.research!.accountResearch!.targetPosts,1);
  for(const text of [renderJson(current),renderMarkdown(current),renderReportHtml(current)])assert.match(text,/阅读工具/);
  const key=current.accountObject!.claims[0]!.sourceKeys[0]!;f.store.setSourceExcluded(f.run.id,key,true);
  const withdrawn=view();assert.equal(withdrawn.state,'partial');assert.equal(withdrawn.accountObject!.claims.length,0);
  for(const text of [renderMarkdown(withdrawn),renderReportHtml(withdrawn)])assert.doesNotMatch(text,/该账号在这条原帖中自述制作了一个合成阅读工具/);
 }finally{f.close();}
});

test('distinct context reads overlap, repeated parent reads stay single, and withdrawn late responses are discarded',async()=>{
 const{f,binding}=setup();const calls:string[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let withdrawn=false;
 const provider:XAccountProvider={async execute(request){
  if(request.type==='profile')return{...result(),account:profile};
  if(request.type==='timeline')return result([post('101',{kind:'reply',parentId:'901'}),post('102',{kind:'reply',parentId:'901'}),post('103',{kind:'quote',quotedId:'902'})]);
  if(request.type==='replies')return result();
  if(request.type!=='detail')throw Error('unexpected comment');
  calls.push(request.tweetId);
  if(request.tweetId==='901'){await held;return result([post('901',{authorId:'99',authorHandle:'other'})]);}
  const key=f.store.listSources(f.run.id).find(s=>s.url.endsWith('/101'))!.sourceKey;f.store.setSourceExcluded(f.run.id,key,true);withdrawn=true;release();return result([post('902',{authorId:'99',authorHandle:'other'})]);
 }};
 try{
  const operation=collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}});
  const outcome=await Promise.race([operation.then(()=>null,error=>error),new Promise<Error>(resolve=>setTimeout(()=>{release();resolve(Error('context calls remained serial'));},1000))]);
  assert.ok(withdrawn,'a distinct contextual request must start while its peer is awaiting a response');assert.match(String(outcome),/source_revoked/);assert.equal(calls.filter(id=>id==='901').length,1,'shared parent cannot dispatch concurrently twice');
  assert.ok(!f.store.listSources(f.run.id).some(s=>s.url.endsWith('/901')||s.url.endsWith('/902')),'neither late response can ingest after source withdrawal');await operation.catch(()=>{});
 }finally{release();f.close();}
});

test('three raw empty pages with fresh cursors stop paid pagination as unknown coverage, then continue replies',async()=>{
 const{f,binding}=setup();const calls:XReadRequest[]=[];let cursor=0;
 const provider:XAccountProvider={async execute(request){calls.push(request);if(request.type==='profile')return{...result(),account:profile};if(request.type==='timeline')return request.cursor===null?result([post('101')],'c1'):result([],`c${++cursor+1}`);return result([post('102')]);}};
 try{
  const {state}=await collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:{...unlimited,toolCalls:8},assertScope:()=>{}});
  assert.equal(state.history.timeline.pages,4);assert.equal(state.history.timeline.done,false);assert.equal(state.history.timeline.blocked,'empty_history_pages');assert.ok(state.gaps.some(g=>g.code==='empty_history_pages'));
  assert.equal(calls.filter(r=>r.type==='timeline').length,4);assert.equal(state.history.replies.done,true);assert.ok(state.posts.some(p=>p.id==='102'));
 }finally{f.close();}
});
test('three foreign-only replies pages are filtered-empty, not raw-empty, and still reach the next target post',async()=>{
 const{f,binding}=setup();let replies=0;
 const provider:XAccountProvider={async execute(request){if(request.type==='profile')return{...result(),account:profile};if(request.type==='timeline')return result([post('101')]);if(request.type==='replies'){replies++;return replies<=3?result([post(String(800+replies),{authorId:'99',authorHandle:'other'})],`r${replies}`):result([post('102')]);}throw Error('unexpected context');}};
 try{const {state}=await collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}});assert.equal(state.history.replies.pages,4);assert.equal(state.history.replies.done,true);assert.ok(state.posts.some(p=>p.id==='102'));assert.ok(!state.gaps.some(g=>g.code==='empty_history_pages'));}finally{f.close();}
});

test('queued cancellation gets an event-loop turn before synchronous cached-style reads can dispatch',async()=>{
 const{f,binding}=setup();const controller=new AbortController();let calls=0;
 const provider:XAccountProvider={async execute(request){calls++;return request.type==='profile'?{...result(),account:profile}:result();}};
 const cancel=setImmediate(()=>controller.abort(new Error('queued cancellation')));
 try{await assert.rejects(collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:controller.signal,limits:unlimited,assertScope:()=>{}}),/queued cancellation/);assert.equal(calls,0,'queued cancel must precede even the first provider dispatch');}finally{clearImmediate(cancel);f.close();}
});

test('newly read parent context remains covered by fresh revocation checks after expectations were cached',async()=>{
 const{f,binding}=setup();
 const provider:XAccountProvider={async execute(request){
  if(request.type==='profile')return{...result(),account:profile};
  if(request.type==='timeline')return result([post('101',{kind:'reply',parentId:'900'})]);
  if(request.type==='replies')return result();
  if(request.type==='detail'&&request.tweetId==='900')return result([post('900',{authorId:'99',authorHandle:'other',kind:'reply',parentId:'901'})]);
  if(request.type==='detail'&&request.tweetId==='901'){
   const parent=f.store.listSources(f.run.id).find(s=>s.url.endsWith('/900'))!;
   f.store.setSourceExcluded(f.run.id,parent.sourceKey,true);
   return result([post('901',{authorId:'99',authorHandle:'other'})]);
  }
  throw Error('unexpected request');
 }};
 try{await assert.rejects(collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}}),/source_revoked/);assert.ok(!f.store.listSources(f.run.id).some(s=>s.url.endsWith('/901')));}finally{f.close();}
});

test('one shared detail fold checkpoints every queued root and keeps parent traversal separate from quoted context',async()=>{
 const{f,binding}=setup();const detailCalls:string[]=[];
 const provider:XAccountProvider={async execute(request){
  if(request.type==='profile')return{...result(),account:profile};
  if(request.type==='timeline')return result([post('101',{kind:'reply',parentId:'900'}),post('102',{kind:'reply',parentId:'900'}),post('103',{kind:'quote',quotedId:'900'})]);
  if(request.type==='replies')return result();
  if(request.type==='detail'){detailCalls.push(request.tweetId);return result([post(request.tweetId,{authorId:'99',authorHandle:'other',kind:'reply',parentId:request.tweetId==='900'?'901':null})]);}
  throw Error('unexpected comments');
 }};
 const originalSave=f.store.research.save.bind(f.store.research);let stopped=false;
 f.store.research.save=(runId,cp)=>{originalSave(runId,cp);if(!stopped&&cp.xAccountResearch?.contextDone.some(key=>key.startsWith('detail:900:'))){stopped=true;f.store.updateRun(runId,{state:'partial',stop_reason:'synthetic_maintenance_stop'});}};
 try{
  await assert.rejects(collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}}),/run_inactive/);
  const state=f.store.research.checkpoint(f.run.id)!.xAccountResearch!;
  assert.deepEqual(state.posts.find(p=>p.id==='900')!.rootIds.slice().sort(),['101','102','103'],'first saved context fold must retain all three queued relationships');
  assert.deepEqual(state.contextDone.filter(k=>k.startsWith('detail:900:')).sort(),['detail:900:101:parent_context','detail:900:102:parent_context','detail:900:103:quoted_context']);
  assert.ok(!state.contextQueue.some(t=>t.tweetId==='900'));
  assert.deepEqual(state.contextQueue.filter(t=>t.tweetId==='901').map(t=>({rootId:t.rootId,relation:t.relation})),[{rootId:'101',relation:'parent_context'},{rootId:'102',relation:'parent_context'}]);
  assert.deepEqual(detailCalls,['900'],'the saved group can stop before dispatching its next parent');
 }finally{f.close();}
});

test('350 roots sharing one detail use bounded checkpoint groups and one paid native read',async()=>{
 const{f,binding}=setup();const rootIds=Array.from({length:350},(_,i)=>String(1001+i));let paidDetails=0;
 const provider:XAccountProvider={async execute(request){
  if(request.type==='profile')return{...result(),account:profile};
  if(request.type==='timeline')return result(rootIds.map(id=>post(id,{kind:'reply',parentId:'900'})));
  if(request.type==='replies')return result();
  if(request.type==='detail'){assert.equal(request.tweetId,'900');paidDetails++;return result([post('900',{authorId:'99',authorHandle:'other'})]);}
  throw Error('unexpected comments');
 }};
 const checkpoints:number[]=[];const originalSave=f.store.research.save.bind(f.store.research);
 f.store.research.save=(runId,cp)=>{originalSave(runId,cp);const done=cp.xAccountResearch?.contextDone.filter(k=>k.startsWith('detail:900:')).length??0;if(done>(checkpoints.at(-1)??0)){checkpoints.push(done);assert.equal(cp.xAccountResearch!.posts.find(p=>p.id==='900')!.rootIds.length,done);}};
 try{
  const {state}=await collectXAccount({store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{}});
  assert.deepEqual(checkpoints,[100,200,300,350],'each synchronous fold handles at most 100 queued relationships');
  assert.equal(paidDetails,1,'later groups replay the same settled native read');
  assert.deepEqual(state.posts.find(p=>p.id==='900')!.rootIds.slice().sort(),rootIds.slice().sort());
  assert.equal(state.contextQueue.length,0);assert.equal(state.contextDone.length,350);
 }finally{f.close();}
});

test('context billing refusal preserves pending work, drains an issued parent and completes verified analysis of retained originals',async()=>{
 const{f,binding}=setup();const calls:XReadRequest[]=[];const purposes:string[]=[];let parentStarted!:()=>void;let releaseParent!:()=>void;let parentReturned=false;
 const parentReady=new Promise<void>(resolve=>{parentStarted=resolve;});const parentRelease=new Promise<void>(resolve=>{releaseParent=resolve;});
 const original='I built a synthetic reading tool.';const statement='该账号在原帖中自述制作了一个合成阅读工具。';
 const provider:XAccountProvider={async execute(request){
  calls.push(request);
  if(request.type==='profile')return{...result(),account:profile};
  if(request.type==='timeline')return result([post('101',{text:original,replyCount:1}),post('102',{kind:'reply',parentId:'900'})]);
  if(request.type==='replies')return result();
  if(request.type==='comments'){await parentReady;setImmediate(releaseParent);throw new ProviderError('provider_billing','供应商计费拒绝',402);}
  if(request.type==='detail'&&request.tweetId==='900'){parentStarted();await parentRelease;parentReturned=true;return result([post('900',{authorId:'99',authorHandle:'other',kind:'reply',parentId:'901'})]);}
  if(request.type==='detail')return result([post(request.tweetId,{authorId:'99',authorHandle:'other'})]);
  throw Error('unexpected request');
 }};
 const options={store:f.store,run:f.store.getRun(f.run.id)!,binding,provider,signal:new AbortController().signal,limits:unlimited,assertScope:()=>{},model:async(input:{purpose:string;prompt:string})=>{
  assert.ok(parentReturned,'analysis starts only after the already-issued parent read has drained');purposes.push(input.purpose);const data=JSON.parse(input.prompt.split('\nDATA\n')[1]!);
  if(data.organizationStage)return {groups:[{section:'work',title:'Synthetic work',ids:data.items.map((item:{id:string})=>item.id)}]};
  if(input.purpose.includes('verify'))return{verdicts:data.findings.map((finding:{id:string})=>({id:finding.id,supported:true,reason:'所引原文支持账号自述。'}))};
  const material=data.materials.find((m:{text:string})=>m.text===original);
  return{findings:material?[{section:'work',statement,kind:'attributed_statement',evidence:[{sourceKey:material.sourceKey,quote:original}]}]:[]};
 }};
 try{
  const output=await runXAccountResearch(options);const cp=f.store.research.checkpoint(f.run.id)!;const state=cp.xAccountResearch!;
  assert.equal(output.state,'partial');assert.ok(state.analysis.synthesisDone);assert.ok(output.observations.some(o=>o.statement===statement));
  assert.deepEqual(calls.filter(r=>r.type==='detail').map(r=>r.tweetId),['900'],'no later context batch is dispatched after billing refusal');
  assert.ok(state.gaps.some(g=>g.code==='provider_billing'&&g.target==='context'),'the actual global billing refusal remains explicit');
  assert.match(output.limitations.join(' '),/计费|额度/);
  assert.ok(state.contextQueue.some(t=>t.type==='comments'&&t.tweetId==='101'),'the billing-refused task is still unread');
  assert.ok(state.contextQueue.some(t=>t.type==='detail'&&t.tweetId==='901'&&t.rootId==='102'),'the newly discovered deeper parent remains queued');
  assert.ok(!state.contextDone.includes('comments:101:101:reply_context'));
  assert.ok(state.contextDone.includes('detail:900:102:parent_context'));assert.ok(state.posts.some(p=>p.id==='900'));
  for(const purpose of ['x-account-analyze','x-account-synthesize','x-account-verify-synthesis'])assert.ok(purposes.includes(purpose));
  assert.ok(f.store.research.receipts(f.run.id).every(r=>r.state!=='inflight'));
  const count=calls.length;await runXAccountResearch(options);assert.equal(calls.length,count,'a saved billing boundary remains blocked during recovery');
 }finally{releaseParent();f.close();}
});
