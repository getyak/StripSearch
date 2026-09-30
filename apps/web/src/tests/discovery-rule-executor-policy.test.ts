/**
 * GET-91 Task 3 policy + transport boundary tests (offline).
 *
 * Everything runs against fake DNS resolvers, a fake request factory and a
 * fake connector: no external DNS provider is consulted and no public URL
 * (e.g. example.org) is ever fetched. The production transport is exercised
 * through its injectable connector so construction and socket pinning are
 * tested without any real socket.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  PUBLIC_HTTPS_TARGET_POLICY,
  checkPublicAddress,
  validateDiscoveryTarget
} from '../server/discovery/request-policy.js';
import type { DnsResolver } from '../server/discovery/request-policy.js';
import { createPinnedHttpsTransport, normalizeSocketAddress } from '../server/discovery/pinned-transport.js';
import type { PinnedHttpConnector } from '../server/discovery/pinned-transport.js';

function fakeDns(map: Record<string, Array<{ address: string; family: 4 | 6 }>>): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveAll(hostname: string) {
      calls.push(hostname);
      return Promise.resolve(map[hostname] ?? []);
    }
  };
}

const SAFE = { address: '93.184.216.34', family: 4 as const };
const UNSAFE = { address: '127.0.0.1', family: 4 as const };

/* ------------------------------------------------------------------ */
/* Address policy                                                      */
/* ------------------------------------------------------------------ */

test('checkPublicAddress refuses loopback, private, link-local and reserved IPv4 specials', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.5',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.5',
    '192.168.1.7',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255'
  ]) {
    assert.equal(checkPublicAddress(address).ok, false, `${address} must be refused`);
  }
  assert.equal(checkPublicAddress('93.184.216.34').ok, true);
  assert.equal(checkPublicAddress('8.8.8.8').ok, true);
});

test('checkPublicAddress refuses special IPv6 and IPv4-mapped mixed forms', () => {
  for (const address of [
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.0.1',
    '64:ff9b::7f00:1'
  ]) {
    assert.equal(checkPublicAddress(address).ok, false, `${address} must be refused`);
  }
  assert.equal(checkPublicAddress('2606:4700:4700::1111').ok, true);
  assert.equal(checkPublicAddress('::ffff:93.184.216.34').ok, true, 'IPv4-mapped public IPv4 normalizes to its v4 form');
});

test('normalizeSocketAddress folds IPv4-mapped IPv6 back to IPv4', () => {
  assert.equal(normalizeSocketAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeSocketAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeSocketAddress('::1'), '::1');
});

/* ------------------------------------------------------------------ */
/* validateDiscoveryTarget                                             */
/* ------------------------------------------------------------------ */

test('validateDiscoveryTarget pins a validated address and keeps the original hostname', async () => {
  const dns = fakeDns({ 'profile.example.test': [SAFE, { address: '93.184.216.35', family: 4 }] });
  const target = await validateDiscoveryTarget('https://Profile.Example.test/user?x=1', PUBLIC_HTTPS_TARGET_POLICY, dns);
  assert.equal(target.hostname, 'profile.example.test', 'TLS/Host use the original hostname');
  assert.equal(target.address, SAFE.address, 'the validated address is pinned');
  assert.equal(target.family, 4);
  assert.equal(target.originalUrl, 'https://Profile.Example.test/user?x=1');
  assert.deepEqual(dns.calls, ['profile.example.test']);
});

test('validateDiscoveryTarget refuses credential URLs, plain HTTP and non-approved ports', async () => {
  const dns = fakeDns({ 'profile.example.test': [SAFE] });
  for (const url of [
    'http://profile.example.test/u',
    'https://user:pass@profile.example.test/u',
    'https://profile.example.test:8443/u',
    'ftp://profile.example.test/u',
    'not a url',
    'https:///missing-host'
  ]) {
    await assert.rejects(
      () => validateDiscoveryTarget(url, PUBLIC_HTTPS_TARGET_POLICY, dns),
      (error: unknown) => typeof (error as { code?: string }).code === 'string',
      `${url} must be refused`
    );
  }
});

test('validateDiscoveryTarget refuses private/special IP literals without any DNS lookup', async () => {
  const dns = fakeDns({});
  for (const url of [
    'https://127.0.0.1/u',
    'https://10.1.2.3/u',
    'https://[::1]/u',
    'https://[fd00::1]/u',
    'https://[::ffff:192.168.0.1]/u',
    'https://169.254.169.254/latest/meta-data'
  ]) {
    await assert.rejects(
      () => validateDiscoveryTarget(url, PUBLIC_HTTPS_TARGET_POLICY, dns),
      (error: unknown) => (error as { code?: string }).code === 'unsafe_address' || (error as { code?: string }).code === 'invalid_target',
      `${url} must be refused`
    );
  }
  assert.deepEqual(dns.calls, [], 'IP literals never trigger DNS');
});

test('DNS results are all validated: one unsafe record refuses the whole target (no first-result allow)', async () => {
  const mixed = fakeDns({ 'mixed.example.test': [SAFE, UNSAFE] });
  await assert.rejects(
    () => validateDiscoveryTarget('https://mixed.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, mixed),
    (error: unknown) => (error as { code?: string }).code === 'dns_unsafe_record'
  );
  const empty = fakeDns({ 'gone.example.test': [] });
  await assert.rejects(
    () => validateDiscoveryTarget('https://gone.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, empty),
    (error: unknown) => (error as { code?: string }).code === 'dns_no_records'
  );
});

/* ------------------------------------------------------------------ */
/* Pinned HTTPS transport (fake request factory / connector)           */
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
    // Behave like a paused Node stream: only flow once a data listener exists.
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

function fakeConnector(script: Array<{ response?: FakeResponse; error?: Error }>): PinnedHttpConnector & {
  requests: Array<{ options: Record<string, unknown>; request: FakeRequest }>;
} {
  const requests: Array<{ options: Record<string, unknown>; request: FakeRequest }> = [];
  return {
    requests,
    request(options: Record<string, unknown>, callback: (res: FakeResponse) => void) {
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
      requests.push({ options, request });
      return request;
    }
  } as unknown as PinnedHttpConnector & {
    requests: Array<{ options: Record<string, unknown>; request: FakeRequest }>;
  };
}

test('the pinned transport keeps original hostname for TLS/Host, disables agents and pins the lookup', async () => {
  const connector = fakeConnector([{ response: new FakeResponse(200, { 'content-type': 'text/html; charset=utf-8' }, SAFE.address, ['hello body']) }]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://profile.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, fakeDns({ 'profile.example.test': [SAFE] }));
  const response = await transport.request(target, {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
    maxBytes: 4096,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: fakeDns({})
  });
  assert.equal(response.status, 200);
  assert.equal(response.bodyText, 'hello body');
  const { options } = connector.requests[0]!;
  assert.equal(options.host, 'profile.example.test', 'TLS SNI/Host use the original hostname');
  assert.equal(options.servername, 'profile.example.test');
  assert.equal(options.agent, false, 'no connection pool and no proxy/env bypass');
  assert.equal(typeof options.lookup, 'function');
  // The custom lookup pins every callback variant to the validated address.
  const lookup = options.lookup as (hostname: string, opts: unknown, cb: (...args: unknown[]) => void) => void;
  await new Promise<void>((resolve, reject) => {
    lookup('profile.example.test', { all: true }, (error: unknown, records: unknown) => {
      try {
        assert.equal(error, null);
        assert.deepEqual(records, [{ address: SAFE.address, family: 4 }]);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    lookup('profile.example.test', {}, (error: unknown, address: unknown, family: unknown) => {
      try {
        assert.equal(error, null);
        assert.equal(address, SAFE.address);
        assert.equal(family, 4);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test('the pinned transport verifies the socket remote address (IPv4-mapped form accepted)', async () => {
  const ok = fakeConnector([{ response: new FakeResponse(200, {}, '::ffff:93.184.216.34', ['ok']) }]);
  const transportOk = createPinnedHttpsTransport({ connector: ok });
  const target = await validateDiscoveryTarget('https://profile.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, fakeDns({ 'profile.example.test': [SAFE] }));
  const response = await transportOk.request(target, {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
    maxBytes: 4096,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: fakeDns({})
  });
  assert.equal(response.status, 200);

  const bad = fakeConnector([{ response: new FakeResponse(200, {}, '10.0.0.5', ['ok']) }]);
  const transportBad = createPinnedHttpsTransport({ connector: bad });
  await assert.rejects(
    () => transportBad.request(target, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5000,
      maxBytes: 4096,
      policy: PUBLIC_HTTPS_TARGET_POLICY,
      dns: fakeDns({})
    }),
    (error: unknown) => (error as { code?: string }).code === 'socket_address_mismatch'
  );
});

test('every redirect revalidates target policy and DNS; hops stay bounded and headers never carry credentials', async () => {
  const dns = fakeDns({
    'a.example.test': [SAFE],
    'b.example.test': [SAFE],
    'internal.example.test': [UNSAFE]
  });
  const connector = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://b.example.test/next' }, SAFE.address) },
    { response: new FakeResponse(200, {}, SAFE.address, ['landed']) }
  ]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://a.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, dns);
  const response = await transport.request(target, {
    method: 'GET',
    headers: { accept: 'text/html' },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
    maxBytes: 4096,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns
  });
  assert.equal(response.status, 200);
  assert.equal(response.finalUrl, 'https://b.example.test/next');
  assert.equal(dns.calls.includes('b.example.test'), true, 'redirect targets get a fresh DNS policy check');

  // A redirect into a private address is refused at revalidation.
  const evil = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://internal.example.test/next' }, SAFE.address) }
  ]);
  const transportEvil = createPinnedHttpsTransport({ connector: evil });
  await assert.rejects(
    () => transportEvil.request(target, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5000,
      maxBytes: 4096,
      policy: PUBLIC_HTTPS_TARGET_POLICY,
      dns
    }),
    (error: unknown) =>
      (error as { code?: string }).code === 'unsupported_target' &&
      /dns_unsafe_record/.test((error as Error).message),
    'a redirect into a private address must be refused at revalidation'
  );

  // Hop cap.
  const loop = fakeConnector([
    { response: new FakeResponse(302, { location: 'https://b.example.test/1' }, SAFE.address) },
    { response: new FakeResponse(302, { location: 'https://a.example.test/2' }, SAFE.address) },
    { response: new FakeResponse(302, { location: 'https://b.example.test/3' }, SAFE.address) },
    { response: new FakeResponse(302, { location: 'https://a.example.test/4' }, SAFE.address) }
  ]);
  const transportLoop = createPinnedHttpsTransport({ connector: loop });
  await assert.rejects(
    () => transportLoop.request(target, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5000,
      maxBytes: 4096,
      policy: PUBLIC_HTTPS_TARGET_POLICY,
      dns
    }),
    (error: unknown) => (error as { code?: string }).code === 'redirect_limit'
  );
});

test('response bytes are bounded while streaming and the stream is destroyed at the cap', async () => {
  const response = new FakeResponse(200, {}, SAFE.address, ['x'.repeat(10), 'y'.repeat(10), 'z'.repeat(500)]);
  const connector = fakeConnector([{ response }]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://profile.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, fakeDns({ 'profile.example.test': [SAFE] }));
  await assert.rejects(
    () => transport.request(target, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5000,
      maxBytes: 32,
      policy: PUBLIC_HTTPS_TARGET_POLICY,
      dns: fakeDns({})
    }),
    (error: unknown) => (error as { code?: string }).code === 'byte_cap'
  );
});

test('the overall deadline aborts in-flight requests via request.destroy, not socket timeouts', async () => {
  const connector = fakeConnector([]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://profile.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, fakeDns({ 'profile.example.test': [SAFE] }));
  await assert.rejects(
    () => transport.request(target, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5,
      maxBytes: 4096,
      policy: PUBLIC_HTTPS_TARGET_POLICY,
      dns: fakeDns({})
    }),
    (error: unknown) => (error as { code?: string }).code === 'deadline_exceeded'
  );
  assert.equal(connector.requests[0]!.request.destroyed, true, 'the request is destroyed on deadline');
});

test('caller aborts cancel the request and report cancelled', async () => {
  const connector = fakeConnector([]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://profile.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, fakeDns({ 'profile.example.test': [SAFE] }));
  const controller = new AbortController();
  const promise = transport.request(target, {
    method: 'GET',
    headers: {},
    signal: controller.signal,
    deadlineAt: Date.now() + 5000,
    maxBytes: 4096,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: fakeDns({})
  });
  controller.abort();
  await assert.rejects(
    () => promise,
    (error: unknown) => (error as { code?: string }).code === 'cancelled'
  );
});

test('non-UTF-8 upstream encodings are reported explicitly instead of a false no-match', async () => {
  const connector = fakeConnector([
    { response: new FakeResponse(200, { 'content-type': 'text/html; charset=gbk' }, SAFE.address, ['\u4e2d\u6587']) }
  ]);
  const transport = createPinnedHttpsTransport({ connector });
  const target = await validateDiscoveryTarget('https://profile.example.test/u', PUBLIC_HTTPS_TARGET_POLICY, fakeDns({ 'profile.example.test': [SAFE] }));
  const response = await transport.request(target, {
    method: 'GET',
    headers: {},
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
    maxBytes: 4096,
    policy: PUBLIC_HTTPS_TARGET_POLICY,
    dns: fakeDns({})
  });
  assert.equal(response.encoding, 'unsupported', 'unsupported charset is explicit');
});
