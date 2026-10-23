import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView, RunEventRecord, SessionUser } from '../shared/types.js';
import { deriveResearchLoading, researchGapText } from '../client/research-loading.js';
import type { StageView } from '../client/render.js';
import { installDom, installFetch, jsonResponse, MockEventSource } from './dom-env.js';

const env = installDom();

type RouteHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let route: RouteHandler = () => jsonResponse({});
const apiCalls: string[] = [];
installFetch((url, init) => {
  apiCalls.push(`${init?.method ?? 'GET'} ${url}`);
  return route(url, init);
});

const main = await import('../client/main.js');
const { state, selectRun, applySnapshot, renderAll } = main.__test;

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function user(id: string): SessionUser {
  return { id, email: `${id}@example.test`, name: id };
}

function source(key: string, overrides: Partial<CanonicalView['sources'][number]> = {}): CanonicalView['sources'][number] {
  return {
    sourceKey: key,
    url: `https://example.org/${key.toLowerCase()}`,
    title: `合成来源 ${key}`,
    kind: 'work',
    publishedAt: null,
    retrievedAt: '2026-10-21T00:00:00.000Z',
    fetchStatus: 'ok',
    excerpt: '原文片段',
    excerptLocator: '正文',
    identityLabel: '未确认',
    identityConfirmed: false,
    limits: [],
    excluded: false,
    excludedAt: null,
    ...overrides
  };
}

function researchMeta(phase: string, stopReason: string | null = null): NonNullable<CanonicalView['research']> {
  return {
    phase,
    steps: 1,
    budget: {
      toolCalls: 1,
      modelCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
      firecrawlCredits: 0,
      unknownCost: false,
      limits: { toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 }
    },
    stopReason,
    unresolved: []
  };
}

function makeView(runId: string, overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    state: 'researching',
    revision: 1,
    question: '林舟 合成创作者',
    seedUrl: 'https://example.org/linzhou',
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    interrupted: false,
    stopReason: null,
    identity: {
      displayName: '林舟',
      handle: 'linzhou',
      profileUrl: 'https://example.org/linzhou',
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [],
    observations: [],
    answer: [],
    limitations: [],
    usage: { provider: 'research', requests: 0, bytes: 0, elapsedMs: null, measurement: 'not_run' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

async function freshUser(id: string): Promise<void> {
  state.user = user(id);
  state.run = null;
  state.runs = [];
  state.messages = [];
  state.events = [];
  state.stages = [];
  state.latestSeq = 0;
  state.activeRunId = null;
  state.selectedSourceKey = null;
  renderAll();
  await settle();
}

function surface(): HTMLElement {
  return env.document.getElementById('research-live') as HTMLElement;
}

function el<T extends HTMLElement>(id: string): T {
  return env.document.getElementById(id) as T;
}

/** Question lines the reader can actually see inside the work body. */
function visibleQueryCount(): number {
  return [...env.document.querySelectorAll('#work-body .report-question')].filter((node) => {
    let element: HTMLElement | null = node as HTMLElement;
    while (element && element.id !== 'work-body') {
      if (element.hidden) return false;
      element = element.parentElement;
    }
    return true;
  }).length;
}

function stageEvent(seq: number, key: string, label: string): RunEventRecord {
  return { seq, type: 'stage', payload: { index: seq - 1, total: 0, key, label, status: 'active' }, createdAt: '' };
}

/* ---------------- queued & researching composition ---------------- */

test('queued research shows the input once with a semantic path and no fake progress', async () => {
  await freshUser('load-queued');
  applySnapshot(makeView('run-queued', { state: 'queued' }), [], 0);
  const live = surface();
  assert.equal(live.hidden, false, 'the live surface owns the queued composition');
  assert.match(live.textContent ?? '', /已排队/);
  assert.equal(visibleQueryCount(), 1, 'the input appears exactly once');
  assert.match(live.textContent ?? '', /林舟 合成创作者/);
  // Old duplicate request/status/activity shells stay out of the live surface.
  assert.equal(el('run-status-summary').hidden, true);
  assert.equal(el('activity-panel').hidden, true);
  assert.equal((env.document.querySelector('#work-body > .request-message') as HTMLElement).hidden, true);
  assert.equal(el('report').hidden, true, 'no mostly-empty report shell while nothing has arrived');
  assert.equal(el('chat-dock').hidden, true, 'no disabled follow-up dock while nothing supports it');
  // Never a percentage, a step ratio or an elapsed milestone.
  assert.doesNotMatch(live.textContent ?? '', /%|\d+\s*\/\s*\d+|分钟|小时/);
  assert.equal(live.querySelectorAll('[role="progressbar"]').length, 0);
  // The path is semantic current/upcoming only — nothing marked completed.
  const steps = [...live.querySelectorAll<HTMLElement>('.stage-path li')];
  assert.ok(steps.length >= 2, 'a restrained path is shown');
  assert.equal(steps[0]?.dataset.status, 'current');
  assert.ok(steps.slice(1).every((step) => step.dataset.status === 'upcoming'));
  assert.doesNotMatch(live.textContent ?? '', /已完成/);
  // Cancel stays reachable while active.
  const stop = el<HTMLButtonElement>('stop-run');
  assert.equal(stop.hidden, false);
  assert.equal(stop.disabled, false);
});

test('researching derives the actual current action and marks no earlier stage done', async () => {
  await freshUser('load-phase');
  applySnapshot(makeView('run-phase', { state: 'researching', research: researchMeta('verifying') }), [], 0);
  const live = surface();
  assert.equal(live.hidden, false);
  assert.equal(live.querySelector('.research-live-heading')?.textContent, '正在独立核验断言与出处');
  const labels = [...live.querySelectorAll('.stage-path li')].map((node) => node.textContent ?? '');
  assert.ok(labels.some((text) => text.includes('核验陈述与出处')));
  assert.ok(labels.some((text) => text.includes('整理有出处的发现')));
  assert.equal(live.querySelectorAll('.stage-path li[data-status="current"]').length, 1);
  assert.doesNotMatch(live.textContent ?? '', /已完成|%/, 'previous stages are never declared finished from the phase alone');
  assert.equal(visibleQueryCount(), 1);
});

/* ---------------- progressive material arrival ---------------- */

test('received material arrives progressively, stays readable and inspectable', async () => {
  await freshUser('load-progressive');
  const run = makeView('run-live', { state: 'researching', research: researchMeta('reading') });
  route = (url) => (url.includes('/api/runs/run-live?')
    ? jsonResponse({ run, events: [], latestSeq: 0 })
    : jsonResponse({ runs: [] }));
  await selectRun('run-live');
  const stream = MockEventSource.instances.at(-1)!;

  stream.emit('source', source('S9', { title: 'Lantern 更新记录' }), '1');
  await settle();
  assert.match(surface().textContent ?? '', /Lantern 更新记录/, 'the actual received title is shown');
  assert.match(surface().textContent ?? '', /已读取 1 条来源/);
  assert.equal(el('report').hidden, true, 'no empty report shell before content exists');

  stream.emit('observation', { statement: '更新记录宣布了离线阅读。', kind: 'page_statement', sourceKeys: ['S9'] }, '2');
  stream.emit('answer', {
    sections: [{ id: 'work', heading: '作品与行动', body: '', bullets: [{ text: '新增离线阅读与本地索引。', sourceKeys: ['S9'], kind: 'factual' }] }]
  }, '3');
  await settle();
  const report = el('report');
  assert.equal(report.hidden, false, 'partial content stays readable while research runs');
  assert.match(report.textContent ?? '', /新增离线阅读与本地索引/);
  assert.equal(report.querySelector('.report-header'), null, 'the live surface owns the heading while active');
  assert.equal(visibleQueryCount(), 1, 'the input is still shown exactly once');

  // The real received source is inspectable through the existing inspector.
  surface().querySelector<HTMLButtonElement>('.live-material')!.click();
  assert.match(el('inspector-detail').textContent ?? '', /Lantern 更新记录/);

  // Surface refreshes never steal focus from a focused material row.
  const row = surface().querySelector<HTMLButtonElement>('.live-material')!;
  row.focus();
  stream.emit('stage', stageEvent(4, 'read', '读取相关资料'), '4');
  await settle();
  assert.equal(env.document.activeElement, surface().querySelector('.live-material'));
  stream.close();
});

/* ---------------- needs_input over stale active stages ---------------- */

test('needs_input stops the busy surface immediately even with old active stage events', async () => {
  await freshUser('load-needs');
  const run = makeView('run-needs', { state: 'researching', provider: 'exa', research: researchMeta('identity') });
  route = (url) => (url.includes('/api/runs/run-needs?')
    ? jsonResponse({ run, events: [stageEvent(1, 'read', '读取相关资料'), stageEvent(2, 'verify', '核验引文与陈述')], latestSeq: 2 })
    : jsonResponse({ runs: [] }));
  await selectRun('run-needs');
  assert.equal(surface().hidden, false);
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('needs_input', { prompt: '请选择要研究的人。', candidates: [] }, '3');
  await settle();

  assert.equal(surface().dataset.mode, 'needs_input');
  assert.equal(surface().dataset.busy, 'false');
  assert.equal(surface().hidden, true, 'the busy loading surface leaves immediately');
  assert.equal(el('activity-panel').hidden, true, 'stale active stage events cannot keep a busy shell alive');
  assert.equal(el('run-indicator').hidden, true);
  const needs = el('needs-input-panel');
  assert.equal(needs.hidden, false, 'the person/scope decision is the next step');
  assert.ok(el('work-body').classList.contains('awaiting-decision'));
  assert.equal(el('chat-dock').hidden, true);
  stream.close();
});

test('research provider needs_input yields to the existing person confirmation workspace', async () => {
  await freshUser('load-needs-first-step');
  applySnapshot(
    makeView('run-first-step', { state: 'needs_input', provider: 'research' }),
    [stageEvent(1, 'read', '读取相关资料')],
    1
  );
  assert.equal(surface().hidden, true);
  assert.equal(surface().dataset.busy, 'false');
  assert.equal(el('first-step-panel').hidden, false, 'GET-213 person confirmation stays the decision UI');
  assert.equal(el('needs-input-panel').hidden, true);
  assert.equal(el('activity-panel').hidden, true);
  assert.equal(el('chat-dock').hidden, true);
  // The confirmation workspace owns the screen; the old request shell stays hidden.
  assert.equal((env.document.querySelector('#work-body > .request-message') as HTMLElement).hidden, true);
});

/* ---------------- terminal outcomes & recovery ---------------- */

test('terminal outcomes exit loading with truthful context and no automatic retry', async () => {
  await freshUser('load-terminal');
  applySnapshot(
    makeView('run-failed', { state: 'failed', stopReason: 'outcome_unknown', answer: [], sources: [source('S1')] }),
    [stageEvent(1, 'read', '读取相关资料')],
    1
  );
  assert.equal(surface().hidden, true, 'failure exits the loading surface');
  const summary = el('run-status-summary');
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent ?? '', /结果尚未确认/);
  assert.match(el('report').textContent ?? '', /已保留 1 个来源/);
  const retry = el<HTMLButtonElement>('retry-run');
  assert.equal(retry.hidden, false, 'the existing recovery action stays reachable');
  await settle();
  assert.equal(
    apiCalls.filter((call) => call.includes('/retry')).length,
    0,
    'an uncertain paid outcome is never retried automatically'
  );

  applySnapshot(makeView('run-partial', {
    state: 'partial',
    sources: [source('S2')],
    answer: [{ id: 'work', heading: '作品与行动', body: '保留下来的发现。', bullets: [] }]
  }), [], 0);
  assert.equal(surface().hidden, true);
  assert.match(el('run-status-summary').textContent ?? '', /已保留|部分/);
  assert.equal(el('report').hidden, false);
  assert.match(el('report').textContent ?? '', /保留下来的发现/);

  applySnapshot(makeView('run-cancelled', { state: 'cancelled', answer: [] }), [], 0);
  assert.equal(surface().hidden, true);
  assert.match(el('run-status-summary').textContent ?? '', /已停止|已取消/);

  applySnapshot(makeView('run-interrupted', { state: 'failed', interrupted: true, answer: [] }), [], 0);
  assert.match(el('run-status-summary').textContent ?? '', /中断/);
  assert.equal(surface().hidden, true);
});

test('cancel stays reachable while active and retry is manual and singular', async () => {
  await freshUser('load-actions');
  const run = makeView('run-actions', { state: 'researching', research: researchMeta('reading') });
  let cancelled = 0;
  let retried = 0;
  route = (url, init) => {
    if (url.includes('/api/runs/run-actions?')) return jsonResponse({ run, events: [], latestSeq: 0 });
    if (url.includes('/cancel') && init?.method === 'POST') {
      cancelled += 1;
      return jsonResponse({ run: { ...run, state: 'cancelled' } });
    }
    return jsonResponse({ runs: [] });
  };
  await selectRun('run-actions');
  const stop = el<HTMLButtonElement>('stop-run');
  assert.equal(stop.hidden, false);
  stop.click();
  await settle();
  assert.equal(cancelled, 1);
  assert.equal(state.run?.state, 'cancelled');
  assert.equal(surface().hidden, true);

  route = (url, init) => {
    if (url.includes('/retry') && init?.method === 'POST') {
      retried += 1;
      return jsonResponse({ run: makeView('run-retry', { state: 'queued' }) });
    }
    if (url.includes('/api/runs/run-retry?')) {
      return jsonResponse({ run: makeView('run-retry', { state: 'queued' }), events: [], latestSeq: 0 });
    }
    return jsonResponse({ runs: [] });
  };
  el<HTMLButtonElement>('retry-run').click();
  await settle();
  assert.equal(retried, 1, 'recovery goes through the existing idempotent retry API');
  assert.equal(state.run?.runId, 'run-retry');
  assert.equal(surface().hidden, false, 'the retried run is loading again');
});

/* ---------------- reconnect, run switching, late responses ---------------- */

test('stream reconnect keeps received material and updates the notice truthfully', async () => {
  await freshUser('load-stream');
  let served = makeView('run-stream', { state: 'researching', research: researchMeta('reading') });
  route = (url) => (url.includes('/api/runs/run-stream?')
    ? jsonResponse({ run: served, events: [], latestSeq: 0 })
    : jsonResponse({ runs: [] }));
  await selectRun('run-stream');
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('source', source('S3', { title: '保留下来的来源' }), '1');
  served = { ...served, sources: [source('S3', { title: '保留下来的来源' })] };
  await settle();

  el('toast').hidden = true; el('toast').textContent = '';
  stream.fail();
  await settle();
  assert.equal(el('toast').hidden, true, 'A transport disconnect is not a research failure');
  assert.doesNotMatch(el('toast').textContent ?? '', /研究失败/);
  assert.match(surface().textContent ?? '', /重连/, 'the disconnect is stated truthfully');
  assert.match(surface().textContent ?? '', /保留下来的来源/, 'received material survives the reconnect');

  await new Promise((resolve) => setTimeout(resolve, 560));
  const reopened = MockEventSource.instances.at(-1)!;
  assert.notEqual(reopened, stream);
  reopened.onopen?.();
  await settle();
  assert.doesNotMatch(surface().textContent ?? '', /重连/, 'the notice clears when the stream actually reopens');
  assert.match(surface().textContent ?? '', /保留下来的来源/);
  reopened.close();
});

test('run switches and late responses keep the surface on the selected run', async () => {
  await freshUser('load-switch');
  const runA = makeView('run-a', { state: 'researching', research: researchMeta('identity') });
  const runB = makeView('run-b', { state: 'researching', research: researchMeta('synthesizing'), question: '另一位合成人物' });
  route = (url) => {
    if (url.includes('/api/runs/run-a?')) {
      return jsonResponse({ run: runA, events: [stageEvent(1, 'old-step', '旧研究的步骤')], latestSeq: 1 });
    }
    if (url.includes('/api/runs/run-b?')) return jsonResponse({ run: runB, events: [], latestSeq: 0 });
    return jsonResponse({ runs: [] });
  };
  await selectRun('run-a');
  const streamA = MockEventSource.instances.at(-1)!;
  assert.match(surface().textContent ?? '', /旧研究的步骤/);

  await selectRun('run-b');
  assert.equal(surface().dataset.runId, 'run-b');
  assert.match(surface().textContent ?? '', /另一位合成人物/);
  assert.doesNotMatch(surface().textContent ?? '', /旧研究的步骤/);
  const before = surface().textContent ?? '';
  streamA.emit('stage', stageEvent(2, 'late', '迟到的旧步骤'), '2');
  await settle();
  assert.equal(surface().textContent, before, 'a late event from the previous run cannot repaint the surface');
});

/* ---------------- completed report preservation ---------------- */

test('a completed report keeps the canonical report, exports and follow-up', async () => {
  await freshUser('load-complete');
  applySnapshot(makeView('run-done', {
    state: 'completed',
    sources: [source('S1')],
    answer: [{
      id: 'facts',
      heading: '查到的事实',
      body: '已完成的结论。',
      bullets: [{ text: '有出处的事实。', sourceKeys: ['S1'], kind: 'factual', validity: 'valid', reviewReason: null }]
    }]
  }), [], 0);
  assert.equal(surface().hidden, true);
  const report = el('report');
  assert.ok(report.querySelector('.report-header'), 'the settled canonical report keeps its header');
  assert.match(report.textContent ?? '', /有出处的事实/);
  assert.equal(visibleQueryCount(), 1);
  assert.equal(el<HTMLButtonElement>('download-md').disabled, false);
  assert.equal(el<HTMLButtonElement>('copy-report').disabled, false);
  assert.equal(el('chat-dock').hidden, false, 'follow-up is available when a report actually supports it');
  assert.equal(el<HTMLInputElement>('chat-input').disabled, false);
  assert.ok(env.document.querySelectorAll('#followup-rail .prompt-chip').length > 0);
});

/* ---------------- model contract ---------------- */

test('the presentation model never invents progress, completion or empty-read claims', () => {
  const activeStage: StageView = {
    key: 'read',
    index: 0,
    total: 0,
    label: '读取相关资料',
    status: 'active',
    detail: '一条实际记录',
    observedSeq: 3
  };
  const unknownPhase = deriveResearchLoading({
    run: makeView('m1', { state: 'researching', research: researchMeta('nonsense-phase') }),
    stages: [activeStage],
    streamState: 'open'
  });
  assert.equal(unknownPhase.mode, 'active');
  assert.equal(unknownPhase.busy, true);
  assert.equal(unknownPhase.heading, '正在读取相关资料', 'unknown phases fall back to the observed stage');
  assert.doesNotMatch(JSON.stringify(unknownPhase), /%|已完成/);

  const zeroSources = deriveResearchLoading({
    run: makeView('m2', { state: 'researching' }),
    stages: [],
    streamState: 'open'
  });
  assert.deepEqual(zeroSources.context, ['找到的资料会逐步出现在这里。'],
    'zero canonical sources never asserts that nothing has been read');

  const reconnecting = deriveResearchLoading({
    run: makeView('m3', { state: 'researching' }),
    stages: [],
    streamState: 'reconnecting'
  });
  assert.match(reconnecting.context.join(''), /重连/);

  const deciding = deriveResearchLoading({
    run: makeView('m4', { state: 'needs_input' }),
    stages: [activeStage],
    streamState: 'open'
  });
  assert.equal(deciding.mode, 'needs_input');
  assert.equal(deciding.busy, false);
  assert.ok(deciding.process.every((record) => record.tag === '过程记录'),
    'historical active stage events never read as busy');

  assert.equal(deriveResearchLoading({ run: null, stages: [], streamState: 'idle' }).mode, 'none');
});


/* Parent acceptance: boundaries exercised through actual main event/session wiring. */
test('a new stage event supersedes the older snapshot phase in the visible current action', async () => {
  await freshUser('stage-after-snapshot');
  const run = makeView('run-stage-lag', { research: researchMeta('planning') });
  route = url => url.includes('/api/runs/run-stage-lag?')
    ? jsonResponse({ run, events: [], latestSeq: 0 }) : jsonResponse({ runs: [] });
  await selectRun(run.runId);
  assert.match(surface().querySelector('.research-live-heading')!.textContent!, /安排/);
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('stage', { key: 'reading', label: '读取原文', status: 'active', index: 2, total: 5 }, '1');
  await settle();
  assert.equal(state.run!.research!.phase, 'planning', 'The source snapshot is unchanged by a stage-only event');
  assert.match(surface().querySelector('.research-live-heading')!.textContent!, /读取|阅读/,
    'The newer actual stage must update the visible action');
  assert.doesNotMatch(surface().querySelector('.research-live-heading')!.textContent!, /安排/);
  stream.close();
});

test('inaccessible received sources are not counted as successfully read originals', async () => {
  await freshUser('unread-source');
  applySnapshot(makeView('run-unread', { sources: [source('UNREAD', { fetchStatus: 'inaccessible', excerpt: '' })], research: researchMeta('reading') }), [], 0);
  assert.match(surface().textContent!, /未能读取/, 'The actual source failure stays inspectable');
  assert.doesNotMatch(surface().querySelector('.research-live-context')!.textContent!, /已读取\s*1/,
    'A received failed source is not a successful read');
});

test('real signout removes the previous query and source text from the retained loading host', async () => {
  await freshUser('private-loading-owner');
  const query = 'SYNTHETIC_PRIVATE_QUERY_A';
  const title = 'SYNTHETIC_PRIVATE_SOURCE_A';
  const privateGap = 'SYNTHETIC_PRIVATE_GAP_A';
  applySnapshot(makeView('run-private-loading', { question: query, sources: [source('PRIVATE', { title })], research: { ...researchMeta('reading'), unresolved: [privateGap, 'second', 'third', 'SYNTHETIC_PRIVATE_OVERFLOW_A'] } }), [], 0);
  const gapMore = surface().querySelector<HTMLDetailsElement>('.research-live-gaps details')!;
  gapMore.open = true;
  assert.ok(surface().textContent!.includes(query) && surface().textContent!.includes(title), 'Valid populated precondition');
  route = () => jsonResponse({});
  await main.__test.signOut();
  await settle();
  assert.equal(state.user, null);
  assert.equal(surface().hidden, true);
  assert.ok(!surface().textContent!.includes(query) && !surface().textContent!.includes(title),
    'Hidden UI must not retain the previous authenticated content after logout');
  assert.doesNotMatch(surface().textContent!, /SYNTHETIC_PRIVATE_(?:GAP|OVERFLOW)_A/);
  assert.equal(surface().querySelector<HTMLElement>('.research-live-gaps')!.hidden, true);
  assert.equal(gapMore.open, false);
  assert.equal(gapMore.textContent, '');
});


test('new sources do not displace the focused material when the preview reaches its cap', async () => {
  await freshUser('stable-material-preview');
  const run = makeView('run-material-cap', { sources: Array.from({ length: 6 }, (_, n) => source(`CAP${n + 1}`)), research: researchMeta('reading') });
  route = url => url.includes('/api/runs/run-material-cap?')
    ? jsonResponse({ run, events: [], latestSeq: 0 }) : jsonResponse({ runs: [] });
  await selectRun(run.runId);
  const row = surface().querySelector<HTMLButtonElement>('[data-source-key="CAP1"]')!;
  row.focus();assert.equal(env.document.activeElement, row);
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('source', source('CAP7'), '1');await settle();
  const retained = surface().querySelector<HTMLButtonElement>('[data-source-key="CAP1"]');
  assert.ok(retained, 'An appended source must not remove the material currently being read');
  assert.equal(env.document.activeElement, retained, 'Keep keyboard focus on the same source');
  assert.match(surface().textContent!, /另有 1 条来源/);
  stream.close();
});


for (const mobile of [false, true]) {
  test(`live material returns focus after refresh and ${mobile ? 'mobile Escape' : 'desktop close'}`, async () => {
    await freshUser(`material-return-${mobile}`);
    const previousMedia = env.window.matchMedia;
    env.window.matchMedia = ((query: string) => ({ ...previousMedia(query), matches: mobile && query === '(max-width: 1220px)' })) as typeof window.matchMedia;
    try {
      const run = makeView(`material-return-${mobile}`, { sources: [source('S1')], research: researchMeta('reading') });
      applySnapshot(run, [], 0);
      const original = surface().querySelector<HTMLButtonElement>('[data-source-key="S1"]')!;
      original.focus(); original.click();
      const entry = main.__test.citationReturn.entry();
      assert.equal(entry?.sourceKey, 'S1');
      assert.equal(entry?.runId, run.runId);
      assert.ok(entry?.returnSelector?.includes('live-material'), 'record a durable return target for the actual material entry');
      applySnapshot({ ...run, revision: 2 }, [], 0);
      const rebuilt = surface().querySelector<HTMLButtonElement>('[data-source-key="S1"]')!;
      assert.notEqual(rebuilt, original, 'exercise a real DOM rebuild while inspection is open');
      if (mobile) {
        const drawer = el<HTMLDialogElement>('source-drawer');
        assert.equal(drawer.open, true);
        drawer.dispatchEvent(new env.window.Event('cancel', { cancelable: true }));
        assert.equal(drawer.open, false);
      } else el<HTMLButtonElement>('desktop-close-inspector').click();
      assert.equal(env.document.activeElement, rebuilt, 'return to this run’s original material after refresh');
    } finally { env.window.matchMedia = previousMedia; }
  });
}

test('loading focus and process disclosure survive only within the same research', async () => {
  await freshUser('material-run-boundary');
  const run = makeView('material-run-a', { sources: [source('S1')], research: researchMeta('reading') });
  const stages = [stageEvent(1, 'reading', '读取原文')];
  applySnapshot(run, stages, 1);
  const process = surface().querySelector<HTMLDetailsElement>('details')!;
  process.open = true;
  surface().querySelector<HTMLButtonElement>('[data-source-key="S1"]')!.focus();
  applySnapshot({ ...run, revision: 2 }, stages, 1);
  assert.equal(process.open, true, 'same-run refresh preserves deliberate disclosure state');
  assert.equal(env.document.activeElement, surface().querySelector('[data-source-key="S1"]'), 'same-run focus survives');
  applySnapshot({ ...run, runId: 'material-run-b' }, stages, 1);
  assert.equal(process.open, false, 'another research starts with its own disclosure state');
  assert.notEqual(env.document.activeElement, surface().querySelector('[data-source-key="S1"]'), 'S1 from another research is not the same focus target');
});


test('a real research error message remains visible separately from transport reconnect', async () => {
  await freshUser('research-error-message');
  const run = makeView('run-research-error-message', { research: researchMeta('reading') });
  route = url => url.includes('/api/runs/run-research-error-message?')
    ? jsonResponse({ run, events: [], latestSeq: 0 }) : jsonResponse({ runs: [] });
  await selectRun(run.runId);
  el('toast').hidden = true; el('toast').textContent = '';
  const stream = MockEventSource.instances.at(-1)!;
  stream.emit('error', { code: 'synthetic_research_error', message: '合成研究操作已失败。' }, '1');
  assert.equal(el('toast').hidden, false);
  assert.equal(el('toast').textContent, '合成研究操作已失败。', 'A real server error is not swallowed');
  assert.equal(state.latestSeq, 1);
  stream.close();
});

test('gap translation preserves target URLs and historical verification qualifiers', () => {
  const url = 'https://fixture.invalid/provider_billing?q=provider_timeout';
  const translated = researchGapText(`历史记录尚未复核（provider_billing）：${url}；不代表当前问题。`);
  assert.ok(translated.includes(url));
  assert.match(translated, /历史记录尚未复核（服务商计费或额度限制）/);
  assert.match(translated, /不代表当前问题/);
  const uppercase = 'HTTPS://fixture.invalid/provider_billing?q=provider_timeout';
  assert.ok(researchGapText(`provider_billing：${uppercase}`).includes(uppercase));
});

test('selected-account reading gaps remain visible during research and after completion without leaking across runs', async () => {
  await freshUser('selected-account-gap');
  const gap = '所选账号初始材料未读取成功（provider_billing）：https://x.com/fixture-person；不代表无资料。';
  const meta = { ...researchMeta('reading'), unresolved: [gap, gap] };
  const run = makeView('run-selected-account-gap', { sources: [source('S1')], research: meta, limitations: [] });
  applySnapshot(run, [], 0);
  const warning = surface().querySelector<HTMLElement>('[aria-label="读取与核验缺口"]');
  assert.ok(warning && !warning.hidden, 'a partial provider failure is visible beside the live status');
  assert.match(warning.textContent ?? '', /x\.com\/fixture-person/);
  assert.match(warning.textContent ?? '', /计费或额度限制/);
  assert.doesNotMatch(warning.textContent ?? '', /provider_billing/);
  assert.equal(warning.querySelectorAll('li').length, 1, 'duplicate canonical gaps do not duplicate the warning');
  assert.match(surface().textContent ?? '', /合成来源 S1/, 'successful material remains available');
  applySnapshot({ ...run, state: 'partial', revision: 2 }, [], 0);
  assert.match(el('run-status-summary').textContent ?? '', /x\.com\/fixture-person/, 'the settled summary retains the actual failed account');
  assert.match(el('research-details').textContent ?? '', /计费或额度限制/);
  applySnapshot(makeView('another-gap-free-run', { research: researchMeta('reading') }), [], 0);
  assert.doesNotMatch(surface().textContent ?? '', /fixture-person/);
});

test('historical model questions are not counted as current reading failures', async () => {
  await freshUser('historical-gap-qualifier');
  const historical = 'Agent 在步骤 1 提出的核对项（未经独立核验，不代表当前读取状态）：当时尚未读取博客正文。';
  applySnapshot(makeView('historical-reading', { state: 'partial', research: { ...researchMeta('done'), unresolved: [historical] } }), [], 0);
  assert.match(el('run-status-summary').textContent ?? '', /读取限制与核对记录/);
  assert.match(el('run-status-summary').textContent ?? '', /不代表当前读取状态/);
  assert.doesNotMatch(el('run-status-summary').textContent ?? '', /1 项读取与核验缺口/);
});
