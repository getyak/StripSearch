/**
 * Native-dialog local search / navigation.
 *
 * Scope (deliberately narrow): it filters only what is already loaded into
 * this account's interface - the history report titles/questions and the
 * current report's source titles, URLs and available excerpts. It never talks
 * to a provider, never searches the web, never does full-text retrieval over
 * stored documents and never persists the typed query.
 *
 * Behaviour contract:
 * - a button and Cmd/Ctrl+K open the dialog; the shortcut ignores IME
 *   composition, key repeat, modifier combinations beyond a single Cmd/Ctrl
 *   and never stacks over another open native dialog;
 * - results are a combobox listbox: ArrowUp/ArrowDown move the active option
 *   (focus stays in the input, `aria-activedescendant` follows), Enter opens
 *   the active option, Escape closes;
 * - empty state (nothing loaded) and no-match state are distinct and honest;
 * - closing clears the query and the rendered results; account switches and
 *   sign-out call reset() so one account's titles can never linger;
 * - native dialog close events are queued, not synchronous: every close carries
 *   a durable intent (restore / select / silent) consumed exactly once. A stale
 *   close event can neither steal selection focus, nor clear a dialog that was
 *   reopened in the meantime, nor resurrect an old account's focus;
 * - closing returns focus to the opener when it is still connected, otherwise
 *   to the caller's fallback - never to a removed element.
 */

export type LocalSearchItemKind = 'history' | 'source';

export interface LocalSearchItem {
  /** runId for history rows, sourceKey for source rows. */
  id: string;
  kind: LocalSearchItemKind;
  title: string;
  /** Secondary line already formatted for humans. */
  meta: string;
  /** Text actually used for filtering (pre-lowercased by the provider). */
  haystack: string;
}

export interface LocalSearchOptions {
  doc?: Document;
  win?: Window;
  /** Fresh snapshot of the loaded, current-account data. */
  getItems(): LocalSearchItem[];
  onSelect(item: LocalSearchItem): void;
  /** Shortcut gating (active workspace, signed-in account). */
  isAvailable?(): boolean;
  /** Focus target when the recorded opener disappeared. */
  getFallbackFocus?(): HTMLElement | null;
  /** Reduced motion right now: suppresses the result entrance class. */
  reducedMotion?(): boolean;
}

export interface LocalSearchController {
  isOpen(): boolean;
  open(trigger?: HTMLElement | null): void;
  close(): void;
  /** Re-run the current filter over fresh data (run switch while open). */
  refresh(): void;
  /** Close and drop every query/result (sign-out, account switch). */
  reset(): void;
  /** Global Cmd/Ctrl+K gate; returns true when the event was handled. */
  handleKeyDown(event: KeyboardEvent): boolean;
  /** Current query, for tests and honest debugging. */
  query(): string;
  /** Number of options currently rendered. */
  resultCount(): number;
}

const OPTION_ID_PREFIX = 'search-option-';

export function createLocalSearch(options: LocalSearchOptions): LocalSearchController {
  const doc = options.doc ?? document;
  const win = options.win ?? (doc.defaultView as Window | null) ?? window;
  const dialog = doc.getElementById('search-dialog') as HTMLDialogElement | null;
  const input = doc.getElementById('search-input') as HTMLInputElement | null;
  const results = doc.getElementById('search-results') as HTMLElement | null;
  const empty = doc.getElementById('search-empty') as HTMLElement | null;
  if (!dialog || !input || !results || !empty) {
    // Incomplete markup: keep the page usable without search.
    return {
      isOpen: () => false,
      open: () => undefined,
      close: () => undefined,
      refresh: () => undefined,
      reset: () => undefined,
      handleKeyDown: () => false,
      query: () => '',
      resultCount: () => 0
    };
  }

  let items: LocalSearchItem[] = [];
  let matches: LocalSearchItem[] = [];
  let activeIndex = -1;
  let opener: HTMLElement | null = null;
  /**
   * Dialog lifetime counter. close events are queued by the browser: a close
   * intent is only valid for the dialog generation that produced it.
   */
  let epoch = 0;
  type CloseReason = 'restore' | 'select' | 'silent';
  let pendingClose: { epoch: number; reason: CloseReason } | null = null;

  function reducedMotion(): boolean {
    try {
      return Boolean(options.reducedMotion?.() ?? win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function lowerQuery(): string {
    return input!.value.trim().toLowerCase();
  }

  function setActive(index: number): void {
    const buttons = [...results!.querySelectorAll<HTMLButtonElement>('.search-result')];
    if (buttons.length === 0) {
      activeIndex = -1;
      input!.removeAttribute('aria-activedescendant');
      return;
    }
    activeIndex = Math.max(0, Math.min(index, buttons.length - 1));
    for (const [position, button] of buttons.entries()) {
      const active = position === activeIndex;
      button.setAttribute('aria-selected', String(active));
      if (active) {
        input!.setAttribute('aria-activedescendant', button.id);
        button.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }

  function selectActive(): void {
    const chosen = matches[activeIndex];
    if (!chosen) return;
    // A durable "select" close intent keeps focus on the selected destination;
    // the queued close event must not restore the opener over it.
    closeWith('select', chosen);
  }

  function render(preserveActive = true): void {
    const previous = preserveActive && activeIndex >= 0 ? matches[activeIndex] ?? null : null;
    const query = lowerQuery();
    matches = query.length === 0
      ? [...items]
      : items.filter((item) => item.haystack.includes(query));
    results!.textContent = '';
    if (items.length === 0) {
      empty!.hidden = false;
      empty!.textContent = '当前没有已加载的内容。打开一份研究后，可在这里检索它的来源。';
      input!.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      return;
    }
    if (matches.length === 0) {
      empty!.hidden = false;
      empty!.textContent = '没有匹配的报告或来源。试试标题、链接或摘录中的词。';
      input!.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      return;
    }
    empty!.hidden = true;
    for (const [index, item] of matches.entries()) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      // The combobox owns arrow navigation; thousands of matches are one Tab stop.
      button.tabIndex = -1;
      button.id = `${OPTION_ID_PREFIX}${index}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');
      button.dataset.kind = item.kind;
      button.dataset.itemId = item.id;
      const kindLabel = doc.createElement('span');
      kindLabel.className = 'search-result-kind';
      kindLabel.textContent = item.kind === 'history' ? '历史报告' : '来源';
      const body = doc.createElement('span');
      body.className = 'search-result-body';
      const title = doc.createElement('strong');
      title.textContent = item.title;
      const meta = doc.createElement('small');
      meta.textContent = item.meta;
      body.append(title, meta);
      button.append(kindLabel, body);
      const chosen = item;
      button.addEventListener('click', () => {
        activeIndex = index;
        closeWith('select', chosen);
      });
      results!.appendChild(button);
    }
    setActive(0);
    if (previous) {
      const kept = matches.findIndex((item) => item.id === previous.id && item.kind === previous.kind);
      if (kept >= 0) setActive(kept);
    }
  }

  function clearRendered(): void {
    input!.value = '';
    results!.textContent = '';
    matches = [];
    activeIndex = -1;
    input!.removeAttribute('aria-activedescendant');
  }

  function closeWith(reason: CloseReason, selection: LocalSearchItem | null = null): void {
    if (!dialog!.open) {
      if (selection) options.onSelect(selection);
      return;
    }
    // Durable per-close intent: the queued close event consumes it exactly
    // once and can therefore never steal selection focus back to the opener.
    pendingClose = { epoch, reason };
    dialog!.close();
    if (selection) options.onSelect(selection);
  }

  function close(): void {
    closeWith('restore');
  }

  function open(trigger?: HTMLElement | null): void {
    if (dialog!.open) {
      input!.focus();
      return;
    }
    epoch += 1;
    pendingClose = null;
    opener = trigger ?? (doc.activeElement as HTMLElement | null);
    dialog!.showModal();
    // Animate the container once, rather than every row in a long result set.
    results!.classList.toggle('enter', !reducedMotion());
    items = options.getItems();
    input!.value = '';
    render(false);
    input!.focus();
  }

  function refresh(): void {
    if (!dialog!.open) return;
    items = options.getItems();
    // Keep the user's active row across streaming refreshes: a new source event
    // must not make Enter select a different row than the one highlighted.
    render(true);
    if (activeIndex >= matches.length) setActive(matches.length - 1);
  }

  function reset(): void {
    // Invalidate every queued close event before touching state.
    epoch += 1;
    pendingClose = null;
    if (dialog!.open) dialog!.close();
    clearRendered();
    matches = [];
    items = [];
    opener = null;
    empty!.hidden = false;
    empty!.textContent = '当前没有已加载的历史报告或当前报告来源。登录并打开研究后可在这里本地筛选。';
  }

  dialog.addEventListener('close', () => {
    const intent = pendingClose;
    pendingClose = null;
    // Stale close (the dialog was reopened or reset meanwhile): leave the new
    // generation's query, results and focus completely alone.
    if (!intent || intent.epoch !== epoch) return;
    clearRendered();
    // A selection already owns the final focus; a silent close is a teardown.
    if (intent.reason !== 'restore') return;
    const previous = opener;
    opener = null;
    if (previous && previous.isConnected && typeof previous.focus === 'function') {
      previous.focus();
      return;
    }
    const fallback = options.getFallbackFocus?.() ?? null;
    if (fallback && fallback.isConnected && typeof fallback.focus === 'function') fallback.focus();
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) return;
      setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      selectActive();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  input.addEventListener('input', () => render());

  for (const closer of dialog.querySelectorAll('[data-close-search]')) {
    closer.addEventListener('click', () => close());
  }

  dialog.addEventListener('cancel', (event) => {
    // Escape still closes; make it explicit so tests and browsers agree.
    event.preventDefault();
    close();
  });

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (event.isComposing || event.repeat) return false;
    const key = event.key.toLowerCase();
    if (key !== 'k') return false;
    const primary = (event.metaKey ? 1 : 0) + (event.ctrlKey ? 1 : 0);
    if (primary !== 1 || event.altKey || event.shiftKey) return false;
    // Never take over another native dialog's keyboard handling.
    for (const other of doc.querySelectorAll('dialog[open]')) {
      if (other !== dialog) return false;
    }
    if (options.isAvailable && !options.isAvailable()) return false;
    event.preventDefault();
    if (dialog!.open) input!.focus();
    else open(null);
    return true;
  }

  return {
    isOpen: () => dialog.open,
    open,
    close,
    refresh,
    reset,
    handleKeyDown,
    query: () => input.value,
    resultCount: () => results.querySelectorAll('.search-result').length
  };
}
