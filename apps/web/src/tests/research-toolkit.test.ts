import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchTools } from '../server/research/toolkit.js';
import type { ResearchToolAction, ResearchToolsOptions } from '../server/research/tool-contracts.js';
import type { HttpRequestInit } from '../server/adapters/types.js';

function harness(body: unknown, status = 200, overrides: Partial<ResearchToolsOptions> = {}) {
  const calls: { url: string; init?: HttpRequestInit }[] = [];
  const tools = createResearchTools({ exaApiKey: 'synthetic', tikhubApiKey: 'synthetic', firecrawlApiKey: 'synthetic', githubToken: null, timeoutMs: 100, maxBytes: 100_000,
    transport: { async fetch(url, init) { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); } }, ...overrides });
  return { calls, tools, execute: (action: ResearchToolAction) => tools.execute(action, new AbortController().signal) };
}
const profile = { status: 'active', profile: 'fixture_author', rest_id: '9007199254740993123', id: '9007199254740993123', name: 'Synthetic Author', desc: 'Original synthetic biography.', website: 'https://synthetic-author.dev/', protected: false };
const profileAction = { type: 'social_profile' as const, url: 'https://x.com/fixture_author' };

test('TikHub profile checks the account and preserves stable IDs in one request', async () => {
  const h = harness({ code: 200, data: profile });
  const result = await h.execute(profileAction);
  assert.equal(result.pages[0]?.account?.id, profile.rest_id);
  assert.equal(result.requests, 1); assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]!.url, /^https:\/\/api.tikhub.io\/api\/v1\/twitter\/web\/fetch_user_profile\?screen_name=fixture_author$/);
  assert.equal(h.calls[0]?.init?.redirect, 'error');
});

test('posts retain only target-authored outer text, never retweets or nested quotes', async () => {
  const own = { tweet_id: '10000000000000000001', text: 'Synthetic own statement', author: { rest_id: profile.rest_id, screen_name: null } };
  const h = harness({ code: 200, data: { status: 'ok', user: profile, next_cursor: 'opaque-next', timeline: [own, { ...own, tweet_id: '10000000000000000002', text: 'Synthetic commentary', quoted: { text: 'NEVER attribute quote' } }, { ...own, retweeted_tweet: { text: 'NEVER attribute retweet' } }, { ...own, retweeted: { id: '999' } }, { ...own, retweet: { id: '999' } }, { ...own, author: { rest_id: 'different' } }] } });
  const r = await h.execute({ type: 'social_posts', url: profileAction.url });
  assert.equal(r.pages.length, 2); assert.equal(r.nextCursor, 'opaque-next');
  assert.doesNotMatch(JSON.stringify(r.pages), /NEVER/);
  assert.match(r.pages[1]!.limitations.join(' '), /引用/);
  assert.equal(h.calls.length, 1);
});

test('unknown posts, protected accounts, wrong handles, unsafe IDs and business errors fail once', async () => {
  for (const body of [{ code: 200, data: { status: 'ok', user: profile, tweets: [] } }, { code: 200, data: { ...profile, protected: true } }, { code: 200, data: { ...profile, profile: 'wrong' } }, { code: 200, data: { ...profile, rest_id: 9007199254740992, id: 9007199254740992 } }, { code: 403, data: profile }]) {
    const h = harness(body);
    await assert.rejects(h.execute('user' in body.data ? { type: 'social_posts', url: profileAction.url } : profileAction));
    assert.equal(h.calls.length, 1);
  }
});

test('403 and 429 are typed failures without retries or raw provider text', async () => {
  for (const status of [403, 429]) {
    const h = harness({ message: 'SECRET-UPSTREAM-TEXT' }, status);
    await assert.rejects(h.execute(profileAction), (e: any) => e.status === status && !e.message.includes('SECRET-UPSTREAM-TEXT'));
    assert.equal(h.calls.length, 1);
  }
});

test('private and literal IP URLs, and Firecrawl X hosts, are refused before fetch', async () => {
  const urls = ['https://localhost/a', 'https://127.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fd00::1]/', 'https://10.0.0.1/', 'https://metadata.google.internal/', 'https://private.local./', 'https://x.com/a', 'https://mobile.twitter.com/a', 'https://sub.x.com/a', 'https://sub.twitter.com/a'];
  for (const url of urls) { const h = harness({}); await assert.rejects(h.execute({ type: 'firecrawl', url })); assert.equal(h.calls.length, 0, url); }
});

test('Exa contents requires matching successful status and exact returned URL', async () => {
  const url = 'https://synthetic-author.dev/about';
  const body = { results: [{ id: url, url, title: 'Synthetic', text: 'Original synthetic text.' }], statuses: [{ id: url, status: 'success' }], costDollars: { total: .001 } };
  const h = harness(body); const r = await h.execute({ type: 'read', url });
  assert.equal(r.estimatedUsd, .001); assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0]!.init!.body!).urls, [url]);
  for (const bad of [{ ...body, statuses: [] }, { ...body, statuses: [{ id: url, status: 'error' }] }, { ...body, results: [{ ...body.results[0], url: 'https://other-synthetic.dev/' }] }]) {
    const b = harness(bad); await assert.rejects(b.execute({ type: 'read', url })); assert.equal(b.calls.length, 1);
  }
});

test('search bounds results and text in exactly one Exa call', async () => {
  const h = harness({ results: [{ url: 'https://github.com/synthetic-author', title: 'Synthetic Author', text: 'x'.repeat(7000), author: 'Synthetic Byline' }], costDollars: { total: .005 } });
  const r = await h.execute({ type: 'search', query: 'Synthetic Author' });
  assert.equal(h.calls.length, 1); assert.equal(r.pages[0]?.kind, 'profile'); assert.ok(r.pages[0]!.text.length <= 6000);
  const body = JSON.parse(h.calls[0]!.init!.body!); assert.equal(body.numResults, 5); assert.equal(body.contents.text.maxCharacters, 6000);
});

test('Firecrawl disables AI/TLS bypass and validates both source and final URLs', async () => {
  const url = 'https://synthetic-author.dev/';
  const body = { success: true, data: { markdown: 'Original synthetic markdown.', metadata: { sourceURL: url, url, statusCode: 200, creditsUsed: 1 } } };
  const h = harness(body); const r = await h.execute({ type: 'firecrawl', url });
  assert.equal(r.credits, 1); assert.equal(r.estimatedUsd, null);
  const sent = JSON.parse(h.calls[0]!.init!.body!); assert.deepEqual(sent.formats, ['markdown']); assert.equal(sent.skipTlsVerification, false); assert.deepEqual(sent.parsers, []);
  for (const patch of [{ sourceURL: 'https://other-synthetic.dev/' }, { url: 'https://other-synthetic.dev/' }, { url: 'https://[::ffff:127.0.0.1]/' }, { statusCode: 403 }]) {
    const b = harness({ ...body, data: { ...body.data, metadata: { ...body.data.metadata, ...patch } } });
    await assert.rejects(b.execute({ type: 'firecrawl', url })); assert.equal(b.calls.length, 1);
  }
});

test('GitHub verifies returned account and canonical profile URL', async () => {
  const body = { login: 'synthetic-author', id: 123, html_url: 'https://github.com/synthetic-author', name: 'Synthetic Author', bio: 'Synthetic biography' };
  const h = harness(body); const result = await h.execute({ type: 'github_profile', url: body.html_url });
  assert.equal(result.pages[0]?.account?.id, '123'); assert.equal(h.calls.length, 1);
  const bad = harness({ ...body, html_url: 'https://github.com/other' }); await assert.rejects(bad.execute({ type: 'github_profile', url: body.html_url }));
});

test('oversize and abort terminate without hidden retries', async () => {
  const h = harness({ code: 200, data: profile }, 200, { maxBytes: 10 });
  await assert.rejects(h.execute(profileAction), (e: any) => e.code === 'provider_response_too_large'); assert.equal(h.calls.length, 1);
  let calls = 0;
  const aborted = new AbortController(); aborted.abort();
  const tools = createResearchTools({ ...({} as ResearchToolsOptions), transport: { async fetch() { calls++; throw new Error('should not call'); } } });
  await assert.rejects(tools.execute(profileAction, aborted.signal)); assert.equal(calls, 0);
  const pending = harness({}, 200, { transport: { fetch(_url, init) { calls++; return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } } });
  const controller = new AbortController(); const request = pending.tools.execute(profileAction, controller.signal); controller.abort();
  await assert.rejects(request); assert.equal(calls, 1);
});


test('Firecrawl excludes PDF conversion before requests and rejects non-HTML documents', async () => {
  for (const url of ['https://synthetic-author.dev/report.pdf', 'https://synthetic-author.dev/report.PDF?download=1']) {
    const h = harness({}); await assert.rejects(h.execute({ type: 'firecrawl', url })); assert.equal(h.calls.length, 0);
  }
  const url = 'https://synthetic-author.dev/document';
  const h = harness({ success: true, data: { markdown: 'Unexpected PDF', metadata: { sourceURL: url, url, statusCode: 200, contentType: 'application/pdf', creditsUsed: 5 } } });
  await assert.rejects(h.execute({ type: 'firecrawl', url })); assert.equal(h.calls.length, 1);
});

test('deadline aborts one charged attempt without fallback', async () => {
  let calls = 0;
  const h = harness({}, 200, { timeoutMs: 5, transport: { fetch(_url, init) { calls++; return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true })); } } });
  await assert.rejects(h.execute(profileAction), (error: any) => error.code === 'provider_timeout'); assert.equal(calls, 1);
});


test('posts require a successful inner status and never retry rejected status', async () => {
  for (const status of [undefined, 'error', 'unknown']) {
    const h = harness({ code: 200, data: { ...(status !== undefined ? { status } : {}), user: profile, timeline: [{ tweet_id: '12345', text: 'Synthetic statement', author: { rest_id: profile.rest_id } }] } });
    await assert.rejects(h.execute({ type: 'social_posts', url: profileAction.url }), (error: any) => error.code === 'provider_bad_response');
    assert.equal(h.calls.length, 1);
  }
});
