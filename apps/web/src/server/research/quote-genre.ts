import {createHash} from 'node:crypto';
import type {ResearchClaim} from './research-store.js';

export function genreReviewIssue(claim:ResearchClaim,page:{url:string;text:string}|undefined,policy?:'genre_context/v1'):string|null {
 if(!policy)return null;
 const review=claim.genreReview;
 if(!review||review.policy!==policy||review.decision!=='literal_relevant')return '未通过现实人物语体与相关性核验。';
 if(!page||review.sourceUrl!==page.url||createHash('sha256').update(page.text).digest('hex')!==review.sourceContentHash||!Number.isSafeInteger(review.quoteOffset)||review.quoteOffset<0||page.text.slice(review.quoteOffset,review.quoteOffset+claim.quote.length)!==claim.quote||review.contextOffset!==Math.max(0,review.quoteOffset-400)||review.contextLength!==Math.min(page.text.length,review.quoteOffset+claim.quote.length+400)-review.contextOffset)return '语体核验与当前原文或引文位置不绑定。';
 return null;
}

/** Controller-owned receipt binding; model text cannot supply these offsets. */
export function bindGenreReview(claim:ResearchClaim,page:{url:string;text:string}):NonNullable<ResearchClaim['genreReview']> {
 const quoteOffset=page.text.indexOf(claim.quote),contextOffset=Math.max(0,quoteOffset-400);
 return {policy:'genre_context/v1',decision:'literal_relevant',sourceUrl:page.url,sourceContentHash:createHash('sha256').update(page.text).digest('hex'),quoteOffset,contextOffset,contextLength:Math.min(page.text.length,quoteOffset+claim.quote.length+400)-contextOffset};
}
export function parseGenreDecisions(value:unknown,count:number):Map<number,'literal_relevant'|'exclude'|'uncertain'>|null {
 if(!Array.isArray(value)||value.length!==count)return null;
 const decisions=new Map<number,'literal_relevant'|'exclude'|'uncertain'>();
 for(const item of value){
  if(!item||typeof item!=='object'||!Number.isInteger(item.index)||item.index<0||item.index>=count||decisions.has(item.index)||!['literal_relevant','exclude','uncertain'].includes(item.decision))return null;
  decisions.set(item.index,item.decision);
 }
 return decisions;
}
