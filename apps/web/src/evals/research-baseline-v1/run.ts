/**
 * CLI entry for versioned offline controller replay (current default: v2).
 *
 * Usage (from the repository root):
 *   npm --prefix apps/web run eval:research
 *   npm --prefix apps/web run eval:research -- --dataset evals/research-baseline-v2/cases.jsonl \
 *     --output _private/evals/research-baseline-v2/latest
 */

import { runCli } from './runner.js';

process.exitCode = await runCli(process.argv.slice(2));
