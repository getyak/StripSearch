import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap } from '../server/index.js';
import type { BootstrappedApp, BootstrapOverrides } from '../server/index.js';
import type { Store } from '../server/store.js';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  capture(response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const value of setCookies) {
      const pair = value.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const cookieValue = pair.slice(eq + 1).trim();
      if (cookieValue === '' || cookieValue === 'deleted') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }
}

export interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: string | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  origin?: string | null;
  jar?: CookieJar | null;
  redirect?: 'follow' | 'manual' | 'error';
}

export class TestClient {
  constructor(
    readonly baseUrl: string,
    readonly origin: string,
    readonly jar: CookieJar = new CookieJar()
  ) {}

  async request(pathname: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    const method = options.method ?? (options.json !== undefined || options.body !== undefined ? 'POST' : 'GET');
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = options.origin === undefined ? this.origin : options.origin;
      if (origin) headers.origin = origin;
    }
    if (options.json !== undefined) headers['content-type'] = 'application/json';
    const jar = options.jar === undefined ? this.jar : options.jar;
    if (jar && jar.header()) headers.cookie = jar.header();
    const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
    const isStream = body !== undefined && typeof body !== 'string';
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body as BodyInit | undefined,
      redirect: options.redirect ?? 'manual',
      ...(isStream ? { duplex: 'half' } : {})
    } as RequestInit);
    if (jar) jar.capture(response);
    return response;
  }

  async json<T = unknown>(pathname: string, options: RequestOptions = {}): Promise<{ status: number; body: T }> {
    const response = await this.request(pathname, options);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T };
  }

  async signUp(email: string, password = 'password-1234', name = '测试用户'): Promise<Response> {
    return this.request('/api/auth/sign-up/email', {
      method: 'POST',
      json: { name, email, password }
    });
  }

  async signIn(email: string, password = 'password-1234'): Promise<Response> {
    return this.request('/api/auth/sign-in/email', {
      method: 'POST',
      json: { email, password }
    });
  }

  async signOut(): Promise<Response> {
    return this.request('/api/auth/sign-out', { method: 'POST', json: {} });
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 15
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface TestServer {
  client: TestClient;
  baseUrl: string;
  origin: string;
  store: Store;
  boot: BootstrappedApp;
  close(): Promise<void>;
}

export interface TestServerOptions {
  /** Reuse an existing data dir, e.g. to restart a server with the same accounts. */
  dataDir?: string;
  /** Keep the data dir after close so a later server can reuse it. */
  preserveData?: boolean;
}

export async function startTestServer(
  overrides: BootstrapOverrides = {},
  envOverrides: NodeJS.ProcessEnv = {},
  options: TestServerOptions = {}
): Promise<TestServer> {
  const dataDir = options.dataDir ?? mkdtempSync(path.join(tmpdir(), 'stripsearch-test-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  delete env.EXA_API_KEY;
  delete env.GITHUB_TOKEN;
  delete env.STRIPSEARCH_PUBLIC_ORIGIN;
  Object.assign(env, envOverrides);
  env.PORT = String(port);
  env.STRIPSEARCH_DATA_DIR = dataDir;
  if (!env.STRIPSEARCH_PUBLIC_ORIGIN) env.STRIPSEARCH_PUBLIC_ORIGIN = `http://localhost:${port}`;
  const boot = await bootstrap(env, overrides);
  const server = boot.app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  const origin = boot.config.origin;
  const client = new TestClient(baseUrl, origin);
  return {
    client,
    baseUrl,
    origin,
    store: boot.store,
    boot,
    async close() {
      boot.runner.stopAll();
      boot.discoveryRunner.stopAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!options.preserveData) rmSync(boot.config.dataDir, { recursive: true, force: true });
    }
  };
}
