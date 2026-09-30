/**
 * GET-91 repair-4 regressions (final repair3 review: 3 P1). Production pinned
 * transport + synthetic fake connector/DNS only. Reproduces: gate/queue
 * attempts miscounted as dispatches, stale authorization at post-DNS/queue
 * dispatch boundary, and missing credential-query guard in the URL policy.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  OriginRateLimiter,
  PlannedDiscoveryRequest
} from '../server/discovery/rule-executor.js';
import { createInMemoryRateLimiter, executeDiscoveryRequest } from '../server/discovery/rule-executor.js';
import type { PublicDiscoveryRule } from '../shared/public-discovery-rules.js';

const SAFE = { address: '93.184.216.34', family: 4 as const };

function rule(): PublicDiscoveryRule {
  return {
    ruleId: 'pr-0000000000000001',
    sourceRef: { sourceId: 'maigret', rowId: 'row', rowSha256: 'a'.repeat(64) },
    sourceName: 'Fixture',
    canonicalProfileTemplate: 'https://a.example.test/{username}',
    requestTemplate: 'https://a.example.test/{username}',
    instanceHost: 'a.example.test',
    accountKind: 'unknown',
    detection: {
      kind: 'bounded_strings',
      presentStatus: null,
      presentAny: ['independent-profile-marker'],
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
    safeHeaders: {}
  };
}

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

interface Connector extends PinnedHttpConnector {
  calls: number;
  hosts: string[];
  destroys: number;
}

function fakeConnector(
  script: Array<{ response?: FakeResponse; error?: Error; hang?: boolean; throwNow?: Error }>
): Connector {
  const state = { calls: 0, hosts: [] as string[], destroys: 0 };
  return {
    get calls() {
      return state.calls;
    },
    get hosts() {
      return state.hosts;
    },
    get destroys() {
      return state.destroys;
    },
    request(options: Record<string, unknown>, callback: (res: never) => void) {
      state.calls += 1;
      state.hosts.push(String(options.host ?? ''));
      const step = script[0];
      if (step?.throwNow) {
        script.shift();
        throw step.throwNow;
      }
      const req = new EventEmitter() as FakeRequest;
      req.destroyed = false;
      req.destroy = () => {
        if (!req.destroyed) state.destroys += 1;
        req.destroyed = true;
        req.emit('close');
      };
      req.end = () => {
        const next = script.shift();
        if (!next || next.hang) return;
        setImmediate(() => {
          if (next.error) req.emit('error', next.error);
          else if (next.response) (callback as unknown as (res: FakeResponse) => void)(next.response);
        });
      };
      return req;
    }
  } as unknown as Connector;
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

function fakeClock(start = 1_000_000): DiscoveryClock & { advance(ms: number): void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

interface Harness {
  ctx: DiscoveryRequestContext;
  connector: Connector;
  receipts: DiscoveryRequestReceipt[];
  releases: number;
  dnsCalls: string[];
  limiter: OriginRateLimiter;
}

function harness(over: {
  script: Parameters<typeof fakeConnector>[0];
  signal?: AbortSignal;
  timeoutMs?: number;
  limiter?: OriginRateLimiter;
  authorityRefresh?: (stage: string) => boolean | Promise<boolean>;
  dns?: DnsResolver;
}): Harness {
  const connector = fakeConnector(over.script);
  const transport: DiscoveryTransport = createPinnedHttpsTransport({ connector });
  const receipts: DiscoveryRequestReceipt[] = [];
  const clock = fakeClock();
  const dnsCalls: string[] = [];
  const baseLimiter = over.limiter ?? createInMemoryRateLimiter({ clock, globalMaxConcurrent: 4 });
  let releases = 0;
  const limiter: OriginRateLimiter = {
    async acquire(origin, options) {
      const release = await baseLimiter.acquire(origin, options);
      return () => {
        releases += 1;
        release();
      };
    },
    noteRetryAfter(origin, ms) {
      baseLimiter.noteRetryAfter(origin, ms);
    }
  };
  const ctx: DiscoveryRequestContext = {
    signal: over.signal ?? new AbortController().signal,
    clock,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: over.dns ?? {
      resolveAll: async (hostname) => {
        dnsCalls.push(hostname);
        return [SAFE];
      }
    },
    transport,
    authority: {
      async refresh(stage: string) {
        return over.authorityRefresh ? await over.authorityRefresh(stage) : true;
      }
    },
    rateLimiter: limiter,
    cache: new MapCache(),
    receipts: {
      record(receipt: DiscoveryRequestReceipt) {
        receipts.push(receipt);
      }
    },
    rules: new Map([['pr-0000000000000001', rule()]]),
    scope: { owner: 'o', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    limits: { timeoutMs: over.timeoutMs ?? 5000, maxBytes: 4096, cacheTtlMs: 30_000 }
  };
  return {
    ctx,
    connector,
    receipts,
    get releases() {
      return releases;
    },
    dnsCalls,
    limiter
  };
}

function request(over: Partial<PlannedDiscoveryRequest> = {}): PlannedDiscoveryRequest {
  return {
    requestKey: 'rk-1',
    origin: 'https://a.example.test',
    url: 'https://a.example.test/user',
    headers: {},
    ruleIds: ['pr-0000000000000001'],
    ...over
  };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* P1-1: only real connector dispatches are counted                     */
/* ------------------------------------------------------------------ */

test('P1-1 abort while a redirect hop waits for its lease reports only real dispatches', async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 2 });
  const held = await limiter.acquire('https://b.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 60_000 });
  const h = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { hang: true }
    ],
    signal: controller.signal,
    limiter
  });
  const promise = executeDiscoveryRequest(request(), h.ctx);
  await tick(15); // A dispatched + redirected; B waits for its lease
  assert.equal(h.connector.hosts.join(','), 'a.example.test', 'only A really dispatched so far');
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(h.connector.calls, 1, 'the queued hop is not a dispatch');
  assert.equal(outcome.sendCount, 1, 'gate/queue attempts are never counted as sends');
  assert.equal(h.receipts.length, 1, 'exactly one usage receipt');
  assert.equal(h.receipts[0]!.sendCount, 1);
  assert.equal(h.receipts[0]!.requestSent, true);
  // A late lease grant is released but can never dispatch.
  held();
  await tick(15);
  assert.equal(h.connector.calls, 1);
});

test('P1-1 deadline while a redirect hop waits for its lease reports only real dispatches', async () => {
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 2 });
  const held = await limiter.acquire('https://b.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 60_000 });
  const h = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { hang: true }
    ],
    timeoutMs: 25,
    limiter
  });
  const outcome = await executeDiscoveryRequest(request(), h.ctx);
  held();
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.sendCount, 1);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0]!.sendCount, 1);
  assert.equal(h.receipts[0]!.outcome, 'unknown');
});

test('P1-1 initial queue abort reports zero sends; sync connector throw is one attempted dispatch', async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 1 });
  const held = await limiter.acquire('https://a.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 60_000 });
  const queued = harness({
    script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }],
    signal: controller.signal,
    limiter
  });
  const promise = executeDiscoveryRequest(request(), queued.ctx);
  await tick(5);
  controller.abort();
  const outcome = await promise;
  held();
  assert.equal(queued.connector.calls, 0, 'a queued acquire is never a dispatch');
  assert.equal(outcome.sendCount, 0);
  assert.equal(queued.receipts.length, 1);
  assert.equal(queued.receipts[0]!.requestSent, false);
  assert.equal(queued.receipts[0]!.sendCount, 0);

  const throwing = harness({ script: [{ throwNow: new Error('connector ctor exploded') }] });
  const thrownOutcome = await executeDiscoveryRequest(request(), throwing.ctx);
  assert.equal(thrownOutcome.status, 'failed');
  assert.equal(throwing.receipts.length, 1);
  assert.equal(throwing.receipts[0]!.sendCount, 1, 'an attempted connector dispatch is counted');
  assert.equal(throwing.receipts[0]!.requestSent, true);
});

/* ------------------------------------------------------------------ */
/* P1-2: fresh authority AFTER DNS + origin queue, before each dispatch  */
/* ------------------------------------------------------------------ */

test('P1-2 revocation while the redirect lease is awaited blocks that dispatch', async () => {
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 2 });
  const held = await limiter.acquire('https://b.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 60_000 });
  let sends = 0;
  const h = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }
    ],
    limiter,
    authorityRefresh: (stage) => {
      if (stage === 'send') {
        sends += 1;
        // Executor post-DNS check (1) + hop-1 gate (2) pass; hop-2 gate (3)
        // runs AFTER its lease is granted and must see the revocation.
        return sends < 3;
      }
      return true;
    }
  });
  const promise = executeDiscoveryRequest(request(), h.ctx);
  await tick(15);
  held();
  const outcome = await promise;
  await tick(10);
  assert.equal(h.connector.hosts.join(','), 'a.example.test', 'B must never dispatch after revocation');
  assert.equal(outcome.sendCount, 1);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0]!.sendCount, 1);
  assert.equal(h.releases, 2, 'each granted lease (A entry + B hop) is released exactly once');
});

test('P1-2 revocation during initial queue / redirect DNS sends nothing new', async () => {
  // Initial queue: revocation lands while the entry lease is awaited.
  const clock = fakeClock();
  const limiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 1 });
  const held = await limiter.acquire('https://a.example.test', { signal: new AbortController().signal, deadlineAt: clock.now() + 60_000 });
  let revoked = false;
  const queued = harness({
    script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }],
    limiter,
    authorityRefresh: () => !revoked
  });
  const promise = executeDiscoveryRequest(request(), queued.ctx);
  await tick(5);
  revoked = true;
  held();
  const queuedOutcome = await promise;
  assert.equal(queued.connector.calls, 0);
  assert.equal(queuedOutcome.sendCount, 0);
  assert.equal(queuedOutcome.detailCode, 'scope_refresh_refused');

  // Redirect DNS: revocation lands while hop-2 DNS is pending.
  let revokedDuringDns = false;
  let resolveSecond: ((records: Array<{ address: string; family: 4 }>) => void) | null = null;
  const dnsState: { resolve: ((records: Array<{ address: string; family: 4 }>) => void) | null } = { resolve: null };
  const dns: DnsResolver = {
    resolveAll: async (hostname) => {
      if (hostname === 'b.example.test') {
        return await new Promise((resolve) => {
          dnsState.resolve = resolve;
        });
      }
      return [SAFE];
    }
  };
  resolveSecond = null;
  const duringDns = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }
    ],
    dns,
    authorityRefresh: () => !revokedDuringDns
  });
  const dnsPromise = executeDiscoveryRequest(request(), duringDns.ctx);
  await tick(15);
  revokedDuringDns = true;
  dnsState.resolve?.([SAFE]);
  const dnsOutcome = await dnsPromise;
  assert.equal(duringDns.connector.hosts.join(','), 'a.example.test', 'no dispatch after revocation during redirect DNS');
  assert.equal(dnsOutcome.sendCount, 1, 'A really sent earlier stays counted');
  assert.equal(duringDns.receipts.length, 1);
});

test('P1-2 authority throw/stall at the post-lease boundary releases once and never dispatches', async () => {
  let sends = 0;
  const throwing = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }
    ],
    authorityRefresh: (stage) => {
      if (stage === 'send') {
        sends += 1;
        if (sends === 3) throw new Error('authority store down');
      }
      return true;
    }
  });
  const outcome = await executeDiscoveryRequest(request(), throwing.ctx);
  assert.equal(throwing.connector.hosts.join(','), 'a.example.test');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detailCode, 'scope_refresh_error');
  assert.equal(outcome.sendCount, 1);
  assert.equal(throwing.releases, 2, 'both granted leases released exactly once');
  assert.equal(throwing.receipts.length, 1);

  let stalls = 0;
  const stalling = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
      { hang: true }
    ],
    timeoutMs: 40,
    authorityRefresh: (stage) => {
      if (stage === 'send') {
        stalls += 1;
        if (stalls === 3) return new Promise<boolean>(() => undefined);
      }
      return true;
    }
  });
  const stallOutcome = await executeDiscoveryRequest(request(), stalling.ctx);
  assert.equal(stalling.connector.hosts.join(','), 'a.example.test');
  assert.equal(stallOutcome.sendCount, 1);
  assert.equal(stalling.receipts.length, 1);
});

/* ------------------------------------------------------------------ */
/* P1-3: credential-query guard in the URL target policy                */
/* ------------------------------------------------------------------ */

test('P1-3 validateDiscoveryTarget refuses credential query targets BEFORE any DNS', async () => {
  const dnsCalls: string[] = [];
  const dns: DnsResolver = {
    resolveAll: async (hostname) => {
      dnsCalls.push(hostname);
      return [SAFE];
    }
  };
  for (const url of [
    'https://a.example.test/u?api_key=FAKE_SYNTHETIC_ONLY&user=u',
    'https://a.example.test/u?API_KEY=FAKE_SYNTHETIC_ONLY&user=u',
    'https://a.example.test/u?api%5Fkey=FAKE_SYNTHETIC_ONLY&user=u',
    'https://a.example.test/u?access_token=FAKE_SYNTHETIC_ONLY',
    'https://a.example.test/u?authorization=FAKE_SYNTHETIC_ONLY',
    'https://a.example.test/u?x=1&password=FAKE_SYNTHETIC_ONLY#frag'
  ]) {
    await assert.rejects(
      () => validateDiscoveryTarget(url, PUBLIC_HTTPS_TARGET_POLICY, dns),
      (error: unknown) => typeof (error as { code?: string }).code === 'string',
      `${url} must be refused as a credential target`
    );
  }
  assert.equal(dnsCalls.length, 0, 'credential targets are refused before DNS');
  // Legal username/profile query semantics stay accepted.
  for (const url of [
    'https://a.example.test/u?user=u&id=5&q=hello%20world&tab=posts',
    'https://a.example.test/u?id=1&id=2&user=u',
    'https://a.example.test/u?user=u#section'
  ]) {
    await validateDiscoveryTarget(url, PUBLIC_HTTPS_TARGET_POLICY, dns);
  }
  assert.ok(dnsCalls.length > 0, 'legal queries still resolve');
});

test('P1-3 initial and redirected credential URLs never reach DNS/send for the rejected hop', async () => {
  const initial = harness({
    script: [{ response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }]
  });
  const outcome = await executeDiscoveryRequest(
    request({ url: 'https://a.example.test/u?api%5Fkey=FAKE_SYNTHETIC_ONLY&user=u' }),
    initial.ctx
  );
  assert.equal(initial.connector.calls, 0);
  assert.equal(initial.dnsCalls.length, 0, 'rejected initial target sends nothing and resolves nothing');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detailCode, 'target_refused');
  assert.equal(outcome.sendCount, 0);

  const redirected = harness({
    script: [
      { response: new FakeResponse(302, { location: 'https://b.example.test/next?API_KEY=FAKE_SYNTHETIC_ONLY' }, SAFE.address) },
      { response: new FakeResponse(200, {}, SAFE.address, ['independent-profile-marker']) }
    ]
  });
  const redirectOutcome = await executeDiscoveryRequest(request(), redirected.ctx);
  assert.equal(redirected.connector.hosts.join(','), 'a.example.test', 'the credential redirect hop never dispatches');
  assert.deepEqual(redirected.dnsCalls, ['a.example.test'], 'the credential hop never resolves');
  assert.equal(redirectOutcome.sendCount, 1, 'A stays counted');
  assert.equal(redirectOutcome.status, 'failed');
  assert.equal(redirected.receipts.length, 1);
  assert.equal(redirected.receipts[0]!.sendCount, 1);
});

test('P1-1/P1-2 in-flight initial abort keeps its real sent receipt (no regression)', async () => {
  const controller = new AbortController();
  const h = harness({
    script: [{ hang: true }],
    signal: controller.signal
  });
  const promise = executeDiscoveryRequest(request(), h.ctx);
  await tick(1);
  controller.abort();
  const outcome = await promise;
  assert.equal(outcome.sendCount, 1);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0]!.sendCount, 1);
  assert.equal(h.receipts[0]!.requestSent, true);
  assert.ok(h.connector.destroys >= 1, 'the active transport is destroyed');
});

// A lease granted in the same turn as abort is shared by late cleanup and
// owned settlement; neither path may release the underlying lease twice.
for (const redirected of [false, true]) {
  test(`grant/abort race releases ${redirected ? 'redirect' : 'initial'} lease exactly once`, async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    let grant!: () => void;
    const releases: number[] = [];
    const h = harness({
      signal: controller.signal,
      script: redirected
        ? [{ response: new FakeResponse(302, { location: 'https://b.example.test/u' }, SAFE.address) }]
        : []
    });
    h.ctx.rateLimiter = {
      acquire() {
        const index = releases.length;
        releases.push(0);
        const release = () => { releases[index] = releases[index]! + 1; };
        if (redirected && index === 0) return Promise.resolve(release);
        return new Promise<() => void>((resolve) => {
          grant = () => resolve(release);
          entered();
        });
      },
      noteRetryAfter() {}
    };
    const pending = executeDiscoveryRequest(request(), h.ctx);
    await waiting;
    grant();
    controller.abort();
    const outcome = await pending;
    await tick(1);
    assert.equal(outcome.status, 'cancelled');
    assert.deepEqual(releases, redirected ? [1, 1] : [1]);
    assert.equal(h.connector.calls, redirected ? 1 : 0);
    assert.equal(outcome.sendCount, redirected ? 1 : 0);
    assert.equal(h.receipts.length, 1);
    assert.equal((h.ctx.cache as MapCache).store.size, 0);
  });
}
