/**
 * Local citation reveal for the evidence-reading home (2026-10-14 redesign).
 *
 * The home composition is static: panels never move, there is no automatic
 * scroll narrative, and no playback clock exists. The single brand motion is the
 * explicit reveal of a cited material: activating a citation opens the matching
 * source card in place, marks it for a short (CSS-driven, 200ms) colour/opacity
 * emphasis and moves keyboard focus onto its disclosure summary. All content is
 * readable without JavaScript; this controller only connects citation buttons
 * to materials that the page already ships.
 *
 * It never starts research, fetches data or runs a timer.
 */
export interface HomeMotionOptions {
  doc?: Document;
  win?: Window;
}

export interface HomeMotionController {
  setActive(active: boolean): void;
  dispose(): void;
}

const NOOP: HomeMotionController = { setActive() {}, dispose() {} };

function materialOf(doc: Document, button: HTMLButtonElement): HTMLDetailsElement | null {
  const id = button.dataset.citation ?? button.getAttribute('aria-controls') ?? '';
  const target = id ? doc.getElementById(id) : null;
  return target && target.tagName === 'DETAILS' ? (target as HTMLDetailsElement) : null;
}

export function createHomeMotion(options: HomeMotionOptions = {}): HomeMotionController {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const citations = [...doc.querySelectorAll<HTMLButtonElement>('button[data-citation]')];
  if (citations.length === 0) return NOOP;

  let active = true;
  let disposed = false;

  function sync(button: HTMLButtonElement): void {
    const material = materialOf(doc, button);
    if (!material) return;
    button.setAttribute('aria-expanded', String(material.open));
    // The emphasis contract is a one-shot 200ms colour/opacity reveal attached
    // to the opened material; closing removes it so a later reveal repeats.
    if (material.open) material.dataset.revealed = 'true';
    else delete material.dataset.revealed;
  }

  function onCitationClick(button: HTMLButtonElement): void {
    if (!active || disposed) return;
    const material = materialOf(doc, button);
    if (!material) return;
    if (!material.open) material.open = true;
    sync(button);
    // Native focus keeps the disclosure in view after an explicit activation,
    // including when the narrow-screen source follows a taller comparison.
    material.querySelector<HTMLElement>('summary')?.focus();
  }

  function onToggle(button: HTMLButtonElement): void {
    if (disposed) return;
    sync(button);
  }

  const bindings = citations.map((button) => {
    const reveal = (): void => onCitationClick(button);
    const syncState = (): void => onToggle(button);
    button.addEventListener('click', reveal);
    const material = materialOf(doc, button);
    material?.addEventListener('toggle', syncState);
    sync(button);
    return { button, material, reveal, syncState };
  });

  const onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) dispose();
  };
  win.addEventListener('pagehide', onPageHide);

  return {
    setActive(next): void {
      if (disposed || active === next) return;
      active = next;
    },
    dispose
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    active = false;
    win.removeEventListener('pagehide', onPageHide);
    for (const { button, material, reveal, syncState } of bindings) {
      button.removeEventListener('click', reveal);
      material?.removeEventListener('toggle', syncState);
    }
  }
}
