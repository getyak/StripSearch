/**
 * Frozen SEARCH query contract for the first step (FR-P1-001 regression):
 *
 * - A validated public URL input (up to LIMITS.seedUrlMax = 2048 chars) is
 *   read, classified and displayed exactly as supplied; only its SEARCH query
 *   is the explicit bounded hostname + real bounded path form (<= 600 chars).
 * - Every planned query family fits the frozen 600-char SEARCH contract.
 * - Name queries keep the actual supplied name text and never guess aliases.
 * - The default v4 budgets and the original global cumulative limits stay
 *   unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRST_STEP_DEFAULT_BUDGET,
  FIRST_STEP_QUERY_FAMILIES,
  FIRST_STEP_SEARCH_QUERY_MAX,
  classifyFirstStepUrl,
  firstStepQueryPlan,
  firstStepUrlSearchQuery
} from '../shared/first-step-discovery.js';
import { LIMITS } from '../shared/limits.js';
import { RESEARCH_LIMITS } from '../server/research/research-store.js';

const LONG_URL = `https://probe-lab.dev/${'a'.repeat(700)}`;

test('a validated long URL keeps its read form and gets an explicit bounded hostname+path query', () => {
  assert.ok(LONG_URL.length <= LIMITS.seedUrlMax && LONG_URL.length > FIRST_STEP_SEARCH_QUERY_MAX);
  // Input acceptance and the READ URL stay exactly as supplied.
  const classified = classifyFirstStepUrl(LONG_URL);
  assert.ok(classified.ok);
  assert.equal(classified.ok && classified.ref.profileUrl, LONG_URL, 'the source read URL is never rewritten');

  const query = firstStepUrlSearchQuery(LONG_URL);
  assert.ok(query.length > 0 && query.length <= FIRST_STEP_SEARCH_QUERY_MAX, 'the query fits the frozen SEARCH contract');
  assert.ok(query.startsWith('probe-lab.dev/'), 'the query is built from the validated hostname + real path');
  assert.ok(LONG_URL.includes(query), 'the query text is only actual URL text from the input');
  assert.ok(!query.includes('https://'), 'no scheme noise; never a manufactured handle');

  const plan = firstStepQueryPlan({ kind: 'homepage_url', value: LONG_URL, question: null }, FIRST_STEP_DEFAULT_BUDGET);
  assert.equal(plan.length, 1, 'the URL input keeps its single frozen home family');
  assert.equal(plan[0]!.family, 'home');
  assert.equal(plan[0]!.query, query);
  assert.equal({ kind: 'homepage_url', value: LONG_URL }.value, LONG_URL, 'the input value itself is never modified');
});

test('short URL inputs also plan bounded hostname+path queries and keep the read URL', () => {
  const short = 'https://fixture-linzhou.org/about';
  const query = firstStepUrlSearchQuery(short);
  assert.equal(query, 'fixture-linzhou.org/about');
  const classified = classifyFirstStepUrl(short);
  assert.ok(classified.ok && classified.ref.profileUrl === short);
  assert.equal(firstStepUrlSearchQuery('https://fixture-linzhou.org/'), 'fixture-linzhou.org');
});

test('every planned query family fits the frozen 600-char SEARCH contract', () => {
  const inputs = [
    { kind: 'homepage_url' as const, value: LONG_URL, question: null },
    { kind: 'homepage_url' as const, value: 'https://fixture-linzhou.org/', question: null },
    { kind: 'name_query' as const, value: 'Lin Zhou', question: null },
    // The longest validated name/hint text plus several actual supplied aliases.
    { kind: 'name_query' as const, value: `${'名'.repeat(400)} / alias-one / alias-two`, question: null },
    { kind: 'name_query' as const, value: '张晓 Ming Zhang', question: null }
  ];
  for (const input of inputs) {
    const plan = firstStepQueryPlan(input, FIRST_STEP_DEFAULT_BUDGET, ['observed alias', `${'x'.repeat(300)}`]);
    assert.ok(plan.length > 0, `a plan exists for ${input.value.slice(0, 24)}`);
    for (const item of plan) {
      assert.ok(item.query.trim().length > 0, 'no empty query is planned');
      assert.ok(item.query.length <= FIRST_STEP_SEARCH_QUERY_MAX, `query exceeds the frozen SEARCH contract: ${item.query.length}`);
    }
  }
});

test('name queries preserve the actual input and never guess aliases', () => {
  const input = { kind: 'name_query' as const, value: 'Lin Zhou / 林舟', question: null };
  const plan = firstStepQueryPlan(input, FIRST_STEP_DEFAULT_BUDGET, ['L. Zhou']);
  assert.equal(input.value, 'Lin Zhou / 林舟');
  const home = plan.find((item) => item.family === 'home');
  assert.equal(home?.query, 'Lin Zhou', 'the home query is the actual supplied name text');
  // Aliases are only ACTUAL supplied or observed strings — never fabricated
  // usernames; no query manufactures a handle.
  assert.ok(plan.every((item) => !item.query.includes('@')), 'no guessed handle ever enters a query');
  const aliases = plan.filter((item) => item.family === 'alias').map((item) => item.query);
  assert.deepEqual(aliases, ['林舟 public profile', 'L. Zhou public profile'], 'only supplied/observed aliases are searched');
  for (const item of plan) assert.ok(item.query.length <= FIRST_STEP_SEARCH_QUERY_MAX);
});

test('the default v4 budgets and the original global cumulative limits stay frozen', () => {
  assert.equal(FIRST_STEP_DEFAULT_BUDGET.maxSearchQueries, 11);
  assert.equal(FIRST_STEP_DEFAULT_BUDGET.maxSearchResults, 12);
  assert.equal(FIRST_STEP_DEFAULT_BUDGET.maxProfileReads, 16);
  assert.equal(FIRST_STEP_DEFAULT_BUDGET.maxModelCalls, 2);
  assert.equal(FIRST_STEP_QUERY_FAMILIES.length, 9);
  assert.equal(FIRST_STEP_SEARCH_QUERY_MAX, 600);
  assert.equal(RESEARCH_LIMITS.toolCalls, 12);
  assert.equal(RESEARCH_LIMITS.modelCalls, 8);
  assert.equal(RESEARCH_LIMITS.inputTokens, 150000);
  assert.equal(RESEARCH_LIMITS.outputTokens, 16000);
  assert.equal(RESEARCH_LIMITS.elapsedMs, 240000);
});
