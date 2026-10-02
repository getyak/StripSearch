import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultClientDir, defaultDataDir, loadConfig } from '../server/config.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'stripsearch-config-'));
}

test('config rejects non-loopback hosts and origins', () => {
  assert.throws(
    () => loadConfig({ STRIPSEARCH_HOST: '0.0.0.0', STRIPSEARCH_DATA_DIR: tempDir() }),
    /loopback/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        STRIPSEARCH_PUBLIC_ORIGIN: 'https://example.com'
      }),
    /http on loopback|loopback/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'http://localhost:4392/path'
      }),
    /without path/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'http://user:pass@localhost:4392'
      }),
    /credentials/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'http://localhost:4393'
      }),
    /port must match/
  );
  assert.throws(
    () =>
      loadConfig({
        STRIPSEARCH_DATA_DIR: tempDir(),
        PORT: '4392',
        STRIPSEARCH_PUBLIC_ORIGIN: 'https://localhost:4392'
      }),
    /http on loopback/
  );
  assert.throws(
    () => loadConfig({ STRIPSEARCH_DATA_DIR: tempDir(), PORT: '70000' }),
    /PORT/
  );
});

test('a local secret is generated once with mode 0600 and never defaults', () => {
  const dir = tempDir();
  try {
    const first = loadConfig({ STRIPSEARCH_DATA_DIR: dir, PORT: '4390' });
    assert.equal(first.authSecretSource, 'file');
    assert.ok(first.authSecret.length >= 32);
    const secretPath = path.join(dir, 'auth-secret');
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);

    const second = loadConfig({ STRIPSEARCH_DATA_DIR: dir, PORT: '4390' });
    assert.equal(second.authSecret, first.authSecret);
    assert.notEqual(first.authSecret, 'better-auth-secret-123456789');

    const withEnv = loadConfig({
      STRIPSEARCH_DATA_DIR: dir,
      BETTER_AUTH_SECRET: 'x'.repeat(40)
    });
    assert.equal(withEnv.authSecretSource, 'env');
    assert.equal(withEnv.authSecret, 'x'.repeat(40));

    assert.throws(
      () => loadConfig({ STRIPSEARCH_DATA_DIR: dir, BETTER_AUTH_SECRET: 'too-short' }),
      /at least 32/
    );

    assert.deepEqual(first.allowedOrigins, [
      'http://localhost:4390',
      'http://127.0.0.1:4390',
      'http://[::1]:4390'
    ]);
    assert.ok(first.dbPath.startsWith(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local mode is the default and keeps HTTP loopback behavior', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ STRIPSEARCH_DATA_DIR: dir, PORT: '4392' });
    assert.equal(config.deployment, 'local');
    assert.equal(config.secureCookies, false);
    assert.equal(config.signupEmails, null);
    assert.equal(config.origin, 'http://localhost:4392');
    assert.deepEqual(config.allowedOrigins, [
      'http://localhost:4392',
      'http://127.0.0.1:4392',
      'http://[::1]:4392'
    ]);

    // An unrecognized deployment value is a configuration error, not a silent fallback.
    assert.throws(
      () => loadConfig({ STRIPSEARCH_DATA_DIR: dir, STRIPSEARCH_DEPLOYMENT: 'public' }),
      /STRIPSEARCH_DEPLOYMENT/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted mode requires an explicit HTTPS origin and derives secure cookies', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({
      STRIPSEARCH_DEPLOYMENT: 'hosted',
      STRIPSEARCH_DATA_DIR: dir,
      STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test',
      STRIPSEARCH_SIGNUP_MODE: 'allowlist',
      STRIPSEARCH_SIGNUP_EMAILS: ' Alice@Example.Test , bob@example.test ,alice@example.test '
    });
    assert.equal(config.deployment, 'hosted');
    assert.equal(config.secureCookies, true);
    assert.equal(config.origin, 'https://search.example.test');
    assert.deepEqual(config.allowedOrigins, ['https://search.example.test']);
    assert.deepEqual(config.signupEmails, ['alice@example.test', 'bob@example.test']);
    // The bind stays loopback even when the public origin is HTTPS.
    assert.equal(config.host, '127.0.0.1');

    // A reverse proxy may hold 443 while the process keeps the loopback PORT,
    // so the public origin port is not tied to PORT in hosted mode.
    const withPort = loadConfig({
      STRIPSEARCH_DEPLOYMENT: 'hosted',
      STRIPSEARCH_DATA_DIR: dir,
      PORT: '4392',
      STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test:8443'
    });
    assert.equal(withPort.origin, 'https://search.example.test:8443');

    // Hosted signup is open without an explicit restriction.
    assert.equal(withPort.signupEmails, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted mode rejects missing, insecure or malformed origins', () => {
  const base = { STRIPSEARCH_DEPLOYMENT: 'hosted', STRIPSEARCH_DATA_DIR: tempDir() };
  const dir = base.STRIPSEARCH_DATA_DIR;
  try {
    assert.throws(
      () => loadConfig({ STRIPSEARCH_DEPLOYMENT: 'hosted', STRIPSEARCH_DATA_DIR: dir }),
      /STRIPSEARCH_PUBLIC_ORIGIN is required/
    );
    assert.throws(
      () => loadConfig({ ...base, STRIPSEARCH_PUBLIC_ORIGIN: 'http://search.example.test' }),
      /https in hosted mode/
    );
    assert.throws(
      () => loadConfig({ ...base, STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test/app' }),
      /without path/
    );
    assert.throws(
      () => loadConfig({ ...base, STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test/?q=1' }),
      /without path/
    );
    assert.throws(
      () => loadConfig({ ...base, STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test/#x' }),
      /without path/
    );
    assert.throws(
      () => loadConfig({ ...base, STRIPSEARCH_PUBLIC_ORIGIN: 'https://user:pass@search.example.test' }),
      /credentials/
    );
    assert.throws(
      () => loadConfig({ ...base, STRIPSEARCH_PUBLIC_ORIGIN: 'https://*.example.test' }),
      /wildcards/
    );
    assert.throws(
      () =>
        loadConfig({
          ...base,
          STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test',
          STRIPSEARCH_SIGNUP_MODE: 'allowlist',
          STRIPSEARCH_SIGNUP_EMAILS: 'alice@example.test,*@example.test'
        }),
      /exact addresses/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted signup defaults open, ignores legacy lists and requires explicit allowlist restrictions', () => {
  const dir = tempDir();
  const env = {
    STRIPSEARCH_DEPLOYMENT: 'hosted',
    STRIPSEARCH_DATA_DIR: dir,
    STRIPSEARCH_PUBLIC_ORIGIN: 'https://search.example.test',
    STRIPSEARCH_SIGNUP_EMAILS: 'alice@example.test'
  };
  try {
    for (const emails of [undefined, '', 'alice@example.test', '*@example.test']) {
      assert.equal(loadConfig({ ...env, STRIPSEARCH_SIGNUP_EMAILS: emails }).signupEmails, null);
    }
    assert.equal(loadConfig({ ...env, STRIPSEARCH_SIGNUP_MODE: ' OPEN ' }).signupEmails, null);
    assert.deepEqual(loadConfig({ ...env, STRIPSEARCH_SIGNUP_MODE: 'allowlist' }).signupEmails, ['alice@example.test']);
    assert.deepEqual(loadConfig({ ...env, STRIPSEARCH_SIGNUP_MODE: 'allowlist', STRIPSEARCH_SIGNUP_EMAILS: '' }).signupEmails, []);
    for (const mode of ['opne', '', 'true', '*']) {
      assert.throws(() => loadConfig({ ...env, STRIPSEARCH_SIGNUP_MODE: mode }), /STRIPSEARCH_SIGNUP_MODE/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default data and client dirs stay anchored at apps/web in source and compiled output', async () => {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(defaultDataDir(), path.join(appRoot, '.data'));
  assert.equal(defaultClientDir(), path.join(appRoot, 'dist', 'client'));

  const compiledUrl = new URL('../../dist/server/config.js', import.meta.url);
  if (existsSync(fileURLToPath(compiledUrl))) {
    const compiled = (await import(compiledUrl.href)) as {
      defaultDataDir: () => string;
      defaultClientDir: () => string;
      loadConfig: (env: NodeJS.ProcessEnv) => { dataDir: string };
    };
    assert.equal(compiled.defaultDataDir(), path.join(appRoot, '.data'));
    assert.equal(compiled.defaultClientDir(), path.join(appRoot, 'dist', 'client'));
    // No env secret here would write auth-secret into the real .data dir.
    const config = compiled.loadConfig({ BETTER_AUTH_SECRET: 'x'.repeat(40), PORT: '4392' });
    assert.equal(config.dataDir, path.join(appRoot, '.data'));
  }
});


test('fresh research totals default to no fixed caps and accept explicit safe integers',async()=>{
 const {loadResearchLimits}=await import('../server/config.js');
 assert.deepEqual(loadResearchLimits({}),{toolCalls:0,modelCalls:0,inputTokens:0,outputTokens:0,elapsedMs:0});
 assert.equal(loadResearchLimits({STRIPSEARCH_RESEARCH_TOOL_CALLS:'0'}).toolCalls,0);
 assert.equal(loadResearchLimits({STRIPSEARCH_RESEARCH_TOOL_CALLS:'1000000',STRIPSEARCH_RESEARCH_MODEL_CALLS:'1'}).toolCalls,1000000);
 for(const value of ['', 'NaN', '-1', '1.2', '9007199254740992']) assert.throws(()=>loadResearchLimits({STRIPSEARCH_RESEARCH_TOOL_CALLS:value}));
});
