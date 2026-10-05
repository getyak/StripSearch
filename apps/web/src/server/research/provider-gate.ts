import type { HttpTransport } from '../adapters/types.js';

interface Gate { tail: Promise<void>; nextStart: number }
const gates = new WeakMap<HttpTransport, Gate>();

/** All toolkits sharing a transport share one cancelable, paced scrape lane. */
export async function pacedFirecrawl<T>(transport: HttpTransport, signal: AbortSignal, intervalMs: number, execute: () => Promise<T>): Promise<T> {
  let gate = gates.get(transport);
  if (!gate) { gate = { tail: Promise.resolve(), nextStart: 0 }; gates.set(transport, gate); }
  const previous = gate.tail;
  let release!: () => void;
  const slot = new Promise<void>(resolve => { release = resolve; });
  // A cancelled slot must still wait for its predecessor before letting the
  // next slot through; otherwise cancellation could create parallel requests.
  gate.tail = previous.then(() => slot);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason ?? new Error('Cancelled')); });
  signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    await Promise.race([previous, cancelled]);
    signal.throwIfAborted();
    const delay = Math.max(0, gate.nextStart - Date.now());
    if (delay > 0) await Promise.race([new Promise<void>(resolve => { timer = setTimeout(resolve, delay); }), cancelled]);
    signal.throwIfAborted();
    gate.nextStart = Date.now() + intervalMs;
    return await execute();
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    release();
  }
}
