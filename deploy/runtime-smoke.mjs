// Run inside the final image via stdin. Synthetic data only; --network none.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { runDshDecision } from '/app/apps/web/dist/server/research/dsh-decision.js';
import { renderReportPdf } from '/app/apps/web/dist/server/services/pdf.js';

const before = new Set(await readdir('/tmp'));
let calls = 0;
const result = await runDshDecision({
  prompt: 'Return the synthetic decision {action:"finish"}.',
  model: 'deepseek-flash', signal: new AbortController().signal, timeoutMs: 30_000,
  invoke: async ({ body }) => {
    calls++;
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'submit_decision' });
    const events = [
      { type: 'message_start', message: { id: 'msg_container', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_container', name: 'submit_decision', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ decision: { action: 'finish' } }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 15 } },
      { type: 'message_stop' },
    ];
    return { status: 200, body: events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), headers: { 'content-type': 'text/event-stream' } };
  },
});
assert.deepEqual(result, { action: 'finish' });
assert.equal(calls, 1);
const pdf = await renderReportPdf('<!doctype html><meta charset="utf-8"><h1>人物研究 · Synthetic report</h1>');
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
assert.ok(pdf.length > 1000);
const leftover = (await readdir('/tmp')).filter(name => !before.has(name) && /^stripsearch-(?:dsh|pdf)-/.test(name));
assert.deepEqual(leftover, []);
console.log(JSON.stringify({ dsh: 'passed', calls, pdfBytes: pdf.length, temporaryDirectories: leftover.length, externalRequests: 0 }));
