import {createHash} from 'node:crypto';
import type {DB} from '../db/index.js';
import type {CaseReportView} from '../../shared/research-case.js';
import {classifyFirstStepUrl,linkRoleFromContext} from '../../shared/first-step-discovery.js';
import {extractOriginalLinkContexts} from './link-context.js';
import type {ResearchPage} from './tool-contracts.js';

/** Read-only current safety projection. Stored evidence, choices and reports are never rewritten. */
export function identitySemanticReviewAccounts(db:DB,report:CaseReportView):Set<string>{
 const invalid=new Set<string>();
 const generated=report.evidence.filter(e=>e.role==='identity_support'&&e.revokedAt===null&&e.provenance.collector==='first-step-discovery');
 if(!generated.length)return invalid;
 const rows=db.prepare(`SELECT a.result_json FROM research_actions a JOIN first_step_links l ON l.run_id=a.run_id WHERE l.case_id=? AND a.kind='tool' AND a.state='completed' AND json_extract(a.request_json,'$.type') IN ('read','firecrawl','github_profile','social_profile')`).all(report.case.caseId) as Array<{result_json:string|null}>;
 const originals=new Map<string,ResearchPage>();
 for(const row of rows){
  let result:{pages?:ResearchPage[]};try{result=JSON.parse(row.result_json??'null')??{};}catch{continue;}
  for(const page of result.pages??[]){if(typeof page.text!=='string'||typeof page.url!=='string')continue;originals.set(page.url+'|'+createHash('sha256').update(page.text).digest('hex'),page);}
 }
 for(const account of report.accounts){
  if(account.identitySupport.state!=='supported')continue;
  const target=classifyFirstStepUrl(account.profileUrl);if(!target.ok)continue;
  for(const evidence of generated.filter(e=>e.accountId===account.accountId&&account.identitySupport.evidenceIds.includes(e.evidenceId))){
   const source=report.sources.find(s=>s.sourceId===evidence.sourceId)?.revisions.find(r=>r.sourceRevision===evidence.sourceRevision);
   if(!source)continue; // Structural validity remains the separate authoritative gate.
   const page=originals.get(source.originalUrl+'|'+source.contentHash);
   // Legacy/manual records without a completed original can still expose a
   // target-bound HTML/Markdown span. Plain legacy statements stay unassessed.
   if(page&&!page.text.includes(evidence.quote)){invalid.add(account.accountId);continue;}
   const text=page?.text??evidence.quote;
   const contexts=extractOriginalLinkContexts(text,source.originalUrl);
   const matched=contexts.filter(c=>{const ref=classifyFirstStepUrl(c.url);return ref.ok&&ref.ref.accountKey===target.ref.accountKey&&(c.quote===evidence.quote||c.quote.includes(evidence.quote)||evidence.quote.includes(c.quote));});
   const native=(page?.linkContexts??[]).filter(c=>c.binding==='native_profile_field'&&c.quote===evidence.quote&&c.url===account.profileUrl&&c.nativeField&&page!.text.slice(c.nativeField.offset,c.nativeField.offset+c.quote.length)===c.quote);
   if(!page&&!/<a\b|\[[^\]\n]*\]\(/iu.test(evidence.quote))continue;
   const ref=classifyFirstStepUrl(source.originalUrl);if(!ref.ok){invalid.add(account.accountId);continue;}
   const social=!['personal_site','rss_blog','web_page'].includes(ref.ref.platform);
   const literals=[...new Set([...(page?.links??[]),account.profileUrl].filter((url):url is string=>typeof url==='string'))].filter(url=>{const ref=classifyFirstStepUrl(url);return ref.ok&&ref.ref.accountKey===target.ref.accountKey&&evidence.quote.includes(url.replace(/\/+$/,''));}).map(url=>({url,quote:evidence.quote,binding:null,surface:null,targetOffset:undefined}));
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
