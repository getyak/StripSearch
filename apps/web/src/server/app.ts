import express from 'express';
import type { Express } from 'express';
import { Router } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from '../shared/limits.js';
import type { Auth } from './auth.js';
import type { AppConfig } from './config.js';
import {
  createAuthBodyLimitMiddleware,
  createAuthMiddleware,
  createAuthNodeHandler,
  createAuthOriginMiddleware,
  createErrorHandler,
  createNoStoreMiddleware,
  createOriginMiddleware
} from './http/middleware.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import type { Runner } from './services/runner.js';
import type { DiscoveryRunner } from './services/discovery-runner.js';
import type { PlatformRegistry } from '../shared/platform-discovery.js';
import type { ReviewStore } from './review-store.js';
import type { DiscoveryStore } from './discovery-store.js';
import type { Store } from './store.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  reviewStore: ReviewStore;
  discoveryStore: DiscoveryStore;
  discoveryRunner: DiscoveryRunner;
  discoveryRegistry: PlatformRegistry;
  auth: Auth;
  runner: Runner;
  clientDir: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Hosted deployments sit behind a loopback reverse proxy that overwrites
  // X-Forwarded-For / X-Real-IP; only those loopback hops are trusted. Local
  // mode keeps the historical no-proxy behavior.
  app.set('trust proxy', deps.config.deployment === 'hosted' ? 'loopback' : false);

  // Better Auth must be mounted before any body parser: it reads the raw stream
  // itself. The bounded adapter caps the actual bytes, not just Content-Length.
  app.use('/api', createNoStoreMiddleware());
  app.all(
    '/api/auth/*splat',
    createAuthOriginMiddleware(deps.config),
    createAuthBodyLimitMiddleware(LIMITS.authBodyBytes),
    createAuthNodeHandler(deps.auth, deps.config)
  );

  const publicRouter = Router();
  publicRouter.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: 'stripsearch-web-alpha',
      version: '0.1.0',
      capabilities: {
        github: true,
        exa: Boolean(deps.config.exaApiKey)
      },
      limits: {
        questionMax: LIMITS.questionMax,
        globalConcurrentJobs: LIMITS.globalConcurrentJobs,
        userConcurrentJobs: LIMITS.userConcurrentJobs
      }
    });
  });
  app.use('/api', publicRouter);

  // Discovery imports carry whole external tool reports, so this subtree gets
  // its own bounded JSON parser before the smaller global one. Body-parser
  // skips an already-parsed body, so the global limit stays in force elsewhere.
  app.use('/api/discovery', express.json({ limit: LIMITS.discoveryImportBytes }));
  app.use(express.json({ limit: LIMITS.jsonBodyBytes }));

  const apiRouter = Router();
  apiRouter.use(createOriginMiddleware(deps.config));
  apiRouter.use(createAuthMiddleware(deps.auth));
  registerRunRoutes(apiRouter, {
    store: deps.store,
    runner: deps.runner,
    auth: deps.auth,
    exaConfigured: Boolean(deps.config.exaApiKey)
  });
  registerReviewRoutes(apiRouter, { reviewStore: deps.reviewStore });
  registerDiscoveryRoutes(apiRouter, {
    store: deps.discoveryStore,
    runner: deps.discoveryRunner,
    registry: deps.discoveryRegistry
  });
  app.use('/api', apiRouter);

  const clientIndex = path.join(deps.clientDir, 'index.html');
  if (existsSync(clientIndex)) {
    app.use(express.static(deps.clientDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res, next) => {
      res.sendFile('index.html', { root: deps.clientDir, cacheControl: false }, (error) => {
        if (error) next(error);
      });
    });
  } else {
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.status(503).type('text/plain').send('客户端尚未构建，请先运行 npm run build。');
    });
  }

  app.use(createErrorHandler(deps.config));
  return app;
}
