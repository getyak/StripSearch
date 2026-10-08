/**
 * GET-99 real GitHub Fetch processing (phase 2): production cached handlers
 * over the immutable captured snapshot.
 *
 * Phase 2 performs ZERO new HTTP and creates no duplicated charges: every
 * tool read serves the exact captured material from the durable journal
 * through the existing GET-59 dispatch gateway, with the same source-pinned
 * binding (`sourceId` + `sourceRevision` + canonical full-text hash) and the
 * isolated verification phase the local pipeline already enforces. This
 * module never imports synthetic fixture modules and never fabricates token
 * usage: the deterministic scheduler reports an honest ZERO external-model
 * requests/tokens.
 *
 * The catalog is rebuilt deterministically from the frozen journal rows, so
 * the pinned `catalogDigest` of a resumed pipeline run always matches and
 * completed snapshot/source pins can never silently change. Cached material
 * keeps its explicit provider limitations and partial boundaries: bodies that
 * cannot enter the processing text window stay journal-only with a gap, first
 * page issue comments keep their actual login/id attribution and original
 * permalinks, and no review thread, media or personal contribution coverage
 * is ever invented.
 */

import type {
  FetchCatalogAccount,
  FetchCatalogComment,
  FetchCatalogItem,
  FetchSourceCatalog
} from './fetch-pipeline.js';
import type {
  CapabilityOperation,
  CapabilitySnapshot,
  ProviderExecutorPort,
  ProviderResponse,
  ToolHandler
} from './research-tool-dispatch.js';
import type { ProviderToolName } from './research-tool-contracts.js';
import type { RuntimeModelGateway, RuntimeModelRequest, RuntimeModelUsage } from './research-runtime.js';
import type { Store } from '../store.js';
import type { FetchGithubRunRecord, FetchGithubStore } from './fetch-github-store.js';
import type { FetchGithubItemRecord } from './fetch-github-store.js';
import {
  FETCH_GITHUB_REGISTRY_VERSION,
  fetchGithubAccountId
} from '../../shared/research-fetch-github.js';

export const GITHUB_CACHED_HANDLER_NOTE =
  'production cached handler: serves exact captured snapshot material; zero new HTTP in processing';

const LIST_EXCERPT_MAX = 8_000;

function targetLoginOf(run: FetchGithubRunRecord): string {
  return run.target.kind === 'account' ? run.target.login : run.target.owner;
}

/**
 * Actual captured authorship for one material item: the requested account is
 * `subject` ONLY when the provider actually attributed the author to it;
 * third-party and unknown authors stay explicit and are never merged into
 * accounts (repository ownership never implies authorship).
 */
function actualAuthor(run: FetchGithubRunRecord, item: FetchGithubItemRecord): {
  authorAccountId: string;
  authorRole: 'subject' | 'third_party' | 'unknown';
} {
  const accountId = run.checkpoint.accountId;
  const login = item.authorLogin;
  if (login === null) {
    return { authorAccountId: `github:author:unknown:${item.itemKey}`, authorRole: 'unknown' };
  }
  if (login.toLowerCase() === targetLoginOf(run).toLowerCase()) {
    return { authorAccountId: accountId, authorRole: 'subject' };
  }
  return { authorAccountId: `github:user:${login.toLowerCase()}`, authorRole: 'third_party' };
}

/* ------------------------------------------------------------------ */
/* Deterministic catalog rebuild over the frozen snapshot              */
/* ------------------------------------------------------------------ */

interface ListingPage {
  requestKey: string;
  url: string;
  rowKeys: string[];
}

function listingPages(journal: FetchGithubStore, run: FetchGithubRunRecord): ListingPage[] {
  const listingKindNames = new Set(['repos_list', 'issues_list']);
  const requests = journal
    .listRequests(run.runId)
    .filter((request) => listingKindNames.has(request.kind) && request.state === 'succeeded');
  // One page per unique settled listing request, in settle order (continuation
  // pages settle strictly after their predecessor). A retried request key
  // contributes exactly one page (its latest settled attempt).
  const byKey = new Map<string, { requestKey: string; url: string; createdAt: string; attempt: number }>();
  for (const request of requests) {
    const prior = byKey.get(request.requestKey);
    if (!prior || request.attempt >= prior.attempt) {
      byKey.set(request.requestKey, {
        requestKey: request.requestKey,
        url: request.url,
        createdAt: request.createdAt,
        attempt: request.attempt
      });
    }
  }
  const ordered = [...byKey.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.requestKey < b.requestKey ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1
  );
  const rows = journal.listListingRows(run.runId, run.target.kind === 'account' ? 'repos' : 'issues');
  return ordered.map((entry) => ({
    requestKey: entry.requestKey,
    url: entry.url,
    rowKeys: rows
      .filter((row) => row.requestKey === entry.requestKey)
      .map((row) => row.rowKey)
      .sort()
  }));
}

function toCatalogComment(
  run: FetchGithubRunRecord,
  comment: ReturnType<FetchGithubStore['listComments']>[number]
): FetchCatalogComment {
  const accountId = run.checkpoint.accountId;
  const authorAccountId =
    comment.authorRole === 'subject'
      ? accountId
      : comment.authorLogin === null
        ? `github:user:unknown:${comment.commentId}`
        : `github:user:${comment.authorLogin.toLowerCase()}`;
  return {
    commentId: comment.commentId,
    authorName: comment.authorLogin,
    originalUrl: comment.originalUrl,
    parentCommentId: null,
    authorAccountId,
    authorRole: comment.authorRole,
    createdAt: comment.commentCreatedAt,
    excerpt: comment.excerpt,
    // No semantic classification in this slice: important/contradictory stay
    // explicitly false and comments are never silently promoted to evidence.
    important: false,
    contradictory: false
  };
}

function toCatalogItem(
  run: FetchGithubRunRecord,
  item: FetchGithubItemRecord,
  comments: ReturnType<FetchGithubStore['listComments']>
): FetchCatalogItem {
  const author = actualAuthor(run, item);
  return {
    accountId: item.accountId,
    itemId: item.itemKey,
    sourceId: item.sourceId,
    sourceRevision: item.sourceRevision,
    // Actual captured authorship (permission boundary stays `accountId`).
    authorAccountId: author.authorAccountId,
    authorRole: author.authorRole,
    // README snapshots structurally have no comment surface; this is frozen
    // with its reason and never fabricated as a successful comments endpoint.
    ...(item.kind === 'readme'
      ? {
          commentsStructuralNa: {
            reason: '结构性不适用：README / 当前公开工作快照没有评论面（冻结理由：本切片只捕获 README 正文快照）'
          }
        }
      : {}),
    title: item.title,
    publishedAt: item.publishedAt,
    fulltext: item.fulltext,
    contentHash: item.bodyHash,
    // Media was never extracted in this slice: unknown stays unknown — the
    // unsupported capability is explicit and never a fabricated absence.
    hasMedia: 'unknown',
    mediaRef: null,
    mediaText: null,
    mediaCaptions: null,
    mediaUnread: false,
    comments: comments
      .filter((comment) => comment.itemKey === item.itemKey)
      .map((comment) => toCatalogComment(run, comment)),
    branches: []
  };
}

/**
 * Rebuild the immutable snapshot catalog deterministically. Items enter
 * processing ONLY when their captured body fits the processing text window
 * (`processingEligible`); oversized bodies stay journal-only with an explicit
 * gap and are never truncated into a fake body pin.
 */
export function buildGithubSnapshotCatalog(
  journal: FetchGithubStore,
  run: FetchGithubRunRecord
): { catalog: FetchSourceCatalog; listingGaps: { code: string; detail: string }[]; commentCapture: Map<string, 'captured' | 'missing' | 'partial' | 'invalid'> } {
  const accountId = run.checkpoint.accountId;
  const comments = journal.listComments(run.runId);
  // Every captured row enters the catalog — oversized/unprocessed bodies are
  // NEVER dropped and then asserted as a known complete denominator (their
  // read fails honestly in the cached handler and the gaps below stay open).
  const items = journal
    .listItems(run.runId)
    .slice()
    .sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  const itemByKey = new Map(items.map((item) => [item.itemKey, item]));
  const pages = listingPages(journal, run);
  const used = new Set<string>();

  const catalogPages: FetchCatalogItem[][] = [];
  const pageCursors: (string | null)[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index] as ListingPage;
    const pageItems: FetchCatalogItem[] = [];
    for (const rowKey of page.rowKeys) {
      const item = itemByKey.get(rowKey);
      if (!item) continue;
      used.add(rowKey);
      pageItems.push(toCatalogItem(run, item, comments));
    }
    catalogPages.push(pageItems);
    // The continuation native cursor after this page is the REAL validated
    // Link URL of the next page; the terminal boundary is explicit null.
    pageCursors.push(pages[index + 1]?.url ?? null);
  }
  // Defensive: captured material whose listing row is missing joins the last
  // page instead of silently disappearing (its pin is still exact).
  const orphans = items.filter((item) => !used.has(item.itemKey));
  if (orphans.length > 0) {
    const orphansCatalog = orphans.map((item) => toCatalogItem(run, item, comments));
    if (catalogPages.length === 0) {
      catalogPages.push(orphansCatalog);
      pageCursors.push(null);
    } else {
      catalogPages[catalogPages.length - 1] = [
        ...(catalogPages[catalogPages.length - 1] as FetchCatalogItem[]),
        ...orphansCatalog
      ];
    }
  }

  // Trusted acquisition-boundary gaps: the cached snapshot is what was
  // actually captured — exhausting it is never proof that the real provider
  // history was exhausted. Every failed/unknown/rejected/cyclic/unreadable
  // request row and unprocessed row stays an explicit gap in GET-60
  // enumeration instead of a false zero/exhaustion result.
  const listingGaps: { code: string; detail: string }[] = [];
  for (const gap of run.checkpoint.gaps) listingGaps.push({ code: gap.code, detail: gap.detail });
  for (const request of journal.listRequests(run.runId)) {
    if (request.state === 'succeeded') continue;
    listingGaps.push({
      code: `acquisition_${request.state}`,
      detail: `${request.kind} ${request.requestKey}（第 ${String(request.attempt)} 次尝试）未成功落定：${request.gap ?? request.state}`
    });
  }
  for (const item of items) {
    if (!item.processingEligible) {
      listingGaps.push({
        code: 'material_unprocessed',
        detail: `${item.itemKey}: ${item.processingGap ?? '捕获正文超出处理窗口'}`
      });
    }
  }
  const capturedRowKeys = new Set(items.map((item) => item.itemKey));
  for (const row of journal.listListingRows(run.runId, run.target.kind === 'account' ? 'repos' : 'issues')) {
    if (!capturedRowKeys.has(row.rowKey)) {
      listingGaps.push({ code: 'listing_row_uncaptured', detail: `${row.rowKey}: 枚举行没有可处理的捕获正文（缺失/超限/不可读），保留为缺口` });
    }
  }

  // First-page comment capture state per material: HTTP settlement alone is
  // NEVER a captured comment page. Only a request whose payload was
  // semantically validated ('valid': top-level array, every row parseable and
  // bound) counts as captured; malformed/non-array/unparseable comment pages
  // stay an explicit unread gap and the cached handler refuses them instead
  // of fabricating a successful empty read.
  const commentCapture = new Map<string, 'captured' | 'missing' | 'partial' | 'invalid'>();
  for (const item of items) {
    if (item.kind === 'readme') continue;
    const number = item.itemKey.split('#').pop() ?? '';
    const request = journal
      .listRequests(run.runId)
      .filter((entry) => entry.kind === 'issue_comments' && entry.url.includes(`/issues/${number}/comments`))
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (!request || request.state !== 'succeeded') {
      commentCapture.set(item.itemKey, 'missing');
    } else if (request.semanticState === 'valid') {
      commentCapture.set(item.itemKey, 'captured');
    } else {
      commentCapture.set(item.itemKey, request.semanticState ?? 'invalid');
    }
  }

  const account: FetchCatalogAccount = {
    accountId,
    platform: 'github',
    handle: targetLoginOf(run),
    profileUrl: run.target.canonicalUrl,
    pages: catalogPages,
    pageCursors,
    listingGaps
  };
  return {
    catalog: { registryVersion: FETCH_GITHUB_REGISTRY_VERSION, accounts: [account] },
    listingGaps,
    commentCapture
  };
}

/* ------------------------------------------------------------------ */
/* Production cached handlers (exact captured material, zero HTTP)     */
/* ------------------------------------------------------------------ */

export interface CachedGithubHandlerDeps {
  store: Store;
  journal: FetchGithubStore;
  run: FetchGithubRunRecord;
  catalog: FetchSourceCatalog;
  /** First-page comment capture state per material item. */
  commentCapture?: Map<string, 'captured' | 'missing' | 'partial' | 'invalid'>;
}

interface ContentMetadataLike {
  applicable: true;
  author: string | null;
  originalUrl: string | null;
  publishedAt: string | null;
  retrievedAt: string | null;
  sourceRevision: number | null;
  locator: string | null;
}

function itemMetadata(deps: CachedGithubHandlerDeps, item: FetchCatalogItem): ContentMetadataLike {
  const revisions = deps.store.cases.listSourceRevisions(
    deps.run.ownerId,
    deps.run.caseId,
    item.accountId,
    item.sourceId
  );
  const revision = revisions.find((entry) => entry.sourceRevision === item.sourceRevision) ?? null;
  return {
    applicable: true,
    author: revision?.author ?? null,
    originalUrl: revision?.originalUrl ?? null,
    publishedAt: revision?.publishedAt ?? item.publishedAt,
    retrievedAt: revision?.retrievedAt ?? null,
    sourceRevision: item.sourceRevision,
    locator: item.itemId
  };
}

function findItem(deps: CachedGithubHandlerDeps, accountId: string, itemId: string): FetchCatalogItem | null {
  for (const account of deps.catalog.accounts) {
    if (account.accountId !== accountId) continue;
    for (const page of account.pages) {
      for (const item of page) if (item.itemId === itemId) return item;
    }
  }
  return null;
}

/**
 * Cached list_posts / read_post / list_comments handlers: exact captured
 * material only, no provider requests (zero new HTTP, zero duplicated
 * charges). read_thread / read_media stay unwired on purpose — this slice
 * captures no review threads or media, and the capability snapshot declares
 * them unsupported with that explicit limitation.
 */
export function createCachedGithubHandlers(
  deps: CachedGithubHandlerDeps
): Partial<Record<ProviderToolName, ToolHandler>> {
  return {
    list_posts: async (ctx) => {
      const accountId = String((ctx.input as { accountId: string }).accountId);
      const account = deps.catalog.accounts.find((entry) => entry.accountId === accountId);
      if (!account) throw new Error('cached snapshot: unknown account');
      const index = ctx.cursor.nativeCursor === null ? 0 : account.pageCursors.indexOf(ctx.cursor.nativeCursor) + 1;
      const page = account.pages[index];
      if (!page) throw new Error('cached snapshot: listing page unavailable');
      return {
        items: page.map((item) => ({
          itemId: item.itemId,
          sourceId: item.sourceId,
          sourceRevision: item.sourceRevision,
          // ACTUAL captured author; the permission/publisher boundary is the
          // explicit sourceAccountId (pin-verified by the gateway). Never
          // forged to the account just to pass the gate.
          authorAccountId: item.authorAccountId ?? item.accountId,
          sourceAccountId: item.accountId,
          authorRole: item.authorRole ?? 'subject',
          title: item.title,
          excerpt: item.fulltext.slice(0, LIST_EXCERPT_MAX),
          metadata: itemMetadata(deps, item)
        })),
        sort: 'provider_default',
        nativeCursor: account.pageCursors[index] ?? null
      };
    },
    read_post: async (ctx) => {
      const input = ctx.input as { accountId: string; itemId: string };
      const item = findItem(deps, input.accountId, input.itemId);
      if (!item) throw new Error('cached snapshot: unknown item');
      const journalItem = deps.journal
        .listItems(deps.run.runId)
        .find((entry) => entry.itemKey === item.itemId && entry.accountId === input.accountId);
      if (journalItem && !journalItem.processingEligible) {
        // The exact body stays in the journal only: it can never be truncated
        // into a fake body pin, so this read fails honestly.
        throw new Error(`cached snapshot: body exceeds the processing window (${journalItem.itemKey})`);
      }
      return {
        item: {
          itemId: item.itemId,
          sourceId: item.sourceId,
          sourceRevision: item.sourceRevision,
          authorAccountId: item.authorAccountId ?? item.accountId,
          sourceAccountId: item.accountId,
          authorRole: item.authorRole ?? 'subject',
          title: item.title,
          text: item.fulltext,
          metadata: itemMetadata(deps, item)
        }
      };
    },
    list_comments: async (ctx) => {
      const input = ctx.input as { accountId: string; itemId: string };
      const item = findItem(deps, input.accountId, input.itemId);
      if (!item) throw new Error('cached snapshot: unknown item');
      // A failed/absent/malformed first-page comment capture is NEVER a
      // successful empty page: only a semantically validated capture is
      // served, everything else fails honestly and keeps the comments
      // boundary open (HTTP 200 alone is not a captured read).
      const capture = deps.commentCapture?.get(item.itemId) ?? 'missing';
      if (capture !== 'captured') {
        throw new Error(`cached snapshot: comment page not captured (${capture}) (${item.itemId})`);
      }
      const metadata = itemMetadata(deps, item);
      return {
        items: item.comments.map((comment) => ({
          commentId: comment.commentId,
          rootItemId: item.itemId,
          parentCommentId: comment.parentCommentId,
          authorAccountId: comment.authorAccountId,
          authorRole: comment.authorRole,
          createdAt: comment.createdAt,
          excerpt: comment.excerpt,
          metadata: {
            applicable: true as const,
            author: comment.authorName ?? null,
            originalUrl: comment.originalUrl ?? null,
            publishedAt: comment.createdAt ?? null,
            retrievedAt: metadata.retrievedAt,
            sourceRevision: item.sourceRevision,
            locator: `comment:${comment.commentId}`
          }
        })),
        ordering: 'provider_default' as const,
        // First page only is captured in this slice; there is no continuation.
        nativeCursor: null
      };
    }
  };
}

/**
 * Phase-2 executor guard: the processing phase performs ZERO HTTP. Cached
 * handlers serve exactly the captured material, so the metered executor is
 * never invoked — and fails closed if anything ever tried.
 */
export function createNoNetworkCachedExecutor(): ProviderExecutorPort {
  return {
    async execute(): Promise<ProviderResponse> {
      throw new Error('cached processing: zero new HTTP is allowed in phase 2');
    }
  };
}

/* ------------------------------------------------------------------ */
/* Trusted capability injection (honest, never synthetic)              */
/* ------------------------------------------------------------------ */

/**
 * The real GitHub public capability surface for this slice. Processing-time
 * capability declarations describe what the captured snapshot actually
 * supports — never an unconditional "synthetic adapter" claim and never a
 * fabricated provider verification.
 */
export function createGithubCapabilitySnapshot(): CapabilitySnapshot {
  const operations: CapabilityOperation[] = [
    {
      platform: 'github',
      operation: 'list_posts',
      state: 'supported',
      sortOptions: ['provider_default'],
      dateRange: 'unsupported',
      maxDepth: null,
      limitation: '枚举来自真实 GitHub 公开 API 抓取的冻结快照（README 快照或 issues/PR 列表）；处理阶段零新 HTTP。'
    },
    {
      platform: 'github',
      operation: 'read_post',
      state: 'supported',
      sortOptions: ['provider_default'],
      dateRange: 'unsupported',
      maxDepth: null,
      limitation: '正文来自冻结快照的精确捕获（README 或 issue/PR body）；超出处理文本窗口的正文只保留日志原文并显式记缺口。'
    },
    {
      platform: 'github',
      operation: 'list_comments',
      state: 'supported',
      sortOptions: ['provider_default'],
      dateRange: 'unsupported',
      maxDepth: null,
      limitation: '只读取每个条目的首页 issue 评论，保留实际 login/id 归属与原始 permalink；无完整评论线程。'
    },
    {
      platform: 'github',
      operation: 'read_thread',
      state: 'unsupported',
      sortOptions: [],
      dateRange: 'unsupported',
      maxDepth: null,
      limitation: '本切片不抓取完整 review/评论线程：无分支材料，绝不发明线程覆盖。'
    },
    {
      platform: 'github',
      operation: 'read_media',
      state: 'unsupported',
      sortOptions: [],
      dateRange: 'unsupported',
      maxDepth: null,
      limitation: '本切片不抓取媒体内容：媒体状态显式为无媒体，绝不发明媒体覆盖。'
    }
  ];
  return { registryVersion: FETCH_GITHUB_REGISTRY_VERSION, operations };
}

/* ------------------------------------------------------------------ */
/* Deterministic scheduler (honest zero external-model usage)          */
/* ------------------------------------------------------------------ */

const ZERO_MODEL_USAGE: RuntimeModelUsage = { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };

/**
 * Deterministic one-decision scheduler over the trusted controller plan: one
 * planned tool call per invocation, then yield. It is NOT an LLM: its usage
 * accounting reports honest zero external-model requests/tokens and is never
 * presented as real model use.
 */
export function createDeterministicFetchScheduler(): RuntimeModelGateway {
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
          : { kind: 'yield', reason: 'deterministic scheduler: plan quantum drained' },
        usage: { ...ZERO_MODEL_USAGE }
      };
    }
  };
}
