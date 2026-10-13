import { readFileSync, writeFileSync } from 'node:fs';
import { parseDataset } from './schema.js';
import { replay } from './grade.js';
const guard = (globalThis as typeof globalThis & {
  __stripsearchSprintGuard?: { installed: boolean; violations: unknown[]; guardedApis: string[] }
}).__stripsearchSprintGuard;
if (!guard?.installed) throw new Error('contract replay requires its preloaded network guard');
const datasetPath = process.argv[2], reportPath = process.argv[3];
if (!datasetPath || !reportPath) throw new Error('worker needs dataset and report paths');
try {
  const dataset = parseDataset(JSON.parse(readFileSync(datasetPath, 'utf8')));
  const report = await replay(dataset);
  writeFileSync(reportPath, JSON.stringify({ ...report, guard: { mechanism: 'process_api_guard', violations: guard.violations, guardedApis: guard.guardedApis } }, null, 2) + '\n');
  process.exitCode = report.failed || guard.violations.length ? 1 : 0;
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ suite: 'sprint-contract-v1', status: 'invalid_dataset', cases: [],
    error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  process.exitCode = 2;
}
