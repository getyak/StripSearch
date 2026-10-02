/**
 * Strict schema for the research-baseline-v1 offline controller replay.
 *
 * The dataset carries versioned original synthetic fixtures with recorded
 * content hashes and structural expectations; it is not a historical freeze
 * claim and nothing in it is a human gold label (`review_status` must stay
 * `unreviewed`). Every case declares a strict ordered script for the injected
 * fixture tools and the injected fixture planner. Unknown fields and invalid
 * types are rejected, never ignored. `expect.modelCalls` counts ACTUAL model
 * gateway invocations of the execution (always zero here), never ledger
 * receipts from earlier attempts.
 */

import type { ResearchBudgetLimits } from '../../shared/types.js';

export type BaselineState = 'completed' | 'partial' | 'needs_input' | 'runner_error';
export type BaselineIdentityStatus = 'resolved' | 'needs_input' | 'ambiguous';
export type BaselineClaimKind = 'attributed_statement' | 'page_statement' | 'inference';
export type BaselineSection = 'background' | 'work' | 'expression' | 'analysis';
export type BaselineToolKind = 'search' | 'read' | 'firecrawl' | 'social_profile' | 'social_posts' | 'github_profile';

export const DATASET_VERSION = 'research-baseline-v2';
export type DatasetVersion = 'research-baseline-v1' | 'research-baseline-v2';
export const DATASET_PROVENANCE = 'original-synthetic';

export class BaselineSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineSchemaError';
  }
}

function fail(path: string, message: string): never {
  throw new BaselineSchemaError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `unknown field "${key}"`);
  }
}

function str(value: unknown, path: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (opts.min !== undefined && value.length < opts.min) fail(path, `must be at least ${opts.min} characters`);
  if (opts.max !== undefined && value.length > opts.max) fail(path, `must be at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function strOrNull(value: unknown, path: string): string | null {
  return value === null ? null : str(value, path);
}

function int(value: unknown, path: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(path, 'must be an integer');
  if (opts.min !== undefined && value < opts.min) fail(path, `must be >= ${opts.min}`);
  if (opts.max !== undefined && value > opts.max) fail(path, `must be <= ${opts.max}`);
  return value;
}

function num(value: unknown, path: string, opts: { min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
  if (opts.min !== undefined && value < opts.min) fail(path, `must be >= ${opts.min}`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `must be one of ${allowed.join(', ')}`);
  return value as T;
}

const TOOL_KINDS: readonly BaselineToolKind[] = ['search', 'read', 'firecrawl', 'social_profile', 'social_posts', 'github_profile'];
const CLAIM_KINDS: readonly BaselineClaimKind[] = ['attributed_statement', 'page_statement', 'inference'];
const SECTIONS: readonly BaselineSection[] = ['background', 'work', 'expression', 'analysis'];
const STATES: readonly BaselineState[] = ['completed', 'partial', 'needs_input', 'runner_error'];
const IDENTITY_STATUSES: readonly BaselineIdentityStatus[] = ['resolved', 'needs_input', 'ambiguous'];

export interface ScriptedAction {
  type: BaselineToolKind;
  query?: string;
  url?: string;
}

export interface ScriptedAccount {
  platform: 'github' | 'x';
  handle: string;
  id: string;
  profileUrl: string;
}

export interface ScriptedPage {
  url: string;
  title: string;
  text: string;
  kind: 'profile' | 'work' | 'third_party';
  publishedAt: string | null;
  account?: ScriptedAccount;
  links: string[];
  limitations: string[];
}

export interface ScriptedToolResult {
  pages: ScriptedPage[];
  requests: number;
  bytes: number;
  estimatedUsd: number | null;
  credits: number | null;
  limitations: string[];
}

export interface ScriptedToolError {
  kind: 'provider' | 'error';
  code: string;
  message: string;
}

export interface ScriptedToolStep {
  action: ScriptedAction;
  result?: ScriptedToolResult;
  error?: ScriptedToolError;
  /** Fault injection: attempt real outbound network; the process guard must stop it. */
  networkAttempt?: string;
}

export interface ScriptedPlannerStep {
  mode: 'plan' | 'verify';
  decision: unknown;
  expectClaims?: number;
}

export interface ScriptedInflightReceipt {
  key: string;
  kind: 'tool' | 'model';
  request: unknown;
}

export interface BaselinePreState {
  inflightReceipts?: ScriptedInflightReceipt[];
  cancelRequested?: boolean;
}

export interface BaselineClaimKindExpectation {
  contains: string;
  kind: BaselineClaimKind;
}

export interface BaselineReceiptsExpectation {
  total: number;
  completed: number;
  failed: number;
  inflight: number;
}

export interface BaselineExpect {
  state: BaselineState;
  stopReason: string | null;
  identityStatus?: BaselineIdentityStatus;
  toolCalls: number;
  plannerCalls: number;
  modelCalls: number;
  receipts: BaselineReceiptsExpectation;
  unknownCost: boolean;
  claimsRetained?: number;
  candidates?: number;
  includeText?: string[];
  excludeText?: string[];
  claimKinds?: BaselineClaimKindExpectation[];
  runnerError?: string;
  runnerErrorIncludes?: string[];
}

export interface BaselineInput {
  question: string;
  seedUrl: string | null;
}

export interface BaselineCase {
  caseId: string;
  datasetVersion: DatasetVersion;
  title: string;
  scenario: string;
  split: 'discovery' | 'regression';
  reviewStatus: 'unreviewed';
  provenance: typeof DATASET_PROVENANCE;
  tags: string[];
  input: BaselineInput;
  limits?: Partial<ResearchBudgetLimits>;
  preState?: BaselinePreState;
  tools: ScriptedToolStep[];
  planner: ScriptedPlannerStep[];
  expect: BaselineExpect;
}

const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseAction(value: unknown, path: string): ScriptedAction {
  const raw = record(value, path);
  const type = enumValue(raw.type, TOOL_KINDS, `${path}.type`);
  if (type === 'search') {
    exactKeys(raw, ['type', 'query'], path);
    return { type, query: str(raw.query, `${path}.query`, { min: 1, max: 600 }) };
  }
  exactKeys(raw, ['type', 'url'], path);
  return { type, url: str(raw.url, `${path}.url`, { min: 1, max: 2000 }) };
}

function parsePage(value: unknown, path: string): ScriptedPage {
  const raw = record(value, path);
  exactKeys(raw, ['url', 'title', 'text', 'kind', 'publishedAt', 'account', 'links', 'limitations'], path);
  const page: ScriptedPage = {
    url: str(raw.url, `${path}.url`, { min: 1 }),
    title: str(raw.title, `${path}.title`),
    text: str(raw.text, `${path}.text`),
    kind: enumValue(raw.kind, ['profile', 'work', 'third_party'] as const, `${path}.kind`),
    publishedAt: strOrNull(raw.publishedAt, `${path}.publishedAt`),
    links: arr(raw.links, `${path}.links`).map((item, index) => str(item, `${path}.links[${index}]`)),
    limitations: arr(raw.limitations, `${path}.limitations`).map((item, index) => str(item, `${path}.limitations[${index}]`))
  };
  if (raw.account !== undefined) {
    const account = record(raw.account, `${path}.account`);
    exactKeys(account, ['platform', 'handle', 'id', 'profileUrl'], `${path}.account`);
    page.account = {
      platform: enumValue(account.platform, ['github', 'x'] as const, `${path}.account.platform`),
      handle: str(account.handle, `${path}.account.handle`),
      id: str(account.id, `${path}.account.id`),
      profileUrl: str(account.profileUrl, `${path}.account.profileUrl`)
    };
  }
  return page;
}

function parseToolResult(value: unknown, path: string): ScriptedToolResult {
  const raw = record(value, path);
  exactKeys(raw, ['pages', 'requests', 'bytes', 'estimatedUsd', 'credits', 'limitations'], path);
  return {
    pages: arr(raw.pages, `${path}.pages`).map((item, index) => parsePage(item, `${path}.pages[${index}]`)),
    requests: int(raw.requests, `${path}.requests`, { min: 1, max: 1 }),
    bytes: int(raw.bytes, `${path}.bytes`, { min: 0 }),
    estimatedUsd: raw.estimatedUsd === null ? null : num(raw.estimatedUsd, `${path}.estimatedUsd`, { min: 0 }),
    credits: raw.credits === null ? null : int(raw.credits, `${path}.credits`, { min: 0 }),
    limitations: arr(raw.limitations, `${path}.limitations`).map((item, index) => str(item, `${path}.limitations[${index}]`))
  };
}

function parseToolStep(value: unknown, path: string): ScriptedToolStep {
  const raw = record(value, path);
  exactKeys(raw, ['action', 'result', 'error', 'networkAttempt'], path);
  const step: ScriptedToolStep = { action: parseAction(raw.action, `${path}.action`) };
  const hasResult = raw.result !== undefined;
  const hasError = raw.error !== undefined;
  if (hasResult === hasError) fail(path, 'must declare exactly one of "result" or "error"');
  if (hasResult) step.result = parseToolResult(raw.result, `${path}.result`);
  if (hasError) {
    const error = record(raw.error, `${path}.error`);
    exactKeys(error, ['kind', 'code', 'message'], `${path}.error`);
    step.error = {
      kind: enumValue(error.kind, ['provider', 'error'] as const, `${path}.error.kind`),
      code: str(error.code, `${path}.error.code`),
      message: str(error.message, `${path}.error.message`)
    };
  }
  if (raw.networkAttempt !== undefined) {
    step.networkAttempt = str(raw.networkAttempt, `${path}.networkAttempt`, { min: 1 });
  }
  return step;
}

function parsePlannerStep(value: unknown, path: string): ScriptedPlannerStep {
  const raw = record(value, path);
  exactKeys(raw, ['mode', 'decision', 'expectClaims'], path);
  const step: ScriptedPlannerStep = {
    mode: enumValue(raw.mode, ['plan', 'verify'] as const, `${path}.mode`),
    decision: raw.decision
  };
  if (raw.expectClaims !== undefined) step.expectClaims = int(raw.expectClaims, `${path}.expectClaims`, { min: 0 });
  return step;
}

function parseLimits(value: unknown, path: string): Partial<ResearchBudgetLimits> {
  const raw = record(value, path);
  exactKeys(raw, ['toolCalls', 'modelCalls', 'inputTokens', 'outputTokens', 'elapsedMs'], path);
  const limits: Partial<ResearchBudgetLimits> = {};
  for (const key of ['toolCalls', 'modelCalls', 'inputTokens', 'outputTokens', 'elapsedMs'] as const) {
    if (raw[key] !== undefined) limits[key] = int(raw[key], `${path}.${key}`, { min: 1 });
  }
  return limits;
}

function parsePreState(value: unknown, path: string): BaselinePreState {
  const raw = record(value, path);
  exactKeys(raw, ['inflightReceipts', 'cancelRequested'], path);
  const preState: BaselinePreState = {};
  if (raw.inflightReceipts !== undefined) {
    preState.inflightReceipts = arr(raw.inflightReceipts, `${path}.inflightReceipts`).map((item, index) => {
      const receipt = record(item, `${path}.inflightReceipts[${index}]`);
      exactKeys(receipt, ['key', 'kind', 'request'], `${path}.inflightReceipts[${index}]`);
      return {
        key: str(receipt.key, `${path}.inflightReceipts[${index}].key`),
        kind: enumValue(receipt.kind, ['tool', 'model'] as const, `${path}.inflightReceipts[${index}].kind`),
        request: receipt.request
      };
    });
  }
  if (raw.cancelRequested !== undefined) preState.cancelRequested = bool(raw.cancelRequested, `${path}.cancelRequested`);
  return preState;
}

function parseExpect(value: unknown, path: string): BaselineExpect {
  const raw = record(value, path);
  exactKeys(raw, [
    'state', 'stopReason', 'identityStatus', 'toolCalls', 'plannerCalls', 'modelCalls',
    'receipts', 'unknownCost', 'claimsRetained', 'candidates', 'includeText', 'excludeText',
    'claimKinds', 'runnerError', 'runnerErrorIncludes'
  ], path);
  const receiptsRaw = record(raw.receipts, `${path}.receipts`);
  exactKeys(receiptsRaw, ['total', 'completed', 'failed', 'inflight'], `${path}.receipts`);
  const expect: BaselineExpect = {
    state: enumValue(raw.state, STATES, `${path}.state`),
    stopReason: strOrNull(raw.stopReason, `${path}.stopReason`),
    toolCalls: int(raw.toolCalls, `${path}.toolCalls`, { min: 0 }),
    plannerCalls: int(raw.plannerCalls, `${path}.plannerCalls`, { min: 0 }),
    modelCalls: int(raw.modelCalls, `${path}.modelCalls`, { min: 0 }),
    receipts: {
      total: int(receiptsRaw.total, `${path}.receipts.total`, { min: 0 }),
      completed: int(receiptsRaw.completed, `${path}.receipts.completed`, { min: 0 }),
      failed: int(receiptsRaw.failed, `${path}.receipts.failed`, { min: 0 }),
      inflight: int(receiptsRaw.inflight, `${path}.receipts.inflight`, { min: 0 })
    },
    unknownCost: bool(raw.unknownCost, `${path}.unknownCost`)
  };
  const receiptSum = expect.receipts.completed + expect.receipts.failed + expect.receipts.inflight;
  if (receiptSum !== expect.receipts.total) fail(`${path}.receipts`, 'completed + failed + inflight must equal total');
  if (raw.identityStatus !== undefined) expect.identityStatus = enumValue(raw.identityStatus, IDENTITY_STATUSES, `${path}.identityStatus`);
  if (raw.claimsRetained !== undefined) expect.claimsRetained = int(raw.claimsRetained, `${path}.claimsRetained`, { min: 0 });
  if (raw.candidates !== undefined) expect.candidates = int(raw.candidates, `${path}.candidates`, { min: 0 });
  if (raw.includeText !== undefined) {
    expect.includeText = arr(raw.includeText, `${path}.includeText`).map((item, index) => str(item, `${path}.includeText[${index}]`, { min: 1 }));
  }
  if (raw.excludeText !== undefined) {
    expect.excludeText = arr(raw.excludeText, `${path}.excludeText`).map((item, index) => str(item, `${path}.excludeText[${index}]`, { min: 1 }));
  }
  if (raw.claimKinds !== undefined) {
    expect.claimKinds = arr(raw.claimKinds, `${path}.claimKinds`).map((item, index) => {
      const entry = record(item, `${path}.claimKinds[${index}]`);
      exactKeys(entry, ['contains', 'kind'], `${path}.claimKinds[${index}]`);
      return {
        contains: str(entry.contains, `${path}.claimKinds[${index}].contains`, { min: 1 }),
        kind: enumValue(entry.kind, CLAIM_KINDS, `${path}.claimKinds[${index}].kind`)
      };
    });
  }
  if (raw.runnerError !== undefined) expect.runnerError = str(raw.runnerError, `${path}.runnerError`, { min: 1 });
  if (raw.runnerErrorIncludes !== undefined) {
    expect.runnerErrorIncludes = arr(raw.runnerErrorIncludes, `${path}.runnerErrorIncludes`)
      .map((item, index) => str(item, `${path}.runnerErrorIncludes[${index}]`, { min: 1 }));
  }
  return expect;
}

export function parseCase(value: unknown, path = 'case'): BaselineCase {
  const raw = record(value, path);
  exactKeys(raw, [
    'case_id', 'dataset_version', 'title', 'scenario', 'split', 'review_status', 'provenance',
    'tags', 'input', 'limits', 'pre_state', 'tools', 'planner', 'expect'
  ], path);
  const tags = arr(raw.tags, `${path}.tags`).map((item, index) => str(item, `${path}.tags[${index}]`));
  if (new Set(tags).size !== tags.length) fail(`${path}.tags`, 'must not contain duplicates');
  const inputRaw = record(raw.input, `${path}.input`);
  exactKeys(inputRaw, ['question', 'seedUrl'], `${path}.input`);
  const entry: BaselineCase = {
    caseId: str(raw.case_id, `${path}.case_id`, { min: 1, pattern: CASE_ID_PATTERN }),
    datasetVersion: enumValue(raw.dataset_version, ['research-baseline-v1','research-baseline-v2'] as const, `${path}.dataset_version`),
    title: str(raw.title, `${path}.title`, { min: 1 }),
    scenario: str(raw.scenario, `${path}.scenario`, { min: 1 }),
    split: enumValue(raw.split, ['discovery', 'regression'] as const, `${path}.split`),
    reviewStatus: enumValue(raw.review_status, ['unreviewed'] as const, `${path}.review_status`),
    provenance: enumValue(raw.provenance, [DATASET_PROVENANCE] as const, `${path}.provenance`),
    tags,
    input: {
      question: str(inputRaw.question, `${path}.input.question`, { min: 1 }),
      seedUrl: inputRaw.seedUrl === null ? null : str(inputRaw.seedUrl, `${path}.input.seedUrl`, { min: 1 })
    },
    tools: arr(raw.tools, `${path}.tools`).map((item, index) => parseToolStep(item, `${path}.tools[${index}]`)),
    planner: arr(raw.planner, `${path}.planner`).map((item, index) => parsePlannerStep(item, `${path}.planner[${index}]`)),
    expect: parseExpect(raw.expect, `${path}.expect`)
  };
  if (raw.limits !== undefined) entry.limits = parseLimits(raw.limits, `${path}.limits`);
  if (raw.pre_state !== undefined) entry.preState = parsePreState(raw.pre_state, `${path}.pre_state`);
  return entry;
}

export interface DatasetValidation {
  cases: number;
  scenarios: string[];
}

/** Dataset-level checks: unique ids and no scripted model invocation in this baseline. */
export function validateDataset(cases: BaselineCase[]): DatasetValidation {
  const seen = new Set<string>();
  for (const entry of cases) {
    if (seen.has(entry.caseId)) throw new BaselineSchemaError(`duplicate case_id "${entry.caseId}"`);
    seen.add(entry.caseId);
    if (entry.expect.modelCalls !== 0) {
      throw new BaselineSchemaError(`${entry.caseId}: this replay never invokes a model; expect.modelCalls must be 0`);
    }
  }
  return { cases: cases.length, scenarios: [...new Set(cases.map((entry) => entry.scenario))] };
}

export function parseDataset(text: string): BaselineCase[] {
  const cases: BaselineCase[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new BaselineSchemaError(`cases.jsonl line ${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    cases.push(parseCase(parsed, `cases.jsonl line ${index + 1}`));
  }
  if (cases.length === 0) throw new BaselineSchemaError('dataset is empty');
  validateDataset(cases);
  if(new Set(cases.map(c=>c.datasetVersion)).size!==1)throw new BaselineSchemaError('mixed dataset versions');
  return cases;
}
