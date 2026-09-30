/**
 * GET-91 repair-2 regressions (Task 3 runtime + policy + evaluator).
 * Each test reproduces a confirmed native-review finding BEFORE the fix.
 * All ports fake: no DNS provider, no HTTP, no provider calls.
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
import type {
  DiscoveryClock,
  DiscoveryRequestContext,
  DiscoveryRequestReceipt,
  DiscoveryResponseCache,
  DiscoveryTransport,
  OriginRateLimiter,
  PlannedDiscoveryRequest
} from '../server/discovery/rule-executor.js';
import {
  createInMemoryRateLimiter,
  evaluateRule,
  executeDiscoveryRequest
} from '../server/discovery/rule-executor.js';
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
      presentAny: ['profile_found'],
      nonProofPresentAny: [],
      absentStatus: null,
      absentAny: [],
      boundedPositive: true,
      boundedNegative: false
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

class MapCache implements DiscoveryResponseCache {
  readonly store = new Map<string, { response: BoundedDiscoveryResponse; observedAt: string; expiresAt: number }>();
  get(key: string) {
    return this.store.get(key) ?? null;
  }
  set(key: string, entry: { response: BoundedDiscoveryResponse; observedAt: string; expiresAt: number }): void {
    this.store.set(key, entry);
  }
}

interface SpyLimiter extends OriginRateLimiter {
  acquires: string[];
  releases: number;
  retryNotes: Array<{ origin: string; ms: number }>;
}

function spyLimiter(clock: DiscoveryClock, base?: OriginRateLimiter): SpyLimiter {
  const inner = base ?? createInMemoryRateLimiter({ clock });
  const acquires: string[] = [];
  const retryNotes: Array<{ origin: string; ms: number }> = [];
  const spy: SpyLimiter = {
    acquires,
    retryNotes,
    releases: 0,
    async acquire(origin, options) {
      acquires.push(origin);
      const release = await inner.acquire(origin, options);
      return () => {
        spy.releases += 1;
        release();
      };
    },
    noteRetryAfter(origin, ms) {
      retryNotes.push({ origin, ms });
      inner.noteRetryAfter(origin, ms);
    }
  };
  return spy;
}

interface Harness {
  ctx: DiscoveryRequestContext;
  transport: { calls: number; deadlines: number[]; request: DiscoveryTransport['request'] };
  receipts: DiscoveryRequestReceipt[];
  stages: string[];
  limiter: SpyLimiter;
  cache: MapCache;
}

function harness(over: {
  responses?: Array<BoundedDiscoveryResponse | Error>;
  clock?: DiscoveryClock & { advance(ms: number): void };
  authorityRefresh?: (stage: string) => boolean | Promise<boolean>;
  rules?: Map<string, PublicDiscoveryRule>;
  signal?: AbortSignal;
  timeoutMs?: number;
  limiterBase?: OriginRateLimiter;
  dns?: DnsResolver;
}): Harness {
  const receipts: DiscoveryRequestReceipt[] = [];
  const stages: string[] = [];
  const script = [...(over.responses ?? [response()])];
  const transport = {
    calls: 0,
    deadlines: [] as number[],
    async request(_target: ValidatedDiscoveryTarget, options: { deadlineAt: number }) {
      transport.calls += 1;
      transport.deadlines.push(options.deadlineAt);
      const next = script.shift() ?? new Error('unexpected extra request');
      if (next instanceof Error) throw next;
      return next;
    }
  };
  const clock = over.clock ?? { now: () => Date.now(), advance: () => undefined };
  const limiter = spyLimiter(clock, over.limiterBase);
  const cache = new MapCache();
  const ctx: DiscoveryRequestContext = {
    signal: over.signal ?? new AbortController().signal,
    clock,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: over.dns ?? { resolveAll: async () => [SAFE] },
    transport,
    authority: {
      async refresh(stage: string) {
        stages.push(stage);
        return over.authorityRefresh ? await over.authorityRefresh(stage) : true;
      }
    },
    rateLimiter: limiter,
    cache,
    receipts: {
      record(receipt: DiscoveryRequestReceipt) {
        receipts.push(receipt);
      }
    },
    rules: over.rules ?? new Map([['pr-0000000000000001', rule()]]),
    scope: { owner: 'o', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    limits: { timeoutMs: over.timeoutMs ?? 5000, maxBytes: 4096, cacheTtlMs: 30_000 }
  };
  return { ctx, transport, receipts, stages, limiter, cache };
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

function fakeClock(start = 1_000_000): DiscoveryClock & { advance(ms: number): void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

/* ------------------------------------------------------------------ */
/* P1-1: one absolute deadline over queue/DNS/authority/hops           */
/* ------------------------------------------------------------------ */

test('P1-1 initial DNS beyond the deadline settles, releases once and never dispatches', async () => {
  const h = harness({ timeoutMs: 15, dns: { resolveAll: () => new Promise(() => undefined) } });
  const started = Date.now();
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.ok(Date.now() - started < 1000, 'the overall deadline covers initial DNS');
  assert.equal(h.transport.calls, 0, 'late DNS must never dispatch');
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.detailCode, 'deadline_exceeded');
  assert.equal(h.limiter.releases, 1, 'capacity released exactly once');
  for (const item of outcome.ruleOutcomes) assert.notEqual(item.outcome, 'candidate');
});

test('P1-1 abort during initial DNS settles cancelled without dispatch', async () => {
  const controller = new AbortController();
  const h = harness({ timeoutMs: 2000, signal: controller.signal, dns: { resolveAll: () => new Promise(() => undefined) } });
  const promise = executeDiscoveryRequest(request(), h.ctx);
  setTimeout(() => controller.abort(), 5);
  const outcome = await promise;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(h.transport.calls, 0);
  assert.equal(h.limiter.releases, 1);
});

test('P1-1 queue+DNS exhausting the budget never sends', async () => {
  const clock = fakeClock();
  const held = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 1 });
  const first = await held.acquire('https://fixture.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 10_000 });
  const h = harness({
    clock,
    timeoutMs: 30,
    limiterBase: held,
    dns: { resolveAll: () => new Promise((resolve) => setTimeout(() => resolve([SAFE]), 40)) }
  });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  first();
  assert.equal(h.transport.calls, 0, 'budget consumed by queue+DNS must not send');
  assert.notEqual(outcome.detailCode, 'ok');
  assert.equal(h.limiter.releases, 0, 'a queued-but-denied acquire owns no capacity to release');
});

test('P1-1 the entry deadline is passed to every hop unchanged (never reset after queueing)', async () => {
  const clock = fakeClock(1_000_000);
  const slowLimiter: OriginRateLimiter = {
    async acquire() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return () => undefined;
    },
    noteRetryAfter() {
      // test stub
    }
  };
  const h = harness({ clock, timeoutMs: 100, limiterBase: slowLimiter });
  await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.transport.deadlines.length, 1);
  assert.equal(h.transport.deadlines[0], 1_000_000 + 100, 'transport gets the ORIGINAL absolute deadline');
});

/* ------------------------------------------------------------------ */
/* P1-3 / P1-4: cancellation and authority failures settle honestly    */
/* ------------------------------------------------------------------ */

test('P1-3 an aborted caller cannot read a cache hit as a candidate', async () => {
  const clock = fakeClock();
  const h = harness({ clock });
  await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(h.transport.calls, 1);
  const controller = new AbortController();
  controller.abort();
  const h2 = harness({ clock, signal: controller.signal });
  h2.cache.store.set([...h.cache.store.keys()][0]!, [...h.cache.store.values()][0]!);
  const outcome = await executeDiscoveryRequest(request(), h2.ctx);
  assert.notEqual(outcome.status, 'completed');
  assert.equal(outcome.reused, false);
  for (const item of outcome.ruleOutcomes) assert.notEqual(item.outcome, 'candidate');
});

test('P1-3 abort between response and commit yields no candidate and no cache write', async () => {
  const controller = new AbortController();
  const h = harness({
    authorityRefresh: (stage) => {
      if (stage === 'commit') controller.abort();
      return true;
    },
    signal: controller.signal
  });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(outcome.status, 'cancelled');
  for (const item of outcome.ruleOutcomes) assert.notEqual(item.outcome, 'candidate');
  assert.equal(h.cache.store.size, 0, 'cancelled results are never cached');
  assert.equal(h.receipts.length, 1, 'the real sent usage receipt survives');
  assert.equal(h.receipts[0]!.requestSent, true);
  assert.equal(h.limiter.releases, 1);
});

test('P1-4 authority throw fails closed, releases once and keeps sent receipts', async () => {
  const throwingSend = harness({
    authorityRefresh: (stage) => {
      if (stage === 'send') throw new Error('authority store down');
      return true;
    }
  });
  const sendOutcome = await executeDiscoveryRequest(request(), throwingSend.ctx);
  assert.equal(sendOutcome.status, 'failed');
  assert.equal(sendOutcome.detailCode, 'scope_refresh_error');
  assert.equal(throwingSend.transport.calls, 0);
  assert.equal(throwingSend.limiter.releases, 1);
  assert.equal(throwingSend.receipts.length, 1);
  assert.equal(throwingSend.receipts[0]!.requestSent, false);

  const throwingCommit = harness({
    authorityRefresh: (stage) => {
      if (stage === 'commit') throw new Error('authority store down');
      return true;
    }
  });
  const commitOutcome = await executeDiscoveryRequest(request(), throwingCommit.ctx);
  assert.equal(commitOutcome.status, 'failed');
  assert.equal(commitOutcome.detailCode, 'scope_refresh_error');
  assert.equal(throwingCommit.transport.calls, 1);
  assert.equal(throwingCommit.receipts.length, 1, 'the dispatched attempt keeps its receipt');
  assert.equal(throwingCommit.receipts[0]!.requestSent, true);
  for (const item of commitOutcome.ruleOutcomes) assert.notEqual(item.outcome, 'candidate');
  assert.equal(throwingCommit.cache.store.size, 0);
  assert.equal(throwingCommit.limiter.releases, 1);
});

test('P1-4 a stalling authority is failure under the same deadline, never proof', async () => {
  const h = harness({
    timeoutMs: 15,
    authorityRefresh: (stage) => (stage === 'send' ? new Promise<boolean>(() => undefined) : true)
  });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.detailCode, 'deadline_exceeded');
  assert.equal(h.transport.calls, 0);
  assert.equal(h.limiter.releases, 1);
});

/* ------------------------------------------------------------------ */
/* P1-2: actual-origin leases + Retry-After + persistent rate state     */
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

function fakeConnector(script: Array<{ response?: FakeResponse; error?: Error }>): PinnedHttpConnector & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    request(_options: Record<string, unknown>, callback: (res: never) => void) {
      state.calls += 1;
      const req = new EventEmitter() as unknown as { destroy(): void; end(): void; destroyed: boolean; emit(event: string, ...args: unknown[]): void };
      req.destroyed = false;
      req.destroy = () => {
        req.destroyed = true;
        req.emit('close');
      };
      req.end = () => {
        const step = script.shift();
        setImmediate(() => {
          if (!step) return;
          if (step.error) req.emit('error', step.error);
          else if (step.response) (callback as unknown as (res: FakeResponse) => void)(step.response);
        });
      };
      return req;
    }
  } as unknown as PinnedHttpConnector & { calls: number };
}

test('P1-2 every real send leases its ACTUAL target origin and 429/503 Retry-After lands there', async () => {
  const clock = fakeClock();
  const connector = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
    { response: new FakeResponse(429, { 'retry-after': '7' }, SAFE.address, ['slow down']) }
  ]);
  const transport = createPinnedHttpsTransport({ connector });
  const dns: DnsResolver = { resolveAll: async () => [SAFE] };
  const limiter = spyLimiter(clock, createInMemoryRateLimiter({ clock, globalMaxConcurrent: 1 }));
  const receipts: DiscoveryRequestReceipt[] = [];
  const ctx: DiscoveryRequestContext = {
    signal: new AbortController().signal,
    clock,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns,
    transport,
    authority: { refresh: async () => true },
    rateLimiter: limiter,
    cache: new MapCache(),
    receipts: { record: (receipt) => receipts.push(receipt) },
    rules: new Map([['pr-0000000000000001', rule()]]),
    scope: { owner: 'o', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    limits: { timeoutMs: 5000, maxBytes: 4096, cacheTtlMs: 30_000 }
  };
  const outcome = await executeDiscoveryRequest(
    request({ url: 'https://a.example.test/user', origin: 'https://a.example.test' }),
    ctx
  );
  assert.equal(connector.calls, 2, 'redirect hop and final request both sent');
  assert.equal(outcome.sendCount, 2);
  assert.deepEqual(limiter.acquires, ['https://a.example.test', 'https://b.example.test'], 'each send leases its actual origin');
  assert.equal(limiter.releases, 2, 'each hop releases its own slot before the next acquire (no nested deadlock)');
  assert.deepEqual(
    limiter.retryNotes.map((note) => note.origin),
    ['https://b.example.test'],
    'Retry-After is recorded for the ACTUAL response origin before its slot is released'
  );
  assert.equal(limiter.retryNotes[0]!.ms, 7000);
});

test('P1-2 unexpired rate state survives idle cleanup and other-origin activity', async () => {
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 4 });
  const signal = new AbortController().signal;
  const first = await limiter.acquire('https://a.example.test', { signal, deadlineAt: clock.now() + 10_000, minIntervalMs: 1000 });
  first();
  // Unrelated origin activity (and idle cleanup) must not forget A's interval.
  const other = await limiter.acquire('https://b.example.test', { signal, deadlineAt: clock.now() + 10_000 });
  other();
  let secondStarted = false;
  const second = limiter.acquire('https://a.example.test', { signal, deadlineAt: clock.now() + 10_000, minIntervalMs: 1000 }).then((release) => {
    secondStarted = true;
    release();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondStarted, false, 'minInterval must still be enforced after idle cleanup');
  clock.advance(1001);
  await second;

  // Retry-After cooldown also survives unrelated activity.
  limiter.noteRetryAfter('https://c.example.test', 5000);
  const unrelated = await limiter.acquire('https://b.example.test', { signal, deadlineAt: clock.now() + 10_000 });
  unrelated();
  let cStarted = false;
  const third = limiter.acquire('https://c.example.test', { signal, deadlineAt: clock.now() + 10_000 }).then((release) => {
    cStarted = true;
    release();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cStarted, false, 'Retry-After cooldown must survive unrelated origin activity');
  clock.advance(5001);
  await third;
});

/* ------------------------------------------------------------------ */
/* P1-5: IANA ordinary allocated IPv6 inventory                        */
/* ------------------------------------------------------------------ */

test('P1-5 only frozen IANA-allocated IPv6 prefixes are accepted, not all of 2000::/3', () => {
  for (const address of ['2000::1', '2001:1000::1', '2001:ffff::1', '3000::1', '3ffe::1', '3fff:1000::1', '4000::1', '23ff::1']) {
    assert.equal(checkPublicAddress(address).ok, false, `${address} is not ordinary allocated space`);
  }
  for (const address of [
    '2001:200::1',
    '2001:4860:4860::8888',
    '2003::1',
    '2400::1',
    '2410::1234',
    '2600::1',
    '2606:4700:4700::1111',
    '2a00:1450:4001::1',
    '2c00::1'
  ]) {
    assert.equal(checkPublicAddress(address).ok, true, `${address} sits in an allocated prefix`);
  }
  // Both ends of allocated prefixes pass; specials inside stay denied.
  for (const address of ['2410::', '2410:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2600::', '2600:ffff:ffff:ffff:ffff:ffff:ffff:ffff']) {
    assert.equal(checkPublicAddress(address).ok, true, `${address} is an allocated boundary`);
  }
  for (const address of ['2001:db8::1', '2002:a00:1::1', '64:ff9b::7f00:1', '3fff::1', '2001::1']) {
    assert.equal(checkPublicAddress(address).ok, false, `${address} stays denied`);
  }
  // Neighbors of allocated prefixes are never inferred as allocated.
  assert.equal(checkPublicAddress('2420::1').ok, false);
  assert.equal(checkPublicAddress('25ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff').ok, false);
});

/* ------------------------------------------------------------------ */
/* P1-8 / P1-9: page proofs and bounded negative semantics             */
/* ------------------------------------------------------------------ */

const LOGIN_MARKERS = ['Dernier Login', 'LOGIN', 'loginname', 'Please log in to like, share and comment', 'data-template="login"'];

test('P1-8 a primary login form is never a candidate/no-match, whatever its source marker', () => {
  for (const marker of LOGIN_MARKERS) {
    const body = `<html><head><title>Log in</title></head><body><main><h1>Log in</h1><form action="/login" method="post"><input name="username"><input name="password" type="password"><button>Log in</button></form><div>${marker}</div></main></body></html>`;
    const bounded = rule({ detection: { ...rule().detection, presentAny: [marker], nonProofPresentAny: [], boundedPositive: true } });
    const outcome = evaluateRule(bounded, response({ bodyText: body, bytes: body.length }));
    assert.notEqual(outcome.outcome, 'candidate', `${marker} must not confirm an account on a login page`);
    assert.notEqual(outcome.outcome, 'checked_no_match', `${marker} must not refute an account on a login page`);
    assert.ok(['inaccessible', 'unknown'].includes(outcome.outcome));
  }
});

test('P1-8 an ordinary profile with sidebar login, CDN footer and bio text keeps its independent proof', () => {
  const body = [
    '<html><head><title>Ada Lovelace — profile</title></head><body>',
    '<nav><a href="/login">Log in</a><a href="/signup">Sign up</a></nav>',
    '<main><h1>Ada Lovelace</h1><p>Bio: we use Cloudflare for our CDN. Coming soon: new portfolio.</p>',
    '<div>profile_found</div></main>',
    '<footer>Powered by a CDN. <a href="/register">Register</a></footer>',
    '</body></html>'
  ].join('');
  const outcome = evaluateRule(rule(), response({ bodyText: body, bytes: body.length }));
  assert.equal(outcome.outcome, 'candidate', 'independent positive proof survives sidebar/CDN/bio noise');
});

test('P1-9 a 2xx absence status without a body marker is not bounded negative proof', () => {
  const evolutionLike = rule({
    detection: {
      kind: 'bounded_strings',
      presentStatus: 200,
      presentAny: ['specific-profile-marker'],
      nonProofPresentAny: [],
      absentStatus: 200,
      absentAny: [],
      boundedPositive: true,
      boundedNegative: false
    }
  });
  const outcome = evaluateRule(evolutionLike, response({ bodyText: 'Hello generic page', bytes: 17 }));
  assert.equal(outcome.outcome, 'unknown');
  assert.notEqual(outcome.outcome, 'checked_no_match');
});

test('P1-9 generic soft-404 pages override a declared absence marker; genuine negatives stay no-match', () => {
  const declared = rule({
    detection: {
      kind: 'bounded_strings',
      presentStatus: null,
      presentAny: ['specific-profile-marker'],
      nonProofPresentAny: [],
      absentStatus: null,
      absentAny: ['no such user'],
      boundedPositive: true,
      boundedNegative: true
    }
  });
  const soft404 = '<html><head><title>Page not found</title></head><body><h1>Page not found</h1><p>no such user</p></body></html>';
  const generic = evaluateRule(declared, response({ bodyText: soft404, bytes: soft404.length }));
  assert.notEqual(generic.outcome, 'checked_no_match', 'generic page ambiguity wins over a source absence marker');
  assert.notEqual(generic.outcome, 'candidate');

  const genuine = '<html><head><title>Profile</title></head><body><main><h1>Profile</h1><p>no such user</p></main></body></html>';
  const specific = evaluateRule(declared, response({ bodyText: genuine, bytes: genuine.length }));
  assert.equal(specific.outcome, 'checked_no_match', 'a site-specific bounded negative on a normal page is still proof');

  // Genuine 404 declared absence status stays valid per spec.
  const declaredStatus = rule({
    detection: {
      kind: 'bounded_strings',
      presentStatus: null,
      presentAny: ['specific-profile-marker'],
      nonProofPresentAny: [],
      absentStatus: 404,
      absentAny: [],
      boundedPositive: true,
      boundedNegative: true
    }
  });
  assert.equal(evaluateRule(declaredStatus, response({ status: 404, bodyText: 'gone' })).outcome, 'checked_no_match');
});
