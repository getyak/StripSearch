import { RESEARCH_FACETS, researchDepthCoverage, type ResearchFacet } from '../../shared/research-depth.js';
import { createHash } from 'node:crypto';
import { NeedsInputError, type IdentityCandidate, type ProviderResult, type ResearchBudgetLimits, type SourceDraft } from '../../shared/types.js';
import { extractGitHubHandle, normalizeResearchUrl, sanitizeText } from '../../shared/validation.js';
import { ProviderError, type HttpTransport } from '../adapters/types.js';
import type { Store, RunRecord } from '../store.js';
import { type ResearchPlanner, invokeDeepSeek, parseMessagesUsage, estimateModelUsd } from './planner.js';
import { RESEARCH_LIMITS, ResearchStop, remainingOf, type ResearchCheckpoint, type StoredPage, type ResearchClaim } from './research-store.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from './tool-contracts.js';

export interface ResearchOptions {
 store:Store;run:RunRecord;tools:ResearchTools;planner:ResearchPlanner;signal:AbortSignal;
 transport?:HttpTransport;deepseekApiKey?:string|null;socialAvailable?:boolean;firecrawlAvailable?:boolean;
 limits?:ResearchBudgetLimits;
}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function digest(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}
function candidateId(url:string):string{return 'candidate_'+digest(url);}
/** Keep everything a tool supplied: only control characters are stripped. */
function retainText(value:unknown):string{return sanitizeText(value,Number.MAX_SAFE_INTEGER);}
function draft(page:StoredPage,anchor:string|null):SourceDraft{return {key:page.sourceKey,url:page.url,title:page.title,kind:page.kind,publishedAt:page.publishedAt,excerpt:page.text,excerptLocator:page.retrieval==='search'?'搜索发现材料，尚未回读原文':'公开页面文本',identityLabel:page.url===anchor?'所选公开主页':'来源归属未独立验证',identityConfirmed:page.url===anchor,fetchStatus:page.text?'ok':'inaccessible',limits:[...page.limitations,...page.url===anchor?['主页内容由该账号维护；不代表跨平台身份已核实。']:['与研究对象的关系需结合原文核对，不因同名自动合并。']]};}

export async function runResearch(options:ResearchOptions):Promise<ProviderResult>{
 const {store,run,tools,planner}=options;
 const persisted=store.research.checkpoint(run.id);
 const limits=persisted?(persisted.limits??RESEARCH_LIMITS):(options.limits??RESEARCH_LIMITS);
 const launched=Date.now();
 const checkpoint:ResearchCheckpoint=persisted??{phase:'identity',steps:0,startedAt:launched,elapsedMs:0,anchorUrl:normalizeResearchUrl(run.seedUrl),identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null};
 checkpoint.limits??={...limits};
 // Historical checkpoints did not persist retrieval provenance. Recover it only
 // from a completed, matching action receipt; missing proof stays unread.
 for(const page of checkpoint.pages){
  if(page.retrieval)continue;
  const matching=store.research.receipts(run.id).filter(r=>r.kind==='tool'&&r.state==='completed'&&object(r.request)&&object(r.result)&&Array.isArray(r.result.pages)&&r.result.pages.some((p:unknown)=>object(p)&&p.url===page.url&&typeof p.text==='string'&&retainText(p.text).startsWith(page.text)));
  const read=matching.find(r=>object(r.request)&&['read','firecrawl','social_profile','social_posts','github_profile'].includes(String(r.request.type)));
  if(read&&object(read.request))page.retrieval=['social_profile','github_profile'].includes(String(read.request.type))?'profile':'read';
  else if(matching.length)page.retrieval='search';
 }

 const priorElapsed=checkpoint.elapsedMs;
 const deadline=new AbortController();
 // Zero elapsed total is no fixed deadline: only cancel/stop can end the run.
 let timer:ReturnType<typeof setTimeout>|undefined;
 const scheduleDeadline=()=>{const remaining=limits.elapsedMs-priorElapsed-(Date.now()-launched);timer=setTimeout(()=>{if(priorElapsed+Date.now()-launched>=limits.elapsedMs)deadline.abort(new ResearchStop('budget_exhausted'));else scheduleDeadline();},Math.min(2_147_483_647,Math.max(1,remaining)));};
 if(limits.elapsedMs>0)scheduleDeadline();
 const signal=AbortSignal.any([options.signal,deadline.signal]);
 const active=()=>{signal.throwIfAborted();store.research.assertActive(run.id);if(limits.elapsedMs>0&&priorElapsed+Date.now()-launched>=limits.elapsedMs)throw new ResearchStop('budget_exhausted');};
 const save=()=>{active();checkpoint.elapsedMs=priorElapsed+Date.now()-launched;store.research.save(run.id,checkpoint);};
 const progress=(phase:string)=>{checkpoint.phase=phase;save();store.addEvent(run.id,'stage',{index:checkpoint.steps,total:limits.toolCalls,key:phase,label:phase==='identity'?'确认公开主页':phase==='planning'?'整理资料与缺口':'读取相关资料',status:'active'});};
 const stillActivePages=()=>checkpoint.pages.filter(page=>store.isResearchSourceActive(run.id,page.sourceKey,run.ownerId));
 const allowedUrls=()=>new Set([checkpoint.anchorUrl,...stillActivePages().flatMap(p=>[p.url,...p.links])].filter((v):v is string=>!!v));
 const dependencies=(action:ResearchToolAction):string[]=>{
  if(action.type==='search'||action.url===checkpoint.anchorUrl)return [];
  const existing=checkpoint.pages.find(p=>p.url===action.url);
  if(action.type==='social_posts'&&existing)return [existing.sourceKey];
  return existing?.discoveredFrom??stillActivePages().filter(p=>p.links.includes(action.url)&&p.sourceKey!==existing?.sourceKey).map(p=>p.sourceKey);
 };
 const ingest=(result:ResearchToolResult,action:ResearchToolAction,discoveredFrom:string[]=[])=>{
  active();
  // No page cap and no slicing: every supplied page, its full original text
  // and all its links stay in the corpus; model scope is a separate window.
  for(const page of result.pages){
   const url=normalizeResearchUrl(page.url);if(!url)continue;
   const existing=checkpoint.pages.find(p=>p.url===url);
   const retrieval=action.type==='search'?'search':action.type==='github_profile'||action.type==='social_profile'?'profile':'read';
   const clean:StoredPage={...page,retrieval,url,title:sanitizeText(page.title,200),text:retainText(page.text),links:[...new Set(page.links.map(normalizeResearchUrl).filter((v):v is string=>!!v))],limitations:page.limitations.map(v=>sanitizeText(v,500)),sourceKey:existing?.sourceKey??`S${checkpoint.pages.length+1}`,...existing?.inheritedFrom?{inheritedFrom:existing.inheritedFrom}:{},...discoveredFrom.length?{discoveredFrom:[...discoveredFrom]}:{}};
   // Search can enrich discovery but cannot replace an already fetched original.
   if(existing&&(existing.retrieval==='read'||existing.retrieval==='profile')&&retrieval==='search'){
    clean.text=existing.text;clean.title=existing.title;clean.retrieval=existing.retrieval;clean.kind=existing.kind;clean.publishedAt=existing.publishedAt;clean.author=existing.author;clean.retrievedAt=existing.retrievedAt;clean.textTruncated=existing.textTruncated;clean.account=existing.account;clean.discoveredFrom=existing.discoveredFrom;
    // Links remain discovery-only; they never inherit the original's factual support.
    clean.links=[...new Set([...existing.links,...clean.links])];clean.limitations=existing.limitations;
   }
   if(existing)checkpoint.pages[checkpoint.pages.indexOf(existing)]=clean;else checkpoint.pages.push(clean);
   store.addSource(run.id,draft(clean,checkpoint.anchorUrl),checkpoint.pages.indexOf(clean));
   store.addEvent(run.id,'source',store.getSource(run.id,clean.sourceKey));
  }
  checkpoint.notes=[...new Set([...(checkpoint.notes??[]),...result.limitations.map(v=>sanitizeText(v,500))])];
  checkpoint.coverageGaps=[...new Set([...(checkpoint.coverageGaps??[]),...(result.coverageGaps??[]).map(v=>sanitizeText(v,500)),...(result.nextCursor?['供应商返回下一页游标，历史尚未枚举完成。']:[])])];save();
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
  active();const step=checkpoint.steps;const budget=store.research.budget(run.id,limits);const activePages=stillActivePages();
  if(checkpoint.inspect&&!activePages.some(p=>p.sourceKey===checkpoint.inspect!.sourceKey))delete checkpoint.inspect;
  return await planner.decide({mode,claims,question:run.question,checkpoint:{...checkpoint,pages:activePages},remainingTools:remainingOf(limits.toolCalls,budget.toolCalls),remainingModels:remainingOf(limits.modelCalls,budget.modelCalls)},signal,async request=>{
    active();if(activePages.some(p=>!store.isResearchSourceActive(run.id,p.sourceKey,run.ownerId)))throw new ResearchStop('source_revoked');if(!options.transport||!options.deepseekApiKey)throw new ProviderError('provider_unavailable','DeepSeek 未配置。');
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
 // Completeness blockers are counted, never hidden: discovery-only sources,
 // unread discovered links, truncated originals and explicit unresolved items.
 const scopeGaps=()=>{const pages=stillActivePages();return {pages,
  discoveryOnly:pages.filter(p=>p.retrieval==='search'),
  unread:[...new Set(pages.flatMap(p=>p.links))].filter(url=>!pages.some(p=>p.url===url)),
  truncated:pages.filter(p=>p.textTruncated),
  unresolved:[...checkpoint.unknowns,...(checkpoint.coverageGaps??[])]};};
 const finish=(reason:string,state:'completed'|'partial'):ProviderResult=>{
  checkpoint.phase='done';checkpoint.stopReason=reason;
  if(!options.signal.aborted){checkpoint.elapsedMs=priorElapsed+Date.now()-launched;store.research.save(run.id,checkpoint);}
  const scope=scopeGaps();const pages=scope.pages;const keys=new Set(pages.map(p=>p.sourceKey));
  const claims=checkpoint.claims.filter(c=>keys.has(c.sourceKey)&&pages.some(p=>p.sourceKey===c.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile')));
  const coverage=researchDepthCoverage(claims,keys);
  const gaps=coverage.filter(c=>c.state==='gap').map(c=>`${c.label}：${c.note}`);
  const depthLimits=[...gaps,
   ...scope.discoveryOnly.length?[`${scope.discoveryOnly.length} 个来源只有搜索发现材料、未回读原文；只能当线索，不算已读证据。`]:[],
   ...scope.unread.length?[`还有 ${scope.unread.length} 条已发现链接未回读；它们是待判断线索，不等于均属于此人。`]:[],
   ...scope.truncated.length?[`${scope.truncated.length} 个来源的原文被截断或不完整；截断部分仍是缺口，不能当作完整原文。`]:[],
   ...scope.unresolved.length?[`还有 ${scope.unresolved.length} 项未解决记录（unresolved）；存在明确未解决项时不能称全平台或全部历史研究完成。`]:[]];
  const observations=claims.map(c=>({statement:c.statement,kind:c.kind,sourceKeys:[c.sourceKey],limitations:['来源原文摘录；身份归属与独立事实核实另行判断。']}));
  const budget=store.research.budget(run.id,limits);
  return {state,identity:checkpoint.identity??{displayName:'',handle:null,profileUrl:checkpoint.anchorUrl,status:'needs_input',note:'尚未确认公开主页。',candidates:checkpoint.candidates},sources:checkpoint.pages.map(p=>draft(p,checkpoint.anchorUrl)),observations,
   answer:(['background','work','expression','analysis'] as const).map(section=>({id:section,heading:({background:'背景与经历',work:'作品与行动',expression:'公开表达',analysis:'分析与不确定性'})[section],body:'',bullets:claims.filter(c=>c.section===section).map(c=>({text:c.statement,sourceKeys:[c.sourceKey],kind:c.kind}))})).filter(section=>section.bullets.length>0),limitations:[...new Set([...checkpoint.unknowns,...(checkpoint.notes??[]),...(checkpoint.coverageGaps??[]),...depthLimits,...state==='partial'?[`研究已停止：${reason}。已有材料保留，未证实的内容不补写。`]:[]])],usage:{requests:budget.toolCalls+budget.modelCalls,bytes:store.research.receipts(run.id).reduce((n,r)=>n+(r.usage?.bytes??0),0)},stopReason:reason};
 };
 const verify=async():Promise<ProviderResult>=>{
  const claims=checkpoint.pendingClaims??[];
  const quoteFallback=(reason:'verification_budget'|'verification_unavailable'):ProviderResult=>{
   options.signal.throwIfAborted();store.research.assertActive(run.id);
   const pages=stillActivePages();
   checkpoint.claims=claims.filter(c=>pages.some(p=>p.sourceKey===c.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile')&&p.text.includes(c.quote))).map(c=>({...c,statement:c.quote,kind:'page_statement',verified:false}));delete checkpoint.pendingClaims;
   checkpoint.unknowns.push('综合结论未通过独立语义核验，仅保留来源逐字摘录；摘录不代表结论已核实。');
   return finish(reason,'partial');
  };
  if(limits.modelCalls>0&&(checkpoint.steps>=limits.modelCalls||store.research.budget(run.id,limits).modelCalls>=limits.modelCalls)){
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
  checkpoint.claims=claims.filter((_c,index)=>supported.has(index)).map(c=>({...c,verified:true}));delete checkpoint.pendingClaims;checkpoint.steps++;
  if(Array.isArray(checked.rejected))for(const item of checked.rejected)if(object(item)&&typeof item.reason==='string')checkpoint.unknowns.push(sanitizeText(item.reason,500));
  const coverage=researchDepthCoverage(checkpoint.claims,new Set(stillActivePages().filter(p=>(p.retrieval==='read'||p.retrieval==='profile')).map(p=>p.sourceKey)));
  // Five facets with evidence never prove all-platform or full-history
  // completion: any discovery-only source, unread discovered link, truncated
  // original or explicit unresolved record keeps the run partial.
  const scope=scopeGaps();
  const complete=checkpoint.claims.length>0&&scope.pages.length>1&&supported.size===claims.length&&coverage.every(c=>c.state==='evidence_found')
   &&scope.discoveryOnly.length===0&&scope.unread.length===0&&scope.truncated.length===0&&scope.unresolved.length===0;
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
    const inherited=parentCheckpoint.pages.filter(p=>activeKeys.has(p.sourceKey));
    const remap=new Map(inherited.map((p,index)=>[p.sourceKey,`S${index+1}`]));
    checkpoint.pages=inherited.map(p=>({...p,sourceKey:remap.get(p.sourceKey)!,discoveredFrom:p.discoveredFrom?.map(key=>remap.get(key)).filter((key):key is string=>!!key),inheritedFrom:{runId:parent.id,sourceKey:p.sourceKey}}));
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
   checkpoint.candidates=[];ingest(result,action);save();
  }
  if(checkpoint.pendingClaims)return await verify();
  const seen=new Set(store.research.receipts(run.id).filter(r=>r.kind==='tool').map(r=>digest(r.request)));
  while(limits.modelCalls===0||checkpoint.steps<limits.modelCalls-1){
   active();progress('planning');
   const step=checkpoint.steps;
   const budget=store.research.budget(run.id,limits);
   const activePages=stillActivePages();
   const decision=await ask('plan');
   active();
   if(!object(decision)||typeof decision.action!=='string')throw new ResearchStop('invalid_decision');
   if(decision.action==='finish'){
    if(!Array.isArray(decision.claims))throw new ResearchStop('invalid_evidence');
    const claims:ResearchClaim[]=decision.claims.map(raw=>{
     if(!object(raw)||typeof raw.sourceKey!=='string'||typeof raw.quote!=='string'||raw.quote.length<3||raw.quote.length>600)throw new ResearchStop('invalid_evidence');
     const page=activePages.find(p=>p.sourceKey===raw.sourceKey);if(!page||(page.retrieval!=='read'&&page.retrieval!=='profile')||!page.text.includes(raw.quote))throw new ResearchStop('invalid_evidence');
     const kind=raw.kind??'page_statement';if(!['attributed_statement','page_statement','inference'].includes(String(kind)))throw new ResearchStop('invalid_evidence');
     const section=raw.section??(kind==='inference'?'analysis':'work');if(!['background','work','expression','analysis'].includes(String(section)))throw new ResearchStop('invalid_evidence');
     const statement=typeof raw.statement==='string'?sanitizeText(raw.statement,600):raw.quote;if(!statement)throw new ResearchStop('invalid_evidence');
     const facet=raw.facet;
     if(facet!==undefined&&!RESEARCH_FACETS.some(f=>f.id===facet))throw new ResearchStop('invalid_evidence');
     return {sourceKey:raw.sourceKey,quote:raw.quote,statement,kind:kind as ResearchClaim['kind'],section:section as ResearchClaim['section'],...(facet?{facet:facet as ResearchFacet}:{})};
    });
    checkpoint.claims=[];checkpoint.pendingClaims=claims;checkpoint.steps++;
    checkpoint.unknowns=[...new Set([...checkpoint.unknowns,...Array.isArray(decision.unknowns)?decision.unknowns.filter((v):v is string=>typeof v==='string').map(v=>sanitizeText(v,600)):[]])];
    checkpoint.phase='verifying';save();return await verify();
   }
   const decisions=decision.action==='batch'?decision.actions:[decision];
   if(!Array.isArray(decisions)||decisions.length<1||decisions.length>4)throw new ResearchStop('invalid_decision');
   type Planned={kind:'inspect';sourceKey:string;offset:number}|{kind:'catalog';offset:number;linkOffset:number;unknownOffset:number}|{kind:'tool';action:ResearchToolAction};
   // Validate the whole batch before any request or local inspect.
   const planned:Planned[]=decisions.map(item=>{
    if(!object(item))throw new ResearchStop('invalid_decision');
    if(item.action==='catalog'){
     const values=[item.offset,item.linkOffset??0,item.unknownOffset??0];
     if(values.some(v=>typeof v!=='number'||!Number.isSafeInteger(v)||v<0))throw new ResearchStop('invalid_decision');
     return {kind:'catalog',offset:Number(values[0]),linkOffset:Number(values[1]),unknownOffset:Number(values[2])};
    }
    if(item.action==='inspect'){
     // Offline local excerpt of an already stored source: no provider request.
     if(typeof item.sourceKey!=='string'||typeof item.offset!=='number'||!Number.isSafeInteger(item.offset)||item.offset<0)throw new ResearchStop('invalid_decision');
     return {kind:'inspect',sourceKey:item.sourceKey,offset:item.offset};
    }
    if(item.action==='search'&&typeof item.query==='string')return {kind:'tool',action:{type:'search',query:item.query.trim()}};
    if(['read','social','social_posts','firecrawl'].includes(String(item.action))&&typeof item.url==='string'){
     const url=normalizeResearchUrl(item.url);if(!url)throw new ResearchStop('url_not_discovered');
     return {kind:'tool',action:{type:item.action==='social'?'social_profile':item.action as 'read'|'social_posts'|'firecrawl',url}};
    }
    throw new ResearchStop('invalid_decision');
   });
   for(const step of planned){
    if(step.kind!=='tool')continue;
    const action=step.action;
    if(action.type==='search'){if(!action.query.trim()||action.query.length>600)throw new ResearchStop('invalid_decision');}
    else {const url=normalizeResearchUrl(action.url);if(!url||!allowedUrls().has(url))throw new ResearchStop('url_not_discovered');}
   }
   let madeProgress=false;
   const localWindows=new Set(checkpoint.localWindows??[]);
   for(const step of planned){
    active();
    if(step.kind==='catalog'){
     const activePages=stillActivePages();const offset=Math.min(step.offset,Math.max(0,activePages.length-1));
     const maxLinks=Math.max(0,...activePages.slice(offset,offset+12).map(p=>p.links.length-1));
     const selected={offset,linkOffset:Math.min(step.linkOffset,maxLinks),unknownOffset:Math.min(step.unknownOffset,Math.max(0,checkpoint.unknowns.length-1))};
     const signature='catalog:'+digest({pages:stillActivePages().slice(selected.offset,selected.offset+12).map(p=>({key:p.sourceKey,text:p.text.slice(0,600),links:p.links.slice(selected.linkOffset,selected.linkOffset+20)})),unknowns:checkpoint.unknowns.slice(selected.unknownOffset,selected.unknownOffset+30)});
     if(!localWindows.has(signature)){localWindows.add(signature);checkpoint.catalog=selected;madeProgress=true;checkpoint.localWindows=[...localWindows];save();}
     continue;
    }
    if(step.kind==='inspect'){
     // Selecting a stored excerpt is free and offline. Inactive or unknown
     // sources are denied: nothing is served and no receipt is created.
     const page=checkpoint.pages.find(p=>p.sourceKey===step.sourceKey);
     if(!page)throw new ResearchStop('invalid_decision');
     if(!stillActivePages().some(p=>p.sourceKey===step.sourceKey))throw new ResearchStop('source_revoked');
     const selected={sourceKey:page.sourceKey,offset:Math.min(step.offset,page.text.length)};
     const signature='inspect:'+digest({sourceKey:selected.sourceKey,text:page.text.slice(selected.offset,selected.offset+4000)});
     if(!localWindows.has(signature)){localWindows.add(signature);checkpoint.inspect=selected;madeProgress=true;checkpoint.localWindows=[...localWindows];}
     save();continue;
    }
    const action=step.action;
    if(limits.toolCalls>0&&store.research.budget(run.id,limits).toolCalls>=limits.toolCalls){checkpoint.unknowns.push('本批读取额度已用完，剩余线索未读；保留分析与独立核验机会。');break;}
    const discoveredFrom=dependencies(action);
    const signature=digest(action);
    if(seen.has(signature)){checkpoint.unknowns.push('同一资料动作已执行，不重复付费；需要选择新的证据线索。');continue;}
    seen.add(signature);madeProgress=true;progress(action.type==='search'?'searching':'reading');
    try{const result=await perform(action);
     if(discoveredFrom.length&&!discoveredFrom.some(key=>store.isResearchSourceActive(run.id,key,run.ownerId)))throw new ResearchStop('source_revoked');
     ingest(result,action,discoveredFrom);}
    catch(error){
     if(options.signal.aborted||deadline.signal.aborted)throw error;
     // A known adapter failure is a gap in this branch, not the end of all research.
     // Its settled attempt is retained and never retried automatically.
     if(error instanceof ProviderError){checkpoint.unknowns.push(`资料分支未读成功：${action.type==='search'?'检索':action.url}（${error.code}）；不代表无资料。`);save();continue;}
     throw error;
    }
   }
   checkpoint.steps++;save();
   if(!madeProgress&&limits.modelCalls===0)return finish(limits.toolCalls>0&&store.research.budget(run.id,limits).toolCalls>=limits.toolCalls?'budget_exhausted':'no_new_evidence','partial');
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
