import { runResearch } from '../research/controller.js';
import { createDshPlanner, type ResearchPlanner } from '../research/planner.js';
import type { ResearchTools } from '../research/tool-contracts.js';
import { LIMITS } from '../../shared/limits.js';
import { isTerminalState, NeedsInputError } from '../../shared/types.js';
import type { ProviderName, RunState } from '../../shared/types.js';
import { ProviderError } from '../adapters/types.js';
import type { HttpTransport, ProviderFactory, ProviderReporter, ResearchProvider } from '../adapters/types.js';
import type { AppConfig } from '../config.js';
import { RunTerminalError, Store, nowIso } from '../store.js';
import type { RunRecord } from '../store.js';

export interface StartGate {
  allowed: boolean;
  code: 'rate_limited' | 'run_limit' | null;
  message: string | null;
}

export interface RunnerDeps {
  store: Store;
  config: AppConfig;
  providerFactory: ProviderFactory;
  transport: HttpTransport;
  now?: () => number;
  researchTools?: ResearchTools;
  researchPlanner?: ResearchPlanner;
}

interface ActiveJob {
  ownerId: string;
  controller: AbortController;
}

/**
 * Durable job runner. Concurrency is per-user 1 and global 3; queued runs wait
 * for a slot. Late provider results can never overwrite a cancelled, deleted or
 * otherwise terminal run because every write goes through an active guard.
 */
export class Runner {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly starts = new Map<string, number[]>();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  checkStartAllowed(ownerId: string): StartGate {
    const windowStart = this.now() - LIMITS.startRateWindowMs;
    const recent = (this.starts.get(ownerId) ?? []).filter((timestamp) => timestamp > windowStart);
    this.starts.set(ownerId, recent);
    if (recent.length >= LIMITS.startRateMax) {
      return { allowed: false, code: 'rate_limited', message: '启动过于频繁，请稍后再试。' };
    }
    if (this.deps.store.countRunsForOwner(ownerId) >= LIMITS.maxRunsPerUser) {
      return { allowed: false, code: 'run_limit', message: '研究记录数量已达上限，请先删除旧记录。' };
    }
    return { allowed: true, code: null, message: null };
  }

  recordStart(ownerId: string): void {
    const recent = this.starts.get(ownerId) ?? [];
    recent.push(this.now());
    this.starts.set(ownerId, recent);
  }

  isRunning(runId: string): boolean {
    return this.jobs.has(runId);
  }

  activeCount(): number {
    return this.jobs.size;
  }

  createProvider(name: ProviderName): ResearchProvider {
    return this.deps.providerFactory(name);
  }

  enqueue(runId: string): void {
    // Fire and forget; pump owns slot accounting.
    void this.pump().catch(() => undefined);
    void runId;
  }

  hasActiveOwner(ownerId: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.ownerId === ownerId) return true;
    }
    return false;
  }

  async pump(): Promise<void> {
    if (this.stopped) return;
    for (;;) {
      if (this.jobs.size >= LIMITS.globalConcurrentJobs) return;
      const queued = this.deps.store.listQueuedRuns();
      const next = queued.find((run) => !this.jobs.has(run.id) && !this.hasActiveOwner(run.ownerId));
      if (!next) return;
      const controller = new AbortController();
      this.jobs.set(next.id, { ownerId: next.ownerId, controller });
      void this.execute(next.id, controller)
        .catch(() => undefined)
        .finally(() => {
          this.jobs.delete(next.id);
          void this.pump().catch(() => undefined);
        });
    }
  }

  /** Abort an in-flight job without changing its persisted state (used before delete). */
  abort(runId: string): void {
    this.jobs.get(runId)?.controller.abort();
  }

  cancel(runId: string): boolean {
    const run = this.deps.store.getRun(runId);
    if (!run) return false;
    const wasActive = !isTerminalState(run.state);
    this.deps.store.requestCancel(runId);
    if (wasActive) {
      this.deps.store.addEvent(runId, 'state', { state: 'cancelled' satisfies RunState });
    }
    this.jobs.get(runId)?.controller.abort();
    return true;
  }

  resume(runId: string, ownerId: string, seedUrl: string | null): RunRecord | 'not_found' | 'conflict' {
    const run = this.deps.store.getRunForOwner(runId, ownerId);
    if (!run) return 'not_found';
    if (run.state !== 'needs_input') return 'conflict';
    if (run.provider === 'research') {
      const checkpoint = this.deps.store.research.checkpoint(runId);
      if (!checkpoint) return 'conflict';
      checkpoint.anchorUrl = seedUrl; checkpoint.identity = null; checkpoint.candidates = []; checkpoint.phase = 'identity';
      this.deps.store.research.save(runId, checkpoint);
    }
    this.deps.store.updateRun(runId, {
      seed_url: seedUrl,
      revision: run.revision + 1,
      state: 'queued',
      cancel_requested: 0,
      error_code: null,
      error_message: null,
      stop_reason: null
    });
    this.deps.store.addEvent(runId, 'state', { state: 'queued' satisfies RunState, resumed: true });
    this.enqueue(runId);
    return this.deps.store.getRun(runId) as RunRecord;
  }

  stopAll(): void {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
  }

  private assertWritable(runId: string): RunRecord {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new RunTerminalError(runId);
    if (run.cancelRequested || isTerminalState(run.state)) throw new RunTerminalError(runId);
    return run;
  }

  private makeReporter(runId: string): ProviderReporter {
    return {
      stage: (index, total, key, label, status, detail) => {
        this.assertWritable(runId);
        this.deps.store.addEvent(runId, 'stage', {
          index,
          total,
          key,
          label,
          status,
          detail: detail ?? null
        });
      },
      source: (draft) => {
        this.assertWritable(runId);
        const sortOrder = this.deps.store.listSources(runId).length;
        this.deps.store.addSource(runId, draft, sortOrder);
        const canonical = this.deps.store.getSource(runId, draft.key);
        this.deps.store.addEvent(runId, 'source', canonical);
      }
    };
  }

  private async execute(runId: string, controller: AbortController): Promise<void> {
    const initial = this.deps.store.getRun(runId);
    if (!initial) return;
    if (initial.cancelRequested || isTerminalState(initial.state)) {
      return;
    }
    if (initial.provider !== 'research') this.deps.store.clearRunContent(runId);
    this.deps.store.updateRunIfActive(runId, {
      state: 'researching',
      started_at: nowIso(),
      error_code: null,
      error_message: null,
      interrupted: 0,
      stop_reason: null,
      finished_at: null
    });
    this.deps.store.addEvent(runId, 'state', { state: 'researching' satisfies RunState });

    const provider = initial.provider === 'research' ? null : this.createProvider(initial.provider);
    const reporter = this.makeReporter(runId);
    const startedAt = this.now();
    try {
      const result = initial.provider === 'research' ? await runResearch({
        store: this.deps.store, run: initial, signal: controller.signal,
        tools: this.deps.researchTools ?? { async execute() { throw new ProviderError('provider_unavailable', '研究工具未配置。'); } },
        planner: this.deps.researchPlanner ?? createDshPlanner(this.deps.config.deepseekModel),
        transport: this.deps.transport, deepseekApiKey: this.deps.config.deepseekApiKey,
        socialAvailable: Boolean(this.deps.config.tikhubApiKey), firecrawlAvailable: Boolean(this.deps.config.firecrawlApiKey)
      }) : await provider!.run(
        {
          question: initial.question,
          seedUrl: initial.seedUrl,
          provider: initial.provider,
          parentRunId: initial.parentRunId,
          retryOf: initial.retryOf,
          followup: initial.followup
        },
        {
          transport: this.deps.transport,
          signal: controller.signal,
          report: reporter,
          githubToken: this.deps.config.githubToken,
          exaApiKey: this.deps.config.exaApiKey,
          timeoutMs: LIMITS.providerTimeoutMs,
          maxBytes: LIMITS.providerMaxBytes
        }
      );
      this.assertWritable(runId);
      // The provider result is the single source of truth; realtime source
      // events may have arrived during the run with transient fields.
      this.deps.store.replaceSources(runId, result.sources);
      this.deps.store.clearObservations(runId);
      result.observations.forEach((observation, index) => {
        this.deps.store.addObservation(runId, observation, index);
        this.deps.store.addEvent(runId, 'observation', {
          statement: observation.statement,
          kind: observation.kind,
          sourceKeys: observation.sourceKeys
        });
      });
      const current = this.deps.store.getRun(runId);
      const nextRevision = (current?.revision ?? initial.revision) + 1;
      const changes = this.deps.store.updateRunIfActive(runId, {
        identity_json: JSON.stringify(result.identity),
        answer_json: JSON.stringify(result.answer),
        limitations_json: JSON.stringify(result.limitations),
        usage_json: JSON.stringify({
          provider: initial.provider,
          requests: result.usage.requests,
          bytes: result.usage.bytes,
          elapsedMs: this.now() - startedAt,
          measurement: 'observed'
        }),
        state: result.state,
        stop_reason: result.stopReason,
        revision: nextRevision,
        finished_at: nowIso()
      });
      if (changes === 0) throw new RunTerminalError(runId);
      this.deps.store.addEvent(runId, 'answer', { sections: result.answer });
      this.deps.store.addEvent(runId, 'state', { state: result.state, stopReason: result.stopReason });
    } catch (error) {
      this.handleFailure(runId, error, controller.signal.aborted);
    }
  }

  private handleFailure(runId: string, error: unknown, aborted: boolean): void {
    const run = this.deps.store.getRun(runId);
    if (!run || isTerminalState(run.state)) return;
    if (run.cancelRequested) {
      this.deps.store.updateRun(runId, { state: 'cancelled', stop_reason: 'cancelled', finished_at: nowIso() });
      return;
    }
    if (error instanceof RunTerminalError) return;
    if (error instanceof NeedsInputError) {
      this.deps.store.updateRunIfActive(runId, {
        state: 'needs_input',
        revision: run.revision + 1,
        identity_json: JSON.stringify({
          displayName: '',
          handle: null,
          profileUrl: null,
          status: 'needs_input',
          note: error.prompt,
          candidates: error.candidates
        }),
        error_code: null,
        error_message: null
      });
      this.deps.store.addEvent(runId, 'needs_input', {
        prompt: error.prompt,
        revision: run.revision + 1,
        candidates: error.candidates
      });
      this.deps.store.addEvent(runId, 'state', { state: 'needs_input' satisfies RunState });
      return;
    }
    if (aborted) {
      // Cancellation already handled above; otherwise the process is stopping
      // and restart recovery will mark the run partial.
      return;
    }
    const providerError = error instanceof ProviderError ? error : null;
    const code = providerError?.code ?? 'internal_error';
    const message = providerError?.message ?? '研究过程中出现错误。';
    this.deps.store.updateRunIfActive(runId, {
      state: 'failed',
      error_code: code,
      error_message: message,
      stop_reason: code,
      finished_at: nowIso()
    });
    this.deps.store.addEvent(runId, 'error', { code, message });
    this.deps.store.addEvent(runId, 'state', { state: 'failed' satisfies RunState, code });
  }
}
