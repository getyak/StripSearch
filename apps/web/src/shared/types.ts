import type { ResearchFacetCoverage } from './research-depth.js';
/**
 * Canonical StripSearch web-alpha types shared by the server, the renderers and
 * the vanilla TypeScript client. This file has no runtime dependencies.
 */

export const SCHEMA_VERSION = 'stripsearch/web-alpha/v1';

export type ProviderName = 'github' | 'exa' | 'research';

export type RunState =
  | 'queued'
  | 'researching'
  | 'needs_input'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type TerminalState = Extract<RunState, 'completed' | 'partial' | 'failed' | 'cancelled'>;

export function isTerminalState(state: RunState): state is TerminalState {
  return state === 'completed' || state === 'partial' || state === 'failed' || state === 'cancelled';
}

export function isActiveState(state: RunState): boolean {
  return state === 'queued' || state === 'researching';
}

export type SourceKind = 'profile' | 'work' | 'third_party';

export type ClaimKind = 'factual' | 'attributed_statement' | 'page_statement' | 'inference';

export type Validity = 'valid' | 'review';

export type FetchStatus = 'ok' | 'truncated' | 'inaccessible' | 'excluded';

export interface RunInput {
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  parentRunId?: string | null;
  retryOf?: string | null;
  followup?: boolean;
}

/** A source exactly as persisted, before exclusion is applied. */
export interface SourceDraft {
  /** Original acquisition time, retained when a read receipt is reused. */
  retrievedAt?: string;
  key: string;
  url: string;
  title: string;
  kind: SourceKind;
  publishedAt: string | null;
  excerpt: string | null;
  excerptLocator: string | null;
  identityLabel: string;
  identityConfirmed: boolean;
  fetchStatus: FetchStatus;
  limits: string[];
}

export interface ObservationDraft {
  statement: string;
  kind: ClaimKind;
  sourceKeys: string[];
  limitations: string[];
}

export interface AnswerBulletDraft {
  text: string;
  sourceKeys: string[];
  kind: ClaimKind;
}

export interface AnswerSectionDraft {
  id: string;
  heading: string;
  body: string;
  bullets: AnswerBulletDraft[];
}

export interface IdentityDraft {
  displayName: string;
  handle: string | null;
  profileUrl: string | null;
  status: 'resolved' | 'needs_input' | 'ambiguous';
  note: string | null;
  candidates: IdentityCandidate[];
}

export interface ProviderResult {
  state: 'completed' | 'partial';
  identity: IdentityDraft;
  sources: SourceDraft[];
  observations: ObservationDraft[];
  answer: AnswerSectionDraft[];
  limitations: string[];
  usage: { requests: number; bytes: number };
  stopReason: string;
}

/** Provider asked for more user input before it can make network calls. */
export class NeedsInputError extends Error {
  readonly prompt: string;
  readonly candidates: IdentityCandidate[];

  constructor(prompt: string, candidates: IdentityCandidate[] = []) {
    super(prompt);
    this.name = 'NeedsInputError';
    this.prompt = prompt;
    this.candidates = candidates;
  }
}

export interface CanonicalSource {
  sourceKey: string;
  url: string;
  title: string;
  kind: SourceKind;
  publishedAt: string | null;
  retrievedAt: string;
  fetchStatus: FetchStatus;
  excerpt: string | null;
  excerptLocator: string | null;
  identityLabel: string;
  identityConfirmed: boolean;
  limits: string[];
  excluded: boolean;
  excludedAt: string | null;
}

export interface CanonicalObservation {
  observationId: string;
  statement: string;
  kind: ClaimKind;
  sourceKeys: string[];
  limitations: string[];
  validity: Validity;
  reviewReason: string | null;
}

export interface CanonicalBullet {
  text: string;
  sourceKeys: string[];
  kind: ClaimKind;
  validity: Validity;
  reviewReason: string | null;
}

export interface CanonicalAnswerSection {
  id: string;
  heading: string;
  body: string;
  bullets: CanonicalBullet[];
}

export interface CanonicalIdentity {
  displayName: string;
  handle: string | null;
  profileUrl: string | null;
  status: 'resolved' | 'needs_input' | 'ambiguous';
  note: string | null;
  candidates: IdentityCandidate[];
}

export interface CanonicalUsage {
  provider: ProviderName;
  requests: number;
  bytes: number;
  elapsedMs: number | null;
  measurement: 'observed' | 'not_run';
}

export interface CanonicalView {
  schemaVersion: string;
  runId: string;
  state: RunState;
  revision: number;
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  parentRunId: string | null;
  retryOf: string | null;
  followup: boolean;
  createdAt: string;
  updatedAt: string;
  interrupted: boolean;
  stopReason: string | null;
  identity: CanonicalIdentity;
  sources: CanonicalSource[];
  observations: CanonicalObservation[];
  answer: CanonicalAnswerSection[];
  limitations: string[];
  usage: CanonicalUsage;
  reviewCount: number;
  personObject?: PersonObject;
  accountObject?: AccountObject;
  research?: ResearchMetadata;
}

export interface RunEventRecord {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface RunSummary {
  runId: string;
  question: string;
  state: RunState;
  provider: ProviderName;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  reviewCount: number;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}


export interface IdentityCandidate { label: string; detail: string; candidateId?: string; profileUrl?: string }
/**
 * Research run totals. Every field uses `0` = no fixed total cap (research
 * continues until the model finishes, the run is cancelled, or a per-request
 * bound fires); a positive safe integer is an explicit per-run cap chosen by
 * the user or deployment. Frozen legacy checkpoints without a `limits` field
 * keep the historical finite defaults (see `RESEARCH_LIMITS`).
 */
export interface ResearchBudgetLimits { toolCalls: number; modelCalls: number; inputTokens: number; outputTokens: number; elapsedMs: number }
export interface ResearchBudget {
 toolCalls: number; modelCalls: number; inputTokens: number; outputTokens: number;
 estimatedUsd: number; firecrawlCredits: number; unknownCost: boolean; limits: ResearchBudgetLimits;
}
export interface ResearchMetadata {
 phase: string; steps: number; budget: ResearchBudget; stopReason: string | null; unresolved: string[]; coverage?: ResearchFacetCoverage[];
 /** Exact original excerpts from an explicitly independent account scope.
  * These are materials, never verified claims or named-person conclusions. */
 accountMaterials?: IndependentAccountMaterial[];
 /** Single-account research is a distinct subject, not merged person facets. */
 accountResearch?: XAccountResearchMetadata;
}
export interface XAccountResearchMetadata {
 platform:'x';handle:string;nativeId:string;profileUrl:string;
 timelinePages:number;repliesPages:number;targetPosts:number;contextPosts:number;
 oldestPostAt:string|null;newestPostAt:string|null;
 timelineEnded:boolean;repliesEnded:boolean;verifiedFindings:number;synthesisComplete:boolean;
}
export interface AccountObject {
 schemaVersion:'stripsearch/account/v1';account:{platform:'x';handle:string;nativeId:string;profileUrl:string};
 claims:Array<{id:string;statement:string;kind:ClaimKind;sourceKeys:string[];evidence:Array<{sourceKey:string;quote:string}>}>;
 coverage:XAccountResearchMetadata;report:{runId:string;revision:number;asOf:string};
}
export interface IndependentAccountMaterial { sourceKey:string; sourceUrl:string; quote:string; quoteOffset:number; sourceContentHash:string }
export interface PersonObject {
 schemaVersion: 'stripsearch/person/v1';
 person: { id: string; displayName: string; profileUrl: string };
 claims: { id: string; statement: string; kind: ClaimKind; sourceKeys: string[]; evidenceIds: string[] }[];
 evidence: { id: string; sourceKey: string; quote: string }[];
 unknowns: string[];
 report: { runId: string; revision: number; asOf: string };
}
