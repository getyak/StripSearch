/**
 * GET-91 Task 3 executor tests (offline): bounded rule evaluation and the
 * standalone discovery request executor.
 *
 * All transports are fake; no DNS provider, no public URL and no paid API is
 * touched. Timings use an injectable clock so rate limiting and retry-after
 * behavior are deterministic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  PublicDetection,
  PublicDiscoveryRule
} from '../shared/public-discovery-rules.js';
import type { BoundedDiscoveryResponse, DnsResolver, ValidatedDiscoveryTarget } from '../server/discovery/request-policy.js';
import { PUBLIC_HTTPS_TARGET_POLICY } from '../server/discovery/request-policy.js';
import type {
  DiscoveryRequestContext,
  DiscoveryRequestReceipt,
  DiscoveryResponseCache,
  DiscoveryTransport,
  OriginRateLimiter,
  PlannedDiscoveryRequest
} from '../server/discovery/rule-executor.js';
import {
  createInMemoryRateLimiter,
  discoveryCacheKey,
  evaluateRule,
  executeDiscoveryRequest
} from '../server/discovery/rule-executor.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function rule(over: Omit<Partial<PublicDiscoveryRule>, 'detection'> & { detection?: Partial<PublicDetection> } = {}): PublicDiscoveryRule {
  const { detection: detectionOver, ...rest } = over;
  return {
    ruleId: 'pr-0000000000000001',
    sourceRef: { sourceId: 'whatsmyname', rowId: 'fixture', rowSha256: 'a'.repeat(64) },
    sourceName: 'Fixture',
    canonicalProfileTemplate: 'https://fixture.example.test/{username}',
    requestTemplate: 'https://fixture.example.test/{username}',
    instanceHost: 'fixture.example.test',
    accountKind: 'unknown',
    detection: {
      kind: 'bounded_strings',
      presentStatus: 200,
      presentAny: ['present-marker'],
      absentStatus: 404,
      absentAny: ['absent-marker'],
      boundedPositive: true,
      boundedNegative: true,
      ...(detectionOver ?? {})
    } as PublicDetection,
    caseSensitive: true,
    ratePerMinute: null,
    protections: [],
    errorMarkers: [],
    safeHeaders: {},
    ...rest
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
    bodyText: 'body with present-marker inside',
    bytes: 32,
    truncated: false,
    utf8Valid: true,
    sendCount: 1,
    ...over
  };
}

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function fakeClock(start = 1_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

interface RecordingTransport extends DiscoveryTransport {
  calls: number;
}

function fakeTransport(responses: Array<BoundedDiscoveryResponse | Error>): RecordingTransport {
  let calls = 0;
  return {
    calls: 0,
    async request(_target: ValidatedDiscoveryTarget) {
      calls += 1;
      this.calls = calls;
      const next = responses.shift() ?? new Error('unexpected extra request');
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

function fakeDns(): DnsResolver {
  return { resolveAll: async () => [{ address: '93.184.216.34', family: 4 }] };
}

function context(over: Partial<DiscoveryRequestContext> = {}): DiscoveryRequestContext & {
  receipts: { entries: DiscoveryRequestReceipt[] };
  stages: string[];
} {
  const receipts: DiscoveryRequestReceipt[] = [];
  const stages: string[] = [];
  return {
    receipts: {
      entries: receipts,
      record(receipt: DiscoveryRequestReceipt) {
        receipts.push(receipt);
      }
    },
    stages,
    signal: new AbortController().signal,
    clock: fakeClock(),
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: fakeDns(),
    transport: fakeTransport([response()]),
    authority: {
      refresh(stage: string) {
        stages.push(stage);
        return true;
      }
    },
    rateLimiter: createInMemoryRateLimiter({ clock: fakeClock() }),
    cache: new MapCache(),
    rules: new Map(),
    scope: { owner: 'owner-1', caseId: 'case-1', inputVersion: 'input-1', registryHash: 'sha256:reg', policyHash: 'sha256:policy' },
    limits: { timeoutMs: 5000, maxBytes: 4096, cacheTtlMs: 120_000 },
    ...over
  } as DiscoveryRequestContext & { receipts: { entries: DiscoveryRequestReceipt[] }; stages: string[] };
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
/* evaluateRule                                                        */
/* ------------------------------------------------------------------ */

test('a matching presence marker is a candidate clue with a short locatable excerpt', () => {
  const body = `padding ${'x'.repeat(400)} present-marker ${'y'.repeat(400)}`;
  const outcome = evaluateRule(rule(), response({ bodyText: body, bytes: body.length }));
  assert.equal(outcome.outcome, 'candidate');
  assert.equal(outcome.reasonCode, 'present_marker');
  assert.match(outcome.locator ?? '', /present-marker/);
  assert.ok((outcome.excerpt ?? '').length <= 200, 'only a short excerpt is kept');
  assert.ok((outcome.excerpt ?? '').length < body.length, 'the whole body is never persisted');
  assert.match(outcome.excerpt ?? '', /present-marker/);
});

test('a documented absence marker is checked_no_match', () => {
  const outcome = evaluateRule(rule(), response({ status: 404, bodyText: 'sorry, absent-marker here' }));
  assert.equal(outcome.outcome, 'checked_no_match');
  assert.equal(outcome.reasonCode, 'absent_marker');
});

test('soft 404 and generic placeholder pages are never candidates and never no-match', () => {
  for (const body of [
    'Sorry, this page is not available. The link you followed may be broken.',
    'Lorem ipsum dolor sit amet, welcome to our default page'
  ]) {
    for (const expected of ['candidate', 'checked_no_match']) {
      const outcome = evaluateRule(rule(), response({ bodyText: body }));
      assert.equal(['checked_no_match', 'candidate'].includes(outcome.outcome), false, `${body} must not be ${expected}`);
    }
    assert.ok(['unknown', 'inaccessible'].includes(evaluateRule(rule(), response({ bodyText: body })).outcome));
  }
});

test('captcha and access walls are blocked BEFORE positivity and can never be candidates', () => {
  const captcha = evaluateRule(rule(), response({ bodyText: 'Checking your browser before accessing captcha challenge' }));
  assert.equal(captcha.outcome, 'inaccessible');
  const wall = evaluateRule(
    rule({ detection: { presentAny: ['Log in to view this profile'] } }),
    response({ bodyText: 'Please Log in to view this profile' })
  );
  assert.equal(wall.outcome, 'inaccessible', 'login-wall strings never become candidates');
  const upstreamError = evaluateRule(rule({ errorMarkers: ['Bad guest token'] }), response({ bodyText: 'Bad guest token received' }));
  assert.equal(upstreamError.outcome, 'inaccessible');
});

test('status 200 alone stays unknown: unbounded rules never claim candidates', () => {
  const statusOnly = rule({
    detection: {
      kind: 'status_only',
      presentStatus: 200,
      presentAny: [],
      absentStatus: null,
      absentAny: [],
      boundedPositive: false,
      boundedNegative: false
    }
  });
  const outcome = evaluateRule(statusOnly, response({ bodyText: 'generic content without any marker' }));
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.reasonCode, 'no_bounded_proof');
  const redirect = rule({
    detection: {
      kind: 'url_redirect',
      presentStatus: null,
      presentAny: [],
      absentStatus: null,
      absentAny: [],
      boundedPositive: false,
      boundedNegative: false
    }
  });
  assert.equal(evaluateRule(redirect, response()).outcome, 'unknown', 'a redirect can never confirm an account identity');
});

test('disputed matches (presence and absence both) stay unknown', () => {
  const outcome = evaluateRule(
    rule({ detection: { absentStatus: 200 } }),
    response({ status: 200, bodyText: 'present-marker and absent-marker both here' })
  );
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.reasonCode, 'disputed_match');
});

test('different predicates on one shared response produce independent outcomes', () => {
  const shared = response({ status: 200, bodyText: 'contains present-marker only' });
  const positive = rule({ ruleId: 'pr-0000000000000001', detection: { presentAny: ['present-marker'], absentAny: ['absent-marker'], absentStatus: 404 } });
  const negative = rule({ ruleId: 'pr-0000000000000002', detection: { presentAny: ['other-present'], absentAny: ['contains present-marker only'], absentStatus: null } });
  assert.equal(evaluateRule(positive, shared).outcome, 'candidate');
  assert.equal(evaluateRule(negative, shared).outcome, 'checked_no_match');
});

test('unsupported encodings stay unknown instead of a false no-match', () => {
  const outcome = evaluateRule(rule(), response({ encoding: 'unsupported', bodyText: 'absent-marker' }));
  assert.equal(outcome.outcome, 'unknown');
  assert.equal(outcome.reasonCode, 'unsupported_encoding');
});

/* ------------------------------------------------------------------ */
/* executeDiscoveryRequest                                             */
/* ------------------------------------------------------------------ */

test('one bounded response feeds several predicates with one request and one receipt', async () => {
  const rules = new Map([
    ['pr-0000000000000001', rule({ ruleId: 'pr-0000000000000001', detection: { presentAny: ['present-marker'] } })],
    ['pr-0000000000000002', rule({ ruleId: 'pr-0000000000000002', detection: { presentAny: ['other'], absentAny: ['present-marker'], absentStatus: null } })]
  ]);
  const transport = fakeTransport([response()]);
  const ctx = context({ transport, rules });
  const outcome = await executeDiscoveryRequest(request({ ruleIds: [...rules.keys()] }), ctx);
  assert.equal(transport.calls, 1, 'one shared response, one request');
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.reused, false);
  assert.equal(outcome.ruleOutcomes.length, 2);
  assert.equal(outcome.ruleOutcomes.find((item) => item.ruleId === 'pr-0000000000000001')?.outcome, 'candidate');
  assert.equal(outcome.ruleOutcomes.find((item) => item.ruleId === 'pr-0000000000000002')?.outcome, 'checked_no_match');
  assert.equal(ctx.receipts.entries.length, 1, 'exactly one request receipt');
  assert.equal(ctx.receipts.entries[0]!.requestSent, true);
  assert.equal(ctx.receipts.entries[0]!.cost.amount, null, 'unknown cost stays null');
  assert.doesNotMatch(ctx.receipts.entries[0]!.cost.basis, /free|免费/i, 'null cost never claims free');
});

test('cache hits reuse only reliable outcomes with the original observedAt and zero new request/fee receipts', async () => {
  const clock = fakeClock(1_000_000);
  const transport = fakeTransport([response()]);
  const ctx = context({ transport, clock, rules: new Map([['pr-0000000000000001', rule()]]) });
  const first = await executeDiscoveryRequest(request(), ctx);
  assert.equal(first.observedAt, new Date(1_000_000).toISOString());
  clock.advance(60_000);
  const second = await executeDiscoveryRequest(request(), ctx);
  assert.equal(transport.calls, 1, 'cache hit issues zero new requests');
  assert.equal(second.reused, true);
  assert.equal(second.observedAt, first.observedAt, 'the original observation time is preserved');
  assert.equal(second.ruleOutcomes[0]?.outcome, 'candidate');
  assert.equal(ctx.receipts.entries.length, 1, 'cache hits add zero fee receipts');
  assert.deepEqual(ctx.stages.slice(-1), ['cache_hit'], 'scope refresh also happens on cache hits');
});

test('cache keys isolate owner, case, inputVersion, registry and policy', async () => {
  const key = discoveryCacheKey({ owner: 'a', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' }, 'rk');
  for (const other of [
    { owner: 'b', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    { owner: 'a', caseId: 'x', inputVersion: 'i', registryHash: 'r', policyHash: 'p' },
    { owner: 'a', caseId: 'c', inputVersion: 'j', registryHash: 'r', policyHash: 'p' },
    { owner: 'a', caseId: 'c', inputVersion: 'i', registryHash: 's', policyHash: 'p' },
    { owner: 'a', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'q' }
  ]) {
    assert.notEqual(discoveryCacheKey(other, 'rk'), key);
  }
  assert.notEqual(discoveryCacheKey({ owner: 'a', caseId: 'c', inputVersion: 'i', registryHash: 'r', policyHash: 'p' }, 'other'), key);
});

test('timeouts and unknown outcomes are never cached and never auto-retried', async () => {
  const timeoutError = Object.assign(new Error('deadline'), { code: 'deadline_exceeded' });
  const transport = fakeTransport([timeoutError, response()]);
  const ctx = context({ transport, rules: new Map([['pr-0000000000000001', rule()]]) });
  const first = await executeDiscoveryRequest(request(), ctx);
  assert.equal(transport.calls, 1, 'no automatic retry');
  assert.equal(first.status, 'unknown');
  assert.equal(first.ruleOutcomes[0]?.outcome, 'unknown');
  const second = await executeDiscoveryRequest(request(), ctx);
  assert.equal(transport.calls, 2, 'unknown outcomes are not persisted as negative cache');
  assert.equal(second.status, 'completed');
});

test('429 records Retry-After on the rate limiter and stays inaccessible', async () => {
  const clock = fakeClock(1_000_000);
  const rateLimiter = createInMemoryRateLimiter({ clock });
  const transport = fakeTransport([response({ status: 429, retryAfter: '2', bodyText: 'slow down' })]);
  const ctx = context({ transport, clock, rateLimiter, rules: new Map([['pr-0000000000000001', rule()]]) });
  const outcome = await executeDiscoveryRequest(request(), ctx);
  assert.equal(outcome.ruleOutcomes[0]?.outcome, 'inaccessible');
  assert.equal(outcome.ruleOutcomes[0]?.reasonCode, 'rate_limited');
  // The next request on that origin waits for the retry-after window.
  const transport2 = fakeTransport([response()]);
  const ctx2 = context({ transport: transport2, clock, rateLimiter, rules: ctx.rules });
  let settled = false;
  const pending = executeDiscoveryRequest(request(), ctx2).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the follow-up request waits for Retry-After');
  clock.advance(2001);
  await pending;
  assert.equal(transport2.calls, 1);
});

test('requests to one origin are serial by default and the global cap applies', async () => {
  const clock = fakeClock();
  const rateLimiter = createInMemoryRateLimiter({ clock, globalMaxConcurrent: 1 });
  let inFlight = 0;
  let maxInFlight = 0;
  const slowTransport: DiscoveryTransport = {
    async request() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return response();
    }
  };
  const ctx = context({ transport: slowTransport, clock, rateLimiter, rules: new Map([['pr-0000000000000001', rule()]]) });
  await Promise.all([
    executeDiscoveryRequest(request({ requestKey: 'rk-a' }), ctx),
    executeDiscoveryRequest(request({ requestKey: 'rk-b' }), ctx),
    executeDiscoveryRequest(request({ requestKey: 'rk-c' }), ctx)
  ]);
  assert.equal(maxInFlight, 1, 'one origin (and a global cap of 1) never runs concurrent requests');
});

test('cancellation aborts the attempt and is receipted as cancelled', async () => {
  const controller = new AbortController();
  const transport: DiscoveryTransport = {
    async request() {
      controller.abort();
      throw Object.assign(new Error('aborted'), { code: 'cancelled' });
    }
  };
  const ctx = context({ transport, signal: controller.signal, rules: new Map([['pr-0000000000000001', rule()]]) });
  const outcome = await executeDiscoveryRequest(request(), ctx);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(ctx.receipts.entries.length, 1);
  assert.equal(ctx.receipts.entries[0]!.outcome, 'cancelled');
});

test('authority refusal at dispatch sends zero requests and records zero receipts', async () => {
  const transport = fakeTransport([response()]);
  const ctx = context({
    transport,
    authority: {
      refresh: (stage: string) => {
        ctx.stages.push(stage);
        return stage !== 'dispatch';
      }
    },
    rules: new Map([['pr-0000000000000001', rule()]])
  });
  const outcome = await executeDiscoveryRequest(request(), ctx);
  assert.equal(transport.calls, 0);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detailCode, 'scope_refresh_refused');
  assert.equal(ctx.receipts.entries.length, 0, 'refused authority means zero requests and zero receipts');
});

test('authority refusal at commit keeps the sent usage receipt but never caches or hands out the response', async () => {
  const transport = fakeTransport([response(), response()]);
  let commitAllowed = true;
  const ctx = context({
    transport,
    authority: {
      refresh: (stage: string) => {
        ctx.stages.push(stage);
        return !(stage === 'commit' && !commitAllowed);
      }
    },
    rules: new Map([['pr-0000000000000001', rule()]])
  });
  commitAllowed = false;
  const first = await executeDiscoveryRequest(request(), ctx);
  // A commit-time scope refusal is an explicit refusal — never completed/ok —
  // and the observed response is not reused. The real sent usage receipt stays.
  assert.equal(first.status, 'failed');
  assert.equal(first.detailCode, 'scope_refresh_refused');
  assert.equal(first.response, null);
  assert.deepEqual(ctx.stages.slice(0, 3), ['dispatch', 'send', 'commit'], 'scope refresh happens before dispatch, each send and commit');
  assert.equal(ctx.receipts.entries.length, 1, 'the sent usage receipt is preserved');
  assert.equal(ctx.receipts.entries[0]!.requestSent, true);
  commitAllowed = true;
  await executeDiscoveryRequest(request(), ctx);
  assert.equal(transport.calls, 2, 'an uncommitted response is not reused');
});

test('byte caps and transport failures are receipted honestly with unknown/failed outcomes', async () => {
  const byteError = Object.assign(new Error('too large'), { code: 'byte_cap' });
  const ctx = context({
    transport: fakeTransport([byteError, Object.assign(new Error('boom'), { code: 'transport_error' })]),
    rules: new Map([['pr-0000000000000001', rule()]])
  });
  const first = await executeDiscoveryRequest(request(), ctx);
  assert.equal(first.status, 'unknown');
  assert.equal(first.detailCode, 'byte_cap');
  const second = await executeDiscoveryRequest(request({ requestKey: 'rk-2' }), ctx);
  assert.equal(second.status, 'failed');
  assert.equal(ctx.receipts.entries.length, 2);
  assert.deepEqual(
    ctx.receipts.entries.map((receipt) => receipt.outcome),
    ['unknown', 'sent_failed'],
    'sent-but-unusable results are receipted as unknown, transport failures as sent_failed'
  );
  for (const receipt of ctx.receipts.entries) {
    assert.equal(receipt.requestSent, true);
    assert.equal(receipt.cost.amount, null);
  }
});

test('unsupported targets are refused before any request is sent', async () => {
  const transport = fakeTransport([response()]);
  const ctx = context({
    transport,
    dns: { resolveAll: async () => [{ address: '127.0.0.1', family: 4 }] },
    rules: new Map([['pr-0000000000000001', rule()]])
  });
  const outcome = await executeDiscoveryRequest(request({ url: 'https://loopback.example.test/u' }), ctx);
  assert.equal(transport.calls, 0, 'a refused target never reaches the transport');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detailCode, 'target_refused');
});
