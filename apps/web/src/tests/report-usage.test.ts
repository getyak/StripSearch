import test from 'node:test';
import { crashRecord } from '../evals/research-baseline-v1/case-runner.js';
import { parseDataset } from '../evals/research-baseline-v1/schema.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, renderMarkdown, verifyReportConsistency, type BaselineReport, type BaselineCaseReport } from '../evals/research-baseline-v1/report.js';

// Frozen synthetic data only: no controller, database, provider or network runs.
const baseline = JSON.parse(readFileSync(new URL('../../../../evals/research-baseline-v1/evidence/report.json', import.meta.url), 'utf8')) as BaselineReport;
function finished(): BaselineCaseReport {
  return structuredClone(baseline.cases.find(entry => entry.caseId === 'rb-001')!);
}
function missing(completion: 'unfinished' | 'not_run'): BaselineCaseReport {
  const entry = finished();
  entry.caseId = completion;
  entry.actual.state = 'runner_error';
  entry.actual.completion = completion;
  entry.actual.counts = { toolCalls: 0, plannerDecisionCalls: 0, modelInvocations: 0, modelReceipts: 0, fixtureProviderCalls: 0 };
  entry.actual.receipts = { total: 0, completed: 0, failed: 0, inflight: 0 };
  entry.actual.fixtureUsage = { measurement: 'simulated', knownSimulatedSubtotal: null, simulatedTotal: null, unknownFeeReceipts: 0, bytes: 0 };
  entry.structural = 'fail';
  entry.hardFailure = true;
  entry.failures = [`completion: ${completion}`];
  return entry;
}

test('lost usage after a started case keeps counts as lower bounds and total unknown', () => {
  const good = finished();
  const report = buildReport([good, missing('unfinished'), missing('not_run')], baseline);
  assert.deepEqual(report.summary.caseProgress, { started: 2, finished: 1, unfinished: 1, notRun: 1 });
  assert.equal(report.summary.passRate.denominator, 3);
  assert.equal(report.summary.unknownUsageCases, 1);
  assert.equal(report.summary.observedCountsMeasurement, 'lower_bound');
  assert.equal(report.summary.fixtureProviderCalls, good.actual.counts.fixtureProviderCalls);
  assert.equal(report.summary.fixtureFees.knownSimulatedSubtotal, good.actual.fixtureUsage.knownSimulatedSubtotal);
  assert.equal(report.summary.fixtureFees.simulatedTotal, null);
  assert.equal(report.summary.fixtureFees.casesWithUnknownFee, 0, 'missing usage is separate from an observed unknown-fee receipt');
  assert.deepEqual(verifyReportConsistency(report), []);
  assert.match(renderMarkdown(report), /lower_bound/);
  assert.match(renderMarkdown(report), /用量记录缺失案例：1/);
});

test('never-started cases do not invent unknown usage; completed observation remains exact', () => {
  const good = finished();
  for (const entries of [[good], [good, missing('not_run')]]) {
    const report = buildReport(entries, baseline);
    assert.equal(report.summary.unknownUsageCases, 0);
    assert.equal(report.summary.observedCountsMeasurement, 'exact');
    assert.equal(report.summary.fixtureFees.simulatedTotal, good.actual.fixtureUsage.simulatedTotal);
    assert.deepEqual(verifyReportConsistency(report), []);
    assert.match(renderMarkdown(report), /`exact`/);
  }
});

test('fully observed failed requests retain unknown fees without downgrading count precision', () => {
  const failure = structuredClone(baseline.cases.find(entry => entry.caseId === 'rb-007')!);
  const report = buildReport([failure], baseline);
  assert.equal(report.summary.unknownUsageCases, 0);
  assert.equal(report.summary.observedCountsMeasurement, 'exact');
  assert.equal(report.summary.fixtureFees.casesWithUnknownFee, 1);
  assert.equal(report.summary.fixtureFees.simulatedTotal, null);
  assert.deepEqual(verifyReportConsistency(report), []);
});

test('consistency derives missing usage from cases, not potentially tampered summary flags', () => {
  const report = buildReport([finished(), missing('unfinished')], baseline);
  report.summary.unknownUsageCases = 0;
  report.summary.observedCountsMeasurement = 'exact';
  report.summary.fixtureFees.simulatedTotal = report.summary.fixtureFees.knownSimulatedSubtotal;
  const failures = verifyReportConsistency(report);
  assert.ok(failures.some(value => value.includes('unknownUsageCases')));
  assert.ok(failures.some(value => value.includes('observedCountsMeasurement')));
  assert.ok(failures.some(value => value.includes('simulatedTotal')));
});

// The worker also makes a crash record if receipt collection itself throws.
test('unexpected case exceptions cannot certify finished usage with placeholder zeroes', () => {
  const cases = parseDataset(readFileSync(new URL('../../../../evals/research-baseline-v1/cases.jsonl', import.meta.url), 'utf8'));
  const crash = crashRecord(cases[0]!, new Error('receipt collection failed'), 1);
  assert.equal(crash.completion, 'unfinished');
  assert.equal(crash.receipts, null);
  const entry = missing('unfinished');
  entry.actual.completion = crash.completion;
  entry.actual.counts = crash.counts;
  entry.actual.fixtureUsage = crash.fixtureUsage;
  const report = buildReport([finished(), entry], baseline);
  assert.equal(report.summary.unknownUsageCases, 1);
  assert.equal(report.summary.observedCountsMeasurement, 'lower_bound');
  assert.equal(report.summary.fixtureFees.simulatedTotal, null);
});
