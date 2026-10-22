/** Durable single-X-account workflow. Paid reads are cursor-addressed receipts;
 * account analysis never becomes a claim about an unverified cross-platform person. */
import {createHash} from 'node:crypto';
import type {Store,RunRecord} from '../store.js';
import type {HttpTransport} from '../adapters/types.js';
import {ProviderError} from '../adapters/types.js';
import {FirstStepSelectionError} from './first-step-store.js';
import {ResearchStop,remainingOf,type FirstStepBinding,type ResearchCheckpoint} from './research-store.js';
import type {ProviderResult,ResearchBudgetLimits,SourceDraft} from '../../shared/types.js';
import type {XAccountProvider,XAccountResearchState,XAccountModel,XNativePost,XReadRequest,XReadResult} from './x-account-contracts.js';
import {allocateSourceKey,rememberSourceKeys} from './source-keys.js';
import {meteredInvoke} from './metered.js';
import {runDshDecision} from './dsh-decision.js';
import {invokeDeepSeek,parseMessagesUsage,estimateModelUsd} from './planner.js';
import {analyzeXAccount,projectXAccountReport} from './x-account-analysis.js';
import {xAccountActiveSourceKeys,xSourceDrafts} from './x-account-projection.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unlimited:ResearchBudgetLimits={toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0};
export interface XAccountResearchOptions {
 store:Store;run:RunRecord;binding:FirstStepBinding;provider:XAccountProvider;signal:AbortSignal;
 limits?:ResearchBudgetLimits;assertScope:()=>void;
 /** Injected model ports own their own metering. Production uses the bridge below. */
 model?:XAccountModel;transport?:HttpTransport;apiKey?:string|null;modelName?:string;
}
function initialState(accountId:string):XAccountResearchState {
 const feed=()=>({started:false,cursor:null,done:false,pages:0,cursors:[],pageHashes:[]});
 return{version:'x-account/v1',accountId,profile:null,history:{timeline:feed(),replies:feed()},posts:[],contextQueue:[],contextDone:[],gaps:[],analysis:{completedBatches:[],findings:[],synthesisDone:false}};
}
function nativeHandle(binding:FirstStepBinding):string {
 if(binding.accounts.length!==1||binding.accounts[0]!.allowedScope!=='public_history')throw new ResearchStop('x_account_scope_required');
 const url=new URL(binding.accounts[0]!.profileUrl);
 if(!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||!/^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname))throw new ResearchStop('x_account_scope_required');
 return url.pathname.split('/')[1]!;
}
function sourceDraft(cp:ResearchCheckpoint,state:XAccountResearchState,key:string):SourceDraft {
 const page=cp.pages.find(p=>p.sourceKey===key)!;
 const post=state.posts.find(p=>p.sourceKey===key);
 return{key,url:page.url,title:page.title,kind:page.kind,publishedAt:page.publishedAt,excerpt:page.text,
  excerptLocator:post?`X 原生帖子 ${post.id}；正文字段 ${post.textField}`:'X 原生账号资料',
  identityLabel:post&&post.role!=='target'?'第三方或线程上下文，作者单独记录':`所选 X 账号 @${state.profile?.handle??''}，不确认跨平台身份`,identityConfirmed:false,fetchStatus:page.text?'ok':'inaccessible',limits:page.limitations};
}
function setup(options:XAccountResearchOptions){
 const {store,run}=options;const handle=nativeHandle(options.binding);
 let checkpoint=store.research.checkpoint(run.id);
 const limits=checkpoint?.limits??options.limits??unlimited;
 const launched=Date.now(),priorElapsed=checkpoint?.elapsedMs??0;
 if(!checkpoint)checkpoint={phase:'x_history',steps:0,startedAt:launched,elapsedMs:0,anchorUrl:options.binding.accounts[0]!.profileUrl,identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null,firstStep:options.binding,limits};
 if(!checkpoint.xAccountResearch){
  // Existing discovery remains in immutable receipts; account analysis starts
  // with a clean, explicitly selected corpus, not arbitrary search previews.
  checkpoint.pages=[];checkpoint.claims=[];checkpoint.pendingClaims=[];checkpoint.independentMaterials=[];
  checkpoint.unknowns=[];checkpoint.coverageGaps=[];checkpoint.notes=[];
  checkpoint.xAccountResearch=initialState(options.binding.accounts[0]!.accountId);
 }
 const cp=checkpoint,state=cp.xAccountResearch!;
 rememberSourceKeys(cp,store.listSources(run.id).map(source=>source.sourceKey));
 if(state.accountId!==options.binding.accounts[0]!.accountId)throw new ResearchStop('scope_changed');
 cp.firstStep=options.binding;cp.limits=limits;
 const active=()=>{
  options.signal.throwIfAborted();store.research.assertActive(run.id);options.assertScope();
  if(!store.isResearchScopeActive(run.id,run.ownerId))throw new FirstStepSelectionError('scope_changed','单账号研究范围已变更或撤回。');
  const current=new Map(store.listSources(run.id).map(source=>[source.sourceKey,source]));
  if(cp.pages.some(page=>{const source=current.get(page.sourceKey);return !source||source.excluded||source.excerpt!==page.text;}))throw new ResearchStop('source_revoked');
  if(limits.elapsedMs>0&&priorElapsed+Date.now()-launched>=limits.elapsedMs)throw new ResearchStop('budget_exhausted');
 };
 const save=()=>{active();cp.elapsedMs=priorElapsed+Date.now()-launched;store.research.save(run.id,cp);};
 const gap=(code:string,target:string,detail:string)=>{if(!state.gaps.some(g=>g.code===code&&g.target===target))state.gaps.push({code,target,detail});};
 const progress=(key:string,label:string)=>{
  cp.phase=key;save();store.addEvent(run.id,'stage',{index:cp.steps,total:0,key,label,status:'active'});
 };
 const read=async(request:XReadRequest):Promise<XReadResult>=>{
  active();const key='x-account:tool:v1:'+digest({accountId:state.accountId,scopeVersion:options.binding.scopeVersion,request});
  const result=await meteredInvoke<XReadResult>({ledger:store.research,runId:run.id,key,kind:'tool',request:{...request,type:`x_${request.type}`},reservation:{inputTokens:0,outputTokens:0},limits,allowSettledFailure:true,
   replayFailure:()=>new ProviderError('provider_bad_response','该请求已有失败回执，未自动重复付费。'),
   execute:()=>options.provider.execute(request,options.signal),usageOf:r=>({estimatedUsd:r.estimatedUsd,bytes:r.bytes,unknownCost:r.estimatedUsd===null}),
   failureUsage:()=>({estimatedUsd:null,unknownCost:true}),settleFailure:()=>!options.signal.aborted});
  active();if(result.requests!==1)throw new ResearchStop('tool_contract_violation');cp.steps++;
  return result;
 };
 return{cp,state,limits,handle,active,save,gap,progress,read};
}

/** Exported so pagination/recovery and cancellation can be tested without a model. */
export async function collectXAccount(options:XAccountResearchOptions){
 const s=setup(options);const{cp,state,handle,active,save,gap,progress,read}=s;const{store,run}=options;
 const queue=(type:'detail'|'comments',tweetId:string,rootId:string,relation:typeof state.contextQueue[number]['relation'])=>{
  if(!/^\d+$/.test(tweetId))return;
  const key=`${type}:${tweetId}:${rootId}:${relation}`;
  if(!state.contextDone.includes(key)&&!state.contextQueue.some(q=>`${q.type}:${q.tweetId}:${q.rootId}:${q.relation}`===key))state.contextQueue.push({type,tweetId,rootId,relation});
 };
 const savePage=(post:XNativePost,role:typeof state.posts[number]['role'],rootId:string)=>{
  options.signal.throwIfAborted();const existing=state.posts.find(p=>p.id===post.id);
  const isTarget=post.authorId===state.profile!.nativeId;
  if(role==='target'&&!isTarget){gap('author_mismatch',post.id,'详情作者与所选账号的原生 ID 不一致，未作为本人发言。');return;}
  const actualRole=isTarget?'target':role;
  if(existing){
   if(!existing.rootIds.includes(rootId))existing.rootIds.push(rootId);
   // Replies feed can contain shorter previews of a long post already read.
   if((!existing.truncated&&post.truncated)||existing.text.length>post.text.length&&post.truncated){
    if(isTarget&&post.kind!=='repost')queue('detail',post.id,post.id,'target');
    return;
   }
  }
  const sourceKey=existing?.sourceKey??allocateSourceKey(cp);
  const root=state.posts.find(p=>p.id===rootId);
  const record={...post,sourceKey,role:actualRole,rootIds:[...new Set([...(existing?.rootIds??[]),rootId])]};
  if(existing)state.posts[state.posts.indexOf(existing)]=record;else state.posts.push(record);
  const dependencies=actualRole==='target'?[]:[...new Set([...(cp.pages.find(p=>p.sourceKey===sourceKey)?.discoveredFrom??[]),...(root&&root.sourceKey!==sourceKey?[root.sourceKey]:[])])];
  const page={sourceKey,url:post.url,title:actualRole==='target'?`@${state.profile!.handle} 的${post.kind==='repost'?'转发记录':'公开帖子'}`:`@${post.authorHandle||'未知作者'} 的上下文原文`,text:post.text,kind:actualRole==='target'?'work' as const:'third_party' as const,publishedAt:post.publishedAt,author:post.authorHandle||null,retrievedAt:new Date().toISOString(),retrieval:'read' as const,account:{platform:'x' as const,handle:post.authorHandle,id:post.authorId,profileUrl:`https://x.com/${post.authorHandle}`},links:[],limitations:[...(post.truncated?['供应商列表返回节选，需以单帖详情补读正文。']:[]),...(actualRole!=='target'?['第三方上下文仅保留实际作者，不作为目标账号本人观点或独立事实核实。']:[]),...(post.kind==='repost'?['转发记录不表示原文由目标账号创作，也不自动表示赞同。']:[])],textTruncated:post.truncated,...(dependencies.length?{discoveredFrom:dependencies}:{})};
  const old=cp.pages.find(p=>p.sourceKey===sourceKey);if(old)cp.pages[cp.pages.indexOf(old)]=page;else cp.pages.push(page);
  store.addSource(run.id,sourceDraft(cp,state,sourceKey),cp.pages.indexOf(page));store.addEvent(run.id,'source',store.getSource(run.id,sourceKey));
  if(actualRole==='target'){
   if(post.truncated&&post.kind!=='repost')queue('detail',post.id,post.id,'target');
   if(post.parentId)queue('detail',post.parentId,post.id,'parent_context');
   else if(post.kind==='reply'&&post.conversationId&&post.conversationId!==post.id)queue('detail',post.conversationId,post.id,'parent_context');
   if(post.quotedId)queue('detail',post.quotedId,post.id,'quoted_context');
   if(post.kind==='repost'&&post.originalPostId)queue('detail',post.originalPostId,post.id,'quoted_context');
   if(post.replyCount!==null&&post.replyCount>0)queue('comments',post.id,post.id,'reply_context');
  }else if(role==='parent_context'&&post.parentId)queue('detail',post.parentId,rootId,'parent_context');
 };
 if(!state.profile){
  progress('x_profile',`核对所选 X 账号 @${handle}`);
  const response=await read({type:'profile',handle});
  if(!response.account||response.account.handle.toLowerCase()!==handle.toLowerCase()||!/^\d+$/.test(response.account.nativeId))throw new ResearchStop('x_account_identity_mismatch');
  state.profile=response.account;cp.anchorUrl=response.account.url;
  cp.identity={displayName:`@${response.account.handle} · X 账号研究`,handle:response.account.handle,profileUrl:response.account.url,status:'resolved',note:'研究主体是此 X 账号，不据此确认真人身份或合并其它平台。',candidates:[]};
  const sourceKey=allocateSourceKey(cp);
  cp.pages.push({sourceKey,url:response.account.url,title:`@${handle} 的公开账号资料`,text:response.account.description,kind:'profile',publishedAt:null,author:handle,account:{platform:'x',handle,id:response.account.nativeId,profileUrl:response.account.url},links:[],limitations:['账号资料为自述，不等于独立身份核验。'],retrieval:'profile',retrievedAt:new Date().toISOString()});
  store.addSource(run.id,sourceDraft(cp,state,sourceKey),0);save();
 }
 for(const feed of ['timeline','replies'] as const){
  const cursor=state.history[feed];
  while(!cursor.done&&!cursor.blocked){
   active();progress(`x_history_${feed}`,`读取${feed==='timeline'?'历史帖子':'账号回复'}第 ${cursor.pages+1} 页，已保留 ${state.posts.filter(p=>p.role==='target').length} 条账号记录`);
   let response:XReadResult;
   try{response=await read({type:feed,handle:state.profile!.handle,nativeId:state.profile!.nativeId,cursor:cursor.cursor});}
   catch(error){if(!(error instanceof ProviderError))throw error;cursor.blocked='history_read_failed';gap('history_read_failed',feed,`${feed==='timeline'?'帖子':'回复'}历史有读取失败，失败回执保留，未自动重试。`);save();break;}
   const pageHash=digest(response.posts.map(p=>[p.id,p.text]));
   cursor.started=true;cursor.pages++;
   for(const post of response.posts)if(post.authorId===state.profile!.nativeId)savePage(post,'target',post.id);
   if(response.recordCount>0&&cursor.pageHashes.includes(pageHash)){
    cursor.blocked='repeated_page';gap('repeated_page',feed,'供应商重复返回同一历史页，不能将重复页当作历史结束。');save();break;
   }
   if(response.recordCount>0)cursor.pageHashes.push(pageHash);
   if(response.cursorState==='end'){cursor.done=true;cursor.cursor=null;save();break;}
   if(response.cursorState!=='more'||!response.nextCursor){cursor.blocked='cursor_unknown';gap('cursor_unknown',feed,'供应商未给出可验证的历史结束或下一页状态。');save();break;}
   if(response.nextCursor===cursor.cursor||cursor.cursors.includes(response.nextCursor)){cursor.blocked='cursor_cycle';gap('cursor_cycle',feed,'供应商历史游标循环，已停止重复读取并保留覆盖缺口。');save();break;}
   cursor.cursors.push(response.nextCursor);cursor.cursor=response.nextCursor;save();
  }
 }
 while(state.contextQueue.length){
  active();const task=state.contextQueue[0]!;const key=`${task.type}:${task.tweetId}:${task.rootId}:${task.relation}`;
  if(state.contextDone.includes(key)){state.contextQueue.shift();save();continue;}
  progress('x_context',`补读${task.relation==='target'?'帖子完整正文':task.type==='comments'?'讨论上下文':task.relation==='quoted_context'?'引用原文':'回复父链'}，待处理 ${state.contextQueue.length} 项`);
  try{
   const response=await read(task.type==='detail'?{type:'detail',tweetId:task.tweetId}:{type:'comments',tweetId:task.tweetId,cursor:null});
   if(task.type==='detail'&&(!response.posts.length||response.posts[0]!.id!==task.tweetId))gap('context_missing',task.tweetId,'单帖详情未返回请求的原生帖子，缺口保留。');
   else for(const post of response.posts)savePage(post,task.relation,task.rootId);
   if(task.type==='comments'&&response.cursorState!=='end')gap('comments_first_page',task.tweetId,'本帖讨论按默认首层一页读取；供应商后续评论或完整讨论树未穷尽。');
  }catch(error){if(!(error instanceof ProviderError))throw error;gap('context_read_failed',task.tweetId,'该条回复、引用或讨论上下文未读取成功，失败回执保留。');}
  state.contextDone.push(key);state.contextQueue.shift();save();
 }
 progress('x_analysis',`已保留 ${state.posts.filter(p=>p.role==='target').length} 条账号记录，开始分批分析与独立核验`);
 return{checkpoint:cp,state,active,save};
}

function productionModel(options:XAccountResearchOptions,cp:ResearchCheckpoint,active:()=>void):XAccountModel {
 if(!options.transport||!options.apiKey)throw new ResearchStop('model_unavailable');
 const limits=cp.limits??options.limits??unlimited;
 return async(input,signal)=>{
  active();let usage={inputTokens:0,outputTokens:0,known:false},dispatched=false;
  const budget=options.store.research.budget(options.run.id,limits);
  const inputReservation=Math.ceil(Buffer.byteLength(input.prompt,'utf8')/2);
  const remaining=remainingOf(limits.outputTokens,budget.outputTokens);
  const maxTokens=Math.min(input.maxTokens,remaining??input.maxTokens,16384);
  if(maxTokens<1)throw new ResearchStop('budget_exhausted');
  const result=await meteredInvoke<unknown>({ledger:options.store.research,runId:options.run.id,key:'x-account:model:v1:'+digest({input,model:options.modelName}),kind:'model',request:{purpose:input.purpose,prompt:input.prompt,schema:input.schema,maxTokens},reservation:{inputTokens:inputReservation,outputTokens:maxTokens},limits,allowSettledFailure:true,
   replayFailure:()=>new ResearchStop('model_request_failed'),
   execute:()=>runDshDecision({prompt:input.prompt,schema:input.schema,model:options.modelName??'deepseek-flash',maxTokens,timeoutMs:120000,signal,invoke:async request=>{
    active();dispatched=true;const response=await invokeDeepSeek(options.transport!,options.apiKey!,request);usage=parseMessagesUsage(response.body);return response;
   }}),
   usageOf:()=>({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,estimatedUsd:usage.known?estimateModelUsd(options.modelName??'deepseek-flash',usage.inputTokens,usage.outputTokens):null,unknownCost:!usage.known}),
   failureUsage:()=>({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,estimatedUsd:dispatched?null:0,unknownCost:dispatched}),settleFailure:()=>!signal.aborted});
  active();cp.steps++;return result;
 };
}

export async function runXAccountResearch(options:XAccountResearchOptions):Promise<ProviderResult>{
 let cp:ResearchCheckpoint|undefined,stopped:string|null=null;
 try{
  const collected=await collectXAccount(options);cp=collected.checkpoint;
  const {state,active,save}=collected;
  const model=options.model??productionModel(options,cp,active);
  await analyzeXAccount({subject:state.profile!,question:options.run.question,pages:cp.pages,posts:state.posts,state,model,signal:options.signal,save,active});
  active();
 }catch(error){
  // Cancellation/process shutdown keeps the durable inflight receipt for the
  // existing recovery flow. Ordinary research stops retain a reviewable report.
  if(options.signal.aborted||error instanceof ResearchStop&&error.code==='run_inactive')throw error;
  stopped=error instanceof ResearchStop||error instanceof FirstStepSelectionError?error.code:error instanceof ProviderError?error.code:'analysis_incomplete';
  // Never publish a late model/provider response after authority was withdrawn.
  // Only the most recent saved checkpoint is eligible for partial projection.
  cp=options.store.research.checkpoint(options.run.id)??undefined;
  if(!cp?.xAccountResearch)throw error;
 }
 if(!cp?.xAccountResearch)throw new ResearchStop('x_account_checkpoint_missing');
 const state=cp.xAccountResearch;
 if(stopped){
  const messages:Record<string,string>={
   budget_exhausted:'本次研究额度已用完；已读取的原文与已核验结论保留，历史或分析尚未完成。',
   unknown_inflight:'上次请求的供应商结算状态未知，已暂停以避免重复付费；先前读取的材料保留。',
   source_revoked:'原文已被撤回或变更；依赖这些材料的结论停止使用，已读材料保留待复核。',
   scope_changed:'所选账号研究范围已变更或撤回；当前结果保留待复核，不继续读取或分析。',
   model_unavailable:'分析模型当前不可用；已读取的账号原文保留，尚未完成分析与独立核验。'
  };
  if(!state.gaps.some(g=>g.code===stopped&&g.target==='research'))state.gaps.push({code:stopped,target:'research',detail:messages[stopped]??'读取、分析或独立核验尚未完成；已读取的资料与有效结论保留。'});
 }
 const scopeActive=stopped!=='scope_changed'&&options.store.isResearchScopeActive(options.run.id,options.run.ownerId);
 const liveSources=options.store.listSources(options.run.id);
 const keys=xAccountActiveSourceKeys(cp.pages,liveSources,scopeActive);
 // The live source is authoritative: never restore withdrawn or edited text
 // from the immutable collection checkpoint during terminal finalization.
 const corpusKeys=new Set(cp.pages.map(page=>page.sourceKey));
 const sources=xSourceDrafts(liveSources.filter(source=>corpusKeys.has(source.sourceKey)));
 const projection=projectXAccountReport({state,pages:cp.pages,sources,activeSourceKeys:keys});
 const complete=!stopped&&state.history.timeline.done&&state.history.replies.done&&state.analysis.synthesisDone&&projection.findings.length>0&&!state.gaps.some(g=>g.code!=='comments_first_page');
 cp.phase='done';cp.stopReason=stopped??(complete?'x_account_research_complete':'x_account_research_partial');cp.unknowns=state.gaps.filter(g=>g.code!=='comments_first_page').map(g=>g.detail);
 // This is a terminal review checkpoint, so it must survive a revoked scope.
 // ResearchStore still enforces run cancellation/deletion/terminal-state guards.
 options.store.research.save(options.run.id,cp);
 const receipts=options.store.research.receipts(options.run.id);
 return{state:complete?'completed':'partial',identity:cp.identity??{displayName:'X 账号研究',handle:null,profileUrl:options.binding.accounts[0]!.profileUrl,status:'needs_input',note:'原生账号资料尚未核对完成，当前不能确认账号标识。',candidates:[]},sources,answer:projection.answer,observations:projection.observations,limitations:projection.limitations,usage:{requests:receipts.length,bytes:receipts.reduce((n,r)=>n+(r.usage?.bytes??0),0)},stopReason:cp.stopReason};
}
