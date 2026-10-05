/** Local scroll narrative. It never starts research, fetches data or runs a playback clock. */
export interface HomeMotionOptions {
  doc?: Document;
  win?: Window;
}

export interface HomeMotionController {
  setActive(active: boolean): void;
  dispose(): void;
}

const DESKTOP_QUERY = '(min-width: 1000px) and (min-height: 720px)';
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
const CONTEXTS = ['新的研究', '林舟 / 身份关系', '林舟 / 作品研究'];
const NOOP: HomeMotionController = { setActive() {}, dispose() {} };

export function createHomeMotion(options: HomeMotionOptions = {}): HomeMotionController {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const journey = doc.querySelector<HTMLElement>('.home-journey');
  const visual = doc.getElementById('journey-visual');
  const windowFrame = doc.getElementById('home-artifact');
  const host = doc.getElementById('journey-stage-host');
  const context = doc.getElementById('journey-context');
  const chapters = [...doc.querySelectorAll<HTMLElement>('[data-journey-step]')];
  const panels = [...doc.querySelectorAll<HTMLElement>('[data-journey-panel]')];
  const slots = [...doc.querySelectorAll<HTMLElement>('[data-stage-slot]')];
  const phases = [...doc.querySelectorAll<HTMLElement>('[data-phase]')];
  if (!journey || !visual || !windowFrame || !host || !context || chapters.length !== 3 || panels.length !== 3 || slots.length !== 3) return NOOP;

  const desktop = win.matchMedia?.(DESKTOP_QUERY);
  const reduced = win.matchMedia?.(REDUCED_QUERY);
  const Observer = (win as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  const source = doc.getElementById('home-source') as HTMLDetailsElement | null;
  const citation = doc.getElementById('home-citation');
  let active = true;
  let disposed = false;
  let suspended = false;
  let scrollLayout = false;
  let current = 1;
  let observer: IntersectionObserver | null = null;

  function disconnect(): void {
    observer?.disconnect();
    observer = null;
  }

  function preserveFocus(change: () => void): void {
    const focused = doc.activeElement as HTMLElement | null;
    const panelFocus = panels.some((panel) => panel.contains(focused));
    change();
    if (active && panelFocus && focused && typeof focused.focus === 'function' && doc.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }

  function render(step: number): void {
    const focusedPanel = panels.findIndex((panel) => panel.contains(doc.activeElement));
    // Keep a source being inspected on screen until the user leaves it.
    if (scrollLayout && focusedPanel >= 0 && focusedPanel + 1 !== step) return;
    current = step;
    windowFrame!.dataset.stage = String(step);
    context!.textContent = CONTEXTS[step - 1]!;
    panels.forEach((panel, index) => {
      panel.hidden = scrollLayout && index + 1 !== step;
    });
    phases.forEach((phase, index) => {
      if (scrollLayout && index + 1 === step) phase.setAttribute('aria-current', 'step');
      else phase.removeAttribute('aria-current');
    });
  }

  function syncReadingPosition(): void {
    if (!active || disposed || suspended || !scrollLayout) return;
    // A discrete observer callback reads three rectangles; no scroll handler or frame loop.
    const line = win.innerHeight * .46;
    let step = 1;
    chapters.forEach((chapter, index) => {
      if (chapter.getBoundingClientRect().top <= line) step = index + 1;
    });
    if (step !== current) render(step);
  }

  function useStaticLayout(): void {
    disconnect();
    scrollLayout = false;
    preserveFocus(() => {
      panels.forEach((panel, index) => {
        panel.hidden = false;
        if (panel.parentElement !== slots[index]) slots[index]!.prepend(panel);
      });
      journey!.dataset.layout = 'static';
      visual!.hidden = true;
    });
    phases.forEach((phase) => phase.removeAttribute('aria-current'));
  }

  function configure(): void {
    disconnect();
    if (disposed || !active || suspended || doc.hidden) return;
    if (!desktop?.matches || reduced?.matches || !Observer) {
      useStaticLayout();
      return;
    }
    const focusedPanel = panels.findIndex((panel) => panel.contains(doc.activeElement));
    if (focusedPanel >= 0) current = focusedPanel + 1;
    scrollLayout = true;
    preserveFocus(() => {
      panels.forEach((panel) => { if (panel.parentElement !== host) host!.append(panel); });
      journey!.dataset.layout = 'scroll';
      visual!.hidden = false;
      render(current);
    });
    syncReadingPosition();
    // Pixels keep this viewport band independent of the viewport's width.
    const top = Math.round(win.innerHeight * .46);
    const bottom = Math.max(0, win.innerHeight - top - 2);
    observer = new Observer(() => syncReadingPosition(), {
      rootMargin: `-${top}px 0px -${bottom}px 0px`, threshold: 0
    });
    chapters.forEach((chapter) => observer!.observe(chapter));
  }

  const onFocusOut = (): void => {
    win.queueMicrotask(() => syncReadingPosition());
  };
  const onPageHide = (event: PageTransitionEvent): void => {
    suspended = true;
    disconnect();
    if (!event.persisted) dispose();
  };
  const onPageShow = (): void => {
    suspended = false;
    configure();
  };
  const onSourceToggle = (): void => citation?.setAttribute('aria-expanded', String(source?.open ?? false));
  const onCitation = (): void => {
    if (!source) return;
    source.open = true;
    onSourceToggle();
    source.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  };

  desktop?.addEventListener('change', configure);
  reduced?.addEventListener('change', configure);
  win.addEventListener('resize', configure);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  doc.addEventListener('visibilitychange', configure);
  visual.addEventListener('focusout', onFocusOut);
  citation?.addEventListener('click', onCitation);
  source?.addEventListener('toggle', onSourceToggle);
  configure();

  return {
    setActive(next): void {
      if (disposed || active === next) return;
      active = next;
      configure();
    },
    dispose
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    active = false;
    useStaticLayout();
    desktop?.removeEventListener('change', configure);
    reduced?.removeEventListener('change', configure);
    win.removeEventListener('resize', configure);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('pageshow', onPageShow);
    doc.removeEventListener('visibilitychange', configure);
    visual!.removeEventListener('focusout', onFocusOut);
    citation?.removeEventListener('click', onCitation);
    source?.removeEventListener('toggle', onSourceToggle);
  }
}
