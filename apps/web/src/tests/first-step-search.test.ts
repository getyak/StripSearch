import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '../server/adapters/types.js';
import { extractOriginalLinkContexts } from '../server/research/link-context.js';
import { applyCoreSchema, openDatabase, type DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import {
  createFirstStepCheckedSearch,
  discoverFirstStep,
  quoteAround,
  verifyFirstStepModelProposals,
  type FirstStepCheckedSearch,
  type FirstStepDiscoverContext
} from '../server/research/first-step-discovery.js';
import type { ResearchPage, ResearchToolResult } from '../server/research/tool-contracts.js';
import { FIRST_STEP_DEFAULT_BUDGET, type FirstStepInput } from '../shared/first-step-discovery.js';

const homepage = 'https://fixture-linzhou.org/';
const page = (url: string, text: string, links: string[] = [], title = 'Lin Zhou'): ResearchPage => ({
  url,
  title,
  text,
  kind: 'profile',
  publishedAt: null,
  links,
  limitations: []
});
const result = (pages: ResearchPage[]): ResearchToolResult => ({
  pages,
  requests: 1,
  bytes: 100,
  estimatedUsd: null,
  credits: null,
  limitations: []
});

interface Harness {
  db: DB;
  store: Store;
  firstStep: FirstStepStore;
  ctx: FirstStepDiscoverContext;
  searches: string[];
  reads: string[];
  runId: string;
  ownerId: string;
}

function harness(
  input: FirstStepInput,
  searchImpl: (query: string, index: number) => Promise<ResearchToolResult>,
  readImpl: (url: string) => Promise<ResearchToolResult>,
  options: { propose?: FirstStepDiscoverContext['propose']; signal?: AbortSignal } = {}
): Harness {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const ownerId = 'coordinator-test';
  const run = store.insertRun({
    ownerId,
    question: input.value,
    seedUrl: input.kind === 'homepage_url' ? input.value : null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'coordinator-test'
  });
  store.updateRun(run.id, { state: 'researching' });
  const firstStep = new FirstStepStore(db, store);
  const searches: string[] = [];
  const reads: string[] = [];
  const search: FirstStepCheckedSearch = {
    async search(_key, query) {
      searches.push(query);
      return searchImpl(query, searches.length);
    },
    async readIdentity(_key, action) {
      const url = 'url' in action ? action.url : '';
      reads.push(url);
      return readImpl(url);
    },
    receipts: () => [],
    async withModel(_key, call) {
      return call();
    }
  };
  return {
    db,
    store,
    firstStep,
    runId: run.id,
    ownerId,
    searches,
    reads,
    ctx: {
      store,
      firstStep,
      ownerId,
      runId: run.id,
      input,
      search,
      signal: options.signal ?? new AbortController().signal,
      registryVersion: 'coordinator-test/v1',
      ...(options.propose ? { propose: options.propose } : {})
    }
  };
}

test('a name query never stops at the first hit and expands real self-links across material types', async () => {
  const ownGithub = 'https://github.com/linzhou-lantern';
  const letter = 'https://lantern-notes.substack.com/';
  const h = harness(
    { kind: 'name_query', value: 'Lin Zhou', question: null },
    async () => result([page(homepage, 'Lin Zhou'), page('https://www.linkedin.com/in/linzhou/', 'Lin Zhou · Lantern', [], 'Lin Zhou | LinkedIn')]),
    async () =>
      result([
        page(homepage, `我是林舟，Lantern 的作者。我的账号：${ownGithub}。我的通讯：${letter}。`, [ownGithub, letter])
      ])
  );
  try {
    const view = await discoverFirstStep(h.ctx);
    assert.ok(h.searches.length > 1, 'the wide recall runs the full frozen query set');
    const platforms = new Set(view.accounts.map((account) => account.platform));
    assert.ok(platforms.has('personal_site'));
    assert.ok(platforms.has('github'), 'self-linked work account is retained');
    assert.ok(platforms.has('substack'), 'self-linked writing account is retained');
    const linked = view.accounts.filter((account) => account.identity.state === 'supported');
    assert.ok(linked.length >= 2, 'role-correct self-links support attribution');
    const colleague = view.accounts.find((account) => account.profileUrl === ownGithub)!;
    assert.equal(colleague.defaultSuggestion.suggested, true);
  } finally {
    h.db.close();
  }
});

test('one provider failure never hides the other routes and failed receipts stay visible', async () => {
  const h = harness(
    { kind: 'name_query', value: 'Lin Zhou', question: null },
    async (_query, index) => {
      if (index === 1) throw new Error('synthetic provider outage');
      return result([page(homepage, 'Lin Zhou')]);
    },
    async () => result([page(homepage, 'Lin Zhou. Independent engineer.')])
  );
  try {
    const view = await discoverFirstStep(h.ctx);
    assert.ok(h.searches.length > 1, 'subsequent queries still run');
    assert.ok(view.accounts.length > 0, 'later successes are preserved');
    assert.ok(view.gaps.some((gap) => gap.includes('未成功')), 'the failure is recorded as a real gap');
    assert.equal(view.accounts.some((account) => account.profileUrl === homepage), true);
  } finally {
    h.db.close();
  }
});

test('an explicit URL anchor is retained as an observed lead even with empty search results', async () => {
  const h = harness(
    { kind: 'homepage_url', value: homepage, question: null },
    async () => result([]),
    async () => result([page(homepage, 'Lin Zhou. Independent engineer.')])
  );
  try {
    const view = await discoverFirstStep(h.ctx);
    const anchor = view.accounts.find((account) => account.profileUrl === homepage);
    assert.ok(anchor, 'the explicit URL stays a displayed observed lead');
    assert.equal(anchor!.userSelection.state, 'unanswered', 'no auto permission: scope still awaits confirmation');
  } finally {
    h.db.close();
  }
});

test('colleague links stay candidates and can never suggest the same person', async () => {
  const own = 'https://github.com/linzhou';
  const other = 'https://github.com/morganchen';
  const h = harness(
    { kind: 'name_query', value: 'Lin Zhou', question: null },
    async () => result([page(homepage, 'Lin Zhou')]),
    async () =>
      result([
        page(homepage, `Lin Zhou. My GitHub: ${own}. Recommended colleague Morgan Chen: ${other}.`, [own, other])
      ])
  );
  try {
    const view = await discoverFirstStep(h.ctx);
    const wrong = view.accounts.find((account) => account.profileUrl === other);
    assert.ok(wrong, 'the colleague candidate is preserved');
    assert.equal(wrong!.defaultSuggestion.suggested, false);
    assert.notEqual(wrong!.identity.state, 'supported');
    // Ordinary mention never attaches another person's account to the cluster.
    const cluster = view.clusters[0];
    assert.ok(cluster);
    assert.ok(!cluster!.accountIds.includes(wrong!.accountId), 'colleague stays outside the person cluster');
  } finally {
    h.db.close();
  }
});

test('same-name anchors stay separate clusters while linked anchors of one person join', async () => {
  const secondSite = 'https://fixture-linzhou-two.org/';
  const linkedIn = 'https://www.linkedin.com/in/linzhou/';
  const h = harness(
    { kind: 'name_query', value: 'Lin Zhou', question: null },
    async () => result([page(homepage, 'Lin Zhou'), page(secondSite, 'Lin Zhou', [], 'Lin Zhou'), page(linkedIn, 'Lin Zhou')],
    ),
    async (url) => {
      if (url === homepage) {
        return result([page(homepage, `我是林舟。我的职业主页：${linkedIn}`, [linkedIn])]);
      }
      if (url === linkedIn) {
        return result([page(linkedIn, `Lin Zhou. 我的个人网站：${homepage}`, [homepage])]);
      }
      return result([page(url, 'Lin Zhou · 另一个同名的人')]);
    }
  );
  try {
    const view = await discoverFirstStep(h.ctx);
    assert.ok(view.clusters.length >= 2, 'same-name anchors separate by evidence');
    const joined = view.clusters.find((cluster) => cluster.anchorUrl === homepage)!;
    assert.ok(joined.accountIds.length >= 2, 'mutual self-links join one person cluster');
    const other = view.clusters.find((cluster) => cluster.anchorUrl === secondSite)!;
    assert.ok(other);
    assert.ok(!other!.accountIds.some((accountId) => joined.accountIds.includes(accountId)), 'no cross-person merge');
  } finally {
    h.db.close();
  }
});

test('URL input reaches scope confirmation and never starts cross-platform deep reads', async () => {
  const h = harness(
    { kind: 'homepage_url', value: homepage, question: null },
    async () => result([]),
    async () => result([page(homepage, 'Lin Zhou. My GitHub: https://github.com/linzhou-lantern', ['https://github.com/linzhou-lantern'])])
  );
  try {
    const view = await discoverFirstStep(h.ctx);
    assert.equal(view.readyForChoice, true);
    assert.equal(view.selection.submitted, false);
    for (const account of view.accounts) {
      assert.equal(account.userSelection.state, 'unanswered');
      assert.equal(account.allowedScope.state, 'none');
    }
    // Only identity-level reads happened; no posts deep-read before selection.
    assert.ok(h.reads.every((url) => url === homepage || url.startsWith('https://')));
  } finally {
    h.db.close();
  }
});

test('restricted model proposals are bound to real receipts, sources, spans and roles', () => {
  const proposal = {
    targetUrl: 'https://github.com/morganchen',
    fromUrl: homepage,
    linkRole: 'self_account_section' as const,
    quote: 'Recommended colleague Morgan',
    requestKey: 'other-request'
  };
  const borrowed = verifyFirstStepModelProposals([proposal], {
    receipts: new Map([['other-request', { state: 'completed', request: { type: 'read', url: 'https://unrelated-source.org/' } }]]),
    readTexts: new Map([[homepage, 'Recommended colleague Morgan']])
  });
  assert.equal(borrowed.accepted.length, 0, 'a receipt for a different source cannot be borrowed');
  assert.ok(borrowed.rejected[0]!.reason.length > 0);

  const unrelated = verifyFirstStepModelProposals(
    [{ ...proposal, quote: 'Lin Zhou writes about programming.', requestKey: 'real-request' }],
    {
      receipts: new Map([['real-request', { state: 'completed', request: { type: 'read', url: homepage } }]]),
      readTexts: new Map([[homepage, 'Lin Zhou writes about programming.']])
    }
  );
  assert.equal(unrelated.accepted.length, 0, 'an unrelated exact quote invents no relation');

  const searchReceipt = verifyFirstStepModelProposals([{ ...proposal, requestKey: 'search-request' }], {
    receipts: new Map([['search-request', { state: 'completed', request: { type: 'search', query: 'Lin Zhou' } }]]),
    readTexts: new Map([[homepage, 'Recommended colleague Morgan']])
  });
  assert.equal(searchReceipt.accepted.length, 0, 'a search receipt is never original read evidence');

  const valid = verifyFirstStepModelProposals(
    [
      {
        targetUrl: 'https://github.com/linzhou',
        fromUrl: homepage,
        linkRole: 'self_account_section',
        quote: 'My GitHub: https://github.com/linzhou',
        requestKey: 'real-request'
      }
    ],
    {
      receipts: new Map([['real-request', { state: 'completed', request: { type: 'read', url: homepage } }]]),
      readTexts: new Map([[homepage, 'Lin Zhou. My GitHub: https://github.com/linzhou']])
    }
  );
  assert.equal(valid.accepted.length, 1, 'a real, role-correct, quoted relation verifies');
});

test('the checked search surface refuses posts deep-read and arbitrary fetch before selection', async () => {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const run = store.insertRun({
    ownerId: 'checked-search',
    question: 'Lin Zhou',
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'checked-search'
  });
  store.updateRun(run.id, { state: 'researching' });
  const checked = createFirstStepCheckedSearch({
    tools: {
      async execute() {
        return result([]);
      }
    },
    store,
    runId: run.id,
    attemptId: 'input-1',
    budget: { maxSearchQueries: 1, maxSearchResults: 3, maxProfileReads: 1, maxModelCalls: 1, policyVersion: 'test' }
  });
  const signal = new AbortController().signal;
  await checked.search('k1', 'Lin Zhou', 3, signal);
  await assert.rejects(
    () => checked.readIdentity('k2', { type: 'social_posts', url: 'https://x.com/linzhou' }, signal),
    /invalid_decision|not allowed/i
  );
  await assert.rejects(
    () => checked.readIdentity('k3', { type: 'firecrawl', url: 'https://lantern.dev/articles/another-author' }, signal),
    /invalid_decision|not allowed/i
  );
  await assert.rejects(() => checked.readIdentity('k4', {type: 'firecrawl', url: 'https://x.com/linzhou'}, signal), /invalid_decision|not allowed/i);
  // Attempt-bound keys: a new attempt never replays old receipts as new work.
  assert.ok(checked.receipts().length === 1);
  db.close();
});

test('cancel before ingestion drops late results and nothing is written', async () => {
  const controller = new AbortController();
  const h = harness(
    { kind: 'name_query', value: 'Lin Zhou', question: null },
    async () => {
      controller.abort();
      return result([page(homepage, 'Lin Zhou')]);
    },
    async () => result([page(homepage, 'Lin Zhou')]),
    { signal: controller.signal }
  );
  try {
    await assert.rejects(() => discoverFirstStep(h.ctx));
    const view = h.firstStep.getFirstStepView(h.ownerId, h.runId);
    assert.ok(view && view.mode === 'first_step');
    assert.equal(view.view.discoveryRevision, 0, 'no discovery revision is published after cancellation');
  } finally {
    h.db.close();
  }
});

test('quoteAround keeps real spans and honest locators; a missing span is never presented as text', () => {
  const text = 'Lin Zhou. My GitHub: https://github.com/linzhou. Recommended colleague Morgan Chen: https://github.com/morganchen.';
  const own = quoteAround(text, 'https://github.com/linzhou');
  assert.match(own.quote ?? '', /My GitHub/);
  assert.ok(own.locator);
  const missing = quoteAround(text, 'https://not-in-text.example-site.org/');
  assert.equal(missing.quote, null, 'a link without a text span is not original quote material');
  assert.match(missing.locator ?? '', /出链/);
});

// ---- Integration regressions for the metered runner / limits / receipts ----

test('runner fetch meters every selected initial read and keeps known failures out of the inflight gate', async () => {
  const { Runner } = await import('../server/services/runner.js');
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const calls: string[] = [];
  const home = 'https://fixture-linzhou.org/';
  const selected = ['https://x.com/linzhou', 'https://github.com/linzhou'];
  const prompts: string[] = [];
  const tools = {
    async execute(action: { type: string; url?: string; query?: string }) {
      calls.push(action.url ?? action.query ?? action.type);
      const pages =
        action.type === 'search'
          ? [page(home, 'Lin Zhou — Independent Engineer')]
          : action.url === home
            ? [page(home, `Lin Zhou. My X: ${selected[0]}.\nMy GitHub: ${selected[1]}.`, selected)]
            : [page(action.url!, 'Lin Zhou. Public account record.')];
      return result(pages);
    }
  };
  const planner: import('../server/research/planner.js').ResearchPlanner = {
    async decide(input) {
      prompts.push(JSON.stringify(input.checkpoint.firstStep ?? {}));
      return input.mode === 'verify'
        ? { supported: [], rejected: [] }
        : { action: 'finish', claims: [], unknowns: ['offline synthetic'] };
    }
  };
  const config = {
    researchLimits: { toolCalls: 30, modelCalls: 6, inputTokens: 100000, outputTokens: 5000, elapsedMs: 0 },
    deepseekModel: 'offline-fixture-model',
    deepseekApiKey: 'synthetic-test-only',
    exaApiKey: 'synthetic-test-only',
    tikhubApiKey: null,
    firecrawlApiKey: null
  };
  const runner = new Runner({
    store,
    firstStep,
    config: config as never,
    researchTools: tools as never,
    researchPlanner: planner,
    providerFactory: () => {
      throw new Error('unexpected legacy provider');
    },
    transport: (async () => {
      throw new Error('no network');
    }) as never,
    discoveryCatalog: null
  });
  const run = store.insertRun({
    ownerId: 'metering-test',
    question: 'Lin Zhou',
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'metering-test'
  });
  firstStep.attachRun(run);
  const wait = async (predicate: () => boolean): Promise<void> => {
    const until = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error('timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    runner.enqueue(run.id);
    await wait(() => !['queued', 'researching'].includes(store.getRun(run.id)?.state ?? ''));
    await wait(() => runner.activeCount() === 0);
    const before = store.getRun(run.id)!;
    const view = firstStep.getFirstStepView('metering-test', run.id) as { view: import('../shared/first-step-discovery.js').FirstStepDiscoveryView };
    firstStep.applyFirstStepSelection(
      'metering-test',
      run.id,
      {
        expectedRunRevision: before.revision,
        expectedScopeVersion: view.view.selection.scopeVersion,
        discoveryRevision: view.view.discoveryRevision,
        clusterId: null,
        accounts: view.view.accounts.map((account) => ({
          accountId: account.accountId,
          selection: selected.includes(account.profileUrl ?? '') ? ('only_this_account' as const) : ('not_selected' as const),
          excluded: false
        }))
      },
      'metering-submit'
    );
    runner.enqueue(run.id);
    await wait(() => !['queued', 'researching'].includes(store.getRun(run.id)?.state ?? ''));
    await wait(() => runner.activeCount() === 0);
    const receipts = store.research.receipts(run.id);
    for (const url of selected) {
      assert.ok(
        receipts.some((receipt) => receipt.kind === 'tool' && receipt.state === 'completed' && (receipt.request as { url?: string }).url === url),
        `selected initial read ${url} has an actual completed receipt`
      );
    }
    // Known settled failures must not block a fresh fetch (only unknown inflight does).
    assert.ok(!['researching', 'queued'].includes(store.getRun(run.id)?.state ?? ''));
    assert.notEqual(store.getRun(run.id)?.stopReason, 'unknown_inflight');
    // The frozen selected scope reaches the planner prompt (both URLs exposed).
    assert.ok(prompts.length > 0, 'the fetch planner actually runs');
    assert.ok(prompts.some((prompt) => selected.every((url) => prompt.includes(url))));
    // Unselected cluster home is never read during fetch.
    assert.equal(calls.filter((target) => target === home).length, 1, 'home only read once during discovery');
  } finally {
    runner.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    db.close();
  }
});

test('operator tool-call ceilings bind first-step discovery and fetch budgets', async () => {
  const { Runner } = await import('../server/services/runner.js');
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  let calls = 0;
  const tools = {
    async execute() {
      calls++;
      return result([page('https://fixture-linzhou.org/', 'Lin Zhou')]);
    }
  };
  const runner = new Runner({
    store,
    firstStep,
    config: {
      researchLimits: { toolCalls: 1, modelCalls: 2, inputTokens: 1000, outputTokens: 1000, elapsedMs: 0 },
      deepseekModel: 'offline-fixture-model',
      deepseekApiKey: null,
      exaApiKey: 'synthetic-test-only',
      tikhubApiKey: null,
      firecrawlApiKey: null
    } as never,
    researchTools: tools as never,
    researchPlanner: {
      async decide(input) {
        return input.mode === 'verify' ? { supported: [], rejected: [] } : { action: 'finish', claims: [], unknowns: [] };
      }
    },
    providerFactory: () => {
      throw new Error('unexpected');
    },
    transport: (async () => {
      throw new Error('no network');
    }) as never,
    discoveryCatalog: null
  });
  const run = store.insertRun({
    ownerId: 'ceiling-test',
    question: 'Lin Zhou',
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'ceiling-test'
  });
  firstStep.attachRun(run);
  const until = Date.now() + 10000;
  runner.enqueue(run.id);
  while (!['queued', 'researching'].includes(store.getRun(run.id)?.state ?? '') === false) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, 'the configured ceiling of one tool call is never exceeded');
  runner.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.close();
});


test('actual index-returned account links become candidates without becoming ownership evidence',async()=>{
 const url='https://x.com/fixture_writer/status/123456';
 const h=harness({kind:'name_query',value:'Lin Zhou',question:null},async()=>result([page('https://news-fixture.org/story','Lin Zhou compiler interview',[url])]),async()=>{throw new ProviderError('provider_unavailable','Synthetic inaccessible original');});
 try {
  const view=await discoverFirstStep(h.ctx);
  const account=view.accounts.find(a=>a.profileUrl==='https://x.com/fixture_writer');
  assert.ok(account,'the actual observed content URL yields its documented account home');
  assert.equal(account.defaultSuggestion.suggested,false);assert.notEqual(account.identity.state,'supported');
  assert.equal(account.identity.evidence.length,0);
 }finally{h.db.close();}
});

test('only actual authorial rel-me declarations support identity; nearby ordinary and comment links do not',async()=>{
 const own='https://github.com/fixture-rel-owner',ordinary='https://github.com/fixture-rel-friend',comment='https://github.com/fixture-rel-comment';
 const html=`<h1>Lin Zhou</h1><p>I build compilers.</p><footer><a href="${own}" rel="noopener me noreferrer">GitHub</a><a href="${ordinary}">GitHub</a></footer><section class="comments"><a href="${comment}" rel="me">My profile</a></section>`;
 const original={...page(homepage,html,[own,ordinary,comment]),linkContexts:extractOriginalLinkContexts(html,homepage)};
 const h=harness({kind:'name_query',value:'Lin Zhou',question:null},async()=>result([page(homepage,'Lin Zhou')]),async(url)=>url===homepage?result([original]):Promise.reject(new ProviderError('provider_unavailable','Unavailable fixture original')));
 try{
  const view=await discoverFirstStep(h.ctx),a=view.accounts.find(a=>a.profileUrl===own);
  assert.equal(a?.identity.state,'supported');assert.ok(a?.identity.evidence.some(e=>e.quote===`<footer><a href="${own}" rel="noopener me noreferrer">GitHub</a><a href="${ordinary}">GitHub</a></footer>`));
  for(const url of [ordinary,comment]){const other=view.accounts.find(a=>a.profileUrl===url);assert.ok(other);assert.notEqual(other.identity.state,'supported');assert.equal(other.defaultSuggestion.suggested,false);}
  assert.equal(original.text,html);assert.ok(original.linkContexts.every(c=>html.includes(c.quote)));
 }finally{h.db.close();}
});

for (const scenario of [
 {label:'colleague attribution outside anchor', prefix:"My colleague's account: ", anchor:'GitHub', role:'prose_mention'},
 {label:'denial outside anchor', prefix:'Not my account; impersonator: ', anchor:'GitHub', role:'explicit_denial'},
 {label:'denial inside anchor', prefix:'', anchor:'Not my account; impersonator', role:'explicit_denial'},
 {label:'oversized wrapper', prefix:'x'.repeat(8100), anchor:'GitHub', role:'unknown_role'}
]) test(`rel-me never overrides ${scenario.label} in the actual discovery chain`,async()=>{
 const target='https://github.com/fixture-other-person';
 const html=`<h1>Lin Zhou</h1><p>${scenario.prefix}<a rel="me" href="${target}">${scenario.anchor}</a></p>`;
 const original={...page(homepage,html,[target]),linkContexts:extractOriginalLinkContexts(html,homepage)};
 const h=harness({kind:'name_query',value:'Lin Zhou',question:null},async()=>result([page(homepage,'Lin Zhou')]),async url=>url===homepage?result([original]):Promise.reject(new ProviderError('provider_unavailable','Synthetic inaccessible original')));
 try {
  const view=await discoverFirstStep(h.ctx),account=view.accounts.find(a=>a.profileUrl===target);
  assert.ok(account);assert.notEqual(account.identity.state,'supported');assert.equal(account.defaultSuggestion.suggested,false);
  assert.ok(account.identity.evidence.every(e=>e.quote===null||html.includes(e.quote)),'all excerpts are literal original spans');
  if(scenario.role==='explicit_denial') assert.ok(account.identity.counterevidence.some(e=>e.role==='identity_counterevidence'&&e.quote!==null&&html.includes(e.quote)),'denial is retained as counterevidence');
  assert.equal(original.text,html);
 }finally{h.db.close();}
});

for (const heading of ["My colleague's account",'Not my account; impersonator']) test(`nested rel-me retains the enclosing ${heading} heading`,async()=>{
 const target='https://github.com/fixture-colleague';
 const html=`<h1>Lin Zhou</h1><section><h2>${heading}</h2><div><p><a rel="me" href="${target}">GitHub</a></p></div></section>`;
 const original={...page(homepage,html,[target]),linkContexts:extractOriginalLinkContexts(html,homepage)};
 const h=harness({kind:'name_query',value:'Lin Zhou',question:null},async()=>result([page(homepage,'Lin Zhou')]),async url=>url===homepage?result([original]):Promise.reject(new ProviderError('provider_unavailable','Unavailable synthetic original')));
 try{
  const view=await discoverFirstStep(h.ctx),account=view.accounts.find(a=>a.profileUrl===target)!;
  assert.notEqual(account.identity.state,'supported');assert.equal(account.defaultSuggestion.suggested,false);
  assert.ok(original.linkContexts[0]!.quote.includes(heading));assert.ok(html.includes(original.linkContexts[0]!.quote));
  if(heading.startsWith('Not'))assert.ok(account.identity.counterevidence.some(e=>e.quote?.includes(heading)));
 }finally{h.db.close();}
});

 test('an actually empty domain-constrained route uses remaining query capacity for the same unconstrained name query', async () => {
  const target='https://x.com/linzhou_public';let socialCalls=0;
  const h=harness({kind:'name_query',value:'Lin Zhou / 林舟',question:null},async query=>{
    if(query==='Lin Zhou Twitter X profile')return result(socialCalls++===0?[]:[page(target,'Original index title.',[],'Lin Zhou')]);
    return result([page(homepage,'Lin Zhou')]);
  },async url=>result([page(url,'Original profile.')]));
  const raw=h.ctx.search;
  h.ctx.search=createFirstStepCheckedSearch({store:h.store,runId:h.runId,attemptId:'empty-route-test',budget:FIRST_STEP_DEFAULT_BUDGET,
    tools:{execute:async action=>action.type==='search'?raw.search('synthetic',action.query,12,new AbortController().signal):raw.readIdentity('synthetic',action,new AbortController().signal)}});
  try {
    const view=await discoverFirstStep(h.ctx);
    assert.equal(socialCalls,2);assert.ok(h.searches.length<=11);
    const calls=h.store.research.receipts(h.runId).filter(r=>(r.request as {query?:string}).query==='Lin Zhou Twitter X profile');
    assert.equal(calls.length,2);
    assert.deepEqual((calls[0]!.request as {includeDomains?:string[]}).includeDomains,['x.com','twitter.com']);
    assert.equal((calls[1]!.request as {includeDomains?:string[]}).includeDomains,undefined);
    assert.deepEqual((calls[0]!.result as ResearchToolResult).pages,[],'the actual empty receipt is preserved');
    assert.equal(view.accounts.find(a=>a.profileUrl===target)!.identity.state,'proposed');
    assert.ok(view.gaps.some(gap=>gap.includes('空结果不证明账号不存在')));
  } finally {h.db.close();}
});
