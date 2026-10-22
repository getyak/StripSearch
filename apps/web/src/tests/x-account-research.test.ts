import assert from 'node:assert/strict';
import test from 'node:test';
import {seedFirstStep} from './first-step-fixtures.js';
import {collectXAccount,runXAccountResearch} from '../server/research/x-account-research.js';
import {renderJson,renderMarkdown} from '../shared/canonical.js';
import {renderReportHtml} from '../shared/report-html.js';
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
   if(input.purpose.includes('verify'))return{verdicts:data.findings.map((finding:{id:string})=>({id:finding.id,supported:true,reason:'这条完整原文明确支持账号的自述。'}))};
   const material=data.materials.find((m:{text:string;role:string})=>m.role==='target'&&m.text.includes('I built a synthetic reading tool.'));
   return{findings:material?[{section:'work',statement:'该账号在这条原帖中自述制作了一个合成阅读工具。',kind:'attributed_statement',evidence:[{sourceKey:material.sourceKey,quote:'I built a synthetic reading tool.'}]}]:[]};
  }});
  assert.equal(output.state,'completed');assert.ok(output.answer.some(s=>s.bullets.some(b=>b.text.includes('阅读工具'))));
  assert.ok(purposes.includes('x-account-analyze')&&purposes.includes('x-account-verify-batch')&&purposes.includes('x-account-synthesize')&&purposes.includes('x-account-verify-synthesis'));
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
