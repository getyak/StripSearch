/**
 * GET-99 synthetic Fetch harness: a deterministic offline corpus and the
 * injected gateways the local Fetch controller runs against — provider
 * handlers plus the single metered executor seam (the synthetic "provider"),
 * a deterministic one-decision model gateway and case preparation that
 * registers REAL CaseStore source revisions (adapter-produced exact pins for
 * immutable complete full text).
 *
 * Everything is synthetic fixture data: no network, no real people, no paid
 * provider or model call. The synthetic pass never verifies a provider
 * profile. Listing excerpts are never body reads; body reads require the
 * exact pinned revision and canonical full-text hash. Real provider
 * ingestion remains pending.
 */

import { createHash } from 'node:crypto';

import type { Store } from '../store.js';
import { Store as StoreImpl } from '../store.js';
import type { DB } from '../db/index.js';
import type { RecordProvenance, ResearchCase, ScopeVersion } from '../../shared/research-case.js';
import type { CompletionScopeSpec, FrozenCompletionScope } from '../../shared/research-completion.js';
import { canonicalJson } from '../../shared/research-fetch-pipeline.js';
import type { FetchPipelineSummary } from '../../shared/research-fetch-pipeline.js';
import type {
  FetchCatalogAccount,
  FetchCatalogBranch,
  FetchCatalogComment,
  FetchCatalogItem,
  FetchCatalogNode,
  FetchPipelineOptions,
  FetchSourceCatalog
} from './fetch-pipeline.js';
import { createInitialCheckpoint, runFetchPipeline } from './fetch-pipeline.js';
import type { FetchPipelineStore } from './fetch-pipeline-store.js';
import { FetchPipelineStore as FetchPipelineStoreImpl } from './fetch-pipeline-store.js';
import type {
  MeteredRequestDescriptor,
  ProviderExecutorPort,
  ProviderResponse,
  RequestReservation,
  ResearchToolServer,
  ToolHandler
} from './research-tool-dispatch.js';
import { createResearchToolServer } from './research-tool-dispatch.js';
import type { RuntimeModelGateway, RuntimeModelRequest, RuntimeModelUsage } from './research-runtime.js';

export const SYNTHETIC_OWNER = 'owner-synthetic-harness';
export const SYNTHETIC_CASE_ID = 'case-synthetic-fetch-harness';
export const SYNTHETIC_REGISTRY_VERSION = 'synthetic-catalog/2026-10-07';

const PROVENANCE: RecordProvenance = {
  authorization: 'not_recorded',
  collector: 'synthetic-harness',
  note: null
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Scenario knobs (failure/edge injection, deterministic)             */
/* ------------------------------------------------------------------ */

export interface SyntheticScenario {
  /** Pages whose continuation cursor repeats an earlier native cursor. */
  cursorCycleAccounts?: string[];
  /** Accounts that serve one empty page with an OPEN cursor mid-listing. */
  emptyOpenCursorAccounts?: string[];
  /** Accounts whose second page repeats items from the first page. */
  repeatPageAccounts?: string[];
  /** Items whose adapter source pin is never prepared (must stay a gap). */
  unpinnedItems?: string[];
  /** Items whose returned body text is altered (source binding must refuse). */
  tamperedItems?: string[];
  /** Accounts whose read_media endpoint fails (per-platform isolation). */
  failMediaAccounts?: string[];
  /** Endpoints reporting unknown fees (null), never zero. */
  unknownFeeEndpoints?: string[];
}

/* ------------------------------------------------------------------ */
/* Deterministic corpus                                               */
/* ------------------------------------------------------------------ */

const SYNTHETIC_PROVENANCE_NOTE = 'synthetic fixture full text';

function fulltextFor(itemId: string, title: string): string {
  return [
    `${title} — synthetic fixture body (${SYNTHETIC_PROVENANCE_NOTE}).`,
    'This complete local original is synthetic; no real person or provider content is involved.',
    `Unique binding tail: ${itemId}.`
  ].join(' ');
}

function makeItem(
  accountId: string,
  platform: string,
  ordinal: number,
  config: {
    hasMedia: 'none' | 'present' | 'unknown';
    mediaText?: string | null;
    mediaCaptions?: string | null;
    mediaUnread?: boolean;
    publishedAt?: string | null;
    comments?: FetchCatalogComment[];
    branches?: FetchCatalogBranch[];
  }
): FetchCatalogItem {
  const suffix = `${platform === 'synthetic_alpha' ? 'alpha' : 'beta'}-${String(ordinal).padStart(2, '0')}`;
  const itemId = `itm-${suffix}`;
  const title = `Synthetic post ${suffix}`;
  const fulltext = fulltextFor(itemId, title);
  return {
    accountId,
    itemId,
    sourceId: `src-${suffix}`,
    sourceRevision: 1,
    title,
    publishedAt: config.publishedAt === undefined ? `2026-03-${String((ordinal % 27) + 1).padStart(2, '0')}` : config.publishedAt,
    fulltext,
    contentHash: sha256(fulltext),
    hasMedia: config.hasMedia,
    mediaRef: config.hasMedia === 'present' ? `media-${suffix}-1` : null,
    mediaText: config.mediaText ?? null,
    mediaCaptions: config.mediaCaptions ?? null,
    mediaUnread: config.mediaUnread ?? false,
    comments: config.comments ?? [],
    branches: config.branches ?? []
  };
}

function comment(
  itemId: string,
  commentId: string,
  authorAccountId: string,
  authorRole: 'subject' | 'third_party' | 'unknown',
  excerpt: string,
  flags: { important?: boolean; contradictory?: boolean } = {}
): FetchCatalogComment {
  return {
    commentId,
    authorName: authorAccountId,
    originalUrl: `https://fixture.test/comments/${encodeURIComponent(commentId)}`,
    parentCommentId: null,
    authorAccountId,
    authorRole,
    createdAt: '2026-03-15T10:00:00.000Z',
    excerpt,
    important: flags.important ?? false,
    contradictory: flags.contradictory ?? false
  };
}

function node(
  itemId: string,
  nodeId: string,
  parentNodeId: string | null,
  depth: number | null,
  authorAccountId: string,
  authorRole: 'subject' | 'third_party' | 'unknown',
  state: 'present' | 'missing' | 'deleted' | 'hidden',
  text: string | null
): FetchCatalogNode {
  return {
    nodeId,
    parentNodeId,
    depth,
    state,
    text: state === 'present' ? text : null,
    textUnavailableReason: state === 'present' ? null : state === 'deleted' ? 'comment deleted by author' : state === 'hidden' ? 'comment hidden by platform' : 'parent comment missing from the provider surface',
    authorAccountId,
    authorRole,
    createdAt: '2026-03-15T11:00:00.000Z'
  };
}

function branch(
  branchKey: string,
  parentRef: string,
  parentChain: FetchCatalogBranch['parentChain'],
  nodes: FetchCatalogNode[],
  options: { missingNodeIds?: string[]; depthReached?: number; truncated?: boolean } = {}
): FetchCatalogBranch {
  return {
    branchKey,
    parentRef,
    parentChain,
    nodes,
    missingNodeIds: options.missingNodeIds ?? [],
    depthReached: options.depthReached ?? 4
  };
}

/**
 * Deterministic two-account / two-platform corpus: 28 listed items (well over
 * the required 25) with complete full text, mixed media states, default first
 * comment pages and ten explicitly selectable branches plus two unselected
 * ones (kept as explicit gaps).
 */
export function buildSyntheticCorpus(scenario: SyntheticScenario = {}): FetchSourceCatalog {
  const alpha = 'acct-alpha';
  const beta = 'acct-beta';
  const thirdParty = 'acct-third-party';

  const alphaItems: FetchCatalogItem[] = [
    makeItem(alpha, 'synthetic_alpha', 1, {
      hasMedia: 'none',
      comments: [comment('itm-alpha-01', 'c-alpha-01-a', thirdParty, 'third_party', 'Third-party praise.')],
      branches: [
        branch('br-alpha-01', 'c-alpha-01-a', [{ commentKey: 'c-alpha-01-a', depth: 1, state: 'present' }], [
          node('itm-alpha-01', 'c-alpha-01-a', null, 1, thirdParty, 'third_party', 'present', 'Third-party praise.'),
          node('itm-alpha-01', 'c-alpha-01-b', 'c-alpha-01-a', 2, thirdParty, 'third_party', 'present', 'Reply kept with its own author role.')
        ])
      ]
    }),
    makeItem(alpha, 'synthetic_alpha', 2, { hasMedia: 'present', mediaText: 'Synthetic caption text for alpha-02.' }),
    makeItem(alpha, 'synthetic_alpha', 3, {
      hasMedia: 'none',
      comments: [
        comment('itm-alpha-03', 'c-alpha-03-a', thirdParty, 'third_party', 'Thread starter with missing parent context.'),
        comment('itm-alpha-03', 'c-alpha-03-b', alpha, 'subject', 'Subject author reply deep in the branch.')
      ],
      branches: [
        // Author reply DEEP in the selected branch with a missing ancestor.
        branch(
          'br-alpha-03',
          'c-alpha-03-a',
          [{ commentKey: 'c-alpha-03-a', depth: 1, state: 'missing' }],
          [
            node('itm-alpha-03', 'c-alpha-03-a', null, 1, thirdParty, 'third_party', 'missing', null),
            node('itm-alpha-03', 'c-alpha-03-b', 'c-alpha-03-a', 4, alpha, 'subject', 'present', 'Subject author reply deep in the branch.')
          ],
          { depthReached: 4 }
        )
      ]
    }),
    makeItem(alpha, 'synthetic_alpha', 4, { hasMedia: 'none' }),
    makeItem(alpha, 'synthetic_alpha', 5, {
      hasMedia: 'none',
      comments: [comment('itm-alpha-05', 'c-alpha-05-a', thirdParty, 'third_party', 'Long discussion.', { important: true })],
      branches: [
        branch('br-alpha-05', 'c-alpha-05-a', [{ commentKey: 'c-alpha-05-a', depth: 1, state: 'present' }], [
          node('itm-alpha-05', 'c-alpha-05-a', null, 1, thirdParty, 'third_party', 'present', 'Long discussion.'),
          node('itm-alpha-05', 'c-alpha-05-b', 'c-alpha-05-a', 2, thirdParty, 'third_party', 'present', 'Reply one.'),
          node('itm-alpha-05', 'c-alpha-05-c', 'c-alpha-05-b', 3, thirdParty, 'third_party', 'present', 'Reply two.'),
          node('itm-alpha-05', 'c-alpha-05-d', 'c-alpha-05-c', 4, thirdParty, 'third_party', 'present', 'Reply three.')
        ])
      ]
    }),
    makeItem(alpha, 'synthetic_alpha', 6, { hasMedia: 'none' }),
    makeItem(alpha, 'synthetic_alpha', 7, { hasMedia: 'present', mediaCaptions: 'Synthetic captions for alpha-07.' }),
    makeItem(alpha, 'synthetic_alpha', 8, {
      hasMedia: 'none',
      comments: [
        comment('itm-alpha-08', 'c-alpha-08-a', thirdParty, 'third_party', 'This contradicts the claimed timeline.', { contradictory: true })
      ],
      branches: [
        branch('br-alpha-08', 'c-alpha-08-a', [{ commentKey: 'c-alpha-08-a', depth: 1, state: 'present' }], [
          node('itm-alpha-08', 'c-alpha-08-a', null, 1, thirdParty, 'third_party', 'present', 'This contradicts the claimed timeline.')
        ])
      ]
    }),
    makeItem(alpha, 'synthetic_alpha', 9, { hasMedia: 'none' }),
    makeItem(alpha, 'synthetic_alpha', 10, { hasMedia: 'none' }),
    makeItem(alpha, 'synthetic_alpha', 11, { hasMedia: 'unknown' }),
    makeItem(alpha, 'synthetic_alpha', 12, { hasMedia: 'none', publishedAt: null }),
    makeItem(alpha, 'synthetic_alpha', 13, { hasMedia: 'none' }),
    makeItem(alpha, 'synthetic_alpha', 14, {
      hasMedia: 'none',
      comments: [
        comment('itm-alpha-14', 'c-alpha-14-a', thirdParty, 'third_party', 'Thread with a deleted parent.', { important: true })
      ],
      branches: [
        branch(
          'br-alpha-14',
          'c-alpha-14-a',
          [
            { commentKey: 'c-alpha-14-root', depth: 1, state: 'deleted' },
            { commentKey: 'c-alpha-14-a', depth: 2, state: 'present' }
          ],
          [
            node('itm-alpha-14', 'c-alpha-14-root', null, 1, thirdParty, 'third_party', 'deleted', null),
            node('itm-alpha-14', 'c-alpha-14-a', 'c-alpha-14-root', 2, thirdParty, 'third_party', 'present', 'Thread with a deleted parent.'),
            node('itm-alpha-14', 'c-alpha-14-b', 'c-alpha-14-a', 3, thirdParty, 'third_party', 'present', 'Third-party continuation.')
          ],
          { depthReached: 3 }
        )
      ]
    })
  ];

  const betaItems: FetchCatalogItem[] = [
    makeItem(beta, 'synthetic_beta', 1, { hasMedia: 'none' }),
    makeItem(beta, 'synthetic_beta', 2, {
      hasMedia: 'none',
      comments: [comment('itm-beta-02', 'c-beta-02-a', beta, 'subject', 'Subject author starts the thread.')],
      branches: [
        branch('br-beta-02', 'c-beta-02-a', [{ commentKey: 'c-beta-02-a', depth: 1, state: 'present' }], [
          node('itm-beta-02', 'c-beta-02-a', null, 1, beta, 'subject', 'present', 'Subject author starts the thread.'),
          node('itm-beta-02', 'c-beta-02-b', 'c-beta-02-a', 2, thirdParty, 'third_party', 'present', 'Third-party reply.')
        ])
      ]
    }),
    makeItem(beta, 'synthetic_beta', 3, { hasMedia: 'present', mediaText: 'Synthetic media text for beta-03.' }),
    makeItem(beta, 'synthetic_beta', 4, { hasMedia: 'none' }),
    makeItem(beta, 'synthetic_beta', 5, { hasMedia: 'unknown' }),
    makeItem(beta, 'synthetic_beta', 6, {
      hasMedia: 'none',
      comments: [comment('itm-beta-06', 'c-beta-06-a', thirdParty, 'third_party', 'Important branch.', { important: true })],
      branches: [
        branch('br-beta-06', 'c-beta-06-a', [{ commentKey: 'c-beta-06-a', depth: 1, state: 'present' }], [
          node('itm-beta-06', 'c-beta-06-a', null, 1, thirdParty, 'third_party', 'present', 'Important branch.'),
          node('itm-beta-06', 'c-beta-06-b', 'c-beta-06-a', 2, thirdParty, 'third_party', 'present', 'Reply.')
        ])
      ]
    }),
    makeItem(beta, 'synthetic_beta', 7, { hasMedia: 'none' }),
    makeItem(beta, 'synthetic_beta', 8, {
      hasMedia: 'none',
      comments: [
        comment('itm-beta-08', 'c-beta-08-a', thirdParty, 'third_party', 'Contradictory account of events.', { contradictory: true })
      ],
      branches: [
        branch('br-beta-08', 'c-beta-08-a', [{ commentKey: 'c-beta-08-a', depth: 1, state: 'present' }], [
          node('itm-beta-08', 'c-beta-08-a', null, 1, thirdParty, 'third_party', 'present', 'Contradictory account of events.')
        ])
      ]
    }),
    makeItem(beta, 'synthetic_beta', 9, { hasMedia: 'present', mediaText: 'Synthetic media text for beta-09.' }),
    makeItem(beta, 'synthetic_beta', 10, {
      hasMedia: 'none',
      comments: [comment('itm-beta-10', 'c-beta-10-a', thirdParty, 'third_party', 'Hidden parent thread.')],
      branches: [
        branch(
          'br-beta-10',
          'c-beta-10-a',
          [{ commentKey: 'c-beta-10-a', depth: 1, state: 'hidden' }],
          [
            node('itm-beta-10', 'c-beta-10-a', null, 1, thirdParty, 'third_party', 'hidden', null),
            node('itm-beta-10', 'c-beta-10-b', 'c-beta-10-a', 4, beta, 'subject', 'present', 'Subject reply under a hidden parent.')
          ],
          { depthReached: 4 }
        )
      ]
    }),
    makeItem(beta, 'synthetic_beta', 11, {
      hasMedia: 'none',
      comments: [
        comment('itm-beta-11', 'c-beta-11-a', thirdParty, 'third_party', 'Third-party attribution case.', { important: true })
      ],
      branches: [
        branch('br-beta-11', 'c-beta-11-a', [{ commentKey: 'c-beta-11-a', depth: 1, state: 'present' }], [
          node('itm-beta-11', 'c-beta-11-a', null, 1, thirdParty, 'third_party', 'present', 'Third-party attribution case.'),
          node('itm-beta-11', 'c-beta-11-b', 'c-beta-11-a', 2, thirdParty, 'third_party', 'present', 'Another third party.')
        ])
      ]
    }),
    makeItem(beta, 'synthetic_beta', 12, { hasMedia: 'present', mediaUnread: true }),
    makeItem(beta, 'synthetic_beta', 13, { hasMedia: 'unknown' }),
    makeItem(beta, 'synthetic_beta', 14, {
      hasMedia: 'none',
      comments: [comment('itm-beta-14', 'c-beta-14-a', thirdParty, 'third_party', 'Truncated branch.', { important: true })],
      branches: [
        branch(
          'br-beta-14',
          'c-beta-14-a',
          [{ commentKey: 'c-beta-14-a', depth: 1, state: 'present' }],
          [node('itm-beta-14', 'c-beta-14-a', null, 1, thirdParty, 'third_party', 'present', 'Truncated branch.')],
          { depthReached: 1, truncated: true }
        )
      ]
    })
  ];

  const pagesFor = (accountId: string, platform: string, items: FetchCatalogItem[]): FetchCatalogItem[][] => {
    const first = items.slice(0, 7);
    const second = items.slice(7);
    if (scenario.emptyOpenCursorAccounts?.includes(accountId)) {
      // One empty page with an OPEN cursor between the two real pages.
      return [first, [], second];
    }
    if (scenario.repeatPageAccounts?.includes(accountId)) {
      // A repeated listing page: already-seen items must never double count.
      return [first, [...second, ...first.slice(0, 2)]];
    }
    void platform;
    return [first, second];
  };

  const cursorsFor = (accountId: string, pageCount: number): (string | null)[] => {
    const cursors: (string | null)[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      if (scenario.cursorCycleAccounts?.includes(accountId)) {
        // Every page hands back the SAME continuation cursor: the controller
        // must detect the cycle instead of looping or claiming exhaustion.
        cursors.push(`cur-${accountId}`);
      } else if (index === pageCount - 1) {
        cursors.push(null);
      } else {
        cursors.push(`cur-${accountId}-${String(index + 1)}`);
      }
    }
    return cursors;
  };

  const accounts: FetchCatalogAccount[] = [alpha, beta].map((accountId) => {
    const platform = accountId === alpha ? 'synthetic_alpha' : 'synthetic_beta';
    const items = accountId === alpha ? alphaItems : betaItems;
    for (const item of items) item.accountId = accountId;
    const pages = pagesFor(accountId, platform, items);
    return {
      accountId,
      platform,
      handle: accountId === alpha ? 'ada-alpha' : 'bo-beta',
      profileUrl: `https://fixture.test/${accountId === alpha ? 'ada-alpha' : 'bo-beta'}`,
      pages,
      pageCursors: cursorsFor(accountId, pages.length)
    };
  });

  return { registryVersion: SYNTHETIC_REGISTRY_VERSION, accounts };
}

/* ------------------------------------------------------------------ */
/* Case preparation (real CaseStore revisions = exact source pins)     */
/* ------------------------------------------------------------------ */

export interface SyntheticCaseSetup {
  ownerId: string;
  caseId: string;
  scopeSpecId: string;
  scopeVersion: ScopeVersion;
  catalog: FetchSourceCatalog;
  record: ResearchCase;
  frozen: FrozenCompletionScope;
  created: boolean;
}

function syntheticSpec(): CompletionScopeSpec {
  return {
    questions: [
      {
        questionId: 'q-work',
        slot: 'work',
        text: '这个人实际做了什么？',
        applicability: 'applicable',
        applicabilityReason: '核心研究问题'
      }
    ],
    platformRegistry: {
      registryVersion: SYNTHETIC_REGISTRY_VERSION,
      entries: [
        {
          platformId: 'synthetic_alpha',
          label: 'Synthetic Alpha',
          applicability: 'applicable',
          applicabilityReason: '合成验证平台'
        },
        {
          platformId: 'synthetic_beta',
          label: 'Synthetic Beta',
          applicability: 'applicable',
          applicabilityReason: '合成验证平台'
        }
      ]
    },
    accountRange: { mode: 'researched_accounts', accountIds: [] },
    timeRange: { from: '2026-01-01', to: '2026-12-31' },
    threadDepth: 4,
    requiredChecks: [{ checkId: 'time', kind: 'time_coverage', required: ['2026'] }]
  };
}

/**
 * Creates (or re-binds on resume) the synthetic case: two accounts with
 * public_history scope and REAL immutable CaseStore source revisions for
 * every catalog item — the adapter-produced exact pins the pipeline requires.
 * On resume the catalog is re-bound from persisted pins by original URL +
 * content hash; a changed pin is refused, never silently rematerialized.
 */
export function prepareSyntheticCase(
  store: Store,
  catalog: FetchSourceCatalog,
  scenario: SyntheticScenario = {}
): SyntheticCaseSetup {
  const existing = store.cases.getCase(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID);
  if (existing) {
    const scopes = store.completion.listCompletionScopes(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID);
    const frozen = scopes[0];
    if (!frozen) throw new Error('synthetic resume: frozen scope missing');
    rebindCatalog(store, catalog, existing);
    return {
      ownerId: SYNTHETIC_OWNER,
      caseId: SYNTHETIC_CASE_ID,
      scopeSpecId: frozen.scopeSpecId,
      scopeVersion: existing.scopeVersion,
      catalog,
      record: existing,
      frozen,
      created: false
    };
  }
  const record = store.cases.createCase({
    ownerId: SYNTHETIC_OWNER,
    caseId: SYNTHETIC_CASE_ID,
    intent: 'Synthetic local fetch chain',
    provenance: PROVENANCE
  });
  const draftFor = (accountId: string, platform: string, handle: string, profileUrl: string) => ({
    accountId,
    platform,
    handle,
    profileUrl,
    identitySupport: {
      state: 'proposed' as const,
      evidenceIds: [],
      counterevidenceIds: [],
      policyVersion: 'identity-policy/v1',
      note: null
    },
    userSelection: { state: 'unanswered' as const, note: null, recordedAt: null },
    allowedScope: { state: 'none' as const, note: null },
    researchValue: { state: 'unassessed' as const, rationale: null },
    accessCoverage: { state: 'unassessed' as const, earliestReadAt: null, note: null }
  });
  for (const account of catalog.accounts) {
    store.cases.addAccount(
      {
        ownerId: SYNTHETIC_OWNER,
        caseId: SYNTHETIC_CASE_ID,
        accountId: account.accountId,
        expectedScopeVersion: record.scopeVersion
      },
      draftFor(account.accountId, account.platform, account.handle, account.profileUrl)
    );
  }
  store.cases.applyScopeChange({
    ownerId: SYNTHETIC_OWNER,
    caseId: SYNTHETIC_CASE_ID,
    expectedScopeVersion: record.scopeVersion,
    reason: 'synthetic authorized research scope',
    accounts: catalog.accounts.map((account) => ({
      accountId: account.accountId,
      userSelection: { state: 'selected' as const, note: 'synthetic', recordedAt: '2026-01-02' },
      allowedScope: { state: 'public_history' as const, note: 'synthetic' }
    }))
  });
  for (const account of catalog.accounts) {
    for (const page of account.pages) {
      for (const item of page) {
        if (scenario.unpinnedItems?.includes(item.itemId)) continue; // adapter gap
        const revision = store.cases.recordSourceRevision(
          {
            ownerId: SYNTHETIC_OWNER,
            caseId: SYNTHETIC_CASE_ID,
            accountId: account.accountId,
            expectedScopeVersion: store.cases.getCase(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID)!.scopeVersion
          },
          {
            author: account.handle,
            originalUrl: `https://fixture.test/${account.handle}/${item.itemId}`,
            title: item.title,
            publishedAt: item.publishedAt,
            retrievedAt: '2026-04-01T00:00:00.000Z',
            locator: item.itemId,
            contentHash: item.contentHash,
            provenance: PROVENANCE
          }
        );
        // Bind the catalog identity to the real persisted pin; never invent one.
        item.sourceId = revision.sourceId;
        item.sourceRevision = revision.sourceRevision;
      }
    }
  }
  const after = store.cases.getCase(SYNTHETIC_OWNER, SYNTHETIC_CASE_ID);
  const frozen = store.completion.freezeCompletionScope({
    ownerId: SYNTHETIC_OWNER,
    caseId: SYNTHETIC_CASE_ID,
    expectedScopeVersion: after!.scopeVersion,
    spec: syntheticSpec(),
    reason: 'synthetic fetch chain fixture'
  });
  return {
    ownerId: SYNTHETIC_OWNER,
    caseId: SYNTHETIC_CASE_ID,
    scopeSpecId: frozen.scopeSpecId,
    scopeVersion: after!.scopeVersion,
    catalog,
    record: after!,
    frozen,
    created: true
  };
}

function rebindCatalog(store: Store, catalog: FetchSourceCatalog, record: ResearchCase): void {
  // Resume: re-bind catalog items to the persisted exact pins via the
  // deterministic original URL; a hash mismatch is refused loudly.
  const report = store.cases.reportView(SYNTHETIC_OWNER, record.caseId);
  for (const account of catalog.accounts) {
    for (const page of account.pages) {
      for (const item of page) {
        const url = `https://fixture.test/${account.handle}/${item.itemId}`;
        const match = report.sources
          .flatMap((source) => source.revisions.map((revision) => ({ ...revision, accountId: source.accountId })))
          .find((revision) => revision.accountId === account.accountId && revision.originalUrl === url);
        if (!match) throw new Error(`synthetic resume: missing source pin for ${item.itemId}`);
        if (match.contentHash !== item.contentHash) {
          throw new Error(`synthetic resume: source pin hash changed for ${item.itemId}`);
        }
        item.sourceId = match.sourceId;
        item.sourceRevision = match.sourceRevision;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Injected synthetic gateways                                        */
/* ------------------------------------------------------------------ */

interface SyntheticQuery {
  tool: string;
  accountId: string;
  itemId?: string;
  mediaRef?: string;
  parentRef?: string;
  nativeCursor?: string | null;
}

function findItem(
  catalog: FetchSourceCatalog,
  accountId: string,
  itemId: string
): FetchCatalogItem | null {
  for (const account of catalog.accounts) {
    if (account.accountId !== accountId) continue;
    for (const page of account.pages) {
      for (const item of page) if (item.itemId === itemId) return item;
    }
  }
  return null;
}

function contentMeta(item: FetchCatalogItem, retrievedAt: string) {
  return {
    applicable: true as const,
    author: item.title,
    originalUrl: `https://fixture.test/${item.accountId}/${item.itemId}`,
    publishedAt: item.publishedAt,
    retrievedAt,
    sourceRevision: item.sourceRevision,
    locator: item.itemId
  };
}

/**
 * The single controlled synthetic transport: every provider request flows
 * through the metered executor seam. Payloads come from the deterministic
 * catalog; failure and tampering knobs are explicit scenario injections.
 */
export function createSyntheticExecutor(
  catalog: FetchSourceCatalog,
  scenario: SyntheticScenario = {}
): ProviderExecutorPort {
  return {
    async execute(
      _reservation: RequestReservation,
      descriptor: MeteredRequestDescriptor
    ): Promise<ProviderResponse> {
      const query = JSON.parse(descriptor.note) as SyntheticQuery;
      const unknownFee = (scenario.unknownFeeEndpoints ?? ['read_thread', 'read_media']).includes(query.tool);
      const fee = unknownFee ? null : { estimatedUsd: 0.001, credits: 1 };
      const account = catalog.accounts.find((entry) => entry.accountId === query.accountId);
      if (!account) return { status: 404, body: null, fee };
      if (query.tool === 'list_posts') {
        const index =
          query.nativeCursor == null ? 0 : account.pageCursors.findIndex((cursor) => cursor === query.nativeCursor) + 1;
        const page = account.pages[index];
        if (!page) return { status: 404, body: null, fee };
        return {
          status: 200,
          fee,
          body: {
            items: page.map((item) => ({
              itemId: item.itemId,
              sourceId: item.sourceId,
              sourceRevision: item.sourceRevision,
              authorAccountId: item.accountId,
              title: item.title,
              excerpt: item.fulltext.slice(0, 120),
              metadata: contentMeta(item, '2026-04-01T00:00:00.000Z')
            })),
            sort: 'provider_default',
            nativeCursor: account.pageCursors[index] ?? null
          }
        };
      }
      const item = findItem(catalog, query.accountId, query.itemId ?? '');
      if (!item) return { status: 404, body: null, fee };
      if (query.tool === 'read_post') {
        const tampered = scenario.tamperedItems?.includes(item.itemId) ?? false;
        return {
          status: 200,
          fee,
          body: {
            item: {
              itemId: item.itemId,
              sourceId: item.sourceId,
              sourceRevision: item.sourceRevision,
              authorAccountId: item.accountId,
              title: item.title,
              text: tampered ? `${item.fulltext} TAMPERED` : item.fulltext,
              metadata: contentMeta(item, '2026-04-02T00:00:00.000Z')
            }
          }
        };
      }
      if (query.tool === 'list_comments') {
        return {
          status: 200,
          fee,
          body: {
            items: item.comments.map((entry) => ({
              commentId: entry.commentId,
              rootItemId: item.itemId,
              parentCommentId: entry.parentCommentId,
              authorAccountId: entry.authorAccountId,
              authorRole: entry.authorRole,
              createdAt: entry.createdAt,
              excerpt: entry.excerpt,
              metadata: contentMeta(item, '2026-04-03T00:00:00.000Z')
            })),
            ordering: 'provider_default',
            nativeCursor: null
          }
        };
      }
      if (query.tool === 'read_media') {
        if (scenario.failMediaAccounts?.includes(query.accountId)) {
          return { status: 500, body: null, fee };
        }
        return {
          status: 200,
          fee,
          body: {
            mediaRef: item.mediaRef ?? query.mediaRef ?? '',
            text: item.mediaUnread ? null : item.mediaText,
            captions: item.mediaUnread ? null : item.mediaCaptions,
            mediaUnread: item.mediaUnread,
            conversion: { authorized: false, state: 'not_attempted', note: null },
            metadata: contentMeta(item, '2026-04-04T00:00:00.000Z')
          }
        };
      }
      if (query.tool === 'read_thread') {
        const target = item.branches.find((entry) => entry.parentRef === query.parentRef);
        if (!target) return { status: 404, body: null, fee };
        return {
          status: 200,
          fee,
          body: {
            nodes: target.nodes.map((entry) => ({
              nodeId: entry.nodeId,
              parentNodeId: entry.parentNodeId,
              rootNodeId: item.itemId,
              authorAccountId: entry.authorAccountId,
              authorRole: entry.authorRole,
              depth: entry.depth,
              createdAt: entry.createdAt,
              state: entry.state,
              text: entry.text,
              textUnavailableReason: entry.textUnavailableReason,
              metadata: contentMeta(item, '2026-04-05T00:00:00.000Z')
            })),
            missingNodeIds: target.missingNodeIds,
            truncation: {
              truncated: item.branches.find((entry) => entry.parentRef === query.parentRef)!.depthReached < 4,
              reason: null,
              depthRequested: 4,
              depthReached: target.depthReached
            }
          }
        };
      }
      return { status: 400, body: null, fee };
    }
  };
}

/** Schema-bound adapter handlers; each real request goes through `requests.run`. */
export function createSyntheticHandlers(): Partial<Record<string, ToolHandler>> {
  const run = async (
    ctx: Parameters<ToolHandler>[0],
    query: SyntheticQuery
  ): Promise<unknown> => {
    const response = await ctx.requests.run(
      { endpoint: `synthetic.${query.tool}`, note: JSON.stringify(query) },
      ctx.signal
    );
    return response.body;
  };
  return {
    list_posts: async (ctx) =>
      run(ctx, {
        tool: 'list_posts',
        accountId: String((ctx.input as { accountId: string }).accountId),
        nativeCursor: ctx.cursor.nativeCursor
      }),
    read_post: async (ctx) =>
      run(ctx, {
        tool: 'read_post',
        accountId: String((ctx.input as { accountId: string }).accountId),
        itemId: String((ctx.input as { itemId: string }).itemId)
      }),
    list_comments: async (ctx) =>
      run(ctx, {
        tool: 'list_comments',
        accountId: String((ctx.input as { accountId: string }).accountId),
        itemId: String((ctx.input as { itemId: string }).itemId)
      }),
    read_media: async (ctx) =>
      run(ctx, {
        tool: 'read_media',
        accountId: String((ctx.input as { accountId: string }).accountId),
        itemId: String((ctx.input as { itemId: string }).itemId),
        mediaRef: String((ctx.input as { mediaRef: string }).mediaRef)
      }),
    read_thread: async (ctx) =>
      run(ctx, {
        tool: 'read_thread',
        accountId: String((ctx.input as { accountId: string }).accountId),
        itemId: String((ctx.input as { itemId: string }).itemId),
        parentRef: String((ctx.input as { parentRef: string }).parentRef)
      })
  };
}

/**
 * Deterministic one-decision model gateway: it consumes exactly the plan the
 * trusted controller handed it (one tool call per invocation, then yield) and
 * reports its OWN usage accounting. DSH compatibility is preserved by the
 * `RuntimeModelGateway` single-decision interface.
 */
export function createPlanModel(
  usage: RuntimeModelUsage = { inputTokens: 256, outputTokens: 64, estimatedUsd: null }
): RuntimeModelGateway {
  return {
    async invoke(request: RuntimeModelRequest): Promise<{ decision: unknown; usage: RuntimeModelUsage }> {
      const instructions = JSON.parse(request.instructions) as {
        plan?: { tool: string; input: Record<string, unknown> }[];
      };
      const plan = instructions.plan ?? [];
      const emitted = request.events.filter((event) => event.kind === 'tool').length;
      const step = plan[emitted];
      return {
        decision: step
          ? { kind: 'tool', tool: step.tool, input: step.input }
          : { kind: 'yield', reason: 'plan chunk exhausted; continue in the next batch' },
        usage
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

export interface SyntheticHarness {
  store: Store;
  runs: FetchPipelineStore;
  catalog: FetchSourceCatalog;
  ownerId: string;
  caseId: string;
  scopeSpecId: string;
  runId: string;
  tools: ResearchToolServer;
  model: RuntimeModelGateway;
  setup: SyntheticCaseSetup;
  run(overrides?: Partial<FetchPipelineOptions>): Promise<FetchPipelineSummary>;
}

/**
 * Open (or reopen) the harness against an explicit database handle. Reopening
 * the same database resumes the same run at its durable checkpoint without
 * replaying known successful actions.
 */
export function openSyntheticHarness(
  db: DB,
  options: {
    scenario?: SyntheticScenario;
    model?: RuntimeModelGateway;
    resumeRunId?: string;
  } = {}
): SyntheticHarness {
  const store = new StoreImpl(db);
  const runs = new FetchPipelineStoreImpl(db, store);
  const catalog = buildSyntheticCorpus(options.scenario ?? {});
  const setup = prepareSyntheticCase(store, catalog, options.scenario ?? {});
  const prior = options.resumeRunId
    ? runs.requireRun(options.resumeRunId)
    : runs.listRuns(setup.ownerId, setup.caseId).find((run) => run.state !== 'finished');
  // An explicit resumeRunId always resumes that exact run (even a finished
  // one: re-running must be a no-op, never a replay).
  const runId =
    prior !== undefined
      ? prior.runId
      : runs.createRun({
          ownerId: setup.ownerId,
          caseId: setup.caseId,
          scopeSpecId: setup.scopeSpecId,
          scopeVersion: setup.scopeVersion,
          checkpoint: createInitialCheckpoint(catalog, setup.scopeVersion)
        }).runId;
  const tools = createResearchToolServer({
    store,
    handlers: createSyntheticHandlers() as ResearchToolServer['ports']['handlers'],
    executor: createSyntheticExecutor(catalog, options.scenario ?? {}),
    accounting: runs.createAccountingPort(runId),
    cursors: runs.createCursorPort(runId),
    submissions: runs.createSubmissionPort(runId),
    controller: runs.createControllerPort(runId)
  });
  const model = options.model ?? createPlanModel();
  return {
    store,
    runs,
    catalog,
    ownerId: setup.ownerId,
    caseId: setup.caseId,
    scopeSpecId: setup.scopeSpecId,
    runId,
    tools,
    model,
    setup,
    run: (overrides = {}) =>
      runFetchPipeline(
        {
          store,
          runs,
          tools,
          model,
          catalog,
          ownerId: setup.ownerId,
          caseId: setup.caseId,
          scopeSpecId: setup.scopeSpecId,
          runId,
          synthetic: true,
          provenance: PROVENANCE,
          ...overrides
        },
        new AbortController().signal
      )
  };
}

/** Deterministic digest helper used by tests and the CLI summary checks. */
export function corpusDigestOf(catalog: FetchSourceCatalog): string {
  return sha256(
    canonicalJson(
      catalog.accounts.map((account) =>
        account.pages.map((page) => page.map((item) => [item.itemId, item.sourceId, item.sourceRevision, item.contentHash]))
      )
    )
  );
}
