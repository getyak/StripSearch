import type { DB } from '../db/index.js';
import type { IdentityCandidate, IdentityDraft, ResearchBudget, ResearchBudgetLimits } from '../../shared/types.js';
import type { ResearchPage } from './tool-contracts.js';

export const RESEARCH_LIMITS: ResearchBudgetLimits = { toolCalls:12, modelCalls:8, inputTokens:150_000, outputTokens:16_000, elapsedMs:240_000 };
export interface ResearchClaim { sourceKey: string; quote: string; statement: string; kind: 'attributed_statement'|'page_statement'|'inference'; section:'background'|'work'|'expression'|'analysis' }
export interface StoredPage extends ResearchPage { sourceKey: string; inheritedFrom?: {runId: string; sourceKey: string} }
export interface ResearchCheckpoint {
 phase: string; steps: number; startedAt: number; elapsedMs: number;
 anchorUrl: string | null; identity: IdentityDraft | null; candidates: IdentityCandidate[];
 pages: StoredPage[]; claims: ResearchClaim[]; pendingClaims?: ResearchClaim[]; unknowns: string[]; stopReason: string | null;
}
export interface ActionUsage { inputTokens?: number; outputTokens?: number; estimatedUsd?: number | null; credits?: number | null; bytes?: number; unknownCost?: boolean }
export interface ActionReceipt { key: string; kind:'tool'|'model'; state:'inflight'|'completed'|'failed'; request:unknown; result:unknown; usage:ActionUsage|null; reservedInput:number; reservedOutput:number }
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
  const rows=this.db.prepare('SELECT * FROM research_actions WHERE run_id=? ORDER BY created_at,action_key').all(runId) as Array<{action_key:string;kind:'tool'|'model';state:'inflight'|'completed'|'failed';request_json:string;result_json:string|null;usage_json:string|null;reserved_input:number;reserved_output:number}>;
  return rows.map(r=>({key:r.action_key,kind:r.kind,state:r.state,request:JSON.parse(r.request_json),result:r.result_json?JSON.parse(r.result_json):null,usage:r.usage_json?JSON.parse(r.usage_json):null,reservedInput:r.reserved_input,reservedOutput:r.reserved_output}));
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
 reserve(runId:string,key:string,kind:'tool'|'model',request:unknown,reservation:{inputTokens:number;outputTokens:number},limits=RESEARCH_LIMITS):ActionReceipt|undefined {
  return this.db.transaction(()=>{
   this.assertActive(runId);
   const old=this.receipt(runId,key);if(old){if(old.state!=='completed')throw new ResearchStop('unknown_inflight');return old;}
   const budget=this.budget(runId,limits);
   if((kind==='tool'&&budget.toolCalls>=limits.toolCalls)||(kind==='model'&&budget.modelCalls>=limits.modelCalls)||budget.inputTokens+reservation.inputTokens>limits.inputTokens||budget.outputTokens+reservation.outputTokens>limits.outputTokens)throw new ResearchStop('budget_exhausted');
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
