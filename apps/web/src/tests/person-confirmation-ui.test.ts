/**
 * GET-213 client authority: the person-confirmation stage renders source-
 * backed candidates (quoted originals visibly distinct from index clues),
 * submits ONLY versions + one immutable candidate id, refuses double submits
 * while pending, shows safe actionable billing status (no spinner, no auto
 * retry), and hands the run to the existing GET-210 account workspace after
 * confirmation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom } from './dom-env.js';
import { seedFirstStep } from './first-step-fixtures.js';
import { createFirstStepPanel, type FirstStepPanelApi } from '../client/first-step.js';
import type { PersonConfirmationPayload } from '../client/api.js';
import type { FirstStepDiscoveryView } from '../shared/first-step-discovery.js';
import type { PersonOverviewView } from '../shared/person-confirmation.js';

const env = installDom();

for (const keepIds of [false, true]) test(`a new discovery resets the previous multi-person choice (same source ids=${keepIds})`, async t => {
  const fixture = seedFirstStep({ accounts: [{ url: 'https://github.com/linzhou' }] });t.after(() => fixture.close());
  const base = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
  assert.ok(base && base.mode === 'first_step');
  let current = withOverview(base.view, overviewFixture());let writes = 0;
  const container = env.document.createElement('section');env.document.body.appendChild(container);
  const panel = createFirstStepPanel({ runId: fixture.run.id, container, api: {
    getFirstStepDiscovery: async () => ({ mode: 'first_step', view: current, runRevision: 3 }),
    expandFirstStep: async () => { throw new Error('Unexpected expansion'); },
    submitFirstStepSelection: async () => { throw new Error('Unexpected account scope'); },
    confirmPerson: async () => { writes++;throw new Error('No stale confirmation should be sent'); }
  } });
  t.after(() => { panel.destroy();container.remove(); });await panel.refresh();
  const radio = container.querySelector<HTMLInputElement>('input[type=radio]')!;
  radio.checked = true;radio.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  assert.equal(container.querySelector<HTMLButtonElement>('[data-focus-key=person-confirm]')!.disabled, false);
  current = structuredClone(current);current.discoveryRevision++;current.inputRevision++;
  current.personOverview!.attemptId = 'a-new-synthetic-attempt';
  if (!keepIds) current.personOverview!.candidates.forEach((c, i) => { c.candidateId = 'pcand/' + String(i + 3).repeat(32); });
  await panel.refresh();
  assert.equal(container.querySelectorAll('input[type=radio]:checked').length, 0);
  assert.equal(container.querySelector<HTMLButtonElement>('[data-focus-key=person-confirm]')!.disabled, true);
  await panel.submit();assert.equal(writes, 0);
});

function overviewFixture(serviceError: PersonOverviewView['serviceError'] = null): PersonOverviewView {
  return {
    schemaVersion: 'stripsearch/person-confirmation/v1',
    policyVersion: 'first-step/v11',
    attemptId: '1-synthetic',
    queryLabel: 'Mira Kepler',
    status: serviceError ? 'service_error' : 'awaiting_confirmation',
    candidates: serviceError
      ? []
      : [
          {
            candidateId: 'pcand/11111111111111111111111111111111',
            displayName: 'Mira Kepler',
            queryLabel: 'Mira Kepler',
            anchorSourceKey: 'psrc/aaaaaaaaaaaaaaaaaaaaaaaa',
            sources: [
              {
                sourceKey: 'psrc/aaaaaaaaaaaaaaaaaaaaaaaa',
                url: 'https://compiler.example/bio/mira',
                title: 'Mira Kepler — Compiler Profile',
                retrieval: 'read',
                contentHash: 'sha256:deadbeef',
                retrievedAt: '2026-10-21T00:00:00.000Z',
                quote: 'Mira Kepler is a compiler researcher.',
                locator: '原文第 1–32 字符',
                note: '原文已读取并保留内容哈希与摘录定位；人物归属未确认。'
              },
              {
                sourceKey: 'psrc/bbbbbbbbbbbbbbbbbbbbbbbb',
                url: 'https://index.example/mira-kepler',
                title: 'Mira Kepler (@mkepler)',
                retrieval: 'indexed',
                contentHash: null,
                retrievedAt: null,
                quote: null,
                locator: null,
                note: '搜索索引线索，不是原文；不能作为原文、身份或归属依据。'
              }
            ],
            descriptors: [
              { atomId: 'patom/1', statement: '来源标题：Mira Kepler — Compiler Profile', kind: 'source_title', sourceKey: 'psrc/aaaaaaaaaaaaaaaaaaaaaaaa', quote: null, locator: null },
              { atomId: 'patom/2', statement: 'Mira Kepler is a compiler researcher.', kind: 'source_excerpt', sourceKey: 'psrc/aaaaaaaaaaaaaaaaaaaaaaaa', quote: 'Mira Kepler is a compiler researcher.', locator: '原文第 1–32 字符' }
            ],
            counterevidence: [],
            unknowns: ['人物归属未确认：确认人物只是用户意图。']
          },
          {
            candidateId: 'pcand/22222222222222222222222222222222',
            displayName: 'Mira Kepler',
            queryLabel: 'Mira Kepler',
            anchorSourceKey: 'psrc/cccccccccccccccccccccccc',
            sources: [
              {
                sourceKey: 'psrc/cccccccccccccccccccccccc',
                url: 'https://marine.example/staff/mira',
                title: 'Mira Kepler — Marine Profile',
                retrieval: 'read',
                contentHash: 'sha256:cafebabe',
                retrievedAt: '2026-10-21T00:00:00.000Z',
                quote: 'Mira Kepler studies coral reefs.',
                locator: '原文第 1–30 字符',
                note: '原文已读取并保留内容哈希与摘录定位；人物归属未确认。'
              }
            ],
            descriptors: [],
            counterevidence: [],
            unknowns: ['人物归属未确认：确认人物只是用户意图。']
          }
        ],
    coverage: {
      queryFamilies: [
        { family: 'home', state: 'completed', note: '已派发普通网页检索并留下真实回执；空结果不代表无资料，覆盖未验证。' },
        { family: 'work', state: serviceError ? 'deferred' : 'completed', note: serviceError ? '因供应商计费失败停止，本路线未派发、未计费；保留缺口，不自动重试。' : '已派发普通网页检索并留下真实回执；空结果不代表无资料，覆盖未验证。' }
      ],
      sourcesRead: serviceError ? 0 : 2,
      sourcesIndexed: serviceError ? 0 : 1,
      attemptsStopped: serviceError ? [{ supplier: 'exa', failure: serviceError, note: '同一供应商（exa）因计费失败已停止本尝试后续调用；未尝试的路线保留为缺口，不自动重试。' }] : []
    },
    gaps: [],
    serviceError,
    createdAt: '2026-10-21T00:00:00.000Z'
  };
}

function withOverview(view: FirstStepDiscoveryView, overview: PersonOverviewView): FirstStepDiscoveryView {
  return {
    ...view,
    personOverview: overview,
    personConfirmation: {
      required: true,
      status: 'awaiting',
      confirmedCandidateId: null,
      confirmedAt: null,
      confirmationRevision: null
    },
    accounts: [],
    clusters: [],
    readyForChoice: false
  };
}

test('the person stage submits only versions + candidate id and keeps quoted vs indexed sources visible', async (t) => {
  const fixture = seedFirstStep({ accounts: [{ url: 'https://github.com/linzhou' }] });
  t.after(() => fixture.close());
  const base = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
  assert.ok(base && base.mode === 'first_step');
  const view = withOverview(base.view, overviewFixture());
  const payloads: Array<{ payload: PersonConfirmationPayload; key: string }> = [];
  let confirmCalls = 0;
  let expands = 0;
  const api: FirstStepPanelApi = {
    getFirstStepDiscovery: async () => ({ mode: 'first_step', view, runRevision: 3 }),
    submitFirstStepSelection: async () => { throw new Error('selection must not run before person confirmation'); },
    expandFirstStep: async () => { expands++; return { queued: true }; },
    confirmPerson: async (_run, payload, key) => {
      confirmCalls++;
      payloads.push({ payload, key });
      if (confirmCalls === 1) throw new Error('synthetic request failure');
      return { confirmation: { runRevision: 4, candidateId: payload.candidateId, idempotent: false }, view: null };
    }
  };
  const container = env.document.createElement('section');
  env.document.body.appendChild(container);
  const panel = createFirstStepPanel({ api, container, runId: fixture.run.id });
  await panel.refresh();

  // Source-backed candidates with the quoted/indexed distinction.
  const text = container.textContent ?? '';
  assert.match(text, /原文已读取/);
  assert.match(text, /仅搜索索引可见/);
  assert.match(text, /搜索索引线索，不是原文/);
  assert.match(text, /原文第 1–32 字符/, 'exact quote spans keep their locators');
  assert.equal(container.querySelectorAll('.person-candidate').length, 2, 'same-name candidates stay separate');
  assert.equal(container.querySelectorAll('.first-step-select').length, 0, 'no account expansion before confirmation');

  // The confirm action is explicit and disabled until a candidate is chosen.
  const primary = container.querySelector<HTMLButtonElement>('.first-step-primary')!;
  assert.equal(primary.disabled, true, 'zero choice disables the confirm action');
  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  radios[1]!.click();
  const primary2 = container.querySelector<HTMLButtonElement>('.first-step-primary')!;
  assert.equal(primary2.disabled, false);
  await panel.submit();
  assert.equal(confirmCalls, 1);
  assert.deepEqual(Object.keys(payloads[0]!.payload).sort(), ['candidateId', 'discoveryRevision', 'expectedRunRevision', 'expectedScopeVersion'], 'no sources or text can ride along');
  assert.equal(payloads[0]!.payload.candidateId, 'pcand/22222222222222222222222222222222');

  // A failed confirm shows the error and a retry with the SAME intent reuses
  // the SAME idempotency key (double-click safety without duplicate records).
  assert.match(container.textContent ?? '', /synthetic request failure/, 'failures are visible, never a silent spinner');
  await panel.submit();
  assert.equal(confirmCalls, 2);
  assert.equal(payloads[1]!.key, payloads[0]!.key, 'the same intent reuses the idempotency key');
  assert.deepEqual(payloads[1]!.payload, payloads[0]!.payload);

  // A double click while a request is pending never fans out.
  const before = confirmCalls;
  void panel.submit();
  void panel.submit();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(confirmCalls <= before + 1, 'pending submits never fan out');
  assert.equal(expands, 0);
});

test('a billing failure shows an actionable service status and empty results invite manual clues', async (t) => {
  const fixture = seedFirstStep({ accounts: [{ url: 'https://github.com/linzhou' }] });
  t.after(() => fixture.close());
  const base = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
  assert.ok(base && base.mode === 'first_step');
  const billing = {
    code: 'provider_billing' as const,
    transient: false,
    serviceError: true,
    safeDetail: '供应商计费/额度失败（HTTP 402）：服务计费问题，需要运营方处理供应商账单后手动重试；本次不自动重试，费用未知。'
  };
  const view = withOverview(base.view, overviewFixture(billing));
  let expands = 0;
  const api: FirstStepPanelApi = {
    getFirstStepDiscovery: async () => ({ mode: 'first_step', view, runRevision: 3 }),
    submitFirstStepSelection: async () => { throw new Error('no selection during a service failure'); },
    expandFirstStep: async () => { expands++; return { queued: true }; }
  };
  const container = env.document.createElement('section');
  env.document.body.appendChild(container);
  const panel = createFirstStepPanel({ api, container, runId: fixture.run.id });
  await panel.refresh();
  const text = container.textContent ?? '';
  assert.match(text, /计费/, 'the safe billing status is visible');
  assert.match(text, /不是“没有这个人”/, 'a service failure is never a person conclusion');
  assert.match(text, /不会自动重试/);
  assert.ok(!/正在读取发现结果/.test(text), 'no permanent spinner over a service failure');
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('手动重新发现'))!;
  assert.ok(retry, 'an actionable manual retry path exists');
  retry.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(expands, 1, 'the retry is manual and explicit');
  assert.match(container.textContent ?? '', /没有找到可辨识的人物来源|计费/, 'empty/failed states stay actionable');
});

test('a confirmed person hands the run to the existing account workspace', async (t) => {
  const fixture = seedFirstStep({
    accounts: [
      { url: 'https://github.com/linzhou', supportedBy: { sourceUrl: 'https://fixture-linzhou.org/', quote: 'My GitHub: https://github.com/linzhou.' } },
      { url: 'https://x.com/linzhou', supportedBy: { sourceUrl: 'https://fixture-linzhou.org/', quote: 'My X: https://x.com/linzhou.' } }
    ]
  });
  t.after(() => fixture.close());
  const base = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
  assert.ok(base && base.mode === 'first_step');
  const confirmed: FirstStepDiscoveryView = {
    ...base.view,
    personOverview: overviewFixture(),
    personConfirmation: {
      required: true,
      status: 'confirmed',
      confirmedCandidateId: 'pcand/11111111111111111111111111111111',
      confirmedAt: '2026-10-21T00:00:00.000Z',
      confirmationRevision: 1
    }
  };
  const api: FirstStepPanelApi = {
    getFirstStepDiscovery: async () => ({ mode: 'first_step', view: confirmed, runRevision: 3 }),
    submitFirstStepSelection: async () => { throw new Error('not used'); },
    expandFirstStep: async () => ({ queued: true })
  };
  const container = env.document.createElement('section');
  env.document.body.appendChild(container);
  const panel = createFirstStepPanel({ api, container, runId: fixture.run.id });
  await panel.refresh();
  assert.ok(container.querySelectorAll('.first-step-select input[type="checkbox"]').length >= 2, 'the GET-210 account workspace renders after confirmation');
  assert.equal(container.querySelectorAll('.person-candidate').length, 0, 'the person stage is done');
});

test('source inspection and counterevidence remain available while pending person choices are locked', async (t) => {
  const fixture = seedFirstStep({ accounts: [{ url: 'https://github.com/linzhou' }] });
  t.after(() => fixture.close());
  const base = fixture.firstStep.getFirstStepView(fixture.run.ownerId, fixture.run.id);
  assert.ok(base && base.mode === 'first_step');
  const overview = overviewFixture();
  overview.candidates[0]!.counterevidence = ['合成反向线索：来源对同名人物有区分。'];
  const view = withOverview(base.view, overview);
  let finish!: (value: { confirmation: { runRevision: number; candidateId: string; idempotent: boolean } }) => void;
  const api: FirstStepPanelApi = {
    getFirstStepDiscovery: async () => ({ mode: 'first_step', view, runRevision: 3 }),
    submitFirstStepSelection: async () => { throw new Error('account selection must wait'); },
    expandFirstStep: async () => ({ queued: true }),
    confirmPerson: async () => new Promise((resolve) => { finish = resolve; })
  };
  const container = env.document.createElement('section');
  env.document.body.appendChild(container);
  const panel = createFirstStepPanel({ api, container, runId: fixture.run.id });
  t.after(() => { panel.destroy(); container.remove(); });
  await panel.refresh();
  assert.ok(container.querySelector('a[href]'), 'the actual source URL is inspectable');
  assert.match(container.textContent ?? '', /合成反向线索/);
  container.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
  const pending = panel.submit();
  assert.ok([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every((input) => input.disabled),
    'the submitted person cannot visually change while confirmation is pending');
  finish({ confirmation: { runRevision: 4, candidateId: overview.candidates[0]!.candidateId, idempotent: false } });
  await pending;
});
