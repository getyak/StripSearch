/**
 * Probe engine and post tracker tests, driven by a synthetic in-memory
 * transport. No network, no real platform, no paid call: every URL here uses
 * reserved test TLDs and is answered by the fake.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchPostsPage, probePlatform, resolveRuleUrl } from '../server/adapters/discovery.js';
import type { ProbeContext } from '../server/adapters/discovery.js';
import type {
  HttpRequestInit,
  HttpResponseLike,
  HttpTransport
} from '../server/adapters/types.js';
import type { PlatformRule } from '../shared/platform-discovery.js';

interface FakeRoute {
  status?: number;
  body?: string;
  delayMs?: number;
  rejectWith?: Error;
}

export class FakeTransport implements HttpTransport {
  readonly calls: string[] = [];

  constructor(private readonly routes: Record<string, FakeRoute>) {}

  async fetch(url: string, init?: HttpRequestInit): Promise<HttpResponseLike> {
    this.calls.push(url);
    const route = this.routes[url];
    if (!route) {
      return {
        status: 404,
        ok: false,
        headers: { get: () => null },
        text: async () => 'not found'
      };
    }
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    }
    if (route.rejectWith) throw route.rejectWith;
    const status = route.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => route.body ?? ''
    };
  }
}

const STATUS_RULE: PlatformRule = {
  platformId: 'fixturecode',
  name: 'Fixture Code',
  category: 'code',
  subjectKinds: ['username'],
  homepage: 'https://fixturecode.example.test',
  probe: {
    kind: 'http_status',
    transport: 'api_http',
    method: 'GET',
    urlTemplate: 'https://fixturecode.example.test/users/{username}',
    foundStatuses: [200],
    notFoundStatuses: [404],
    blockedStatuses: [429],
    foundMarker: null,
    notFoundMarker: null
  },
  posts: {
    kind: 'json_list',
    urlTemplate: 'https://fixturecode.example.test/users/{username}/posts?page={page}',
    maxPages: 2,
    itemsPath: 'data.items',
    fields: {
      id: 'id',
      url: 'link',
      title: 'meta.title',
      publishedAt: 'created',
      excerpt: 'summary'
    }
  },
  rateLimitPerMinute: 60,
  verification: 'live_unverified',
  verificationNote: 'fixture',
  notes: []
};

const MARKER_RULE: PlatformRule = {
  ...STATUS_RULE,
  platformId: 'fixtureblog',
  name: 'Fixture Blog',
  probe: {
    kind: 'http_marker',
    transport: 'profile_http',
    method: 'GET',
    urlTemplate: 'https://fixtureblog.example.test/@{username}',
    foundStatuses: [200],
    notFoundStatuses: [404],
    blockedStatuses: [403],
    foundMarker: 'profile-marker',
    notFoundMarker: 'no-such-user'
  },
  posts: {
    kind: 'rss',
    urlTemplate: 'https://fixtureblog.example.test/feed/@{username}',
    maxPages: 1,
    itemsPath: '',
    fields: { id: 'guid', url: 'link', title: 'title', publishedAt: 'pubDate', excerpt: 'description' }
  }
};

function context(transport: HttpTransport, timeoutMs = 1000): ProbeContext {
  return { transport, signal: new AbortController().signal, timeoutMs };
}

test('resolveRuleUrl encodes the subject and refuses non-https rules', () => {
  assert.equal(
    resolveRuleUrl('https://fixturecode.example.test/users/{username}', 'a b/c'),
    'https://fixturecode.example.test/users/a%20b%2Fc'
  );
  assert.throws(() => resolveRuleUrl('http://insecure.example.test/{username}', 'x'));
  assert.equal(
    resolveRuleUrl('https://fixturecode.example.test/p/{page}', 'x', 3),
    'https://fixturecode.example.test/p/3'
  );
});

test('http_status probe maps platform answers honestly', async () => {
  const transport = new FakeTransport({
    'https://fixturecode.example.test/users/alice': { status: 200, body: '{"login":"alice"}' },
    'https://fixturecode.example.test/users/nobody': { status: 404, body: '' },
    'https://fixturecode.example.test/users/throttled': { status: 429, body: '' },
    'https://fixturecode.example.test/users/broken': { status: 500, body: '' },
    'https://fixturecode.example.test/users/redirected': { status: 302, body: '' },
    'https://fixturecode.example.test/users/huge': {
      status: 200,
      body: 'x'.repeat(300 * 1024)
    }
  });

  const found = await probePlatform(STATUS_RULE, { kind: 'username', value: 'alice' }, context(transport));
  assert.equal(found.result.status, 'found');
  assert.equal(found.result.handle, 'alice');
  assert.equal(found.result.profileUrl, 'https://fixturecode.example.test/users/alice');
  assert.equal(found.result.verification, 'live_unverified');
  assert.ok(found.result.limitations.includes('rule_live_unverified'));

  const missing = await probePlatform(STATUS_RULE, { kind: 'username', value: 'nobody' }, context(transport));
  assert.equal(missing.result.status, 'not_found');

  const blocked = await probePlatform(STATUS_RULE, { kind: 'username', value: 'throttled' }, context(transport));
  assert.equal(blocked.result.status, 'blocked');
  assert.ok(blocked.result.limitations.includes('platform_blocked'));

  const broken = await probePlatform(STATUS_RULE, { kind: 'username', value: 'broken' }, context(transport));
  assert.equal(broken.result.status, 'error');

  const redirected = await probePlatform(STATUS_RULE, { kind: 'username', value: 'redirected' }, context(transport));
  assert.equal(redirected.result.status, 'unknown');
  assert.ok(redirected.result.limitations.includes('redirect_not_followed'));

  const huge = await probePlatform(STATUS_RULE, { kind: 'username', value: 'huge' }, context(transport));
  assert.equal(huge.result.status, 'unknown');
  assert.ok(huge.result.limitations.includes('response_too_large'));
});

test('marker probe only reports found when the marker is present', async () => {
  const transport = new FakeTransport({
    'https://fixtureblog.example.test/@alice': {
      status: 200,
      body: '<html><title>alice</title><p>profile-marker</p></html>'
    },
    'https://fixtureblog.example.test/@ghost': {
      status: 200,
      body: '<html><p>no-such-user</p></html>'
    },
    'https://fixtureblog.example.test/@odd': {
      status: 200,
      body: '<html><p>something else</p></html>'
    }
  });

  const found = await probePlatform(MARKER_RULE, { kind: 'username', value: 'alice' }, context(transport));
  assert.equal(found.result.status, 'found');
  assert.ok(found.result.evidence?.excerpt?.includes('profile-marker'));

  const ghost = await probePlatform(MARKER_RULE, { kind: 'username', value: 'ghost' }, context(transport));
  assert.equal(ghost.result.status, 'not_found');

  const odd = await probePlatform(MARKER_RULE, { kind: 'username', value: 'odd' }, context(transport));
  assert.equal(odd.result.status, 'unknown');
  assert.ok(odd.result.limitations.includes('marker_mismatch'));
});

test('timeout is an error with unknown billing outcome', async () => {
  const transport = new FakeTransport({
    'https://fixturecode.example.test/users/slow': { status: 200, body: '{}', delayMs: 400 }
  });
  const run = await probePlatform(
    STATUS_RULE,
    { kind: 'username', value: 'slow' },
    context(transport, 30)
  );
  assert.equal(run.result.status, 'error');
  assert.ok(run.result.limitations.includes('timeout'));
  assert.ok(run.result.limitations.includes('billing_outcome_unknown'));
  assert.equal(run.outcomeUnknown, true);
});

test('json_list post tracking pages, maps fields and skips bad items', async () => {
  const transport = new FakeTransport({
    'https://fixturecode.example.test/users/alice/posts?page=1': {
      status: 200,
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'p1',
              link: 'https://fixturecode.example.test/alice/p1',
              meta: { title: '第一篇' },
              created: 1753000000,
              summary: 'a'.repeat(400)
            },
            {
              id: 'p2',
              link: 'https://fixturecode.example.test/alice/p2',
              meta: { title: '第二篇' },
              created: '2026-07-20T10:00:00Z',
              summary: '摘录'
            },
            { id: 'bad', meta: { title: '没有链接' } }
          ]
        }
      })
    },
    'https://fixturecode.example.test/users/alice/posts?page=2': {
      status: 200,
      body: JSON.stringify({
        data: {
          items: [
            {
              id: 'p3',
              link: 'https://fixturecode.example.test/alice/p3',
              meta: { title: '第三篇' },
              created: '2026-07-21T10:00:00Z',
              summary: '摘录3'
            }
          ]
        }
      })
    }
  });

  const page1 = await fetchPostsPage(
    STATUS_RULE,
    'link-1',
    'alice',
    null,
    context(transport)
  );
  assert.equal(page1.posts.length, 2);
  assert.equal(page1.posts[0]?.postKey, 'fixturecode:p1');
  assert.equal(page1.posts[0]?.title, '第一篇');
  assert.equal(page1.posts[0]?.publishedAt, new Date(1753000000 * 1000).toISOString());
  assert.equal(page1.posts[0]?.excerpt?.length, 200);
  assert.deepEqual(page1.posts[0]?.limits, ['listing_excerpt_only', 'full_text_not_fetched']);
  assert.equal(page1.nextCursor, '2');
  assert.ok(page1.warnings.some((w) => w.includes('缺少链接')));

  const page2 = await fetchPostsPage(STATUS_RULE, 'link-1', 'alice', '2', context(transport));
  assert.equal(page2.posts.length, 1);
  // page 2 is the rule's maxPages: no further cursor.
  assert.equal(page2.nextCursor, null);
});

test('post tracking degrades instead of fabricating on bad payloads', async () => {
  const badJson = new FakeTransport({
    'https://fixturecode.example.test/users/alice/posts?page=1': { status: 200, body: 'not-json' }
  });
  const unparsable = await fetchPostsPage(STATUS_RULE, 'link-1', 'alice', null, context(badJson));
  assert.equal(unparsable.posts.length, 0);
  assert.ok(unparsable.limits.includes('unparsable_body'));

  const wrongPath = new FakeTransport({
    'https://fixturecode.example.test/users/alice/posts?page=1': {
      status: 200,
      body: JSON.stringify({ unexpected: [] })
    }
  });
  const mismatch = await fetchPostsPage(STATUS_RULE, 'link-1', 'alice', null, context(wrongPath));
  assert.ok(mismatch.limits.includes('items_path_mismatch'));

  const failing = new FakeTransport({
    'https://fixturecode.example.test/users/alice/posts?page=1': { status: 500, body: '' }
  });
  const failed = await fetchPostsPage(STATUS_RULE, 'link-1', 'alice', null, context(failing));
  assert.ok(failed.limits.includes('posts_fetch_failed'));
});

test('rss post tracking keeps locator and strips markup', async () => {
  const feed = [
    '<?xml version="1.0"?><rss><channel>',
    '<item><guid>post-1</guid><link>https://fixtureblog.example.test/@alice/p1</link>',
    '<title><![CDATA[标题一]]></title><pubDate>Wed, 22 Jul 2026 10:00:00 GMT</pubDate>',
    '<description><![CDATA[<p>带 <b>标记</b> 的摘录</p>]]></description></item>',
    '<item><guid>post-2</guid><link>https://fixtureblog.example.test/@alice/p2</link>',
    '<title>标题二</title><pubDate>Thu, 23 Jul 2026 10:00:00 GMT</pubDate>',
    '<description>第二段摘录</description></item>',
    '</channel></rss>'
  ].join('');
  const transport = new FakeTransport({
    'https://fixtureblog.example.test/feed/@alice': { status: 200, body: feed }
  });
  const page = await fetchPostsPage(MARKER_RULE, 'link-2', 'alice', null, context(transport));
  assert.equal(page.posts.length, 2);
  assert.equal(page.posts[0]?.postKey, 'fixtureblog:post-1');
  assert.equal(page.posts[0]?.excerpt, '带 标记 的摘录');
  assert.equal(page.posts[0]?.excerptLocator, 'post-listing-item');
  assert.equal(page.posts[0]?.publishedAt, '2026-07-22T10:00:00.000Z');
  assert.equal(page.nextCursor, null);
});

test('rules without post support say so instead of inventing posts', async () => {
  const noPosts: PlatformRule = {
    ...STATUS_RULE,
    platformId: 'fixturestatic',
    posts: {
      kind: 'none',
      urlTemplate: '',
      maxPages: 0,
      itemsPath: '',
      fields: { id: null, url: null, title: null, publishedAt: null, excerpt: null }
    }
  };
  const transport = new FakeTransport({});
  const page = await fetchPostsPage(noPosts, 'link-3', 'alice', null, context(transport));
  assert.equal(page.posts.length, 0);
  assert.ok(page.limits.includes('posts_unsupported'));
  assert.equal(transport.calls.length, 0);
});
