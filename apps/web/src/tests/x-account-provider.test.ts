import assert from 'node:assert/strict';
import test from 'node:test';
import {createXAccountProvider} from '../server/research/x-account-provider.js';
import type {HttpRequestInit} from '../server/adapters/types.js';
import type {XReadRequest} from '../server/research/x-account-contracts.js';

const profile={status:'active',profile:'fixture_author',rest_id:'9007199254740993123',id:'9007199254740993123',name:'Synthetic Author',desc:'Original synthetic biography.',protected:false};
const original={tweet_id:'10000000000000000001',text:'Synthetic original text.',created_at:'Wed Oct 21 12:00:00 +0000 2026',conversation_id:'10000000000000000001',replies:2,author:{rest_id:profile.rest_id,screen_name:null}};
const timelineRequest={type:'timeline',handle:'fixture_author',nativeId:profile.rest_id,cursor:null} as const;
const signal=()=>new AbortController().signal;
function harness(data:unknown,overrides:{http?:number;code?:number;maxBytes?:number;redirected?:boolean}={}){
  const calls:Array<{url:string;init?:HttpRequestInit}>=[];
  const provider=createXAccountProvider({apiKey:'synthetic-private-token',timeoutMs:100,maxBytes:overrides.maxBytes??100_000,transport:{async fetch(url,init){calls.push({url,init});const response=new Response(JSON.stringify({code:overrides.code??200,data}),{status:overrides.http??200});if(overrides.redirected)Object.defineProperty(response,'redirected',{value:true});return response;}}});
  return {calls,execute:(request:XReadRequest)=>provider.execute(request,signal())};
}

test('profile validates the actual returned handle and stable native ID in one fixed request',async()=>{
  const h=harness(profile);const r=await h.execute({type:'profile',handle:'fixture_author'});
  assert.equal(r.account?.nativeId,'9007199254740993123');assert.equal(r.account?.url,'https://x.com/fixture_author');
  assert.equal(r.requests,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0]?.url,'https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name=fixture_author');assert.equal(h.calls[0]?.init?.redirect,'error');
});

test('timeline preserves long outer text, native parent and quote IDs without harvesting quoted text',async()=>{
  const long='Synthetic long statement. '.repeat(80);
  const h=harness({status:'ok',user:profile,next_cursor:'opaque + / = cursor',timeline:[{...original,text:long},{...original,tweet_id:'10000000000000000002',reply_to:original.tweet_id,conversation_id:original.tweet_id},{...original,tweet_id:'10000000000000000003',quoted:{tweet_id:'10000000000000000004',text:'Nested text must stay separate.',author:{rest_id:'777'}}}]});
  const r=await h.execute({...timelineRequest,cursor:'opaque + / = input'});
  assert.equal(r.posts[0]?.text,long);assert.equal(r.posts[0]?.authorHandle,'fixture_author');assert.equal(r.posts[1]?.parentId,'10000000000000000001');assert.equal(r.posts[1]?.kind,'reply');assert.equal(r.posts[2]?.kind,'quote');assert.equal(r.posts[2]?.quotedId,'10000000000000000004');assert.equal(r.posts.length,3);assert.doesNotMatch(JSON.stringify(r.posts),/Nested text/);
  assert.equal(new URL(h.calls[0]!.url).searchParams.get('cursor'),'opaque + / = input');assert.equal(r.nextCursor,'opaque + / = cursor');assert.equal(r.cursorState,'more');
});

test('repost wrappers retain distinct original IDs and author rather than becoming target-authored originals',async()=>{
  const h=harness({status:'ok',user:profile,timeline:[{...original,retweeted:{id:'10000000000000000009'},retweeted_tweet:{tweet_id:'10000000000000000009',text:'Synthetic original from another author.',author:{rest_id:'777',screen_name:'other_author'}}}],next_cursor:null});
  const r=await h.execute(timelineRequest);assert.equal(r.posts[0]?.kind,'repost');assert.equal(r.posts[0]?.authorId,profile.rest_id);assert.equal(r.posts[0]?.originalPostId,'10000000000000000009');assert.equal(r.posts[0]?.originalAuthorId,'777');assert.equal(r.posts[0]?.originalAuthorHandle,'other_author');
});

test('replies accept their observed statusless envelope while retaining third-party authors and preview uncertainty',async()=>{
  const h=harness({user:profile,timeline:[{...original,in_reply_to_status_id_str:'10000000000000000005',author:{rest_id:profile.rest_id,screen_name:'fixture_author'}},{...original,tweet_id:'10000000000000000006',in_reply_to_status_id_str:'10000000000000000005',author:{rest_id:'777',screen_name:'other_author'}}],next_cursor:'next-replies'});
  const r=await h.execute({...timelineRequest,type:'replies'});assert.equal(r.posts.length,2);assert.equal(r.posts[1]?.authorId,'777');assert.equal(r.posts[1]?.url,'https://x.com/other_author/status/10000000000000000006');assert.equal(r.posts[0]?.parentId,'10000000000000000005');assert.equal(r.posts[0]?.truncated,true);assert.match(r.limitations.join(' '),/全文/);
});

test('detail uses the returned id and full text rather than the shorter display_text',async()=>{
  const h=harness({id:original.tweet_id,status:'active',text:'Synthetic full text with more context.',display_text:'Synthetic preview',author:{rest_id:'777',screen_name:'other_author'},in_reply_to_status_id_str:'10000000000000000005',reply_to:'10000000000000000005',conversation_id:'10000000000000000004',initial_tweets:null});
  const r=await h.execute({type:'detail',tweetId:original.tweet_id});assert.equal(r.posts[0]?.id,original.tweet_id);assert.equal(r.posts[0]?.text,'Synthetic full text with more context.');assert.equal(r.posts[0]?.parentId,'10000000000000000005');assert.equal(r.posts[0]?.textField,'text');assert.equal(r.posts[0]?.truncated,false);
});

test('comments use thread and cursor without inventing direct parent IDs from conversation membership',async()=>{
  const h=harness({id:original.tweet_id,status:'active',thread:[{id:'10000000000000000007',status:'active',text:'Synthetic comment body.',display_text:'Preview',conversation_id:original.tweet_id,author:{rest_id:'777',screen_name:'other_author'}}],cursor:'comments-next'});
  const r=await h.execute({type:'comments',tweetId:original.tweet_id,cursor:'comments-input'});assert.equal(r.posts.length,1);assert.equal(r.posts[0]?.kind,'reply');assert.equal(r.posts[0]?.parentId,null);assert.equal(r.posts[0]?.conversationId,original.tweet_id);assert.equal(r.nextCursor,'comments-next');assert.equal(r.cursorState,'more');assert.equal(r.recordCount,1);assert.match(r.limitations.join(' '),/父|直接/);assert.equal(new URL(h.calls[0]!.url).pathname,'/api/v1/twitter/web/fetch_post_comments');
});

test('empty pages with continuing cursors remain more and missing cursors remain unknown',async()=>{
  for(const [extra,want]of [[{next_cursor:'next'},'more'],[{next_cursor:null},'end'],[{next_cursor:''},'end'],[{},'unknown']]as const){
    const h=harness({status:'ok',user:profile,timeline:[],...extra});const r=await h.execute(timelineRequest);assert.equal(r.recordCount,0);assert.equal(r.cursorState,want);
  }
});

test('identity mismatches, malformed records and unsupported envelopes fail once without returning evidence',async()=>{
  for(const data of [{status:'ok',user:{...profile,rest_id:'777'},timeline:[original]},{status:'ok',user:profile,tweets:[original]},{status:'ok',user:profile,timeline:[{...original,author:{rest_id:9007199254740992}}]},{status:'ok',user:profile,timeline:[{...original,text:null}]},{status:'ok',user:profile,timeline:[],next_cursor:123}]){
    const h=harness(data);await assert.rejects(h.execute(timelineRequest),(e:any)=>e.code==='provider_bad_response');assert.equal(h.calls.length,1);
  }
  for(const data of [{...profile,profile:'wrong_author'},{...profile,protected:true},{...profile,rest_id:9007199254740992}])await assert.rejects(harness(data).execute({type:'profile',handle:'fixture_author'}));
  await assert.rejects(harness({id:'999',status:'active',text:'Wrong post.',author:{rest_id:'777',screen_name:'other_author'}}).execute({type:'detail',tweetId:original.tweet_id}));
  await assert.rejects(harness({id:'999',status:'active',thread:[],cursor:null}).execute({type:'comments',tweetId:original.tweet_id,cursor:null}));
});

test('invalid handles and IDs are rejected before any outbound call',async()=>{
  const h=harness(profile);for(const request of [{type:'profile',handle:'fixture_author/path'},{type:'detail',tweetId:'1?cursor=bad'},{...timelineRequest,nativeId:'not-an-id'}]as XReadRequest[])await assert.rejects(h.execute(request));assert.equal(h.calls.length,0);
});

test('provider failures, redirects and response size bounds do not retry or expose raw errors',async()=>{
  for(const [overrides,code]of [[{http:429},'provider_rate_limited'],[{code:403},'provider_forbidden'],[{redirected:true},'provider_redirect'],[{maxBytes:5},'provider_response_too_large']]as const){
    const h=harness({message:'SENSITIVE_RAW_RESPONSE'},overrides);await assert.rejects(h.execute({type:'profile',handle:'fixture_author'}),(e:any)=>e.code===code&&!/SENSITIVE_RAW_RESPONSE|synthetic-private-token/.test(e.message));assert.equal(h.calls.length,1);
  }
});
