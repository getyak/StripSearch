/**
 * Local search / navigation dialog: offline controller tests.
 *
 * The DOM mock in dom-env closes dialogs synchronously, but real browsers queue
 * the close event. These tests run against a QUEUED close mock so the durable
 * close-intent contract is exercised the way Chromium behaves.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { createLocalSearch } from '../client/local-search.js';
import type { LocalSearchItem } from '../client/local-search.js';

let env = installDom();

/* ---------------- queued native close mock ---------------- */

let closeTasks: (() => void)[] = [];
function installQueuedClose(): void {
  const window = env.window as unknown as Record<string, unknown> & typeof globalThis;
  const proto = (
    window.HTMLDialogElement
      ? (window.HTMLDialogElement as unknown as { prototype: Record<string, unknown> }).prototype
      : (window.HTMLElement.prototype as unknown as Record<string, unknown>)
  );
  proto.showModal = function (this: { setAttribute(n: string, v: string): void }): void {
    this.setAttribute('open', '');
  };
  proto.close = function (this: { removeAttribute(n: string): void; dispatchEvent(e: unknown): boolean }): void {
    this.removeAttribute('open');
    // Native: the close event is a queued task, not a synchronous dispatch.
    closeTasks.push(() => this.dispatchEvent(new (window.Event as new (type: string) => unknown)('close')));
  };
}
test.beforeEach(() => {
  env = installDom();
  closeTasks = [];
  installQueuedClose();
});

async function flushCloseTasks(): Promise<void> {
  const tasks = closeTasks;
  closeTasks = [];
  for (const task of tasks) task();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new env.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

function typeQuery(value: string): void {
  const input = env.document.getElementById('search-input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new env.window.Event('input'));
}

function resultButtons(): HTMLButtonElement[] {
  return [...env.document.querySelectorAll<HTMLButtonElement>('.search-result')];
}

function emptyText(): string {
  return env.document.getElementById('search-empty')?.textContent ?? '';
}

function fixture(overrides: {
  items?: () => LocalSearchItem[];
  onSelect?: (item: LocalSearchItem) => void;
  isAvailable?: () => boolean;
  getFallbackFocus?: () => HTMLElement | null;
  reducedMotion?: () => boolean;
} = {}) {
  const selected: LocalSearchItem[] = [];
  const controller = createLocalSearch({
    getItems: overrides.items ?? (() => [
      { id: 'runA', kind: 'history', title: '林舟的公开作品', meta: '已完成', haystack: '林舟的公开作品' },
      { id: 'S1', kind: 'source', title: 'Lantern 2025.06 更新记录', meta: '已读取 · https://example.test/lantern', haystack: 'lantern 2025.06 更新记录 https://example.test/lantern' }
    ]),
    onSelect: overrides.onSelect ?? ((item) => selected.push(item)),
    isAvailable: overrides.isAvailable,
    getFallbackFocus: overrides.getFallbackFocus,
    reducedMotion: overrides.reducedMotion
  });
  return { controller, selected };
}

function makeTrigger(id: string): HTMLButtonElement {
  const button = env.document.createElement('button');
  button.id = id;
  button.textContent = '检索';
  env.document.body.appendChild(button);
  button.focus();
  return button;
}

test('Cmd/Ctrl+K opens the dialog and filters only the loaded items', async () => {
  const { controller } = fixture();
  assert.equal(controller.handleKeyDown(key({ key: 'k', ctrlKey: true })), true);
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.resultCount(), 2, 'both loaded entries are listed');

  typeQuery('lantern');
  assert.equal(controller.resultCount(), 1);
  assert.match(resultButtons()[0]?.textContent ?? '', /Lantern 2025\.06/);
  assert.match(resultButtons()[0]?.textContent ?? '', /来源/, 'results carry their scope label');
  await flushCloseTasks();
  controller.reset();
});

test('no results shows a distinct no-match state with zero options', async () => {
  const { controller } = fixture();
  controller.open();
  typeQuery('不存在的关键词');
  assert.equal(controller.resultCount(), 0);
  assert.match(emptyText(), /没有匹配/);
  assert.match(emptyText(), /标题、链接或摘录/, 'the empty state explains how to recover');
  await flushCloseTasks();
  controller.reset();
});

test('empty state appears when nothing is loaded for this account', async () => {
  const { controller } = fixture({ items: () => [] });
  controller.open();
  assert.equal(controller.resultCount(), 0);
  assert.match(emptyText(), /当前没有已加载/);
  await flushCloseTasks();
  controller.reset();
});

test('IME composition, key repeat and extra modifiers never trigger the shortcut', async () => {
  const { controller } = fixture();
  assert.equal(controller.handleKeyDown(key({ key: 'k', ctrlKey: true, isComposing: true })), false);
  assert.equal(controller.handleKeyDown(key({ key: 'k', ctrlKey: true, repeat: true })), false);
  assert.equal(controller.handleKeyDown(key({ key: 'K', ctrlKey: true, shiftKey: true })), false);
  assert.equal(controller.handleKeyDown(key({ key: 'k', ctrlKey: true, altKey: true })), false);
  assert.equal(controller.handleKeyDown(key({ key: 'k' })), false);
  assert.equal(controller.handleKeyDown(key({ key: 'k', ctrlKey: true, metaKey: true })), false);
  assert.equal(controller.isOpen(), false);
});

test('the shortcut never stacks over another open native dialog', async () => {
  const { controller } = fixture();
  const auth = env.document.getElementById('auth-dialog') as HTMLDialogElement;
  auth.setAttribute('open', '');
  try {
    assert.equal(controller.handleKeyDown(key({ key: 'k', metaKey: true })), false);
    assert.equal(controller.isOpen(), false);
  } finally {
    auth.removeAttribute('open');
  }
  assert.equal(controller.handleKeyDown(key({ key: 'k', metaKey: true })), true);
  assert.equal(controller.isOpen(), true);
  await flushCloseTasks();
  controller.reset();
});

test('a queued close after selection cannot steal focus back to the opener', async () => {
  const trigger = makeTrigger('search-trigger-a');
  const destination = env.document.createElement('button');
  destination.id = 'selection-destination';
  env.document.body.appendChild(destination);
  const { controller, selected } = fixture({
    onSelect: (item) => {
      selected.push(item);
      destination.focus();
    }
  });
  controller.open(trigger);
  const input = env.document.getElementById('search-input') as HTMLInputElement;
  input.dispatchEvent(key({ key: 'ArrowDown' }));
  input.dispatchEvent(key({ key: 'Enter' }));

  assert.equal(selected.length, 1, 'selection runs immediately and owns the focus');
  assert.equal(selected[0]?.id, 'S1');
  assert.equal(env.document.activeElement, destination);

  // The native close event arrives later and must not restore the opener.
  await flushCloseTasks();
  assert.equal(env.document.activeElement, destination, 'late close must not steal selection focus');
  assert.equal(controller.resultCount(), 0, 'close cleanup still clears the rendered results');
  trigger.remove();
  destination.remove();
  controller.reset();
});

test('a stale close event cannot clear a freshly reopened dialog', async () => {
  const trigger = makeTrigger('search-trigger-b');
  const { controller } = fixture();
  controller.open(trigger);
  typeQuery('lantern');
  controller.close();
  // Reopen before the queued close event arrives.
  controller.open(trigger);
  typeQuery('林舟');
  assert.equal(controller.isOpen(), true);
  await flushCloseTasks();
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.query(), '林舟', 'the reopened dialog keeps its query');
  assert.equal(controller.resultCount(), 1, 'the reopened dialog keeps its results');
  await flushCloseTasks();
  controller.reset();
  trigger.remove();
});

test('close returns focus to the opener, never to a removed element', async () => {
  const trigger = makeTrigger('search-trigger-c');
  const fallback = makeTrigger('search-fallback-c');
  const { controller } = fixture({
    getFallbackFocus: () => (fallback.isConnected ? fallback : null)
  });
  controller.open(trigger);
  controller.close();
  await flushCloseTasks();
  assert.equal(env.document.activeElement, trigger);

  trigger.focus();
  controller.open(trigger);
  trigger.remove();
  controller.close();
  await flushCloseTasks();
  assert.equal(env.document.activeElement, fallback, 'a removed opener is never focused');
  fallback.remove();
  controller.reset();
});

test('reset drops query and results and a queued close cannot restore old focus', async () => {
  const trigger = makeTrigger('search-trigger-d');
  const { controller } = fixture();
  controller.open(trigger);
  typeQuery('lantern');
  controller.reset();
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.query(), '');
  assert.equal(controller.resultCount(), 0);
  assert.match(emptyText(), /当前没有已加载|没有匹配|筛选/, 'the state area is reset');
  await flushCloseTasks();
  assert.notEqual(env.document.activeElement, trigger, 'a stale close must not restore old-account focus');
  trigger.remove();
});

test('refresh preserves the active row identity across streaming updates', async () => {
  const items: LocalSearchItem[] = [
    { id: 'S1', kind: 'source', title: '来源一', meta: '', haystack: '来源一' },
    { id: 'S2', kind: 'source', title: '来源二', meta: '', haystack: '来源二' }
  ];
  const { controller, selected } = fixture({ items: () => items });
  controller.open();
  const input = env.document.getElementById('search-input') as HTMLInputElement;
  input.dispatchEvent(key({ key: 'ArrowDown' }));
  const activeBefore = input.getAttribute('aria-activedescendant');
  assert.match(activeBefore ?? '', /^search-option-1$/, 'second row is active');

  // A streaming refresh inserts a new source in front of the same context.
  items.unshift({ id: 'S0', kind: 'source', title: '来源零', meta: '', haystack: '来源零' });
  controller.refresh();
  assert.equal(
    env.document.activeElement,
    input,
    'the input keeps DOM focus (combobox + aria-activedescendant)'
  );
  const activeAfter = input.getAttribute('aria-activedescendant');
  assert.match(activeAfter ?? '', /^search-option-2$/, 'the highlighted row follows the same item');
  input.dispatchEvent(key({ key: 'Enter' }));
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, 'S2', 'Enter selects the row that was highlighted');
  await flushCloseTasks();
  controller.reset();
});

test('ArrowUp/ArrowDown clamp at the edges and stay inside the result set', async () => {
  const { controller, selected } = fixture();
  controller.open();
  const input = env.document.getElementById('search-input') as HTMLInputElement;
  input.dispatchEvent(key({ key: 'ArrowUp' }));
  assert.match(input.getAttribute('aria-activedescendant') ?? '', /^search-option-0$/);
  input.dispatchEvent(key({ key: 'ArrowDown' }));
  input.dispatchEvent(key({ key: 'ArrowDown' }));
  input.dispatchEvent(key({ key: 'ArrowDown' }));
  assert.match(input.getAttribute('aria-activedescendant') ?? '', /^search-option-1$/, 'clamped at the last row');
  input.dispatchEvent(key({ key: 'Enter' }));
  assert.equal(selected[0]?.id, 'S1');
  await flushCloseTasks();
  controller.reset();
});

test('reduced motion renders results without the entrance animation class', async () => {
  const { controller } = fixture({ reducedMotion: () => true });
  controller.open();
  for (const button of resultButtons()) {
    assert.equal(button.classList.contains('enter'), false, 'no motion class under reduced motion');
  }
  await flushCloseTasks();
  controller.reset();
});

test('Escape closes the dialog and clears what was typed', async () => {
  const trigger = makeTrigger('search-trigger-e');
  const { controller } = fixture();
  controller.open(trigger);
  typeQuery('lantern');
  const input = env.document.getElementById('search-input') as HTMLInputElement;
  input.dispatchEvent(key({ key: 'Escape' }));
  assert.equal(controller.isOpen(), false);
  await flushCloseTasks();
  assert.equal(controller.query(), '');
  assert.equal(controller.resultCount(), 0);
  assert.equal(env.document.activeElement, trigger, 'Escape returns to the opener');
  trigger.remove();
  controller.reset();
});
