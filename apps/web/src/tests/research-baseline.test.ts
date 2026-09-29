/**
 * Targeted tests for the research-baseline-v1 offline controller replay.
 *
 * Covered: strict dataset schema, strict ordered scripted fixtures, volatile
 * normalization sensitivity (including inherited-source dependency identity and
 * receipt ordering), the isolated-process network/subprocess guard with proof
 * that underlying connectors are never reached, a full frozen replay with
 * honest counters and deterministic hashes, artifact file hashing, guard
 * violations that cannot be swallowed by the controller, worker process failure
 * with complete records, and mid-run process crashes that preserve prior
 * results. All outputs are synthetic; nothing here is human gold or a model
 * quality evaluation.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { ScriptedResearchPlanner, ScriptedResearchTools } from '../evals/research-baseline-v1/fixtures.js';
import { gradeCase } from '../evals/research-baseline-v1/grade.js';
import { normalizedHash, sha256Hex, stableReceiptOrder } from '../evals/research-baseline-v1/normalize.js';
import { verifyReportConsistency } from '../evals/research-baseline-v1/report.js';
import type { BaselineReport } from '../evals/research-baseline-v1/report.js';
import { findRepoRoot, runResearchBaseline } from '../evals/research-baseline-v1/runner.js';
import { BaselineSchemaError, parseCase, parseDataset } from '../evals/research-baseline-v1/schema.js';
import type { BaselineCase } from '../evals/research-baseline-v1/schema.js';
import type { CaseExecution } from '../evals/research-baseline-v1/case-runner.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.resolve(testDir, '..', 'evals', 'research-baseline-v1');
const repoRoot = findRepoRoot();
const datasetPath = path.join(repoRoot, 'evals', 'research-baseline-v1', 'cases.jsonl');
const datasetDisplayPath = 'evals/research-baseline-v1/cases.jsonl';

function tempBase(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tempBase(), prefix));
}

/** Keep the event loop live so the parent can observe real TCP connections. */
function runNodeProbe(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function loadCases(): BaselineCase[] {
  return parseDataset(readFileSync(datasetPath, 'utf8'));
}

function loadRawCases(): Record<string, unknown>[] {
  return readFileSync(datasetPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeRawSubsetDataset(dir: string, name: string, cases: Record<string, unknown>[]): string {
  const file = path.join(dir, name);
  writeFileSync(file, cases.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return file;
}

function rawCase(): Record<string, unknown> {
  return {
    case_id: 'test-1',
    dataset_version: 'research-baseline-v1',
    title: '测试用例',
    scenario: 'test',
    split: 'regression',
    review_status: 'unreviewed',
    provenance: 'original-synthetic',
    tags: ['test'],
    input: { question: '公开问题', seedUrl: null },
    tools: [],
    planner: [],
    expect: {
      state: 'partial', stopReason: 'unknown_inflight',
      toolCalls: 0, plannerCalls: 0, modelCalls: 0,
      receipts: { total: 0, completed: 0, failed: 0, inflight: 0 },
      unknownCost: false
    }
  };
}

test('dataset schema rejects unknown fields, duplicates and fake model usage', () => {
  const bad = rawCase();
  (bad as Record<string, unknown>).extra = true;
  assert.throws(() => parseCase(bad), BaselineSchemaError);

  const wrongModelCalls = rawCase();
  (wrongModelCalls.expect as Record<string, unknown>).modelCalls = 2;
  assert.throws(() => parseDataset(`${JSON.stringify(wrongModelCalls)}\n`), BaselineSchemaError);

  const cases = loadCases();
  assert.equal(cases.length, 11);
  const duplicated = `${JSON.stringify(cases[0])}\n${JSON.stringify(cases[0])}\n`;
  assert.throws(() => parseDataset(duplicated), BaselineSchemaError);

  for (const entry of cases) {
    assert.equal(entry.reviewStatus, 'unreviewed');
    assert.equal(entry.provenance, 'original-synthetic');
    assert.equal(entry.expect.modelCalls, 0);
  }
});

test('scripted fixtures reject extra calls, wrong action input and wrong planner mode', async () => {
  const tools = new ScriptedResearchTools([
    { action: { type: 'search', query: 'q1' }, result: { pages: [], requests: 1, bytes: 1, estimatedUsd: null, credits: null, limitations: [] } }
  ]);
  const signal = new AbortController().signal;
  await tools.execute({ type: 'search', query: 'q1' }, signal);
  assert.equal(tools.remaining, 0);
  await assert.rejects(tools.execute({ type: 'search', query: 'q2' }, signal), /no scripted step remains/);
  assert.equal(tools.violations[0]?.kind, 'unexpected_tool_call');
  assert.ok(tools.finishScript().some((violation) => violation.kind === 'unexpected_tool_call'));

  const mismatch = new ScriptedResearchTools([
    { action: { type: 'search', query: 'expected' }, result: { pages: [], requests: 1, bytes: 1, estimatedUsd: null, credits: null, limitations: [] } }
  ]);
  await assert.rejects(mismatch.execute({ type: 'search', query: 'other' }, signal), /expects/);
  assert.equal(mismatch.violations[0]?.kind, 'tool_action_mismatch');

  const unconsumed = new ScriptedResearchTools([
    { action: { type: 'search', query: 'q' }, result: { pages: [], requests: 1, bytes: 1, estimatedUsd: null, credits: null, limitations: [] } }
  ]);
  assert.ok(unconsumed.finishScript().some((violation) => violation.kind === 'unconsumed_tool_step'));

  const planner = new ScriptedResearchPlanner([
    { mode: 'plan', decision: { action: 'finish', claims: [], unknowns: [] } }
  ]);
  await assert.rejects(
    planner.decide({ mode: 'verify', question: 'q', checkpoint: {} as never, remainingTools: 1, remainingModels: 1 }, signal, async () => ({ status: 200, body: '' })),
    /expects mode/
  );
  assert.equal(planner.violations[0]?.kind, 'planner_mode_mismatch');
  assert.equal(planner.invokeCalls, 0);
  assert.ok(planner.finishScript().some((violation) => violation.kind === 'unconsumed_planner_step'));
});

test('normalization keeps dependency identity and stabilizes receipt order', () => {
  const receiptA = { key: 'tool:a', kind: 'tool', state: 'completed', request: { q: 2 }, result: { n: 2 }, usage: { estimatedUsd: 0.2 }, reservedInput: 0, reservedOutput: 0 };
  const receiptB = { key: 'tool:b', kind: 'tool', state: 'completed', request: { q: 1 }, result: { n: 1 }, usage: { estimatedUsd: 0.1 }, reservedInput: 0, reservedOutput: 0 };
  const base = {
    checkpoint: {
      startedAt: 111, elapsedMs: 5,
      pages: [{ sourceKey: 'S1', url: 'https://a.invalid/', inheritedFrom: { runId: 'run_a', sourceKey: 'S1' } }]
    },
    receipts: [receiptB, receiptA]
  };
  const swapped = { ...base, receipts: [receiptA, receiptB] };
  assert.equal(
    normalizedHash({ ...base, receipts: stableReceiptOrder(base.receipts) }),
    normalizedHash({ ...swapped, receipts: stableReceiptOrder(swapped.receipts) }),
    'same-millisecond receipt reordering must not change the normalized hash'
  );

  const changedSourceKey = JSON.parse(JSON.stringify(base)) as typeof base;
  changedSourceKey.checkpoint.pages[0]!.inheritedFrom.sourceKey = 'S2';
  assert.notEqual(
    normalizedHash({ ...base, receipts: stableReceiptOrder(base.receipts) }),
    normalizedHash({ ...changedSourceKey, receipts: stableReceiptOrder(changedSourceKey.receipts) }),
    'an inherited source changing S1 -> S2 must change the normalized hash'
  );

  const changedRunId = JSON.parse(JSON.stringify(base)) as typeof base;
  changedRunId.checkpoint.pages[0]!.inheritedFrom.runId = 'run_b';
  assert.equal(
    normalizedHash({ ...base, receipts: stableReceiptOrder(base.receipts) }),
    normalizedHash({ ...changedRunId, receipts: stableReceiptOrder(changedRunId.receipts) }),
    'only the volatile runId of inheritedFrom normalizes'
  );

  const withoutDependency = JSON.parse(JSON.stringify(base)) as typeof base;
  delete (withoutDependency.checkpoint.pages[0] as Record<string, unknown>).inheritedFrom;
  assert.notEqual(
    normalizedHash({ ...base, receipts: stableReceiptOrder(base.receipts) }),
    normalizedHash({ ...withoutDependency, receipts: stableReceiptOrder(withoutDependency.receipts) }),
    'null-vs-existing dependency must be preserved in the hash'
  );
});

test('network guard denies fetch/http/https/net/tls/subprocess without reaching the connectors', async () => {
  const dir = tempDir('rb-guard-probe-');
  const connections: number[] = [];
  const server: Server = createServer((socket) => {
    connections.push(1);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const markerSpawn = path.join(dir, 'spawn-marker');
  const markerWorker = path.join(dir, 'worker-marker');
  const resultPath = path.join(dir, 'probe.json');
  const guardLog = path.join(dir, 'guard-violations.jsonl');
  try {
    // Positive control: the same listener must see an actual loopback
    // connection before its zero count can prove anything about the guard.
    const positive = await runNodeProbe(['-e', `
      const socket = require('node:net').connect(${address.port}, '127.0.0.1');
      socket.on('error', () => { process.exitCode = 1; });
      socket.on('connect', () => socket.end());
    `]);
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(connections.length, 1, 'positive control must reach the TCP listener');
    connections.length = 0;

    const probe = await runNodeProbe([
      '--import', pathToFileURL(path.join(harnessDir, 'network-guard.mjs')).href,
      path.join(harnessDir, 'network-probe.mjs')
    ], {
        ...process.env,
        STRIPSEARCH_GUARD_LOG: guardLog,
        PROBE_HOST: '127.0.0.1',
        PROBE_PORT: String(address.port),
        MARKER_SPAWN: markerSpawn,
        MARKER_WORKER: markerWorker,
        PROBE_RESULT: resultPath
    });
    assert.equal(probe.status, 1, `denied attempts must force a nonzero exit: ${probe.stdout}\n${probe.stderr}`);
    const verdict = JSON.parse(readFileSync(resultPath, 'utf8')) as { attempts: { api: string; denied: boolean }[]; allDenied: boolean };
    assert.equal(verdict.allDenied, true);
    for (const api of ['fetch', 'http.request', 'https.request', 'net.connect', 'net.Socket.prototype.connect', 'tls.connect', 'child_process.execFile', 'worker_threads.Worker']) {
      assert.ok(verdict.attempts.some((entry) => entry.api === api && entry.denied), `missing denied probe for ${api}`);
    }
    assert.equal(connections.length, 0, 'no underlying TCP connector may be reached');
    assert.equal(existsSync(markerSpawn), false, 'child_process escape must not reach the OS');
    assert.equal(existsSync(markerWorker), false, 'worker_threads escape must not reach a worker');
    const logged = readFileSync(guardLog, 'utf8').split('\n').filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { api: string });
    assert.ok(logged.length >= verdict.attempts.length, 'the independent violation log records every denied attempt');
    for (const entry of verdict.attempts) {
      assert.ok(logged.some((line) => line.api === entry.api), `guard log misses ${entry.api}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard violations force failure even when caught and the caller requests exit zero', async () => {
  const dir = tempDir('rb-guard-exit-');
  const guardLog = path.join(dir, 'violations.jsonl');
  try {
    const probe = await runNodeProbe([
      '--import', pathToFileURL(path.join(harnessDir, 'network-guard.mjs')).href,
      '-e', "try { fetch('https://must-never-connect.invalid'); } catch {} process.exit(0);"
    ], { ...process.env, STRIPSEARCH_GUARD_LOG: guardLog });
    assert.equal(probe.status, 1, probe.stderr);
    assert.equal(readFileSync(guardLog, 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a guard log write failure terminates before a caller can swallow it', async () => {
  const dir = tempDir('rb-guard-log-failure-');
  try {
    // An existing directory is an unwritable append target even under root;
    // this avoids platform/user-dependent chmod behavior in the regression.
    const probe = await runNodeProbe([
      '--import', pathToFileURL(path.join(harnessDir, 'network-guard.mjs')).href,
      '-e', "try { fetch('https://must-never-connect.invalid'); } catch {} console.log('continued-after-log-failure'); process.exit(0);"
    ], { ...process.env, STRIPSEARCH_GUARD_LOG: dir });
    assert.equal(probe.status, 1, probe.stderr);
    assert.match(probe.stderr, /could not persist a violation/);
    assert.equal(probe.stdout.includes('continued-after-log-failure'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('frozen replay passes structurally with honest counters and deterministic hashes', async () => {
  const dir = tempDir('rb-full-');
  try {
    const first = await runResearchBaseline({ datasetPath, datasetDisplayPath, outputDir: path.join(dir, 'out-a'), repoRoot });
    const second = await runResearchBaseline({ datasetPath, datasetDisplayPath, outputDir: path.join(dir, 'out-b'), repoRoot });
    const report = first.report;
    assert.equal(first.exitCode, 0, report.cases.filter((entry) => entry.structural !== 'pass').map((entry) => entry.failures.join('; ')).join(' | ') || report.run.failures.join('; '));
    assert.equal(second.exitCode, 0);
    assert.equal(report.type, 'offline_controller_replay');
    assert.equal(report.summary.scheduled, 11);
    assert.deepEqual(report.summary.caseProgress, { started: 11, finished: 11, unfinished: 0, notRun: 0 });
    assert.deepEqual(report.summary.states, { completed: 2, partial: 7, needs_input: 1, runner_error: 1 });
    assert.equal(report.summary.passRate.denominator, 11, 'all scheduled cases stay in the denominator');
    assert.equal(report.summary.structural.passed, 11);
    // Model accounting: zero actual invocations, historical receipts preserved,
    // real token/cost not measured instead of a fabricated zero.
    assert.equal(report.summary.modelInvocations, 0);
    assert.equal(report.summary.modelReceipts, 1);
    assert.equal(report.summary.modelTokens, 'not_measured');
    assert.equal(report.summary.modelCostUsd, 'not_measured');
    assert.equal(report.summary.actualPaidCostUsd, null);
    assert.equal(report.summary.plannerDecisionCalls, 16);
    assert.equal(report.summary.fixtureProviderCalls, 14);
    assert.equal(report.summary.networkAttempts, 0);
    assert.deepEqual(report.run.failures, []);
    assert.equal(report.run.workerExitCode, 0);
    assert.equal(report.run.guardInstalled, true);

    // Fixture fees are simulated; a mixed known/unknown case keeps the complete
    // total unknown instead of summing a misleading number.
    assert.equal(report.summary.fixtureFees.measurement, 'simulated');
    assert.equal(report.summary.fixtureFees.simulatedTotal, null);
    assert.equal(report.summary.fixtureFees.casesWithUnknownFee >= 1, true);
    const withFailure = report.cases.find((entry) => entry.caseId === 'rb-007');
    assert.ok(withFailure);
    assert.equal(withFailure.actual.fixtureUsage.unknownFeeReceipts, 1);
    assert.equal(withFailure.actual.fixtureUsage.knownSimulatedSubtotal, 0.0004);
    assert.equal(withFailure.actual.fixtureUsage.simulatedTotal, null);
    assert.equal(withFailure.actual.receipts.failed, 1, 'the failed receipt with unknown fee is preserved');

    // Unknown inflight recovery: no re-fetch, receipts untouched.
    const inflight = report.cases.find((entry) => entry.caseId === 'rb-008');
    assert.ok(inflight);
    assert.equal(inflight.actual.counts.toolCalls, 0);
    assert.equal(inflight.actual.counts.plannerDecisionCalls, 0);
    assert.deepEqual(inflight.actual.receipts, { total: 1, completed: 0, failed: 0, inflight: 1 });

    // Runner error is retained and the subsequent case still runs.
    const runnerError = report.cases.find((entry) => entry.caseId === 'rb-009');
    assert.ok(runnerError);
    assert.equal(runnerError.actual.state, 'runner_error');
    assert.equal(runnerError.actual.executionError?.name, 'ResearchStop');
    assert.ok(runnerError.actual.executionError?.message.includes('run_inactive'));
    const continuation = report.cases.find((entry) => entry.caseId === 'rb-010');
    assert.ok(continuation);
    assert.equal(continuation.actual.state, 'completed');
    assert.equal(continuation.structural, 'pass');

    // Historical inflight model receipt is recovery evidence, not an invocation.
    const modelReceipt = report.cases.find((entry) => entry.caseId === 'rb-011');
    assert.ok(modelReceipt);
    assert.equal(modelReceipt.actual.counts.modelInvocations, 0);
    assert.equal(modelReceipt.actual.counts.modelReceipts, 1);

    // Effective merged limits are recorded per case (rb-006 caps toolCalls at 2).
    const budget = report.cases.find((entry) => entry.caseId === 'rb-006');
    assert.ok(budget);
    assert.equal(budget.actual.effectiveLimits.toolCalls, 2);
    assert.equal(report.config.execution.baseLimits.toolCalls, 12);

    // Determinism across independent replays, and honest hash flavours.
    for (const entry of report.cases) {
      const other = second.report.cases.find((candidate) => candidate.caseId === entry.caseId);
      assert.ok(other);
      assert.equal(entry.hashes.normalizedResult, other.hashes.normalizedResult, `normalized hash drift for ${entry.caseId}`);
      assert.ok(entry.hashes.serialized);
      assert.equal(typeof entry.hashes.artifact, 'string');
    }

    // Artifact hashes describe the real files on disk (manifest is the audit).
    const manifestPath = path.join(dir, 'out-a', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; sha256: string }[] };
    for (const file of manifest.files) {
      const bytes = readFileSync(path.join(dir, 'out-a', file.path));
      assert.equal(sha256Hex(bytes.toString('utf8')), file.sha256, `artifact hash mismatch for ${file.path}`);
    }
    for (const entry of report.cases) {
      const manifestEntry = manifest.files.find((file) => file.path === entry.artifact);
      assert.ok(manifestEntry, `manifest misses ${entry.artifact}`);
      assert.equal(manifestEntry.sha256, entry.hashes.artifact, `report/manifest hash mismatch for ${entry.caseId}`);
    }

    assert.deepEqual(verifyReportConsistency(report), []);
    assert.ok(report.notEvaluated.some((line) => line.includes('semantic_entailment')));
    assert.ok(report.notEvaluated.some((line) => line.includes('os_network_isolation')));
    assert.ok(report.notEvaluated.some((line) => line.includes('freeze_chronology')));
    assert.ok(report.build.executedArtifacts.length > 0, 'executed worker bytes are hashed');
    assert.ok(report.source.manifestAggregateSha256.length === 64);
    assert.ok(report.config.execution.sha256.length === 64);

    // runtime-v1 stays honestly labelled as its own track.
    const runtimeReport = readFileSync(path.join(repoRoot, 'apps', 'web', 'src', 'evals', 'report.ts'), 'utf8');
    assert.ok(runtimeReport.includes("REPORT_TYPE = 'offline_provider_contract'"));
    const runtimeReadme = readFileSync(path.join(repoRoot, 'evals', 'runtime-v1', 'README.md'), 'utf8');
    assert.ok(runtimeReadme.includes('冻结回放'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a guarded network attempt cannot be swallowed by the controller', async () => {
  const dir = tempDir('rb-netfault-');
  try {
    const cases = loadRawCases();
    const fault = cases[0];
    assert.ok(fault);
    fault.case_id = 'rb-netfault';
    const faultSteps = fault.tools as { networkAttempt?: string }[];
    const faultStep = faultSteps[0];
    assert.ok(faultStep);
    const privateLocalPath = path.join(dir, 'synthetic-private-helper');
    faultStep.networkAttempt = `file://${privateLocalPath}`;
    const subset = writeRawSubsetDataset(dir, 'netfault.jsonl', [fault]);
    const result = await runResearchBaseline({ datasetPath: subset, datasetDisplayPath: 'netfault.jsonl', outputDir: path.join(dir, 'out'), repoRoot });
    assert.equal(result.exitCode, 1);
    assert.ok(result.report.run.failures.some((failure) => failure.includes('network_guard_violations')));
    const entry = result.report.cases[0];
    assert.ok(entry);
    assert.equal(entry.structural, 'fail');
    assert.ok(entry.failures.some((failure) => failure.includes('hard_failure:network_guard_violation')));
    assert.ok(entry.failures.some((failure) => failure.includes('fixture:network_attempt')));
    // The controller swallowed the thrown error and returned partial: the
    // independent guard log is what makes the attempt impossible to hide.
    assert.equal(entry.actual.state, 'partial');
    assert.equal(entry.actual.stopReason, 'research_error');
    const guardLog = readFileSync(path.join(dir, 'out', 'guard-violations.jsonl'), 'utf8');
    assert.ok(guardLog.includes('"api":"fetch"'));
    assert.equal(guardLog.includes(privateLocalPath), false, 'published guard logs must redact local paths');
    assert.ok(guardLog.includes('<path>') || guardLog.includes('<abs-path>'));
    const artifactManifest = JSON.parse(readFileSync(path.join(dir, 'out', 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
    assert.equal(artifactManifest.files.find(file => file.path === 'guard-violations.jsonl')?.sha256, sha256Hex(guardLog));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete records with a failed worker process still fail the run visibly', async () => {
  const dir = tempDir('rb-workerexit-');
  const previous = process.env.STRIPSEARCH_WORKER_FAULT_EXIT;
  try {
    const cases = loadRawCases();
    const subset = writeRawSubsetDataset(dir, 'exit-fault.jsonl', [cases[0] as Record<string, unknown>]);
    process.env.STRIPSEARCH_WORKER_FAULT_EXIT = '3';
    const result = await runResearchBaseline({ datasetPath: subset, datasetDisplayPath: 'exit-fault.jsonl', outputDir: path.join(dir, 'out'), repoRoot });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.summary.caseProgress.finished, 1);
    assert.equal(result.report.summary.structural.passed, 1, 'the case itself passed');
    assert.ok(result.report.run.failures.some((failure) => failure.includes('worker_exit_nonzero')), result.report.run.failures.join('; '));
    assert.equal(result.report.run.workerExitCode, 3);
    assert.ok(result.report.summary.runLevelFailures >= 1);
  } finally {
    if (previous === undefined) delete process.env.STRIPSEARCH_WORKER_FAULT_EXIT;
    else process.env.STRIPSEARCH_WORKER_FAULT_EXIT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mid-run process crash preserves prior results and keeps every case in the denominator', async () => {
  const dir = tempDir('rb-crash-');
  const previous = process.env.STRIPSEARCH_WORKER_FAULT_CRASH_AT;
  try {
    const cases = loadRawCases();
    const subset = writeRawSubsetDataset(dir, 'crash.jsonl', cases.slice(0, 3));
    process.env.STRIPSEARCH_WORKER_FAULT_CRASH_AT = 'rb-002';
    const result = await runResearchBaseline({ datasetPath: subset, datasetDisplayPath: 'crash.jsonl', outputDir: path.join(dir, 'out'), repoRoot });
    assert.equal(result.exitCode, 1);
    const report = result.report;
    assert.equal(report.summary.scheduled, 3);
    assert.deepEqual(report.summary.caseProgress, { started: 2, finished: 1, unfinished: 1, notRun: 1 });
    assert.equal(report.summary.unknownUsageCases, 1);
    assert.equal(report.summary.observedCountsMeasurement, 'lower_bound');
    assert.equal(report.summary.fixtureFees.simulatedTotal, null);
    assert.equal(report.summary.passRate.denominator, 3);
    assert.ok(report.run.failures.some((failure) => failure.includes('worker_signal')), report.run.failures.join('; '));

    const survivors = report.cases.filter((entry) => entry.actual.completion === 'finished');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0]?.caseId, 'rb-001', 'completed predecessors survive the crash');
    assert.equal(survivors[0]?.structural, 'pass');
    assert.ok(survivors[0]?.hashes.artifact);
    const unfinished = report.cases.find((entry) => entry.caseId === 'rb-002');
    assert.equal(unfinished?.actual.completion, 'unfinished');
    assert.ok(unfinished?.failures.some((failure) => failure.includes('completion: expected finished received unfinished')));
    const notRun = report.cases.find((entry) => entry.caseId === 'rb-003');
    assert.equal(notRun?.actual.completion, 'not_run');
    assert.ok(notRun?.failures.some((failure) => failure.includes('completion: expected finished received not_run')));
    // The surviving artifact really exists on disk with its result payload.
    const survivorArtifact = JSON.parse(readFileSync(path.join(dir, 'out', 'cases', 'rb-001.json'), 'utf8')) as { raw: { result: unknown } };
    assert.ok(survivorArtifact.raw.result, 'the surviving case keeps its raw result');
  } finally {
    if (previous === undefined) delete process.env.STRIPSEARCH_WORKER_FAULT_CRASH_AT;
    else process.env.STRIPSEARCH_WORKER_FAULT_CRASH_AT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report consistency verification catches tampering without losing reports', () => {
  const report: BaselineReport = {
    type: 'offline_controller_replay',
    datasetVersion: 'research-baseline-v1',
    labels: { track: '', boundary: '' },
    generatedAt: 'now',
    totalMonotonicElapsedMs: 1,
    config: {
      execution: { fixtureProvider: '', injected: true, planner: '', modelGateway: '', transport: '', credentials: '', networkPolicy: '', baseLimits: {}, sha256: '' },
      paths: { outputDir: '', tmpBase: '' }
    },
    build: { bootstrap: '', executedArtifacts: [], aggregateSha256: '' },
    source: { datasetPath: '', datasetSha256: '', commit: null, dirty: null, dirtyPaths: null, nodeVersion: '', lockfile: { path: '', sha256: '' }, manifest: [], manifestAggregateSha256: '' },
    normalization: { ids: [], timestamps: [], durations: [] },
    guard: { processIsolated: true, installedBeforeProductionImports: true, coveredApis: [], violations: 0, logArtifact: '', boundary: '' },
    run: { workerExitCode: 0, workerSignal: null, guardInstalled: true, recordsFormat: '', failures: [] },
    runCommands: [],
    summary: {
      scheduled: 1,
      caseProgress: { started: 1, finished: 1, unfinished: 0, notRun: 0 },
      structural: { passed: 1, failed: 0 },
      passRate: { value: 1, denominator: 1 },
      states: { completed: 1, partial: 0, needs_input: 0, runner_error: 0 },
      hardFailures: 0,
      fixtureViolations: 0,
      networkAttempts: 0,
      executionErrors: 0,
      unknownUsageCases: 0,
      observedCountsMeasurement: 'exact',
      runLevelFailures: 0,
      plannerDecisionCalls: 1,
      modelInvocations: 0,
      modelReceipts: 0,
      fixtureProviderCalls: 1,
      modelTokens: 'not_measured',
      modelCostUsd: 'not_measured',
      actualPaidCostUsd: null,
      fixtureFees: { measurement: 'simulated', knownSimulatedSubtotal: null, simulatedTotal: null, casesWithUnknownFee: 0 }
    },
    cases: [{
      caseId: 'x', scenario: 's', title: 't', tags: [],
      expected: {
        state: 'completed', stopReason: null, toolCalls: 0, plannerCalls: 0, modelCalls: 0,
        receipts: { total: 0, completed: 0, failed: 0, inflight: 0 }, unknownCost: false
      },
      actual: {
        state: 'completed', stopReason: null, identityStatus: 'resolved', completion: 'finished',
        counts: { toolCalls: 0, plannerDecisionCalls: 1, modelInvocations: 0, modelReceipts: 0, fixtureProviderCalls: 0 },
        receipts: { total: 0, completed: 0, failed: 0, inflight: 0 }, unknownCost: false,
        claimsRetained: 0, candidates: 0, runnerError: null, fixtureViolations: [], executionError: null,
        fixtureUsage: { measurement: 'simulated', knownSimulatedSubtotal: null, simulatedTotal: null, unknownFeeReceipts: 0, bytes: 0 },
        effectiveLimits: {}
      },
      structural: 'pass', failures: [], hardFailure: false, monotonicElapsedMs: 1,
      hashes: { normalizedResult: 'h', serialized: { result: null, checkpoint: null, receipts: null, canonical: null, markdown: null }, artifact: 'a' },
      artifact: 'cases/x.json'
    }],
    notEvaluated: []
  };
  assert.deepEqual(verifyReportConsistency(report), []);
  const tampered = JSON.parse(JSON.stringify(report)) as BaselineReport;
  tampered.summary.structural.passed += 1;
  assert.ok(verifyReportConsistency(tampered).some((failure) => failure.includes('contradicts')));
  const fakeModel = JSON.parse(JSON.stringify(report)) as BaselineReport;
  fakeModel.summary.modelInvocations = 2;
  fakeModel.summary.modelTokens = 0 as never;
  assert.ok(verifyReportConsistency(fakeModel).some((failure) => failure.includes('not_measured') || failure.includes('modelInvocations')));
  const unknownFee = JSON.parse(JSON.stringify(report)) as BaselineReport;
  unknownFee.summary.fixtureFees.casesWithUnknownFee = 1;
  unknownFee.summary.fixtureFees.simulatedTotal = 0.5;
  assert.ok(verifyReportConsistency(unknownFee).some((failure) => failure.includes('simulatedTotal')));
});

test('grading fails hard on unexpected execution errors and fixture violations', () => {
  const cases = loadCases();
  const entry = cases[0] as BaselineCase;
  const execution: CaseExecution = {
    caseId: entry.caseId,
    scenario: entry.scenario,
    completion: 'finished',
    monotonicElapsedMs: 1,
    state: 'runner_error',
    stopReason: null,
    error: { name: 'TypeError', message: 'boom', stack: null },
    runId: null,
    result: null,
    checkpoint: null,
    receipts: [],
    budget: null,
    canonical: null,
    markdown: null,
    canonicalJson: null,
    counts: { toolCalls: 0, plannerDecisionCalls: 0, modelInvocations: 0, modelReceipts: 0, fixtureProviderCalls: 0 },
    fixtureUsage: { measurement: 'simulated', knownSimulatedSubtotal: null, simulatedTotal: null, unknownFeeReceipts: 0, bytes: 0 },
    fixtureViolations: [{ kind: 'unexpected_tool_call', message: 'extra call' }]
  };
  const grade = gradeCase(entry, execution, 0);
  assert.equal(grade.passed, false);
  assert.equal(grade.hardFailure, true);
  assert.ok(grade.failures.some((failure) => failure.includes('unexpected_execution_error')));
  assert.ok(grade.failures.some((failure) => failure.includes('fixture:unexpected_tool_call')));
});
