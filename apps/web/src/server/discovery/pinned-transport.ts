/**
 * GET-91 Task 3: pinned-HTTPS production transport for validated targets.
 *
 * The transport ONLY accepts a `ValidatedDiscoveryTarget` from
 * `request-policy.ts` — there is no resolve-check-then-default-fetch path:
 *
 * - TLS SNI / Host / certificate verification use the ORIGINAL hostname;
 * - the TCP connection is pinned through a custom `lookup` (every callback
 *   variant, incl. `options.all`) to the validated address, `agent: false`
 *   opts out of pooling/proxy env, and the actual socket remote address is
 *   re-verified (IPv4-mapped IPv6 folded) — a mismatch or an UNCONFIRMED pin
 *   (no remote address) fails closed;
 * - every redirect target goes through the full URL + DNS policy again,
 *   hops are capped, and no credential header is ever forwarded;
 * - bytes are bounded WHILE streaming (the stream is destroyed at the cap);
 * - the overall deadline and caller abort cover the WHOLE attempt — initial
 *   DNS, queueing, headers, body AND redirect DNS — and settle everywhere.
 *   A guarded flag prevents ANY late connector dispatch after the deadline/
 *   abort (a slow DNS result can never send work afterwards), and all timers
 *   and listeners are stopped on settle;
 * - `sendCount` reports every ACTUAL connector dispatch (redirect hops
 *   included) so request receipts can account for real sends.
 *
 * Tests inject a fake request factory/connector and fake sockets; the real
 * `https.request` is only used in production and never in tests. Node docs
 * for the request boundary are linked in `request-policy.ts`.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';

import {
  DiscoveryTargetError,
  isRedirectStatus,
  normalizeSocketAddress,
  validateDiscoveryTarget
} from './request-policy.js';
import type {
  BoundedDiscoveryResponse,
  DnsResolver,
  DiscoveryTargetPolicy,
  ValidatedDiscoveryTarget
} from './request-policy.js';

export { normalizeSocketAddress };

/** Injectable request factory; production default is `https.request`. */
export interface PinnedResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): void;
}

export interface PinnedRequestLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  end(): void;
  destroy(): void;
}

export interface PinnedHttpConnector {
  request(options: Record<string, unknown>, callback: (res: PinnedResponseLike) => void): PinnedRequestLike;
}

export interface PinnedRequestOptions {
  method: 'GET';
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Absolute deadline in the SAME time base as `now` (default wall clock). */
  deadlineAt: number;
  /** Injectable clock so the executor and transport share ONE time base. */
  now?: () => number;
  maxBytes: number;
  policy: DiscoveryTargetPolicy;
  dns: DnsResolver;
  /**
   * Rate/authority gate invoked before EVERY actual send (redirect hops
   * included) with the ACTUAL validated target, so per-origin leases match
   * the real dispatch. `release` runs exactly once per hop in a finally —
   * safe on constructor, stream, redirect, cancel and deadline failures.
   */
  beforeSend?: (info: { attempt: number; target: ValidatedDiscoveryTarget }) => Promise<SendGate> | SendGate;
  /** Called when a hop's response settles, BEFORE that hop's gate release. */
  onHopResponse?: (info: { target: ValidatedDiscoveryTarget; response: BoundedDiscoveryResponse }) => void;
  /**
   * Synchronous dispatch progress reported AT the actual connector.request
   * attempt boundary (attempted-connector semantics: an invoked attempt
   * counts even when the connector throws synchronously). Gate entry, DNS and
   * lease waits never count as dispatches.
   */
  onDispatch?: (info: { target: ValidatedDiscoveryTarget; attempt: number }) => void;
}

export interface SendGate {
  allowed: boolean;
  /** Idempotent: safe to call more than once, releases capacity exactly once. */
  release: () => void;
}

export type PinnedTransportErrorCode =
  | 'deadline_exceeded'
  | 'cancelled'
  | 'byte_cap'
  | 'socket_address_mismatch'
  | 'redirect_limit'
  | 'unsafe_header'
  | 'scope_refresh_refused'
  | 'transport_error'
  | 'unsupported_target';

export class PinnedTransportError extends Error {
  constructor(
    readonly code: PinnedTransportErrorCode,
    detail: string,
    /** Connector dispatches that actually happened before this error. */
    readonly sendCount: number = 0
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PinnedTransportError';
  }
}

export interface DiscoveryTransportLike {
  request(target: ValidatedDiscoveryTarget, options: PinnedRequestOptions): Promise<BoundedDiscoveryResponse>;
}

const FORWARDED_HEADER_DENYLIST = ['authorization', 'cookie', 'host', 'proxy-authorization'];

function assertSafeHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (FORWARDED_HEADER_DENYLIST.includes(key.trim().toLowerCase())) {
      throw new PinnedTransportError('unsafe_header', 'credential/host headers are never sent');
    }
  }
}

function charsetOf(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /charset=("?)([^";]+)\1/i.exec(contentType);
  return match ? (match[2] as string).trim().toLowerCase() : null;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

/** Run state shared by every hop: overall abandon flag + send accounting. */
interface RunState {
  /** Set by the overall deadline/abort: no further dispatch is permitted. */
  abandoned: boolean;
  sends: number;
}

const UTF8_DECODER_STRICT = new TextDecoder('utf-8', { fatal: true });

export function createPinnedHttpsTransport(
  deps: { connector?: PinnedHttpConnector } = {}
): DiscoveryTransportLike {
  const connector: PinnedHttpConnector = deps.connector ?? {
    request: (options, callback) =>
      https.request(options as https.RequestOptions, callback as unknown as (res: http.IncomingMessage) => void) as unknown as PinnedRequestLike
  };

  function singleRequest(
    target: ValidatedDiscoveryTarget,
    options: PinnedRequestOptions,
    state: RunState
  ): Promise<BoundedDiscoveryResponse> {
    return new Promise<BoundedDiscoveryResponse>((resolve, reject) => {
      let hopSettled = false;
      let onHopAbort: (() => void) | null = null;
      const cleanupHop = (): void => {
        if (onHopAbort) options.signal.removeEventListener('abort', onHopAbort);
        onHopAbort = null;
      };
      const fail = (error: Error): void => {
        if (hopSettled) return;
        hopSettled = true;
        cleanupHop();
        reject(error);
      };
      const succeed = (value: BoundedDiscoveryResponse): void => {
        if (hopSettled) return;
        hopSettled = true;
        cleanupHop();
        resolve(value);
      };
      // Guard BEFORE any dispatch: a late DNS/redirect step must never send
      // work after the deadline or the caller aborted.
      if (state.abandoned) {
        reject(new PinnedTransportError('cancelled', 'request already settled', state.sends));
        return;
      }

      // Actual dispatch boundary: attempted-connector semantics — the count
      // advances AT connector.request invocation, before any constructor or
      // stream failure can be observed.
      state.sends += 1;
      options.onDispatch?.({ target, attempt: state.sends });
      let request: PinnedRequestLike;
      try {
        request = connector.request(
        {
          protocol: 'https:',
          host: target.hostname,
          servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
          port: target.port,
          path: target.path,
          method: options.method,
          headers: { ...options.headers, host: target.hostname },
          // No pooling, no proxy env, no upstream agent configuration.
          agent: false,
          setHost: true,
          // Custom lookup in ALL callback variants pins the validated address.
          lookup: (hostname: string, lookupOptions: unknown, callback: (...args: unknown[]) => void) => {
            const done = typeof lookupOptions === 'function' ? (lookupOptions as (...args: unknown[]) => void) : callback;
            const wantsAll = typeof lookupOptions === 'object' && lookupOptions !== null
              ? Boolean((lookupOptions as { all?: boolean }).all)
              : false;
            if (wantsAll) done(null, [{ address: target.address, family: target.family }]);
            else done(null, target.address, target.family);
          }
        },
        (res) => {
          // Fail closed when the pin cannot actually be confirmed.
          const remote = res.socket?.remoteAddress ?? null;
          if (remote === null) {
            res.destroy();
            request.destroy();
            fail(new PinnedTransportError('socket_address_mismatch', 'socket pin unconfirmed (no remote address)', state.sends));
            return;
          }
          const normalized = normalizeSocketAddress(remote);
          if (normalized !== target.address) {
            res.destroy();
            request.destroy();
            fail(new PinnedTransportError('socket_address_mismatch', `socket ${normalized} != pinned ${target.address}`, state.sends));
            return;
          }
          const contentTypeHeader = firstHeader(res.headers['content-type']);
          const charset = charsetOf(contentTypeHeader ?? undefined);
          const contentEncoding = firstHeader(res.headers['content-encoding']);
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: never) => {
            const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
            total += buffer.byteLength;
            if (total > options.maxBytes) {
              res.destroy();
              request.destroy();
              fail(new PinnedTransportError('byte_cap', `response exceeded ${options.maxBytes} bytes while streaming`, state.sends));
              return;
            }
            chunks.push(buffer as Buffer);
          });
          res.on('end', () => {
            const encoding: BoundedDiscoveryResponse['encoding'] =
              charset === null || charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii'
                ? 'utf-8'
                : 'unsupported';
            const merged = Buffer.concat(chunks);
            let utf8Valid = true;
            if (encoding === 'utf-8') {
              try {
                UTF8_DECODER_STRICT.decode(merged);
              } catch {
                utf8Valid = false;
              }
            } else {
              utf8Valid = false;
            }
            succeed({
              status: res.statusCode ?? 0,
              finalUrl: target.originalUrl,
              contentType: contentTypeHeader,
              encoding,
              contentEncoding,
              retryAfter: firstHeader(res.headers['retry-after']),
              location: firstHeader(res.headers.location),
              bodyText: merged.toString('utf8'),
              bytes: total,
              truncated: false,
              utf8Valid,
              sendCount: state.sends
            });
          });
          res.on('error', (error: never) => fail(new PinnedTransportError('transport_error', String((error as Error).message ?? error), state.sends)));
        }
      );
      } catch (error) {
        // Attempted-connector semantics: the dispatch was already counted at
        // the connector boundary; a synchronous failure settles with it.
        fail(new PinnedTransportError('transport_error', String((error as Error)?.message ?? error), state.sends));
        return;
      }

      request.on('socket', (socket: never) => {
        const typed = socket as unknown as { remoteAddress?: string | null; on?: (event: string, cb: () => void) => void };
        const verify = (): void => {
          const remote = typed.remoteAddress ?? null;
          if (remote === null) return;
          const normalized = normalizeSocketAddress(remote);
          if (normalized !== target.address) {
            request.destroy();
            fail(new PinnedTransportError('socket_address_mismatch', `socket ${normalized} != pinned ${target.address}`, state.sends));
          }
        };
        verify();
        typed.on?.('connect', verify);
        typed.on?.('secureConnect', verify);
      });
      request.on('error', (error: never) => {
        const typed = error as Error & { code?: string };
        if (typed.code === 'deadline_exceeded' || typed.code === 'cancelled') {
          fail(new PinnedTransportError(typed.code, typed.message, state.sends));
          return;
        }
        fail(new PinnedTransportError('transport_error', typed.message, state.sends));
      });
      onHopAbort = () => {
        request.destroy();
        fail(new PinnedTransportError('cancelled', 'aborted during the request', state.sends));
      };
      if (options.signal.aborted) onHopAbort();
      else options.signal.addEventListener('abort', onHopAbort, { once: true });
      request.end();
    });
  }

  return {
    async request(target, options) {
      assertSafeHeaders(options.headers);
      const state: RunState = { abandoned: false, sends: 0 };
      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;
      let abortController: AbortController | null = null;

      const settleHooks = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (onAbort) options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      };

      const overall = new Promise<never>((_resolve, reject) => {
        const nowMs = options.now ?? Date.now;
        timer = setTimeout(() => {
          if (state.abandoned) return;
          state.abandoned = true;
          abortController?.abort();
          settleHooks();
          reject(new PinnedTransportError('deadline_exceeded', 'overall discovery deadline exceeded', state.sends));
        }, Math.max(0, options.deadlineAt - nowMs()));
        onAbort = () => {
          if (state.abandoned) return;
          state.abandoned = true;
          abortController?.abort();
          settleHooks();
          reject(new PinnedTransportError('cancelled', 'caller aborted the discovery request', state.sends));
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      });

      const run = async (): Promise<BoundedDiscoveryResponse> => {
        abortController = new AbortController();
        const hopOptions = { ...options, signal: abortController.signal };
        let current = target;
        for (let hops = 0; ; hops += 1) {
          if (state.abandoned) throw new PinnedTransportError('cancelled', 'request settled before dispatch', state.sends);
          let gate: SendGate | null = null;
          let response: BoundedDiscoveryResponse;
          try {
            if (options.beforeSend) {
              gate = await options.beforeSend({ attempt: state.sends + 1, target: current });
              if (state.abandoned) throw new PinnedTransportError('cancelled', 'request settled during beforeSend', state.sends);
              if (!gate.allowed) {
                throw new PinnedTransportError('scope_refresh_refused', 'authority refused the send', state.sends);
              }
            }
            if (state.abandoned) throw new PinnedTransportError('cancelled', 'request settled before dispatch', state.sends);
            response = await singleRequest(current, hopOptions, state);
            // Origin-scoped handling (e.g. Retry-After) happens before the
            // send slot is released and queued contenders wake up.
            options.onHopResponse?.({ target: current, response });
          } finally {
            gate?.release();
          }
          const redirectLocation = response.location;
          if (!isRedirectStatus(response.status) || redirectLocation === null) {
            settleHooks();
            return response;
          }
          if (hops >= options.policy.maxRedirects) {
            throw new PinnedTransportError('redirect_limit', 'redirect hop cap reached', state.sends);
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(redirectLocation, current.originalUrl).toString();
          } catch {
            throw new PinnedTransportError('unsupported_target', 'redirect location is not a valid URL', state.sends);
          }
          // Every redirect target gets the complete URL + DNS policy again;
          // the overall deadline/abort covers this DNS wait as well.
          try {
            current = await validateDiscoveryTarget(nextUrl, options.policy, options.dns);
          } catch (error) {
            if (error instanceof DiscoveryTargetError) {
              throw new PinnedTransportError('unsupported_target', `${error.code}: ${error.message}`, state.sends);
            }
            throw error;
          }
          if (state.abandoned) throw new PinnedTransportError('cancelled', 'request settled during redirect DNS', state.sends);
        }
      };

      const runPromise = run().then((response) => {
        settleHooks();
        return response;
      });
      // The overall deadline/abort may settle first; a later run() rejection
      // (abandoned hop) must never surface as an unhandled rejection.
      runPromise.catch(() => undefined);
      return await Promise.race([runPromise, overall]);
    }
  };
}
