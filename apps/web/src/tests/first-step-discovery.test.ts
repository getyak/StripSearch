import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessIdentityLink,
  firstStepQueryPlan,
  classifyFirstStepUrl,
  firstStepAccountCategory,
  firstStepAccountIdentity,
  firstStepAccountKey,
  firstStepDefaultSuggestion,
  freezeFirstStepObligations,
  validateClusterChoice,
  validateDecisionCompleteness,
  validateFirstStepSelectionInput,
  validateSelectionDecision,
  FIRST_STEP_DEFAULT_BUDGET,
  FIRST_STEP_SCHEMA_VERSION,
  type FirstStepAccountView,
  type FirstStepLinkObservation,
  type FirstStepRetrieval
} from '../shared/first-step-discovery.js';

function classify(raw: string) {
  const result = classifyFirstStepUrl(raw);
  assert.equal(result.ok, true, `expected ${raw} to classify`);
  return (result as Extract<typeof result, { ok: true }>).ref;
}

test('homepage root and About pages classify as identity anchors, not as dropped non-profiles', () => {
  const home = classify('https://lantern.dev/');
  assert.equal(home.platform, 'personal_site');
  assert.equal(home.materialUse, 'identity_anchor');
  assert.equal(home.entry, 'profile');
  assert.equal(firstStepAccountCategory(home), 'identity_work');

  const about = classify('https://lantern.dev/about');
  assert.equal(about.platform, 'personal_site');
  assert.equal(about.materialUse, 'identity_anchor');
  assert.equal(about.entry, 'profile');

  const nested = classify('https://lantern.dev/works/compiler');
  assert.equal(nested.materialUse, 'related_material');
  assert.equal(nested.entry, 'page');
});

test('GitHub, X and LinkedIn shapes classify with conservative distinct keys', () => {
  const github = classify('https://github.com/linzhou-lantern');
  assert.equal(github.platform, 'github');
  assert.equal(github.handle, 'linzhou-lantern');
  assert.equal(github.entry, 'profile');
  const repo = classify('https://github.com/linzhou-lantern/lantern');
  assert.equal(repo.entry, 'page');
  assert.equal(repo.accountKey, github.accountKey, 'a repo page maps to its account key');

  const x = classify('https://x.com/linzhou_public');
  assert.equal(x.platform, 'x');
  assert.equal(x.handle, 'linzhou_public');
  const xPost = classify('https://x.com/linzhou_public/status/123');
  assert.equal(xPost.entry, 'page');
  assert.equal(xPost.accountKey, x.accountKey);
  // twitter.com and x.com denote the same referent.
  assert.equal(classify('https://twitter.com/linzhou_public').accountKey, x.accountKey);

  const linkedin = classify('https://www.linkedin.com/in/linzhou/');
  assert.equal(linkedin.platform, 'linkedin');
  assert.equal(linkedin.accountKind, 'person');
  const company = classify('https://www.linkedin.com/company/lantern');
  assert.equal(company.accountKind, 'organization');
  assert.notEqual(company.accountKey, linkedin.accountKey);
});

test('YouTube @handle and channel-ID forms classify and never merge without evidence', () => {
  const at = classify('https://www.youtube.com/@linzhou-talks');
  assert.equal(at.platform, 'youtube');
  assert.equal(at.handle, 'linzhou-talks');
  assert.equal(at.accountKind, 'channel');
  assert.equal(at.entry, 'profile');

  const channel = classify('https://www.youtube.com/channel/UCsynthetic00000000000000');
  assert.equal(channel.stableId, 'UCsynthetic00000000000000');
  assert.equal(channel.entry, 'profile');
  // A handle key and a channel-id key stay distinct: no handle→id guessing.
  assert.notEqual(channel.accountKey, at.accountKey);

  const video = classify('https://www.youtube.com/watch?v=abc123');
  assert.equal(video.entry, 'page');
});

test('Substack publication, Medium author and Mastodon instance profiles classify with instance preserved', () => {
  const pub = classify('https://lantern-notes.substack.com/');
  assert.equal(pub.platform, 'substack');
  assert.equal(pub.accountKind, 'publication');
  assert.equal(pub.handle, 'lantern-notes');
  assert.equal(pub.instance, 'lantern-notes.substack.com');
  assert.equal(firstStepAccountCategory(pub), 'writing');

  const post = classify('https://lantern-notes.substack.com/p/on-lantern');
  assert.equal(post.entry, 'page');
  assert.equal(post.accountKey, pub.accountKey);

  const medium = classify('https://medium.com/@linzhou');
  assert.equal(medium.platform, 'medium');
  assert.equal(medium.handle, 'linzhou');

  const mastodon = classify('https://hachyderm.io/@linzhou');
  assert.equal(mastodon.platform, 'mastodon');
  assert.equal(mastodon.instance, 'hachyderm.io');
  assert.equal(mastodon.handle, 'linzhou');
  // Same handle on another instance is a different account.
  const other = classify('https://mastodon.social/@linzhou');
  assert.notEqual(other.accountKey, mastodon.accountKey);
  assert.equal(other.instance, 'mastodon.social');

  // substack.com/@user is a Substack profile, not a Mastodon instance account.
  const substackProfile = classify('https://substack.com/@linzhou');
  assert.equal(substackProfile.platform, 'substack');
});

test('Google Scholar user pages classify by stable user id', () => {
  const scholar = classify('https://scholar.google.com/citations?hl=en&user=AbC123XyZ&pagesize=20');
  assert.equal(scholar.platform, 'google_scholar');
  assert.equal(scholar.stableId, 'AbC123XyZ');
  assert.equal(scholar.materialUse, 'academic');
  assert.equal(scholar.entry, 'profile');
  const same = classify('https://scholar.google.com/citations?user=AbC123XyZ');
  assert.equal(same.accountKey, scholar.accountKey);
  const listing = classify('https://scholar.google.com/citations?hl=en&view_op=search_authors');
  assert.equal(listing.entry, 'page');
});

test('same-platform multiple accounts stay distinct and unsafe URLs are rejected', () => {
  const a = classify('https://github.com/linzhou');
  const b = classify('https://github.com/linzhou-lantern');
  assert.notEqual(a.accountKey, b.accountKey);
  // Verified account-key rules never case-fold without evidence: a case-variant
  // URL stays a distinct conservative key instead of merging on similarity.
  assert.notEqual(classify('https://github.com/LINZHOU').accountKey, a.accountKey);
  // But the same referent under one platform's verified URL shape does merge.
  assert.equal(classify('https://github.com/linzhou/issues/1').accountKey, a.accountKey);

  for (const bad of [
    'http://lantern.dev/',
    'https://127.0.0.1/about',
    'https://localhost/x',
    'https://user:pass@lantern.dev/',
    'https://lantern.dev:8443/',
    'https://internal.example.invalid/',
    'https://example.org/person-alpha',
    'not a url',
    'file:///etc/passwd'
  ]) {
    const result = classifyFirstStepUrl(bad);
    assert.equal(result.ok, false, `expected ${bad} to be rejected`);
    assert.ok(result.ok === false && (result.code === 'unsafe_url' || result.code === 'not_a_url'));
  }
  // The raw URL text is never rewritten into a fetchable form by classification.
  assert.equal(classifyFirstStepUrl(' https://lantern.dev/about ').ok, true);
});

function observation(over: Partial<FirstStepLinkObservation> & { observationId: string }): FirstStepLinkObservation {
  return {
    sourceId: 'SRC1',
    sourceRevision: 1,
    sourceUrl: 'https://lantern.dev/about',
    sourceContentHash: 'a'.repeat(64),
    sourceRetrievedAt: '2026-10-05T00:00:00.000Z',
    fromAccountKey: 'anchor',
    targetAccountKey: 'target',
    targetUrl: 'https://x.com/linzhou_public',
    linkRole: 'self_account_section',
    direction: 'outbound',
    retrieval: 'read',
    quote: 'Accounts: @linzhou_public',
    locator: 'Accounts 区',
    observedAt: '2026-10-05T00:00:00.000Z',
    ...over
  };
}

test('only explicit role-correct associations read from a source support identity', () => {
  const supported = assessIdentityLink('target', [
    observation({ observationId: 'o1', linkRole: 'self_account_section', retrieval: 'read' })
  ]);
  assert.equal(supported.state, 'supported');
  assert.equal(supported.basis, 'explicit_self_link');
  assert.equal(supported.independentSources, 1);

  for (const weak of [
    observation({ observationId: 'w1', linkRole: 'prose_mention', retrieval: 'read' }),
    observation({ observationId: 'w2', linkRole: 'self_account_section', retrieval: 'indexed' }),
    observation({ observationId: 'w3', linkRole: 'self_account_section', retrieval: 'link_only' }),
    observation({ observationId: 'w4', linkRole: 'explicit_claim', retrieval: 'indexed' })
  ] as FirstStepLinkObservation[]) {
    const assessed = assessIdentityLink('target', [weak]);
    assert.notEqual(assessed.state, 'supported', `weak observation ${weak.observationId} must not support identity`);
    assert.equal(assessed.supportObservationIds.length, 0);
    assert.ok(assessed.candidateObservationIds.includes(weak.observationId) || assessed.counterevidenceObservationIds.includes(weak.observationId));
  }
});

test('same-source repeats never count as independent evidence and denials keep accounts disputed', () => {
  const doubled = assessIdentityLink('target', [
    observation({ observationId: 'd1', sourceId: 'SRC1', linkRole: 'self_account_section' }),
    observation({ observationId: 'd2', sourceId: 'SRC1', linkRole: 'explicit_directory' })
  ]);
  assert.equal(doubled.independentSources, 1, 'one source is one basis');
  assert.equal(doubled.state, 'supported');

  const twoPagesOneAccount = assessIdentityLink('target', [
    observation({ observationId: 'e1', sourceId: 'SRC1', linkRole: 'self_account_section' }),
    observation({ observationId: 'e2', sourceId: 'SRC2', linkRole: 'explicit_directory' })
  ]);
  assert.equal(twoPagesOneAccount.independentSources, 1, 'two pages of one source account are one basis');

  const twoAccounts = assessIdentityLink('target', [
    observation({ observationId: 'e3', sourceId: 'SRC1', fromAccountKey: 'anchor', linkRole: 'self_account_section' }),
    observation({ observationId: 'e4', sourceId: 'SRC4', fromAccountKey: 'other-site', linkRole: 'explicit_directory' }),
    observation({ observationId: 'e5', sourceId: 'SRC5', fromAccountKey: null, linkRole: 'explicit_directory' })
  ]);
  assert.equal(twoAccounts.independentSources, 3, 'distinct source accounts/pages are distinct bases');

  const disputed = assessIdentityLink('target', [
    observation({ observationId: 'f1', linkRole: 'self_account_section' }),
    observation({ observationId: 'f2', sourceId: 'SRC9', linkRole: 'explicit_denial', quote: '不是我' })
  ]);
  assert.equal(disputed.state, 'disputed');
  assert.deepEqual(disputed.counterevidenceObservationIds, ['f2']);

  // An ordinary mention with a denial ROLE label is not a denial: real
  // negative association text is required.
  const fakeDenial = assessIdentityLink('target', [observation({ observationId: 'g0', linkRole: 'explicit_denial' })]);
  assert.equal(fakeDenial.state, 'proposed', 'role labels cannot fabricate denials');
  assert.deepEqual(fakeDenial.counterevidenceObservationIds, []);

  const rejected = assessIdentityLink('target', [observation({ observationId: 'g1', linkRole: 'explicit_denial', quote: '不是我，请勿混淆。' })]);
  assert.equal(rejected.state, 'rejected');
});

function accountView(over: Partial<FirstStepAccountView>): FirstStepAccountView {
  return {
    accountId: 'acc1',
    caseId: 'case1',
    accountKey: 'k',
    platform: 'x',
    platformLabel: 'X',
    displayName: null,
    handle: 'linzhou_public',
    instance: null,
    profileUrl: 'https://x.com/linzhou_public',
    category: 'expression',
    materialUse: 'expression',
    accountKind: 'person',
    identity: {
      state: 'supported',
      basis: 'explicit_self_link',
      basisLabel: '本人公开页面明确链接',
      evidence: [],
      counterevidence: [],
      conflicts: []
    },
    userSelection: { state: 'unanswered', note: null, recordedAt: null },
    allowedScope: { state: 'none', note: null },
    researchValue: { state: 'unassessed', rationale: null },
    accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null },
    researchSummary: '公开短文与讨论',
    accessLabel: '原文可读',
    defaultSuggestion: { suggested: false, reason: '' },
    requiresIndependentScope: false,
    ...over
  };
}

test('default suggestions require real support, no conflict and an allowed account kind', () => {
  const assessment = assessIdentityLink('target', [
    observation({ observationId: 's1', linkRole: 'self_account_section' })
  ]);
  const suggested = firstStepDefaultSuggestion(assessment, 'person', { readable: true, note: null });
  assert.equal(suggested.suggested, true);
  const limited = firstStepDefaultSuggestion(assessment, 'person', { readable: false, note: '仅索引可见' });
  assert.equal(limited.suggested, true);
  assert.match(limited.reason, /受限/);

  const org = firstStepDefaultSuggestion(assessment, 'organization', { readable: true, note: null });
  assert.equal(org.suggested, false);

  const weak = assessIdentityLink('target', [observation({ observationId: 's2', linkRole: 'prose_mention' })]);
  assert.equal(firstStepDefaultSuggestion(weak, 'person', { readable: true, note: null }).suggested, false);

  const conflict = assessIdentityLink('target', [
    observation({ observationId: 's3', linkRole: 'self_account_section' }),
    observation({ observationId: 's4', sourceId: 'SRC8', linkRole: 'explicit_denial', quote: '不是我' })
  ]);
  assert.equal(firstStepDefaultSuggestion(conflict, 'person', { readable: true, note: null }).suggested, false);
});

test('selection input validation rejects duplicates, conflicts and missing versions', () => {
  const good = validateFirstStepSelectionInput({
    expectedRunRevision: 3,
    expectedScopeVersion: 1,
    discoveryRevision: 2,
    clusterId: 'cluster-1',
    accounts: [
      { accountId: 'a1', selection: 'selected', excluded: false },
      { accountId: 'a2', selection: 'not_selected', excluded: true, note: '不是此人' }
    ]
  });
  assert.equal(good.ok, true);
  assert.ok(good.ok && good.input.accounts.length === 2);

  assert.equal(validateFirstStepSelectionInput(null).ok, false);
  assert.equal(
    validateFirstStepSelectionInput({ expectedRunRevision: 1, expectedScopeVersion: 1, discoveryRevision: 1, clusterId: null, accounts: [] }).ok,
    true,
    'zero selection is expressible; policy decides what it means'
  );
  assert.equal(
    validateFirstStepSelectionInput({
      expectedRunRevision: 1,
      expectedScopeVersion: 1,
      discoveryRevision: 1,
      clusterId: null,
      accounts: [{ accountId: 'a1', selection: 'selected' }, { accountId: 'a1', selection: 'not_selected' }]
    }).ok,
    false,
    'duplicates rejected'
  );
  assert.equal(
    validateFirstStepSelectionInput({
      expectedRunRevision: 1,
      expectedScopeVersion: 1,
      discoveryRevision: 1,
      clusterId: null,
      accounts: [{ accountId: 'a1', selection: 'selected', excluded: true }]
    }).ok,
    false,
    'exclude + select rejected'
  );
  assert.equal(
    validateFirstStepSelectionInput({
      expectedRunRevision: -1,
      expectedScopeVersion: 1,
      discoveryRevision: 1,
      clusterId: null,
      accounts: []
    }).ok,
    false
  );
});

test('uncertain accounts need independent scope and selection never upgrades identity', () => {
  const uncertain = accountView({
    identity: { state: 'proposed', basis: 'shared_handle', basisLabel: '仅有相同 handle 线索', evidence: [], counterevidence: [], conflicts: [] }
  });
  assert.equal(validateSelectionDecision(uncertain, { accountId: 'acc1', selection: 'selected', excluded: false, note: null }).ok, false);
  const independent = validateSelectionDecision(uncertain, { accountId: 'acc1', selection: 'only_this_account', excluded: false, note: null });
  assert.equal(independent.ok, true);
  assert.ok(independent.ok && independent.allowedScope === 'public_history');

  const supported = accountView({});
  const joined = validateSelectionDecision(supported, { accountId: 'acc1', selection: 'selected', excluded: false, note: null });
  assert.equal(joined.ok, true);

  const rejected = accountView({
    identity: { state: 'rejected', basis: 'explicit_denial', basisLabel: '原文明确否认关联', evidence: [], counterevidence: [], conflicts: [] }
  });
  assert.equal(validateSelectionDecision(rejected, { accountId: 'acc1', selection: 'only_this_account', excluded: false, note: null }).ok, false);

  // Unchecking is not a denial; a denial excludes research but records intent only.
  const unchecked = validateSelectionDecision(supported, { accountId: 'acc1', selection: 'not_selected', excluded: false, note: null });
  assert.equal(unchecked.ok, true);
  assert.ok(unchecked.ok && unchecked.allowedScope === 'none');
});

test('initial obligations are frozen before IO and never enumerate the whole catalog', () => {
  const plan = freezeFirstStepObligations(
    { kind: 'name_query', value: '林舟', question: '研究这位创作者的公开作品' },
    { registryVersion: 'registry-test/v1', now: '2026-10-05T00:00:00.000Z' }
  );
  assert.equal(plan.frozenAt, '2026-10-05T00:00:00.000Z');
  assert.equal(plan.policyVersion, 'first-step/v6');
  const triggers = new Set(plan.obligations.map((o) => o.trigger));
  assert.ok(triggers.has('initial_wave'));
  assert.ok(plan.obligations.length >= 5 && plan.obligations.length <= 12, 'a bounded initial wave, not 4421 rules');
  // Generic v4 budget: at most 11 queries / 12 results / 16 identity reads /
  // 2 model calls; operator limits always dominate these defaults.
  assert.equal(plan.budget.maxSearchQueries, 11);
  assert.equal(plan.budget.maxSearchResults, 12);
  assert.equal(plan.budget.maxProfileReads, 16);
  assert.equal(plan.budget.maxModelCalls, 2);
  const platforms = new Set(plan.obligations.map((o) => o.platform));
  assert.ok(platforms.has('web_search'));
  assert.ok(platforms.has('github'));
  assert.ok(platforms.has('x'));
  assert.ok(platforms.has('google_scholar'), 'declared routes stay visible even without adapters');

  // A URL input still freezes the same confirmation-first obligations.
  const urlPlan = freezeFirstStepObligations(
    { kind: 'homepage_url', value: 'https://lantern.dev/' },
    { registryVersion: 'registry-test/v1', now: '2026-10-05T00:00:00.000Z' }
  );
  assert.equal(urlPlan.obligations.length, plan.obligations.length);
});

test('catalog platform forms classify: bsky profiles, Instagram, YouTube tabs, Bilibili spaces, Threads and Facebook', () => {
  const bsky = classify('https://bsky.app/profile/author.dev');
  assert.equal(bsky.platform, 'bluesky');
  assert.equal(bsky.handle, 'author.dev');
  assert.equal(bsky.entry, 'profile');
  const bskyPost = classify('https://bsky.app/profile/author.dev/post/abc');
  assert.equal(bskyPost.entry, 'page');
  assert.equal(bskyPost.accountKey, bsky.accountKey);

  const ig = classify('https://www.instagram.com/public_author/');
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.handle, 'public_author');
  assert.equal(ig.entry, 'profile');
  const igPost = classify('https://www.instagram.com/p/xyz/');
  assert.equal(igPost.entry, 'page');

  const ytTab = classify('https://www.youtube.com/@PublicAuthor/videos');
  assert.equal(ytTab.platform, 'youtube');
  assert.equal(ytTab.handle, 'PublicAuthor');
  assert.equal(ytTab.entry, 'profile');
  assert.equal(ytTab.accountKey, classify('https://www.youtube.com/@PublicAuthor').accountKey);

  const space = classify('https://space.bilibili.com/123456');
  assert.equal(space.platform, 'bilibili');
  assert.equal(space.stableId, '123456');
  assert.equal(space.entry, 'profile');
  assert.equal(classify('https://www.bilibili.com/space/123456').accountKey, space.accountKey);

  const threads = classify('https://www.threads.net/@public_author');
  assert.equal(threads.platform, 'threads');
  assert.equal(threads.handle, 'public_author');
  assert.equal(threads.entry, 'profile');

  const facebook = classify('https://www.facebook.com/some.profile');
  assert.equal(facebook.platform, 'facebook');
  assert.equal(facebook.handle, 'some.profile');
  assert.equal(facebook.entry, 'profile');
  assert.equal(classify('https://www.facebook.com/groups/123').entry, 'page');

  // Arbitrary /users or /u paths are never guessed into Mastodon accounts.
  const forum = classify('https://forum.example-net.dev/u/alice');
  assert.equal(forum.platform !== 'mastodon', true, 'no Mastodon guessing on arbitrary /u paths');
  const mastodon = classify('https://hachyderm.io/@linzhou');
  assert.equal(mastodon.platform, 'mastodon');
});

test('schema version is stable and account keys reuse the verified GET-92 ladder', async () => {
  assert.equal(FIRST_STEP_SCHEMA_VERSION, 'stripsearch/first-step-discovery/v1');
  const gh = firstStepAccountKey({ platform: 'github', instance: null, accountKind: 'person', handle: 'linzhou', accountUrl: 'https://github.com/linzhou' });
  const x = firstStepAccountKey({ platform: 'x', instance: null, accountKind: 'person', handle: 'linzhou', accountUrl: 'https://x.com/linzhou' });
  assert.notEqual(gh, x, 'never cross-platform');
  assert.match(gh, /^ssack\/1:/);
  // The shared projection must equal the verified server-side canonical key.
  const { canonicalAccountKey } = await import('../server/discovery/account-key.js');
  for (const url of ['https://lantern.dev/', 'https://github.com/linzhou', 'https://x.com/linzhou', 'https://hachyderm.io/@linzhou']) {
    const ref = classify(url);
    assert.equal(firstStepAccountKey(ref), canonicalAccountKey(firstStepAccountIdentity(ref)), `key mismatch for ${url}`);
  }
});

void (async () => {
  // Type-level guard: the retrieval union is part of the shared contract.
  const retrievals: FirstStepRetrieval[] = ['read', 'indexed', 'link_only'];
  assert.equal(retrievals.length, 3);
})();

test('explicit claims need stored quotes; indexed claims/denials never become original evidence', () => {
  const quoteless = assessIdentityLink('target', [
    observation({ observationId: 'q1', linkRole: 'explicit_claim', quote: null })
  ]);
  assert.equal(quoteless.state, 'proposed', 'a role label without a stored quote invents no support');
  assert.equal(quoteless.supportObservationIds.length, 0);

  const quoted = assessIdentityLink('target', [
    observation({ observationId: 'q2', linkRole: 'explicit_claim', quote: '这个账号是我的官方主页。' })
  ]);
  assert.equal(quoted.state, 'supported');

  const indexedClaim = assessIdentityLink('target', [
    observation({ observationId: 'q3', linkRole: 'explicit_claim', retrieval: 'indexed', quote: '搜索摘要里的自称' })
  ]);
  assert.equal(indexedClaim.state, 'proposed', 'indexed claims are never original evidence');
  assert.deepEqual(indexedClaim.candidateObservationIds, ['q3']);

  const indexedDenial = assessIdentityLink('target', [
    observation({ observationId: 'q4', linkRole: 'explicit_denial', retrieval: 'indexed', quote: '搜索摘要里的否认' })
  ]);
  assert.equal(indexedDenial.counterevidenceObservationIds.length, 0, 'indexed denials are not promoted either');
  assert.equal(indexedDenial.state, 'proposed');

  const quotedDenial = assessIdentityLink('target', [
    observation({ observationId: 'q5', linkRole: 'explicit_denial', quote: '不是我' })
  ]);
  assert.equal(quotedDenial.state, 'rejected');
});

test('one inbound link is never mislabeled as mutual linking', () => {
  const inbound = assessIdentityLink('target', [
    observation({ observationId: 'm1', linkRole: 'self_account_section', direction: 'inbound' })
  ]);
  assert.equal(inbound.state, 'proposed', 'an inbound observation alone is not identity support');
  assert.equal(inbound.basis !== 'mutual_link', true);

  const outbound = assessIdentityLink('target', [
    observation({ observationId: 'm2', linkRole: 'self_account_section', direction: 'outbound' })
  ]);
  assert.equal(outbound.state, 'supported');
  assert.equal(outbound.basis, 'explicit_self_link');
});

test('decision completeness and cluster choice enforce full-state batches and cluster binding', () => {
  const accountA = accountView({ accountId: 'a1' });
  const accountB = accountView({ accountId: 'a2' });
  const accounts = [accountA, accountB];
  assert.equal(validateDecisionCompleteness(accounts, [{ accountId: 'a1', selection: 'selected', excluded: false, note: null }]).ok, false);
  assert.equal(
    validateDecisionCompleteness(accounts, [
      { accountId: 'a1', selection: 'selected', excluded: false, note: null },
      { accountId: 'a2', selection: 'not_selected', excluded: false, note: null }
    ]).ok,
    true
  );

  const clusters = [
    { clusterId: 'c1', displayName: 'A', anchorUrl: null, anchorLabel: '', leads: [], conflicts: [], accountIds: ['a1'] },
    { clusterId: 'c2', displayName: 'B', anchorUrl: null, anchorLabel: '', leads: [], conflicts: [], accountIds: ['a2'] }
  ];
  const joinedA = [{ accountId: 'a1', selection: 'selected' as const, excluded: false, note: null }];
  assert.equal(validateClusterChoice(clusters, accounts, joinedA, 'missing').ok, false, 'nonexistent cluster rejected');
  assert.equal(validateClusterChoice(clusters, accounts, joinedA, null).ok, false, 'same-person join needs a bound cluster');
  assert.equal(validateClusterChoice(clusters, accounts, joinedA, 'c1').ok, true);
  const crossCluster = [
    { accountId: 'a1', selection: 'selected' as const, excluded: false, note: null },
    { accountId: 'a2', selection: 'selected' as const, excluded: false, note: null }
  ];
  assert.equal(validateClusterChoice(clusters, accounts, crossCluster, 'c1').ok, false, 'no same-name cross-cluster merge');

  const independentOnly = validateClusterChoice(clusters, accounts, [
    { accountId: 'a2', selection: 'only_this_account' as const, excluded: false, note: null },
    { accountId: 'a1', selection: 'not_selected' as const, excluded: false, note: null }
  ], null);
  assert.equal(independentOnly.ok, true);
  assert.ok(independentOnly.ok && independentOnly.independentAccountIds.length === 1);
  assert.ok(independentOnly.ok && independentOnly.joinedAccountIds.length === 0);
});

test('evidence projections carry inspectable source metadata and never invent facts', () => {
  const supported = assessIdentityLink('target', [
    observation({ observationId: 's5', linkRole: 'explicit_directory', quote: '目录：“Accounts”列出 @target' })
  ]);
  assert.equal(supported.state, 'supported');
  const view = accountView({
    identity: {
      state: 'supported',
      basis: supported.basis,
      basisLabel: '公开链接目录明确列出',
      evidence: [
        {
          evidenceId: 'ev1',
          sourceId: 'src1',
          sourceRevision: 1,
          sourceUrl: 'https://lantern.dev/about',
          sourceTitle: '合成 About',
          sourceLocator: 'Accounts 区',
          sourceRetrievedAt: '2026-10-05T00:00:00.000Z',
          role: 'identity_support',
          quote: '目录：“Accounts”列出 @target',
          locator: 'Accounts 区',
          retrieval: 'read',
          label: '本人页面明确链接',
          limitation: '作者自述；不代表跨平台身份已核实。',
          observedAt: '2026-10-05T00:00:00.000Z'
        }
      ],
      counterevidence: [],
      conflicts: []
    }
  });
  const evidence = view.identity.evidence[0]!;
  assert.equal(evidence.sourceUrl, 'https://lantern.dev/about');
  assert.equal(evidence.sourceTitle, '合成 About');
  assert.ok(evidence.quote && evidence.quote.length > 0);
  assert.ok(evidence.limitation.length > 0);
});


test('mixed-script input uses its supplied Latin name in constrained searches without inventing handles', () => {
 const input={kind:'name_query' as const,value:'张晓 Ming Zhang'};
 const queries=firstStepQueryPlan(input,FIRST_STEP_DEFAULT_BUDGET);
 assert.equal(input.value,'张晓 Ming Zhang');
 assert.ok(queries.some(q=>q.includeDomains?.includes('x.com')&&q.query==='Ming Zhang Twitter X profile'));
 assert.ok(queries.every(q=>!q.query.includes('@')));
});

test('unknown at-sign profile URLs never imply Mastodon software or a verified platform route',()=>{
 const profile=classify('https://synthetic-academic.org/@fixture-author');
 assert.equal(profile.platform,'web_page');assert.equal(profile.entry,'profile');assert.equal(profile.handle,'fixture-author');assert.equal(profile.platformLabel,'公开网页');
 const post=classify('https://synthetic-academic.org/@fixture-author/posts/123');assert.equal(post.entry,'page');assert.equal(post.accountKey,profile.accountKey);
 assert.equal(classify('https://mastodon.social/@fixture-author').platform,'mastodon');
});
