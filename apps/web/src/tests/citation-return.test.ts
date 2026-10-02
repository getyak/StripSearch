/**
 * Citation inspection return controller: offline controller tests.
 *
 * Regression focus: repeated citations of the SAME source must keep their own
 * identity and reading offset across re-renders; stale records (removal, report
 * switch) are dropped instead of moving focus to the wrong place.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { createCitationReturn } from '../client/citation-return.js';

const env = installDom();

interface Harness {
  report: HTMLElement;
  scroller: HTMLElement;
  runId: string | null;
  render(anchors: string[], options?: { review?: boolean }): void;
  citation(anchor: string): HTMLElement | null;
}

function harness(): Harness {
  const report = env.document.createElement('div');
  report.id = 'report-fixture';
  const scroller = env.document.createElement('div');
  scroller.id = 'work-body-fixture';
  env.document.body.append(scroller, report);
  const state: Harness = {
    report,
    scroller,
    runId: 'runA',
    render(anchors, options = {}) {
      report.textContent = '';
      for (const anchor of anchors) {
        const wrapper = env.document.createElement('div');
        wrapper.className = 'finding';
        if (options.review) wrapper.dataset.validity = 'review';
        const button = env.document.createElement('button');
        button.className = 'citation';
        button.dataset.source = 'S1';
        button.dataset.citationAnchor = anchor;
        button.textContent = '[S1]';
        wrapper.appendChild(button);
        report.appendChild(wrapper);
      }
    },
    citation(anchor) {
      return report.querySelector<HTMLElement>(`button.citation[data-citation-anchor="${anchor}"]`);
    }
  };
  return state;
}

function controller(h: Harness, reduced = false) {
  return createCitationReturn({
    doc: env.document,
    win: env.window as unknown as Window & typeof globalThis,
    report: () => h.report,
    scroller: () => h.scroller,
    runId: () => h.runId,
    reducedMotion: () => reduced
  });
}

test('repeated citations of one source keep their own identity and reading offset', () => {
  const h = harness();
  const c = controller(h);
  h.render(['s0b0c0', 's0b1c0']);
  const second = h.citation('s0b1c0');
  assert.ok(second);
  h.scroller.scrollTop = 526;
  c.enterViaCitation('S1', 's0b1c0', second);

  // Same report re-render (polling snapshot): nodes are recreated.
  h.render(['s0b0c0', 's0b1c0']);
  c.sync();
  assert.equal(c.canReturn(), true, 'the exact citation is re-resolved');
  assert.equal(c.returnToCitation(), true);
  assert.equal(env.document.activeElement, h.citation('s0b1c0'), 'focus returns to the SECOND S1');
  assert.notEqual(env.document.activeElement, h.citation('s0b0c0'));
  assert.equal(h.scroller.scrollTop, 526, 'the reading offset of the entered citation is restored');
});

test('same-report source revocation re-render keeps the return target', () => {
  const h = harness();
  const c = controller(h);
  h.render(['s0b0c0', 's0b1c0']);
  h.scroller.scrollTop = 200;
  c.enterViaCitation('S1', 's0b1c0', h.citation('s0b1c0'));

  // Revocation marks findings as review but keeps the same semantic layout.
  h.render(['s0b0c0', 's0b1c0'], { review: true });
  c.sync();
  assert.equal(c.canReturn(), true);
  assert.equal(c.returnToCitation(), true);
  assert.equal(env.document.activeElement, h.citation('s0b1c0'));
  assert.equal(h.scroller.scrollTop, 200);
});

test('a removed citation clears the record instead of focusing another one', () => {
  const h = harness();
  const c = controller(h);
  h.render(['s0b0c0', 's0b1c0']);
  c.enterViaCitation('S1', 's0b1c0', h.citation('s0b1c0'));

  h.render(['s0b0c0']); // the entered citation disappeared from the report
  c.sync();
  assert.equal(c.canReturn(), false);
  assert.equal(c.entry(), null, 'the stale record is dropped');
  assert.equal(c.returnToCitation(), false);
  assert.notEqual(env.document.activeElement, h.citation('s0b0c0'), 'a different citation is never focused');
});

test('a report switch invalidates the return record', () => {
  const h = harness();
  const c = controller(h);
  h.render(['s0b0c0']);
  c.enterViaCitation('S1', 's0b0c0', h.citation('s0b0c0'));

  h.runId = 'runB';
  assert.equal(c.canReturn(), false);
  assert.equal(c.entry(), null);
  assert.equal(c.returnToCitation(), false);
  // Even after the new report renders an S1 citation, the old record is gone.
  h.render(['s0b0c0']);
  c.sync();
  assert.equal(c.canReturn(), false);
});

test('emphasize is a short-lived class and is disabled under reduced motion', async () => {
  const h = harness();
  h.render(['s0b0c0']);
  const target = h.citation('s0b0c0')!;
  const moving = controller(h, false);
  moving.emphasize(target);
  assert.ok(target.classList.contains('emphasis'));
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(target.classList.contains('emphasis'), false, 'the emphasis clears itself');

  const quiet = controller(h, true);
  quiet.emphasize(target);
  assert.equal(target.classList.contains('emphasis'), false, 'reduced motion adds no animation class');
});

test('list entries return to their row and never to a removed element', () => {
  const h = harness();
  const c = controller(h);
  h.render(['s0b0c0']);
  const list = env.document.createElement('div');
  list.className = 'source-list';
  list.id = 'source-list-fixture';
  const row = env.document.createElement('button');
  row.className = 'source-row';
  row.dataset.sourceKey = 'S1';
  list.appendChild(row);
  env.document.body.appendChild(list);

  c.enterViaList('S1', row);
  assert.equal(c.restoreEntryFocus(null), true);
  assert.equal(env.document.activeElement, row, 'closing returns to the list row that was the entry');

  row.remove();
  const fallback = env.document.createElement('button');
  env.document.body.appendChild(fallback);
  c.enterViaList('S1', null);
  assert.equal(c.restoreEntryFocus(fallback), true);
  assert.equal(env.document.activeElement, fallback, 'a removed row is never focused');
  list.remove();
  fallback.remove();
});

test('search and button entries return to their recorded opener', () => {
  const h = harness();
  const c = controller(h);
  h.render(['s0b0c0']);
  const opener = env.document.createElement('button');
  env.document.body.appendChild(opener);
  c.enterViaSearch('S1', opener);
  assert.equal(c.restoreEntryFocus(null), true);
  assert.equal(env.document.activeElement, opener);
  opener.remove();
  assert.equal(c.restoreEntryFocus(null), false, 'focus is left alone rather than sent to a removed node');
  c.clear();
});
