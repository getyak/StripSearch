import { createHash } from 'node:crypto';
import type { RunInput, ProviderName } from '../../shared/types.js';

export interface FingerprintInput {
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  parentRunId: string | null;
  retryOf: string | null;
  followup: boolean;
}

export function canonicalFingerprintSource(input: FingerprintInput): string {
  return JSON.stringify({
    question: input.question,
    seedUrl: input.seedUrl,
    provider: input.provider,
    parentRunId: input.parentRunId,
    retryOf: input.retryOf,
    followup: input.followup
  });
}

export function fingerprintInput(input: FingerprintInput): string {
  return createHash('sha256').update(canonicalFingerprintSource(input)).digest('hex');
}

export function normalizeProvider(raw: unknown): ProviderName {
  return raw === 'exa' ? 'exa' : raw === 'github' ? 'github' : 'research';
}

export function inputFromRun(run: {
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
}): RunInput {
  return { question: run.question, seedUrl: run.seedUrl, provider: run.provider };
}
