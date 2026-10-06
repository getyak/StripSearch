import {createHash} from 'node:crypto';
import type {DB} from '../db/index.js';
import type {CaseReportView} from '../../shared/research-case.js';
import {classifyFirstStepUrl,linkRoleFromContext} from '../../shared/first-step-discovery.js';
import {extractOriginalLinkContexts} from './link-context.js';
import type {ResearchPage, ResearchToolAction} from './tool-contracts.js';
import {verifiedNativeAccountRequest, verifiedNativeWebsiteDeclaration, verifiedNativeFieldContext} from './toolkit.js';

/** Read-only current safety projection. Stored evidence, choices and reports are never rewritten. */
export function identitySemanticReviewAccounts(db:DB,report:CaseReportView):Set<string>{
 const invalid=new Set<string>();
 const generated=report.evidence.filter(e=>e.role==='identity_support'&&e.revokedAt===null&&e.provenance.collector==='first-step-discovery');
 if(!generated.length)return invalid;
 const rows=db.prepare(`SELECT a.result_json,a.request_json FROM research_actions a JOIN first_step_links l ON l.run_id=a.run_id WHERE l.case_id=? AND a.kind='tool' AND a.state='completed' AND json_extract(a.request_json,'$.type') IN ('read','firecrawl','github_profile','social_profile')`).all(report.case.caseId) as Array<{result_json:string|null;request_json:string}>;
 const originals=new Map<string,{page:ResearchPage;action:ResearchToolAction}>();
 for(const row of rows){
  let result:{pages?:ResearchPage[]},action:ResearchToolAction;try{result=JSON.parse(row.result_json??'null')??{};action=JSON.parse(row.request_json);}catch{continue;}
  for(const page of Array.isArray(result.pages)?result.pages:[]){if(!page||typeof page.text!=='string'||typeof page.url!=='string')continue;originals.set(page.url+'|'+createHash('sha256').update(page.text).digest('hex'),{page,action});}
 }
 for(const account of report.accounts){
  if(account.identitySupport.state!=='supported')continue;
  const target=classifyFirstStepUrl(account.profileUrl);if(!target.ok)continue;
  for(const evidence of generated.filter(e=>e.accountId===account.accountId&&account.identitySupport.evidenceIds.includes(e.evidenceId))){
   const source=report.sources.find(s=>s.sourceId===evidence.sourceId)?.revisions.find(r=>r.sourceRevision===evidence.sourceRevision);
   if(!source)continue; // Structural validity remains the separate authoritative gate.
   const original=originals.get(source.originalUrl+'|'+source.contentHash),page=original?.page;
   // Legacy/manual records without a completed original can still expose a
   // target-bound HTML/Markdown span. Plain legacy statements stay unassessed.
   if(page&&!page.text.includes(evidence.quote)){invalid.add(account.accountId);continue;}
   const text=page?.text??evidence.quote;
   const contexts=extractOriginalLinkContexts(text,source.originalUrl);
   const matched=contexts.filter(c=>{const ref=classifyFirstStepUrl(c.url);return ref.ok&&ref.ref.accountKey===target.ref.accountKey&&(c.quote===evidence.quote||c.quote.includes(evidence.quote)||evidence.quote.includes(c.quote));});
   const declaration=original?verifiedNativeWebsiteDeclaration(original.page,original.action):null;
   const nativeCandidates=(Array.isArray(page?.linkContexts)?page.linkContexts:[]).filter(c=>c&&c.binding==='native_profile_field'&&c.quote===evidence.quote&&c.url===account.profileUrl);
   const native=nativeCandidates.filter(c=>original&&verifiedNativeAccountRequest(original.page,original.action)&&verifiedNativeFieldContext(original.page,c,declaration));
   if(!page&&!/<a\b|\[[^\]\n]*\]\(/iu.test(evidence.quote))continue;
   const ref=classifyFirstStepUrl(source.originalUrl);if(!ref.ok){invalid.add(account.accountId);continue;}
   const social=!['personal_site','rss_blog','web_page'].includes(ref.ref.platform);
   // An extracted target context or native field is authoritative. A narrow
   // historical quote must never override its denial, attribution or field veto.
   const literals=matched.length||nativeCandidates.length||/<a\b|\[[^\]\n]*\]\(/iu.test(text)?[]:[...new Set([...(Array.isArray(page?.links)?page.links:[]),account.profileUrl].filter((url):url is string=>typeof url==='string'))].filter(url=>{const ref=classifyFirstStepUrl(url);return ref.ok&&ref.ref.accountKey===target.ref.accountKey&&text.includes(url.replace(/\/+$/,''));}).map(url=>({url,quote:text,binding:null,surface:null,targetOffset:undefined}));
   const bound=[...matched,...native,...literals];
   const valid=bound.some(c=>{
    const role=linkRoleFromContext({quote:c.quote,targetUrl:c.url,targetOffset:c.targetOffset,binding:c.binding,surface:c.surface,sourceIsOwnProfilePage:ref.ref.entry==='profile'||page?.kind==='profile',sourceIsDirectory:ref.ref.platform==='linktree',sourceIsRestrictedSurface:social&&ref.ref.entry!=='profile',sourceIsSocialPlatform:social,sourceIsNativeAccount:c.binding==='native_profile_field'&&!!page?.account});
    return role.retrieval==='read'&&['self_account_section','explicit_directory'].includes(role.role);
   });
   if(!valid)invalid.add(account.accountId);
  }
 }
 return invalid;
}
