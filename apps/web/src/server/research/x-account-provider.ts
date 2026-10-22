import {safeFetchJson} from '../adapters/http.js';
import {ProviderError,type HttpTransport} from '../adapters/types.js';
import type {XAccountProvider,XNativeAccount,XNativePost,XReadRequest,XReadResult} from './x-account-contracts.js';

type RecordValue=Record<string,unknown>;
const BASE='https://api.tikhub.io/api/v1/twitter/web/';
const ENDPOINTS={profile:'fetch_user_profile',timeline:'fetch_user_post_tweet',replies:'fetch_user_tweet_replies',detail:'fetch_tweet_detail',comments:'fetch_post_comments'} as const;

function fail():never {throw new ProviderError('provider_bad_response','X 返回的资料结构或来源标识不符合读取契约。');}
function record(value:unknown):RecordValue {if(!value||typeof value!=='object'||Array.isArray(value))fail();return value as RecordValue;}
function nativeId(value:unknown):string {if(typeof value!=='string'||! /^[1-9][0-9]{0,29}$/.test(value))fail();return value;}
function handle(value:unknown):string {if(typeof value!=='string'||! /^[A-Za-z0-9_]{1,15}$/.test(value))fail();return value;}
function optionalId(value:unknown):string|null {return value===null||value===undefined?null:nativeId(value);}
function nonemptyText(value:unknown):string {if(typeof value!=='string'||!value.trim())fail();return value;}

function parseAccount(value:unknown,requestedHandle:string,expectedId?:string):XNativeAccount {
  const data=record(value);const id=nativeId(data.rest_id);const returnedHandle=handle(data.profile);
  if(data.status!=='active'||data.protected!==false||returnedHandle.toLowerCase()!==requestedHandle.toLowerCase()||expectedId&&id!==expectedId)fail();
  if(data.id!==undefined&&nativeId(data.id)!==id)fail();
  return {nativeId:id,handle:returnedHandle,name:typeof data.name==='string'?data.name:returnedHandle,description:typeof data.desc==='string'?data.desc:'',url:`https://x.com/${returnedHandle}`};
}

function parsePost(value:unknown,format:'list'|'detail'|'comment',account?:XNativeAccount,preview=false):XNativePost {
  const item=record(value);const id=nativeId(format==='list'?item.tweet_id:item.id);
  if(format!=='list'&&item.status!=='active')fail();
  const author=record(item.author);const authorId=nativeId(author.rest_id);
  const authorHandle=author.screen_name===null||author.screen_name===undefined
    ?account?.nativeId===authorId?account.handle:fail():handle(author.screen_name);
  // A populated handle cannot contradict a verified stable target account.
  if(account?.nativeId===authorId&&authorHandle.toLowerCase()!==account.handle.toLowerCase())fail();
  const parent=optionalId(item.in_reply_to_status_id_str);const replyTo=optionalId(item.reply_to);
  if(parent&&replyTo&&parent!==replyTo)fail();
  const parentId=parent??replyTo;
  const quoted=item.quoted===null||item.quoted===undefined?null:record(item.quoted);
  const quotedId=quoted?nativeId(quoted.tweet_id):null;
  const repost=item.retweeted_tweet===null||item.retweeted_tweet===undefined?null:record(item.retweeted_tweet);
  const repostMarker=item.retweeted===null||item.retweeted===undefined?null:record(item.retweeted);
  const originalPostId=repost?nativeId(repost.tweet_id):repostMarker?nativeId(repostMarker.id):null;
  if(repost&&repostMarker&&nativeId(repostMarker.id)!==originalPostId)fail();
  const originalAuthor=repost?record(repost.author):null;
  const originalAuthorId=originalAuthor?nativeId(originalAuthor.rest_id):null;
  const originalAuthorHandle=originalAuthor?.screen_name===null||originalAuthor?.screen_name===undefined
    ?account?.nativeId===originalAuthorId?account.handle:null:handle(originalAuthor.screen_name);
  const replyCount=typeof item.replies==='number'&&Number.isSafeInteger(item.replies)&&item.replies>=0?item.replies:null;
  return {id,url:`https://x.com/${authorHandle}/status/${id}`,authorId,authorHandle,text:nonemptyText(item.text),publishedAt:typeof item.created_at==='string'?item.created_at:null,
    kind:originalPostId?'repost':parentId||format==='comment'?'reply':quotedId?'quote':'original',parentId,quotedId,conversationId:optionalId(item.conversation_id),replyCount,textField:'text',truncated:preview,
    ...(originalPostId?{originalPostId,originalAuthorId,originalAuthorHandle}:{})};
}

function pagination(data:RecordValue,key:'next_cursor'|'cursor'):Pick<XReadResult,'nextCursor'|'cursorState'|'limitations'> {
  if(!Object.hasOwn(data,key))return {nextCursor:null,cursorState:'unknown',limitations:['供应商未返回分页结束信号，历史或评论覆盖仍有缺口。']};
  const value=data[key];
  if(value===null||value==='')return {nextCursor:null,cursorState:'end',limitations:['已到本次供应商可访问分页的末尾；这不证明平台完整历史或全部评论均可访问。']};
  if(typeof value!=='string')fail();
  return {nextCursor:value,cursorState:'more',limitations:[]};
}

function validateRequest(request:XReadRequest):URL {
  if(!Object.hasOwn(ENDPOINTS,request.type))fail();
  const url=new URL(ENDPOINTS[request.type],BASE);
  if(request.type==='profile'||request.type==='timeline'||request.type==='replies')url.searchParams.set('screen_name',handle(request.handle));
  else if('tweetId' in request)url.searchParams.set('tweet_id',nativeId(request.tweetId));
  else fail();
  if(request.type==='timeline'||request.type==='replies')nativeId(request.nativeId);
  if(request.type==='timeline'||request.type==='replies'||request.type==='comments'){
    if(request.cursor!==null){if(typeof request.cursor!=='string'||!request.cursor.length)fail();url.searchParams.set('cursor',request.cursor);}
  }
  return url;
}

/** One action is exactly one bounded request; pagination and graph traversal belong to the controller. */
export function createXAccountProvider(options:{transport:HttpTransport;apiKey:string;timeoutMs:number;maxBytes:number}):XAccountProvider {
  return {async execute(request,signal){
    const url=validateRequest(request);
    if(!options.apiKey)throw new ProviderError('provider_unavailable','X 资料读取凭据尚未配置。');
    if(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0||!Number.isFinite(options.maxBytes)||options.maxBytes<=0)fail();
    if(signal.aborted)throw signal.reason??new Error('研究已取消。');
    const response=await safeFetchJson({transport:options.transport,url:url.href,init:{headers:{accept:'application/json',authorization:`Bearer ${options.apiKey}`}},signal,timeoutMs:Math.min(60_000,Math.max(1,Math.floor(options.timeoutMs))),maxBytes:Math.min(4_000_000,Math.max(1,Math.floor(options.maxBytes)))});
    if(signal.aborted)throw signal.reason??new Error('研究已取消。');
    const body=record(response.json);
    if(body.code!==200){
      const status=typeof body.code==='number'?body.code:undefined;
      throw new ProviderError(status===429?'provider_rate_limited':status===401||status===403?'provider_forbidden':status===402?'provider_billing':status===404?'provider_not_found':'provider_bad_response','X 供应商未完成本次资料读取。',status);
    }
    const data=record(body.data);
    const base={requests:1 as const,bytes:response.bytes,estimatedUsd:null,endpoint:url.pathname};
    const completeness='保留供应商 text 字段全文；供应商未提供可核验的全文完整性保证，媒体内容尚未读取。';
    if(request.type==='profile')return {...base,account:parseAccount(data,request.handle),posts:[],nextCursor:null,cursorState:'end',recordCount:1,limitations:['公开资料为账号自述，不自动证明跨平台身份。']};
    if(request.type==='timeline'||request.type==='replies'){
      if(request.type==='timeline'?data.status!=='ok':data.status!==undefined&&data.status!=='ok')fail();
      const account=parseAccount(data.user,request.handle,request.nativeId);
      if(!Array.isArray(data.timeline))fail();
      const posts=data.timeline.map(item=>parsePost(item,'list',account,request.type==='replies'));
      if(request.type==='timeline'&&posts.some(post=>post.authorId!==account.nativeId))fail();
      const continuation=pagination(data,'next_cursor');
      return {...base,account,posts,...continuation,recordCount:data.timeline.length,limitations:[...continuation.limitations,completeness,...(request.type==='replies'?['账号回复接口可混合本人和第三方上下文，且已观察到长文预览；须读取单帖详情后才能核验全文。']:[])]};
    }
    if(!('tweetId' in request)||nativeId(data.id)!==request.tweetId||data.status!=='active')fail();
    if(request.type==='detail')return {...base,posts:[parsePost(data,'detail')],nextCursor:null,cursorState:'end',recordCount:1,limitations:[completeness,'单帖详情只保留实际父帖与引用标识，不代表整条对话已读完。']};
    if(!Array.isArray(data.thread))fail();
    const posts=data.thread.map(item=>parsePost(item,'comment'));
    const continuation=pagination(data,'cursor');
    return {...base,posts,...continuation,recordCount:data.thread.length,limitations:[...continuation.limitations,completeness,'评论排序为供应商默认；thread 是供应商返回的对话成员，缺少父帖 ID 时不推定为目标帖的直接回复。']};
  }};
}
