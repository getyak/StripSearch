import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installDom, installFetch, MockEventSource } from './dom-env.js';

const env = installDom();

/* ---------------- controllable clock ---------------- */

interface ScheduledTask {
  id: number;
  at: number;
  fn: () => void;
}

class FakeClock {
  now = 0;
  private seq = 0;
  private tasks: ScheduledTask[] = [];

  setTimeout = (fn: () => void, ms: number): unknown => {
    this.seq += 1;
    this.tasks.push({ id: this.seq, at: this.now + Math.max(0, ms), fn });
    return this.seq;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks = this.tasks.filter((task) => task.id !== handle);
  };

  tick(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.tasks = this.tasks.filter((task) => task !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
  }

  get pending(): number {
    return this.tasks.length;
  }
}

/* ---------------- controllable media queries ---------------- */

type MediaListener = () => void;

interface MediaMock {
  set(query: string, matches: boolean): void;
  listenerCount(query: string): number;
}

function installMediaMock(): MediaMock {
  const state = new Map<string, boolean>([
    ['(prefers-reduced-motion: reduce)', false],
    ['(pointer: fine)', true],
    ['(max-width: 1220px)', false]
  ]);
  const listeners = new Map<string, Set<MediaListener>>();
  const window = env.window as unknown as Record<string, unknown>;
  window.matchMedia = (query: string) => {
    const own = listeners.get(query) ?? new Set<MediaListener>();
    listeners.set(query, own);
    return {
      get matches() {
        return state.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: (type: string, cb: MediaListener) => {
        if (type === 'change') own.add(cb);
      },
      removeEventListener: (type: string, cb: MediaListener) => {
        if (type === 'change') own.delete(cb);
      },
      addListener: (cb: MediaListener) => own.add(cb),
      removeListener: (cb: MediaListener) => own.delete(cb),
      dispatchEvent: () => false
    };
  };
  return {
    set(query, matches) {
      state.set(query, matches);
      for (const cb of [...(listeners.get(query) ?? [])]) cb();
    },
    listenerCount(query) {
      return listeners.get(query)?.size ?? 0;
    }
  };
}

/* ---------------- environment helpers ---------------- */

const media = installMediaMock();

let documentHidden = false;
Object.defineProperty(env.document, 'hidden', {
  configurable: true,
  get: () => documentHidden
});
Object.defineProperty(env.document, 'visibilityState', {
  configurable: true,
  get: () => (documentHidden ? 'hidden' : 'visible')
});

function setHidden(hidden: boolean): void {
  documentHidden = hidden;
  env.document.dispatchEvent(new env.window.Event('visibilitychange'));
}

const providerCalls: string[] = [];
installFetch((url) => {
  providerCalls.push(String(url));
  return new Response('{}');
});

const homeMotionModule = await import('../client/home-motion.js');
const { createHomeMotion } = homeMotionModule;

const STEP_MS = 1000;

type TestContext = { after(fn: () => void): void };

interface Fixture {
  clock: FakeClock;
  controller: { setActive(active: boolean): void; dispose(): void };
  el<T extends Element = HTMLElement>(id: string): T;
  stages(): HTMLElement[];
  activeStage(): number | null;
  play(): void;
  toggle(): void;
  jump(): void;
  replay(): void;
  pickStage(n: number): void;
  toggleSource(): void;
  dispose(): void;
}

function fixture(t: TestContext): Fixture {
  const clock = new FakeClock();
  const controller = createHomeMotion({
    doc: env.document,
    win: env.window as unknown as Window & typeof globalThis,
    timers: clock,
    stepMs: STEP_MS
  });
  const el = <T extends Element = HTMLElement>(id: string): T => {
    const found = env.document.getElementById(id);
    assert.ok(found, `missing #${id}`);
    return found as unknown as T;
  };
  const stages = (): HTMLElement[] =>
    [...env.document.querySelectorAll<HTMLElement>('#artifact-stage-area .artifact-stage')];
  const made: Fixture = {
    clock,
    controller,
    el,
    stages,
    activeStage() {
      const visible = stages().filter((panel) => !panel.hidden);
      return visible.length === 1 ? Number(visible[0]!.dataset.stage) : null;
    },
    play: () => el<HTMLButtonElement>('demo-play').click(),
    toggle: () => el<HTMLButtonElement>('demo-toggle').click(),
    jump: () => el<HTMLButtonElement>('demo-jump').click(),
    replay: () => el<HTMLButtonElement>('demo-replay').click(),
    pickStage(n) {
      const button = env.document.querySelector<HTMLButtonElement>(`[data-stage-button="${n}"]`);
      assert.ok(button, `missing stage button ${n}`);
      button.click();
    },
    toggleSource: () => el<HTMLButtonElement>('artifact-source-strip').click(),
    dispose: () => controller.dispose()
  };
  t.after(() => made.dispose());
  return made;
}

/* ---------------- tests ---------------- */

test('the default render shows the full synthetic result without playing anything', (t) => {
  const f = fixture(t);
  assert.equal(f.activeStage(), 4, 'full useful result is on screen by default');
  const artifact = f.el('home-artifact');
  assert.match(artifact.textContent ?? '', /新增离线阅读与本地索引/);
  assert.match(artifact.textContent ?? '', /原创合成演示 · 非实时研究/);
  assert.match(artifact.textContent ?? '', /还不能证明/);
  assert.equal(f.el('demo-play').hidden, false);
  assert.equal(f.el('demo-toggle').hidden, true);
  assert.equal(f.el('demo-replay').hidden, true);
  assert.equal(f.clock.pending, 0, 'no playback timer before an explicit play');
  assert.match(f.el('artifact-context').textContent ?? '', /结论/);
});

test('explicit play runs a bounded single-pass demonstration that finishes once', (t) => {
  const f = fixture(t);
  f.play();
  assert.equal(f.activeStage(), 1);
  assert.equal(f.el('demo-play').hidden, true);
  assert.equal(f.el('demo-toggle').hidden, false);
  assert.equal(f.clock.pending, 1);
  assert.match(f.el('demo-status').textContent ?? '', /演示开始/);

  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 2);
  assert.match(f.el('demo-status').textContent ?? '', /第 2 \/ 4 步 发现/);

  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 3);

  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 4);
  assert.match(f.el('demo-status').textContent ?? '', /演示结束/);
  assert.equal(f.clock.pending, 0, 'playback completes without further timers');
  assert.equal(f.el('demo-replay').hidden, false);
  assert.equal(f.el('demo-toggle').hidden, true);

  const settled = f.el('demo-status').textContent;
  f.clock.tick(STEP_MS * 5);
  assert.equal(f.activeStage(), 4, 'completion happens once');
  assert.equal(f.el('demo-status').textContent, settled, 'no further status chatter after completion');
});

test('pause and resume stay under user control and resume clears the status', (t) => {
  const f = fixture(t);
  f.play();
  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 2);

  f.toggle();
  assert.equal(f.el('demo-toggle').textContent?.trim(), '继续');
  assert.match(f.el('demo-status').textContent ?? '', /已暂停/);
  assert.equal(f.clock.pending, 0);
  f.clock.tick(STEP_MS * 4);
  assert.equal(f.activeStage(), 2, 'paused playback does not advance');

  // A user pause must never auto-resume, not even when visibility and home activity return.
  setHidden(true);
  setHidden(false);
  f.controller.setActive(false);
  f.controller.setActive(true);
  assert.equal(f.clock.pending, 0, 'user pause survives visibility and route changes');

  f.toggle();
  assert.equal(f.el('demo-toggle').textContent?.trim(), '暂停');
  assert.equal(f.el('demo-status').textContent, '', 'resume clears the paused status');
  assert.equal(f.clock.pending, 1);
  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 3);
});

test('a hidden document and an inactive home pause playback, and automatic pauses resume', (t) => {
  const f = fixture(t);
  f.play();
  setHidden(true);
  assert.equal(f.clock.pending, 0, 'hidden document pauses the demo');
  assert.match(f.el('demo-status').textContent ?? '', /已暂停/);
  f.clock.tick(STEP_MS * 3);
  assert.equal(f.activeStage(), 1);
  setHidden(false);
  assert.equal(f.clock.pending, 1, 'an automatic pause resumes when the document is visible again');
  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 2);

  f.controller.setActive(false);
  assert.equal(f.clock.pending, 0, 'leaving home pauses the demo');
  f.clock.tick(STEP_MS * 3);
  assert.equal(f.activeStage(), 2);
  f.controller.setActive(true);
  assert.equal(f.clock.pending, 1, 'returning home resumes the automatic pause');
  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 3);
});

test('manual stage selection cancels playback and updates the selected and source context', (t) => {
  const f = fixture(t);
  f.play();
  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 2);

  const buttons = [...env.document.querySelectorAll<HTMLButtonElement>('[data-stage-button]')];
  assert.equal(buttons.length, 4);
  for (const button of buttons) assert.equal(button.tagName, 'BUTTON');
  const third = buttons.find((button) => button.dataset.stageButton === '3');
  assert.ok(third);
  third.click();

  assert.equal(f.clock.pending, 0, 'manual selection cancels playback');
  assert.equal(f.activeStage(), 3);
  assert.equal(third.getAttribute('aria-current'), 'step');
  assert.equal(
    buttons.find((button) => button.dataset.stageButton === '2')?.hasAttribute('aria-current'),
    false
  );
  assert.match(f.el('artifact-context').textContent ?? '', /时间线/);
  assert.match(f.el('demo-status').textContent ?? '', /演示已停止/);
  assert.equal(f.el('demo-play').hidden, false, 'playback controls reset to an explicit start');

  f.clock.tick(STEP_MS * 4);
  assert.equal(f.activeStage(), 3, 'no automatic transition after manual selection');

  const first = buttons.find((button) => button.dataset.stageButton === '1');
  assert.ok(first);
  first.click();
  assert.equal(f.activeStage(), 1);
  assert.match(f.el('artifact-context').textContent ?? '', /线索/);
  assert.equal(f.el('artifact-source-strip').hidden, true, 'the source has not been found at the clue stage');
  assert.equal(f.el('artifact-strip-empty').hidden, false);
});

test('jump-to-result lands on the final evidence immediately', (t) => {
  const f = fixture(t);
  f.play();
  f.clock.tick(STEP_MS);
  f.jump();
  assert.equal(f.activeStage(), 4);
  assert.equal(f.clock.pending, 0);
  assert.match(f.el('demo-status').textContent ?? '', /已直接查看结果/);
  assert.equal(f.el('demo-replay').hidden, false);
  f.clock.tick(STEP_MS * 4);
  assert.equal(f.activeStage(), 4);
});

test('replay restarts the bounded demonstration from the beginning', (t) => {
  const f = fixture(t);
  f.play();
  f.clock.tick(STEP_MS * 3);
  assert.equal(f.activeStage(), 4);
  assert.equal(f.el('demo-replay').hidden, false);
  f.replay();
  assert.equal(f.activeStage(), 1);
  assert.equal(f.clock.pending, 1);
  f.clock.tick(STEP_MS * 3);
  assert.equal(f.activeStage(), 4, 'the replayed demonstration finishes once as well');
  assert.equal(f.clock.pending, 0);
});

test('runtime reduced motion shows all steps at once and stops every timer', (t) => {
  const f = fixture(t);
  f.play();
  f.clock.tick(STEP_MS);
  assert.equal(f.activeStage(), 2);

  media.set('(prefers-reduced-motion: reduce)', true);
  assert.equal(f.clock.pending, 0, 'no timer survives the reduced-motion switch');
  for (const panel of f.stages()) assert.equal(panel.hidden, false, 'all four step explanations stay visible');
  assert.match(f.el('home-artifact').textContent ?? '', /新增离线阅读与本地索引/, 'final evidence stays visible');
  assert.equal(f.el('demo-toggle').hidden, true);
  assert.match(f.el('demo-status').textContent ?? '', /减少动态效果/);
  f.clock.tick(STEP_MS * 5);
  for (const panel of f.stages()) assert.equal(panel.hidden, false, 'nothing animates while reduced motion is on');

  media.set('(prefers-reduced-motion: reduce)', false);
  assert.equal(f.activeStage() !== null, true, 'a single selected stage returns when motion is allowed again');
  f.play();
  assert.equal(f.activeStage(), 1, 'playback works again after restoring motion');
  assert.equal(f.clock.pending, 1);
});

test('stage buttons are native buttons and the source expands from the keyboard-activated control', (t) => {
  const f = fixture(t);
  const strip = f.el<HTMLButtonElement>('artifact-source-strip');
  assert.equal(strip.tagName, 'BUTTON');
  assert.equal(strip.getAttribute('aria-expanded'), 'false');
  assert.equal(f.el('artifact-source-detail').hidden, true);

  f.toggleSource();
  assert.equal(strip.getAttribute('aria-expanded'), 'true');
  assert.equal(f.el('artifact-source-detail').hidden, false);
  assert.match(f.el('artifact-source-detail').textContent ?? '', /新增离线阅读与本地索引/);
  assert.match(f.el('artifact-source-detail').textContent ?? '', /还不能证明/);

  f.toggleSource();
  assert.equal(strip.getAttribute('aria-expanded'), 'false');
  assert.equal(f.el('artifact-source-detail').hidden, true);
});

test('the entry stagger starts once and stays off under reduced motion', (t) => {
  const animated: string[] = [];
  const fakeAnimate = function (this: Element): { cancel(): void; finished: Promise<void> } {
    animated.push(this.id || this.className);
    return { cancel: () => undefined, finished: Promise.resolve() };
  };
  for (const id of ['hero-title', 'home-artifact']) {
    const node = env.document.getElementById(id)!;
    (node as unknown as { animate: unknown }).animate = fakeAnimate;
  }
  const composer = env.document.querySelector('.composer-wrap') as HTMLElement;
  (composer as unknown as { animate: unknown }).animate = fakeAnimate;

  const f = fixture(t);
  assert.equal(animated.length, 3, 'heading, composer and artifact enter together');
  f.controller.setActive(false);
  f.controller.setActive(true);
  assert.equal(animated.length, 3, 'the entry stagger starts once');
  f.dispose();

  media.set('(prefers-reduced-motion: reduce)', true);
  try {
    animated.length = 0;
    const reduced = fixture(t);
    assert.equal(animated.length, 0, 'no entry animation under reduced motion');
    reduced.controller.setActive(false);
    reduced.controller.setActive(true);
    assert.equal(animated.length, 0);
  } finally {
    media.set('(prefers-reduced-motion: reduce)', false);
  }
});

test('the lower sections reveal once through IntersectionObserver and stay visible', (t) => {
  const observed: Element[] = [];
  let notify: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
  class FakeObserver {
    constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
      notify = callback;
    }
    observe(target: Element): void {
      observed.push(target);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  const window = env.window as unknown as Record<string, unknown>;
  window.IntersectionObserver = FakeObserver;
  for (const id of ['example', 'boundaries']) {
    env.document.getElementById(id)!.classList.remove('reveal-armed', 'is-revealed');
  }
  try {
    const f = fixture(t);
    assert.equal(observed.length, 2, 'both lower sections are armed once');
    const target = env.document.getElementById('example')!;
    assert.ok(target.classList.contains('reveal-armed'));
    assert.equal(target.classList.contains('is-revealed'), false);
    notify!([{ target, isIntersecting: true }]);
    assert.ok(target.classList.contains('is-revealed'));
    notify!([{ target, isIntersecting: false }]);
    assert.ok(target.classList.contains('is-revealed'), 'revealed content never hides again');
    f.controller.setActive(false);
  } finally {
    delete window.IntersectionObserver;
  }
});

test('dispose cancels timers and detaches every listener', (t) => {
  const f = fixture(t);
  f.play();
  assert.equal(f.clock.pending, 1);
  f.dispose();

  assert.equal(f.clock.pending, 0, 'dispose clears pending work');
  setHidden(true);
  setHidden(false);
  media.set('(prefers-reduced-motion: reduce)', true);
  media.set('(prefers-reduced-motion: reduce)', false);
  f.controller.setActive(false);
  f.controller.setActive(true);
  f.play();
  f.clock.tick(STEP_MS * 10);
  assert.equal(f.activeStage(), 1, 'a disposed controller keeps its last rendered state');
  assert.equal(f.clock.pending, 0, 'a disposed controller schedules nothing');
  assert.equal(media.listenerCount('(prefers-reduced-motion: reduce)'), 0, 'media listeners are removed');
});

test('home motion never issues provider or stream requests', (t) => {
  providerCalls.length = 0;
  MockEventSource.instances.length = 0;
  const f = fixture(t);
  f.play();
  f.clock.tick(STEP_MS * 3);
  f.toggleSource();
  f.pickStage(2);
  f.play();
  f.clock.tick(STEP_MS * 4);
  f.toggleSource();
  f.jump();
  assert.deepEqual(providerCalls, [], 'no fetch request was made');
  assert.equal(MockEventSource.instances.length, 0, 'no event stream was opened');
});

test('cached page round trip retains controls and user pause', (t) => {
 const f=fixture(t);
 f.play(); f.toggle();
 env.window.dispatchEvent(new env.window.PageTransitionEvent('pagehide',{persisted:true}));
 env.window.dispatchEvent(new env.window.PageTransitionEvent('pageshow',{persisted:true}));
 assert.equal(f.clock.pending,0);
 f.toggle(); assert.equal(f.clock.pending,1);
 env.window.dispatchEvent(new env.window.PageTransitionEvent('pagehide',{persisted:true}));
 assert.equal(f.clock.pending,0,'BFCache suspension stops timers');
 env.window.dispatchEvent(new env.window.PageTransitionEvent('pageshow',{persisted:true}));
 assert.equal(f.clock.pending,1);
 f.pickStage(2); f.toggleSource();
 assert.equal(f.el('artifact-source-detail').hidden,false);
});

test('reduction during clue stage restores final provenance and cancels entry', (t) => {
 let canceled=0;
 const ids=['hero-title','home-artifact'];
 for(const id of ids) (env.document.getElementById(id) as unknown as { animate: () => { cancel(): void } }).animate=()=>({cancel:()=>{canceled++;}});
 const f=fixture(t); f.play();
 f.el('home-artifact').style.transform='translate3d(2px,2px,0)';
 media.set('(prefers-reduced-motion: reduce)',true);
 try {
 assert.ok(canceled>=2,'running WAAPI entry cancels');
 assert.equal(f.el('home-artifact').style.transform,'');
 assert.equal(f.el('artifact-source-strip').hidden,false);
 assert.match(f.el('artifact-context').textContent??'',/结论/);
 assert.equal(f.clock.pending,0);
 } finally {media.set('(prefers-reduced-motion: reduce)',false);}
});

test('opening a citation pauses playback for deliberate reading', (t)=>{
 const f=fixture(t);f.play();f.clock.tick(STEP_MS);f.toggleSource();
 assert.equal(f.clock.pending,0);
 setHidden(true);setHidden(false);assert.equal(f.clock.pending,0);
 f.toggle();assert.equal(f.clock.pending,1);
});

test('keyboard focus follows a replaced playback control', (t)=>{
 const f=fixture(t);f.el('demo-play').focus();f.play();
 assert.equal(env.document.activeElement,f.el('demo-toggle'));
 f.el('demo-jump').focus();f.jump();
 assert.equal(env.document.activeElement,f.el('demo-replay'));
});

 test('rapid manual steps cancel the old material transition', (t)=>{
 let started=0,canceled=0;
 for(const p of env.document.querySelectorAll('.artifact-stage')) (p as unknown as { animate: () => { cancel(): void } }).animate=()=>{started++;return {cancel:()=>{canceled++;}};};
 const f=fixture(t);f.pickStage(1);f.pickStage(2);
 assert.ok(started>=2);assert.ok(canceled>=1);
 });


test('static HTML provides readable provenance and hides JS-only controls', () => {
  const doc = env.document.implementation.createHTMLDocument('Static home');
  doc.body.innerHTML = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
  const byId = (id: string) => doc.getElementById(id) as HTMLElement;
  assert.equal(byId('demo-play').hidden, true);
  assert.equal(byId('artifact-stages').hidden, true);
  assert.equal(byId('artifact-source-strip').hidden, true);
  assert.equal(byId('artifact-source-detail').hidden, false);
  assert.match(byId('artifact-source-detail').textContent ?? '', /2025 年 6 月/);
  assert.equal(doc.querySelectorAll('.artifact-stage[hidden]').length, 0);
});

test('actual routing scopes the campaign theme and preserves cached controls', async (t) => {
  const main = (await import('../client/main.js')).__test;
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
  t.after(() => main.homeMotion.dispose());
  main.state.user = { id: 'home-test', name: 'Synthetic', email: 'home@example.test' };
  for (const [hash, view] of [['#/app', 'app'], ['#/review', 'review'], ['#/', 'home']]) {
    env.window.location.hash = hash!;
    env.window.dispatchEvent(new env.window.HashChangeEvent('hashchange'));
    assert.equal(env.document.body.dataset.view, view);
  }
  env.window.dispatchEvent(new env.window.PageTransitionEvent('pagehide', { persisted: true }));
  env.window.dispatchEvent(new env.window.PageTransitionEvent('pageshow', { persisted: true }));
  env.document.querySelector<HTMLButtonElement>('[data-stage-button="2"]')!.click();
  assert.equal(env.document.querySelector<HTMLElement>('[data-stage="2"].artifact-stage')!.hidden, false);
  env.document.getElementById('artifact-source-strip')!.click();
  assert.equal((env.document.getElementById('artifact-source-detail') as HTMLElement).hidden, false);
});
