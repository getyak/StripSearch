// Run inside the final image via stdin. Synthetic data only; --network none.
// Zero network: any accidental external request throws.
globalThis.fetch = () => {
  throw new Error('runtime smoke is offline: fetch is disabled');
};
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The image mounts the app at /app; an override enables local compiled smoke runs.
const APP = process.env.STRIPSEARCH_APP_ROOT ?? '/app';
const compiled = (relative) => import(pathToFileURL(path.join(APP, relative)).href);

const { runDshDecision } = await compiled('apps/web/dist/server/research/dsh-decision.js');
const { renderReportPdf } = await compiled('apps/web/dist/server/services/pdf.js');

// Hosts may configure TMPDIR; the before/after leftover check must watch the
// SAME temp root that Fetch/PDF actually use, so cleanup is tested honestly.
const TMP_ROOT = tmpdir();
const before = new Set(await readdir(TMP_ROOT));
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

// Local Fetch pipeline smoke: the COMPILED synthetic chain over a REAL SQLite
// database, interrupted and reopened (no replay), zero network. The chain is
// a local prototype: pending findings only and zero verified provider
// profiles, exactly as in the source-level offline tests.
const { openDatabase, applyCoreSchema } = await compiled('apps/web/dist/server/db/index.js');
const { openSyntheticHarness } = await compiled('apps/web/dist/server/research/fetch-pipeline-synthetic.js');
const fetchDir = await mkdtemp(path.join(tmpdir(), 'stripsearch-fetch-'));
let fetchDb = null;
let fetchRun = null;
try {
  const dbPath = path.join(fetchDir, 'smoke.db');
  fetchDb = openDatabase(dbPath);
  applyCoreSchema(fetchDb);
  let harness = openSyntheticHarness(fetchDb, {});
  // Interrupted pass: one bounded scheduling quantum, then close the database.
  const first = await harness.run({ maxStepsPerBatch: 3, maxBatches: 1 });
  assert.equal(first.state, 'running', 'the scheduling bound keeps the run resumable');
  assert.ok(first.openSteps > 0);
  assert.equal(first.providerProfilesVerified, 0);
  fetchDb.close();
  // Reopen the same database: finish without repeating any successful call.
  fetchDb = openDatabase(dbPath);
  applyCoreSchema(fetchDb);
  harness = openSyntheticHarness(fetchDb, { resumeRunId: first.runId });
  const second = await harness.run({ maxStepsPerBatch: 8 });
  assert.equal(second.runId, first.runId);
  assert.equal(second.state, 'finished');
  assert.equal(second.openSteps, 0);
  assert.equal(second.providerProfilesVerified, 0);
  assert.equal(second.counts.bodiesRead, second.counts.listedItems);
  const successful = harness.runs
    .listEvents(first.runId)
    .filter((event) => event.kind === 'tool')
    .map((event) => event.payload)
    .filter((payload) => payload.envelope.status === 'success' || payload.envelope.status === 'partial');
  assert.equal(new Set(successful.map((payload) => payload.stepKey)).size, successful.length, 'no successful call repeats across close/reopen');
  for (const finding of harness.runs.listFindings(first.runId)) assert.equal(finding.state, 'pending');
  fetchRun = {
    runId: first.runId,
    state: second.state,
    interrupted: { state: first.state, openSteps: first.openSteps },
    toolActions: second.counts.toolActions,
    bodiesRead: second.counts.bodiesRead,
    pendingFindings: second.pendingFindings.length,
    duplicateSuccessfulActions: successful.length - new Set(successful.map((payload) => payload.stepKey)).size
  };
} finally {
  if (fetchDb) {
    try {
      fetchDb.close();
    } catch {
      // already closed
    }
  }
  await rm(fetchDir, { recursive: true, force: true });
}

const leftover = (await readdir(TMP_ROOT)).filter(name => !before.has(name) && /^stripsearch-(?:dsh|pdf|fetch)-/.test(name));
assert.deepEqual(leftover, []);
console.log(JSON.stringify({ dsh: 'passed', calls, pdfBytes: pdf.length, fetch: fetchRun, temporaryDirectories: leftover.length, externalRequests: 0 }));
