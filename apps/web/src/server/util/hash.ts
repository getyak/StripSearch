/**
 * Deterministic hash helpers shared by discovery planning, public rules and
 * the research ledgers. Behavior is frozen: existing persisted digests, route
 * ids and replay keys must stay byte-identical to their pre-refactor values.
 */
import { createHash } from 'node:crypto';

/** 12-hex digest of a UTF-8 string (deterministic route/rule id derivation). */
export function hash12(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

/**
 * 24-hex digest of `JSON.stringify(value)` (NOT canonical JSON) — the exact
 * historical recipe used for tool/model request keys and candidate ids.
 * Never switch this to canonical JSON: persisted digests and replay keys
 * depend on the current serialization.
 */
export function jsonDigest24(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
