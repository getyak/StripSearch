/**
 * Shared route request-input helpers (express `Request` shape only; no route
 * policy lives here).
 *
 * String helpers keep their EXPLICITLY different semantics — see
 * docs/code-maintenance.md:
 * - `optionalBoundedString` (runs): trim, then reject blank/overlong → null;
 * - `optionalClippedText` (discovery): trim, then clip to max;
 * - review's human-judgment `requireText`/`optionalText` stay route-local:
 *   they reject overlong input with a field error instead of clipping.
 */
import type { Request } from 'express';

/** The JSON body as a plain object; arrays/scalars/null read as `{}`. */
export function readBody(req: Request): Record<string, unknown> {
  const body = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** Idempotency-Key header: trimmed, capped at 128 chars; blank/missing → null. */
export function readIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key');
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 128) : null;
}

/** Trim, then accept only non-empty values up to `max` chars (longer → null). */
export function optionalBoundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Trim, then clip to `max` chars (blank → null). */
export function optionalClippedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}
