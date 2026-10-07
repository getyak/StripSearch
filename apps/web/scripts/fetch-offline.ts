/**
 * GET-99 local Fetch offline harness CLI (synthetic, deterministic, offline).
 *
 * Runs the local Fetch chain against the deterministic synthetic corpus with
 * the network forbidden and every gateway injected, using an EXPLICIT output
 * database path. It closes and reopens that database mid-run and resumes the
 * same durable run — proving precise account-cursor/item-step resume without
 * replaying known successful actions — then prints one concise structured
 * summary: real counts, pending findings, the deterministic GET-60 assessment
 * status and remaining gaps.
 *
 * This is a local synthetic pass: no live endpoint, no real provider or model
 * call, no deployment, and no provider profile is ever marked verified.
 *
 * Usage:
 *   node --import tsx scripts/fetch-offline.ts --db /tmp/fetch-offline.db [--steps 8]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase, applyCoreSchema } from '../src/server/db/index.js';
import type { DB } from '../src/server/db/index.js';
import { openSyntheticHarness } from '../src/server/research/fetch-pipeline-synthetic.js';
import type { FetchPipelineSummary } from '../src/shared/research-fetch-pipeline.js';

// Offline by construction: any accidental request fails loudly.
globalThis.fetch = (() => {
  throw new Error('fetch-offline harness is offline: real network/fetch is disabled');
}) as typeof globalThis.fetch;

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv.length > index + 1 ? (process.argv[index + 1] ?? null) : null;
}

function concise(summary: FetchPipelineSummary) {
  return {
    runId: summary.runId,
    state: summary.state,
    stopReason: summary.stopReason,
    openSteps: summary.openSteps,
    items: summary.counts.listedItems,
    toolActions: summary.counts.toolActions,
    modelCalls: summary.counts.modelCalls,
    batches: summary.counts.batches,
    bodiesRead: summary.counts.bodiesRead,
    commentsRead: summary.counts.commentsRead,
    mediaReads: summary.counts.mediaReads,
    mediaUnknownUnread: summary.counts.mediaUnknownUnread,
    branchesSelected: summary.counts.branchesSelected,
    branchesRead: summary.counts.branchesRead,
    pendingFindings: summary.pendingFindings.map((finding) => ({
      pendingRef: finding.pendingRef,
      kind: finding.kind,
      accountIds: finding.accountIds
    })),
    assessment: summary.assessment
      ? {
          verdict: summary.assessment.verdict,
          dimensions: summary.assessment.dimensions.map((dimension) => ({
            dimension: dimension.dimension,
            state: dimension.state,
            total: dimension.total,
            addressed: dimension.addressed,
            unresolved: dimension.unresolved,
            percent: dimension.percent
          }))
        }
      : null,
    remainingGaps: summary.remainingGaps,
    estimatedUsd: summary.counts.estimatedUsd,
    unknownFeeRequests: summary.counts.unknownFeeRequests,
    modelUsage: {
      inputTokens: summary.counts.modelInputTokens,
      outputTokens: summary.counts.modelOutputTokens,
      estimatedUsd: summary.counts.modelEstimatedUsd
    },
    providerProfilesVerified: summary.providerProfilesVerified
  };
}

async function main(): Promise<void> {
  const explicitDb = argValue('db')?.trim() || null;
  const steps = Number(argValue('steps') ?? '8');
  if (!Number.isSafeInteger(steps) || steps < 1) throw new Error('steps must be a positive integer');
  const tempDir = explicitDb === null
    ? mkdtempSync(path.join(process.env.TMPDIR?.trim() || tmpdir(), 'fetch-offline-'))
    : null;
  const dbPath = explicitDb ?? path.join(tempDir!, 'fetch-offline.db');
  let db: DB | null = null;
  try {
    db = openDatabase(dbPath);
    applyCoreSchema(db);
    const first = openSyntheticHarness(db);
    // Stop after one scheduling quantum, while obligations remain open.
    const firstSummary = await first.run({ maxStepsPerBatch: steps, maxBatches: 1 });
    if (firstSummary.state !== 'running' || firstSummary.openSteps < 1) {
      throw new Error('first pass did not leave an unfinished run to resume');
    }
    const knownSuccessful = new Set(first.runs.loadCheckpoint(firstSummary.runId)!.doneSteps);
    const priorIntentIds = new Set(first.runs.listIntents(firstSummary.runId).map(intent => intent.intentId));
    db.close();
    db = null;

    db = openDatabase(dbPath);
    applyCoreSchema(db);
    const second = openSyntheticHarness(db, { resumeRunId: firstSummary.runId });
    const secondSummary = await second.run({ maxStepsPerBatch: steps });
    const duplicateSuccessfulActions = second.runs.listIntents(secondSummary.runId)
      .filter(intent => !priorIntentIds.has(intent.intentId) && knownSuccessful.has(intent.stepKey)).length;
    if (secondSummary.runId !== firstSummary.runId || duplicateSuccessfulActions > 0) {
      throw new Error('resume changed the run or replayed a known successful action');
    }
    const output = {
      harness: 'stripsearch/fetch-offline-synthetic/v1',
      dbPath: explicitDb ?? '(temp: cleaned up)',
      deterministic: true,
      networkForbidden: true,
      firstPass: concise(firstSummary),
      afterCloseReopen: concise(secondSummary),
      resume: {
        sameRun: secondSummary.runId === firstSummary.runId,
        resumedFromUnfinished: true,
        toolActionsBeforeReopen: firstSummary.counts.toolActions,
        toolActionsAfterReopen: secondSummary.counts.toolActions,
        newToolActions: secondSummary.counts.toolActions - firstSummary.counts.toolActions,
        duplicateSuccessfulActions
      }
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    db?.close();
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`fetch-offline failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
