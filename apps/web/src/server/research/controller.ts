import { RESEARCH_FACETS, researchDepthCoverage, claimEvidenceIssue, quoteHasFirstPerson, type ResearchFacet } from '../../shared/research-depth.js';
import { createHash } from 'node:crypto';
import { NeedsInputError, type IdentityCandidate, type ProviderResult, type ResearchBudgetLimits, type SourceDraft } from '../../shared/types.js';
import { extractGitHubHandle, normalizeResearchUrl, sanitizeText } from '../../shared/validation.js';
import { ProviderError, type HttpTransport } from '../adapters/types.js';
import type { Store, RunRecord } from '../store.js';
import { type ResearchPlanner, invokeDeepSeek, parseMessagesUsage, estimateModelUsd } from './planner.js';
import { RESEARCH_LIMITS, ResearchStop, remainingOf, type ActionUsage, type ResearchCheckpoint, type StoredPage, type ResearchClaim } from './research-store.js';
import { FirstStepSelectionError } from './first-step-store.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from './tool-contracts.js';

/** Optional fail-closed scope check run BEFORE any metered reservation exists. */
export interface ScopedResearchTools extends ResearchTools { predispatch?(action:ResearchToolAction):void; }
export interface ResearchOptions {
 store:Store;run:RunRecord;tools:ScopedResearchTools;planner:ResearchPlanner;signal:AbortSignal;
 transport?:HttpTransport;deepseekApiKey?:string|null;socialAvailable?:boolean;firecrawlAvailable?:boolean;
 limits?:ResearchBudgetLimits;
 /** First-step fetch scope: independent-account material never joins person claims. */
 firstStepScope?:{assertCurrent?:()=>void;selectedAccountKeys?:ReadonlySet<string>;independentAccountKeys:ReadonlySet<string>;accountKeyOf:(url:string)=>string|null};
}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
interface RefusalRecord { dispatched:boolean; usage?:ActionUsage }
const refusalRecords=new WeakMap<object,RefusalRecord>();
/** Tag a scope-guard refusal with dispatch provenance so metering stays honest. */
export function tagScopeRefusal<T>(error:T,record:RefusalRecord):T {
 if(error&&(typeof error==='object'||typeof error==='function'))refusalRecords.set(error as object,record);
 return error;
}
export function scopeRefusalRecord(error:unknown):RefusalRecord|null {
 return error&&(typeof error==='object'||typeof error==='function')?refusalRecords.get(error as object)??null:null;
}
/** Honest failure metering: a predispatch refusal is never billed; a refused late ingest keeps its dispatched cost. */
export function failedUsage(error:unknown):ActionUsage {
 const record=scopeRefusalRecord(error);
 if(!record)return {estimatedUsd:null,unknownCost:true};
 return record.dispatched?(record.usage??{estimatedUsd:null,unknownCost:true}):{inputTokens:0,outputTokens:0,estimatedUsd:0,credits:0,unknownCost:false};
}
/** Scope withdrawal/revocation always stops; it is never a gap to plan around. */
function isScopeStop(error:unknown):boolean {
 return (error instanceof ResearchStop&&error.code==='source_revoked')||(error instanceof FirstStepSelectionError&&error.code==='scope_changed');
}
function digest(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}
function candidateId(url:string):string{return 'candidate_'+digest(url);}
/** Keep everything a tool supplied: only control characters are stripped. */
function retainText(value:unknown):string{return sanitizeText(value,Number.MAX_SAFE_INTEGER);}
function draft(page:StoredPage,anchor:string|null,scope?:ResearchOptions['firstStepScope']):SourceDraft{
 const key=scope?.accountKeyOf(page.url)??null;
 const independent=!!(key&&scope?.independentAccountKeys.has(key));
 const selected=!!(key&&scope?.selectedAccountKeys?.has(key));
 return {key:page.sourceKey,url:page.url,title:page.title,kind:page.kind,publishedAt:page.publishedAt,excerpt:page.text,excerptLocator:page.retrieval==='search'?'搜索发现材料，尚未回读原文':'公开页面文本',
 identityLabel:independent?'独立账号范围：尚未证明与其他账号同人':page.url===anchor?(scope?'所选公开主页；归属依据见第一步':'所选公开主页'):selected?'已选人物账号范围；归属依据见第一步':'来源归属未独立验证',identityConfirmed:!scope&&page.url===anchor&&!independent,fetchStatus:page.text?'ok':'inaccessible',
 limits:[...page.limitations,...independent?['独立账号材料：只作该账号自身记录，不并入同一人物结论。']:page.url===anchor?['主页内容由该账号维护；不代表跨平台身份已核实。']:selected?['来自已确认研究范围的账号；账号自述不等于内容已独立证实。']:['与研究对象的关系需结合原文核对，不因同名自动合并。']]};}
function stillActivePagesOf(store:Store,run:RunRecord,checkpoint:ResearchCheckpoint):StoredPage[]{
 return checkpoint.pages.filter(page=>store.isResearchSourceActive(run.id,page.sourceKey,run.ownerId));
}
function currentReadFailureGaps(store:Store,run:RunRecord,checkpoint:ResearchCheckpoint,pages:StoredPage[]):string[]{
 const completed=store.research.receipts(run.id).filter(r=>r.kind==='tool'&&r.state==='completed');
 return [...new Set((checkpoint.actionFailures??[]).filter(f=>{
  const action=f.action;if(action.type==='search')return true;
  return !completed.some(r=>{
   if(!object(r.request)||!object(r.result)||!Array.isArray(r.result.pages))return false;
   const native=action.type==='social_posts'||action.type==='social_profile'||action.type==='github_profile';
   if(native&&(r.request.type!==action.type||r.request.url!==action.url))return false;
   if(!native&&!['read','firecrawl','social_posts'].includes(String(r.request.type)))return false;
   return r.result.pages.some((p:unknown)=>object(p)&&typeof p.text==='string'&&p.text.trim().length>0&&(action.type==='social_posts'?p.kind==='work':p.url===action.url)&&pages.some(active=>active.url===p.url&&active.text===retainText(p.text)&&active.kind===p.kind&&(action.type==='social_posts'||active.retrieval==='read'||native)));
  });
 }).map(f=>`当前未取得相应原文：${f.action.type==='search'?'检索':f.action.url}（${f.action.type}，${f.code}）；该次尝试与费用保存在实际回执，不代表资料不存在。`))];
}
function scopeGapsOf(store:Store,run:RunRecord,checkpoint:ResearchCheckpoint){
 const pages=stillActivePagesOf(store,run,checkpoint);
 return {pages,
  discoveryOnly:pages.filter(p=>p.retrieval==='search'),
  unread:[...new Set(pages.flatMap(p=>p.links))].filter(url=>!pages.some(p=>p.url===url)),
  truncated:pages.filter(p=>p.textTruncated),
  readFailureGaps:currentReadFailureGaps(store,run,checkpoint,pages),
  unresolved:[...checkpoint.unknowns,...(checkpoint.coverageGaps??[]),...currentReadFailureGaps(store,run,checkpoint,pages)]};
}
export interface ResearchReportContext {
 store:Store;run:RunRecord;checkpoint:ResearchCheckpoint;limits:ResearchBudgetLimits;
 /** First-step fetch scope: independent-account material never joins person claims. */
 firstStepScope?:ResearchOptions['firstStepScope'];
}
/** Deterministic report from the preserved checkpoint: never invents facts, keeps every gap. */
export function buildResearchReport(context:ResearchReportContext,reason:string,state:'completed'|'partial'):ProviderResult{
 const {store,run,checkpoint,limits}=context;
 const scopeStop=reason==='scope_changed'||reason==='source_revoked';
 checkpoint.phase='done';checkpoint.stopReason=reason;
 const scope=scopeGapsOf(store,run,checkpoint);const pages=scope.pages;const keys=new Set(pages.map(p=>p.sourceKey));
 const eligibleClaims=checkpoint.claims.filter(c=>keys.has(c.sourceKey)&&pages.some(p=>p.sourceKey===c.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile')));
 const sourceClaims=eligibleClaims.filter(c=>pages.some(p=>p.sourceKey===c.sourceKey&&p.text.includes(c.quote)));
 const invalidQuotes=eligibleClaims.filter(c=>!sourceClaims.includes(c));
 const scopeRejected=sourceClaims.filter(c=>claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)!==null);
 const claims=sourceClaims.filter(c=>claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)===null);
 if(scopeRejected.length||invalidQuotes.length){state='partial';if(!scopeStop){reason=scopeRejected.length?'claim_scope_unverified':'invalid_evidence';checkpoint.stopReason=reason;}}
 const coverage=researchDepthCoverage(claims,keys);
 const gaps=coverage.filter(c=>c.state==='gap').map(c=>`${c.label}：${c.note}`);
 const depthLimits=[...gaps,...scopeRejected.map(c=>`${c.sourceKey}：${claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)}`),...invalidQuotes.map(c=>`${c.sourceKey}：引用不在该来源原文中，原陈述保留待核对。`),
  ...scope.discoveryOnly.length?[`${scope.discoveryOnly.length} 个来源只有搜索发现材料、未回读原文；只能当线索，不算已读证据。`]:[],
  ...scope.unread.length?[`还有 ${scope.unread.length} 条已发现链接未回读；它们是待判断线索，不等于均属于此人。`]:[],
  ...scope.truncated.length?[`${scope.truncated.length} 个来源的原文被截断或不完整；截断部分仍是缺口，不能当作完整原文。`]:[],
  ...scope.unresolved.length?[`还有 ${scope.unresolved.length} 项未解决记录（unresolved）；存在明确未解决项时不能称全平台或全部历史研究完成。`]:[]];
 const observations=claims.map(c=>({statement:c.statement,kind:c.kind,sourceKeys:[c.sourceKey],limitations:['来源原文摘录；身份归属与独立事实核实另行判断。']}));
 const budget=store.research.budget(run.id,limits);
 const identity=checkpoint.identity??{displayName:'',handle:null,profileUrl:checkpoint.anchorUrl,status:'needs_input',note:'尚未确认公开主页。',candidates:checkpoint.candidates};
 return {state,identity:scopeStop&&checkpoint.identity?{...identity,note:`${identity.note?`${identity.note} `:''}冻结范围已失效或撤回（${reason}）：已读材料保留待复核，不能据此继续人物结论。`}:identity,sources:checkpoint.pages.map(p=>draft(p,checkpoint.anchorUrl,context.firstStepScope)),observations,
  answer:(['background','work','expression','analysis'] as const).map(section=>({id:section,heading:({background:'背景与经历',work:'作品与行动',expression:'公开表达',analysis:'分析与不确定性'})[section],body:'',bullets:claims.filter(c=>c.section===section).map(c=>({text:c.statement,sourceKeys:[c.sourceKey],kind:c.kind}))})).filter(section=>section.bullets.length>0),limitations:[...new Set([...checkpoint.unknowns,...(checkpoint.notes??[]),...(checkpoint.coverageGaps??[]),...scope.readFailureGaps,...depthLimits,...state==='partial'?[`研究已停止：${reason}。已有材料保留，未证实的内容不补写。`]:[],...scopeStop?['冻结范围已失效或撤回：如需继续，请通过现有第一步流程以新的范围重新开始研究。']:[]])],usage:{requests:budget.toolCalls+budget.modelCalls,bytes:store.research.receipts(run.id).reduce((n,r)=>n+(r.usage?.bytes??0),0)},stopReason:reason};
}

export async function runResearch(options:ResearchOptions):Promise<ProviderResult>{
 const {store,run,tools,planner}=options;
 const persisted=store.research.checkpoint(run.id);
 const limits=persisted?(persisted.limits??(persisted.firstStep?options.limits:undefined)??RESEARCH_LIMITS):(options.limits??RESEARCH_LIMITS);
 const launched=Date.now();
 const checkpoint:ResearchCheckpoint=persisted??{phase:'identity',steps:0,startedAt:launched,elapsedMs:0,anchorUrl:normalizeResearchUrl(run.seedUrl),identity:null,candidates:[],pages:[],claims:[],unknowns:[],stopReason:null};
 checkpoint.limits??={...limits};
 if(options.firstStepScope)checkpoint.quoteRolePolicy??='preserve_actor/v1';
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
 const active=()=>{signal.throwIfAborted();store.research.assertActive(run.id);options.firstStepScope?.assertCurrent?.();if(limits.elapsedMs>0&&priorElapsed+Date.now()-launched>=limits.elapsedMs)throw new ResearchStop('budget_exhausted');};
 const save=()=>{active();checkpoint.elapsedMs=priorElapsed+Date.now()-launched;store.research.save(run.id,checkpoint);};
 const progress=(phase:string)=>{checkpoint.phase=phase;save();store.addEvent(run.id,'stage',{index:checkpoint.steps,total:limits.toolCalls,key:phase,label:phase==='identity'?'确认公开主页':phase==='planning'?'整理资料与缺口':phase==='verifying'?'核验引文与陈述':'读取相关资料',status:'active'});};
 const stillActivePages=()=>stillActivePagesOf(store,run,checkpoint);
 // Concrete scoped articles keep their observed URL. Legacy normalization
 // removes trailing slashes for anchor keys and is not a transport alias proof.
 const researchUrl=(raw:unknown):string|null=>{
  const normalized=normalizeResearchUrl(raw);if(!normalized)return null;
  if(!options.firstStepScope)return normalized;
  const url=new URL(raw as string);url.hash='';return url.href;
 };
 const allowedUrls=()=>new Set([checkpoint.anchorUrl,...stillActivePages().flatMap(p=>[p.url,...p.links])].map(researchUrl).filter((v):v is string=>!!v));
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
   const url=researchUrl(page.url);if(!url)continue;
   const existing=checkpoint.pages.find(p=>p.url===url);
   const retrieval=action.type==='search'?'search':action.type==='github_profile'||action.type==='social_profile'?'profile':'read';
   const clean:StoredPage={...page,retrieval,url,title:sanitizeText(page.title,200),text:retainText(page.text),links:[...new Set(page.links.map(researchUrl).filter((v):v is string=>!!v))],limitations:page.limitations.map(v=>sanitizeText(v,500)),sourceKey:existing?.sourceKey??`S${checkpoint.pages.length+1}`,...existing?.inheritedFrom?{inheritedFrom:existing.inheritedFrom}:{},...discoveredFrom.length?{discoveredFrom:[...discoveredFrom]}:{}};
   // Search can enrich discovery but cannot replace an already fetched original.
   if(existing&&(existing.retrieval==='read'||existing.retrieval==='profile')&&retrieval==='search'){
    clean.text=existing.text;clean.title=existing.title;clean.retrieval=existing.retrieval;clean.kind=existing.kind;clean.publishedAt=existing.publishedAt;clean.author=existing.author;clean.retrievedAt=existing.retrievedAt;clean.textTruncated=existing.textTruncated;clean.account=existing.account;clean.discoveredFrom=existing.discoveredFrom;
    // Links remain discovery-only; they never inherit the original's factual support.
    clean.links=[...new Set([...existing.links,...clean.links])];clean.limitations=existing.limitations;
   }
   if(existing)checkpoint.pages[checkpoint.pages.indexOf(existing)]=clean;else checkpoint.pages.push(clean);
   store.addSource(run.id,draft(clean,checkpoint.anchorUrl,options.firstStepScope),checkpoint.pages.indexOf(clean));
   store.addEvent(run.id,'source',store.getSource(run.id,clean.sourceKey));
  }
  checkpoint.notes=[...new Set([...(checkpoint.notes??[]),...result.limitations.map(v=>sanitizeText(v,500))])];
  checkpoint.coverageGaps=[...new Set([...(checkpoint.coverageGaps??[]),...(result.coverageGaps??[]).map(v=>sanitizeText(v,500)),...(result.nextCursor?['供应商返回下一页游标，历史尚未枚举完成。']:[])])];save();
 };
 const perform=async(action:ResearchToolAction):Promise<ResearchToolResult>=>{
  active();
  if(action.type!=='search'){
   const url=researchUrl(action.url);
   if(!url||!allowedUrls().has(url))throw new ResearchStop('url_not_discovered');
   action={...action,url};
   if(action.type==='firecrawl'&&(!options.firecrawlAvailable||['x.com','twitter.com'].includes(new URL(url).hostname)))throw new ResearchStop('tool_unavailable');
   if((action.type==='social_profile'||action.type==='social_posts')&&!options.socialAvailable)throw new ResearchStop('tool_unavailable');
  }else if(!action.query.trim()||action.query.length>600)throw new ResearchStop('invalid_decision');
  // A scope refusal rejects BEFORE any metered reservation: never billed, no receipt.
  options.tools.predispatch?.(action);
  const key='tool:'+digest(action);
  const old=store.research.reserve(run.id,key,'tool',action,{inputTokens:0,outputTokens:0},limits,Boolean(options.firstStepScope));
  if(old){if(old.state==='failed')throw new ProviderError('provider_bad_response','资料请求已有已结算失败回执，不自动重放。');return old.result as ResearchToolResult;}
  try{
   const result=await tools.execute(action,signal);
   if(result.requests!==1)throw new ResearchStop('tool_contract_violation');
   store.research.settle(run.id,key,result,{estimatedUsd:result.estimatedUsd,credits:result.credits,bytes:result.bytes,unknownCost:result.estimatedUsd===null});
   active();return result;
  }catch(error){
   if(!options.signal.aborted){try{store.research.settle(run.id,key,null,failedUsage(error),'failed');}catch{/* A cancelled/deleted run cannot accept late receipts. */}}
   throw error;
  }
 };
 const ask=async(mode:'plan'|'verify',claims?:ResearchClaim[]):Promise<unknown>=>{
  active();const step=checkpoint.steps;const budget=store.research.budget(run.id,limits);const activePages=stillActivePages();
  if(checkpoint.inspect&&!activePages.some(p=>p.sourceKey===checkpoint.inspect!.sourceKey))delete checkpoint.inspect;
  if(checkpoint.inspectWindows)checkpoint.inspectWindows=checkpoint.inspectWindows.filter(w=>activePages.some(p=>p.sourceKey===w.sourceKey)).slice(0,4);
  const decision=await planner.decide({mode,claims,question:run.question,checkpoint:{...checkpoint,pages:activePages,unknowns:[...checkpoint.unknowns,...currentReadFailureGaps(store,run,checkpoint,activePages)]},remainingTools:remainingOf(limits.toolCalls,budget.toolCalls),remainingModels:remainingOf(limits.modelCalls,budget.modelCalls)},signal,async request=>{
    active();if(activePages.some(p=>!store.isResearchSourceActive(run.id,p.sourceKey,run.ownerId)))throw new ResearchStop('source_revoked');if(!options.transport||!options.deepseekApiKey)throw new ProviderError('provider_unavailable','DeepSeek 未配置。');
    if(request.body.max_tokens!==2500)throw new ResearchStop('model_contract_violation');
    const verificationPolicy=mode==='verify'&&checkpoint.quoteSupportPolicy==='exact_quote/v1'?'exact_quote/v1':null;
    const attributionPolicy=mode==='verify'?checkpoint.quoteAttributionPolicy:null;
    const lexicalPolicy=mode==='verify'?checkpoint.quoteLexicalPolicy:null;
    const rolePolicy=checkpoint.quoteRolePolicy;
    const key=`model:${step}${verificationPolicy?':quote_only_v1':''}${attributionPolicy?':attribution_v1':''}${lexicalPolicy?':literal_terms_v1':''}${rolePolicy?':preserve_actor_v1':''}`;const inputBound=Buffer.byteLength(JSON.stringify(request.body));
    const old=store.research.reserve(run.id,key,'model',{model:request.body.model,path:request.path,...(verificationPolicy?{verificationPolicy}:{}),...(attributionPolicy?{attributionPolicy}:{}),...(lexicalPolicy?{lexicalPolicy}:{}),...(rolePolicy?{rolePolicy}:{})},{inputTokens:inputBound,outputTokens:2500},limits,Boolean(options.firstStepScope));
    if(old){if(old.state==='failed')throw new ProviderError('provider_bad_response','模型请求已有已结算失败回执，不自动重放。');return old.result as Awaited<ReturnType<typeof invokeDeepSeek>>;}
    try{const result=await invokeDeepSeek(options.transport,options.deepseekApiKey,request);
     const usage=parseMessagesUsage(result.body);
     store.research.settle(run.id,key,result,{inputTokens:usage.known?usage.inputTokens:inputBound,outputTokens:usage.known?usage.outputTokens:2500,estimatedUsd:usage.known?estimateModelUsd(String(request.body.model),usage.inputTokens,usage.outputTokens):null,unknownCost:!usage.known||estimateModelUsd(String(request.body.model),usage.inputTokens,usage.outputTokens)===null,bytes:Buffer.byteLength(result.body)});
     active();return result;
    }catch(error){if(!options.signal.aborted){try{store.research.settle(run.id,key,null,{estimatedUsd:null,unknownCost:true},'failed');}catch{}}throw error;}
   });
  active();return decision;
 };
 // Completeness blockers are counted, never hidden: discovery-only sources,
 // unread discovered links, truncated originals and explicit unresolved items.
 const scopeGaps=()=>scopeGapsOf(store,run,checkpoint);
 const finish=(reason:string,state:'completed'|'partial'):ProviderResult=>{
  if(!options.signal.aborted&&reason!=='scope_changed'&&reason!=='source_revoked')options.firstStepScope?.assertCurrent?.();
  if(!options.signal.aborted){checkpoint.elapsedMs=priorElapsed+Date.now()-launched;}
  const result=buildResearchReport({store,run,checkpoint,limits,firstStepScope:options.firstStepScope},reason,state);
  if(!options.signal.aborted){store.research.save(run.id,checkpoint);}
  return result;
 };
 const verify=async():Promise<ProviderResult|null>=>{
  let claims=checkpoint.pendingClaims??[];
  const quoteFallback=(reason:'verification_budget'|'verification_unavailable'):ProviderResult=>{
   active();
   const pages=stillActivePages();
   const excerpts=claims.filter(c=>pages.some(p=>p.sourceKey===c.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile')&&p.text.includes(c.quote))).map(c=>({...c,statement:c.quote,kind:'page_statement' as const,verified:false}));
   const retained=options.firstStepScope?checkpoint.claims.filter(c=>c.verified===true&&claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)===null&&pages.some(p=>p.sourceKey===c.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile')&&p.text.includes(c.quote))):[];
   checkpoint.claims=[...retained,...excerpts];delete checkpoint.pendingClaims;
   checkpoint.unknowns.push('综合结论未通过独立语义核验，仅保留来源逐字摘录；摘录不代表结论已核实。');
   return finish(reason,'partial');
  };
  if(limits.modelCalls>0&&(checkpoint.steps>=limits.modelCalls||store.research.budget(run.id,limits).modelCalls>=limits.modelCalls)){
   return quoteFallback('verification_budget');
  }
  if(options.firstStepScope){
   claims=claims.map(c=>{
    const page=stillActivePages().find(p=>p.sourceKey===c.sourceKey);
    const nativeAuthor=page?.retrieval==='read'&&page.kind==='work'&&!!page.account?.id&&!!page.author&&page.author.toLowerCase()===page.account.handle.toLowerCase();
    return {...c,authorialBasis:quoteHasFirstPerson(c.quote)?'quote_first_person' as const:nativeAuthor?'native_authored_post' as const:'page_text' as const,quoteLexicalPolicy:'literal_terms/v1' as const,quoteRolePolicy:'preserve_actor/v1' as const,sourceReadKind:page?.kind,sourceReadUrl:page?.url};
   });
   checkpoint.pendingClaims=claims;checkpoint.quoteSupportPolicy='exact_quote/v1';checkpoint.quoteAttributionPolicy='quote_attribution/v1';checkpoint.quoteLexicalPolicy='literal_terms/v1';checkpoint.quoteRolePolicy='preserve_actor/v1';save();
  }
  progress('verifying');
  let checked:unknown;
  try{checked=await ask('verify',claims);}catch(error){
   if(options.signal.aborted)throw error;
   // Scope withdrawal stops with its explicit reason; it never rewrites claims.
   if(isScopeStop(error))throw error;
   return quoteFallback('verification_unavailable');
  }
  active();
  if(claims.some(c=>!stillActivePages().some(p=>p.sourceKey===c.sourceKey)))throw new ResearchStop('source_revoked');
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
  const scopeRejected=claims.filter((c,index)=>supported.has(index)&&claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)!==null);
  const approved=claims.filter((c,index)=>supported.has(index)&&claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)===null).map(c=>({...c,verified:true}));
  const retained=options.firstStepScope?checkpoint.claims.filter(c=>c.verified===true&&claimEvidenceIssue(c,checkpoint.quoteSupportPolicy)===null&&stillActivePages().some(p=>p.sourceKey===c.sourceKey&&(p.retrieval==='read'||p.retrieval==='profile')&&p.text.includes(c.quote))):[];
  checkpoint.claims=[...new Map([...retained,...approved].map(c=>[digest({...c,verified:undefined}),c])).values()];delete checkpoint.pendingClaims;checkpoint.steps++;
  const feedback=[...(checked.rejected as Array<{index:number;reason:string}>).map(item=>({claim:claims[item.index]!,reason:sanitizeText(item.reason,500)})),...scopeRejected.map(claim=>({claim,reason:claimEvidenceIssue(claim,checkpoint.quoteSupportPolicy)!}))];
  if(checkpoint.quoteLexicalPolicy){
   checkpoint.verificationHistory=[...(checkpoint.verificationHistory??[]),{step:checkpoint.steps,policy:checkpoint.quoteLexicalPolicy,rejections:feedback}];
  }else{
   for(const claim of scopeRejected)checkpoint.unknowns.push(`${claim.sourceKey}：${claimEvidenceIssue(claim,checkpoint.quoteSupportPolicy)}`);
   if(Array.isArray(checked.rejected))for(const item of checked.rejected)if(object(item)&&typeof item.reason==='string')checkpoint.unknowns.push(sanitizeText(item.reason,500));
  }
  if(options.firstStepScope&&feedback.length&&(checkpoint.claimRepairRounds??0)<2){
   const remaining=remainingOf(limits.modelCalls,store.research.budget(run.id,limits).modelCalls);
   if((remaining===null||remaining>=2)&&(limits.modelCalls===0||checkpoint.steps<=limits.modelCalls-2)){
    checkpoint.claimRepairRounds=(checkpoint.claimRepairRounds??0)+1;
    checkpoint.verificationFeedback=feedback;checkpoint.phase='planning';save();
    store.addEvent(run.id,'stage',{key:`claim_repair:${checkpoint.claimRepairRounds}`,label:'按原文修正未通过核验的陈述',status:'active'});
    return null;
   }
  }
  if(checkpoint.quoteLexicalPolicy&&feedback.length){
   for(const claim of scopeRejected)checkpoint.unknowns.push(`${claim.sourceKey}：${claimEvidenceIssue(claim,checkpoint.quoteSupportPolicy)}`);
   if(rejectedIndexes.length)checkpoint.unknowns.push(`最终核验仍有 ${rejectedIndexes.length} 条提案未获得完整支持，未作为结论；原提案及拒绝理由保存在核验历史与实际回执。`);
  }
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
  // First-step fetch separates KNOWN settled discovery failures (inspectable
  // gaps) from unresolved inflight actions: only unknown inflight blocks, and
  // it is never replayed. Legacy/direct controller replay keeps the historical
  // any-state-not-completed gate verbatim.
  const blockingReceipts=store.research.receipts(run.id).filter(r=>options.firstStepScope?r.state==='inflight':r.state!=='completed');
  if(blockingReceipts.length)return finish('unknown_inflight','partial');
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
  if(checkpoint.pendingClaims){const result=await verify();if(result)return result;}
  const seen=new Set(store.research.receipts(run.id).filter(r=>r.kind==='tool').map(r=>digest(r.request)));
  while(limits.modelCalls===0||checkpoint.steps<limits.modelCalls-1){
   active();progress('planning');
   const step=checkpoint.steps;
   const budget=store.research.budget(run.id,limits);
   const activePages=stillActivePages();
   const decision=await ask('plan');
   active();
   try {
   if(!object(decision)||typeof decision.action!=='string')throw new ResearchStop('invalid_decision');
   if(decision.action==='finish'){
    if(!Array.isArray(decision.claims))throw new ResearchStop('invalid_evidence');
    let validOriginalClaims=0;
    const claims:ResearchClaim[]=decision.claims.map((raw,index)=>{
     try {
     if(!object(raw)||typeof raw.sourceKey!=='string'||typeof raw.quote!=='string'||raw.quote.length<3||raw.quote.length>600)throw new ResearchStop('invalid_evidence');
     const page=activePages.find(p=>p.sourceKey===raw.sourceKey);if(!page||(page.retrieval!=='read'&&page.retrieval!=='profile')||!page.text.includes(raw.quote))throw new ResearchStop('invalid_evidence');
     const kind=raw.kind??'page_statement';if(!['attributed_statement','page_statement','inference'].includes(String(kind)))throw new ResearchStop('invalid_evidence');
     const section=raw.section??(kind==='inference'?'analysis':'work');if(!['background','work','expression','analysis'].includes(String(section)))throw new ResearchStop('invalid_evidence');
     const statement=typeof raw.statement==='string'?sanitizeText(raw.statement,600):raw.quote;if(!statement)throw new ResearchStop('invalid_evidence');
     const facet=raw.facet;
     if(facet!==undefined&&!RESEARCH_FACETS.some(f=>f.id===facet))throw new ResearchStop('invalid_evidence');
     validOriginalClaims++;
     return {sourceKey:raw.sourceKey,quote:raw.quote,statement,kind:kind as ResearchClaim['kind'],section:section as ResearchClaim['section'],...(facet?{facet:facet as ResearchFacet}:{})};
     } catch(error) {
      if(!options.firstStepScope||!(error instanceof ResearchStop)||error.code!=='invalid_evidence')throw error;
      checkpoint.proposalRejections=[...(checkpoint.proposalRejections??[]),{step:checkpoint.steps,index,sourceKey:object(raw)&&typeof raw.sourceKey==='string'?raw.sourceKey:null,reason:'invalid_evidence'}];
      return null;
     }
    }).filter((claim):claim is ResearchClaim=>claim!==null).filter(claim=>{
     // Independent first-step account material is retained as sources but can
     // never become a claim about the selected person.
     const page=activePages.find(p=>p.sourceKey===claim.sourceKey);
     const key=page?(options.firstStepScope?.accountKeyOf(page.url)??null):null;
     if(key&&options.firstStepScope?.independentAccountKeys.has(key)){
      checkpoint.notes=[...new Set([...(checkpoint.notes??[]),`独立账号材料（未并入人物结论）：${claim.quote}`])];
      return false;
     }
     return true;
    });
    if(options.firstStepScope&&decision.claims.length>0&&validOriginalClaims===0)throw new ResearchStop('invalid_evidence');
    if(!options.firstStepScope)checkpoint.claims=[];checkpoint.pendingClaims=claims;checkpoint.steps++;
    checkpoint.unknowns=[...new Set([...checkpoint.unknowns,...Array.isArray(decision.unknowns)?decision.unknowns.filter((v):v is string=>typeof v==='string').map(v=>sanitizeText(v,600)):[]])];
    checkpoint.phase='verifying';save();const result=await verify();if(result)return result;continue;
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
     const url=researchUrl(item.url);if(!url)throw new ResearchStop('url_not_discovered');
     return {kind:'tool',action:{type:item.action==='social'?'social_profile':item.action as 'read'|'social_posts'|'firecrawl',url}};
    }
    throw new ResearchStop('invalid_decision');
   });
   for(const step of planned){
    if(step.kind==='inspect'){
     if(!checkpoint.pages.some(page=>page.sourceKey===step.sourceKey))throw new ResearchStop('invalid_decision');
     if(!stillActivePages().some(page=>page.sourceKey===step.sourceKey))throw new ResearchStop('source_revoked');
     continue;
    }
    if(step.kind!=='tool')continue;
    const action=step.action;
    if(action.type==='search'){if(!action.query.trim()||action.query.length>600)throw new ResearchStop('invalid_decision');}
    else {const url=researchUrl(action.url);if(!url||(!options.firstStepScope&&!allowedUrls().has(url)))throw new ResearchStop('url_not_discovered');}
   }
   let madeProgress=false;
   const outcomes:NonNullable<ResearchCheckpoint['lastBatchOutcomes']>=[];
   if(planned.some(p=>p.kind==='inspect'))checkpoint.inspectWindows=[];
   const localWindows=new Set(checkpoint.localWindows??[]);
   for(const step of planned){
    active();
    if(step.kind==='catalog'){
     const activePages=stillActivePages();const offset=Math.min(step.offset,Math.max(0,activePages.length-1));
     const maxLinks=Math.max(0,...activePages.slice(offset,offset+12).map(p=>p.links.length-1));
     const selected={offset,linkOffset:Math.min(step.linkOffset,maxLinks),unknownOffset:Math.min(step.unknownOffset,Math.max(0,checkpoint.unknowns.length-1))};
     const signature='catalog:'+digest({pages:stillActivePages().slice(selected.offset,selected.offset+12).map(p=>({key:p.sourceKey,text:p.text.slice(0,600),links:p.links.slice(selected.linkOffset,selected.linkOffset+20)})),unknowns:checkpoint.unknowns.slice(selected.unknownOffset,selected.unknownOffset+30)});
     const fresh=!localWindows.has(signature);
     if(fresh){localWindows.add(signature);checkpoint.catalog=selected;madeProgress=true;checkpoint.localWindows=[...localWindows];save();}
     outcomes.push({action:'catalog',target:String(offset),status:fresh?'new_window':'already_seen'});
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
     const fresh=!localWindows.has(signature);
     if(fresh){localWindows.add(signature);checkpoint.inspect=selected;madeProgress=true;checkpoint.localWindows=[...localWindows];}
     checkpoint.inspectWindows!.push(selected);
     outcomes.push({action:'inspect',target:`${selected.sourceKey}:${selected.offset}`,status:fresh?'new_window':'already_seen'});
     save();continue;
    }
    const action=step.action;
    if(limits.toolCalls>0&&store.research.budget(run.id,limits).toolCalls>=limits.toolCalls){checkpoint.unknowns.push('本批读取额度已用完，剩余线索未读；保留分析与独立核验机会。');break;}
    const discoveredFrom=dependencies(action);
    const signature=digest(action);
    const target=action.type==='search'?action.query:action.url;
    if(seen.has(signature)){checkpoint.unknowns.push('同一资料动作已执行，不重复付费；需要选择新的证据线索。');outcomes.push({action:action.type,target,status:'already_attempted'});continue;}
    seen.add(signature);if(!options.firstStepScope)madeProgress=true;progress(action.type==='search'?'searching':'reading');
    const before=new Map(stillActivePages().map(p=>[p.url,p]));
    try{const result=await perform(action);
     if(discoveredFrom.length&&!discoveredFrom.some(key=>store.isResearchSourceActive(run.id,key,run.ownerId)))throw new ResearchStop('source_revoked');
     ingest(result,action,discoveredFrom);
     const fresh=result.pages.some(p=>{
      const url=researchUrl(p.url);const next=checkpoint.pages.find(item=>item.url===url);const prior=url?before.get(url):undefined;
      return !!next&&((next.text.trim().length>0&&next.text!==prior?.text)||next.links.some(link=>!prior?.links.includes(link)));
     });
     madeProgress ||= fresh;outcomes.push({action:action.type,target,status:fresh?'new_material':'no_new_material'});}
    catch(error){
     if(options.signal.aborted||deadline.signal.aborted)throw error;
     // A known adapter failure is a gap in this branch, not the end of all research.
     // Its settled attempt is retained and never retried automatically.
     if(error instanceof ProviderError){outcomes.push({action:action.type,target,status:error.code});if(options.firstStepScope)checkpoint.actionFailures=[...(checkpoint.actionFailures??[]),{step:checkpoint.steps,action:{...action},code:error.code}];else checkpoint.unknowns.push(`资料分支未读成功：${action.type==='search'?'检索':action.url}（${error.code}）；不代表无资料。`);save();continue;}
     // A per-target scope refusal is fail-closed but not fatal: the refused
     // target was never fetched, the honest gap stays visible, and planning
     // continues under the same model/tool/elapsed caps with retained material.
     if(error instanceof ResearchStop&&error.code==='url_not_discovered'&&options.firstStepScope){outcomes.push({action:action.type,target,status:'url_not_discovered'});checkpoint.unknowns.push(`拒绝未在已读资料中发现的地址：${action.type==='search'?'检索':action.url}；未发送请求。请只选择目录中已观察到且属于所选账号的链接，或检查已存原文。`);save();continue;}
     if(error instanceof FirstStepSelectionError&&error.code==='out_of_scope'){
      outcomes.push({action:action.type,target,status:'out_of_scope'});
      const dispatched=scopeRefusalRecord(error)?.dispatched===true;
      checkpoint.unknowns.push(`范围外目标拒绝${dispatched?'入库':'读取'}（${error.detail}）；${dispatched?'请求已发生，实际用量保留，返回材料未入库':'未发送请求'}，缺口保留，已读材料不变。`);save();continue;
     }
     throw error;
    }
   }
   checkpoint.lastBatchOutcomes=outcomes;checkpoint.noProgressBatches=madeProgress?0:(checkpoint.noProgressBatches??0)+1;
   checkpoint.steps++;save();
   if(!madeProgress&&(options.firstStepScope?checkpoint.noProgressBatches>=2:limits.modelCalls===0))return finish(limits.toolCalls>0&&store.research.budget(run.id,limits).toolCalls>=limits.toolCalls?'budget_exhausted':'no_new_evidence','partial');
   } catch(error) {
    if(!options.firstStepScope||!(error instanceof ResearchStop)||!['invalid_decision','invalid_evidence','url_not_discovered'].includes(error.code))throw error;
    // Validate the whole proposal before dispatch. Corrective planning is a
    // new, metered model call under the original cap, never a hidden retry.
    checkpoint.planFeedback=`上个方案未被接受（${error.code}）。只允许一个平铺的 batch，actions 为 1–4 个 read/search/social/social_posts/firecrawl/inspect/catalog，禁止嵌套 batch；inspect 仅使用已存 sourceKey 与非负整数 offset。finish 的 quote 必须是已读 sourceKey 原文中精确、连续的 3–600 字符片段，不能把 HTML 改写后的展示文本当原文。请改正方案；仅使用所选范围，不猜测地址。`;
    checkpoint.unknowns.push(`模型方案未通过校验（${error.code}）；该方案未成为结论，保留缺口并在原预算内重新规划。`);
    checkpoint.steps++;checkpoint.planValidationFailures=(checkpoint.planValidationFailures??0)+1;save();
    if(checkpoint.planValidationFailures>=3)return finish('invalid_decision','partial');
   }
  }
  return finish('budget_exhausted','partial');
 }catch(error){
  if(error instanceof NeedsInputError){checkpoint.phase='needs_input';save();throw error;}
  if(options.signal.aborted)throw error;
  if(error instanceof ResearchStop&&error.code==='run_inactive')throw error;
  // Scope withdrawal/revocation stops explicitly with an honest gap and the
  // preserved material; it never degrades into research_error/internal_error
  // and never opens a needs_input screen over a stale immutable binding.
  if(isScopeStop(error)){
   const detail=error instanceof FirstStepSelectionError?error.detail:'依赖的来源已被撤回或失效';
   checkpoint.unknowns.push(`冻结范围或来源有效性已撤回（${detail}）；停止继续读取与新结论，已读材料与检查点保留待复核。`);
   return finish(error instanceof ResearchStop?'source_revoked':'scope_changed','partial');
  }
  if(error instanceof FirstStepSelectionError){checkpoint.unknowns.push(`范围守卫拒绝（${error.detail}）；缺口保留，已读材料不变。`);return finish('research_error','partial');}
  const reason=deadline.signal.aborted?'budget_exhausted':error instanceof ResearchStop?error.code:error instanceof ProviderError?error.code:'research_error';
  return finish(reason,'partial');
 }finally{clearTimeout(timer);}
}
