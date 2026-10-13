/** Original synthetic evidence only; no transport or model invocation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  verifyFirstStepModelProposals,
  type FirstStepModelProposal
} from '../server/research/first-step-discovery.js';
import { extractOriginalLinkContexts } from '../server/research/link-context.js';
import {
  assessIdentityLink,
  firstStepDefaultSuggestion,
  type FirstStepLinkObservation
} from '../shared/first-step-discovery.js';

const source = 'https://synthetic-owner.dev/';
const target = 'https://github.com/synthetic-owner';
const raw = `<p>Zoë builds synthetic compilers. My GitHub: <a href="${target}">My account</a></p>`;
const proposal = (over: Partial<FirstStepModelProposal> = {}): FirstStepModelProposal => ({
  targetUrl: target, fromUrl: source, linkRole: 'self_account_section', quote: raw, requestKey: 'original-read', ...over
});
function observed(text = raw) {
  return {
    receipts: new Map([['original-read', { state: 'completed', request: { type: 'read', url: source } }]]),
    readTexts: new Map([[source, text]]),
    readLinks: new Map([[source, extractOriginalLinkContexts(text, source).map(context => context.url)]]),
    readContexts: new Map([[source, extractOriginalLinkContexts(text, source)]])
  };
}
function observation(item: FirstStepModelProposal, observationId: string, sourceText = raw): FirstStepLinkObservation {
  assert.ok(item.verifiedRole, 'only server-verified roles enter the shared assessment');
  return {
    observationId, sourceId: `source-${observationId}`, sourceRevision: 1,
    sourceUrl: source, sourceContentHash: createHash('sha256').update(sourceText).digest('hex'),
    sourceRetrievedAt: '2026-10-13T00:00:00.000Z', fromAccountKey: 'synthetic-owner',
    targetAccountKey: 'target-account', targetUrl: target, linkRole: item.verifiedRole,
    direction: 'outbound', retrieval: 'read', quote: item.quote, locator: 'synthetic original span',
    observedAt: '2026-10-13T00:00:00.000Z'
  };
}

test('hotspot: an original-read receipt without its request URL cannot authenticate a source', () => {
  const input = observed();
  // A damaged/imported receipt must fail closed even when separate stored text
  // is genuine. Text existence does not identify which document was requested.
  const receipts = new Map([['original-read', { state: 'completed', request: { type: 'read' } }]]);
  const checked = verifyFirstStepModelProposals([proposal()], { ...input, receipts });
  assert.equal(checked.accepted.length, 0, 'a missing URL must not bypass original-source binding');
  assert.equal(checked.rejected.length, 1);
});

test('hotspot: receipt URL binding keeps the matching original and rejects an unrelated original', () => {
  for (const url of [source, 'https://another-synthetic-owner.dev/', '', ' \t ', null, 42]) {
    const input = observed();
    // JSON read-back is not a runtime type proof: preserve damaged values at
    // this boundary and require rejection without throwing on comparableUrl.
    input.receipts.get('original-read')!.request.url = url as string;
    const checked = verifyFirstStepModelProposals([proposal()], input);
    assert.equal(checked.accepted.length, url === source ? 1 : 0, `receipt URL ${JSON.stringify(url)}`);
    assert.equal(checked.rejected.length, url === source ? 0 : 1);
  }
});

test('hotspot: evidence keeps exact Unicode and whitespace bytes rather than a normalized paraphrase', () => {
  const before = structuredClone(observed());
  const input = observed();
  const proposals = [proposal(), proposal({ quote: raw.normalize('NFD') }), proposal({ quote: raw.replace('. My', '.  My') })];
  const checked = verifyFirstStepModelProposals(proposals, input);
  assert.deepEqual(checked.accepted.map(item => item.quote), [raw]);
  assert.equal(checked.rejected.length, 2);
  assert.ok(checked.rejected.every(item => /精确片段/.test(item.reason)));
  assert.deepEqual(input, before, 'verification must not rewrite stored source text or contexts');
  assert.equal(proposals[0]!.verifiedRole, undefined, 'verification must not mutate model proposals');
});

test('hotspot: a mixed proposal batch isolates invented receipts, unread text and borrowed target spans', () => {
  const otherTarget = 'https://github.com/synthetic-colleague';
  const text = `${raw}\n<p>Colleague: <a href="${otherTarget}">another account</a></p>`;
  const checked = verifyFirstStepModelProposals([
    proposal(),
    proposal({ requestKey: 'invented' }),
    proposal({ fromUrl: 'https://unread-synthetic.dev/' }),
    proposal({ targetUrl: otherTarget })
  ], observed(text));
  assert.equal(checked.accepted.length, 1, 'one bad proposal must not erase genuine independent evidence');
  assert.equal(checked.accepted[0]!.targetUrl, target);
  assert.equal(checked.rejected.length, 3);
  assert.ok(checked.rejected.some(item => /回执不存在/.test(item.reason)));
  assert.ok(checked.rejected.some(item => /没有绑定同一目标/.test(item.reason)));
});

test('hotspot: an original explicit denial survives into shared conflict state and suppresses suggestion', () => {
  const denied = `<p>This is not my account: <a href="${target}">unrelated profile</a>.</p>`;
  const text = `${raw}\n${denied}`;
  const checked = verifyFirstStepModelProposals([
    proposal(), proposal({ quote: denied, linkRole: 'explicit_denial' })
  ], observed(text));
  assert.equal(checked.rejected.length, 0);
  const facts = checked.accepted.map((item, index) => observation(item, `verified-${index}`, text));
  const assessment = assessIdentityLink('target-account', facts);
  assert.equal(assessment.state, 'disputed');
  assert.deepEqual(assessment.supportObservationIds, ['verified-0']);
  assert.deepEqual(assessment.counterevidenceObservationIds, ['verified-1']);
  assert.equal(firstStepDefaultSuggestion(assessment, 'person', { readable: true, note: null }).suggested, false);
  assert.equal(assessIdentityLink('another-account', facts).state, 'proposed', 'counterevidence cannot spill into another target');
});

test('hotspot: third-party and hidden denial text cannot manufacture negative identity evidence', () => {
  for (const text of [
    `<blockquote>This is not my account: <a href="${target}">profile</a>.</blockquote>`,
    `<p hidden>This is not my account: <a href="${target}">profile</a>.</p>`,
    `<p>My GitHub: <a href="${target}">My account</a></p>`
  ]) {
    const checked = verifyFirstStepModelProposals([proposal({ quote: text, linkRole: 'explicit_denial' })], observed(text));
    assert.equal(checked.accepted.length, 0, text);
    assert.equal(checked.rejected.length, 1);
  }
});

test('hotspot: organization-origin first-person prose stays a candidate across verification and assessment', () => {
  const input = { ...observed(), organizationSourceUrls: new Set([source]) };
  const checked = verifyFirstStepModelProposals([proposal({ linkRole: 'explicit_claim' })], input);
  assert.equal(checked.rejected.length, 0, 'the real relation remains inspectable');
  assert.equal(checked.accepted[0]!.verifiedRole, 'prose_mention');
  const assessment = assessIdentityLink('target-account', [observation(checked.accepted[0]!, 'organization-mention')]);
  assert.equal(assessment.state, 'proposed');
  assert.deepEqual(assessment.supportObservationIds, []);
  assert.deepEqual(assessment.candidateObservationIds, ['organization-mention']);
  assert.equal(firstStepDefaultSuggestion(assessment, 'person', { readable: true, note: null }).suggested, false);
  assert.equal(checked.accepted[0]!.quote, raw);
});
