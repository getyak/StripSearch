/**
 * GET-213 staged name discovery: synthetic offline tests for the vertical
 * sequence (bounded general-web overview -> explicit person confirmation ->
 * account discovery -> the existing atomic account scope gate).
 *
 * Hard boundaries asserted here:
 * - NO social/account/history dispatch before person confirmation: the
 *   checked surface refuses social-constrained queries and social/technical
 *   profile reads BEFORE any request (no receipt, no cost).
 * - Overview candidates come from real checked receipts only: read originals
 *   keep content hashes + exact quote spans/locators, search-index clues stay
 *   explicitly indexed and never become originals; same-name candidates stay
 *   separate.
 * - Billing failures (HTTP 402) are safe structured non-transient service
 *   errors: exactly one supplier call, no automatic retry, remaining routes
 *   stay honest gaps — distinct from a true zero-result overview.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import {
  FirstStepSupplierStopped,
  createFirstStepCheckedSearch,
  discoverFirstStep
} from '../server/research/first-step-discovery.js';
import type { FirstStepCheckedSearch } from '../server/research/first-step-discovery.js';
import { ProviderError } from '../server/adapters/types.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { FirstStepInput } from '../shared/first-step-discovery.js';
import type { FirstStepFailureView } from '../shared/person-confirmation.js';

const OWNER = 'person-flow-owner';
const HOME_URL = 'https://lantern.dev/';
const HOME_TEXT = 'Mira Kepler maintains the Lantern compiler. Contact: hello@lantern.dev.';
const EDU_URL = 'https://example.edu/people/mira-kepler/';
const EDU_TEXT = 'Mira Kepler is a compiler researcher at Example.edu. She leads the Lantern project.';
const EDU_TEXT_OTHER = 'Mira Kepler is a marine biologist at Example.edu studying coral reefs.';
const X_URL = 'https://x.com/mkepler';

function fixture(name: string) {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const run = store.insertRun({
    ownerId: OWNER,
    question: name,
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: `fp-${name}`
  });
  firstStep.attachRun(run);
  return { db, store, firstStep, run };
}

function page(url: string, title: string, text: string, links: string[] = []) {
  return { url, title, text, kind: 'profile' as const, publishedAt: null, links, limitations: [] };
}

function result(pages: ResearchToolResult['pages']): ResearchToolResult {
  return { pages, requests: 1, bytes: 256, estimatedUsd: 0.001, credits: null, limitations: [] };
}

function checkedSearch(
  f: ReturnType<typeof fixture>,
  tools: ResearchTools,
  stage: 'overview' | 'accounts' | 'full',
  stoppedSuppliers: Array<{ supplier: string; failure: FirstStepFailureView }> = []
): FirstStepCheckedSearch {
  return createFirstStepCheckedSearch({
    tools,
    store: f.store,
    runId: f.run.id,
    attemptId: 'input-1',
    budget: { maxSearchQueries: 11, maxSearchResults: 12, maxProfileReads: 16, maxModelCalls: 2, policyVersion: 'first-step/v11' },
    stage,
    stoppedSuppliers
  });
}

async function discover(
  f: ReturnType<typeof fixture>,
  tools: ResearchTools,
  stage: 'overview' | 'accounts' | 'full',
  options: { confirmedPerson?: { candidateId: string; confirmedAt: string } | null } = {}
) {
  const input: FirstStepInput = { kind: 'name_query', value: 'Mira Kepler', question: null };
  return discoverFirstStep({
    store: f.store,
    firstStep: f.firstStep,
    ownerId: OWNER,
    runId: f.run.id,
    input,
    search: checkedSearch(f, tools, stage),
    signal: new AbortController().signal,
    registryVersion: 'registry-test/v1',
    catalog: null,
    stage,
    confirmedPerson: options.confirmedPerson ?? null
  });
}

test('overview stage dispatches no social/account IO and keeps same-name candidates separate', async (t) => {
  const f = fixture('Mira Kepler');
  t.after(() => f.db.close());
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      if (action.type === 'search') {
        return result([
          page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT),
          page(EDU_URL, 'Mira Kepler — Example.edu', EDU_TEXT),
          page(X_URL, 'Mira Kepler (@mkepler)', 'Compiler researcher. Opinions my own.')
        ]);
      }
      // Identity reads only return their own document.
      const text = action.url === EDU_URL ? EDU_TEXT : HOME_TEXT;
      return result([page(action.url, action.url === EDU_URL ? 'Mira Kepler — Example.edu' : 'Mira Kepler — Lantern', text)]);
    }
  };
  const view = await discover(f, tools, 'overview');

  assert.equal(view.phase, 'awaiting_person_confirmation');
  assert.equal(view.readyForChoice, false, 'account selection waits for person confirmation');
  assert.equal(view.accounts.length, 0, 'no account expansion before person confirmation');
  assert.equal(view.personConfirmation?.required, true);
  assert.equal(view.personConfirmation?.status, 'awaiting');

  // No social/account/history dispatch at all in the overview stage.
  for (const call of calls) {
    if (call.type === 'search') {
      assert.equal(call.includeDomains, undefined, 'no social-constrained account search before confirmation');
      assert.equal(call.provider, undefined, 'no native social search before confirmation');
    } else {
      assert.ok(call.type === 'read', `no social/technical profile read before confirmation: ${call.type}`);
      assert.ok(['lantern.dev', 'example.edu'].includes(new URL(call.url).hostname), `only identity sources are read: ${call.url}`);
    }
  }

  const overview = view.personOverview!;
  assert.equal(overview.status, 'awaiting_confirmation');
  assert.ok(overview.candidates.length >= 2, 'several source-backed candidates are shown');
  const candidateIds = new Set(overview.candidates.map((candidate) => candidate.candidateId));
  assert.equal(candidateIds.size, overview.candidates.length, 'candidate ids are immutable and unique');
  // Same names are never merged across distinct source referents.
  const eduCandidate = overview.candidates.find((candidate) => candidate.sources.some((source) => source.url === EDU_URL));
  const xCandidate = overview.candidates.find((candidate) => candidate.sources.some((source) => source.url === X_URL));
  assert.ok(eduCandidate && xCandidate, 'both the biography and the social lead are present');
  assert.notEqual(eduCandidate!.candidateId, xCandidate!.candidateId, 'same-name candidates stay separate');

  // Quoted/original vs indexed distinction.
  const eduSource = eduCandidate!.sources.find((source) => source.url === EDU_URL)!;
  assert.equal(eduSource.retrieval, 'read');
  assert.ok(eduSource.contentHash?.startsWith('sha256:'), 'read originals keep content hashes');
  assert.ok(eduSource.quote && eduSource.quote.includes('Mira Kepler'), 'descriptor quotes are real source spans');
  assert.ok(eduSource.locator?.includes('原文'), 'quote spans keep real locators');
  const xSource = xCandidate!.sources.find((source) => source.url === X_URL)!;
  assert.equal(xSource.retrieval, 'indexed');
  assert.equal(xSource.contentHash, null, 'index clues never carry original hashes');
  assert.equal(xSource.quote, null, 'index clues never carry quote spans');
  assert.ok(xSource.note.includes('不是原文'), 'the indexed limitation stays visible');
  for (const descriptor of overview.candidates.flatMap((candidate) => candidate.descriptors)) {
    assert.ok(descriptor.quote === null || typeof descriptor.locator === 'string', 'descriptor atoms stay source-backed');
    assert.ok(descriptor.statement.length <= 200, 'descriptors are concise, never free-form biography');
  }
  assert.equal(overview.coverage.sourcesRead >= 1, true);
  assert.equal(overview.coverage.sourcesIndexed >= 1, true);
});

test('a true zero-result overview never fabricates a person and keeps the service error null', async (t) => {
  const f = fixture('Mira Kepler');
  t.after(() => f.db.close());
  let searches = 0;
  const tools: ResearchTools = {
    async execute(action) {
      assert.equal(action.type, 'search');
      searches++;
      return result([]);
    }
  };
  const view = await discover(f, tools, 'overview');
  const overview = view.personOverview!;
  assert.equal(overview.status, 'no_candidates');
  assert.equal(overview.serviceError, null, 'zero results are not a service failure');
  assert.equal(overview.candidates.length, 0);
  assert.ok(overview.gaps.some((gap) => gap.includes('未找到')), 'zero results stay an honest gap');
  assert.ok(searches > 0 && searches <= 4, 'bounded general-web recall only');
});

test('HTTP 402 is a distinct non-transient service failure that stops same-supplier calls', async (t) => {
  const f = fixture('Mira Kepler');
  t.after(() => f.db.close());
  let calls = 0;
  const tools: ResearchTools = {
    async execute() {
      calls++;
      throw new ProviderError('provider_billing', '供应商计费/额度不足（HTTP 402）。', 402);
    }
  };
  const view = await discover(f, tools, 'overview');
  assert.equal(calls, 1, 'exactly one query runs before the same-supplier stop');
  const overview = view.personOverview!;
  assert.equal(overview.status, 'service_error');
  assert.equal(overview.serviceError?.code, 'provider_billing');
  assert.equal(overview.serviceError?.transient, false, 'billing failures are non-transient');
  assert.equal(overview.serviceError?.serviceError, true);
  assert.ok(!overview.serviceError!.safeDetail.includes('api-key'), 'no credentials in the safe failure detail');
  assert.equal(overview.candidates.length, 0, 'a billing failure never fabricates a person');
  assert.ok(overview.coverage.attemptsStopped.some((stop) => stop.supplier === 'exa'), 'the stopped supplier is recorded');
  assert.ok(overview.gaps.some((gap) => gap.includes('同一供应商')), 'unattempted routes stay honest gaps');
  assert.ok(view.gaps.some((gap) => gap.includes('不自动重试')), 'no automatic billing retry');
  // Honest coverage: only actually dispatched work is ever claimed.
  assert.equal(overview.coverage.queryFamilies.filter((family) => family.state === 'completed').length, 0, 'untried families are never claimed as completed');
  for (const family of overview.coverage.queryFamilies) {
    assert.ok(['failed', 'deferred', 'skipped_budget'].includes(family.state), `family ${family.family} never fakes completion`);
    if (family.state !== 'failed') assert.ok(family.note.includes('未派发'), 'untried families state they were never dispatched');
  }
  // The failure is a structured route fact, never "no person".
  const route = view.routes.find((item) => item.routeId === 'web-search')!;
  assert.equal(route.state, 'provider_billing');
  assert.equal(route.failure?.code, 'provider_billing');
});

test('the checked surface refuses same-supplier dispatch after a billing stop', async () => {
  const f = fixture('Mira Kepler');
  let calls = 0;
  const tools: ResearchTools = {
    async execute() {
      calls++;
      return result([]);
    }
  };
  const stopped = [{ supplier: 'exa', failure: { code: 'provider_billing' as const, transient: false, serviceError: true, safeDetail: 'synthetic billing stop' } }];
  const search = checkedSearch(f, tools, 'overview', stopped);
  const signal = new AbortController().signal;
  await assert.rejects(
    () => search.search('firststep:probe:v11:search:1', 'Mira Kepler', 5, signal),
    (error: unknown) => error instanceof FirstStepSupplierStopped
  );
  assert.equal(calls, 0, 'a stopped supplier leaves no dispatch and no receipt');
  assert.equal(f.store.research.receipts(f.run.id).length, 0, 'no receipt, no cost');
});

test('a concrete third-party article result is read as a minimal original, not left as an index title', async (t) => {
  const f = fixture('Mira Kepler');
  t.after(() => f.db.close());
  const articleUrl = 'https://synthetic-news.dev/articles/mira-kepler';
  const articleText = 'Mira Kepler is a compiler researcher at Example.edu. This is a third-party article about her work.';
  const readUrls: string[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      if (action.type === 'search') return result([page(articleUrl, 'Mira Kepler — Compiler Profile', 'Indexed summary only.')]);
      readUrls.push(action.url);
      return result([page(action.url, 'Mira Kepler — Compiler Profile', articleText)]);
    }
  };
  const view = await discover(f, tools, 'overview');
  assert.deepEqual(readUrls, [articleUrl], 'the observed public biography/article page gets its bounded minimal read');
  const candidate = view.personOverview!.candidates[0]!;
  const source = candidate.sources.find((item) => item.url === articleUrl)!;
  assert.equal(source.retrieval, 'read', 'the article is an actually read original, not an index title');
  assert.ok(source.contentHash?.startsWith('sha256:'));
  assert.ok(source.quote?.includes('Mira Kepler'), 'the excerpt comes from the retained original');
  assert.ok(source.locator?.includes('原文'));
  // A third-party article never becomes a person-owned/selectable account.
  assert.equal(view.accounts.length, 0);
});

for (const longDescription of [false, true]) test(`two same-name candidates drive different real account-stage context (long=${longDescription})`, async (t) => {
  const compilerText = 'Mira Kepler is a compiler researcher at Example.edu leading the Lantern project' + (longDescription ? ' and compiler methodology'.repeat(30) : '') + '.';
  const marineText = 'Mira Kepler is a marine biologist at Ocean Lab studying coral reefs' + (longDescription ? ' and marine methodology'.repeat(30) : '') + '.';
  const makeTools = (calls: string[]): ResearchTools => ({
    async execute(action) {
      if (action.type === 'search') {
        calls.push(`search:${action.query}`);
        return result([
          page('https://compiler.dev/bio/mira', longDescription ? 'Mira Kepler' : 'Mira Kepler — Compiler Profile', compilerText),
          page('https://ocean-lab.example/marine/mira', longDescription ? 'Mira Kepler' : 'Mira Kepler — Marine Profile', marineText)
        ]);
      }
      calls.push(`read:${action.url}`);
      const text = action.url.includes('ocean-lab') ? marineText : compilerText;
      return result([page(action.url, longDescription ? 'Mira Kepler' : action.url.includes('ocean-lab') ? 'Mira Kepler — Marine Profile' : 'Mira Kepler — Compiler Profile', text)]);
    }
  });
  const queriesFor = async (wanted: string): Promise<string[]> => {
    const f = fixture('Mira Kepler');
    t.after(() => f.db.close());
    const calls: string[] = [];
    const overview = await discover(f, makeTools(calls), 'overview');
    const candidates = overview.personOverview!.candidates;
    assert.ok(candidates.length >= 2, 'same-name candidates stay separate');
    const chosen = candidates.find((candidate) => candidate.sources.some((source) => source.url.includes(wanted)))!;
    assert.ok(chosen, 'each candidate is anchored by its own source');
    const accountCalls: string[] = [];
    const accountsView = await discover(f, makeTools(accountCalls), 'accounts', {
      confirmedPerson: { candidateId: chosen.candidateId, confirmedAt: '2026-10-21T00:00:00.000Z' }
    });
    assert.equal(accountsView.phase, 'ready_for_choice');
    return accountCalls.filter((call) => call.startsWith('search:'));
  };
  const compilerQueries = await queriesFor('compiler.dev');
  const marineQueries = await queriesFor('ocean-lab');
  assert.ok(compilerQueries.length > 0 && marineQueries.length > 0, 'the account stage really dispatches its bounded queries');
  assert.notDeepEqual(compilerQueries, marineQueries, 'choosing different same-name candidates drives different real expansion context');
  assert.ok(compilerQueries.some((query) => /compiler|Lantern/i.test(query)), 'the confirmed candidate\'s source context guides the queries');
  assert.ok(marineQueries.some((query) => /marine|coral/i.test(query)), 'the other candidate drives a different real target context');
});

test('valid confirmation runs account discovery and then the existing atomic scope submission', async (t) => {
  const f = fixture('Mira Kepler');
  t.after(() => f.db.close());
  const socialCalls: ResearchToolAction[] = [];
  const overviewTools: ResearchTools = {
    async execute(action) {
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT)]);
      return result([page(action.url, 'Mira Kepler — Lantern', HOME_TEXT)]);
    }
  };
  const overview = await discover(f, overviewTools, 'overview');
  const candidateId = overview.personOverview!.candidates[0]!.candidateId;

  // Account discovery after the confirmed person: social search is allowed.
  const accountTools: ResearchTools = {
    async execute(action) {
      socialCalls.push(action);
      if (action.type === 'search') return result([page(HOME_URL, 'Mira Kepler — Lantern', HOME_TEXT), page(X_URL, 'Mira Kepler (@mkepler)', 'Compiler researcher.')]);
      return result([page(action.url, 'Mira Kepler — Lantern', `Mira Kepler owns this page. My X: ${X_URL}.`)]);
    }
  };
  const accountsView = await discover(f, accountTools, 'accounts', {
    confirmedPerson: { candidateId, confirmedAt: '2026-10-21T00:00:00.000Z' }
  });
  assert.equal(accountsView.phase, 'ready_for_choice');
  assert.equal(accountsView.personConfirmation?.status, 'confirmed');
  assert.equal(accountsView.personConfirmation?.confirmedCandidateId, candidateId);
  assert.ok(accountsView.accounts.length > 0, 'account discovery ran after confirmation');
  assert.ok(socialCalls.some((call) => call.type === 'search'), 'the account stage may dispatch account search');
  assert.equal(
    accountsView.personOverview?.candidates.some((candidate) => candidate.candidateId === candidateId),
    true,
    'the immutable overview snapshot is preserved'
  );
});
