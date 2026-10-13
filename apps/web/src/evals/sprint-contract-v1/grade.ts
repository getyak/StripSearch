import { isDeepStrictEqual } from 'node:util';
import type { ContractCase, Dataset } from './schema.js';
import { executeCase, type CaseExecution } from './case-runner.js';

export interface Failure { path: string; expected: unknown; actual: unknown; message: string }
export interface CaseResult {
  id: string; boundary: string; kind: ContractCase['kind']; status: 'pass' | 'fail';
  expected: ContractCase['expected']; actual: Record<string, unknown> | null;
  evidence: unknown[]; failures: Failure[];
}
export function gradeCase(entry: ContractCase, actual: CaseExecution): CaseResult {
  const failures: Failure[] = [];
  for (const [path, expected] of Object.entries(entry.expected)) {
    const observed = path === 'reasonIncludes' ? actual.observed.reason : actual.observed[path];
    const matches = path === 'reasonIncludes' && typeof expected === 'string'
      ? typeof observed === 'string' && observed.includes(expected)
      : isDeepStrictEqual(observed, expected);
    if (!matches) failures.push({ path, expected, actual: observed ?? null, message: 'production result differs from independent specification' });
  }
  // An unrequested local write is always a hard failure, even if the envelope
  // says it was not staged after a port error.
  if (entry.kind === 'dispatch' && actual.observed.submissionCalls !== 0) failures.push({ path: 'submissionCalls', expected: 0, actual: actual.observed.submissionCalls, message: 'forbidden submission reached' });
  return { id: entry.id, boundary: entry.boundary, kind: entry.kind, status: failures.length ? 'fail' : 'pass',
    expected: entry.expected, actual: actual.observed, evidence: actual.evidence, failures };
}
export async function replay(dataset: Dataset, execute: (entry: ContractCase) => Promise<CaseExecution> = executeCase) {
  const cases: CaseResult[] = [];
  for (const entry of dataset.cases) {
    try { cases.push(gradeCase(entry, await execute(entry))); }
    catch (error) {
      cases.push({ id: entry.id, boundary: entry.boundary, kind: entry.kind, status: 'fail', expected: entry.expected, actual: null, evidence: [],
        failures: [{ path: 'execution', expected: 'completed production execution', actual: null, message: error instanceof Error ? error.message : String(error) }] });
    }
  }
  const failed = cases.filter((entry) => entry.status === 'fail').length;
  return { suite: dataset.suite, track: dataset.track, material: dataset.material, reviewStatus: dataset.reviewStatus,
    qualityClaim: false, networkAccess: false, total: cases.length, passed: cases.length - failed, failed, cases };
}
