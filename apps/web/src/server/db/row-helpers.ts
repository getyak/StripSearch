/**
 * Shared SQLite row helpers: one timestamp format, one record-id derivation
 * and one tolerant row-JSON parser for every store.
 *
 * Record ids preserve the caller's EXACT prefix (`${prefix}_${24 hex}`); the
 * prefixes at the call sites are part of persisted identity and are never
 * rewritten here. `parseJson` accepts `string | null` (nullable rows) and
 * keeps the historical failure fallback: unparsable rows return the fallback.
 */
import { randomUUID } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

/** Record id with the caller's prefix preserved verbatim. */
export function newRecordId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Tolerant row JSON parse: `null` and unparsable rows fall back. */
export function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
