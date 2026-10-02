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
