export const RESEARCH_FACETS = [
  { id: 'background', label: '经历与时间变化' },
  { id: 'work', label: '作品与个人贡献' },
  { id: 'expression', label: '原作与观点' },
  { id: 'interaction', label: '互动与本人回应' },
  { id: 'counterevidence', label: '反证、修正与限制' }
] as const;
export type ResearchFacet = typeof RESEARCH_FACETS[number]['id'];
export interface ResearchFacetCoverage {
  id: ResearchFacet;
  label: string;
  state: 'evidence_found' | 'gap';
  sourceKeys: string[];
  note: string;
}

/** A bounded single-quote policy, not a general semantic entailment checker. */
export function claimScopeIssue(claim: { statement: string; quote: string }): string | null {
  const statement = claim.statement.trim();
  // An exact source assertion may remain an attributed assertion. The caller
  // must still validate this quote against its original, active scoped source.
  if (statement && claim.quote.includes(statement)) return null;
  // Classify an adjacent explicitly scoped pronoun as that item. This never
  // changes stored text or participates in the exact-quote exemption above.
  const scopedStatement = statement
    .replace(/((?:这|该|本)篇(?:文章|论文|博文)(?:中|里|内)[，,：:\s]*)(?:其|他的|她的)(?=(?:的)?(?:核心|主要|中心|总体))/gu,'$1该条目')
    .replace(/(\b(?:in|within)\s+(?:this|the)\s+(?:article|post|entry|passage)[,:]?\s+)(?:his|her|their)(?=\s+(?:core|central|main|overall|overarching)\b)/giu,'$1this item');
  const corpusSummary = /(?:博客|网站|作品集|职业生涯|公开表达|其|本人|他的|她的)(?:的)?(?:总体|整体)?(?:核心(?:观点|理念|思想|信念)|主要(?:观点|思想)|中心(?:观点|思想)|统一(?:观点|立场)|总体(?:观点|立场))|\b(?:blog|website|body of work|career|author|creator|his|her|their)(?:['’]s)?\s+(?:(?:overall|main|central|core|overarching)\s+(?:views?|viewpoints?|stances?|positions?|ideas?|beliefs?|philosophy|thesis|message))\b|\b(?:core|central|overall|overarching)\s+(?:views?|viewpoints?|stances?|positions?|ideas?|beliefs?|philosophy|thesis|message)\s+of\s+(?:(?:the|his|her|their)\s+)?(?:blog|website|body of work|career|author|creator|person)\b/iu;
  const completeCorpus = /(?:全部|所有|完整)(?:的)?(?:文章|作品|历史|账号|发言|经历|博客)|整个(?:博客|网站|职业生涯)|\b(?:all|entire|whole)\s+(?:(?:his|her|their|the)\s+)?(?:posts?|works?|history|career|blog|website)\b/iu;
  const enduringView = /(?:一贯|始终|长期|贯穿).{0,12}(?:主张|观点|信念|理念|立场|风格|坚持|认为|强调)|\b(?:always|consistently)\s+(?:believes?|argues?|maintains?|holds?|advocates?|claims?|emphasizes?)\b/iu;
  return corpusSummary.test(scopedStatement) || completeCorpus.test(statement) || enduringView.test(statement)
    ? '单条来源摘录不能支持整个作品集合、人物核心观点或一贯立场的综合概括；请限定具体条目与时间，或保留原文逐字陈述。'
    : null;
}

/** Narrow literal-year guard; never a complete semantic entailment test. */
export function claimQuotedYearIssue(claim: { statement: string; quote: string }): string | null {
  const years = claim.statement.match(/(?<!\d)(?:1[5-9]\d{2}|20\d{2}|21\d{2})(?!\d)/gu) ?? [];
  const quotedYears: readonly string[] = claim.quote.match(/(?<!\d)(?:1[5-9]\d{2}|20\d{2}|21\d{2})(?!\d)/gu) ?? [];
  return years.some(year => !quotedYears.includes(year))
    ? '陈述包含本条引文未支持的年份；请绑定能完整支持本条的连续引文，或删除未绑定的经历与日期。'
    : null;
}

/** Same policy gate for verification, stored canonical projection and exports. */
export function claimEvidenceIssue(claim: { statement: string; quote: string }, policy?: 'exact_quote/v1'): string | null {
  return claimScopeIssue(claim) ?? (policy === 'exact_quote/v1' ? claimQuotedYearIssue(claim) : null);
}

/** Evidence availability, never a percentage or a claim of complete history. */
export function researchDepthCoverage(
  claims: readonly { sourceKey: string; facet?: ResearchFacet; verified?: boolean }[],
  readableKeys: ReadonlySet<string>
): ResearchFacetCoverage[] {
  return RESEARCH_FACETS.map(facet => {
    const sourceKeys = [...new Set(claims.filter(c => c.verified === true && c.facet === facet.id && readableKeys.has(c.sourceKey)).map(c => c.sourceKey))];
    return { ...facet, state: sourceKeys.length ? 'evidence_found' : 'gap', sourceKeys,
      note: sourceKeys.length ? '有经核验的原文材料；不代表此范围已读完。' : '尚无经核验的原文材料，需要继续补查。' };
  });
}
