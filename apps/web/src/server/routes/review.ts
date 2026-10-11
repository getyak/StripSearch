import { Router } from 'express';
import type { Request, Response } from 'express';
import { LIMITS } from '../../shared/limits.js';
import { stripControlCharacters, validateQuestion } from '../../shared/validation.js';
import {
  REVIEW_SCHEMA_VERSION,
  isClaimLabel,
  isPreference,
  isReasonTag,
  isReviewStatus,
  validateAnnotationShape
} from '../../shared/review.js';
import { parseResearchTaskInput } from '../../shared/research-task.js';
import type { ResearchTaskSpec } from '../../shared/research-task.js';
import type {
  ClaimLabel,
  Preference,
  QueueStatus,
  ReasonTag,
  ReviewAnnotationSaveInput,
  ReviewAnnotationView,
  ReviewDecision,
  ReviewExportRecord,
  ReviewRubric,
  ReviewSource
} from '../../shared/review.js';
import { HttpError } from '../http/errors.js';
import { readBody } from '../http/request-input.js';
import { requireUser } from '../http/middleware.js';
import { PRACTICE_BADGE, PRACTICE_CASES } from '../review-seed.js';
import {
  buildUserContent as buildUserCandidateSet,
  caseStatus,
  contentHashOf,
  reviewerPseudonym,
  snapshotForRecord,
  toAnnotationView,
  toCaseDetail,
  toHistoryEntry,
  toProvenanceList,
  toResearchTaskListItem,
  toResearchTaskView,
  type ReviewAnnotationRecord,
  type ReviewCaseRecord,
  type ReviewStore
} from '../review-store.js';

export interface ReviewRouteDeps {
  reviewStore: ReviewStore;
}

const CLAIM_ID_MAX = 160;
const EVIDENCE_ID_MAX = 40;
const RUBRIC_LIST_MAX = 20;

function cleanText(value: string): string {
  // Shared control-character policy (`shared/validation.stripControlCharacters`);
  // the reject-not-truncate behavior of requireText/optionalText below is
  // review-route policy and stays local.
  return stripControlCharacters(value);
}

/** Reject rather than silently truncate a human judgment. */
function requireText(value: unknown, max: number, code: string, field: string): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, code, `${field} 必须是字符串。`);
  }
  const cleaned = cleanText(value).trim();
  if (cleaned.length === 0) {
    throw new HttpError(400, code, `${field} 不能为空。`);
  }
  if (cleaned.length > max) {
    throw new HttpError(400, code, `${field} 不能超过 ${max} 个字符。`);
  }
  return cleaned;
}

function optionalText(value: unknown, max: number, code: string, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return requireText(value, max, code, field);
}

function parseEnumValue<T extends string>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  code: string,
  field: string
): T {
  if (!guard(value)) {
    throw new HttpError(400, code, `${field} 不是受支持的取值。`);
  }
  return value;
}

function parseClaims(raw: unknown, fieldLabel: string): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => cleanText(line).trim())
    .filter((line) => line.length > 0);
  if (lines.length > LIMITS.reviewMaxClaimsPerCandidate) {
    throw new HttpError(
      400,
      'invalid_case',
      `${fieldLabel} 最多 ${LIMITS.reviewMaxClaimsPerCandidate} 条论断，请每行一条。`
    );
  }
  for (const line of lines) {
    if (line.length > LIMITS.reviewClaimTextMax) {
      throw new HttpError(400, 'invalid_case', `${fieldLabel} 单条论断不能超过 ${LIMITS.reviewClaimTextMax} 个字符。`);
    }
  }
  return lines;
}

interface ParsedCandidate {
  origin: string | null;
  model: string | null;
  notes: string | null;
  claims: string[];
}

function parseCreateCase(body: Record<string, unknown>): {
  title: string;
  question: string;
  asOf: string | null;
  sources: ReviewSource[];
  candidates: [ParsedCandidate, ParsedCandidate];
} {
  const questionCheck = validateQuestion(body.question);
  if (!questionCheck.ok) {
    throw new HttpError(400, 'invalid_case', questionCheck.error ?? '问题无效。');
  }
  const question = String(body.question).trim().replace(/\s+/g, ' ');

  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw new HttpError(400, 'invalid_case', '至少需要一条证据。');
  }
  if (body.sources.length > LIMITS.reviewMaxSources) {
    throw new HttpError(400, 'invalid_case', `证据最多 ${LIMITS.reviewMaxSources} 条。`);
  }
  const sources: ReviewSource[] = body.sources.map((raw, index) => {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const position = index + 1;
    const hasAny = typeof item.title === 'string' || typeof item.text === 'string' || typeof item.locator === 'string';
    const title = item.title === '' || item.title === undefined ? null : requireText(item.title, LIMITS.reviewSourceTitleMax, 'invalid_case', `第 ${position} 条证据标题`);
    const text = item.text === '' || item.text === undefined ? null : requireText(item.text, LIMITS.reviewSourceTextMax, 'invalid_case', `第 ${position} 条证据正文`);
    if (!title || !text) {
      throw new HttpError(
        400,
        'invalid_case',
        hasAny
          ? `第 ${position} 条证据不完整：需要标题和正文，不会丢弃你已填写的内容。`
          : `第 ${position} 条证据为空，请填写标题和正文。`
      );
    }
    return {
      sourceId: `S${position}`,
      title,
      text,
      locator: optionalText(item.locator, LIMITS.reviewSourceLocatorMax, 'invalid_case', `第 ${position} 条证据定位`)
    };
  });

  if (!Array.isArray(body.candidates) || body.candidates.length !== 2) {
    throw new HttpError(400, 'invalid_case', '需要两个候选回答。');
  }
  const candidates = body.candidates.map((raw, index) => {
    const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const label = index === 0 ? 'A' : 'B';
    const claims = parseClaims(item.response, `候选 ${label}`);
    if (claims.length === 0) {
      throw new HttpError(400, 'invalid_case', `候选 ${label} 至少需要一条论断（每行一条）。`);
    }
    return {
      origin: optionalText(item.origin, LIMITS.reviewCandidateOriginMax, 'invalid_case', `候选 ${label} 来源`),
      model: optionalText(item.model, LIMITS.reviewCandidateModelMax, 'invalid_case', `候选 ${label} 模型`),
      notes: optionalText(item.notes, LIMITS.reviewCandidateNotesMax, 'invalid_case', `候选 ${label} 说明`),
      claims
    };
  }) as [ParsedCandidate, ParsedCandidate];

  const title =
    optionalText(body.title, LIMITS.reviewTitleMax, 'invalid_case', '标题') ??
    (question.length > 40 ? `${question.slice(0, 40)}…` : question);

  return {
    title,
    question,
    asOf: optionalText(body.asOf, LIMITS.reviewAsOfMax, 'invalid_case', '时间'),
    sources,
    candidates
  };
}

function parseDecisions(raw: unknown, code: string): ReviewDecision[] {
  if (!Array.isArray(raw)) {
    throw new HttpError(400, code, 'decisions 必须是数组。');
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, code, `第 ${index + 1} 条判断格式不正确。`);
    }
    const record = item as Record<string, unknown>;
    const claimId = requireText(record.claimId, CLAIM_ID_MAX, code, 'claimId');
    const label: ClaimLabel | null =
      record.label === null || record.label === undefined
        ? null
        : parseEnumValue(record.label, isClaimLabel, code, 'label');
    if (!Array.isArray(record.evidenceIds)) {
      throw new HttpError(400, code, 'evidenceIds 必须是数组。');
    }
    const evidenceIds = record.evidenceIds.map((id) => {
      if (typeof id !== 'string') {
        throw new HttpError(400, code, 'evidenceIds 必须全部是证据 ID 字符串。');
      }
      const cleaned = cleanText(id).trim();
      if (cleaned.length === 0 || cleaned.length > EVIDENCE_ID_MAX) {
        throw new HttpError(400, code, '证据 ID 格式不正确。');
      }
      return cleaned;
    });
    return {
      claimId,
      label,
      evidenceIds,
      note: optionalText(record.note, LIMITS.reviewNoteMax, code, 'note')
    };
  });
}

function parseReasonTags(raw: unknown, code: string): ReasonTag[] {
  if (!Array.isArray(raw)) {
    throw new HttpError(400, code, 'reasonTags 必须是数组。');
  }
  const tags: ReasonTag[] = [];
  for (const item of raw) {
    const tag = parseEnumValue(item, isReasonTag, code, 'reasonTags');
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > LIMITS.reviewMaxReasonTags) {
    throw new HttpError(400, code, `理由标签最多 ${LIMITS.reviewMaxReasonTags} 个。`);
  }
  return tags;
}

function parseListStrict(
  raw: unknown,
  maxItems: number,
  maxItemLength: number,
  code: string,
  field: string
): string[] {
  let items: string[];
  if (raw === null || raw === undefined) {
    return [];
  } else if (Array.isArray(raw)) {
    items = raw.map((item, index) => {
      if (typeof item !== 'string') {
        throw new HttpError(400, code, `${field} 第 ${index + 1} 项必须是字符串。`);
      }
      return cleanText(item).trim();
    });
  } else if (typeof raw === 'string') {
    items = raw.split(/\r?\n/).map((line) => cleanText(line).trim());
  } else {
    throw new HttpError(400, code, `${field} 必须是字符串或字符串数组。`);
  }
  const nonEmpty = items.filter((item) => item.length > 0);
  if (nonEmpty.length > maxItems) {
    throw new HttpError(400, code, `${field} 最多 ${maxItems} 条。`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of nonEmpty) {
    if (item.length > maxItemLength) {
      throw new HttpError(400, code, `${field} 单条不能超过 ${maxItemLength} 个字符。`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function parseRubric(raw: unknown, code: string): ReviewRubric {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let referenceAnswer = '';
  if (record.referenceAnswer !== undefined && record.referenceAnswer !== null && record.referenceAnswer !== '') {
    referenceAnswer = requireText(record.referenceAnswer, LIMITS.reviewReferenceAnswerMax, code, '参考答案');
  }
  return {
    referenceAnswer,
    mustInclude: parseListStrict(record.mustInclude, RUBRIC_LIST_MAX, LIMITS.reviewMustIncludeMax, code, '必须包含'),
    mustAvoid: parseListStrict(record.mustAvoid, RUBRIC_LIST_MAX, LIMITS.reviewMustAvoidMax, code, '必须避免')
  };
}

function parseSaveInput(req: Request, record: ReviewCaseRecord): ReviewAnnotationSaveInput {
  const body = readBody(req);
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new HttpError(400, 'invalid_annotation', 'expectedRevision 必须是 >= 0 的安全整数。');
  }
  if (!isReviewStatus(body.status)) {
    throw new HttpError(400, 'invalid_annotation', 'status 必须是 draft 或 submitted。');
  }
  const decisions = parseDecisions(body.decisions, 'invalid_annotation');
  const preferenceRaw = body.preference;
  const preference: Preference | null =
    preferenceRaw === null || preferenceRaw === undefined || preferenceRaw === ''
      ? null
      : parseEnumValue(preferenceRaw, isPreference, 'invalid_annotation', 'preference');
  const rationale = optionalText(body.rationale, LIMITS.reviewRationaleMax, 'invalid_annotation', '判断理由');
  const reasonTags = parseReasonTags(body.reasonTags, 'invalid_annotation');
  const rubric = parseRubric(body.rubric, 'invalid_annotation');

  const issues = validateAnnotationShape(
    {
      sources: record.sources,
      candidates: record.candidateSet.candidates.map((candidate) => ({
        blindLabel: 'A' as const,
        claims: candidate.claims.map((claim) => ({ ...claim }))
      })),
      claimIds: record.candidateSet.candidates.flatMap((candidate) =>
        candidate.claims.map((claim) => claim.claimId)
      )
    },
    { status: body.status, decisions, preference, rationale, reasonTags }
  );
  if (issues.length > 0) {
    throw new HttpError(400, 'invalid_annotation', issues[0]!.message, { issues });
  }

  return {
    expectedRevision,
    status: body.status,
    decisions,
    preference,
    rationale,
    reasonTags,
    rubric
  };
}

function progressOf(records: { record: ReviewCaseRecord; latest: ReviewAnnotationRecord | null }[]): {
  total: number;
  reviewed: number;
  draft: number;
  unreviewed: number;
} {
  const progress = { total: records.length, reviewed: 0, draft: 0, unreviewed: 0 };
  for (const { latest } of records) {
    const status: QueueStatus = caseStatus(latest);
    progress[status] += 1;
  }
  return progress;
}

function buildExportRecord(record: ReviewCaseRecord, annotations: ReviewAnnotationRecord[]): ReviewExportRecord {
  const revisions = annotations.map(toAnnotationView);
  const latest = revisions.length > 0 ? revisions[revisions.length - 1]! : null;
  const accepted = latest?.status === 'submitted';
  const snapshot = snapshotForRecord(record);
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    case: {
      caseId: record.id,
      datasetVersion: record.datasetVersion,
      split: 'discovery',
      kind: record.kind,
      title: record.title,
      question: record.question,
      asOf: record.asOf,
      badge: record.badge,
      rubricVersion: record.rubricVersion,
      contentHash: record.contentHash,
      createdAt: record.createdAt,
      sources: record.sources,
      candidates: (['A', 'B'] as const).map((blindLabel) => {
        const candidate = record.candidateSet.candidates.find(
          (item) => item.candidateId === record.candidateSet.blindMap[blindLabel]
        );
        return { blindLabel, claims: candidate ? candidate.claims.map((claim) => ({ ...claim })) : [] };
      }),
      blindMapping: {
        A: record.candidateSet.blindMap.A,
        B: record.candidateSet.blindMap.B
      },
      provenance: toProvenanceList(record),
      hash: {
        algorithm: 'sha256',
        serialization: 'stableStringify',
        contentHash: contentHashOf(snapshot),
        payload: snapshot
      }
    },
    annotation: latest,
    revisions,
    history: annotations.map(toHistoryEntry),
    reviewer: {
      pseudonymousId: reviewerPseudonym(record.ownerId),
      humanSingleReview: true
    },
    eligibility: {
      accepted,
      basis: 'human_single_review',
      reason: accepted
        ? '已提交的人工单评审记录，可用于探索性分析。'
        : '尚未提交完整评审，不得作为已接受标签。'
    }
  };
}

export function registerReviewRoutes(router: Router, deps: ReviewRouteDeps): void {
  const { reviewStore } = deps;

  router.post('/review/seed', (_req: Request, res: Response) => {
    const user = requireUser(res);
    const result = reviewStore.seedForOwner(user.id, PRACTICE_CASES, PRACTICE_BADGE);
    res.json({
      inserted: result.inserted,
      total: result.total,
      capped: result.capped,
      badge: PRACTICE_BADGE
    });
  });

  router.get('/review/cases', (_req: Request, res: Response) => {
    const user = requireUser(res);
    const records = reviewStore.listCasesForOwner(user.id).map((record) => ({
      record,
      latest: reviewStore.latestAnnotation(record.id)
    }));
    const cases = records.map(({ record, latest }) => ({
      caseId: record.id,
      title: record.title,
      question: record.question,
      badge: record.badge,
      kind: record.kind,
      status: caseStatus(latest),
      latestStatus: latest?.status ?? null,
      latestRevision: latest?.revision ?? 0,
      sourceCount: record.sources.length,
      claimCount: record.candidateSet.candidates.reduce((sum, candidate) => sum + candidate.claims.length, 0),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }));
    res.json({ cases, progress: progressOf(records) });
  });

  router.post('/review/cases', (req: Request, res: Response) => {
    const user = requireUser(res);
    if (reviewStore.countCasesForOwner(user.id) >= LIMITS.reviewMaxCasesPerUser) {
      throw new HttpError(409, 'case_limit', `每个账号最多 ${LIMITS.reviewMaxCasesPerUser} 个案例。`);
    }
    const parsed = parseCreateCase(readBody(req));
    const candidateSet = buildUserCandidateSet(parsed.sources, parsed.candidates);
    const created = reviewStore.insertCase({
      ownerId: user.id,
      seedKey: null,
      datasetVersion: 'user-authored-v1',
      kind: 'user',
      title: parsed.title,
      question: parsed.question,
      asOf: parsed.asOf,
      badge: '自建案例 · 待你判断',
      sources: parsed.sources,
      candidateSet
    });
    res.status(201).json({
      case: {
        caseId: created.id,
        title: created.title,
        question: created.question,
        badge: created.badge,
        kind: created.kind,
        status: 'unreviewed' as QueueStatus,
        latestStatus: null,
        latestRevision: 0,
        sourceCount: created.sources.length,
        claimCount: created.candidateSet.candidates.reduce((sum, candidate) => sum + candidate.claims.length, 0),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt
      }
    });
  });

  router.get('/review/insights', (_req: Request, res: Response) => {
    const user = requireUser(res);
    res.json({ insights: reviewStore.insightsForOwner(user.id) });
  });

  router.get('/review/export', (req: Request, res: Response) => {
    const user = requireUser(res);
    const format = req.query.format === 'jsonl' ? 'jsonl' : 'json';
    const filter = req.query.filter === 'reviewed' ? 'reviewed' : 'all';
    const records = reviewStore.listCasesForOwner(user.id).map((record) => ({
      record,
      annotations: reviewStore.listAllAnnotations(record.id)
    }));
    const selected = records.filter(({ annotations }) =>
      filter === 'all' ? true : annotations[annotations.length - 1]?.status === 'submitted'
    );
    const pseudonym = reviewerPseudonym(user.id);
    const exported = selected.map(({ record, annotations }) => buildExportRecord(record, annotations));
    const filename = `stripsearch-annotations-${filter}.${format === 'jsonl' ? 'jsonl' : 'json'}`;
    if (format === 'jsonl') {
      const lines = exported.map((record) => JSON.stringify(record));
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      res.send(lines.length > 0 ? `${lines.join('\n')}\n` : '');
      return;
    }
    const envelope = {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      hashNote: 'contentHash = sha256(stableStringify(case.hash.payload)); stableStringify sorts object keys, keeps array order and omits undefined.',
      reviewer: { pseudonymousId: pseudonym, humanSingleReview: true as const },
      filter: filter as 'all' | 'reviewed',
      records: exported
    };
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(envelope, null, 2));
  });

  router.get('/review/cases/:caseId', (req: Request, res: Response) => {
    const user = requireUser(res);
    const record = reviewStore.getCaseForOwner(String(req.params.caseId), user.id);
    if (!record) throw new HttpError(404, 'case_not_found', '未找到该标注案例。');
    const latest = reviewStore.latestAnnotation(record.id);
    res.json({
      case: toCaseDetail(record, latest),
      annotation: latest ? toAnnotationView(latest) : null,
      history: [...reviewStore.listAllAnnotations(record.id)].reverse().map(toHistoryEntry)
    });
  });

  router.get('/review/cases/:caseId/history', (req: Request, res: Response) => {
    const user = requireUser(res);
    const record = reviewStore.getCaseForOwner(String(req.params.caseId), user.id);
    if (!record) throw new HttpError(404, 'case_not_found', '未找到该标注案例。');
    const all = reviewStore.listAllAnnotations(record.id);
    const views: ReviewAnnotationView[] = all.map(toAnnotationView);
    res.json({
      history: [...all].reverse().map(toHistoryEntry),
      revisions: views
    });
  });

  router.put('/review/cases/:caseId/annotation', (req: Request, res: Response) => {
    const user = requireUser(res);
    const record = reviewStore.getCaseForOwner(String(req.params.caseId), user.id);
    if (!record) throw new HttpError(404, 'case_not_found', '未找到该标注案例。');
    const input = parseSaveInput(req, record);
    const result = reviewStore.saveAnnotation({
      ownerId: user.id,
      caseId: record.id,
      caseHash: record.contentHash,
      rubricVersion: record.rubricVersion,
      expectedRevision: input.expectedRevision,
      status: input.status,
      decisions: input.decisions,
      preference: input.preference,
      rationale: input.rationale,
      reasonTags: input.reasonTags,
      rubric: input.rubric
    });
    if (!result.ok) {
      throw new HttpError(409, 'stale_revision', '该案例已有更新的评审版本，请刷新后重试。');
    }
    res.json({
      annotation: toAnnotationView(result.annotation),
      acknowledgment: '已保存'
    });
  });

  router.delete('/review/cases/:caseId', (req: Request, res: Response) => {
    const user = requireUser(res);
    const record = reviewStore.getCaseForOwner(String(req.params.caseId), user.id);
    if (!record) throw new HttpError(404, 'case_not_found', '未找到该标注案例。');
    reviewStore.deleteCaseForOwner(record.id, user.id);
    res.status(204).end();
  });

  /* ---------------- candidate-free research task library ---------------- */

  // Reads only: GET never creates, mutates or fetches any seed URL.
  router.get('/review/research-tasks', (_req: Request, res: Response) => {
    const user = requireUser(res);
    const tasks = reviewStore.listResearchTasksForOwner(user.id).map(toResearchTaskListItem);
    res.json({
      tasks,
      note: '研究任务仅为评估规范：尚未运行模型，人工判断为空白。'
    });
  });

  router.post('/review/research-tasks', (req: Request, res: Response) => {
    const user = requireUser(res);
    // `req.body` verbatim: an array payload must be rejected with the explicit
    // single-object message instead of being coerced to `{}`.
    const parsed = parseResearchTaskInput(req.body);
    if (!parsed.ok) {
      throw new HttpError(400, 'invalid_research_task', parsed.message);
    }
    const spec: ResearchTaskSpec = parsed.spec;
    const existing = reviewStore.findResearchTaskByKey(user.id, spec.datasetVersion, spec.externalId);
    if (!existing && reviewStore.countResearchTasksForOwner(user.id) >= LIMITS.researchTaskMaxPerUser) {
      throw new HttpError(409, 'research_task_limit', `每个账号最多 ${LIMITS.researchTaskMaxPerUser} 个研究任务。`);
    }
    const result = reviewStore.createResearchTask({ ownerId: user.id, spec });
    if (!result.ok) {
      throw new HttpError(
        409,
        'research_task_conflict',
        '相同 externalId + datasetVersion 已存在内容不同的研究任务，不覆盖既有快照。'
      );
    }
    res.status(result.created ? 201 : 200).json({
      task: toResearchTaskView(result.record),
      created: result.created
    });
  });

  router.get('/review/research-tasks/:taskId', (req: Request, res: Response) => {
    const user = requireUser(res);
    const record = reviewStore.getResearchTask(String(req.params.taskId), user.id);
    if (!record) throw new HttpError(404, 'research_task_not_found', '未找到该研究任务。');
    res.json({ task: toResearchTaskView(record) });
  });
}
