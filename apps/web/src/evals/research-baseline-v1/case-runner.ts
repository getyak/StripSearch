/**
 * Executes one baseline case against the production research loop.
 *
 * The real `runResearch` controller and the real `Store` are used on the SAME
 * run: checkpoints, action receipts and budget all belong to the run being
 * executed, and the canonical output is exported from that run. The
 * `persistResult` helper of the runtime-v1 evaluator is deliberately NOT used
 * here because it would write the outcome into a different run than the ledger.
 *
 * No provider transport, no API key and no model gateway is supplied: the only
 * tools are the injected scripted fixtures, so no DSH, model or live provider
 * request can be made. All elapsed timings are monotonic (performance.now).
 */

import { performance } from 'node:perf_hooks';

import { runResearch } from '../../server/research/controller.js';
import { RESEARCH_LIMITS } from '../../server/research/research-store.js';
import type { ActionReceipt, ResearchCheckpoint } from '../../server/research/research-store.js';
import { nowIso, type RunRecord, type Store } from '../../server/store.js';
import type {
  CanonicalView,
  IdentityCandidate,
  ProviderResult,
  ResearchBudget,
  ResearchBudgetLimits
} from '../../shared/types.js';
import { NeedsInputError } from '../../shared/types.js';
import { closeEvalStore, exportCanonical, openEvalStore } from '../canonical-store.js';
import { ScriptedResearchPlanner, ScriptedResearchTools, type FixtureViolation } from './fixtures.js';
import type { BaselineCase, BaselineState } from './schema.js';

export interface CaseError {
  name: string;
  message: string;
  stack: string | null;
}

/**
 * Harness progress through case execution, separate from the research state:
 * finished = ran to completion, unfinished = the process died mid-case,
 * not_run = the case never started.
 */
export type CaseCompletion = 'finished' | 'unfinished' | 'not_run';

export interface CaseCounts {
  toolCalls: number;
  plannerDecisionCalls: number;
  /** Actual model gateway invocations performed by THIS execution. */
  modelInvocations: number;
  /** Model-kind receipts found in the same-run ledger (may include historical attempts). */
  modelReceipts: number;
  fixtureProviderCalls: number;
}

export interface CaseFixtureUsage {
  measurement: 'simulated';
  /** Sum of fixture-declared fees that are known; null when none are known. */
  knownSimulatedSubtotal: number | null;
  /** Complete simulated total; null whenever any fee is unknown (never a misleading number). */
  simulatedTotal: number | null;
  unknownFeeReceipts: number;
  bytes: number;
}

export interface CaseExecution {
  caseId: string;
  scenario: string;
  completion: CaseCompletion;
  monotonicElapsedMs: number;
  state: BaselineState;
  stopReason: string | null;
  error: CaseError | null;
  runId: string | null;
  result: ProviderResult | null;
  checkpoint: ResearchCheckpoint | null;
  receipts: ActionReceipt[] | null;
  budget: ResearchBudget | null;
  canonical: CanonicalView | null;
  markdown: string | null;
  canonicalJson: string | null;
  counts: CaseCounts;
  fixtureUsage: CaseFixtureUsage;
  fixtureViolations: FixtureViolation[];
}

function errorRecord(error: unknown): CaseError {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : null
  };
}

export function limitsFor(entry: BaselineCase): ResearchBudgetLimits {
  return { ...RESEARCH_LIMITS, ...(entry.limits ?? {}) };
}

/**
 * Persist a controller result onto the same run that produced it, mirroring the
 * production service writes (identity / answer / limitations / usage / state).
 */
function persistResultOnRun(store: Store, run: RunRecord, result: ProviderResult, elapsedMs: number): RunRecord {
  store.replaceSources(run.id, result.sources);
  store.clearObservations(run.id);
  result.observations.forEach((observation, index) => {
    store.addObservation(run.id, observation, index);
    store.addEvent(run.id, 'observation', {
      statement: observation.statement,
      kind: observation.kind,
      sourceKeys: observation.sourceKeys
    });
  });
  const current = store.getRun(run.id);
  const changes = store.updateRunIfActive(run.id, {
    identity_json: JSON.stringify(result.identity),
    answer_json: JSON.stringify(result.answer),
    limitations_json: JSON.stringify(result.limitations),
    usage_json: JSON.stringify({
      provider: 'research',
      requests: result.usage.requests,
      bytes: result.usage.bytes,
      elapsedMs,
      measurement: 'observed'
    }),
    state: result.state,
    stop_reason: result.stopReason,
    revision: (current?.revision ?? run.revision) + 1,
    finished_at: nowIso()
  });
  if (changes === 0) throw new Error(`run ${run.id} became unwritable while persisting the replay result`);
  store.addEvent(run.id, 'answer', { sections: result.answer });
  store.addEvent(run.id, 'state', { state: result.state, stopReason: result.stopReason });
  const updated = store.getRun(run.id);
  if (!updated) throw new Error(`run ${run.id} disappeared while persisting the replay result`);
  return updated;
}

/** Mirror the production failure path that turns a confirmation request into a durable run state. */
function persistNeedsInput(store: Store, run: RunRecord, error: NeedsInputError): RunRecord {
  const updated = store.getRun(run.id);
  const revision = (updated?.revision ?? run.revision) + 1;
  const candidates: IdentityCandidate[] = error.candidates;
  store.updateRunIfActive(run.id, {
    state: 'needs_input',
    revision,
    identity_json: JSON.stringify({
      displayName: '',
      handle: null,
      profileUrl: null,
      status: 'needs_input',
      note: error.prompt,
      candidates
    }),
    error_code: null,
    error_message: null
  });
  store.addEvent(run.id, 'needs_input', { prompt: error.prompt, revision, candidates });
  store.addEvent(run.id, 'state', { state: 'needs_input' });
  const record = store.getRun(run.id);
  if (!record) throw new Error(`run ${run.id} disappeared while persisting needs_input`);
  return record;
}

export function summarizeFixtureUsage(receipts: readonly ActionReceipt[]): CaseFixtureUsage {
  let knownSimulatedSubtotal: number | null = null;
  let unknownFeeReceipts = 0;
  let bytes = 0;
  for (const receipt of receipts) {
    const usage = receipt.usage;
    if (!usage || usage.estimatedUsd === null || usage.estimatedUsd === undefined || usage.unknownCost) {
      unknownFeeReceipts += 1;
    } else {
      knownSimulatedSubtotal = (knownSimulatedSubtotal ?? 0) + usage.estimatedUsd;
    }
    bytes += usage?.bytes ?? 0;
  }
  return {
    measurement: 'simulated',
    knownSimulatedSubtotal,
    // A total that ignores unknown fees would be misleading; keep it unknown.
    simulatedTotal: unknownFeeReceipts > 0 ? null : knownSimulatedSubtotal,
    unknownFeeReceipts,
    bytes
  };
}

export async function executeCase(entry: BaselineCase): Promise<CaseExecution> {
  const started = performance.now();
  const evalStore = openEvalStore();
  const { store } = evalStore;
  const tools = new ScriptedResearchTools(entry.tools);
  const planner = new ScriptedResearchPlanner(entry.planner);
  const limits = limitsFor(entry);
  let run: RunRecord | null = null;
  let result: ProviderResult | null = null;
  let error: CaseError | null = null;
  let state: BaselineState = 'runner_error';
  try {
    run = store.insertRun({
      ownerId: 'eval-research-baseline',
      question: entry.input.question,
      seedUrl: entry.input.seedUrl,
      provider: 'research',
      parentRunId: null,
      retryOf: null,
      followup: false,
      idempotencyKey: null,
      bodyFingerprint: 'research-baseline-v1'
    });
    if (entry.preState?.inflightReceipts) {
      for (const receipt of entry.preState.inflightReceipts) {
        store.research.reserve(run.id, receipt.key, receipt.kind, receipt.request, { inputTokens: 0, outputTokens: 0 }, limits);
      }
    }
    if (entry.preState?.cancelRequested) {
      store.requestCancel(run.id);
    } else {
      store.updateRunIfActive(run.id, { state: 'researching', started_at: nowIso() });
      store.addEvent(run.id, 'state', { state: 'researching' });
    }
    run = store.getRun(run.id) ?? run;
    try {
      result = await runResearch({
        store,
        run,
        tools,
        planner,
        signal: new AbortController().signal,
        limits,
        transport: undefined,
        deepseekApiKey: null,
        socialAvailable: false,
        firecrawlAvailable: false
      });
      state = result.state;
      run = persistResultOnRun(store, run, result, Math.round(performance.now() - started));
    } catch (thrown) {
      if (thrown instanceof NeedsInputError) {
        state = 'needs_input';
        run = persistNeedsInput(store, run, thrown);
        error = errorRecord(thrown);
      } else {
        // The controller rethrows run-level errors (for example a cancelled
        // run). The runner must retain the error and keep going.
        state = 'runner_error';
        error = errorRecord(thrown);
      }
    }
  } catch (thrown) {
    error = errorRecord(thrown);
    state = 'runner_error';
  }

  const receipts = run ? store.research.receipts(run.id) : [];
  const budget = run ? store.research.budget(run.id, limits) : null;
  const checkpoint = run ? store.research.checkpoint(run.id) : null;
  let canonical: CanonicalView | null = null;
  let markdown: string | null = null;
  let canonicalJson: string | null = null;
  if (run) {
    try {
      const exported = exportCanonical(store, run);
      canonical = exported.view;
      markdown = exported.markdown;
      canonicalJson = exported.json;
    } catch (exportError) {
      error = error ?? errorRecord(exportError);
    }
  }

  const counts: CaseCounts = {
    toolCalls: tools.calls.length,
    plannerDecisionCalls: planner.calls.length,
    modelInvocations: planner.invokeCalls,
    modelReceipts: receipts.filter((receipt) => receipt.kind === 'model').length,
    fixtureProviderCalls: tools.calls.length
  };
  const fixtureViolations = [...tools.finishScript(), ...planner.finishScript()];
  closeEvalStore(evalStore);
  return {
    caseId: entry.caseId,
    scenario: entry.scenario,
    completion: 'finished',
    monotonicElapsedMs: performance.now() - started,
    state,
    stopReason: result?.stopReason ?? run?.stopReason ?? null,
    error,
    runId: run?.id ?? null,
    result,
    checkpoint,
    receipts,
    budget,
    canonical,
    markdown,
    canonicalJson,
    counts,
    fixtureUsage: summarizeFixtureUsage(receipts),
    fixtureViolations
  };
}

/** A crash record retains the error, but cannot certify completion or usage. */
export function crashRecord(entry: BaselineCase, thrown: unknown, monotonicElapsedMs: number, completion: CaseCompletion = 'unfinished'): CaseExecution {
  return {
    caseId: entry.caseId,
    scenario: entry.scenario,
    completion,
    monotonicElapsedMs,
    state: 'runner_error',
    stopReason: null,
    error: errorRecord(thrown),
    runId: null,
    result: null,
    checkpoint: null,
    receipts: null,
    budget: null,
    canonical: null,
    markdown: null,
    canonicalJson: null,
    counts: { toolCalls: 0, plannerDecisionCalls: 0, modelInvocations: 0, modelReceipts: 0, fixtureProviderCalls: 0 },
    fixtureUsage: { measurement: 'simulated', knownSimulatedSubtotal: null, simulatedTotal: null, unknownFeeReceipts: 0, bytes: 0 },
    fixtureViolations: []
  };
}
