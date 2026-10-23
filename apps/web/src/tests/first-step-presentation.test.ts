/**
 * Pure presentation-contract regressions for the 2026-10-21 account
 * comparison workspace: honest person labels (a page title is never stripped
 * into a name), separated account/handle/host/page-title slots, account-
 * specific clue precedence, and presentation-only filter/search matching.
 *
 * All values are synthetic; no real people, sources or network calls.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountHandleLabel,
  accountMatchesFilter,
  accountMatchesQuery,
  accountRowFor,
  contentClueFor,
  hasInvalidBasis,
  isSettledSupport,
  personLabelFor
} from '../client/first-step-presentation.js';
import type {
  FirstStepAccountView,
  FirstStepDiscoveryView,
  FirstStepPersonClusterView
} from '../shared/first-step-discovery.js';
import type { IdentitySupportState, OwnerAnchor } from '../shared/research-case.js';

function accountView(overrides: Partial<FirstStepAccountView> = {}): FirstStepAccountView {
  return {
    accountId: 'acct-1',
    caseId: 'case-1',
    accountKey: 'key-1',
    platform: 'github',
    platformLabel: 'GitHub',
    displayName: 'fixture-linzhou',
    handle: 'fixture-linzhou',
    instance: null,
    profileUrl: 'https://github.com/fixture-linzhou',
    category: 'identity_work',
    materialUse: 'technical_work',
    accountKind: 'person',
    identity: {
      state: 'supported',
      basis: 'explicit_self_link',
      basisLabel: '公开原文明确链接',
      evidence: [],
      counterevidence: [],
      conflicts: []
    },
    userSelection: { state: 'unanswered', note: null, recordedAt: null },
    allowedScope: { state: 'none', note: null },
    researchValue: { state: 'unassessed', rationale: null },
    accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null },
    researchSummary: '合成研究价值说明',
    accessLabel: '原文可读',
    defaultSuggestion: { suggested: true, reason: '合成建议规则' },
    requiresIndependentScope: false,
    ...overrides
  };
}

function owner(state: OwnerAnchor['state'], personLabel: string): OwnerAnchor {
  return { state, personLabel, policyVersion: 'named-owner/v1', claims: [], counterevidenceIds: [] };
}

function discoveryView(overrides: Partial<FirstStepDiscoveryView> = {}): FirstStepDiscoveryView {
  return {
    schemaVersion: 'stripsearch/first-step-discovery/v1',
    runId: 'run-1',
    caseId: 'case-1',
    discoveryRevision: 1,
    inputRevision: 1,
    registryVersion: 'registry-test/v1',
    catalogHash: null,
    policyVersion: 'first-step/v10',
    phase: 'ready_for_choice',
    stopReason: null,
    readyForChoice: true,
    input: { kind: 'name_query', value: 'Lin Zhou', question: null },
    clusters: [],
    accounts: [],
    relatedLeads: [],
    routes: [],
    gaps: [],
    receipts: [],
    budget: { toolCalls: 0, modelCalls: 0, estimatedUsd: 0, unknownCost: false },
    selection: { scopeVersion: 1, frozenScopeVersion: null, submitted: false, submittedAt: null, selectedAccountIds: [], excludedAccountIds: [] },
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides
  };
}

function cluster(overrides: Partial<FirstStepPersonClusterView> = {}): FirstStepPersonClusterView {
  return {
    clusterId: 'pc-1',
    displayName: 'Lin Zhou',
    anchorUrl: 'https://github.com/fixture-linzhou',
    anchorLabel: 'GitHub · fixture-linzhou',
    anchorAccountId: 'acct-1',
    linkage: 'linked',
    anchorBasis: null,
    leads: [],
    conflicts: [],
    accountIds: ['acct-1'],
    ...overrides
  };
}

test('website host handles remain public entries while dotted social handles stay accounts', () => {
  const website = accountView({ platform: 'personal_site', platformLabel: '个人网站', handle: 'lantern.dev', profileUrl: 'https://lantern.dev/' });
  const siteCluster = cluster({ displayName: 'Lantern public archive', anchorLabel: '个人网站', anchorUrl: website.profileUrl });
  const view = discoveryView({ input: { kind: 'homepage_url', value: website.profileUrl! }, accounts: [website] });
  const entry = personLabelFor(siteCluster, view);
  assert.equal(entry.label, 'lantern.dev');
  assert.equal(entry.kind, 'entry_only');
  assert.doesNotMatch(entry.kindLabel, /handle/);
  assert.equal(entry.pageTitle, 'Lantern public archive');
  const nameQuery = personLabelFor(siteCluster, discoveryView({ accounts: [website] }));
  assert.equal(nameQuery.label, 'Lin Zhou');
  assert.doesNotMatch(nameQuery.label, /^@/);
  const bluesky = accountView({ platform: 'bluesky', handle: 'fixture.bsky.social', profileUrl: 'https://bsky.app/profile/fixture.bsky.social' });
  assert.equal(personLabelFor(cluster(), discoveryView({ input: { kind: 'homepage_url', value: bluesky.profileUrl! }, accounts: [bluesky] })).label, '@fixture.bsky.social');
  const named = { ...website, identity: { ...website.identity, ownerAnchor: owner('self_declared', 'Lin Zhou'), ownerValidity: 'valid' as const } };
  assert.equal(personLabelFor(siteCluster, { ...view, accounts: [named] }).label, 'Lin Zhou');
  const withdrawn = { ...named, identity: { ...named.identity, ownerValidity: 'review' as const } };
  assert.equal(personLabelFor(siteCluster, { ...view, accounts: [withdrawn] }).label, 'lantern.dev');
});

test('a source-backed owner person label is preferred and honestly qualified', () => {
  const anchor = accountView({
    identity: {
      state: 'supported',
      basis: 'explicit_self_link',
      basisLabel: '公开原文明确链接',
      evidence: [],
      counterevidence: [],
      conflicts: [],
      ownerAnchor: owner('self_declared', 'Lin Zhou'),
      ownerValidity: 'valid'
    }
  });
  const view = discoveryView({
    accounts: [anchor],
    clusters: [cluster({ displayName: 'Lin Zhou | Synthetic University' })]
  });
  const label = personLabelFor(view.clusters[0]!, view);
  assert.equal(label.label, 'Lin Zhou', 'the real owner label wins');
  assert.equal(label.kind, 'owner_self_declared');
  assert.equal(label.kindLabel, '账号自述姓名 · 尚未独立验证');
  assert.equal(label.pageTitle, 'Lin Zhou | Synthetic University', 'the literal title stays visible');
});

test('a page title is never stripped into a person name', () => {
  const anchor = accountView({ handle: 'linzhou-uni' });
  const view = discoveryView({
    accounts: [anchor],
    clusters: [cluster({ displayName: 'Lin Zhou | Synthetic University', anchorAccountId: 'acct-1' })]
  });
  const label = personLabelFor(view.clusters[0]!, view);
  assert.equal(label.label, '@linzhou-uni', 'the distinguishing label is the handle, not a cut title');
  assert.doesNotMatch(label.label, /\||Synthetic/, 'no page-title fragment leaks into the name slot');
  assert.equal(label.kindLabel, '按账号 handle 称呼 · 未确认姓名');
  assert.equal(label.pageTitle, 'Lin Zhou | Synthetic University', 'the full title is preserved verbatim');
  // A title that is EXACTLY the query is still only a query match.
  const exact = personLabelFor(cluster({ displayName: 'Lin Zhou' }), discoveryView({ accounts: [anchor], clusters: [cluster({ displayName: 'Lin Zhou' })] }));
  assert.equal(exact.kind, 'query_match');
  assert.equal(exact.kindLabel, '与输入姓名一致 · 尚未确认');
  // Homepage input labels by handle, with the literal title beside it.
  const homepage = personLabelFor(
    cluster({ displayName: 'Fixture Linzhou', anchorAccountId: 'acct-1' }),
    discoveryView({ input: { kind: 'homepage_url', value: 'https://github.com/fixture-linzhou' }, accounts: [accountView()], clusters: [] })
  );
  assert.equal(homepage.kind, 'handle_only');
  assert.equal(homepage.label, '@fixture-linzhou');
  assert.equal(homepage.pageTitle, 'Fixture Linzhou');
});

test('unverified or withdrawn owner anchors never become a source-backed name claim', () => {
  const viewFor = (anchor: Partial<import('../shared/research-case.js').OwnerAnchor> & { state: import('../shared/research-case.js').OwnerAnchor['state'] }, extra: Partial<FirstStepAccountView['identity']> = {}) => {
    const account = accountView({
      handle: 'linzhou-uni',
      identity: {
        state: 'supported', basis: 'explicit_self_link', basisLabel: '公开原文明确链接',
        evidence: [], counterevidence: [], conflicts: [],
        ownerAnchor: owner(anchor.state, anchor.personLabel ?? 'Lin Zhou'), ownerValidity: 'valid',
        ...extra
      }
    });
    return personLabelFor(
      cluster({ displayName: 'Lin Zhou | Synthetic University', anchorAccountId: 'acct-1' }),
      discoveryView({ accounts: [account] })
    );
  };
  for (const state of ['unbound', 'disputed', 'contradicted'] as const) {
    const label = viewFor({ state, personLabel: 'Lin Zhou' });
    assert.notEqual(label.kind, 'owner_self_declared', `${state} must not claim a self-declared name`);
    assert.notEqual(label.kind, 'owner_supported', `${state} must not claim an independently supported name`);
    assert.doesNotMatch(label.kindLabel, /姓名有独立来源支持|账号自述姓名/, `${state} must not read as a source claim`);
    assert.equal(label.kind, 'handle_only');
    assert.equal(label.label, '@linzhou-uni');
    assert.equal(label.pageTitle, 'Lin Zhou | Synthetic University', 'the title is preserved as a title');
  }
  // Review validity and fully withdrawn owner evidence also withdraw the label.
  const review = personLabelFor(
    cluster({ displayName: 'Lin Zhou', anchorAccountId: 'acct-1' }),
    discoveryView({
      accounts: [accountView({
        identity: {
          state: 'supported', basis: 'explicit_self_link', basisLabel: '公开原文明确链接',
          evidence: [], counterevidence: [], conflicts: [],
          ownerAnchor: owner('self_declared', 'Lin Zhou'), ownerValidity: 'review'
        }
      })]
    })
  );
  assert.notEqual(review.kind, 'owner_self_declared');
  const revoked = viewFor(
    { state: 'self_declared', personLabel: 'Lin Zhou' },
    { ownerEvidence: [{ evidenceId: 'oe1', quote: '我叫林舟', sourceUrl: 'https://lantern.dev/about', sourceTitle: '合成 About', revoked: true }] }
  );
  assert.equal(revoked.kind, 'handle_only', 'withdrawn owner evidence cannot back a name claim');
  const revokedRow = accountRowFor(accountView({identity: {
    state: 'supported', basis: 'explicit_self_link', basisLabel: '公开原文明确链接',
    evidence: [], counterevidence: [], conflicts: [],
    ownerAnchor: owner('self_declared', 'Lin Zhou'), ownerValidity: 'valid',
    ownerEvidence: [{evidenceId:'oe1',quote:'我叫林舟',sourceUrl:'https://lantern.dev/about',sourceTitle:'合成 About',revoked:true}]
  }}), [], {requiresIndependentScope:false,submitted:false});
  assert.equal(revokedRow.personLabel, null);
  assert.match(revokedRow.ownerNote!, /已撤回/);
  assert.doesNotMatch(revokedRow.ownerNote!, /自述姓名一致/);
  const backed = viewFor(
    { state: 'self_declared', personLabel: 'Lin Zhou' },
    { ownerEvidence: [{ evidenceId: 'oe2', quote: '我叫林舟', sourceUrl: 'https://lantern.dev/about', sourceTitle: '合成 About', revoked: false }] }
  );
  assert.equal(backed.kind, 'owner_self_declared', 'a live owner quote keeps its honest label');
  assert.equal(backed.kindLabel, '账号自述姓名 · 尚未独立验证');
  // The account row uses the same conservative gate.
  for (const state of ['unbound', 'disputed', 'contradicted'] as const) {
    const row = accountRowFor(accountView({
      identity: {
        state: 'supported', basis: 'explicit_self_link', basisLabel: '公开原文明确链接',
        evidence: [], counterevidence: [], conflicts: [],
        ownerAnchor: owner(state, 'Lin Zhou'), ownerValidity: 'valid'
      }
    }), [], { requiresIndependentScope: false, submitted: false });
    assert.equal(row.personLabel, null, `${state} rows keep the name slot empty instead of claiming a source`);
    assert.equal(row.ownerNote, state === 'unbound' ? '姓名归属尚未核对' : '姓名归属存在冲突，请核对');
  }
});

test('handle, host and page title occupy separate slots', () => {
  const mastodon = accountView({
    platform: 'mastodon', platformLabel: 'Mastodon', handle: 'mira', instance: 'mastodon.social',
    displayName: 'mira', profileUrl: 'https://mastodon.social/@mira'
  });
  const twin = accountView({
    accountId: 'acct-2', accountKey: 'key-2',
    platform: 'mastodon', platformLabel: 'Mastodon', handle: 'mira', instance: 'hachyderm.io',
    displayName: 'mira', profileUrl: 'https://hachyderm.io/@mira'
  });
  assert.equal(accountHandleLabel(mastodon, [mastodon, twin]), '@mira · mastodon.social');
  assert.equal(accountHandleLabel(twin, [mastodon, twin]), '@mira · hachyderm.io');
  const row = accountRowFor(
    accountView({ displayName: 'Lin Zhou | Synthetic University' }),
    [],
    { requiresIndependentScope: false, submitted: false }
  );
  assert.equal(row.handleLabel, '@fixture-linzhou');
  assert.equal(row.hostLabel, 'github.com');
  assert.equal(row.pageTitle, 'Lin Zhou | Synthetic University', 'the literal title is its own slot');
  const entry = personLabelFor(cluster({anchorUrl:'https://lantern.dev/',anchorLabel:'个人公开主页'}), discoveryView({
    input:{kind:'homepage_url',value:'https://lantern.dev/',question:null},
    accounts:[accountView({platform:'personal_site',handle:null,profileUrl:'https://lantern.dev/'})]
  }));
  assert.equal(entry.label,'个人公开主页');
  assert.equal(entry.kind,'entry_only');
  assert.match(entry.kindLabel,/按公开入口称呼/);
  assert.doesNotMatch(entry.kindLabel,/handle/,'a site label must not claim to be an account handle');
});

test('account-specific clues outrank the repetitive generic research summary', () => {
  const generic = accountView();
  assert.deepEqual(contentClueFor(generic), { text: '合成研究价值说明', kind: 'summary' });
  const linked = accountView({ attribution: { relation: 'person_owned', reason: '个人站 Accounts 区明确链接此账号', sources: [], sourceGroups: 1 } });
  assert.equal(contentClueFor(linked).kind, 'linkage');
  assert.equal(contentClueFor(linked).text, '个人站 Accounts 区明确链接此账号');
  const counter = accountView({
    identity: { state: 'proposed', basis: 'shared_handle', basisLabel: '同 handle 线索', evidence: [], counterevidence: [{
      evidenceId: 'e1', sourceId: 's1', sourceRevision: 1, sourceUrl: 'https://lantern.dev/about', sourceTitle: '合成来源',
      sourceLocator: null, sourceRetrievedAt: '2026-10-21T00:00:00.000Z', role: 'identity_counterevidence', quote: null,
      locator: null, retrieval: 'read', label: '明确否认', limitation: '合成限制', observedAt: '2026-10-21T00:00:00.000Z'
    }], conflicts: [] }
  });
  assert.deepEqual(contentClueFor(counter), { text: '存在反证：明确否认', kind: 'counterevidence' });
  const conflicted = accountView({
    identity: { state: 'disputed', basis: 'shared_handle', basisLabel: '同 handle 线索', evidence: [], counterevidence: [], conflicts: ['实际原生 ID 冲突，只能独立研究。'] }
  });
  assert.deepEqual(contentClueFor(conflicted), { text: '实际原生 ID 冲突，只能独立研究。', kind: 'conflict' });
  const invalid = accountView({
    identity: { state: 'supported', validity: 'review', reviewReason: '依据撤回', basis: 'explicit_self_link', basisLabel: '公开原文明确链接', evidence: [], counterevidence: [], conflicts: [] }
  });
  assert.deepEqual(contentClueFor(invalid), { text: '依据撤回', kind: 'invalid' });
  const nativeConflict = accountView({
    identity: { state: 'supported', nativeIdConflict: true, basis: 'explicit_self_link', basisLabel: '公开原文明确链接', evidence: [], counterevidence: [], conflicts: [] }
  });
  assert.equal(contentClueFor(nativeConflict).kind, 'conflict');
});

test('shared attribution boilerplate is not repeated as public-content information', () => {
  const account = accountView({researchSummary:'公开视频与讲解',attribution:{relation:'person_owned',reason:'本人账号关联有目标绑定的原文依据；人物身份与作品作者仍分别核对。',sources:[],sourceGroups:1}});
  assert.deepEqual(contentClueFor(account),{text:'公开视频与讲解',kind:'summary'});
});

test('filter and search predicates match only what the row displays', () => {
  const settled = accountView();
  assert.equal(isSettledSupport(settled), true);
  assert.equal(hasInvalidBasis(settled), false);
  const selected = { selection: 'selected' as const, excluded: false };
  const unchecked = { selection: 'unanswered' as const, excluded: false };
  assert.equal(accountMatchesFilter(settled, selected, 'selected'), true);
  assert.equal(accountMatchesFilter(settled, unchecked, 'selected'), false);
  assert.equal(accountMatchesFilter(settled, { selection: 'selected', excluded: true }, 'selected'), false, 'an exclusion is not a selection');
  const uncertain = accountView({
    identity: { state: 'proposed', basis: 'shared_handle', basisLabel: '同 handle 线索', evidence: [], counterevidence: [], conflicts: [] }
  });
  assert.equal(accountMatchesFilter(uncertain, unchecked, 'needs_check'), true);
  assert.equal(accountMatchesFilter(settled, unchecked, 'needs_check'), false);
  const unbound = accountView({identity:{...settled.identity,ownerAnchor:owner('unbound','Lin Zhou')}});
  assert.equal(accountMatchesFilter(unbound, unchecked, 'needs_check'), true, 'supported account links do not settle an unbound person name');
  const withdrawnOwner = accountView({identity:{...settled.identity,ownerEvidence:[{evidenceId:'oe',quote:'我叫林舟',sourceUrl:'https://lantern.dev/about',sourceTitle:'合成 About',revoked:true}]}});
  assert.equal(accountMatchesFilter(withdrawnOwner, unchecked, 'needs_check'), true);
  assert.equal(accountMatchesFilter(withdrawnOwner, unchecked, 'invalid_basis'), true);
  const revoked = accountView({
    identity: { state: 'revoked', basis: 'explicit_self_link', basisLabel: '公开原文明确链接', evidence: [], counterevidence: [], conflicts: [] }
  });
  assert.equal(accountMatchesFilter(revoked, unchecked, 'invalid_basis'), true);
  assert.equal(accountMatchesFilter(settled, unchecked, 'invalid_basis'), false);
  assert.equal(accountMatchesQuery(settled, 'GITHUB'), true);
  assert.equal(accountMatchesQuery(settled, 'fixture-linzhou'), true);
  assert.equal(accountMatchesQuery(settled, 'github.com'), true);
  assert.equal(accountMatchesQuery(settled, 'mastodon'), false);
  assert.equal(accountMatchesQuery(settled, ''), true);
});
