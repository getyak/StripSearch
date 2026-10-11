import type {DB} from '../db/index.js';
import {classifyFirstStepUrl} from '../../shared/first-step-discovery.js';
import {verifiedNativeAccountKind} from './toolkit.js';
import type {ResearchToolAction,ResearchToolResult} from './tool-contracts.js';

/** Re-derive conservative organization metadata from the case's completed
 * native reads. A failed later read never converts an organization to a
 * person. The metadata cannot grant identity, access or personal authorship. */
export function nativeOrganizationKeys(db:DB,ownerId:string,caseId:string):Set<string>{
 const keys=new Set<string>();
 const rows=db.prepare(`SELECT a.request_json,a.result_json FROM research_actions a JOIN first_step_links l ON l.run_id=a.run_id JOIN runs r ON r.id=a.run_id WHERE l.case_id=? AND r.owner_id=? AND a.kind='tool' AND a.state='completed' AND json_extract(a.request_json,'$.type')='github_profile'`).all(caseId,ownerId) as Array<{request_json:string;result_json:string|null}>;
 for(const row of rows){
  try{
   const action=JSON.parse(row.request_json) as ResearchToolAction,result=JSON.parse(row.result_json??'null') as ResearchToolResult|null;
   for(const page of Array.isArray(result?.pages)?result.pages:[]){
    if(verifiedNativeAccountKind(page,action)!=='organization')continue;
    for (const url of [page.url, action.type === 'search' ? null : action.url]) {
     const ref=classifyFirstStepUrl(url);if(ref.ok)keys.add(ref.ref.accountKey);
    }
   }
  }catch{/* Malformed historical provider data cannot establish a new role. */}
 }
 return keys;
}
