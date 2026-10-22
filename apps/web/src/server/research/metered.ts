/**
 * The shared metered-call scaffold: `reserve → replay-or-execute → settle`
 * over the one `store.research` action ledger.
 *
 * Semantics that every chain shares and that live here:
 * - a same-key completed receipt replays its EXACT saved result (original
 *   receipt time), an unknown inflight receipt is never replayed (reserve
 *   throws) and a settled FAILED receipt is refused with the caller's error;
 * - after execution the receipt settles with the caller's usage derivation;
 * - failure settlement is try/except-wrapped (cancelled/deleted runs refuse
 *   late receipts) and the original error always propagates.
 *
 * Role differences stay explicit at the call sites (docs/code-maintenance.md):
 * failure-usage policy (dispatched cost vs unknown cost), the late-receipt
 * abort gate, per-role replay messages, first-step attempt budgets/notes and
 * controller predispatch. The fetch seed-read variant in `services/runner.ts`
 * keeps its own gap-and-continue replay handling and is not routed through
 * this helper.
 */
import type {
  ActionReceipt,
  ActionUsage,
  ResearchStore
} from './research-store.js';
import type { ResearchBudgetLimits } from '../../shared/types.js';

export interface MeteredInvokeOptions<T> {
  /** The shared `store.research` ledger. */
  ledger: Pick<ResearchStore, 'reserve' | 'settle' | 'receipt'>;
  runId: string;
  key: string;
  kind: 'tool' | 'model';
  request: unknown;
  reservation: { inputTokens: number; outputTokens: number };
  limits: ResearchBudgetLimits;
  /** Replayed settled-failure receipts stay visible (first-step/fetch scope). */
  allowSettledFailure: boolean;
  /** Error for a replayed settled-FAILED receipt; message is role-specific. */
  replayFailure: (receipt: ActionReceipt) => Error;
  execute: () => Promise<T>;
  usageOf: (result: T) => ActionUsage;
  /** Runs after settle and may throw into the failure path (abort/active checks). */
  onSettled?: (receipt: ActionReceipt | undefined) => void;
  /** Failure settlement usage policy (dispatched cost retention lives here). */
  failureUsage: (error: unknown) => ActionUsage;
  /** Optional bounded, caller-owned metadata; old callers keep a null result. */
  failureResult?: (error: unknown) => unknown;
  /** When false no late failure receipt is written (aborted chains). */
  settleFailure: () => boolean;
  /** Called with the settled FAILED receipt when one exists. */
  onFailed?: (receipt: ActionReceipt | undefined) => void;
  /** Called with a replayed receipt BEFORE the failed-replay check. */
  onReplay?: (receipt: ActionReceipt) => void;
}

export async function meteredInvoke<T>(options: MeteredInvokeOptions<T>): Promise<T> {
  const old = options.ledger.reserve(
    options.runId,
    options.key,
    options.kind,
    options.request,
    options.reservation,
    options.limits,
    options.allowSettledFailure
  );
  if (old) {
    options.onReplay?.(old);
    if (old.state === 'failed') throw options.replayFailure(old);
    return old.result as T;
  }
  try {
    const result = await options.execute();
    options.ledger.settle(options.runId, options.key, result, options.usageOf(result));
    options.onSettled?.(options.ledger.receipt(options.runId, options.key));
    return result;
  } catch (error) {
    if (options.settleFailure()) {
      try {
        options.ledger.settle(options.runId, options.key, options.failureResult?.(error) ?? null, options.failureUsage(error), 'failed');
        options.onFailed?.(options.ledger.receipt(options.runId, options.key));
      } catch {
        /* cancelled/deleted runs refuse late receipts; keep the original error */
      }
    }
    throw error;
  }
}
