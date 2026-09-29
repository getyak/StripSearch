import { createHash } from 'node:crypto';
import { NeedsInputError, type IdentityCandidate, type ProviderResult, type ResearchBudgetLimits, type SourceDraft } from '../../shared/types.js';
import { extractGitHubHandle, normalizeResearchUrl, sanitizeText } from '../../shared/validation.js';
import { ProviderError, type HttpTransport } from '../adapters/types.js';
import type { Store, RunRecord } from '../store.js';
import { type ResearchPlanner, invokeDeepSeek, parseMessagesUsage, estimateModelUsd } from './planner.js';
import { RESEARCH_LIMITS, ResearchStop, type ResearchCheckpoint, type StoredPage, type ResearchClaim } from './research-store.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from './tool-contracts.js';

export interface ResearchOptions {
 store:Store;run:RunRecord;tools:ResearchTools;planner:ResearchPlanner;signal:AbortSignal;
 transport?:HttpTransport;deepseekApiKey?:string|null;socialAvailable?:boolean;firecrawlAvailable?:boolean;
 limits?:ResearchBudgetLimits;
}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function digest(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}
function candidateId(url:string):string{return 'candidate_'+digest(url);}
function draft(page:StoredPage,anchor:string|null):SourceDraft{return {key:page.sourceKey,url:page.url,title:page.title,kind:page.kind,publishedAt:page.publishedAt,excerpt:page.text,excerptLocator:'公开页面文本',identityLabel:page.url===anchor?'所选公开主页':'来源归属未独立验证',identityConfirmed:page.url===anchor,fetchStatus:page.text?'ok':'inaccessible',limits:[...page.limitations,...page.url===anchor?['主页内容由该账号维护；不代表跨平台身份已核实。']:['与研究对象的关系需结合原文核对，不因同名自动合并。']]};}

export async function runResearch(options:ResearchOptions):Promise<ProviderResult>{
 const {store,run,tools,planner}=options;const limits=options.limits??RESEARCH_LIMITS;
 const launched=Date.now();
 const checkpoint:ResearchCheckpoint=store.research.checkpoint(run.id)??{phase:'identity',steps:0,startedAt:launched,elapsedMs:0,anchorUrl:normalizeResearchUrl(run.seedUrl),identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null};
 const priorElapsed=checkpoint.elapsedMs;
 const deadline=new AbortController();const remaining=Math.max(1,limits.elapsedMs-priorElapsed);
 const timer=setTimeout(()=>deadline.abort(new ResearchStop('budget_exhausted')),remaining);
 const signal=AbortSignal.any([options.signal,deadline.signal]);
 const active=()=>{signal.throwIfAborted();store.research.assertActive(run.id);if(priorElapsed+Date.now()-launched>=limits.elapsedMs)throw new ResearchStop('budget_exhausted');};
 const save=()=>{active();checkpoint.elapsedMs=priorElapsed+Date.now()-launched;store.research.save(run.id,checkpoint);};
 const progress=(phase:string)=>{checkpoint.phase=phase;save();store.addEvent(run.id,'stage',{index:checkpoint.steps,total:limits.toolCalls,key:phase,label:phase==='identity'?'确认公开主页':phase==='planning'?'整理资料与缺口':'读取相关资料',status:'active'});};
 const allowedUrls=()=>new Set([checkpoint.anchorUrl,...checkpoint.pages.flatMap(p=>[p.url,...p.links])].filter((v):v is string=>!!v));
 const stillActivePages=()=>checkpoint.pages.filter(page=>store.isResearchSourceActive(run.id,page.sourceKey,run.ownerId));
 const ingest=(result:ResearchToolResult)=>{
  active();
  for(const page of result.pages.slice(0,12)){
   const url=normalizeResearchUrl(page.url);if(!url)continue;
   const existing=checkpoint.pages.find(p=>p.url===url);
   if(!existing&&checkpoint.pages.length>=24)continue;
   const clean:StoredPage={...page,url,title:sanitizeText(page.title,200),text:sanitizeText(page.text,8000),links:[...new Set(page.links.map(normalizeResearchUrl).filter((v):v is string=>!!v))].slice(0,24),limitations:page.limitations.map(v=>sanitizeText(v,500)),sourceKey:existing?.sourceKey??`S${checkpoint.pages.length+1}`};
   if(existing)checkpoint.pages[checkpoint.pages.indexOf(existing)]=clean;else checkpoint.pages.push(clean);
   store.addSource(run.id,draft(clean,checkpoint.anchorUrl),checkpoint.pages.indexOf(clean));
   store.addEvent(run.id,'source',store.getSource(run.id,clean.sourceKey));
  }
  checkpoint.unknowns=[...new Set([...checkpoint.unknowns,...result.limitations.map(v=>sanitizeText(v,500))])].slice(0,24);save();
 };
 const perform=async(action:ResearchToolAction):Promise<ResearchToolResult>=>{
  active();
  if(action.type!=='search'){
   const url=normalizeResearchUrl(action.url);
   if(!url||!allowedUrls().has(url))throw new ResearchStop('url_not_discovered');
   action={...action,url};
   if(action.type==='firecrawl'&&(!options.firecrawlAvailable||['x.com','twitter.com'].includes(new URL(url).hostname)))throw new ResearchStop('tool_unavailable');
   if((action.type==='social_profile'||action.type==='social_posts')&&!options.socialAvailable)throw new ResearchStop('tool_unavailable');
  }else if(!action.query.trim()||action.query.length>600)throw new ResearchStop('invalid_decision');
  const key='tool:'+digest(action);
  const old=store.research.reserve(run.id,key,'tool',action,{inputTokens:0,outputTokens:0},limits);
  if(old)return old.result as ResearchToolResult;
  try{
   const result=await tools.execute(action,signal);
   if(result.requests!==1)throw new ResearchStop('tool_contract_violation');
   store.research.settle(run.id,key,result,{estimatedUsd:result.estimatedUsd,credits:result.credits,bytes:result.bytes,unknownCost:result.estimatedUsd===null});
   active();return result;
  }catch(error){
   if(!options.signal.aborted){try{store.research.settle(run.id,key,null,{estimatedUsd:null,unknownCost:true},'failed');}catch{/* A cancelled/deleted run cannot accept late receipts. */}}
   throw error;
  }
 };
 const ask=async(mode:'plan'|'verify',claims?:ResearchClaim[]):Promise<unknown>=>{
  const step=checkpoint.steps;const budget=store.research.budget(run.id,limits);const activePages=stillActivePages();
  return await planner.decide({mode,claims,question:run.question,checkpoint:{...checkpoint,pages:activePages},remainingTools:limits.toolCalls-budget.toolCalls,remainingModels:limits.modelCalls-budget.modelCalls},signal,async request=>{
    active();if(!options.transport||!options.deepseekApiKey)throw new ProviderError('provider_unavailable','DeepSeek 未配置。');
    if(request.body.max_tokens!==2500)throw new ResearchStop('model_contract_violation');
    const key=`model:${step}`;const inputBound=Buffer.byteLength(JSON.stringify(request.body));
    const old=store.research.reserve(run.id,key,'model',{model:request.body.model,path:request.path},{inputTokens:inputBound,outputTokens:2500},limits);
    if(old)return old.result as Awaited<ReturnType<typeof invokeDeepSeek>>;
    try{const result=await invokeDeepSeek(options.transport,options.deepseekApiKey,request);
     const usage=parseMessagesUsage(result.body);
     store.research.settle(run.id,key,result,{inputTokens:usage.known?usage.inputTokens:inputBound,outputTokens:usage.known?usage.outputTokens:2500,estimatedUsd:usage.known?estimateModelUsd(String(request.body.model),usage.inputTokens,usage.outputTokens):null,unknownCost:!usage.known||estimateModelUsd(String(request.body.model),usage.inputTokens,usage.outputTokens)===null,bytes:Buffer.byteLength(result.body)});
     active();return result;
    }catch(error){if(!options.signal.aborted){try{store.research.settle(run.id,key,null,{estimatedUsd:null,unknownCost:true},'failed');}catch{}}throw error;}
   });
 };
 const finish=(reason:string,state:'completed'|'partial'):ProviderResult=>{
  checkpoint.phase='done';checkpoint.stopReason=reason;
  if(!options.signal.aborted){checkpoint.elapsedMs=priorElapsed+Date.now()-launched;store.research.save(run.id,checkpoint);}
  const pages=stillActivePages();const keys=new Set(pages.map(p=>p.sourceKey));
  const claims=checkpoint.claims.filter(c=>keys.has(c.sourceKey));
  const observations=claims.map(c=>({statement:c.statement,kind:c.kind,sourceKeys:[c.sourceKey],limitations:['来源原文摘录；身份归属与独立事实核实另行判断。']}));
  const budget=store.research.budget(run.id,limits);
  return {state,identity:checkpoint.identity??{displayName:'',handle:null,profileUrl:checkpoint.anchorUrl,status:'needs_input',note:'尚未确认公开主页。',candidates:checkpoint.candidates},sources:checkpoint.pages.map(p=>draft(p,checkpoint.anchorUrl)),observations,
   answer:(['background','work','expression','analysis'] as const).map(section=>({id:section,heading:({background:'背景与经历',work:'作品与行动',expression:'公开表达',analysis:'分析与不确定性'})[section],body:'',bullets:claims.filter(c=>c.section===section).map(c=>({text:c.statement,sourceKeys:[c.sourceKey],kind:c.kind}))})).filter(section=>section.bullets.length>0),limitations:[...new Set([...checkpoint.unknowns,...state==='partial'?[`研究已停止：${reason}。已有材料保留，未证实的内容不补写。`]:[]])],usage:{requests:budget.toolCalls+budget.modelCalls,bytes:store.research.receipts(run.id).reduce((n,r)=>n+(r.usage?.bytes??0),0)},stopReason:reason};
 };
 const verify=async():Promise<ProviderResult>=>{
  const claims=checkpoint.pendingClaims??[];
  const quoteFallback=(reason:'verification_budget'|'verification_unavailable'):ProviderResult=>{
   options.signal.throwIfAborted();store.research.assertActive(run.id);
   const pages=stillActivePages();
   checkpoint.claims=claims.filter(c=>pages.some(p=>p.sourceKey===c.sourceKey&&p.text.includes(c.quote))).map(c=>({...c,statement:c.quote,kind:'page_statement'}));delete checkpoint.pendingClaims;
   checkpoint.unknowns.push('综合结论未通过独立语义核验，仅保留来源逐字摘录；摘录不代表结论已核实。');
   return finish(reason,'partial');
  };
  if(checkpoint.steps>=limits.modelCalls||store.research.budget(run.id,limits).modelCalls>=limits.modelCalls){
   return quoteFallback('verification_budget');
  }
  progress('verifying');
  let checked:unknown;
  try{checked=await ask('verify',claims);}catch(error){
   if(options.signal.aborted)throw error;
   return quoteFallback('verification_unavailable');
  }
  active();
  if(!object(checked)||!Array.isArray(checked.supported)||!Array.isArray(checked.rejected))return quoteFallback('verification_unavailable');
  const supportedIndexes=checked.supported;
  const rejectedIndexes:number[]=[];
  for(const item of checked.rejected){
   if(!object(item)||!Number.isInteger(item.index)||typeof item.reason!=='string'||!item.reason.trim())return quoteFallback('verification_unavailable');
   rejectedIndexes.push(item.index as number);
  }
  const partition=[...supportedIndexes,...rejectedIndexes];
  if(partition.some(i=>!Number.isInteger(i)||Number(i)<0||Number(i)>=claims.length)||new Set(partition).size!==partition.length||partition.length!==claims.length)return quoteFallback('verification_unavailable');
  const supported=new Set(supportedIndexes as number[]);
  checkpoint.claims=claims.filter((_c,index)=>supported.has(index));delete checkpoint.pendingClaims;checkpoint.steps++;
  if(Array.isArray(checked.rejected))for(const item of checked.rejected)if(object(item)&&typeof item.reason==='string')checkpoint.unknowns.push(sanitizeText(item.reason,500));
  const complete=checkpoint.claims.length>0&&stillActivePages().length>1&&supported.size===claims.length;
  return finish(complete?'research_complete':'limited_evidence',complete?'completed':'partial');
 };
 try{
  active();
  if(store.research.receipts(run.id).some(r=>r.state!=='completed'))return finish('unknown_inflight','partial');
  // A follow-up can reuse only the same owner's currently active evidence.
  if(!store.research.checkpoint(run.id)&&run.followup&&run.parentRunId){
   const parent=store.getRunForOwner(run.parentRunId,run.ownerId);
   const parentCheckpoint=parent?store.research.checkpoint(parent.id):null;
   if(!parent)throw new ResearchStop('parent_unavailable');
   const parentView=store.buildCanonicalView(parent);
   if(parentCheckpoint && (parentView.identity.status!=='resolved'||!parentView.sources.some(source=>source.url===parentCheckpoint.anchorUrl&&!source.excluded))){
    checkpoint.anchorUrl=null;checkpoint.identity=null;checkpoint.candidates=[];save();
    throw new NeedsInputError('父研究的人物主页已撤回，请重新确认公开主页。',[]);
   }
   if(parentCheckpoint?.identity?.status==='resolved'){
    const activeKeys=new Set(parentView.sources.filter(s=>!s.excluded).map(s=>s.sourceKey));
    checkpoint.anchorUrl=parentCheckpoint.anchorUrl;checkpoint.identity=parentCheckpoint.identity;
    checkpoint.pages=parentCheckpoint.pages.filter(p=>activeKeys.has(p.sourceKey)).map((p,index)=>({...p,sourceKey:`S${index+1}`,inheritedFrom:{runId:parent.id,sourceKey:p.sourceKey}}));
    checkpoint.pages.forEach((p,index)=>store.addSource(run.id,draft(p,checkpoint.anchorUrl),index));
   }
  }
  progress('identity');
  if(!checkpoint.anchorUrl){
   const result=await perform({type:'search',query:run.question+' public profile biography'});
   const candidates:IdentityCandidate[]=[];
   for(const page of result.pages){const url=normalizeResearchUrl(page.account?.profileUrl??page.url);if(!url||page.kind!=='profile'||candidates.some(c=>c.profileUrl===url))continue;candidates.push({candidateId:candidateId(url),label:sanitizeText(page.title,160)||url,detail:url,profileUrl:url});}
   checkpoint.candidates=candidates.slice(0,8);save();
   // A search returning one result is not evidence that it is the intended person.
   throw new NeedsInputError(candidates.length?'请确认你要研究的公开主页。':'未找到明确的人物主页，请补充一个公开主页链接。',checkpoint.candidates);
  }
  if(!checkpoint.identity){
   const anchor=checkpoint.anchorUrl!;const handle=extractGitHubHandle(anchor);
   const action:ResearchToolAction=handle?{type:'github_profile',url:anchor}:new URL(anchor).hostname==='x.com'&&options.socialAvailable?{type:'social_profile',url:anchor}:{type:'read',url:anchor};
   const result=await perform(action);const page=result.pages.find(p=>normalizeResearchUrl(p.account?.profileUrl??p.url)===anchor);
   if(!page||!page.text.trim())throw new ResearchStop('identity_unverified');
   const profileLike=page.kind==='profile'||!!page.account||!!handle||['x.com','linkedin.com','www.linkedin.com'].includes(new URL(anchor).hostname);
   if(!profileLike)throw new NeedsInputError('该链接尚不能确定人物，请补充人物的公开主页。',[]);
   checkpoint.identity={displayName:sanitizeText(page.title,160)||page.account?.handle||anchor,handle:page.account?.handle??handle,profileUrl:anchor,status:'resolved',note:'已读取所选公开主页；跨平台账号关系尚未自动合并。',candidates:[]};
   checkpoint.candidates=[];ingest(result);save();
  }
  if(checkpoint.pendingClaims)return await verify();
  const seen=new Set<string>();
  while(checkpoint.steps<limits.modelCalls-1){
   active();progress('planning');
   const step=checkpoint.steps;
   const budget=store.research.budget(run.id,limits);
   const activePages=stillActivePages();
   const decision=await ask('plan');
   active();
   if(!object(decision)||typeof decision.action!=='string')throw new ResearchStop('invalid_decision');
   if(decision.action==='finish'){
    if(!Array.isArray(decision.claims)||decision.claims.length>12)throw new ResearchStop('invalid_evidence');
    const claims:ResearchClaim[]=decision.claims.map(raw=>{
     if(!object(raw)||typeof raw.sourceKey!=='string'||typeof raw.quote!=='string'||raw.quote.length<3||raw.quote.length>600)throw new ResearchStop('invalid_evidence');
     const page=activePages.find(p=>p.sourceKey===raw.sourceKey);if(!page||!page.text.includes(raw.quote))throw new ResearchStop('invalid_evidence');
     const kind=raw.kind??'page_statement';if(!['attributed_statement','page_statement','inference'].includes(String(kind)))throw new ResearchStop('invalid_evidence');
     const section=raw.section??(kind==='inference'?'analysis':'work');if(!['background','work','expression','analysis'].includes(String(section)))throw new ResearchStop('invalid_evidence');
     const statement=typeof raw.statement==='string'?sanitizeText(raw.statement,600):raw.quote;if(!statement)throw new ResearchStop('invalid_evidence');
     return {sourceKey:raw.sourceKey,quote:raw.quote,statement,kind:kind as ResearchClaim['kind'],section:section as ResearchClaim['section']};
    });
    checkpoint.claims=[];checkpoint.pendingClaims=claims;checkpoint.steps++;
    checkpoint.unknowns=[...new Set([...checkpoint.unknowns,...Array.isArray(decision.unknowns)?decision.unknowns.filter((v):v is string=>typeof v==='string').map(v=>sanitizeText(v,600)):[]])].slice(0,24);
    checkpoint.phase='verifying';save();return await verify();
   }
   let action:ResearchToolAction;
   if(decision.action==='search'&&typeof decision.query==='string')action={type:'search',query:decision.query};
   else if(['read','social','social_posts','firecrawl'].includes(decision.action)&&typeof decision.url==='string')action={type:decision.action==='social'?'social_profile':decision.action as 'read'|'social_posts'|'firecrawl',url:decision.url};
   else throw new ResearchStop('invalid_decision');
   const signature=digest(action);if(seen.has(signature))throw new ResearchStop('no_new_evidence');seen.add(signature);
   progress('reading');const result=await perform(action);ingest(result);checkpoint.steps++;save();
  }
  return finish('budget_exhausted','partial');
 }catch(error){
  if(error instanceof NeedsInputError){checkpoint.phase='needs_input';save();throw error;}
  if(options.signal.aborted)throw error;
  if(error instanceof ResearchStop&&error.code==='run_inactive')throw error;
  const reason=deadline.signal.aborted?'budget_exhausted':error instanceof ResearchStop?error.code:error instanceof ProviderError?error.code:'research_error';
  return finish(reason,'partial');
 }finally{clearTimeout(timer);}
}
