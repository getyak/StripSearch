/**
 * Deterministic person-overview projection for staged name discovery
 * (GET-213). It only projects REAL checked receipts: retained originals
 * (with content hashes and exact quote spans) and search-index clues kept
 * explicitly distinct from originals. No model text, no invented biography,
 * no ownership assertion and no social/account expansion.
 *
 * Same-name sources are never merged by name or handle: each observed anchor
 * referent stays its own candidate and uncertainty stays visible. The result
 * is persisted inside the immutable discovery revision; the client can only
 * confirm one of its immutable candidate ids.
 */

import { createHash } from 'node:crypto';
import { classifyFirstStepUrl } from '../../shared/first-step-discovery.js';
import {
  PERSON_CONFIRMATION_SCHEMA_VERSION,
  excerptAroundLabel,
  type FirstStepFailureView,
  type PersonCandidateView,
  type PersonDescriptorAtomView,
  type PersonOverviewCoverageView,
  type PersonOverviewView,
  type PersonSourceView
} from '../../shared/person-confirmation.js';

export interface OverviewSourceInput {
  url: string;
  title: string | null;
  /**
   * Retained original text for `read` sources. For `indexed` clues this may
   * carry the search snippet ONLY for name matching; the projection never
   * keeps it (indexed sources stay clue-only with no quote/hash/excerpt).
   */
  text: string | null;
  retrieval: 'read' | 'indexed';
  retrievedAt: string | null;
  contentHash?: string | null;
}

export interface BuildPersonOverviewInput {
  attemptId: string;
  queryLabel: string;
  policyVersion: string;
  now: string;
  sources: OverviewSourceInput[];
  coverage: Omit<PersonOverviewCoverageView, 'sourcesRead' | 'sourcesIndexed'>;
  gaps: string[];
  serviceError: FirstStepFailureView | null;
}

export function personSourceKey(url: string): string {
  return `psrc/${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}

export function personCandidateId(anchorGroupKey: string): string {
  return `pcand/${createHash('sha256').update(anchorGroupKey).digest('hex').slice(0, 32)}`;
}

function groupKeyOf(url: string): string {
  const classified = classifyFirstStepUrl(url);
  return classified.ok ? classified.ref.accountKey : `url:${url}`;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function matchesQueryLabel(source: OverviewSourceInput, needle: string): boolean {
  if (needle.length === 0) return true;
  // Matching may look at the indexed snippet text; the PROJECTION never keeps
  // that text (indexed sources stay clue-only with no quote/hash/excerpt).
  const haystack = normalized(`${source.title ?? ''}\n${source.text ?? ''}`);
  return haystack.includes(needle);
}

const MAX_CANDIDATES = 4;

export function buildPersonOverview(input: BuildPersonOverviewInput): PersonOverviewView {
  const needle = normalized(input.queryLabel.trim());
  const gaps = [...input.gaps];
  const matching = input.sources.filter((source) => matchesQueryLabel(source, needle));
  const nonMatching = input.sources.length - matching.length;
  if (nonMatching > 0) {
    gaps.push(`${String(nonMatching)} 个检索来源未出现查询姓名线索，未纳入人物候选；不据此断言与查询人物无关。`);
  }

  const groups = new Map<string, OverviewSourceInput[]>();
  for (const source of matching) {
    const key = groupKeyOf(source.url);
    const list = groups.get(key) ?? [];
    list.push(source);
    groups.set(key, list);
  }

  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const readCount = (list: OverviewSourceInput[]): number => list.filter((item) => item.retrieval === 'read').length;
    return readCount(right[1]) - readCount(left[1]) || left[0].localeCompare(right[0]);
  });

  const candidates: PersonCandidateView[] = [];
  for (const [groupKey, sources] of orderedGroups.slice(0, MAX_CANDIDATES)) {
    const anchor = [...sources].sort((a, b) => (b.retrieval === 'read' ? 1 : 0) - (a.retrieval === 'read' ? 1 : 0))[0]!;
    const personSources: PersonSourceView[] = sources.map((source) => {
      const read = source.retrieval === 'read';
      const contentHash = read
        ? source.contentHash ?? `sha256:${createHash('sha256').update(source.text ?? '').digest('hex')}`
        : null;
      return {
        sourceKey: personSourceKey(source.url),
        url: source.url,
        title: source.title,
        retrieval: source.retrieval,
        contentHash,
        retrievedAt: read ? source.retrievedAt : null,
        quote: null,
        locator: null,
        note: read
          ? '原文已读取并保留内容哈希与摘录定位；人物归属未确认，摘录不作本人拥有账号的证明。'
          : '搜索索引线索，不是原文；不能作为原文、身份或归属依据。'
      };
    });
    const descriptors: PersonDescriptorAtomView[] = [];
    for (const source of sources) {
      const sourceKey = personSourceKey(source.url);
      if (source.title && source.title.trim().length >= 2) {
        descriptors.push({
          atomId: `patom/${createHash('sha256').update(`${sourceKey}|title|${source.title}`).digest('hex').slice(0, 20)}`,
          statement: source.retrieval === 'read' ? `来源标题：${source.title.trim().slice(0, 160)}` : `搜索索引标题：${source.title.trim().slice(0, 160)}`,
          kind: 'source_title',
          sourceKey,
          quote: null,
          locator: null
        });
      }
      if (source.retrieval === 'read' && source.text) {
        const excerpt = excerptAroundLabel(source.text, input.queryLabel);
        if (excerpt) {
          const view = personSources.find((item) => item.sourceKey === sourceKey);
          if (view) {
            view.quote = excerpt.quote.slice(0, 400);
            view.locator = excerpt.locator;
          }
          descriptors.push({
            atomId: `patom/${createHash('sha256').update(`${sourceKey}|excerpt|${excerpt.quote}|${excerpt.locator}`).digest('hex').slice(0, 20)}`,
            statement: excerpt.quote.slice(0, 200),
            kind: 'source_excerpt',
            sourceKey,
            quote: excerpt.quote.slice(0, 400),
            locator: excerpt.locator
          });
        }
      }
    }
    candidates.push({
      candidateId: personCandidateId(groupKey),
      displayName: anchor.title?.trim().slice(0, 120) || input.queryLabel.trim().slice(0, 120),
      queryLabel: input.queryLabel.trim().slice(0, 200),
      anchorSourceKey: personSourceKey(anchor.url),
      sources: personSources,
      descriptors,
      counterevidence: [],
      unknowns: [
        ...sources.some((source) => source.retrieval === 'indexed')
          ? ['该候选含仅搜索索引可见的线索；索引摘要不是原文，未核对内容。']
          : [],
        '人物归属未确认：确认人物只是用户意图，不构成任何账号归属或事实依据。'
      ]
    });
  }

  const remaining = orderedGroups.length - candidates.length;
  if (remaining > 0) {
    gaps.push(`另有 ${String(remaining)} 个同名来源线索未展开为候选；同名来源不合并，请用补线索缩小范围。`);
  }

  const status: PersonOverviewView['status'] =
    input.serviceError !== null && input.serviceError.serviceError && candidates.length === 0
      ? 'service_error'
      : candidates.length > 0
        ? 'awaiting_confirmation'
        : 'no_candidates';
  if (candidates.length === 0 && input.serviceError === null) {
    gaps.push('本次有界检索未找到可辨识的人物来源；不代表此人不存在，可补充公开主页、机构或作品线索。');
  }

  return {
    schemaVersion: PERSON_CONFIRMATION_SCHEMA_VERSION,
    policyVersion: input.policyVersion,
    attemptId: input.attemptId,
    queryLabel: input.queryLabel.trim().slice(0, 200),
    status,
    candidates,
    coverage: {
      ...input.coverage,
      sourcesRead: input.sources.filter((source) => source.retrieval === 'read').length,
      sourcesIndexed: input.sources.filter((source) => source.retrieval === 'indexed').length
    },
    gaps,
    serviceError: input.serviceError,
    createdAt: input.now
  };
}
