import assert from 'node:assert/strict';
import test from 'node:test';
import { pacedFirecrawl } from '../server/research/provider-gate.js';
import type { HttpTransport } from '../server/adapters/types.js';

const transport = (): HttpTransport => ({ async fetch() { throw new Error('offline gate test never contacts a provider'); } });

test('shared scrape lane spaces requests and never runs them in parallel', async () => {
  const provider = transport(); const starts: number[] = []; let running = 0; let maximum = 0;
  const execute = () => pacedFirecrawl(provider, new AbortController().signal, 25, async () => {
    starts.push(Date.now()); running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, 8)); running--; return starts.length;
  });
  await Promise.all([execute(), execute(), execute()]);
  assert.equal(maximum, 1); assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 20);
});

test('cancelling a queued scrape never sends it or lets a later call bypass the active predecessor', async () => {
  const provider = transport(); const events: string[] = []; let release!: () => void;
  const first = pacedFirecrawl(provider, new AbortController().signal, 0, async () => {
    events.push('first started'); await new Promise<void>(resolve => { release = resolve; }); events.push('first done');
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const controller = new AbortController();
  const queued = pacedFirecrawl(provider, controller.signal, 0, async () => { events.push('cancelled request sent'); });
  const rejected = assert.rejects(queued);
  const third = pacedFirecrawl(provider, new AbortController().signal, 0, async () => { events.push('third sent'); });
  controller.abort(new Error('own test cancelled'));
  await rejected; assert.deepEqual(events, ['first started']);
  release(); await Promise.all([first, third]);
  assert.deepEqual(events, ['first started', 'first done', 'third sent']);
});
