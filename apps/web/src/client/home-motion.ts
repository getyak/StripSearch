/**
 * Homepage motion controller.
 *
 * Owns the synthetic evidence artifact on the home page: the four research
 * stages (捕捉 / 发现 / 整理 / 理解), the bounded single-pass demonstration and
 * its pause / resume / jump / replay controls, the source expansion and the
 * one-shot entry stagger plus lower-section reveal.
 *
 * Boundaries:
 * - purely local DOM work: no fetch, no provider, no stream, no storage;
 * - the full synthetic result is rendered by default; playback only starts on
 *   an explicit user action and finishes exactly once;
 * - a user pause never auto-resumes; automatic pauses (hidden document, home
 *   inactive) resume only when their cause is gone;
 * - prefers-reduced-motion is honoured at runtime: all four step explanations
 *   and the final evidence are shown immediately and no timer keeps running;
 * - dispose() cancels timers/animations and removes every listener.
 */

export interface HomeMotionTimers {
  setTimeout(handler: () => void, timeout: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HomeMotionOptions {
  doc?: Document;
  win?: Window;
  timers?: HomeMotionTimers;
  /** Delay between demonstration stages. */
  stepMs?: number;
}

export interface HomeMotionController {
  /** Driven by the router: true while the home view is the active view. */
  setActive(active: boolean): void;
  dispose(): void;
}

type Playback = 'idle' | 'playing' | 'paused' | 'finished';
type PauseReason = 'user' | 'auto';

const STAGE_NAMES: Record<number, string> = { 1: '捕捉', 2: '发现', 3: '整理', 4: '理解' };
const STAGE_CONTEXTS: Record<number, string> = {
  1: '线索 · 林舟 · 合成项目主页',
  2: '来源 · [S1] Lantern 2025.06 更新记录 · 2025 年 6 月',
  3: '时间线 · 2025 年 6 月 · 更新记录',
  4: '结论 · [S1] 更新记录 · 2025 年 6 月'
};

const STATUS = {
  start: '演示开始 · 第 1 / 4 步 捕捉',
  paused: '已暂停。',
  finished: '演示结束 · 结果保留在下方。',
  jump: '已直接查看结果。',
  reduced: '已按系统「减少动态效果」设置，直接显示全部步骤与结果。'
};

const NOOP: HomeMotionController = { setActive: () => undefined, dispose: () => undefined };

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

interface HomeDom {
  artifact: HTMLElement;
  heading: HTMLElement | null;
  composer: HTMLElement | null;
  context: HTMLElement;
  strip: HTMLElement;
  stripEmpty: HTMLElement;
  detail: HTMLElement;
  stageGroup: HTMLElement;
  status: HTMLElement;
  play: HTMLElement;
  toggle: HTMLElement;
  jump: HTMLElement;
  replay: HTMLElement;
  panels: HTMLElement[];
  stageButtons: HTMLElement[];
}

export function createHomeMotion(options: HomeMotionOptions = {}): HomeMotionController {
  const doc = options.doc ?? document;
  const win = options.win ?? (doc.defaultView as Window | null) ?? window;
  const timers: HomeMotionTimers = options.timers ?? {
    setTimeout: (handler, timeout) => win.setTimeout(handler, timeout),
    clearTimeout: (handle) => win.clearTimeout(handle as number)
  };
  const stepMs = options.stepMs ?? 1800;

  const resolved = resolveDom(doc);
  if (!resolved) {
    // Home markup is incomplete: keep the page functional without motion.
    return NOOP;
  }
  const { artifact, heading, composer, context, strip, stripEmpty, detail, stageGroup, status, play, toggle, jump, replay, panels, stageButtons } = resolved;

  const reducedQuery = win.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = win.matchMedia('(pointer: fine)');

  let stage = 4;
  let playback: Playback = 'idle';
  let pauseReason: PauseReason | null = null;
  let active = true;
  let disposed = false;
  let entryRan = false;
  let timer: unknown = null;
  const animations: { cancel(): void }[] = [];
  const stageAnimations: { cancel(): void }[] = [];
  let renderedStage: number | null = null;
  let cacheSuspended = false;
  detail.hidden = true;
  strip.setAttribute('aria-expanded', 'false');

  /* ---------------- rendering ---------------- */

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function renderStage(): void {
    const changed = renderedStage !== null && renderedStage !== stage;
    for (const animation of stageAnimations.splice(0)) animation.cancel();
    artifact.dataset.stage = String(stage);
    for (const panel of panels) {
      panel.hidden = Number(panel.dataset.stage) !== stage;
    }
    for (const button of stageButtons) {
      const current = Number(button.dataset.stageButton) === stage;
      if (current) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    context.textContent = STAGE_CONTEXTS[stage] ?? '';
    const hasSource = stage >= 2;
    strip.hidden = !hasSource;
    stripEmpty.hidden = hasSource;
    if (!hasSource && strip.getAttribute('aria-expanded') === 'true') {
      strip.setAttribute('aria-expanded', 'false');
      detail.hidden = true;
    }
    if (changed && !reducedQuery.matches && active && !cacheSuspended) {
      const panel = panels.find((item) => Number(item.dataset.stage) === stage);
      for (const node of [panel, stage === 2 ? strip : null]) {
        if (!node || typeof node.animate !== 'function') continue;
        stageAnimations.push(node.animate([
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ], { duration: 440, easing: EASE }));
      }
    }
    renderedStage = stage;
  }

  function renderPlayback(): void {
    const focused = doc.activeElement;
    play.hidden = playback !== 'idle';
    toggle.hidden = playback !== 'playing' && playback !== 'paused';
    toggle.textContent = playback === 'paused' ? '继续' : '暂停';
    jump.hidden = playback !== 'playing' && playback !== 'paused';
    replay.hidden = playback !== 'finished';
    if ([play, toggle, jump, replay].includes(focused as HTMLElement) && (focused as HTMLElement).hidden) {
      (playback === 'playing' || playback === 'paused' ? toggle : playback === 'finished' ? replay : play).focus();
    }
  }

  function render(): void {
    if (reducedQuery.matches) return;
    renderStage();
    renderPlayback();
  }

  /* ---------------- playback ---------------- */

  function clearTimer(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    clearTimer();
    timer = timers.setTimeout(advance, stepMs);
  }

  function advance(): void {
    timer = null;
    if (disposed || playback !== 'playing') return;
    if (stage >= 4) {
      finish();
      return;
    }
    stage += 1;
    if (stage === 4) {
      finish();
      return;
    }
    render();
    setStatus(`第 ${stage} / 4 步 ${STAGE_NAMES[stage] ?? ''}`);
    schedule();
  }

  function startPlayback(): void {
    if (disposed || reducedQuery.matches || !active || cacheSuspended || docHidden()) return;
    clearTimer();
    stage = 1;
    playback = 'playing';
    pauseReason = null;
    render();
    setStatus(STATUS.start);
    schedule();
  }

  function finish(): void {
    clearTimer();
    stage = 4;
    playback = 'finished';
    pauseReason = null;
    render();
    setStatus(STATUS.finished);
  }

  function pause(reason: PauseReason): void {
    if (playback !== 'playing') return;
    clearTimer();
    playback = 'paused';
    pauseReason = reason;
    render();
    setStatus(STATUS.paused);
  }

  function resume(): void {
    if (playback !== 'paused') return;
    playback = 'playing';
    pauseReason = null;
    render();
    // Resuming clears the paused status instead of stacking announcements.
    setStatus('');
    schedule();
  }

  function docHidden(): boolean {
    return Boolean(doc.hidden || doc.visibilityState === 'hidden');
  }

  function autoResume(): void {
    if (playback === 'paused' && pauseReason === 'auto' && active && !cacheSuspended && !docHidden() && !reducedQuery.matches) {
      resume();
    }
  }

  function jumpToResult(): void {
    if (disposed || reducedQuery.matches) return;
    clearTimer();
    stage = 4;
    playback = 'finished';
    pauseReason = null;
    render();
    setStatus(STATUS.jump);
  }

  function selectStage(next: number): void {
    if (disposed || reducedQuery.matches) return;
    clearTimer();
    stage = next;
    playback = 'idle';
    pauseReason = null;
    render();
    setStatus(`已手动切换到第 ${stage} / 4 步 · 演示已停止。`);
  }

  /* ---------------- motion mode ---------------- */

  function revealAll(): void {
    for (const target of revealTargets) {
      if (target.classList.contains('reveal-armed')) target.classList.add('is-revealed');
    }
  }

  function applyMotionMode(): void {
    if (reducedQuery.matches) {
      const focusedInControls = stageGroup.contains(doc.activeElement) || [play, toggle, jump, replay].includes(doc.activeElement as HTMLElement);
      clearTimer();
      cancelAnimations();
      artifact.style.transform = '';
      observer?.disconnect();
      observer = null;
      stage = 4;
      playback = 'idle';
      pauseReason = null;
      renderStage();
      artifact.dataset.motion = 'static';
      for (const panel of panels) panel.hidden = false;
      stageGroup.hidden = true;
      play.hidden = true;
      toggle.hidden = true;
      jump.hidden = true;
      replay.hidden = true;
      revealAll();
      setStatus(STATUS.reduced);
      if (focusedInControls) strip.focus();
      return;
    }
    artifact.dataset.motion = 'enabled';
    stageGroup.hidden = false;
    render();
    setStatus('');
  }

  /* ---------------- lower-section reveal ---------------- */

  const revealTargets = [doc.getElementById('example'), doc.getElementById('boundaries')].filter(
    (node): node is HTMLElement => node !== null
  );
  type ObserverLike = { disconnect(): void };
  let observer: ObserverLike | null = null;
  const ObserverCtor = (win as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (typeof ObserverCtor === 'function' && !reducedQuery.matches) {
    const io = new ObserverCtor((entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.12 });
    for (const target of revealTargets) {
      target.classList.add('reveal-armed');
      io.observe(target);
    }
    observer = io;
  }

  /* ---------------- entry stagger (once) ---------------- */

  function runEntry(): void {
    if (entryRan) return;
    entryRan = true;
    if (reducedQuery.matches) return;
    const targets: [HTMLElement | null, number, number][] = [
      [heading, 0, 480],
      [composer, 90, 540],
      [artifact, 180, 600]
    ];
    for (const [node, delay, duration] of targets) {
      if (!node || typeof node.animate !== 'function') continue;
      const animation = node.animate(
        [
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ],
        { duration, delay, easing: EASE, fill: 'backwards' }
      );
      animations.push(animation);
    }
  }

  /* ---------------- listeners ---------------- */

  const onVisibility = (): void => {
    if (disposed) return;
    if (docHidden()) pause('auto');
    else autoResume();
  };

  const onMotionChange = (): void => {
    if (disposed) return;
    applyMotionMode();
  };

  const onStrip = (): void => {
    if (disposed) return;
    const open = strip.getAttribute('aria-expanded') === 'true';
    if (!open) pause('user');
    strip.setAttribute('aria-expanded', String(!open));
    detail.hidden = open;
  };

  const onStageClick = (event: Event): void => {
    const next = Number((event.currentTarget as HTMLElement | null)?.dataset.stageButton);
    if (Number.isInteger(next) && next >= 1 && next <= 4) selectStage(next);
  };

  const onPlay = (): void => startPlayback();
  const onToggle = (): void => {
    if (playback === 'playing') pause('user');
    else if (playback === 'paused') resume();
  };
  const onJump = (): void => jumpToResult();
  const onReplay = (): void => startPlayback();

  const onPointerMove = (event: Event): void => {
    if (disposed || reducedQuery.matches || !finePointer.matches) return;
    const pointer = event as PointerEvent;
    const rect = artifact.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = (pointer.clientX - (rect.left + rect.width / 2)) / rect.width;
    const dy = (pointer.clientY - (rect.top + rect.height / 2)) / rect.height;
    artifact.style.transform = `translate3d(${(-dx * 6).toFixed(2)}px, ${(-dy * 6).toFixed(2)}px, 0)`;
  };

  const onPointerLeave = (): void => {
    artifact.style.transform = '';
  };

  function cancelAnimations(): void {
    for (const animation of animations.splice(0)) animation.cancel();
    for (const animation of stageAnimations.splice(0)) animation.cancel();
  }

  const onPageHide = (event: PageTransitionEvent): void => {
    cacheSuspended = true;
    pause('auto');
    cancelAnimations();
    artifact.style.transform = '';
    revealAll();
    if (!event.persisted) dispose();
  };
  const onPageShow = (): void => {
    cacheSuspended = false;
    autoResume();
  };

  doc.addEventListener('visibilitychange', onVisibility);
  reducedQuery.addEventListener('change', onMotionChange);
  strip.addEventListener('click', onStrip);
  for (const button of stageButtons) button.addEventListener('click', onStageClick);
  play.addEventListener('click', onPlay);
  toggle.addEventListener('click', onToggle);
  jump.addEventListener('click', onJump);
  replay.addEventListener('click', onReplay);
  artifact.addEventListener('pointermove', onPointerMove);
  artifact.addEventListener('pointerleave', onPointerLeave);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);

  applyMotionMode();
  runEntry();

  return {
    setActive(next: boolean): void {
      if (disposed) return;
      active = next;
      if (!active) {
        pause('auto');
        cancelAnimations();
        artifact.style.transform = '';
      }
      else autoResume();
    },
    dispose
  };

  function dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      cancelAnimations();
      artifact.style.transform = '';
      revealAll();
      doc.removeEventListener('visibilitychange', onVisibility);
      reducedQuery.removeEventListener('change', onMotionChange);
      strip.removeEventListener('click', onStrip);
      for (const button of stageButtons) button.removeEventListener('click', onStageClick);
      play.removeEventListener('click', onPlay);
      toggle.removeEventListener('click', onToggle);
      jump.removeEventListener('click', onJump);
      replay.removeEventListener('click', onReplay);
      artifact.removeEventListener('pointermove', onPointerMove);
      artifact.removeEventListener('pointerleave', onPointerLeave);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      observer?.disconnect();
      observer = null;
  }
}

function resolveDom(doc: Document): HomeDom | null {
  const artifact = doc.getElementById('home-artifact');
  const context = doc.getElementById('artifact-context');
  const strip = doc.getElementById('artifact-source-strip');
  const stripEmpty = doc.getElementById('artifact-strip-empty');
  const detail = doc.getElementById('artifact-source-detail');
  const stageGroup = doc.getElementById('artifact-stages');
  const status = doc.getElementById('demo-status');
  const play = doc.getElementById('demo-play');
  const toggle = doc.getElementById('demo-toggle');
  const jump = doc.getElementById('demo-jump');
  const replay = doc.getElementById('demo-replay');
  const panels = [...doc.querySelectorAll<HTMLElement>('#artifact-stage-area .artifact-stage')];
  const stageButtons = [...doc.querySelectorAll<HTMLElement>('[data-stage-button]')];
  if (
    !artifact || !context || !strip || !stripEmpty || !detail || !stageGroup || !status ||
    !play || !toggle || !jump || !replay || panels.length !== 4 || stageButtons.length !== 4
  ) {
    return null;
  }
  return {
    artifact,
    heading: doc.getElementById('hero-title'),
    composer: doc.querySelector<HTMLElement>('.composer-wrap'),
    context,
    strip,
    stripEmpty,
    detail,
    stageGroup,
    status,
    play,
    toggle,
    jump,
    replay,
    panels,
    stageButtons
  };
}
