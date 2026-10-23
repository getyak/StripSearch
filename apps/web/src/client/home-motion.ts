/**
 * Local evidence-reading interactions. All materials remain native details;
 * this controller connects judgments to their sources and preserves the exact
 * reading position for an explicit return. It never requests data or runs a
 * playback clock. Ambient light, when present, is handled entirely by CSS.
 */
export interface HomeMotionOptions {
  doc?: Document;
  win?: Window;
}

export interface HomeMotionController {
  setActive(active: boolean): void;
  dispose(): void;
}

interface ReadingPosition {
  button: HTMLButtonElement;
  x: number;
  y: number;
}

function materialOf(doc: Document, button: HTMLButtonElement): HTMLDetailsElement | null {
  const id = button.dataset.citation ?? button.getAttribute('aria-controls') ?? '';
  const target = id ? doc.getElementById(id) : null;
  return target?.tagName === 'DETAILS' ? target as HTMLDetailsElement : null;
}

function elementOf(target: EventTarget | null): Element | null {
  if (!target || !('nodeType' in target)) return null;
  const node = target as Node;
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

export function createHomeMotion(options: HomeMotionOptions = {}): HomeMotionController {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const home = doc.getElementById('view-home');
  const root = home ?? doc;
  const citations = [...root.querySelectorAll<HTMLButtonElement>('button[data-citation]')];
  const materials = new Set(citations.map((button) => materialOf(doc, button)).filter((material) => material !== null));
  const bookmarks = new Map<HTMLDetailsElement, ReadingPosition>();
  const related = new Set<HTMLElement>();
  const motionToggle = root.querySelector<HTMLButtonElement>('button[data-motion-toggle]');
  const reducedMotion = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let userPaused: boolean | null = null;
  let pointed: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let active = true;
  let cached = false;
  let bound = false;
  let disposed = false;

  function sync(material: HTMLDetailsElement): void {
    for (const button of citations) {
      if (materialOf(doc, button) === material) button.setAttribute('aria-expanded', String(material.open));
    }
    if (material.open && bound) material.dataset.revealed = 'true';
    else delete material.dataset.revealed;
    for (const button of material.querySelectorAll<HTMLButtonElement>('button[data-citation-return]')) {
      button.hidden = !bound || !material.open || !bookmarks.has(material);
    }
  }

  function restore(position: ReadingPosition): void {
    if (!position.button.isConnected) return;
    position.button.focus({ preventScroll: true });
    win.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
  }

  function close(material: HTMLDetailsElement): void {
    const position = bookmarks.get(material);
    bookmarks.delete(material);
    material.open = false;
    sync(material);
    if (position) restore(position);
    else material.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
  }

  function onToggle(event: Event): void {
    const material = event.currentTarget as HTMLDetailsElement;
    sync(material);
    if (material.open) return;
    const position = bookmarks.get(material);
    bookmarks.delete(material);
    // Native summary toggling remains available. Only return a reader who is
    // still inspecting this source; closing elsewhere must not steal focus.
    if (position && material.contains(doc.activeElement)) restore(position);
  }

  function onClick(event: Event): void {
    const target = elementOf(event.target);
    const button = target?.closest<HTMLButtonElement>('button');
    if (!button || !root.contains(button)) return;
    if (button.hasAttribute('data-citation')) {
      const material = materialOf(doc, button);
      if (!material || !materials.has(material)) return;
      bookmarks.set(material, { button, x: win.scrollX, y: win.scrollY });
      material.open = true;
      sync(material);
      const summary = material.querySelector<HTMLElement>('summary');
      summary?.focus({ preventScroll: true });
      // Reveal the actual passage rather than only its disclosure line. The
      // summary retains keyboard focus, ready to close or continue into it.
      (material.querySelector<HTMLElement>('[data-source-location]') ?? summary)
        ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } else if (button.hasAttribute('data-citation-return')) {
      const material = button.closest<HTMLDetailsElement>('details');
      if (material && materials.has(material)) close(material);
    } else if (button === motionToggle) {
      if (reducedMotion?.matches) return;
      userPaused = !(userPaused ?? false);
      syncAmbient();
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const material = elementOf(event.target)?.closest<HTMLDetailsElement>('details');
    if (!material?.open || !materials.has(material)) return;
    event.preventDefault();
    close(material);
  }

  function evidenceOf(target: EventTarget | null): HTMLElement | null {
    const node = elementOf(target)?.closest<HTMLElement>('[data-evidence-key]');
    return node && root.contains(node) && node.closest('[data-evidence-scope]') ? node : null;
  }

  function clearRelated(): void {
    for (const node of related) delete node.dataset.related;
    related.clear();
  }

  function syncRelated(): void {
    clearRelated();
    for (const node of [pointed, focused]) {
      const scope = node?.closest('[data-evidence-scope]');
      const key = node?.dataset.evidenceKey;
      if (!scope || !key) continue;
      for (const match of scope.querySelectorAll<HTMLElement>('[data-evidence-key]')) {
        if (match.dataset.evidenceKey !== key || match.closest('[data-evidence-scope]') !== scope) continue;
        match.dataset.related = 'true';
        related.add(match);
      }
    }
  }

  function onPointerOver(event: PointerEvent): void {
    pointed = event.pointerType === 'touch' ? null : evidenceOf(event.target);
    syncRelated();
  }

  function onPointerOut(event: PointerEvent): void {
    pointed = event.pointerType === 'touch' ? null : evidenceOf(event.relatedTarget);
    syncRelated();
  }

  function onFocusIn(event: FocusEvent): void {
    focused = evidenceOf(event.target);
    syncRelated();
  }

  function onFocusOut(event: FocusEvent): void {
    focused = evidenceOf(event.relatedTarget);
    syncRelated();
  }

  function syncAmbient(): void {
    const systemPaused = reducedMotion?.matches ?? false;
    const paused = systemPaused || (userPaused ?? false);
    if (home) home.dataset.ambientPaused = String(paused || !active || cached || disposed || doc.hidden);
    if (motionToggle) {
      motionToggle.hidden = !bound;
      motionToggle.disabled = systemPaused;
      motionToggle.setAttribute('aria-pressed', String(paused));
      motionToggle.textContent = paused ? '继续光影' : '暂停光影';
      if (systemPaused) motionToggle.title = '已跟随系统的减少动态效果设置';
      else motionToggle.removeAttribute('title');
    }
  }

  function bind(): void {
    if (bound || !active || cached || disposed) return;
    bound = true;
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown as EventListener);
    root.addEventListener('pointerover', onPointerOver as EventListener);
    root.addEventListener('pointerout', onPointerOut as EventListener);
    root.addEventListener('focusin', onFocusIn as EventListener);
    root.addEventListener('focusout', onFocusOut as EventListener);
    for (const material of materials) {
      material.addEventListener('toggle', onToggle);
      sync(material);
    }
  }

  function unbind(): void {
    bound = false;
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeyDown as EventListener);
    root.removeEventListener('pointerover', onPointerOver as EventListener);
    root.removeEventListener('pointerout', onPointerOut as EventListener);
    root.removeEventListener('focusin', onFocusIn as EventListener);
    root.removeEventListener('focusout', onFocusOut as EventListener);
    for (const material of materials) {
      material.removeEventListener('toggle', onToggle);
      delete material.dataset.revealed;
      for (const button of material.querySelectorAll<HTMLButtonElement>('button[data-citation-return]')) button.hidden = true;
    }
    bookmarks.clear();
    pointed = focused = null;
    clearRelated();
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (!event.persisted) return dispose();
    cached = true;
    unbind();
    syncAmbient();
  }

  function onPageShow(): void {
    cached = false;
    bind();
    syncAmbient();
  }

  bind();
  syncAmbient();
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  doc.addEventListener('visibilitychange', syncAmbient);
  reducedMotion?.addEventListener?.('change', syncAmbient);

  return {
    setActive(next): void {
      if (disposed || active === next) return;
      active = next;
      if (active) bind();
      else unbind();
      syncAmbient();
    },
    dispose
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    active = false;
    unbind();
    syncAmbient();
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('pageshow', onPageShow);
    doc.removeEventListener('visibilitychange', syncAmbient);
    reducedMotion?.removeEventListener?.('change', syncAmbient);
  }
}
