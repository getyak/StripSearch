import assert from 'node:assert/strict';
import test from 'node:test';
import { extractOriginalLinkContexts, nativeProfileLinkContext } from '../server/research/link-context.js';
import { createResearchTools } from '../server/research/toolkit.js';

test('HTML anchors retain exact source span, label, relative href and ownership paragraph', () => {
  const source = '<p>I create educational videos on <a href="https://www.youtube.com/@fixture-author">my channel</a>.</p><p>A colleague: <a href="https://github.com/other-author">Morgan</a>.</p><footer><a href="/about">About</a></footer>';
  const links = extractOriginalLinkContexts(source, 'https://fixture-author.dev/');
  const channel = links.find(link => link.url.includes('@fixture-author'))!;
  assert.equal(channel.binding, 'html_anchor');
  assert.equal(channel.surface, 'authorial');
  assert.ok(source.includes(channel.quote));
  assert.match(channel.quote, /my channel/);
  assert.doesNotMatch(channel.quote, /Morgan/);
  assert.ok(links.some(link => link.url === 'https://fixture-author.dev/about'));
});

test('a quoted activity author never becomes the profile owner through first-person wording', () => {
  const source = '<section class="activity-feed"><article><p>Morgan: I defended my thesis; find my work <a href="https://github.com/morgan">here</a>.</p></article></section><p>My own links: <a href="https://github.com/fixture-author">GitHub</a>.</p>';
  const links = extractOriginalLinkContexts(source, 'https://www.linkedin.com/in/fixture-author/');
  assert.equal(links.find(link => link.url.endsWith('/morgan'))?.surface, 'third_party');
  assert.equal(links.find(link => link.url.endsWith('/fixture-author'))?.surface, 'authorial');
});

test('large wrappers and naked labels retain links without authorial attribution', () => {
  const source = `<div>${'x'.repeat(8100)}<a href="https://github.com/fixture-author">GitHub</a></div>`;
  const [link] = extractOriginalLinkContexts(source, 'https://fixture-author.dev/');
  assert.equal(link!.surface, 'unknown');
  assert.ok(source.includes(link!.quote));
  assert.doesNotMatch(link!.quote, /x{10}/);
});

test('Markdown quote and recommendation context remains distinct from own links', () => {
  const source = 'My account: [GitHub](https://github.com/fixture-author).\n\n> I am Morgan. [My GitHub](https://github.com/morgan).';
  const links = extractOriginalLinkContexts(source, 'https://fixture-author.dev/');
  assert.equal(links.find(link => link.url.endsWith('/fixture-author'))?.surface, 'authorial');
  assert.equal(links.find(link => link.url.endsWith('/morgan'))?.surface, 'third_party');
  assert.ok(links.every(link => source.includes(link.quote)));
});

test('native website context is the actual verified account field, never synthesized prose', () => {
  const source = 'Fixture Author\nOriginal bio\nhttps://fixture-author.dev/';
  assert.deepEqual(nativeProfileLinkContext(source, 'https://absent-author.dev/'), null);
  const link = nativeProfileLinkContext(source, 'https://fixture-author.dev/')!;
  assert.equal(link.surface, 'profile_field');
  assert.equal(link.quote, 'https://fixture-author.dev/');
  assert.ok(source.includes(link.quote));
});

test('Exa original requests preserve HTML binding and cannot turn extras labels into exact context', async () => {
  const url = 'https://fixture-author.dev/';
  const original = '<p>My work: <a href="https://github.com/fixture-author">GitHub</a>.</p>';
  let payload: any;
  const tools = createResearchTools({ exaApiKey: 'synthetic', firecrawlApiKey: null, githubToken: null, tikhubApiKey: null, timeoutMs: 100, maxBytes: 100000,
    transport: { async fetch(_url, init) {
      payload = JSON.parse(init!.body!);
      return new Response(JSON.stringify({ results: [{ url, id: url, text: original, extras: { richLinks: [{ url: 'https://github.com/unread-other', anchor: 'My account' }] } }], statuses: [{ id: url, status: 'success' }] }));
    } } });
  const result = await tools.execute({ type: 'read', url }, new AbortController().signal);
  assert.deepEqual(payload.text, { includeHtmlTags: true });
  assert.equal(result.pages[0]!.text, original);
  assert.ok(result.pages[0]!.links.includes('https://github.com/unread-other'));
  assert.ok(result.pages[0]!.linkContexts!.some(link => link.url === 'https://github.com/fixture-author' && original.includes(link.quote)));
  assert.ok(!result.pages[0]!.linkContexts!.some(link => link.url.includes('unread-other')));
});

 test('rel-me retains surrounding colleague and denial text instead of an isolated anchor',()=>{
  for(const prefix of ["My colleague's account: ",'Not my account; impersonator: ']){
   const source=`<p>${prefix}<a rel="me" href="https://github.com/fixture-other">GitHub</a></p>`;
   const [context]=extractOriginalLinkContexts(source,'https://fixture-author.dev/');
   assert.equal(context!.binding,'html_rel_me');assert.equal(context!.quote,source);
  }
  const source=`<section>${'x'.repeat(8100)}<a rel="me" href="https://github.com/fixture-other">GitHub</a></section>`;
  assert.equal(extractOriginalLinkContexts(source,'https://fixture-author.dev/')[0]!.surface,'unknown');
 });
