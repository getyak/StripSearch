/**
 * GET-99 real GitHub Fetch runner: the single-instance server worker that
 * drives the two durable phases of one Web Fetch run.
 *
 * Phase 1 (acquisition) issues real GitHub public REST requests through ONE
 * controlled transport, one resumable quantum at a time, after a durable
 * per-request intent. Phase 2 (processing) reuses the existing
 * `runFetchPipeline` source-pinned chain with production cached handlers over
 * the frozen snapshot: zero new HTTP, no duplicated charges, no synthetic
 * fixture modules and honest zero external-model usage.
 *
 * Worker discipline: a single in-process instance (no GET-79 distributed
 * lease claim) with bounded per-owner concurrency (one run at a time), pause
 * /resume/stop controls and shutdown wiring. A durable unresolved in-flight
 * request on restart stops the run as unreconciled — never blindly replayed —
 * and an explicit user resume reconciles it as `retry` (fresh journaled
 * attempt, prior cost unknown) or `skip` (permanent honest gap). Persisted
 * successful requests are never repeated and explicit cancel/stop rejects
 * late packets without persisting their captures.
 */

import { LIMITS } from '../../shared/limits.js';
import { normalizeQuestion, screenQuestion, validateQuestion } from '../../shared/validation.js';
import { DEFAULT_THREAD_DEPTH } from '../../shared/research-completion.js';
import type { CompletionScopeSpec } from '../../shared/research-completion.js';
import type { ScopeVersion } from '../../shared/research-case.js';
import {
  FETCH_GITHUB_REGISTRY_VERSION,
  accessScopeFor,
  fetchGithubAccountId,
  fetchGithubLimitations,
  fetchGithubRequiredCheck,
  fetchGithubScopeQuestion,
  parseFetchGithubTarget,
  type FetchGithubItemView,
  type FetchGithubPendingEvidenceView,
  type FetchGithubProcessingView,
  type FetchGithubRequestView,
  type FetchGithubResumeRequest,
  type FetchGithubRunState,
  type FetchGithubRunSummary,
  type FetchGithubRunView,
  type FetchGithubStartRequest,
  type FetchGithubTarget
} from '../../shared/research-fetch-github.js';
import type { HttpTransport } from '../adapters/types.js';
import type { DB } from '../db/index.js';
import type { Store } from '../store.js';
import {
  createFetchGithubCheckpoint,
  FetchGithubStore,
  type FetchGithubRunRecord
} from './fetch-github-store.js';
import {
  executeAcquisitionQuantum,
  freezeSnapshot,
  planNextRequest,
  FETCH_GITHUB_ACQUISITION_PROVENANCE
} from './fetch-github-acquisition.js';
import {
  buildGithubSnapshotCatalog,
  createCachedGithubHandlers,
  createDeterministicFetchScheduler,
  createGithubCapabilitySnapshot,
  createNoNetworkCachedExecutor
} from './fetch-github-catalog.js';
import { createInitialCheckpoint, runFetchPipeline } from './fetch-pipeline.js';
import type { FetchPipelineSummary } from '../../shared/research-fetch-pipeline.js';
import { FetchPipelineStore } from './fetch-pipeline-store.js';
import { createResearchToolServer, type ResearchToolServer } from './research-tool-dispatch.js';

export class FetchGithubRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'FetchGithubRequestError';
  }
}

export interface FetchGithubRunnerDeps {
  db: DB;
  store: Store;
  transport: HttpTransport;
  githubToken: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  /** Pipeline scheduler quanta per processing step (resumable, never a cap). */
  processingBatchesPerStep?: number;
  /** Idle poll interval for the single worker loop. */
  pollIntervalMs?: number;
}

interface ActiveQuantum {
  controller: AbortController;
}

export class FetchGithubRunner {
  private readonly journal: FetchGithubStore;
  private readonly pipelineRuns: FetchPipelineStore;
  private readonly active = new Map<string, ActiveQuantum>();
  private readonly wakeups = new Set<() => void>();
  private loopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: FetchGithubRunnerDeps) {
    this.journal = new FetchGithubStore(deps.db, deps.store);
    this.pipelineRuns = new FetchPipelineStore(deps.db, deps.store);
  }

  /* ---------------------------------------------------------------- */
  /* Boot recovery                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Runs interrupted by a process restart STOP honestly: any durable
   * in-flight request leaves the run `unreconciled` (never blindly replayed);
   * runs without one become `paused` and wait for an explicit resume.
   */
  recoverInterrupted(): number {
    let count = 0;
    for (const run of this.allRuns()) {
      if (run.state !== 'acquiring' && run.state !== 'processing') continue;
      const unresolved = this.journal.listUnresolvedRequests(run.runId);
      if (unresolved.length > 0) {
        this.journal.updateRun(run.runId, { state: 'unreconciled', stopReason: 'restart_in_flight' });
        this.journal.appendEvent(run.runId, 'interrupted', {
          reason: 'restart_in_flight',
          unresolvedRequests: unresolved.map((request) => request.requestKey)
        });
      } else {
        this.journal.updateRun(run.runId, { state: 'paused', stopReason: 'server_restart' });
        this.journal.appendEvent(run.runId, 'interrupted', { reason: 'server_restart' });
      }
      count += 1;
    }
    return count;
  }

  private allRuns(): FetchGithubRunRecord[] {
    // Single-instance worker: one database, one owner directory table scan is
    // fine at this scale; owner scoping is enforced by every public method.
    const rows = this.deps.db.prepare('SELECT id FROM research_fetch_github_runs ORDER BY created_at, id').all() as {
      id: string;
    }[];
    return rows.map((row) => this.journal.requireRun(row.id));
  }

  /* ---------------------------------------------------------------- */
  /* Start (explicit confirmation BEFORE any HTTP)                     */
  /* ---------------------------------------------------------------- */

  start(input: FetchGithubStartRequest & { ownerId: string; idempotencyKey?: string | null; bodyFingerprint?: string | null }): FetchGithubRunView {
    const question = normalizeQuestion(input.question);
    const questionCheck = validateQuestion(question);
    if (!questionCheck.ok) {
      throw new FetchGithubRequestError('invalid_question', questionCheck.error ?? '研究问题无效。');
    }
    const parsed = parseFetchGithubTarget(input.targetUrl);
    if (!parsed.ok) throw new FetchGithubRequestError('invalid_target', parsed.error);
    const target = parsed.target;
    const expectedScope = accessScopeFor(target);
    if (input.accessScope !== expectedScope) {
      throw new FetchGithubRequestError(
        'invalid_scope',
        '访问范围与目标不匹配：账号链接对应 github_public_account，仓库链接对应 github_public_repository。',
        422
      );
    }
    // Explicit user confirmation of the EXACT target, frozen question and
    // supported access scope is required before any HTTP request.
    if (
      input.confirmation !== true ||
      input.confirmedTarget !== target.canonicalUrl ||
      normalizeQuestion(input.confirmedQuestion) !== question ||
      input.confirmedAccessScope !== expectedScope
    ) {
      throw new FetchGithubRequestError(
        'confirmation_required',
        '开始抓取前需要显式确认目标 GitHub 账号或仓库、冻结的问题与支持的访问范围。'
      );
    }
    const screen = screenQuestion(question, target.canonicalUrl);
    if (screen.disallowed) {
      throw new FetchGithubRequestError('scope_disallowed', screen.reason ?? '该请求不在可处理范围内。', 422);
    }

    const login = target.kind === 'account' ? target.login : target.owner;
    const provenance = {
      ...FETCH_GITHUB_ACQUISITION_PROVENANCE,
      note: JSON.stringify({
        confirmedTarget: target.canonicalUrl,
        accessScope: expectedScope,
        question,
        apiVersion: '2026-03-10'
      })
    };

    const confirmation = {
      target: target.canonicalUrl,
      question,
      accessScope: expectedScope,
      confirmedAt: new Date().toISOString()
    };

    const runRecord = this.deps.store.inTransaction(() => {
      const caseRecord = this.deps.store.cases.createCase({
        ownerId: input.ownerId,
        intent: `Web Fetch: ${target.canonicalUrl}`,
        provenance
      });
      // Case-bound account identity: the same login in two cases never
      // collides on the global account key and is never merged.
      const accountId = fetchGithubAccountId(caseRecord.caseId, login);
      // Selection AND authorization are one atomic scope change (the CaseStore
      // guards forbid selecting/authorizing accounts at creation time and are
      // never loosened here).
      const change = this.deps.store.cases.applyScopeChange({
        ownerId: input.ownerId,
        caseId: caseRecord.caseId,
        expectedScopeVersion: caseRecord.scopeVersion,
        reason: `用户显式确认 Web Fetch 目标账号：${target.canonicalUrl}`,
        accounts: [
          {
            create: {
              accountId,
              platform: 'github',
              handle: login,
              profileUrl: target.canonicalUrl,
              identitySupport: {
                state: 'proposed',
                evidenceIds: [],
                counterevidenceIds: [],
                policyVersion: 'identity-policy/v1',
                note: '账号研究不认定同一人关联；组织/仓库作者不假定为研究对象。'
              },
              userSelection: { state: 'unanswered', note: null, recordedAt: null },
              allowedScope: { state: 'none', note: null },
              researchValue: { state: 'unassessed', rationale: null },
              accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null }
            },
            userSelection: {
              state: 'selected',
              note: '用户显式确认的目标账号',
              recordedAt: new Date().toISOString().slice(0, 10)
            },
            allowedScope: {
              state: 'public_history',
              note:
                target.kind === 'account'
                  ? '公开账号资料、公开自有仓库列表与 README/当前公开工作快照'
                  : '公开仓库 issues（含 PR）正文与每条首页 issue 评论'
            }
          }
        ]
      });
      // Freeze completion at EXACTLY the authoritative version this atomic
      // scope change produced.
      const authoritative = change.case;
      const spec: CompletionScopeSpec = {
        questions: [fetchGithubScopeQuestion(question)],
        platformRegistry: {
          registryVersion: FETCH_GITHUB_REGISTRY_VERSION,
          entries: [
            {
              platformId: 'github',
              label: 'GitHub',
              applicability: 'applicable',
              applicabilityReason: '本切片只处理用户显式确认的 GitHub 公开资源'
            },
            {
              platformId: 'exa_web',
              label: 'Exa / Web',
              applicability: 'not_applicable',
              applicabilityReason: '本切片不启用 Exa、X 或网站抓取'
            }
          ]
        },
        accountRange: { mode: 'researched_accounts', accountIds: [] },
        timeRange: { from: null, to: null },
        threadDepth: DEFAULT_THREAD_DEPTH,
        requiredChecks: [fetchGithubRequiredCheck()]
      };
      const frozen = this.deps.store.completion.freezeCompletionScope({
        ownerId: input.ownerId,
        caseId: caseRecord.caseId,
        expectedScopeVersion: authoritative.scopeVersion as ScopeVersion,
        spec,
        reason: `用户显式确认的 Web Fetch 范围：${target.canonicalUrl}`
      });
      // Idempotency record + run creation commit atomically BEFORE the worker
      // is woken.
      return this.journal.createRun({
        ownerId: input.ownerId,
        caseId: caseRecord.caseId,
        scopeSpecId: frozen.scopeSpecId,
        scopeVersion: authoritative.scopeVersion,
        target,
        accessScope: expectedScope,
        question,
        confirmation,
        checkpoint: createFetchGithubCheckpoint(target, accountId),
        idempotencyKey: input.idempotencyKey ?? null,
        bodyFingerprint: input.bodyFingerprint ?? null
      });
    });
    this.journal.appendEvent(runRecord.runId, 'started', {
      target: target.canonicalUrl,
      accessScope: expectedScope,
      question
    });
    this.wake();
    return this.view(runRecord.runId, input.ownerId) as FetchGithubRunView;
  }

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
  /* ---------------------------------------------------------------- */

  pause(runId: string, ownerId: string, expectedRevision?: number): FetchGithubRunView {
    const run = this.requireOwned(runId, ownerId);
    this.checkRevision(run, expectedRevision);
    if (run.state !== 'acquiring' && run.state !== 'processing') {
      throw new FetchGithubRequestError('run_not_pausable', '该 Web Fetch 运行当前不可暂停。', 409);
    }
    // The control revision bumps and the in-flight quantum is aborted: a
    // response from the old generation is rejected (fenced), never folded.
    this.journal.updateRun(runId, { state: 'paused', stopReason: 'user_pause' });
    this.journal.appendEvent(runId, 'paused', {});
    this.active.get(runId)?.controller.abort();
    return this.view(runId, ownerId) as FetchGithubRunView;
  }

  resume(
    runId: string,
    ownerId: string,
    options: FetchGithubResumeRequest
  ): FetchGithubRunView {
    const run = this.requireOwned(runId, ownerId);
    this.checkRevision(run, options.expectedRevision);
    if (run.state !== 'paused' && run.state !== 'unreconciled') {
      throw new FetchGithubRequestError('run_not_resumable', '该 Web Fetch 运行当前不需要恢复。', 409);
    }
    const unresolved = this.journal.listUnresolvedRequests(runId);
    if (run.state === 'unreconciled' || unresolved.length > 0) {
      if (options.reconcileUnknown !== 'retry' && options.reconcileUnknown !== 'skip') {
        throw new FetchGithubRequestError(
          'reconcile_choice_required',
          '恢复前需要显式选择如何处理结果未知的请求：retry（重新发起，费用未知）或 skip（保留为缺口）。'
        );
      }
      const cp = run.checkpoint;
      for (const request of this.journal.reconcileUnknownRequests(runId, 'abandon')) {
        if (options.reconcileUnknown === 'retry') {
          // Explicit user authorization only: unknown outcomes are NEVER
          // retried automatically.
          cp.retryRequestKeys = [...new Set([...cp.retryRequestKeys, request.requestKey])].sort();
        }
        cp.gaps.push({
          code: 'outcome_unknown',
          detail: `${request.requestKey} 的结果未知（第 ${String(request.attempt)} 次尝试）；已显式${options.reconcileUnknown === 'retry' ? '授权重新发起（先前费用未知）' : '保留为永久缺口'}`
        });
      }
      this.journal.updateCheckpoint(runId, cp);
      this.journal.appendEvent(runId, 'reconciled', { resolution: options.reconcileUnknown });
    }
    const next: FetchGithubRunState = run.checkpoint.snapshot.frozen ? 'processing' : 'acquiring';
    this.journal.updateRun(runId, { state: next, stopReason: null });
    this.journal.appendEvent(runId, 'resumed', { state: next });
    this.wake();
    return this.view(runId, ownerId) as FetchGithubRunView;
  }

  stop(runId: string, ownerId: string, expectedRevision?: number): FetchGithubRunView {
    const run = this.requireOwned(runId, ownerId);
    this.checkRevision(run, expectedRevision);
    if (run.state === 'finished' || run.state === 'stopped') {
      throw new FetchGithubRequestError('run_not_stoppable', '该 Web Fetch 运行已结束。', 409);
    }
    // Explicit cancel/stop: abort the in-flight quantum; its late packet is
    // rejected without persisting the body or any capture.
    this.journal.updateRun(runId, { state: 'stopped', stopReason: 'user_stop' });
    this.journal.appendEvent(runId, 'stopped', {});
    this.active.get(runId)?.controller.abort();
    return this.view(runId, ownerId) as FetchGithubRunView;
  }

  /* ---------------------------------------------------------------- */
  /* Owner-scoped views (no foreign run/case probing)                  */
  /* ---------------------------------------------------------------- */

  view(runId: string, ownerId: string): FetchGithubRunView | null {
    const run = this.journal.getRunForOwner(runId, ownerId);
    return run ? this.buildView(run) : null;
  }

  list(ownerId: string): FetchGithubRunSummary[] {
    return this.journal.listRunsForOwner(ownerId).map((run) => ({
      runId: run.runId,
      revision: run.revision,
      state: run.state,
      phase: run.phase,
      targetUrl: run.target.canonicalUrl,
      question: run.question,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      snapshotFrozen: run.checkpoint.snapshot.frozen,
      progress: {
        requests: this.journal.listRequests(run.runId).length,
        items: this.journal.listItems(run.runId).length,
        comments: this.journal.listComments(run.runId).length,
        gaps: run.checkpoint.gaps.length
      }
    }));
  }

  /** Key-based idempotency surface for the routes (same semantics as legacy). */
  findByIdempotency(
    ownerId: string,
    idempotencyKey: string
  ): { runId: string; bodyFingerprint: string | null } | null {
    return this.journal.findByIdempotency(ownerId, idempotencyKey);
  }

  recordIdempotency(ownerId: string, idempotencyKey: string, bodyFingerprint: string, runId: string): void {
    this.journal.recordIdempotency(ownerId, idempotencyKey, bodyFingerprint, runId);
  }

  private requireOwned(runId: string, ownerId: string): FetchGithubRunRecord {
    const run = this.journal.getRunForOwner(runId, ownerId);
    if (!run) throw new FetchGithubRequestError('run_not_found', '未找到该 Web Fetch 运行。', 404);
    return run;
  }

  private checkRevision(run: FetchGithubRunRecord, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== run.revision)) {
      throw new FetchGithubRequestError('stale_revision', 'Web Fetch 运行已更新，请刷新后重试。', 409);
    }
  }

  private buildView(run: FetchGithubRunRecord): FetchGithubRunView {
    const requests: FetchGithubRequestView[] = this.journal.listRequests(run.runId).map((request) => ({
      requestKey: request.requestKey,
      kind: request.kind,
      url: request.url,
      state: request.state,
      status: request.status,
      bodyBytes: request.bodyBytes,
      bodyHash: request.bodyHash,
      attempt: request.attempt,
      createdAt: request.createdAt,
      settledAt: request.settledAt,
      gap: request.gap
    }));
    const comments = this.journal.listComments(run.runId);
    const items: FetchGithubItemView[] = this.journal.listItems(run.runId).map((item) => ({
      itemKey: item.itemKey,
      kind: item.kind,
      title: item.title,
      originalUrl: item.originalUrl,
      authorLogin: item.authorLogin,
      publishedAt: item.publishedAt,
      contentHash: item.bodyHash,
      fulltext: item.fulltext,
      bodyBytes: item.bodyBytes,
      sourceId: item.sourceId,
      sourceRevision: item.sourceRevision,
      comments: comments
        .filter((comment) => comment.itemKey === item.itemKey)
        .map((comment) => ({
          commentId: comment.commentId,
          authorLogin: comment.authorLogin,
          authorId: comment.authorId,
          authorRole: comment.authorRole,
          originalUrl: comment.originalUrl,
          bodyHash: comment.bodyHash,
          body: comment.body,
          excerpt: comment.excerpt,
          createdAt: comment.commentCreatedAt
        })),
      processingEligible: item.processingEligible,
      processingGap: item.processingGap
    }));
    const pendingEvidence = this.pendingEvidence(run);
    const requestStates = (state: FetchGithubRequestView['state']) =>
      requests.filter((request) => request.state === state).length;
    const latestProcessing = this.latestProcessingSummary(run.runId);
    return {
      runId: run.runId,
      revision: run.revision,
      state: run.state,
      phase: run.phase,
      target: run.target,
      needsReconciliation: run.state === 'unreconciled' || this.journal.listUnresolvedRequests(run.runId).length > 0,
      accessScope: run.accessScope,
      question: run.question,
      confirmation: run.confirmation,
      scopeSpecId: run.scopeSpecId,
      scopeVersion: run.scopeVersion,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      snapshot: run.checkpoint.snapshot,
      progress: {
        requests: {
          total: requests.length,
          succeeded: requestStates('succeeded'),
          failed: requestStates('failed'),
          unknown: requestStates('unknown'),
          rejected: requestStates('rejected'),
          inFlight: requestStates('in_flight')
        },
        listingPages: {
          repos: run.checkpoint.listings.repos?.pagesDone ?? 0,
          issues: run.checkpoint.listings.issues?.pagesDone ?? 0
        },
        items: items.length,
        comments: comments.length
      },
      requests,
      items,
      pendingEvidence,
      gaps: run.checkpoint.gaps,
      limitations: fetchGithubLimitations(run.target),
      processing: latestProcessing
    };
  }

  private pendingEvidence(run: FetchGithubRunRecord): FetchGithubPendingEvidenceView[] {
    try {
      const report = this.deps.store.cases.reportView(run.ownerId, run.caseId);
      return report.evidence.map((evidence) => {
        const source = report.sources.find((entry) => entry.sourceId === evidence.sourceId) ?? null;
        const revision = source?.revisions.find((entry) => entry.sourceRevision === evidence.sourceRevision) ?? null;
        return {
          evidenceId: evidence.evidenceId,
          accountId: evidence.accountId,
          sourceId: evidence.sourceId,
          sourceRevision: evidence.sourceRevision,
          role: evidence.role,
          quote: evidence.quote,
          sourceUrl: revision?.originalUrl ?? null,
          sourceTitle: revision?.title ?? null,
          author: revision?.author ?? null,
          publishedAt: revision?.publishedAt ?? null,
          retrievedAt: revision?.retrievedAt ?? null,
          revokedAt: evidence.revokedAt
        };
      });
    } catch {
      return [];
    }
  }

  private latestProcessingSummary(runId: string): FetchGithubProcessingView | null {
    const events = this.journal.listEvents(runId).filter((event) => event.kind === 'processing_summary');
    const latest = events.at(-1);
    return latest ? (latest.payload as FetchGithubProcessingView) : null;
  }

  /* ---------------------------------------------------------------- */
  /* Single worker loop (bounded per-owner concurrency = serial quanta) */
  /* ---------------------------------------------------------------- */

  private wake(): void {
    for (const wakeup of this.wakeups) wakeup();
    this.wakeups.clear();
  }

  /** Start the single worker loop (idempotent). */
  ensureRunning(): void {
    if (this.loopPromise || this.stopped) return;
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
    });
  }

  /** Shutdown wiring: stop the loop and abort any in-flight quantum. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.wake();
    for (const quantum of this.active.values()) quantum.controller.abort();
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }

  private nextRunnable(): FetchGithubRunRecord | null {
    // Bounded query, never a busy scan over finished runs.
    const row = this.deps.db
      .prepare(
        "SELECT id FROM research_fetch_github_runs WHERE state IN ('acquiring','processing') ORDER BY updated_at, id LIMIT 1"
      )
      .get() as { id: string } | undefined;
    return row ? this.journal.requireRun(row.id) : null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const run = this.nextRunnable();
      if (run === null) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            this.wakeups.delete(finish);
            resolve();
          };
          const timer = setTimeout(finish, this.deps.pollIntervalMs ?? 250);
          this.wakeups.add(finish);
          void timer;
        });
        continue;
      }
      try {
        if (run.phase === 'acquire') await this.acquisitionQuantum(run);
        else await this.processingQuantum(run);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'worker error';
        const fresh = this.journal.requireRun(run.runId);
        if (fresh.state === 'acquiring' || fresh.state === 'processing') {
          const cp = fresh.checkpoint;
          cp.gaps.push({ code: 'worker_error', detail });
          this.journal.updateCheckpoint(run.runId, cp);
          this.journal.updateRun(run.runId, { state: 'paused', stopReason: 'worker_error' });
          this.journal.appendEvent(run.runId, 'worker_error', { detail });
        }
      }
      // Keep checks serial and the event loop fair between quanta.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async acquisitionQuantum(run: FetchGithubRunRecord): Promise<void> {
    const controller = new AbortController();
    this.active.set(run.runId, { controller });
    try {
      await executeAcquisitionQuantum(
        run,
        {
          store: this.deps.store,
          journal: this.journal,
          transport: this.deps.transport,
          githubToken: this.deps.githubToken,
          timeoutMs: this.deps.timeoutMs ?? LIMITS.providerTimeoutMs,
          maxBytes: this.deps.maxBytes ?? LIMITS.providerMaxBytes
        },
        controller.signal
      );
    } finally {
      this.active.delete(run.runId);
    }
    const fresh = this.journal.requireRun(run.runId);
    if (fresh.state !== 'acquiring') return;
    // An unknown outcome stops the run as unreconciled BEFORE any next HTTP
    // or snapshot freeze — even without a restart, never auto-retried.
    if (this.journal.listUnresolvedRequests(fresh.runId).length > 0) {
      this.journal.updateRun(fresh.runId, { state: 'unreconciled', stopReason: 'outcome_unknown' });
      this.journal.appendEvent(fresh.runId, 'unreconciled', { reason: 'outcome_unknown' });
      return;
    }
    if (planNextRequest(fresh, this.journal) === null) {
      // Acquisition plan drained: freeze the immutable snapshot and hand the
      // captured material to phase 2 (zero new HTTP from here on). The freeze
      // itself refuses unresolved intents and commits atomically.
      freezeSnapshot(fresh, this.journal);
      this.wake();
    }
  }

  private async processingQuantum(run: FetchGithubRunRecord): Promise<void> {
    const summary = await this.processingStep(run);
    if (summary === null) return;
    this.journal.appendEvent(run.runId, 'processing_summary', this.processingView(summary));
    const fresh = this.journal.requireRun(run.runId);
    if (fresh.state !== 'processing') return;
    if (summary.state === 'running') return; // resumable scheduling quantum
    if (summary.stopReason === 'unreconciled_action') {
      this.journal.updateRun(run.runId, { state: 'unreconciled', stopReason: 'processing_unreconciled' });
      return;
    }
    this.journal.updateRun(run.runId, { state: 'finished', stopReason: summary.stopReason });
    this.journal.appendEvent(run.runId, 'finished', { stopReason: summary.stopReason });
  }

  /**
   * ONE phase-2 scheduling quantum over the frozen snapshot. Zero HTTP: the
   * production cached handlers serve exactly the captured material through
   * the GET-59 gateway, and the deterministic scheduler reports honest zero
   * external-model usage.
   */
  private async processingStep(run: FetchGithubRunRecord): Promise<FetchPipelineSummary | null> {
    const built = buildGithubSnapshotCatalog(this.journal, run);
    const catalog = built.catalog;
    let pipelineRunId = run.pipelineRunId;
    if (pipelineRunId === null) {
      pipelineRunId = this.pipelineRuns.createRun({
        ownerId: run.ownerId,
        caseId: run.caseId,
        scopeSpecId: run.scopeSpecId,
        scopeVersion: run.scopeVersion,
        checkpoint: createInitialCheckpoint(catalog, run.scopeVersion as ScopeVersion)
      }).runId;
      this.journal.updateRun(run.runId, { pipelineRunId });
    }
    const handlers = createCachedGithubHandlers({
      store: this.deps.store,
      journal: this.journal,
      run,
      catalog,
      commentCapture: built.commentCapture
    });
    const tools = createResearchToolServer({
      store: this.deps.store,
      handlers: handlers as ResearchToolServer['ports']['handlers'],
      // Phase 2 is strictly zero-HTTP: the cached executor never performs a
      // request and fails closed if a handler ever tried.
      executor: createNoNetworkCachedExecutor(),
      accounting: this.pipelineRuns.createAccountingPort(pipelineRunId),
      cursors: this.pipelineRuns.createCursorPort(pipelineRunId),
      submissions: this.pipelineRuns.createSubmissionPort(pipelineRunId),
      controller: this.pipelineRuns.createControllerPort(pipelineRunId)
    });
    const unresolvedIntents = this.pipelineRuns.listUnresolvedIntents(pipelineRunId);
    const controller = new AbortController();
    this.active.set(run.runId, { controller });
    try {
      return await runFetchPipeline(
        {
          store: this.deps.store,
          runs: this.pipelineRuns,
          tools,
          model: createDeterministicFetchScheduler(),
          catalog,
          ownerId: run.ownerId,
          caseId: run.caseId,
          scopeSpecId: run.scopeSpecId,
          runId: pipelineRunId,
          synthetic: false,
          capabilityInjection: createGithubCapabilitySnapshot(),
          provenance: FETCH_GITHUB_ACQUISITION_PROVENANCE,
          maxBatches: this.deps.processingBatchesPerStep ?? 1,
          // An explicit user resume is the authoritative reconciliation of
          // unresolved cached dispatch intents; nothing is auto-replayed.
          ...(unresolvedIntents.length > 0 ? { reconcileUnresolvedIntents: 'abandon' as const } : {})
        },
        controller.signal
      );
    } finally {
      this.active.delete(run.runId);
    }
  }

  private processingView(summary: FetchPipelineSummary): FetchGithubProcessingView {
    return {
      pipelineRunId: summary.runId,
      state: summary.state,
      stopReason: summary.stopReason,
      openSteps: summary.openSteps,
      counts: {
        toolActions: summary.counts.toolActions,
        providerRequests: summary.counts.providerRequests,
        listedItems: summary.counts.listedItems,
        bodiesRead: summary.counts.bodiesRead,
        commentsRead: summary.counts.commentsRead,
        findingsStaged: summary.counts.findingsStaged,
        verificationsStaged: summary.counts.verificationsStaged,
        // The scheduler is deterministic and local: ZERO external LLM calls,
        // reported separately from its own decision count (never presented
        // as real model use).
        modelCalls: 0,
        schedulerDecisions: summary.counts.modelCalls,
        modelInputTokens: summary.counts.modelInputTokens,
        modelOutputTokens: summary.counts.modelOutputTokens,
        modelEstimatedUsd: summary.counts.modelEstimatedUsd
      },
      assessment: summary.assessment
        ? {
            verdict: summary.assessment.verdict,
            dimensions: summary.assessment.dimensions.map((dimension) => ({
              dimension: dimension.dimension,
              state: dimension.state,
              unresolved: dimension.unresolved
            }))
          }
        : null,
      pendingFindings: summary.pendingFindings.map((finding) => ({
        pendingRef: finding.pendingRef,
        kind: finding.kind,
        accountIds: finding.accountIds,
        dependencyEvidenceIds: finding.dependencyEvidenceIds
      })),
      remainingGaps: summary.remainingGaps
    };
  }
}
