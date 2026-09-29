/**
 * Durable platform-discovery task runner.
 *
 * Continuity model (the point of this module):
 *
 * - Every stage persists its progress in a domain checkpoint BEFORE the next
 *   request: completed probe keys, per-link post cursors, finished links. A
 *   restarted process resumes instead of re-running paid questions; only an
 *   explicit `resume` continues, so nothing is silently re-billed.
 * - The correction stage is a single explicit pass: deterministic cross-link
 *   evidence may auto-confirm an account, everything else pauses as
 *   `needs_input` with the reason it needs review. Handle equality never
 *   auto-confirms identity.
 * - Tracking only reads posts through confirmed links. Dismissing a link
 *   revokes the attribution of every post collected through it.
 * - Cancellation first revokes execution (abort), then relies on the active
 *   state guard so a late probe result cannot rewrite a terminal task.
 */

import { createHash } from 'node:crypto';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { fetchBounded, fetchPostsPage, probePlatform } from '../adapters/discovery.js';
import { ProviderError } from '../adapters/types.js';
import type { HttpTransport } from '../adapters/types.js';
import type {
  AccountLinkRecord,
  DiscoveryTaskRecord
} from '../discovery-store.js';
import { DiscoveryStore } from '../discovery-store.js';
import type {
  CorrectionCandidate,
  DiscoveryCheckpoint,
  DiscoverySubject,
  DiscoveryUsage,
  LinkCorrectionInput,
  PlatformRegistry,
  PlatformRule,
  ProbeMethod,
  TrackedPostDraft
} from '../../shared/platform-discovery.js';
import {
  DEFAULT_DISCOVERY_LIMITS,
  budgetStop,
  emptyUsage,
  isTerminalDiscoveryState,
  nextLinkState,
  planOnePassCorrection,
  probeKey,
  remainingProbeKeys,
  reviewReasonFor,
  rulesForSubject,
  stageAfter,
  validateCorrection
} from '../../shared/platform-discovery.js';
import { LIMITS } from '../../shared/limits.js';

export interface DiscoveryRunnerDeps {
  store: DiscoveryStore;
  transport: HttpTransport;
  registry: PlatformRegistry;
  timeoutMs?: number;
  now?: () => number;
}

export interface DiscoveryStartGate {
  allowed: boolean;
  code: 'rate_limited' | 'task_limit' | null;
  message: string | null;
}

export class CorrectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CorrectionError';
  }
}

function methodOf(rule: PlatformRule): ProbeMethod {
  return rule.probe?.transport === 'api_http' ? 'api_http' : 'profile_http';
}

function profileKey(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return null; }
}

/** Only actual HTML self-links count, never mentions, comments or script text. */
function selfLinks(html: string, base: string): Set<string> {
  const targets = new Set<string>();
  const pending: DefaultTreeAdapterTypes.Node[] = [parseFragment(html)];
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node && node.tagName === 'a' && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const rel = node.attrs.find(attr => attr.name === 'rel')?.value.toLowerCase().split(/\s+/) ?? [];
      const href = node.attrs.find(attr => attr.name === 'href')?.value;
      const target = href && rel.includes('me') ? profileKey(href, base) : null;
      if (target) targets.add(target);
    }
    if ('childNodes' in node) pending.push(...node.childNodes);
  }
  return targets;
}

export class DiscoveryRunner {
  private readonly jobs = new Map<string, AbortController>();
  private readonly starts = new Map<string, number[]>();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: DiscoveryRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  checkStartAllowed(ownerId: string): DiscoveryStartGate {
    const windowStart = this.now() - LIMITS.startRateWindowMs;
    const recent = (this.starts.get(ownerId) ?? []).filter((t) => t > windowStart);
    this.starts.set(ownerId, recent);
    if (recent.length >= LIMITS.startRateMax) {
      return { allowed: false, code: 'rate_limited', message: '启动过于频繁，请稍后再试。' };
    }
    if (this.deps.store.countTasksForOwner(ownerId) >= LIMITS.discoveryMaxTasksPerUser) {
      return {
        allowed: false,
        code: 'task_limit',
        message: '平台发现任务数量已达上限，请先删除旧任务。'
      };
    }
    return { allowed: true, code: null, message: null };
  }

  recordStart(ownerId: string): void {
    const recent = this.starts.get(ownerId) ?? [];
    recent.push(this.now());
    this.starts.set(ownerId, recent);
  }

  isRunning(taskId: string): boolean {
    return this.jobs.has(taskId);
  }

  /** Cancel: revoke execution first (abort), then persist the terminal state. */
  cancel(taskId: string): void {
    const controller = this.jobs.get(taskId);
    if (controller) {
      controller.abort();
      this.jobs.delete(taskId);
    }
    this.deps.store.requestCancel(taskId);
  }

  /** Schedule a task attempt. Idempotent while the task is already running. */
  schedule(taskId: string): void {
    if (this.stopped || this.jobs.has(taskId)) return;
    const controller = new AbortController();
    this.jobs.set(taskId, controller);
    void this.executeTask(taskId, controller).catch((error: unknown) => {
      const task = this.deps.store.getTask(taskId);
      if (!controller.signal.aborted && task && !isTerminalDiscoveryState(task.state)) {
        this.deps.store.setState(taskId, 'failed', {
          stop_reason: 'error',
          error_code: 'internal_error',
          error_message: error instanceof Error ? error.message : '任务执行失败。'
        });
        this.deps.store.addEvent(taskId, 'failed', {
          error: error instanceof Error ? error.message : 'unknown'
        });
      }
    });
  }

  /** Resume a paused/interrupted task from its checkpoint. */
  resume(taskId: string): boolean {
    const task = this.deps.store.getTask(taskId);
    if (!task) return false;
    if (task.state === 'cancelled' || task.state === 'completed') return false;
    const running = this.jobs.get(taskId);
    const activelyRunning =
      running !== undefined &&
      (task.state === 'queued' ||
        task.state === 'discovering' ||
        task.state === 'correcting' ||
        task.state === 'tracking');
    if (activelyRunning) return true;
    if (running) {
      // A stale attempt is still in flight from before the interruption; its
      // writes are already guarded, and it must not keep the task paused.
      running.abort();
      this.jobs.delete(taskId);
    }
    this.deps.store.updateTask(taskId, {
      state: 'queued',
      error_code: null,
      error_message: null,
      interrupted: 0,
      finished_at: null
    });
    this.deps.store.addEvent(taskId, 'resumed', { stage: task.checkpoint.stage });
    this.schedule(taskId);
    return true;
  }

  stopAll(): void {
    this.stopped = true;
    for (const controller of this.jobs.values()) controller.abort();
    this.jobs.clear();
  }

  // -------------------------------------------------------------------------
  // Corrections (the one-pass identity fix)
  // -------------------------------------------------------------------------

  /**
   * Apply a batch of explicit corrections in one revision pass. Dismissing a
   * link revokes the attribution of its tracked posts; re-opening restores
   * them. Returns the links whose state still needs a decision.
   */
  correct(
    taskId: string,
    inputs: LinkCorrectionInput[],
    actor: string = 'user'
  ): { links: AccountLinkRecord[]; pendingReview: AccountLinkRecord[] } {
    const task = this.deps.store.getTask(taskId);
    if (!task) throw new CorrectionError('task_not_found', '未找到该任务。');
    if (inputs.length === 0) {
      throw new CorrectionError('empty_correction', '至少提交一条修订。');
    }
    if (inputs.length > LIMITS.discoveryCorrectionsMax) {
      throw new CorrectionError('too_many_corrections', '单次修订条数超出上限。');
    }
    for (const input of inputs) {
      const check = validateCorrection(input);
      if (!check.ok) throw new CorrectionError('invalid_correction', check.error ?? '修订无效。');
    }

    this.deps.store.transaction(() => {
      for (const input of inputs) {
        const link = this.deps.store.getLink(taskId, input.linkId);
        if (!link) throw new CorrectionError('link_not_found', '未找到要修订的账号链接。');
        const toState = nextLinkState(link.state, input.action);
        if (!toState) {
          throw new CorrectionError(
            'invalid_transition',
            `链接 ${link.platformId} 当前状态不允许该修订。`
          );
        }
        if (
          (input.action === 'confirm' || input.action === 'dismiss') &&
          !input.note &&
          input.basis.includes('manual_review') === false &&
          input.basis.length === 0
        ) {
          throw new CorrectionError('invalid_correction', '修订必须给出依据。');
        }
        this.deps.store.applyLinkRevision({
          taskId,
          linkId: link.id,
          action: input.action,
          fromState: link.state,
          toState,
          basis: input.basis,
          note: input.note,
          counterevidence: input.counterevidence,
          actor
        });
        if (toState === 'dismissed') {
          const revoked = this.deps.store.revokePostsForLink(taskId, link.id);
          this.deps.store.addEvent(taskId, 'attribution_revoked', {
            linkId: link.id,
            platformId: link.platformId,
            revokedPosts: revoked,
            reason: input.counterevidence ?? input.note ?? '人工排除'
          });
        }
        if (link.state === 'dismissed' && toState !== 'dismissed') {
          // Re-opening (or confirming) a dismissed link restores the posts that
          // were revoked through it; the cascade is symmetric and recorded.
          const restored = this.deps.store.restorePostsForLink(taskId, link.id);
          this.deps.store.addEvent(taskId, 'attribution_restored', {
            linkId: link.id,
            platformId: link.platformId,
            restoredPosts: restored
          });
        }
        this.deps.store.addEvent(taskId, 'correction_applied', {
          linkId: link.id,
          platformId: link.platformId,
          action: input.action,
          fromState: link.state,
          toState,
          basis: input.basis,
          actor
        });
      }
      // One batch correction = one revision bump.
      this.deps.store.updateTask(taskId, { revision: task.revision + 1 });
    });

    const links = this.deps.store.listLinks(taskId);
    const pendingReview = links.filter((link) => link.state === 'proposed');
    if (task.state === 'needs_input' && pendingReview.length === 0) {
      // Decisions complete: let the stage machine continue from its checkpoint.
      this.deps.store.updateTask(taskId, { state: 'queued', needs_input_prompt: null });
      this.schedule(taskId);
    } else if (task.state === 'needs_input') {
      this.deps.store.updateTask(taskId, {
        needs_input_prompt: this.needsInputPrompt(pendingReview)
      });
    }
    return { links, pendingReview };
  }

  private needsInputPrompt(pending: AccountLinkRecord[]): string {
    if (pending.length === 0) return '身份归属待确认。';
    const names = pending.map((link) => link.platformId).join('、');
    return `请确认这些候选账号是否属于研究对象（${names}）：同名/同用户名不等于同一人，确认或排除都需要依据。`;
  }

  // -------------------------------------------------------------------------
  // Stage machine
  // -------------------------------------------------------------------------

  private subjectOf(task: DiscoveryTaskRecord): DiscoverySubject {
    return { kind: task.subjectKind, value: task.subjectValue };
  }

  async executeTask(taskId: string, controller: AbortController): Promise<void> {
    const { store } = this.deps;
    try {
      let task = store.getTask(taskId);
      if (!task || isTerminalDiscoveryState(task.state) || task.cancelRequested) return;

      if (task.checkpoint.stage === 'discover') {
        store.setState(taskId, 'discovering');
        await this.runDiscover(taskId, controller.signal);
        task = store.getTask(taskId);
        if (!task || isTerminalDiscoveryState(task.state) || controller.signal.aborted) return;
      }

      if (task.checkpoint.stage === 'correct') {
        store.setState(taskId, 'correcting');
        const paused = await this.runCorrect(taskId, controller.signal);
        task = store.getTask(taskId);
        if (!task || paused || isTerminalDiscoveryState(task.state) || controller.signal.aborted) return;
      }

      if (task.checkpoint.stage === 'track' && task.mode === 'discover_and_track') {
        store.setState(taskId, 'tracking');
        await this.runTrack(taskId, controller.signal);
        task = store.getTask(taskId);
        if (!task || isTerminalDiscoveryState(task.state) || controller.signal.aborted) return;
      }

      this.finish(taskId, 'completed', 'done');
    } finally {
      if (this.jobs.get(taskId) === controller) this.jobs.delete(taskId);
    }
  }

  private checkpoint(taskId: string): DiscoveryCheckpoint | null {
    return this.deps.store.getTask(taskId)?.checkpoint ?? null;
  }

  private saveProgress(taskId: string, checkpoint: DiscoveryCheckpoint, usage?: DiscoveryUsage): boolean {
    const task = this.deps.store.getTask(taskId);
    if (!task) return false;
    return (
      this.deps.store.updateTaskIfActive(taskId, {
        checkpoint_json: JSON.stringify(checkpoint),
        usage_json: JSON.stringify(usage ?? task.usage)
      }) > 0
    );
  }

  private async runDiscover(taskId: string, signal: AbortSignal): Promise<void> {
    const { store, registry, transport } = this.deps;
    const task = store.getTask(taskId);
    if (!task) return;
    const subject = this.subjectOf(task);
    const rules = rulesForSubject(registry, subject.kind);
    const checkpoint = task.checkpoint;
    const planned = rules.map((rule) => probeKey(rule.platformId, methodOf(rule), subject));
    if (checkpoint.plannedProbeKeys.length === 0) {
      checkpoint.plannedProbeKeys = planned;
    }
    const remaining = remainingProbeKeys(checkpoint.plannedProbeKeys, checkpoint.completedProbeKeys);
    const remainingSet = new Set(remaining);
    const usage = task.usage;

    let sortOrder = store.listProbes(taskId).length;
    for (const rule of rules) {
      const key = probeKey(rule.platformId, methodOf(rule), subject);
      if (!remainingSet.has(key)) continue;
      if (signal.aborted) return;
      const stop = budgetStop(usage, task.limits);
      if (stop) {
        this.finish(taskId, 'partial', `budget:${stop}`);
        return;
      }
      const run = await probePlatform(rule, subject, {
        transport,
        signal,
        timeoutMs: this.deps.timeoutMs ?? LIMITS.providerTimeoutMs
      });
      usage.probes += 1;
      usage.requests += run.requests;
      usage.bytes += run.bytes;
      if (run.outcomeUnknown) usage.outcomeUnknown += 1;
      if (signal.aborted) return;
      store.upsertProbe(taskId, key, run.result, sortOrder);
      sortOrder += 1;
      checkpoint.completedProbeKeys.push(key);
      if (!this.saveProgress(taskId, checkpoint, usage)) return;
      store.addEvent(taskId, 'probe', {
        platformId: rule.platformId,
        status: run.result.status,
        verification: run.result.verification,
        limitations: run.result.limitations
      });
    }
    checkpoint.stage = stageAfter('discover');
    this.saveProgress(taskId, checkpoint, usage);
  }

  /**
   * The one-pass correction stage. Materializes account links from found
   * probes, checks deterministic cross-link evidence against the seed page,
   * auto-confirms only those, and pauses as `needs_input` for everything else.
   */
  private async runCorrect(taskId: string, signal: AbortSignal): Promise<boolean> {
    const { store, registry, transport } = this.deps;
    const task = store.getTask(taskId);
    if (!task) return true;
    const subject = this.subjectOf(task);

    const probes = store.listProbes(taskId).filter((probe) => probe.status === 'found');
    for (const probe of probes) {
      store.upsertLink(taskId, probe.platformId, probe.handle ?? subject.value, probe.profileUrl);
    }
    const links = store.listLinks(taskId);
    const proposed = links.filter((link) => link.state === 'proposed');
    if (proposed.length === 0) {
      this.advanceFromCorrect(taskId);
      return false;
    }

    // Deterministic cross-link evidence: an explicitly given seed page links
    // to a candidate profile URL. One fetch, checked for every candidate.
    const crossLinked = new Set<string>();
    // Only server-owned registry origins may be contacted. Arbitrary personal
    // websites require a hardened remote reader; until then keep manual review.
    const seedOrigin = task.seedUrl ? new URL(task.seedUrl).origin : null;
    const allowedSeed = seedOrigin && registry.rules.some(rule => new URL(rule.homepage).origin === seedOrigin);
    if (task.seedUrl && !allowedSeed) {
      store.addEvent(taskId, 'seed_cross_link_unavailable', { reason: 'seed_origin_not_allowed' });
    }
    if (task.seedUrl && allowedSeed && proposed.some((link) => link.profileUrl)) {
      const stop = budgetStop(task.usage, task.limits);
      if (stop) { this.finish(taskId, 'partial', `budget:${stop}`); return true; }
      const usage = { ...task.usage, requests: task.usage.requests + 1 };
      this.saveProgress(taskId, task.checkpoint, usage);
      try {
        const seed = await fetchBounded(task.seedUrl, seedOrigin, {
          transport,
          signal,
          timeoutMs: this.deps.timeoutMs ?? LIMITS.providerTimeoutMs
        }, 256 * 1024);
        if (signal.aborted) return true;
        usage.bytes += seed.bytes;
        if (!this.saveProgress(taskId, task.checkpoint, usage)) return true;
        const targets = seed.status === 200 && /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(seed.contentType ?? '')
          ? selfLinks(seed.text, task.seedUrl) : new Set<string>();
        for (const link of proposed) {
          if (!link.profileUrl) continue;
          const target = profileKey(link.profileUrl);
          if (target && targets.has(target)) crossLinked.add(link.id);
        }
        store.addEvent(taskId, 'seed_cross_link_checked', {
          seedUrl: task.seedUrl,
          matched: [...crossLinked],
          bytes: seed.bytes
        });
      } catch (error) {
        if (signal.aborted) return true;
        usage.outcomeUnknown += 1;
        if (!this.saveProgress(taskId, task.checkpoint, usage)) return true;
        store.addEvent(taskId, 'seed_cross_link_unavailable', {
          seedUrl: task.seedUrl,
          reason: error instanceof ProviderError ? error.code : 'fetch_failed'
        });
      }
    }

    if (signal.aborted) return true;
    const current = store.getTask(taskId);
    if (!current || isTerminalDiscoveryState(current.state) || current.cancelRequested) return true;

    const candidates: CorrectionCandidate[] = proposed.map((link) => ({
      linkId: link.id,
      platformId: link.platformId,
      handle: link.handle,
      profileUrl: link.profileUrl,
      state: link.state,
      crossLinked: crossLinked.has(link.id),
      exactHandleMatch:
        subject.kind === 'username' &&
        (link.handle ?? '').toLowerCase() === subject.value.toLowerCase()
    }));
    const plan = planOnePassCorrection(candidates);
    for (const proposal of plan.proposals) {
      const link = store.getLink(taskId, proposal.linkId);
      if (!link || link.state !== 'proposed') continue;
      store.applyLinkRevision({
        taskId,
        linkId: link.id,
        action: 'confirm',
        fromState: link.state,
        toState: 'confirmed',
        basis: proposal.basis,
        note: proposal.reason,
        counterevidence: null,
        actor: 'auto-correction'
      });
      store.addEvent(taskId, 'correction_applied', {
        linkId: link.id,
        platformId: link.platformId,
        action: 'confirm',
        basis: proposal.basis,
        actor: 'auto-correction'
      });
    }

    const pending = store.listLinks(taskId).filter((link) => link.state === 'proposed');
    if (pending.length > 0) {
      const reasons = candidates
        .filter((candidate) => plan.needsReview.includes(candidate.linkId))
        .map((candidate) => ({
          linkId: candidate.linkId,
          platformId: candidate.platformId,
          reason: reviewReasonFor(candidate)
        }));
      store.setState(taskId, 'needs_input', {
        needs_input_prompt: this.needsInputPrompt(pending),
        checkpoint_json: JSON.stringify({ ...task.checkpoint, stage: 'correct' })
      });
      store.addEvent(taskId, 'needs_input', { prompt: this.needsInputPrompt(pending), reasons });
      return true;
    }
    this.advanceFromCorrect(taskId);
    return false;
  }

  private advanceFromCorrect(taskId: string): void {
    const { store } = this.deps;
    const task = store.getTask(taskId);
    if (!task) return;
    const checkpoint = task.checkpoint;
    if (task.mode === 'discover_and_track') {
      checkpoint.stage = 'track';
      this.saveProgress(taskId, checkpoint);
    } else {
      checkpoint.stage = 'done';
      this.saveProgress(taskId, checkpoint);
      this.finish(taskId, 'completed', 'done');
    }
  }

  private async runTrack(taskId: string, signal: AbortSignal): Promise<void> {
    const { store, registry, transport } = this.deps;
    const task = store.getTask(taskId);
    if (!task) return;
    const usage = task.usage;
    const checkpoint = task.checkpoint;
    const confirmed = store.listLinks(taskId).filter((link) => link.state === 'confirmed');

    for (const link of confirmed) {
      if (signal.aborted) return;
      if (checkpoint.finishedLinkIds.includes(link.id)) continue;
      const rule = registry.rules.find((item) => item.platformId === link.platformId);
      const postsRule = rule?.posts;
      if (!rule || !postsRule || postsRule.kind === 'none') {
        checkpoint.finishedLinkIds.push(link.id);
        this.saveProgress(taskId, checkpoint);
        store.addEvent(taskId, 'posts_unsupported', { platformId: link.platformId });
        continue;
      }

      let cursor = checkpoint.trackCursors[link.id] ?? null;
      for (;;) {
        if (signal.aborted) return;
        const stop = budgetStop(usage, task.limits);
        if (stop) {
          this.finish(taskId, 'partial', `budget:${stop}`);
          return;
        }
        if (store.countPostsForLink(taskId, link.id) >= task.limits.maxPostsPerLink) {
          break;
        }
        const page = await fetchPostsPage(
          rule,
          link.id,
          link.handle ?? task.subjectValue,
          cursor,
          { transport, signal, timeoutMs: this.deps.timeoutMs ?? LIMITS.providerTimeoutMs }
        );
        usage.requests += page.requests;
        usage.bytes += page.bytes;
        usage.posts += page.posts.length;
        if (signal.aborted) return;
        let sort = store.countPostsForLink(taskId, link.id);
        for (const post of page.posts as TrackedPostDraft[]) {
          store.upsertPost(taskId, post, sort);
          sort += 1;
        }
        cursor = page.nextCursor;
        checkpoint.trackCursors[link.id] = cursor;
        this.saveProgress(taskId, checkpoint, usage);
        if (page.limits.length > 0) {
          store.addEvent(taskId, 'track_page', {
            linkId: link.id,
            platformId: link.platformId,
            posts: page.posts.length,
            warnings: page.warnings,
            limits: page.limits
          });
        }
        if (!cursor) break;
      }
      checkpoint.finishedLinkIds.push(link.id);
      this.saveProgress(taskId, checkpoint);
      store.addEvent(taskId, 'track_finished', {
        linkId: link.id,
        platformId: link.platformId,
        posts: store.countPostsForLink(taskId, link.id)
      });
    }
    checkpoint.stage = stageAfter('track');
    this.saveProgress(taskId, checkpoint);
  }

  private finish(taskId: string, state: 'completed' | 'partial', stopReason: string): void {
    const { store } = this.deps;
    store.setState(taskId, state, { stop_reason: stopReason });
    store.addEvent(taskId, state, { stopReason });
  }
}

export function fingerprintDiscoveryTask(input: {
  subjectKind: string;
  subjectValue: string;
  seedUrl: string | null;
  mode: string;
  authorization: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        subjectKind: input.subjectKind,
        subjectValue: input.subjectValue,
        seedUrl: input.seedUrl,
        mode: input.mode,
        authorization: input.authorization
      })
    )
    .digest('hex');
}

export { DEFAULT_DISCOVERY_LIMITS, emptyUsage };
