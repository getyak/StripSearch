import type {AnswerSectionDraft, ClaimKind, ObservationDraft, SourceDraft} from '../../shared/types.js';
import type {StoredPage} from './research-store.js';

export interface XNativeAccount {nativeId:string;handle:string;name:string;description:string;url:string}
export interface XNativePost {
  id:string;url:string;authorId:string;authorHandle:string;text:string;publishedAt:string|null;
  kind:'original'|'reply'|'quote'|'repost';parentId:string|null;quotedId:string|null;
  conversationId:string|null;replyCount:number|null;textField:string;truncated:boolean;quotedUnavailable?:boolean;
  originalPostId?:string|null;originalAuthorId?:string|null;originalAuthorHandle?:string|null;
}
export type XReadRequest =
  | {type:'profile';handle:string}
  | {type:'timeline'|'replies';handle:string;nativeId:string;cursor:string|null}
  | {type:'detail';tweetId:string}
  | {type:'comments';tweetId:string;cursor:string|null};
export interface XReadResult {
  retrievedAt?:string;inheritedFromRunId?:string;account?:XNativeAccount;posts:XNativePost[];nextCursor:string|null;cursorState:'more'|'end'|'unknown';
  recordCount:number;limitations:string[];requests:1;bytes:number;estimatedUsd:number|null;endpoint:string;
}
export interface XAccountProvider {execute(request:XReadRequest,signal:AbortSignal):Promise<XReadResult>}
export interface XAccountPost extends XNativePost {
  sourceKey:string;role:'target'|'parent_context'|'quoted_context'|'reply_context';rootIds:string[];
}
export interface XHistoryProgress {started:boolean;cursor:string|null;done:boolean;pages:number;cursors:string[];pageHashes:string[];emptyRawPages?:number;blocked?:string}
export type XFindingSection = 'overview'|'themes'|'changes'|'work'|'interaction'|'commercial';
export interface XFindingEvidence {sourceKey:string;quote:string;quoteOffset:number;sourceContentHash:string}
export interface XAccountFinding {
  id:string;section:XFindingSection;statement:string;kind:Exclude<ClaimKind,'factual'>;
  evidence:XFindingEvidence[];verified:boolean;
}
export interface XAccountResearchState {
  version:'x-account/v1';accountId:string;profile:XNativeAccount|null;
  history:{timeline:XHistoryProgress;replies:XHistoryProgress};posts:XAccountPost[];
  contextQueue:Array<{type:'detail'|'comments';tweetId:string;rootId:string;relation:'target'|'parent_context'|'quoted_context'|'reply_context'}>;
  contextDone:string[];gaps:Array<{code:string;target:string;detail:string}>;
  analysis:{completedBatches:string[];findings:XAccountFinding[];synthesisDone:boolean};
}
export type XAccountModel = (input:{purpose:string;prompt:string;schema:Record<string,unknown>;maxTokens:number},signal:AbortSignal)=>Promise<unknown>;
export interface XAccountAnalysisInput {
  subject:XNativeAccount;question:string;pages:StoredPage[];posts:XAccountPost[];
  state:XAccountResearchState;model:XAccountModel;signal:AbortSignal;save:()=>void;
  active:()=>void;
}
export interface XAccountProjection {
  answer:AnswerSectionDraft[];observations:ObservationDraft[];limitations:string[];
  findings:XAccountFinding[];
  rejectedFindings?:number;
}
export interface XAccountReportInput {
  state:XAccountResearchState;pages:StoredPage[];sources:SourceDraft[];
  activeSourceKeys:ReadonlySet<string>;
}
