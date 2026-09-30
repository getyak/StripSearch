/**
 * GET-92 account key tests: conservative canonical account identity and
 * candidate origin merging.
 *
 * Everything here is offline and pure. The rules under test:
 *
 * - native ids are opaque STRINGS (letters / leading zeros / large values
 *   preserved) and only key anything with a VERIFIED issuer namespace; a
 *   home instance is never the issuer of a remote/federated account;
 * - URL fallback is public-safe HTTPS with conservative canonicalization:
 *   unknown path/handle case, encoded slashes, trailing slashes, identity
 *   queries and fragments are preserved; tracking parameters are stripped
 *   only through an explicit verified per-platform whitelist (empty by
 *   default);
 * - handles keep their case unless a verified platform case rule exists;
 *   `invalid_handle` placeholders are never verified handles and a remote
 *   acct (`user@domain`) is a domain-bound handle, never an email;
 * - instances (ports/subdomains included) and account kinds stay distinct;
 * - native-id ↔ URL/actor association merges ONLY with deterministic
 *   provider proof; unproven association never merges; contradictions in
 *   ids/actor/home/kinds are retained as explicit conflicts with all
 *   origins; discovery never inflates identity support, user choice or
 *   reading scope.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CandidateMergeError,
  NO_ACCOUNT_KEY_RULES,
  canonicalAccountKey,
  mergeCandidateOrigins,
  newCandidateDraft
} from '../server/discovery/account-key.js';
import type { AccountKeyRules } from '../server/discovery/account-key.js';
import type {
  AccountNativeId,
  CandidateDraft,
  CandidateOrigin,
  DiscoveredAccountIdentity
} from '../shared/discovery-plan.js';

function identity(over: Partial<DiscoveredAccountIdentity> = {}): DiscoveredAccountIdentity {
  return {
    platformId: 'github',
    instance: null,
    accountKind: 'person',
    nativeId: null,
    nativeIdIssuer: null,
    profileUrl: null,
    actorUrl: null,
    handle: null,
    handleVerified: false,
    homeInstance: null,
    associationProof: null,
    ...over
  };
}

function origin(originId: string, over: Partial<CandidateOrigin> = {}): CandidateOrigin {
  return {
    originId,
    observedAt: '2026-09-30T00:00:00.000Z',
    provenance: {
      kind: 'username_probe',
      platformId: 'github',
      routeId: 'route-1',
      ruleId: 'pr-0000000000000001',
      requestKey: 'sdrk/1:fixture',
      sourceRefs: ['maigret']
    },
    locator: 'marker:FOUND',
    excerpt: 'short excerpt',
    ...over
  };
}

/* ------------------------------------------------------------------ */
/* Native id first: opaque strings + verified issuer namespace          */
/* ------------------------------------------------------------------ */

test('native id keys preserve opaque strings and bind the verified issuer namespace', () => {
  const base = {
    platformId: 'mastodon',
    instance: 'mastodon.social',
    accountKind: 'person' as const,
    homeInstance: 'mastodon.social'
  };
  const keyOf = (nativeId: string, issuer: string | null): string | null =>
    canonicalAccountKey(identity({ ...base, nativeId, nativeIdIssuer: issuer }));

  const seven = keyOf('7', 'api.issuer-a');
  const padded = keyOf('007', 'api.issuer-a');
  const letters = keyOf('ab12cd', 'api.issuer-a');
  const huge = keyOf('90071992547409931234567890', 'api.issuer-a');
  for (const key of [seven, padded, letters, huge]) {
    assert.ok(key && key.startsWith('ssack/1'), 'a verified issuer yields a canonical key');
    assert.ok(key.includes('"mode":"native"'));
  }
  assert.notEqual(seven, padded, 'leading zeros are identity, never Number-normalized');
  assert.ok(padded?.includes('007'), 'leading zeros survive in the key');
  assert.ok(letters?.includes('ab12cd'), 'letters survive in the key');
  assert.ok(huge?.includes('90071992547409931234567890'), 'large opaque ids survive as strings');
  assert.equal(keyOf('007', 'api.issuer-a'), padded, 'same id + issuer + tuple keys equal');

  // Same home instance, same opaque id, DIFFERENT API issuers never merge.
  assert.notEqual(keyOf('007', 'api.issuer-b'), padded, 'issuer namespace is part of identity');
  // Home instance is never the issuer for a remote account.
  assert.notEqual(
    canonicalAccountKey(identity({ ...base, nativeId: '007', nativeIdIssuer: 'mastodon.social' })),
    canonicalAccountKey(identity({ ...base, nativeId: '007', nativeIdIssuer: 'remote.example' })),
    'home host and issuer namespace stay distinct'
  );
});

test('an unverified issuer never claims an issuer and falls back conservatively', () => {
  const withUrl = identity({
    platformId: 'mastodon',
    instance: 'mastodon.social',
    accountKind: 'person',
    nativeId: '4242',
    nativeIdIssuer: null,
    profileUrl: 'https://mastodon.social/@alice'
  });
  const key = canonicalAccountKey(withUrl);
  assert.ok(key, 'conservative URL fallback still keys');
  assert.ok(key.includes('"mode":"url"'), 'unverified ids cannot produce native keys');
  assert.ok(!key.includes('4242'), 'the unresolved id never leaks into the key as an issuer claim');

  // No URL, no verified handle, unverified id: explicit unknown (null), kept as evidence.
  assert.equal(
    canonicalAccountKey(identity({ ...withUrl, profileUrl: null })),
    null,
    'no conservative key exists without a verified issuer'
  );
});

/* ------------------------------------------------------------------ */
/* URL fallback: conservative, public-safe HTTPS only                   */
/* ------------------------------------------------------------------ */

test('URL fallback preserves unknown case, encoded slash, trailing slash, identity query and fragment', () => {
  const keyOfUrl = (profileUrl: string): string | null =>
    canonicalAccountKey(identity({ platformId: 'web', instance: null, accountKind: 'person', profileUrl }));

  const plain = keyOfUrl('https://site.test/u/alice');
  assert.ok(plain && plain.includes('"mode":"url"'));

  assert.notEqual(keyOfUrl('https://site.test/u/Alice'), plain, 'path case is preserved');
  assert.notEqual(keyOfUrl('https://site.test/u/a%2Fb'), keyOfUrl('https://site.test/u/a/b'), 'encoded slash never collapses');
  assert.notEqual(keyOfUrl('https://site.test/u/alice/'), plain, 'trailing slash is identity');
  assert.notEqual(keyOfUrl('https://site.test/u?u=alice'), keyOfUrl('https://site.test/u'), 'identity query is preserved');
  assert.notEqual(keyOfUrl('https://site.test/u#bio'), plain, 'identity fragments stay conservative');
  assert.equal(keyOfUrl('https://SITE.test/u/alice'), plain, 'host case is not identity (documented HTTP semantics)');
  assert.notEqual(keyOfUrl('https://site.test:8443/u/alice'), plain, 'ports stay distinct');

  // Unsafe links never key anything.
  assert.equal(keyOfUrl('http://site.test/u/alice'), null, 'plain http is refused');
  assert.equal(keyOfUrl('https://user:pass@site.test/u/alice'), null, 'credential URLs are refused');
  assert.equal(keyOfUrl('https://site.test/u?api_key=abc'), null, 'credential queries are refused');
});

test('tracking parameters are stripped only by an explicit verified per-platform whitelist', () => {
  const tracked = identity({ platformId: 'blog', profileUrl: 'https://site.test/u?utm_source=x&id=7' });
  const plain = identity({ platformId: 'blog', profileUrl: 'https://site.test/u?id=7' });

  // Default: NO whitelist = NO stripping (nothing is removed without evidence).
  assert.notEqual(canonicalAccountKey(tracked), canonicalAccountKey(plain));

  const rules: AccountKeyRules = {
    caseFoldHandlePlatforms: new Set<string>(),
    trackingParamWhitelist: new Map<string, readonly string[]>([['blog', ['utm_source']]])
  };
  assert.equal(
    canonicalAccountKey(tracked, rules),
    canonicalAccountKey(plain, rules),
    'verified whitelist strips exactly the listed tracking parameter'
  );
  assert.notEqual(
    canonicalAccountKey(identity({ platformId: 'blog', profileUrl: 'https://site.test/u?id=8' }), rules),
    canonicalAccountKey(plain, rules),
    'identity-bearing query parameters are never stripped'
  );
  assert.notEqual(
    canonicalAccountKey({ ...tracked, platformId: 'other' }, rules),
    canonicalAccountKey({ ...plain, platformId: 'other' }, rules),
    'a whitelist never crosses platforms'
  );
});

/* ------------------------------------------------------------------ */
/* Handle fallback: conservative casing, instances, kinds               */
/* ------------------------------------------------------------------ */

test('handle keys keep case by default and fold only with a verified platform rule', () => {
  const keyOf = (handle: string, rules: AccountKeyRules = NO_ACCOUNT_KEY_RULES): string | null =>
    canonicalAccountKey(
      identity({ platformId: 'github', accountKind: 'person', handle, handleVerified: true }),
      rules
    );

  const alice = keyOf('Alice');
  assert.ok(alice && alice.includes('"mode":"handle"'));
  assert.notEqual(keyOf('alice'), alice, 'no default casefold from the platform label');
  assert.equal(keyOf('Alice'), alice);

  const folding: AccountKeyRules = {
    caseFoldHandlePlatforms: new Set<string>(['github']),
    trackingParamWhitelist: new Map()
  };
  assert.equal(keyOf('alice', folding), keyOf('Alice', folding), 'verified case rules may fold');

  // invalid_handle placeholders are never verified handles.
  assert.equal(
    canonicalAccountKey(
      identity({ platformId: 'github', accountKind: 'person', handle: 'invalid_handle', handleVerified: false })
    ),
    null,
    'placeholder handles never produce a key'
  );
  assert.equal(
    canonicalAccountKey(identity({ platformId: 'github', accountKind: 'person', handle: 'Alice', handleVerified: false })),
    null,
    'unverified handles never produce a key'
  );
});

test('instances, ports, subdomains and account kinds stay distinct', () => {
  const keyOf = (instance: string | null, accountKind: DiscoveredAccountIdentity['accountKind']): string | null =>
    canonicalAccountKey(
      identity({ platformId: 'mastodon', instance, accountKind, handle: 'alice', handleVerified: true })
    );
  const main = keyOf('mastodon.social', 'person');
  assert.ok(main);
  assert.notEqual(keyOf('mastodon.social:8443', 'person'), main, 'instance ports are identity');
  assert.notEqual(keyOf('sub.mastodon.social', 'person'), main, 'subdomains are identity');
  assert.notEqual(keyOf('other.social', 'person'), main, 'instances never merge by name similarity');
  for (const kind of ['publication', 'channel', 'organization', 'unknown'] as const) {
    assert.notEqual(keyOf('mastodon.social', kind), main, `${kind} is a distinct account kind`);
  }
});

test('a remote acct handle stays domain-bound and is never treated as an email', () => {
  const remote = canonicalAccountKey(
    identity({
      platformId: 'mastodon',
      instance: 'home.example',
      accountKind: 'person',
      handle: 'alice@remote.example',
      handleVerified: true,
      homeInstance: 'remote.example'
    })
  );
  assert.ok(remote && remote.includes('"mode":"handle"'));
  assert.ok(remote.includes('alice@remote.example'), 'the acct string is preserved as a handle value');
  assert.notEqual(
    remote,
    canonicalAccountKey(
      identity({
        platformId: 'mastodon',
        instance: 'other.example',
        accountKind: 'person',
        handle: 'alice@remote.example',
        handleVerified: true
      })
    ),
    'the observing instance still distinguishes keys'
  );
});

/* ------------------------------------------------------------------ */
/* Association proof and candidate origin merging                       */
/* ------------------------------------------------------------------ */

test('native id and URL identities merge only through verified deterministic association', () => {
  const native = newCandidateDraft(
    identity({
      platformId: 'mastodon',
      instance: 'mastodon.social',
      accountKind: 'person',
      nativeId: '12345',
      nativeIdIssuer: 'mastodon.social:api'
    }),
    [origin('o-native')],
    '2026-09-30T00:00:00.000Z'
  );
  const byUrl = newCandidateDraft(
    identity({
      platformId: 'mastodon',
      instance: 'mastodon.social',
      accountKind: 'person',
      profileUrl: 'https://mastodon.social/@alice'
    }),
    [origin('o-url', { provenance: { ...origin('x').provenance, kind: 'selflink', ruleId: null } })],
    '2026-09-30T00:01:00.000Z'
  );

  assert.notEqual(native.canonicalKey, byUrl.canonicalKey, 'unproven identifiers keep separate keys');
  assert.throws(
    () => mergeCandidateOrigins(native, byUrl),
    (error: unknown) =>
      error instanceof CandidateMergeError && error.reasonCode === 'unproven_association',
    'unproven association never merges'
  );

  const proofNative: DiscoveredAccountIdentity = {
    ...native.identity,
    associationProof: {
      basis: 'same_actor_uri',
      evidenceRef: 'receipt:actor-1',
      nativeIds: [{ id: '12345', issuer: 'mastodon.social:api' }],
      urls: ['https://mastodon.social/@alice']
    }
  };
  const linked = mergeCandidateOrigins(
    newCandidateDraft(proofNative, native.origins, '2026-09-30T00:00:00.000Z'),
    byUrl
  );
  assert.equal(linked.mergeBasis, 'association_proof');
  assert.equal(linked.origins.length, 2, 'all origins survive the association');
  assert.equal(linked.identitySupport.state, 'proposed', 'association is evidence, never identity support');
});

test('merging retains every origin, records conflicts and never inflates selection facets', () => {
  const shared = identity({
    platformId: 'mastodon',
    instance: 'mastodon.social',
    accountKind: 'person',
    nativeId: '777',
    nativeIdIssuer: 'mastodon.social:api'
  });
  const existing = newCandidateDraft(
    shared,
    [
      origin('o-1', { observedAt: '2026-09-30T01:00:00.000Z', locator: 'marker:A', provenance: { ...origin('x').provenance, sourceRefs: ['maigret'] } }),
      origin('o-1b', { observedAt: '2026-09-30T01:00:00.000Z', locator: 'marker:A' })
    ],
    '2026-09-30T01:00:00.000Z'
  );
  // A user already selected this account with reading scope: merges must not reset it.
  existing.userSelection = { state: 'selected', note: 'user pick', recordedAt: '2026-09-30T02:00:00.000Z' };
  existing.allowedScope = { state: 'public_history', note: 'granted' };

  const incoming = newCandidateDraft(
    {
      ...shared,
      profileUrl: 'https://mastodon.social/@other',
      homeInstance: 'remote.example'
    },
    [
      origin('o-1', { observedAt: '2026-09-30T01:00:00.000Z', locator: 'marker:A', provenance: { ...origin('x').provenance, sourceRefs: ['maigret'] } }),
      origin('o-2', {
        observedAt: '2026-09-30T03:00:00.000Z',
        locator: 'marker:B',
        provenance: {
          kind: 'username_probe',
          platformId: 'mastodon',
          routeId: 'route-2',
          ruleId: 'pr-0000000000000002',
          requestKey: 'sdrk/1:other',
          sourceRefs: ['whatsmyname']
        }
      })
    ],
    '2026-09-30T03:00:00.000Z'
  );

  const merged = mergeCandidateOrigins(existing, incoming);
  assert.equal(merged.mergeBasis, 'canonical_key');
  assert.equal(merged.origins.length, 3, 'structural dedupe only — distinct provenance survives');
  const originIds = merged.origins.map((item) => item.originId).sort();
  assert.deepEqual(originIds, ['o-1', 'o-1b', 'o-2']);
  const o2 = merged.origins.find((item) => item.originId === 'o-2');
  assert.equal(o2?.provenance.ruleId, 'pr-0000000000000002', 'independent rule lineage survives');
  assert.deepEqual(o2?.provenance.sourceRefs, ['whatsmyname'], 'independent source origin survives');

  const fields = merged.conflicts.map((conflict) => conflict.field).sort();
  assert.deepEqual(fields, ['homeInstance', 'profileUrl'], 'contradictory actor/home evidence is retained');
  for (const conflict of merged.conflicts) {
    assert.ok(conflict.originIds.length > 0, 'conflicts keep their origin provenance');
  }
  assert.equal(merged.userSelection.state, 'selected', 'existing user selection is never reset');
  assert.equal(merged.allowedScope.state, 'public_history', 'existing scope is never reset');
  assert.equal(merged.identitySupport.state, 'proposed', 'merging never creates identity support');
});

test('new candidate drafts are proposed, unanswered and scope-none', () => {
  const draft = newCandidateDraft(
    identity({ profileUrl: 'https://site.test/u/alice' }),
    [origin('o-1')],
    '2026-09-30T00:00:00.000Z'
  );
  assert.equal(draft.identitySupport.state, 'proposed');
  assert.deepEqual(draft.identitySupport.evidenceIds, []);
  assert.equal(draft.userSelection.state, 'unanswered');
  assert.equal(draft.allowedScope.state, 'none');
  assert.equal(draft.mergeBasis, null);
  assert.deepEqual(draft.conflicts, []);
});

test('same-platform different accounts and cross-platform identities never merge', () => {
  const a = newCandidateDraft(
    identity({ profileUrl: 'https://site.test/u/alice' }),
    [origin('o-a')],
    '2026-09-30T00:00:00.000Z'
  );
  const b = newCandidateDraft(
    identity({ profileUrl: 'https://site.test/u/bob' }),
    [origin('o-b')],
    '2026-09-30T00:00:00.000Z'
  );
  assert.throws(
    () => mergeCandidateOrigins(a, b),
    (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'unproven_association',
    'two same-platform accounts stay separate'
  );

  const crossPlatform = newCandidateDraft(
    identity({ platformId: 'gitlab', profileUrl: 'https://site.test/u/alice' }),
    [origin('o-c')],
    '2026-09-30T00:00:00.000Z'
  );
  assert.throws(
    () => mergeCandidateOrigins(a, crossPlatform),
    (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'platform_conflict',
    'platforms are an identity boundary even for identical URLs'
  );
});

test('contradictory native id evidence is retained as a conflict, never silently resolved', () => {
  const shared = identity({
    platformId: 'mastodon',
    instance: 'mastodon.social',
    accountKind: 'person',
    profileUrl: 'https://mastodon.social/@alice'
  });
  const existing = newCandidateDraft(
    { ...shared, nativeId: '111', nativeIdIssuer: null },
    [origin('o-1')],
    '2026-09-30T00:00:00.000Z'
  );
  const incoming = newCandidateDraft(
    { ...shared, nativeId: '222', nativeIdIssuer: null },
    [origin('o-2')],
    '2026-09-30T01:00:00.000Z'
  );
  const merged = mergeCandidateOrigins(existing, incoming);
  assert.equal(merged.identity.nativeId, '111', 'the primary value is not silently swapped');
  const conflict = merged.conflicts.find((item) => item.field === 'nativeId');
  assert.ok(conflict, 'contradictory ids are retained');
  assert.equal(conflict.existing, '111');
  assert.equal(conflict.incoming, '222');
  assert.equal(merged.origins.length, 2, 'all origins survive contradictions');
});

test('unverified association across native id and URL keeps separate keys even on one home host', () => {
  const issuerA: AccountNativeId = { id: '55', issuer: 'api-a.example' };
  const first = identity({
    platformId: 'mastodon',
    instance: 'shared.example',
    accountKind: 'person',
    nativeId: issuerA.id,
    nativeIdIssuer: issuerA.issuer,
    homeInstance: 'shared.example'
  });
  const second = identity({
    platformId: 'mastodon',
    instance: 'shared.example',
    accountKind: 'person',
    nativeId: '55',
    nativeIdIssuer: 'api-b.example',
    homeInstance: 'shared.example'
  });
  assert.notEqual(canonicalAccountKey(first), canonicalAccountKey(second));
  assert.throws(
    () =>
      mergeCandidateOrigins(
        newCandidateDraft(first, [origin('o-1')], '2026-09-30T00:00:00.000Z'),
        newCandidateDraft(second, [origin('o-2')], '2026-09-30T00:00:00.000Z')
      ),
    (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'unproven_association',
    'same home + same id from different issuers cannot merge'
  );
});

/* ------------------------------------------------------------------ */
/* Independent review regressions (GET-92 repair 1)                    */
/* ------------------------------------------------------------------ */

test('stale or forged canonical keys refuse merges instead of carrying identity onto another account', () => {
  // Source-object mutation must never alias the draft's identity snapshot.
  const mutable = identity({ profileUrl: 'https://site.test/u/a' });
  const draft = newCandidateDraft(mutable, [origin('s-1')], '2026-09-30T00:00:00.000Z');
  mutable.profileUrl = 'https://site.test/u/b';
  assert.equal(draft.identity.profileUrl, 'https://site.test/u/a', 'the draft snapshots identity evidence');

  const merged = mergeCandidateOrigins(draft, newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-2')], '2026-09-30T00:00:00.000Z'));
  assert.equal(merged.identity.profileUrl, 'https://site.test/u/a', 'the merged identity follows the snapshot, not the mutated source');
  assert.equal(merged.mergeBasis, 'canonical_key');
  assert.equal(merged.origins.length, 2);

  // The merged draft is an independent snapshot too.
  const source = identity({ profileUrl: 'https://site.test/u/a' });
  const mergedLater = mergeCandidateOrigins(
    newCandidateDraft(source, [origin('s-3')], '2026-09-30T00:00:00.000Z'),
    newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-4')], '2026-09-30T00:00:00.000Z')
  );
  source.profileUrl = 'https://site.test/u/zzz';
  assert.equal(mergedLater.identity.profileUrl, 'https://site.test/u/a');

  // Direct draft mutation is a stale/forged key and must be refused: the
  // stored key no longer describes the identity it is merged under.
  const direct = newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-5')], '2026-09-30T00:00:00.000Z');
  direct.identity.profileUrl = 'https://site.test/u/b';
  assert.throws(
    () => mergeCandidateOrigins(direct, newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-6')], '2026-09-30T00:00:00.000Z')),
    (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'stale_canonical_key',
    'a mutated draft keeps its stale key and must not merge across accounts'
  );

  // Different profiles without proof still never merge.
  assert.throws(
    () =>
      mergeCandidateOrigins(
        newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-7')], '2026-09-30T00:00:00.000Z'),
        newCandidateDraft(identity({ profileUrl: 'https://site.test/u/b' }), [origin('s-8')], '2026-09-30T00:00:00.000Z')
      ),
    (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'unproven_association'
  );

  // Existing selection and scope survive the snapshot-based merge.
  const existing = newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-9')], '2026-09-30T00:00:00.000Z');
  existing.userSelection = { state: 'selected', note: 'user pick', recordedAt: '2026-09-30T02:00:00.000Z' };
  existing.allowedScope = { state: 'public_history', note: 'granted' };
  existing.identitySupport = {
    state: 'supported',
    evidenceIds: ['ev-1'],
    counterevidenceIds: [],
    policyVersion: 'policy-1',
    note: null
  };
  const kept = mergeCandidateOrigins(existing, newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('s-10')], '2026-09-30T00:00:00.000Z'));
  assert.equal(kept.userSelection.state, 'selected');
  assert.equal(kept.allowedScope.state, 'public_history');
  assert.equal(kept.identitySupport.state, 'supported');
  assert.deepEqual(kept.identitySupport.evidenceIds, ['ev-1']);
});

test('three-stage merges keep both sides historical conflicts, origins and facets', () => {
  const nativeDraft = (nativeId: string, originId: string): CandidateDraft =>
    newCandidateDraft(
      identity({ profileUrl: 'https://site.test/u/a', nativeId, nativeIdIssuer: null }),
      [origin(originId)],
      '2026-09-30T00:00:00.000Z'
    );

  // Forward: existing side is fresh, incoming carries history.
  const incoming = mergeCandidateOrigins(nativeDraft('111', 'h-1'), nativeDraft('222', 'h-2'));
  assert.equal(incoming.conflicts.length, 1);
  const forward = mergeCandidateOrigins(nativeDraft('333', 'h-3'), incoming);
  assert.equal(forward.conflicts.length, 2, 'incoming history survives a forward merge');
  assert.ok(forward.conflicts.some((item) => item.field === 'nativeId' && item.existing === '111' && item.incoming === '222'));
  assert.ok(forward.conflicts.some((item) => item.field === 'nativeId' && item.existing === '333' && item.incoming === '111'));
  assert.equal(forward.origins.length, 3);

  // Backward: existing side is fresh and incoming is the historical merge.
  const backward = mergeCandidateOrigins(nativeDraft('444', 'h-4'), incoming);
  assert.equal(backward.conflicts.length, 2, 'incoming history survives a backward merge');
  assert.equal(backward.origins.length, 3);

  // Deeper chain: actor/home contradictions never disappear in either direction.
  const actorDraft = (actorUrl: string, homeInstance: string, originId: string): CandidateDraft =>
    newCandidateDraft(
      identity({ profileUrl: 'https://site.test/u/a', actorUrl, homeInstance }),
      [origin(originId)],
      '2026-09-30T00:00:00.000Z'
    );
  const first = mergeCandidateOrigins(
    actorDraft('https://a.test/actor/1', 'one.test', 'x-1'),
    actorDraft('https://a.test/actor/2', 'two.test', 'x-2')
  );
  assert.equal(first.conflicts.length, 2);
  const deeper = mergeCandidateOrigins(actorDraft('https://a.test/actor/3', 'three.test', 'x-3'), first);
  assert.equal(deeper.conflicts.length, 4, 'two historical actor/home conflicts plus the two new ones');
  const deepest = mergeCandidateOrigins(deeper, actorDraft('https://a.test/actor/4', 'four.test', 'x-4'));
  assert.equal(deepest.conflicts.length, 6, 'history is never lost across deeper merge stages');
  assert.equal(deepest.origins.length, 4);
  assert.ok(deepest.conflicts.some((item) => item.field === 'actorUrl' && item.incoming === 'https://a.test/actor/2'));
  assert.ok(deepest.conflicts.some((item) => item.field === 'homeInstance' && item.incoming === 'two.test'));
});

test('association proofs need a supported basis, locatable evidence and two-sided exact binding', () => {
  const proofOf = (over: Record<string, unknown> = {}) => ({
    basis: 'provider_identity_mapping',
    evidenceRef: 'receipt:actor-1',
    nativeIds: [{ id: '1', issuer: 'demo:api' }],
    urls: ['https://site.test/u/b'],
    ...over
  });
  const nativeSide = (proof: unknown): CandidateDraft =>
    newCandidateDraft(
      identity({
        nativeId: '1',
        nativeIdIssuer: 'demo:api',
        profileUrl: null,
        associationProof: proof as DiscoveredAccountIdentity['associationProof']
      }),
      [origin('p-1')],
      '2026-09-30T00:00:00.000Z'
    );
  const urlSide = (): CandidateDraft =>
    newCandidateDraft(identity({ profileUrl: 'https://site.test/u/b' }), [origin('p-2')], '2026-09-30T00:00:00.000Z');

  const refused = (proof: unknown, label: string): void => {
    assert.throws(
      () => mergeCandidateOrigins(nativeSide(proof), urlSide()),
      (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'invalid_association_proof',
      label
    );
  };
  refused(proofOf({ evidenceRef: '' }), 'empty evidence ref');
  refused(proofOf({ evidenceRef: '   ' }), 'blank evidence ref');
  refused(proofOf({ basis: 'display_name_similarity' }), 'unsupported basis');
  refused(proofOf({ urls: ['https://site.test/u/other'] }), 'one-sided binding');
  refused(proofOf({ nativeIds: [{ id: '1', issuer: null }] }), 'unverified issuer inside the proof');
  refused(proofOf({ nativeIds: [{ id: '', issuer: 'demo:api' }] }), 'empty native id inside the proof');

  // A genuine trusted same-actor mapping across two API issuers stays positive.
  const crossIssuerProof = {
    basis: 'same_actor_uri' as const,
    evidenceRef: 'receipt:actor-map-1',
    nativeIds: [
      { id: '1', issuer: 'api-a.example' },
      { id: '2', issuer: 'api-b.example' }
    ],
    urls: [] as string[]
  };
  const linked = mergeCandidateOrigins(
    newCandidateDraft(
      identity({ nativeId: '1', nativeIdIssuer: 'api-a.example', profileUrl: null, associationProof: crossIssuerProof }),
      [origin('p-3')],
      '2026-09-30T00:00:00.000Z'
    ),
    newCandidateDraft(
      identity({ nativeId: '2', nativeIdIssuer: 'api-b.example', profileUrl: null }),
      [origin('p-4')],
      '2026-09-30T00:00:00.000Z'
    )
  );
  assert.equal(linked.mergeBasis, 'association_proof');
  assert.equal(linked.origins.length, 2);

  // An invalid proof on a key-equal pair is still refused (evidence hygiene).
  const dirty = identity({ profileUrl: 'https://site.test/u/a' });
  const invalidProof = proofOf({ evidenceRef: '' }) as unknown as DiscoveredAccountIdentity['associationProof'];
  assert.throws(
    () =>
      mergeCandidateOrigins(
        newCandidateDraft({ ...dirty, associationProof: invalidProof }, [origin('p-5')], '2026-09-30T00:00:00.000Z'),
        newCandidateDraft(identity({ profileUrl: 'https://site.test/u/a' }), [origin('p-6')], '2026-09-30T00:00:00.000Z')
      ),
    (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'invalid_association_proof'
  );
});

test('URL identity refuses credential fragments, non-public hosts and non-preserving URLs', () => {
  // Credential-bearing fragment metadata is the same confidentiality
  // boundary as a credential query: it never reaches a key.
  const secretFragment = 'https://site.test/u/alice#access_token=synthetic-not-a-secret';
  assert.equal(canonicalAccountKey(identity({ profileUrl: secretFragment })), null);
  assert.equal(
    canonicalAccountKey(identity({ profileUrl: 'https://site.test/u/alice#refresh_token=synthetic-not-a-secret' })),
    null
  );
  // Harmless identity fragments stay preserved.
  const keyed = canonicalAccountKey(identity({ profileUrl: 'https://site.test/u/alice#bio' }));
  assert.ok(keyed?.includes('#bio'), 'identity fragments are conservative');

  for (const url of [
    'https://localhost/u/alice',
    'https://sub.localhost/u/alice',
    'https://127.0.0.1/u/alice',
    'https://[::1]/u/alice',
    'https://bad host/u/alice',
    'https://site.test/u/\n/alice',
    'https://site.test/u/..',
    'https://site.test/u/./alice'
  ]) {
    assert.equal(canonicalAccountKey(identity({ profileUrl: url })), null, url);
  }
  // Valid public raw bytes survive unchanged (ports, encoded slash, case).
  assert.ok(canonicalAccountKey(identity({ profileUrl: 'https://site.test:8443/u/a%2Fb?x=1&x=2#bio' })));
});


test('candidate URL metadata rejects unsafe native-ID profile, actor and proof URLs before materialization', () => {
  const unsafe = 'https://site.test/u/alice#/callback?access_token=synthetic-not-a-secret';
  const base = identity({ nativeId: '007', nativeIdIssuer: 'api.issuer-a' });
  for (const value of [
    identity({ ...base, profileUrl: unsafe }),
    identity({ ...base, actorUrl: unsafe }),
    identity({ ...base, associationProof: { basis: 'same_actor_uri', evidenceRef: 'receipt:fixture', nativeIds: [], urls: [unsafe] } })
  ]) {
    assert.throws(() => newCandidateDraft(value, [origin('unsafe')], '2026-09-30T00:00:00Z'),
      (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'unsafe_identity_url');
  }
});

test('candidate URL metadata is revalidated during merges even when a native key remains equal', () => {
  const unsafe = 'https://site.test/u/alice#?access_token=synthetic-not-a-secret';
  const base = identity({ nativeId: '007', nativeIdIssuer: 'api.issuer-a', profileUrl: 'https://site.test/u/alice' });
  for (const side of ['existing', 'incoming'] as const) {
    for (const field of ['profileUrl', 'actorUrl', 'proofUrl'] as const) {
      const existing = newCandidateDraft(base, [origin('existing')], '2026-09-30T00:00:00Z');
      const incoming = newCandidateDraft(base, [origin('incoming')], '2026-09-30T00:00:00Z');
      const changed = side === 'existing' ? existing : incoming;
      if (field === 'proofUrl') changed.identity.associationProof = { basis: 'same_actor_uri', evidenceRef: 'receipt:fixture', nativeIds: [], urls: [unsafe] };
      else changed.identity[field] = unsafe;
      assert.throws(() => mergeCandidateOrigins(existing, incoming),
        (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'unsafe_identity_url', `${side}/${field}`);
    }
  }
});

test('candidate URL metadata preserves safe native-ID fragments and unresolved identity evidence', () => {
  const profileUrl = 'https://site.test/u/alice#/bio?tab=posts';
  const actorUrl = 'https://site.test/actors/alice#?tab=profile';
  const value = identity({ nativeId: '007', nativeIdIssuer: 'api.issuer-a', profileUrl, actorUrl });
  const draft = newCandidateDraft(value, [origin('safe')], '2026-09-30T00:00:00Z');
  assert.equal(draft.identity.profileUrl, profileUrl);
  assert.equal(draft.identity.actorUrl, actorUrl);
  assert.equal(draft.canonicalKey, canonicalAccountKey(value));
  const unresolved = newCandidateDraft(identity(), [origin('unresolved')], '2026-09-30T00:00:00Z');
  assert.equal(unresolved.canonicalKey, null);
  assert.equal(unresolved.origins.length, 1);
  assert.equal(unresolved.allowedScope.state, 'none');
});


test('unsafe historical profile and actor URLs refuse merges from either side and value slot', () => {
  const value = identity({ nativeId: '007', nativeIdIssuer: 'api.issuer-a', profileUrl: 'https://site.test/u/alice' });
  for (const side of ['existing', 'incoming'] as const) {
    for (const field of ['profileUrl', 'actorUrl'] as const) {
      for (const slot of ['existing', 'incoming'] as const) {
        const existing = newCandidateDraft(value, [origin('existing')], '2026-09-30T00:00:00Z');
        const incoming = newCandidateDraft(value, [origin('incoming')], '2026-09-30T00:00:00Z');
        const changed = side === 'existing' ? existing : incoming;
        changed.conflicts.push({ field, existing: null, incoming: null, originIds: [side], note: 'historical observation' });
        changed.conflicts[0]![slot] = 'https://site.test/u/alice#access_token=synthetic-not-a-secret';
        assert.throws(() => mergeCandidateOrigins(existing, incoming),
          (error: unknown) => error instanceof CandidateMergeError && error.reasonCode === 'unsafe_identity_url', `${side}/${field}/${slot}`);
      }
    }
  }
});

test('safe historical URL conflicts remain exact and opaque evidence is not treated as a URL', () => {
  const value = identity({ nativeId: '007', nativeIdIssuer: 'api.issuer-a' });
  const existing = newCandidateDraft(value, [origin('existing')], '2026-09-30T00:00:00Z');
  const incoming = newCandidateDraft(value, [origin('incoming')], '2026-09-30T00:00:00Z');
  existing.conflicts.push({ field: 'profileUrl', existing: 'https://site.test/u/alice#/bio?tab=posts', incoming: null, originIds: ['old-a'], note: 'retained profile evidence' });
  incoming.conflicts.push({ field: 'actorUrl', existing: null, incoming: 'https://site.test/actors/alice#?tab=profile', originIds: ['old-b'], note: 'retained actor evidence' });
  incoming.conflicts.push({ field: 'nativeId', existing: 'opaque', incoming: 'ordinary access_token text', originIds: ['old-c'], note: 'opaque identity evidence' });
  const merged = mergeCandidateOrigins(existing, incoming);
  assert.deepEqual(merged.conflicts, [...existing.conflicts, ...incoming.conflicts]);
  assert.deepEqual(merged.userSelection, existing.userSelection);
  assert.deepEqual(merged.allowedScope, existing.allowedScope);
});
