import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../client/api.js';
import type { SessionUser } from '../shared/types.js';
import { createFakeFactory } from './fakes.js';
import { startTestServer, TestClient, waitFor } from './harness.js';
import { installDom } from './dom-env.js';

for (const deployment of ['local', 'hosted'] as const) {
  test(`${deployment}: six-character passwords register and sign in; five characters create no account`, async (t) => {
    const server = await startTestServer(
      { providerFactory: createFakeFactory() },
      deployment === 'hosted'
        ? { STRIPSEARCH_DEPLOYMENT: 'hosted', STRIPSEARCH_PUBLIC_ORIGIN: 'https://password.example.test' }
        : {}
    );
    t.after(() => server.close());

    const rejected = await server.client.signUp('short@example.test', 'abcde');
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as { code: string }).code, 'PASSWORD_TOO_SHORT');
    assert.equal((server.boot.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n, 0);

    // Letters only: no digit, uppercase or symbol composition requirement.
    const signup = await server.client.signUp('six@example.test', 'abcdef', 'Six');
    assert.equal(signup.status, 200);
    const signedUp = await signup.json() as { user: SessionUser };
    assert.equal(signedUp.user.email, 'six@example.test');
    assert.equal((await server.client.signOut()).status, 200);

    const fresh = new TestClient(server.baseUrl, server.origin);
    assert.equal((await fresh.signIn('six@example.test', 'abcdef')).status, 200);
    const session = await fresh.json<{ user: SessionUser }>('/api/auth/get-session');
    assert.equal(session.body.user.id, signedUp.user.id);

    const wrong = new TestClient(server.baseUrl, server.origin);
    assert.equal((await wrong.signIn('six@example.test', 'ghijkl')).status, 401);
    assert.equal((await wrong.json('/api/auth/get-session')).body, null);
  });
}

test('the auth form registers and signs in with six characters and blocks five before writing', async (t) => {
  const server = await startTestServer({ providerFactory: createFakeFactory() });
  t.after(() => server.close());
  const env = installDom();
  const { createAuthController } = await import('../client/auth.js');
  const authenticate = async (response: Response): Promise<{ user: SessionUser }> => {
    const body = await response.json() as { user: SessionUser; code?: string; message?: string };
    if (!response.ok) throw new ApiError(response.status, body.code ?? 'auth_failed', body.message ?? 'Auth failed');
    return { user: body.user };
  };
  const controller = createAuthController({
    signUp: async (payload: { name: string; email: string; password: string }) =>
      authenticate(await server.client.signUp(payload.email, payload.password, payload.name)),
    signIn: async (payload: { email: string; password: string }) =>
      authenticate(await server.client.signIn(payload.email, payload.password))
  } as never);
  t.after(() => controller.close());
  const input = (id: string) => env.document.getElementById(id) as HTMLInputElement;
  const form = env.document.getElementById('auth-form') as HTMLFormElement;
  let successes = 0;
  const submit = () => form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

  controller.open('signup', () => { successes += 1; });
  input('auth-name').value = 'Form Six';
  input('auth-email').value = 'form-six@example.test';
  input('auth-password').value = 'abcde';
  submit();
  assert.equal(input('auth-password').getAttribute('aria-invalid'), 'true');
  assert.equal((server.boot.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n, 0);

  input('auth-password').value = '123456';
  submit();
  await waitFor(() => successes === 1);
  assert.equal(controller.isOpen(), false);
  assert.equal((await server.client.signOut()).status, 200);

  controller.open('signin', () => { successes += 1; });
  input('auth-email').value = 'form-six@example.test';
  input('auth-password').value = '123456';
  submit();
  await waitFor(() => successes === 2);
  const session = await server.client.json<{ user: SessionUser }>('/api/auth/get-session');
  assert.equal(session.body.user.email, 'form-six@example.test');
  assert.equal((server.boot.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n, 1);
});
