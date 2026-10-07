/**
 * GET-95 local Fetch pipeline step identities: collision-free canonical
 * serialization of the FULL exact tool/input plus pinned revision identity.
 *
 * These are pure regression tests for the review-confirmed identity defects:
 * stage vs verification staging, read_evidence arrays, colon-delimited native
 * ids and per-item media references must never share a step identity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJson,
  fetchLocalStepKey,
  fetchPlanStepKey,
  selectFetchBranches
} from '../shared/research-fetch-pipeline.js';

const IDENTITY = { sourceId: 'src-1', sourceRevision: 1 };

test('stage and verification staging never share a step identity', () => {
  const collected = {
    findings: [
      {
        kind: 'collected_finding',
        statement: 's',
        supportEvidenceIds: ['e1'],
        counterEvidenceIds: [],
        note: null
      }
    ]
  };
  const verification = {
    findings: [
      {
        kind: 'verification_check',
        statement: 's',
        supportEvidenceIds: ['e1'],
        counterEvidenceIds: [],
        note: null
      }
    ]
  };
  const a = fetchPlanStepKey('save_findings', collected, null);
  const b = fetchPlanStepKey('save_findings', verification, null);
  assert.notEqual(a, b);
  // The same exact call stays stable (deterministic resume identity).
  assert.equal(a, fetchPlanStepKey('save_findings', JSON.parse(JSON.stringify(collected)), null));
});

test('read_evidence arrays with different contents never share a step identity', () => {
  const e1 = { evidence: [{ evidenceId: 'E1' }] };
  const e2 = { evidence: [{ evidenceId: 'E2' }] };
  const both = { evidence: [{ evidenceId: 'E1' }, { evidenceId: 'E2' }] };
  assert.notEqual(fetchPlanStepKey('read_evidence', e1, null), fetchPlanStepKey('read_evidence', e2, null));
  assert.notEqual(fetchPlanStepKey('read_evidence', e1, null), fetchPlanStepKey('read_evidence', both, null));
});

test('colon-delimited native ids cannot collide across fields', () => {
  const a = fetchPlanStepKey('read_post', { accountId: 'a:b', itemId: 'c' }, { sourceId: 's', sourceRevision: 1 });
  const b = fetchPlanStepKey('read_post', { accountId: 'a', itemId: 'b:c' }, { sourceId: 's', sourceRevision: 1 });
  assert.notEqual(a, b);
  // Key order and undefined fields never change the identity.
  assert.equal(
    fetchPlanStepKey('read_post', { itemId: 'c', accountId: 'a:b', cursor: undefined }, IDENTITY),
    fetchPlanStepKey('read_post', { accountId: 'a:b', itemId: 'c' }, IDENTITY)
  );
});

test('media steps carry the full item identity, never the mediaRef alone', () => {
  const a = fetchPlanStepKey(
    'read_media',
    { accountId: 'acct', itemId: 'itm-1', mediaRef: 'media-shared' },
    { sourceId: 'src-1', sourceRevision: 1 }
  );
  const b = fetchPlanStepKey(
    'read_media',
    { accountId: 'acct', itemId: 'itm-2', mediaRef: 'media-shared' },
    { sourceId: 'src-2', sourceRevision: 1 }
  );
  assert.notEqual(a, b);
  // The pinned revision identity participates even when GET-59 input omits it.
  const r2 = fetchPlanStepKey(
    'read_media',
    { accountId: 'acct', itemId: 'itm-1', mediaRef: 'media-shared' },
    { sourceId: 'src-1', sourceRevision: 2 }
  );
  assert.notEqual(a, r2);
});

test('tool names and local actions are disjoint step identities', () => {
  const input = { accountId: 'a', itemId: 'i', note: 'progress-0', gaps: [] };
  const keys = [
    fetchPlanStepKey('read_post', input, IDENTITY),
    fetchPlanStepKey('list_comments', input, IDENTITY),
    fetchPlanStepKey('read_thread', { ...input, parentRef: 'c-1', depth: 4 }, IDENTITY),
    fetchPlanStepKey('report_progress', { note: 'progress-0', gaps: [] }, null),
    fetchLocalStepKey('media_unknown', { accountId: 'a', itemId: 'i', sourceId: 's', sourceRevision: 1 })
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('canonicalJson is order-stable and array-order preserving', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, 2, 1] }), canonicalJson({ a: [3, 2, 1], b: 1 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  assert.notEqual(canonicalJson({ 'a:b': 'c' }), canonicalJson({ a: 'b:c' }));
});

test('branch selection is explicit and deterministic', () => {
  const selected = selectFetchBranches([
    { branchKey: 'z', important: false, subjectAuthor: false, contradictory: false, ancestorGaps: [] },
    { branchKey: 'b', important: true, subjectAuthor: false, contradictory: false, ancestorGaps: ['x:missing'] },
    { branchKey: 'a', important: false, subjectAuthor: true, contradictory: false, ancestorGaps: [] },
    { branchKey: 'c', important: false, subjectAuthor: false, contradictory: true, ancestorGaps: [] }
  ]);
  assert.deepEqual(
    selected.map((entry) => entry.branchKey),
    ['a', 'b', 'c']
  );
  assert.deepEqual(selected[1]?.ancestorGaps, ['x:missing']);
});
