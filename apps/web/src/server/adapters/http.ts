import { ProviderError } from './types.js';
import type { HttpRequestInit, HttpResponseLike, HttpTransport } from './types.js';

const decoder = new TextDecoder();

export async function readBoundedBody(response: HttpResponseLike, maxBytes: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    signal?.throwIfAborted();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ProviderError('provider_response_too_large', '供应商响应超过大小上限。');
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    signal?.throwIfAborted();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Releasing an oversized stream is best effort; a broken cancel must
      // never postpone the size failure or replace its error classification.
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw new ProviderError('provider_response_too_large', '供应商响应超过大小上限。');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(merged);
}

export interface SafeFetchOptions {
  transport: HttpTransport;
  url: string;
  init?: HttpRequestInit;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}

export interface SafeFetchResult {
  status: number;
  json: unknown;
  text: string;
  bytes: number;
}

function classifyStatus(status: number): ProviderError | null {
  if (status === 401) return new ProviderError('provider_forbidden', '供应商拒绝了该请求凭据。', status);
  if (status === 403) return new ProviderError('provider_forbidden', '供应商拒绝了该请求。', status);
  if (status === 402) return new ProviderError('provider_billing', '供应商计费/额度不足（HTTP 402）。', status);
  if (status === 404) return new ProviderError('provider_not_found', '供应商未找到该资源。', status);
  if (status === 429) return new ProviderError('provider_rate_limited', '供应商限流，请稍后再试。', status);
  if (status >= 500) return new ProviderError('provider_error', '供应商暂时不可用。', status);
  if (status >= 400) return new ProviderError('provider_bad_response', `供应商返回 ${status}。`, status);
  return null;
}

/**
 * Fixed-endpoint fetch helper: timeout, caller abort, redirect rejection and a
 * hard response size bound. Never follows an arbitrary URL supplied by a user.
 */
export async function safeFetchJson(options: SafeFetchOptions): Promise<SafeFetchResult> {
  options.signal.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => { stop = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new ProviderError('provider_timeout', '供应商请求超时。');
    stop(error);
    controller.abort(error);
  }, options.timeoutMs);
  const onAbort = () => { stop(options.signal.reason); controller.abort(options.signal.reason); };
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    // A transport or reader may ignore AbortSignal. Race the entire pipeline,
    // and keep the losing promise observed even if it settles much later.
    const work = (async (): Promise<SafeFetchResult> => {
      controller.signal.throwIfAborted();
      const response = await options.transport.fetch(options.url, {
        ...options.init,
        redirect: 'error',
        signal: controller.signal
      });
      controller.signal.throwIfAborted();
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new ProviderError('provider_redirect', '供应商返回了重定向，已中止。', response.status);
      }
      const text = await readBoundedBody(response, options.maxBytes, controller.signal);
      const classified = classifyStatus(response.status);
      if (classified) {
        // Attach bounded context without echoing the body verbatim.
        classified.message = `${classified.message} (${response.status})`;
        throw classified;
      }
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('provider_bad_response', '供应商返回了无法解析的内容。', response.status);
      }
      return { status: response.status, json, text, bytes: Buffer.byteLength(text, 'utf8') };
    })();
    return await Promise.race([work, stopped]);
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    if (error instanceof ProviderError) throw error;
    if (timedOut || controller.signal.aborted) {
      throw new ProviderError('provider_timeout', '供应商请求超时。');
    }
    throw new ProviderError('provider_error', '供应商请求失败。');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

export {
  asArray,
  asFiniteNumber,
  asRecord,
  asSafeIntegerNumber,
  asString
} from '../../shared/response-primitives.js';

import { asFiniteNumber } from '../../shared/response-primitives.js';

/**
 * Historical name on the report/research-tool chains: FINITE number semantics.
 * The GitHub acquisition chain uses `asSafeIntegerNumber` instead — the
 * finite vs safe-integer difference is intentional and tested.
 */
export const asNumber = asFiniteNumber;
