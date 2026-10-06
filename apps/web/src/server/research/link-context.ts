import { parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { classifyLinkContext, isExplicitDenialQuote } from '../../shared/first-step-discovery.js';
import type { ResearchLinkContext } from './tool-contracts.js';

function resolveLink(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || raw.startsWith('//')) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

const BLOCKS = new Set(['p', 'li', 'nav', 'footer', 'header', 'section', 'div', 'main']);
const THIRD_PARTY = /(?:activity|timeline|feed|comment|recommend|suggest|reshare|repost|quote|people-also|related-post)/i;
const PAGE_ROOTS = new Set(['main', 'body', 'html']);

/** A root's adjacent heading/description belongs to this branch; an
 * independent article elsewhere on the page does not. Keep a literal span. */
export function adjacentRootSpan(root: Tree.Element | Tree.DocumentFragment | Tree.Document, branch: Tree.Node): {startOffset:number;endOffset:number} | null {
  const location=branch.sourceCodeLocation;if(!location)return null;
  const index=root.childNodes.findIndex(node=>node===branch);let start=location.startOffset,end=location.endOffset;
  for(const direction of [-1,1]){
   for(let i=index+direction;i>=0&&i<root.childNodes.length;i+=direction){
    const sibling=root.childNodes[i]!;
    if(sibling.nodeName==='#comment'||sibling.nodeName==='#text'&&'value' in sibling&&!sibling.value.trim())continue;
    if('tagName' in sibling&&!/^(?:h[1-6]|p)$/.test(sibling.tagName))break;
    if(!('tagName' in sibling)&&sibling.nodeName!=='#text')break;
    const pending:Tree.Node[]=[sibling];let independentLink=false;
    while(pending.length){const node=pending.pop()!;if('tagName' in node&&node.tagName==='a'){independentLink=true;break;}if('childNodes' in node)pending.push(...node.childNodes);}
    if(independentLink&&'tagName' in sibling&&sibling.tagName==='p'){
      const describingNavigation=navigationBranch(branch)&&sibling.sourceCodeLocation&&
        /\b(?:about|bio(?:graphy)?|contact)\b|\b(?:this|these|following|below)\s+(?:links?|pages?|accounts?|profiles?)\b|(?:简介|关于页面|联系页面|这些链接|下面的链接)/i.test(nodeText(sibling));
      if(!describingNavigation)break;
    }
    if(!sibling.sourceCodeLocation)break;
    if(direction<0)start=sibling.sourceCodeLocation.startOffset;else end=sibling.sourceCodeLocation.endOffset;
    if('tagName' in sibling&&/^h[1-6]$/.test(sibling.tagName))break;
   }
  }
  return start<location.startOffset||end>location.endOffset?{startOffset:start,endOffset:end}:null;
}

function navigationBranch(node:Tree.Node):boolean {
  if(!('tagName' in node))return false;
  if(node.tagName==='nav')return true;
  if(node.tagName!=='div'||THIRD_PARTY.test(node.attrs.map(attr=>attr.value).join(' ')))return false;
  const children=node.childNodes.filter(child=>child.nodeName!=='#comment'&&!(child.nodeName==='#text'&&'value' in child&&!child.value.trim()));
  return children.length===1&&navigationBranch(children[0]!);
}

function nodeText(node:Tree.Node):string {
  // Text nodes preserve the local caption without reading another branch.
  const pending:Tree.Node[]=[node];let text='';
  while(pending.length){const item=pending.shift()!;if(item.nodeName==='#text'&&'value' in item)text+=item.value;if('childNodes' in item)pending.unshift(...item.childNodes);}
  return text;
}

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
    const relMe=(node.attrs.find(attr=>attr.name==='rel')?.value??'').toLowerCase().split(/\s+/).includes('me');
    let block: Tree.Element = node;
    let semanticVeto: {startOffset:number;endOffset:number} | null = null;
    let ancestor: Tree.Node | null = node.parentNode;
    let branch: Tree.Node = node;
    let thirdParty = false;
    let socialControls = false;
    while (ancestor && 'tagName' in ancestor) {
      const attrs = ancestor.attrs.map(attr => `${attr.name}=${attr.value}`).join(' ');
      socialControls ||= ancestor.attrs.some(attr => attr.name === 'class' && attr.value.split(/\s+/).includes('social-media-icons'));
      // An RSS subscription wrapper around explicit social controls is not
      // a third-party timeline. Other feed/activity markers still veto it.
      const surfaceAttrs = relMe && socialControls ? attrs.replace(/\brss-feed\b/gi, 'rss-subscription') : attrs;
      if (ancestor.tagName === 'blockquote' || THIRD_PARTY.test(surfaceAttrs)) thirdParty = true;
      if (block === node && BLOCKS.has(ancestor.tagName) && ancestor.sourceCodeLocation) block = ancestor;
      // A nested paragraph cannot erase the heading or description of an
      // enclosing semantic container. Inspect actual ancestor text for a
      // conservative veto; retain its exact span rather than invent context.
      if (semanticVeto === null && ancestor.sourceCodeLocation) {
        const relevant=PAGE_ROOTS.has(ancestor.tagName)?adjacentRootSpan(ancestor,branch):ancestor.sourceCodeLocation;
        const span=relevant?original.slice(relevant.startOffset,relevant.endOffset):'';
        if (relevant&&(isExplicitDenialQuote(span)||classifyLinkContext(span)==='third_party')) semanticVeto=relevant;
      }
      branch = ancestor;
      ancestor = ancestor.parentNode;
    }
    // parseFragment removes body/html wrappers; their direct descriptions
    // remain siblings in the document fragment and must still constrain nav.
    if(semanticVeto===null&&ancestor===root){
      const relevant=adjacentRootSpan(root,branch);
      const span=relevant?original.slice(relevant.startOffset,relevant.endOffset):'';
      if(relevant&&(isExplicitDenialQuote(span)||classifyLinkContext(span)==='third_party'))semanticVeto=relevant;
    }
    // Preserve the surrounding original semantics: rel=me cannot discard a
    // nearby denial or attribution to someone else.
    const location = semanticVeto ?? block.sourceCodeLocation!;
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
export function nativeProfileLinkContext(original: string, url: string, fieldOffset: number): ResearchLinkContext | null {
  const index = Number.isInteger(fieldOffset) && fieldOffset >= 0 && original.slice(fieldOffset, fieldOffset + url.length) === url ? fieldOffset : -1;
  return index < 0 ? null : { url, quote: url, locator: `账号资料 website 字段，第 ${String(index + 1)}–${String(index + url.length)} 字符`, binding: 'native_profile_field', surface: 'profile_field' };
}


/** A verified native username field binds its documented profile URL without manufacturing a quote. */
export function nativeUsernameLinkContext(original: string, username: string, url: string, fieldOffset: number): ResearchLinkContext | null {
  const field = `twitter_username: ${username}`;
  const index = Number.isInteger(fieldOffset) && fieldOffset >= 0 && original.slice(fieldOffset, fieldOffset + field.length) === field ? fieldOffset : -1;
  return index < 0 ? null : { url, quote: field, locator: `GitHub 公开账号 twitter_username 字段，第 ${index + 1}–${index + field.length} 字符`, binding: 'native_profile_field', surface: 'profile_field' };
}
