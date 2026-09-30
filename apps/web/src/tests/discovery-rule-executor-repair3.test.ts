/**
 * GET-91 repair-3 regressions (final native review: P1 x4 / P2 x2 runtime).
 * Reproduces confirmed defects BEFORE the fix. All offline: fake DNS,
 * injected connector on the REAL pinned transport, fake clock/ports.
 */

import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import test from 'node:test';

import {
  PUBLIC_HTTPS_TARGET_POLICY,
  validateDiscoveryTarget
} from '../server/discovery/request-policy.js';
import type { BoundedDiscoveryResponse, DnsResolver, ValidatedDiscoveryTarget } from '../server/discovery/request-policy.js';
import { createPinnedHttpsTransport } from '../server/discovery/pinned-transport.js';
import type { PinnedHttpConnector } from '../server/discovery/pinned-transport.js';
import type {
  DiscoveryClock,
  DiscoveryRequestContext,
  DiscoveryRequestReceipt,
  DiscoveryResponseCache,
  DiscoveryTransport,
  PlannedDiscoveryRequest
} from '../server/discovery/rule-executor.js';
import { createInMemoryRateLimiter, evaluateRule, executeDiscoveryRequest } from '../server/discovery/rule-executor.js';
import type { PublicDiscoveryRule } from '../shared/public-discovery-rules.js';

const SAFE = { address: '93.184.216.34', family: 4 as const };

function rule(over: Partial<PublicDiscoveryRule> = {}): PublicDiscoveryRule {
  return {
    ruleId: 'pr-0000000000000001',
    sourceRef: { sourceId: 'maigret', rowId: 'row', rowSha256: 'a'.repeat(64) },
    sourceName: 'Fixture',
    canonicalProfileTemplate: 'https://fixture.example.test/{username}',
    requestTemplate: 'https://fixture.example.test/{username}',
    instanceHost: 'fixture.example.test',
    accountKind: 'unknown',
    detection: {
      kind: 'bounded_strings',
      presentStatus: null,
      presentAny: ['independent-profile-marker'],
      nonProofPresentAny: [],
      absentStatus: null,
      absentAny: ['site-specific-absence'],
      boundedPositive: true,
      boundedNegative: true
    },
    caseSensitive: true,
    ratePerMinute: null,
    protections: [],
    errorMarkers: [],
    safeHeaders: {},
    ...over
  };
}

function response(over: Partial<BoundedDiscoveryResponse> = {}): BoundedDiscoveryResponse {
  return {
    status: 200,
    finalUrl: 'https://fixture.example.test/user',
    contentType: 'text/html; charset=utf-8',
    encoding: 'utf-8',
    contentEncoding: 'identity',
    retryAfter: null,
    location: null,
    bodyText: 'independent-profile-marker',
    bytes: 27,
    truncated: false,
    utf8Valid: true,
    sendCount: 1,
    ...over
  };
}

/* ------------------------------------------------------------------ */
/* Fake connector for the REAL pinned transport                        */
/* ------------------------------------------------------------------ */

class FakeSocket extends EventEmitter {
  constructor(readonly remoteAddress: string | null) {
    super();
  }
  destroy(): void {
    this.emit('close');
  }
}

class FakeResponse extends EventEmitter {
  socket: FakeSocket;
  private scheduled = false;
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | undefined>,
    remoteAddress: string | null,
    private readonly chunks: string[] = []
  ) {
    super();
    this.socket = new FakeSocket(remoteAddress);
  }
  override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as never);
    if (event === 'data' && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        for (const chunk of this.chunks) this.emit('data', Buffer.from(chunk, 'utf8'));
        this.emit('end');
      });
    }
    return this;
  }
  destroy(): void {
    this.emit('close');
  }
}

interface FakeRequest extends EventEmitter {
  destroyed: boolean;
  destroy: () => void;
  end: () => void;
}

function fakeConnector(script: Array<{ response?: FakeResponse; error?: Error; hang?: boolean }>): PinnedHttpConnector & {
  calls: number;
  destroys: number;
} {
  const state = { calls: 0, destroys: 0 };
  return {
    get calls() {
      return state.calls;
    },
    get destroys() {
      return state.destroys;
    },
    request(_options: Record<string, unknown>, callback: (res: never) => void) {
      state.calls += 1;
      const req = new EventEmitter() as FakeRequest;
      req.destroyed = false;
      req.destroy = () => {
        if (!req.destroyed) state.destroys += 1;
        req.destroyed = true;
        req.emit('close');
      };
      req.end = () => {
        const step = script.shift();
        if (!step || step.hang) return;
        setImmediate(() => {
          if (step.error) req.emit('error', step.error);
          else if (step.response) (callback as unknown as (res: FakeResponse) => void)(step.response);
        });
      };
      return req;
    }
  } as unknown as PinnedHttpConnector & { calls: number; destroys: number };
}

class MapCache implements DiscoveryResponseCache {
  readonly store = new Map<string, { response: BoundedDiscoveryResponse; observedAt: string; expiresAt: number }>();
  get(key: string) {
    return this.store.get(key) ?? null;
  }
  set(key: string, entry: { response: BoundedDiscoveryResponse; observedAt: string; expiresAt: number }): void {
    this.store.set(key, entry);
  }
}

function clockNow(start = 1_000_000): DiscoveryClock & { advance(ms: number): void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

function realTransportHarness(over: {
  script: Array<{ response?: FakeResponse; error?: Error; hang?: boolean }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  authorityRefresh?: (stage: string) => boolean | Promise<boolean>;
  clock?: DiscoveryClock & { advance(ms: number): void };
}): {
  ctx: DiscoveryRequestContext;
  connector: PinnedHttpConnector & { calls: number; destroys: number };
  receipts: DiscoveryRequestReceipt[];
  cache: MapCache;
} {
  const connector = fakeConnector(over.script);
  const transport = createPinnedHttpsTransport({ connector });
  const receipts: DiscoveryRequestReceipt[] = [];
  const cache = new MapCache();
  const clock = over.clock ?? clockNow();
  const dns: DnsResolver = { resolveAll: async () => [SAFE] };
  const ctx: DiscoveryRequestContext = {
    signal: over.signal ?? new AbortController().signal,
    clock,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns,
    transport,
    authority: {
      async refresh(stage: string) {
        return over.authorityRefresh ? await over.authorityRefresh(stage) : true;
      }
    },
    rateLimiter: createInMemoryRateLimiter({ clock }),
    cache,
    receipts: {
      record(receipt: DiscoveryRequestReceipt) {
        receipts.push(receipt);
      }
    },
    rules: new Map([['pr-0000000000000001', rule()]]),
    scope: { owner: 'o', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    limits: { timeoutMs: over.timeoutMs ?? 5000, maxBytes: 4096, cacheTtlMs: 30_000 }
  };
  return { ctx, connector, receipts, cache };
}

function request(over: Partial<PlannedDiscoveryRequest> = {}): PlannedDiscoveryRequest {
  return {
    requestKey: 'rk-1',
    origin: 'https://fixture.example.test',
    url: 'https://fixture.example.test/user',
    headers: {},
    ruleIds: ['pr-0000000000000001'],
    ...over
  };
}

/* ------------------------------------------------------------------ */
/* P1-1: external abort/ deadline on the REAL pinned transport          */
/* ------------------------------------------------------------------ */

test('P1-1 external abort destroys the pending request and keeps the real sent receipt', async () => {
  const controller = new AbortController();
  const h = realTransportHarness({
    script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }],
    signal: controller.signal
  });
  // Delay the response so the abort lands while the request is in flight.
  const promise = executeDiscoveryRequest(request(), h.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(h.connector.calls, 1, 'the request really dispatched');
  assert.ok(h.connector.destroys >= 1, 'the pending request must be destroyed on external abort');
  assert.equal(h.receipts.length, 1, 'exactly one final usage receipt');
  assert.equal(h.receipts[0]!.requestSent, true, 'a real dispatch is never reported as unsent');
  assert.equal(h.receipts[0]!.sendCount, 1);
  assert.equal(h.receipts[0]!.outcome, 'cancelled');
  assert.equal(h.cache.store.size, 0, 'no late cache write');
});

test('P1-1 deadline in flight keeps sent accounting; thrown connector keeps its receipt', async () => {
  const hanging = realTransportHarness({ script: [{ hang: true }], timeoutMs: 15 });
  const outcome = await executeDiscoveryRequest(request(), hanging.ctx);
  assert.equal(outcome.status, 'unknown');
  assert.equal(hanging.connector.calls, 1);
  assert.equal(hanging.receipts.length, 1);
  assert.equal(hanging.receipts[0]!.requestSent, true);
  assert.equal(hanging.receipts[0]!.sendCount, 1);
  assert.equal(hanging.receipts[0]!.outcome, 'unknown');

  const thrown = realTransportHarness({ script: [{ error: new Error('socket exploded') }] });
  const thrownOutcome = await executeDiscoveryRequest(request(), thrown.ctx);
  assert.equal(thrownOutcome.status, 'failed');
  assert.equal(thrown.receipts.length, 1);
  assert.equal(thrown.receipts[0]!.requestSent, true);
  assert.equal(thrown.receipts[0]!.sendCount, 1);
});

test('P1-1 external abort during a redirected hop counts every dispatched hop', async () => {
  const controller = new AbortController();
  const h = realTransportHarness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { hang: true }
    ],
    signal: controller.signal
  });
  const promise = executeDiscoveryRequest(request({ url: 'https://a.example.test/user', origin: 'https://a.example.test' }), h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(h.connector.calls, 2, 'both hops really dispatched');
  assert.equal(outcome.sendCount, 2, 'dispatch accounting keeps every already-sent hop');
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0]!.sendCount, 2);
  assert.equal(h.receipts[0]!.requestSent, true);
  assert.equal(h.cache.store.size, 0);
});

/* ------------------------------------------------------------------ */
/* P1-2: fresh authority immediately before EVERY actual dispatch       */
/* ------------------------------------------------------------------ */

test('P1-2 authority revoked during initial DNS must not send (fresh check after DNS)', async () => {
  let revoked = false;
  const dnsHolder: { resolve: ((records: Array<{ address: string; family: 4 }>) => void) | null } = { resolve: null };
  const h = realTransportHarness({
    script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }],
    authorityRefresh: (stage) => (stage === 'send' && revoked ? false : true),
  });
  h.ctx.dns = {
    resolveAll: () =>
      new Promise((resolve) => {
        dnsHolder.resolve = resolve;
      })
  };
  const promise = executeDiscoveryRequest(request(), h.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  revoked = true;
  dnsHolder.resolve?.([SAFE]);
  const outcome = await promise;
  assert.equal(h.connector.calls, 0, 'a revoked scope must never dispatch');
  assert.equal(outcome.sendCount, 0);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detailCode, 'scope_refresh_refused');
});

test('P1-2 delayed authority blocks dispatch until resolved or deadline', async () => {
  const h = realTransportHarness({
    script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }],
    timeoutMs: 15,
    authorityRefresh: (stage) => (stage === 'send' ? new Promise<boolean>(() => undefined) : true)
  });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.connector.calls, 0);
  assert.equal(outcome.sendCount, 0);
  assert.notEqual(outcome.detailCode, 'ok');
});

/* ------------------------------------------------------------------ */
/* P1-3: rule errorMarkers counterevidence precedes positivity/negativity */
/* ------------------------------------------------------------------ */

test('P1-3 a rule error marker beats positive AND absence markers on mixed bodies', () => {
  const withErrors = rule({ errorMarkers: ['synthetic-platform-error'] });
  const mixedPositive = evaluateRule(
    withErrors,
    response({ bodyText: '<html><head><title>Synthetic temporary error</title></head><body><nav>independent-profile-marker</nav><main>synthetic-platform-error</main></body></html>' })
  );
  assert.notEqual(mixedPositive.outcome, 'candidate', 'error counterevidence beats the positive marker');
  assert.ok(['inaccessible', 'unknown'].includes(mixedPositive.outcome));
  assert.ok((mixedPositive.locator ?? '').includes('synthetic-platform-error'), 'the locator keeps the error evidence');

  const mixedNegative = evaluateRule(
    withErrors,
    response({ bodyText: 'site-specific-absence synthetic-platform-error' })
  );
  assert.notEqual(mixedNegative.outcome, 'checked_no_match', 'error counterevidence beats the absence marker');
  assert.ok(['inaccessible', 'unknown'].includes(mixedNegative.outcome));
  // Pure error body stays non-candidate and provenance keeps the rule id.
  const pureError = evaluateRule(withErrors, response({ bodyText: 'synthetic-platform-error' }));
  assert.equal(pureError.outcome, 'inaccessible');
  assert.equal(pureError.ruleId, 'pr-0000000000000001');
  // A clean profile with the independent marker and no error marker is still a candidate.
  assert.equal(evaluateRule(rule({ errorMarkers: ['synthetic-platform-error'] }), response()).outcome, 'candidate');
});

/* ------------------------------------------------------------------ */
/* P2-1: sidebar login form is not a primary page wall                  */
/* ------------------------------------------------------------------ */

test('P2-1 a sidebar password form never walls a primary profile with independent proof', () => {
  const sidebarLogin =
    '<html><head><title>Ada Lovelace — profile</title></head><body><main><h1>Ada Lovelace</h1><div>independent-profile-marker</div></main>' +
    '<aside><form action="/login"><input type="password"><button>log in</button></form></aside></body></html>';
  const outcome = evaluateRule(rule(), response({ bodyText: sidebarLogin }));
  assert.equal(outcome.outcome, 'candidate', 'the sidebar form must not classify the page as a login wall');
  // The genuine primary login bodies stay blocked.
  const primaryLogin =
    '<html><head><title>Log in</title></head><body><main><h1>Log in</h1><form action="/login" method="post"><input name="username"><input name="password" type="password"><button>Log in</button></form><div>independent-profile-marker</div></main></body></html>';
  const blocked = evaluateRule(rule(), response({ bodyText: primaryLogin }));
  assert.ok(['inaccessible', 'unknown'].includes(blocked.outcome), 'primary login pages stay blocked');
});

/* ------------------------------------------------------------------ */
/* P2-2: no external signal listener leaks across settled runs          */
/* ------------------------------------------------------------------ */

test('P2-2 settled executions never retain external signal abort listeners', async () => {
  const controller = new AbortController();
  const preExisting = () => undefined;
  controller.signal.addEventListener('abort', preExisting);
  const baseline = getEventListeners(controller.signal, 'abort').length;
  for (let index = 0; index < 4; index += 1) {
    const h = realTransportHarness({
      script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }],
      signal: controller.signal
    });
    const outcome = await executeDiscoveryRequest(request({ requestKey: `rk-${index}` }), h.ctx);
    assert.equal(outcome.status, 'completed');
  }
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    baseline,
    'settled runs must not accumulate execution listeners on the caller signal'
  );
  // Pre-existing unrelated listeners survive.
  controller.signal.removeEventListener('abort', preExisting);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
