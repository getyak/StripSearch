import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html?: string, options?: Record<string, unknown>) => {
    window: Record<string, unknown> & typeof globalThis;
  };
};

type EventListenerLike = (event: { data?: string; lastEventId?: string }) => void;

/** Minimal EventSource double used to assert that streams are opened/closed. */
export class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, EventListenerLike[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, callback: EventListenerLike): void {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, payload: unknown, id = '1'): void {
    for (const callback of this.listeners.get(type) ?? []) {
      callback({ data: JSON.stringify(payload), lastEventId: String(id) });
    }
  }

  emitRaw(type: string, data: string, id = '1'): void {
    for (const callback of this.listeners.get(type) ?? []) {
      callback({ data, lastEventId: String(id) });
    }
  }

  fail(): void {
    // Native EventSource transport errors notify registered error listeners
    // as well as onerror, without MessageEvent.data or lastEventId.
    for (const callback of this.listeners.get('error') ?? []) callback({});
    this.onerror?.();
  }
}

export interface DomEnv {
  window: Record<string, unknown> & typeof globalThis;
  document: Document;
  clipboardWrites: string[];
}

export function installDom(): DomEnv {
  const html = readFileSync(fileURLToPath(new URL('../client/index.html', import.meta.url)), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const window = dom.window as DomEnv['window'];

  const dialogPrototype = (window as unknown as { HTMLDialogElement?: { prototype: Record<string, unknown> } })
    .HTMLDialogElement?.prototype;
  const openDialog = function (this: { setAttribute: (n: string, v: string) => void }): void {
    this.setAttribute('open', '');
  };
  const closeDialog = function (this: {
    removeAttribute: (n: string) => void;
    dispatchEvent: (event: unknown) => boolean;
  }): void {
    this.removeAttribute('open');
    this.dispatchEvent(new (window as unknown as { Event: new (t: string) => unknown }).Event('close'));
  };
  if (dialogPrototype) {
    dialogPrototype.showModal = openDialog;
    dialogPrototype.close = closeDialog;
  } else {
    (window.HTMLElement.prototype as unknown as Record<string, unknown>).showModal = openDialog;
    (window.HTMLElement.prototype as unknown as Record<string, unknown>).close = closeDialog;
  }

  (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as typeof window.matchMedia;
  window.confirm = () => true;

  const clipboardWrites: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardWrites.push(text);
      }
    }
  });

  const global = globalThis as unknown as Record<string, unknown>;
  global.window = window;
  global.document = window.document;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: window.navigator
  });
  global.EventSource = MockEventSource;
  global.HTMLElement = window.HTMLElement;
  global.Event = (window as unknown as { Event: unknown }).Event;
  global.Node = (window as unknown as { Node: unknown }).Node;
  global.requestAnimationFrame =
    (window as unknown as { requestAnimationFrame?: (cb: (time: number) => void) => number }).requestAnimationFrame?.bind(
      window
    ) ?? ((cb: (time: number) => void) => setTimeout(() => cb(0), 0) as unknown as number);

  return { window, document: window.document, clipboardWrites };
}

export function installFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response
): void {
  (globalThis as unknown as { fetch: unknown }).fetch = (input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init));
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}
