/**
 * Structural grading for the research-baseline-v1 replay.
 *
 * Structural pass/fail is kept strictly separate from the research state
 * distribution: a case passes when the observed controller behaviour matches
 * the frozen fixture expectations and no fixture/network violation happened.
 * The resulting research state (completed / partial / needs_input / ...) is
 * reported as a distribution and is never a quality score.
 */

import type { CaseExecution } from './case-runner.js';
import type { BaselineCase, BaselineExpect } from './schema.js';

export interface CaseGrade {
  passed: boolean;
  hardFailure: boolean;
  failures: string[];
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

function compareCounts(failures: string[], label: string, expected: number, received: number): void {
  if (expected !== received) failures.push(`${label}: expected ${expected} received ${received}`);
}

export function gradeCase(entry: BaselineCase, execution: CaseExecution, guardViolations: number): CaseGrade {
  const failures: string[] = [];
  let hardFailure = false;
  const expect: BaselineExpect = entry.expect;

  for (const violation of execution.fixtureViolations) {
    failures.push(`fixture:${violation.kind}: ${violation.message}`);
    hardFailure = true;
  }
  if (guardViolations > 0) {
    failures.push(`hard_failure:network_guard_violation: ${guardViolations} guarded network/subprocess attempt(s) were logged`);
    hardFailure = true;
  }

  if (execution.state !== expect.state) failures.push(`state: expected ${expect.state} received ${execution.state}`);
  if (execution.completion !== 'finished') {
    // Harness progress failures are hard failures: the case never completed.
    failures.push(`completion: expected finished received ${execution.completion}`);
    hardFailure = true;
  }
  if (execution.stopReason !== expect.stopReason) {
    failures.push(`stop_reason: expected ${JSON.stringify(expect.stopReason)} received ${JSON.stringify(execution.stopReason)}`);
  }

  if (expect.identityStatus !== undefined) {
    const status = execution.canonical?.identity.status;
    if (status === undefined) failures.push('identity_status: canonical output missing');
    else if (status !== expect.identityStatus) failures.push(`identity_status: expected ${expect.identityStatus} received ${status}`);
  }

  compareCounts(failures, 'tool_calls', expect.toolCalls, execution.counts.toolCalls);
  compareCounts(failures, 'planner_calls', expect.plannerCalls, execution.counts.plannerDecisionCalls);
  // expect.modelCalls counts actual model gateway invocations of THIS execution
  // (zero for scripted decisions); ledger receipts are reported separately.
  compareCounts(failures, 'model_calls', expect.modelCalls, execution.counts.modelInvocations);

  const receipts = receiptsSummary(execution);
  for (const key of ['total', 'completed', 'failed', 'inflight'] as const) {
    compareCounts(failures, `receipts.${key}`, expect.receipts[key], receipts[key]);
  }

  const unknownCost = execution.budget?.unknownCost ?? false;
  if (unknownCost !== expect.unknownCost) failures.push(`unknown_cost: expected ${expect.unknownCost} received ${unknownCost}`);

  if (expect.claimsRetained !== undefined) {
    const retained = execution.result?.observations.length;
    if (retained === undefined) failures.push('claims_retained: result missing');
    else compareCounts(failures, 'claims_retained', expect.claimsRetained, retained);
  }

  if (expect.candidates !== undefined) {
    const candidates = execution.canonical?.identity.candidates.length;
    if (candidates === undefined) failures.push('candidates: canonical output missing');
    else compareCounts(failures, 'candidates', expect.candidates, candidates);
  }

  // include_text / exclude_text match the canonical OUTPUT as a whole: the
  // Markdown export or the canonical JSON view. Pure renderer escaping (e.g.
  // Markdown `\_`) does not count as absence; exclude_text must be absent from
  // both. Documented in evals/research-baseline-v1/CONTRACT.md.
  const canonicalText = `${execution.markdown ?? ''}\n${execution.canonicalJson ?? (execution.canonical ? JSON.stringify(execution.canonical) : '')}`;
  for (const text of expect.includeText ?? []) {
    if (!canonicalText.includes(text)) failures.push(`include_text: ${JSON.stringify(text)} missing from canonical output`);
  }
  for (const text of expect.excludeText ?? []) {
    if (canonicalText.includes(text)) failures.push(`exclude_text: ${JSON.stringify(text)} unexpectedly present in canonical output`);
  }

  for (const claimExpectation of expect.claimKinds ?? []) {
    const observations = execution.result?.observations ?? [];
    const matches = observations.filter((observation) => observation.statement.includes(claimExpectation.contains));
    if (matches.length === 0) {
      failures.push(`claim_kinds: no retained claim contains ${JSON.stringify(claimExpectation.contains)}`);
      continue;
    }
    for (const match of matches) {
      if (match.kind !== claimExpectation.kind) {
        failures.push(`claim_kinds: claim containing ${JSON.stringify(claimExpectation.contains)} has kind ${match.kind} expected ${claimExpectation.kind}`);
      }
    }
  }

  if (expect.runnerError !== undefined) {
    const name = execution.error?.name;
    if (name !== expect.runnerError) failures.push(`runner_error: expected ${expect.runnerError} received ${name ?? 'no error'}`);
  }
  for (const fragment of expect.runnerErrorIncludes ?? []) {
    if (!execution.error?.message.includes(fragment)) {
      failures.push(`runner_error_includes: ${JSON.stringify(fragment)} missing from the retained error`);
    }
  }

  if (execution.error) {
    const expectedName = expect.state === 'runner_error' ? expect.runnerError : expect.state === 'needs_input' ? 'NeedsInputError' : null;
    if (expectedName === null) {
      failures.push(`unexpected_execution_error: ${execution.error.name}: ${execution.error.message}`);
      hardFailure = true;
    } else if (execution.error.name !== expectedName) {
      failures.push(`unexpected_execution_error: ${execution.error.name} does not match expected ${expectedName}`);
      hardFailure = true;
    }
  }

  return { passed: failures.length === 0, hardFailure, failures };
}
