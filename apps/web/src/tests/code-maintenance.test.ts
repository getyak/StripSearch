/**
 * Regression tests for the 2026-10-11 duplication refactor (contract:
 * docs/code-maintenance.md). They pin BEHAVIOR, especially the semantic
 * differences that were deliberately retained:
 *
 * - request-input: reject-style vs clip-style string helpers;
 * - response primitives: finite vs safe-integer number parsing;
 * - account keys: one shared URL-fallback key shape, but the first-step and
 *   GET-92 normalization ladders stay different (preflight / tracking strip);
 * - URL policy layers keep their divergent strictness;
 * - 12/24 hex digest values are frozen (persisted digests / replay keys);
 * - record ids preserve their prefixes;
 * - link normalization: legacy self-link keys vs first-step evidence links;
 * - control-character stripping keeps \t \n \r;
 * - metered reserve/replay/settle/failure semantics.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Request } from 'express';

import {
  optionalBoundedString,
  optionalClippedText,
  readBody,
  readIdempotencyKey
} from '../server/http/request-input.js';
import {
  asArray,
  asFiniteNumber,
  asRecord,
  asSafeIntegerNumber,
  asString
} from '../shared/response-primitives.js';
import { asNumber } from '../server/adapters/http.js';
import { ACCOUNT_KEY_PREFIX, canonicalJson, urlFallbackAccountKey } from '../shared/discovery-plan.js';
import {
  canonicalAccountKey,
  NO_ACCOUNT_KEY_RULES,
  type AccountKeyRules
} from '../server/discovery/account-key.js';
import {
  classifyFirstStepUrl,
  firstStepAccountIdentity,
  firstStepAccountKey
} from '../shared/first-step-discovery.js';
import {
  isLiteralIpHost,
  matchesNonPublicHostSuffix,
  normalizeSchemeHost
} from '../shared/url-policy.js';
import { isPublicHttpsUrl, sanitizeText, stripControlCharacters } from '../shared/validation.js';
import { hash12, jsonDigest24 } from '../server/util/hash.js';
import { newRecordId, nowIso, parseJson } from '../server/db/row-helpers.js';
import {
  FIRST_STEP_LINK_POLICY,
  LEGACY_SELF_LINK_POLICY,
  normalizeHref
} from '../server/research/link-context.js';
import { escapeAttrValue, prefersReducedMotion } from '../client/dom.js';
import { meteredInvoke, type MeteredInvokeOptions } from '../server/research/metered.js';
import type { ActionReceipt, ActionUsage, ResearchStore } from '../server/research/research-store.js';

function fakeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return {
    body,
    header: (name: string) => headers[name.toLowerCase()]
  } as unknown as Request;
}

/* ------------------------------------------------------------------ */
/* 1. Route request input                                              */
/* ------------------------------------------------------------------ */

test('request-input: readBody keeps plain objects and rejects arrays/scalars', () => {
  assert.deepEqual(readBody(fakeRequest({ a: 1 })), { a: 1 });
  assert.deepEqual(readBody(fakeRequest([1, 2])), {});
  assert.deepEqual(readBody(fakeRequest(null)), {});
  assert.deepEqual(readBody(fakeRequest('x')), {});
});

test('request-input: Idempotency-Key trims, caps at 128 and maps blank to null', () => {
  assert.equal(readIdempotencyKey(fakeRequest({}, { 'idempotency-key': '  key-1  ' })), 'key-1');
  assert.equal(readIdempotencyKey(fakeRequest({}, { 'idempotency-key': '   ' })), null);
  assert.equal(readIdempotencyKey(fakeRequest({})), null);
  const long = 'k'.repeat(200);
  assert.equal(readIdempotencyKey(fakeRequest({}, { 'idempotency-key': long })), 'k'.repeat(128));
});

test('request-input: bounded vs clipped string helpers keep their different semantics', () => {
  // Reject-style (runs route): longer than max → null.
  assert.equal(optionalBoundedString('  ok  ', 10), 'ok');
  assert.equal(optionalBoundedString('toolong', 3), null);
  assert.equal(optionalBoundedString('   ', 3), null);
  assert.equal(optionalBoundedString(7, 3), null);
  // Clip-style (discovery route): longer than max → truncated.
  assert.equal(optionalClippedText('toolong', 3), 'too');
  assert.equal(optionalClippedText('   ', 3), null);
  assert.equal(optionalClippedText(null, 3), null);
});

/* ------------------------------------------------------------------ */
/* 2. Response primitives: finite vs safe integer stays split          */
/* ------------------------------------------------------------------ */

test('response primitives: finite and safe-integer number semantics stay different', () => {
  assert.equal(asFiniteNumber(1.5), 1.5);
  assert.equal(asSafeIntegerNumber(1.5), null);
  assert.equal(asSafeIntegerNumber(2), 2);
  assert.equal(asFiniteNumber(2), 2);
  assert.equal(asFiniteNumber(Infinity), null);
  assert.equal(asSafeIntegerNumber(2.0), 2);
  // The historical `asNumber` alias on the report/tool chains is FINITE.
  assert.equal(asNumber(1.5), 1.5);
});

test('response primitives: record/string/array coercions match the frozen rules', () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.deepEqual(asRecord([1]), {});
  assert.deepEqual(asRecord(null), {});
  assert.equal(asString('  x  '), 'x');
  assert.equal(asString('   '), null);
  assert.equal(asString(3), null);
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray('x'), []);
});

/* ------------------------------------------------------------------ */
/* 3. Account keys: one shape, two normalization ladders               */
/* ------------------------------------------------------------------ */

const safeRef = {
  platform: 'github' as const,
  instance: null,
  accountKind: 'person' as const,
  handle: 'octocat',
  accountUrl: 'https://GitHub.com/Octocat'
};

function identityFrom(overrides: Partial<ReturnType<typeof firstStepAccountIdentity>> = {}) {
  return { ...firstStepAccountIdentity(safeRef), ...overrides };
}

test('account keys: first-step and GET-92 agree on the URL-fallback key shape', () => {
  const firstStep = firstStepAccountKey(safeRef);
  const get92 = canonicalAccountKey(identityFrom());
  assert.equal(firstStep, get92);
  assert.ok(firstStep.startsWith(`${ACCOUNT_KEY_PREFIX}:`));
  assert.ok(firstStep.includes('"mode":"url"'));
  // The shared serializer is exactly the historical shape.
  assert.equal(
    firstStep,
    urlFallbackAccountKey(
      {
        v: ACCOUNT_KEY_PREFIX,
        platformId: 'github',
        instance: null,
        accountKind: 'person'
      },
      'https://github.com/Octocat'
    )
  );
});

test('account keys: the GET-92 preflight ladder stays stricter than first-step', () => {
  // A credential URL fails `staticHttpsUrlPreflight`: GET-92 falls back to the
  // verified-handle key while first-step (no preflight) still keys by URL.
  const credentialUrl = 'https://user:pass@site.example/octocat';
  const firstStep = firstStepAccountKey({ ...safeRef, accountUrl: credentialUrl });
  const get92 = canonicalAccountKey(identityFrom({ profileUrl: credentialUrl }));
  assert.ok(firstStep.includes('"mode":"url"'));
  assert.ok(get92 !== null && get92.includes('"mode":"handle"'));
  assert.notEqual(firstStep, get92);
});

test('account keys: tracking-parameter stripping is GET-92-only and explicit', () => {
  const dirty = 'https://site.example/p?utm_source=x&id=7';
  const rules: AccountKeyRules = {
    caseFoldHandlePlatforms: new Set<string>(),
    trackingParamWhitelist: new Map<string, readonly string[]>([['github', ['utm_source']]])
  };
  const get92 = canonicalAccountKey(
    identityFrom({ profileUrl: dirty, handle: null, handleVerified: false }),
    rules
  );
  const firstStep = firstStepAccountKey({ ...safeRef, accountUrl: dirty, handle: null });
  assert.equal(
    get92,
    urlFallbackAccountKey(
      { v: ACCOUNT_KEY_PREFIX, platformId: 'github', instance: null, accountKind: 'person' },
      'https://site.example/p?id=7'
    )
  );
  // first-step keeps every byte of the query: the keys intentionally differ.
  assert.ok(firstStep.includes('%3F') || firstStep.includes('utm_source'));
  assert.notEqual(firstStep, get92);
  // Without verified whitelist evidence nothing is ever stripped.
  const noRules = canonicalAccountKey(
    identityFrom({ profileUrl: dirty, handle: null, handleVerified: false }),
    NO_ACCOUNT_KEY_RULES
  );
  assert.ok(noRules !== null && noRules.includes('utm_source'));
});

/* ------------------------------------------------------------------ */
/* 4. URL policy layers keep divergent strictness                      */
/* ------------------------------------------------------------------ */

test('URL policy: input layer and first-step layer stay divergent on fixture hosts', () => {
  // Documented divergence (docs/code-maintenance.md): the storage-input layer
  // does NOT block fixture hosts; first-step classification DOES.
  assert.equal(isPublicHttpsUrl('https://example.com/x'), true);
  assert.equal(classifyFirstStepUrl('https://example.com/x').ok, false);
});

test('URL policy: shared predicates behave like the historical inline copies', () => {
  assert.equal(matchesNonPublicHostSuffix('example.org'), true);
  assert.equal(matchesNonPublicHostSuffix('sub.example.org'), true);
  assert.equal(matchesNonPublicHostSuffix('github.com'), false);
  assert.equal(isLiteralIpHost('1.2.3.4'), true);
  assert.equal(isLiteralIpHost('999.1.1.1'), true);
  assert.equal(isLiteralIpHost('github.com'), false);
  assert.equal(normalizeSchemeHost('HTTPS://GitHub.COM/Octocat?x=1#y'), 'https://github.com/Octocat?x=1#y');
});

/* ------------------------------------------------------------------ */
/* 5. Frozen 12/24 hex digests                                        */
/* ------------------------------------------------------------------ */

test('hash utilities keep the frozen digest values', () => {
  assert.equal(hash12('stripsearch'), '643c929a981c');
  assert.equal(jsonDigest24({ a: 1 }), '015abd7f5cc57a2dd94b7590');
  assert.equal(jsonDigest24([1, 2]), '49a64717d5d4cb19952e6eac');
  // jsonDigest24 is plain JSON.stringify, NOT canonicalJson: key order matters
  // for persisted digests and must not be "fixed".
  assert.notEqual(jsonDigest24({ a: 1, b: 2 }), jsonDigest24({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

/* ------------------------------------------------------------------ */
/* 6. Record ids and row helpers                                      */
/* ------------------------------------------------------------------ */

test('record ids preserve caller prefixes; parseJson keeps its fallbacks', () => {
  for (const prefix of ['run', 'src', 'obs', 'rtask', 'rcase', 'rann', 'dtask', 'dimport', 'excl']) {
    assert.match(newRecordId(prefix), new RegExp(`^${prefix}_[0-9a-f]{24}$`));
  }
  assert.equal(parseJson('not-json', 'fallback'), 'fallback');
  assert.equal(parseJson(null, 'fallback'), 'fallback');
  assert.deepEqual(parseJson('{"a":1}', {}), { a: 1 });
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/);
});

/* ------------------------------------------------------------------ */
/* 7. Link normalization: two explicit policies                       */
/* ------------------------------------------------------------------ */

test('link normalization: legacy self-link keys and first-step links keep their differences', () => {
  // Trailing slashes: legacy collapses, first-step keeps exact path bytes.
  assert.equal(normalizeHref('https://Site.example/Profile/', 'https://x.example/', LEGACY_SELF_LINK_POLICY), 'https://site.example/Profile');
  assert.equal(normalizeHref('https://Site.example/Profile/', 'https://x.example/', FIRST_STEP_LINK_POLICY), 'https://site.example/Profile/');
  // Ports: legacy allows instance ports, first-step refuses them.
  assert.equal(normalizeHref('https://social.example:8443/u', 'https://x.example/', LEGACY_SELF_LINK_POLICY), 'https://social.example:8443/u');
  assert.equal(normalizeHref('https://social.example:8443/u', 'https://x.example/', FIRST_STEP_LINK_POLICY), null);
  // Protocol-relative hrefs: first-step refuses, legacy resolves them.
  assert.equal(normalizeHref('//other.example/a', 'https://x.example/', FIRST_STEP_LINK_POLICY), null);
  assert.equal(normalizeHref('//other.example/a', 'https://x.example/', LEGACY_SELF_LINK_POLICY), 'https://other.example/a');
  // Both policies strip fragments and refuse credentials/non-https.
  assert.equal(normalizeHref('https://a.example/p#frag', 'https://x.example/', LEGACY_SELF_LINK_POLICY), 'https://a.example/p');
  assert.equal(normalizeHref('https://a.example/p#frag', 'https://x.example/', FIRST_STEP_LINK_POLICY), 'https://a.example/p');
  assert.equal(normalizeHref('https://u:p@a.example/p', 'https://x.example/', LEGACY_SELF_LINK_POLICY), null);
  assert.equal(normalizeHref('http://a.example/p', 'https://x.example/', FIRST_STEP_LINK_POLICY), null);
});

/* ------------------------------------------------------------------ */
/* 8. Text / client helpers                                           */
/* ------------------------------------------------------------------ */

test('stripControlCharacters keeps tab/newline/CR and is the one policy', () => {
  const raw = 'a\u0000b\tc\nd\re\u007f';
  assert.equal(stripControlCharacters(raw), 'ab\tc\nd\re');
  assert.equal(sanitizeText(raw, 100), 'ab\tc\nd\re');
});

test('escapeAttrValue reproduces the historical attribute escaping', () => {
  assert.equal(escapeAttrValue('x"y'), 'x\\"y');
  assert.equal(escapeAttrValue('p\\q'), 'p\\\\q');
  // \n \r \f become CSS hex escapes followed by a literal space.
  assert.equal(escapeAttrValue('line1\nline2'), 'line1\\a line2');
  assert.equal(escapeAttrValue('r\rf'), 'r\\d f');
  assert.equal(escapeAttrValue('c\ff'), 'c\\c f');
});

test('prefersReducedMotion: override wins, matchMedia fallback, false on failure', () => {
  const winMedia = { matchMedia: () => ({ matches: true }) } as unknown as Window;
  const winNoPref = { matchMedia: () => ({ matches: false }) } as unknown as Window;
  const winBroken = { matchMedia: () => { throw new Error('no matchMedia'); } } as unknown as Window;
  assert.equal(prefersReducedMotion(winMedia), true);
  assert.equal(prefersReducedMotion(winNoPref), false);
  assert.equal(prefersReducedMotion(winMedia, () => false), false);
  assert.equal(prefersReducedMotion(winNoPref, () => true), true);
  assert.equal(prefersReducedMotion(winNoPref, () => undefined), false);
  assert.equal(prefersReducedMotion(winBroken), false);
  assert.equal(prefersReducedMotion(winBroken, () => true), true);
});

/* ------------------------------------------------------------------ */
/* 9. Metered reserve / replay / settle semantics                     */
/* ------------------------------------------------------------------ */

type Ledger = Pick<ResearchStore, 'reserve' | 'settle' | 'receipt'>;

function fakeLedger(): Ledger & { rows: Map<string, ActionReceipt>; settles: number } {
  const rows = new Map<string, ActionReceipt>();
  const ledger = {
    rows,
    settles: 0,
    reserve(runId: string, key: string, kind: 'tool' | 'model', request: unknown, reservation: { inputTokens: number; outputTokens: number }, _limits?: unknown, allowSettledFailure = false) {
      const old = rows.get(key);
      if (old) {
        if (old.state === 'inflight' || (old.state === 'failed' && !allowSettledFailure)) {
          throw new Error('unknown_inflight');
        }
        return old;
      }
      rows.set(key, { key, kind, state: 'inflight', request, result: null, usage: null, reservedInput: reservation.inputTokens, reservedOutput: reservation.outputTokens, createdAt: 't0' });
      return undefined;
    },
    settle(_runId: string, key: string, result: unknown, usage: ActionUsage, state: 'completed' | 'failed' = 'completed') {
      ledger.settles += 1;
      const row = rows.get(key);
      if (row && row.state === 'inflight') {
        row.state = state;
        row.result = result;
        row.usage = usage;
      }
    },
    receipt(_runId: string, key: string) {
      return rows.get(key);
    }
  };
  return ledger;
}

function baseOptions<T>(ledger: Ledger, overrides: Partial<MeteredInvokeOptions<T>>): MeteredInvokeOptions<T> {
  return {
    ledger,
    runId: 'run_1',
    key: 'tool:key',
    kind: 'tool' as const,
    request: { type: 'read' },
    reservation: { inputTokens: 0, outputTokens: 0 },
    limits: { toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
    allowSettledFailure: true,
    replayFailure: () => new Error('failed receipt replayed'),
    execute: async () => ({} as T),
    usageOf: (result: T) => ({ estimatedUsd: (result as { cost?: number }).cost ?? null, unknownCost: false }),
    failureUsage: () => ({ estimatedUsd: null, unknownCost: true }),
    settleFailure: () => true,
    ...overrides
  };
}

test('meteredInvoke: completed receipts replay exactly and never re-execute', async () => {
  const ledger = fakeLedger();
  ledger.rows.set('tool:key', {
    key: 'tool:key', kind: 'tool', state: 'completed', request: { type: 'read' },
    result: { saved: true, cost: 1 }, usage: { estimatedUsd: 1 }, reservedInput: 0, reservedOutput: 0, createdAt: 't0'
  });
  let executed = 0;
  const result = await meteredInvoke<{ saved: boolean; cost?: number }>(baseOptions<{ saved: boolean; cost?: number }>(ledger, {
    execute: async () => { executed += 1; return { saved: false }; }
  }));
  assert.deepEqual(result, { saved: true, cost: 1 });
  assert.equal(executed, 0);
  assert.equal(ledger.settles, 0);
});

test('meteredInvoke: settled FAILED receipts are refused with the role error', async () => {
  const ledger = fakeLedger();
  ledger.rows.set('tool:key', {
    key: 'tool:key', kind: 'tool', state: 'failed', request: { type: 'read' },
    result: null, usage: null, reservedInput: 0, reservedOutput: 0, createdAt: 't0'
  });
  await assert.rejects(
    meteredInvoke(baseOptions<{ ok: boolean }>(ledger, { execute: async () => ({ ok: true }) })),
    /failed receipt replayed/
  );
});

test('meteredInvoke: success settles with the derived usage; failure keeps the policy', async () => {
  const ledger = fakeLedger();
  const onSettledOrder: string[] = [];
  const result = await meteredInvoke<{ cost: number }>(baseOptions<{ cost: number }>(ledger, {
    execute: async () => ({ cost: 2 }),
    onSettled: () => { onSettledOrder.push('after-settle'); }
  }));
  assert.deepEqual(result, { cost: 2 });
  const row = ledger.rows.get('tool:key');
  assert.equal(row?.state, 'completed');
  assert.deepEqual(row?.usage, { estimatedUsd: 2, unknownCost: false });
  assert.deepEqual(onSettledOrder, ['after-settle']);

  // Failure: failureUsage policy is written once, the error propagates.
  const failed = fakeLedger();
  await assert.rejects(
    meteredInvoke(baseOptions<{ ok: boolean }>(failed, {
      key: 'tool:bad',
      execute: async () => { throw new Error('boom'); },
      failureUsage: () => ({ estimatedUsd: 0.5, unknownCost: false })
    })),
    /boom/
  );
  const badRow = failed.rows.get('tool:bad');
  assert.equal(badRow?.state, 'failed');
  assert.deepEqual(badRow?.usage, { estimatedUsd: 0.5, unknownCost: false });
});

test('meteredInvoke: aborted chains skip late failure receipts; post-settle checks enter the failure path', async () => {
  // Abort gate (controller semantics): no late receipt at all.
  const ledger = fakeLedger();
  await assert.rejects(
    meteredInvoke(baseOptions<{ ok: boolean }>(ledger, {
      key: 'tool:aborted',
      execute: async () => { throw new Error('boom'); },
      settleFailure: () => false
    })),
    /boom/
  );
  assert.equal(ledger.rows.get('tool:aborted')?.state, 'inflight');
  assert.equal(ledger.settles, 0);

  // Post-settle signal/active checks (first-step semantics) run INSIDE the
  // metered try: their failure attempts a failed settlement first.
  const strict = fakeLedger();
  const notes: string[] = [];
  await assert.rejects(
    meteredInvoke(baseOptions<{ ok: boolean }>(strict, {
      key: 'tool:late',
      execute: async () => ({ ok: true }),
      onSettled: () => { throw new Error('cancelled'); },
      onFailed: (receipt: ActionReceipt | undefined) => { notes.push(receipt?.state ?? 'none'); }
    })),
    /cancelled/
  );
  // The completed settlement stands (the failure update is inflight-only) and
  // the failed-log hook still sees the real receipt — the historical behavior.
  assert.equal(strict.rows.get('tool:late')?.state, 'completed');
  assert.deepEqual(notes, ['completed']);
});
