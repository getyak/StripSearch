/**
 * GET-99 `/api/fetch` routes: the authenticated, same-origin Web Fetch API
 * for the real GitHub public slice.
 *
 * Contract (shared/research-fetch-github.ts): the start request must echo the
 * explicit user confirmation of the exact target GitHub account or
 * repository, the frozen question and the supported access scope — required
 * BEFORE any HTTP request. The session owner comes only from middleware and
 * every response is owner-scoped (a foreign run is a 404, never probed).
 * Request shape, idempotency and version-conflict behaviour mirror the
 * existing routes: `Idempotency-Key` + normalized-request fingerprint (a
 * reused key with a different request is a conflict), the same per-user start
 * rate gate, and `expectedRevision` version conflict on controls.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type {
  FetchGithubResumeRequest,
  FetchGithubRunView,
  FetchGithubStartRequest
} from '../../shared/research-fetch-github.js';
import { HttpError } from '../http/errors.js';
import { requireUser } from '../http/middleware.js';
import type { Runner } from '../services/runner.js';
import {
  FetchGithubRequestError,
  FetchGithubRunner,
  type FetchGithubRunnerDeps
} from '../research/fetch-github-runner.js';

export interface FetchRouteDeps {
  fetchRunner: FetchGithubRunner;
  /** Legacy start gate: rate/start bounds identical to the existing routes. */
  runner: Runner;
}

function readBody(req: Request): Record<string, unknown> {
  const body = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function readIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key');
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 128);
}

function fingerprintOf(input: { targetUrl: string; question: string; accessScope: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ targetUrl: input.targetUrl, question: input.question, accessScope: input.accessScope }))
    .digest('hex');
}

function mapStartBody(body: Record<string, unknown>): FetchGithubStartRequest {
  return {
    targetUrl: typeof body.targetUrl === 'string' ? body.targetUrl : '',
    question: typeof body.question === 'string' ? body.question : '',
    accessScope:
      body.accessScope === 'github_public_account' || body.accessScope === 'github_public_repository'
        ? body.accessScope
        : ('' as FetchGithubStartRequest['accessScope']),
    confirmation: body.confirmation === true,
    confirmedTarget: typeof body.confirmedTarget === 'string' ? body.confirmedTarget : '',
    confirmedQuestion: typeof body.confirmedQuestion === 'string' ? body.confirmedQuestion : '',
    confirmedAccessScope:
      body.confirmedAccessScope === 'github_public_account' || body.confirmedAccessScope === 'github_public_repository'
        ? body.confirmedAccessScope
        : ('' as FetchGithubStartRequest['confirmedAccessScope'])
  };
}

function toHttp(error: unknown): HttpError {
  // Preserve real HttpErrors (404/409/429/...): a missing/foreign run is a
  // 404, an idempotency or version conflict a 409 — never a blanket 500.
  if (error instanceof HttpError) return error;
  if (error instanceof FetchGithubRequestError) {
    return new HttpError(error.status, error.code, error.message);
  }
  if (error instanceof Error) {
    return new HttpError(500, 'internal_error', 'Web Fetch 服务内部错误。');
  }
  return new HttpError(500, 'internal_error', 'Web Fetch 服务内部错误。');
}

export function registerFetchRoutes(router: Router, deps: FetchRouteDeps): void {
  const { fetchRunner, runner } = deps;

  const wrap = (handler: (req: Request, res: Response) => void) => (req: Request, res: Response): void => {
    try {
      handler(req, res);
    } catch (error) {
      throw toHttp(error);
    }
  };

  router.post(
    '/fetch/start',
    wrap((req, res) => {
      const user = requireUser(res);
      const body = readBody(req);
      const start = mapStartBody(body);
      const idempotencyKey = readIdempotencyKey(req);
      const fingerprint = fingerprintOf({
        targetUrl: start.targetUrl,
        question: start.question,
        accessScope: start.accessScope
      });
      if (idempotencyKey) {
        // Same key + same normalized request returns the existing run; the
        // same key with a different request is a conflict (409).
        const existing = fetchRunner.findByIdempotency(user.id, idempotencyKey);
        if (existing && existing.bodyFingerprint !== fingerprint) {
          throw new HttpError(409, 'idempotency_conflict', '幂等键与请求内容不一致，请使用新的键。');
        }
        if (existing) {
          const view = fetchRunner.view(existing.runId, user.id);
          if (view) {
            res.json({ run: view, idempotent: true });
            return;
          }
        }
      }
      // Rate/start bounds identical to the existing routes.
      const gate = runner.checkStartAllowed(user.id);
      if (!gate.allowed) {
        throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请求过于频繁。');
      }
      let run: FetchGithubRunView;
      try {
        // The idempotency record commits atomically with run creation (before
        // the worker is woken).
        run = fetchRunner.start({
          ...start,
          ownerId: user.id,
          idempotencyKey: idempotencyKey ?? null,
          bodyFingerprint: idempotencyKey ? fingerprint : null
        });
      } catch (error) {
        throw toHttp(error);
      }
      runner.recordStart(user.id);
      res.status(201).json({ run, idempotent: false });
    })
  );

  router.get(
    '/fetch/runs',
    wrap((_req, res) => {
      const user = requireUser(res);
      res.json({ runs: fetchRunner.list(user.id) });
    })
  );

  router.get(
    '/fetch/runs/:id',
    wrap((req, res) => {
      const user = requireUser(res);
      const run = fetchRunner.view(String(req.params.id), user.id);
      if (!run) throw new HttpError(404, 'run_not_found', '未找到该 Web Fetch 运行。');
      res.json({ run });
    })
  );

  router.post(
    '/fetch/runs/:id/pause',
    wrap((req, res) => {
      const user = requireUser(res);
      const body = readBody(req);
      try {
        const run = fetchRunner.pause(
          String(req.params.id),
          user.id,
          Number.isInteger(body.expectedRevision) ? (body.expectedRevision as number) : undefined
        );
        res.json({ run });
      } catch (error) {
        throw toHttp(error);
      }
    })
  );

  router.post(
    '/fetch/runs/:id/resume',
    wrap((req, res) => {
      const user = requireUser(res);
      const body = readBody(req);
      const input: FetchGithubResumeRequest = {
        reconcileUnknown:
          body.reconcileUnknown === 'retry' || body.reconcileUnknown === 'skip' ? body.reconcileUnknown : undefined,
        expectedRevision: Number.isInteger(body.expectedRevision) ? (body.expectedRevision as number) : undefined
      };
      try {
        const run = fetchRunner.resume(String(req.params.id), user.id, input);
        res.json({ run });
      } catch (error) {
        throw toHttp(error);
      }
    })
  );

  router.post(
    '/fetch/runs/:id/stop',
    wrap((req, res) => {
      const user = requireUser(res);
      const body = readBody(req);
      try {
        const run = fetchRunner.stop(
          String(req.params.id),
          user.id,
          Number.isInteger(body.expectedRevision) ? (body.expectedRevision as number) : undefined
        );
        res.json({ run });
      } catch (error) {
        throw toHttp(error);
      }
    })
  );
}

export type { FetchGithubRunnerDeps };
