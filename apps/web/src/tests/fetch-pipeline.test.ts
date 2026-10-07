/**
 * GET-99 local Fetch pipeline acceptance tests (synthetic, offline).
 *
 * Real SQLite (memory and file-backed close/reopen), global fetch disabled.
 * The chain runs through the exact GET-59 dispatch gateway and the
 * research-runtime model gateway against the deterministic synthetic corpus:
 * more than 25 items and more than 80 real tool actions across multiple
 * batches, every listed body read, two accounts on two platforms. Covered
 * here: repeated pages / cursor cycles / empty open-cursor pages staying
 * partial-unknown, deep author replies with missing/deleted/hidden ancestors,
 * third-party attribution, unknown vs no media, tampered source hashes
 * refused, scope changes and evidence revocation, restart without duplicate
 * successful calls, interrupted intents and atomic fold rollback, actual
 * model usage/fee persistence across close/reopen, plan-gated dispatch
 * (unplanned and repeated calls refused, scheduling bounds stay resumable),
 * malformed model authority injection, isolated verify with read-back gating,
 * incomplete questions/checks and no automatic report.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openDatabase, applyCoreSchema } from '../server/db/index.js';
import type { DB } from '../server/db/index.js';
import { createInitialCheckpoint, runFetchPipeline } from '../server/research/fetch-pipeline.js';
import type { ToolEnvelope } from '../server/research/research-tool-contracts.js';
import type { ModelCall, TrustedContext } from '../server/research/research-tool-dispatch.js';
import {
  SYNTHETIC_CASE_ID,
  SYNTHETIC_OWNER,
  buildSyntheticCorpus,
  createPlanModel,
  openSyntheticHarness,
  prepareSyntheticCase
} from '../server/research/fetch-pipeline-synthetic.js';
import type { SyntheticHarness, SyntheticScenario } from '../server/research/fetch-pipeline-synthetic.js';
import type { FetchPipelineSummary } from '../shared/research-fetch-pipeline.js';
import { fetchPlanStepKey } from '../shared/research-fetch-pipeline.js';

// Offline by construction: any accidental request fails loudly.
globalThis.fetch = (() => {
  throw new Error('fetch-pipeline tests are offline: real network/fetch is disabled');
}) as typeof globalThis.fetch;

function tempBase(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tempBase(), prefix));
}

interface Fixture {
  db: DB;
  dbPath: string;
  harness: SyntheticHarness;
  close(): void;
  reopen(): SyntheticHarness;
}

function fixture(
  t: TestContext,
  options: { scenario?: SyntheticScenario; model?: ReturnType<typeof createPlanModel> } = {}
): Fixture {
  const dir = tempDir('get95-pipe-');
  const dbPath = path.join(dir, 'pipeline.db');
  let db: DB = openDatabase(dbPath);
  applyCoreSchema(db);
  t.after(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  let harness = openSyntheticHarness(db, { scenario: options.scenario, model: options.model });
  return {
    get db() {
      return db;
    },
    dbPath,
    get harness() {
      return harness;
    },
    close: () => db.close(),
    reopen: () => {
      db = openDatabase(dbPath);
      applyCoreSchema(db);
      harness = openSyntheticHarness(db, { scenario: options.scenario, model: options.model, resumeRunId: harness.runId });
      return harness;
    }
  };
}

function pickCounts(summary: FetchPipelineSummary) {
  const { estimatedUsd, credits, modelEstimatedUsd, ...rest } = summary.counts;
  void estimatedUsd;
  void credits;
  void modelEstimatedUsd;
  return rest;
}

test('full synthetic chain: >25 items, >80 tool actions, multiple batches, all bodies read, honest assessment', async (t) => {
  const fx = fixture(t);
  const first = await fx.harness.run({ maxStepsPerBatch: 8 });
  assert.ok(first.counts.listedItems >= 25, `items ${String(first.counts.listedItems)}`);
  assert.ok(first.counts.toolActions > 80, `tool actions ${String(first.counts.toolActions)}`);
  assert.ok(first.counts.batches > 1, `batches ${String(first.counts.batches)}`);
  // Every readable listed body is processed (never dropped by engagement).
  assert.equal(first.counts.bodiesRead, first.counts.listedItems);
  assert.equal(first.counts.commentsRead, first.counts.listedItems);
  // Two accounts on two distinct platforms.
  const platforms = new Set(first.accounts.map((account) => account.platform));
  assert.equal(first.accounts.length, 2);
  assert.equal(platforms.size, 2);
  // Pending findings only: collected per account plus one verification check.
  const collected = first.pendingFindings.filter((finding) => finding.kind === 'collected_finding');
  const verified = first.pendingFindings.filter((finding) => finding.kind === 'verification_check');
  assert.equal(collected.length, 2);
  assert.equal(verified.length, 1);
  for (const finding of first.pendingFindings) assert.ok(finding.dependencyEvidenceIds.length > 0);
  // Deterministic GET-60 assessment is reported, never claimed by the run.
  assert.ok(first.assessment);
  assert.notEqual(first.assessment?.verdict, 'complete');
  assert.ok(first.remainingGaps.length > 0);
  assert.equal(first.providerProfilesVerified, 0);
  assert.equal(first.openSteps, 0);
  assert.equal(first.state, 'finished');
  assert.equal(first.stopReason, 'obligations_processed');

  // Close/reopen on the same explicit database: precise resume, no replays.
  const before = fx.harness.runs.loadCheckpoint(first.runId);
  fx.close();
  const second = fx.reopen();
  const resumed = await second.run({ maxStepsPerBatch: 8 });
  assert.equal(resumed.runId, first.runId);
  assert.deepEqual(pickCounts(resumed), pickCounts(first));
  assert.deepEqual(second.runs.loadCheckpoint(first.runId)?.doneSteps, before?.doneSteps);
});

test('repeated pages never double count and cursor cycles keep the denominator unknown', async (t) => {
  const repeated = fixture(t, { scenario: { repeatPageAccounts: ['acct-alpha'] } });
  const summary = await repeated.harness.run({ maxStepsPerBatch: 8 });
  const alpha = summary.accounts.find((account) => account.accountId === 'acct-alpha');
  assert.equal(alpha?.enumeratedItems, 14);
  assert.equal(summary.counts.bodiesRead, 28);

  const cycling = fixture(t, { scenario: { cursorCycleAccounts: ['acct-alpha'] } });
  const cycleSummary = await cycling.harness.run({ maxStepsPerBatch: 8 });
  const view = cycling.harness.store.fetchCoverage.getFetchCoverageView(
    SYNTHETIC_OWNER,
    SYNTHETIC_CASE_ID,
    cycling.harness.scopeSpecId
  );
  assert.ok(view);
  const cycleAccount = view.accounts.find((account) => account.accountId === 'acct-alpha');
  assert.equal(cycleAccount?.enumeration.exhausted, false);
  assert.equal(cycleAccount?.enumeration.basis, 'known_gap');
  assert.equal(cycleAccount?.denominatorKnown, false);
  assert.equal(cycleAccount?.dimensions.find((dimension) => dimension.dimension === 'body')?.percent, null);
  assert.ok(cycleSummary.remainingGaps.some((line) => line.includes('cursor_cycle')));
});

test('an empty page with an open cursor is recorded as open, never as exhaustion', async (t) => {
  const fx = fixture(t, { scenario: { emptyOpenCursorAccounts: ['acct-beta'] } });
  await fx.harness.run({ maxStepsPerBatch: 8 });
  const observations = fx.harness.store.completion.listCompletionObservations(
    SYNTHETIC_OWNER,
    SYNTHETIC_CASE_ID,
    fx.harness.scopeSpecId
  );
  const openEmpty = observations.find(
    (observation) =>
      observation.action === 'enumerate_history' &&
      observation.obligationRef.kind === 'account_history' &&
      observation.obligationRef.accountId === 'acct-beta' &&
      observation.items.length === 0 &&
      observation.nextCursor !== null
  );
  assert.ok(openEmpty, 'the empty page must keep its open cursor');
  assert.equal(openEmpty.stopReason, null);
  // The terminal page may claim exhaustion; the open page never does.
  const terminal = observations.filter(
    (observation) =>
      observation.action === 'enumerate_history' &&
      observation.obligationRef.kind === 'account_history' &&
      observation.obligationRef.accountId === 'acct-beta' &&
      observation.stopReason === 'endpoint_exhausted'
  );
  assert.equal(terminal.length, 1);
});

test('deep author replies keep ancestor gaps and third-party attribution stays separate', async (t) => {
  const fx = fixture(t);
  const summary = await fx.harness.run({ maxStepsPerBatch: 8 });
  const events = fx.harness.runs.listEvents(summary.runId);
  const toolEvents = events.filter((event) => event.kind === 'tool');
  const threadCalls = toolEvents.filter(
    (event) => (event.payload as { tool?: string }).tool === 'read_thread'
  ) as unknown as { payload: { input: { parentRef: string; depth: number }; envelope: { content: { nodes: { authorAccountId: string; authorRole: string; state: string; text: string | null; textUnavailableReason: string | null }[] } } } }[];
  // Branch calls carry the actual parentRef and the frozen depth.
  const deep = threadCalls.find((call) => call.payload.input.parentRef === 'c-alpha-03-a');
  assert.ok(deep);
  assert.equal(deep.payload.input.depth, 4);
  const nodes = deep.payload.envelope.content.nodes;
  const deepReply = nodes.find((node) => node.authorAccountId === 'acct-alpha');
  assert.equal(deepReply?.authorRole, 'subject');
  assert.equal(deepReply?.text !== null, true);
  const missingParent = nodes.find((node) => node.state === 'missing');
  assert.equal(missingParent?.text, null);
  assert.equal((missingParent?.textUnavailableReason ?? '').length > 0, true);

  // Third-party authors keep their own role everywhere and are never subject.
  for (const call of threadCalls) {
    for (const node of call.payload.envelope.content.nodes) {
      if (node.authorAccountId !== 'acct-alpha' && node.authorAccountId !== 'acct-beta') {
        assert.notEqual(node.authorRole, 'subject');
      }
    }
  }
  // The selected branch with the missing parent stays explicitly unresolved.
  assert.ok(summary.remainingGaps.some((line) => line.includes('br-alpha-03')));
  const observation = fx.harness.store.completion
    .listCompletionObservations(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID, fx.harness.scopeSpecId)
    .find(
      (entry) =>
        entry.action === 'select_branch' &&
        entry.obligationRef.kind === 'thread_branch' &&
        entry.obligationRef.branchKey === 'br-alpha-03'
    );
  assert.equal(
    observation?.action === 'select_branch' ? observation.parentChain.some((link) => link.state === 'missing') : false,
    true
  );
});

test('unknown media is explicit and no-media is satisfied only by credible absence', async (t) => {
  const fx = fixture(t);
  const summary = await fx.harness.run({ maxStepsPerBatch: 8 });
  assert.equal(summary.counts.mediaUnknownUnread, 4); // 3 unknown + 1 explicit unread
  const view = fx.harness.store.fetchCoverage.getFetchCoverageView(
    SYNTHETIC_OWNER,
    SYNTHETIC_CASE_ID,
    fx.harness.scopeSpecId
  );
  assert.ok(view);
  const alphaUnknown = view.items.find(
    (item) => item.content.accountId === 'acct-alpha' && item.dimensions.some((dimension) => dimension.dimension.name === 'media' && dimension.state === 'unread' && dimension.history.length > 0)
  );
  assert.ok(alphaUnknown, 'unknown media carries an explicit unread record');
  const noMedia = view.items.filter((item) => item.media.applicability === 'none');
  assert.ok(noMedia.length > 0, 'credibly absent media stays absent');
  const alphaCounter = view.accounts.find((account) => account.accountId === 'acct-alpha');
  const media = alphaCounter?.dimensions.find((dimension) => dimension.dimension === 'media');
  assert.ok((media?.satisfiedByAbsence ?? 0) > 0);
});

test('a changed source hash is refused: metering retained, no evidence, no body coverage', async (t) => {
  const fx = fixture(t, { scenario: { tamperedItems: ['itm-alpha-02'] } });
  const summary = await fx.harness.run({ maxStepsPerBatch: 8 });
  assert.ok(summary.remainingGaps.some((line) => line.includes('source_binding_mismatch')));
  assert.equal(summary.counts.bodiesRead, summary.counts.listedItems - 1);
  const evidence = fx.harness.store.cases.reportView(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID).evidence;
  assert.equal(
    evidence.some((entry) => entry.sourceId === fx.harness.catalog.accounts[0]!.pages[0]![1]!.sourceId),
    false,
    'a tampered read never creates evidence for the requested source'
  );
  // The refusal is explicit and the executed request stays metered.
  assert.ok(summary.counts.providerRequests > 0);
  assert.equal(summary.counts.unknownFeeRequests > 0 || summary.counts.estimatedUsd !== null, true);
});

test('scope change mid-run stops new writes and keeps the frozen scope stale', async (t) => {
  const fx = fixture(t);
  let drifted = false;
  const model = createPlanModel();
  const summary = await fx.harness.run({
    model: {
      invoke: async (request, signal) => {
        if (!drifted && request.events.filter((event) => event.kind === 'tool').length >= 3) {
          drifted = true;
          fx.harness.store.cases.applyScopeChange({
            ownerId: SYNTHETIC_OWNER,
            caseId: SYNTHETIC_CASE_ID,
            expectedScopeVersion: fx.harness.store.cases.getCase(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID)!.scopeVersion,
            reason: 'mid-run scope change',
            accounts: [{ accountId: 'acct-alpha', allowedScope: { state: 'none', note: 'revoked' } }]
          });
        }
        return model.invoke(request, signal);
      }
    }
  });
  assert.equal(summary.state, 'stopped');
  assert.equal(summary.stopReason, 'scope_changed');
  // Scope stays stale; no new freeze is synthesized.
  assert.equal(summary.frozenScopeStale, true);
  assert.equal(
    fx.harness.store.completion.listCompletionScopes(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID).length,
    1
  );
  // A second run on the stale scope refuses to write and stays stale.
  const again = await fx.harness.run();
  assert.equal(again.stopReason, 'scope_changed');
  assert.equal(again.frozenScopeStale, true);
});

test('evidence revocation blocks verify read-back and no verification claim is staged', async (t) => {
  const fx = fixture(t);
  const planModel = createPlanModel();
  let revoked = false;
  const summary = await fx.harness.run({
    model: {
      invoke: async (request, signal) => {
        const instructions = JSON.parse(request.instructions) as { plan: { tool: string }[] };
        if (!revoked && instructions.plan[0]?.tool === 'read_evidence') {
          revoked = true;
          for (const evidence of fx.harness.store.cases.reportView(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID).evidence) {
            for (const account of fx.harness.store.cases.listAccounts(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID)) {
              try {
                fx.harness.store.cases.revokeEvidence(
                  {
                    ownerId: SYNTHETIC_OWNER,
                    caseId: SYNTHETIC_CASE_ID,
                    accountId: account.accountId,
                    expectedScopeVersion: fx.harness.store.cases.getCase(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID)!.scopeVersion
                  },
                  evidence.evidenceId
                );
              } catch {
                // evidence belongs to another account
              }
            }
          }
        }
        return planModel.invoke(request, signal);
      }
    }
  });
  const findings = fx.harness.runs.listFindings(summary.runId);
  assert.equal(findings.filter((finding) => finding.kind === 'verification_check').length, 0);
  assert.equal(summary.counts.verificationsStaged, 0);
  assert.equal(findings.some((finding) => finding.kind === 'collected_finding'), true);
});

test('interrupted intent and atomic fold rollback never replay and stay unreconciled', async (t) => {
  const fx = fixture(t);
  let faults = 0;
  const summary = await fx.harness.run({
    maxStepsPerBatch: 2,
    foldHooks: {
      beforeCheckpointCommit: () => {
        if (faults === 0) {
          faults += 1;
          throw new Error('synthetic fold fault after originals/evidence');
        }
      }
    }
  });
  // The raw executed outcome is durable, but ZERO derived writes landed.
  const intents = fx.harness.runs.listIntents(summary.runId);
  const faulted = intents.find((intent) => intent.state === 'reported');
  assert.ok(faulted, 'the interrupted intent stays unresolved');
  assert.ok(faulted.outcome !== null, 'raw outcome durable');
  assert.equal(summary.state, 'stopped');
  assert.equal(summary.stopReason, 'unreconciled_action');
  const observations = fx.harness.store.completion.listCompletionObservations(
    SYNTHETIC_OWNER,
    SYNTHETIC_CASE_ID,
    fx.harness.scopeSpecId
  );
  assert.equal(
    observations.some((observation) => observation.action === 'enumerate_history'),
    false,
    'rolled-back fold leaves no derived observation'
  );

  // Reopen without reconciliation: still unreconciled, nothing dispatched.
  fx.close();
  const reopened = fx.reopen();
  let dispatched = 0;
  const blocked = await reopened.run({
    tools: {
      dispatch: async (_context: TrustedContext, _call: ModelCall) => {
        dispatched += 1;
        throw new Error('must not dispatch');
      }
    }
  });
  assert.equal(blocked.stopReason, 'unreconciled_action');
  assert.equal(dispatched, 0);

  // Explicit authoritative reconciliation resumes without replaying the step.
  const reconciled = await reopened.run({ reconcileUnresolvedIntents: 'abandon' });
  assert.notEqual(reconciled.stopReason, 'unreconciled_action');
  const stepKey = faulted.stepKey;
  assert.equal(reopened.runs.loadCheckpoint(reconciled.runId)?.refusedSteps.includes(stepKey), true);
  assert.equal(reopened.runs.requireIntent(faulted.intentId).state, 'abandoned');
});

test('actual model usage and known fees survive metering across close/reopen', async (t) => {
  const usage = { inputTokens: 13, outputTokens: 7, estimatedUsd: 0.25 } as const;
  const fx = fixture(t, { model: createPlanModel(usage), scenario: { unknownFeeEndpoints: [] } });
  const first = await fx.harness.run({ maxStepsPerBatch: 8 });
  const modelEvents = fx.harness.runs.listEvents(first.runId).filter((event) => event.kind === 'model');
  assert.ok(modelEvents.length > 0);
  assert.equal((modelEvents[0]?.payload as { inputTokens: number }).inputTokens, 13);
  assert.equal((modelEvents[0]?.payload as { estimatedUsd: number }).estimatedUsd, 0.25);
  assert.equal(first.counts.modelInputTokens, 13 * first.counts.modelCalls);
  assert.equal(first.counts.modelOutputTokens, 7 * first.counts.modelCalls);
  assert.equal(first.counts.modelEstimatedUsd, 0.25 * first.counts.modelCalls);
  assert.equal(typeof first.counts.estimatedUsd, 'number');
  assert.ok(
    Math.abs(
      (first.counts.estimatedUsd ?? 0) -
        (first.counts.providerRequests * 0.001 + (first.counts.modelEstimatedUsd ?? 0))
    ) < 1e-9
  );

  fx.close();
  const reopened = fx.reopen();
  const resumed = await reopened.run({ maxStepsPerBatch: 8 });
  assert.deepEqual(pickCounts(resumed), pickCounts(first));
  assert.equal(resumed.counts.estimatedUsd, first.counts.estimatedUsd);
});

test('a persisted stopped/unreconciled run never silently becomes finished on resume', async (t) => {
  const fx = fixture(t);
  fx.harness.runs.finishRun(fx.harness.runId, 'stopped', 'unreconciled_action');
  let invoked = 0;
  let dispatched = 0;
  const summary = await fx.harness.run({
    tools: {
      dispatch: async () => {
        dispatched += 1;
        throw new Error('must not dispatch');
      }
    },
    model: {
      invoke: async () => {
        invoked += 1;
        throw new Error('must not invoke');
      }
    }
  });
  assert.equal(summary.stopReason, 'unreconciled_action');
  assert.equal(invoked, 0);
  assert.equal(dispatched, 0);
  assert.equal(fx.harness.runs.requireRun(fx.harness.runId).stopReason, 'unreconciled_action');
});

test('unplanned and repeated calls are refused before dispatch and scheduling bounds stay resumable', async (t) => {
  const fx = fixture(t);
  let dispatched = 0;
  const counter = {
    dispatch: async (context: TrustedContext, call: ModelCall, signal: AbortSignal) => {
      dispatched += 1;
      return fx.harness.tools.dispatch(context, call, signal);
    }
  };
  // (a) an unplanned call never reaches the provider; maxBatches stays resumable
  const summary = await fx.harness.run({
    maxBatches: 1,
    maxStepsPerBatch: 2,
    tools: counter,
    model: {
      invoke: async () => ({
        decision: { kind: 'tool', tool: 'report_progress', input: { note: 'unplanned', gaps: [] } },
        usage: { inputTokens: null, outputTokens: null, estimatedUsd: null }
      })
    }
  });
  assert.equal(dispatched, 0);
  assert.notEqual(summary.state, 'finished');
  assert.equal(summary.stopReason, 'batch_quantum_exhausted');
  assert.ok(summary.openSteps > 0);
  assert.equal(summary.assessment?.verdict !== 'complete', true);

  // (b) an identical planned call repeated inside one batch is refused once done
  dispatched = 0;
  const planModel = createPlanModel();
  const repeated = await fx.harness.run({
    maxBatches: 2,
    maxStepsPerBatch: 3,
    tools: counter,
    model: {
      invoke: async (request, signal) => {
        const instructions = JSON.parse(request.instructions) as { plan: { tool: string; input: Record<string, unknown> }[] };
        const first = instructions.plan[0];
        if (first && request.events.filter((event) => event.kind === 'tool').length > 0) {
          return {
            decision: { kind: 'tool', tool: first.tool, input: first.input },
            usage: { inputTokens: null, outputTokens: null, estimatedUsd: null }
          };
        }
        return planModel.invoke(request, signal);
      }
    }
  });
  assert.ok(dispatched >= 1);
  const refusedEvents = fx.harness.runs
    .listEvents(repeated.runId)
    .filter((event) => event.kind === 'refused_call');
  assert.ok(refusedEvents.length > 0, 'the repeated call is refused after completion');
});

test('model authority injection and mutating gateways cannot corrupt the trusted state', async (t) => {
  const fx = fixture(t);
  let dispatched = 0;
  const summary = await fx.harness.run({
    maxBatches: 1,
    maxStepsPerBatch: 2,
    tools: {
      dispatch: async (context: TrustedContext, call: ModelCall, signal: AbortSignal) => {
        dispatched += 1;
        return fx.harness.tools.dispatch(context, call, signal);
      }
    },
    model: {
      invoke: async (request) => {
        // Malformed model attempts: privilege injection and unknown verdicts.
        request.allowedTools.push('discover_accounts');
        return {
          decision: {
            kind: 'tool',
            tool: 'list_posts',
            input: { accountId: 'acct-alpha', ownerId: 'evil-owner', caseId: 'evil-case' }
          },
          usage: { inputTokens: null, outputTokens: null, estimatedUsd: null }
        };
      }
    }
  });
  assert.equal(dispatched, 0, 'privilege-injected input never dispatches');
  const checkpoint = fx.harness.runs.loadCheckpoint(summary.runId);
  assert.ok(checkpoint);
  assert.equal(
    checkpoint.doneSteps.some((key) => !key.startsWith('local:')),
    false,
    'no dispatched step is folded after an injection attempt'
  );
  assert.equal(fx.harness.store.cases.getCase('evil-owner', SYNTHETIC_CASE_ID), null);

  // A gateway mutating its returned envelope cannot rewrite recorded history.
  const planModel = createPlanModel();
  const hijack = await fx.harness.run({
    maxBatches: 1,
    maxStepsPerBatch: 1,
    model: planModel,
    tools: {
      dispatch: async (context: TrustedContext, call: ModelCall, signal: AbortSignal) => {
        const envelope = await fx.harness.tools.dispatch(context, call, signal);
        setTimeout(() => {
          (envelope as { content: unknown }).content = { hijacked: true };
        }, 0);
        return envelope;
      }
    }
  });
  const firstTool = fx.harness.runs
    .listEvents(hijack.runId)
    .find((event) => event.kind === 'tool') as { payload: { envelope: ToolEnvelope } } | undefined;
  if (firstTool) assert.notDeepEqual(firstTool.payload.envelope.content, { hijacked: true });
});

test('isolated verify exposes exactly three tools and cannot list or read provider sources', async (t) => {
  const fx = fixture(t);
  const seen: string[][] = [];
  const planModel = createPlanModel();
  const summary = await fx.harness.run({
    maxStepsPerBatch: 8,
    model: {
      invoke: async (request, signal) => {
        seen.push([...request.allowedTools]);
        return planModel.invoke(request, signal);
      }
    }
  });
  const verifyPhases = seen.filter((tools) => tools.includes('save_findings') && !tools.includes('list_posts'));
  assert.ok(verifyPhases.length > 0, 'a verify phase batch ran');
  for (const tools of verifyPhases) {
    assert.deepEqual([...tools].sort(), ['load_skill', 'read_evidence', 'save_findings']);
  }
  const fetchPhases = seen.filter((tools) => tools.includes('list_posts'));
  assert.ok(fetchPhases.length > 0);
  assert.equal(fetchPhases[0]?.length, 10, 'fetch phase exposes exactly the Fetch 10');
  // The staged verification check exists and is bound to read-back evidence.
  const verification = summary.pendingFindings.find((finding) => finding.kind === 'verification_check');
  assert.ok(verification);
  assert.ok(verification.dependencyEvidenceIds.length > 0);
});

test('questions and required checks stay incomplete and nothing is published', async (t) => {
  const fx = fixture(t);
  const summary = await fx.harness.run({ maxStepsPerBatch: 8 });
  const dimensions = summary.assessment?.dimensions ?? [];
  const questions = dimensions.find((dimension) => dimension.dimension === 'questions');
  const checks = dimensions.find((dimension) => dimension.dimension === 'required_checks');
  assert.equal(questions?.unresolved, 1);
  assert.equal(checks?.unresolved, 1);
  assert.equal(questions?.state, 'partial');
  assert.equal(checks?.state, 'partial');
  // No claim, report or completed finding is ever written by the pipeline.
  const claims = fx.db.prepare('SELECT COUNT(*) AS n FROM research_case_claims').get() as { n: number };
  assert.equal(claims.n, 0);
  for (const finding of fx.harness.runs.listFindings(summary.runId)) assert.equal(finding.state, 'pending');
});

test('partial responses never manufacture read coverage', async (t) => {
  const fx = fixture(t);
  let downgraded = false;
  const summary = await fx.harness.run({
    maxStepsPerBatch: 8,
    tools: {
      dispatch: async (context: TrustedContext, call: ModelCall, signal: AbortSignal) => {
        const envelope = await fx.harness.tools.dispatch(context, call, signal);
        if (!downgraded && call.tool === 'list_comments') {
          downgraded = true;
          (envelope as { status: string }).status = 'partial';
        }
        return envelope;
      }
    }
  });
  const events = fx.harness.runs.listEvents(summary.runId).filter((event) => event.kind === 'tool');
  const partialComment = events.find((event) => {
    const payload = event.payload as { tool: string; envelope: { status: string } };
    return payload.tool === 'list_comments' && payload.envelope.status === 'partial';
  });
  assert.ok(partialComment);
  const view = fx.harness.store.fetchCoverage.getFetchCoverageView(
    SYNTHETIC_OWNER,
    SYNTHETIC_CASE_ID,
    fx.harness.scopeSpecId
  );
  assert.ok(view);
  const truncated = view.items.filter((item) =>
    item.dimensions.some(
      (dimension) => dimension.dimension.name === 'comments' && dimension.state === 'truncated'
    )
  );
  assert.equal(truncated.length, 1);
  assert.equal(summary.counts.commentsRead, summary.counts.listedItems - 1);
});

test('the offline CLI resumes unfinished work after closing the file database without replays', (t) => {
  const dir = tempDir('fetch-cli-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cli.db');
  const raw = execFileSync(process.execPath,
    ['--import', 'tsx', 'scripts/fetch-offline.ts', '--db', dbPath, '--steps', '8'],
    { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: { ...process.env, TMPDIR: tempBase() } });
  const output = JSON.parse(raw);
  assert.equal(output.firstPass.state, 'running');
  assert.ok(output.firstPass.openSteps > 0);
  assert.equal(output.firstPass.batches, 1);
  const complete = output.afterCloseReopen;
  assert.ok(complete.items >= 25);
  assert.ok(complete.toolActions > 80);
  assert.ok(complete.batches > 1);
  assert.equal(complete.bodiesRead, complete.items);
  assert.ok(complete.pendingFindings.length > 0);
  assert.ok(complete.assessment);
  assert.ok(complete.remainingGaps.length > 0);
  assert.equal(output.resume.sameRun, true);
  assert.equal(output.resume.resumedFromUnfinished, true);
  assert.equal(output.resume.duplicateSuccessfulActions, 0);
  assert.ok(output.resume.newToolActions > 0);
});

test('a listed row without a matching source pin is a preserved gap, never a false denominator', async (t) => {
  const fx = fixture(t, { scenario: { unpinnedItems: ['itm-alpha-01'] } });
  // The adapter never prepared an exact source pin for one listed row.
  const summary = await fx.harness.run({ maxStepsPerBatch: 8 });
  assert.ok(summary.remainingGaps.some((line) => line.includes('pin_mismatch')));
  const view = fx.harness.store.fetchCoverage.getFetchCoverageView(
    SYNTHETIC_OWNER,
    SYNTHETIC_CASE_ID,
    fx.harness.scopeSpecId
  );
  assert.ok(view);
  const alpha = view.accounts.find((account) => account.accountId === 'acct-alpha');
  // The observed subset never becomes a falsely known denominator.
  assert.equal(alpha?.enumeration.exhausted, false);
  assert.equal(alpha?.enumeration.basis, 'known_gap');
  assert.equal(alpha?.denominatorKnown, false);
  assert.equal(alpha?.dimensions.find((dimension) => dimension.dimension === 'body')?.percent, null);
  // The unpinned row is not counted and never gets a body read.
  assert.equal(alpha?.enumeratedItems, 13);
  assert.equal(summary.counts.bodiesRead, 27);
});

test('a mid-run scheduling stop resumes at the exact cursor/item step without replays', async (t) => {
  const interrupted = fixture(t);
  const partial = await interrupted.harness.run({ maxBatches: 3, maxStepsPerBatch: 4 });
  assert.equal(partial.state, 'running');
  assert.equal(partial.stopReason, 'batch_quantum_exhausted');
  assert.ok(partial.openSteps > 0, 'obligations stay open at a scheduling bound');
  const before = interrupted.harness.runs.loadCheckpoint(partial.runId)!;
  assert.ok(before.doneSteps.length > 0, 'mid-run position is durable');
  assert.equal(before.accounts.some((account) => account.pagesDone > 0), true);
  interrupted.close();
  const reopened = interrupted.reopen();
  const resumed = await reopened.run({ maxStepsPerBatch: 8 });
  assert.equal(resumed.state, 'finished');
  const after = reopened.runs.loadCheckpoint(partial.runId)!;
  assert.ok(after.doneSteps.length > before.doneSteps.length);
  assert.equal(new Set(after.doneSteps).size, after.doneSteps.length, 'no step recorded twice');

  // Totals must equal an uninterrupted chain: no duplicate successful calls.
  const baseline = fixture(t);
  const straight = await baseline.harness.run({ maxStepsPerBatch: 8 });
  assert.equal(resumed.counts.toolActions, straight.counts.toolActions);
  assert.equal(resumed.counts.listedItems, straight.counts.listedItems);
  assert.equal(resumed.counts.bodiesRead, straight.counts.bodiesRead);
  assert.equal(resumed.counts.commentsRead, straight.counts.commentsRead);
  assert.equal(resumed.counts.mediaReads, straight.counts.mediaReads);
  assert.equal(resumed.counts.branchesSelected, straight.counts.branchesSelected);
  assert.equal(resumed.counts.findingsStaged, straight.counts.findingsStaged);
  assert.equal(resumed.counts.verificationsStaged, straight.counts.verificationsStaged);
});

test('resume refuses a changed adapter catalog / source pin set', async (t) => {
  const fx = fixture(t);
  const partial = await fx.harness.run({ maxBatches: 1, maxStepsPerBatch: 2 });
  assert.equal(partial.state, 'running');
  const store = fx.harness.store;
  const runs = fx.harness.runs;
  const drifted = buildSyntheticCorpus();
  const setup = prepareSyntheticCase(store, drifted);
  drifted.accounts[0]!.pages[0]![0]!.contentHash = 'a'.repeat(64);
  await assert.rejects(
    () =>
      runFetchPipeline(
        {
          store,
          runs,
          tools: fx.harness.tools,
          model: createPlanModel(),
          catalog: drifted,
          ownerId: setup.ownerId,
          caseId: setup.caseId,
          scopeSpecId: setup.scopeSpecId,
          runId: partial.runId,
          synthetic: true
        },
        new AbortController().signal
      ),
    /catalog \/ source pins changed/
  );
  // A different frozen scope spec is refused outright as well.
  await assert.rejects(
    () =>
      runFetchPipeline(
        {
          store,
          runs,
          tools: fx.harness.tools,
          model: createPlanModel(),
          catalog: fx.harness.catalog,
          ownerId: setup.ownerId,
          caseId: setup.caseId,
          scopeSpecId: 'cspec-not-this-run',
          runId: partial.runId,
          synthetic: true
        },
        new AbortController().signal
      ),
    /frozen scope not found|different frozen scope spec/
  );
});


test('invalid model usage never enters valid metering totals and remains unknown across reopen', async (t) => {
  for (const invalid of [
    { inputTokens: -1, outputTokens: 7, estimatedUsd: 0.25 },
    { inputTokens: 13.5, outputTokens: 7, estimatedUsd: 0.25 },
    { inputTokens: 13, outputTokens: Number.NaN, estimatedUsd: 0.25 },
    { inputTokens: 13, outputTokens: 7, estimatedUsd: -0.25 },
    { inputTokens: 13, outputTokens: 7, estimatedUsd: Number.POSITIVE_INFINITY }
  ]) {
    const fx = fixture(t, { model: createPlanModel(invalid) });
    const first = await fx.harness.run({ maxBatches: 1 });
    assert.equal(first.counts.toolActions, 0);
    assert.equal(first.counts.modelInputTokens, null);
    assert.equal(first.counts.modelOutputTokens, null);
    assert.equal(first.counts.modelEstimatedUsd, null);
    assert.equal(first.counts.estimatedUsd, null);
    const events = fx.harness.runs.listEvents(first.runId);
    assert.deepEqual(events.find(event => event.kind === 'model')?.payload,
      { inputTokens: null, outputTokens: null, estimatedUsd: null });
    assert.ok(events.some(event => event.kind === 'model_failure' &&
      (event.payload as { detail: string }).detail === 'invalid_model_usage'));
    fx.close();
    const resumed = await fx.reopen().run({ maxBatches: 1 });
    assert.equal(resumed.counts.modelEstimatedUsd, null);
    assert.equal(resumed.counts.toolActions, 0);
  }
});


test('comment counterevidence preserves its speaker, permalink and independently captured excerpt', async (t) => {
  const fx = fixture(t);
  const summary = await fx.harness.run();
  const counters = fx.harness.store.cases.reportView(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID).evidence
    .filter(evidence => evidence.role === 'factual_counterevidence');
  assert.ok(counters.length > 0, 'materialized counterevidence must be exercised');
  for (const evidence of counters) {
    const revisions = fx.harness.store.cases.listSourceRevisions(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID,
      evidence.accountId, evidence.sourceId);
    const revision = revisions.find(entry => entry.sourceRevision === evidence.sourceRevision)!;
    const captured = JSON.parse(evidence.provenance.note!);
    assert.equal(captured.captureType, 'comment_excerpt');
    assert.equal(revision.author, captured.authorName ?? captured.authorAccountId);
    assert.equal(revision.originalUrl, captured.permalink);
    assert.notEqual(revision.sourceId, captured.rootSourceId);
    assert.ok(revision.title.includes('excerpt'));
    assert.notEqual(revision.contentHash, fx.harness.catalog.accounts.flatMap(account => account.pages.flat())
      .find(item => item.sourceId === captured.rootSourceId)?.contentHash);
  }
  const stagedCounters = fx.harness.runs.listFindings(summary.runId).flatMap(finding => finding.counterEvidenceIds);
  assert.ok(counters.every(evidence => stagedCounters.includes(evidence.evidenceId)),
    'separate comment sources must remain in staged counterevidence dependencies');
});

test('dispatch errors without a metering outcome keep totals unknown after reopen and abandon', async (t) => {
  const fx = fixture(t, { model: createPlanModel({ inputTokens: 13, outputTokens: 7, estimatedUsd: 0.25 }) });
  const first = await fx.harness.run({ tools: { dispatch: async () => { throw new Error('request timeout: outcome unknown'); } } });
  assert.equal(first.stopReason, 'unreconciled_action');
  assert.equal(first.counts.modelEstimatedUsd, 0.25);
  assert.equal(first.counts.estimatedUsd, null);
  fx.close();
  const reopened = fx.reopen();
  const stopped = await reopened.run();
  assert.equal(stopped.counts.estimatedUsd, null);
  assert.equal(stopped.counts.modelEstimatedUsd, 0.25);
  const abandoned = await reopened.run({ reconcileUnresolvedIntents: 'abandon', maxBatches: 1 });
  assert.ok(reopened.runs.listIntents(first.runId).some(intent => intent.state === 'abandoned'));
  assert.equal(abandoned.counts.estimatedUsd, null);
  assert.equal(abandoned.counts.credits, null);
});

test('a new run on a stale frozen scope cannot dispatch any action', async (t) => {
  const fx = fixture(t);
  const record = fx.harness.store.cases.getCase(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID)!;
  fx.harness.store.cases.applyScopeChange({ ownerId: SYNTHETIC_OWNER, caseId: SYNTHETIC_CASE_ID,
    expectedScopeVersion: record.scopeVersion, reason: 'stale-freeze regression',
    accounts: [{ accountId: 'acct-alpha', allowedScope: { state: 'none', note: 'revoked' } }] });
  let dispatched = 0;
  const result = await fx.harness.run({ runId: '', tools: { dispatch: async (...args) => {
    dispatched++; return fx.harness.tools.dispatch(...args);
  } } });
  assert.equal(result.stopReason, 'scope_changed');
  assert.equal(result.frozenScopeStale, true);
  assert.equal(dispatched, 0);
  assert.equal(result.counts.modelCalls, 0);
});


test('gateway call mutation cannot change the approved action or materialize an unplanned body', async (t) => {
  const fx = fixture(t);
  const summary = await fx.harness.run({ maxBatches: 1, tools: { dispatch: async (context, call, signal) => {
    assert.equal(call.tool, 'list_posts');
    call.tool = 'read_post';
    call.input = { accountId: 'acct-alpha', itemId: 'itm-alpha-01' };
    return fx.harness.tools.dispatch(context, call, signal);
  } } });
  assert.equal(summary.stopReason, 'unreconciled_action');
  assert.equal(summary.counts.bodiesRead, 0);
  assert.equal(summary.counts.listedItems, 0);
  assert.equal(fx.harness.store.cases.reportView(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID).evidence.length, 0);
  const intent = fx.harness.runs.listUnresolvedIntents(summary.runId)[0]!;
  assert.equal(intent.tool, 'list_posts');
  assert.equal(intent.state, 'reported');
  assert.equal((intent.outcome as ToolEnvelope).tool, 'read_post');
  assert.equal((intent.outcome as ToolEnvelope).usage.providerRequests, 1);
  assert.equal(fx.harness.runs.loadCheckpoint(summary.runId)!.doneSteps.includes(intent.stepKey), false);
  const before = summary.counts.toolActions;
  const reopened = await fx.harness.run();
  assert.equal(reopened.counts.toolActions, before);
  assert.equal(reopened.stopReason, 'unreconciled_action');
});
