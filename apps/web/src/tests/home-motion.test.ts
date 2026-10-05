import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from './dom-env.js';
import { createHomeMotion } from '../client/home-motion.js';

const DESKTOP = '(min-width: 1000px) and (min-height: 720px)';
const REDUCED = '(prefers-reduced-motion: reduce)';

function fixture(t: { after(fn: () => void): void }, options: { observer?: boolean; desktop?: boolean; reduced?: boolean } = {}) {
  const env = installDom();
  const win = env.window as unknown as Window & typeof globalThis;
  const doc = env.document;
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
  for (const [query, matches] of [[DESKTOP, options.desktop ?? true], [REDUCED, options.reduced ?? false]] as const) {
    queries.set(query, { matches, listeners: new Set() });
  }
  win.matchMedia = ((query: string) => {
    const state = queries.get(query)!;
    return {
      get matches() { return state.matches; }, media: query,
      addEventListener(_type: string, listener: () => void) { state.listeners.add(listener); },
      removeEventListener(_type: string, listener: () => void) { state.listeners.delete(listener); }
    };
  }) as typeof win.matchMedia;
  let hidden = false;
  Object.defineProperty(doc, 'hidden', { get: () => hidden, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 900, configurable: true });
  let scroll = 0;
  const chapters = [...doc.querySelectorAll<HTMLElement>('[data-journey-step]')];
  chapters.forEach((chapter, index) => {
    chapter.getBoundingClientRect = () => ({ top: 100 + index * 700 - scroll, bottom: 800 + index * 700 - scroll }) as DOMRect;
  });
  const observers: { callback: IntersectionObserverCallback; disconnected: boolean; targets: Element[] }[] = [];
  if (options.observer !== false) {
    (win as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      record: typeof observers[number];
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, disconnected: false, targets: [] }; observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      disconnect() { this.record.disconnected = true; }
    };
  }
  const controller = createHomeMotion({ doc, win });
  t.after(() => controller.dispose());
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => doc.getElementById(id)! as T;
  const panels = () => [...doc.querySelectorAll<HTMLElement>('[data-journey-panel]')];
  return {
    controller, doc, win, queries, observers, panels, el,
    stage: () => Number(el('home-artifact').dataset.stage),
    emit(y: number) {
      scroll = y;
      observers.at(-1)?.callback([], {} as IntersectionObserver);
    },
    setMedia(query: string, matches: boolean) {
      const state = queries.get(query)!; state.matches = matches;
      [...state.listeners].forEach((listener) => listener());
    },
    setHidden(value: boolean) { hidden = value; doc.dispatchEvent(new win.Event('visibilitychange')); }
  };
}

test('desktop starts at the input and scroll unfolds all three stages in either direction', (t) => {
  const f = fixture(t);
  assert.equal(f.el('journey-visual').hidden, false);
  assert.equal(f.stage(), 1);
  assert.equal(f.panels().filter(panel => !panel.hidden).length, 1);
  assert.equal(f.observers[0]!.targets.length, 3);
  f.emit(600); assert.equal(f.stage(), 2);
  assert.match(f.el('journey-stage-host').textContent!, /同名候选/);
  assert.equal(f.doc.querySelector('[data-phase="2"]')?.getAttribute('aria-current'), 'step');
  f.emit(1400); assert.equal(f.stage(), 3);
  assert.equal(f.panels()[2]!.hidden, false);
  assert.match(f.el('journey-context').textContent!, /作品研究/);
  f.emit(600); assert.equal(f.stage(), 2);
  f.emit(0); assert.equal(f.stage(), 1);
});

test('restored reading position is selected synchronously without requiring an entry order', (t) => {
  const f = fixture(t);
  f.controller.setActive(false);
  f.emit(1600);
  f.controller.setActive(true);
  assert.equal(f.stage(), 3);
  assert.equal(f.panels()[2]!.hidden, false);
});

for (const [name, options] of [
  ['mobile or short viewport', { desktop: false }],
  ['reduced motion', { reduced: true }],
  ['missing IntersectionObserver', { observer: false }]
] as const) {
  test(`${name} keeps each full panel beside its chapter without a hidden result`, (t) => {
    const f = fixture(t, options);
    assert.equal(f.el('journey-visual').hidden, true);
    assert.equal(f.observers.length, 0);
    f.panels().forEach((panel, index) => {
      assert.equal(panel.hidden, false);
      assert.equal(panel.parentElement?.dataset.stageSlot, String(index + 1));
    });
    assert.match(f.panels()[2]!.textContent!, /还不能证明/);
  });
}

test('changing media settings moves the same content and preserves inspected details and focus', (t) => {
  const f = fixture(t);
  f.emit(1400);
  f.el<HTMLButtonElement>('home-citation').click();
  const detail = f.el<HTMLDetailsElement>('home-source');
  const summary = detail.querySelector('summary')!;
  assert.equal(detail.open, true);
  assert.equal(f.doc.activeElement, summary);
  f.setMedia(REDUCED, true);
  assert.equal(f.el('journey-visual').hidden, true);
  assert.equal(detail.open, true);
  assert.equal(f.doc.activeElement, summary);
  assert.equal(f.panels().every(panel => !panel.hidden), true);
  f.setMedia(REDUCED, false);
  assert.equal(f.el('journey-visual').hidden, false);
  assert.equal(detail.open, true);
  assert.equal(f.doc.activeElement, summary);
  f.setMedia(DESKTOP, false);
  assert.equal(f.el('journey-visual').hidden, true);
});

test('initial mobile source focus survives promotion into the desktop workspace', (t) => {
  const f = fixture(t, { desktop: false });
  f.emit(1400);
  const summary = f.el('home-source').querySelector('summary')!;
  summary.focus();
  f.setMedia(DESKTOP, true);
  assert.equal(f.stage(), 3);
  assert.equal(f.panels()[2]!.hidden, false);
  assert.equal(f.doc.activeElement, summary);
});

test('scroll does not hide or blur a focused source; leaving it resumes the narrative', async (t) => {
  const f = fixture(t);
  f.emit(1400);
  f.el<HTMLButtonElement>('home-citation').click();
  const summary = f.el('home-source').querySelector('summary')!;
  f.emit(0);
  assert.equal(f.stage(), 3);
  assert.equal(f.doc.activeElement, summary);
  f.el<HTMLTextAreaElement>('research-question').focus();
  await Promise.resolve();
  assert.equal(f.stage(), 1);
  assert.equal(f.el<HTMLDetailsElement>('home-source').open, true);
});

test('inactive, hidden, cached and disposed pages disconnect observers without late mutations', (t) => {
  const f = fixture(t);
  f.emit(600);
  f.controller.setActive(false);
  assert.equal(f.observers.at(-1)!.disconnected, true);
  f.emit(1400); assert.equal(f.stage(), 2);
  f.controller.setActive(true); assert.equal(f.stage(), 3);
  f.setHidden(true); assert.equal(f.observers.at(-1)!.disconnected, true);
  f.setHidden(false); assert.equal(f.el('journey-visual').hidden, false);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide', { persisted: true }));
  assert.equal(f.el('journey-visual').hidden, false, 'cached page preserves DOM and reading geometry');
  assert.equal(f.observers.at(-1)!.disconnected, true);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(f.el('journey-visual').hidden, false);
  f.controller.dispose();
  assert.equal(f.observers.at(-1)!.disconnected, true);
  assert.equal(f.panels().every(panel => !panel.hidden), true);
  assert.equal([...f.queries.values()].every(state => state.listeners.size === 0), true);
  f.emit(0); assert.equal(f.stage(), 3);
  f.controller.setActive(true); assert.equal(f.el('journey-visual').hidden, true);
});

test('the baseline document contains the three readable panels with synthetic truth and no playback prerequisite', () => {
  const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-journey-panel=/g) ?? []).length, 3);
  assert.doesNotMatch(html, /demo-play|demo-toggle|demo-replay|data-stage-button/);
  const motion = readFileSync(new URL('../client/home-motion.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(motion, /\bfetch\s*\(|setTimeout\s*\(|setInterval\s*\(|requestAnimationFrame\s*\(|addEventListener\(['"]scroll/);
  assert.match(html, /原创合成示例 · 非实时研究/);
  assert.match(html, /尚未开放订阅或收款/);
  assert.match(html, /模型、API 与服务器费用另计/);
});
