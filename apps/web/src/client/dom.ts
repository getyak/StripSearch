export { hostnameOf } from '../shared/url-policy.js';

/**
 * Escape a value for a double-quoted attribute/selector string: backslashes
 * and quotes escaped; newline, carriage return and form feed become CSS hex
 * escapes followed by a literal space. Shared by the focus-anchor capture and
 * the citation return selectors (byte-identical to the historical inline
 * helpers).
 */
export function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/[\n\r\f]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `);
}

/** `prefers-reduced-motion` with an optional app override; false on failure. */
export function prefersReducedMotion(win: Window, override?: () => boolean | undefined): boolean {
  try {
    return Boolean(override?.() ?? win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

export interface MakeOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null>;
  children?: (Node | null | undefined)[];
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
  style?: Partial<CSSStyleDeclaration>;
}

export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: MakeOptions = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    if (handler) element.addEventListener(event, handler as EventListener);
  }
  for (const child of options.children ?? []) {
    if (child) element.appendChild(child);
  }
  if (options.style) Object.assign(element.style, options.style);
  return element;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setText(node: Element, value: string): void {
  node.textContent = value;
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '时间未标注';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${formatDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
