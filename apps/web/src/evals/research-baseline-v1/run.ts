/**
 * CLI entry for the research-baseline-v1 offline controller replay.
 *
 * Usage (from the repository root):
 *   npm --prefix apps/web run eval:research
 *   npm --prefix apps/web run eval:research -- --dataset evals/research-baseline-v1/cases.jsonl \
 *     --output evals/research-baseline-v1/evidence
 */

import { runCli } from './runner.js';

process.exitCode = await runCli(process.argv.slice(2));
