import { parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import type { ResearchLinkContext } from './tool-contracts.js';

function resolveLink(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || raw.startsWith('//')) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

const BLOCKS = new Set(['p', 'li', 'nav', 'footer', 'header', 'section', 'div']);
const THIRD_PARTY = /(?:activity|feed|comment|recommend|suggest|reshare|repost|quote|people-also|related-post)/i;

/** Retain actual HTML anchors and their original containing span. No source executes. */
export function extractOriginalLinkContexts(original: string, base: string): ResearchLinkContext[] {
  const contexts: ResearchLinkContext[] = [];
  const root = parseFragment(original, { sourceCodeLocationInfo: true });
  const pending: Tree.Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if ('childNodes' in node) pending.push(...node.childNodes);
    if (!('tagName' in node) || node.tagName !== 'a') continue;
    const href = node.attrs.find(attr => attr.name === 'href')?.value;
    const url = href ? resolveLink(href, base) : null;
    if (!url || !node.sourceCodeLocation) continue;
    let block: Tree.Element = node;
    let ancestor: Tree.Node | null = node.parentNode;
    let thirdParty = false;
    while (ancestor && 'tagName' in ancestor) {
      const attrs = ancestor.attrs.map(attr => `${attr.name}=${attr.value}`).join(' ');
      if (ancestor.tagName === 'blockquote' || THIRD_PARTY.test(attrs)) thirdParty = true;
      if (block === node && BLOCKS.has(ancestor.tagName) && ancestor.sourceCodeLocation) block = ancestor;
      ancestor = ancestor.parentNode;
    }
    const relMe=(node.attrs.find(attr=>attr.name==='rel')?.value??'').toLowerCase().split(/\s+/).includes('me');
    // Preserve the surrounding original semantics: rel=me cannot discard a
    // nearby denial or attribution to someone else.
    const location = block.sourceCodeLocation!;
    const quote = original.slice(location.startOffset, location.endOffset);
    // A huge wrapper is not a target-specific attribution context.
    const tooBroad = quote.length > 8000;
    contexts.push({ url, quote: tooBroad ? original.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset) : quote,
      locator: `HTML 原文第 ${String((tooBroad ? node.sourceCodeLocation : location).startOffset + 1)}–${String((tooBroad ? node.sourceCodeLocation : location).endOffset)} 字符`,
      binding: relMe ? 'html_rel_me' : 'html_anchor', surface: thirdParty ? 'third_party' : tooBroad ? 'unknown' : relMe ? 'authorial' : block === node ? 'unknown' : 'authorial' });
  }
  // Markdown retains the literal href next to its anchor text. Paragraph
  // boundaries preserve authorship context without borrowing a different link.
  for (const match of original.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/g)) {
    const url = resolveLink(match[1]!, base);
    if (!url) continue;
    const index = match.index;
    const boundary = original.lastIndexOf('\n\n', index);
    const start = boundary < 0 ? 0 : boundary + 2;
    const next = original.indexOf('\n\n', index + match[0].length);
    const end = next < 0 ? original.length : next;
    const quote = original.slice(start, end);
    const thirdParty = /^\s*>/m.test(quote) || THIRD_PARTY.test(quote);
    contexts.push({ url, quote, locator: `Markdown 原文第 ${String(start + 1)}–${String(end)} 字符`,
      binding: 'markdown_link', surface: thirdParty ? 'third_party' : quote.length > 8000 ? 'unknown' : 'authorial' });
  }
  return contexts;
}

/** The native adapter has verified the account; its website field is self-supplied. */
export function nativeProfileLinkContext(original: string, url: string): ResearchLinkContext | null {
  const index = original.indexOf(url);
  return index < 0 ? null : { url, quote: url, locator: `账号资料 website 字段，第 ${String(index + 1)}–${String(index + url.length)} 字符`, binding: 'native_profile_field', surface: 'profile_field' };
}


/** A verified native username field binds its documented profile URL without manufacturing a quote. */
export function nativeUsernameLinkContext(original: string, username: string, url: string): ResearchLinkContext | null {
  const field = `twitter_username: ${username}`;
  const index = original.indexOf(field);
  return index < 0 ? null : { url, quote: field, locator: `GitHub 公开账号 twitter_username 字段，第 ${index + 1}–${index + field.length} 字符`, binding: 'native_profile_field', surface: 'profile_field' };
}
