/**
 * GET-59 Search 8 / Fetch 10 tool contract tests.
 *
 * These tests drive the production dispatcher through fake ports and a real
 * SQLite CaseStore (evidence reads), with synthetic offline fixtures only.
 * Expected tool name arrays below are fixed literals, independent of the
 * registry, so the registry can never validate itself.
 *
 * Covered: exact role x phase matrix (verify is a Fetch phase, not a role);
 * injected privilege/account/scope/cursor/capability refusals; revoked and
 * pinned-history evidence on the real store; async late scope change,
 * withdrawal and cancellation; skill pin mismatch; pending-only findings and
 * verify-phase isolation; required per-item output metadata and invalid
 * handler responses; per-request accounting order/count, partial failure,
 * unknown fee, budget refusal and settlement-failure fail-stop; real Store
 * scope drift and submission commit-time races.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import {
  TOOL_NAMES,
  loadSkillOutputV,
  envelopeV,
  toolAllowedFor,
  type ContentMetadata,
  type ToolEnvelope,
  type ToolName
} from '../server/research/research-tool-contracts.js';
import {
  BudgetRefusedError,
  SubmissionRejectedError,
  createOpaqueCursorPort,
  createPinnedSkillManifestPort,
  createResearchToolServer,
  createStoreFreshStatePort,
  dispatch,
  type AccountingPort,
  type CaseStateSnapshot,
  type ControllerCommitContext,
  type EvidenceReadPort,
  type FreshStatePort,
  type MeteredRequestDescriptor,
  type PendingFindingCommit,
  type ProviderExecutorPort,
  type ProviderResponse,
  type RequestOutcome,
  type RequestReservation,
  type ResearchToolPorts,
  type ToolHandler,
  type TrustedContext,
  type UsageSummary
} from '../server/research/research-tool-dispatch.js';

/* ------------------------------------------------------------------ */
/* Fixed independent expectations (never derived from the registry)     */
/* ------------------------------------------------------------------ */

const EXPECTED_SHARED = ['get_platform_capabilities', 'load_skill', 'read_evidence'];
const EXPECTED_SEARCH_ONLY = ['discover_accounts', 'read_profile', 'request_confirmation', 'search_web', 'submit_candidates'];
const EXPECTED_FETCH_ONLY = ['list_comments', 'list_posts', 'read_media', 'read_post', 'read_thread', 'report_progress', 'save_findings'];
const EXPECTED_VERIFY_ALLOWLIST = ['load_skill', 'read_evidence', 'save_findings'];

/** Allowed role:phase pairs per tool, authored independently of the code. */
const EXPECTED_MATRIX: Record<string, string[]> = {
  get_platform_capabilities: ['search:search', 'fetch:fetch'],
  load_skill: ['search:search', 'fetch:fetch', 'fetch:verify'],
  read_evidence: ['search:search', 'fetch:fetch', 'fetch:verify'],
  discover_accounts: ['search:search'],
  read_profile: ['search:search'],
  request_confirmation: ['search:search'],
  search_web: ['search:search'],
  submit_candidates: ['search:search'],
  list_comments: ['fetch:fetch'],
  list_posts: ['fetch:fetch'],
  read_media: ['fetch:fetch'],
  read_post: ['fetch:fetch'],
  read_thread: ['fetch:fetch'],
  report_progress: ['fetch:fetch'],
  save_findings: ['fetch:fetch', 'fetch:verify']
};

const sorted = (values: string[]) => [...values].sort();

/* ------------------------------------------------------------------ */
/* Offline fixtures                                                    */
/* ------------------------------------------------------------------ */

const OWNER = 'owner-fixture';
const CASE = 'case-fixture';

function okMetadata(over: Partial<Extract<ContentMetadata, { applicable: true }>> = {}): ContentMetadata {
  return {
    applicable: true,
    author: 'Synthetic Author',
    originalUrl: 'https://fixture.test/item',
    publishedAt: '2026-01-01T00:00:00.000Z',
    retrievedAt: '2026-01-02T00:00:00.000Z',
    sourceRevision: 1,
    locator: 'paragraph 1',
    ...over
  };
}

function trusted(over: Partial<TrustedContext> = {}): TrustedContext {
  return {
    ownerId: OWNER,
    caseId: CASE,
    role: 'fetch',
    phase: 'fetch',
    scopeVersion: 3,
    cancelled: false,
    accounts: [{ accountId: 'acct-1', platform: 'synthetic', handle: 'ada', allowedScope: 'public_history' }],
    capabilities: {
      registryVersion: 'registry/v1',
      operations: [
        { platform: 'synthetic', operation: 'list_posts', state: 'supported', sortOptions: ['new'], dateRange: 'supported', maxDepth: null, limitation: null },
        { platform: 'synthetic', operation: 'list_comments', state: 'supported', sortOptions: ['new'], dateRange: 'unsupported', maxDepth: null, limitation: null },
        { platform: 'synthetic', operation: 'read_thread', state: 'supported', sortOptions: [], dateRange: 'unsupported', maxDepth: 4, limitation: null },
        { platform: 'synthetic', operation: 'read_post', state: 'supported', sortOptions: [], dateRange: 'unsupported', maxDepth: null, limitation: null },
        { platform: 'synthetic', operation: 'read_media', state: 'supported', sortOptions: [], dateRange: 'unsupported', maxDepth: null, limitation: null },
        { platform: 'synthetic', operation: 'discover_accounts', state: 'supported', sortOptions: [], dateRange: 'unsupported', maxDepth: null, limitation: null },
        { platform: '*', operation: 'search_web', state: 'supported', sortOptions: [], dateRange: 'unsupported', maxDepth: null, limitation: null }
      ]
    },
    skillPins: [{ skillId: 'understand-person', version: 'v1', hash: 'hash-v1' }],
    ...over
  };
}

const inputFixtures: Record<ToolName, () => unknown> = {
  get_platform_capabilities: () => ({ platform: 'synthetic' }),
  discover_accounts: () => ({ platform: 'synthetic', query: 'ada fixture' }),
  read_profile: () => ({ accountId: 'acct-1' }),
  search_web: () => ({ query: 'ada fixture' }),
  submit_candidates: () => ({ candidates: [{ candidateRef: 'cand-1', platform: 'synthetic', handle: 'ada', supportEvidenceIds: [], counterEvidenceIds: [], sourceGroup: null }] }),
  request_confirmation: () => ({ question: 'Which candidate?', options: [{ optionId: 'opt-1', label: 'compiler author', discriminator: 'wrote the compiler' }] }),
  read_evidence: () => ({ evidence: [{ evidenceId: 'ev-1' }] }),
  load_skill: () => ({ skillId: 'understand-person', version: 'v1', hash: 'hash-v1' }),
  save_findings: () => ({ findings: [{ kind: 'collected_finding', statement: 'Ada built the compiler.', supportEvidenceIds: ['ev-1'], counterEvidenceIds: [] }] }),
  report_progress: () => ({ note: 'halfway through the timeline', gaps: ['2019 gap'] }),
  list_posts: () => ({ accountId: 'acct-1' }),
  read_post: () => ({ accountId: 'acct-1', itemId: 'item-1' }),
  list_comments: () => ({ accountId: 'acct-1', itemId: 'item-1' }),
  read_thread: () => ({ accountId: 'acct-1', itemId: 'item-1' }),
  read_media: () => ({ accountId: 'acct-1', itemId: 'item-1', mediaRef: 'media-1' })
};

interface Fixture {
  ports: ResearchToolPorts;
  events: string[];
  executorCalls: string[];
  settleCalls: Map<string, number>;
  commits: PendingFindingCommit[];
  controllerCommits: ControllerCommitContext[];
  progressNotes: string[];
  stateSnap: { current: CaseStateSnapshot; revoked: string[] };
}

function fixture(options: {
  script?: (call: number, endpoint: string) => ProviderResponse | Error;
  refuseBudget?: boolean;
  failSettleOn?: (reservation: RequestReservation) => boolean;
  cumulativeUsage?: UsageSummary;
  state?: { flipOnRead?: number; flipTo?: Partial<CaseStateSnapshot> & { revoked?: string[] } };
  submissions?: 'reject-commit' | 'reject-second' | 'fail-unexpected-second' | 'ok';
  controllerReject?: boolean;
  handlers?: Partial<Record<string, ToolHandler>>;
} = {}): Fixture {
  const events: string[] = [];
  const executorCalls: string[] = [];
  const settleCalls = new Map<string, number>();
  const commits: PendingFindingCommit[] = [];
  const controllerCommits: ControllerCommitContext[] = [];
  const progressNotes: string[] = [];
  let actionSeq = 0;
  let callSeq = 0;
  const stateSnap = {
    current: {
      scopeVersion: 3,
      cancelled: false,
      accounts: [{ accountId: 'acct-1', allowedScope: 'public_history' as const }]
    },
    revoked: [] as string[]
  };
  let stateReads = 0;

  const accounting: AccountingPort = {
    reserve(request) {
      if (options.refuseBudget) throw new BudgetRefusedError('budget_exhausted', 'budget exhausted');
      actionSeq += 1;
      const actionId = `act-${actionSeq}`;
      const endpoint = request.kind === 'provider_request' ? request.descriptor.endpoint : `${request.tool}#${request.kind}`;
      events.push(`reserve:${endpoint}:${actionId}`);
      return {
        actionId,
        tool: request.tool,
        descriptor: request.kind === 'provider_request' ? request.descriptor : { endpoint, note: 'step' }
      };
    },
    async settle(reservation, outcome: RequestOutcome) {
      settleCalls.set(reservation.actionId, (settleCalls.get(reservation.actionId) ?? 0) + 1);
      events.push(`settle:${reservation.descriptor.endpoint}:${reservation.actionId}:${outcome.state}`);
      if (options.failSettleOn?.(reservation)) throw new Error('settlement transport down');
    },
    ...(options.cumulativeUsage ? { usage: () => options.cumulativeUsage! } : {})
  };

  const executor: ProviderExecutorPort = {
    async execute(reservation, descriptor: MeteredRequestDescriptor) {
      callSeq += 1;
      executorCalls.push(descriptor.endpoint);
      events.push(`execute:${descriptor.endpoint}:${reservation.actionId}`);
      const result = options.script?.(callSeq, descriptor.endpoint) ?? { status: 200, body: {}, fee: { estimatedUsd: 0.001, credits: null } };
      if (result instanceof Error) throw result;
      return result;
    }
  };

  const state: FreshStatePort = {
    readCaseState() {
      stateReads += 1;
      if (options.state?.flipOnRead === stateReads && options.state.flipTo) {
        Object.assign(stateSnap.current, options.state.flipTo);
        if (options.state.flipTo.revoked) stateSnap.revoked = [...options.state.flipTo.revoked];
      }
      return { ...stateSnap.current, accounts: stateSnap.current.accounts.map((a) => ({ ...a })) };
    },
    revokedEvidence(_ownerId, _caseId, evidenceIds) {
      return Object.fromEntries(evidenceIds.map((id) => [id, stateSnap.revoked.includes(id)]));
    }
  };

  const ports: ResearchToolPorts = {
    accounting,
    executor,
    cursors: createOpaqueCursorPort(),
    state,
    submissions: {
      async stagePendingFinding(commit) {
        if (options.submissions === 'reject-commit') {
          throw new SubmissionRejectedError('stale_scope_at_commit', 'scope advanced before commit');
        }
        if (options.submissions === 'reject-second' && commits.length >= 1) {
          throw new SubmissionRejectedError('stale_scope_at_commit', 'scope advanced before commit');
        }
        if (options.submissions === 'fail-unexpected-second' && commits.length >= 1) {
          throw new Error('submission port crashed');
        }
        commits.push(commit);
        return { pendingRef: `pending-${commits.length}` };
      }
    },
    controller: {
      async submitCandidates(input) {
        controllerCommits.push(input.commit);
        if (options.controllerReject) throw new SubmissionRejectedError('stale_scope_at_commit', 'scope advanced before commit');
        return { batchRef: 'batch-1' };
      },
      async requestConfirmation(input) {
        controllerCommits.push(input.commit);
        if (options.controllerReject) throw new SubmissionRejectedError('stale_scope_at_commit', 'scope advanced before commit');
        return { confirmationRef: 'confirm-1' };
      },
      async reportProgress(input) {
        controllerCommits.push(input.commit);
        progressNotes.push(input.note ?? '');
      }
    },
    handlers: (options.handlers ?? {}) as Partial<Record<string, ToolHandler>>
  };
  return { ports, events, executorCalls, settleCalls, commits, controllerCommits, progressNotes, stateSnap };
}

function threadOut(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodes: [],
    missingNodeIds: [],
    truncation: { truncated: false, reason: null, depthRequested: null, depthReached: null },
    ...over
  };
}

function threadNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: 'node-1', parentNodeId: null, rootNodeId: 'item-1', authorAccountId: 'acct-1',
    authorRole: 'subject', depth: 0, createdAt: '2026-01-01T00:00:00.000Z', state: 'present',
    text: 'Synthetic dialogue text.', textUnavailableReason: null, metadata: okMetadata(), ...over
  };
}

function postItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: 'item-1', sourceId: 'src-1', sourceRevision: 1, authorAccountId: 'acct-1',
    title: 'Synthetic post', excerpt: 'Ada built the compiler.', metadata: okMetadata(), ...over
  };
}

function readPostItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: 'item-1', sourceId: 'src-1', sourceRevision: 1, authorAccountId: 'acct-1',
    title: 'Synthetic post', text: 'Ada built the compiler.', metadata: okMetadata(), ...over
  };
}

function fakeEvidencePort(): EvidenceReadPort {
  return {
    readEvidence: () => ({
      state: 'ok',
      detail: 'ok',
      evidence: {
        evidenceId: 'ev-1', caseId: CASE, accountId: 'acct-1', sourceId: 'src-1', sourceRevision: 1,
        role: 'factual_support', quote: 'q', quoteHash: 'h', locator: null, revokedAt: null,
        source: { author: 'A', originalUrl: 'https://fixture.test/x', publishedAt: null, retrievedAt: '2026-01-02T00:00:00.000Z', locator: null, contentHash: 'a'.repeat(64) }
      }
    }),
    readSourceRevision: () => ({ author: 'A', originalUrl: 'https://fixture.test/x', publishedAt: null, retrievedAt: '2026-01-02T00:00:00.000Z', locator: null, contentHash: 'a'.repeat(64) })
  };
}

const emptyHandlers: Partial<Record<string, ToolHandler>> = {};

async function call(
  ctx: TrustedContext,
  tool: ToolName,
  input: unknown,
  fx: Fixture = fixture(),
  inputOver?: unknown
): Promise<ToolEnvelope> {
  return dispatch(ctx, { tool, input: inputOver ?? input }, fx.ports, new AbortController().signal);
}

/* ------------------------------------------------------------------ */
/* Registry and role x phase matrix                                    */
/* ------------------------------------------------------------------ */

test('registry exposes exactly the shared 3, search-only 5 and fetch-only 7 tools', () => {
  assert.deepEqual(sorted(EXPECTED_SHARED), ['get_platform_capabilities', 'load_skill', 'read_evidence']);
  const search = sorted([...EXPECTED_SHARED, ...EXPECTED_SEARCH_ONLY]);
  const fetch = sorted([...EXPECTED_SHARED, ...EXPECTED_FETCH_ONLY]);
  assert.equal(search.length, 8);
  assert.equal(fetch.length, 10);
  const union = sorted([...EXPECTED_SHARED, ...EXPECTED_SEARCH_ONLY, ...EXPECTED_FETCH_ONLY]);
  assert.equal(union.length, 15);
  assert.deepEqual(sorted([...TOOL_NAMES]), union);
  const searchNames = sorted(['discover_accounts', 'read_profile', 'search_web', 'submit_candidates', 'request_confirmation']);
  assert.deepEqual(searchNames, sorted(EXPECTED_SEARCH_ONLY));
  const fetchNames = sorted(['list_posts', 'read_post', 'list_comments', 'read_thread', 'read_media', 'save_findings', 'report_progress']);
  assert.deepEqual(fetchNames, sorted(EXPECTED_FETCH_ONLY));
});

test('verify is a Fetch phase limited to read_evidence/load_skill/save_findings, not a third role', () => {
  assert.deepEqual(sorted(EXPECTED_VERIFY_ALLOWLIST), ['load_skill', 'read_evidence', 'save_findings']);
  for (const name of Object.keys(EXPECTED_MATRIX) as ToolName[]) {
    const expectVerify = (EXPECTED_VERIFY_ALLOWLIST as string[]).includes(name);
    assert.equal(toolAllowedFor(name, 'fetch', 'verify'), expectVerify, name);
    assert.equal(toolAllowedFor(name, 'search', 'verify'), false, `${name} never runs in verify`);
  }
  assert.equal(toolAllowedFor('get_platform_capabilities', 'fetch', 'verify'), false, 'shared tools earn no verify entry');
});

test('the full role x phase matrix refuses every other combination at the dispatcher', async () => {
  const phases = ['search', 'fetch', 'verify'] as const;
  const roles = ['search', 'fetch'] as const;
  for (const name of Object.keys(EXPECTED_MATRIX) as ToolName[]) {
    for (const role of roles) {
      for (const phase of phases) {
        const expected = (EXPECTED_MATRIX[name] ?? []).includes(`${role}:${phase}`);
        assert.equal(toolAllowedFor(name, role, phase), expected, `${name} ${role}:${phase}`);
        const fx = fixture({ handlers: emptyHandlers });
        const envelope = await dispatch(trusted({ role, phase }), { tool: name, input: inputFixtures[name]() }, fx.ports, new AbortController().signal);
        assert.ok(envelopeV(envelope, 'envelope'), 'envelopes stay schema-valid');
        if (expected) {
          assert.doesNotMatch(envelope.reason ?? '', /role\/phase refused/, `${name} ${role}:${phase} should pass the matrix`);
        } else {
          assert.equal(envelope.status, 'blocked', `${name} ${role}:${phase}`);
          assert.match(envelope.reason ?? '', /role\/phase refused/);
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* Untrusted input boundaries                                          */
/* ------------------------------------------------------------------ */

test('model-supplied privilege, ownership and budget fields are refused everywhere', async () => {
  const injections: Array<[ToolName, Record<string, unknown>]> = [
    ['read_post', { accountId: 'acct-1', itemId: 'item-1', ownerId: OWNER }],
    ['read_post', { accountId: 'acct-1', itemId: 'item-1', caseId: CASE }],
    ['read_post', { accountId: 'acct-1', itemId: 'item-1', role: 'fetch' }],
    ['read_post', { accountId: 'acct-1', itemId: 'item-1', phase: 'verify' }],
    ['list_posts', { accountId: 'acct-1', allowedScope: 'public_history' }],
    ['list_posts', { accountId: 'acct-1', scopeVersion: 99 }],
    ['search_web', { query: 'ada', budget: { estimatedUsd: 5 } }],
    ['search_web', { query: 'ada', estimatedUsd: 0 }],
    ['report_progress', { note: 'ok', usage: { estimatedUsd: 0 } }],
    ['save_findings', { findings: [{ kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [], identitySupport: { state: 'supported' } }] }]
  ];
  for (const [tool, input] of injections) {
    const fx = fixture({ handlers: { read_post: async () => ({ item: postItem() }), list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }), search_web: async () => ({ items: [], nativeCursor: null }) } });
    const envelope = await call(trusted(), tool, inputFixtures[tool](), fx, input);
    assert.equal(envelope.status, 'blocked', `${tool} ${JSON.stringify(input)}`);
    assert.match(envelope.reason ?? '', /untrusted_privilege_field/);
    assert.equal(fx.executorCalls.length, 0, 'refusal happens before execution');
    assert.equal(envelope.actions.length, 0);
  }
});

test('unknown input keys are refused before any execution', async () => {
  const fx = fixture({ handlers: { read_post: async () => ({ item: postItem() }) } });
  const envelope = await call(trusted(), 'read_post', inputFixtures.read_post(), fx, { accountId: 'acct-1', itemId: 'item-1', cursorBinding: { accountId: 'acct-2' } });
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /unknown_key/);
  assert.equal(fx.executorCalls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Account, scope and capability gates                                 */
/* ------------------------------------------------------------------ */

test('profile_only cannot read history and none cannot read restricted content', async () => {
  const cases: Array<[ToolName, TrustedContext['accounts'][number]['allowedScope'], boolean]> = [
    ['list_posts', 'profile_only', false],
    ['read_post', 'profile_only', false],
    ['list_comments', 'none', false],
    ['read_thread', 'none', false],
    ['read_media', 'none', false],
    ['read_profile', 'none', false],
    ['read_profile', 'profile_only', true],
    ['list_posts', 'public_history', true]
  ];
  for (const [tool, allowedScope, ok] of cases) {
    const fx = fixture({
      handlers: {
        list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }),
        read_post: async () => ({ item: readPostItem() }),
        list_comments: async () => ({ items: [], ordering: 'provider_default', nativeCursor: null }),
        read_thread: async () => ({ nodes: [], missingNodeIds: [], truncation: { truncated: false, reason: null, depthRequested: null, depthReached: null } }),
        read_media: async () => ({ mediaRef: 'media-1', text: 'x', captions: null, mediaUnread: false, conversion: { authorized: false, state: 'not_attempted', note: null }, metadata: okMetadata() }),
        read_profile: async () => ({ items: [{ pageRole: 'profile', title: 'Ada', summary: 'bio', externalLinks: [], metadata: okMetadata() }] })
      }
    });
    const base = tool === 'read_profile' ? { role: 'search' as const, phase: 'search' as const } : { role: 'fetch' as const, phase: 'fetch' as const };
    const envelope = await call(trusted({ ...base, accounts: [{ accountId: 'acct-1', platform: 'synthetic', handle: 'ada', allowedScope }] }), tool, inputFixtures[tool](), fx);
    if (ok) {
      assert.equal(envelope.status, 'success', `${tool} ${allowedScope}`);
    } else {
      assert.equal(envelope.status, 'blocked', `${tool} ${allowedScope}`);
      assert.match(envelope.reason ?? '', /scope refused/);
      assert.equal(fx.executorCalls.length, 0);
    }
  }
});

test('a foreign or unknown account is refused as a request subject', async () => {
  const fx = fixture({ handlers: { read_post: async () => ({ item: postItem() }) } });
  const envelope = await call(trusted(), 'read_post', inputFixtures.read_post(), fx, { accountId: 'acct-foreign', itemId: 'item-1' });
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /account refused/);
  assert.equal(fx.executorCalls.length, 0);
});

test('trusted capabilities refuse unknown sort, unconfirmed date windows and excess depth before handlers run', async () => {
  const refused: Array<[ToolName, Record<string, unknown>, RegExp]> = [
    ['list_comments', { accountId: 'acct-1', itemId: 'item-1', sort: 'top' }, /sort top/],
    ['read_thread', { accountId: 'acct-1', itemId: 'item-1', depth: 5 }, /depth 5/],
    ['search_web', { query: 'ada', dateTo: '2021-01-01' }, /date windows/]
  ];
  for (const [tool, input, pattern] of refused) {
    const fx = fixture({
      handlers: {
        list_comments: async () => ({ items: [], ordering: 'provider_default', nativeCursor: null }),
        list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }),
        read_thread: async () => ({ nodes: [], missingNodeIds: [], truncation: { truncated: false, reason: null, depthRequested: null, depthReached: null } }),
        search_web: async () => ({ items: [], nativeCursor: null })
      }
    });
    const base = tool === 'search_web' ? { role: 'search' as const, phase: 'search' as const } : { role: 'fetch' as const, phase: 'fetch' as const };
    const envelope = await call(trusted(base), tool, inputFixtures[tool](), fx, input);
    assert.equal(envelope.status, 'blocked', tool);
    assert.match(envelope.reason ?? '', /capability refused/);
    assert.match(envelope.reason ?? '', pattern);
    assert.equal(fx.executorCalls.length, 0, 'capability gate precedes handlers');
    assert.equal(envelope.actions.length, 0);
  }
});

/* ------------------------------------------------------------------ */
/* Cursors                                                             */
/* ------------------------------------------------------------------ */

test('native cursors bind to account/tool/scope/sort/date and cross-target replay is refused', async () => {
  const fx = fixture({
    handlers: {
      list_posts: async (ctx) => ({
        items: [postItem()],
        sort: 'new',
        nativeCursor: (ctx.cursor.nativeCursor ?? '') + '|page2'
      })
    }
  });
  const first = await call(trusted(), 'list_posts', { accountId: 'acct-1' }, fx);
  assert.equal(first.status, 'success');
  assert.equal(first.cursor.nativeCursor, '|page2');
  assert.ok(first.cursor.token, 'continuation goes through the trusted opaque port');

  const otherSort = await call(trusted(), 'list_posts', { accountId: 'acct-1', sort: 'new', cursor: first.cursor.token }, fx, { accountId: 'acct-1', cursor: first.cursor.token, dateFrom: '2020-01-01' });
  assert.equal(otherSort.status, 'blocked');
  assert.match(otherSort.reason ?? '', /cursor refused/);

  fx.stateSnap.current.accounts = [
    { accountId: 'acct-1', allowedScope: 'public_history' },
    { accountId: 'acct-2', allowedScope: 'public_history' }
  ];
  const otherAccount = await call(
    trusted({ accounts: [{ accountId: 'acct-2', platform: 'synthetic', handle: 'other', allowedScope: 'public_history' }] }),
    'list_posts',
    inputFixtures.list_posts(),
    fx,
    { accountId: 'acct-2', cursor: first.cursor.token }
  );
  assert.equal(otherAccount.status, 'blocked');
  assert.match(otherAccount.reason ?? '', /cursor refused/);

  fx.stateSnap.current.scopeVersion = 4; // the trusted snapshot below is intentionally one version stale
  const otherScope = await call(trusted({ scopeVersion: 4 }), 'list_posts', { accountId: 'acct-1', cursor: first.cursor.token }, fx, { accountId: 'acct-1', cursor: first.cursor.token });
  assert.equal(otherScope.status, 'blocked');
  assert.match(otherScope.reason ?? '', /cursor refused/);
});

test('a forged model cursor wrapper is refused and an unbound cursor port fails closed', async () => {
  const fx = fixture({ handlers: { list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }) } });
  const forged = await call(trusted(), 'list_posts', inputFixtures.list_posts(), fx, {
    accountId: 'acct-1',
    cursor: 'cur_forged',
    cursorBinding: { accountId: 'acct-1', window: 'any' }
  });
  assert.equal(forged.status, 'blocked');
  assert.match(forged.reason ?? '', /unknown_key/);

  const privilegeWrapper = await call(trusted(), 'list_posts', inputFixtures.list_posts(), fx, {
    accountId: 'acct-1',
    cursor: 'cur_forged',
    cursorBinding: { accountId: 'acct-1', scopeVersion: 3 }
  });
  assert.equal(privilegeWrapper.status, 'blocked');
  assert.match(privilegeWrapper.reason ?? '', /untrusted_privilege_field/);

  const unbound: ResearchToolPorts = { ...fx.ports, cursors: null };
  const result = await dispatch(trusted(), { tool: 'list_posts', input: { accountId: 'acct-1', cursor: 'cur_1' } }, unbound, new AbortController().signal);
  assert.equal(result.status, 'not_implemented');
  assert.match(result.reason ?? '', /cursor validation port unbound/);
});

/* ------------------------------------------------------------------ */
/* Provider request accounting                                         */
/* ------------------------------------------------------------------ */

test('search_web performs exactly one adapter request', async () => {
  let attempts = 0;
  const fx = fixture({
    handlers: {
      search_web: async (ctx) => {
        await ctx.requests.run({ endpoint: 'exa.search', note: 'search' }, ctx.signal);
        attempts += 1;
        try {
          await ctx.requests.run({ endpoint: 'exa.search', note: 'sneaky second search' }, ctx.signal);
        } catch {
          attempts += 1;
        }
        return { items: [{ clueKind: 'source', title: 'Interview', excerpt: 'Ada writes compilers.', limitation: null, metadata: okMetadata() }], nativeCursor: null };
      }
    }
  });
  const envelope = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', inputFixtures.search_web(), fx);
  assert.equal(envelope.status, 'success');
  assert.equal(fx.executorCalls.length, 1, 'exactly one adapter request per search_web call');
  for (const count of fx.settleCalls.values()) assert.equal(count, 1, 'each settled reservation settles exactly once');
  assert.equal(attempts, 2, 'the second attempt was refused without dispatch');
  const notDispatched = envelope.actions.filter((action) => action.state === 'not_dispatched');
  assert.equal(notDispatched.length, 1);
});

test('three executed sub-requests settle three distinct receipts in reserve->execute->settle order', async () => {
  const node = (id: string, parent: string | null, authorRole: 'subject' | 'third_party'): Record<string, unknown> => ({
    nodeId: id, parentNodeId: parent, rootNodeId: 'item-1', authorAccountId: authorRole === 'subject' ? 'acct-1' : 'acct-third',
    authorRole, depth: null, createdAt: '2026-01-01T00:00:00.000Z', state: 'present',
    text: 'Synthetic dialogue text.', textUnavailableReason: null, metadata: okMetadata()
  });
  const fx = fixture({
    handlers: {
      read_thread: async (ctx) => {
        await ctx.requests.run({ endpoint: 'tikhub.thread_root', note: 'root' }, ctx.signal);
        await ctx.requests.run({ endpoint: 'tikhub.thread_comments', note: 'comments' }, ctx.signal);
        await ctx.requests.run({ endpoint: 'tikhub.thread_branch', note: 'branch' }, ctx.signal);
        return {
          nodes: [node('n1', null, 'subject'), node('n2', 'n1', 'third_party'), node('n3', 'n2', 'subject')],
          missingNodeIds: [],
          truncation: { truncated: false, reason: null, depthRequested: 4, depthReached: 3 }
        };
      }
    }
  });
  const envelope = await call(trusted(), 'read_thread', inputFixtures.read_thread(), fx);
  assert.equal(envelope.status, 'success');
  assert.equal(fx.executorCalls.length, 3);
  const receipts = envelope.actions.filter((action) => action.kind === 'provider_request');
  assert.equal(receipts.length, 3);
  assert.equal(new Set(receipts.map((action) => action.actionId)).size, 3, 'three executed requests, three distinct receipts');
  const relevant = fx.events.filter((event) => event.startsWith('reserve:tikhub') || event.startsWith('execute:') || event.startsWith('settle:tikhub'));
  assert.deepEqual(relevant.map((event) => event.split(':')[0]), ['reserve', 'execute', 'settle', 'reserve', 'execute', 'settle', 'reserve', 'execute', 'settle']);
  for (const action of receipts) assert.equal(fx.settleCalls.get(action.actionId ?? ''), 1, 'each executed attempt settles exactly once');
});

test('fail-stop keeps the first result and the second failure/unknown fee and never dispatches the third request', async () => {
  let plannedThird = false;
  const fx = fixture({
    script: (call) => (call === 2 ? new Error('provider 500') : { status: 200, body: {}, fee: call === 1 ? { estimatedUsd: 0.002, credits: null } : null }),
    handlers: {
      read_thread: async (ctx) => {
        await ctx.requests.run({ endpoint: 'tikhub.thread_root', note: 'root' }, ctx.signal);
        try {
          await ctx.requests.run({ endpoint: 'tikhub.thread_comments', note: 'comments' }, ctx.signal);
        } catch {
          // fail-stop: the next planned request must not reach the provider.
        }
        try {
          plannedThird = true;
          await ctx.requests.run({ endpoint: 'tikhub.thread_branch', note: 'planned branch' }, ctx.signal);
        } catch {
          // recorded as not_dispatched
        }
        return {
          nodes: [threadNode({
            nodeId: 'n1', parentNodeId: null, rootNodeId: 'item-1', authorAccountId: 'acct-1',
            authorRole: 'subject', depth: 0, createdAt: null, text: 'Kept first result.', metadata: okMetadata({ publishedAt: null })
          })],
          missingNodeIds: ['n9'],
          truncation: { truncated: true, reason: 'fail-stop after a failed request', depthRequested: 4, depthReached: 1 }
        };
      }
    }
  });
  const envelope = await call(trusted(), 'read_thread', inputFixtures.read_thread(), fx);
  assert.equal(envelope.status, 'partial');
  assert.equal(plannedThird, true);
  assert.equal(fx.executorCalls.length, 2, 'the third request never executed');
  const content = envelope.content as { nodes: unknown[]; missingNodeIds: string[] };
  assert.equal(content.nodes.length, 1, 'the first result is retained');
  assert.deepEqual(content.missingNodeIds, ['n9']);
  const receipts = envelope.actions.filter((action) => action.kind === 'provider_request' || action.state === 'not_dispatched');
  assert.equal(receipts.length, 3);
  assert.equal(receipts[0]?.state, 'completed');
  assert.equal(receipts[0]?.estimatedUsd, 0.002);
  assert.equal(receipts[1]?.state, 'failed');
  assert.equal(receipts[1]?.estimatedUsd, null, 'the failed attempt keeps an unknown fee');
  assert.equal(receipts[2]?.state, 'not_dispatched');
  assert.equal(envelope.usage.estimatedUsd, null, 'unknown fee is never silently priced');
  assert.equal(envelope.usage.unknownFeeRequests, 1);
  assert.equal(envelope.usage.notDispatchedRequests, 1);
});

test('unknown provider fees stay unknown instead of zero', async () => {
  const fx = fixture({
    script: () => ({ status: 200, body: {}, fee: null }),
    handlers: { search_web: async (ctx) => { await ctx.requests.run({ endpoint: 'exa.search', note: 'search' }, ctx.signal); return { items: [], nativeCursor: null }; } }
  });
  const envelope = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', inputFixtures.search_web(), fx);
  assert.equal(envelope.status, 'success');
  assert.equal(envelope.usage.estimatedUsd, null);
  assert.equal(envelope.usage.unknownFeeRequests, 1);
  assert.equal(envelope.usage.credits, null);
});

test('budget refusal means zero handler calls and no accounting port means no billable dispatch', async () => {
  let handlerCalls = 0;
  const fx = fixture({
    refuseBudget: true,
    handlers: { search_web: async () => { handlerCalls += 1; return { items: [], nativeCursor: null }; } }
  });
  const refused = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', inputFixtures.search_web(), fx);
  assert.equal(refused.status, 'blocked');
  assert.match(refused.reason ?? '', /budget refused/);
  assert.equal(handlerCalls, 0);
  assert.equal(fx.executorCalls.length, 0);

  const unmetered: ResearchToolPorts = { ...fixture({ handlers: { search_web: async () => { handlerCalls += 1; return { items: [], nativeCursor: null }; } } }).ports, accounting: null };
  const unaccounted = await dispatch(trusted({ role: 'search', phase: 'search' }), { tool: 'search_web', input: inputFixtures.search_web() }, unmetered, new AbortController().signal);
  assert.equal(unaccounted.status, 'not_implemented');
  assert.match(unaccounted.reason ?? '', /no accounting port/);
  assert.equal(handlerCalls, 0);
});

test('malformed output after one settled request fails the dispatch without dropping the receipt', async () => {
  const fx = fixture({
    handlers: {
      read_post: async (ctx) => {
        await ctx.requests.run({ endpoint: 'exa.contents', note: 'read' }, ctx.signal);
        return { item: { itemId: 'item-1', sourceId: 'src-1', sourceRevision: 1, authorAccountId: 'acct-1', title: 't', text: 'x', metadata: { applicable: true, author: 'A', originalUrl: 'https://fixture.test/item', retrievedAt: '2026-01-02T00:00:00.000Z', sourceRevision: 1, locator: null } } };
      }
    }
  });
  const envelope = await call(trusted(), 'read_post', inputFixtures.read_post(), fx);
  assert.equal(envelope.status, 'failed');
  assert.match(envelope.reason ?? '', /output refused/);
  assert.equal(fx.executorCalls.length, 1);
  const requestReceipts = envelope.actions.filter((action) => action.kind === 'provider_request');
  assert.equal(requestReceipts.length, 1);
  assert.equal(fx.settleCalls.get(requestReceipts[0]?.actionId ?? ''), 1, 'the executed request settled exactly once');
  assert.equal(requestReceipts[0]?.state, 'completed');
  assert.equal(envelope.staged, false);
  assert.ok(envelopeV(envelope, 'envelope'));
});

test('settlement failure fail-stops: unreconciled receipt, no repeated request, no double settle', async () => {
  const fx = fixture({
    failSettleOn: (reservation) => reservation.descriptor.endpoint === 'exa.contents',
    handlers: {
      read_post: async (ctx) => {
        try {
          await ctx.requests.run({ endpoint: 'exa.contents', note: 'read' }, ctx.signal);
        } catch {
          // handler swallows; the dispatch must still fail-stop
        }
        try {
          await ctx.requests.run({ endpoint: 'exa.retry', note: 'must never run' }, ctx.signal);
        } catch {
          // not dispatched
        }
        return { item: postItem(), text: 'stale' };
      }
    }
  });
  const envelope = await call(trusted(), 'read_post', inputFixtures.read_post(), fx);
  assert.equal(envelope.status, 'failed');
  assert.match(envelope.reason ?? '', /settlement failed/);
  assert.equal(fx.executorCalls.length, 1, 'the remote request is never repeated');
  const settled = [...fx.settleCalls.entries()];
  assert.equal(settled.length, 2, 'the tool step and the one executed request each settled once');
  for (const [, count] of settled) assert.equal(count, 1, 'no double settle');
  assert.ok(envelope.gaps.some((gap) => gap.code === 'unreconciled'));
  assert.equal(envelope.actions.some((action) => action.state === 'unreconciled'), true);
  assert.equal(envelope.actions.some((action) => action.state === 'not_dispatched'), true);
  assert.equal(envelope.staged, false);
});

/* ------------------------------------------------------------------ */
/* Output honesty: metadata, subjects, ordering, media, discovery      */
/* ------------------------------------------------------------------ */

test('required per-item output metadata and foreign/substituted outputs are refused', async () => {
  const missing = fixture({ handlers: { list_posts: async () => ({ items: [{ ...postItem(), metadata: { applicable: true, author: 'A', originalUrl: null, publishedAt: '2026-01-01T00:00:00.000Z', sourceRevision: 1 } }], sort: 'new', nativeCursor: null }) } });
  const noLocator = await call(trusted(), 'list_posts', inputFixtures.list_posts(), missing);
  assert.equal(noLocator.status, 'failed');
  assert.match(noLocator.reason ?? '', /output refused/);

  const substituted = fixture({ handlers: { read_post: async () => ({ item: readPostItem({ itemId: 'item-OTHER' }) }) } });
  const wrongItem = await call(trusted(), 'read_post', inputFixtures.read_post(), substituted);
  assert.equal(wrongItem.status, 'failed');
  assert.match(wrongItem.reason ?? '', /substituted target locator/);

  const foreign = fixture({ handlers: { read_post: async () => ({ item: readPostItem({ authorAccountId: 'acct-third' }) }) } });
  const wrongAuthor = await call(trusted(), 'read_post', inputFixtures.read_post(), foreign);
  assert.equal(wrongAuthor.status, 'failed');
  assert.match(wrongAuthor.reason ?? '', /foreign account/);

  const badRole = fixture({
    handlers: {
      list_comments: async () => ({
        items: [{
          commentId: 'c1', rootItemId: 'item-1', parentCommentId: null, authorAccountId: 'acct-third',
          authorRole: 'subject', createdAt: null, excerpt: 'hi', metadata: okMetadata()
        }],
        ordering: 'provider_default',
        nativeCursor: null
      })
    }
  });
  const mislabeled = await call(trusted(), 'list_comments', inputFixtures.list_comments(), badRole);
  assert.equal(mislabeled.status, 'failed');
  assert.match(mislabeled.reason ?? '', /foreign author declared as subject/);
});

test('legitimate third-party comment and thread authors are preserved and never added to selected scope', async () => {
  const fx = fixture({
    handlers: {
      list_comments: async () => ({
        items: [
          { commentId: 'c1', rootItemId: 'item-1', parentCommentId: null, authorAccountId: 'acct-1', authorRole: 'subject', createdAt: '2026-01-03T00:00:00.000Z', excerpt: 'my post', metadata: okMetadata() },
          { commentId: 'c2', rootItemId: 'item-1', parentCommentId: 'c1', authorAccountId: 'acct-third', authorRole: 'third_party', createdAt: '2026-01-04T00:00:00.000Z', excerpt: 'a question', metadata: okMetadata({ author: 'Third Party' }) }
        ],
        ordering: 'provider_default',
        nativeCursor: null
      })
    }
  });
  const ctx = trusted();
  const envelope = await call(ctx, 'list_comments', inputFixtures.list_comments(), fx);
  assert.equal(envelope.status, 'success');
  const content = envelope.content as { items: { authorAccountId: string; authorRole: string }[]; ordering: string };
  assert.equal(content.items[1]?.authorAccountId, 'acct-third');
  assert.equal(content.items[1]?.authorRole, 'third_party');
  assert.equal(content.ordering, 'provider_default', 'provider_default ordering is preserved, never relabeled top');
  assert.deepEqual(ctx.accounts.map((account) => account.accountId), ['acct-1'], 'third-party authors never enter selected scope');
});

test('discovery timeouts are never recorded as checked_no_match', async () => {
  const fx = fixture({
    handlers: {
      discover_accounts: async () => ({ discoveryStatus: 'checked_no_match', stopReason: 'timeout', nativeCursor: null, items: [] })
    }
  });
  const envelope = await call(trusted({ role: 'search', phase: 'search' }), 'discover_accounts', inputFixtures.discover_accounts(), fx);
  assert.equal(envelope.status, 'failed');
  assert.match(envelope.reason ?? '', /checked_no_match/);

  const ok = fixture({
    handlers: {
      discover_accounts: async () => ({ discoveryStatus: 'inaccessible', stopReason: 'timeout', nativeCursor: null, items: [] })
    }
  });
  const honest = await call(trusted({ role: 'search', phase: 'search' }), 'discover_accounts', inputFixtures.discover_accounts(), ok);
  assert.equal(honest.status, 'success');
});

test('media separates existing text, unread media and authorized conversion', async () => {
  const mixed = fixture({
    handlers: {
      read_media: async () => ({ mediaRef: 'media-1', text: 'leaked', captions: null, mediaUnread: true, conversion: { authorized: true, state: 'succeeded', note: null }, metadata: okMetadata() })
    }
  });
  const bad = await call(trusted(), 'read_media', inputFixtures.read_media(), mixed);
  assert.equal(bad.status, 'failed');
  assert.match(bad.reason ?? '', /unread media/);

  const unauthorized = fixture({
    handlers: {
      read_media: async () => ({ mediaRef: 'media-1', text: null, captions: null, mediaUnread: false, conversion: { authorized: true, state: 'succeeded', note: null }, metadata: okMetadata() })
    }
  });
  const refused = await call(trusted({ mediaConversionAuthorized: false }), 'read_media', inputFixtures.read_media(), unauthorized);
  assert.equal(refused.status, 'failed');
  assert.match(refused.reason ?? '', /explicit trusted authorization/);

  const clean = fixture({
    handlers: {
      read_media: async () => ({ mediaRef: 'media-1', text: null, captions: 'synthetic captions', mediaUnread: false, conversion: { authorized: true, state: 'not_attempted', note: null }, metadata: okMetadata() })
    }
  });
  const ok = await call(trusted({ mediaConversionAuthorized: true }), 'read_media', inputFixtures.read_media(), clean);
  assert.equal(ok.status, 'success');
});

test('unwired provider handlers return not_implemented without fabricated receipts', async () => {
  const fx = fixture({});
  const envelope = await call(trusted(), 'read_post', inputFixtures.read_post(), fx);
  assert.equal(envelope.status, 'not_implemented');
  assert.equal(envelope.actions.length, 0);
  assert.equal(fx.executorCalls.length, 0);
  assert.ok(envelopeV(envelope, 'envelope'));
});

/* ------------------------------------------------------------------ */
/* Real CaseStore evidence adapter                                     */
/* ------------------------------------------------------------------ */

function realStore(): { db: DB; store: Store; caseId: string; accountId: string } {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const record = store.cases.createCase({ ownerId: OWNER, intent: 'Synthetic case', provenance: { authorization: 'not_recorded', collector: 'synthetic-fixture', note: null } });
  const account = store.cases.addAccount(
    { ownerId: OWNER, caseId: record.caseId, accountId: 'ignored', expectedScopeVersion: record.scopeVersion },
    {
      accountId: 'acct-1',
      platform: 'synthetic',
      handle: 'ada',
      profileUrl: 'https://fixture.test/ada',
      identitySupport: { state: 'proposed', evidenceIds: [], counterevidenceIds: [], policyVersion: 'identity-policy/v1', note: null },
      userSelection: { state: 'unanswered', note: null, recordedAt: null },
      allowedScope: { state: 'public_history', note: null },
      researchValue: { state: 'unassessed', rationale: null },
      accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null }
    }
  );
  return { db, store, caseId: record.caseId, accountId: account.accountId };
}

function addSourceWithEvidence(store: Store, caseId: string, accountId: string, opts: { revoke?: boolean } = {}) {
  const ctx = { ownerId: OWNER, caseId, accountId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion };
  const source = store.cases.recordSourceRevision(ctx, {
    author: 'Synthetic Author v1',
    originalUrl: 'https://fixture.test/article',
    title: 'Synthetic article',
    publishedAt: '2025-06-01',
    retrievedAt: '2026-01-02T00:00:00.000Z',
    locator: 'paragraph 1',
    contentHash: 'a'.repeat(64),
    provenance: { authorization: 'not_recorded', collector: 'synthetic-fixture', note: null }
  });
  const evidence = store.cases.addEvidence(ctx, {
    sourceId: source.sourceId,
    sourceRevision: 1,
    role: 'factual_support',
    quote: 'Ada built the compiler.',
    locator: 'paragraph 1',
    provenance: { authorization: 'not_recorded', collector: 'synthetic-fixture', note: null }
  });
  // A newer source revision exists; the pinned historical one stays valid.
  store.cases.recordSourceRevision(ctx, {
    sourceId: source.sourceId,
    author: 'Synthetic Author v2',
    originalUrl: 'https://fixture.test/article',
    title: 'Synthetic article',
    publishedAt: '2025-06-02',
    retrievedAt: '2026-01-03T00:00:00.000Z',
    locator: 'paragraph 1',
    contentHash: 'b'.repeat(64),
    provenance: { authorization: 'not_recorded', collector: 'synthetic-fixture', note: null }
  });
  if (opts.revoke) store.cases.revokeEvidence(ctx, evidence.evidenceId);
  return { source, evidence };
}

test('real CaseStore read-back honors pins, revocation, locator binding and pinned history', async (t) => {
  const { db, store, caseId, accountId } = realStore();
  t.after(() => db.close());
  const { evidence } = addSourceWithEvidence(store, caseId, accountId);
  const server = createResearchToolServer({ store });
  const ctx = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion });

  const pinned = await server.dispatch(ctx, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId, sourceRevision: 1, locator: 'paragraph 1' }] } }, new AbortController().signal);
  assert.equal(pinned.status, 'success', pinned.reason ?? '');
  const items = (pinned.content as { items: { sourceRevision: number; metadata: { author: string | null; publishedAt: string | null } }[] }).items;
  assert.equal(items[0]?.sourceRevision, 1, 'a newer revision exists but the pin stays on the captured one');
  assert.equal(items[0]?.metadata.author, 'Synthetic Author v1');
  assert.equal(items[0]?.metadata.publishedAt, '2025-06-01');

  const wrongPin = await server.dispatch(ctx, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId, sourceRevision: 2 }] } }, new AbortController().signal);
  assert.equal(wrongPin.status, 'blocked');
  assert.match(wrongPin.reason ?? '', /revision_mismatch/);

  const wrongLocator = await server.dispatch(ctx, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId, locator: 'paragraph 9' }] } }, new AbortController().signal);
  assert.equal(wrongLocator.status, 'blocked');
  assert.match(wrongLocator.reason ?? '', /locator_mismatch/);

  addSourceWithEvidence(store, caseId, accountId, { revoke: true });

  const ctx2 = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion });
  // Withdraw the evidence and confirm explicit revocation refusal.
  store.cases.revokeEvidence({ ownerId: OWNER, caseId, accountId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion }, evidence.evidenceId);
  const after = await server.dispatch(ctx2, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId }] } }, new AbortController().signal);
  assert.equal(after.status, 'blocked');
  assert.match(after.reason ?? '', /revoked|withdrawn/);
});

test('fresh Store state refuses a stale trusted scope snapshot before dispatch', async (t) => {
  const { db, store, caseId, accountId } = realStore();
  t.after(() => db.close());
  const { evidence } = addSourceWithEvidence(store, caseId, accountId);
  const server = createResearchToolServer({ store });
  const stale = trusted({ caseId, scopeVersion: 1 });
  store.cases.applyCaseScopeMutation({ ownerId: OWNER, caseId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion, reason: 'synthetic scope advance', advance: true });

  const refused = await server.dispatch(stale, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId }] } }, new AbortController().signal);
  assert.equal(refused.status, 'blocked');
  assert.match(refused.reason ?? '', /stale against current store state/);

  const fresh = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion });
  const ok = await server.dispatch(fresh, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId }] } }, new AbortController().signal);
  assert.equal(ok.status, 'success', ok.reason ?? '');
});

/* ------------------------------------------------------------------ */
/* Async late changes                                                  */
/* ------------------------------------------------------------------ */

test('async late scope change and cancellation settle receipts but never stage or publish', async () => {
  for (const mode of ['scope', 'cancel'] as const) {
    const fx = fixture({
      handlers: {
        read_post: async (ctx) => {
          await ctx.requests.run({ endpoint: 'exa.contents', note: 'read' }, ctx.signal);
          // The trusted state drifts during the awaited provider call.
          if (mode === 'scope') fx.stateSnap.current.scopeVersion += 1;
          else fx.stateSnap.current.cancelled = true;
          return { item: readPostItem() };
        }
      }
    });
    const envelope = await call(trusted(), 'read_post', inputFixtures.read_post(), fx);
    assert.equal(envelope.status, 'blocked', mode);
    assert.match(envelope.reason ?? '', mode === 'scope' ? /scope refused/ : /cancelled/);
    assert.equal(envelope.content, null, `${mode}: stale results are withheld`);
    assert.equal(envelope.staged, false);
    assert.equal(envelope.actions.filter((action) => action.kind === 'provider_request' && action.state === 'completed').length, 1, `${mode}: the executed receipt settles`);
  }
});

test('late evidence withdrawal blocks pending staging while receipts remain', async () => {
  const fx = fixture({ submissions: 'ok' });
  fx.ports.evidence = fakeEvidencePort();
  // Withdraw after dependency validation but before the pre-write gate:
  // entry + dependency checks read revocation state first, the pre-stage gate
  // third and must refuse the write.
  let revokedReads = 0;
  const state = fx.ports.state!;
  const readRevoked = state.revokedEvidence.bind(state);
  state.revokedEvidence = (ownerId, caseId, evidenceIds) => {
    revokedReads += 1;
    if (revokedReads >= 3) fx.stateSnap.revoked = ['ev-1'];
    return readRevoked(ownerId, caseId, evidenceIds);
  };
  const envelope = await call(trusted(), 'save_findings', inputFixtures.save_findings(), fx);
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /evidence withdrawn/);
  assert.equal(envelope.staged, false);
  assert.equal(fx.commits.length, 0, 'the write never happened');
  assert.ok(envelope.actions.some((action) => action.kind === 'local_step'), 'step accounting remains');
});

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

test('load_skill serves the pinned manifest path and refuses pin mismatches', async () => {
  const skills = createPinnedSkillManifestPort([
    { skillId: 'understand-person', version: 'v1', hash: 'hash-v1', body: 'Ask which questions apply before reading.', dependencies: [] }
  ]);
  const accounting = fixture();
  const ports: ResearchToolPorts = { skills, accounting: accounting.ports.accounting, state: accounting.ports.state };

  const ok = await dispatch(trusted(), { tool: 'load_skill', input: { skillId: 'understand-person', version: 'v1', hash: 'hash-v1' } }, ports, new AbortController().signal);
  assert.equal(ok.status, 'success');
  assert.equal((ok.content as { body: string }).body.includes('Ask which questions'), true);
  assert.equal(ok.usage.providerRequests, 0, 'local skill reads make zero provider calls');
  assert.equal(ok.usage.localSteps, 1, 'step/context accounting remains');

  const mismatched = await dispatch(trusted(), { tool: 'load_skill', input: { skillId: 'understand-person', version: 'v1', hash: 'hash-EVIL' } }, ports, new AbortController().signal);
  assert.equal(mismatched.status, 'blocked');
  assert.match(mismatched.reason ?? '', /skill refused/);

  const wrongVersion = await dispatch(trusted(), { tool: 'load_skill', input: { skillId: 'understand-person', version: 'v9', hash: 'hash-v1' } }, ports, new AbortController().signal);
  assert.equal(wrongVersion.status, 'blocked');
  assert.match(wrongVersion.reason ?? '', /skill refused/);

  const unreviewed = await dispatch(trusted({ skillPins: [{ skillId: 'research-x', version: 'v1', hash: 'hash-x' }] }), { tool: 'load_skill', input: { skillId: 'research-x', version: 'v1', hash: 'hash-x' } }, ports, new AbortController().signal);
  assert.equal(unreviewed.status, 'not_applicable');
  assert.match(unreviewed.reason ?? '', /audited local manifest/);
});

/* ------------------------------------------------------------------ */
/* save_findings: pending-only, verify isolation, atomic commit         */
/* ------------------------------------------------------------------ */

test('save_findings is pending-only and verify accepts checks on existing evidence only', async () => {
  const { db, store, caseId, accountId } = realStore();
  const { evidence } = addSourceWithEvidence(store, caseId, accountId);
  const server = createResearchToolServer({ store });
  const fx = fixture({ submissions: 'ok' });
  fx.ports.evidence = server.ports.evidence;
  fx.ports.state = server.ports.state;
  const ctx = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion, phase: 'verify' });

  const verifyCheck = await call(ctx, 'save_findings', {
    findings: [{ kind: 'verification_check', statement: 'Quote matches the captured source.', supportEvidenceIds: [evidence.evidenceId], counterEvidenceIds: [] }]
  }, fx);
  assert.equal(verifyCheck.status, 'success', verifyCheck.reason ?? '');
  assert.equal(verifyCheck.staged, true);
  const stagedContent = verifyCheck.content as { status: string; submitted: { pendingRef: string | null; findingKind: string; accountIds: string[] }[]; notSubmitted: unknown[] };
  assert.equal(stagedContent.status, 'pending');
  assert.equal(stagedContent.submitted[0]?.findingKind, 'verification_check');
  assert.equal(stagedContent.submitted[0]?.pendingRef, 'pending-1');
  assert.deepEqual(stagedContent.submitted[0]?.accountIds, ['acct-1']);
  assert.deepEqual(stagedContent.notSubmitted, []);
  assert.equal(fx.commits[0]?.expectedScopeVersion, ctx.scopeVersion);
  assert.deepEqual(fx.commits[0]?.dependencies, [{ evidenceId: evidence.evidenceId, sourceRevision: 1 }]);

  const newCollection = await call(ctx, 'save_findings', {
    findings: [{ kind: 'collected_finding', statement: 'New material.', supportEvidenceIds: [], counterEvidenceIds: [] }]
  }, fx);
  assert.equal(newCollection.status, 'blocked');
  assert.match(newCollection.reason ?? '', /verify phase refused/);

  const newCoverage = await call(ctx, 'save_findings', {
    findings: [{
      kind: 'verification_check', statement: 'Sneaky coverage.', supportEvidenceIds: [], counterEvidenceIds: [],
      coverageDelta: [{ locator: { accountId, sourceId: 'src-x', sourceRevision: 1 }, taskRef: { kind: 'question_matrix', slot: 'work' }, status: 'evidence_found' }]
    }]
  }, fx);
  assert.equal(newCoverage.status, 'blocked');
  assert.match(newCoverage.reason ?? '', /verify phase refused/);

  for (const poisoned of [
    { findings: [{ kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [], status: 'completed' }] },
    { findings: [{ kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [], identitySupport: { state: 'supported' } }] },
    { findings: [{ kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [], allowedScope: { state: 'public_history' } }] }
  ]) {
    const rejected = await call(trusted({ caseId, scopeVersion: ctx.scopeVersion }), 'save_findings', poisoned, fx);
    assert.equal(rejected.status, 'blocked', JSON.stringify(poisoned));
    assert.equal(rejected.staged, false);
  }
  assert.equal(fx.commits.length, 1, 'only the valid verification check staged');
  db.close();
});

test('save_findings validates support/counter roles, foreign locators and unknown revisions', async () => {
  const { db, store, caseId, accountId } = realStore();
  const { evidence } = addSourceWithEvidence(store, caseId, accountId);
  const fx = fixture({ submissions: 'ok' });
  const real = createResearchToolServer({ store });
  fx.ports.evidence = real.ports.evidence;
  fx.ports.state = real.ports.state;
  const ctx = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion, phase: 'fetch' });

  const wrongPolarity = await call(ctx, 'save_findings', {
    findings: [{ kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [evidence.evidenceId] }]
  }, fx);
  assert.equal(wrongPolarity.status, 'blocked');
  assert.match(wrongPolarity.reason ?? '', /role mismatch/);

  const foreignLocator = await call(ctx, 'save_findings', {
    findings: [{
      kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [],
      coverageDelta: [{ locator: { accountId: 'acct-foreign', sourceId: 'src-1', sourceRevision: 1 }, taskRef: { kind: 'question_matrix', slot: 'work' }, status: 'unseen' }]
    }]
  }, fx);
  assert.equal(foreignLocator.status, 'blocked');
  assert.match(foreignLocator.reason ?? '', /foreign account/);

  const unknownRevision = await call(ctx, 'save_findings', {
    findings: [{
      kind: 'collected_finding', statement: 's', supportEvidenceIds: [], counterEvidenceIds: [],
      coverageDelta: [{ locator: { accountId, sourceId: 'src-missing', sourceRevision: 7 }, taskRef: { kind: 'question_matrix', slot: 'work' }, status: 'unseen' }]
    }]
  }, fx);
  assert.equal(unknownRevision.status, 'blocked');
  assert.match(unknownRevision.reason ?? '', /unknown source revision/);
  assert.equal(fx.commits.length, 0);
  db.close();
});

test('a commit-time scope race is refused atomically while receipts remain', async () => {
  const fx = fixture({ submissions: 'reject-commit' });
  fx.ports.evidence = fakeEvidencePort();
  const envelope = await call(trusted(), 'save_findings', inputFixtures.save_findings(), fx);
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /commit refused: stale_scope_at_commit/);
  assert.equal(envelope.staged, false);
  assert.equal(fx.commits.length, 0);
  assert.ok(envelope.actions.some((action) => action.kind === 'local_step'), 'receipts remain after the refused commit');
});

test('an unbound submission port fails closed and never writes claims or completion observations', async (t) => {
  const { db, store, caseId, accountId } = realStore();
  t.after(() => db.close());
  const { evidence } = addSourceWithEvidence(store, caseId, accountId);
  const server = createResearchToolServer({ store }); // submissions unbound
  const ctx = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion });
  const envelope = await server.dispatch(ctx, {
    tool: 'save_findings',
    input: { findings: [{ kind: 'collected_finding', statement: 's', supportEvidenceIds: [evidence.evidenceId], counterEvidenceIds: [] }] }
  }, new AbortController().signal);
  assert.equal(envelope.status, 'not_implemented');
  assert.match(envelope.reason ?? '', /pending submission port unbound/);
  assert.equal(envelope.staged, false);
  assert.equal(store.cases.listClaims(OWNER, caseId).length, 0, 'addClaim is never used as a pending store');
  assert.equal(store.completion.listCompletionObservations(OWNER, caseId, 'spec').length, 0, 'completion observations are never findings');
});

/* ------------------------------------------------------------------ */
/* Progress and capabilities                                           */
/* ------------------------------------------------------------------ */

test('report_progress derives budget from receipts and refuses model-asserted costs', async () => {
  const cumulative: UsageSummary = {
    providerRequests: 6, settledRequests: 6, unknownFeeRequests: 1, notDispatchedRequests: 0,
    localSteps: 2, estimatedUsd: null, credits: null, unaccounted: false
  };
  const fx = fixture({ cumulativeUsage: cumulative });
  const forged = await call(trusted(), 'report_progress', { note: 'fast', estimatedUsd: 0, budget: { providerRequests: 1 } }, fx);
  assert.equal(forged.status, 'blocked');
  assert.match(forged.reason ?? '', /untrusted_privilege_field/);

  const ok = await call(trusted(), 'report_progress', inputFixtures.report_progress(), fx);
  assert.equal(ok.status, 'success');
  assert.deepEqual(ok.usage, cumulative, 'cost/budget comes from receipts, not assertions');
  const content = ok.content as { note: string; gaps: string[]; recorded: boolean };
  assert.equal(content.note, 'halfway through the timeline');
  assert.deepEqual(content.gaps, ['2019 gap']);
  assert.equal(content.recorded, true);
  assert.equal(fx.progressNotes[0], 'halfway through the timeline');
});

test('get_platform_capabilities reports only confirmed capability records', async () => {
  const fx = fixture({});
  const ok = await call(trusted({ role: 'search', phase: 'search' }), 'get_platform_capabilities', { platform: 'synthetic' }, fx);
  assert.equal(ok.status, 'success');
  const content = ok.content as { operations: { operation: string; state: string }[] };
  assert.equal(content.operations.length, 6);
  assert.equal(content.operations.every((operation) => operation.state === 'supported'), true);

  const unknown = await call(trusted({ role: 'search', phase: 'search' }), 'get_platform_capabilities', { platform: 'unknown-platform' }, fx);
  assert.equal(unknown.status, 'not_applicable');
  assert.match(unknown.reason ?? '', /not in the frozen capability registry/);
});

test('every envelope stays schema-valid on refusal and failure paths', async () => {
  const envelopes: ToolEnvelope[] = [];
  const fxRefusal = fixture({ handlers: emptyHandlers });
  envelopes.push(await call(trusted(), 'list_posts', { accountId: 'acct-1', itemId: 'x' }, fxRefusal, { accountId: 'acct-1', unknownField: 1 }));
  envelopes.push(await call(trusted(), 'read_post', inputFixtures.read_post(), fixture({})));
  envelopes.push(await call(trusted({ role: 'search', phase: 'search' }), 'search_web', inputFixtures.search_web(), fixture({ refuseBudget: true })));
  envelopes.push(await call(trusted(), 'read_evidence', inputFixtures.read_evidence(), fixture({})));
  for (const envelope of envelopes) {
    assert.ok(envelopeV(envelope, 'envelope'), `envelope schema: ${JSON.stringify(envelope)}`);
  }
});

/* ------------------------------------------------------------------ */
/* Independent review regressions (F1-F12): corrected outcomes          */
/* ------------------------------------------------------------------ */

test('F1 missing fresh state fails closed at the public dispatch entry', async () => {
  for (const [tool, input, ctx] of [
    ['search_web', inputFixtures.search_web(), trusted({ role: 'search' as const, phase: 'search' as const })],
    ['read_evidence', inputFixtures.read_evidence(), trusted()],
    ['save_findings', inputFixtures.save_findings(), trusted()],
    ['load_skill', inputFixtures.load_skill(), trusted()]
  ] as Array<[ToolName, unknown, TrustedContext]>) {
    const fx = fixture({ handlers: { search_web: async () => ({ items: [], nativeCursor: null }) } });
    fx.ports.state = null;
    const envelope = await call(ctx, tool, input, fx);
    assert.equal(envelope.status, 'not_implemented', tool);
    assert.match(envelope.reason ?? '', /fresh state port unbound/);
    assert.equal(fx.executorCalls.length, 0, tool);
    assert.equal(fx.commits.length, 0, tool);
    assert.ok(envelopeV(envelope, 'envelope'));
  }
});

test('F2 authority is re-checked after awaited step accounting before any execution', async () => {
  for (const mode of ['scope', 'abort'] as const) {
    const fx = fixture({
      handlers: { search_web: async (ctx) => { await ctx.requests.run({ endpoint: 'exa.search', note: 'x' }, ctx.signal); return { items: [], nativeCursor: null }; } }
    });
    const controller = new AbortController();
    const settle = fx.ports.accounting!.settle.bind(fx.ports.accounting);
    fx.ports.accounting!.settle = async (reservation, outcome) => {
      await settle(reservation, outcome);
      if (reservation.descriptor.endpoint.includes('provider_step')) {
        if (mode === 'scope') fx.stateSnap.current.scopeVersion += 1;
        else controller.abort();
      }
    };
    const envelope = await dispatch(trusted({ role: 'search', phase: 'search' }), { tool: 'search_web', input: inputFixtures.search_web() }, fx.ports, controller.signal);
    assert.equal(envelope.status, 'blocked', mode);
    assert.equal(fx.executorCalls.length, 0, `${mode}: zero provider execution after the awaited step`);
    assert.match(envelope.reason ?? '', mode === 'scope' ? /scope refused/ : /cancelled/);
    assert.ok(envelope.actions.some((action) => action.kind === 'provider_step'), `${mode}: step receipts remain`);
  }
});

test('F2 authority is re-checked before every provider request and the next request stops', async () => {
  const fx = fixture({
    handlers: {
      read_thread: async (ctx) => {
        await ctx.requests.run({ endpoint: 'first', note: 'x' }, ctx.signal);
        fx.stateSnap.current.scopeVersion += 1;
        await ctx.requests.run({ endpoint: 'second', note: 'x' }, ctx.signal); // must never dispatch
        return threadOut();
      }
    }
  });
  const envelope = await call(trusted(), 'read_thread', inputFixtures.read_thread(), fx);
  assert.equal(fx.executorCalls.length, 1, 'only the first request reached the provider');
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /request not dispatched: scope refused/);
  const receipts = envelope.actions.filter((action) => action.kind === 'provider_request' || action.state === 'not_dispatched');
  assert.equal(receipts[0]?.state, 'completed');
  assert.equal(receipts[1]?.state, 'not_dispatched');
  assert.equal(fx.settleCalls.get(receipts[0]?.actionId ?? ''), 1, 'the executed request settles exactly once');
});

test('F2 the original dispatch AbortSignal cannot be bypassed by handler-supplied signals', async () => {
  const controller = new AbortController();
  const fx = fixture({
    handlers: {
      search_web: async (ctx) => {
        controller.abort(); // the dispatch is cancelled mid-call
        await ctx.requests.run({ endpoint: 'exa.search', note: 'x' }, new AbortController().signal); // fresh foreign signal
        return { items: [], nativeCursor: null };
      }
    }
  });
  const envelope = await dispatch(trusted({ role: 'search', phase: 'search' }), { tool: 'search_web', input: inputFixtures.search_web() }, fx.ports, controller.signal);
  assert.equal(envelope.status, 'blocked');
  assert.equal(fx.executorCalls.length, 0, 'a handler-supplied signal cannot resurrect a cancelled dispatch');

  const fx2 = fixture({
    handlers: {
      search_web: async (ctx) => {
        const foreign = new AbortController();
        foreign.abort();
        await ctx.requests.run({ endpoint: 'exa.search', note: 'x' }, foreign.signal); // foreign signal aborted
        return { items: [], nativeCursor: null };
      }
    }
  });
  const envelope2 = await dispatch(trusted({ role: 'search', phase: 'search' }), { tool: 'search_web', input: inputFixtures.search_web() }, fx2.ports, new AbortController().signal);
  assert.equal(envelope2.status, 'blocked');
  assert.equal(fx2.executorCalls.length, 0, 'an aborted handler signal also stops the new request');
});

test('F2 a late abort withholds usable content while receipts settle', async () => {
  const controller = new AbortController();
  const fx = fixture({
    handlers: {
      search_web: async (ctx) => {
        await ctx.requests.run({ endpoint: 'exa.search', note: 'x' }, ctx.signal);
        controller.abort();
        return { items: [{ clueKind: 'source', title: 't', excerpt: 'e', limitation: null, metadata: okMetadata() }], nativeCursor: null };
      }
    }
  });
  const envelope = await dispatch(trusted({ role: 'search', phase: 'search' }), { tool: 'search_web', input: inputFixtures.search_web() }, fx.ports, controller.signal);
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /cancelled/);
  assert.equal(envelope.content, null, 'late results are withheld');
  assert.equal(envelope.actions.filter((action) => action.kind === 'provider_request' && action.state === 'completed').length, 1, 'the executed receipt settles');
});

test('F3 real Store evidence outside the trusted slice or allowedScope none is refused for read and save', async (t) => {
  for (const mode of ['outside', 'none'] as const) {
    const { db, store, caseId, accountId } = realStore();
    t.after(() => db.close());
    const { evidence } = addSourceWithEvidence(store, caseId, accountId);
    if (mode === 'none') {
      store.cases.updateAccountFacets(
        { ownerId: OWNER, caseId, accountId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion },
        { allowedScope: { state: 'none', note: null } }
      );
    }
    const fx = fixture({ submissions: 'ok' });
    const server = createResearchToolServer({ store, accounting: fx.ports.accounting, submissions: fx.ports.submissions });
    const ctx = trusted({
      caseId,
      scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion,
      accounts: mode === 'outside' ? [] : [{ accountId, platform: 'synthetic', handle: 'ada', allowedScope: 'none' }]
    });
    const read = await server.dispatch(ctx, { tool: 'read_evidence', input: { evidence: [{ evidenceId: evidence.evidenceId }] } }, new AbortController().signal);
    assert.equal(read.status, 'blocked', mode);
    const save = await server.dispatch(ctx, {
      tool: 'save_findings',
      input: { findings: [{ kind: 'verification_check', statement: 'check', supportEvidenceIds: [evidence.evidenceId], counterEvidenceIds: [] }] }
    }, new AbortController().signal);
    assert.equal(save.status, 'blocked', mode);
    assert.equal(save.staged, false, mode);
    assert.equal(fx.commits.length, 0, mode);
    assert.equal(fx.executorCalls.length, 0, mode);
  }
});

test('F3 profile_only reads pinned profile evidence but never historical evidence', async (t) => {
  const { db, store, caseId, accountId } = realStore();
  t.after(() => db.close());
  const write = { ownerId: OWNER, caseId, accountId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion };
  // Profile material: originalUrl exactly matches the real account.profileUrl.
  const profileSource = store.cases.recordSourceRevision(write, {
    author: 'Ada',
    originalUrl: 'https://fixture.test/ada',
    title: 'Ada profile',
    publishedAt: null,
    retrievedAt: '2026-01-02T00:00:00.000Z',
    locator: null,
    contentHash: 'c'.repeat(64),
    provenance: { authorization: 'not_recorded', collector: 'synthetic-fixture', note: null }
  });
  const profileEvidence = store.cases.addEvidence(write, {
    sourceId: profileSource.sourceId,
    sourceRevision: 1,
    role: 'identity_support',
    quote: 'Ada builds compilers.',
    locator: null,
    provenance: { authorization: 'not_recorded', collector: 'synthetic-fixture', note: null }
  });
  const { evidence: historyEvidence } = addSourceWithEvidence(store, caseId, accountId);
  store.cases.updateAccountFacets(
    { ownerId: OWNER, caseId, accountId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion },
    { allowedScope: { state: 'profile_only', note: null } }
  );
  const fx = fixture({ submissions: 'ok' });
  const server = createResearchToolServer({ store, submissions: fx.ports.submissions });
  const scopeVersion = store.cases.getCase(OWNER, caseId)!.scopeVersion;
  const narrow = trusted({ caseId, scopeVersion, accounts: [{ accountId, platform: 'synthetic', handle: 'ada', allowedScope: 'profile_only' }] });

  const profileRead = await server.dispatch(narrow, { tool: 'read_evidence', input: { evidence: [{ evidenceId: profileEvidence.evidenceId }] } }, new AbortController().signal);
  assert.equal(profileRead.status, 'success', profileRead.reason ?? '');

  const historyRead = await server.dispatch(narrow, { tool: 'read_evidence', input: { evidence: [{ evidenceId: historyEvidence.evidenceId }] } }, new AbortController().signal);
  assert.equal(historyRead.status, 'blocked');
  assert.match(historyRead.reason ?? '', /profile_only cannot read history/);

  const save = await server.dispatch(narrow, {
    tool: 'save_findings',
    input: { findings: [{ kind: 'verification_check', statement: 'check', supportEvidenceIds: [historyEvidence.evidenceId], counterEvidenceIds: [] }] }
  }, new AbortController().signal);
  assert.equal(save.status, 'blocked');
  assert.equal(save.staged, false);
  assert.equal(fx.commits.length, 0, 'no historical finding staged under profile_only');

  // public_history keeps authorized pinned source access (current Store scope
  // restored too: the trusted snapshot never widens fresh state).
  store.cases.updateAccountFacets(
    { ownerId: OWNER, caseId, accountId, expectedScopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion },
    { allowedScope: { state: 'public_history', note: null } }
  );
  const wide = trusted({ caseId, scopeVersion: store.cases.getCase(OWNER, caseId)!.scopeVersion, accounts: [{ accountId, platform: 'synthetic', handle: 'ada', allowedScope: 'public_history' }] });
  const wideRead = await server.dispatch(wide, { tool: 'read_evidence', input: { evidence: [{ evidenceId: historyEvidence.evidenceId }] } }, new AbortController().signal);
  assert.equal(wideRead.status, 'success', wideRead.reason ?? '');
});

test('F4 candidate dependencies can never be accepted unverified', async () => {
  const fx = fixture();
  fx.ports.evidence = null;
  let writes = 0;
  fx.ports.controller = {
    async submitCandidates() { writes += 1; return { batchRef: 'batch' }; },
    async requestConfirmation() { writes += 1; return { confirmationRef: 'c' }; },
    async reportProgress() { writes += 1; }
  };
  const envelope = await call(trusted({ role: 'search', phase: 'search' }), 'submit_candidates', {
    candidates: [{ candidateRef: 'c', platform: 'synthetic', handle: 'a', supportEvidenceIds: ['nonexistent'], counterEvidenceIds: [], sourceGroup: null }]
  }, fx);
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /evidence read port unbound/);
  assert.equal(writes, 0, 'no controller write happened');
});

test('F4 controller writes carry commit obligations and are gated before the side effect', async () => {
  const stale = fixture();
  let writes = 0;
  stale.ports.controller = {
    async submitCandidates() { writes += 1; return { batchRef: 'b' }; },
    async requestConfirmation() { writes += 1; return { confirmationRef: 'c' }; },
    async reportProgress() { writes += 1; }
  };
  const settle = stale.ports.accounting!.settle.bind(stale.ports.accounting);
  stale.ports.accounting!.settle = async (reservation, outcome) => {
    await settle(reservation, outcome);
    if (reservation.descriptor.endpoint.includes('local_step')) stale.stateSnap.current.scopeVersion += 1;
  };
  const blocked = await call(trusted({ role: 'search', phase: 'search' }), 'request_confirmation', inputFixtures.request_confirmation(), stale);
  assert.equal(blocked.status, 'blocked');
  assert.equal(writes, 0, 'the confirmation write never happened under stale scope');

  const rejecting = fixture({ controllerReject: true });
  const refused = await call(trusted({ role: 'search', phase: 'search' }), 'request_confirmation', inputFixtures.request_confirmation(), rejecting);
  assert.equal(refused.status, 'blocked');
  assert.match(refused.reason ?? '', /commit refused: stale_scope_at_commit/);

  const ok = fixture();
  const accepted = await call(trusted({ role: 'search', phase: 'search' }), 'request_confirmation', inputFixtures.request_confirmation(), ok);
  assert.equal(accepted.status, 'success');
  const commit = ok.controllerCommits[0]!;
  assert.equal(commit.ownerId, OWNER);
  assert.equal(commit.caseId, CASE);
  assert.equal(commit.expectedScopeVersion, 3);
});

test('F5 comment cursors bind to the post and search cursors to the query window', async () => {
  let commentCalls = 0;
  let searchCalls = 0;
  let lastNative: string | null = null;
  const fx = fixture({
    handlers: {
      list_comments: async (ctx) => {
        commentCalls += 1;
        lastNative = ctx.cursor.nativeCursor;
        return { items: [], ordering: 'provider_default', nativeCursor: 'page2' };
      },
      search_web: async (ctx) => {
        searchCalls += 1;
        lastNative = ctx.cursor.nativeCursor;
        await ctx.requests.run({ endpoint: 'exa.search', note: 'x' }, ctx.signal);
        return { items: [], nativeCursor: 'page2' };
      }
    }
  });
  const first = await call(trusted(), 'list_comments', { accountId: 'acct-1', itemId: 'post-A' }, fx);
  assert.equal(first.status, 'success');
  const beforeCross = commentCalls;
  const crossPost = await call(trusted(), 'list_comments', { accountId: 'acct-1', itemId: 'post-B', cursor: first.cursor.token }, fx);
  assert.equal(crossPost.status, 'blocked');
  assert.match(crossPost.reason ?? '', /cursor refused/);
  assert.equal(commentCalls, beforeCross, 'cross-post replay never reached the handler');
  const samePost = await call(trusted(), 'list_comments', { accountId: 'acct-1', itemId: 'post-A', cursor: first.cursor.token }, fx);
  assert.equal(samePost.status, 'success', 'the same request identity keeps its legitimate next page');
  assert.equal(lastNative, 'page2');

  const search = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', { query: 'query A' }, fx);
  assert.equal(search.status, 'success');
  const beforeQuery = searchCalls;
  const crossQuery = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', { query: 'query B', cursor: search.cursor.token }, fx);
  assert.equal(crossQuery.status, 'blocked');
  assert.match(crossQuery.reason ?? '', /cursor refused/);
  assert.equal(searchCalls, beforeQuery, 'cross-query replay never reached the handler');
});

test('F6 unverified or absent capability records never authorize sort/date/depth', async () => {
  for (const mode of ['unverified', 'absent'] as const) {
    const ctx = trusted();
    const entry = ctx.capabilities.operations.find((operation) => operation.operation === 'list_posts')!;
    if (mode === 'unverified') entry.state = 'unverified';
    else ctx.capabilities.operations.splice(ctx.capabilities.operations.indexOf(entry), 1);
    const fx = fixture({ handlers: { list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }) } });
    const envelope = await call(ctx, 'list_posts', { accountId: 'acct-1', sort: 'new' }, fx);
    assert.equal(envelope.status, 'blocked', mode);
    assert.match(envelope.reason ?? '', /capability refused/);
    assert.equal(fx.executorCalls.length, 0, mode);
    assert.equal(fx.settleCalls.size, 0, mode);
  }
  // A catalog record or sortOptions array is never capability confirmation:
  // even an unconstrained read of an unverified operation fails closed.
  const ctx = trusted();
  ctx.capabilities.operations.find((operation) => operation.operation === 'list_posts')!.state = 'unverified';
  const fx = fixture({ handlers: { list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }) } });
  const envelope = await call(ctx, 'list_posts', { accountId: 'acct-1' }, fx);
  assert.equal(envelope.status, 'blocked');
  assert.match(envelope.reason ?? '', /not confirmed supported/);
  assert.equal(fx.executorCalls.length, 0);
});

test('F7 thread and media outputs bind to the request locator while third-party ancestors survive', async () => {
  const foreignRoot = fixture({
    handlers: {
      read_thread: async () => threadOut({
        nodes: [threadNode({ nodeId: 'unrelated', rootNodeId: 'other-post', authorAccountId: 'acct-third', authorRole: 'third_party' })],
        missingNodeIds: []
      })
    }
  });
  const wrongRoot = await call(trusted(), 'read_thread', { accountId: 'acct-1', itemId: 'post-A' }, foreignRoot);
  assert.equal(wrongRoot.status, 'failed');
  assert.match(wrongRoot.reason ?? '', /foreign root locator/);

  const foreignMedia = fixture({
    handlers: {
      read_media: async () => ({ mediaRef: 'media-OTHER', text: 'unrelated', captions: null, mediaUnread: false, conversion: { authorized: false, state: 'not_attempted', note: null }, metadata: okMetadata() })
    }
  });
  const wrongMedia = await call(trusted(), 'read_media', inputFixtures.read_media(), foreignMedia);
  assert.equal(wrongMedia.status, 'failed');
  assert.match(wrongMedia.reason ?? '', /substituted target locator/);

  // Positive counterpart: the requested thread keeps third-party ancestors,
  // deleted/missing nodes and honest text.
  const okFx = fixture({
    handlers: {
      read_thread: async () => threadOut({
        nodes: [
          threadNode({ nodeId: 'root-1', text: 'The original post.' }),
          threadNode({ nodeId: 'ask-1', parentNodeId: 'root-1', authorAccountId: 'acct-third', authorRole: 'third_party', text: 'The question needed to interpret the reply.', metadata: okMetadata({ author: 'Third Party' }) }),
          threadNode({ nodeId: 'gone-1', parentNodeId: 'ask-1', authorAccountId: 'acct-third', authorRole: 'third_party', state: 'deleted', text: null, textUnavailableReason: 'deleted node', metadata: okMetadata({ author: null, publishedAt: null }) })
        ],
        missingNodeIds: ['gone-1']
      })
    }
  });
  const okThread = await call(trusted(), 'read_thread', inputFixtures.read_thread(), okFx);
  assert.equal(okThread.status, 'success', okThread.reason ?? '');

  // A requested parentRef must be represented (node or explicit missing id).
  const omittedParent = fixture({
    handlers: {
      read_thread: async () => threadOut({ nodes: [threadNode({ nodeId: 'root-1' })], missingNodeIds: [] })
    }
  });
  const missingParent = await call(trusted(), 'read_thread', { accountId: 'acct-1', itemId: 'item-1', parentRef: 'ask-99' }, omittedParent);
  assert.equal(missingParent.status, 'failed');
  assert.match(missingParent.reason ?? '', /omits the requested parentRef/);
});

test('F8 HTTP failures are failed settled attempts that fail-stop and keep earlier output as partial', async () => {
  let plannedThird = false;
  const fx = fixture({
    script: (call) => (call === 2
      ? { status: 500, body: {}, fee: { estimatedUsd: 0.002, credits: null } }
      : { status: 200, body: {}, fee: { estimatedUsd: 0.001, credits: null } }),
    handlers: {
      read_thread: async (ctx) => {
        await ctx.requests.run({ endpoint: 'first', note: 'x' }, ctx.signal);
        try {
          await ctx.requests.run({ endpoint: 'second', note: 'x' }, ctx.signal);
        } catch {
          // failed settled attempt
        }
        try {
          plannedThird = true;
          await ctx.requests.run({ endpoint: 'third', note: 'planned' }, ctx.signal);
        } catch {
          // never dispatched
        }
        return threadOut({
          nodes: [threadNode({ nodeId: 'root-1', text: 'kept result' })],
          missingNodeIds: []
        });
      }
    }
  });
  const envelope = await call(trusted(), 'read_thread', inputFixtures.read_thread(), fx);
  assert.equal(envelope.status, 'partial');
  assert.equal(plannedThird, true);
  assert.equal(fx.executorCalls.length, 2, 'the third request never executed');
  const content = envelope.content as { nodes: { text: string }[] };
  assert.equal(content.nodes[0]?.text, 'kept result', 'earlier successful output survives the later failure');
  const receipts = envelope.actions.filter((action) => action.kind === 'provider_request' || action.state === 'not_dispatched');
  assert.equal(receipts[0]?.state, 'completed');
  assert.equal(receipts[1]?.state, 'failed', 'HTTP 500 is a failed settled attempt, never a success');
  assert.equal(receipts[1]?.estimatedUsd, 0.002, 'a valid fee on the failed attempt stays known');
  assert.equal(receipts[2]?.state, 'not_dispatched');
  assert.equal(fx.settleCalls.get(receipts[1]?.actionId ?? ''), 1, 'the failed attempt settles exactly once');
  assert.ok(envelopeV(envelope, 'envelope'));
});

test('F8 invalid provider fees become unknown with a diagnostic and valid envelopes', async () => {
  const fx = fixture({
    script: () => ({ status: 200, body: {}, fee: { estimatedUsd: -1, credits: Number.NaN } }),
    handlers: { search_web: async (ctx) => { await ctx.requests.run({ endpoint: 'exa.search', note: 'x' }, ctx.signal); return { items: [], nativeCursor: null }; } }
  });
  const envelope = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', inputFixtures.search_web(), fx);
  assert.equal(envelope.status, 'success');
  assert.ok(envelope.gaps.some((gap) => gap.code === 'invalid_fee'), 'invalid metering is called out, not hidden');
  assert.equal(envelope.usage.estimatedUsd, null);
  assert.equal(envelope.usage.credits, null);
  assert.equal(envelope.usage.unknownFeeRequests, 1);
  const receipt = envelope.actions.find((action) => action.kind === 'provider_request');
  assert.equal(receipt?.estimatedUsd, null);
  assert.equal(receipt?.credits, null);
  assert.equal(receipt?.state, 'completed');
  assert.ok(envelopeV(envelope, 'envelope'), 'the final envelope stays schema-valid with billing evidence intact');
});

test('F9 partial batch submission returns a truthful partial receipt with accepted pending refs', async () => {
  const fx = fixture({ submissions: 'reject-second' });
  fx.ports.evidence = fakeEvidencePort();
  const finding = { kind: 'verification_check', statement: 'check', supportEvidenceIds: ['ev-1'], counterEvidenceIds: [] };
  const envelope = await call(trusted({ phase: 'verify' }), 'save_findings', { findings: [finding, finding] }, fx);
  assert.equal(envelope.status, 'partial');
  assert.equal(envelope.staged, true, 'an accepted write is never denied');
  const content = envelope.content as { submitted: { pendingRef: string | null; findingKind: string; accountIds: string[] }[]; notSubmitted: { index: number; reason: string }[] };
  assert.deepEqual(content.submitted.map((entry) => entry.pendingRef), ['pending-1']);
  assert.equal(content.submitted[0]?.findingKind, 'verification_check');
  assert.deepEqual(content.submitted[0]?.accountIds, ['acct-1']);
  assert.equal(content.notSubmitted.length, 1);
  assert.equal(content.notSubmitted[0]?.index, 1);
  assert.match(content.notSubmitted[0]?.reason ?? '', /commit refused: stale_scope_at_commit/);
  assert.equal(fx.commits.length, 1, 'no automatic whole-batch retry');
  assert.ok(envelopeV(envelope, 'envelope'));
});

test('F9 an unexpected submission failure reports an unknown commit outcome without retry', async () => {
  const fx = fixture({ submissions: 'fail-unexpected-second' });
  fx.ports.evidence = fakeEvidencePort();
  const finding = { kind: 'verification_check', statement: 'check', supportEvidenceIds: ['ev-1'], counterEvidenceIds: [] };
  const envelope = await call(trusted({ phase: 'verify' }), 'save_findings', { findings: [finding, finding] }, fx);
  assert.equal(envelope.status, 'partial');
  assert.ok(envelope.gaps.some((gap) => gap.code === 'commit_outcome_unknown'));
  const content = envelope.content as { notSubmitted: { index: number; reason: string }[] };
  assert.match(content.notSubmitted[0]?.reason ?? '', /commit outcome unknown/);
  assert.equal(fx.commits.length, 1);

  const firstFx = fixture();
  firstFx.ports.evidence = fakeEvidencePort();
  firstFx.ports.submissions = { async stagePendingFinding() { throw new Error('port crashed'); } };
  const first = await call(trusted({ phase: 'verify' }), 'save_findings', { findings: [finding] }, firstFx);
  assert.equal(first.status, 'failed');
  assert.match(first.reason ?? '', /commit outcome unknown/);
  assert.equal(first.staged, false);
  assert.ok(envelopeV(first, 'envelope'));
});

test('F10 each finding derives its own authorized account set', async () => {
  const fx = fixture({ submissions: 'ok' });
  const base = fakeEvidencePort();
  fx.ports.evidence = {
    ...base,
    readEvidence: (req) => {
      const result = base.readEvidence(req);
      if (result.evidence) {
        result.evidence = { ...result.evidence, evidenceId: req.evidenceId, accountId: req.evidenceId === 'ev-2' ? 'acct-2' : 'acct-1' };
      }
      return result;
    }
  };
  fx.stateSnap.current.accounts.push({ accountId: 'acct-2', allowedScope: 'public_history' });
  const ctx = trusted();
  ctx.accounts.push({ accountId: 'acct-2', platform: 'synthetic', handle: 'b', allowedScope: 'public_history' });
  const envelope = await call(ctx, 'save_findings', {
    findings: [
      { kind: 'verification_check', statement: 'check 1', supportEvidenceIds: ['ev-1'], counterEvidenceIds: [] },
      { kind: 'verification_check', statement: 'check 2', supportEvidenceIds: ['ev-2'], counterEvidenceIds: [] }
    ]
  }, fx);
  assert.equal(envelope.status, 'success', envelope.reason ?? '');
  assert.deepEqual(fx.commits.map((commit) => commit.accountIds), [['acct-1'], ['acct-2']], 'no carryover from the first dependency');
  assert.deepEqual(fx.commits[1]?.dependencies, [{ evidenceId: 'ev-2', sourceRevision: 1 }]);
});

test('F11 thread nodes carry readable text with explicit unavailability reasons', async () => {
  const withText = fixture({
    handlers: {
      read_thread: async () => threadOut({
        nodes: [threadNode({ nodeId: 'item-1', authorAccountId: 'acct-third', authorRole: 'third_party', text: 'The question needed to interpret the reply.', metadata: okMetadata({ author: 'Third Party' }) })],
        missingNodeIds: []
      })
    }
  });
  const ok = await call(trusted(), 'read_thread', inputFixtures.read_thread(), withText);
  assert.equal(ok.status, 'success', ok.reason ?? '');
  const nodes = (ok.content as { nodes: { text: string | null; textUnavailableReason: string | null }[] }).nodes;
  assert.equal(nodes[0]?.text, 'The question needed to interpret the reply.', 'third-party dialogue text is representable');
  assert.equal(nodes[0]?.textUnavailableReason, null);

  const missingNode = fixture({
    handlers: {
      read_thread: async () => threadOut({
        nodes: [threadNode({ nodeId: 'gone', authorAccountId: 'acct-third', authorRole: 'unknown', state: 'missing', text: null, textUnavailableReason: 'parent node not returned by the endpoint', metadata: okMetadata({ author: null, publishedAt: null }) })],
        missingNodeIds: ['gone']
      })
    }
  });
  const okMissing = await call(trusted(), 'read_thread', inputFixtures.read_thread(), missingNode);
  assert.equal(okMissing.status, 'success', okMissing.reason ?? '');

  for (const bad of [
    threadNode({ nodeId: 'n1', state: 'missing', text: null, textUnavailableReason: null, metadata: okMetadata({ author: null, publishedAt: null }) }),
    threadNode({ nodeId: 'n2', state: 'missing', text: 'impossible text', textUnavailableReason: null, metadata: okMetadata({ author: null, publishedAt: null }) }),
    threadNode({ nodeId: 'n3', text: 'readable', textUnavailableReason: 'contradictory reason' })
  ]) {
    const badFx = fixture({ handlers: { read_thread: async () => threadOut({ nodes: [bad], missingNodeIds: [String(bad.nodeId)] }) } });
    const refused = await call(trusted(), 'read_thread', inputFixtures.read_thread(), badFx);
    assert.equal(refused.status, 'failed', JSON.stringify(bad.nodeId));
    assert.match(refused.reason ?? '', /node text|readable text|explicit reason/);
  }
});

test('F12 prototype-named unknown input and output keys are refused like any unknown key', async () => {
  const fx = fixture({ handlers: { list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null }) } });
  const forged = await call(trusted(), 'list_posts', inputFixtures.list_posts(), fx,
    JSON.parse('{"accountId":"acct-1","constructor":42,"__proto__":{"unrelated":true},"toString":"x"}'));
  assert.equal(forged.status, 'blocked');
  assert.match(forged.reason ?? '', /unknown_key/);
  assert.equal(fx.executorCalls.length, 0);

  const outFx = fixture({
    handlers: {
      list_posts: async () => ({ items: [], sort: 'new', nativeCursor: null, constructor: 42 })
    }
  });
  const badOutput = await call(trusted(), 'list_posts', inputFixtures.list_posts(), outFx);
  assert.equal(badOutput.status, 'failed');
  assert.match(badOutput.reason ?? '', /unknown_key/);
  assert.ok(envelopeV(badOutput, 'envelope'));
});


test('pending batches recheck cancellation, scope and withdrawal between commits', async () => {
  for (const mode of ['abort', 'scope', 'withdrawal', 'allowed'] as const) {
    const fx = fixture();
    fx.ports.evidence = fakeEvidencePort();
    const controller = new AbortController();
    fx.ports.submissions = {
      async stagePendingFinding(commit) {
        fx.commits.push(commit);
        await Promise.resolve();
        if (fx.commits.length === 1) {
          if (mode === 'abort') controller.abort();
          if (mode === 'scope') fx.stateSnap.current.scopeVersion += 1;
          if (mode === 'withdrawal') fx.stateSnap.revoked.push('ev-1');
        }
        return { pendingRef: `pending-${fx.commits.length}` };
      }
    };
    const finding = { kind: 'verification_check', statement: 'check', supportEvidenceIds: ['ev-1'], counterEvidenceIds: [] };
    const result = await dispatch(trusted({ phase: 'verify' }), { tool: 'save_findings', input: { findings: [finding, finding] } }, fx.ports, controller.signal);
    assert.equal(fx.commits.length, mode === 'allowed' ? 2 : 1, mode);
    assert.equal(result.status, mode === 'allowed' ? 'success' : 'partial', mode);
    assert.equal(result.staged, true, 'the first accepted write remains visible');
    const content = result.content as { submitted: { pendingRef: string }[]; notSubmitted: { index: number; reason: string }[] };
    assert.equal(content.submitted[0]?.pendingRef, 'pending-1');
    if (mode !== 'allowed') {
      assert.equal(content.notSubmitted[0]?.index, 1);
      assert.match(content.notSubmitted[0]?.reason ?? '', mode === 'abort' ? /cancelled/ : mode === 'scope' ? /scope refused/ : /withdrawn/);
    }
    assert.ok(envelopeV(result, 'envelope'));
  }
});

test('long handler errors preserve settled receipts in a valid failure envelope', async () => {
  for (const length of [20, 2200]) {
    const fx = fixture({ handlers: {
      search_web: async (ctx) => {
        await ctx.requests.run({ endpoint: 'exa.search', note: 'synthetic' }, ctx.signal);
        throw new Error('x'.repeat(length));
      }
    } });
    const result = await call(trusted({ role: 'search', phase: 'search' }), 'search_web', inputFixtures.search_web(), fx);
    assert.equal(result.status, 'failed');
    assert.equal(result.content, null);
    assert.ok(result.reason && result.reason.length <= 2000);
    assert.equal(result.reason.endsWith('… [truncated]'), length > 2000);
    const receipts = result.actions.filter((action) => action.kind === 'provider_request');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.state, 'completed');
    assert.equal(fx.settleCalls.get(receipts[0]!.actionId!), 1);
    assert.ok(envelopeV(result, 'envelope'));
  }
});


test('discovery issues a bound next-page cursor and refuses changed query or rules', async () => {
  const seen: (string | null)[] = [];
  const fx = fixture({ handlers: { discover_accounts: async (ctx) => {
    seen.push(ctx.cursor.nativeCursor);
    await ctx.requests.run({ endpoint: 'discovery.page', note: 'synthetic' }, ctx.signal);
    return { discoveryStatus: 'candidates', stopReason: null, nativeCursor: seen.length === 1 ? 'native-next' : null, items: [] };
  } } });
  const context = trusted({ role: 'search', phase: 'search' });
  const input = { platform: 'synthetic', query: 'ada', rules: 'public-profile' };
  const first = await call(context, 'discover_accounts', input, fx);
  assert.equal(first.status, 'success', first.reason ?? '');
  assert.ok(first.cursor.token);
  const second = await call(context, 'discover_accounts', { ...input, cursor: first.cursor.token }, fx);
  assert.equal(second.status, 'success', second.reason ?? '');
  assert.deepEqual(seen, [null, 'native-next']);
  assert.deepEqual(second.cursor, { token: null, nativeCursor: null }, 'terminal page has no continuation');
  for (const changed of [{ query: 'other' }, { rules: 'different' }]) {
    const refused = await call(context, 'discover_accounts', { ...input, ...changed, cursor: first.cursor.token }, fx);
    assert.equal(refused.status, 'blocked');
  }
  assert.equal(fx.executorCalls.length, 2);
  assert.ok(envelopeV(first, 'envelope'));
});

test('a maximum-capacity multi-account finding preserves its accepted receipt', async () => {
  const fx = fixture({ submissions: 'ok' });
  const context = trusted();
  const accounts = Array.from({ length: 300 }, (_, i) => ({ accountId: `acct-${i}`, platform: 'synthetic', handle: `h${i}`, allowedScope: 'public_history' as const }));
  context.accounts = accounts;
  fx.stateSnap.current.accounts = accounts;
  const base = fakeEvidencePort();
  fx.ports.evidence = { ...base, readEvidence(req) {
    const result = base.readEvidence(req);
    const index = Number(req.evidenceId.slice(3));
    return { ...result, evidence: { ...result.evidence!, evidenceId: req.evidenceId, accountId: `acct-${index}`, role: index < 100 ? 'factual_support' : 'factual_counterevidence' } };
  } };
  const result = await call(context, 'save_findings', { findings: [{
    kind: 'collected_finding', statement: 'Synthetic synthesis.',
    supportEvidenceIds: Array.from({ length: 100 }, (_, i) => `ev-${i}`),
    counterEvidenceIds: Array.from({ length: 100 }, (_, i) => `ev-${100 + i}`),
    coverageDelta: Array.from({ length: 100 }, (_, i) => ({
      locator: { accountId: `acct-${200 + i}`, sourceId: 'src-1', sourceRevision: 1 },
      taskRef: { kind: 'question_matrix', slot: 'work' }, status: 'evidence_found'
    }))
  }] }, fx);
  assert.equal(result.status, 'success', result.reason ?? '');
  assert.equal(result.staged, true);
  assert.equal(fx.commits.length, 1);
  const submitted = (result.content as { submitted: { pendingRef: string; accountIds: string[]; dependencyEvidenceIds: string[] }[] }).submitted;
  assert.equal(submitted[0]?.pendingRef, 'pending-1');
  assert.equal(submitted[0]?.accountIds.length, 300);
  assert.equal(submitted[0]?.dependencyEvidenceIds.length, 200);
  assert.ok(envelopeV(result, 'envelope'));
});

test('local skill metadata requires its declared reason', () => {
  const output = { skillId: 'skill', version: 'v1', hash: 'h', body: 'body', dependencies: [], metadata: { applicable: false, reason: 'local_skill' } };
  assert.ok(loadSkillOutputV(output, 'output'));
  for (const reason of ['', 'controller_ack']) {
    assert.throws(() => loadSkillOutputV({ ...output, metadata: { applicable: false, reason } }, 'output'));
  }
});
