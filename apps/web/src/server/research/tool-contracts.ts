import type { HttpTransport } from '../adapters/types.js';
export type ResearchToolAction =
 | { type: 'search'; query: string; numResults?: number; provider?: 'bluesky'; includeDomains?: readonly string[] }
 | { type: 'read' | 'firecrawl' | 'social_profile' | 'social_posts' | 'github_profile'; url: string };
export interface ResearchAccount { platform: 'github' | 'x'; handle: string; id: string; profileUrl: string }
/**
 * Source-backed alias proof for duplicate candidate projection. It is
 * generated ONLY by an adapter from an actual verified provider response and
 * always carries the original requested URL plus the actually returned URL
 * (and the stable native id for native profiles). The proof itself is never
 * identity support, never a scope permission and never a fallback URL: no
 * adapter may invent a returned URL it did not observe.
 */
export type ResearchAliasProof =
  | {
      kind: 'native_profile';
      /** Exact platform of the verified native profile (GitHub/X only). */
      platform: 'github' | 'x';
      /** Stable nonempty native id from the verified response. */
      nativeId: string;
      /** Original requested profile URL, exactly as dispatched. */
      requestedUrl: string;
      /** Canonical profile URL the provider actually returned (case alias). */
      returnedUrl: string;
    }
  | {
      kind: 'same_document_redirect';
      /** Original requested URL (the actual metadata.sourceURL matched it). */
      requestedUrl: string;
      /** Actual final metadata.url observed; same pathname+query, www/apex only. */
      returnedUrl: string;
    };
/** A link bound to an exact span of the retained original, never an index label. */
export interface ResearchLinkContext {
 url: string; quote: string; locator: string;
 binding: 'html_anchor' | 'html_rel_me' | 'markdown_link' | 'native_profile_field';
 surface: 'authorial' | 'profile_field' | 'third_party' | 'unknown';
}
export interface ResearchPage {
 url: string; title: string; text: string; kind: 'profile' | 'work' | 'third_party';
 publishedAt: string | null; account?: ResearchAccount; links: string[]; limitations: string[];
 author?: string | null; retrievedAt?: string; retrieval?: 'search' | 'read' | 'profile'; textTruncated?: boolean;
 linkContexts?: ResearchLinkContext[];
  /** Adapter-generated alias proof of THIS response; never model-claimed. */
  aliasProof?: ResearchAliasProof;
 /** Adapter-observed document binding; requested URL is never a substitute for returned URL. */
 documentBinding?: { requestedUrl: string; returnedUrl: string };
}
export interface ResearchToolResult {
 pages: ResearchPage[]; requests: number; bytes: number;
 estimatedUsd: number | null; credits: number | null; limitations: string[]; nextCursor?: string | null;
 /** Unread history, media, discussion or extraction completeness, distinct from cost notes. */
 coverageGaps?: string[];
}
export interface ResearchToolsOptions {
 transport: HttpTransport; exaApiKey: string | null; firecrawlApiKey: string | null;
 tikhubApiKey: string | null; githubToken: string | null; timeoutMs: number; maxBytes: number;
 /** Operator-owned pacing; model decisions cannot alter it. Default respects the smallest hosted scrape plan. */
 firecrawlIntervalMs?: number;
}
export interface ResearchTools { execute(action: ResearchToolAction, signal: AbortSignal): Promise<ResearchToolResult> }
