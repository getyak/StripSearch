/**
 * Orchestrator for the research-baseline-v1 offline controller replay.
 *
 * Bootstrap: this untrusted-workspace orchestrator precompiles the harness and
 * the production modules it exercises to a temporary build directory with
 * `tsc` BEFORE the replay runs, and records a SHA256 of every executed byte
 * (emitted JS + the guard preload) in the report. The replay itself then runs
 * in an isolated worker process with NO transpiler present, so the
 * network/subprocess guard (network-guard.mjs) can deny fetch, http, https,
 * net, tls, child_process and worker_threads unconditionally before any
 * production import. The orchestrator only reads/writes local files, compiles,
 * spawns the worker, reads the independent guard violation log, grades every
 * case structurally and writes hashed JSON + Markdown evidence.
 *
 * Exit codes: 0 all structural checks pass, 1 any assertion/fixture/network
 * guard/worker-process violation, 2 invalid dataset or usage. A report is
 * always produced for executed work; internal inconsistencies become visible
 * run-level failures instead of throwing the report away.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { RESEARCH_LIMITS } from '../../server/research/research-store.js';
import { crashRecord, limitsFor, type CaseExecution } from './case-runner.js';
import { gradeCase } from './grade.js';
import { normalizedHash, sanitizeLocalPaths, sha256Hex, stableReceiptOrder } from './normalize.js';
import {
  buildReport,
  verifyReportConsistency,
  renderMarkdown,
  type BaselineCaseActual,
  type BaselineCaseReport,
  type BaselineHashes,
  type BaselineReport,
  type BaselineRunMeta
} from './report.js';
import { BaselineSchemaError, DATASET_VERSION, parseDataset, type BaselineCase } from './schema.js';

export class BaselineRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineRunError';
  }
}

/** Mirror of the APIs denied by network-guard.mjs (kept in sync with that file). */
const GUARDED_APIS = [
  'fetch',
  'WebSocket',
  'http.request',
  'http.get',
  'https.request',
  'https.get',
  'net.connect',
  'net.createConnection',
  'net.Socket.prototype.connect',
  'tls.connect',
  'child_process.spawn',
  'child_process.spawnSync',
  'child_process.exec',
  'child_process.execSync',
  'child_process.execFile',
  'child_process.execFileSync',
  'child_process.fork',
  'worker_threads.Worker'
];

/** Every source file whose bytes take part in the replay; missing entries fail the run. */
const SOURCE_MANIFEST_FILES = [
  'apps/web/src/evals/research-baseline-v1/schema.ts',
  'apps/web/src/evals/research-baseline-v1/fixtures.ts',
  'apps/web/src/evals/research-baseline-v1/case-runner.ts',
  'apps/web/src/evals/research-baseline-v1/normalize.ts',
  'apps/web/src/evals/research-baseline-v1/grade.ts',
  'apps/web/src/evals/research-baseline-v1/report.ts',
  'apps/web/src/evals/research-baseline-v1/runner.ts',
  'apps/web/src/evals/research-baseline-v1/run.ts',
  'apps/web/src/evals/research-baseline-v1/replay-worker.ts',
  'apps/web/src/evals/research-baseline-v1/network-guard.mjs',
  'apps/web/src/evals/research-baseline-v1/network-probe.mjs',
  'apps/web/src/evals/canonical-store.ts',
  'apps/web/src/server/research/controller.ts',
  'apps/web/src/server/research/research-store.ts',
  'apps/web/src/server/research/planner.ts',
  'apps/web/src/server/research/tool-contracts.ts',
  'apps/web/src/server/research/dsh-decision.ts',
  'apps/web/src/server/store.ts',
  'apps/web/src/server/db/index.ts',
  'apps/web/src/server/db/schema.ts',
  'apps/web/src/server/adapters/types.ts',
  'apps/web/src/shared/types.ts',
  'apps/web/src/shared/canonical.ts',
  'apps/web/src/shared/validation.ts'
];

const GUARD_FILE = 'apps/web/src/evals/research-baseline-v1/network-guard.mjs';

/** Walk up from this module to the repository root (the directory with evals/ and apps/). */
export function findRepoRoot(moduleUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(dir, 'evals')) && existsSync(path.join(dir, 'apps'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let cwd = process.cwd();
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(cwd, 'evals')) && existsSync(path.join(cwd, 'apps'))) return cwd;
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return process.cwd();
}

function tempBase(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

function gitInfo(repoRoot: string): { commit: string | null; dirty: boolean | null; dirtyPaths: number | null } {
  try {
    const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
    const dirtyPaths = status.split('\n').filter((line) => line.trim().length > 0).length;
    return { commit, dirty: dirtyPaths > 0, dirtyPaths };
  } catch {
    return { commit: null, dirty: null, dirtyPaths: null };
  }
}

/** The manifest must be complete: a missing required source file fails the run explicitly. */
function sourceManifest(repoRoot: string): { manifest: { path: string; sha256: string }[]; aggregateSha256: string } {
  const missing: string[] = [];
  const entries: { path: string; sha256: string }[] = [];
  for (const relative of SOURCE_MANIFEST_FILES) {
    const absolute = path.join(repoRoot, relative);
    if (!existsSync(absolute)) {
      missing.push(relative);
      continue;
    }
    entries.push({ path: relative, sha256: sha256Hex(readFileSync(absolute, 'utf8')) });
  }
  if (missing.length > 0) {
    throw new BaselineRunError(`source manifest incomplete; missing required file(s): ${missing.join(', ')}`);
  }
  return { manifest: entries, aggregateSha256: sha256Hex(JSON.stringify(entries)) };
}

function runCommand(executable: string, args: string[], cwd: string): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', (error) => resolve({ exitCode: null, output: `${output}\n${error.message}` }));
    child.on('close', (code) => resolve({ exitCode: code, output }));
  });
}

interface CompiledWorker {
  buildDir: string;
  entryPath: string;
  executedArtifacts: { path: string; sha256: string }[];
  aggregateSha256: string;
}

function walkJsFiles(dir: string, base: string, out: string[]): void {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walkJsFiles(full, base, out);
    else if (item.name.endsWith('.js')) out.push(path.relative(base, full));
  }
}

/**
 * Precompile the replay worker (and every production module it imports) to a
 * temporary build tree with tsc, so the guarded execution runs only local,
 * hashed JS bytes with no transpiler able to spawn helpers. A node_modules
 * symlink keeps dependency resolution identical to the source tree.
 */
async function compileWorker(repoRoot: string, tmpBase: string): Promise<CompiledWorker> {
  const webRoot = path.join(repoRoot, 'apps', 'web');
  const buildDir = mkdtempSync(path.join(tmpBase, 'stripsearch-research-baseline-build-'));
  symlinkSync(path.join(webRoot, 'node_modules'), path.join(buildDir, 'node_modules'), 'dir');
  const outDir = path.join(buildDir, 'out');
  const configPath = path.join(buildDir, 'tsconfig.json');
  writeFileSync(configPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      resolveJsonModule: true,
      noEmitOnError: true,
      rootDir: path.join(webRoot, 'src'),
      outDir,
      typeRoots: [path.join(webRoot, 'node_modules', '@types')],
      types: ['node']
    },
    files: [path.join(webRoot, 'src', 'evals', 'research-baseline-v1', 'replay-worker.ts')]
  }, null, 2), 'utf8');

  const require = createRequire(import.meta.url);
  const typescriptMain = require.resolve('typescript');
  const tscBin = path.join(path.dirname(typescriptMain), '..', 'bin', 'tsc');
  const compile = await runCommand(process.execPath, [tscBin, '-p', configPath], repoRoot);
  if (compile.exitCode !== 0) {
    throw new BaselineRunError(`worker precompile failed (exit ${String(compile.exitCode)}):\n${compile.output.trim().slice(0, 4000)}`);
  }

  const emitted: string[] = [];
  walkJsFiles(outDir, buildDir, emitted);
  const executedArtifacts = emitted.sort().map((relative) => ({
    path: `build/${relative.split(path.sep).join('/')}`,
    sha256: sha256Hex(readFileSync(path.join(buildDir, relative), 'utf8'))
  }));
  const guardAbsolute = path.join(repoRoot, GUARD_FILE);
  executedArtifacts.push({ path: GUARD_FILE, sha256: sha256Hex(readFileSync(guardAbsolute, 'utf8')) });
  return {
    buildDir,
    entryPath: path.join(outDir, 'evals', 'research-baseline-v1', 'replay-worker.js'),
    executedArtifacts,
    aggregateSha256: sha256Hex(JSON.stringify(executedArtifacts))
  };
}

interface WorkerOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
}

async function spawnWorker(options: {
  repoRoot: string;
  entryPath: string;
  datasetPath: string;
  recordsPath: string;
  guardLog: string;
  tmpBase: string;
}): Promise<WorkerOutcome> {
  const guardUrl = pathToFileURL(path.join(options.repoRoot, GUARD_FILE)).href;
  return await new Promise<WorkerOutcome>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', guardUrl, options.entryPath, '--dataset', options.datasetPath, '--records', options.recordsPath],
      {
        cwd: options.repoRoot,
        env: { ...process.env, STRIPSEARCH_GUARD_LOG: options.guardLog, TMPDIR: options.tmpBase },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let stdout = '';
    let stderr = '';
    let spawnFailed = false;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      spawnFailed = true;
      resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\nworker spawn failed: ${error.message}`, spawnFailed });
    });
    child.on('close', (code, signal) => {
      resolve({ exitCode: code, signal, stdout, stderr, spawnFailed });
    });
  });
}

function readGuardLog(guardLog: string): { violations: number; lines: string[]; missing: boolean } {
  if (!existsSync(guardLog)) return { violations: 0, lines: [], missing: true };
  const lines = readFileSync(guardLog, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  return { violations: lines.length, lines, missing: false };
}

interface ParsedWorkerRecords {
  guardInstalled: boolean;
  started: Set<string>;
  executions: Map<string, CaseExecution>;
  workerDone: boolean;
}

function parseWorkerRecords(recordsPath: string): ParsedWorkerRecords {
  const parsed: ParsedWorkerRecords = { guardInstalled: false, started: new Set(), executions: new Map(), workerDone: false };
  if (!existsSync(recordsPath)) return parsed;
  for (const line of readFileSync(recordsPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'guard') parsed.guardInstalled = event.installed === true;
    else if (event.type === 'case-start' && typeof event.caseId === 'string') parsed.started.add(event.caseId);
    else if (event.type === 'case-done' && typeof event.caseId === 'string' && event.execution && typeof event.execution === 'object') {
      parsed.executions.set(event.caseId, event.execution as CaseExecution);
    } else if (event.type === 'worker-done') parsed.workerDone = true;
  }
  return parsed;
}

function safeFilename(caseId: string): string {
  return caseId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function receiptsSummary(execution: CaseExecution): { total: number; completed: number; failed: number; inflight: number } {
  const receipts = execution.receipts ?? [];
  return {
    total: receipts.length,
    completed: receipts.filter((receipt) => receipt.state === 'completed').length,
    failed: receipts.filter((receipt) => receipt.state === 'failed').length,
    inflight: receipts.filter((receipt) => receipt.state === 'inflight').length
  };
}

function actualOf(execution: CaseExecution, entry: BaselineCase): BaselineCaseActual {
  return {
    state: execution.state,
    stopReason: execution.stopReason,
    identityStatus: execution.canonical?.identity.status ?? null,
    completion: execution.completion,
    counts: execution.counts,
    receipts: receiptsSummary(execution),
    unknownCost: execution.budget?.unknownCost ?? false,
    claimsRetained: execution.result?.observations.length ?? null,
    candidates: execution.canonical?.identity.candidates.length ?? null,
    runnerError: execution.error?.name ?? null,
    fixtureViolations: execution.fixtureViolations,
    executionError: execution.error,
    fixtureUsage: execution.fixtureUsage,
    effectiveLimits: { ...limitsFor(entry) }
  };
}

function hashesOf(execution: CaseExecution): Omit<BaselineHashes, 'artifact'> {
  const rawResult = execution.result ? JSON.stringify(execution.result, null, 2) : null;
  const rawCheckpoint = execution.checkpoint ? JSON.stringify(execution.checkpoint, null, 2) : null;
  const rawReceipts = execution.receipts ? JSON.stringify(execution.receipts, null, 2) : null;
  const rawCanonical = execution.canonicalJson ?? (execution.canonical ? JSON.stringify(execution.canonical, null, 2) : null);
  const rawMarkdown = execution.markdown;
  return {
    normalizedResult: normalizedHash({
      caseId: execution.caseId,
      state: execution.state,
      stopReason: execution.stopReason,
      error: execution.error ? { name: execution.error.name, message: execution.error.message } : null,
      counts: execution.counts,
      result: execution.result,
      checkpoint: execution.checkpoint,
      // Stable ordering for hashing only; raw ledger order stays in the artifacts.
      receipts: execution.receipts === null ? null : stableReceiptOrder(execution.receipts)
    }),
    serialized: {
      result: rawResult === null ? null : sha256Hex(rawResult),
      checkpoint: rawCheckpoint === null ? null : sha256Hex(rawCheckpoint),
      receipts: rawReceipts === null ? null : sha256Hex(rawReceipts),
      canonical: rawCanonical === null ? null : sha256Hex(rawCanonical),
      markdown: rawMarkdown === null ? null : sha256Hex(rawMarkdown)
    }
  };
}

export interface RunResearchBaselineOptions {
  datasetPath: string;
  datasetDisplayPath: string;
  outputDir: string;
  repoRoot: string;
}

export interface RunResearchBaselineResult {
  report: BaselineReport;
  exitCode: number;
  outputDir: string;
  manifestPath: string;
}

export async function runResearchBaseline(options: RunResearchBaselineOptions): Promise<RunResearchBaselineResult> {
  const startedAt = performance.now();
  const datasetText = readFileSync(options.datasetPath, 'utf8');
  const datasetSha256 = sha256Hex(datasetText);
  const cases = parseDataset(datasetText);
  const { manifest, aggregateSha256 } = sourceManifest(options.repoRoot);
  const tmpBase = tempBase();

  const workDir = mkdtempSync(path.join(tmpBase, 'stripsearch-research-baseline-'));
  const guardLog = path.join(workDir, 'guard-violations.jsonl');
  writeFileSync(guardLog, '', 'utf8');
  const recordsPath = path.join(workDir, 'records.jsonl');

  let compiled: CompiledWorker | null = null;
  let outcome: WorkerOutcome = { exitCode: null, signal: null, stdout: '', stderr: '', spawnFailed: false };
  const runLevelFailures: string[] = [];
  let bootstrapFailed = false;
  try {
    compiled = await compileWorker(options.repoRoot, tmpBase);
    outcome = await spawnWorker({
      repoRoot: options.repoRoot,
      entryPath: compiled.entryPath,
      datasetPath: options.datasetPath,
      recordsPath,
      guardLog,
      tmpBase
    });
  } catch (error) {
    bootstrapFailed = true;
    runLevelFailures.push(`worker_bootstrap_failed: ${error instanceof Error ? error.message : String(error)}`);
    outcome = { exitCode: null, signal: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), spawnFailed: true };
  }

  const guard = readGuardLog(guardLog);
  const records = parseWorkerRecords(recordsPath);

  // Run-level process accounting: a complete record set does not excuse a
  // failed or signalled worker process.
  if (!bootstrapFailed && outcome.spawnFailed) runLevelFailures.push(`worker_spawn_failed: ${outcome.stderr.trim().slice(0, 400)}`);
  if (outcome.signal) runLevelFailures.push(`worker_signal: worker process terminated by ${outcome.signal}`);
  if (!bootstrapFailed && !outcome.spawnFailed && !outcome.signal && outcome.exitCode !== 0) {
    runLevelFailures.push(`worker_exit_nonzero: worker process exited ${String(outcome.exitCode)}`);
  }
  if (!bootstrapFailed && !records.guardInstalled) runLevelFailures.push('guard_not_installed: replay worker did not report the network guard');
  if (guard.missing) runLevelFailures.push('guard_log_missing: the independent guard violation log was not created');
  if (guard.violations > 0) runLevelFailures.push(`network_guard_violations: ${guard.violations} guarded network/subprocess attempt(s) logged`);
  if (!bootstrapFailed && !records.workerDone && outcome.signal === null && !outcome.spawnFailed) {
    runLevelFailures.push('worker_records_incomplete: no worker-done marker in the incremental records');
  }
  const guardViolations = guard.violations;

  // Reconcile scheduled cases against incremental records. Scheduled cases are
  // never dropped: finished, started-unfinished and never-started all keep a
  // record and stay in the denominator.
  const executions: CaseExecution[] = [];
  for (const entry of cases) {
    const done = records.executions.get(entry.caseId);
    if (done) {
      executions.push(done);
      continue;
    }
    if (records.started.has(entry.caseId)) {
      executions.push(crashRecord(
        entry,
        new BaselineRunError(`case started but the worker process died before finishing it (worker exit ${String(outcome.exitCode)} signal ${String(outcome.signal)})`),
        0,
        'unfinished'
      ));
      continue;
    }
    executions.push(crashRecord(
      entry,
      new BaselineRunError(`case never started; worker stopped earlier (worker exit ${String(outcome.exitCode)} signal ${String(outcome.signal)})`),
      0,
      'not_run'
    ));
  }
  if (executions.some((execution) => execution.completion !== 'finished')) {
    runLevelFailures.push('worker_records_incomplete: not every scheduled case has a completed record');
  }

  // Build each case's FINAL publishable bytes first, hash those bytes, then
  // keep them for writing. The serialized subobject hashes stay separate and
  // honestly named.
  const roots = [options.repoRoot, tmpBase, workDir, compiled?.buildDir ?? '', options.outputDir];
  const caseReports: BaselineCaseReport[] = [];
  const artifactFiles: { name: string; bytes: string }[] = [];
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index] as BaselineCase;
    const execution = executions[index] as CaseExecution;
    const grade = gradeCase(entry, execution, guardViolations);
    const hashes = hashesOf(execution);
    const actual = actualOf(execution, entry);
    const artifactName = `cases/${safeFilename(entry.caseId)}.json`;
    const artifactBytes = sanitizeLocalPaths(JSON.stringify({
      caseId: entry.caseId,
      scenario: entry.scenario,
      title: entry.title,
      expected: entry.expect,
      actual,
      failures: grade.failures,
      error: execution.error,
      raw: {
        result: execution.result,
        checkpoint: execution.checkpoint,
        receipts: execution.receipts,
        canonical: execution.canonical,
        markdown: execution.markdown
      },
      hashes: { ...hashes, artifact: null },
      artifactHashNote: 'hashes.artifact is stored in report.json and manifest.json: a file cannot contain its own hash'
    }, null, 2), roots) + '\n';
    const artifactSha256 = sha256Hex(artifactBytes);
    artifactFiles.push({ name: artifactName, bytes: artifactBytes });
    caseReports.push({
      caseId: entry.caseId,
      scenario: entry.scenario,
      title: entry.title,
      tags: entry.tags,
      expected: entry.expect,
      actual,
      structural: grade.passed ? 'pass' : 'fail',
      failures: grade.failures,
      hardFailure: grade.hardFailure,
      monotonicElapsedMs: execution.monotonicElapsedMs,
      hashes: { ...hashes, artifact: artifactSha256 },
      artifact: artifactName
    });
  }

  const executionConfig = {
    fixtureProvider: 'scripted-research-tools-v1',
    injected: true as const,
    planner: 'scripted-fixture-decisions-v1',
    modelGateway: 'never invoked (scripted decisions do not call invoke)',
    transport: 'none (no HttpTransport is supplied to runResearch)',
    credentials: 'none (no API keys are supplied to runResearch)',
    networkPolicy: 'isolated replay worker under network-guard.mjs; process-level API guard, not OS network isolation',
    baseLimits: { ...RESEARCH_LIMITS }
  };
  const lockfilePath = path.join('apps', 'web', 'package-lock.json');
  const lockfileFull = path.join(options.repoRoot, lockfilePath);
  const runMeta: BaselineRunMeta = {
    workerExitCode: outcome.exitCode,
    workerSignal: outcome.signal,
    guardInstalled: records.guardInstalled,
    recordsFormat: 'jsonl-events-v1',
    failures: runLevelFailures
  };
  const report = buildReport(caseReports, {
    generatedAt: new Date().toISOString(),
    totalMonotonicElapsedMs: performance.now() - startedAt,
    config: {
      execution: { ...executionConfig, sha256: sha256Hex(JSON.stringify(executionConfig)) },
      paths: {
        outputDir: sanitizeLocalPaths(options.outputDir, [options.repoRoot, tmpBase]),
        tmpBase: '<TMPDIR>'
      }
    },
    build: {
      bootstrap: 'tsc-precompiled worker (no transpiler in the guarded process); executed bytes hashed below',
      executedArtifacts: compiled?.executedArtifacts ?? [],
      aggregateSha256: compiled?.aggregateSha256 ?? 'not-built'
    },
    source: {
      datasetPath: options.datasetDisplayPath,
      datasetSha256,
      ...gitInfo(options.repoRoot),
      nodeVersion: process.version,
      lockfile: {
        path: lockfilePath.split(path.sep).join('/'),
        sha256: existsSync(lockfileFull) ? sha256Hex(readFileSync(lockfileFull, 'utf8')) : 'missing'
      },
      manifest,
      manifestAggregateSha256: aggregateSha256
    },
    guard: {
      processIsolated: true,
      installedBeforeProductionImports: true,
      coveredApis: GUARDED_APIS,
      violations: guardViolations,
      logArtifact: 'guard-violations.jsonl',
      boundary: 'process-level network/subprocess API guard in the isolated replay worker; NOT OS network isolation and not claimed as such'
    },
    run: runMeta,
    runCommands: [
      'npm --prefix apps/web ci --prefer-offline --no-audit --no-fund',
      'npm --prefix apps/web run typecheck',
      'node --import ./apps/web/node_modules/tsx/dist/loader.mjs --test apps/web/src/tests/research-baseline.test.ts',
      'npm --prefix apps/web run eval:research',
      `npm --prefix apps/web run eval:research -- --dataset ${options.datasetDisplayPath} --output evals/research-baseline-v1/evidence`
    ]
  });

  // Internal inconsistencies become visible run-level failures; the report is
  // still written so nothing is lost.
  for (const failure of verifyReportConsistency(report)) {
    report.run.failures.push(`report_inconsistency: ${failure}`);
    report.summary.runLevelFailures = report.run.failures.length;
  }

  mkdirSync(options.outputDir, { recursive: true });
  writeFileSync(path.join(options.outputDir, 'report.json'), sanitizeLocalPaths(JSON.stringify(report, null, 2), roots) + '\n', 'utf8');
  writeFileSync(path.join(options.outputDir, 'report.md'), sanitizeLocalPaths(renderMarkdown(report), roots), 'utf8');
  const casesDir = path.join(options.outputDir, 'cases');
  rmSync(casesDir, { recursive: true, force: true });
  mkdirSync(casesDir, { recursive: true });
  for (const artifact of artifactFiles) {
    writeFileSync(path.join(options.outputDir, artifact.name), artifact.bytes, 'utf8');
  }
  writeFileSync(path.join(options.outputDir, 'guard-violations.jsonl'), sanitizeLocalPaths(guard.lines.join('\n') + (guard.lines.length > 0 ? '\n' : ''), roots), 'utf8');
  writeFileSync(
    path.join(options.outputDir, 'worker.log'),
    sanitizeLocalPaths(`exit=${String(outcome.exitCode)} signal=${String(outcome.signal)}\n--- stdout ---\n${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`, roots),
    'utf8'
  );

  // The artifact manifest hashes the exact final bytes of every written file
  // (itself excluded); tests rehash the real files against it.
  const manifestFiles: { path: string; sha256: string; bytes: number }[] = [];
  const hashFile = (relative: string, bytes: string): void => {
    manifestFiles.push({ path: relative, sha256: sha256Hex(bytes), bytes: Buffer.byteLength(bytes) });
  };
  hashFile('report.json', readFileSync(path.join(options.outputDir, 'report.json'), 'utf8'));
  hashFile('report.md', readFileSync(path.join(options.outputDir, 'report.md'), 'utf8'));
  for (const artifact of artifactFiles) hashFile(artifact.name, artifact.bytes);
  hashFile('guard-violations.jsonl', readFileSync(path.join(options.outputDir, 'guard-violations.jsonl'), 'utf8'));
  hashFile('worker.log', readFileSync(path.join(options.outputDir, 'worker.log'), 'utf8'));
  const manifestPath = path.join(options.outputDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    type: 'research-baseline-v1-artifact-manifest',
    note: 'sha256 of the exact final bytes of each written artifact; manifest.json excludes itself',
    files: manifestFiles.sort((a, b) => (a.path < b.path ? -1 : 1))
  }, null, 2) + '\n', 'utf8');

  if (compiled) rmSync(compiled.buildDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });

  const anyFailure =
    report.summary.structural.failed > 0 ||
    report.summary.hardFailures > 0 ||
    report.run.failures.length > 0 ||
    guardViolations !== 0;
  return {
    report,
    exitCode: anyFailure ? 1 : 0,
    outputDir: options.outputDir,
    manifestPath
  };
}

/** CLI entry point. Returns the process exit code (0 pass, 1 violation, 2 invalid usage/dataset). */
export async function runCli(argv: string[]): Promise<number> {
  let values: { dataset?: string; output?: string };
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        dataset: { type: 'string' },
        output: { type: 'string' }
      },
      allowPositionals: false,
      strict: true
    });
    values = parsed.values;
  } catch (error) {
    console.error(`eval:research: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const repoRoot = findRepoRoot();
  const datasetArg = values.dataset ?? path.join('evals', 'research-baseline-v1', 'cases.jsonl');
  const outputArg = values.output ?? path.join('_private', 'evals', 'research-baseline', 'latest');
  const datasetPath = path.resolve(repoRoot, datasetArg);
  const outputDir = path.resolve(repoRoot, outputArg);
  const datasetDisplayPath = path.relative(repoRoot, datasetPath).split(path.sep).join('/') || datasetPath;

  try {
    const { report, exitCode } = await runResearchBaseline({ datasetPath, datasetDisplayPath, outputDir, repoRoot });
    for (const entry of report.cases) {
      if (entry.structural !== 'pass') {
        console.error(`eval:research: case ${entry.caseId} failed: ${entry.failures.join('; ')}`);
      }
    }
    for (const failure of report.run.failures) {
      console.error(`eval:research: run-level failure: ${failure}`);
    }
    console.log(
      `eval:research: ${report.summary.scheduled} scheduled case(s) ` +
      `(${report.summary.caseProgress.finished} finished, ${report.summary.caseProgress.unfinished} unfinished, ${report.summary.caseProgress.notRun} not run), ` +
      `${report.summary.structural.passed} structural pass, ${report.summary.structural.failed} structural fail, ` +
      `${report.summary.hardFailures} hard failure(s)`
    );
    console.log(
      `eval:research: planner decisions ${report.summary.plannerDecisionCalls}, ` +
      `model invocations ${report.summary.modelInvocations} (receipts ${report.summary.modelReceipts}, tokens/cost ${report.summary.modelTokens}), ` +
      `network/subprocess attempts ${report.summary.networkAttempts}`
    );
    console.log(`eval:research: report written to ${path.relative(repoRoot, outputDir) || outputDir}`);
    return exitCode;
  } catch (error) {
    const message = error instanceof BaselineSchemaError ? `invalid dataset: ${error.message}` : error instanceof Error ? error.message : String(error);
    console.error(`eval:research: ${message}`);
    return 2;
  }
}

export { DATASET_VERSION };
