/** Batch authority and accounting boundaries; real dispatcher/Store, fake model only. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { applyCoreSchema, openDatabase } from '../server/db/index.js';
import { Store } from '../server/store.js';
import { createResearchToolServer, type TrustedContext } from '../server/research/research-tool-dispatch.js';
import {
  isValidRuntimeModelUsage,
  runResearchRuntimeBatch,
  type RuntimeModelGateway,
  type RuntimeModelUsage
} from '../server/research/research-runtime.js';

const usage: RuntimeModelUsage = { inputTokens: 17, outputTokens: 5, estimatedUsd: null };
const decision = { kind: 'tool', tool: 'get_platform_capabilities', input: { platform: 'synthetic' } };
function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  applyCoreSchema(db);
  const store = new Store(db);
  const record = store.cases.createCase({ ownerId: 'hotspot-owner', intent: 'Original synthetic runtime case',
    provenance: { authorization: 'not_recorded', collector: 'hotspot-fixture', note: null } });
  for (const suffix of ['a', 'b']) store.cases.addAccount({ ownerId: record.ownerId, caseId: record.caseId,
    accountId: `account-${suffix}`, expectedScopeVersion: record.scopeVersion }, {
    accountId: `account-${suffix}`, platform: 'synthetic', handle: `owner-${suffix}`, profileUrl: `https://synthetic-${suffix}.dev/`,
    identitySupport: { state: 'proposed', evidenceIds: [], counterevidenceIds: [], policyVersion: 'synthetic/v1', note: null },
    userSelection: { state: 'unanswered', note: null, recordedAt: null }, allowedScope: { state: 'public_history', note: null },
    researchValue: { state: 'unassessed', rationale: null }, accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null }
  });
  const ctx: TrustedContext = {
    ownerId: record.ownerId, caseId: record.caseId, scopeVersion: record.scopeVersion, role: 'search', phase: 'search', cancelled: false,
    accounts: ['a', 'b'].map(suffix => ({ accountId: `account-${suffix}`, platform: 'synthetic', handle: `owner-${suffix}`, allowedScope: 'public_history' })),
    capabilities: { registryVersion: 'synthetic/v1', operations: [{ platform: 'synthetic', operation: 'read_profile', state: 'supported', sortOptions: [], dateRange: 'unsupported', maxDepth: 1, limitation: null }] },
    skillPins: [{ skillId: 'synthetic-reader', version: '1', hash: 'synthetic-hash' }], mediaConversionAuthorized: false
  };
  const server = createResearchToolServer({ store });
  let dispatches = 0;
  // This wrapper observes calls without replacing any production gate or result.
  const tools = { dispatch: (async (...args) => { dispatches++; return server.dispatch(...args); }) as typeof server.dispatch };
  const task = { taskId: 'hotspot-task', context: structuredClone(ctx), instructions: 'Inspect the frozen synthetic capability registry.' };
  return { store, ctx, task, tools, dispatches: () => dispatches };
}

const drifts: Array<[string, (ctx: TrustedContext) => void]> = [
  ['owner', ctx => { ctx.ownerId = 'other-owner'; }],
  ['case', ctx => { ctx.caseId = 'other-case'; }],
  ['scope version', ctx => { ctx.scopeVersion++; }],
  ['role', ctx => { ctx.role = 'fetch'; }],
  ['phase', ctx => { ctx.phase = 'verify'; }],
  ['cancelled', ctx => { ctx.cancelled = true; }],
  ['account removal', ctx => { ctx.accounts.pop(); }],
  ['account addition', ctx => { ctx.accounts.push({ ...ctx.accounts[0]!, accountId: 'new-account' }); }],
  ['account replacement', ctx => { ctx.accounts[0]!.accountId = 'other-account'; }],
  ['platform', ctx => { ctx.accounts[0]!.platform = 'different-platform'; }],
  ['handle', ctx => { ctx.accounts[0]!.handle = 'different-owner'; }],
  ['allowed scope', ctx => { ctx.accounts[0]!.allowedScope = 'profile_only'; }],
  ['registry version', ctx => { ctx.capabilities.registryVersion = 'synthetic/v2'; }],
  ['capability permission', ctx => { ctx.capabilities.operations[0]!.state = 'unsupported'; }],
  ['skill hash', ctx => { ctx.skillPins[0]!.hash = 'changed-skill'; }],
  ['skill removal', ctx => { ctx.skillPins = []; }],
  ['media permission', ctx => { ctx.mediaConversionAuthorized = true; }]
];
for (const phase of ['before model', 'after model'] as const) {
  test(`hotspot: every authority dimension is frozen ${phase}`, async t => {
    for (const [name, mutate] of drifts) await t.test(name, async t => {
      const f = fixture(t);
      let models = 0;
      if (phase === 'before model') mutate(f.ctx);
      const result = await runResearchRuntimeBatch(f.task, {
        readContext: () => f.ctx, tools: f.tools,
        model: { invoke: async () => { models++; mutate(f.ctx); return { decision, usage }; } }
      }, new AbortController().signal);
      assert.equal(result.state, 'blocked');
      assert.equal(result.reason, 'authority_changed');
      assert.equal(f.dispatches(), 0, 'a changed authority snapshot must not reach the tool server');
      assert.equal(models, phase === 'before model' ? 0 : 1);
      assert.equal(result.steps, models);
      assert.deepEqual(result.events, models === 0 ? [] : [{ kind: 'model', usage }], 'completed model usage survives refusal');
    });
  });
}

test('hotspot: account ordering permits the real tool result while missing accounting remains explicit', async t => {
  const f = fixture(t);
  f.ctx.accounts.reverse();
  const result = await runResearchRuntimeBatch(f.task, {
    readContext: () => f.ctx, tools: f.tools, maxStepsPerBatch: 1,
    model: { invoke: async () => ({ decision, usage }) }
  }, new AbortController().signal);
  // This deliberately unmetered server can serve local catalog data, but the
  // runtime must stop with the real receipt's unaccounted state, never fake a
  // reconciled ledger merely because the tool made no provider request.
  assert.equal(result.state, 'blocked');
  assert.equal(result.reason, 'unreconciled_action');
  assert.equal(f.dispatches(), 1);
  const tool = result.events.find(event => event.kind === 'tool');
  assert.equal(tool?.envelope.status, 'success');
  assert.equal((tool?.envelope.content as { registryVersion: string }).registryVersion, 'synthetic/v1');
  assert.equal(tool?.envelope.usage.providerRequests, 0);
  assert.equal(tool?.envelope.usage.unaccounted, true);
});

const invalidUsages: Array<[string, unknown]> = [
  ['missing usage', undefined], ['null object', null], ['array', []],
  ['missing token field', { inputTokens: 1, estimatedUsd: null }],
  ['extra model-supplied field', { ...usage, authoritative: true }],
  ['negative input tokens', { ...usage, inputTokens: -1 }],
  ['negative output tokens', { ...usage, outputTokens: -1 }],
  ['fractional input tokens', { ...usage, inputTokens: 0.5 }],
  ['fractional output tokens', { ...usage, outputTokens: 0.5 }],
  ['unsafe integer tokens', { ...usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 }],
  ['string tokens', { ...usage, outputTokens: '5' }],
  ['NaN tokens', { ...usage, inputTokens: NaN }],
  ['infinite tokens', { ...usage, outputTokens: Infinity }],
  ['negative fee', { ...usage, estimatedUsd: -0.01 }],
  ['NaN fee', { ...usage, estimatedUsd: NaN }],
  ['infinite fee', { ...usage, estimatedUsd: Infinity }],
  ['string fee', { ...usage, estimatedUsd: '0' }]
];
test('hotspot: malformed model usage refuses the decision without recording false usage or dispatching', async t => {
  for (const [name, invalid] of invalidUsages) await t.test(name, async t => {
    const f = fixture(t);
    assert.equal(isValidRuntimeModelUsage(invalid), false);
    const model: RuntimeModelGateway = { invoke: async () => ({ decision, usage: invalid as RuntimeModelUsage }) };
    const result = await runResearchRuntimeBatch(f.task, { readContext: () => f.ctx, tools: f.tools, model }, new AbortController().signal);
    assert.deepEqual(result, { state: 'failed', reason: 'invalid_model_usage', events: [], steps: 0 });
    assert.equal(f.dispatches(), 0);
  });
});

test('hotspot: unknown, zero and known fractional fees remain distinct in observed model usage', async t => {
  for (const measured of [
    { inputTokens: null, outputTokens: null, estimatedUsd: null },
    { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2, estimatedUsd: 0.00001 }
  ]) {
    const f = fixture(t);
    assert.equal(isValidRuntimeModelUsage(measured), true);
    const result = await runResearchRuntimeBatch(f.task, { readContext: () => f.ctx, tools: f.tools,
      model: { invoke: async () => ({ decision: { kind: 'yield', reason: 'await next batch' }, usage: measured }) }
    }, new AbortController().signal);
    assert.deepEqual(result.events, [{ kind: 'model', usage: measured }]);
    assert.equal(result.state, 'yielded');
    assert.equal(result.steps, 1);
    assert.equal(f.dispatches(), 0);
  }
});

test('hotspot: a delayed model reply is billed as observed but cannot cross a real persisted scope revision', async t => {
  const f = fixture(t);
  let resolve!: (value: Awaited<ReturnType<RuntimeModelGateway['invoke']>>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(done => { markStarted = done; });
  const delayed = new Promise<Awaited<ReturnType<RuntimeModelGateway['invoke']>>>(done => { resolve = done; });
  const pending = runResearchRuntimeBatch(f.task, {
    readContext: () => ({ ...f.ctx, scopeVersion: f.store.cases.getCase(f.ctx.ownerId, f.ctx.caseId)!.scopeVersion }),
    tools: f.tools, model: { invoke: () => { markStarted(); return delayed; } }
  }, new AbortController().signal);
  await started;
  const currentCase = f.store.cases.getCase(f.ctx.ownerId, f.ctx.caseId);
  assert.ok(currentCase);
  f.store.cases.applyCaseScopeMutation({ ownerId: f.ctx.ownerId, caseId: f.ctx.caseId,
    expectedScopeVersion: currentCase.scopeVersion, reason: 'Synthetic user scope replacement', advance: true });
  resolve({ decision, usage });
  const result = await pending;
  assert.deepEqual(result, { state: 'blocked', reason: 'authority_changed', steps: 1, events: [{ kind: 'model', usage }] });
  assert.equal(f.dispatches(), 0);
  assert.equal(f.store.cases.getCase(f.ctx.ownerId, f.ctx.caseId)!.scopeVersion, f.ctx.scopeVersion + 1);
});
