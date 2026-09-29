import { ProviderError } from './types.js';
import type { HttpRequestInit, HttpResponseLike, HttpTransport } from './types.js';

const decoder = new TextDecoder();

export async function readBoundedBody(response: HttpResponseLike, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ProviderError('provider_response_too_large', '供应商响应超过大小上限。');
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
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
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal.aborted) controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await options.transport.fetch(options.url, {
      ...options.init,
      redirect: 'error',
      signal: controller.signal
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new ProviderError('provider_redirect', '供应商返回了重定向，已中止。', response.status);
    }
    const text = await readBoundedBody(response, options.maxBytes);
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
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (options.signal.aborted) throw error;
    if (timedOut || controller.signal.aborted) {
      throw new ProviderError('provider_timeout', '供应商请求超时。');
    }
    throw new ProviderError('provider_error', '供应商请求失败。');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
