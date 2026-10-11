import assert from 'node:assert/strict';
import test from 'node:test';
import { seedFirstStep } from './first-step-fixtures.js';

test('explicit discovery without a new clue gets a fresh attempt and idempotent replay does not advance it twice', t => {
  const f = seedFirstStep({ accounts: [{ url: 'https://fixture-linzhou.org/' }] }); t.after(() => f.close());
  const before = f.firstStep.link(f.run.id)!;
  const previous = f.firstStep.currentDiscovery(f.run.id)!;
  const expanded = f.firstStep.applyFirstStepExpand('user-owner', f.run.id, null, 'explicit-refresh');
  const after = f.firstStep.link(f.run.id)!;
  assert.equal(after.inputRevision, before.inputRevision + 1);
  assert.equal(after.hint, before.hint);
  assert.deepEqual(f.firstStep.currentDiscovery(f.run.id), previous, 'old immutable discovery is retained until a new revision exists');
  const replay = f.firstStep.applyFirstStepExpand('user-owner', f.run.id, null, 'explicit-refresh');
  assert.equal(replay.idempotent, true);
  assert.equal(replay.runRevision, expanded.runRevision);
  assert.equal(f.firstStep.link(f.run.id)!.inputRevision, after.inputRevision);
});
