import type { ResearchCheckpoint } from './research-store.js';

/** Remember every issued ordinal before corpus filtering; history never reuses it. */
export function rememberSourceKeys(checkpoint: ResearchCheckpoint, storedKeys: Iterable<string> = []): void {
  let maximum = checkpoint.sourceKeyHighWatermark ?? 0;
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid source-key watermark');
  for (const key of [...checkpoint.pages.map(page => page.sourceKey), ...storedKeys]) {
    const match = /^S([0-9]+)$/.exec(key);
    if (!match) continue;
    const ordinal = Number(match[1]);
    if (!Number.isSafeInteger(ordinal)) throw new Error('Invalid source-key ordinal');
    maximum = Math.max(maximum, ordinal);
  }
  checkpoint.sourceKeyHighWatermark = maximum;
}

export function allocateSourceKey(checkpoint: ResearchCheckpoint, storedKeys: Iterable<string> = []): string {
  rememberSourceKeys(checkpoint, storedKeys);
  const next = checkpoint.sourceKeyHighWatermark! + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Source-key space exhausted');
  checkpoint.sourceKeyHighWatermark = next;
  return `S${next}`;
}
