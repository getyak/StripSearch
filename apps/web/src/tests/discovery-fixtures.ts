import { startTestServer, type TestServer } from './harness.js';
import type { HttpRequestInit, HttpResponseLike, HttpTransport } from '../server/adapters/types.js';
import type { PlatformRegistry } from '../shared/platform-discovery.js';

export interface FakeRoute {
  status?: number;
  body?: string;
  delayMs?: number;
  contentType?: string;
}

export class FakeTransport implements HttpTransport {
  readonly calls: string[] = [];

  constructor(private readonly routes: Record<string, FakeRoute>) {}

  async fetch(url: string, init?: HttpRequestInit): Promise<HttpResponseLike> {
    this.calls.push(url);
    const route = this.routes[url];
    if (!route) {
      return { status: 404, ok: false, headers: { get: () => null }, text: async () => '' };
    }
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    }
    const status = route.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: name => name.toLowerCase() === 'content-type' ? route.contentType ?? 'application/json' : null },
      text: async () => route.body ?? ''
    };
  }

  count(fragment: string): number {
    return this.calls.filter((url) => url.includes(fragment)).length;
  }
}

export const FIXTURE_REGISTRY: PlatformRegistry = {
  version: 'fixture-2026-09-27.1',
  generatedAt: '2026-09-27',
  rules: [
    {
      platformId: 'fixturecode',
      name: 'Fixture Code',
      category: 'code',
      subjectKinds: ['username'],
      homepage: 'https://fixturecode.example.test',
      probe: {
        kind: 'http_status',
        transport: 'api_http',
        method: 'GET',
        urlTemplate: 'https://fixturecode.example.test/users/{username}',
        foundStatuses: [200],
        notFoundStatuses: [404],
        blockedStatuses: [429],
        foundMarker: null,
        notFoundMarker: null
      },
      posts: {
        kind: 'json_list',
        urlTemplate: 'https://fixturecode.example.test/users/{username}/posts?page={page}',
        maxPages: 2,
        itemsPath: 'items',
        fields: { id: 'id', url: 'url', title: 'title', publishedAt: 'publishedAt', excerpt: 'excerpt' }
      },
      rateLimitPerMinute: 60,
      verification: 'offline_fixture',
      verificationNote: '合成夹具规则，仅离线测试。',
      notes: []
    },
    {
      platformId: 'fixtureblog',
      name: 'Fixture Blog',
      category: 'writing',
      subjectKinds: ['username'],
      homepage: 'https://fixtureblog.example.test',
      probe: {
        kind: 'http_marker',
        transport: 'profile_http',
        method: 'GET',
        urlTemplate: 'https://fixtureblog.example.test/@{username}',
        foundStatuses: [200],
        notFoundStatuses: [404],
        blockedStatuses: [403],
        foundMarker: 'profile-marker',
        notFoundMarker: 'no-such-user'
      },
      posts: {
        kind: 'rss',
        urlTemplate: 'https://fixtureblog.example.test/feed/@{username}',
        maxPages: 1,
        itemsPath: '',
        fields: { id: 'guid', url: 'link', title: 'title', publishedAt: 'pubDate', excerpt: 'description' }
      },
      rateLimitPerMinute: 60,
      verification: 'offline_fixture',
      verificationNote: '合成夹具规则，仅离线测试。',
      notes: []
    }
  ]
};

function postsPage(page: number, count: number): string {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `p${page}-${index + 1}`,
    url: `https://fixturecode.example.test/alice/p${page}-${index + 1}`,
    title: `帖子 ${page}-${index + 1}`,
    publishedAt: '2026-07-20T10:00:00Z',
    excerpt: `摘录 ${page}-${index + 1}`
  }));
  return JSON.stringify({ items });
}

export function defaultRoutes(overrides: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    'https://fixturecode.example.test/users/alice': {
      status: 200,
      body: JSON.stringify({ login: 'alice' })
    },
    'https://fixtureblog.example.test/@alice': {
      status: 200,
      body: '<html>no-such-user</html>'
    },
    'https://fixturecode.example.test/users/alice/posts?page=1': { status: 200, body: postsPage(1, 2) },
    'https://fixturecode.example.test/users/alice/posts?page=2': { status: 200, body: postsPage(2, 1) },
    ...overrides
  };
}

export async function startDiscoveryServer(
  routes: Record<string, FakeRoute>
): Promise<{ server: TestServer; transport: FakeTransport }> {
  const transport = new FakeTransport(routes);
  const server = await startTestServer({ transport, discoveryRegistry: FIXTURE_REGISTRY });
  return { server, transport };
}

export interface TaskDetail {
  task: {
    taskId: string;
    state: string;
    stage: string;
    revision: number;
    needsInputPrompt: string | null;
    interrupted: boolean;
    stopReason: string | null;
  };
  checkpoint: { completedProbeKeys: string[]; stage: string };
  probes: {
    platformId: string;
    status: string;
    method: string;
    verification: string;
    receipt: { tool: string };
    limitations: string[];
  }[];
  links: {
    id: string;
    platformId: string;
    state: string;
    basis: string[];
    attribution: string;
    revisions: { action: string; actor: string; toState: string }[];
  }[];
  posts: {
    postKey: string;
    valid: boolean;
    attribution: string;
    excluded: boolean;
    url: string;
  }[];
  imports: { tool: string; resultCount: number }[];
  events: { type: string }[];
}
