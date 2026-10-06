export const RESEARCH_FACETS = [
  { id: 'background', label: '经历与时间变化' },
  { id: 'work', label: '作品与个人贡献' },
  { id: 'expression', label: '原作与观点' },
  { id: 'interaction', label: '互动与本人回应' },
  { id: 'counterevidence', label: '反证、修正与限制' }
] as const;
export type ResearchFacet = typeof RESEARCH_FACETS[number]['id'];
export type ClaimAuthorialBasis = 'quote_first_person' | 'native_authored_post' | 'page_text';
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
export function quoteHasFirstPerson(quote:string):boolean {
  const readable=quote.replace(/<[^>]*>/g,' ');
  return /\b(?:I|me|my|mine|we|our|ours)\b|(?:我|本人)(?:的|们|曾|在|是|有|做|写|想|希望|觉得|说|讲述|学习|研究|参与|负责|建立|发布|训练|工作|设计|创建|认为|喜欢)/iu.test(readable);
}

/** New server-bound attribution gate; unmarked history is not relabeled. */
export function claimAuthorialIssue(claim:{statement:string;quote:string;kind?:string;facet?:ResearchFacet;authorialBasis?:ClaimAuthorialBasis}):string|null {
  if(!claim.authorialBasis)return null;
  if(claim.authorialBasis==='page_text'&&(claim.kind==='attributed_statement'||/自述|自我介绍|自称|他称|她称|本人(?:开设|创办|创建)|\b(?:he|she)\s+(?:says|said|states|claims)|self-description/iu.test(claim.statement)))
    return '第三人称页面简介或一般页面文字不能改成本人自述；请使用页面陈述并保留来源归因，不增加创办或个人行动。';
  if(/^(?:同文|同一(?:篇|文章|论文)|上文|[Ii]n\s+the\s+same\s+(?:article|paper))/u.test(claim.statement.trim()))
    return '每条陈述必须独立指明来源与范围；不能用同文或上文跨条目代指，分组与导出不会维持该代指。';
  if(claim.facet==='background'&&/\bI\s+(?:like|love|enjoy)\b|我喜欢|本人喜欢/iu.test(claim.quote)&&!/(?:\b(?:since|when|started|began|years?|months?)\b|(?:19|20)\d{2}|年|月)/iu.test(claim.quote))
    return '账号简介中的偏好不是带时间的经历变化，不能填充经历维度；请寻找真正经历原文或保留缺口。';
  if(claim.facet==='work'&&/\b(?:blog|channel|repository|website)\s+of\b/iu.test(claim.quote)&&!(/\b(?:wrote|built|created|founded|designed|developed|led|instructed)\b|编写|开发|设计|创办/u.test(claim.quote)))
    return '博客或账号归属简介不能证明本人创办或具体贡献，不能填充个人作品行动维度。';
  const digits:Record<string,string>={'1':'[1一]','2':'[2二两]','3':'[3三]','4':'[4四]','5':'[5五]','6':'[6六]','7':'[7七]','8':'[8八]','9':'[9九]','10':'(?:10|十)'};
  for(const match of claim.quote.matchAll(/(?:~\s*|\b(?:about|approximately)\s+)(\d+)\s*(?:years?|年)/giu)){
    const number=digits[match[1]!]??match[1]!;
    if(new RegExp(`(?:${number}年(?:多|以上)|(?:超过|至少)${number}年)`,'u').test(claim.statement))return '原文约数不能扩写成超过、至少或多年限定；请保留约数的范围。';
  }
  if(/(?:~\s*|\b(?:about|approximately)\s+)(?:(?:a|one|1)\s+)?week\b/iu.test(claim.quote)&&/[一1](?:周|星期)前/u.test(claim.statement)&&!/(?:约|大概|大致|差不多|左右|前后).{0,8}[一1](?:周|星期)|[一1](?:周|星期).{0,5}(?:左右|前后)/u.test(claim.statement))return '原文约一周不能改成精确一周前；请保留约数的限定。';
  if(/\bbe\s+like\b/iu.test(claim.quote)&&/成为/.test(claim.statement))return '原文的像某人一样不能扩写为成为该人；请保留比较与愿望的限定。';
  return null;
}

/** Conservative mixed-language lexical eligibility, never semantic support. */
export function claimLiteralTermIssue(claim:{statement:string;quote:string;sourceKey?:string;facet?:ResearchFacet;sourceReadKind?:string;sourceReadUrl?:string;quoteLexicalPolicy?:'literal_terms/v1'}):string|null {
  if(!claim.quoteLexicalPolicy)return null;
  const quote=claim.quote.replace(/<[^>]*>/g,' ');
  if(/^(?:同一(?:帖|条帖文)|[Ii]n\s+the\s+same\s+post)/u.test(claim.statement.trim()))return '每条陈述必须独立指明来源与范围；不能用同一帖跨条目代指，分组与导出不会维持该代指。';
  if(claim.facet==='work'&&claim.sourceReadKind==='profile'&&!(/\b(?:I|we|he|she)\s+(?:(?:have|has|had|am|is|are|was|were|did|personally|independently|also|now)\s+){0,3}(?:wrote|writ(?:e|es|ing)|built|build(?:s|ing)?|creat(?:e|es|ed|ing)|found(?:ed|s|ing)?|design(?:ed|s|ing)?|develop(?:ed|s|ing)?|implement(?:ed|s|ing)?|author(?:ed|s|ing)?|led|lead(?:s|ing)?|instruct(?:ed|s|ing)?|releas(?:e|es|ed|ing)|publish(?:ed|es|ing)?)\b|(?:我|本人|他|她)(?:们)?(?:曾|亲自|独立)?(?:编写|开发|设计|创办|创建|发布|带领)/iu.test(quote)))return '主页或索引描述未绑定明确个人创作/贡献动作；不能填作品行动维度，请保留页面描述或引用实际作品的贡献原文。';
  if(/\bfirst\s+(?:\w+\s+){0,4}(?:course|class)\b/iu.test(quote)&&/首位.{0,16}课程/u.test(claim.statement))return '原文首门课程不能改写为首位课程设计者；请保留课程与人物的不同限定。';
  if(!/\p{Script=Han}/u.test(claim.statement))return null;
  let statement=claim.statement;
  // A bound, leading source citation labels the claim; it is not a named fact
  // from the quotation. Other source IDs and terms remain subject to the guard.
  if(claim.sourceKey&&/^S[1-9]\d*$/.test(claim.sourceKey))statement=statement.trimStart().replace(new RegExp(`^(?:\\[${claim.sourceKey}\\]|${claim.sourceKey})(?=\\s|[：:，,]|帖|来源|页面|中)`),' ');
  if(claim.sourceReadUrl){try{
   const source=new URL(claim.sourceReadUrl);
   statement=statement.replace(/https?:\/\/[^\s，。；：）)\]「」『』“”‘’"'`<>]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s，。；：）)\]「」『』“”‘’"'`<>]*)?/giu,token=>{
    if(token.toLowerCase()===source.hostname)return ' ';
    try{return new URL(/^https?:\/\//i.test(token)?token:'https://'+token).href===source.href?' ':token;}catch{return token;}
   });
  }catch{/* An invalid stored source cannot exempt any term. */}}
  const stem=(term:string)=>(term.length>3&&/[^s]s$/i.test(term)||/^[A-Z]{2,}s$/u.test(term))?term.slice(0,-1).toLowerCase():term.toLowerCase();
  const terms=(text:string)=>(text.replace(/([a-z])\s+(?=\d)/giu,'$1').match(/\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*\b/gu)??[]);
  const words=new Set(terms(quote).map(stem));
  const missing=terms(statement).filter(term=>term.length>1&&!words.has(stem(term)));
  return missing.length?'陈述包含本条引文没有的英文命名词；不能从其它段落、条目或元数据补入，请缩短陈述或选择完整连续原文后重新核验。':null;
}

/** Eligibility for explicit preference-role reversals, never general entailment. */
export function claimPreferenceRoleIssue(claim:{statement:string;quote:string;quoteRolePolicy?:'preserve_actor/v1'}):string|null {
 if(!claim.quoteRolePolicy)return null;
 const quote=claim.quote.replace(/<[^>]*>/g,' ');
 const humanPreference=/\bhuman[-\s]preferred\b|人类(?:所)?偏好/iu.test(quote);
 const machinePreference=/\b(?:AI(?:s)?|LLM(?:s)?|models?|systems?)(?:'s)?[-\s]+(?:preferred|prefers?|prefer)\b|(?:AI|LLM|模型|系统|人工智能|机器)\s*(?:自身|自己)?\s*(?:的|所)?\s*偏好/iu;
 return humanPreference&&!machinePreference.test(quote)&&machinePreference.test(claim.statement)?'原文偏好主体是人类，不能将面向或来自机器的输入/输出改成机器自身偏好；请保留判断主体与方向。':null;
}

export function claimEvidenceIssue(claim: { statement: string; quote: string;sourceKey?:string;kind?:string;facet?:ResearchFacet;authorialBasis?:ClaimAuthorialBasis;sourceReadKind?:string;sourceReadUrl?:string;quoteLexicalPolicy?:'literal_terms/v1';quoteRolePolicy?:'preserve_actor/v1' }, policy?: 'exact_quote/v1'): string | null {
  return claimScopeIssue(claim) ?? (policy === 'exact_quote/v1' ? claimQuotedYearIssue(claim) ?? claimAuthorialIssue(claim) ?? claimLiteralTermIssue(claim) ?? claimPreferenceRoleIssue(claim) : null);
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
