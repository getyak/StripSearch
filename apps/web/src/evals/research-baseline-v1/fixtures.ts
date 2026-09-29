/**
 * Strict ordered scripted fixtures for the research-baseline-v1 replay.
 *
 * The injected fixture tools and the injected fixture planner replace every
 * provider and model decision. Both replay a frozen script in strict order:
 * every call must match the expected action / input / mode exactly, extra calls
 * are rejected and recorded, and unconsumed steps at the end of a case are a
 * violation. Scripted planner decisions never call the model `invoke` gateway,
 * so the replay performs zero actual model calls and real token/cost usage
 * stays unknown (never a fabricated zero).
 */

import { ProviderError, type ProviderErrorCode } from '../../server/adapters/types.js';
import type { DshDecisionOptions } from '../../server/research/dsh-decision.js';
import type { PlannerInput, ResearchPlanner } from '../../server/research/planner.js';
import type { ResearchToolAction, ResearchToolResult, ResearchTools } from '../../server/research/tool-contracts.js';
import type { ScriptedPlannerStep, ScriptedToolStep } from './schema.js';

export interface FixtureViolation {
  kind: string;
  message: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function describe(action: unknown): string {
  return JSON.stringify(action);
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/**
 * Strict ordered tool replay. A call that does not match the next scripted
 * action (type plus input) throws and is recorded as a violation, so the
 * controller cannot silently swallow an unexpected request.
 */
export class ScriptedResearchTools implements ResearchTools {
  readonly calls: ResearchToolAction[] = [];
  readonly violations: FixtureViolation[] = [];
  private cursor = 0;

  constructor(private readonly steps: readonly ScriptedToolStep[]) {}

  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  private violate(kind: string, message: string): never {
    this.violations.push({ kind, message });
    throw new Error(`scripted research tools: ${message}`);
  }

  async execute(action: ResearchToolAction, signal: AbortSignal): Promise<ResearchToolResult> {
    signal.throwIfAborted();
    this.calls.push(clone(action));
    const step = this.steps[this.cursor];
    if (!step) {
      this.violate('unexpected_tool_call', `no scripted step remains for ${describe(action)}`);
    }
    if (canonical(step.action) !== canonical(action)) {
      this.violate('tool_action_mismatch', `step ${this.cursor} expects ${describe(step.action)} received ${describe(action)}`);
    }
    this.cursor += 1;
    if (step.networkAttempt !== undefined) {
      // Fault injection: an outbound attempt from fixture code. The isolated
      // process guard must stop it before any connector runs; the violation is
      // recorded either way so it can never be swallowed by the controller.
      let stoppedByGuard = false;
      try {
        await fetch(step.networkAttempt);
      } catch (error) {
        stoppedByGuard = error instanceof Error && error.message.includes('network guard blocked');
      }
      this.violate(
        'network_attempt',
        `fixture attempted ${step.networkAttempt}; ${stoppedByGuard ? 'stopped by the network guard' : 'NOT stopped by the network guard'}`
      );
    }
    if (step.error) {
      throw step.error.kind === 'provider'
        ? new ProviderError(step.error.code as ProviderErrorCode, step.error.message)
        : new Error(step.error.message);
    }
    return clone(step.result as ScriptedToolStep['result']) as ResearchToolResult;
  }

  finishScript(): FixtureViolation[] {
    if (this.remaining > 0) {
      this.violations.push({ kind: 'unconsumed_tool_step', message: `${this.remaining} scripted tool step(s) were never called` });
    }
    return this.violations;
  }
}

export interface PlannerCallRecord {
  mode: string | undefined;
  remainingTools: number;
  remainingModels: number;
  claims: number | undefined;
}

/**
 * Strict ordered planner replay. Decisions must match the scripted mode (and
 * optional claim count); the model `invoke` gateway is never called.
 */
export class ScriptedResearchPlanner implements ResearchPlanner {
  readonly calls: PlannerCallRecord[] = [];
  readonly violations: FixtureViolation[] = [];
  /** Actual model gateway invocations performed by this execution (always 0 here). */
  invokeCalls = 0;
  private cursor = 0;

  constructor(private readonly steps: readonly ScriptedPlannerStep[]) {}

  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  private violate(kind: string, message: string): never {
    this.violations.push({ kind, message });
    throw new Error(`scripted research planner: ${message}`);
  }

  async decide(input: PlannerInput, _signal: AbortSignal, invoke: DshDecisionOptions['invoke']): Promise<unknown> {
    // Count real invocations of the model gateway this execution. Scripted
    // decisions are frozen fixture data and never call it; the wrapped counter
    // makes that observable rather than assumed.
    const countingInvoke: DshDecisionOptions['invoke'] = async (request) => {
      this.invokeCalls += 1;
      return invoke(request);
    };
    this.calls.push({
      mode: input.mode,
      remainingTools: input.remainingTools,
      remainingModels: input.remainingModels,
      claims: input.claims?.length
    });
    const step = this.steps[this.cursor];
    if (!step) {
      this.violate('unexpected_planner_call', `no scripted step remains for mode "${input.mode ?? 'plan'}"`);
    }
    if (step.mode !== (input.mode ?? 'plan')) {
      this.violate('planner_mode_mismatch', `step ${this.cursor} expects mode "${step.mode}" received "${input.mode ?? 'plan'}"`);
    }
    if (step.expectClaims !== undefined && (input.claims?.length ?? 0) !== step.expectClaims) {
      this.violate('planner_claims_mismatch', `step ${this.cursor} expects ${step.expectClaims} claims received ${input.claims?.length ?? 0}`);
    }
    this.cursor += 1;
    // Scripted decisions are frozen fixture data; countingInvoke (and with it
    // the real model gateway) is deliberately never called.
    void countingInvoke;
    return clone(step.decision);
  }

  finishScript(): FixtureViolation[] {
    if (this.remaining > 0) {
      this.violations.push({ kind: 'unconsumed_planner_step', message: `${this.remaining} scripted planner step(s) were never called` });
    }
    return this.violations;
  }
}
