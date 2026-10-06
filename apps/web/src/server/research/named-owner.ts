import {createHash} from 'node:crypto';
import {parse,type DefaultTreeAdapterTypes as Tree} from 'parse5';
import type {ResearchPage,ResearchToolAction} from './tool-contracts.js';
import {classifyFirstStepUrl,isUntrustedInstructionText,isExplicitDenialQuote,classifyLinkContext} from '../../shared/first-step-discovery.js';
import {adjacentRootSpan} from './link-context.js';

export interface NativeNameDeclaration {
  platform:'github'|'x';nativeId:string;requestedUrl:string;returnedProfileUrl:string;
  payloadField:'name';rawLiteral:string;fieldOffset:number;sourceContentHash:string;
}
export const normalizedPersonName=(name:string):string=>name.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en');

function restrictedElement(item:Tree.Element):boolean {
  return ['q','cite','blockquote','script','style','template','aside','article','pre','code','svg','math','noscript'].includes(item.tagName)||
    item.attrs.some(attr=>attr.name==='hidden'||attr.name==='aria-hidden'&&attr.value.toLowerCase()==='true'||attr.name==='style'&&/(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)/i.test(attr.value))||
    /(?:feed|timeline|comment|repost|quote|recommend)/i.test(item.attrs.map(attr=>attr.value).join(' '));
}

function introductionText(node:Tree.Node):string|null {
  const pending:Tree.Node[]=[node];let text='';
  while(pending.length){
    const item=pending.shift()!;
    if('tagName' in item&&restrictedElement(item))return null;
    if(item.nodeName==='#text'&&'value' in item)text+=item.value;
    if('childNodes' in item)pending.unshift(...item.childNodes);
  }
  return text;
}

/** Native names are account self-declarations, never independent ownership. */
export function namedOwnerQuote(page:ResearchPage,action:ResearchToolAction,personName:string):{quote:string;offset:number;nativeField?:{platform:'github'|'x';nativeId:string;payloadField:'name'}}|null {
  if(action.type==='search'||page.retrieval==='search'||isUntrustedInstructionText(personName))return null;
  const request=classifyFirstStepUrl(action.url),returned=classifyFirstStepUrl(page.url);
  if(!request.ok||!returned.ok||request.ref.accountKey!==returned.ref.accountKey&&!(page.aliasProof?.kind==='native_profile'&&page.aliasProof.requestedUrl===action.url&&page.aliasProof.returnedUrl===page.url&&page.aliasProof.nativeId===page.account?.id))return null;
  const declaration=page.nativeNameDeclaration;
  if(declaration){
    const account=page.account;
    if(!account||!['github','x'].includes(account.platform)||typeof account.id!=='string'||typeof declaration.rawLiteral!=='string'||page.kind!=='profile'||page.retrieval!=='profile'||account.profileUrl!==page.url||declaration.platform!==account.platform||declaration.nativeId!==account.id||!/^\d+$/.test(account.id)||
      declaration.requestedUrl!==action.url||declaration.returnedProfileUrl!==page.url||declaration.payloadField!=='name'||declaration.fieldOffset!==0||
      action.type!==(account.platform==='github'?'github_profile':'social_profile')||
      declaration.sourceContentHash!==createHash('sha256').update(page.text).digest('hex')||
      page.text.slice(0,declaration.rawLiteral.length)!==declaration.rawLiteral||page.text.length>declaration.rawLiteral.length&&page.text[declaration.rawLiteral.length]!=='\n'||
      normalizedPersonName(declaration.rawLiteral)!==normalizedPersonName(personName)||isUntrustedInstructionText(declaration.rawLiteral))return null;
    const actual=classifyFirstStepUrl(account.profileUrl);
    if(!actual.ok||actual.ref.platform!==account.platform||actual.ref.handle?.toLowerCase()!==account.handle.toLowerCase()||request.ref.handle?.toLowerCase()!==account.handle.toLowerCase())return null;
    return {quote:declaration.rawLiteral,offset:0,nativeField:{platform:account.platform,nativeId:account.id,payloadField:'name'}};
  }
  if(returned.ref.platform!=='personal_site'||page.documentBinding&&(page.documentBinding.requestedUrl!==action.url||page.documentBinding.returnedUrl!==page.url)||!page.documentBinding&&page.url!==action.url)return null;
  const root=parse(page.text,{sourceCodeLocationInfo:true}),pending:Tree.Node[]=[root];
  while(pending.length){
    const node=pending.shift()!;
    if('tagName' in node&&restrictedElement(node))continue;
    if('childNodes' in node)pending.unshift(...node.childNodes);
    if(!('tagName' in node)||!['p','h1','h2'].includes(node.tagName)||!node.sourceCodeLocation)continue;
    const text=introductionText(node);if(text===null)continue;
    const normalized=normalizedPersonName(text),name=normalizedPersonName(personName);
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(!new RegExp(`^(?:(?:hi|hello)[,!]?\\s+)?(?:(?:i am|i'm|my name is)\\s+|我是|我叫)${escaped}(?=$|[\\s,.!。！])`,'u').test(normalized))continue;
    const quote=page.text.slice(node.sourceCodeLocation.startOffset,node.sourceCodeLocation.endOffset);
    if(quote.length>2000||isUntrustedInstructionText(quote)||isExplicitDenialQuote(quote)||classifyLinkContext(quote)==='third_party')continue;
    let ancestor=node.parentNode,branch:Tree.Node=node,veto=false;
    while(ancestor){
      const span=ancestor===root||'tagName' in ancestor&&['main','body','html'].includes(ancestor.tagName)?adjacentRootSpan(ancestor as Tree.Element|Tree.Document,branch):ancestor.sourceCodeLocation;
      const surrounding=span?page.text.slice(span.startOffset,span.endOffset):'';
      if(surrounding&&(isExplicitDenialQuote(surrounding)||classifyLinkContext(surrounding)==='third_party'||isUntrustedInstructionText(surrounding)))veto=true;
      branch=ancestor;ancestor='parentNode' in ancestor?ancestor.parentNode:null;
    }
    if(veto)continue;
    return {quote,offset:node.sourceCodeLocation.startOffset};
  }
  return null;
}
