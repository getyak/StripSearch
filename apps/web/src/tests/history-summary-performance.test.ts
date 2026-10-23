import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {applyCoreSchema,openDatabase} from '../server/db/index.js';
import {Store,type RunRecord} from '../server/store.js';
import type {ResearchCheckpoint,StoredPage} from '../server/research/research-store.js';
import type {XAccountResearchState} from '../server/research/x-account-contracts.js';
import {seedFirstStep} from './first-step-fixtures.js';

const OWNER='summary-owner';
const IDENTITY={displayName:'Synthetic author',handle:null,profileUrl:'https://lantern.dev/',status:'resolved' as const,note:null,candidates:[]};
const TEXT='I built a synthetic reading tool.';

function fixture(){
  const db=openDatabase(':memory:');applyCoreSchema(db);const store=new Store(db);
  const run=store.insertRun({ownerId:OWNER,question:'Synthetic summary',seedUrl:IDENTITY.profileUrl,provider:'research',parentRunId:null,retryOf:null,followup:false,idempotencyKey:null,bodyFingerprint:'summary-fixture'});
  return {db,store,run,close:()=>db.close()};
}
function page(key:string,url:string,text=TEXT):StoredPage{return {sourceKey:key,url,title:'Synthetic retained material',text,kind:'work',publishedAt:null,retrieval:'read',links:[],limitations:[]};}
function save(f:{store:Store;run:RunRecord},pages:StoredPage[],extra:Partial<ResearchCheckpoint>={}){
  const cp:ResearchCheckpoint={phase:'done',steps:1,startedAt:1,elapsedMs:0,anchorUrl:pages[0]?.url??null,identity:IDENTITY,candidates:[],pages,claims:[],unknowns:[],stopReason:null,...extra};
  f.store.updateRun(f.run.id,{state:'researching'});f.store.research.save(f.run.id,cp);
  pages.forEach((p,i)=>f.store.addSource(f.run.id,{key:p.sourceKey,url:p.url,title:p.title,kind:p.kind,publishedAt:p.publishedAt,excerpt:p.text,excerptLocator:'Synthetic original',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},i));
  f.store.updateRun(f.run.id,{state:'completed',identity_json:JSON.stringify(IDENTITY),answer_json:JSON.stringify([{id:'work',heading:'Synthetic work',body:'',bullets:[{text:'合成作者描述了阅读工具。',kind:'page_statement',sourceKeys:[pages.at(-1)!.sourceKey]}]}])});
  return cp;
}
function expected(store:Store,run:RunRecord){const v=store.buildCanonicalView(run);return {state:v.state,sourceCount:v.sources.length,reviewCount:v.reviewCount};}
function check(store:Store,id:string){const run=store.getRun(id)!;const full=expected(store,run),summary=store.summarize(run);assert.deepEqual({state:summary.state,sourceCount:summary.sourceCount,reviewCount:summary.reviewCount},full);return summary;}

test('history summary reads only referenced X originals while retaining the full source count',t=>{
  const f=fixture();t.after(f.close);
  const profile=page('S1','https://x.com/summary_fixture','Synthetic account profile');
  const posts=Array.from({length:300},(_,i)=>page(`S${i+2}`,`https://x.com/summary_fixture/status/${i+1}`));
  const x:XAccountResearchState={version:'x-account/v1',accountId:'synthetic-account',profile:{nativeId:'42',handle:'summary_fixture',name:'Synthetic author',description:'Synthetic account',url:profile.url},
    history:{timeline:{started:true,cursor:null,done:true,pages:1,cursors:[],pageHashes:[]},replies:{started:true,cursor:null,done:true,pages:0,cursors:[],pageHashes:[]}},
    posts:posts.map((p,i)=>({id:String(i+1),url:p.url,authorId:'42',authorHandle:'summary_fixture',text:p.text,publishedAt:null,kind:'original',parentId:null,quotedId:null,conversationId:String(i+1),replyCount:0,textField:'text',truncated:false,sourceKey:p.sourceKey,role:'target',rootIds:[String(i+1)]})),
    contextQueue:[],contextDone:[],gaps:[],analysis:{completedBatches:['report-plan:v1:ready:workhash:plan','report:v4:complete:workhash:plan'],synthesisDone:true,findings:[{id:'report:v4:plan:work',section:'work',statement:'该账号自述制作了一款合成阅读工具。',kind:'attributed_statement',verified:true,evidence:[{sourceKey:'S2',quote:TEXT,quoteOffset:0,sourceContentHash:createHash('sha256').update(TEXT).digest('hex')}]}]}};
  save(f,[profile,...posts],{anchorUrl:profile.url,xAccountResearch:x});
  const full=expected(f.store,f.store.getRun(f.run.id)!);
  assert.deepEqual(full,{state:'completed',sourceCount:301,reviewCount:0});
  const prepare=f.db.prepare.bind(f.db);let sourceReads=0;
  f.db.prepare=((sql:string)=>{
    if(/\bFROM sources\b/i.test(sql)&&!/^\s*SELECT COUNT\(/i.test(sql)&&!/^SELECT source_key FROM sources WHERE run_id = \? AND url = \?$/i.test(sql)){
      assert.match(sql,/source_key\s*(?:=|IN\b)/i,'history must not load unrelated retained source bodies');sourceReads++;
    }
    return prepare(sql);
  }) as typeof f.db.prepare;
  const summary=f.store.summarize(f.store.getRun(f.run.id)!);
  assert.deepEqual({state:summary.state,sourceCount:summary.sourceCount,reviewCount:summary.reviewCount},full);
  assert.ok(sourceReads<=12,'referenced evidence closure has a bounded number of source reads');
  f.db.prepare=prepare;
  f.store.setSourceExcluded(f.run.id,'S2',true);
  assert.equal(check(f.store,f.run.id).state,'partial','withdrawn published X evidence changes the summary immediately');
  f.store.setSourceExcluded(f.run.id,'S2',false);
  assert.equal(check(f.store,f.run.id).state,'completed');
});

test('generic summaries do not load unrelated retained bodies',t=>{
  const f=fixture();t.after(f.close);
  const pages=[page('S1',IDENTITY.profileUrl),...Array.from({length:200},(_,i)=>({...page(`S${i+2}`,`https://lantern.dev/blog/synthetic-${i}`),discoveredFrom:['S1']}))];
  save(f,pages);
  const full=expected(f.store,f.store.getRun(f.run.id)!);
  const prepare=f.db.prepare.bind(f.db);
  f.db.prepare=((sql:string)=>{
    if(/\bFROM sources\b/i.test(sql)&&!/^\s*SELECT COUNT\(/i.test(sql)&&!/^SELECT source_key FROM sources WHERE run_id = \? AND url = \?$/i.test(sql)) assert.match(sql,/source_key\s*(?:=|IN\b)/i,'summary must not select every original');
    return prepare(sql);
  }) as typeof f.db.prepare;
  const actual=f.store.summarize(f.store.getRun(f.run.id)!);
  assert.deepEqual({state:actual.state,sourceCount:actual.sourceCount,reviewCount:actual.reviewCount},full);
});

test('history summaries match live canonical withdrawal, restoration and unsafe quote decisions',t=>{
  const f=fixture();t.after(f.close);
  const a=page('S1',IDENTITY.profileUrl),b={...page('S9','https://lantern.dev/blog/tool'),discoveredFrom:['S1']};
  const cp=save(f,[a,b]);
  f.store.addObservation(f.run.id,{statement:'合成作者描述了阅读工具。',kind:'page_statement',sourceKeys:['S9'],limitations:[]},0);
  assert.equal(check(f.store,f.run.id).reviewCount,0);
  f.store.setSourceExcluded(f.run.id,'S9',true);
  assert.equal(check(f.store,f.run.id).reviewCount,2);
  f.store.setSourceExcluded(f.run.id,'S9',false);
  assert.equal(check(f.store,f.run.id).reviewCount,0);
  cp.quoteSupportPolicy='exact_quote/v1';cp.claims=[{statement:'该作者的所有作品都始终主张这一核心观点。',kind:'page_statement',sourceKey:'S9',quote:TEXT,section:'work',verified:true}];
  f.store.updateRun(f.run.id,{state:'researching'});f.store.research.save(f.run.id,cp);f.store.updateRun(f.run.id,{state:'completed'});
  assert.equal(check(f.store,f.run.id).state,'partial','unsafe retained claims cannot keep a completed summary');
});

test('retained anchor versions and anchors absent from the checkpoint remain visible to summaries',t=>{
  const f=fixture();t.after(f.close);
  const anchor=page('S1',IDENTITY.profileUrl),article=page('S2','https://lantern.dev/blog/reading');
  const cp=save(f,[anchor,article]);
  f.store.addSource(f.run.id,{key:'S9',url:anchor.url,title:'Older retained anchor',kind:'profile',publishedAt:null,excerpt:'Older synthetic profile.',excerptLocator:'Synthetic original',identityLabel:'Synthetic',identityConfirmed:false,fetchStatus:'ok',limits:[]},9);
  assert.equal(check(f.store,f.run.id).reviewCount,0);
  f.store.setSourceExcluded(f.run.id,'S9',true);
  assert.equal(check(f.store,f.run.id).reviewCount,1,'an excluded retained anchor also affects the complete report');
  cp.pages=[article];
  f.store.updateRun(f.run.id,{state:'researching'});f.store.research.save(f.run.id,cp);f.store.updateRun(f.run.id,{state:'completed'});
  assert.equal(check(f.store,f.run.id).reviewCount,1,'anchor provenance remains relevant when it is no longer in the checkpoint');
  f.store.setSourceExcluded(f.run.id,'S9',false);
  assert.equal(check(f.store,f.run.id).reviewCount,0);
});

for(const changed of ['text','url'] as const)test(`an inherited ${changed} replacement invalidates the old child evidence`,t=>{
  const f=fixture();t.after(f.close);const parentPage=page('S1',IDENTITY.profileUrl);save(f,[parentPage]);
  const child=f.store.insertRun({ownerId:OWNER,question:'Synthetic child',seedUrl:IDENTITY.profileUrl,provider:'research',parentRunId:f.run.id,retryOf:null,followup:true,idempotencyKey:null,bodyFingerprint:`child-${changed}`});
  const childPage={...parentPage,sourceKey:'S7',inheritedFrom:{runId:f.run.id,sourceKey:'S1'}};
  save({store:f.store,run:child},[childPage]);
  assert.equal(f.store.isResearchSourceActive(child.id,'S7',OWNER),true);
  const changedPage={...parentPage,...(changed==='text'?{text:'Replacement synthetic original.'}:{url:'https://lantern.dev/changed'})};
  save(f,[changedPage]);
  assert.equal(f.store.isResearchSourceActive(child.id,'S7',OWNER),false,'a parent source key cannot authenticate replacement content');
  assert.equal(check(f.store,child.id).reviewCount,1);
});

test('ancestor revocation and restored content are read afresh by every history summary',t=>{
  const f=fixture();t.after(f.close);const original=page('S1',IDENTITY.profileUrl);save(f,[original]);
  const child=f.store.insertRun({ownerId:OWNER,question:'Synthetic descendant',seedUrl:IDENTITY.profileUrl,provider:'research',parentRunId:f.run.id,retryOf:null,followup:true,idempotencyKey:null,bodyFingerprint:'descendant'});
  save({store:f.store,run:child},[{...original,sourceKey:'S8',inheritedFrom:{runId:f.run.id,sourceKey:'S1'}}]);
  assert.equal(check(f.store,child.id).reviewCount,0);
  f.store.setSourceExcluded(f.run.id,'S1',true);assert.equal(check(f.store,child.id).reviewCount,1);
  f.store.setSourceExcluded(f.run.id,'S1',false);assert.equal(check(f.store,child.id).reviewCount,0);
});

test('scope changes cannot reuse an earlier history projection',t=>{
  const f=seedFirstStep({accounts:[{url:IDENTITY.profileUrl,supportedBy:{sourceUrl:'https://lantern.dev/about'}}]});t.after(f.close);
  const view=f.firstStep.getFirstStepView(f.run.ownerId,f.run.id)!;assert.equal(view.mode,'first_step');if(view.mode!=='first_step')return;
  f.firstStep.applyFirstStepSelection(f.run.ownerId,f.run.id,{expectedRunRevision:f.store.getRun(f.run.id)!.revision,expectedScopeVersion:view.view.selection.scopeVersion,discoveryRevision:view.view.discoveryRevision,clusterId:'cluster-1',accounts:[{accountId:f.accountIdFor(0),selection:'selected',excluded:false}]},'summary-selection');
  const binding=f.firstStep.selectionBinding(f.run.id)!;
  save(f,[page('S1',IDENTITY.profileUrl)],{firstStep:binding});
  assert.equal(check(f.store,f.run.id).state,'completed');
  f.db.prepare('UPDATE research_cases SET scope_version=scope_version+1 WHERE id=?').run(f.caseId);
  assert.equal(check(f.store,f.run.id).state,'partial');
});
