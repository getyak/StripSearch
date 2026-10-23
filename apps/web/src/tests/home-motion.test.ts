import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from './dom-env.js';
import { createHomeMotion } from '../client/home-motion.js';

function fixture(
  t: { after(fn: () => void): void },
  html?: string,
  prepare?: (doc: Document, win: Window & typeof globalThis) => void
) {
  const env = installDom();
  const win = env.window as unknown as Window & typeof globalThis;
  const doc = env.document;
  if (html) doc.getElementById('view-home')!.innerHTML = html;
  let x = 0;
  let y = 0;
  const scrolls: ScrollToOptions[] = [];
  const reveals: HTMLElement[] = [];
  Object.defineProperties(win, {
    scrollX: { configurable: true, get: () => x },
    scrollY: { configurable: true, get: () => y }
  });
  win.scrollTo = ((position: ScrollToOptions) => {
    scrolls.push(position);
    x = position.left ?? x;
    y = position.top ?? y;
  }) as Window['scrollTo'];
  win.HTMLElement.prototype.scrollIntoView = function () { reveals.push(this); };
  prepare?.(doc, win);
  const controller = createHomeMotion({ doc, win });
  t.after(() => { controller.dispose(); win.close(); });
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => doc.getElementById(id)! as T;
  return {
    controller, doc, win, el, scrolls, reveals,
    moveTo: (left: number, top: number) => { x = left; y = top; },
    citation: (id: string) => el<HTMLButtonElement>(id),
    material: (id: string) => el<HTMLDetailsElement>(id)
  };
}

const evidenceHtml = `
  <section data-evidence-scope>
    <p id="claim" data-evidence-key="lantern-update" tabindex="0">记录宣布了这项功能。</p>
    <button id="home-citation" data-citation="home-source" aria-expanded="false">出处 [S1]</button>
    <button id="same-source-citation" data-citation="home-source" aria-expanded="false">另一处引用 [S1]</button>
    <details id="home-source" data-evidence-key="lantern-update">
      <summary>核查材料</summary>
      <p id="original" data-source-location tabindex="-1">新增离线阅读与本地索引。</p>
      <button id="return" data-citation-return hidden>返回刚才的判断</button>
    </details>
  </section>
  <section data-evidence-scope>
    <p id="other-claim" data-evidence-key="lantern-update" tabindex="0">同材料的另一组说明。</p>
    <button id="home-citation-2" data-citation="home-source-2" aria-expanded="false">出处 [S1]</button>
    <details id="home-source-2" data-evidence-key="lantern-update">
      <summary>核查材料</summary><p data-source-location tabindex="-1">合成原文。</p>
      <button data-citation-return hidden>返回刚才的判断</button>
    </details>
  </section>
  <button id="motion-toggle" data-motion-toggle aria-pressed="false" hidden>暂停光影</button>`;

function point(f: ReturnType<typeof fixture>, type: string, target: HTMLElement, relatedTarget: HTMLElement | null = null, pointerType = 'mouse'): void {
  const event = new f.win.MouseEvent(type, { bubbles: true, relatedTarget });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('a citation reveal opens its material in place and moves focus onto the disclosure', (t) => {
  const f = fixture(t);
  const button = f.citation('home-citation');
  const material = f.material('home-source');
  assert.equal(material.open, false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  const parent = material.parentElement;
  button.click();
  assert.equal(material.open, true);
  assert.equal(material.parentElement, parent, 'the material never relocates');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(material.dataset.revealed, 'true');
  assert.equal(f.doc.activeElement, material.querySelector('summary'));
});

test('every citation binds to its own material without touching the others', (t) => {
  const f = fixture(t);
  f.citation('home-citation-2').click();
  assert.equal(f.material('home-source-2').open, true);
  assert.equal(f.material('home-source').open, false);
  assert.equal(f.citation('home-citation').getAttribute('aria-expanded'), 'false');
});

test('return closes the source and restores the exact citation and reading position', (t) => {
  const f = fixture(t, evidenceHtml);
  const origin = f.citation('same-source-citation');
  f.moveTo(12, 680);
  origin.click();
  assert.equal(f.doc.activeElement, f.material('home-source').querySelector('summary'));
  assert.equal(f.reveals.at(-1), f.el('original'), 'the original passage is brought into view');
  assert.equal(f.citation('home-citation').getAttribute('aria-expanded'), 'true');
  f.moveTo(0, 1200);
  f.el('return').click();
  assert.equal(f.material('home-source').open, false);
  assert.equal(origin.getAttribute('aria-expanded'), 'false');
  assert.equal(f.citation('home-citation').getAttribute('aria-expanded'), 'false');
  assert.equal(f.doc.activeElement, origin, 'return uses the actual activating citation');
  assert.deepEqual(f.scrolls.at(-1), { left: 12, top: 680, behavior: 'instant' });
});

test('enhanced controls are available only while their interaction is usable', (t) => {
  const f = fixture(t, evidenceHtml);
  const returns = f.el<HTMLButtonElement>('return');
  const motion = f.el<HTMLButtonElement>('motion-toggle');
  assert.equal(motion.hidden, false, 'the CSS pause control becomes available when JavaScript is ready');
  assert.equal(returns.hidden, true, 'a source has no return position before a citation is activated');
  f.citation('home-citation').click();
  assert.equal(returns.hidden, false, 'opening a citation makes its exact return action available');
  returns.click();
  assert.equal(returns.hidden, true);
  f.citation('home-citation').click();
  f.controller.setActive(false);
  assert.equal(returns.hidden, true);
  assert.equal(motion.hidden, true);
  f.controller.setActive(true);
  assert.equal(motion.hidden, false);
  assert.equal(returns.hidden, true, 'navigation does not recreate a discarded return position');
  f.citation('home-citation').click();
  f.controller.dispose();
  assert.equal(returns.hidden, true);
  assert.equal(motion.hidden, true, 'disposed controls cannot remain visible without listeners');
});

test('Escape within an open source returns to its latest activating citation', (t) => {
  const f = fixture(t, evidenceHtml);
  f.citation('home-citation').click();
  f.moveTo(0, 420);
  const origin = f.citation('same-source-citation');
  origin.click();
  f.el('original').focus();
  const escape = new f.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  f.el('original').dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(f.material('home-source').open, false);
  assert.equal(f.doc.activeElement, origin);
  assert.deepEqual(f.scrolls.at(-1), { left: 0, top: 420, behavior: 'instant' });
});

test('native closing returns focus only while the reader is still inside the source', (t) => {
  const f = fixture(t, evidenceHtml);
  const material = f.material('home-source');
  const origin = f.citation('same-source-citation');
  f.moveTo(0, 210);
  origin.click();
  material.open = false;
  material.dispatchEvent(new f.win.Event('toggle'));
  assert.equal(f.doc.activeElement, origin);
  assert.equal(f.citation('home-citation').getAttribute('aria-expanded'), 'false');

  origin.click();
  f.el('other-claim').focus();
  material.open = false;
  material.dispatchEvent(new f.win.Event('toggle'));
  assert.equal(f.doc.activeElement, f.el('other-claim'), 'closing after moving on does not steal focus');
  assert.equal(f.scrolls.length, 1);
});

test('native disclosure remains usable without inventing a citation return position', (t) => {
  const f = fixture(t, evidenceHtml);
  const material = f.material('home-source');
  material.open = true;
  material.dispatchEvent(new f.win.Event('toggle'));
  assert.equal(f.citation('same-source-citation').getAttribute('aria-expanded'), 'true');
  assert.equal(f.el('return').hidden, true, 'native opening does not offer an invented judgment position');
  const summary = material.querySelector<HTMLElement>('summary')!;
  summary.focus();
  summary.click();
  material.dispatchEvent(new f.win.Event('toggle'));
  assert.equal(material.open, false);
  assert.equal(f.doc.activeElement, material.querySelector('summary'));
  assert.equal(f.scrolls.length, 0, 'a native disclosure does not invent a previous reading position');
});

test('pointer and focus relate matching evidence only within their nearest scope', (t) => {
  const f = fixture(t, evidenceHtml);
  const claim = f.el('claim');
  const material = f.material('home-source');
  point(f, 'pointerover', claim);
  assert.equal(claim.dataset.related, 'true');
  assert.equal(material.dataset.related, 'true');
  assert.equal(f.el('other-claim').dataset.related, undefined, 'same keys in another section stay separate');
  point(f, 'pointerout', claim, material);
  assert.equal(material.dataset.related, 'true', 'moving from a judgment to its source keeps their relationship');
  point(f, 'pointerout', material);
  assert.equal(claim.dataset.related, undefined);
  assert.equal(material.dataset.related, undefined);

  claim.focus();
  assert.equal(material.dataset.related, 'true', 'keyboard focus has the same relationship feedback');
  f.citation('home-citation-2').focus();
  assert.equal(material.dataset.related, undefined);
  point(f, 'pointerover', claim, null, 'touch');
  assert.equal(material.dataset.related, undefined, 'touch input does not leave a hover state behind');
  point(f, 'pointerover', claim);
  point(f, 'pointerover', claim, null, 'touch');
  assert.equal(material.dataset.related, undefined, 'switching from a pointer to touch clears pointer feedback');
});

test('leaving the home clears evidence and return state while preserving readable material', (t) => {
  const f = fixture(t, evidenceHtml);
  f.citation('same-source-citation').click();
  point(f, 'pointerover', f.el('claim'));
  f.controller.setActive(false);
  assert.equal(f.material('home-source').open, true);
  assert.equal(f.material('home-source').dataset.related, undefined);
  assert.equal(f.material('home-source').dataset.revealed, undefined);
  f.el('return').click();
  assert.equal(f.material('home-source').open, true, 'inactive controls have no effect');
  f.controller.setActive(true);
  assert.equal(f.el('return').hidden, true);
  f.material('home-source').querySelector<HTMLElement>('summary')!.click();
  f.material('home-source').dispatchEvent(new f.win.Event('toggle'));
  assert.equal(f.material('home-source').open, false);
  assert.equal(f.doc.activeElement, f.material('home-source').querySelector('summary'));
  assert.equal(f.scrolls.length, 0, 'an old reading bookmark cannot survive navigation');
});

test('ambient controls pause on request, visibility changes and inactive routes', (t) => {
  const f = fixture(t, evidenceHtml);
  const toggle = f.el<HTMLButtonElement>('motion-toggle');
  const home = f.el('view-home');
  assert.equal(home.dataset.ambientPaused, 'false');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.textContent, '继续光影');
  assert.equal(home.dataset.ambientPaused, 'true');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.textContent, '暂停光影');
  Object.defineProperty(f.doc, 'hidden', { configurable: true, value: true });
  f.doc.dispatchEvent(new f.win.Event('visibilitychange'));
  assert.equal(home.dataset.ambientPaused, 'true');
  Object.defineProperty(f.doc, 'hidden', { configurable: true, value: false });
  f.doc.dispatchEvent(new f.win.Event('visibilitychange'));
  assert.equal(home.dataset.ambientPaused, 'false');
  f.controller.setActive(false);
  assert.equal(home.dataset.ambientPaused, 'true');
  f.controller.setActive(true);
  assert.equal(home.dataset.ambientPaused, 'false');
  f.controller.dispose();
  toggle.click();
  assert.equal(home.dataset.ambientPaused, 'true', 'disposed ambient effects stay paused');
});

test('closing the material collapses its citation and clears the reveal mark', async (t) => {
  const f = fixture(t);
  const button = f.citation('home-citation');
  const material = f.material('home-source');
  button.click();
  material.open = false;
  // jsdom queues details toggle events; browsers fire them directly.
  material.dispatchEvent(new f.win.Event('toggle'));
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(material.dataset.revealed, undefined);
  material.open = true;
  material.dispatchEvent(new f.win.Event('toggle'));
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(material.dataset.revealed, 'true');
  await settle();
});

test('an inactive page ignores reveals and an active page resumes them', (t) => {
  const f = fixture(t);
  f.controller.setActive(false);
  f.citation('home-citation').click();
  assert.equal(f.material('home-source').open, false);
  f.controller.setActive(true);
  f.citation('home-citation').click();
  assert.equal(f.material('home-source').open, true);
  f.controller.setActive(false);
  assert.equal(f.material('home-source').open, true, 'an inspected material stays readable when leaving the page');
});

test('dispose removes listeners without mutating content, and repeated cleanup is safe', (t) => {
  const f = fixture(t);
  const button = f.citation('home-citation');
  const material = f.material('home-source');
  f.controller.dispose();
  f.controller.dispose();
  button.click();
  assert.equal(material.open, false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  f.controller.setActive(true);
  button.click();
  assert.equal(material.open, false);
  assert.match(f.doc.getElementById('home-source')!.textContent!, /不能证明由某个人独立完成/);
});

test('cached pages suspend interactions and resume without retaining stale reading bookmarks', (t) => {
  const f = fixture(t, evidenceHtml);
  f.citation('same-source-citation').click();
  point(f, 'pointerover', f.el('claim'));
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide', { persisted: true }));
  assert.equal(f.el('claim').dataset.related, undefined);
  assert.equal(f.el('view-home').dataset.ambientPaused, 'true');
  f.citation('home-citation-2').click();
  assert.equal(f.material('home-source-2').open, false, 'cached page suspends interaction listeners');
  assert.equal(f.material('home-source').open, true, 'inspected material remains open');
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(f.el('return').hidden, true);
  f.material('home-source').querySelector<HTMLElement>('summary')!.click();
  f.material('home-source').dispatchEvent(new f.win.Event('toggle'));
  assert.equal(f.scrolls.length, 0, 'cached pages discard stale reading positions');
  f.citation('home-citation-2').click();
  assert.equal(f.material('home-source-2').open, true, 'restored pages resume their interactions');
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide', { persisted: false }));
  f.material('home-source').open = false;
  f.citation('home-citation').click();
  assert.equal(f.material('home-source').open, false);
});

test('a citation pointing at a missing or non-material target fails quietly', (t) => {
  const f = fixture(t);
  const stray = f.doc.createElement('button');
  stray.dataset.citation = 'does-not-exist';
  stray.textContent = '出处 [S9]';
  stray.setAttribute('aria-expanded', 'false');
  f.el('view-home').appendChild(stray);
  const controller = createHomeMotion({ doc: f.doc, win: f.win });
  stray.click();
  assert.equal(stray.getAttribute('aria-expanded'), 'false');
  controller.dispose();
});

test('the baseline document is a static evidence composition with synthetic truth and no playback', () => {
  const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
  // Structural redesign: hero input + evidence object, horizontal identity lane,
  // wide conclusion/source comparison — three different layout families.
  assert.match(html, /class="home-hero home-band"/);
  assert.match(html, /class="home-identity"/);
  assert.match(html, /class="home-compare home-band"/);
  assert.equal(html.includes('data-journey-panel'), false, 'no relocated journey panels');
  assert.equal(html.includes('journey-visual'), false, 'no scroll-driven workspace host');
  assert.doesNotMatch(html, /demo-play|demo-toggle|demo-replay|data-stage-button/);
  // The hero object shows support, source, date and explicit uncertainty statically.
  assert.match(html, /有材料支持/);
  assert.match(html, /Lantern 更新记录<small>2025 年 6 月<\/small>/);
  assert.match(html, /还不能证明/);
  assert.match(html, /原创合成示例 · 非实时研究/);
  assert.match(html, /尚未开放订阅或收款/);
  assert.match(html, /模型、API 与服务器费用另计/);
  const motion = readFileSync(new URL('../client/home-motion.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(motion, /\bfetch\s*\(|setTimeout\s*\(|setInterval\s*\(|requestAnimationFrame\s*\(|addEventListener\(['"]scroll|IntersectionObserver/);
  assert.match(motion, /export function createHomeMotion/);
  assert.match(motion, /setActive\(active: boolean\): void/);
  assert.match(motion, /dispose\(\): void/);
});

test('reveal works the same without IntersectionObserver or any media query support', (t) => {
  const f = fixture(t, undefined, (_doc, win) => {
    Object.defineProperty(win, 'matchMedia', { configurable: true, value: undefined });
  });
  assert.equal((f.win as unknown as { IntersectionObserver?: unknown }).IntersectionObserver, undefined);
  f.citation('home-citation').click();
  assert.equal(f.material('home-source').open, true);
  assert.equal(f.doc.activeElement, f.material('home-source').querySelector('summary'));
});

test('system reduced motion always pauses ambient light after the reader has chosen to continue', (t) => {
  let reduced = true;
  let changed: EventListener | null = null;
  const f = fixture(t, evidenceHtml, (_doc, win) => {
    win.matchMedia = (() => ({
      get matches() { return reduced; },
      addEventListener: (_type: string, listener: EventListener) => { changed = listener; },
      removeEventListener: () => { changed = null; }
    })) as unknown as Window['matchMedia'];
  });
  const home = f.el('view-home');
  const toggle = f.el<HTMLButtonElement>('motion-toggle');
  assert.equal(home.dataset.ambientPaused, 'true');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.disabled, true);
  reduced = false;
  (changed as EventListener | null)?.(new f.win.Event('change'));
  assert.equal(home.dataset.ambientPaused, 'false');
  toggle.click();
  assert.equal(home.dataset.ambientPaused, 'true');
  toggle.click();
  assert.equal(home.dataset.ambientPaused, 'false');
  reduced = true;
  (changed as EventListener | null)?.(new f.win.Event('change'));
  assert.equal(home.dataset.ambientPaused, 'true', 'system reduced motion overrides an earlier continue choice');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.disabled, true);
  assert.match(toggle.title, /系统/);
  f.controller.dispose();
  assert.equal(changed, null, 'the system preference listener is released');
});
