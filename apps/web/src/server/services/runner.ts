import { buildResearchReport, failedUsage, runResearch, scopeRefusalRecord, tagScopeRefusal, type ScopedResearchTools } from '../research/controller.js';
import { createDshPlanner, type ResearchPlanner } from '../research/planner.js';
import type { ResearchTools } from '../research/tool-contracts.js';
import { LIMITS } from '../../shared/limits.js';
import { isTerminalState, NeedsInputError } from '../../shared/types.js';
import type { ProviderName, RunState, ProviderResult } from '../../shared/types.js';
import { ProviderError } from '../adapters/types.js';
import { ResearchStop, RESEARCH_LIMITS } from '../research/research-store.js';
import type { HttpTransport, ProviderFactory, ProviderReporter, ResearchProvider } from '../adapters/types.js';
import type { AppConfig } from '../config.js';
import { RunTerminalError, Store, nowIso } from '../store.js';
import type { RunRecord } from '../store.js';
import { FirstStepStore, FirstStepSelectionError } from '../research/first-step-store.js';
import { createFirstStepCheckedSearch, createFirstStepProposalModel, discoverFirstStep } from '../research/first-step-discovery.js';
import type { FirstStepCheckedSearch } from '../research/first-step-discovery.js';
import { classifyFirstStepUrl, FIRST_STEP_DEFAULT_BUDGET } from '../../shared/first-step-discovery.js';
import type { PlatformCatalogSnapshot } from '../../shared/platform-catalog.js';

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
  /** First-step persistence; runs with a link use the new first-step flow. */
  firstStep?: FirstStepStore;
  /** Bound platform catalog for first-step obligation freezing. */
  discoveryCatalog?: PlatformCatalogSnapshot | null;
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
    this.deps.firstStep?.setPhase(runId, 'cancelled');
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
      // First-step runs (fresh production default) drive discovery / scoped
      // fetch here; the frozen controller path stays for historical jobs and
      // the replay baselines.
      const firstStepLink = initial.provider === 'research' && this.deps.firstStep ? this.deps.firstStep.link(runId) : null;
      if (firstStepLink && this.deps.firstStep) {
        await this.executeBoundedFirstStep(runId, initial, controller, startedAt);
        return;
      }
      const result = initial.provider === 'research' ? await runResearch({
        store: this.deps.store, run: initial, signal: controller.signal,
        tools: this.deps.researchTools ?? { async execute() { throw new ProviderError('provider_unavailable', '研究工具未配置。'); } },
        planner: this.deps.researchPlanner ?? createDshPlanner(this.deps.config.deepseekModel),
        transport: this.deps.transport, deepseekApiKey: this.deps.config.deepseekApiKey,
        limits: this.deps.config.researchLimits,
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
      this.finishWithResult(runId, initial, result, startedAt);
    } catch (error) {
      this.handleFailure(runId, error, controller.signal.aborted);
    }
  }

  /**
   * The first-step job: no selection yet runs the Search discovery and waits
   * for the one scope confirmation; a submitted selection runs the existing
   * fetch loop inside the frozen, per-dispatch re-checked scope. Independent
   * account material stays isolated from same-person claims.
   */
  private async executeBoundedFirstStep(runId: string, initial: RunRecord, parent: AbortController, startedAt: number): Promise<void> {
    const research = this.deps.store.research;
    let checkpoint = research.checkpoint(runId);
    const frozenLimits = checkpoint?.limits ?? { ...(this.deps.config.researchLimits ?? RESEARCH_LIMITS) };
    if (!checkpoint) {
      checkpoint = { phase: 'first_step_search', steps: 0, startedAt: Date.now(), elapsedMs: 0,
        limits: frozenLimits, anchorUrl: null, identity: null, candidates: [], pages: [], claims: [], unknowns: [], stopReason: null };
    } else if (!checkpoint.limits) checkpoint.limits = frozenLimits;
    research.save(runId, checkpoint);
    const previousElapsed = checkpoint.elapsedMs;
    const deadline = new AbortController();
    const remaining = frozenLimits.elapsedMs > 0 ? Math.max(0, frozenLimits.elapsedMs - previousElapsed) : null;
    const timer = remaining === null ? null : setTimeout(() => deadline.abort(new ResearchStop('budget_exhausted')), remaining);
    const signal = AbortSignal.any([parent.signal, deadline.signal]);
    try {
      if (remaining === 0) deadline.abort(new ResearchStop('budget_exhausted'));
      signal.throwIfAborted();
      await this.executeFirstStep(runId, initial, { signal }, startedAt);
    } catch (error) {
      if (!parent.signal.aborted && deadline.signal.aborted) {
        const run = this.deps.store.getRun(runId);
        if (run && !isTerminalState(run.state) && !run.cancelRequested) {
          const selected = this.deps.firstStep?.selectionBinding(runId) !== null;
          const timed = research.checkpoint(runId);
          if (timed) { timed.elapsedMs = previousElapsed + Math.max(0, this.now() - startedAt); research.save(runId, timed); }
          const message = '本次研究达到执行时长上限，已有资料与回执已保留。可以新建研究继续。';
          this.deps.firstStep?.setPhase(runId, 'blocked');
          this.deps.store.updateRunIfActive(runId, { state: selected ? 'partial' : 'needs_input', stop_reason: 'budget_exhausted',
            error_code: 'budget_exhausted', error_message: message, revision: run.revision + 1 });
          this.deps.store.addEvent(runId, 'error', { code: 'budget_exhausted', message });
          this.deps.store.addEvent(runId, 'state', { state: selected ? 'partial' : 'needs_input', stopReason: 'budget_exhausted' });
        }
      } else throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      const current = this.deps.store.getRun(runId);
      if (current && !isTerminalState(current.state) && !current.cancelRequested && !parent.signal.aborted) {
        const latest = research.checkpoint(runId);
        if (latest) {
          // Count active work only; the user's time choosing accounts is excluded.
          latest.elapsedMs = previousElapsed + Math.max(0, this.now() - startedAt);
          research.save(runId, latest);
        }
      }
    }
  }

  private async executeFirstStep(runId: string, initial: RunRecord, controller: { signal: AbortSignal }, startedAt: number): Promise<void> {
    const firstStep = this.deps.firstStep as FirstStepStore;
    const binding = firstStep.selectionBinding(runId);
    const tools = this.deps.researchTools ?? {
      async execute() {
        throw new ProviderError('provider_unavailable', '研究工具未配置。');
      }
    };
    if (!binding) {
      const link = firstStep.link(runId)!;
      const input = {
        kind: (initial.seedUrl ? 'homepage_url' : 'name_query') as 'homepage_url' | 'name_query',
        value: (link.hint ?? initial.seedUrl ?? initial.question).trim(),
        question: initial.question
      };
      const search: FirstStepCheckedSearch = createFirstStepCheckedSearch({
        tools,
        store: this.deps.store,
        runId,
        attemptId: `input-${String(link.inputRevision)}`,
        budget: FIRST_STEP_DEFAULT_BUDGET,
        // The OPERATOR's real ceilings: discovery never raises configured caps.
        limits: this.deps.store.research.checkpoint(runId)?.limits ?? this.deps.config.researchLimits,
        modelName: this.deps.config.deepseekModel
      });
      await discoverFirstStep({
        store: this.deps.store,
        firstStep,
        ownerId: initial.ownerId,
        runId,
        input,
        search,
        signal: controller.signal,
        registryVersion: this.deps.discoveryCatalog?.registryVersion ?? 'catalog-unavailable',
        catalog: this.deps.discoveryCatalog ?? null,
        hint: link.hint,
        firecrawlAvailable: Boolean(this.deps.config.firecrawlApiKey),
        // The restricted first-step model role runs on the PRODUCT model
        // provider (same configured DeepSeek credential as research); metered
        // through the checked ledger and fully server-verified.
        propose:
          this.deps.config.deepseekApiKey && this.deps.config.exaApiKey
            ? createFirstStepProposalModel({
                transport: this.deps.transport,
                apiKey: String(this.deps.config.deepseekApiKey),
                model: this.deps.config.deepseekModel ?? 'deepseek-flash'
              })
            : undefined
      });
      // Wait for the one scope confirmation; the projection carries the rest.
      this.deps.store.updateRunIfActive(runId, {
        state: 'needs_input',
        revision: (this.deps.store.getRun(runId)?.revision ?? initial.revision) + 1,
        identity_json: JSON.stringify({
          displayName: '',
          handle: null,
          profileUrl: null,
          status: 'needs_input',
          note: '请在第一步确认人物与研究账号范围。',
          candidates: []
        }),
        error_code: null,
        error_message: null
      });
      this.deps.store.addEvent(runId, 'needs_input', { prompt: '请确认人物与研究账号范围。', firstStep: true });
      this.deps.store.addEvent(runId, 'state', { state: 'needs_input' satisfies RunState });
      return;
    }
    // Scope-limited fetch: every dispatch AND ingestion re-checks the live
    // scope; excluded/unselected/later-discovered accounts are refused.
    const guard = firstStep.scopeGuard(initial.ownerId, runId);
    const independentAccountKeys = new Set(
      Object.entries(binding.accountKeys)
        .filter(([, accountId]) => binding.independentAccountIds.includes(accountId))
        .map(([accountKey]) => accountKey)
    );
    const firstStepScope = {
      assertCurrent: () => guard.assertCurrent(),
      selectedAccountKeys: new Set(Object.keys(binding.accountKeys)),
      independentAccountKeys,
      accountKeyOf: (url: string): string | null => {
        const classified = classifyFirstStepUrl(url);
        return classified.ok ? classified.ref.accountKey : null;
      }
    };
    const guardedTools: ScopedResearchTools = {
      // Fail-closed predispatch check, run before any metered reservation so a
      // rejected predispatch action is never billed and leaves no receipt.
      predispatch(action) {
        guard.assertDispatch(action);
        if(action.type==='search')throw new FirstStepSelectionError('out_of_scope','账号范围已确认；此阶段只读取已观察到的所选账号内容。扩展平台须显式修订发现范围。');
      },
      async execute(action, signal) {
        try {
          guard.assertDispatch(action);
        } catch (error) {
          // Rejected BEFORE any provider request ran: never billed downstream.
          throw tagScopeRefusal(error, { dispatched: false });
        }
        const result = await tools.execute(action, signal);
        try {
          guard.assertIngest(result.pages.map((page) => ({ url: page.url, links: page.links })));
        } catch (error) {
          // The request ran but its late result is refused: the measured cost
          // is metered honestly and the material is never ingested.
          throw tagScopeRefusal(error, {
            dispatched: true,
            usage: { estimatedUsd: result.estimatedUsd, credits: result.credits, bytes: result.bytes, unknownCost: result.estimatedUsd === null }
          });
        }
        return result;
      }
    };
    const checkpoint = this.deps.store.research.checkpoint(runId);
    let scopeStopped = false;
    if (checkpoint) {
      // Never reintroduce legacy/unsolicited pages into the new model corpus:
      // only material attributable to a frozen selected account stays.
      const kept = checkpoint.pages.filter((page) => {
        const key = firstStepScope.accountKeyOf(page.url);
        return key !== null && binding.accountKeys[key] !== undefined;
      });
      if (kept.length !== checkpoint.pages.length) {
        checkpoint.notes = [
          ...new Set([
            ...(checkpoint.notes ?? []),
            `${String(checkpoint.pages.length - kept.length)} 个旧发现页面不属于已冻结范围，未带入本次人物结论语料；历史记录仍保留。`
          ])
        ];
      }
      checkpoint.pages = kept;
      if (!checkpoint.identity && binding.anchorUrl) {
        checkpoint.anchorUrl = binding.anchorUrl;
      }
      checkpoint.identity = {
        displayName: binding.displayName ?? binding.anchorUrl ?? '',
        handle: null,
        profileUrl: binding.anchorUrl,
        status: 'resolved',
        note: '已按用户确认的人物范围绑定；跨平台身份仍按证据逐条判断。',
        candidates: []
      };
      this.deps.store.research.save(runId, checkpoint);
      // Schedule and ingest the initial eligible material for EVERY selected
      // account (independent ones stay isolated own-account material) so the
      // planner starts from the real frozen scope, not only the anchor. Every
      // real read is METERED through the same action ledger and the operator's
      // total budget: a same-attempt completed receipt replays its exact saved
      // output without re-executing, unknown inflight is never replayed, and a
      // failed read stays an honest gap instead of a silent retry.
      const fetchLimits = checkpoint.limits ?? this.deps.config.researchLimits;
      const seedAttempt = `seed-${String(binding.discoveryRevision)}-${String(binding.scopeVersion)}`;
      for (const account of binding.accounts) {
        if (!account.profileUrl) continue;
        const action: Parameters<ResearchTools['execute']>[0] = (() => {
          const classified = classifyFirstStepUrl(account.profileUrl);
          const platform = classified.ok ? classified.ref.platform : null;
          if (platform === 'github') return { type: 'github_profile', url: account.profileUrl };
          if (platform === 'x') return { type: 'social_profile', url: account.profileUrl };
          return { type: 'read', url: account.profileUrl };
        })();
        const requestKey = `firststep:fetch:${seedAttempt}:${account.accountId}`;
        let result: Awaited<ReturnType<ResearchTools['execute']>> | null = null;
        try {
          // Predispatch refusal stops BEFORE any reservation: never billed.
          guardedTools.predispatch?.(action);
          this.deps.store.addEvent(runId,'stage',{index:binding.accounts.indexOf(account)+1,total:binding.accounts.length,key:`selected-${account.accountId}`,label:`读取已选账号 ${binding.accounts.indexOf(account)+1}/${binding.accounts.length}：${account.profileUrl}`,status:'active'});
          const old = this.deps.store.research.reserve(runId, requestKey, 'tool', action, { inputTokens: 0, outputTokens: 0 }, fetchLimits, true);
          if (old) {
            if (old.state !== 'completed') {
              // Known settled failure: kept inspectable, never re-executed.
              checkpoint.unknowns.push(`所选账号初始读取曾失败，保留失败回执不重放：${account.profileUrl}`);
              continue;
            }
            // Same-attempt recovery: reuse the exact saved output, no re-read.
            result = old.result as Awaited<ReturnType<ResearchTools['execute']>>;
          } else {
            try {
              result = await guardedTools.execute(action, controller.signal);
              this.deps.store.research.settle(runId, requestKey, result, {
                estimatedUsd: result.estimatedUsd,
                credits: result.credits,
                bytes: result.bytes,
                unknownCost: result.estimatedUsd === null
              });
            } catch (error) {
              try {
                this.deps.store.research.settle(runId, requestKey, null, failedUsage(error), 'failed');
              } catch { /* cancelled/deleted runs refuse late receipts */ }
              throw error;
            }
          }
        } catch (error) {
          if (error instanceof ResearchStop && error.code === 'unknown_inflight') {
            checkpoint.unknowns.push(`所选账号初始读取结果未知（不重放）：${account.profileUrl}`);
            continue;
          }
          if (error instanceof ResearchStop && error.code === 'budget_exhausted') {
            checkpoint.unknowns.push('操作员总预算上限已到，剩余所选账号初始材料未读取；缺口保留，不自动重试。');
            break;
          }
          if (error instanceof ProviderError) {
            // A failed initial read is a real gap for this account, not absence.
            checkpoint.unknowns.push(`所选账号初始材料未读取成功（${error.code}）：${account.profileUrl}；不代表无资料。`);
            continue;
          }
          if (error instanceof FirstStepSelectionError && error.code === 'out_of_scope') {
            // Fail-closed per-account refusal: an honest gap, never a fetch;
            // the remaining selected accounts keep their initial material.
            checkpoint.unknowns.push(`所选账号初始材料被范围守卫拒绝（${error.detail}）；${scopeRefusalRecord(error)?.dispatched?'请求已发生，实际用量保留，返回材料未入库':'未发送请求'}，缺口保留，已读材料不变。`);
            continue;
          }
          if (error instanceof FirstStepSelectionError && error.code === 'scope_changed') {
            // Frozen scope withdrawn mid-seed: STOP all further reads and keep
            // the preserved material for review; never internal_error and
            // never a needs_input screen over a stale immutable binding.
            checkpoint.unknowns.push(`冻结范围已撤回或失效（${error.detail}）；停止继续读取与新结论，已读材料与检查点保留待复核；如需继续，请通过现有第一步流程以新的范围重新开始研究。`);
            scopeStopped = true;
            break;
          }
          throw error;
        }
        for (const page of result.pages) {
            const url = page.url;
            if (checkpoint.pages.some((existing) => existing.url === url)) continue;
            const sourceKey = `S${String(checkpoint.pages.length + 1)}`;
            checkpoint.pages.push({
              sourceKey,
              url,
              title: page.title || url,
              text: page.text,
              kind: page.kind,
              publishedAt: page.publishedAt ?? null,
              author: page.author ?? null,
              retrievedAt: new Date().toISOString(),
              account: page.account,
              links: page.links,
              limitations: [
                ...page.limitations,
                account.independent ? '独立账号范围：该材料只作该账号自身记录，不并入同一人物结论。' : '用户已冻结范围内账号的初始材料。'
              ],
              retrieval: action.type === 'read' ? 'read' : 'profile',
              textTruncated: page.textTruncated ?? false
            });
            this.deps.store.addSource(
              runId,
              {
                key: sourceKey,
                url,
                title: page.title || url,
                kind: page.kind,
                publishedAt: page.publishedAt ?? null,
                excerpt: page.text,
                excerptLocator: '公开页面文本',
                identityLabel: account.independent ? '独立账号范围：尚未证明与其他账号同人' : '用户所选范围内的账号',
                identityConfirmed: false,
                fetchStatus: page.text ? 'ok' : 'inaccessible',
                limits: page.limitations
              },
              checkpoint.pages.length - 1
            );
          }
      }
      this.deps.store.research.save(runId, checkpoint);
    }
    if (checkpoint && scopeStopped) {
      checkpoint.elapsedMs += Math.max(0, this.now() - startedAt);
      // A scope stop publishes a paused review report from the preserved
      // checkpoint: same sources, no new claims, explicit scope stop reason.
      const paused = buildResearchReport({
        store: this.deps.store,
        run: initial,
        checkpoint,
        limits: checkpoint.limits ?? this.deps.config.researchLimits ?? RESEARCH_LIMITS,
        firstStepScope
      }, 'scope_changed', 'partial');
      this.deps.store.research.save(runId, checkpoint);
      this.finishWithResult(runId, initial, paused, startedAt);
      return;
    }
    if (checkpoint) {
      checkpoint.elapsedMs += Math.max(0, this.now() - startedAt);
      this.deps.store.research.save(runId, checkpoint);
    }
    const result = await runResearch({
      store: this.deps.store,
      run: initial,
      signal: controller.signal,
      tools: guardedTools,
      planner: this.deps.researchPlanner ?? createDshPlanner(this.deps.config.deepseekModel),
      transport: this.deps.transport,
      deepseekApiKey: this.deps.config.deepseekApiKey,
      limits: this.deps.config.researchLimits,
      socialAvailable: Boolean(this.deps.config.tikhubApiKey),
      firecrawlAvailable: Boolean(this.deps.config.firecrawlApiKey),
      firstStepScope
    });
    this.finishWithResult(runId, initial, result, startedAt);
  }

  private finishWithResult(runId: string, initial: RunRecord, result: ProviderResult, startedAt: number): void {
      this.assertWritable(runId);
      // A scope stop stays reviewable (blocked), never pretending completion.
      this.deps.firstStep?.setPhase(runId, result.stopReason === 'scope_changed' || result.stopReason === 'source_revoked' ? 'blocked' : 'done');
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
  }

  private handleFailure(runId: string, error: unknown, aborted: boolean): void {
    const run = this.deps.store.getRun(runId);
    if (!run || isTerminalState(run.state)) return;
    if (run.cancelRequested) {
      this.deps.firstStep?.setPhase(runId, 'cancelled');
      this.deps.store.updateRun(runId, { state: 'cancelled', stop_reason: 'cancelled', finished_at: nowIso() });
      return;
    }
    if (error instanceof RunTerminalError) return;
    if (error instanceof NeedsInputError) {
      this.deps.firstStep?.setPhase(runId, 'awaiting_selection');
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
    if (error instanceof FirstStepSelectionError) {
      // Defensive: a scope-guard refusal must never surface as internal_error.
      this.deps.firstStep?.setPhase(runId, 'blocked');
      const message = `${error.detail}；已读材料与检查点保留待复核；如需继续，请通过现有第一步流程以新的范围重新开始研究。`;
      this.deps.store.updateRunIfActive(runId, {
        state: 'partial',
        error_code: error.code,
        error_message: message,
        stop_reason: error.code,
        finished_at: nowIso()
      });
      this.deps.store.addEvent(runId, 'error', { code: error.code, message });
      this.deps.store.addEvent(runId, 'state', { state: 'partial' satisfies RunState, stopReason: error.code });
      return;
    }
    const providerError = error instanceof ProviderError ? error : null;
    const code = providerError?.code ?? 'internal_error';
    const message = providerError?.message ?? '研究过程中出现错误。';
    this.deps.firstStep?.setPhase(runId, 'blocked');
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
