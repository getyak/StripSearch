/** Real checked Search, toolkit and ledger; only the external HTTP transport is synthetic. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { createResearchTools } from '../server/research/toolkit.js';
import { createFirstStepCheckedSearch } from '../server/research/first-step-discovery.js';
import type { ResearchToolAction } from '../server/research/tool-contracts.js';
import type { FirstStepThirdPartyIdentityIntent } from '../shared/first-step-discovery.js';

const biography = 'https://synthetic-university.dev/people/mira-kepler';
const news = 'https://synthetic-university.dev/news/mira-kepler';
const home = 'https://synthetic-mira.dev/';
const searchKey = 'firststep:attempt-a:search:identity';
const readKey = 'firststep:attempt-a:read:biography';
const signal = () => new AbortController().signal;
function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  applyCoreSchema(db);
  const store = new Store(db);
  const run = store.insertRun({ ownerId: 'hotspot-search', question: 'Mira Kepler', seedUrl: null, provider: 'research',
    parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'synthetic-hotspot-search' });
  store.updateRun(run.id, { state: 'researching' });
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const tools = createResearchTools({ exaApiKey: 'synthetic-key', tikhubApiKey: null, githubToken: null, firecrawlApiKey: null,
    timeoutMs: 100, maxBytes: 100_000, firecrawlIntervalMs: 0,
    transport: { async fetch(endpoint, init) {
      assert.ok(['https://api.exa.ai/search', 'https://api.exa.ai/contents'].includes(endpoint), 'fixture must never fall through to a real transport');
      const body = JSON.parse(init!.body!) as Record<string, unknown>;
      calls.push({ endpoint, body });
      const urls = endpoint.endsWith('/search') ? [biography, news] : body.urls as string[];
      return new Response(JSON.stringify({
        results: urls.map(url => ({ id: url, url, title: 'Mira Kepler — synthetic fixture', text: '<p>Mira Kepler researches synthetic compilers.</p>' })),
        statuses: urls.map(url => ({ id: url, status: 'success' })), costDollars: { total: 0.001 }
      }), { status: 200 });
    } }
  });
  const checked = createFirstStepCheckedSearch({ tools, store, runId: run.id, attemptId: 'attempt-a',
    budget: { maxSearchQueries: 3, maxSearchResults: 3, maxProfileReads: 3, maxModelCalls: 1, policyVersion: 'synthetic/v1' } });
  return { checked, store, run, calls };
}

test('hotspot: third-party identity reads require the exact same-attempt search receipt and document', async t => {
  const cases: Array<{ name: string; key?: string; action?: ResearchToolAction; intent?: Partial<FirstStepThirdPartyIdentityIntent>; originalRead?: boolean }> = [
    { name: 'invented receipt', intent: { searchReceiptKey: 'firststep:attempt-a:search:invented' } },
    { name: 'foreign read attempt', key: 'firststep:attempt-b:read:biography' },
    { name: 'unbound key', key: 'biography-read' },
    { name: 'URL absent from search', action: { type: 'read', url: biography + '-other' }, intent: { url: biography + '-other' } },
    { name: 'intent URL differs', intent: { url: biography + '-other' } },
    { name: 'news article is not an identity document', action: { type: 'read', url: news }, intent: { url: news } },
    { name: 'provider switch cannot inherit biography permission', action: { type: 'firecrawl', url: biography } },
    { name: 'an original-read receipt cannot substitute for search', originalRead: true, intent: { searchReceiptKey: 'firststep:attempt-a:read:home' } }
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const f = fixture(t);
    await f.checked.search(searchKey, 'Mira Kepler synthetic biography', 3, signal());
    if (entry.originalRead) await f.checked.readIdentity('firststep:attempt-a:read:home', { type: 'read', url: home }, signal());
    const requestsBefore = f.calls.length;
    const ledgerBefore = f.store.research.receipts(f.run.id);
    const intent: FirstStepThirdPartyIdentityIntent = { purpose: 'third_party_identity', url: biography, searchReceiptKey: searchKey, ...entry.intent };
    await assert.rejects(f.checked.readIdentity(entry.key ?? readKey, entry.action ?? { type: 'read', url: biography }, signal(), intent), /invalid_decision/);
    assert.equal(f.calls.length, requestsBefore, 'refusal happens before external transport');
    assert.deepEqual(f.store.research.receipts(f.run.id), ledgerBefore, 'refusal neither reserves nor bills an action');
  });
});

test('hotspot: an authorized institution original is read once and replays its actual receipt', async t => {
  const f = fixture(t);
  const indexed = await f.checked.search(searchKey, 'Mira Kepler synthetic biography', 3, signal());
  assert.equal(indexed.pages[0]!.url, biography);
  const intent: FirstStepThirdPartyIdentityIntent = { purpose: 'third_party_identity', url: biography, searchReceiptKey: searchKey };
  const original = await f.checked.readIdentity(readKey, { type: 'read', url: biography }, signal(), intent);
  const receipt = f.store.research.receipt(f.run.id, readKey)!;
  const replay = await f.checked.readIdentity('firststep:attempt-a:read:alternate-key', { type: 'read', url: biography }, signal(), intent);
  assert.deepEqual(replay, original);
  assert.deepEqual(f.calls.map(call => call.endpoint), ['https://api.exa.ai/search', 'https://api.exa.ai/contents']);
  assert.deepEqual(f.calls[1]!.body.urls, [biography]);
  assert.equal(f.store.research.receipts(f.run.id).length, 2);
  const reads = f.checked.receipts().filter(row => row.kind === 'profile_read');
  assert.equal(reads.length, 2);
  assert.ok(reads.every(row => row.requestKey === readKey && row.observedAt === receipt.createdAt && row.retrieval === 'read' && row.estimatedUsd === 0.001));
  assert.equal(original.pages[0]!.text, '<p>Mira Kepler researches synthetic compilers.</p>');
});
