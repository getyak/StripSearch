import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFakeFactory } from './fakes.js';
import { startTestServer } from './harness.js';

const HOSTED_ORIGIN = 'https://search.example.test';

// A separate test process keeps these accounts independent of the shared
// in-memory authentication rate-limit bucket in hosted-auth.test.ts.
test('default hosted signup accepts any email despite empty or stale legacy lists and survives restart', async (t) => {
  for (const emails of [undefined, '', 'legacy@example.test']) {
    await t.test(`legacy list: ${emails ?? 'unset'}`, async (t) => {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'stripsearch-open-'));
      t.after(() => rmSync(dataDir, { recursive: true, force: true }));
      const env = {
        STRIPSEARCH_DEPLOYMENT: 'hosted',
        STRIPSEARCH_PUBLIC_ORIGIN: HOSTED_ORIGIN,
        STRIPSEARCH_SIGNUP_EMAILS: emails
      };
      const first = await startTestServer({ providerFactory: createFakeFactory() }, env, { dataDir, preserveData: true });
      let second: Awaited<ReturnType<typeof startTestServer>> | undefined;
      t.after(async () => { await second?.close(); await first.close(); });
      assert.equal(first.boot.config.signupEmails, null);
      const signup = await first.client.signUp('newcomer@example.test');
      assert.equal(signup.status, 200);
      const cookie = signup.headers.getSetCookie().find(value => value.startsWith('__Secure-stripsearch.'));
      assert.ok(cookie);
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; HttpOnly/i);
      assert.equal((await first.client.signOut()).status, 200);
      await first.close();
      second = await startTestServer({ providerFactory: createFakeFactory() }, env, { dataDir, preserveData: true });
      assert.equal((await second.client.signIn('newcomer@example.test', 'password-1234')).status, 200);
      const session = await second.client.json<{ user: { email: string } }>('/api/auth/get-session');
      assert.equal(session.body.user.email, 'newcomer@example.test');
      assert.equal((await second.client.signUp('another@example.test')).status, 200);
      const foreign = await second.client.request('/api/auth/sign-up/email', {
        method: 'POST', origin: 'https://evil.example.test',
        json: { name: 'Foreign', email: 'foreign@example.test', password: 'password-1234' }
      });
      assert.equal(foreign.status, 403);
      const missing = await second.client.request('/api/auth/sign-up/email', {
        method: 'POST', origin: null,
        json: { name: 'Missing', email: 'missing@example.test', password: 'password-1234' }
      });
      assert.equal(missing.status, 403);
    });
  }
});
