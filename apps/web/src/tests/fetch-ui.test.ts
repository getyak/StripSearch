/**
 * Web Fetch panel DOM tests (GET-99): repository DOM race coverage for the
 * identity-guarded panel — late list/detail/start/control success after
 * reset must never overwrite the new owner's UI, stale 401/error/finally
 * paths must not leak into the new session, newer selections are never
 * overwritten by older responses, and the current-owner positive control
 * renders normally. Untrusted captured prose stays plain text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, installFetch, jsonResponse } from './dom-env.js';
import { deferred } from './fakes.js';
import type {
  FetchGithubRunState,
  FetchGithubRunSummary,
  FetchGithubRunView
} from '../shared/research-fetch-github.js';

const env = installDom();

type RouteHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let route: RouteHandler = () => jsonResponse({});
installFetch((url, init) => route(url, init));

const main = await import('../client/main.js');
const fetchPanel = main.__test.fetchPanel;

function makeRunView(runId: string, overrides: { state?: FetchGithubRunState; question?: string } = {}): FetchGithubRunView {
  return {
    runId,
    revision: 3,
    state: overrides.state ?? 'acquiring',
    phase: 'acquire',
    target: { kind: 'repository', owner: 'fixture', name: 'repo', canonicalUrl: 'https://github.com/fixture/repo' },
    accessScope: 'github_public_repository',
    question: overrides.question ?? 'Synthetic question',
    confirmation: {
      target: 'https://github.com/fixture/repo',
      question: overrides.question ?? 'Synthetic question',
      accessScope: 'github_public_repository',
      confirmedAt: '2026-04-01T00:00:00.000Z'
    },
    scopeSpecId: 'spec-1',
    scopeVersion: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    snapshot: { frozen: false, digest: null, frozenAt: null },
    progress: {
      requests: { total: 1, succeeded: 1, failed: 0, unknown: 0, rejected: 0, inFlight: 0 },
      listingPages: { repos: 0, issues: 1 },
      items: 1,
      comments: 0
    },
    requests: [],
    items: [],
    pendingEvidence: [
      {
        evidenceId: 'ev-1',
        accountId: 'ghacct:case-1:fixture',
        sourceId: 'src-1',
        sourceRevision: 1,
        role: 'factual_support',
        quote: '<img src=x onerror="window.__xss=1"> plain quote',
        sourceUrl: 'https://github.com/fixture/repo/issues/1',
        sourceTitle: 'fixture/repo#1',
        author: 'writer',
        publishedAt: null,
        retrievedAt: '2026-04-01T00:00:00.000Z',
        revokedAt: null
      }
    ],
    gaps: [{ code: 'synthetic_gap', detail: 'Synthetic gap detail' }],
    limitations: ['合成限制：只读取公开资源。'],
    processing: null
  };
}

function makeRunSummary(runId: string): FetchGithubRunSummary {
  return {
    runId,
    revision: 3,
    state: 'acquiring',
    phase: 'acquire',
    targetUrl: 'https://github.com/fixture/repo',
    question: 'Synthetic question',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    snapshotFrozen: false,
    progress: { requests: 1, items: 1, comments: 0, gaps: 1 }
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function statusText(id: string): string {
  return env.document.getElementById(id)?.textContent ?? '';
}

function submitForm(): void {
  const target = env.document.getElementById('fetch-target') as HTMLInputElement;
  const question = env.document.getElementById('fetch-question') as HTMLTextAreaElement;
  const confirm = env.document.getElementById('fetch-confirm') as HTMLInputElement;
  target.value = 'https://github.com/fixture/repo';
  question.value = 'Synthetic question';
  confirm.checked = true;
  env.document
    .getElementById('fetch-form')!
    .dispatchEvent(new (env.window as unknown as { Event: new (type: string, init?: unknown) => Event }).Event('submit', { bubbles: true, cancelable: true }));
}

test('current-owner positive control: list, selection and plain-text evidence render normally', async () => {
  route = (url) => {
    if (url.includes('/api/fetch/runs/run-a')) return jsonResponse({ run: makeRunView('run-a') });
    if (url.includes('/api/fetch/runs')) return jsonResponse({ runs: [makeRunSummary('run-a')] });
    return jsonResponse({});
  };
  await fetchPanel.open();
  await settle();
  const list = env.document.getElementById('fetch-run-list')!;
  assert.equal(list.children.length, 1, 'persisted runs restore after refresh');
  await fetchPanel.select('run-a');
  await settle();
  assert.equal(statusText('fetch-detail-title'), 'https://github.com/fixture/repo');
  // Untrusted captured prose stays plain text, never raw HTML.
  const quote = env.document.querySelector('#fetch-evidence blockquote');
  assert.ok(quote, 'evidence quote rendered');
  assert.equal(quote!.querySelector('img'), null, 'captured prose is never rendered as HTML');
  assert.ok(quote!.textContent?.includes('plain quote'));
});

test('late list response after reset never repaints the previous owner UI', async () => {
  const gate = deferred<Response>();
  route = (url) => {
    if (url.includes('/api/fetch/runs')) return gate.promise;
    return jsonResponse({});
  };
  const refreshing = fetchPanel.refresh();
  fetchPanel.reset();
  gate.resolve(jsonResponse({ runs: [makeRunSummary('run-stale')] }));
  await refreshing;
  await settle();
  assert.equal(env.document.getElementById('fetch-run-list')!.children.length, 0, 'stale list is dropped');
  assert.equal((env.document.getElementById('fetch-detail') as HTMLElement).hidden, true);
});

test('newer selections are never overwritten by older detail responses', async () => {
  const gate = deferred<Response>();
  route = (url) => {
    if (url.includes('/api/fetch/runs/run-old')) return gate.promise;
    if (url.includes('/api/fetch/runs/run-new')) {
      return jsonResponse({ run: makeRunView('run-new', { question: 'Synthetic NEW question' }) });
    }
    return jsonResponse({});
  };
  const older = fetchPanel.select('run-old');
  await fetchPanel.select('run-new');
  await settle();
  assert.ok(statusText('fetch-detail-state').includes('Synthetic NEW question'), 'newest selection rendered');
  gate.resolve(jsonResponse({ run: makeRunView('run-old', { question: 'Synthetic OLD question' }) }));
  await older;
  await settle();
  assert.ok(statusText('fetch-detail-state').includes('Synthetic NEW question'), 'late older response cannot overwrite');
  assert.ok(!statusText('fetch-detail-state').includes('Synthetic OLD question'));
});

test('late start success after reset renders nothing for the previous identity', async () => {
  const gate = deferred<Response>();
  route = (url) => {
    if (url.includes('/api/fetch/start')) return gate.promise;
    return jsonResponse({ runs: [] });
  };
  submitForm();
  await settle();
  fetchPanel.reset();
  gate.resolve(jsonResponse({ run: makeRunView('run-started'), idempotent: false }));
  await settle();
  assert.equal((env.document.getElementById('fetch-detail') as HTMLElement).hidden, true, 'stale start success is dropped');
  assert.equal(statusText('fetch-form-status'), '', 'stale start never repaints the form status');
});

test('stale 401 and stale errors after reset never leak into the new session', async () => {
  const gate = deferred<Response>();
  route = (url) => {
    if (url.includes('/api/fetch/runs')) return gate.promise;
    return jsonResponse({});
  };
  const authDialog = env.document.getElementById('auth-dialog')!;
  authDialog.removeAttribute('open');
  const refreshing = fetchPanel.refresh();
  fetchPanel.reset();
  gate.resolve(jsonResponse({ error: { code: 'unauthorized', message: 'Synthetic stale 401' } }, 401));
  await refreshing;
  await settle();
  assert.equal(authDialog.hasAttribute('open'), false, 'stale 401 never opens sign-in for the new identity');
  assert.equal(statusText('fetch-form-status'), '', 'stale errors never leak into the new session');
  assert.equal(statusText('fetch-detail-status'), '');
});

test('live 401 still triggers sign-in (positive control for the error path)', async () => {
  route = (url) => {
    if (url.includes('/api/fetch/runs')) return jsonResponse({ error: { code: 'unauthorized', message: '请先登录。' } }, 401);
    return jsonResponse({});
  };
  const authDialog = env.document.getElementById('auth-dialog')!;
  authDialog.removeAttribute('open');
  await fetchPanel.refresh();
  await settle();
  assert.equal(authDialog.hasAttribute('open'), true, 'a live 401 opens sign-in for the current identity');
  authDialog.removeAttribute('open');
  fetchPanel.reset();
});

test('late control success after reset and stale finally guard busy state', async () => {
  // Late control success after reset.
  const control = deferred<Response>();
  route = (url) => {
    if (url.includes('/pause')) return control.promise;
    if (url.includes('/api/fetch/runs/run-ctl')) return jsonResponse({ run: makeRunView('run-ctl') });
    return jsonResponse({ runs: [makeRunSummary('run-ctl')] });
  };
  await fetchPanel.open();
  await settle();
  await fetchPanel.select('run-ctl');
  await settle();
  (env.document.getElementById('fetch-pause') as HTMLButtonElement).click();
  await settle();
  fetchPanel.reset();
  control.resolve(jsonResponse({ run: makeRunView('run-ctl', { state: 'paused' }) }));
  await settle();
  assert.equal((env.document.getElementById('fetch-detail') as HTMLElement).hidden, true, 'late control success is dropped');

  // Stale submit finally must not clobber the NEW owner's busy state: the
  // button stays disabled while the new submission is pending.
  const staleStart = deferred<Response>();
  const freshStart = deferred<Response>();
  let call = 0;
  route = (url) => {
    if (url.includes('/api/fetch/start')) {
      call += 1;
      return call === 1 ? staleStart.promise : freshStart.promise;
    }
    return jsonResponse({ runs: [] });
  };
  submitForm();
  await settle();
  fetchPanel.reset();
  submitForm();
  await settle();
  const submitButton = env.document.getElementById('fetch-submit') as HTMLButtonElement;
  assert.equal(submitButton.disabled, true, 'new submission is busy');
  staleStart.resolve(jsonResponse({ run: makeRunView('run-stale-start'), idempotent: false }));
  await settle();
  assert.equal(submitButton.disabled, true, 'stale finally cannot clear the new submission busy state');
  freshStart.resolve(jsonResponse({ run: makeRunView('run-fresh'), idempotent: false }));
  await settle();
  assert.equal(submitButton.disabled, false, 'current submission completion restores the button');
  fetchPanel.reset();
});

test('start confirmation belongs to the current target and question', async () => {
  const target = env.document.getElementById('fetch-target') as HTMLInputElement;
  const question = env.document.getElementById('fetch-question') as HTMLTextAreaElement;
  const confirmation = env.document.getElementById('fetch-confirm') as HTMLInputElement;
  for (const field of [null, target, question]) {
    fetchPanel.reset();
    let starts = 0;
    route = (url, init) => {
      if (url.includes('/api/fetch/start')) {
        starts++;
        const body = JSON.parse(String(init?.body)) as { targetUrl: string; question: string; confirmedTarget: string; confirmedQuestion: string };
        assert.equal(body.confirmedTarget, body.targetUrl);
        assert.equal(body.confirmedQuestion, body.question);
        const run = makeRunView('confirmed', { question: body.question });
        run.target.canonicalUrl = body.targetUrl;
        return jsonResponse({ run });
      }
      if (url.includes('/api/fetch/runs/')) return jsonResponse({ run: makeRunView('confirmed') });
      return jsonResponse({ runs: [] });
    };
    target.value = 'https://github.com/fixture/repo';
    question.value = 'Synthetic frozen question';
    confirmation.checked = true;
    if (field) {
      field.value = field === target ? 'https://github.com/fixture/other' : 'Changed synthetic question';
      field.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      assert.equal(confirmation.checked, false);
    }
    env.document.getElementById('fetch-form')!.dispatchEvent(new env.window.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(starts, field ? 0 : 1, 'edited inputs need a new confirmation before dispatch');
    if (field) {
      confirmation.checked = true;
      env.document.getElementById('fetch-form')!.dispatchEvent(new env.window.Event('submit', { cancelable: true }));
      await settle();
      assert.equal(starts, 1, 'reconfirming edited inputs permits the new start');
    }
  }
  fetchPanel.reset();
});

test('unknown request consent is explicit and bound to one run and control revision', async () => {
  const choice = env.document.getElementById('fetch-resume-choice') as HTMLSelectElement;
  const resume = env.document.getElementById('fetch-resume') as HTMLButtonElement;
  let run = makeRunView('unknown-a', { state: 'paused' });
  let resumes: Record<string, unknown>[] = [];
  route = (url, init) => {
    if (url.endsWith('/resume')) {
      resumes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ run });
    }
    if (url.includes('/api/fetch/runs/')) return jsonResponse({ run });
    return jsonResponse({ runs: [] });
  };
  for (const uncertain of ['unknown', 'inFlight'] as const) {
    fetchPanel.reset();
    run = makeRunView(`unknown-${uncertain}`, { state: 'paused' });
    run.progress.requests[uncertain] = 1;
    resumes = [];
    await fetchPanel.select(run.runId);
    assert.equal(choice.hidden, false);
    assert.equal(choice.value, '');
    resume.click();
    await settle();
    assert.equal(resumes.length, 0, 'unknown or in-flight requests need an explicit decision');
    for (const decision of ['retry', 'skip']) {
      choice.value = decision;
      resume.click();
      await settle();
      assert.equal(resumes.at(-1)?.reconcileUnknown, decision);
    }
  }
  for (const reset of [false, true]) {
    choice.value = 'retry';
    if (reset) fetchPanel.reset();
    run = makeRunView('unknown-b', { state: 'unreconciled' });
    run.needsReconciliation = true;
    resumes = [];
    await fetchPanel.select(run.runId);
    assert.equal(choice.value, '', 'another run or identity cannot inherit retry permission');
    resume.click();
    await settle();
    assert.equal(resumes.length, 0);
    choice.value = 'retry';
    run.revision++;
    await fetchPanel.refresh();
    assert.equal(choice.value, '', 'a new control revision needs fresh permission');
  }
  fetchPanel.reset();
  run = makeRunView('reconciled-history', { state: 'paused' });
  run.progress.requests.unknown = 1;
  run.needsReconciliation = false;
  resumes = [];
  await fetchPanel.select(run.runId);
  assert.equal(choice.hidden, true, 'resolved historical unknowns need no extra confirmation');
  resume.click();
  await settle();
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0]?.reconcileUnknown, undefined);
  fetchPanel.reset();
});
