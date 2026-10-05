/**
 * Source-backed duplicate candidate projection regressions (2026-10-06):
 * verified adapter alias proofs may collapse duplicate candidates ONLY on
 * fresh discovery attempts with no persisted case accounts, only through the
 * observed requested->returned account-key map, and never as identity support,
 * default suggestion or scope permission. Existing cases keep their original
 * user choices / negative / exclusion untouched and get one honest gap. All
 * fixtures are original synthetic offline material.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase, type DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import {
  createFirstStepCheckedSearch,
  discoverFirstStep,
  verifyAliasProjection,
  type FirstStepDiscoverContext
} from '../server/research/first-step-discovery.js';
import type { ResearchPage, ResearchToolResult, ResearchToolAction, ResearchAliasProof } from '../server/research/tool-contracts.js';
import type { FirstStepBudgetPolicy, FirstStepInput, FirstStepSelectionInput } from '../shared/first-step-discovery.js';
import { seedFirstStep } from './first-step-fixtures.js';

const page = (url: string, text: string, over: Partial<ResearchPage> = {}): ResearchPage => ({
  url,
  title: over.title ?? 'Fixture Author',
  text,
  kind: 'profile',
  publishedAt: null,
  links: [],
  limitations: [],
  ...(over.aliasProof?.kind==='native_profile'?{account:{platform:over.aliasProof.platform,id:over.aliasProof.nativeId,handle:new URL(url).pathname.slice(1),profileUrl:url}}:{}),
  ...over
});
const result = (pages: ResearchPage[]): ResearchToolResult => ({ pages, requests: 1, bytes: 100, estimatedUsd: null, credits: null, limitations: [] });

interface Impl {
  search?: (query: string) => ResearchPage[];
  read: (url: string) => ResearchPage[];
  firecrawlAvailable?: boolean;
  budget?: Partial<FirstStepBudgetPolicy>;
}

interface Harness {
  db: DB;
  store: Store;
  firstStep: FirstStepStore;
  ctx: FirstStepDiscoverContext;
  runId: string;
  ownerId: string;
  reads: string[];
}

function attachTools(store: Store, firstStep: FirstStepStore, runId: string, ownerId: string, input: FirstStepInput, impl: Impl): Harness {
  const reads: string[] = [];
  const tools = {
    async execute(action: ResearchToolAction): Promise<ResearchToolResult> {
      if (action.type === 'search') return result(impl.search?.(action.query) ?? []);
      reads.push(action.url);
      return result(impl.read(action.url));
    }
  };
  const search = createFirstStepCheckedSearch({
    tools,
    store,
    runId,
    attemptId: 'alias-projection-test',
    budget: {
      maxSearchQueries: 8,
      maxSearchResults: 12,
      maxProfileReads: 16,
      maxModelCalls: 2,
      policyVersion: 'first-step/v2',
      ...impl.budget
    }
  });
  return {
    db: null as unknown as DB,
    store,
    firstStep,
    runId,
    ownerId,
    reads,
    ctx: {
      store,
      firstStep,
      ownerId,
      runId,
      input,
      search,
      signal: new AbortController().signal,
      registryVersion: 'alias-projection-test/v1',
      firecrawlAvailable: impl.firecrawlAvailable ?? false
    }
  };
}

function harness(input: FirstStepInput, impl: Impl): Harness {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const ownerId = 'alias-projection-test';
  const run = store.insertRun({
    ownerId,
    question: input.value,
    seedUrl: input.kind === 'homepage_url' ? input.value : null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: 'alias-projection-test'
  });
  store.updateRun(run.id, { state: 'researching' });
  const firstStep = new FirstStepStore(db, store);
  const attached = attachTools(store, firstStep, run.id, ownerId, input, impl);
  return { ...attached, db };
}

test('a proven native case alias collapses to the observed canonical account and never supports identity by itself', async () => {
  const aliasUrl = 'https://github.com/fixtureauthor';
  const canonicalUrl = 'https://github.com/FixtureAuthor';
  const home = 'https://fixture-author.dev/';
  const h = harness({ kind: 'name_query', value: 'Fixture Author', question: null }, {
    search: () => [page(aliasUrl, 'Original synthetic bio.'), page(canonicalUrl, 'Original synthetic bio.'), page(home, 'Original synthetic home.')],
    read: (url) =>
      url === aliasUrl || url === canonicalUrl
        ? [page(canonicalUrl, 'Original synthetic bio.', {
            aliasProof: { kind: 'native_profile', platform: 'github', nativeId: '123456', requestedUrl: url, returnedUrl: canonicalUrl },
            account: { platform: 'github', handle: 'FixtureAuthor', id: '123456', profileUrl: canonicalUrl }
          })]
        : [page(url, 'Original synthetic home.')],
    budget: { maxSearchQueries: 2 }
  });
  try {
    const view = await discoverFirstStep(h.ctx);
    const githubAccounts = view.accounts.filter((account) => account.platform === 'github');
    assert.equal(githubAccounts.length, 1, 'the proven case alias is projected as ONE account');
    assert.equal(githubAccounts[0]!.profileUrl, canonicalUrl, 'the observed canonical returned ref is the representative');
    assert.equal(view.accounts.some((account) => account.profileUrl === aliasUrl), false);
    assert.equal(view.input.value, 'Fixture Author', 'the original input value is unchanged');
    assert.equal(githubAccounts[0]!.identity.state, 'proposed', 'an alias proof is never identity support');
    assert.equal(githubAccounts[0]!.identity.evidence.length, 0);
    assert.equal(githubAccounts[0]!.defaultSuggestion.suggested, false, 'no default support from an alias');
    assert.ok(view.receipts.some((receipt) => receipt.target === aliasUrl), 'the original requested read receipt is preserved');
    const rawReceipt = h.store.research.receipts(h.runId).find((receipt) => (receipt.request as { url?: string } | null)?.url === aliasUrl);
    assert.ok(rawReceipt, 'the real metered receipt of the requested read is preserved');
    const storedResult = JSON.stringify(rawReceipt!.result);
    assert.ok(storedResult.includes(aliasUrl) && storedResult.includes(canonicalUrl), 'the proof round-trips through the real result/receipt');
    assert.ok(view.gaps.some((gap) => gap.includes('合并仅为投影去重')), 'the projection merge is an inspectable note');
  } finally {
    h.db.close();
  }
});

test('an alias projection keeps the exact source-original quote, target URL and hash of real evidence', async () => {
  const aliasUrl = 'https://github.com/fixtureauthor';
  const canonicalUrl = 'https://github.com/FixtureAuthor';
  const home = 'https://fixture-author.dev/';
  const quote = '<p>My GitHub: <a href="https://github.com/fixtureauthor">my projects</a>.</p>';
  const homeText = `${quote}\n<p>Original synthetic biography.</p>`;
  const h = harness({ kind: 'name_query', value: 'Fixture Author', question: null }, {
    search: () => [page(aliasUrl, 'Original synthetic bio.'), page(home, homeText, { links: [aliasUrl], linkContexts: [{ url: aliasUrl, quote, locator: 'HTML 原文第 1–80 字符', binding: 'html_anchor', surface: 'authorial' }] })],
    read: (url) =>
      url === aliasUrl
        ? [page(canonicalUrl, 'Original synthetic bio.', {
            aliasProof: { kind: 'native_profile', platform: 'github', nativeId: '123456', requestedUrl: aliasUrl, returnedUrl: canonicalUrl },
            account: { platform: 'github', handle: 'FixtureAuthor', id: '123456', profileUrl: canonicalUrl }
          })]
        : [page(url, homeText, { links: [aliasUrl], linkContexts: [{ url: aliasUrl, quote, locator: 'HTML 原文第 1–80 字符', binding: 'html_anchor', surface: 'authorial' }] })],
    budget: { maxSearchQueries: 1 }
  });
  try {
    const view = await discoverFirstStep(h.ctx);
    const githubAccounts = view.accounts.filter((account) => account.platform === 'github');
    assert.equal(githubAccounts.length, 1);
    const github = githubAccounts[0]!;
    // The support comes from the real home-page self link (the alias proof adds
    // nothing): its exact original span and literals survive the merge.
    assert.equal(github.identity.state, 'supported', 'real self-link evidence still counts after the projection merge');
    const evidence = github.identity.evidence[0]!;
    assert.equal(evidence.quote, quote, 'the source-original quote is retained byte-for-byte');
    assert.equal(evidence.sourceUrl, home, 'the original source URL is retained');
    assert.ok((evidence.sourceLocator ?? '').includes(aliasUrl), 'the original literal target URL is retained');
  } finally {
    h.db.close();
  }
});

test('a proven same-path www/apex redirect projects one account, keeps the input and maps later registrations', async () => {
  const requested = 'https://www.fixture-author.dev/';
  const finalUrl = 'https://fixture-author.dev/';
  const h = harness({ kind: 'homepage_url', value: requested, question: null }, {
    // Search hits AFTER the read still resolve through the observed map.
    search: () => [page(requested, 'Original synthetic home.'), page('https://fixture-author.dev/about', 'Original synthetic about.')],
    read: (url) =>
      url === requested
        ? [page(finalUrl, 'Original synthetic home.', {
            aliasProof: { kind: 'same_document_redirect', requestedUrl: requested, returnedUrl: finalUrl }
          })]
        : [page(url, 'Original synthetic about.')],
    firecrawlAvailable: true,
    budget: { maxSearchQueries: 1 }
  });
  try {
    const view = await discoverFirstStep(h.ctx);
    assert.equal(view.accounts.length, 1, 'the www/apex variants project to ONE account');
    assert.equal(view.accounts[0]!.profileUrl, finalUrl, 'the observed actual final URL is the representative');
    assert.equal(view.input.value, requested, 'the original input value is unchanged');
    assert.ok(view.receipts.some((receipt) => receipt.target === requested), 'the original requested read receipt is preserved');
    assert.equal(view.accounts[0]!.identity.state, 'proposed');
    assert.equal(view.accounts[0]!.defaultSuggestion.suggested, false, 'no default support from an alias');
  } finally {
    h.db.close();
  }
});

test('unproven variants stay separate: different paths, subdomains and native ids never merge', async () => {
  // (a) A claimed redirect across different pathnames fails the server
  //     re-verification: both candidates remain, with an honest gap.
  const claimed = harness({ kind: 'homepage_url', value: 'https://www.fixture-author.dev/about', question: null }, {
    search: () => [],
    read: () => [page('https://fixture-author.dev/', 'Original synthetic home.', {
      aliasProof: { kind: 'same_document_redirect', requestedUrl: 'https://www.fixture-author.dev/about', returnedUrl: 'https://fixture-author.dev/' }
    })],
    firecrawlAvailable: true,
    budget: { maxSearchQueries: 1 }
  });
  try {
    const view = await discoverFirstStep(claimed.ctx);
    assert.equal(new Set(view.accounts.map((account) => account.accountKey)).size, 2, 'different paths never merge');
    assert.ok(view.gaps.some((gap) => gap.includes('未通过服务端核验')), 'the rejected proof is an honest gap');
  } finally {
    claimed.db.close();
  }

  // (b) A claimed subdomain jump fails the same re-verification.
  const subdomain = harness({ kind: 'homepage_url', value: 'https://www.fixture-author.dev/', question: null }, {
    search: () => [],
    read: () => [page('https://blog.fixture-author.dev/', 'Original synthetic blog.', {
      aliasProof: { kind: 'same_document_redirect', requestedUrl: 'https://www.fixture-author.dev/', returnedUrl: 'https://blog.fixture-author.dev/' }
    })],
    firecrawlAvailable: true,
    budget: { maxSearchQueries: 1 }
  });
  try {
    const view = await discoverFirstStep(subdomain.ctx);
    assert.equal(new Set(view.accounts.map((account) => account.accountKey)).size, 2, 'different subdomains never merge');
    assert.ok(view.gaps.some((gap) => gap.includes('未通过服务端核验')));
  } finally {
    subdomain.db.close();
  }

  // (c) Different native handles/IDs each keep their own (case) account.
  const natives = harness({ kind: 'name_query', value: 'Fixture Author', question: null }, {
    search: () => [page('https://github.com/alice', 'Original synthetic bio.'), page('https://github.com/alice-2', 'Original synthetic bio.')],
    read: (url) => {
      const returned = url.includes('alice-2') ? 'https://github.com/Alice-2' : 'https://github.com/Alice';
      return [page(returned, 'Original synthetic bio.', {
        aliasProof: { kind: 'native_profile', platform: 'github', nativeId: url.includes('alice-2') ? '222' : '111', requestedUrl: url, returnedUrl: returned }
      })];
    },
    budget: { maxSearchQueries: 1 }
  });
  try {
    const view = await discoverFirstStep(natives.ctx);
    const githubAccounts = view.accounts.filter((account) => account.platform === 'github');
    assert.equal(githubAccounts.length, 2, 'different native IDs stay separate');
    assert.deepEqual(new Set(githubAccounts.map((account) => account.profileUrl)), new Set(['https://github.com/Alice', 'https://github.com/Alice-2']));
  } finally {
    natives.db.close();
  }
});

test('verifyAliasProjection rejects forged, cross-platform, non-profile and cross-handle proofs', () => {
  const native = (over: Partial<Extract<ResearchAliasProof, { kind: 'native_profile' }>>): ResearchAliasProof => ({
    kind: 'native_profile', platform: 'github', nativeId: '123456', requestedUrl: 'https://github.com/alice', returnedUrl: 'https://github.com/Alice', ...over
  });
  assert.equal(verifyAliasProjection(native({ nativeId: '' })).ok, false, 'no stable native id, no proof');
  assert.equal(verifyAliasProjection(native({ returnedUrl: 'https://github.com/Alice-2' })).ok, false, 'different handles/native ids never merge');
  assert.equal(verifyAliasProjection(native({ platform: 'x' })).ok, false, 'cross-platform claims never merge');
  assert.equal(verifyAliasProjection(native({ returnedUrl: 'https://github.com/Alice/repo' })).ok, false, 'content pages are not profile entries');
  const redirect = (over: Partial<Extract<ResearchAliasProof, { kind: 'same_document_redirect' }>>): ResearchAliasProof => ({
    kind: 'same_document_redirect', requestedUrl: 'https://www.fixture-author.dev/', returnedUrl: 'https://fixture-author.dev/', ...over
  });
  assert.equal(verifyAliasProjection(redirect({ requestedUrl: 'https://www.fixture-author.dev/about' })).ok, false, 'different paths never merge');
  assert.equal(verifyAliasProjection(redirect({ returnedUrl: 'https://blog.fixture-author.dev/' })).ok, false, 'subdomains never merge');
  assert.equal(verifyAliasProjection(redirect({ requestedUrl: 'https://www.fixture-author.dev/works/x', returnedUrl: 'https://fixture-author.dev/works/x' })).ok, false, 'non-profile pages never merge');
  assert.equal(verifyAliasProjection(redirect({ requestedUrl: 'https://www.other-author.dev/' })).ok, false, 'different domains never merge');
  assert.equal(verifyAliasProjection(native({})).ok, true);
  assert.equal(verifyAliasProjection(redirect({})).ok, true);
});

test('existing cases keep prior choices and exclusions untouched and never merge aliases', async () => {
  const f = seedFirstStep({
    accounts: [
      { url: 'https://fixture-linzhou.org/', supportedBy: { sourceUrl: 'https://fixture-linzhou.org/about', quote: 'My GitHub: https://github.com/fixture-linzhou.' } },
      { url: 'https://github.com/fixture-linzhou' }
    ]
  });
  const ownerId = 'user-owner';
  const current = f.firstStep.getFirstStepView(ownerId, f.run.id);
  assert.ok(current && current.mode === 'first_step');
  if (!current || current.mode !== 'first_step') throw new Error('wrong flow');
  const selection: FirstStepSelectionInput = {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: current.view.selection.scopeVersion,
    discoveryRevision: current.view.discoveryRevision,
    clusterId: current.view.clusters[0]!.clusterId,
    accounts: [
      { accountId: f.accountIdFor(0), selection: 'selected', excluded: false },
      { accountId: f.accountIdFor(1), selection: 'not_selected', excluded: true, note: '不是此人' }
    ]
  };
  f.firstStep.applyFirstStepSelection(ownerId, f.run.id, selection, 'alias-projection-select');

  const aliasUrl = 'https://github.com/fixtureauthor';
  const canonicalUrl = 'https://github.com/FixtureAuthor';
  const h = attachTools(f.store, f.firstStep, f.run.id, ownerId, { kind: 'name_query', value: 'Fixture Author', question: null }, {
    search: () => [page(aliasUrl, 'Original synthetic bio.'), page(canonicalUrl, 'Original synthetic bio.')],
    read: (url) => [
      page(canonicalUrl, 'Original synthetic bio.', {
        aliasProof: { kind: 'native_profile', platform: 'github', nativeId: '123456', requestedUrl: url, returnedUrl: canonicalUrl }
      })
    ],
    budget: { maxSearchQueries: 1 }
  });
  const view = await discoverFirstStep(h.ctx);
  const githubAccounts = view.accounts.filter((account) => account.platform === 'github');
  assert.equal(githubAccounts.length, 2, 'no merge on an existing case: both candidates stay separate');
  assert.ok(view.gaps.some((gap) => gap.includes('不做合并投影')), 'the unresolved alias is an honest gap');
  // The original user choice and the explicit negative/exclusion stay exactly
  // as recorded before the new discovery attempt.
  const exclusions = f.firstStep.activeExclusions(f.run.id);
  assert.equal(exclusions.length, 1, 'the prior exclusion is untouched');
  assert.equal(exclusions[0]!.accountId, f.accountIdFor(1));
  assert.equal(exclusions[0]!.statement, '不是此人');
  const accounts = f.store.cases.listAccounts(ownerId, f.caseId);
  assert.equal(accounts.find((account) => account.accountId === f.accountIdFor(0))!.userSelection.state, 'selected');
  assert.equal(accounts.find((account) => account.accountId === f.accountIdFor(1))!.userSelection.state, 'not_selected');
  f.close();
});

test('an unverified search outlink inherits no name relevance from its referring page title', async () => {
  const home = 'https://fixture-author.dev/';
  const outlink = 'https://github.com/linzhou-lantern';
  const other = 'https://linzhou-lantern.dev/';
  const h = harness({ kind: 'name_query', value: 'Fixture Author', question: null }, {
    search: () => [
      page(home, 'Original synthetic home.', { title: 'Fixture Author', links: [outlink] }),
      page(other, 'Original synthetic other.', { title: 'Lin Zhou' })
    ],
    read: (url) => [page(url, `Original synthetic ${url}.`, { title: url === other ? 'Lin Zhou' : 'Fixture Author' })],
    budget: { maxSearchQueries: 1 }
  });
  try {
    const view = await discoverFirstStep(h.ctx);
    // A direct result page title may count name relevance; an unverified
    // outbound link must not jump the read queue through its referring title.
    assert.deepEqual(h.reads, [home, other, outlink], 'the outlink keeps its platform priority only');
    const linked = view.accounts.find((account) => account.profileUrl === outlink)!;
    assert.ok(linked, 'the actual outlink stays a candidate');
    assert.equal(linked.identity.basis, 'search_index', 'the unverified outlink stays an indexed candidate (unknown_role only)');
    assert.equal(linked.identity.evidence.length, 0);
    assert.equal(linked.identity.state, 'proposed');
    assert.equal(linked.defaultSuggestion.suggested, false);
  } finally {
    h.db.close();
  }
});

for(const mismatch of ['request','id','returned'] as const)test(`alias proof cannot collapse candidates with unbound ${mismatch}`,async()=>{
 const requested='https://github.com/fixture-author',returned='https://github.com/Fixture-Author';
 const h=harness({kind:'homepage_url',value:requested,question:null},{search:()=>[],read:url=>[page(returned,'Actual synthetic original.',{
  account:{platform:'github',id:'111',handle:'Fixture-Author',profileUrl:returned},
  aliasProof:{kind:'native_profile',platform:'github',nativeId:mismatch==='id'?'222':'111',requestedUrl:mismatch==='request'?'https://github.com/other-fixture':url,returnedUrl:mismatch==='returned'?'https://github.com/FIXTURE-AUTHOR':returned}
 })],budget:{maxSearchQueries:1}});
 try{const view=await discoverFirstStep(h.ctx);assert.ok(view.accounts.some(a=>a.profileUrl===requested));assert.ok(view.accounts.some(a=>a.profileUrl===returned));assert.ok(view.gaps.some(g=>g.includes('与实际请求或原生返回账号不绑定')));}finally{h.db.close();}
});
