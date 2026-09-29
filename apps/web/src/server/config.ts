import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_PORT = 4392;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DeploymentMode = 'local' | 'hosted';

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host);
}

export interface AppConfig {
  /** `local` keeps the historical HTTP loopback defaults; `hosted` is explicit. */
  deployment: DeploymentMode;
  host: '127.0.0.1' | 'localhost' | '::1';
  port: number;
  /** Canonical same-origin used by Better Auth and Origin checks. */
  origin: string;
  /** Every accepted loopback origin for this port (exactly one in hosted mode). */
  allowedOrigins: string[];
  /** Secure cookies are derived from hosted HTTPS only. */
  secureCookies: boolean;
  /**
   * Normalized lowercase signup allowlist. `null` means local mode is
   * unrestricted; an empty array means hosted mode rejects every new signup.
   */
  signupEmails: string[] | null;
  authSecret: string;
  authSecretSource: 'env' | 'file';
  dataDir: string;
  dbPath: string;
  githubToken: string | null;
  exaApiKey: string | null;
  deepseekApiKey?: string | null;
  deepseekModel?: string;
  firecrawlApiKey?: string | null;
  tikhubApiKey?: string | null;
  nodeEnv: string;
  isTest: boolean;
}

/**
 * Package root (`apps/web`) is exactly two segments above both the source module
 * (`src/server/config.ts`) and the compiled module (`dist/server/config.js`), so
 * these defaults are identical whether the server runs from source or `dist`.
 * Keep them anchored here instead of resolving from a per-module depth.
 */
function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

export function defaultDataDir(): string {
  return path.join(packageRoot(), '.data');
}

export function defaultClientDir(): string {
  return path.join(packageRoot(), 'dist', 'client');
}

function readOrCreateSecret(dataDir: string): { secret: string; source: 'file' } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // Best effort; the directory may live on a filesystem without POSIX modes.
  }
  const secretPath = path.join(dataDir, 'auth-secret');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) {
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        // Best effort only.
      }
      return { secret: existing, source: 'file' };
    }
  }
  const generated = randomBytes(32).toString('base64url');
  writeFileSync(secretPath, generated, { mode: 0o600 });
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Best effort only.
  }
  return { secret: generated, source: 'file' };
}

function parseDeployment(raw: string | undefined): DeploymentMode {
  const value = (raw ?? 'local').trim().toLowerCase();
  if (value !== 'local' && value !== 'hosted') {
    throw new Error(`STRIPSEARCH_DEPLOYMENT must be "local" or "hosted", received "${raw}".`);
  }
  return value;
}

/** Normalize a comma-separated allowlist; exact addresses only, case-insensitive. */
function parseSignupEmails(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (entry.includes('*') || !EMAIL_RE.test(entry)) {
      throw new Error(
        `STRIPSEARCH_SIGNUP_EMAILS must list exact addresses (no wildcards or spaces), received "${entry}".`
      );
    }
  }
  return [...new Set(entries)];
}

function parseOrigin(origin: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`STRIPSEARCH_PUBLIC_ORIGIN is not a valid URL: "${origin}".`);
  }
  if (origin.includes('*') || parsed.hostname.includes('*')) {
    throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must not contain wildcards.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must not contain credentials.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must be an origin without path, query or fragment.');
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deployment = parseDeployment(env.STRIPSEARCH_DEPLOYMENT);
  const hosted = deployment === 'hosted';

  const rawHost = (env.STRIPSEARCH_HOST ?? '127.0.0.1').trim();
  if (!isLoopbackHostname(rawHost)) {
    throw new Error(`STRIPSEARCH_HOST must be a loopback address, received "${rawHost}".`);
  }
  const host = rawHost.toLowerCase() as AppConfig['host'];

  const rawPort = env.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${rawPort}".`);
  }

  const nodeEnv = env.NODE_ENV ?? 'development';
  const isTest = nodeEnv === 'test' || env.STRIPSEARCH_TEST === '1';

  const dataDir = path.resolve(env.STRIPSEARCH_DATA_DIR ?? defaultDataDir());

  let authSecret: string;
  let authSecretSource: AppConfig['authSecretSource'];
  const envSecret = env.BETTER_AUTH_SECRET?.trim();
  if (envSecret) {
    if (envSecret.length < 32) {
      throw new Error('BETTER_AUTH_SECRET must be at least 32 characters.');
    }
    authSecret = envSecret;
    authSecretSource = 'env';
  } else {
    const created = readOrCreateSecret(dataDir);
    authSecret = created.secret;
    authSecretSource = created.source;
  }

  // Local mode keeps the historical default and the loopback port check.
  // Hosted mode requires an explicit HTTPS origin (a reverse proxy may hold
  // 443 while the process keeps listening on the loopback PORT), so the
  // public port is intentionally not tied to PORT.
  const rawOrigin = hosted
    ? env.STRIPSEARCH_PUBLIC_ORIGIN?.trim()
    : (env.STRIPSEARCH_PUBLIC_ORIGIN ?? `http://localhost:${port}`).trim();
  if (!rawOrigin) {
    throw new Error(
      'STRIPSEARCH_PUBLIC_ORIGIN is required when STRIPSEARCH_DEPLOYMENT=hosted (explicit https origin).'
    );
  }
  const parsedOrigin = parseOrigin(rawOrigin);

  if (hosted) {
    if (parsedOrigin.protocol !== 'https:') {
      throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must use https in hosted mode.');
    }
  } else {
    if (parsedOrigin.protocol !== 'http:') {
      throw new Error('STRIPSEARCH_PUBLIC_ORIGIN must use http on loopback in local mode.');
    }
    if (!isLoopbackHostname(parsedOrigin.hostname)) {
      throw new Error(
        `STRIPSEARCH_PUBLIC_ORIGIN must stay on loopback in local mode, received "${rawOrigin}".`
      );
    }
    if (parsedOrigin.port !== String(port)) {
      throw new Error(
        `STRIPSEARCH_PUBLIC_ORIGIN port must match PORT (${port}), received "${rawOrigin}".`
      );
    }
  }

  const origin = parsedOrigin.origin;
  const allowedOrigins = hosted
    ? [origin]
    : [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];

  return {
    deployment,
    host,
    port,
    origin,
    allowedOrigins,
    secureCookies: hosted,
    signupEmails: hosted ? parseSignupEmails(env.STRIPSEARCH_SIGNUP_EMAILS) : null,
    authSecret,
    authSecretSource,
    dataDir,
    dbPath: path.join(dataDir, 'stripsearch.sqlite'),
    githubToken: env.GITHUB_TOKEN?.trim() || null,
    exaApiKey: env.EXA_API_KEY?.trim() || null,
    deepseekApiKey: env.DEEPSEEK_API_KEY?.trim() || null,
    deepseekModel: env.STRIPSEARCH_DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    firecrawlApiKey: env.FIRECRAWL_API_KEY?.trim() || null,
    tikhubApiKey: env.TIKHUB_API_KEY?.trim() || null,
    nodeEnv,
    isTest
  };
}
