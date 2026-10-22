import type {CanonicalSource,SourceDraft,XAccountResearchMetadata} from '../../shared/types.js';
import type {StoredPage} from './research-store.js';
import type {XAccountResearchState} from './x-account-contracts.js';

/** Memoized dependency projection avoids reparsing a large corpus per source. */
export function xAccountActiveSourceKeys(pages:readonly StoredPage[],sources:readonly {sourceKey:string;excluded:boolean}[],scopeActive:boolean):Set<string>{
 const result=new Set<string>();if(!scopeActive)return result;
 const rows=new Map(sources.map(s=>[s.sourceKey,s]));const corpus=new Map(pages.map(p=>[p.sourceKey,p]));const visiting=new Set<string>();const checked=new Map<string,boolean>();
 const active=(key:string):boolean=>{if(checked.has(key))return checked.get(key)!;if(visiting.has(key))return false;const page=corpus.get(key);if(!page||!rows.has(key)||rows.get(key)!.excluded)return false;visiting.add(key);const valid=!page.discoveredFrom?.length||page.discoveredFrom.some(active);visiting.delete(key);checked.set(key,valid);if(valid)result.add(key);return valid;};
 for(const page of pages)active(page.sourceKey);return result;
}
export function xSourceDrafts(sources:readonly CanonicalSource[]):SourceDraft[]{return sources.map(s=>({key:s.sourceKey,url:s.url,title:s.title,kind:s.kind,publishedAt:s.publishedAt,excerpt:s.excerpt,excerptLocator:s.excerptLocator,identityLabel:s.identityLabel,identityConfirmed:false,fetchStatus:s.fetchStatus,limits:s.limits}));}
export function xAccountMetadata(state:XAccountResearchState,verifiedFindings:number):XAccountResearchMetadata {
 const target=state.posts.filter(p=>p.role==='target');const dates=target.map(p=>p.publishedAt?Date.parse(p.publishedAt):NaN).filter(Number.isFinite).sort((a,b)=>a-b);
 return{platform:'x',handle:state.profile?.handle??'',nativeId:state.profile?.nativeId??'',profileUrl:state.profile?.url??'',timelinePages:state.history.timeline.pages,repliesPages:state.history.replies.pages,targetPosts:target.length,contextPosts:state.posts.length-target.length,oldestPostAt:dates.length?new Date(dates[0]!).toISOString():null,newestPostAt:dates.length?new Date(dates[dates.length-1]!).toISOString():null,timelineEnded:state.history.timeline.done,repliesEnded:state.history.replies.done,verifiedFindings,synthesisComplete:state.analysis.synthesisDone};
}
