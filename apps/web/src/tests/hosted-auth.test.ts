import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFakeFactory } from './fakes.js';
import { startTestServer, TestClient } from './harness.js';

const HOSTED_ORIGIN = 'https://search.example.test';

function hostedEnv(signupEmails: string): NodeJS.ProcessEnv {
  return {
    STRIPSEARCH_DEPLOYMENT: 'hosted',
    STRIPSEARCH_PUBLIC_ORIGIN: HOSTED_ORIGIN,
    STRIPSEARCH_SIGNUP_EMAILS: signupEmails
  };
}

test('hosted HTTPS signup issues secure cookies and the allowlist is case-insensitive', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() }, hostedEnv('alice@example.test'));
  t.after(() => server.close());
  assert.equal(server.origin, HOSTED_ORIGIN);
  assert.equal(server.client.origin, HOSTED_ORIGIN);

  const signup = await server.client.signUp('Alice@Example.Test', 'password-1234', 'Alice');
  assert.equal(signup.status, 200);
  const setCookies = signup.headers.getSetCookie();
  assert.ok(setCookies.length > 0, 'hosted signup must set a session cookie');
  const sessionCookie =
    setCookies.find((value) => value.startsWith('__Secure-stripsearch.')) ??
    setCookies.find((value) => value.startsWith('stripsearch.')) ??
    setCookies[0] ??
    '';
  assert.match(sessionCookie, /^__Secure-stripsearch\./);
  assert.match(sessionCookie.toLowerCase(), /secure/);
  assert.match(sessionCookie.toLowerCase(), /httponly/);
  assert.match(sessionCookie.toLowerCase(), /samesite=lax/);

  const session = await server.client.json<{ user: { email: string } } | null>('/api/auth/get-session');
  assert.equal(session.status, 200);
  assert.equal(session.body?.user.email, 'alice@example.test');

  // The session persists and hosted sign-out invalidates it.
  const persisted = await server.client.json<{ user: { email: string } }>('/api/auth/get-session');
  assert.equal(persisted.body.user.email, 'alice@example.test');
  const logout = await server.client.signOut();
  assert.equal(logout.status, 200);
  const afterLogout = await server.client.json<unknown>('/api/auth/get-session');
  assert.equal(afterLogout.body, null);
});

test('hosted signup denies non-allowlisted emails and empty lists; existing login still works', async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stripsearch-hosted-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const first = await startTestServer(
    { providerFactory: createFakeFactory() },
    hostedEnv('alice@example.test'),
    { dataDir, preserveData: true }
  );
  assert.equal((await first.client.signUp('alice@example.test')).status, 200);
  const denied = await first.client.signUp('mallory@example.test');
  assert.notEqual(denied.status, 200);
  const deniedBody = (await denied.json()) as { code?: string; message?: string };
  assert.equal(deniedBody.code, 'SIGNUP_NOT_ALLOWED');
  await first.close();

  // Restart with an empty allowlist: every new account is denied, but the
  // existing account can still sign in.
  const second = await startTestServer(
    { providerFactory: createFakeFactory() },
    hostedEnv(''),
    { dataDir, preserveData: true }
  );
  t.after(() => second.close());
  assert.deepEqual(second.boot.config.signupEmails, []);

  const rejected = await second.client.signUp('newcomer@example.test');
  assert.notEqual(rejected.status, 200);
  assert.equal(((await rejected.json()) as { code?: string }).code, 'SIGNUP_NOT_ALLOWED');

  const loginClient = new TestClient(second.baseUrl, second.origin);
  const login = await loginClient.signIn('alice@example.test', 'password-1234');
  assert.equal(login.status, 200);
  const session = await loginClient.json<{ user: { email: string } }>('/api/auth/get-session');
  assert.equal(session.body.user.email, 'alice@example.test');
});

test('explicit open hosted signup admits an unlisted email while preserving secure sessions and Origin checks', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() }, {
    ...hostedEnv('alice@example.test'),
    STRIPSEARCH_SIGNUP_MODE: 'open'
  });
  t.after(() => server.close());
  const rejected = await server.client.request('/api/auth/sign-up/email', {
    method: 'POST', origin: 'https://evil.example.test',
    json: { name: 'Bob', email: 'bob@example.test', password: 'password-1234' }
  });
  assert.equal(rejected.status, 403);
  const signup = await server.client.signUp('bob@example.test', 'password-1234', 'Bob');
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().find(value => value.startsWith('__Secure-stripsearch.'));
  assert.ok(cookie);
  assert.match(cookie, /; Secure/i);
  assert.match(cookie, /; HttpOnly/i);
  const session = await server.client.json<{ user: { email: string } }>('/api/auth/get-session');
  assert.equal(session.body.user.email, 'bob@example.test');
  assert.equal((await server.client.signOut()).status, 200);
  assert.equal((await server.client.signIn('bob@example.test', 'password-1234')).status, 200);
});

test('hosted auth mutations reject missing, foreign and spoofed Origins', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() }, hostedEnv('alice@example.test'));
  t.after(() => server.close());
  const client = new TestClient(server.baseUrl, HOSTED_ORIGIN);
  const payload = { name: 'Alice', email: 'alice@example.test', password: 'password-1234' };

  const missing = await client.request('/api/auth/sign-up/email', {
    method: 'POST',
    origin: null,
    json: payload
  });
  assert.equal(missing.status, 403);
  assert.equal(
    ((await missing.json()) as { error?: { code?: string } }).error?.code,
    'origin_rejected'
  );

  for (const origin of ['https://evil.example.test', `http://${HOSTED_ORIGIN.slice(8)}`]) {
    const foreign = await client.request('/api/auth/sign-up/email', {
      method: 'POST',
      origin,
      json: payload
    });
    assert.equal(foreign.status, 403, `origin ${origin} must be rejected`);
    assert.equal(
      ((await foreign.json()) as { error?: { code?: string } }).error?.code,
      'origin_rejected'
    );
  }

  // The exact configured origin still works and application mutations stay
  // pinned to the single hosted origin as well.
  const allowed = await client.signUp('alice@example.test');
  assert.equal(allowed.status, 200);
  const spoofedRun = await client.request('/api/runs', {
    method: 'POST',
    origin: 'https://evil.example.test',
    json: { question: '来源伪造测试', seedUrl: null, provider: 'github' }
  });
  assert.equal(spoofedRun.status, 403);
});
