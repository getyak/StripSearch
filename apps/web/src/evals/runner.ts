/**
 * Runtime evaluation v1 orchestrator.
 *
 * Loads a frozen JSONL dataset, drives the real production GitHub / Exa
 * adapters through an in-memory replay transport, grades every case
 * independently, persists results through the real Store and writes JSON and
 * Markdown reports. There is no model judge, no paid call and no outbound
 * network: a global fetch guard turns any non-fixture request into a hard
 * failure for the case that triggered it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { findRepoRoot, gitInfo, parseEvalCliArgs, safeFilename } from './shared/cli.js';

export { findRepoRoot };

import { createExaProvider } from '../server/adapters/exa.js';
import { githubProvider } from '../server/adapters/github.js';
import { ProviderError } from '../server/adapters/types.js';
import type { ProviderContext, ProviderReporter, ResearchProvider } from '../server/adapters/types.js';
import { LIMITS } from '../shared/limits.js';
import { NeedsInputError } from '../shared/types.js';
import type { ProviderName, ProviderResult, RunInput, SourceDraft } from '../shared/types.js';
import { screenQuestion } from '../shared/validation.js';

import {
  closeEvalStore,
  exportCanonical,
  openEvalStore,
  persistResult,
  roundTripFailures
} from './canonical-store.js';
import { FixtureTransport } from './fixture-transport.js';
import { gradeCase } from './grade.js';
import type { CaseActual } from './grade.js';
import { buildReport, renderReportMarkdown, verifyReportConsistency } from './report.js';
import type { CaseResult, EvalReport } from './report.js';
import { runRevocationCheck } from './revocation.js';
import { parseDataset, EvalSchemaError } from './schema.js';
import type { EvalCase, EvalSplit } from './schema.js';

/** A synthetic, non-secret key used only so the Exa adapter can be exercised. */
const EVAL_FIXTURE_EXA_KEY = 'eval-fixture-exa-key';

export class EvalRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalRunError';
  }
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

/**
 * Replace global fetch for the duration of one case. The production adapters
 * never use it (they receive FixtureTransport), so any hit is a non-fixture
 * outbound attempt and is recorded as a hard failure.
 */
async function withNetworkGuard<T>(fn: (networkAttempts: string[]) => Promise<T>): Promise<T> {
  const attempts: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown): never => {
    const url = requestUrl(input);
    attempts.push(url);
    throw new Error(`offline evaluation blocked a non-fixture network request to ${url}`);
  }) as typeof fetch;
  try {
    return await fn(attempts);
  } finally {
    globalThis.fetch = original;
  }
}

function makeReporter(stages: unknown[], sources: SourceDraft[]): ProviderReporter {
  return {
    stage: (index, total, key, label, status, detail) => {
      stages.push({ index, total, key, label, status, detail: detail ?? null });
    },
    source: (draft) => {
      sources.push(draft);
    }
  };
}

async function executeScopeCase(evalCase: EvalCase): Promise<CaseResult> {
  return withNetworkGuard(async (networkAttempts) => {
    const screen = screenQuestion(evalCase.input.question, evalCase.input.seedUrl ?? '');
    const actual: CaseActual = {
      state: screen.disallowed ? 'disallowed' : 'allowed',
      errorCode: null,
      result: null,
      canonical: null,
      markdown: null,
      scopeDisallowed: screen.disallowed,
      scopeReason: screen.reason,
      calls: [],
      violations: [],
      unconsumedReplay: 0,
      networkAttempts,
      revocation: null,
      roundTripFailures: [],
      providerCalls: 0
    };
    return { case: evalCase, actual, grade: gradeCase(evalCase, actual), canonical: null, markdown: null, canonicalJson: null };
  });
}

async function executeProviderCase(evalCase: EvalCase, store: ReturnType<typeof openEvalStore>['store']): Promise<CaseResult> {
  return withNetworkGuard(async (networkAttempts) => {
    const providerName = evalCase.input.provider as ProviderName;
    const fixtureExaKey = evalCase.config.exa_configured === false ? null : EVAL_FIXTURE_EXA_KEY;
    const provider: ResearchProvider = providerName === 'exa' ? createExaProvider(fixtureExaKey) : githubProvider;
    const transport = new FixtureTransport(evalCase.replay);
    const controller = new AbortController();
    const stages: unknown[] = [];
    const reportedSources: SourceDraft[] = [];
    const context: ProviderContext = {
      transport,
      signal: controller.signal,
      report: makeReporter(stages, reportedSources),
      githubToken: null,
      exaApiKey: providerName === 'exa' ? fixtureExaKey : null,
      timeoutMs: evalCase.config.timeout_ms ?? LIMITS.providerTimeoutMs,
      maxBytes: evalCase.config.max_bytes ?? LIMITS.providerMaxBytes
    };
    const runInput: RunInput = {
      question: evalCase.input.question,
      seedUrl: evalCase.input.seedUrl,
      provider: providerName
    };

    let state: CaseActual['state'] = 'failed';
    let errorCode: string | null = null;
    let result: ProviderResult | null = null;
    try {
      result = await provider.run(runInput, context);
      state = result.state;
    } catch (error) {
      if (error instanceof NeedsInputError) {
        state = 'needs_input';
      } else if (error instanceof ProviderError) {
        state = 'failed';
        errorCode = error.code;
      } else {
        state = 'failed';
        errorCode = 'internal_error';
      }
    }

    let canonical: CaseResult['canonical'] = null;
    let markdown: string | null = null;
    let canonicalJson: string | null = null;
    let revocation: CaseActual['revocation'] = null;
    const roundTrip: string[] = [];

    if (result) {
      try {
        const run = persistResult(store, result, {
          question: evalCase.input.question,
          seedUrl: evalCase.input.seedUrl,
          provider: providerName
        });
        const exported = exportCanonical(store, run);
        canonical = exported.view;
        markdown = exported.markdown;
        canonicalJson = exported.json;
        roundTrip.push(...roundTripFailures(result, exported.view));
        if (evalCase.check_revocation) {
          revocation = runRevocationCheck(store, run, result);
        }
      } catch (error) {
        roundTrip.push(`persistence: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const actual: CaseActual = {
      state,
      errorCode,
      result,
      canonical,
      markdown,
      scopeDisallowed: null,
      scopeReason: null,
      calls: transport.calls,
      violations: transport.violations,
      unconsumedReplay: transport.remaining,
      networkAttempts,
      revocation,
      roundTripFailures: roundTrip,
      providerCalls: transport.calls.length
    };
    return { case: evalCase, actual, grade: gradeCase(evalCase, actual), canonical, markdown, canonicalJson };
  });
}

function crashResult(evalCase: EvalCase, error: unknown): CaseResult {
  const message = error instanceof Error ? error.message : String(error);
  const actual: CaseActual = {
    state: 'failed',
    errorCode: 'evals_runner_crash',
    result: null,
    canonical: null,
    markdown: null,
    scopeDisallowed: null,
    scopeReason: null,
    calls: [],
    violations: [],
    unconsumedReplay: 0,
    networkAttempts: [],
    revocation: null,
    roundTripFailures: [],
    providerCalls: 0
  };
  return {
    case: evalCase,
    actual,
    grade: { passed: false, hardFailure: true, failures: [`runner_crash: ${message}`] },
    canonical: null,
    markdown: null,
    canonicalJson: null
  };
}

export interface RunEvalOptions {
  datasetPath: string;
  datasetDisplayPath: string;
  outputDir: string;
  split?: EvalSplit;
  repoRoot: string;
}

export interface RunEvalResult {
  report: EvalReport;
  exitCode: number;
  outputDir: string;
}

function writeArtifacts(outputDir: string, results: CaseResult[], report: EvalReport): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(outputDir, 'report.md'), renderReportMarkdown(report), 'utf8');
  const casesDir = path.join(outputDir, 'cases');
  rmSync(casesDir, { recursive: true, force: true });
  mkdirSync(casesDir, { recursive: true });
  for (const result of results) {
    if (result.canonicalJson !== null && result.markdown !== null) {
      const name = safeFilename(result.case.case_id);
      writeFileSync(path.join(casesDir, `${name}.json`), result.canonicalJson, 'utf8');
      writeFileSync(path.join(casesDir, `${name}.md`), result.markdown, 'utf8');
    }
  }
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const startedAt = Date.now();
  const datasetBytes = readFileSync(options.datasetPath);
  const datasetText = datasetBytes.toString('utf8');
  const datasetSha256 = createHash('sha256').update(datasetBytes).digest('hex');
  const allCases = parseDataset(datasetText);
  const cases = options.split ? allCases.filter((entry) => entry.split === options.split) : allCases;
  if (cases.length === 0) {
    throw new EvalRunError(`no cases match split "${options.split}" in ${options.datasetDisplayPath}`);
  }

  const evalStore = openEvalStore();
  const results: CaseResult[] = [];
  try {
    for (const evalCase of cases) {
      try {
        results.push(evalCase.mode === 'scope' ? await executeScopeCase(evalCase) : await executeProviderCase(evalCase, evalStore.store));
      } catch (error) {
        results.push(crashResult(evalCase, error));
      }
    }
  } finally {
    closeEvalStore(evalStore);
  }

  const report = buildReport(results, {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    source: {
      datasetPath: options.datasetDisplayPath,
      datasetSha256,
      splitFilter: options.split ?? null,
      ...gitInfo(options.repoRoot),
      nodeVersion: process.version
    }
  });

  const consistency = verifyReportConsistency(report);
  if (consistency.length > 0) {
    throw new EvalRunError(`internal report inconsistency: ${consistency.join('; ')}`);
  }

  writeArtifacts(options.outputDir, results, report);
  const exitCode = report.summary.failed === 0 && report.summary.hardFailures === 0 ? 0 : 1;
  return { report, exitCode, outputDir: options.outputDir };
}

/** CLI entry point. Returns the process exit code (0 pass, 1 case failure, 2 invalid usage/dataset). */
export async function runCli(argv: string[]): Promise<number> {
  const parsedArgs = parseEvalCliArgs<{ dataset?: string; output?: string; split?: string }>(
    argv,
    { dataset: { type: 'string' }, output: { type: 'string' }, split: { type: 'string' } },
    'eval'
  );
  if (!parsedArgs.ok) return 2;
  const values = parsedArgs.values;

  const splitRaw = values.split;
  if (splitRaw !== undefined && splitRaw !== 'discovery' && splitRaw !== 'regression') {
    console.error(`eval: --split must be "discovery" or "regression", received "${splitRaw}"`);
    return 2;
  }
  const split: EvalSplit | undefined = splitRaw;

  const repoRoot = findRepoRoot();
  const datasetArg = values.dataset ?? path.join('evals', 'runtime-v1', 'cases.jsonl');
  const outputArg = values.output ?? path.join('_private', 'evals', 'latest');
  const datasetPath = path.resolve(repoRoot, datasetArg);
  const outputDir = path.resolve(repoRoot, outputArg);
  const datasetDisplayPath = path.relative(repoRoot, datasetPath) || datasetPath;

  try {
    const { report, exitCode } = await runEval({ datasetPath, datasetDisplayPath, outputDir, split, repoRoot });
    for (const entry of report.cases) {
      if (!entry.passed) {
        console.error(`eval: case ${entry.caseId} failed: ${entry.failures.join('; ')}`);
      }
    }
    console.log(
      `eval: ${report.summary.started} case(s), ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.hardFailures} hard failure(s)`
    );
    console.log(`eval: model calls ${report.summary.modelCalls}, network calls ${report.summary.networkCalls}`);
    console.log(`eval: report written to ${path.relative(repoRoot, outputDir) || outputDir}`);
    return exitCode;
  } catch (error) {
    const message = error instanceof EvalSchemaError ? `invalid dataset: ${error.message}` : error instanceof Error ? error.message : String(error);
    console.error(`eval: ${message}`);
    return 2;
  }
}
