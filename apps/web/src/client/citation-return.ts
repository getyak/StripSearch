/**
 * Citation inspection return controller.
 *
 * Records how the source panel was entered (report citation click, source list
 * browsing, local search, or the toolbar button) and makes every exit safe:
 * - the "返回原句" action restores the original citation's focus and the exact
 *   reading scroll offset of the report container;
 * - closing the inspector / drawer returns to the recorded entry point, or to a
 *   caller fallback, never to a removed element or a previous report;
 * - re-renders (polling, exclusion toggles) re-resolve the exact citation by
 *   its semantic report anchor (section/bullet/citation position), never by
 *   source key alone - repeated citations of the same source keep their own
 *   identity and reading offset; when the exact citation is gone (report
 *   switch, deletion, revocation removal) the record is dropped instead of
 *   resurrecting stale focus;
 * - reduced motion suppresses the transient emphasis class.
 */

export type SourceEntryKind = 'citation' | 'list' | 'search' | 'button';

export interface SourceEntry {
  kind: SourceEntryKind;
  runId: string;
  sourceKey: string;
  /** Semantic report location of the exact citation (stable across re-renders). */
  anchor: string | null;
  /** Where focus goes when inspection ends; re-resolved after re-renders. */
  returnTo: HTMLElement | null;
  /** Selector able to re-find the exact return target after a re-render. */
  returnSelector: string | null;
  /** Report-container scroll offset captured at entry (the reading position). */
  scrollTop: number;
}

export interface CitationReturnTimers {
  setTimeout(handler: () => void, timeout: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CitationReturnOptions {
  doc?: Document;
  win?: Window;
  timers?: CitationReturnTimers;
  /** Report container holding `button.citation[data-source]` elements. */
  report(): HTMLElement | null;
  /** Scroll container whose scrollTop is the reading position. */
  scroller(): HTMLElement | null;
  /** Current run id, or null when no report is loaded. */
  runId(): string | null;
  reducedMotion?(): boolean;
}

export interface CitationReturnController {
  /** Record a report-citation entry (the core interaction). */
  enterViaCitation(sourceKey: string, anchor: string, button: HTMLElement | null): void;
  /** Record a plain source-list selection. */
  enterViaList(sourceKey: string, row: HTMLElement | null): void;
  /** Record a local-search selection (returns to the search opener). */
  enterViaSearch(sourceKey: string, fallback: HTMLElement | null): void;
  /** Record the toolbar-button entry (mobile drawer opened from the bar). */
  enterViaButton(sourceKey: string, button: HTMLElement | null): void;
  entry(): SourceEntry | null;
  canReturn(): boolean;
  /** Restore citation focus + reading position. False when the record is stale. */
  returnToCitation(): boolean;
  /** Exit helper: return to the recorded entry (or fallback) if still valid. */
  restoreEntryFocus(fallback?: HTMLElement | null): boolean;
  /** Drop/re-resolve the record after a render or run change. */
  sync(): void;
  clear(): void;
  /** Short-lived emphasis on the located source; off under reduced motion. */
  emphasize(target: HTMLElement | null): void;
}

const NOOP: CitationReturnController = {
  enterViaCitation: () => undefined,
  enterViaList: () => undefined,
  enterViaSearch: () => undefined,
  enterViaButton: () => undefined,
  entry: () => null,
  canReturn: () => false,
  returnToCitation: () => false,
  restoreEntryFocus: () => false,
  sync: () => undefined,
  clear: () => undefined,
  emphasize: () => undefined
};

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/[\n\r\f]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `);
}

export function createCitationReturn(options: CitationReturnOptions): CitationReturnController {
  const doc = options.doc ?? document;
  const win = options.win ?? (doc.defaultView as Window | null) ?? window;
  const timers: CitationReturnTimers = options.timers ?? {
    setTimeout: (handler, timeout) => win.setTimeout(handler, timeout),
    clearTimeout: (handle) => win.clearTimeout(handle as number)
  };

  let record: SourceEntry | null = null;
  const emphasisTimers = new Map<HTMLElement, unknown>();

  function reducedMotion(): boolean {
    try {
      return Boolean(options.reducedMotion?.() ?? win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function enter(
    kind: SourceEntryKind,
    sourceKey: string,
    anchor: string | null,
    returnTo: HTMLElement | null,
    returnSelector: string | null
  ): void {
    const runId = options.runId();
    if (!runId) {
      record = null;
      return;
    }
    record = {
      kind,
      runId,
      sourceKey,
      anchor,
      returnTo,
      returnSelector,
      scrollTop: options.scroller()?.scrollTop ?? 0
    };
  }

  function focusSafe(target: HTMLElement | null): boolean {
    if (!target || !target.isConnected || typeof target.focus !== 'function') return false;
    target.focus({ preventScroll: true });
    return doc.activeElement === target;
  }

  function currentEntry(): SourceEntry | null {
    if (!record) return null;
    if (record.runId !== options.runId()) {
      record = null;
      return null;
    }
    if (record.returnTo && !record.returnTo.isConnected) record.returnTo = null;
    return record;
  }

  function emphasize(target: HTMLElement | null): void {
    if (!target) return;
    const previous = emphasisTimers.get(target);
    if (previous !== undefined) timers.clearTimeout(previous);
    if (reducedMotion()) {
      emphasisTimers.delete(target);
      target.classList.remove('emphasis');
      return;
    }
    target.classList.add('emphasis');
    const handle = timers.setTimeout(() => {
      emphasisTimers.delete(target);
      target.classList.remove('emphasis');
    }, 260);
    emphasisTimers.set(target, handle);
  }

  function returnToCitation(): boolean {
    const entry = currentEntry();
    if (!entry || entry.kind !== 'citation') return false;
    // Verify source and sentence too: an updated report can reuse an array slot.
    const target = entry.returnSelector
      ? options.report()?.querySelector<HTMLElement>(entry.returnSelector) ?? null : null;
    entry.returnTo = target;
    // An explicit return reveals the sentence even if its disclosure was closed.
    for (let parent = target?.parentElement; parent && parent !== options.report(); parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
    }
    if (!focusSafe(target)) {
      // The citation no longer exists: drop the record, never fake a return.
      record = null;
      return false;
    }
    const scroller = options.scroller();
    if (scroller) scroller.scrollTop = entry.scrollTop;
    emphasize(target);
    return true;
  }

  function restoreEntryFocus(fallback: HTMLElement | null = null): boolean {
    const entry = currentEntry();
    if (entry && entry.kind === 'citation') return returnToCitation() || focusSafe(fallback);
    if (entry && entry.kind === 'list' && entry.returnSelector && !entry.returnTo?.isConnected) {
      entry.returnTo = doc.querySelector<HTMLElement>(entry.returnSelector);
    }
    if (entry && focusSafe(entry.returnTo)) {
      emphasize(entry.returnTo);
      return true;
    }
    return focusSafe(fallback);
  }

  function sync(): void {
    const entry = currentEntry();
    if (!entry) return;
    if (entry.kind === 'citation') {
      const resolved = entry.returnSelector
        ? options.report()?.querySelector<HTMLElement>(entry.returnSelector) ?? null
        : null;
      entry.returnTo = resolved;
      if (!resolved) record = null;
      return;
    }
    if (entry.kind === 'list' && entry.returnSelector) {
      entry.returnTo = doc.querySelector<HTMLElement>(entry.returnSelector);
    }
  }

  return {
    enterViaCitation(sourceKey, anchor, button) {
      const context = button?.dataset.citationContext;
      enter(
        'citation',
        sourceKey,
        anchor,
        button,
        `button.citation[data-citation-anchor="${quote(anchor)}"][data-source="${quote(sourceKey)}"]${context !== undefined ? `[data-citation-context="${quote(context)}"]` : ''}`
      );
    },
    enterViaList(sourceKey, row) {
      const listId = row?.closest('.source-list')?.id ?? '';
      enter(
        'list',
        sourceKey,
        null,
        row,
        listId ? `#${listId} button.source-row[data-source-key="${quote(sourceKey)}"]` : null
      );
    },
    enterViaSearch(sourceKey, fallback) {
      enter('search', sourceKey, null, fallback, null);
    },
    enterViaButton(sourceKey, button) {
      enter('button', sourceKey, null, button, null);
    },
    entry: () => currentEntry(),
    canReturn() {
      const entry = currentEntry();
      return Boolean(entry && entry.kind === 'citation' && (entry.returnTo?.isConnected ?? false));
    },
    returnToCitation,
    restoreEntryFocus,
    sync,
    clear() {
      record = null;
      for (const [target, handle] of emphasisTimers) {
        timers.clearTimeout(handle);
        target.classList.remove('emphasis');
      }
      emphasisTimers.clear();
    },
    emphasize
  };
}

export { NOOP as noopCitationReturn };
