import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom } from './dom-env.js';
import { createHomeMotion } from '../client/home-motion.js';

function fixture(t: { after(fn: () => void): void }) {
  const env = installDom();
  const win = env.window as unknown as Window & typeof globalThis;
  const doc = env.document;
  const controller = createHomeMotion({ doc, win });
  t.after(() => controller.dispose());
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => doc.getElementById(id)! as T;
  return {
    controller, doc, win, el,
    citation: (id: string) => el<HTMLButtonElement>(id),
    material: (id: string) => el<HTMLDetailsElement>(id)
  };
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

test('real navigation disposes the controller while cached pages keep their state', (t) => {
  const f = fixture(t);
  f.win.dispatchEvent(new f.win.PageTransitionEvent('pagehide', { persisted: true }));
  f.citation('home-citation').click();
  assert.equal(f.material('home-source').open, true, 'cached page keeps its listeners and DOM');
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
  f.doc.body.appendChild(stray);
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
  const f = fixture(t);
  assert.equal((f.win as unknown as { IntersectionObserver?: unknown }).IntersectionObserver, undefined);
  f.citation('home-citation').click();
  assert.equal(f.material('home-source').open, true);
  assert.equal(f.doc.activeElement, f.material('home-source').querySelector('summary'));
});
