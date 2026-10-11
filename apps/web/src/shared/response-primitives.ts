/**
 * Shared untrusted-response primitives (pure).
 *
 * Two numeric semantics coexist ON PURPOSE and are kept as distinct exports
 * (docs/code-maintenance.md):
 * - `asFiniteNumber` (finite): provider costs/estimates on the report and
 *   research-tool chains;
 * - `asSafeIntegerNumber` (whole safe integers only): persisted GitHub
 *   acquisition ids/counts, where a fractional value must never round-trip.
 * Never silently alias one to the other.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Finite numbers (including fractional): provider estimate semantics. */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whole safe integers only: persisted id/count semantics. */
export function asSafeIntegerNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
