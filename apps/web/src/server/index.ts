import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTransport } from './adapters/types.js';
import type { HttpTransport, ProviderFactory } from './adapters/types.js';
import { createExaProvider } from './adapters/exa.js';
import { githubProvider } from './adapters/github.js';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { defaultClientDir, loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { migrateDatabase } from './db/migrate.js';
import { Runner } from './services/runner.js';
import { DiscoveryRunner } from './services/discovery-runner.js';
import { ReviewStore } from './review-store.js';
import { DiscoveryStore } from './discovery-store.js';
import { BUILTIN_PLATFORM_REGISTRY } from './platforms/registry.js';
import type { PlatformRegistry } from '../shared/platform-discovery.js';
import { Store } from './store.js';
import type { DB } from './db/index.js';

export interface BootstrapOverrides {
  providerFactory?: ProviderFactory;
  transport?: HttpTransport;
  clientDir?: string;
  discoveryRegistry?: PlatformRegistry;
}

export interface BootstrappedApp {
  config: AppConfig;
  db: DB;
  store: Store;
  reviewStore: ReviewStore;
  discoveryStore: DiscoveryStore;
  discoveryRunner: DiscoveryRunner;
  runner: Runner;
  app: ReturnType<typeof createApp>;
  interrupted: number;
  interruptedDiscovery: number;
}

export async function bootstrap(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BootstrapOverrides = {}
): Promise<BootstrappedApp> {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  const auth = createAuth(db, config);
  await migrateDatabase(db, auth);
  const store = new Store(db);
  const reviewStore = new ReviewStore(db);
  const discoveryStore = new DiscoveryStore(db);
  const interrupted = store.recoverInterruptedRuns();
  const interruptedDiscovery = discoveryStore.recoverInterruptedTasks();
  const providerFactory: ProviderFactory =
    overrides.providerFactory ??
    ((name) => (name === 'exa' ? createExaProvider(config.exaApiKey) : githubProvider));
  const transport = overrides.transport ?? defaultTransport;
  const runner = new Runner({
    store,
    config,
    providerFactory,
    transport
  });
  const discoveryRegistry = overrides.discoveryRegistry ?? BUILTIN_PLATFORM_REGISTRY;
  const discoveryRunner = new DiscoveryRunner({
    store: discoveryStore,
    transport,
    registry: discoveryRegistry
  });
  const clientDir = overrides.clientDir ?? defaultClientDir();
  const app = createApp({
    config,
    store,
    reviewStore,
    discoveryStore,
    discoveryRunner,
    discoveryRegistry,
    auth,
    runner,
    clientDir
  });
  return { config, db, store, reviewStore, discoveryStore, discoveryRunner, runner, app, interrupted, interruptedDiscovery };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entry);
}

async function main(): Promise<void> {
  const { config, app, interrupted, runner, discoveryRunner, interruptedDiscovery } = await bootstrap();
  let failed = false;
  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      failed = true;
      console.error('[stripsearch] failed to listen:', error.message);
      process.exit(1);
    }
    console.log(`[stripsearch] http://${config.host}:${config.port} (origin ${config.origin})`);
    if (interrupted > 0) {
      console.log(`[stripsearch] marked ${interrupted} interrupted run(s) as partial`);
    }
    if (interruptedDiscovery > 0) {
      console.log(
        `[stripsearch] paused ${interruptedDiscovery} discovery task(s) at their checkpoints`
      );
    }
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (failed) return;
    failed = true;
    console.error('[stripsearch] failed to listen:', error.message);
    process.exit(1);
  });
  const shutdown = (): void => {
    runner.stopAll();
    discoveryRunner.stopAll();
    server.close();
    // Drop lingering SSE / keep-alive sockets so the process can exit promptly.
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error('[stripsearch] failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
