/**
 * First-step HTTP surface: authoritative discovery projection, the one atomic
 * account selection and the explicit expand/补线索 entry.
 *
 * All routes are owner-checked; the selection binds run, scope and discovery
 * versions plus the person cluster in one transaction and accepts an
 * Idempotency-Key for double-click safety. The legacy single-candidate resume
 * stays readable for historical jobs and can never bypass the batch selection
 * of a first-step run.
 */

import type { Request, Response, Router } from 'express';
import { LIMITS } from '../../shared/limits.js';
import { HttpError } from '../http/errors.js';
import { readBody, readIdempotencyKey } from '../http/request-input.js';
import { requireUser } from '../http/middleware.js';
import type { Auth } from '../auth.js';
import type { Runner } from '../services/runner.js';
import type { Store } from '../store.js';
import { FirstStepSelectionError, type FirstStepStore } from '../research/first-step-store.js';
import { PersonConfirmationError, type PersonConfirmationStore } from '../research/person-confirmation.js';

export interface FirstStepRouteDeps {
  store: Store;
  firstStep: FirstStepStore;
  /** GET-213 person-confirmation gates; null keeps the legacy routes only. */
  persons: PersonConfirmationStore | null;
  runner: Runner;
  auth: Auth;
  researchConfigured: boolean;
}

function errorStatus(code: FirstStepSelectionError['code']): number {
  switch (code) {
    case 'run_not_found':
      return 404;
    case 'stale_run_revision':
    case 'stale_scope_version':
    case 'stale_discovery_revision':
    case 'idempotency_conflict':
    case 'run_not_waiting':
    case 'not_first_step':
    case 'person_confirmation_required':
    case 'expand_not_allowed':
    case 'scope_changed':
      return 409;
    case 'empty_selection':
      return 422;
    default:
      return 400;
  }
}

function personErrorStatus(code: PersonConfirmationError['code']): number {
  switch (code) {
    case 'run_not_found':
      return 404;
    case 'not_staged':
    case 'run_not_waiting':
    case 'stale_run_revision':
    case 'stale_scope_version':
    case 'stale_discovery_revision':
    case 'idempotency_conflict':
    case 'confirmation_conflict':
    case 'revoked_candidate':
      return 409;
    case 'unknown_candidate':
      return 422;
    default:
      return 400;
  }
}

function mapSelectionError(error: unknown): never {
  if (error instanceof FirstStepSelectionError) {
    throw new HttpError(errorStatus(error.code), error.code, error.detail);
  }
  if (error instanceof PersonConfirmationError) {
    throw new HttpError(personErrorStatus(error.code), error.code, error.detail);
  }
  throw error;
}

export function registerFirstStepRoutes(router: Router, deps: FirstStepRouteDeps): void {
  /** Authoritative projection: immutable revision + live user facets. */
  router.get('/runs/:id/first-step/discovery', (req: Request, res: Response) => {
    const user = requireUser(res);
    const result = deps.firstStep.getFirstStepView(user.id, String(req.params.id));
    if (!result) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    if (result.mode === 'legacy') {
      // Historical jobs keep their own candidates and receipts verbatim.
      res.json({ mode: 'legacy', candidates: result.candidates, prompt: result.prompt, canExpand: true });
      return;
    }
    res.json({
      mode: 'first_step',
      view: result.view,
      runRevision: deps.store.getRun(String(req.params.id))?.revision ?? 0
    });
  });

  /**
   * GET-213 person confirmation: owner-checked, same-origin POST binding run,
   * scope, input and discovery revisions plus one immutable candidate id from
   * the persisted authoritative overview. Idempotent: a double submit or a
   * restart replays the receipt and never duplicates downstream requests.
   * The client can never submit arbitrary sources or bypass this gate.
   */
  router.post('/runs/:id/first-step/person-confirmation', (req: Request, res: Response) => {
    const user = requireUser(res);
    if (!deps.persons) throw new HttpError(409, 'provider_unavailable', '人物确认服务未启用。');
    const runId = String(req.params.id);
    // No active-job race: the store refuses a FRESH confirmation unless the
    // run truly awaits it (state `needs_input`), while a repeated idempotency
    // key or an identical double submit replays the receipt WITHOUT any new
    // downstream request — even while queued work is still running.
    const body = readBody(req);
    let result;
    try {
      result = deps.persons.applyConfirmation(user.id, runId, body, readIdempotencyKey(req));
    } catch (error) {
      mapSelectionError(error);
    }
    if (!result.idempotent) {
      // Confirmed person: enqueue the account-discovery stage (new receipts
      // only; the overview receipts replay with their original timestamps).
      deps.runner.enqueue(runId);
    }
    const view = deps.firstStep.getFirstStepView(user.id, runId);
    res.json({
      confirmation: result,
      view: view && view.mode === 'first_step' ? view.view : null
    });
  });

  /**
   * One atomic selection. Every current account must appear exactly once; the
   * person cluster, run revision, scope version and discovery revision are
   * bound together. A repeated Idempotency-Key with the same payload replays
   * the receipt; a different payload conflicts.
   */
  router.post('/runs/:id/first-step/selection', (req: Request, res: Response) => {
    const user = requireUser(res);
    const runId = String(req.params.id);
    const body = readBody(req);
    let result;
    try {
      result = deps.firstStep.applyFirstStepSelection(user.id, runId, body, readIdempotencyKey(req));
    } catch (error) {
      mapSelectionError(error);
    }
    if (!result.idempotent) {
      // The frozen scope is submitted: hand the run to the scope-limited Fetch.
      deps.runner.enqueue(runId);
    }
    const view = deps.firstStep.getFirstStepView(user.id, runId);
    res.json({ selection: result, view: view && view.mode === 'first_step' ? view.view : null });
  });

  /**
   * Expand / 补线索: an explicit NEW discovery attempt with a manual public URL
   * or distinguishing clue (or the original input for a legacy continue). The
   * hint never upgrades identity by itself and never widens a submitted scope:
   * new candidates stay `unanswered` and require a new explicit submission.
   */
  router.post('/runs/:id/first-step/expand', (req: Request, res: Response) => {
    const user = requireUser(res);
    const runId = String(req.params.id);
    const run = deps.store.getRunForOwner(runId, user.id);
    if (!run) throw new HttpError(404, 'run_not_found', '未找到该研究。');
    if (!deps.researchConfigured) throw new HttpError(409, 'provider_unavailable', '人物研究需要服务端配置 DeepSeek 与 Exa。');
    // No active-job race: an in-flight job is never cancelled or reset here.
    if (deps.runner.isRunning(runId)) {
      throw new HttpError(409, 'run_active', '该研究仍在进行，不能原地扩展发现。');
    }
    const body = readBody(req);
    const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 500) : '';
    const url = typeof body.url === 'string' ? body.url.trim().slice(0, 2048) : '';
    if (url && !/^https:\/\//i.test(url)) {
      throw new HttpError(400, 'invalid_hint', '补线索链接必须是公开 HTTPS 地址。');
    }
    const gate = deps.runner.checkStartAllowed(user.id);
    if (!gate.allowed) throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请求过于频繁。');
    let result;
    try {
      result = deps.firstStep.applyFirstStepExpand(user.id, runId, hint || url || null, readIdempotencyKey(req));
    } catch (error) {
      mapSelectionError(error);
    }
    if (!result.idempotent) {
      deps.runner.recordStart(user.id);
      deps.runner.enqueue(runId);
    }
    res.status(202).json({ queued: true, caseId: result.caseId, discoveryRevision: result.discoveryRevision, idempotent: result.idempotent });
  });

  void LIMITS;
}
