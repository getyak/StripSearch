import assert from 'node:assert/strict';
import test from 'node:test';
import { extractGitHubHandle, isPublicHttpsUrl } from '../shared/validation.js';
import {
  GITHUB_API_ORIGIN,
  buildGitHubResult,
  githubProvider,
  parseGitHubProfile,
  parseGitHubRepo,
  selectWorks
} from '../server/adapters/github.js';
import type { HttpResponseLike, HttpTransport, ProviderContext } from '../server/adapters/types.js';
import { ProviderError } from '../server/adapters/types.js';
import {readBoundedBody,safeFetchJson} from '../server/adapters/http.js';

function bodyStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

function jsonResponse(status: number, body: unknown, redirected = false): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected,
    headers: { get: () => null },
    body: bodyStream(text),
    text: async () => text
  };
}

interface FakeTransport extends HttpTransport {
  calls: { url: string; method: string }[];
}

function fakeTransport(handler: (url: string) => HttpResponseLike | Promise<HttpResponseLike>): FakeTransport {
  const calls: { url: string; method: string }[] = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, method: init?.method ?? 'GET' });
      return handler(url);
    }
  };
}

interface Capture {
  stages: unknown[];
  sources: unknown[];
}

function context(transport: HttpTransport, capture: Capture, overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    transport,
    signal: new AbortController().signal,
    report: {
      stage: (...args: unknown[]) => capture.stages.push(args),
      source: (source) => capture.sources.push(source)
    },
    githubToken: null,
    exaApiKey: null,
    timeoutMs: 500,
    maxBytes: 64 * 1024,
    ...overrides
  };
}

const input = { question: 'example 做过什么？', seedUrl: 'https://github.com/example', provider: 'github' as const };

function profilePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    login: 'example',
    name: 'Example Person',
    bio: '公开简介',
    company: 'Example Lab',
    blog: 'https://example.dev',
    html_url: 'https://github.com/example',
    created_at: '2015-01-01T00:00:00Z',
    public_repos: 2,
    location: 'private-place',
    email: 'leak@example.test',
    ...overrides
  };
}

function repoPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'repo-one',
    html_url: 'https://github.com/example/repo-one',
    description: 'First repository',
    language: 'TypeScript',
    pushed_at: '2024-04-01T00:00:00Z',
    fork: false,
    archived: false,
    topics: ['tools'],
    owner: { login: 'example' },
    ...overrides
  };
}

test('extractGitHubHandle only accepts the canonical public profile form', () => {
  assert.equal(extractGitHubHandle('https://github.com/simonw'), 'simonw');
  assert.equal(extractGitHubHandle('https://github.com/simonw/'), 'simonw');
  assert.equal(extractGitHubHandle('看看 https://github.com/simonw 的资料'), 'simonw');
  assert.equal(extractGitHubHandle('http://github.com/simonw'), null);
  assert.equal(extractGitHubHandle('https://user:pass@github.com/simonw'), null);
  assert.equal(extractGitHubHandle('https://github.com:443/simonw'), null);
  assert.equal(extractGitHubHandle('https://github.com/simonw?tab=repos'), null);
  assert.equal(extractGitHubHandle('https://github.com/simonw/repo'), null);
  assert.equal(extractGitHubHandle('https://github.com/settings'), null);
  assert.equal(extractGitHubHandle('https://gitlab.com/simonw'), null);
  assert.equal(extractGitHubHandle('simonw'), null);
  assert.equal(extractGitHubHandle('https://127.0.0.1/simonw'), null);
  assert.equal(isPublicHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isPublicHttpsUrl('https://example.com/a'), true);
  assert.equal(isPublicHttpsUrl('https://localhost/a'), false);
  assert.equal(isPublicHttpsUrl('https://192.168.1.10/a'), false);
});

test('GitHub parsing keeps safe professional fields and rejects mismatched attribution', () => {
  const profile = parseGitHubProfile(profilePayload(), 'example');
  assert.ok(profile);
  assert.equal(profile.name, 'Example Person');
  assert.equal(profile.blog, 'https://example.dev');
  assert.equal(JSON.stringify(profile).includes('leak@example.test'), false);
  assert.equal(JSON.stringify(profile).includes('private-place'), false);

  // Returned login must match the requested handle.
  assert.equal(parseGitHubProfile(profilePayload({ login: 'someone-else' }), 'example'), null);
  // html_url must represent the same account, not an arbitrary repo or host.
  assert.equal(
    parseGitHubProfile(profilePayload({ html_url: 'https://github.com/example/repo' }), 'example'),
    null
  );
  assert.equal(
    parseGitHubProfile(profilePayload({ html_url: 'https://evil.test/example' }), 'example'),
    null
  );

  assert.ok(parseGitHubRepo(repoPayload(), 'example'));
  assert.equal(parseGitHubRepo(repoPayload({ owner: { login: 'evil' } }), 'example'), null);
  assert.equal(
    parseGitHubRepo(repoPayload({ html_url: 'https://github.com/evil/repo-one' }), 'example'),
    null
  );
  assert.equal(parseGitHubRepo(repoPayload({ html_url: 'https://evil.test/example/repo-one' }), 'example'), null);
});

test('selectWorks filters forks and keeps archived repositories as readable', () => {
  const repos = [
    repoPayload({ name: 'a', html_url: 'https://github.com/example/a', pushed_at: '2024-03-01T00:00:00Z' }),
    repoPayload({ name: 'forked', html_url: 'https://github.com/example/forked', fork: true, pushed_at: '2024-05-01T00:00:00Z' }),
    repoPayload({ name: 'archived', html_url: 'https://github.com/example/archived', archived: true, pushed_at: '2024-06-01T00:00:00Z' }),
    repoPayload({ name: 'b', html_url: 'https://github.com/example/b', pushed_at: '2024-02-01T00:00:00Z' })
  ];
  const parsed = repos.map((repo) => parseGitHubRepo(repo, 'example')).filter((repo) => repo !== null);
  assert.deepEqual(
    selectWorks(parsed).map((repo) => repo.name),
    ['archived', 'a', 'b']
  );
});

test('githubProvider calls fixed api.github.com endpoints and returns bounded safe output', async () => {
  const capture: Capture = { stages: [], sources: [] };
  const transport = fakeTransport((url) => {
    if (url.endsWith('/repos?per_page=30&sort=updated&direction=desc&type=owner')) {
      return jsonResponse(200, [
        repoPayload(),
        repoPayload({ name: 'forked', html_url: 'https://github.com/example/forked', fork: true }),
        repoPayload({ name: 'other', html_url: 'https://github.com/evil/other', owner: { login: 'evil' } })
      ]);
    }
    return jsonResponse(200, profilePayload());
  });
  const result = await githubProvider.run(input, context(transport, capture));
  assert.equal(result.state, 'completed');
  assert.equal(result.identity.handle, 'example');
  assert.deepEqual(
    transport.calls.map((call) => call.url),
    [
      `${GITHUB_API_ORIGIN}/users/example`,
      `${GITHUB_API_ORIGIN}/users/example/repos?per_page=30&sort=updated&direction=desc&type=owner`
    ]
  );
  assert.deepEqual(
    result.answer.map((section) => section.heading),
    ['这个人是谁', '做过什么', '查到的事实', '可能的解释', '还不确定']
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('leak@example.test'), false);
  assert.equal(serialized.includes('private-place'), false);
  assert.equal(serialized.includes('forked'), false);
  assert.equal(serialized.includes('github.com/evil'), false);
  assert.ok(result.sources.every((source) => source.url.startsWith('https://github.com/example')));
  assert.ok(result.limitations.some((limit) => limit.includes('元数据')));
  assert.equal(result.usage.requests, 2);
  // Realtime source events must match the canonical result sources exactly.
  assert.deepEqual(JSON.parse(JSON.stringify(capture.sources)), JSON.parse(JSON.stringify(result.sources)));
});

test('githubProvider needs a valid handle before making calls', async () => {
  const capture: Capture = { stages: [], sources: [] };
  const transport = fakeTransport(() => jsonResponse(200, {}));
  await assert.rejects(
    githubProvider.run({ ...input, seedUrl: null, question: '没有主页的问题' }, context(transport, capture)),
    (error: unknown) => error instanceof Error && error.name === 'NeedsInputError'
  );
  assert.equal(transport.calls.length, 0);
});

test('githubProvider maps HTTP failures to typed provider errors', async () => {
  const capture: Capture = { stages: [], sources: [] };
  for (const [status, code] of [
    [404, 'provider_not_found'],
    [403, 'provider_forbidden'],
    [429, 'provider_rate_limited'],
    [500, 'provider_error']
  ] as const) {
    const transport = fakeTransport(() => jsonResponse(status, { message: 'nope' }));
    await assert.rejects(githubProvider.run(input, context(transport, capture)), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test('githubProvider counts failed attempts and keeps archived repositories readable', async () => {
  const capture: Capture = { stages: [], sources: [] };
  const transport = fakeTransport((url) => {
    if (url.includes('/repos')) return jsonResponse(500, { message: 'boom' });
    return jsonResponse(200, profilePayload());
  });
  const result = await githubProvider.run(input, context(transport, capture));
  assert.equal(result.state, 'partial');
  assert.equal(result.usage.requests, 2);
  assert.ok(result.limitations.some((limit) => limit.includes('读取公开仓库失败')));

  const archivedCapture: Capture = { stages: [], sources: [] };
  const archivedTransport = fakeTransport((url) => {
    if (url.includes('/repos')) {
      return jsonResponse(200, [repoPayload({ archived: true })]);
    }
    return jsonResponse(200, profilePayload());
  });
  const archived = await githubProvider.run(input, context(archivedTransport, archivedCapture));
  const workSource = archived.sources.find((source) => source.kind === 'work');
  assert.equal(workSource?.fetchStatus, 'ok');
  assert.ok(workSource?.limits.some((limit) => limit.includes('归档')));
});

test('githubProvider rejects mismatched provider data before confirming identity', async () => {
  const capture: Capture = { stages: [], sources: [] };
  const transport = fakeTransport(() => jsonResponse(200, profilePayload({ login: 'someone-else' })));
  await assert.rejects(githubProvider.run(input, context(transport, capture)), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'provider_bad_response');
    return true;
  });
});

test('githubProvider rejects redirects, timeouts and oversized responses', async () => {
  const capture: Capture = { stages: [], sources: [] };
  const redirected = fakeTransport(() => jsonResponse(302, {}, true));
  await assert.rejects(githubProvider.run(input, context(redirected, capture)), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'provider_redirect');
    return true;
  });

  const oversized = fakeTransport(() => jsonResponse(200, { pad: 'x'.repeat(5000) }));
  await assert.rejects(
    githubProvider.run(input, context(oversized, capture, { maxBytes: 64 })),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'provider_response_too_large');
      return true;
    }
  );

  const hanging: HttpTransport = {
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
  };
  await assert.rejects(
    githubProvider.run(input, context(hanging, capture, { timeoutMs: 25 })),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'provider_timeout');
      return true;
    }
  );
});

async function rejectsBeforeWatchdog(pending:Promise<unknown>,check:(error:unknown)=>boolean):Promise<void> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  const watchdog=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('request still pending after its deadline')),250);});
  try {await assert.rejects(Promise.race([pending,watchdog]),check);} finally {clearTimeout(timer);}
}
const isTimeout=(error:unknown)=>error instanceof ProviderError&&error.code==='provider_timeout';
const isTooLarge=(error:unknown)=>error instanceof ProviderError&&error.code==='provider_response_too_large';
const safeOptions=(transport:HttpTransport,signal=new AbortController().signal)=>({transport,url:'https://synthetic.invalid/api',signal,timeoutMs:10,maxBytes:1000});

test('HTTP deadline rejects a stubborn fetch and consumes its later rejection without retrying',async()=>{
  let rejectFetch!:(error:Error)=>void;let calls=0;
  const transport:HttpTransport={fetch(){calls++;return new Promise((_resolve,reject)=>{rejectFetch=reject;});}};
  await rejectsBeforeWatchdog(safeFetchJson(safeOptions(transport)),isTimeout);
  rejectFetch(new Error('late upstream failure'));
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
});

test('HTTP deadline covers stubborn body reads and the response.text fallback',async()=>{
  for(const mode of ['reader','text']as const){
    const response=jsonResponse(200,{});
    if(mode==='reader')response.body={getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{}})} as unknown as ReadableStream<Uint8Array>;
    else {response.body=null;response.text=()=>new Promise(()=>{});}
    await rejectsBeforeWatchdog(safeFetchJson(safeOptions({fetch:async()=>response})),isTimeout);
  }
});

test('caller abort releases stubborn fetch or body waits with the original cancellation reason',async()=>{
  for(const mode of ['fetch','body']as const){
    const controller=new AbortController();const reason=new Error('original caller cancellation');
    let dispatched!:()=>void;const started=new Promise<void>(resolve=>{dispatched=resolve;});
    const response=jsonResponse(200,{});
    response.body={getReader:()=>({read:()=>{dispatched();return new Promise(()=>{});},cancel:async()=>{}})} as unknown as ReadableStream<Uint8Array>;
    const transport:HttpTransport={fetch(){if(mode==='body')return Promise.resolve(response);dispatched();return new Promise(()=>{});}};
    const pending=safeFetchJson({...safeOptions(transport,controller.signal),timeoutMs:1000});
    await started;controller.abort(reason);
    await rejectsBeforeWatchdog(pending,error=>error===reason);
  }
});

test('an already aborted caller never starts an HTTP request',async()=>{
  const controller=new AbortController();const reason=new Error('already cancelled');controller.abort(reason);let calls=0;
  const pending=safeFetchJson(safeOptions({fetch(){calls++;return new Promise(()=>{});}},controller.signal));
  await rejectsBeforeWatchdog(pending,error=>error===reason);assert.equal(calls,0);
});

test('an oversized body fails promptly even when reader.cancel hangs or throws',async()=>{
  for(const mode of ['hang','throw']as const){
    let cancels=0;const response=jsonResponse(200,{});
    response.body={getReader:()=>({read:async()=>({done:false,value:new Uint8Array(8)}),cancel:()=>{cancels++;if(mode==='throw')throw new Error('cancel failure');return new Promise(()=>{});}})} as unknown as ReadableStream<Uint8Array>;
    await rejectsBeforeWatchdog(readBoundedBody(response,2),isTooLarge);assert.equal(cancels,1);
  }
});

test('a fetch that resolves after the deadline cannot start reading or publish its body',async()=>{
  let release!:(response:HttpResponseLike)=>void;let bodyReads=0;
  const pending=safeFetchJson(safeOptions({fetch:()=>new Promise(resolve=>{release=resolve;})}));
  await rejectsBeforeWatchdog(pending,isTimeout);
  const response=jsonResponse(200,{late:true});
  response.body={getReader:()=>{bodyReads++;return bodyStream('{"late":true}').getReader();}} as ReadableStream<Uint8Array>;
  release(response);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(bodyReads,0);
});

test('buildGitHubResult marks a profile-only result partial', () => {
  const result = buildGitHubResult({
    profile: {
      login: 'example',
      name: null,
      bio: null,
      company: null,
      blog: null,
      htmlUrl: 'https://github.com/example',
      createdAt: null,
      publicRepos: 0
    },
    works: [],
    usage: { requests: 1, bytes: 10 },
    repoLimitReached: false,
    reposError: null
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'github_profile_only');
});
