import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView, SessionUser } from '../shared/types.js';
import type { ReviewCaseDetail, ReviewQueueItem } from '../shared/review.js';
import { installDom, installFetch, jsonResponse, textResponse } from './dom-env.js';
import { deferred } from './fakes.js';

const env = installDom();

function user(id: string): SessionUser {
  return { id, email: `${id}@example.test`, name: id };
}

function makeSource(sourceKey: string, excluded = false): CanonicalView['sources'][number] {
  return {
    sourceKey,
    url: `https://example.com/${sourceKey.toLowerCase()}`,
    title: `来源 ${sourceKey}`,
    kind: 'work',
    publishedAt: null,
    retrievedAt: '2024-01-01T00:00:00.000Z',
    fetchStatus: excluded ? 'excluded' : 'ok',
    excerpt: '短摘录',
    excerptLocator: '摘录',
    identityLabel: '未确认',
    identityConfirmed: false,
    limits: [],
    excluded,
    excludedAt: excluded ? '2024-01-02T00:00:00.000Z' : null
  };
}

function makeView(runId: string, overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    state: 'completed',
    revision: 1,
    question: `问题 ${runId}`,
    seedUrl: 'https://github.com/example',
    provider: 'github',
    parentRunId: null,
    retryOf: null,
    followup: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    interrupted: false,
    stopReason: null,
    identity: {
      displayName: runId,
      handle: null,
      profileUrl: null,
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [makeSource('S1')],
    observations: [],
    answer: [
      {
        id: 'facts',
        heading: '查到的事实',
        body: '',
        bullets: [{ text: '事实一', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null }]
      }
    ],
    limitations: [],
    usage: { provider: 'github', requests: 1, bytes: 1, elapsedMs: 1, measurement: 'observed' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

type RouteHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let route: RouteHandler = () => jsonResponse({});
installFetch((url, init) => route(url, init));

const main = await import('../client/main.js');
const { state, review, selectRun, loadRuns, signOut, cancelRun, toggleExclusion, retryRun, sendFollowup, copyReport, renderAll } =
  main.__test;

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function freshUser(id: string): Promise<void> {
  state.user = user(id);
  state.run = null;
  state.runs = [];
  state.messages = [];
  state.activeRunId = null;
  renderAll();
}

function stubRun(runId: string): void {
  route = (url) => {
    if (url.includes(`/api/runs/${runId}?`)) {
      return jsonResponse({ run: makeView(runId), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
}

test('a late selection cannot replace a newer one', async () => {
  await freshUser('u-select');
  const gateA = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runA?')) {
      return gateA.promise.then(() => jsonResponse({ run: makeView('runA'), events: [], latestSeq: 0 }));
    }
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pendingA = selectRun('runA');
  await settle();
  await selectRun('runB');
  assert.equal(state.run?.runId, 'runB');
  gateA.resolve();
  await pendingA;
  assert.equal(state.run?.runId, 'runB');
});

test('a pending list cannot repopulate after logout', async () => {
  await freshUser('u-list');
  const gate = deferred<void>();
  route = (url) => {
    if (url.endsWith('/api/runs')) {
      return gate.promise.then(() =>
        jsonResponse({ runs: [{ runId: 'runA', question: 'q', state: 'completed', provider: 'github', revision: 1, createdAt: '', updatedAt: '', sourceCount: 1, reviewCount: 0 }] })
      );
    }
    return jsonResponse({});
  };
  const pending = loadRuns();
  state.user = null;
  gate.resolve();
  await pending;
  assert.equal(state.runs.length, 0);
});

test('cancel and retry responses for an abandoned run are ignored', async () => {
  await freshUser('u-cancel');
  state.run = makeView('runA');
  const gate = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runA/cancel')) {
      return gate.promise.then(() => jsonResponse({ run: makeView('runA', { state: 'cancelled' }) }));
    }
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pendingCancel = cancelRun();
  await settle();
  await selectRun('runB');
  gate.resolve();
  await pendingCancel;
  assert.equal(state.run?.runId, 'runB');

  const retryGate = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runB/retry')) {
      return retryGate.promise.then(() => jsonResponse({ run: makeView('child') }));
    }
    if (url.includes('/api/runs/runC?')) {
      return jsonResponse({ run: makeView('runC'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pendingRetry = retryRun();
  await settle();
  await selectRun('runC');
  retryGate.resolve();
  await pendingRetry;
  assert.equal(state.run?.runId, 'runC');
});

test('clipboard is not written for a run the user already left', async () => {
  await freshUser('u-copy');
  state.run = makeView('runA');
  env.clipboardWrites.length = 0;
  const gate = deferred<void>();
  route = (url) => {
    if (url.includes('/export')) return gate.promise.then(() => textResponse('# report'));
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    }
    return jsonResponse({});
  };
  const pending = copyReport();
  await settle();
  await selectRun('runB');
  gate.resolve();
  await pending;
  assert.equal(env.clipboardWrites.length, 0);
});

test('a failed sign-out keeps the session and surfaces an error', async () => {
  await freshUser('u-signout');
  route = (url) => {
    if (url.includes('/api/auth/sign-out')) return jsonResponse({ message: 'nope' }, 500);
    return jsonResponse({});
  };
  await signOut();
  assert.equal(state.user?.id, 'u-signout');
  assert.match(env.document.getElementById('toast')?.textContent ?? '', /退出失败/);
});

test('restore keeps focus on the source action inside the open drawer', async () => {
  await freshUser('u-focus');
  state.run = makeView('runA', { sources: [makeSource('S1', true)] });
  state.selectedSourceKey = 'S1';
  renderAll();
  (env.window.matchMedia as unknown as (q: string) => { matches: boolean }) = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }) as unknown as MediaQueryList;
  const drawer = env.document.getElementById('source-drawer') as HTMLDialogElement;
  drawer.showModal();
  route = (url) => {
    if (url.includes('/sources/S1/restore')) {
      return jsonResponse({ run: makeView('runA', { sources: [makeSource('S1', false)] }), changed: true });
    }
    return jsonResponse({});
  };
  await toggleExclusion('S1', false);
  const active = env.document.activeElement as HTMLElement | null;
  assert.ok(active, 'an element should have focus after restore');
  assert.ok(active.closest('#source-drawer'), 'focus must stay inside the open drawer');
  assert.equal(active.classList.contains('button'), true);
});

test('a followup response for an abandoned run is ignored', async () => {
  await freshUser('u-followup');
  state.run = makeView('runA', { provider: 'exa' });
  const gate = deferred<void>();
  route = (url) => {
    if (url.includes('/api/runs/runA/followup')) {
      return gate.promise.then(() => jsonResponse({ run: makeView('child', { provider: 'exa' }) }));
    }
    if (url.includes('/api/runs/runB?')) {
      return jsonResponse({ run: makeView('runB', { provider: 'exa' }), events: [], latestSeq: 0 });
    }
    if (url.endsWith('/api/runs')) return jsonResponse({ runs: [] });
    return jsonResponse({});
  };
  const pending = sendFollowup('还有哪些项目？');
  await settle();
  await selectRun('runB');
  gate.resolve();
  await pending;
  assert.equal(state.run?.runId, 'runB');
  assert.equal(state.messages.filter((message) => message.label === '子研究').length, 0);
});

test('stubRun keeps a completed run selected without opening a stream', async () => {
  await freshUser('u-stub');
  stubRun('runA');
  await selectRun('runA');
  assert.equal(state.run?.runId, 'runA');
  assert.equal(state.streamState, 'idle');
});

/* ---------------- review workbench session isolation ---------------- */

const REVIEW_PROGRESS = { total: 1, reviewed: 0, draft: 0, unreviewed: 1 };

function reviewItem(caseId: string): ReviewQueueItem {
  return {
    caseId,
    title: `案例 ${caseId}`,
    question: '这是问题吗？',
    badge: '合成练习 · 示例回答 · 待你判断',
    kind: 'practice',
    status: 'unreviewed',
    latestStatus: null,
    latestRevision: 0,
    sourceCount: 1,
    claimCount: 1,
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z'
  };
}

function reviewDetail(caseId: string): ReviewCaseDetail {
  return {
    caseId,
    datasetVersion: 'behavior-v1',
    split: 'discovery',
    kind: 'practice',
    title: `案例 ${caseId}`,
    question: '这是问题吗？',
    asOf: '2026-03-02',
    badge: '合成练习 · 示例回答 · 待你判断',
    rubricVersion: 1,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    status: 'unreviewed',
    latestRevision: 0,
    latestStatus: null,
    sources: [{ sourceId: 'S1', title: '证据', text: '正文', locator: null }],
    candidates: [
      { blindLabel: 'A', claims: [{ claimId: 'K1', text: '候选甲' }] },
      { blindLabel: 'B', claims: [{ claimId: 'K2', text: '候选乙' }] }
    ],
    claimIds: ['K1', 'K2'],
    provenance: null
  };
}

function reviewRoutes(prefix: string, extra?: (url: string) => Response | null): (url: string) => Response {
  return (url: string) => {
    if (url.includes('/api/review/cases?') || url.endsWith('/api/review/cases')) {
      return jsonResponse({ cases: [reviewItem(`${prefix}case`)], progress: REVIEW_PROGRESS });
    }
    if (url.includes(`/api/review/cases/${prefix}case/history`)) {
      return jsonResponse({ history: [], revisions: [] });
    }
    if (url.includes(`/api/review/cases/${prefix}case`)) {
      return jsonResponse({ case: reviewDetail(`${prefix}case`), annotation: null, history: [] });
    }
    const other = extra?.(url);
    if (other) return other;
    return jsonResponse({});
  };
}

test('sign-out clears the previous account review queue and case', async () => {
  await freshUser('review-A');
  review.reset();
  route = reviewRoutes('a');
  await review.open('acase');
  assert.equal(review.state.caseId, 'acase');
  assert.equal(env.document.querySelector('#view-review .review-case') !== null, true);

  await signOut();
  assert.equal(state.user, null);
  assert.equal(review.state.caseId, null);
  assert.equal(review.state.detail, null);
  assert.equal(review.state.queue.length, 0);
  assert.equal(env.document.querySelector('#view-review .review-case'), null);

  await freshUser('review-B');
  route = reviewRoutes('b');
  await review.open();
  assert.equal(review.state.caseId, 'bcase');
  assert.match(env.document.querySelector('#view-review')?.textContent ?? '', /案例 bcase/);
});

test('a late review load cannot repopulate state after account reset', async () => {
  await freshUser('review-C');
  review.reset();
  const gate = deferred<void>();
  route = (url: string) => {
    if (url.endsWith('/api/review/cases')) {
      return jsonResponse({ cases: [reviewItem('ccase')], progress: REVIEW_PROGRESS });
    }
    if (url.includes('/api/review/cases/ccase')) {
      return gate.promise.then(() =>
        jsonResponse({ case: reviewDetail('ccase'), annotation: null, history: [] })
      );
    }
    return jsonResponse({});
  };
  const pending = review.open('ccase');
  await settle();
  review.reset();
  gate.resolve();
  await pending;
  assert.equal(review.state.caseId, null);
  assert.equal(review.state.detail, null);
  assert.equal(env.document.querySelector('#view-review .review-case'), null);
});

test('a failed sign-out preserves review state and unsaved work', async () => {
  await freshUser('review-D');
  review.reset();
  route = reviewRoutes('d', (url) => {
    if (url.includes('/api/auth/sign-out')) return jsonResponse({ message: 'nope' }, 500);
    return null;
  });
  await review.open('dcase');
  assert.equal(review.state.caseId, 'dcase');
  review.state.dirty = true;

  await signOut();
  assert.equal(state.user?.id, 'review-D');
  assert.equal(review.state.caseId, 'dcase');
  assert.equal(review.state.dirty, true);
});

test('a malformed encoded review hash does not throw or leak state', async () => {
  await freshUser('review-E');
  review.reset();
  route = () =>
    jsonResponse({ cases: [], progress: { total: 0, reviewed: 0, draft: 0, unreviewed: 0 } });
  env.window.location.hash = '#/review/%E0%A4%A';
  await settle();
  assert.equal(review.state.caseId, null);
  assert.equal(review.state.queue.length, 0);
});

test('in-app navigation away from a dirty review asks and can be declined', async () => {
  await freshUser('review-H');
  review.reset();
  route = reviewRoutes('h');
  env.window.location.hash = '#/review/hcase';
  await settle();
  assert.equal(review.state.caseId, 'hcase');
  review.state.dirty = true;

  const originalConfirm = env.window.confirm;
  let asked = 0;
  env.window.confirm = () => {
    asked += 1;
    return false;
  };
  try {
    const before = env.window.location.hash;
    env.window.location.hash = '#/app';
    await settle();
    assert.equal(asked, 1);
    assert.equal(env.window.location.hash, before);
    assert.equal(review.state.caseId, 'hcase');
    assert.equal(review.state.dirty, true);
  } finally {
    env.window.confirm = originalConfirm;
  }
});

test('a stale 401 after account reset does not open sign-in for the new user', async () => {
  await freshUser('review-I');
  review.reset();
  const gate = deferred<Response>();
  route = (url: string) => {
    if (url.endsWith('/api/review/cases')) {
      return jsonResponse({ cases: [reviewItem('icase')], progress: REVIEW_PROGRESS });
    }
    if (url.includes('/api/review/cases/icase')) return gate.promise;
    return jsonResponse({});
  };
  const pending = review.open('icase');
  await settle();
  review.reset();
  await freshUser('review-J');

  const dialog = env.document.getElementById('auth-dialog');
  gate.resolve(jsonResponse({ error: { code: 'unauthorized', message: '请先登录。' } }, 401));
  await pending;
  await settle();
  assert.equal(review.state.caseId, null);
  assert.notEqual(dialog?.hasAttribute('open'), true);
});

test('an expired review session clears the previous account research state', async () => {
  await freshUser('review-K');
  review.reset();
  state.run = makeView('privateA');
  state.activeRunId = 'privateA';
  state.runs = [
    {
      runId: 'privateA',
      question: '问题 privateA',
      state: 'completed',
      provider: 'github',
      revision: 1,
      createdAt: '',
      updatedAt: '',
      sourceCount: 1,
      reviewCount: 0
    }
  ];
  state.messages = [{ role: 'user', label: '你', text: 'A 的追问' }];
  renderAll();

  route = (url: string) => {
    if (url.endsWith('/api/review/cases')) return jsonResponse({ error: { code: 'unauthorized' } }, 401);
    return jsonResponse({});
  };
  await review.open(null);
  await settle();

  assert.equal(state.run, null);
  assert.equal(state.activeRunId, null);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.messages, []);
  const appText = env.document.getElementById('view-app')?.textContent ?? '';
  assert.doesNotMatch(appText, /privateA/);
  assert.doesNotMatch(appText, /A 的追问/);
  assert.equal(env.document.getElementById('auth-dialog')?.hasAttribute('open'), true);
});

test('a direct auth-form account switch clears the previous research DOM immediately', async () => {
  await freshUser('review-L');
  const privateInputs = ['research-question', 'chat-input', 'resume-seed'];
  for (const id of privateInputs) {
    (env.document.getElementById(id) as HTMLInputElement).value = `privateL unsent ${id}`;
  }
  state.run = makeView('privateL');
  state.activeRunId = 'privateL';
  state.runs = [
    {
      runId: 'privateL',
      question: '问题 privateL',
      state: 'completed',
      provider: 'github',
      revision: 1,
      createdAt: '',
      updatedAt: '',
      sourceCount: 1,
      reviewCount: 0
    }
  ];
  renderAll();
  assert.match(env.document.getElementById('view-app')?.textContent ?? '', /privateL/);

  const runsGate = deferred<void>();
  route = (url: string) => {
    if (url.includes('/api/auth/sign-in/email')) {
      return jsonResponse({ user: { id: 'review-M', email: 'm@example.test', name: 'review-M' } });
    }
    if (url.endsWith('/api/runs')) {
      return runsGate.promise.then(() => jsonResponse({ runs: [] }));
    }
    return jsonResponse({});
  };
  env.document.getElementById('open-auth')!.click();
  const email = env.document.getElementById('auth-email') as HTMLInputElement;
  const password = env.document.getElementById('auth-password') as HTMLInputElement;
  email.value = 'm@example.test';
  password.value = 'password-1234';
  const form = env.document.getElementById('auth-form') as HTMLFormElement;
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();

  // Runs list is still pending, but the previous account's DOM must be gone.
  assert.equal(state.user?.id, 'review-M');
  const appText = env.document.getElementById('view-app')?.textContent ?? '';
  assert.doesNotMatch(appText, /privateL/);
  for (const id of privateInputs) {
    assert.equal((env.document.getElementById(id) as HTMLInputElement).value, '', `${id} must clear on identity switch`);
  }
  runsGate.resolve();
  await settle();
});

test('single person input submits without a provider and suppresses concurrent double clicks', async () => {
  await freshUser('person-entry');
  const gate = deferred<void>();
  const posted: unknown[] = [];
  route = (url, init) => {
    if (url === '/api/runs' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return gate.promise.then(() => jsonResponse({ run: makeView('person-created', { state: 'queued' }), idempotent: false }));
    }
    if (url.includes('/api/runs/person-created?')) return jsonResponse({ run: makeView('person-created', { state: 'queued' }), events: [], latestSeq: 0 });
    if (url === '/api/runs') return jsonResponse({ runs: [] });
    return jsonResponse({});
  };
  const input = env.document.getElementById('research-question') as HTMLTextAreaElement;
  input.value = 'https://example.org/person/synthetic';
  const form = env.document.getElementById('research-form')!;
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(posted, [{ input: 'https://example.org/person/synthetic' }]);
  gate.resolve();
  await settle();
  assert.equal(state.run?.runId, 'person-created');
  assert.equal(input.value, 'https://example.org/person/synthetic');
  assert.equal(env.document.querySelector('input[name="provider"]'), null);
});

test('needs_input stream preserves the new prompt and displays stored candidate choices', async () => {
  await freshUser('person-choice');
  const waiting = makeView('choice', { state: 'researching', identity: { displayName: '', handle: null, profileUrl: null, status: 'needs_input', note: null, candidates: [] } });
  route = () => jsonResponse({ run: waiting, events: [], latestSeq: 0 });
  await selectRun('choice');
  const { MockEventSource } = await import('./dom-env.js');
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('needs_input', { prompt: '你指的是哪位林舟？', candidates: [{ candidateId: 'candidate-a', label: '林舟', detail: '合成创作者', profileUrl: 'https://example.org/person/a' }] }, '2');
  assert.match(env.document.getElementById('needs-input-prompt')?.textContent ?? '', /哪位林舟/);
  const choice = env.document.querySelector<HTMLButtonElement>('[data-candidate-id="candidate-a"]');
  assert.ok(choice);
  assert.match(choice.getAttribute('aria-label') ?? '', /合成创作者/);
  state.run = null;
  stream.close();
});

test('retrying an uncertain person submission reuses its key and retains the input', async () => {
  await freshUser('person-retry');
  const keys: string[] = [];
  route = (url, init) => {
    if (url === '/api/runs' && init?.method === 'POST') {
      keys.push(new Headers(init.headers).get('idempotency-key') ?? '');
      if (keys.length === 1) throw new TypeError('connection lost');
      return jsonResponse({ run: makeView('recovered'), idempotent: true });
    }
    return jsonResponse({ runs: [] });
  };
  const input = env.document.getElementById('research-question') as HTMLTextAreaElement;
  input.value = '林舟 合成创作者';
  const form = env.document.getElementById('research-form')!;
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(input.value, '林舟 合成创作者');
  assert.match(env.document.getElementById('form-status')?.textContent ?? '', /不会重复创建/);
  form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(state.run?.runId, 'recovered');
});

test('candidate confirmation submits only the stored ID and displayed revision', async () => {
  await freshUser('person-confirm');
  const identity = { displayName: '', handle: null, profileUrl: null, status: 'ambiguous' as const, note: '请选择人物', candidates: [{ candidateId: 'c-stored', label: '林舟', detail: '创作者', profileUrl: 'https://example.org/person/a' }] };
  state.run = makeView('confirm', { state: 'needs_input', revision: 7, identity });
  state.activeRunId = 'confirm';
  renderAll();
  let resolution: unknown;
  route = (url, init) => {
    if (url.endsWith('/resume')) { resolution = JSON.parse(String(init?.body)); return jsonResponse({ run: makeView('confirm', { state: 'completed' }) }); }
    return jsonResponse({});
  };
  env.document.querySelector<HTMLButtonElement>('[data-candidate-id="c-stored"]')!.click();
  await settle();
  assert.deepEqual(resolution, { candidateId: 'c-stored', expectedRevision: 7 });
});

test('IME composition and repeated keyboard events do not start research', async () => {
  await freshUser('person-ime');
  let posts = 0;
  route = (_url, init) => { if (init?.method === 'POST') posts += 1; return jsonResponse({}); };
  const input = env.document.getElementById('research-question') as HTMLTextAreaElement;
  input.value = '林舟';
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true }));
  await settle();
  assert.equal(posts, 0);
});


test('a bookmarked person run is restored instead of the newest history item', async () => {
  await freshUser('person-bookmark');
  state.runs = [{ runId: 'newest', question: '新研究', state: 'completed', provider: 'github', revision: 1, createdAt: '', updatedAt: '', sourceCount: 0, reviewCount: 0 }];
  route = (url) => {
    const id = url.includes('/bookmarked?') ? 'bookmarked' : 'newest';
    return jsonResponse({ run: makeView(id), events: [], latestSeq: 0 });
  };
  env.window.location.hash = '#/app/bookmarked';
  await settle();
  assert.equal(state.run?.runId, 'bookmarked');
});

test('budget stopping explains retained results and labels uncertain cost', async () => {
  await freshUser('person-budget');
  state.run = { ...makeView('limited', { state: 'partial' }), research: { phase: 'finished', steps: 4, stopReason: 'budget_exhausted', budget: { toolCalls: 3, modelCalls: 2, estimatedUsd: 0.013, unknownCost: true, limits: { toolCalls: 12, modelCalls: 8 } } } } as CanonicalView;
  renderAll();
  assert.match(env.document.getElementById('run-status-summary')?.textContent ?? '', /达到预算/);
  const details = env.document.getElementById('research-details')?.textContent ?? '';
  assert.match(details, /读取 3 \/ 12 次/);
  assert.match(details, /估算/);
  assert.match(details, /部分费用尚未确认/);
  assert.equal((env.document.getElementById('activity-panel') as HTMLDetailsElement).hidden, false);
});


test('an older in-flight snapshot cannot erase a newer identity choice', async () => {
  await freshUser('person-snapshot-order');
  const initial = makeView('ordered', { state: 'researching', revision: 1 });
  const late = deferred<void>();
  let reads = 0;
  route = () => ++reads === 1
    ? jsonResponse({ run: initial, events: [], latestSeq: 0 })
    : late.promise.then(() => jsonResponse({ run: initial, events: [], latestSeq: 1 }));
  await selectRun('ordered');
  const { MockEventSource } = await import('./dom-env.js');
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('revision', { revision: 1 }, '1');
  await new Promise((resolve) => setTimeout(resolve, 120));
  stream.emit('needs_input', { prompt: '请选择新的候选人', revision: 2, candidates: [{ candidateId: 'new-person', label: '林舟', detail: '合成作者' }] }, '2');
  late.resolve();
  await settle();
  assert.equal(state.run?.state, 'needs_input');
  assert.equal(state.run?.revision, 2);
  assert.ok(env.document.querySelector('[data-candidate-id="new-person"]'));
  stream.close();
});
