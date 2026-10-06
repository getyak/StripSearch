import assert from 'node:assert/strict';
import test from 'node:test';
import { extractOriginalLinkContexts, extractOriginalLiteralLinkContexts, nativeProfileLinkContext } from '../server/research/link-context.js';
import { createResearchTools } from '../server/research/toolkit.js';
import { linkRoleFromContext } from '../shared/first-step-discovery.js';

test('a same-target ownership predicate after the anchor preserves the exact original', () => {
 const home='https://fixture-author.dev/', blog='https://fixture-author.blog/';
 for(const original of [
  `<p>I have three blogs. This <a href="${blog}">GitHub blog</a> is my oldest one. I switched to another blog.</p>`,
  `<p>This <a href="${blog}">page</a> is my personal blog.</p>`,
  `This [blog](${blog}) is my oldest one.`,
 ]){
  const context=extractOriginalLinkContexts(original,home).find(c=>c.url===blog)!;
  assert.ok(original.includes(context.quote));
  assert.equal(linkRoleFromContext({...context,targetUrl:blog,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section');
  assert.notEqual(linkRoleFromContext({...context,targetUrl:blog,sourceIsOwnProfilePage:true,sourceIsDirectory:false,sourceIsRestrictedSurface:true}).role,'self_account_section');
 }
 for(const original of [
  `<p>This <a href="${blog}">book</a> is my oldest one.</p>`,
  `<p>This <a href="${blog}">blog</a>. My blog is elsewhere.</p>`,
  `<p>This <a href="${blog}">blog</a> and <a href="${home}">website</a> is my oldest one.</p>`,
  `<p>My colleague's <a href="${blog}">blog</a> is my oldest one.</p>`,
  `<p>This <a href="${blog}">blog</a> is not my oldest one.</p>`,
  `<p>I authored a book on <a href="${blog}">blog</a> is my oldest one.</p>`,
  `<p>This <a href="${blog}">blog</a> is my oldest one?</p>`,
  `<p>This <a href="${blog}">blog</a> is my blog if I purchase it.</p>`,
  `<p>This <a href="${blog}">blog</a> is my personal blog bookmark.</p>`,
  `<p>This <a href="${blog}">book about a blog</a> is my oldest one.</p>`,
  `<p>This <a href="${blog}">Blog: A Novel</a> is my oldest one.</p>`,
 ]){
  const context=extractOriginalLinkContexts(original,home).find(c=>c.url===blog)!;
  assert.notEqual(linkRoleFromContext({...context,targetUrl:blog,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section',original);
 }
});

test('attribute punctuation cannot manufacture a visible ownership declaration',()=>{
 const url='https://github.com/fixture-book';
 for(const attribute of ['title="Synthetic > My GitHub"',"title='Synthetic > My GitHub'",'aria-label="Synthetic > My GitHub"','data-caption="Synthetic > My GitHub"']){
  const original=`<p><a href="${url}" ${attribute}>Synthetic Book</a></p>`;
  const context=extractOriginalLinkContexts(original,'https://fixture-author.dev/')[0]!;
  assert.equal(context.quote,original);
  assert.notEqual(linkRoleFromContext({...context,targetUrl:url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section');
 }
});

test('HTML and Markdown self links share visible-text and quotation restrictions',()=>{
 const url='https://github.com/fixture-profile';
 for(const wrapper of ['p','q','cite','body hidden','html hidden','p aria-hidden="TRUE"','p hidden','pre','blockquote']){
  const tag=wrapper.split(' ')[0]!;
  for(const link of [`<a href="${url}">GitHub</a>`,`[GitHub](${url})`]){
   const original=`<${wrapper}>My GitHub: ${link}</${tag}>`;
   const linked=extractOriginalLinkContexts(original,'https://fixture-author.dev/');
   if(link.startsWith('[')&&['p','pre','body','html','blockquote'].includes(tag))assert.ok(linked.every(c=>c.binding!=='markdown_link'),original);
   const context=(link.startsWith('[')?extractOriginalLiteralLinkContexts(original,'https://fixture-author.dev/',url):linked).find(c=>c.url===url)!;
   assert.ok(context,original);
   assert.equal(linkRoleFromContext({...context,targetUrl:url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role==='self_account_section',wrapper==='p'&&!link.startsWith('['),original);
  }
 }
 const attribute=`<p title="My GitHub: [GitHub](${url})">Plain text</p>`;
 assert.equal(extractOriginalLinkContexts(attribute,'https://fixture-author.dev/').length,0);
 assert.equal(extractOriginalLiteralLinkContexts(attribute,'https://fixture-author.dev/',url).length,0);
});

test('Markdown code and quotation spans cannot grant either literal or linked ownership',()=>{
 const url='https://github.com/fixture-profile',home='https://fixture-author.dev/';
 for(const content of [`My GitHub: ${url}`,`My GitHub: [My account](${url})`,`My GitHub: <a href="${url}">My account</a>`]){
  for(const text of ['```\n'+content+'\n```','~~~\n'+content+'\n~~~','    '+content,'`'+content+'`','> '+content]){
   const contexts=[...extractOriginalLinkContexts(text,home),...extractOriginalLiteralLinkContexts(text,home,url)];
   assert.ok(contexts.length,text);
   for(const context of contexts)assert.notEqual(linkRoleFromContext({...context,targetUrl:url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section',text);
  }
 }
 for(const text of [`My GitHub: [My account](${url})`,`My GitHub:\n- [My account](${url})`]){
  const context=extractOriginalLinkContexts(text,home)[0]!;assert.equal(context.surface,'authorial');
 }
});

test('rel-me local attribution does not borrow unrelated prose from the page root', () => {
  const source = '<main><header><div><a rel="me" href="https://github.com/fixture-author">GitHub</a></div></header><article><p>He said this about a different person.</p></article></main>';
  const [context] = extractOriginalLinkContexts(source, 'https://fixture-author.dev/');
  assert.equal(context!.surface, 'authorial');
  assert.doesNotMatch(context!.quote, /He said/);
  assert.equal(linkRoleFromContext({...context!, targetUrl:context!.url, sourceIsOwnProfilePage:true, sourceIsDirectory:false}).role, 'self_account_section');
  for (const attribution of ["My colleague's accounts", 'Not my account; impersonator']) {
    const scoped = `<main><section><h2>${attribution}</h2><div><p><a rel="me" href="https://github.com/fixture-other">GitHub</a></p></div></section></main>`;
    const [item] = extractOriginalLinkContexts(scoped, 'https://fixture-author.dev/');
    assert.ok(scoped.includes(item!.quote));
    assert.notEqual(linkRoleFromContext({...item!,targetUrl:item!.url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section');
  }
  const [rootDenial] = extractOriginalLinkContexts('<main>Not my account; impersonator: <a rel="me" href="https://github.com/fixture-other">GitHub</a></main>','https://fixture-author.dev/');
  assert.notEqual(linkRoleFromContext({...rootDenial!,targetUrl:rootDenial!.url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section');
  for(const prefix of ["<h2>Accounts belonging to my colleague</h2>", '<p>This is not my account: https://github.com/fixture-other</p>']) {
   for(const wrapper of ['main','body','']) {
    for(const side of ['before','after']) {
    const original=`${wrapper?`<${wrapper}>`:''}${side==='before'?prefix:''}<nav><a rel="me" href="https://github.com/fixture-other">GitHub</a></nav>${side==='after'?prefix:''}<article><p>Other content</p></article>${wrapper?`</${wrapper}>`:''}`;
    const [denied]=extractOriginalLinkContexts(original,'https://fixture-author.dev/');
    assert.ok(original.includes(denied!.quote));
    assert.notEqual(linkRoleFromContext({...denied!,targetUrl:denied!.url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section');
    }
   }
  }
});

test('RSS subscription controls differ from third-party feeds and naked social navigation', () => {
  const own = '<div class="rss-feed"><p>RSS Subscribe</p><div class="social-media-icons"><a rel="me" href="https://github.com/fixture-author">GitHub</a></div></div>';
  const [context] = extractOriginalLinkContexts(own, 'https://fixture-author.dev/');
  assert.equal(context!.surface, 'authorial');
  for (const attrs of ['activity-feed', 'rss-feed comment-stream', 'rss-feed timeline', 'feed']) {
    const third = `<section class="${attrs}"><div class="social-media-icons"><a rel="me" href="https://github.com/fixture-other">My account</a></div></section>`;
    assert.equal(extractOriginalLinkContexts(third,'https://fixture-author.dev/')[0]!.surface,'third_party');
  }
  const [bare] = extractOriginalLinkContexts('<nav><a href="https://x.com/fixture-author">Twitter</a></nav>','https://fixture-author.dev/');
  assert.equal(linkRoleFromContext({...bare!,targetUrl:bare!.url,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'unknown_role');
});

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
  const offset=source.lastIndexOf('https://fixture-author.dev/');
  assert.deepEqual(nativeProfileLinkContext(source, 'https://absent-author.dev/',offset), null);
  const link = nativeProfileLinkContext(source, 'https://fixture-author.dev/',offset)!;
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

test('complete raw HTML indentation preserves authorial self-links while fenced or indented HTML examples do not',()=>{
 const home='https://fixture-author.dev/',blog='https://fixture-author.blog/';
 const section=`<div>I have three blogs. This <a href="${blog}">GitHub blog</a> is my oldest one.</div>`;
 const original=`<!doctype html>\n<html>\n<body>\n    ${section}\n</body>\n</html>`;
 const [context]=extractOriginalLinkContexts(original,home);assert.equal(context!.surface,'authorial');assert.equal(linkRoleFromContext({...context!,targetUrl:blog,sourceIsOwnProfilePage:true,sourceIsDirectory:false}).role,'self_account_section');assert.ok(original.includes(context!.quote));
 for(const code of ['```html\n'+original+'\n```','    <html>\n    <body>\n    '+section+'\n    </body>\n    </html>'])assert.ok(extractOriginalLinkContexts(code,home).every(c=>c.surface==='third_party'));
});
test('regex cannot manufacture a Markdown link from an AST HTML block or code example',()=>{
 const url='https://github.com/fixture-code-example';
 for(const original of [`<p>I am Fixture.</p>\n\`\`\`text\nMy GitHub: [My account](${url})\n\`\`\``,`<p>My GitHub: [My account](${url})</p>`,`\`My GitHub: [My account](${url})\``])assert.ok(extractOriginalLinkContexts(original,'https://fixture-author.dev/').every(c=>c.binding!=='markdown_link'));
});
