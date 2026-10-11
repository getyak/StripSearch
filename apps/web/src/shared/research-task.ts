/**
 * Shared contract for the candidate-free research task library.
 *
 * These types describe a person-research **evaluation specification** plus its
 * evaluator checks. Nothing in here has ever been executed: there are no model
 * outputs and no human judgments attached to a task. AI-authored proposed
 * criteria are proposals, never human labels and never gold.
 *
 * The parser is pure and shared: the server is the authority (400 on any
 * invalid or oversize value, never truncation) and the client can reuse the
 * same bounds for its import dialog without diverging.
 */

import { LIMITS } from './limits.js';
import { stripControlCharacters as stripControls, validateSeedUrl } from './validation.js';

export const RESEARCH_MODEL_INPUT_VERSION = 'stripsearch/research-model-input/v1';
export const RESEARCH_SPEC_EXPORT_VERSION = 'stripsearch/research-task-spec/v1';

export type ResearchSourcePackStatus = 'incomplete';
export type ResearchInteractionSampleStatus = 'not_systematically_sampled';
export type ResearchExecutionStatus = 'not_run';
export type ResearchReviewStatus = 'unreviewed';

export interface ResearchCheck {
  id: string;
  focus: string;
  lookFor: string;
}

/** The bounded, immutable evaluation specification a reviewer imports. */
export interface ResearchTaskInput {
  externalId: string;
  datasetVersion: string;
  title: string;
  input: {
    prompt: string;
    identitySeedUrls: string[];
  };
  commonChecks: ResearchCheck[];
  personChecks: ResearchCheck[];
  observedStartingPoint: string;
  typicalFailure: string;
  sourcePackStatus: ResearchSourcePackStatus;
  interactionSampleStatus: ResearchInteractionSampleStatus;
}

/**
 * The server-attached immutable record. Every execution/review field is fixed
 * at creation: no run exists, no label exists, and none may be implied.
 */
export interface ResearchTaskView extends ResearchTaskInput {
  taskId: string;
  split: 'discovery';
  contentHash: string;
  createdAt: string;
  executionStatus: ResearchExecutionStatus;
  reviewStatus: ResearchReviewStatus;
  modelOutputs: [];
  humanLabels: null;
}

/** Queue row: safe owner data only, without the evaluator criteria bodies. */
export interface ResearchTaskListItem {
  taskId: string;
  externalId: string;
  datasetVersion: string;
  title: string;
  split: 'discovery';
  contentHash: string;
  createdAt: string;
  executionStatus: ResearchExecutionStatus;
  reviewStatus: ResearchReviewStatus;
  modelOutputCount: 0;
  sourcePackStatus: ResearchSourcePackStatus;
  interactionSampleStatus: ResearchInteractionSampleStatus;
}

/**
 * What a model harness may see. Deliberately excludes every evaluator check,
 * the observation starting point and the typical-failure note so evaluation
 * criteria can never leak into the tested model's prompt.
 */
export interface ResearchModelInput {
  schemaVersion: typeof RESEARCH_MODEL_INPUT_VERSION;
  caseId: string;
  externalId: string;
  datasetVersion: string;
  prompt: string;
  identitySeedUrls: string[];
}

/** The evaluator-facing full specification export, kept separate on purpose. */
export interface ResearchSpecExport {
  schemaVersion: typeof RESEARCH_SPEC_EXPORT_VERSION;
  taskId: string;
  contentHash: string;
  spec: ResearchTaskSpec;
}

export type ResearchTaskSpec = ResearchTaskInput;

export type ResearchParseResult =
  | { ok: true; spec: ResearchTaskSpec }
  | { ok: false; message: string };

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

class ParseFailure extends Error {}

function requiredText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') {
    throw new ParseFailure(`${field} 必须是字符串。`);
  }
  const cleaned = stripControls(value).trim();
  if (cleaned.length === 0) {
    throw new ParseFailure(`${field} 不能为空。`);
  }
  if (cleaned.length > max) {
    throw new ParseFailure(`${field} 不能超过 ${max} 个字符。`);
  }
  return cleaned;
}

function parseChecks(value: unknown, field: string, maxItems: number): ResearchCheck[] {
  if (!Array.isArray(value)) {
    throw new ParseFailure(`${field} 必须是数组。`);
  }
  if (value.length < 1 || value.length > maxItems) {
    throw new ParseFailure(`${field} 需要 1–${maxItems} 条检查项。`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = plainObject(raw);
    if (!item) {
      throw new ParseFailure(`${field} 第 ${index + 1} 条必须是对象。`);
    }
    const id = requiredText(item.id, LIMITS.researchTaskCheckIdMax, `${field} 第 ${index + 1} 条 id`);
    if (seen.has(id)) {
      throw new ParseFailure(`${field} 的检查项 id 重复：${id}`);
    }
    seen.add(id);
    return {
      id,
      focus: requiredText(item.focus, LIMITS.researchTaskFocusMax, `${field} 第 ${index + 1} 条 focus`),
      lookFor: requiredText(item.lookFor, LIMITS.researchTaskLookForMax, `${field} 第 ${index + 1} 条 lookFor`)
    };
  });
}

function parseSeedUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ParseFailure('input.identitySeedUrls 必须是数组。');
  }
  if (value.length < 1 || value.length > LIMITS.researchTaskSeedUrlsMax) {
    throw new ParseFailure(`input.identitySeedUrls 需要 1–${LIMITS.researchTaskSeedUrlsMax} 条链接。`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw !== 'string') {
      throw new ParseFailure(`身份种子链接第 ${index + 1} 条必须是字符串。`);
    }
    const check = validateSeedUrl(raw);
    if (!check.ok || !check.url) {
      throw new ParseFailure(
        `身份种子链接第 ${index + 1} 条无效：${check.error ?? '只支持 http(s) 链接。'}`
      );
    }
    if (seen.has(check.url)) {
      throw new ParseFailure(`身份种子链接重复：${check.url}`);
    }
    seen.add(check.url);
    return check.url;
  });
}

/**
 * Validate and normalize one task payload. Returns the first problem as a
 * human-readable message; callers must reject rather than truncate.
 */
export function parseResearchTaskInput(value: unknown): ResearchParseResult {
  try {
    const body = plainObject(value);
    if (!body) {
      throw new ParseFailure('请求体必须是一个研究任务对象（数组请逐条提交）。');
    }
    const input = plainObject(body.input);
    if (!input) {
      throw new ParseFailure('input 必须是包含 prompt 与 identitySeedUrls 的对象。');
    }
    if (body.sourcePackStatus !== 'incomplete') {
      throw new ParseFailure('sourcePackStatus 只能是 incomplete。');
    }
    if (body.interactionSampleStatus !== 'not_systematically_sampled') {
      throw new ParseFailure('interactionSampleStatus 只能是 not_systematically_sampled。');
    }
    const spec: ResearchTaskSpec = {
      externalId: requiredText(
        body.externalId,
        LIMITS.researchTaskExternalIdMax,
        'externalId'
      ),
      datasetVersion: requiredText(
        body.datasetVersion,
        LIMITS.researchTaskDatasetVersionMax,
        'datasetVersion'
      ),
      title: requiredText(body.title, LIMITS.reviewTitleMax, 'title'),
      input: {
        prompt: requiredText(input.prompt, LIMITS.researchTaskPromptMax, 'input.prompt'),
        identitySeedUrls: parseSeedUrls(input.identitySeedUrls)
      },
      commonChecks: parseChecks(
        body.commonChecks,
        'commonChecks',
        LIMITS.researchTaskChecksMax
      ),
      personChecks: parseChecks(
        body.personChecks,
        'personChecks',
        LIMITS.researchTaskChecksMax
      ),
      observedStartingPoint: requiredText(
        body.observedStartingPoint,
        LIMITS.researchTaskObservationMax,
        'observedStartingPoint'
      ),
      typicalFailure: requiredText(
        body.typicalFailure,
        LIMITS.researchTaskFailureMax,
        'typicalFailure'
      ),
      sourcePackStatus: 'incomplete',
      interactionSampleStatus: 'not_systematically_sampled'
    };
    return { ok: true, spec };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, message: error.message };
    return { ok: false, message: '研究任务规范格式不正确。' };
  }
}

/** Exactly the object that `contentHash = sha256(stableStringify(spec))` covers. */
export function researchTaskSpec(view: ResearchTaskView): ResearchTaskSpec {
  return {
    externalId: view.externalId,
    datasetVersion: view.datasetVersion,
    title: view.title,
    input: {
      prompt: view.input.prompt,
      identitySeedUrls: [...view.input.identitySeedUrls]
    },
    commonChecks: view.commonChecks.map((check) => ({ ...check })),
    personChecks: view.personChecks.map((check) => ({ ...check })),
    observedStartingPoint: view.observedStartingPoint,
    typicalFailure: view.typicalFailure,
    sourcePackStatus: view.sourcePackStatus,
    interactionSampleStatus: view.interactionSampleStatus
  };
}

/**
 * Model-input-only export: prompt, seed URLs and case identity. No evaluator
 * check, observation or failure note may ever appear here.
 */
export function researchModelInput(
  task: Pick<ResearchTaskView, 'taskId' | 'externalId' | 'datasetVersion' | 'input'>
): ResearchModelInput {
  return {
    schemaVersion: RESEARCH_MODEL_INPUT_VERSION,
    caseId: task.taskId,
    externalId: task.externalId,
    datasetVersion: task.datasetVersion,
    prompt: task.input.prompt,
    identitySeedUrls: [...task.input.identitySeedUrls]
  };
}

/** Full evaluator specification export, kept separate from the model input. */
export function researchSpecExport(task: ResearchTaskView): ResearchSpecExport {
  return {
    schemaVersion: RESEARCH_SPEC_EXPORT_VERSION,
    taskId: task.taskId,
    contentHash: task.contentHash,
    spec: researchTaskSpec(task)
  };
}
