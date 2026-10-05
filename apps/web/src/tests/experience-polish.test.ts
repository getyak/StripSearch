/**
 * Experience polish (GET-132) integration tests against the real main
 * controller: workspace toolbar, native-dialog local search/navigation,
 * citation inspection with safe return-to-original-citation, polling focus
 * stability and restrained reduced-motion behaviour. Fully offline.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView, SessionUser } from '../shared/types.js';
import { installDom, installFetch, jsonResponse, MockEventSource } from './dom-env.js';

const env = installDom();

function user(id: string): SessionUser {
  return { id, email: `${id}@example.test`, name: id };
}

function makeSource(
  sourceKey: string,
  overrides: Partial<CanonicalView['sources'][number]> = {}
): CanonicalView['sources'][number] {
  return {
    sourceKey,
    url: `https://example.test/${sourceKey.toLowerCase()}`,
    title: `来源 ${sourceKey}`,
    kind: 'work',
    publishedAt: null,
    retrievedAt: '2024-01-01T00:00:00.000Z',
    fetchStatus: 'ok',
    excerpt: '短摘录',
    excerptLocator: '摘录',
    identityLabel: '未确认',
    identityConfirmed: false,
    limits: [],
    excluded: false,
    excludedAt: null,
    ...overrides
  };
}

function makeView(runId: string, overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    state: 'completed',
    revision: 1,
    question: `问题 ${runId}`,
    seedUrl: 'https://example.test/profile',
    provider: 'exa',
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
    sources: [makeSource('S1', { title: 'Lantern 2025.06 更新记录' }), makeSource('S2', { title: '第三方评价摘录' })],
    observations: [],
    answer: [
      {
        id: 'facts',
        heading: '查到的事实',
        body: '',
        bullets: [
          { text: '事实一', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null },
          { text: '事实二', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null }
        ]
      }
    ],
    limitations: [],
    usage: { provider: 'exa', requests: 1, bytes: 1, elapsedMs: 1, measurement: 'observed' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

type RouteHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let route: RouteHandler = () => jsonResponse({});
installFetch((url, init) => route(url, init));

const main = await import('../client/main.js');
const { state, selectRun, loadRuns, signOut, deleteRun, applySnapshot, renderAll, localSearch, citationReturn } =
  main.__test;

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function summary(runId: string, question = `问题 ${runId}`) {
  return {
    runId,
    question,
    state: 'completed' as const,
    provider: 'exa' as const,
    revision: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    sourceCount: 2,
    reviewCount: 0
  };
}

async function freshUser(id: string, runs: ReturnType<typeof summary>[] = []): Promise<void> {
  localSearch.reset();
  citationReturn.clear();
  state.user = user(id);
  state.runs = runs;
  state.run = null;
  state.activeRunId = null;
  state.messages = [];
  state.events = [];
  state.selectedSourceKey = null;
  renderAll();
  await settle();
}

function workBody(): HTMLElement {
  return env.document.getElementById('work-body') as HTMLElement;
}

function searchInput(): HTMLInputElement {
  return env.document.getElementById('search-input') as HTMLInputElement;
}

function typeSearch(value: string): void {
  searchInput().value = value;
  searchInput().dispatchEvent(new env.window.Event('input'));
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new env.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

function resultTexts(): string[] {
  return [...env.document.querySelectorAll('.search-result')].map((node) => node.textContent ?? '');
}

/* ---------------- toolbar ---------------- */

test('the reading toolbar keeps common actions clear and moves low-frequency actions into one menu', () => {
  const actions = env.document.querySelector('.work-actions');
  assert.ok(actions);
  for (const id of ['new-research', 'open-search', 'stop-run']) {
    const button = env.document.getElementById(id);
    assert.ok(button, `missing #${id}`);
    assert.equal(button.closest('.work-actions'), actions, `#${id} stays in the toolbar`);
    assert.equal(button.closest('#more-menu'), null, `#${id} must not hide in the overflow menu`);
  }
  for (const id of [
    'download-html', 'download-pdf', 'download-json', 'download-md',
    'copy-report', 'retry-run', 'delete-run', 'app-return-home'
  ]) {
    const button = env.document.getElementById(id);
    assert.ok(button, `missing #${id}`);
    assert.ok(button.closest('#more-menu'), `#${id} is collected in the accessible action area`);
  }
  for (const id of ['toggle-inspector', 'open-mobile-sources', 'open-mobile-history']) {
    assert.ok(env.document.getElementById(id), `missing source/history entry #${id}`);
  }
  assert.equal(env.document.getElementById('open-search')?.getAttribute('aria-haspopup'), 'dialog');
});

/* ---------------- local search / navigation ---------------- */

test('Cmd/Ctrl+K local search covers loaded history and current sources only', async () => {
  await freshUser('search-a', [summary('runA', '林舟的公开作品')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();
  env.document.body.dataset.view = 'app';

  env.window.dispatchEvent(keydown({ key: 'k', ctrlKey: true }));
  assert.equal(localSearch.isOpen(), true);
  assert.equal(localSearch.resultCount(), 3, 'one history row + two loaded sources');

  typeSearch('lantern');
  assert.deepEqual(resultTexts().map((text) => text.includes('Lantern 2025.06 更新记录')), [true]);
  typeSearch('不存在的关键词');
  assert.equal(localSearch.resultCount(), 0);
  assert.match(env.document.getElementById('search-empty')?.textContent ?? '', /没有匹配/);

  // Composition and key repeat must never open the dialog over the user's typing.
  assert.equal(localSearch.handleKeyDown(keydown({ key: 'k', ctrlKey: true, isComposing: true })), false);
  assert.equal(localSearch.handleKeyDown(keydown({ key: 'k', ctrlKey: true, repeat: true })), false);
  localSearch.close();
  await settle();
  assert.equal(localSearch.isOpen(), false);
  env.document.body.dataset.view = 'home';
});

test('search meta carries withdrawn, truncated and unconfirmed status for cached excerpts', async () => {
  await freshUser('search-b', [summary('runB', '状态标注检查')]);
  state.run = makeView('runB', {
    sources: [
      makeSource('S1', { excluded: true, excludedAt: '2024-01-02T00:00:00.000Z', excerpt: '缓存摘录一' }),
      makeSource('S2', { fetchStatus: 'truncated', excerpt: '缓存摘录二' }),
      makeSource('S3', { identityConfirmed: true, excerpt: '缓存摘录三' })
    ]
  });
  state.activeRunId = 'runB';
  renderAll();
  localSearch.open();
  const texts = resultTexts();
  assert.ok(texts.some((text) => text.includes('已不采用') && text.includes('缓存摘录一')), 'withdrawn status is shown');
  assert.ok(texts.some((text) => text.includes('被截断') && text.includes('缓存摘录二')), 'truncated status is shown');
  const confirmed = texts.find((text) => text.includes('缓存摘录三'));
  assert.ok(confirmed, 'third source is listed');
  assert.ok(confirmed.includes('已读取'));
  assert.equal(confirmed.includes('归属未确认'), false, 'confirmed attribution is not flagged');
  localSearch.close();
  await settle();
});

test('search sources are gated to the active and rendered report', async () => {
  await freshUser('search-c', [summary('runA'), summary('runB')]);
  state.run = makeView('runA');
  state.activeRunId = 'runB'; // navigation target differs from the rendered report
  renderAll();
  localSearch.open();
  assert.equal(localSearch.resultCount(), 2, 'history rows only: runA sources are not exposed');
  typeSearch('Lantern');
  assert.equal(localSearch.resultCount(), 0);

  state.activeRunId = 'runA';
  renderAll();
  typeSearch('Lantern');
  assert.equal(localSearch.resultCount(), 1, 'sources appear only for the active + rendered report');
  localSearch.close();
  await settle();
});

test('search selection uses the existing citation location and history route', async () => {
  await freshUser('search-d', [summary('runA'), summary('runB', '路线检查')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();
  route = (url) => {
    if (url.includes('/api/runs/runB?')) return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    return jsonResponse({});
  };

  localSearch.open();
  typeSearch('第三方');
  const sourceResult = env.document.querySelector<HTMLButtonElement>('.search-result');
  assert.ok(sourceResult);
  sourceResult.click();
  await settle();
  assert.equal(state.selectedSourceKey, 'S2', 'source selection goes through the existing citation location');
  assert.match(env.document.getElementById('inspector-detail')?.textContent ?? '', /第三方评价摘录/);

  localSearch.open();
  typeSearch('路线检查');
  const historyResult = env.document.querySelector<HTMLButtonElement>('.search-result');
  assert.ok(historyResult);
  historyResult.click();
  await settle();
  assert.equal(env.window.location.hash, '#/app/runB', 'history selection uses the existing route');
  assert.equal(state.run?.runId, 'runB');
});

test('run switch drops old search sources immediately and sign-out clears results', async () => {
  await freshUser('search-e', [summary('runA'), summary('runB')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();
  route = (url) => {
    if (url.includes('/api/runs/runB?')) return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    if (url.includes('/api/auth/sign-out')) return jsonResponse({});
    return jsonResponse({});
  };

  localSearch.open();
  typeSearch('Lantern');
  assert.equal(localSearch.resultCount(), 1);

  const pending = selectRun('runB');
  assert.equal(localSearch.resultCount(), 0, 'old report sources vanish the moment navigation starts');
  await pending;
  assert.equal(state.run?.runId, 'runB');
  localSearch.refresh();
  typeSearch('Lantern');
  assert.equal(localSearch.resultCount(), 1, 'the new report sources replace them after the switch');

  typeSearch('私密查询');
  await signOut();
  assert.equal(localSearch.isOpen(), false, 'sign-out closes the dialog');
  assert.equal(localSearch.query(), '', 'sign-out clears the typed query');
  assert.equal(localSearch.resultCount(), 0, 'sign-out clears rendered results');
});

/* ---------------- citation inspection ---------------- */

function secondCitation(): HTMLButtonElement {
  const button = env.document.querySelector<HTMLButtonElement>('button.citation[data-citation-anchor="s0b1c0"]');
  assert.ok(button, 'second S1 citation rendered');
  return button;
}

test('citation inspection returns to the exact sentence with focus and reading position', async () => {
  await freshUser('cite-a', [summary('runA')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();

  workBody().scrollTop = 320;
  secondCitation().click();
  assert.equal(state.selectedSourceKey, 'S1');
  const detail = env.document.getElementById('inspector-detail') as HTMLElement;
  assert.equal(env.document.activeElement, detail, 'focus lands on the located source');
  const returnButton = detail.querySelector<HTMLButtonElement>('.return-citation');
  assert.ok(returnButton, 'explicit return action is offered after a citation click');

  workBody().scrollTop = 900;
  returnButton.click();
  assert.equal(env.document.activeElement, secondCitation(), 'focus returns to the exact entered citation');
  assert.equal(workBody().scrollTop, 320, 'the reading position is restored');

  // Consecutive checks of another citation re-arm the return for that one.
  const first = env.document.querySelector<HTMLButtonElement>('button.citation[data-citation-anchor="s0b0c0"]');
  assert.ok(first);
  workBody().scrollTop = 120;
  first.click();
  const nextReturn = env.document.querySelector<HTMLButtonElement>('#inspector-detail .return-citation');
  assert.ok(nextReturn);
  nextReturn.click();
  assert.equal(env.document.activeElement, first, 'consecutive checks return to the latest entered citation');
  assert.equal(workBody().scrollTop, 120);
});

test('stale citation returns are cleared on re-render removal, report switch and deletion', async () => {
  await freshUser('cite-b', [summary('runA'), summary('runB')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();
  secondCitation().click();
  assert.ok(env.document.querySelector('#inspector-detail .return-citation'));

  // Same report, but the entered citation's bullet disappeared from the view.
  applySnapshot(
    makeView('runA', {
      answer: [
        {
          id: 'facts',
          heading: '查到的事实',
          body: '',
          bullets: [{ text: '事实一', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null }]
        }
      ]
    }),
    [],
    0
  );
  assert.equal(citationReturn.entry(), null, 'a removed citation never keeps a return record');
  assert.equal(env.document.querySelector('#inspector-detail .return-citation'), null);

  // Restore the full report: the same anchors come back for the same content.
  applySnapshot(makeView('runA'), [], 0);
  secondCitation().click();
  assert.ok(citationReturn.entry());
  route = (url) => {
    if (url.includes('/api/runs/runB?')) return jsonResponse({ run: makeView('runB'), events: [], latestSeq: 0 });
    return jsonResponse({});
  };
  await selectRun('runB');
  assert.equal(citationReturn.entry(), null, 'report switch drops the stale return');
  assert.equal(env.document.querySelector('#inspector-detail .return-citation'), null);

  secondCitation().click();
  assert.ok(citationReturn.entry());
  route = (url, init) => {
    if (init?.method === 'DELETE') return jsonResponse({});
    if (url.endsWith('/api/runs')) return jsonResponse({ runs: [] });
    return jsonResponse({});
  };
  await deleteRun();
  assert.equal(citationReturn.entry(), null, 'deletion drops the stale return');
});

test('the mobile drawer closes before returning so focus is never trapped behind the modal', async () => {
  await freshUser('cite-c', [summary('runA')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();

  const originalMedia = env.window.matchMedia;
  (env.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes('max-width: 1220px'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  });

  // Real browsers queue dialog close events: patch the prototype accordingly.
  const dialogProto = (
    env.window as unknown as { HTMLDialogElement: { prototype: Record<string, unknown> } }
  ).HTMLDialogElement.prototype;
  const syncClose = dialogProto.close;
  const queued: (() => void)[] = [];
  dialogProto.close = function (this: { removeAttribute(n: string): void; dispatchEvent(e: unknown): boolean }): void {
    this.removeAttribute('open');
    queued.push(() => this.dispatchEvent(new env.window.Event('close')));
  };

  try {
    workBody().scrollTop = 210;
    secondCitation().click();
    const drawer = env.document.getElementById('source-drawer') as HTMLDialogElement;
    assert.equal(drawer.hasAttribute('open'), true, 'the mobile source drawer is open');
    const returnButton = env.document.querySelector<HTMLButtonElement>('#drawer-source-detail .return-citation');
    assert.ok(returnButton, 'the return action lives inside the drawer on mobile');

    workBody().scrollTop = 777;
    returnButton.click();
    assert.equal(drawer.hasAttribute('open'), false, 'the modal closes before focus moves');
    assert.equal(env.document.activeElement, secondCitation(), 'focus reaches the citation, not an inert background');
    assert.equal(workBody().scrollTop, 210);

    // The delayed close event must not override the citation focus.
    for (const task of queued.splice(0)) task();
    await settle();
    assert.equal(env.document.activeElement, secondCitation(), 'a delayed close cannot steal the restored focus');
  } finally {
    dialogProto.close = syncClose;
    (env.window as unknown as { matchMedia: unknown }).matchMedia = originalMedia;
  }
});

/* ---------------- polling focus stability + reduced motion ---------------- */

test('polling re-renders keep focus on the same citation and never chase reports', async () => {
  await freshUser('focus-a', [summary('runA'), summary('runB')]);
  state.run = makeView('runA', { state: 'researching' });
  state.activeRunId = 'runA';
  renderAll();
  secondCitation().focus();

  renderAll(); // what a snapshot refresh does
  assert.equal(
    env.document.activeElement?.getAttribute('data-citation-anchor'),
    's0b1c0',
    'focus stays on the same semantic citation after re-render'
  );

  secondCitation().focus();
  applySnapshot(makeView('runB'), [], 0);
  assert.notEqual(
    env.document.activeElement?.getAttribute('data-citation-anchor'),
    's0b1c0',
    'a different report never receives the old anchor focus'
  );

  // Streaming events drive the same render path and must not steal focus either.
  secondCitation().focus();
  const stream = MockEventSource.instances.at(-1);
  if (stream && !stream.closed) {
    stream.emit('answer', { sections: makeView('runB').answer }, '9');
    await settle();
    assert.equal(env.document.activeElement?.getAttribute('data-citation-anchor'), 's0b1c0');
    stream.close();
  } else {
    renderAll();
    assert.equal(env.document.activeElement?.getAttribute('data-citation-anchor'), 's0b1c0');
  }
});

test('reduced motion suppresses controller motion while keeping focus returns usable', async () => {
  await freshUser('motion-a', [summary('runA')]);
  state.run = makeView('runA');
  state.activeRunId = 'runA';
  renderAll();
  const originalMedia = env.window.matchMedia;
  (env.window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  });
  try {
    workBody().scrollTop = 55;
    secondCitation().click();
    const detail = env.document.getElementById('inspector-detail') as HTMLElement;
    assert.equal(detail.classList.contains('emphasis'), false, 'no motion class under reduced motion');
    localSearch.open();
    assert.equal(
      env.document.querySelector('.search-result.enter'),
      null,
      'search results render without entrance animation'
    );
    localSearch.close();
    await settle();
    const returnButton = detail.querySelector<HTMLButtonElement>('.return-citation');
    assert.ok(returnButton);
    workBody().scrollTop = 999;
    returnButton.click();
    assert.equal(env.document.activeElement, secondCitation(), 'focus return still works with motion off');
    assert.equal(workBody().scrollTop, 55);
  } finally {
    (env.window as unknown as { matchMedia: unknown }).matchMedia = originalMedia;
  }
});

/* ---------------- author-level contracts ---------------- */

test('the stylesheet keeps motion restrained and reduced-motion safe', () => {
  const css = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');
  assert.equal(/transition:\s*all/.test(css), false, 'no transition: all');
  assert.equal(/animation[^;{}]*infinite/.test(css), false, 'no infinite loops');
  assert.equal(/backdrop-filter|filter:\s*blur/.test(css), false, 'no large-area blur');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /scroll-behavior: auto/);
  assert.match(css, /\.search-result\b/, 'search results are styled');
  assert.match(css, /\.return-citation\b/, 'the return action is styled');
  assert.match(css, /body\[data-view="home"\]/, 'homepage theme remains scoped to the home view');
  assert.doesNotMatch(css, /campaign/, 'the abandoned campaign styling is gone');
});

test('the page ships no external fonts or frameworks', () => {
  const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('fonts.googleapis'), false);
  assert.equal(html.includes('fonts.gstatic'), false);
  assert.equal(/<script[^>]+src="https?:/.test(html), false);
  assert.match(html, /id="search-dialog"/, 'native dialog markup exists');
  assert.match(html, /id="open-search"/);
  assert.match(html, /已加载的历史报告与当前报告来源/, 'the search scope is stated in the interface');
});

test('search results travel with honest status instead of presenting cached excerpts as evidence', async () => {
  await freshUser('uncertainty-a', [summary('runA')]);
  state.run = makeView('runA', {
    sources: [makeSource('S1', { fetchStatus: 'inaccessible', excerpt: '缓存的旧摘录' })]
  });
  state.activeRunId = 'runA';
  renderAll();
  localSearch.open();
  const texts = resultTexts();
  assert.ok(
    texts.some((text) => text.includes('未能读取') && text.includes('缓存的旧摘录')),
    'inaccessible status travels with the cached excerpt'
  );
  localSearch.close();
  await settle();
});

// Independent review regressions: preserve the control the reader is using,
// and never let an earlier native close event consume a new drawer's focus.
test('snapshot refresh preserves source detail controls for the same source', async () => {
  await freshUser('detail-focus', [summary('runA')]);
  state.run = makeView('runA'); state.activeRunId = 'runA'; renderAll();
  secondCitation().click();
  for (const action of ['return', 'url', 'exclude']) {
    const selector = `#inspector-detail [data-source-focus="${action}"]`;
    (env.document.querySelector(selector) as HTMLElement).focus();
    renderAll();
    assert.equal(env.document.activeElement, env.document.querySelector(selector));
  }
});

test('observation disclosure stays open across refresh and explicit return reveals its citation', async () => {
  await freshUser('observation-focus', [summary('runA')]);
  state.run = makeView('runA', { observations: [{ observationId: 'O1', statement: '合成观察', kind: 'factual',
    sourceKeys: ['S1'], limitations: [], validity: 'valid', reviewReason: null }] });
  state.activeRunId = 'runA'; renderAll();
  (env.document.querySelector('.report-observations') as HTMLDetailsElement).open = true;
  (env.document.querySelector('[data-citation-anchor="o0c0"]') as HTMLButtonElement).click();
  renderAll();
  assert.equal((env.document.querySelector('.report-observations') as HTMLDetailsElement).open, true);
  (env.document.querySelector('.report-observations') as HTMLDetailsElement).open = false;
  (env.document.querySelector('#inspector-detail .return-citation') as HTMLButtonElement).click();
  assert.equal((env.document.querySelector('.report-observations') as HTMLDetailsElement).open, true);
  assert.equal(env.document.activeElement?.getAttribute('data-citation-anchor'), 'o0c0');
});

test('mobile toolbar reopening records its own opener and ignores stale queued drawer closes', async () => {
  await freshUser('drawer-generation', [summary('runA')]);
  state.run = makeView('runA'); state.activeRunId = 'runA'; renderAll();
  const originalMedia = env.window.matchMedia;
  env.window.matchMedia = (query: string) => ({ matches: query.includes('max-width: 1220px'), media: query,
    onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  const proto = (env.window as unknown as { HTMLDialogElement: { prototype: Record<string, unknown> } }).HTMLDialogElement.prototype;
  const originalClose = proto.close; const queued: (() => void)[] = [];
  proto.close = function(this: HTMLDialogElement) { this.removeAttribute('open'); queued.push(() => this.dispatchEvent(new env.window.Event('close'))); };
  const opener = env.document.getElementById('open-mobile-sources') as HTMLButtonElement;
  const drawer = env.document.getElementById('source-drawer') as HTMLDialogElement;
  const close = drawer.querySelector<HTMLButtonElement>('[data-close-source]')!;
  try {
    secondCitation().click(); close.click();
    for (const task of queued.splice(0)) task();
    opener.click();
    assert.equal(drawer.querySelector('.return-citation'), null, 'toolbar entry has no stale return action');
    close.click();
    for (const task of queued.splice(0)) task();
    assert.equal(env.document.activeElement, opener, 'toolbar entry replaces the old citation entry');
    opener.click(); close.click(); opener.click();
    const detail = env.document.getElementById('drawer-source-detail') as HTMLElement;
    detail.focus();
    for (const task of queued.splice(0)) task();
    assert.equal(env.document.activeElement, detail, 'old close cannot change the newly opened drawer focus');
    close.click(); for (const task of queued.splice(0)) task();
    assert.equal(env.document.activeElement, opener);
  } finally { proto.close = originalClose; env.window.matchMedia = originalMedia; }
});
