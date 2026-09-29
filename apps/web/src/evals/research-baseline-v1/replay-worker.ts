/**
 * Replay worker for the research-baseline-v1 baseline.
 *
 * This entry point runs in an isolated process launched as
 *   node --import ./network-guard.mjs <precompiled>/replay-worker.js
 * where <precompiled> is a tsc-compiled snapshot of this source tree whose
 * bytes are hashed into the report. The network/subprocess guard is installed
 * BEFORE any production module (runResearch, Store, adapters) is imported.
 *
 * Records are persisted incrementally as JSONL events: a `case-start` is
 * appended before each case and a `case-done` (with the full execution record)
 * after it, so a process crash preserves completed predecessors and lets the
 * orchestrator distinguish started-unfinished from never-started cases. All
 * elapsed timings are monotonic (performance.now).
 *
 * Harness self-test fault hooks (never reachable from dataset content):
 * - STRIPSEARCH_WORKER_FAULT_EXIT=<n>: after finishing all cases, exit with n.
 * - STRIPSEARCH_WORKER_FAULT_CRASH_AT=<caseId>: kill this process (SIGKILL)
 *   right after the case-start marker of that case, simulating a hard crash.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { crashRecord, executeCase, type CaseExecution } from './case-runner.js';
import { parseDataset } from './schema.js';

const { values } = parseArgs({
  options: {
    dataset: { type: 'string' },
    records: { type: 'string' }
  },
  strict: true,
  allowPositionals: false
});

if (!values.dataset || !values.records) {
  console.error('replay-worker: --dataset and --records are required');
  process.exit(2);
}

function emit(event: Record<string, unknown>): void {
  appendFileSync(values.records as string, JSON.stringify(event) + '\n', 'utf8');
}

const faultExitRaw = process.env.STRIPSEARCH_WORKER_FAULT_EXIT?.trim() ?? '';
const faultExit = /^\d+$/.test(faultExitRaw) ? Number(faultExitRaw) : 0;
const faultCrashAt = process.env.STRIPSEARCH_WORKER_FAULT_CRASH_AT?.trim() ?? '';

const cases = parseDataset(readFileSync(values.dataset, 'utf8'));
writeFileSync(values.records, '', 'utf8');
emit({
  type: 'guard',
  installed: (globalThis as Record<string, unknown>).__stripsearchNetworkGuardInstalled === true,
  at: new Date().toISOString()
});

const replayStarted = performance.now();
for (const entry of cases) {
  emit({ type: 'case-start', caseId: entry.caseId, at: new Date().toISOString(), monotonicMs: performance.now() - replayStarted });
  if (faultCrashAt !== '' && faultCrashAt === entry.caseId) {
    // Simulate a hard process crash mid-run: no further bytes are written.
    process.kill(process.pid, 'SIGKILL');
  }
  const started = performance.now();
  let execution: CaseExecution;
  try {
    execution = await executeCase(entry);
  } catch (error) {
    execution = crashRecord(entry, error, performance.now() - started);
  }
  emit({ type: 'case-done', caseId: entry.caseId, at: new Date().toISOString(), monotonicMs: performance.now() - replayStarted, execution });
}

emit({ type: 'worker-done', cases: cases.length, monotonicMs: performance.now() - replayStarted });
console.log(`replay-worker: wrote ${cases.length} case record(s)`);
if (faultExit > 0) process.exitCode = faultExit;
