/**
 * TEST ONLY: opt-in existing evidence, against unchanged production main.
 * Existing public route handlers + real in-memory Store/FirstStepStore/Runner.
 * Every provider boundary is injected; no HTTP listener, production DB or real
 * fetch is used. New production types/exports are intentionally not imported.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHash } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { seedFirstStep, type SeededFirstStep } from './first-step-fixtures.js';
import { waitFor } from './harness.js';
import { Runner } from '../server/services/runner.js';
import { registerRunRoutes } from '../server/routes/runs.js';
import { HttpError } from '../server/http/errors.js';
import { FirstStepStore } from '../server/research/first-step-store.js';
import { Store } from '../server/store.js';
import type { ResearchCheckpoint, StoredPage } from '../server/research/research-store.js';
import type { ResearchPlanner } from '../server/research/planner.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from '../server/research/tool-contracts.js';
import type { XAccountProvider } from '../server/research/x-account-contracts.js';
import type { HttpResponseLike } from '../server/adapters/types.js';
import type { AppConfig } from '../server/config.js';
import type { RunRecord } from '../server/store.js';
import { asScopeVersion } from '../shared/research-case.js';
import { buildResearchReport } from '../server/research/controller.js';
import { RESEARCH_LIMITS } from '../server/research/research-store.js';

// A hard network backstop, in addition to the injected transport/tools below.
// Restore the file-local mock tracker after every test; credentials stay untouched.
test.beforeEach(() => {
  mock.method(globalThis, 'fetch', async () => { throw new Error('real_network_forbidden'); });
});
test.afterEach(() => { mock.restoreAll(); });

const OWNER = 'user-owner';
const HOME = 'https://fixture-followup-home.org/';
const ABOUT = 'https://fixture-followup-home.org/about';
const X_URL = 'https://x.com/fixture_author';
const MEDIUM = 'https://medium.com/@fixture_writer';
const OUTSIDE = 'https://fixture-unsolicited-outsider.net/note';
const HOME_QUOTE = 'I maintain the Fixture compiler notes.';
const MEDIUM_QUOTE = 'I publish independent Fixture essays.';
const BILLING_GAP = `所选账号初始材料未读取成功（provider_billing）：${X_URL}；不代表无资料。`;
const HISTORY_GAP = '历史时间线尚未枚举完成；分母未知不显示假百分比。';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function page(sourceKey: string, url: string, text: string, extra: Partial<StoredPage> = {}): StoredPage {
  return { sourceKey, url, title: `Synthetic ${sourceKey}`, text, kind: 'profile', publishedAt: null,
    links: [], limitations: [], retrieval: 'read', ...extra };
}
function addSource(f: SeededFirstStep, runId: string, p: StoredPage): void {
  f.store.addSource(runId, { key: p.sourceKey, url: p.url, title: p.title, kind: p.kind, publishedAt: null,
    excerpt: p.text, excerptLocator: '公开页面文本', identityLabel: 'Synthetic parent material',
    identityConfirmed: true, fetchStatus: 'ok', limits: [] }, 0);
}

/** Multiselected parent (two merged + one independent) with real evidence and one billing-failed X read. */
function followupFixture(): SeededFirstStep & { parentCp: ResearchCheckpoint } {
  const f = seedFirstStep({ question: '研究这位创作者的公开作品',
    accounts: [
      { url: HOME },
      { url: X_URL, supportedBy: { sourceUrl: HOME, quote: `My X account: ${X_URL}` } },
      { url: MEDIUM, supportedBy: { sourceUrl: HOME, quote: `My Medium: ${MEDIUM}` } }
    ] });
  const current = f.firstStep.getFirstStepView(OWNER, f.run.id)!;
  if (current.mode !== 'first_step') throw new Error('wrong fixture mode');
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: current.view.selection.scopeVersion,
    discoveryRevision: current.view.discoveryRevision,
    clusterId: current.view.clusters[0]!.clusterId,
    accounts: [
      { accountId: f.accountIdFor(0), selection: 'selected', excluded: false },
      { accountId: f.accountIdFor(1), selection: 'selected', excluded: false },
      { accountId: f.accountIdFor(2), selection: 'only_this_account', excluded: false }
    ]
  }, 'followup-evidence-select');
  const cp = f.store.research.checkpoint(f.run.id)!;
  cp.anchorUrl = HOME;
  cp.identity = { displayName: 'Fixture Person', handle: null, profileUrl: HOME, status: 'resolved', note: null, candidates: [] };
  cp.pages = [
    page('S2', HOME, `${HOME_QUOTE} Public notes follow.`, { retrieval: 'profile' }),
    page('S5', ABOUT, 'About page with further Fixture details.', { discoveredFrom: ['S2'] }),
    page('S7', MEDIUM, MEDIUM_QUOTE, { kind: 'work' }),
    page('S9', `${HOME}withdrawn`, 'Withdrawn fixture page.'),
    page('S11', OUTSIDE, 'Unsolicited outsider material.')
  ];
  cp.claims = [{ sourceKey: 'S2', quote: HOME_QUOTE, statement: HOME_QUOTE, kind: 'attributed_statement', section: 'work' }];
  cp.unknowns = [BILLING_GAP, HISTORY_GAP];
  cp.coverageGaps = ['默认评论页尚未读取。'];
  cp.actionFailures = [{ step: 1, action: { type: 'social_profile', url: X_URL }, code: 'provider_billing' }];
  cp.independentMaterials = [{ sourceKey: 'S7', sourceUrl: MEDIUM, quote: MEDIUM_QUOTE, quoteOffset: 0, sourceContentHash: sha256(MEDIUM_QUOTE) }];
  f.store.research.save(f.run.id, cp);
  cp.pages.forEach((p) => addSource(f, f.run.id, p));
  f.store.setSourceExcluded(f.run.id, 'S9', true);
  // The known X billing failure stays a FAILED receipt in the PARENT ledger only.
  f.store.research.reserve(f.run.id, 'seed-x-billing', 'tool', { type: 'social_profile', url: X_URL }, { inputTokens: 0, outputTokens: 0 }, undefined, true);
  f.store.research.settle(f.run.id, 'seed-x-billing', null, { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, credits: 0, unknownCost: false }, 'failed');
  // Production follow-ups are created from a finished parent; a queued parent
  // would otherwise be executed by the same runner and pollute call counters.
  f.store.updateRun(f.run.id, { state: 'completed', finished_at: new Date().toISOString() });
  return Object.assign(f, { parentCp: cp });
}

function recordingTools() {
  const calls: ResearchToolAction[] = [];
  const tools: ResearchTools = {
    async execute(action) {
      calls.push(action);
      return { pages: [], requests: 1, bytes: 1, estimatedUsd: 0, credits: 0, limitations: [] } satisfies ResearchToolResult;
    }
  };
  return { calls, tools };
}
function recordingXProvider() {
  const calls: string[] = [];
  const provider: XAccountProvider = { async execute(request) {
    calls.push(request.type);
    throw new Error('synthetic_x_dispatch_observed: no real provider exists');
  } };
  return { calls, provider };
}
/** Metered reasoning: every decision round-trips the real `invoke` closure. */
function meteredTransport() {
  const urls: string[] = [];
  return { urls, transport: { async fetch(url: string): Promise<HttpResponseLike> {
    urls.push(url);
    return new Response(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":0}}}\n\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":40}}\n\n' +
      'data: {"type":"message_stop"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }) as unknown as HttpResponseLike;
  } } };
}
function metered(invoke: Parameters<ResearchPlanner['decide']>[2], signal: AbortSignal) {
  return invoke({ path: '/v1/messages', body: { model: 'synthetic-model', max_tokens: 2500, messages: [] }, signal });
}
function followupPlanner(planDecisions: Array<unknown>) {
  let planCalls = 0;
  return {
    planCalls: () => planCalls,
    planner: {
      async decide(input: Parameters<ResearchPlanner['decide']>[0], signal: AbortSignal, invoke: Parameters<ResearchPlanner['decide']>[2]) {
        await metered(invoke, signal);
        if (input.mode === 'verify') return { supported: (input.claims ?? []).map((_, index) => index), rejected: [] };
        return planDecisions[Math.min(planCalls++, planDecisions.length - 1)];
      }
    } satisfies ResearchPlanner
  };
}
function finishWith(claims: unknown[], unknowns: string[] = []) {
  return { action: 'finish', claims, unknowns };
}
const PERSON_CLAIM = { sourceKey: 'S1', quote: HOME_QUOTE, statement: HOME_QUOTE, kind: 'attributed_statement', section: 'work' };
const INDEPENDENT_CLAIM = { sourceKey: 'S3', quote: MEDIUM_QUOTE, statement: MEDIUM_QUOTE, kind: 'attributed_statement', section: 'work' };

function runnerFor(f: SeededFirstStep, parts: { tools: ResearchTools; planner: ResearchPlanner; transport: ReturnType<typeof meteredTransport>['transport']; xProvider?: XAccountProvider }) {
  return new Runner({
    store: f.store,
    firstStep: f.firstStep,
    config: { researchLimits: { toolCalls: 20, modelCalls: 6, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 },
      deepseekApiKey: 'offline-fixture', exaApiKey: 'offline-fixture', firecrawlApiKey: null, tikhubApiKey: null, githubToken: null } as AppConfig,
    providerFactory: () => { throw new Error('no legacy provider'); },
    transport: parts.transport,
    researchTools: parts.tools,
    researchPlanner: parts.planner,
    ...(parts.xProvider ? { xAccountProvider: parts.xProvider } : {})
  });
}
async function runToTerminal(f: SeededFirstStep, runner: Runner, runId: string) {
  runner.enqueue(runId);
  await waitFor(() => {
    const run = f.store.getRun(runId);
    return runner.activeCount() === 0 && run !== null && !['queued', 'researching'].includes(run.state);
  });
  return f.store.getRun(runId)!;
}


type EvidenceMarker = { version: 'v1'; parentRunId: string; readMode: 'existing_evidence' };
function marker(checkpoint: ResearchCheckpoint | null): EvidenceMarker | undefined {
  // Local expected-data shape, NOT a new production import or a missing export.
  return (checkpoint as (ResearchCheckpoint & { inheritedFollowup?: EvidenceMarker }) | null)?.inheritedFollowup;
}
type Entry = 'create' | 'followup';
const ENTRIES: Entry[] = ['create', 'followup'];
const ABSENT = Symbol('body field absent');
const QUESTION = '追问：只核对已有公开作品材料';
type Handler = (req: Request, res: Response) => unknown;
function apiFor(f: SeededFirstStep) {
  const handlers = new Map<string, Handler>();
  const bind = (method: string) => (path: string, handler: Handler) => { handlers.set(`${method} ${path}`, handler); };
  const router = { get: bind('GET'), post: bind('POST'), delete: bind('DELETE') } as unknown as Router;
  const queue: string[] = [];
  const runner = {
    checkStartAllowed: () => ({ allowed: true, code: null, message: null }),
    recordStart: () => undefined,
    enqueue: (id: string) => { queue.push(id); }
  } as unknown as Runner;
  registerRunRoutes(router, { store: f.store, firstStep: f.firstStep, runner, auth: {} as never,
    exaConfigured: true, researchConfigured: true });
  const call = (entry: Entry | 'retry', options: { mode?: unknown; owner?: string; parentId?: string; key?: string } = {}) => {
    const parentId = options.parentId ?? f.run.id;
    const body: Record<string, unknown> = entry === 'create'
      ? { input: QUESTION, provider: 'research', followup: true, parentRunId: parentId }
      : entry === 'followup' ? { question: QUESTION } : {};
    if (Object.prototype.hasOwnProperty.call(options, 'mode') && options.mode !== ABSENT) body.evidenceMode = options.mode;
    const response = {
      locals: { user: { id: options.owner ?? OWNER, email: 'fixture@example.test', name: 'Fixture' } },
      statusCode: 200, body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; return this; }
    };
    const request = { body, params: { id: parentId },
      header(name: string) { return name.toLowerCase() === 'idempotency-key' ? options.key : undefined; }
    } as unknown as Request;
    const path = entry === 'create' ? '/runs' : entry === 'retry' ? '/runs/:id/retry' : '/runs/:id/followup';
    handlers.get(`POST ${path}`)!(request, response as unknown as Response);
    return response;
  };
  return { call, queue };
}
function childFrom(f: SeededFirstStep, response: ReturnType<ReturnType<typeof apiFor>['call']>): RunRecord {
  assert.equal(response.statusCode, 201);
  const id = (response.body as { run: { runId: string } }).run.runId;
  const child = f.store.getRun(id); assert.ok(child); return child;
}
function explicitChild(f: SeededFirstStep, entry: Entry = 'followup'): RunRecord {
  return childFrom(f, apiFor(f).call(entry, { mode: 'existing_evidence' }));
}
function expectedHttp(status: number, code?: string) {
  return (error: unknown) => error instanceof HttpError && error.status === status && (code === undefined || error.code === code);
}

for (const entry of ENTRIES) {
  test(`${entry}: explicit existing_evidence inherits only active same-owner frozen material`, (t) => {
    const f = followupFixture(); t.after(() => f.close());
    const child = explicitChild(f, entry), cp = f.store.research.checkpoint(child.id)!;
    assert.deepEqual(marker(cp), { version: 'v1', parentRunId: f.run.id, readMode: 'existing_evidence' });
    assert.deepEqual(cp.pages.map(p => [p.sourceKey, p.url]), [['S1', HOME], ['S2', ABOUT], ['S3', MEDIUM]]);
    assert.deepEqual(cp.pages.map(p => p.inheritedFrom), [
      { runId: f.run.id, sourceKey: 'S2' }, { runId: f.run.id, sourceKey: 'S5' }, { runId: f.run.id, sourceKey: 'S7' }
    ]);
    assert.deepEqual(cp.pages[1]!.discoveredFrom, ['S1']);
    assert.ok(cp.unknowns.includes(BILLING_GAP)); assert.ok(cp.unknowns.includes(HISTORY_GAP));
    assert.ok(cp.coverageGaps?.includes('默认评论页尚未读取。'));
    assert.deepEqual(cp.claims, []); assert.equal(cp.pendingClaims, undefined);
    assert.equal(cp.planFeedback, undefined);
    assert.equal(f.store.research.receipts(child.id).length, 0);
    assert.equal(f.store.research.budget(child.id).estimatedUsd, 0);
    assert.deepEqual(cp.independentMaterials?.map(m => m.sourceKey), ['S3']);
    assert.equal(f.store.listSources(child.id).length, 3);
    assert.ok(f.store.listSources(child.id)[2]!.identityLabel.includes('独立账号范围'));
    assert.equal(f.store.listSources(child.id)[0]!.identityConfirmed, false);
  });

  test(`${entry}: missing evidenceMode preserves the current fresh-corpus/re-read behavior`, async (t) => {
    const f = followupFixture(); let runner: Runner | undefined;
    t.after(() => { runner?.stopAll(); f.close(); });
    const child = childFrom(f, apiFor(f).call(entry));
    assert.equal(marker(f.store.research.checkpoint(child.id)), undefined);
    assert.deepEqual(f.store.research.checkpoint(child.id)!.pages, []);
    const tools = recordingTools(), transport = meteredTransport();
    runner = runnerFor(f, { tools: tools.tools, transport: transport.transport, planner: followupPlanner([finishWith([])]).planner });
    await runToTerminal(f, runner, child.id);
    assert.ok(tools.calls.length >= 3, 'default retains all existing selected-account seed attempts');
    assert.ok(f.store.research.receipts(child.id).some(r => r.kind === 'tool'));
  });

  for (const invalid of ['continue_reading', null, 1]) {
    test(`${entry}: rejects unknown evidenceMode ${JSON.stringify(invalid)} before inserting/enqueueing`, (t) => {
      const f = followupFixture(); t.after(() => f.close()); const api = apiFor(f);
      const before = f.store.listRunsForOwner(OWNER).length;
      assert.throws(() => api.call(entry, { mode: invalid }), expectedHttp(400, 'invalid_evidence_mode'));
      assert.equal(f.store.listRunsForOwner(OWNER).length, before);
      assert.deepEqual(api.queue, []);
    });
  }

  test(`${entry}: default and opt-in do not collide under one idempotency key`, (t) => {
    const f = followupFixture(); t.after(() => f.close()); const api = apiFor(f);
    const first = api.call(entry, { key: 'same-request-key' });
    assert.equal(first.statusCode, 201);
    assert.throws(() => api.call(entry, { key: 'same-request-key', mode: 'existing_evidence' }), expectedHttp(409, 'idempotency_conflict'));
    assert.equal(api.queue.length, 1);
  });

  test(`${entry}: explicit mode cannot use another owner's parent`, (t) => {
    const f = followupFixture(); t.after(() => f.close()); const api = apiFor(f);
    assert.throws(() => api.call(entry, { owner: 'other-fixture-owner', mode: 'existing_evidence' }), expectedHttp(404));
    assert.deepEqual(api.queue, []);
  });
  test(`${entry}: explicit mode cannot use an unknown parent`, (t) => {
    const f = followupFixture(); t.after(() => f.close()); const api = apiFor(f);
    assert.throws(() => api.call(entry, { parentId: 'missing-fixture-parent', mode: 'existing_evidence' }), expectedHttp(404));
    assert.deepEqual(api.queue, []);
  });
  test(`${entry}: explicit mode preserves the unfrozen parent guard`, (t) => {
    const f = seedFirstStep({ accounts: [{ url: HOME }] }); t.after(() => f.close()); const api = apiFor(f);
    assert.throws(() => api.call(entry, { mode: 'existing_evidence' }), expectedHttp(409, 'parent_scope_not_frozen'));
    assert.deepEqual(api.queue, []);
  });
  test(`${entry}: explicit mode fails closed for a non-first-step research parent`, (t) => {
    const f = followupFixture(); t.after(() => f.close());
    const legacy = f.store.insertRun({ ownerId: OWNER, question: QUESTION, seedUrl: null, provider: 'research',
      parentRunId: null, retryOf: null, followup: false, idempotencyKey: null, bodyFingerprint: 'synthetic-legacy-parent' });
    f.store.updateRun(legacy.id, { state: 'completed', finished_at: new Date().toISOString() });
    const api = apiFor(f), before = f.store.listRunsForOwner(OWNER).length;
    assert.throws(() => api.call(entry, { parentId: legacy.id, mode: 'existing_evidence' }), expectedHttp(409, 'followup_unsupported'));
    assert.equal(f.store.listRunsForOwner(OWNER).length, before); assert.deepEqual(api.queue, []);
  });
  test(`${entry}: explicit mode fails closed for dedicated X-engine parent material`, (t) => {
    const f = followupFixture(); t.after(() => f.close());
    // Synthetic unsupported-kind marker in the in-memory fixture only.
    f.db.prepare("UPDATE research_checkpoints SET data_json=json_set(data_json,'$.xAccountResearch',json('{}')) WHERE run_id=?").run(f.run.id);
    const api = apiFor(f), before = f.store.listRunsForOwner(OWNER).length;
    assert.throws(() => api.call(entry, { mode: 'existing_evidence' }), expectedHttp(409, 'followup_unsupported'));
    assert.equal(f.store.listRunsForOwner(OWNER).length, before); assert.deepEqual(api.queue, []);
  });
}

const EXTERNAL_PLANS: unknown[] = [
  { action: 'read', url: ABOUT }, { action: 'search', query: 'synthetic extra evidence' },
  { action: 'social', url: X_URL }, { action: 'social_posts', url: X_URL }, { action: 'firecrawl', url: ABOUT },
  { action: 'batch', actions: [{ action: 'catalog', offset: 0 }, { action: 'read', url: ABOUT }] }
];
for (const proposal of EXTERNAL_PLANS) {
  test(`explicit mode rejects ${String((proposal as { action: string }).action)} before tool reservation; reasoning stays metered`, async (t) => {
    const f = followupFixture(); let runner: Runner | undefined;
    t.after(() => { runner?.stopAll(); f.close(); });
    const child = explicitChild(f);
    const tools = recordingTools(), x = recordingXProvider(), transport = meteredTransport();
    const planner = followupPlanner([proposal, finishWith([PERSON_CLAIM, INDEPENDENT_CLAIM])]);
    runner = runnerFor(f, { tools: tools.tools, planner: planner.planner, transport: transport.transport, xProvider: x.provider });
    await runToTerminal(f, runner, child.id);
    assert.equal(tools.calls.length, 0); assert.equal(x.calls.length, 0);
    const receipts = f.store.research.receipts(child.id), budget = f.store.research.budget(child.id);
    assert.ok(receipts.length > 0 && receipts.every(r => r.kind === 'model'));
    assert.equal(budget.toolCalls, 0); assert.equal(budget.modelCalls, 3);
    assert.ok(budget.inputTokens > 0); assert.equal(planner.planCalls(), 2);
    const cp = f.store.research.checkpoint(child.id)!;
    assert.ok(cp.unknowns.some(value => value.includes('existing_evidence_only')));
    assert.ok(cp.unknowns.includes(BILLING_GAP));
    assert.equal(cp.claims.some(claim => claim.sourceKey === 'S3'), false, 'independent material is not a person claim');
  });
}

test('explicit mode keeps parent withdrawal active both before and after inheritance', (t) => {
  const f = followupFixture(); t.after(() => f.close());
  f.store.setSourceExcluded(f.run.id, 'S7', true);
  const child = explicitChild(f), cp = f.store.research.checkpoint(child.id)!;
  assert.equal(cp.pages.some(p => p.url === MEDIUM), false);
  assert.equal(cp.pages.length, 2);
  assert.equal(f.store.isResearchSourceActive(child.id, 'S1', OWNER), true);
  f.store.setSourceExcluded(f.run.id, 'S2', true);
  assert.equal(f.store.isResearchSourceActive(child.id, 'S1', OWNER), false);
  assert.equal(f.store.buildCanonicalView(f.store.getRun(child.id)!).sources.find(s => s.sourceKey === 'S1')!.excluded, true);
});

test('explicit mode persists through Store/Runner re-instantiation and replays the same API key without duplicates', async (t) => {
  const f = followupFixture(); let runner: Runner | undefined;
  t.after(() => { runner?.stopAll(); f.close(); });
  const api = apiFor(f);
  const first = api.call('followup', { mode: 'existing_evidence', key: 'same-opt-in-request' });
  const child = childFrom(f, first);
  const replay = api.call('followup', { mode: 'existing_evidence', key: 'same-opt-in-request' });
  assert.equal((replay.body as { run: { runId: string } }).run.runId, child.id);
  assert.equal(api.queue.length, 1);
  const raw = f.db.prepare('SELECT data_json FROM research_checkpoints WHERE run_id=?').get(child.id) as { data_json: string };
  assert.deepEqual(marker(JSON.parse(raw.data_json) as ResearchCheckpoint), { version: 'v1', parentRunId: f.run.id, readMode: 'existing_evidence' });
  const store = new Store(f.db), firstStep = new FirstStepStore(f.db, store);
  const restarted = { ...f, store, firstStep };
  assert.equal(store.research.checkpoint(child.id)!.pages.length, 3);
  const tools = recordingTools(), transport = meteredTransport();
  runner = runnerFor(restarted, { tools: tools.tools, transport: transport.transport, planner: followupPlanner([finishWith([])]).planner });
  await runToTerminal(restarted, runner, child.id);
  assert.equal(tools.calls.length, 0); assert.equal(store.listSources(child.id).length, 3);
});

test('retry without evidenceMode retains a fresh corpus and selected-account reads', async (t) => {
  const f = followupFixture(); let runner: Runner | undefined;
  t.after(() => { runner?.stopAll(); f.close(); });
  const child = childFrom(f, apiFor(f).call('retry'));
  const cp = f.store.research.checkpoint(child.id)!;
  assert.equal(marker(cp), undefined); assert.deepEqual(cp.pages, []); assert.deepEqual(cp.unknowns, []);
  const tools = recordingTools(), transport = meteredTransport();
  runner = runnerFor(f, { tools: tools.tools, transport: transport.transport, planner: followupPlanner([finishWith([])]).planner });
  await runToTerminal(f, runner, child.id);
  assert.ok(tools.calls.length >= 3);
  assert.ok(f.store.research.receipts(child.id).some(r => r.kind === 'tool'));
});


test('explicit ordinary single-X evidence does not start the dedicated X engine', async (t) => {
  const f = seedFirstStep({ accounts: [{ url: X_URL }] }); let runner: Runner | undefined;
  t.after(() => { runner?.stopAll(); f.close(); });
  const current = f.firstStep.getFirstStepView(OWNER, f.run.id)!;
  if (current.mode !== 'first_step') throw new Error('unexpected fixture mode');
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: current.view.selection.scopeVersion,
    discoveryRevision: current.view.discoveryRevision, clusterId: null,
    accounts: [{ accountId: f.accountIdFor(0), selection: 'only_this_account', excluded: false }]
  }, 'single-x-opt-in-synthetic');
  const cp = f.store.research.checkpoint(f.run.id)!;
  cp.anchorUrl = X_URL;
  cp.identity = { displayName: 'Synthetic account', handle: 'fixture_author', profileUrl: X_URL, status: 'resolved', note: null, candidates: [] };
  cp.pages = [page('S2', X_URL, HOME_QUOTE)];
  f.store.research.save(f.run.id, cp); addSource(f, f.run.id, cp.pages[0]!);
  f.store.updateRun(f.run.id, { state: 'completed', finished_at: new Date().toISOString() });
  const child = explicitChild(f), tools = recordingTools(), x = recordingXProvider(), transport = meteredTransport();
  runner = runnerFor(f, { tools: tools.tools, xProvider: x.provider, transport: transport.transport,
    planner: followupPlanner([finishWith([])]).planner });
  await runToTerminal(f, runner, child.id);
  assert.equal(x.calls.length, 0); assert.equal(tools.calls.length, 0);
  assert.equal(f.store.research.checkpoint(child.id)!.xAccountResearch, undefined);
});


// Two supplemental real-memory boundaries. The 32 admitted cases above remain unchanged.
test('historical profile-only corpus uses the actual parent URL guard, not account-key membership', (t) => {
  const ordinary = followupFixture(); t.after(() => ordinary.close());
  assert.doesNotThrow(() => ordinary.firstStep.scopeGuard(OWNER, ordinary.run.id).resolveUrl(ABOUT),
    'the original 32-case About positive is legitimately public_history');

  const f = seedFirstStep({ accounts: [{ url: HOME }] }); t.after(() => f.close());
  const view = f.firstStep.getFirstStepView(OWNER, f.run.id)!;
  if (view.mode !== 'first_step') throw new Error('unexpected synthetic mode');
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: view.view.selection.scopeVersion, discoveryRevision: view.view.discoveryRevision,
    clusterId: null,
    accounts: [{ accountId: f.accountIdFor(0), selection: 'only_this_account', excluded: false }]
  }, 'synthetic-profile-selection');
  const cp = f.store.research.checkpoint(f.run.id)!;
  // The real domain API supports profile_only. A historical checkpoint/link is
  // rebound to its returned version; no fabricated scope mismatch is used.
  const narrowed = f.store.cases.applyScopeChange({ ownerId: OWNER, caseId: f.caseId,
    expectedScopeVersion: asScopeVersion(cp.firstStep!.scopeVersion), reason: 'synthetic historical profile-only policy',
    accounts: [{ accountId: f.accountIdFor(0), allowedScope: { state: 'profile_only', note: 'synthetic profile only' } }] });
  cp.firstStep = { ...cp.firstStep!, scopeVersion: narrowed.case.scopeVersion,
    accounts: cp.firstStep!.accounts.map(account => ({ ...account, allowedScope: 'profile_only' as const })) };
  cp.anchorUrl = HOME;
  cp.pages = [page('S2', HOME, HOME_QUOTE, { retrieval: 'profile' }),
    page('S5', ABOUT, 'Synthetic historical About original.', { retrieval: 'read' }),
    page('S7', HOME + 'withdrawn', 'Synthetic explicitly withdrawn historical original.', { retrieval: 'read' })];
  cp.claims = []; cp.unknowns = []; cp.coverageGaps = [];
  f.store.research.save(f.run.id, cp);
  f.db.prepare('UPDATE first_step_links SET selection_scope_version=? WHERE run_id=?').run(narrowed.case.scopeVersion, f.run.id);
  cp.pages.forEach(p => addSource(f, f.run.id, p));
  f.store.setSourceExcluded(f.run.id, 'S7', true);
  f.store.updateRun(f.run.id, { state: 'completed', finished_at: new Date().toISOString() });

  const guard = f.firstStep.scopeGuard(OWNER, f.run.id);
  assert.equal(f.firstStep.link(f.run.id)!.selectionScopeVersion, narrowed.case.scopeVersion);
  assert.equal(f.store.isResearchScopeActive(f.run.id, OWNER), true);
  assert.equal(guard.resolveUrl(HOME).allowedScope, 'profile_only');
  assert.throws(() => guard.resolveUrl(ABOUT), (error: unknown) => error instanceof Error &&
    (error as Error & { code?: string }).code === 'out_of_scope');
  assert.throws(() => guard.resolveUrl(HOME + 'withdrawn'), (error: unknown) => error instanceof Error &&
    (error as Error & { code?: string }).code === 'out_of_scope');
  const before = f.store.buildCanonicalView(f.store.getRun(f.run.id)!);
  assert.equal(before.sources.find(s => s.sourceKey === 'S2')!.excluded, false);
  assert.equal(before.sources.find(s => s.sourceKey === 'S5')!.excluded, false,
    'canonical source activity alone does not enforce profile-only URL depth');
  assert.equal(before.sources.find(s => s.sourceKey === 'S7')!.excluded, true);

  const child = explicitChild(f), inherited = f.store.research.checkpoint(child.id)!;
  assert.equal(inherited.pages.some(p => p.url === HOME), true, 'allowed homepage remains a positive');
  assert.equal(inherited.pages.some(p => p.url === ABOUT), false, 'current parent URL refusal survives inheritance');
  assert.equal(inherited.pages.some(p => p.url === HOME + 'withdrawn'), false);
});

test('search-only snippet cannot erase an actual failed original-read billing gap during inheritance', (t) => {
  const f = seedFirstStep({ accounts: [{ url: HOME }] }); t.after(() => f.close());
  const view = f.firstStep.getFirstStepView(OWNER, f.run.id)!;
  if (view.mode !== 'first_step') throw new Error('unexpected synthetic mode');
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: view.view.selection.scopeVersion, discoveryRevision: view.view.discoveryRevision,
    clusterId: null,
    accounts: [{ accountId: f.accountIdFor(0), selection: 'only_this_account', excluded: false }]
  }, 'synthetic-search-only-parent');
  const cp = f.store.research.checkpoint(f.run.id)!;
  cp.anchorUrl = HOME;
  cp.pages = [page('S2', ABOUT, 'Synthetic discovery snippet, not an original read.', { retrieval: 'search' })];
  cp.claims = []; cp.unknowns = []; cp.coverageGaps = [];
  cp.actionFailures = [{ step: 1, action: { type: 'read', url: ABOUT }, code: 'provider_billing' }];
  f.store.research.save(f.run.id, cp);
  const snippet = cp.pages[0]!;
  f.store.addSource(f.run.id, { key: snippet.sourceKey, url: snippet.url, title: snippet.title,
    kind: snippet.kind, publishedAt: null, excerpt: snippet.text, excerptLocator: '搜索发现材料，尚未回读原文',
    identityLabel: 'Synthetic discovery only', identityConfirmed: false, fetchStatus: 'ok', limits: [] }, 0);
  const search = { type: 'search' as const, query: 'synthetic discovery for the selected fixture account' };
  f.store.research.reserve(f.run.id, 'synthetic-search-completed', 'tool', search,
    { inputTokens: 0, outputTokens: 0 }, undefined, true);
  f.store.research.settle(f.run.id, 'synthetic-search-completed',
    { pages: [{ url: ABOUT, title: snippet.title, text: snippet.text, kind: snippet.kind,
      publishedAt: null, links: [], limitations: [] }], requests: 1, bytes: 64, estimatedUsd: 0, credits: 0, limitations: [] },
    { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, credits: 0, bytes: 64, unknownCost: false });
  f.store.research.reserve(f.run.id, 'synthetic-original-read-failed', 'tool', { type: 'read', url: ABOUT },
    { inputTokens: 0, outputTokens: 0 }, undefined, true);
  f.store.research.settle(f.run.id, 'synthetic-original-read-failed', null,
    { inputTokens: 0, outputTokens: 0, estimatedUsd: null, credits: null, unknownCost: true }, 'failed');
  assert.deepEqual(cp.unknowns, []); assert.deepEqual(cp.coverageGaps, []);
  assert.equal(f.firstStep.scopeGuard(OWNER, f.run.id).resolveUrl(ABOUT).allowedScope, 'public_history');
  const report = buildResearchReport({ store: f.store, run: f.store.getRun(f.run.id)!, checkpoint: cp, limits: RESEARCH_LIMITS },
    'no_new_evidence', 'partial');
  assert.deepEqual(cp.unknowns, []); assert.deepEqual(cp.coverageGaps, [], 'no hand-inserted BILLING_GAP');
  f.store.research.save(f.run.id, cp);
  f.store.updateRun(f.run.id, { state: 'partial', limitations_json: JSON.stringify(report.limitations), finished_at: new Date().toISOString() });
  const parentView = f.store.buildCanonicalView(f.store.getRun(f.run.id)!);
  assert.ok(parentView.limitations.some(value => value.includes('provider_billing') && value.includes(ABOUT)),
    'actual current report/canonical pipeline derives the unresolved original-read failure');
  assert.equal(f.store.research.checkpoint(f.run.id)!.pages[0]!.retrieval, 'search');
  const parentReceipts = f.store.research.receipts(f.run.id);
  assert.equal(parentReceipts.length, 2); assert.ok(parentReceipts.some(r => r.state === 'failed'));

  const child = explicitChild(f), inherited = f.store.research.checkpoint(child.id)!;
  assert.ok([...(inherited.coverageGaps ?? []), ...inherited.unknowns].some(value =>
    value.includes('provider_billing') && value.includes(ABOUT)), 'discovery text is not successful original-read provenance');
  assert.equal(f.store.research.receipts(child.id).length, 0);
  assert.equal(f.store.research.budget(child.id).estimatedUsd, 0);
  assert.deepEqual(f.store.research.receipts(f.run.id), parentReceipts, 'parent receipts/cost provenance is unchanged');
});
