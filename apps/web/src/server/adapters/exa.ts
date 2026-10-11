import type { AnswerSectionDraft, ObservationDraft, ProviderResult, RunInput, SourceDraft } from '../../shared/types.js';
import { isPublicHttpsUrl } from '../../shared/validation.js';
import { asArray, asRecord, asString, safeFetchJson } from './http.js';
import { ProviderError } from './types.js';
import type { ProviderContext, ResearchProvider } from './types.js';

export const EXA_API_ORIGIN = 'https://api.exa.ai';
export const EXA_RESULTS = 6;
export const EXA_EXCERPT_MAX = 1200;
export const EXA_ANSWER_MAX = 4000;
export const EXA_EXTRA_CITATION_SOURCES = 6;
export const EXA_MAX_CITATION_URLS = EXA_RESULTS + EXA_EXTRA_CITATION_SOURCES;
export const EXA_MAX_RAW_CITATIONS = 50;

export interface ExaResult {
  url: string;
  title: string;
  excerpt: string | null;
  author: string | null;
  publishedDate: string | null;
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/** Only public https result URLs are accepted; anything else is dropped. */
export function parseExaResult(raw: unknown): ExaResult | null {
  const object = asRecord(raw);
  const url = asString(object.url);
  if (!url || !isPublicHttpsUrl(url)) return null;
  const title = asString(object.title) ?? url;
  return {
    url: new URL(url).href,
    title,
    excerpt: truncate(asString(object.text) ?? asString(object.summary), EXA_EXCERPT_MAX),
    author: asString(object.author),
    publishedDate: asString(object.publishedDate)
  };
}

import { hostnameOf } from '../../shared/url-policy.js';

export function dedupeExaResults(results: ExaResult[]): ExaResult[] {
  const seen = new Set<string>();
  const deduped: ExaResult[] = [];
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    deduped.push(result);
  }
  return deduped;
}

function buildGroundingQuery(question: string, seedUrl: string | null): string {
  if (seedUrl) {
    return `${question}\n已知公开主页（仅用于同名区分，不是本地材料）：${seedUrl}`;
  }
  return question;
}

/** Merge search results with citation-derived pages, preserving first occurrence. */
export function mergeExaResults(results: ExaResult[], citations: ExaResult[]): ExaResult[] {
  const seen = new Set(results.map((result) => result.url));
  const extra: ExaResult[] = [];
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    extra.push(citation);
    if (extra.length >= EXA_EXTRA_CITATION_SOURCES) break;
  }
  return [...results, ...extra];
}

export interface ExaAnswerPayload {
  answer: string | null;
  citations: ExaResult[];
  rawCitationCount: number;
  invalidCitationCount: number;
}

export function extractAnswerPayload(raw: unknown): ExaAnswerPayload {
  const object = asRecord(raw);
  const answerValue = object.answer;
  const answer =
    typeof answerValue === 'string' && answerValue.trim().length > 0
      ? answerValue.trim().slice(0, EXA_ANSWER_MAX)
      : null;
  const rawCitations = asArray(object.citations);
  const citations = rawCitations
    .map(parseExaResult)
    .filter((citation): citation is ExaResult => citation !== null);
  return {
    answer,
    citations,
    rawCitationCount: rawCitations.length,
    invalidCitationCount: rawCitations.length - citations.length
  };
}

function buildSources(seedUrl: string | null, results: ExaResult[]): SourceDraft[] {
  return results.map((result, index) => {
    const confirmed = seedUrl !== null && result.url === seedUrl;
    return {
      key: `S${index + 1}`,
      url: result.url,
      title: result.title,
      kind: confirmed ? 'profile' : 'third_party',
      publishedAt: result.publishedDate,
      excerpt: result.excerpt,
      excerptLocator: result.excerpt ? '检索结果短摘录' : null,
      identityLabel: confirmed ? '已知种子账号' : '网页检索结果（身份未确认）',
      identityConfirmed: confirmed,
      fetchStatus: 'ok',
      limits: ['检索结果短摘录；本机未抓取页面全文，身份未确认。']
    } satisfies SourceDraft;
  });
}

export function buildExaResult(
  seedUrl: string | null,
  results: ExaResult[],
  answerText: string | null,
  citationUrls: string[],
  usage: { requests: number; bytes: number }
): ProviderResult {
  const sources = buildSources(seedUrl, results);
  const keyByUrl = new Map(sources.map((source) => [source.url, source.key] as const));
  const synthesisKeys = [
    ...new Set(citationUrls.map((url) => keyByUrl.get(url)).filter((key): key is string => Boolean(key)))
  ];
  const includeAnswer = Boolean(answerText) && synthesisKeys.length > 0;

  const observations: ObservationDraft[] = results.map((result, index) => ({
    statement:
      result.excerpt === null
        ? `检索结果《${result.title}》（${hostnameOf(result.url)}）未返回可用短摘录。`
        : `检索结果《${result.title}》（${hostnameOf(result.url)}）提到：${result.excerpt}。`,
    kind: result.excerpt === null ? 'inference' : 'page_statement',
    sourceKeys: [`S${index + 1}`],
    limitations: ['页面自身的表述，尚未独立核实。']
  }));

  const excerptBullets: AnswerSectionDraft['bullets'] = results.map((result, index) => {
    const key = `S${index + 1}`;
    if (result.excerpt) {
      return {
        text: `《${result.title}》（${hostnameOf(result.url)}）：${result.excerpt}`,
        sourceKeys: [key],
        kind: 'page_statement'
      };
    }
    return {
      text: `《${result.title}》（${hostnameOf(result.url)}）· 供应商未返回短摘录。`,
      sourceKeys: [key],
      kind: 'inference'
    };
  });

  const exactSeed = seedUrl !== null && results.some((result) => result.url === seedUrl);
  const seedKey = exactSeed ? keyByUrl.get(seedUrl as string) ?? null : null;
  const identityBullets: AnswerSectionDraft['bullets'] =
    seedKey === null
      ? []
      : [{ text: `你提供的种子主页：${seedUrl}`, sourceKeys: [seedKey], kind: 'factual' }];

  const unknowns: AnswerSectionDraft['bullets'] = [
    { text: '检索结果中的身份未经确认，除非是你提供的种子账号。', sourceKeys: [], kind: 'inference' },
    { text: '本机没有抓取页面全文，短摘录可能缺少上下文。', sourceKeys: [], kind: 'inference' }
  ];
  if (!includeAnswer) unknowns.push({ text: '本次没有采用可用的整理结果。', sourceKeys: [], kind: 'inference' });

  const answer: AnswerSectionDraft[] = [
    {
      id: 'identity',
      heading: '这个人是谁',
      body: '网页检索不能确认同名身份；只有你提供的种子主页会被标记为已确认。',
      bullets: identityBullets
    },
    {
      id: 'excerpts',
      heading: '来源摘录',
      body:
        results.length > 0
          ? '以下为来源页面自身的短摘录，按返回顺序列出；未读取全文。'
          : '本次没有检索到可用的公开来源。',
      bullets: excerptBullets
    },
    {
      id: 'synthesis',
      heading: '整理结果',
      body: includeAnswer
        ? '以下为供应商基于上述来源生成的整理结果，是生成式摘要，不是独立核实的事实。'
        : '未采用整理结果（缺少有效引用或引用不完整）；以下仅为来源摘录。',
      bullets: includeAnswer
        ? [{ text: answerText as string, sourceKeys: synthesisKeys, kind: 'inference' }]
        : []
    },
    { id: 'unknowns', heading: '待核实', body: '以下内容目前无法确认。', bullets: unknowns }
  ];

  const limitations = [
    'Exa 返回检索结果与短摘录，本机未抓取原始页面全文。',
    '检索结果中的身份未经确认，除非是你提供的种子账号。',
    '整理结果由 Exa 生成，是生成式摘要，需按引用核对。'
  ];
  if (!includeAnswer) limitations.push('本次没有采用可用的整理结果。');

  return {
    state: results.length > 0 && includeAnswer ? 'completed' : 'partial',
    identity: {
      displayName: '',
      handle: null,
      profileUrl: exactSeed ? seedUrl : null,
      status: exactSeed ? 'resolved' : 'ambiguous',
      note: exactSeed ? null : '网页检索未自动确认同名身份。',
      candidates: []
    },
    sources,
    observations,
    answer,
    limitations,
    usage,
    stopReason: results.length === 0 ? 'exa_no_results' : includeAnswer ? 'exa_search_and_answer' : 'exa_search_partial'
  };
}

function reportSources(context: ProviderContext, sources: SourceDraft[]): void {
  for (const source of sources) context.report.source(source);
}

export function createExaProvider(apiKey: string | null): ResearchProvider {
  return {
    name: 'exa',
    available: Boolean(apiKey),
    async run(input: RunInput, context: ProviderContext): Promise<ProviderResult> {
      const key = context.exaApiKey ?? apiKey;
      if (!key) {
        throw new ProviderError('provider_unavailable', 'Exa 未配置，未发起任何请求。');
      }
      if (input.seedUrl !== null && !isPublicHttpsUrl(input.seedUrl)) {
        throw new ProviderError('provider_bad_response', '种子主页必须是可公开访问的 HTTPS 链接。');
      }
      const totalStages = 4;
      const headers = { 'content-type': 'application/json', 'x-api-key': key };
      const groundingQuery = buildGroundingQuery(input.question, input.seedUrl);

      context.report.stage(0, totalStages, 'search', '提交网页检索', 'active');
      const searchResponse = await safeFetchJson({
        transport: context.transport,
        url: `${EXA_API_ORIGIN}/search`,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: groundingQuery,
            numResults: EXA_RESULTS,
            type: 'auto',
            contents: { text: { maxCharacters: EXA_EXCERPT_MAX } }
          })
        },
        signal: context.signal,
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes
      });
      context.report.stage(0, totalStages, 'search', '提交网页检索', 'done');
      const rawResults = asArray(asRecord(searchResponse.json).results);
      const results = dedupeExaResults(
        rawResults
          .map(parseExaResult)
          .filter((result): result is ExaResult => result !== null)
          .slice(0, EXA_RESULTS)
      );
      context.report.stage(1, totalStages, 'read', '读取检索结果', 'active', `接受 ${results.length} 条公开结果`);

      let bytes = searchResponse.bytes;
      let answerText: string | null = null;
      let citationResults: ExaResult[] = [];
      let citationUrls: string[] = [];
      context.report.stage(2, totalStages, 'answer', '整理带引用回答', 'active');
      if (results.length > 0) {
        try {
          const answerResponse = await safeFetchJson({
            transport: context.transport,
            url: `${EXA_API_ORIGIN}/answer`,
            init: {
              method: 'POST',
              headers,
              body: JSON.stringify({ query: groundingQuery, text: true })
            },
            signal: context.signal,
            timeoutMs: context.timeoutMs,
            maxBytes: context.maxBytes
          });
          bytes += answerResponse.bytes;
          const payload = extractAnswerPayload(answerResponse.json);
          const tooManyCitations =
            payload.rawCitationCount > EXA_MAX_RAW_CITATIONS ||
            new Set(payload.citations.map((citation) => citation.url)).size > EXA_MAX_CITATION_URLS;
          // All-or-nothing: a single invalid or unmapped citation drops the
          // generated answer so it can never look grounded when it is not.
          const allCitationsValid =
            payload.rawCitationCount > 0 && payload.invalidCitationCount === 0 && !tooManyCitations;
          const merged = mergeExaResults(results, payload.citations);
          const mergedUrls = new Set(merged.map((result) => result.url));
          const uniqueCitationUrls = [...new Set(payload.citations.map((citation) => citation.url))];
          const allMapped = uniqueCitationUrls.every((url) => mergedUrls.has(url));
          if (allCitationsValid && allMapped && payload.answer) {
            answerText = payload.answer;
            citationUrls = uniqueCitationUrls;
            citationResults = merged.slice(results.length);
          }
          context.report.stage(
            2,
            totalStages,
            'answer',
            '整理带引用回答',
            'done',
            answerText ? '已采用带引用整理结果' : '引用不完整，未采用整理结果'
          );
        } catch (error) {
          const message = error instanceof ProviderError ? error.message : '整理回答失败。';
          context.report.stage(2, totalStages, 'answer', '整理带引用回答', 'error', message);
        }
      } else {
        context.report.stage(2, totalStages, 'answer', '整理带引用回答', 'unavailable', '没有可用来源');
      }

      const merged = mergeExaResults(results, citationResults);
      context.report.stage(3, totalStages, 'limits', '标注限制', 'active');
      const result = buildExaResult(input.seedUrl, merged, answerText, citationUrls, {
        requests: results.length > 0 ? 2 : 1,
        bytes
      });
      reportSources(context, result.sources);
      context.report.stage(3, totalStages, 'limits', '标注限制', 'done', `${result.limitations.length} 条限制`);
      return result;
    }
  };
}
