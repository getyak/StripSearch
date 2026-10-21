import type {
  ProviderName,
  ProviderResult,
  RunInput,
  SourceDraft
} from '../../shared/types.js';

export type StageStatus = 'active' | 'done' | 'error' | 'unavailable';

export interface ProviderReporter {
  stage(index: number, total: number, key: string, label: string, status: StageStatus, detail?: string): void;
  source(draft: SourceDraft): void;
}

export interface HttpHeadersLike {
  get(name: string): string | null;
}

export interface HttpResponseLike {
  status: number;
  ok: boolean;
  redirected?: boolean;
  headers: HttpHeadersLike;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'error' | 'follow' | 'manual';
}

export interface HttpTransport {
  fetch(url: string, init?: HttpRequestInit): Promise<HttpResponseLike>;
}

export const defaultTransport: HttpTransport = {
  fetch(url, init) {
    return fetch(url, init as RequestInit) as unknown as Promise<HttpResponseLike>;
  }
};

export type ProviderErrorCode =
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_forbidden'
  | 'provider_not_found'
  | 'provider_billing'
  | 'provider_response_too_large'
  | 'provider_redirect'
  | 'provider_bad_response'
  | 'provider_error'
  | 'provider_unavailable';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderContext {
  transport: HttpTransport;
  signal: AbortSignal;
  report: ProviderReporter;
  githubToken: string | null;
  exaApiKey: string | null;
  timeoutMs: number;
  maxBytes: number;
}

export interface ResearchProvider {
  readonly name: ProviderName;
  readonly available: boolean;
  run(input: RunInput, context: ProviderContext): Promise<ProviderResult>;
}

export type ProviderFactory = (name: ProviderName) => ResearchProvider;
