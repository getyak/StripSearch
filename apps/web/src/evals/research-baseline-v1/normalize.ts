/**
 * Deterministic hashing for the research-baseline-v1 replay.
 *
 * The normalized result hash is stable across replays: volatile fields (run and
 * owner identifiers, timestamps, durations) are replaced with explicit
 * placeholders before hashing. No structural dependency is erased: for example
 * `inheritedFrom` keeps its `sourceKey` and keeps the difference between null
 * and an existing dependency, only its `runId` normalizes. Serialized
 * subobject hashes and final artifact file hashes are additionally recorded,
 * so a tampered artifact is detectable. The volatile field lists below are
 * exported and printed in the report; no hidden normalization exists.
 */

import { createHash } from 'node:crypto';

export const VOLATILE_NORMALIZATION: { ids: string[]; timestamps: string[]; durations: string[] } = {
  ids: ['runId', 'run_id', 'parentRunId', 'retryOf', 'ownerId'],
  timestamps: ['startedAt', 'createdAt', 'updatedAt', 'settledAt', 'retrievedAt', 'finishedAt', 'generatedAt', 'asOf'],
  durations: ['elapsedMs', 'durationMs', 'monotonicElapsedMs']
};

const NORMALIZED_ID = '<normalized:id>';
const NORMALIZED_TIMESTAMP = '<normalized:timestamp>';
const NORMALIZED_DURATION = '<normalized:duration>';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_NORMALIZATION.ids.includes(key)) out[key] = NORMALIZED_ID;
      else if (VOLATILE_NORMALIZATION.timestamps.includes(key)) out[key] = NORMALIZED_TIMESTAMP;
      else if (VOLATILE_NORMALIZATION.durations.includes(key)) out[key] = NORMALIZED_DURATION;
      else out[key] = normalizeValue(item);
    }
    return out;
  }
  return value;
}

/** Normalize the explicit volatile fields and hash the deterministic remainder. */
export function normalizedHash(input: unknown): string {
  return sha256Hex(JSON.stringify(normalizeValue(input)));
}

/**
 * Stable receipt order for hashing only. The ledger read order is
 * `created_at, action_key`, so two actions landing in the same millisecond can
 * swap between replays. Sorting a copy by kind then action key keeps every
 * receipt's request/result/usage association intact and is stable regardless of
 * millisecond ties. Raw ledger order is preserved verbatim in the artifacts.
 */
export function stableReceiptOrder<T extends { key: string; kind: string }>(receipts: readonly T[]): T[] {
  return [...receipts].sort((a, b) => (a.kind === b.kind ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.kind < b.kind ? -1 : 1));
}

const ABSOLUTE_PATH_PATTERN = /\/(?:Users|home|private\/tmp|var\/folders)\/[^\s"']+/g;

/**
 * Strip local absolute paths from publishable artifacts. Reports may contain
 * temporary directories and worktree paths; none of them belong in evidence.
 */
export function sanitizeLocalPaths(text: string, roots: readonly string[] = []): string {
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (root && root.length > 1) out = out.split(root).join('<path>');
  }
  return out.replace(ABSOLUTE_PATH_PATTERN, '<abs-path>');
}
