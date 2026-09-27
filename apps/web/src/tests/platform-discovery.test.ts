/**
 * Shared contract tests: subjects, external tool report parsing, the one-pass
 * correction planner, link transitions, checkpoints and budgets.
 *
 * All fixtures here are synthetic. Nothing in this file touches a network.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attributionFor,
  budgetStop,
  emptyCheckpoint,
  emptyUsage,
  nextLinkState,
  normalizePlatformId,
  normalizeSubject,
  parseHoleheReport,
  parseMaigretNdjson,
  parseMaigretReport,
  planOnePassCorrection,
  postAttribution,
  probeKey,
  remainingProbeKeys,
  reviewReasonFor,
  stageAfter,
  trackedPostKey,
  validateCorrection,
  validateSubject
} from '../shared/platform-discovery.js';
import type { CorrectionCandidate } from '../shared/platform-discovery.js';

test('subject normalization lowercases emails and trims usernames', () => {
  assert.deepEqual(normalizeSubject({ kind: 'email', value: ' Person@Example.TEST ' }), {
    kind: 'email',
    value: 'person@example.test'
  });
  assert.deepEqual(normalizeSubject({ kind: 'username', value: ' alice-01 ' }), {
    kind: 'username',
    value: 'alice-01'
  });
  assert.equal(validateSubject({ kind: 'email', value: 'person@example.test' }).ok, true);
  assert.equal(validateSubject({ kind: 'email', value: 'not-an-email' }).ok, false);
  assert.equal(validateSubject({ kind: 'username', value: 'ok_user.1-2' }).ok, true);
  assert.equal(validateSubject({ kind: 'username', value: 'has space' }).ok, false);
  assert.equal(validateSubject({ kind: 'username', value: 'a/b' }).ok, false);
  assert.equal(validateSubject({ kind: 'username', value: '' }).ok, false);
});

test('maigret simple JSON report maps statuses honestly', () => {
  const parsed = parseMaigretReport(
    {
      fixturecode: {
        username: 'alice',
        url_main: 'https://fixturecode.example.test',
        url_user: 'https://fixturecode.example.test/alice',
        http_status: 200,
        status: {
          username: 'alice',
          site_name: 'fixturecode',
          url: 'https://fixturecode.example.test/alice',
          status: 'Claimed',
          ids: {},
          tags: [],
          keywords: [],
          keyword_match_status: 'No Keywords'
        },
        found: true
      },
      fixtureblog: {
        username: 'alice',
        url_user: 'https://fixtureblog.example.test/alice',
        status: { status: 'Available' }
      },
      fixturewiki: {
        username: 'alice',
        url_user: 'https://fixturewiki.example.test/alice',
        status: { status: 'Weird-New-Status' }
      },
      fixturesimilar: {
        username: 'alice',
        url_user: 'https://fixturesimilar.example.test/alice',
        is_similar: true,
        status: { status: 'Claimed' }
      }
    },
    { toolVersion: '0.6.5', generatedAt: '2026-09-27T00:00:00Z' }
  );
  assert.equal(parsed.ok, true);
  const byId = new Map(parsed.results.map((item) => [item.platformId, item]));
  assert.equal(byId.get('fixturecode')?.status, 'found');
  assert.equal(byId.get('fixturecode')?.method, 'external_report');
  assert.equal(byId.get('fixturecode')?.receipt.tool, 'maigret');
  assert.equal(byId.get('fixturecode')?.receipt.toolVersion, '0.6.5');
  assert.equal(byId.get('fixtureblog')?.status, 'not_found');
  // Unknown spellings never become found.
  assert.equal(byId.get('fixturewiki')?.status, 'unknown');
  // Similar-account results are dropped entirely.
  assert.equal(byId.has('fixturesimilar'), false);
  // Imported results stay unverified by default.
  for (const result of parsed.results) {
    assert.equal(result.verification, 'live_unverified');
    assert.ok(result.limitations.includes('not_rechecked_by_stripsearch'));
  }
  assert.ok(parsed.warnings.some((w) => w.includes('Weird-New-Status')));
});

test('maigret NDJSON report parses one entry per line', () => {
  const text = [
    JSON.stringify({
      sitename: 'fixturecode',
      username: 'alice',
      url_user: 'https://fixturecode.example.test/alice',
      status: { status: 'Claimed', username: 'alice', url: 'https://fixturecode.example.test/alice' }
    }),
    'not-json',
    JSON.stringify({
      sitename: 'fixtureblog',
      username: 'alice',
      url_user: 'https://fixtureblog.example.test/alice',
      status: { status: 'Available' }
    })
  ].join('\n');
  const parsed = parseMaigretNdjson(text);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0]?.status, 'found');
  assert.equal(parsed.results[1]?.status, 'not_found');
  assert.ok(parsed.warnings.length >= 1);
});

test('holehe module report drops re-contact fields and keeps rate limits honest', () => {
  const parsed = parseHoleheReport([
    {
      name: 'fixture-mail',
      rateLimit: false,
      exists: true,
      emailrecovery: 'ex****e@example.test',
      phoneNumber: '0*******78',
      others: null
    },
    { name: 'fixture-locked', rateLimit: true, exists: true },
    { name: 'fixture-absent', rateLimit: false, exists: false },
    { name: 'fixture-broken', rateLimit: false }
  ]);
  assert.equal(parsed.ok, true);
  const byId = new Map(parsed.results.map((item) => [item.platformId, item]));
  assert.equal(byId.get('fixture-mail')?.status, 'found');
  assert.equal(byId.get('fixture-locked')?.status, 'blocked');
  assert.equal(byId.get('fixture-absent')?.status, 'not_found');
  assert.equal(byId.get('fixture-broken')?.status, 'unknown');
  const found = byId.get('fixture-mail');
  assert.ok(found?.limitations.includes('recontact_fields_dropped'));
  assert.ok(found?.limitations.includes('email_registration_probe'));
  // The obfuscated recovery hints never survive the parse.
  assert.equal(JSON.stringify(parsed.results).includes('ex****e@example.test'), false);
  assert.ok(parsed.warnings.some((w) => w.includes('已丢弃')));
});

test('parse rejects non-report payloads instead of guessing', () => {
  assert.equal(parseMaigretReport(42).ok, false);
  assert.equal(parseHoleheReport(true).ok, false);
  assert.equal(parseMaigretReport(null).ok, false);
});

test('one-pass correction only auto-confirms deterministic cross links', () => {
  const candidates: CorrectionCandidate[] = [
    {
      linkId: 'l1',
      platformId: 'fixturecode',
      handle: 'alice',
      profileUrl: 'https://fixturecode.example.test/alice',
      state: 'proposed',
      crossLinked: true,
      exactHandleMatch: true
    },
    {
      linkId: 'l2',
      platformId: 'fixtureblog',
      handle: 'alice',
      profileUrl: 'https://fixtureblog.example.test/alice',
      state: 'proposed',
      crossLinked: false,
      exactHandleMatch: true
    },
    {
      linkId: 'l3',
      platformId: 'fixturewiki',
      handle: null,
      profileUrl: null,
      state: 'proposed',
      crossLinked: false,
      exactHandleMatch: false
    }
  ];
  const plan = planOnePassCorrection(candidates);
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0]?.linkId, 'l1');
  assert.deepEqual(plan.proposals[0]?.basis, ['cross_link']);
  assert.deepEqual(plan.needsReview, ['l2', 'l3']);
  // Handle equality is recorded as a review reason, never as confirmation.
  assert.ok(reviewReasonFor(candidates[1]!).includes('同一人'));
});

test('link state machine enforces explicit transitions', () => {
  assert.equal(nextLinkState('proposed', 'confirm'), 'confirmed');
  assert.equal(nextLinkState('proposed', 'dismiss'), 'dismissed');
  assert.equal(nextLinkState('confirmed', 'dismiss'), 'dismissed');
  assert.equal(nextLinkState('dismissed', 'reopen'), 'proposed');
  assert.equal(nextLinkState('proposed', 'reopen'), null);
  assert.equal(nextLinkState('confirmed', 'confirm'), null);
  assert.equal(nextLinkState('dismissed', 'dismiss'), null);

  assert.equal(validateCorrection({ linkId: 'l1', action: 'confirm', basis: [], note: null, counterevidence: null }).ok, false);
  assert.equal(
    validateCorrection({ linkId: 'l1', action: 'confirm', basis: ['manual_review'], note: '核对过', counterevidence: null }).ok,
    true
  );
  assert.equal(
    validateCorrection({ linkId: 'l1', action: 'reopen', basis: [], note: null, counterevidence: null }).ok,
    true
  );

  assert.equal(attributionFor('proposed'), 'unattributed');
  assert.equal(attributionFor('confirmed'), 'linked');
  assert.equal(attributionFor('dismissed'), 'revoked');
  assert.deepEqual(postAttribution('confirmed'), { attribution: 'linked', valid: true });
  assert.deepEqual(postAttribution('dismissed'), { attribution: 'revoked', valid: false });
});

test('checkpoints make resume idempotent', () => {
  const subject = { kind: 'username' as const, value: 'alice' };
  const keyA = probeKey('fixturecode', 'api_http', subject);
  const keyB = probeKey('fixtureblog', 'profile_http', subject);
  assert.equal(keyA, probeKey('fixturecode', 'api_http', { kind: 'username', value: 'alice' }));
  assert.notEqual(keyA, keyB);
  assert.deepEqual(remainingProbeKeys([keyA, keyB], [keyA]), [keyB]);
  assert.deepEqual(remainingProbeKeys([keyA, keyB], [keyA, keyA]), [keyB]);

  const checkpoint = emptyCheckpoint();
  assert.equal(checkpoint.stage, 'discover');
  assert.equal(stageAfter('discover'), 'correct');
  assert.equal(stageAfter('correct'), 'track');
  assert.equal(stageAfter('track'), 'done');
});

test('budgets stop work instead of overrunning it', () => {
  const limits = { maxProbes: 2, maxPostsPerLink: 5, maxRequests: 4, maxBytes: 1000 };
  const usage = emptyUsage();
  assert.equal(budgetStop(usage, limits), null);
  usage.probes = 2;
  assert.equal(budgetStop(usage, limits), 'max_probes');
  const usage2 = emptyUsage();
  usage2.requests = 4;
  assert.equal(budgetStop(usage2, limits), 'max_requests');
  const usage3 = emptyUsage();
  usage3.bytes = 1000;
  assert.equal(budgetStop(usage3, limits), 'max_bytes');
});

test('tracked post keys are stable and platform ids normalize as slugs', () => {
  assert.equal(trackedPostKey('fixturecode', 'p1'), 'fixturecode:p1');
  assert.equal(normalizePlatformId('My Site!'), 'my-site');
  assert.equal(normalizePlatformId('  Weird___Name  '), 'weird-name');
});
