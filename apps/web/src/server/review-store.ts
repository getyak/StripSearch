import { createHash, randomInt, randomUUID } from 'node:crypto';
import type {
  BlindLabel,
  ClaimLabel,
  Preference,
  QueueStatus,
  ReasonTag,
  ReviewAnnotationView,
  ReviewCandidate,
  ReviewCaseDetail,
  ReviewDecision,
  ReviewHistoryEntry,
  ReviewInsights,
  ReviewProgress,
  ReviewProvenance,
  ReviewRubric,
  ReviewCaseSnapshot,
  ReviewSource,
  ReviewStatus
} from '../shared/review.js';
import {
  CLAIM_LABELS,
  PREFERENCE_LABELS,
  REASON_TAG_LABELS
} from '../shared/review.js';
import type { DB } from './db/index.js';
import { newRecordId as newId, nowIso, parseJson } from './db/row-helpers.js';
import type { SeedCase } from './review-seed.js';
import { LIMITS } from '../shared/limits.js';
import type {
  ResearchCheck,
  ResearchTaskInput,
  ResearchTaskListItem,
  ResearchTaskView
} from '../shared/research-task.js';

export interface StoredClaim {
  claimId: string;
  text: string;
}

export interface StoredCandidate {
  candidateId: string;
  origin: string | null;
  model: string | null;
  notes: string | null;
  claims: StoredClaim[];
}

export interface StoredCandidateSet {
  blindMap: Record<BlindLabel, string>;
  candidates: StoredCandidate[];
}

export interface ReviewCaseRecord {
  id: string;
  ownerId: string;
  seedKey: string | null;
  datasetVersion: string;
  split: 'discovery';
  kind: 'practice' | 'user';
  title: string;
  question: string;
  asOf: string | null;
  badge: string;
  rubricVersion: number;
  contentHash: string;
  sources: ReviewSource[];
  candidateSet: StoredCandidateSet;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewAnnotationRecord {
  id: string;
  caseId: string;
  ownerId: string;
  revision: number;
  status: ReviewStatus;
  actorId: string;
  actorPseudonym: string;
  caseHash: string;
  rubricVersion: number;
  decisions: ReviewDecision[];
  preference: Preference | null;
  rationale: string | null;
  reasonTags: ReasonTag[];
  rubric: ReviewRubric;
  createdAt: string;
}

export interface CreateReviewCaseInput {
  ownerId: string;
  seedKey: string | null;
  datasetVersion: string;
  kind: 'practice' | 'user';
  title: string;
  question: string;
  asOf: string | null;
  badge: string | null;
  sources: ReviewSource[];
  candidateSet: StoredCandidateSet;
}

export interface SaveAnnotationInput {
  ownerId: string;
  caseId: string;
  caseHash: string;
  rubricVersion: number;
  expectedRevision: number;
  status: ReviewStatus;
  decisions: ReviewDecision[];
  preference: Preference | null;
  rationale: string | null;
  reasonTags: ReasonTag[];
  rubric: ReviewRubric;
}

export type SaveAnnotationResult =
  | { ok: true; annotation: ReviewAnnotationRecord }
  | { ok: false; conflict: true };

interface CaseRow {
  id: string;
  owner_id: string;
  seed_key: string | null;
  dataset_version: string;
  split: string;
  kind: string;
  title: string;
  question: string;
  as_of: string | null;
  badge: string | null;
  rubric_version: number;
  content_hash: string;
  source_json: string;
  candidate_json: string;
  created_at: string;
  updated_at: string;
}

interface AnnotationRow {
  id: string;
  case_id: string;
  owner_id: string;
  revision: number;
  status: string;
  actor_id: string;
  actor_pseudonym: string;
  case_hash: string;
  rubric_version: number;
  decisions_json: string;
  preference: string | null;
  rationale: string | null;
  reason_tags_json: string;
  reference_answer: string | null;
  must_include_json: string;
  must_avoid_json: string;
  created_at: string;
}


/** Deterministic, key-sorted JSON used for immutable content hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

export function contentHashOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * The immutable, exportable snapshot that is hashed. Candidate array order is
 * the stored order; the blind map is exported separately so the hash can be
 * recomputed without guessing.
 */
export function snapshotOf(input: {
  datasetVersion: string;
  kind: 'practice' | 'user';
  title: string;
  question: string;
  asOf: string | null;
  sources: ReviewSource[];
  candidateSet: StoredCandidateSet;
}): ReviewCaseSnapshot {
  return {
    datasetVersion: input.datasetVersion,
    split: 'discovery',
    kind: input.kind,
    title: input.title,
    question: input.question,
    asOf: input.asOf,
    sources: input.sources.map((source) => ({ ...source })),
    candidateSet: {
      blindMap: { A: input.candidateSet.blindMap.A, B: input.candidateSet.blindMap.B },
      candidates: input.candidateSet.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        origin: candidate.origin,
        model: candidate.model,
        notes: candidate.notes,
        claims: candidate.claims.map((claim) => ({ claimId: claim.claimId, text: claim.text }))
      }))
    }
  };
}

export function snapshotForRecord(record: ReviewCaseRecord): ReviewCaseSnapshot {
  return snapshotOf({
    datasetVersion: record.datasetVersion,
    kind: record.kind,
    title: record.title,
    question: record.question,
    asOf: record.asOf,
    sources: record.sources,
    candidateSet: record.candidateSet
  });
}

/** Stable pseudonymous reviewer identity; the raw account id is never exported. */
export function reviewerPseudonym(ownerId: string): string {
  return `rev_${createHash('sha256').update(`stripsearch-review:${ownerId}`).digest('hex').slice(0, 16)}`;
}

function randomBlindMap(candidateIds: [string, string]): Record<BlindLabel, string> {
  const swap = randomInt(2) === 1;
  return swap ? { A: candidateIds[1], B: candidateIds[0] } : { A: candidateIds[0], B: candidateIds[1] };
}

export function buildPracticeContent(
  seed: SeedCase,
  caseId: string
): { sources: ReviewSource[]; candidateSet: StoredCandidateSet } {
  const sources: ReviewSource[] = seed.sources.map((source, index) => ({
    sourceId: `S${index + 1}`,
    title: source.title,
    text: source.text,
    locator: source.locator
  }));
  let counter = 0;
  const candidates: StoredCandidate[] = seed.candidates.map((candidate, index) => ({
    candidateId: `${caseId}-cand-${index + 1}`,
    origin: candidate.origin,
    model: candidate.model,
    notes: candidate.notes,
    claims: candidate.claims.map((text) => {
      counter += 1;
      return { claimId: `K${counter}`, text };
    })
  }));
  const candidateSet: StoredCandidateSet = {
    blindMap: randomBlindMap([candidates[0]!.candidateId, candidates[1]!.candidateId]),
    candidates
  };
  return { sources, candidateSet };
}

export interface UserCandidateInput {
  origin: string | null;
  model: string | null;
  notes: string | null;
  claims: string[];
}

export function buildUserContent(
  sources: ReviewSource[],
  candidates: [UserCandidateInput, UserCandidateInput]
): StoredCandidateSet {
  const stored: StoredCandidate[] = candidates.map((candidate, index) => ({
    candidateId: `cand_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    origin: candidate.origin,
    model: candidate.model,
    notes: candidate.notes,
    claims: candidate.claims.map((text) => ({ claimId: `cl_${randomUUID().replace(/-/g, '').slice(0, 12)}`, text }))
  }));
  return {
    blindMap: randomBlindMap([stored[0]!.candidateId, stored[1]!.candidateId]),
    candidates: stored
  };
}

function mapCase(row: CaseRow): ReviewCaseRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    seedKey: row.seed_key,
    datasetVersion: row.dataset_version,
    split: 'discovery',
    kind: row.kind === 'practice' ? 'practice' : 'user',
    title: row.title,
    question: row.question,
    asOf: row.as_of,
    badge: row.badge ?? '',
    rubricVersion: row.rubric_version,
    contentHash: row.content_hash,
    sources: parseJson<ReviewSource[]>(row.source_json, []),
    candidateSet: parseJson<StoredCandidateSet>(row.candidate_json, { blindMap: { A: '', B: '' }, candidates: [] }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAnnotation(row: AnnotationRow): ReviewAnnotationRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    ownerId: row.owner_id,
    revision: row.revision,
    status: row.status === 'submitted' ? 'submitted' : 'draft',
    actorId: row.actor_id,
    actorPseudonym: row.actor_pseudonym,
    caseHash: row.case_hash,
    rubricVersion: row.rubric_version,
    decisions: parseJson<ReviewDecision[]>(row.decisions_json, []),
    preference: (row.preference as Preference | null) ?? null,
    rationale: row.rationale,
    reasonTags: parseJson<ReasonTag[]>(row.reason_tags_json, []),
    rubric: {
      referenceAnswer: row.reference_answer ?? '',
      mustInclude: parseJson<string[]>(row.must_include_json, []),
      mustAvoid: parseJson<string[]>(row.must_avoid_json, [])
    },
    createdAt: row.created_at
  };
}

export function caseStatus(latest: ReviewAnnotationRecord | null): QueueStatus {
  if (!latest) return 'unreviewed';
  return latest.status === 'submitted' ? 'reviewed' : 'draft';
}

/** Pre-submit views hide the actual candidate origin mapping. */
export function toAnnotationView(annotation: ReviewAnnotationRecord): ReviewAnnotationView {
  return {
    annotationId: annotation.id,
    revision: annotation.revision,
    status: annotation.status,
    actorPseudonymousId: annotation.actorPseudonym,
    caseHash: annotation.caseHash,
    rubricVersion: annotation.rubricVersion,
    decisions: annotation.decisions,
    preference: annotation.preference,
    rationale: annotation.rationale,
    reasonTags: annotation.reasonTags,
    rubric: annotation.rubric,
    createdAt: annotation.createdAt
  };
}

export function toCaseDetail(
  record: ReviewCaseRecord,
  latest: ReviewAnnotationRecord | null
): ReviewCaseDetail {
  const byId = new Map(record.candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const candidates: ReviewCandidate[] = (['A', 'B'] as BlindLabel[]).map((blindLabel) => {
    const candidate = byId.get(record.candidateSet.blindMap[blindLabel]);
    return {
      blindLabel,
      claims: candidate ? candidate.claims.map((claim) => ({ ...claim })) : []
    };
  });
  const claimIds = candidates.flatMap((candidate) => candidate.claims.map((claim) => claim.claimId));
  const submitted = latest?.status === 'submitted';
  const provenance: ReviewProvenance[] | null = submitted
    ? (['A', 'B'] as BlindLabel[]).map((blindLabel) => {
        const candidate = byId.get(record.candidateSet.blindMap[blindLabel]);
        return {
          blindLabel,
          candidateId: candidate?.candidateId ?? '',
          origin: candidate?.origin ?? null,
          model: candidate?.model ?? null,
          notes: candidate?.notes ?? null
        };
      })
    : null;
  return {
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
    updatedAt: record.updatedAt,
    status: caseStatus(latest),
    latestRevision: latest?.revision ?? 0,
    latestStatus: latest?.status ?? null,
    sources: record.sources.map((source) => ({ ...source })),
    candidates,
    claimIds,
    provenance
  };
}

export function toHistoryEntry(annotation: ReviewAnnotationRecord): ReviewHistoryEntry {
  return {
    revision: annotation.revision,
    status: annotation.status,
    createdAt: annotation.createdAt,
    actorPseudonymousId: annotation.actorPseudonym
  };
}

export function toProvenanceList(record: ReviewCaseRecord): ReviewProvenance[] {
  const byId = new Map(record.candidateSet.candidates.map((candidate) => [candidate.candidateId, candidate]));
  return (['A', 'B'] as BlindLabel[]).map((blindLabel) => {
    const candidate = byId.get(record.candidateSet.blindMap[blindLabel]);
    return {
      blindLabel,
      candidateId: candidate?.candidateId ?? '',
      origin: candidate?.origin ?? null,
      model: candidate?.model ?? null,
      notes: candidate?.notes ?? null
    };
  });
}

interface ResearchTaskRow {
  id: string;
  owner_id: string;
  dataset_version: string;
  external_id: string;
  title: string;
  content_hash: string;
  spec_json: string;
  created_at: string;
}

/** Owner-scoped immutable research task snapshot. Never carries executions. */
export interface ResearchTaskRecord {
  id: string;
  ownerId: string;
  contentHash: string;
  createdAt: string;
  spec: ResearchTaskInput;
}

function mapResearchTask(row: ResearchTaskRow): ResearchTaskRecord {
  const fallback: ResearchTaskInput = {
    externalId: row.external_id,
    datasetVersion: row.dataset_version,
    title: row.title,
    input: { prompt: '', identitySeedUrls: [] },
    commonChecks: [],
    personChecks: [],
    observedStartingPoint: '',
    typicalFailure: '',
    sourcePackStatus: 'incomplete',
    interactionSampleStatus: 'not_systematically_sampled'
  };
  return {
    id: row.id,
    ownerId: row.owner_id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    spec: parseJson<ResearchTaskInput>(row.spec_json, fallback)
  };
}

/**
 * Safe response view: the fixed not-run/unreviewed status is explicit and the
 * raw owner id never appears in any field.
 */
export function toResearchTaskView(record: ResearchTaskRecord): ResearchTaskView {
  return {
    taskId: record.id,
    externalId: record.spec.externalId,
    datasetVersion: record.spec.datasetVersion,
    title: record.spec.title,
    split: 'discovery',
    contentHash: record.contentHash,
    createdAt: record.createdAt,
    executionStatus: 'not_run',
    reviewStatus: 'unreviewed',
    modelOutputs: [],
    humanLabels: null,
    input: {
      prompt: record.spec.input.prompt,
      identitySeedUrls: [...record.spec.input.identitySeedUrls]
    },
    commonChecks: record.spec.commonChecks.map((check: ResearchCheck) => ({ ...check })),
    personChecks: record.spec.personChecks.map((check: ResearchCheck) => ({ ...check })),
    observedStartingPoint: record.spec.observedStartingPoint,
    typicalFailure: record.spec.typicalFailure,
    sourcePackStatus: 'incomplete',
    interactionSampleStatus: 'not_systematically_sampled'
  };
}

/** Queue row without the evaluator criteria bodies. */
export function toResearchTaskListItem(record: ResearchTaskRecord): ResearchTaskListItem {
  return {
    taskId: record.id,
    externalId: record.spec.externalId,
    datasetVersion: record.spec.datasetVersion,
    title: record.spec.title,
    split: 'discovery',
    contentHash: record.contentHash,
    createdAt: record.createdAt,
    executionStatus: 'not_run',
    reviewStatus: 'unreviewed',
    modelOutputCount: 0,
    sourcePackStatus: 'incomplete',
    interactionSampleStatus: 'not_systematically_sampled'
  };
}

export class ReviewStore {
  constructor(private readonly db: DB) {}

  /* ---------------- candidate-free research task library ---------------- */

  /**
   * Idempotent create: the same owner+datasetVersion+externalId with the same
   * content hash returns the existing record; changed content conflicts so an
   * immutable snapshot is never silently overwritten.
   */
  createResearchTask(input: {
    ownerId: string;
    spec: ResearchTaskInput;
  }): { ok: true; created: boolean; record: ResearchTaskRecord } | { ok: false; conflict: true; record: ResearchTaskRecord } {
    const contentHash = contentHashOf(input.spec);
    const tx = this.db.transaction(() => {
      const existing = this.findResearchTaskByKey(
        input.ownerId,
        input.spec.datasetVersion,
        input.spec.externalId
      );
      if (existing) {
        return existing.contentHash === contentHash
          ? ({ ok: true, created: false, record: existing } as const)
          : ({ ok: false, conflict: true, record: existing } as const);
      }
      const timestamp = nowIso();
      const id = newId('rtask');
      try {
        this.db
          .prepare(
            `INSERT INTO review_research_tasks (
              id, owner_id, dataset_version, external_id, title, content_hash, spec_json, created_at
            ) VALUES (
              @id, @owner_id, @dataset_version, @external_id, @title, @content_hash, @spec_json, @created_at
            )`
          )
          .run({
            id,
            owner_id: input.ownerId,
            dataset_version: input.spec.datasetVersion,
            external_id: input.spec.externalId,
            title: input.spec.title,
            content_hash: contentHash,
            spec_json: JSON.stringify(input.spec),
            created_at: timestamp
          });
      } catch (error) {
        // A concurrent writer may have won the unique key; resolve through it.
        const raced = this.findResearchTaskByKey(
          input.ownerId,
          input.spec.datasetVersion,
          input.spec.externalId
        );
        if (!raced) throw error;
        return raced.contentHash === contentHash
          ? ({ ok: true, created: false, record: raced } as const)
          : ({ ok: false, conflict: true, record: raced } as const);
      }
      const created = this.getResearchTask(id, input.ownerId);
      if (!created) throw new Error('failed to insert research task');
      return { ok: true, created: true, record: created } as const;
    });
    return tx();
  }

  private findResearchTaskRow(
    ownerId: string,
    datasetVersion: string,
    externalId: string
  ): ResearchTaskRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM review_research_tasks WHERE owner_id = ? AND dataset_version = ? AND external_id = ?'
      )
      .get(ownerId, datasetVersion, externalId) as ResearchTaskRow | undefined;
  }

  findResearchTaskByKey(
    ownerId: string,
    datasetVersion: string,
    externalId: string
  ): ResearchTaskRecord | null {
    const row = this.findResearchTaskRow(ownerId, datasetVersion, externalId);
    return row ? mapResearchTask(row) : null;
  }

  getResearchTask(id: string, ownerId: string): ResearchTaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM review_research_tasks WHERE id = ? AND owner_id = ?')
      .get(id, ownerId) as ResearchTaskRow | undefined;
    return row ? mapResearchTask(row) : null;
  }

  listResearchTasksForOwner(
    ownerId: string,
    limit = LIMITS.researchTaskMaxPerUser
  ): ResearchTaskRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM review_research_tasks WHERE owner_id = ? ORDER BY created_at ASC, id ASC LIMIT ?'
      )
      .all(ownerId, limit) as ResearchTaskRow[];
    return rows.map(mapResearchTask);
  }

  countResearchTasksForOwner(ownerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM review_research_tasks WHERE owner_id = ?')
      .get(ownerId) as { n: number };
    return row.n;
  }

  insertCase(input: CreateReviewCaseInput): ReviewCaseRecord {
    const timestamp = nowIso();
    const id = newId('rcase');
    const contentHash = contentHashOf(
      snapshotOf({
        datasetVersion: input.datasetVersion,
        kind: input.kind,
        title: input.title,
        question: input.question,
        asOf: input.asOf,
        sources: input.sources,
        candidateSet: input.candidateSet
      })
    );
    this.db
      .prepare(
        `INSERT INTO review_cases (
          id, owner_id, seed_key, dataset_version, split, kind, title, question, as_of, badge,
          rubric_version, content_hash, source_json, candidate_json, created_at, updated_at
        ) VALUES (
          @id, @owner_id, @seed_key, @dataset_version, @split, @kind, @title, @question, @as_of, @badge,
          @rubric_version, @content_hash, @source_json, @candidate_json, @created_at, @updated_at
        )`
      )
      .run({
        id,
        owner_id: input.ownerId,
        seed_key: input.seedKey,
        dataset_version: input.datasetVersion,
        split: 'discovery',
        kind: input.kind,
        title: input.title,
        question: input.question,
        as_of: input.asOf,
        badge: input.badge,
        rubric_version: 1,
        content_hash: contentHash,
        source_json: JSON.stringify(input.sources),
        candidate_json: JSON.stringify(input.candidateSet),
        created_at: timestamp,
        updated_at: timestamp
      });
    const created = this.getCase(id);
    if (!created) throw new Error('failed to insert review case');
    return created;
  }

  getCase(id: string): ReviewCaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM review_cases WHERE id = ? AND deleted_at IS NULL')
      .get(id) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  getCaseForOwner(id: string, ownerId: string): ReviewCaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM review_cases WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(id, ownerId) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  findCaseBySeedKey(ownerId: string, seedKey: string): ReviewCaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM review_cases WHERE owner_id = ? AND seed_key = ? AND deleted_at IS NULL')
      .get(ownerId, seedKey) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  listCasesForOwner(ownerId: string, limit = LIMITS.reviewQueueLimit): ReviewCaseRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM review_cases WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?'
      )
      .all(ownerId, limit) as CaseRow[];
    return rows.map(mapCase);
  }

  countCasesForOwner(ownerId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM review_cases WHERE owner_id = ? AND deleted_at IS NULL')
      .get(ownerId) as { n: number };
    return row.n;
  }

  deleteCaseForOwner(id: string, ownerId: string): boolean {
    const info = this.db
      .prepare('DELETE FROM review_cases WHERE id = ? AND owner_id = ?')
      .run(id, ownerId);
    return info.changes > 0;
  }

  latestAnnotation(caseId: string): ReviewAnnotationRecord | null {
    const row = this.db
      .prepare('SELECT * FROM review_annotations WHERE case_id = ? ORDER BY revision DESC LIMIT 1')
      .get(caseId) as AnnotationRow | undefined;
    return row ? mapAnnotation(row) : null;
  }

  listAnnotations(caseId: string, limit = 50): ReviewAnnotationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM review_annotations WHERE case_id = ? ORDER BY revision DESC LIMIT ?')
      .all(caseId, limit) as AnnotationRow[];
    return rows.map(mapAnnotation);
  }

  /** Complete append-only history for export and read-only inspection. */
  listAllAnnotations(caseId: string): ReviewAnnotationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM review_annotations WHERE case_id = ? ORDER BY revision ASC')
      .all(caseId) as AnnotationRow[];
    return rows.map(mapAnnotation);
  }

  saveAnnotation(input: SaveAnnotationInput): SaveAnnotationResult {
    const pseudonym = reviewerPseudonym(input.ownerId);
    const timestamp = nowIso();
    const tx = this.db.transaction((): SaveAnnotationResult => {
      const current = (
        this.db
          .prepare('SELECT COALESCE(MAX(revision), 0) AS n FROM review_annotations WHERE case_id = ?')
          .get(input.caseId) as { n: number }
      ).n;
      if (current !== input.expectedRevision) return { ok: false, conflict: true };
      const revision = current + 1;
      const id = newId('rann');
      this.db
        .prepare(
          `INSERT INTO review_annotations (
            id, case_id, owner_id, revision, status, actor_id, actor_pseudonym, case_hash, rubric_version,
            decisions_json, preference, rationale, reason_tags_json, reference_answer, must_include_json,
            must_avoid_json, created_at
          ) VALUES (
            @id, @case_id, @owner_id, @revision, @status, @actor_id, @actor_pseudonym, @case_hash, @rubric_version,
            @decisions_json, @preference, @rationale, @reason_tags_json, @reference_answer, @must_include_json,
            @must_avoid_json, @created_at
          )`
        )
        .run({
          id,
          case_id: input.caseId,
          owner_id: input.ownerId,
          revision,
          status: input.status,
          actor_id: input.ownerId,
          actor_pseudonym: pseudonym,
          case_hash: input.caseHash,
          rubric_version: input.rubricVersion,
          decisions_json: JSON.stringify(input.decisions),
          preference: input.preference,
          rationale: input.rationale,
          reason_tags_json: JSON.stringify(input.reasonTags),
          reference_answer: input.rubric.referenceAnswer,
          must_include_json: JSON.stringify(input.rubric.mustInclude),
          must_avoid_json: JSON.stringify(input.rubric.mustAvoid),
          created_at: timestamp
        });
      this.db
        .prepare('UPDATE review_cases SET updated_at = ? WHERE id = ?')
        .run(timestamp, input.caseId);
      const row = this.db
        .prepare('SELECT * FROM review_annotations WHERE id = ?')
        .get(id) as AnnotationRow | undefined;
      if (!row) throw new Error('failed to insert annotation');
      return { ok: true, annotation: mapAnnotation(row) };
    });
    return tx();
  }

  /** Latest annotation per owner review case, used for aggregate insights only. */
  latestAnnotationsForOwner(ownerId: string): { record: ReviewCaseRecord; latest: ReviewAnnotationRecord }[] {
    const cases = this.listCasesForOwner(ownerId);
    const result: { record: ReviewCaseRecord; latest: ReviewAnnotationRecord }[] = [];
    for (const record of cases) {
      const latest = this.latestAnnotation(record.id);
      if (latest && latest.status === 'submitted') result.push({ record, latest });
    }
    return result;
  }

  /** Bootstrap the ten practice cases; idempotent per owner and seed key. */
  seedForOwner(
    ownerId: string,
    seeds: SeedCase[],
    badge: string
  ): { inserted: number; total: number; capped: boolean } {
    const existing = this.countCasesForOwner(ownerId);
    const remaining = Math.max(0, LIMITS.reviewMaxCasesPerUser - existing);
    const missing = seeds.filter((seed) => !this.findCaseBySeedKey(ownerId, seed.seedKey)).length;
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const seed of seeds) {
        if (inserted >= remaining) break;
        if (this.findCaseBySeedKey(ownerId, seed.seedKey)) continue;
        const placeholder = newId('rcase');
        const { sources, candidateSet } = buildPracticeContent(seed, placeholder);
        this.insertCaseWithId(placeholder, {
          ownerId,
          seedKey: seed.seedKey,
          datasetVersion: seed.datasetVersion,
          kind: 'practice',
          title: seed.title,
          question: seed.question,
          asOf: seed.asOf,
          badge: seed.badge || badge,
          sources,
          candidateSet
        });
        inserted += 1;
      }
    });
    tx();
    return {
      inserted,
      total: this.countPracticeCases(ownerId, seeds),
      capped: missing > remaining
    };
  }

  private countPracticeCases(ownerId: string, seeds: SeedCase[]): number {
    if (seeds.length === 0) return 0;
    const placeholders = seeds.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_cases
         WHERE owner_id = ? AND deleted_at IS NULL AND seed_key IN (${placeholders})`
      )
      .get(ownerId, ...seeds.map((seed) => seed.seedKey)) as { n: number };
    return row.n;
  }

  private insertCaseWithId(id: string, input: CreateReviewCaseInput): void {
    const timestamp = nowIso();
    const contentHash = contentHashOf(
      snapshotOf({
        datasetVersion: input.datasetVersion,
        kind: input.kind,
        title: input.title,
        question: input.question,
        asOf: input.asOf,
        sources: input.sources,
        candidateSet: input.candidateSet
      })
    );
    this.db
      .prepare(
        `INSERT INTO review_cases (
          id, owner_id, seed_key, dataset_version, split, kind, title, question, as_of, badge,
          rubric_version, content_hash, source_json, candidate_json, created_at, updated_at
        ) VALUES (
          @id, @owner_id, @seed_key, @dataset_version, @split, @kind, @title, @question, @as_of, @badge,
          @rubric_version, @content_hash, @source_json, @candidate_json, @created_at, @updated_at
        )`
      )
      .run({
        id,
        owner_id: input.ownerId,
        seed_key: input.seedKey,
        dataset_version: input.datasetVersion,
        split: 'discovery',
        kind: input.kind,
        title: input.title,
        question: input.question,
        as_of: input.asOf,
        badge: input.badge,
        rubric_version: 1,
        content_hash: contentHash,
        source_json: JSON.stringify(input.sources),
        candidate_json: JSON.stringify(input.candidateSet),
        created_at: timestamp,
        updated_at: timestamp
      });
  }

  insightsForOwner(ownerId: string): ReviewInsights {
    const factualLabels = Object.fromEntries(
      Object.keys(CLAIM_LABELS).map((key) => [key, 0])
    ) as Record<ClaimLabel, number>;
    const preferenceCounts = Object.fromEntries(
      Object.keys(PREFERENCE_LABELS).map((key) => [key, 0])
    ) as Record<Preference, number>;
    const reasonTagCounts = Object.fromEntries(
      Object.keys(REASON_TAG_LABELS).map((key) => [key, 0])
    ) as Record<ReasonTag, number>;
    const progress: ReviewProgress = { total: 0, reviewed: 0, draft: 0, unreviewed: 0 };

    const cases = this.listCasesForOwner(ownerId);
    progress.total = cases.length;
    for (const record of cases) {
      const latest = this.latestAnnotation(record.id);
      const status = caseStatus(latest);
      progress[status] += 1;
      // Only submitted, latest revisions contribute to derived counts.
      if (!latest || latest.status !== 'submitted') continue;
      for (const decision of latest.decisions) {
        if (decision.label && decision.label in factualLabels) {
          factualLabels[decision.label] += 1;
        }
      }
      if (latest.preference) preferenceCounts[latest.preference] += 1;
      for (const tag of latest.reasonTags) reasonTagCounts[tag] += 1;
    }

    return {
      generatedFrom: 'submitted-latest-revisions-only',
      note: '这些判断用于形成评估标准，尚未运行模型对照。',
      caseCounts: progress,
      factualLabels,
      preferenceCounts,
      reasonTagCounts
    };
  }
}
