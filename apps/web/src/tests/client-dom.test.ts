import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { CanonicalView } from '../shared/types.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html?: string, options?: Record<string, unknown>) => { window: Record<string, unknown> };
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
(globalThis as unknown as { window: unknown }).window = jsdomWindow;
(globalThis as unknown as { document: Document }).document = jsdomWindow.document;
(globalThis as unknown as { requestAnimationFrame: (cb: (time: number) => void) => number }).requestAnimationFrame =
  (cb) => setTimeout(() => cb(0), 0) as unknown as number;

const { renderReport, renderSourceDetail, renderSourceList, stagesFromEvents } = await import('../client/render.js');
const { renderActivity } = await import('../client/render.js');

function domContainer(): HTMLElement {
  return jsdomWindow.document.createElement('div');
}

function viewWith(overrides: Partial<CanonicalView> = {}): CanonicalView {
  const base: CanonicalView = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run_dom',
    state: 'completed',
    revision: 1,
    question: '问题',
    seedUrl: 'https://github.com/example',
    provider: 'github',
    parentRunId: null,
    retryOf: null,
    followup: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    interrupted: false,
    stopReason: 'test',
    identity: {
      displayName: 'Example',
      handle: 'example',
      profileUrl: 'https://github.com/example',
      status: 'resolved',
      note: null,
      candidates: []
    },
    sources: [
      {
        sourceKey: 'S1',
        url: 'https://github.com/example',
        title: 'example · 公开主页',
        kind: 'profile',
        publishedAt: null,
        retrievedAt: '2024-01-01T00:00:00.000Z',
        fetchStatus: 'ok',
        excerpt: '公开简介',
        excerptLocator: '公开简介',
        identityLabel: '种子账号',
        identityConfirmed: true,
        limits: [],
        excluded: false,
        excludedAt: null
      }
    ],
    observations: [],
    answer: [
      {
        id: 'identity',
        heading: '这个人是谁',
        body: '公开资料。',
        bullets: [
          {
            text: '<img src=x onerror="window.__xss=1">',
            sourceKeys: ['S1'],
            kind: 'factual',
            validity: 'valid',
            reviewReason: null
          }
        ]
      }
    ],
    limitations: [],
    usage: { provider: 'github', requests: 1, bytes: 10, elapsedMs: 1, measurement: 'observed' },
    reviewCount: 0
  };
  return { ...base, ...overrides };
}

test('report rendering treats upstream text as text, never as markup', () => {
  const container = domContainer();
  renderReport(container, viewWith(), { onCitation: () => undefined });
  assert.equal(container.querySelector('img'), null);
  assert.ok(container.textContent?.includes('<img src=x onerror='));
  assert.equal((jsdomWindow as unknown as { __xss?: number }).__xss, undefined);
  assert.equal(container.querySelectorAll('.report-section').length, 1);
  assert.equal(container.querySelectorAll('.citation').length, 1);
});

test('source detail links are safe and carry noopener', () => {
  const container = domContainer();
  renderSourceDetail(container, viewWith(), 'S1', {
    onSelect: () => undefined,
    onExclude: () => undefined,
    onRestore: () => undefined,
    onUndo: () => undefined
  });
  const anchor = container.querySelector('a');
  assert.ok(anchor);
  assert.equal(anchor.getAttribute('target'), '_blank');
  assert.match(anchor.getAttribute('rel') ?? '', /noopener/);
  assert.equal(anchor.getAttribute('href'), 'https://github.com/example');
});

test('source list filters excluded sources and shows an empty state', () => {
  const container = domContainer();
  const view = viewWith({
    sources: [
      { ...viewWith().sources[0]!, excluded: false },
      { ...viewWith().sources[0]!, sourceKey: 'S2', title: '被排除', excluded: true, fetchStatus: 'excluded', kind: 'third_party' }
    ]
  });
  renderSourceList(container, view, null, 'all', () => undefined);
  assert.equal(container.querySelectorAll('.source-row').length, 1);
  renderSourceList(container, view, null, 'excluded', () => undefined);
  assert.equal(container.querySelectorAll('.source-row').length, 1);
  assert.ok(container.textContent?.includes('被排除'));
});

test('activity rendering derives progress from ordered stage events', () => {
  const events = [
    { seq: 1, type: 'stage', payload: { index: 0, total: 2, key: 'a', label: '第一步', status: 'active' }, createdAt: '' },
    { seq: 2, type: 'stage', payload: { index: 0, total: 2, key: 'a', label: '第一步', status: 'done' }, createdAt: '' },
    { seq: 3, type: 'stage', payload: { index: 1, total: 2, key: 'b', label: '第二步', status: 'active' }, createdAt: '' }
  ];
  const stages = stagesFromEvents(events);
  assert.equal(stages.length, 2);
  assert.equal(stages[0]?.status, 'done');
  assert.equal(stages[1]?.status, 'active');

  const list = domContainer();
  const fill = domContainer();
  const bar = domContainer();
  const text = domContainer();
  const stateEl = domContainer();
  const indicator = domContainer();
  renderActivity(list, fill, bar, text, stateEl, indicator, stages, 'researching');
  assert.equal(text.textContent, '1 / 2');
  assert.equal(fill.style.transform, 'scaleX(0.5)');
  assert.equal(indicator.hidden, false);
});

test('open-ended terminal research shows process records without claiming active or completed stages', () => {
 const list=domContainer(), fill=domContainer(), bar=domContainer(), text=domContainer(), stateEl=domContainer(), indicator=domContainer();
 renderActivity(list,fill,bar,text,stateEl,indicator,[{index:0,total:12,key:'reading',label:'读取原文',status:'active',detail:null}],'partial',true);
 assert.equal(text.textContent,'1 条过程记录');assert.equal(stateEl.textContent,'部分完成');assert.equal(indicator.hidden,true);assert.equal(bar.hidden,true);assert.match(list.textContent!,/过程记录/);assert.doesNotMatch(list.textContent!,/正在查看/);
});
