import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFirstStep, type SeededFirstStep } from './first-step-fixtures.js';
import { waitFor } from './harness.js';
import { Runner } from '../server/services/runner.js';
import { Store } from '../server/store.js';
import { openDatabase } from '../server/db/index.js';
import type { AppConfig } from '../server/config.js';
import type { ResearchCheckpoint, StoredPage } from '../server/research/research-store.js';
import { allocateSourceKey, rememberSourceKeys } from '../server/research/source-keys.js';
import { runResearch } from '../server/research/controller.js';
import { renderJson, renderMarkdown } from '../shared/canonical.js';
import { renderReportHtml } from '../shared/report-html.js';

const OWNER = 'user-owner';
const HOME = 'https://release-fixture-one.org/';
const OTHER = 'https://release-fixture-two.org/';
const QUOTE = 'I write public compiler notes.';
const page = (sourceKey: string, url: string, text = QUOTE): StoredPage => ({
  sourceKey, url, title: 'Synthetic original', text, kind: 'profile', publishedAt: null,
  links: [], limitations: [], retrieval: 'read'
});
function add(f: SeededFirstStep, runId: string, p: StoredPage) {
  f.store.addSource(runId, { key: p.sourceKey, url: p.url, title: p.title, kind: p.kind,
    publishedAt: null, excerpt: p.text, excerptLocator: 'synthetic original', identityLabel: 'Synthetic account',
    identityConfirmed: true, fetchStatus: 'ok', limits: [] }, 0);
}
function select(f: SeededFirstStep, independent: boolean) {
  const result = f.firstStep.getFirstStepView(OWNER, f.run.id)!;
  if (result.mode !== 'first_step') throw new Error('wrong fixture mode');
  f.firstStep.applyFirstStepSelection(OWNER, f.run.id, {
    expectedRunRevision: f.store.getRun(f.run.id)!.revision,
    expectedScopeVersion: result.view.selection.scopeVersion,
    discoveryRevision: result.view.discoveryRevision,
    clusterId: independent ? null : result.view.clusters[0]!.clusterId,
    accounts: result.view.accounts.map(a => ({ accountId: a.accountId, selection: independent ? 'only_this_account' : 'selected', excluded: false }))
  }, null);
}
function completed(f: SeededFirstStep, extras: StoredPage[] = []): ResearchCheckpoint {
  const cp = f.store.research.checkpoint(f.run.id)!;
  cp.anchorUrl = HOME;
  cp.identity = { displayName: 'Synthetic person', handle: null, profileUrl: HOME, status: 'resolved', note: null, candidates: [] };
  cp.pages = [page('S1', HOME), ...extras];
  cp.claims = [{ sourceKey: 'S1', quote: QUOTE, statement: QUOTE, kind: 'page_statement', section: 'work' }];
  f.store.research.save(f.run.id, cp);
  cp.pages.forEach(p => add(f, f.run.id, p));
  f.store.updateRun(f.run.id, { state: 'completed', identity_json: JSON.stringify(cp.identity),
    answer_json: JSON.stringify([{ id: 'work', heading: 'Work', body: 'Synthetic scoped narrative', bullets: [{ text: QUOTE, sourceKeys: ['S1'], kind: 'page_statement' }] }]) });
  return cp;
}

test('runner keeps historical S2 and allocates distinct S3 after selected corpus filtering', async () => {
  const f = seedFirstStep({ accounts: [{ url: HOME }, { url: OTHER }] });
  const old = [page('S1', 'https://unselected-release-fixture.org/'), page('S2', HOME, 'Saved original text.')];
  f.store.research.save(f.run.id, { phase: 'needs_input', steps: 0, startedAt: Date.now(), elapsedMs: 0,
    anchorUrl: null, identity: null, candidates: [], pages: old, claims: [], unknowns: [], stopReason: null });
  old.forEach(p => add(f, f.run.id, p));
  select(f, true);
  const runner = new Runner({ store: f.store, firstStep: f.firstStep,
    config: { researchLimits: { toolCalls: 50, modelCalls: 10, inputTokens: 150000, outputTokens: 16000, elapsedMs: 0 }, deepseekApiKey: null } as AppConfig,
    providerFactory() { throw Error('no provider'); }, transport: { async fetch() { throw Error('no network'); } },
    researchTools: { async execute(action) { return { pages: [page('', 'url' in action ? action.url : OTHER, 'Fresh original text.')], requests: 1, bytes: 1, estimatedUsd: 0, credits: 0, limitations: [] }; } },
    researchPlanner: { async decide() { return { action: 'finish', claims: [], unknowns: [] }; } }
  });
  try {
    runner.enqueue(f.run.id);
    await waitFor(() => runner.activeCount() === 0 && f.store.getRun(f.run.id)!.state !== 'queued');
    assert.deepEqual(f.store.research.checkpoint(f.run.id)!.pages.map(p => [p.sourceKey, p.url]), [['S2', HOME], ['S3', OTHER]]);
    assert.equal(f.store.getSource(f.run.id, 'S2')!.excerpt, 'Saved original text.');
    assert.equal(f.store.getSource(f.run.id, 'S3')!.url, OTHER);
    f.store.setSourceExcluded(f.run.id, 'S3', true);
    assert.equal(f.store.getSource(f.run.id, 'S2')!.excluded, false);
  } finally { runner.stopAll(); f.close(); }
});

test('controller ingestion also allocates above retained and historical ordinals', async () => {
  const f = seedFirstStep({ accounts: [{ url: HOME }] });
  try {
    const original = { ...page('S2', HOME), links: [OTHER] };
    f.store.research.save(f.run.id, { phase: 'planning', steps: 0, startedAt: Date.now(), elapsedMs: 0,
      anchorUrl: HOME, identity: { displayName: 'Synthetic', handle: null, profileUrl: HOME, status: 'resolved', note: null, candidates: [] },
      candidates: [], pages: [original], claims: [], unknowns: [], stopReason: null });
    add(f, f.run.id, original);
    let decisions = 0;
    await runResearch({ store: f.store, run: f.store.getRun(f.run.id)!, signal: new AbortController().signal,
      tools: { async execute() { return { pages: [page('', OTHER)], requests: 1, bytes: 1, estimatedUsd: 0, credits: 0, limitations: [] }; } },
      planner: { async decide() { return decisions++ === 0 ? { action: 'read', url: OTHER } : { action: 'finish', claims: [], unknowns: [] }; } }
    });
    assert.deepEqual(f.store.research.checkpoint(f.run.id)!.pages.map(p => p.sourceKey), ['S2', 'S3']);
    assert.equal(f.store.getSource(f.run.id, 'S2')!.excerpt, QUOTE);
  } finally { f.close(); }
});

test('filtered historical key watermark survives real SQLite close/reopen with no retained pages', async () => {
  const f = seedFirstStep({ accounts: [{ url: HOME }] });
  const directory = mkdtempSync(join(tmpdir(), 'stripsearch-watermark-'));
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    const cp: ResearchCheckpoint = { phase: 'planning', steps: 0, startedAt: 0, elapsedMs: 0,
      anchorUrl: null, identity: null, candidates: [], pages: [page('S99', HOME)], claims: [], unknowns: [], stopReason: null };
    rememberSourceKeys(cp, ['S101']);
    cp.pages = [];
    f.store.research.save(f.run.id, cp);
    f.store.replaceSources(f.run.id, []);
    await f.db.backup(join(directory, 'reopen.sqlite'));
    f.close();
    reopened = openDatabase(join(directory, 'reopen.sqlite'));
    const saved = new Store(reopened).research.checkpoint(f.run.id)!;
    assert.equal(allocateSourceKey(saved), 'S102');
    assert.equal(saved.pages.length, 0);
  } finally { reopened?.close(); if (f.db.open) f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('scope withdrawal invalidates completed and descendant report/export projections without rewriting history', () => {
  const f = seedFirstStep({ accounts: [{ url: HOME }] });
  try {
    select(f, false);
    const cp = completed(f);
    const history = JSON.stringify(cp);
    const ids = [f.run.id];
    for (const relation of ['parent', 'retry'] as const) {
      const child = f.store.insertRun({ ownerId: OWNER, question: 'Synthetic descendant', seedUrl: HOME, provider: 'research',
        parentRunId: relation === 'parent' ? f.run.id : null, retryOf: relation === 'retry' ? f.run.id : null,
        followup: relation === 'parent', idempotencyKey: null, bodyFingerprint: relation });
      const { firstStep: _binding, ...legacyChild } = cp;
      f.store.research.save(child.id, { ...legacyChild, pages: [{ ...cp.pages[0]!, inheritedFrom: { runId: f.run.id, sourceKey: 'S1' } }] });
      add(f, child.id, cp.pages[0]!);
      f.store.updateRun(child.id, { state: 'completed', identity_json: JSON.stringify(cp.identity), answer_json: JSON.stringify(f.store.getRun(f.run.id)!.answer) });
      assert.equal(f.store.buildCanonicalView(f.store.getRun(child.id)!).identity.status, 'resolved');
      ids.push(child.id);
    }
    f.store.cases.applyScopeChange({ ownerId: OWNER, caseId: f.caseId, expectedScopeVersion: f.store.cases.getCase(OWNER, f.caseId)!.scopeVersion,
      reason: 'synthetic withdrawal', accounts: [{ accountId: f.accountIds[0]!, userSelection: { state: 'not_selected', note: null, recordedAt: new Date().toISOString() }, allowedScope: { state: 'none', note: 'withdrawn' } }] });
    for (const id of ids) {
      const view = f.store.buildCanonicalView(f.store.getRun(id)!);
      assert.equal(view.state, 'partial'); assert.equal(view.stopReason, 'scope_changed');
      assert.equal(view.identity.status, 'ambiguous'); assert.equal(view.personObject, undefined);
      assert.equal(view.sources[0]!.excluded, true); assert.equal(view.answer[0]!.bullets[0]!.validity, 'review');
      assert.equal(view.answer[0]!.body, '');
      assert.equal(f.store.summarize(f.store.getRun(id)!).state, 'partial');
      for (const rendered of [renderJson(view), renderMarkdown(view), renderReportHtml(view)]) assert.ok(rendered.includes('范围已变更或撤回'));
      assert.equal(f.store.getRun(id)!.state, 'completed'); assert.equal(f.store.getSource(id, 'S1')!.excerpt, QUOTE);
      assert.equal(f.store.getRun(id)!.answer[0]!.body, 'Synthetic scoped narrative');
    }
    assert.equal(JSON.stringify(f.store.research.checkpoint(f.run.id)), history);
  } finally { f.close(); }
});

test('independent original keeps its own material when another anchor is withdrawn, but explicit dependencies remain effective', () => {
  const f = seedFirstStep({ accounts: [{ url: HOME }, { url: OTHER }] });
  try {
    select(f, true);
    const cp = f.store.research.checkpoint(f.run.id)!;
    cp.anchorUrl = HOME; cp.pages = [page('S1', HOME, 'I wrote parser one.'), page('S2', OTHER, 'I wrote parser two.')];
    cp.independentMaterials = cp.pages.map(p => ({ sourceKey: p.sourceKey, sourceUrl: p.url, quote: p.text, quoteOffset: 0, sourceContentHash: createHash('sha256').update(p.text).digest('hex') }));
    f.store.research.save(f.run.id, cp); cp.pages.forEach(p => add(f, f.run.id, p));
    f.store.setSourceExcluded(f.run.id, 'S1', true);
    const view = f.store.buildCanonicalView(f.store.getRun(f.run.id)!);
    assert.equal(view.sources.find(s => s.sourceKey === 'S2')!.excluded, false);
    assert.deepEqual(view.research!.accountMaterials!.map(m => m.sourceKey), ['S2']);
    for (const rendered of [renderJson(view), renderMarkdown(view), renderReportHtml(view)]) assert.ok(rendered.includes('I wrote parser two.'));
    assert.equal(f.store.research.checkpoint(f.run.id)!.independentMaterials!.length, 2);
    cp.pages[1]!.discoveredFrom = ['S1']; f.store.research.save(f.run.id, cp);
    assert.equal(f.store.isResearchSourceActive(f.run.id, 'S2', OWNER), false);
    assert.equal(f.store.buildCanonicalView(f.store.getRun(f.run.id)!).research!.accountMaterials!.length, 0);
  } finally { f.close(); }
});

test('person material still depends on its person anchor original', () => {
  const f = seedFirstStep({ accounts: [{ url: HOME }] });
  try {
    select(f, false); completed(f, [page('S2', HOME + 'notes')]);
    assert.equal(f.store.isResearchSourceActive(f.run.id, 'S2', OWNER), true);
    f.store.setSourceExcluded(f.run.id, 'S1', true);
    const view = f.store.buildCanonicalView(f.store.getRun(f.run.id)!);
    assert.equal(view.sources.find(s => s.sourceKey === 'S2')!.excluded, true);
    assert.equal(view.personObject, undefined);
  } finally { f.close(); }
});
