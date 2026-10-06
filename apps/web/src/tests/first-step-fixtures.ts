/**
 * Shared seeding helper for first-step store/scope tests. It drives the REAL
 * FirstStepStore persistence path (attach -> recordDiscoveredAccount ->
 * recordIdentityObservation -> appendDiscoveryRevision), so tests exercise the
 * same writes the discovery coordinator uses.
 */

import { createHash } from 'node:crypto';
import { applyCoreSchema, openDatabase, type DB } from '../server/db/index.js';
import { Store } from '../server/store.js';
import type { RunRecord } from '../server/store.js';
import {
  FirstStepStore,
  firstStepAccountId
} from '../server/research/first-step-store.js';
import {
  FIRST_STEP_SCHEMA_VERSION,
  classifyFirstStepUrl,
  freezeFirstStepObligations,
  type FirstStepAccountCategory,
  type FirstStepAccountRef,
  type FirstStepAccountView,
  type FirstStepDiscoveryView,
  type FirstStepFrozenPlan,
  type FirstStepInput,
  type FirstStepPersonClusterView
} from '../shared/first-step-discovery.js';
import { asScopeVersion, type IdentitySupportState } from '../shared/research-case.js';

export interface SeedAccountInput {
  /** Full profile URL; classification derives the conservative account key. */
  url: string;
  displayName?: string;
  identityState?: IdentitySupportState;
  /** Read identity-support observation from this source page URL. */
  supportedBy?: { sourceUrl: string; quote?: string } | null;
  deniedBy?: { sourceUrl: string; quote?: string } | null;
  accountKind?: FirstStepAccountRef['accountKind'];
}

export interface SeedOptions {
  ownerId?: string;
  question?: string;
  input?: FirstStepInput;
  accounts: SeedAccountInput[];
  readyForChoice?: boolean;
}

export interface SeededFirstStep {
  db: DB;
  store: Store;
  firstStep: FirstStepStore;
  run: RunRecord;
  caseId: string;
  plan: FirstStepFrozenPlan;
  discoveryRevision: number;
  accountIds: string[];
  accountIdFor(index: number): string;
  accountViewFor(index: number): FirstStepAccountView;
  /** Simulate a new discovery revision (e.g. a manual hint expansion). */
  republish(mutate?: (view: FirstStepDiscoveryView) => FirstStepDiscoveryView): number;
  /** Completed synthetic discovery reads already counted before Fetch. */
  initialToolCalls: number;
  close(): void;
}

function refFor(input: SeedAccountInput): FirstStepAccountRef {
  const classified = classifyFirstStepUrl(input.url);
  if (!classified.ok) throw new Error(`seed URL did not classify: ${input.url}`);
  return classified.ref;
}

function categoryFor(ref: FirstStepAccountRef): FirstStepAccountCategory {
  switch (ref.materialUse) {
    case 'identity_anchor':
    case 'technical_work':
      return 'identity_work';
    case 'writing':
      return 'writing';
    case 'expression':
    case 'community':
      return 'expression';
    case 'video_audio':
      return 'video_audio';
    case 'academic':
      return 'academic';
    default:
      return 'related_material';
  }
}

function accountView(ref: FirstStepAccountRef, accountId: string, caseId: string, state: IdentitySupportState, evidenceIds: string[]): FirstStepAccountView {
  return {
    accountId,
    caseId,
    accountKey: ref.accountKey,
    platform: ref.platform,
    platformLabel: ref.platformLabel,
    displayName: ref.handle,
    handle: ref.handle,
    instance: ref.instance,
    profileUrl: ref.profileUrl,
    category: categoryFor(ref),
    materialUse: ref.materialUse,
    accountKind: ref.accountKind,
    identity: {
      state,
      basis: state === 'supported' ? 'explicit_self_link' : state === 'rejected' ? 'explicit_denial' : 'shared_handle',
      basisLabel: '测试投影',
      evidence: evidenceIds.map((evidenceId) => ({
        evidenceId,
        sourceId: `src-${evidenceId}`,
        sourceRevision: 1,
        sourceUrl: 'https://lantern.dev/about',
        sourceTitle: '合成 About',
        sourceLocator: 'Accounts 区',
        sourceRetrievedAt: '2026-10-05T00:00:00.000Z',
        role: 'identity_support' as const,
        quote: '合成测试摘录',
        locator: 'Accounts 区',
        retrieval: 'read' as const,
        label: '测试归属依据',
        limitation: '合成测试依据；不代表跨平台身份已核实。',
        observedAt: '2026-10-05T00:00:00.000Z'
      })),
      counterevidence: [],
      conflicts: []
    },
    userSelection: { state: 'unanswered', note: null, recordedAt: null },
    allowedScope: { state: 'none', note: null },
    researchValue: { state: 'unassessed', rationale: null },
    accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null },
    researchSummary: '合成测试研究价值',
    accessLabel: '尚未检查',
    defaultSuggestion: { suggested: state === 'supported', reason: '测试建议规则' },
    requiresIndependentScope: state !== 'supported'
  };
}

export function seedFirstStep(options: SeedOptions): SeededFirstStep {
  const db = openDatabase(':memory:');
  applyCoreSchema(db);
  const store = new Store(db);
  const firstStep = new FirstStepStore(db, store);
  const ownerId = options.ownerId ?? 'user-owner';
  const question = options.question ?? '研究这位创作者的公开作品';
  const input: FirstStepInput = options.input ?? { kind: 'name_query', value: '林舟', question };
  const run = store.insertRun({
    ownerId,
    question,
    seedUrl: null,
    provider: 'research',
    parentRunId: null,
    retryOf: null,
    followup: false,
    idempotencyKey: null,
    bodyFingerprint: createHash('sha256').update(question).digest('hex')
  });
  const link = firstStep.attachRun(run);
  const caseId = link.caseId;
  const plan = freezeFirstStepObligations(input, {
    registryVersion: 'registry-test/v1',
    now: '2026-10-05T00:00:00.000Z'
  });
  const scopeVersion = asScopeVersion(1);
  // Several observations from one synthetic page share one immutable original
  // and one completed receipt, just as the actual coordinator does.
  const supportQuote=(seed:SeedAccountInput)=>seed.supportedBy?.quote??`<p>My profile: <a href="${seed.url}">My account</a></p>`;
  const originals=new Map<string,string>();
  for(const seed of options.accounts){if(seed.supportedBy){const url=seed.supportedBy.sourceUrl;originals.set(url,[originals.get(url),supportQuote(seed)].filter(Boolean).join('\n\n'));}}
  const views: FirstStepAccountView[] = [];
  const accountIds: string[] = [];
  for (const seed of options.accounts) {
    const ref = refFor(seed);
    const accountId = firstStepAccountId(caseId, ref.accountKey);
    accountIds.push(accountId);
    firstStep.recordDiscoveredAccount({
      ownerId,
      caseId,
      expectedScopeVersion: scopeVersion,
      ref,
      displayName: seed.displayName ?? ref.handle,
      researchSummary: '合成测试研究价值',
      researchValue: { state: 'unassessed', rationale: null },
      accessCoverage: { state: 'unassessed', earliestReadAt: null, note: null }
    });
    const evidenceIds: string[] = [];
    if (seed.supportedBy) {
      const quote=supportQuote(seed), original=originals.get(seed.supportedBy.sourceUrl)!;
      const recorded = firstStep.recordIdentityObservation({
        ownerId,
        caseId,
        accountId,
        expectedScopeVersion: scopeVersion,
        source: {
          url: seed.supportedBy.sourceUrl,
          title: '合成来源',
          author: null,
          retrievedAt: '2026-10-05T00:00:00.000Z',
          contentHash: createHash('sha256').update(original).digest('hex'),
          locator: 'Accounts 区'
        },
        role: 'identity_support',
        quote,
        evidenceLocator: 'Accounts 区'
      });
      evidenceIds.push(recorded.evidenceId);
      const receiptKey=`synthetic-original-${createHash('sha256').update(seed.supportedBy.sourceUrl).digest('hex')}`;
      store.research.reserve(run.id,receiptKey,'tool',{type:'read',url:seed.supportedBy.sourceUrl},{inputTokens:0,outputTokens:0});
      store.research.settle(run.id,receiptKey,{pages:[{url:seed.supportedBy.sourceUrl,title:'Synthetic original',text:original,kind:'profile',retrieval:'read',links:[seed.url],limitations:[],publishedAt:null}]},{inputTokens:0,outputTokens:0,estimatedUsd:0});
    }
    if (seed.deniedBy) {
      firstStep.recordIdentityObservation({
        ownerId,
        caseId,
        accountId,
        expectedScopeVersion: scopeVersion,
        source: {
          url: seed.deniedBy.sourceUrl,
          title: '合成否认来源',
          author: null,
          retrievedAt: '2026-10-05T00:00:00.000Z',
          contentHash: createHash('sha256').update(seed.deniedBy.sourceUrl).digest('hex'),
          locator: '声明区'
        },
        role: 'identity_counterevidence',
        quote: seed.deniedBy.quote ?? '不是我',
        evidenceLocator: '声明区'
      });
    }
    const state: IdentitySupportState =
      seed.identityState ?? (seed.supportedBy && !seed.deniedBy ? 'supported' : seed.deniedBy && !seed.supportedBy ? 'rejected' : 'proposed');
    views.push(accountView(ref, accountId, caseId, state, evidenceIds));
  }
  const cluster: FirstStepPersonClusterView = {
    clusterId: 'cluster-1',
    displayName: '林舟',
    anchorUrl: views[0]?.profileUrl ?? null,
    anchorLabel: '合成锚点',
    anchorAccountId: views[0]?.accountId ?? null,
    linkage: 'linked',
    anchorBasis: null,
    leads: [],
    conflicts: [],
    accountIds: views.map((view) => view.accountId)
  };
  const buildView = (): FirstStepDiscoveryView => ({
    schemaVersion: FIRST_STEP_SCHEMA_VERSION,
    runId: run.id,
    caseId,
    discoveryRevision: 0,
    inputRevision: 1,
    registryVersion: 'registry-test/v1',
    catalogHash: null,
    policyVersion: 'first-step/v2',
    phase: 'ready_for_choice',
    stopReason: null,
    readyForChoice: options.readyForChoice ?? true,
    input,
    clusters: [cluster],
    accounts: views,
    relatedLeads: [],
    routes: [],
    gaps: [],
    receipts: [],
    budget: { toolCalls: 2, modelCalls: 0, estimatedUsd: 0.002, unknownCost: false },
    selection: { scopeVersion: 0, frozenScopeVersion: null, submitted: false, submittedAt: null, selectedAccountIds: [], excludedAccountIds: [] },
    updatedAt: '2026-10-05T00:00:00.000Z'
  });
  const published = firstStep.appendDiscoveryRevision({
    runId: run.id,
    input,
    plan,
    view: buildView(),
    phase: 'ready_for_choice',
    readyForChoice: options.readyForChoice ?? true,
    stopReason: 'initial_wave_complete'
  });
  // The run waits for the one scope confirmation.
  store.updateRun(run.id, { state: 'needs_input' });
  store.addEvent(run.id, 'needs_input', { prompt: '请确认人物与研究账号范围。', revision: store.getRun(run.id)!.revision });

  const seeded: SeededFirstStep = {
    db,
    store,
    firstStep,
    run,
    caseId,
    plan,
    discoveryRevision: published.discoveryRevision,
    accountIds,
    initialToolCalls: store.research.budget(run.id).toolCalls,
    accountIdFor: (index) => accountIds[index]!,
    accountViewFor: (index) => views[index]!,
    republish(mutate) {
      const next = mutate ? mutate(buildView()) : buildView();
      const record = firstStep.appendDiscoveryRevision({
        runId: run.id,
        input,
        plan,
        view: next,
        phase: 'ready_for_choice',
        readyForChoice: true,
        stopReason: 'expanded'
      });
      return record.discoveryRevision;
    },
    close() {
      db.close();
    }
  };
  return seeded;
}

export function asRecordValue(raw: unknown): Record<string, unknown> {
  return raw as Record<string, unknown>;
}
