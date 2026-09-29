import test from 'node:test';
import assert from 'node:assert/strict';
import { runDshDecision } from '../server/research/dsh-decision.js';

/** Exact Messages stream shape; synthetic content only, no network upstream. */
function response(decision: unknown, toolName = 'submit_decision'): string {
  const events = [
    { type: 'message_start', message: { id: 'msg_offline', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_offline', name: toolName, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ decision }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 15 } },
    { type: 'message_stop' },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const prompt = 'Return a synthetic continue decision, with query Ada Fixture biography.';

test('DSH official adapter returns a structured tool receipt through one budgeted request', { timeout: 30_000 }, async () => {
  let count = 0;
  const result = await runDshDecision({
    prompt, signal: new AbortController().signal, model: 'deepseek-flash', timeoutMs: 15_000,
    invoke: async ({ path, body, signal }) => {
      count++;
      assert.equal(path, '/v1/messages');
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, 8192);
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_decision' });
      assert.equal(signal.aborted, false);
      assert.deepEqual((body.tools as Array<{ name: string }>).map(tool => tool.name), ['submit_decision']);
      assert.equal('dsh_session_log' in body, false);
      assert.equal('dsh_plugin_packages' in body, false);
      return { status: 200, body: response({ action: 'continue', query: 'Ada Fixture biography' }), headers: { 'content-type': 'text/event-stream' } };
    },
  });
  assert.deepEqual(result, { action: 'continue', query: 'Ada Fixture biography' });
  assert.equal(count, 1);
});

test('DSH abort closes an in-flight decision and aborts the parent request', { timeout: 30_000 }, async () => {
  const controller = new AbortController();
  let observedAbort = false;
  await assert.rejects(runDshDecision({
    prompt, signal: controller.signal, model: 'deepseek-flash', timeoutMs: 15_000,
    invoke: async ({ signal }) => {
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => { observedAbort = true; reject(signal.reason); }, { once: true });
        controller.abort(new Error('fixture cancellation'));
      });
    },
  }), /fixture cancellation/);
  assert.equal(observedAbort, true);
});

test('DSH rejects an oversized upstream response without a second paid request', { timeout: 30_000 }, async () => {
  let count = 0;
  await assert.rejects(runDshDecision({
    prompt, signal: new AbortController().signal, model: 'deepseek-flash', timeoutMs: 15_000,
    invoke: async () => { count++; return { status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1) }; },
  }), /oversized/);
  assert.equal(count, 1);
});

test('DSH rejects pre-aborted work before starting a runtime', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  await assert.rejects(runDshDecision({ prompt, signal: controller.signal, model: 'deepseek-flash', invoke: async () => { throw new Error('must not invoke'); } }), /already cancelled/);
});


test('DSH never forwards a second model request after an invented unavailable tool', { timeout: 30_000 }, async () => {
  let count = 0;
  await assert.rejects(runDshDecision({
    prompt, signal: new AbortController().signal, model: 'deepseek-flash', timeoutMs: 15_000,
    invoke: async () => { count++; return { status: 200, body: response({ command: 'must-not-execute' }, 'bash') }; },
  }), /without a structured decision/);
  assert.equal(count, 1);
});

test('DSH decodes one JSON-encoded object in a structured tool receipt', { timeout: 30_000 }, async () => {
  const verdict = { supported: [0, 2], rejected: [{ index: 1, reason: 'The quote does not establish personal contribution.' }] };
  let calls = 0;
  const result = await runDshDecision({
    prompt: 'Verify the supplied synthetic claims.', signal: new AbortController().signal,
    model: 'deepseek-flash', timeoutMs: 15_000,
    invoke: async () => { calls++; return { status: 200, body: response(JSON.stringify(verdict)) }; },
  });
  assert.deepEqual(result, verdict);
  assert.equal(calls, 1);
});

test('DSH rejects recursively encoded or non-object decisions', { timeout: 30_000 }, async () => {
  for (const value of [JSON.stringify(JSON.stringify({ supported: [0], rejected: [] })), '[0,1]']) {
    await assert.rejects(runDshDecision({
      prompt, signal: new AbortController().signal, model: 'deepseek-flash', timeoutMs: 15_000,
      invoke: async () => ({ status: 200, body: response(value) }),
    }), /decision must be a JSON object/);
  }
});
