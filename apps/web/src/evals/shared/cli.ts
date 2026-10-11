/**
 * Shared eval CLI / repository-metadata scaffolding for BOTH frozen replay
 * toolchains (`evals/runner.ts` and `evals/research-baseline-v1/runner.ts`).
 *
 * Only the identical plumbing lives here: repo-root discovery, git metadata,
 * artifact filenames and CLI flag parsing. Dataset shapes, grading, report
 * rendering, exit-code semantics and output paths stay per-baseline on
 * purpose (docs/code-maintenance.md).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

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

/** Commit identity of the replayed tree; nulls when git is unavailable. */
export function gitInfo(repoRoot: string): { commit: string | null; dirty: boolean | null; dirtyPaths: number | null } {
  try {
    const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
    const dirtyPaths = status.split('\n').filter((line) => line.trim().length > 0).length;
    return { commit, dirty: dirtyPaths > 0, dirtyPaths };
  } catch {
    return { commit: null, dirty: null, dirtyPaths: null };
  }
}

/** Artifact-safe case file name (everything outside [A-Za-z0-9._-] → _). */
export function safeFilename(caseId: string): string {
  return caseId.replace(/[^A-Za-z0-9._-]/g, '_');
}

export type EvalCliParseResult<T> = { ok: true; values: T } | { ok: false };

/**
 * Strict flag parsing with no positionals; parse failures print
 * `${label}: <message>` and report `{ ok: false }` so each CLI keeps its own
 * exit code and usage semantics.
 */
export function parseEvalCliArgs<T>(
  argv: string[],
  options: NonNullable<ParseArgsConfig['options']>,
  label: string
): EvalCliParseResult<T> {
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: false, strict: true });
    return { ok: true, values: parsed.values as T };
  } catch (error) {
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }
}
