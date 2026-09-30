/**
 * GET-91 consolidated repair regressions (Task 3 policy / transport /
 * executor). Each test reproduces a confirmed parent-review behavioral RED
 * against the initial implementation; all ports are fake — zero DNS/HTTP.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  PUBLIC_HTTPS_TARGET_POLICY,
  checkPublicAddress,
  validateDiscoveryTarget
} from '../server/discovery/request-policy.js';
import type { BoundedDiscoveryResponse, DnsResolver, ValidatedDiscoveryTarget } from '../server/discovery/request-policy.js';
import { createPinnedHttpsTransport } from '../server/discovery/pinned-transport.js';
import type { PinnedHttpConnector } from '../server/discovery/pinned-transport.js';
import type { DiscoveryTransport, PlannedDiscoveryRequest, DiscoveryRequestContext, DiscoveryRequestReceipt, DiscoveryResponseCache, DiscoveryClock } from '../server/discovery/rule-executor.js';
import {
  createInMemoryRateLimiter,
  evaluateRule,
  executeDiscoveryRequest
} from '../server/discovery/rule-executor.js';
import type { PublicDiscoveryRule } from '../shared/public-discovery-rules.js';

/* ------------------------------------------------------------------ */
/* Policy: IANA special-purpose denials                                */
/* ------------------------------------------------------------------ */

test('policy refuses IANA special-purpose IPv4/IPv6 representatives', () => {
  for (const address of [
    '192.88.99.1',
    '100::1',
    '100:0:0:1::1',
    '2001::1',
    '2001:2::1',
    '2002:a00:1::1',
    '3fff::1',
    '5f00::1',
    '4000::1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1'
  ]) {
    assert.equal(checkPublicAddress(address).ok, false, `${address} must be refused`);
  }
});

test('policy keeps ordinary global allocations reachable at subnet boundaries', () => {
  // Ordinary allocated space stays allowed (neighbors of refused specials).
  for (const address of [
    '192.88.98.255',
    '192.88.100.0',
    '2001:4860::1',
    '2001:4860:4860::8888',
    '2606:4700::1111',
    '2001:200::1',
    '2003::1'
  ]) {
    assert.equal(checkPublicAddress(address).ok, true, `${address} is ordinary allocated space`);
  }
  // Reserved/unallocated 2000::/3 space and both subnet ends of the denied
  // blocks stay refused (an allocation inventory, not the whole assignable
  // range, is the allow policy).
  for (const address of [
    '192.88.99.0',
    '192.88.99.255',
    '2002::',
    '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '3fff::',
    '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '4fff::1',
    '5f00::',
    '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:ffff::1',
    '3ffe::1'
  ]) {
    assert.equal(checkPublicAddress(address).ok, false, `${address} must be refused`);
  }
});

test('policy normalizes numeric/hex host aliases before the address check', async () => {
  const dns: DnsResolver = { resolveAll: async () => [] };
  for (const url of ['https://0x7f000001/u', 'https://2130706433/u', 'https://0177.0.0.1/u', 'https://017700000001/u']) {
    await assert.rejects(
      () => validateDiscoveryTarget(url, PUBLIC_HTTPS_TARGET_POLICY, dns),
      (error: unknown) => typeof (error as { code?: string }).code === 'string',
      `${url} must normalize to loopback and be refused`
    );
  }
});

test('policy refuses contradictory DNS record families after mapped normalization', async () => {
  const contradictory: DnsResolver = {
    resolveAll: async () => [{ address: '93.184.216.34', family: 6 as unknown as 4 }]
  };
  await assert.rejects(
    () => validateDiscoveryTarget('https://mixed-family.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, contradictory),
    (error: unknown) => (error as { code?: string }).code === 'dns_contradictory_record'
  );
  const mapped: DnsResolver = {
    resolveAll: async () => [{ address: '::ffff:93.184.216.34', family: 6 }]
  };
  await assert.rejects(
    () => validateDiscoveryTarget('https://mapped.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, mapped),
    (error: unknown) => (error as { code?: string }).code === 'dns_contradictory_record'
  );
});

/* ------------------------------------------------------------------ */
/* Transport: deadline/cancel coverage and pin confirmation            */
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
  override on(event: string, listener: (...args: unknown[]) => void): this {
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

function fakeConnector(script: Array<{ response?: FakeResponse; error?: Error }>): PinnedHttpConnector & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    request(_options: Record<string, unknown>, callback: (res: FakeResponse) => void) {
      state.calls += 1;
      const request = new EventEmitter() as FakeRequest;
      request.destroyed = false;
      request.destroy = () => {
        request.destroyed = true;
        request.emit('close');
      };
      request.end = () => {
        const step = script.shift();
        setImmediate(() => {
          if (!step) return;
          if (step.error) request.emit('error', step.error);
          else if (step.response) (callback as (res: FakeResponse) => void)(step.response);
        });
      };
      return request;
    }
  } as unknown as PinnedHttpConnector & { calls: number };
}

const SAFE = { address: '93.184.216.34', family: 4 as const };
const safeDns: DnsResolver = { resolveAll: async () => [SAFE] };

function requestOptions(over: Partial<Parameters<ReturnType<typeof createPinnedHttpsTransport>['request']>[1]> = {}) {
  return {
    method: 'GET' as const,
    headers: {} as Record<string, string>,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
    maxBytes: 4096,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: safeDns,
    ...over
  };
}

test('transport rejects during redirect DNS on deadline and never dispatches a second request', async () => {
  const connector = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://second.example.test/next' }, SAFE.address) }
  ]);
  const transport = createPinnedHttpsTransport({ connector });
  const neverResolves: DnsResolver = {
    resolveAll: () => new Promise(() => undefined)
  };
  const target = await validateDiscoveryTarget('https://first.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, safeDns);
  const started = Date.now();
  await assert.rejects(
    () => transport.request(target, requestOptions({ deadlineAt: Date.now() + 10, dns: neverResolves })),
    (error: unknown) => ['deadline_exceeded', 'cancelled'].includes((error as { code?: string }).code ?? '')
  );
  assert.ok(Date.now() - started < 1000, 'the overall deadline covers redirect DNS');
  assert.equal(connector.calls, 1, 'no second connector dispatch after the deadline');
});

test('transport honors abort during redirect DNS and a late DNS result cannot dispatch work', async () => {
  const connector = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://second.example.test/next' }, SAFE.address) }
  ]);
  const transport = createPinnedHttpsTransport({ connector });
  const late: { resolve: ((records: Array<{ address: string; family: 4 }>) => void) | null } = { resolve: null };
  const lateDns: DnsResolver = {
    resolveAll: () =>
      new Promise((resolve) => {
        late.resolve = resolve;
      })
  };
  const controller = new AbortController();
  const target = await validateDiscoveryTarget('https://first.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, safeDns);
  const promise = transport.request(target, requestOptions({ signal: controller.signal, dns: lateDns }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    () => promise,
    (error: unknown) => (error as { code?: string }).code === 'cancelled'
  );
  // The resolver completes late: no extra send/candidate commit may happen.
  late.resolve?.([SAFE]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connector.calls, 1, 'a late DNS result must never dispatch a new request');
});

test('transport fails closed when the socket pin cannot be confirmed', async () => {
  const connector = fakeConnector([{ response: new FakeResponse(200, {}, null, ['body']) }]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://first.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, safeDns);
  await assert.rejects(
    () => transport.request(target, requestOptions()),
    (error: unknown) => (error as { code?: string }).code === 'socket_address_mismatch'
  );
});

test('transport reports every actual send including redirects', async () => {
  const connector = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://second.example.test/next' }, SAFE.address) },
    { response: new FakeResponse(200, {}, SAFE.address, ['landed']) }
  ]);
  const transport = createPinnedHttpsTransport({ connector });
  const dns: DnsResolver = {
    resolveAll: async () => [SAFE]
  };
  const target = await validateDiscoveryTarget('https://first.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, dns);
  const response = await transport.request(target, requestOptions({ dns }));
  assert.equal(response.sendCount, 2, 'the 302 hop and the final request are both counted');
  assert.equal(connector.calls, 2);
});

/* ------------------------------------------------------------------ */
/* Executor: authority, evaluation, queue, cache TTL, receipts          */
/* ------------------------------------------------------------------ */

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
      presentAny: ['profile_found'],
      nonProofPresentAny: [],
      absentStatus: null,
      absentAny: ['gone'],
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
    bodyText: 'profile_found',
    bytes: 12,
    truncated: false,
    utf8Valid: true,
    sendCount: 1,
    ...over
  };
}

function fakeClock(start = 1_000_000): DiscoveryClock & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
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

interface Harness {
  ctx: DiscoveryRequestContext;
  transport: { calls: number; request: DiscoveryTransport['request'] };
  receipts: DiscoveryRequestReceipt[];
  stages: string[];
}

function harness(over: {
  responses?: Array<BoundedDiscoveryResponse | Error>;
  clock?: ReturnType<typeof fakeClock>;
  authorityRefresh?: (stage: string) => boolean;
  rules?: Map<string, PublicDiscoveryRule>;
  cache?: DiscoveryResponseCache;
  signal?: AbortSignal;
  onQueue?: () => void;
}): Harness {
  const receipts: DiscoveryRequestReceipt[] = [];
  const stages: string[] = [];
  const script = [...(over.responses ?? [response()])];
  const transport = {
    calls: 0,
    async request(_target: ValidatedDiscoveryTarget) {
      transport.calls += 1;
      const next = script.shift() ?? new Error('unexpected extra request');
      if (next instanceof Error) throw next;
      return next;
    }
  };
  const clock = over.clock ?? fakeClock();
  const authority = {
    refresh(stage: string) {
      stages.push(stage);
      if (over.onQueue && stage === 'send') over.onQueue();
      return over.authorityRefresh ? over.authorityRefresh(stage) : true;
    }
  };
  const ctx: DiscoveryRequestContext = {
    signal: over.signal ?? new AbortController().signal,
    clock,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: { resolveAll: async () => [SAFE] },
    transport,
    authority,
    rateLimiter: createInMemoryRateLimiter({ clock }),
    cache: over.cache ?? new MapCache(),
    receipts: {
      record(receipt: DiscoveryRequestReceipt) {
        receipts.push(receipt);
      }
    },
    rules: over.rules ?? new Map([['pr-0000000000000001', rule()]]),
    scope: { owner: 'o', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    limits: { timeoutMs: 5000, maxBytes: 4096, cacheTtlMs: 30_000 }
  };
  return { ctx, transport, receipts, stages };
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

test('evaluateRule never turns 401/403/429/5xx bodies into candidates or no-match', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const outcome = evaluateRule(rule(), response({ status, bodyText: 'profile_found gone' }));
    assert.notEqual(outcome.outcome, 'candidate', `status ${status}`);
    assert.notEqual(outcome.outcome, 'checked_no_match', `status ${status}`);
    assert.ok(['inaccessible', 'unknown'].includes(outcome.outcome));
  }
  // A 404 proves no-match ONLY with the rule's own declared absence proof.
  const declared = evaluateRule(
    rule({
      detection: {
        kind: 'bounded_strings',
        presentStatus: null,
        presentAny: ['profile_found'],
        nonProofPresentAny: [],
        absentStatus: 404,
        absentAny: ['gone'],
        boundedPositive: true,
        boundedNegative: true
      }
    }),
    response({ status: 404, bodyText: 'gone' })
  );
  assert.equal(declared.outcome, 'checked_no_match');
  const agnostic = evaluateRule(rule(), response({ status: 404, bodyText: 'gone' }));
  assert.notEqual(agnostic.outcome, 'checked_no_match', 'status-agnostic absence strings cannot prove no-match from a 404 body');
});

test('evaluateRule keeps truncated and invalid-UTF-8 responses unknown', () => {
  assert.equal(evaluateRule(rule(), response({ truncated: true, bodyText: 'profile_found' })).outcome, 'unknown');
  assert.equal(evaluateRule(rule(), response({ utf8Valid: false, bodyText: 'profile_found' })).outcome, 'unknown');
});

test('commit-time scope refusal never yields candidates, ok status or reusable responses', async () => {
  let commitAllowed = true;
  const h = harness({
    authorityRefresh: (stage) => stage !== 'commit' || commitAllowed
  });
  commitAllowed = false;
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.notEqual(outcome.status, 'completed');
  assert.notEqual(outcome.detailCode, 'ok');
  for (const item of outcome.ruleOutcomes) {
    assert.notEqual(item.outcome, 'candidate');
    assert.notEqual(item.outcome, 'checked_no_match');
  }
  assert.equal(outcome.response, null, 'an uncommitted response is never handed out for reuse');
  assert.equal(h.receipts.length, 1, 'the actual sent usage receipt is preserved');
  assert.equal(h.receipts[0]!.requestSent, true);
  assert.equal(h.transport.calls, 1);
});

test('authority revoked while queued dispatches zero requests', async () => {
  let allowed = true;
  const h = harness({
    authorityRefresh: () => allowed,
    onQueue: () => {
      allowed = false;
    }
  });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.transport.calls, 0, 'authority must be rechecked after the queue and before any send');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detailCode, 'scope_refresh_refused');
  for (const item of outcome.ruleOutcomes) assert.notEqual(item.outcome, 'candidate');
});

test('rate-limiter queued deadlines settle even while the origin is busy', async () => {
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 1 });
  const held: { release: (() => void) | null } = { release: null };
  const first = limiter.acquire('https://a.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 10_000 });
  await first.then((release) => {
    held.release = release;
  });
  const second = limiter.acquire('https://a.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 10 });
  const secondOutcome = second.then(
    () => 'acquired',
    (error: unknown) => (error as { code?: string }).code ?? 'failed'
  );
  clock.advance(20);
  assert.equal(await secondOutcome, 'deadline_exceeded', 'a queued entry must settle on its own deadline');
  held.release?.();
  // Idle origin state is released: a later acquire still works.
  const third = await limiter.acquire('https://a.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 10_000 });
  third();
});

test('cache entries expire on the injected clock; hits keep observedAt and zero new sends', async () => {
  const clock = fakeClock();
  const h = harness({ clock });
  const first = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.transport.calls, 1);
  assert.equal(first.sendCount, 1);
  clock.advance(10_000);
  const hit = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.transport.calls, 1, 'within-TTL replay sends nothing');
  assert.equal(hit.reused, true);
  assert.equal(hit.observedAt, first.observedAt, 'the original observation time survives reuse');
  assert.equal(hit.sendCount, 0, 'cached replay reports zero NEW sends');
  clock.advance(21_000);
  await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.transport.calls, 2, 'expired cache entries are not reused');
});

test('receipts report the real send boundary and all actual send attempts', async () => {
  const cancelError = Object.assign(new Error('aborted'), { code: 'cancelled', sendCount: 2 });
  const h = harness({ responses: [cancelError] });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0]!.sendCount, 2, 'redirect sends that actually happened stay counted');
  assert.equal(h.receipts[0]!.requestSent, true);

  const controller = new AbortController();
  controller.abort();
  const queued = harness({ signal: controller.signal });
  const cancelledBeforeSend = await executeDiscoveryRequest(request(), queued.ctx);
  assert.equal(cancelledBeforeSend.status, 'cancelled');
  assert.equal(queued.receipts.length, 1);
  assert.equal(queued.receipts[0]!.requestSent, false, 'nothing was sent before the cancel');
  assert.equal(queued.receipts[0]!.sendCount, 0);
});
