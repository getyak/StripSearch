import type { HttpTransport } from '../adapters/types.js';
export type ResearchToolAction =
 | { type: 'search'; query: string }
 | { type: 'read' | 'firecrawl' | 'social_profile' | 'social_posts' | 'github_profile'; url: string };
export interface ResearchAccount { platform: 'github' | 'x'; handle: string; id: string; profileUrl: string }
export interface ResearchPage {
 url: string; title: string; text: string; kind: 'profile' | 'work' | 'third_party';
 publishedAt: string | null; account?: ResearchAccount; links: string[]; limitations: string[];
 author?: string | null; retrievedAt?: string; retrieval?: 'search' | 'read' | 'profile'; textTruncated?: boolean;
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
}
export interface ResearchTools { execute(action: ResearchToolAction, signal: AbortSignal): Promise<ResearchToolResult> }

