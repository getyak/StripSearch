import type { ResearchFacet, ClaimAuthorialBasis } from '../../shared/research-depth.js';
import type { DB } from '../db/index.js';
import type { IdentityCandidate, IdentityDraft, ResearchBudget, ResearchBudgetLimits, IndependentAccountMaterial } from '../../shared/types.js';
import type { ResearchPage, ResearchToolAction } from './tool-contracts.js';
import type { XAccountResearchState } from './x-account-contracts.js';

/**
 * Legacy finite totals for direct controller calls and historical replay
 * compatibility (frozen v1/v2 baselines, old checkpoints without `limits`).
 * Fresh service runs pass `loadResearchLimits()` where 0 = no fixed total cap.
 */
export const RESEARCH_LIMITS: ResearchBudgetLimits = { toolCalls:12, modelCalls:8, inputTokens:150_000, outputTokens:16_000, elapsedMs:240_000 };
/** Remaining budget for one total; `null` means no fixed total cap (limit 0). */
export function remainingOf(limit:number,used:number):number|null { return limit>0?Math.max(0,limit-used):null; }
/** One local inspect window over stored source text; never a paid request. */
export const INSPECT_WINDOW_CHARS = 4000;
export interface InspectWindow { sourceKey:string; url:string; offset:number; length:number; textLength:number; text:string }
/** Select an excerpt window of a stored source at `offset` (clamped, no fetch). */
export function inspectWindow(page:{sourceKey:string;url:string;text:string},offset:number,size=INSPECT_WINDOW_CHARS):InspectWindow {
 const textLength=page.text.length;
 const start=Math.min(Math.max(0,offset),textLength);
 const text=page.text.slice(start,start+size);
 return {sourceKey:page.sourceKey,url:page.url,offset:start,length:text.length,textLength,text};
}
export interface ResearchClaim { sourceKey: string; quote: string; statement: string; kind: 'attributed_statement'|'page_statement'|'inference'; section:'background'|'work'|'expression'|'analysis'; facet?: ResearchFacet; verified?: boolean; authorialBasis?:ClaimAuthorialBasis;quoteLexicalPolicy?:'literal_terms/v1';quoteRolePolicy?:'preserve_actor/v1';sourceReadKind?:ResearchPage['kind'];sourceReadUrl?:string;genreReview?:ClaimGenreReview }
/** Frozen first-step selection binding; fetch work may only read these accounts. */
export interface FirstStepBinding {
 caseId: string; discoveryRevision: number; scopeVersion: number;
 /** Bound person cluster; null = independent-only scope (never a same-person claim). */
 clusterId: string | null;
 /** Observed person display name (never a raw cluster key) for reports. */
 displayName: string | null;
 /** Anchor of the bound scope, ALWAYS one of the selected accounts. */
 anchorUrl: string | null;
 selectedAccountIds: string[]; independentAccountIds: string[];
 /** Frozen identity-path dependencies can include unselected intermediate anchors. */
 identityDependencyAccountIds?: string[];
 /** accountKey -> accountId for the accounts frozen into this scope. */
 accountKeys: Record<string,string>;
 /** Per-account frozen scope for the Fetch planner; honest and explicit. */
 accounts: Array<{ accountId: string; accountKey: string; profileUrl: string; allowedScope: 'profile_only' | 'public_history'; independent: boolean; accessCoverage: string }>;
}
export interface StoredPage extends ResearchPage { sourceKey: string; discoveredFrom?: string[]; inheritedFrom?: {runId: string; sourceKey: string} }
export interface ClaimGenreReview {
 policy:'genre_context/v1';decision:'literal_relevant';sourceUrl:string;sourceContentHash:string;
 quoteOffset:number;contextOffset:number;contextLength:number;
}
export interface ResearchCheckpoint {
 /** Separate single-account subject; never promoted into person claims. */
 xAccountResearch?: XAccountResearchState;
 /** Highest historical source ordinal, retained when pages leave the corpus. */
 sourceKeyHighWatermark?: number;
 /** Same-source genre context is exclusion-only, never extra fact support. */
 quoteGenrePolicy?:'genre_context/v1';
 /** Persisted only after a scoped quote-only verification starts; no historical relabeling. */
 quoteSupportPolicy?: 'exact_quote/v1';
 /** New dispatched attribution contract; historical verifier receipts stay distinct. */
 quoteAttributionPolicy?: 'quote_attribution/v1';
 quoteLexicalPolicy?: 'literal_terms/v1';
 quoteRolePolicy?: 'preserve_actor/v1';
 /** Attempt/proposal history is not automatically a current evidence gap. */
 proposalRejections?: Array<{step:number;index:number;sourceKey:string|null;reason:string}>;
 actionFailures?: Array<{step:number;action:ResearchToolAction;code:string}>;
 /** Bounded synthesis correction; rejected material is feedback, never evidence. */
 claimRepairRounds?: number;
 verificationFeedback?: Array<{claim:ResearchClaim;reason:string}>;
 /** New lexical-policy checks, separate from current unresolved research gaps. */
 verificationHistory?: Array<{step:number;policy:'literal_terms/v1';rejections:Array<{claim:ResearchClaim;reason:string}>}>;
 /** Last bounded model validation feedback; never source evidence. */
 planFeedback?: string;
 planValidationFailures?: number;
 phase: string; steps: number; startedAt: number; elapsedMs: number;
 limits?: ResearchBudgetLimits;
 /** Latest locally inspected source window (an excerpt scope window, not full text). */
 inspect?: {sourceKey:string;offset:number};
 /** Current flat batch's descriptors only; text is rebuilt from active pages. */
 inspectWindows?: Array<{sourceKey:string;offset:number}>;
 /** Controller observations, never original source evidence. */
 lastBatchOutcomes?: Array<{action:string;target:string;status:string}>;
 noProgressBatches?: number;
 catalog?: {offset:number;linkOffset:number;unknownOffset:number};
 localWindows?:string[];
 anchorUrl: string | null; identity: IdentityDraft | null; candidates: IdentityCandidate[];
 /** Present only for first-step runs; frozen at selection submission. */
 firstStep?: FirstStepBinding;
 notes?:string[];
 /** Optional on legacy checkpoints; exact materials remain outside claims. */
 independentMaterials?: IndependentAccountMaterial[];
 /** Model-authored historical questions, never authoritative current read status. */
 modelGapHistory?: Array<{step:number;text:string}>;
 coverageGaps?:string[];
 pages: StoredPage[]; claims: ResearchClaim[]; pendingClaims?: ResearchClaim[]; unknowns: string[]; stopReason: string | null;
}
export interface ActionUsage { inputTokens?: number; outputTokens?: number; estimatedUsd?: number | null; credits?: number | null; bytes?: number; unknownCost?: boolean }
export interface ActionReceipt { key: string; kind:'tool'|'model'; state:'inflight'|'completed'|'failed'; request:unknown; result:unknown; usage:ActionUsage|null; reservedInput:number; reservedOutput:number; createdAt:string }
export class ResearchStop extends Error { constructor(readonly code:string){super(code);this.name='ResearchStop';} }

export class ResearchStore {
 constructor(private readonly db:DB){}
 assertActive(runId:string):void {
  const run=this.db.prepare("SELECT id FROM runs WHERE id=? AND deleted_at IS NULL AND cancel_requested=0 AND state IN ('queued','researching','needs_input')").get(runId);
  if(!run)throw new ResearchStop('run_inactive');
 }
 checkpoint(runId:string):ResearchCheckpoint|null {
  const row=this.db.prepare('SELECT data_json FROM research_checkpoints WHERE run_id=?').get(runId) as {data_json:string}|undefined;
  return row?JSON.parse(row.data_json) as ResearchCheckpoint:null;
 }
 save(runId:string,checkpoint:ResearchCheckpoint):void {
  this.assertActive(runId);
  this.db.prepare('INSERT INTO research_checkpoints(run_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(runId,JSON.stringify(checkpoint),new Date().toISOString());
 }
 receipts(runId:string):ActionReceipt[] {
  const rows=this.db.prepare('SELECT * FROM research_actions WHERE run_id=? ORDER BY created_at,action_key').all(runId) as Array<{action_key:string;kind:'tool'|'model';state:'inflight'|'completed'|'failed';request_json:string;result_json:string|null;usage_json:string|null;reserved_input:number;reserved_output:number;created_at:string}>;
  return rows.map(r=>({key:r.action_key,kind:r.kind,state:r.state,request:JSON.parse(r.request_json),result:r.result_json?JSON.parse(r.result_json):null,usage:r.usage_json?JSON.parse(r.usage_json):null,reservedInput:r.reserved_input,reservedOutput:r.reserved_output,createdAt:r.created_at}));
 }
 receipt(runId:string,key:string):ActionReceipt|undefined{return this.receipts(runId).find(row=>row.key===key);}
 budget(runId:string,limits:ResearchBudgetLimits=RESEARCH_LIMITS):ResearchBudget {
  const budget:ResearchBudget={toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,estimatedUsd:0,firecrawlCredits:0,unknownCost:false,limits:{...limits}};
  for(const row of this.receipts(runId)){
   if(row.kind==='tool')budget.toolCalls++;else budget.modelCalls++;
   budget.inputTokens+=row.usage?.inputTokens??row.reservedInput;
   budget.outputTokens+=row.usage?.outputTokens??row.reservedOutput;
   budget.estimatedUsd+=row.usage?.estimatedUsd??0;
   budget.firecrawlCredits+=row.usage?.credits??0;
   if(!row.usage||row.usage.estimatedUsd===null||row.usage.unknownCost)budget.unknownCost=true;
  }
  return budget;
 }
 reserve(runId:string,key:string,kind:'tool'|'model',request:unknown,reservation:{inputTokens:number;outputTokens:number},limits=RESEARCH_LIMITS,allowSettledFailure=false):ActionReceipt|undefined {
  return this.db.transaction(()=>{
   this.assertActive(runId);
   const old=this.receipt(runId,key);if(old){if(old.state==='inflight'||old.state==='failed'&&!allowSettledFailure)throw new ResearchStop('unknown_inflight');return old;}
   const budget=this.budget(runId,limits);
   // A zero total is a disabled ceiling, never a zero allowance.
   const over=(limits.toolCalls>0&&kind==='tool'&&budget.toolCalls>=limits.toolCalls)
    ||(limits.modelCalls>0&&kind==='model'&&budget.modelCalls>=limits.modelCalls)
    ||(limits.inputTokens>0&&budget.inputTokens+reservation.inputTokens>limits.inputTokens)
    ||(limits.outputTokens>0&&budget.outputTokens+reservation.outputTokens>limits.outputTokens);
   if(over)throw new ResearchStop('budget_exhausted');
   this.db.prepare("INSERT INTO research_actions(run_id,action_key,kind,state,request_json,reserved_input,reserved_output,created_at) VALUES(?,?,?,'inflight',?,?,?,?)").run(runId,key,kind,JSON.stringify(request),reservation.inputTokens,reservation.outputTokens,new Date().toISOString());
   return undefined;
  })();
 }
 settle(runId:string,key:string,result:unknown,usage:ActionUsage,state:'completed'|'failed'='completed'):void {
  // Financial receipts may settle after cancellation; no publication fields are written.
  const changed=this.db.prepare("UPDATE research_actions SET state=?,result_json=?,usage_json=?,settled_at=? WHERE run_id=? AND action_key=? AND state='inflight'").run(state,JSON.stringify(result),JSON.stringify(usage),new Date().toISOString(),runId,key).changes;
  void changed; // Deleted runs cascade their ledger; never recreate it.
 }
}
