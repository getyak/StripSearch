import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearchRuntimeBatch, createDshRuntimeModelGateway, type RuntimeModelGateway } from '../server/research/research-runtime.js';
import type { TrustedContext } from '../server/research/research-tool-dispatch.js';
import type { ToolEnvelope, ToolName } from '../server/research/research-tool-contracts.js';

const context = (): TrustedContext => ({ ownerId: 'owner', caseId: 'case', scopeVersion: 1, role: 'fetch', phase: 'fetch', cancelled: false, accounts: [{accountId: 'a', platform: 'synthetic', handle: 'fixture', allowedScope: 'public_history'}], capabilities: {registryVersion: 'v1', operations: []}, skillPins: [] });
const usage = {inputTokens: null, outputTokens: null, estimatedUsd: null};
const task = (ctx = context()) => ({taskId: 'task', context: ctx, instructions: 'Process authorized synthetic evidence.'});
function envelope(tool: ToolName): ToolEnvelope {
  return {tool, status: 'success', reason: null, content: {}, cursor: {token: null, nativeCursor: null}, gaps: [], actions: [], usage: {providerRequests: 0, settledRequests: 0, unknownFeeRequests: 0, notDispatchedRequests: 0, localSteps: 1, estimatedUsd: null, credits: null, unaccounted: false}, staged: false};
}
const decision = {kind: 'tool', tool: 'report_progress', input: {note: 'Fixture progress', gaps: []}};

test('finite batch quantum yields and does not cap cumulative research or declare completion', async () => {
  let calls = 0;
  const ctx = context();
  const options = {readContext: () => ctx, maxStepsPerBatch: 3, model: {invoke: async () => ({decision, usage})}, tools: {dispatch: async (_ctx: TrustedContext, call: {tool: ToolName}) => {calls++; return envelope(call.tool);}}};
  for (let i = 0; i < 10; i++) {
    const result = await runResearchRuntimeBatch(task(ctx), options, new AbortController().signal);
    assert.equal(result.state, 'yielded'); assert.equal(result.reason, 'batch_quantum'); assert.equal(result.steps, 3);
  }
  assert.equal(calls, 30);
});

test('verify phase exposes only evidence, pinned skill and pending finding tools', async () => {
  const ctx = {...context(), phase: 'verify' as const};
  const result = await runResearchRuntimeBatch(task(ctx), {readContext: () => ctx, tools: {dispatch: async () => {throw new Error('must not dispatch');}}, model: {invoke: async request => {
    assert.deepEqual(request.allowedTools.sort(), ['load_skill', 'read_evidence', 'save_findings']);
    return {decision: {kind: 'tool', tool: 'read_post', input: {accountId: 'a', itemId: 'p'}}, usage};
  }}}, new AbortController().signal);
  assert.equal(result.state, 'blocked');
});

test('scope, cancellation and permission drift during model await prevent dispatch', async () => {
  for (const change of ['scope', 'cancel', 'permission'] as const) {
    const ctx = context(); let dispatched = false;
    const result = await runResearchRuntimeBatch(task(ctx), {readContext: () => ctx, tools: {dispatch: async () => {dispatched = true; return envelope('report_progress');}}, model: {invoke: async () => {
      if (change === 'scope') ctx.scopeVersion++;
      if (change === 'cancel') ctx.cancelled = true;
      if (change === 'permission') ctx.accounts[0]!.allowedScope = 'none';
      return {decision, usage};
    }}}, new AbortController().signal);
    assert.equal(result.state, 'blocked'); assert.equal(dispatched, false);
  }
});

test('authority is snapshotted, and context reader cannot mutate expected scope', async () => {
  const ctx = context();
  const result = await runResearchRuntimeBatch(task(ctx), {readContext: packet => {packet.context.scopeVersion++; return packet.context;}, model: {invoke: async () => {throw new Error('must not invoke');}}, tools: {dispatch: async () => {throw new Error('must not dispatch');}}}, new AbortController().signal);
  assert.equal(result.reason, 'authority_changed'); assert.equal(ctx.scopeVersion, 1);
});

test('model cannot inject ownership, completion verdicts or invalid usage', async () => {
  for (const response of [
    {decision: {...decision, ownerId: 'other'}, usage},
    {decision: {kind: 'complete'}, usage},
    {decision: {...decision, input: {...decision.input, caseId: 'other'}}, usage},
    {decision, usage: {...usage, inputTokens: -1}}
  ]) {
    const ctx = context(); let dispatched = false;
    const result = await runResearchRuntimeBatch(task(ctx), {readContext: () => ctx, model: {invoke: async () => response}, tools: {dispatch: async () => {dispatched = true; return envelope('report_progress');}}}, new AbortController().signal);
    assert.ok(['blocked', 'failed'].includes(result.state)); assert.equal(dispatched, false);
  }
});

test('unsettled action stops batch without a second action and preserves receipt', async () => {
  const ctx = context(); let invoked = 0;
  const result = await runResearchRuntimeBatch(task(ctx), {readContext: () => ctx, model: {invoke: async () => {invoked++; return {decision, usage};}}, tools: {dispatch: async () => {const receipt = envelope('report_progress'); receipt.usage.unaccounted = true; return receipt;}}}, new AbortController().signal);
  assert.equal(result.reason, 'unreconciled_action'); assert.equal(invoked, 1); assert.equal(result.events.length, 2);
});

test('abort during model await preserves observed model usage but starts no tool', async () => {
  const ctx = context(); const controller = new AbortController();
  const result = await runResearchRuntimeBatch(task(ctx), {readContext: () => ctx, model: {invoke: async () => {controller.abort(); return {decision, usage};}}, tools: {dispatch: async () => {throw new Error('must not dispatch');}}}, controller.signal);
  assert.equal(result.state, 'cancelled'); assert.deepEqual(result.events, [{kind: 'model', usage}]);
});

test('DSH gateway retains one metered request and reports known tokens with unknown fee', {timeout: 30000}, async () => {
  let calls = 0;
  const gateway: RuntimeModelGateway = createDshRuntimeModelGateway({model: 'deepseek-flash', timeoutMs: 15000, invoke: async () => {
    calls++;
    const events = [
      {type: 'message_start', message: {id: 'synthetic', role: 'assistant', content: [], usage: {input_tokens: 20, output_tokens: 0}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'synthetic', name: 'submit_decision', input: {}}},
      {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: JSON.stringify({decision: {kind: 'yield', reason: 'continue in next batch'}})}},
      {type: 'content_block_stop', index: 0},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 15}},
      {type: 'message_stop'}
    ];
    return {status: 200, body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')};
  }});
  const result = await gateway.invoke({taskId: 't', role: 'fetch', phase: 'verify', instructions: 'synthetic only', allowedTools: ['read_evidence'], events: []}, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(result.decision, {kind: 'yield', reason: 'continue in next batch'});
  assert.deepEqual(result.usage, {inputTokens: 20, outputTokens: 15, estimatedUsd: null});
});
