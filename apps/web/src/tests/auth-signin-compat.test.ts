import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { installDom, type DomEnv } from './dom-env.js';
import { ApiError } from '../client/api.js';
import type { AuthController } from '../client/auth.js';
import { createAuth } from '../server/auth.js';
import type { AppConfig } from '../server/config.js';
import { openDatabase } from '../server/db/index.js';
import { migrateDatabase } from '../server/db/migrate.js';

// Existing accounts may hold passwords created before the 8-character signup
// rule (down to a synthetic six-character legacy case). This file proves the
// bounded compatibility fix end to end: a mode-aware client that hands short
// existing passwords to the unchanged Better Auth server, while new signups
// stay 8–128 characters in both the client and the real server handler.

// Install a throwaway DOM before importing the controller module, exactly like
// auth-controller.test.ts. Every scenario below installs its own fresh DOM.
installDom();
const { createAuthController } = await import('../client/auth.js');

interface FakeAuthApi {
  calls: { type: 'signin' | 'signup'; payload: Record<string, string> }[];
  pending: {
    resolve: (value: { user: { id: string; email: string; name: string } }) => void;
    reject: (error: unknown) => void;
  }[];
  api: {
    signIn: (payload: Record<string, string>) => Promise<unknown>;
    signUp: (payload: Record<string, string>) => Promise<unknown>;
  };
}

/** Fake ApiClient: records payloads and only settles when the test says so. */
function makeFakeApi(): FakeAuthApi {
  const calls: FakeAuthApi['calls'] = [];
  const pending: FakeAuthApi['pending'] = [];
  const api: FakeAuthApi['api'] = {
    signIn(payload) {
      calls.push({ type: 'signin', payload });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    signUp(payload) {
      calls.push({ type: 'signup', payload });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
  };
  return { calls, pending, api };
}

interface ScenarioEls {
  form: HTMLFormElement;
  nameInput: HTMLInputElement;
  nameError: HTMLElement;
  email: HTMLInputElement;
  emailError: HTMLElement;
  password: HTMLInputElement;
  passwordError: HTMLElement;
  submit: HTMLButtonElement;
  tabSignin: HTMLButtonElement;
  tabSignup: HTMLButtonElement;
}

interface Scenario {
  env: DomEnv;
  fake: FakeAuthApi;
  controller: AuthController;
  els: ScenarioEls;
}

/** Fresh document + controller per scenario so old listeners cannot leak. */
function scenario(): Scenario {
  const env = installDom();
  const fake = makeFakeApi();
  const controller = createAuthController(fake.api as never);
  const doc = env.document;
  const element = <T extends HTMLElement>(id: string): T => {
    const found = doc.getElementById(id);
    if (!found) throw new Error(`missing element #${id}`);
    return found as T;
  };
  return {
    env,
    fake,
    controller,
    els: {
      form: element<HTMLFormElement>('auth-form'),
      nameInput: element<HTMLInputElement>('auth-name'),
      nameError: element<HTMLElement>('auth-name-error'),
      email: element<HTMLInputElement>('auth-email'),
      emailError: element<HTMLElement>('auth-email-error'),
      password: element<HTMLInputElement>('auth-password'),
      passwordError: element<HTMLElement>('auth-password-error'),
      submit: element<HTMLButtonElement>('auth-submit'),
      tabSignin: element<HTMLButtonElement>('tab-signin'),
      tabSignup: element<HTMLButtonElement>('tab-signup')
    }
  };
}

async function tick(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function submitForm(env: DomEnv, form: HTMLFormElement): void {
  const EventCtor = (env.window as unknown as { Event: new (type: string, init?: EventInit) => Event }).Event;
  form.dispatchEvent(new EventCtor('submit', { cancelable: true, bubbles: true }));
}

function clickOn(env: DomEnv, element: HTMLElement): void {
  const EventCtor = (env.window as unknown as { Event: new (type: string) => Event }).Event;
  element.dispatchEvent(new EventCtor('click'));
}

const LEGACY_EMAIL = 'legacy@example.test';
const LEGACY_SIX = 'a1B2c3';

test('signin dispatches an existing six-character password unchanged and closes on success', async () => {
  const { env, fake, controller, els } = scenario();
  let success = 0;
  controller.open('signin', () => {
    success += 1;
  });
  els.email.value = LEGACY_EMAIL;
  els.password.value = LEGACY_SIX;
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.type, 'signin');
  assert.equal(fake.calls[0]?.payload.email, LEGACY_EMAIL);
  assert.equal(fake.calls[0]?.payload.password, LEGACY_SIX, 'the exact six-character password must reach signIn');
  assert.equal(success, 0, 'success only fires after the response');
  fake.pending[0]?.resolve({ user: { id: 'u-legacy', email: LEGACY_EMAIL, name: 'Legacy' } });
  await tick();
  assert.equal(success, 1);
  assert.equal(controller.isOpen(), false);
});

test('signin sends one- and seven-character passwords instead of pre-rejecting the signup bound', async () => {
  for (const password of ['x', 'seven77']) {
    const { env, fake, controller, els } = scenario();
    controller.open('signin', () => undefined);
    els.email.value = LEGACY_EMAIL;
    els.password.value = password;
    submitForm(env, els.form);
    await tick();
    assert.equal(fake.calls.length, 1, `a ${password.length}-character password must reach signIn`);
    assert.equal(fake.calls[0]?.type, 'signin');
    assert.equal(fake.calls[0]?.payload.password, password);
    fake.pending[0]?.reject(new ApiError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password'));
    await tick();
  }
});

test('a wrong short password is really sent and only surfaces the generic 401 message', async () => {
  const { env, fake, controller, els } = scenario();
  let success = 0;
  controller.open('signin', () => {
    success += 1;
  });
  els.email.value = LEGACY_EMAIL;
  els.password.value = 'a1B2c4';
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 1, 'the request must leave the client; the server hash check decides');
  fake.pending[0]?.reject(new ApiError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password'));
  await tick();
  assert.equal(success, 0);
  assert.equal(els.emailError.textContent, '邮箱或密码不正确，请重试。');
  assert.equal(els.email.getAttribute('aria-invalid'), 'true');
  assert.equal(els.submit.disabled, false, 'the form must stay retryable');
  els.password.value = LEGACY_SIX;
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 2);
  fake.pending[1]?.resolve({ user: { id: 'u-legacy', email: LEGACY_EMAIL, name: 'Legacy' } });
  await tick();
  assert.equal(success, 1);
});

test('empty and 129-character passwords fail inline in both modes without losing input', async () => {
  for (const mode of ['signin', 'signup'] as const) {
    for (const password of ['', 'x'.repeat(129)]) {
      const { env, fake, controller, els } = scenario();
      controller.open(mode, () => undefined);
      if (mode === 'signup') els.nameInput.value = 'Synthetic User';
      els.email.value = 'keep@example.test';
      els.password.value = password;
      submitForm(env, els.form);
      await tick();
      const label = password.length === 0 ? 'empty' : '129-character';
      assert.equal(fake.calls.length, 0, `${mode} must not send a ${label} password`);
      assert.ok((els.passwordError.textContent ?? '').length > 0, 'inline password error required');
      assert.equal(els.password.getAttribute('aria-invalid'), 'true');
      assert.equal(els.email.value, 'keep@example.test', 'existing input must be preserved');
      assert.equal(els.password.value, password);
    }
  }
});

test('signin→signup→signin keeps minLength/autocomplete and the short-password rule in sync', async () => {
  const { env, fake, controller, els } = scenario();
  controller.open('signin', () => undefined);
  assert.equal(els.password.minLength, 1);
  assert.equal(els.password.getAttribute('minlength'), '1');
  assert.equal(els.password.autocomplete, 'current-password');

  clickOn(env, els.tabSignup);
  assert.equal(els.password.minLength, 8);
  assert.equal(els.password.getAttribute('minlength'), '8');
  assert.equal(els.password.autocomplete, 'new-password');

  els.nameInput.value = 'Synthetic User';
  els.email.value = LEGACY_EMAIL;
  els.password.value = LEGACY_SIX;
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 0, 'signup mode must block the six-character password');
  assert.ok((els.passwordError.textContent ?? '').length > 0);
  assert.equal(els.password.getAttribute('aria-invalid'), 'true');

  clickOn(env, els.tabSignin);
  assert.equal(els.password.minLength, 1);
  assert.equal(els.password.getAttribute('minlength'), '1');
  assert.equal(els.password.autocomplete, 'current-password');
  assert.equal(els.passwordError.textContent, '', 'no stale error may survive the mode switch');
  assert.equal(els.password.getAttribute('aria-invalid'), null);

  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 1, 'the same six-character password must send in signin mode');
  assert.equal(fake.calls[0]?.type, 'signin');
  assert.equal(fake.calls[0]?.payload.password, LEGACY_SIX);
  fake.pending[0]?.resolve({ user: { id: 'u-legacy', email: LEGACY_EMAIL, name: 'Legacy' } });
  await tick();
});

test('signup blocks 7/129 characters, sends 8/128 and keeps the display-name rule', async () => {
  const cases: { password: string; sends: boolean }[] = [
    { password: 'x'.repeat(7), sends: false },
    { password: 'x'.repeat(8), sends: true },
    { password: 'x'.repeat(128), sends: true },
    { password: 'x'.repeat(129), sends: false }
  ];
  for (const item of cases) {
    const { env, fake, controller, els } = scenario();
    controller.open('signup', () => undefined);
    els.nameInput.value = 'Synthetic User';
    els.email.value = 'fresh@example.test';
    els.password.value = item.password;
    submitForm(env, els.form);
    await tick();
    assert.equal(fake.calls.length, item.sends ? 1 : 0, `signup ${item.password.length}-character dispatch`);
    if (item.sends) {
      assert.equal(fake.calls[0]?.type, 'signup');
      assert.equal(fake.calls[0]?.payload.name, 'Synthetic User');
      assert.equal(fake.calls[0]?.payload.password, item.password);
    } else {
      assert.ok((els.passwordError.textContent ?? '').length > 0);
      assert.equal(els.password.getAttribute('aria-invalid'), 'true');
    }
    fake.pending[0]?.resolve({ user: { id: 'u-new', email: 'fresh@example.test', name: 'Synthetic User' } });
    await tick();
  }

  // The name rule is untouched by the password fix.
  const { env, fake, controller, els } = scenario();
  controller.open('signup', () => undefined);
  els.nameInput.value = '';
  els.email.value = 'fresh@example.test';
  els.password.value = 'x'.repeat(8);
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 0, 'signup still requires a display name');
  assert.equal(els.nameInput.getAttribute('aria-invalid'), 'true');
  assert.ok((els.nameError.textContent ?? '').length > 0);
});

test('passwords are validated and dispatched byte-exact without trimming', async () => {
  // Signin: a padded existing string passes through unchanged.
  {
    const padded = '  padded-pass  ';
    const { env, fake, controller, els } = scenario();
    controller.open('signin', () => undefined);
    els.email.value = LEGACY_EMAIL;
    els.password.value = padded;
    submitForm(env, els.form);
    await tick();
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.payload.password, padded);
    assert.equal(fake.calls[0]?.payload.password.length, padded.length);
    fake.pending[0]?.resolve({ user: { id: 'u-legacy', email: LEGACY_EMAIL, name: 'Legacy' } });
    await tick();
  }

  // Signup: length uses the raw value, so a string that is only 7 characters
  // when trimmed still counts as its raw 9 characters and is sent unchanged.
  const padded = ' x1Y2z34 ';
  assert.equal(padded.trim().length, 7);
  assert.equal(padded.length, 9);
  const { env, fake, controller, els } = scenario();
  controller.open('signup', () => undefined);
  els.nameInput.value = 'Synthetic User';
  els.email.value = 'padded@example.test';
  els.password.value = padded;
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 1, 'raw length, not trimmed length, decides');
  assert.equal(fake.calls[0]?.type, 'signup');
  assert.equal(fake.calls[0]?.payload.password, padded);
  fake.pending[0]?.resolve({ user: { id: 'u-pad', email: 'padded@example.test', name: 'Synthetic User' } });
  await tick();
});

test('pending submission, close and reopen keep duplicate and late-response guards', async () => {
  const { env, fake, controller, els } = scenario();
  let first = 0;
  let second = 0;
  controller.open('signin', () => {
    first += 1;
  });
  els.email.value = 'first@example.test';
  els.password.value = LEGACY_SIX;
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 1);

  // Tab changes and duplicate submits are blocked while the request is pending.
  clickOn(env, els.tabSignup);
  assert.equal(els.tabSignup.getAttribute('aria-selected'), 'false');
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 1, 'a second submit while pending must be ignored');

  controller.close();
  await tick();
  controller.open('signin', () => {
    second += 1;
  });
  els.email.value = 'second@example.test';
  els.password.value = 'x';
  submitForm(env, els.form);
  await tick();
  assert.equal(fake.calls.length, 2);

  // A late failure from the abandoned dialog must not touch the new one.
  fake.pending[0]?.reject(new ApiError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password'));
  await tick();
  assert.equal(first, 0);
  assert.equal(second, 0);
  assert.equal(els.emailError.textContent, '');
  assert.equal(controller.isOpen(), true);

  // The live request resolves normally.
  fake.pending[1]?.resolve({ user: { id: 'u2', email: 'second@example.test', name: 'Second' } });
  await tick();
  assert.equal(first, 0);
  assert.equal(second, 1);
  assert.equal(controller.isOpen(), false);
});

// --- In-process Better Auth contract (real 1.7.5 handler, SQLite :memory:) ---

function syntheticConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    deployment: 'local',
    host: '127.0.0.1',
    port: 4392,
    origin: 'http://127.0.0.1:4392',
    allowedOrigins: ['http://127.0.0.1:4392'],
    secureCookies: false,
    signupEmails: null,
    authSecret: 'synthetic-test-secret-not-a-real-credential',
    authSecretSource: 'file',
    dataDir: '/nonexistent/synthetic-data-dir',
    dbPath: ':memory:',
    githubToken: null,
    exaApiKey: null,
    deepseekApiKey: null,
    firecrawlApiKey: null,
    tikhubApiKey: null,
    nodeEnv: 'test',
    isTest: true,
    ...overrides
  };
}

function cookieCount(response: Response): number {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return (headers.getSetCookie?.() ?? []).length;
}

interface HandlerFixture {
  post: (pathname: string, body: Record<string, string>) => Promise<Response>;
  counts: () => { users: number; accounts: number };
  seedLegacyPassword: (email: string, password: string) => Promise<string>;
  currentHash: (email: string) => string;
}

function makeHandlerFixture(
  db: ReturnType<typeof openDatabase>,
  config: AppConfig,
  auth: ReturnType<typeof createAuth>
): HandlerFixture {
  const post = (pathname: string, body: Record<string, string>): Promise<Response> =>
    auth.handler(
      new Request(`${config.origin}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: config.origin },
        body: JSON.stringify(body)
      })
    );
  const counts = (): { users: number; accounts: number } => ({
    users: (db.prepare('select count(*) as c from user').get() as { c: number }).c,
    accounts: (db.prepare('select count(*) as c from account').get() as { c: number }).c
  });
  const credentialRow = (email: string): { id: string; accountId: string } =>
    db
      .prepare(
        "select u.id as id, a.accountId as accountId from user u join account a on a.userId = u.id where u.email = ? and a.providerId = 'credential'"
      )
      .get(email) as { id: string; accountId: string };
  return {
    post,
    counts,
    async seedLegacyPassword(email, password) {
      const row = credentialRow(email);
      // Legacy-state fixture for this :memory: test only: an old short password
      // hash replacing the one credential row of the synthetic account.
      const legacyHash = await hashPassword(password);
      const seeded = db
        .prepare("update account set password = ? where providerId = 'credential' and userId = ? and accountId = ?")
        .run(legacyHash, row.id, row.accountId);
      assert.equal(seeded.changes, 1);
      return legacyHash;
    },
    currentHash(email) {
      const row = credentialRow(email);
      return (
        db
          .prepare("select password from account where providerId = 'credential' and userId = ? and accountId = ?")
          .get(row.id, row.accountId) as { password: string }
      ).password;
    }
  };
}

test('the unchanged better auth handler signs in a synthetic legacy short password and keeps signup at 8–128', async (t) => {
  const config = syntheticConfig();
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = createAuth(db, config);
  await migrateDatabase(db, auth);
  const { post, counts, seedLegacyPassword, currentHash } = makeHandlerFixture(db, config, auth);

  // Normal fixture signup under the current >= 8 rule.
  let res = await post('/api/auth/sign-up/email', {
    name: 'Synthetic Legacy',
    email: LEGACY_EMAIL,
    password: 'fixture-password-1234'
  });
  assert.equal(res.status, 200);
  const legacyHash = await seedLegacyPassword(LEGACY_EMAIL, LEGACY_SIX);

  // The correct short password authenticates through the real handler.
  res = await post('/api/auth/sign-in/email', { email: LEGACY_EMAIL, password: LEGACY_SIX });
  assert.equal(res.status, 200);
  const signInBody = (await res.json()) as { user?: { email?: string } };
  assert.equal(signInBody.user?.email, LEGACY_EMAIL);
  assert.ok(cookieCount(res) > 0, 'a successful sign-in must set a session cookie');

  // A wrong short password is rejected and creates no session.
  res = await post('/api/auth/sign-in/email', { email: LEGACY_EMAIL, password: 'a1B2c4' });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code?: string }).code, 'INVALID_EMAIL_OR_PASSWORD');
  assert.equal(cookieCount(res), 0, 'a wrong password must not create a session');

  // Direct new signups with 6 and 7 characters fail and create nothing.
  const beforeShort = counts();
  for (const password of ['sixsix', 'seven77']) {
    res = await post('/api/auth/sign-up/email', {
      name: 'Synthetic Short',
      email: `short-${password.length}@example.test`,
      password
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, 'PASSWORD_TOO_SHORT');
  }
  assert.deepEqual(counts(), beforeShort, 'rejected short signups must not grow user/account rows');

  // The 8 and 128 character signups succeed; 129 fails without inserting rows.
  res = await post('/api/auth/sign-up/email', { name: 'Synthetic Eight', email: 'eight@example.test', password: 'eight88x' });
  assert.equal(res.status, 200);
  res = await post('/api/auth/sign-up/email', { name: 'Synthetic Max', email: 'max128@example.test', password: 'y'.repeat(128) });
  assert.equal(res.status, 200);
  const beforeLong = counts();
  res = await post('/api/auth/sign-up/email', { name: 'Synthetic Long', email: 'long@example.test', password: 'x'.repeat(129) });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code?: string }).code, 'PASSWORD_TOO_LONG');
  assert.deepEqual(counts(), beforeLong);

  // The legacy hash is never re-hashed or migrated by signing in.
  assert.equal(currentHash(LEGACY_EMAIL), legacyHash);
  res = await post('/api/auth/sign-in/email', { email: LEGACY_EMAIL, password: LEGACY_SIX });
  assert.equal(res.status, 200);
  assert.equal(currentHash(LEGACY_EMAIL), legacyHash, 'the legacy hash must survive sign-in untouched');
});

test('a hosted allowlist config still signs in the legacy short password and refuses unknown signups', async (t) => {
  const config = syntheticConfig({
    deployment: 'hosted',
    origin: 'https://search.example.test',
    allowedOrigins: ['https://search.example.test'],
    secureCookies: true,
    signupEmails: ['hosted-legacy@example.test']
  });
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = createAuth(db, config);
  await migrateDatabase(db, auth);
  const { post, counts, seedLegacyPassword } = makeHandlerFixture(db, config, auth);

  let res = await post('/api/auth/sign-up/email', {
    name: 'Hosted Legacy',
    email: 'hosted-legacy@example.test',
    password: 'fixture-password-1234'
  });
  assert.equal(res.status, 200);
  await seedLegacyPassword('hosted-legacy@example.test', LEGACY_SIX);

  res = await post('/api/auth/sign-in/email', { email: 'hosted-legacy@example.test', password: LEGACY_SIX });
  assert.equal(res.status, 200);
  assert.ok(cookieCount(res) > 0, 'the hosted sign-in must set a session cookie');

  const before = counts();
  res = await post('/api/auth/sign-up/email', {
    name: 'Hosted Stranger',
    email: 'stranger@example.test',
    password: 'eight888x'
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code?: string }).code, 'SIGNUP_NOT_ALLOWED');
  assert.deepEqual(counts(), before, 'the allowlist refusal must not insert rows');
});
