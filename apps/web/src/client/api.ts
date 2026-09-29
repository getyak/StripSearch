import type {
  CanonicalView,
  ProviderName,
  RunEventRecord,
  RunSummary,
  SessionUser
} from '../shared/types.js';
import type {
  ReviewAnnotationSaveInput,
  ReviewAnnotationView,
  ReviewCaseResponse,
  ReviewHistoryEntry,
  ReviewInsights,
  ReviewProgress,
  ReviewQueueItem
} from '../shared/review.js';
import type { ResearchTaskInput, ResearchTaskListItem, ResearchTaskView } from '../shared/research-task.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiEnvelope {
  run?: CanonicalView;
  runs?: RunSummary[];
  events?: RunEventRecord[];
  latestSeq?: number;
  idempotent?: boolean;
  changed?: boolean;
  code?: string;
  error?: { code?: string; message?: string };
  message?: string;
}

export interface CreateRunInput {
  question: string;
  seedUrl: string | null;
  provider: ProviderName;
  parentRunId?: string | null;
  retryOf?: string | null;
  followup?: boolean;
}

export type ExportFormat = 'markdown' | 'json' | 'html' | 'pdf';

export type ResumeInput = { seedUrl: string } | { candidateId: string; expectedRevision: number };

export interface HealthResponse {
  status: string;
  app: string;
  version: string;
  capabilities: { github: boolean; exa: boolean; research?: boolean };
  limits: Record<string, number>;
}

export class ApiClient {
  private requestToken = 0;

  constructor(private readonly baseUrl = '') {}

  private async request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const envelope = (body ?? {}) as ApiEnvelope;
      const code = envelope.error?.code ?? envelope.code ?? `http_${response.status}`;
      const message =
        envelope.error?.message ??
        envelope.message ??
        (typeof body === 'string' && body.length > 0 ? body : '请求失败。');
      throw new ApiError(response.status, String(code), message);
    }
    return body as T;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/health');
  }

  async session(): Promise<{ user: SessionUser; session: { id: string } } | null> {
    try {
      const data = await this.request<{ user?: SessionUser; session?: { id: string } } | null>(
        '/api/auth/get-session'
      );
      if (!data?.user) return null;
      return { user: data.user, session: { id: data.session?.id ?? '' } };
    } catch {
      return null;
    }
  }

  private async authenticate(
    pathname: string,
    payload: Record<string, string>
  ): Promise<{ user: SessionUser }> {
    const data = await this.request<{ user?: SessionUser; error?: { message?: string } }>(pathname, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!data?.user) {
      throw new ApiError(400, 'auth_failed', '登录失败。');
    }
    return { user: data.user };
  }

  signUp(payload: { name: string; email: string; password: string }): Promise<{ user: SessionUser }> {
    return this.authenticate('/api/auth/sign-up/email', payload);
  }

  signIn(payload: { email: string; password: string }): Promise<{ user: SessionUser }> {
    return this.authenticate('/api/auth/sign-in/email', payload);
  }

  async signOut(): Promise<void> {
    await this.request('/api/auth/sign-out', { method: 'POST', body: '{}' });
  }

  async listRuns(): Promise<RunSummary[]> {
    const data = await this.request<{ runs: RunSummary[] }>('/api/runs');
    return data.runs ?? [];
  }

  private nextIdempotencyKey(label: string): string {
    const token = ++this.requestToken;
    return `${label}-${token}-${Date.now().toString(36)}`;
  }

  async createRun(input: CreateRunInput): Promise<{ run: CanonicalView; idempotent: boolean }> {
    const idempotencyKey = this.nextIdempotencyKey('run');
    const data = await this.request<ApiEnvelope>('/api/runs', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input)
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return { run: data.run, idempotent: Boolean(data.idempotent) };
  }

  async createResearch(input: string, idempotencyKey: string): Promise<{ run: CanonicalView; idempotent: boolean }> {
    const data = await this.request<ApiEnvelope>('/api/runs', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ input })
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return { run: data.run, idempotent: Boolean(data.idempotent) };
  }

  async getRun(id: string, since = 0): Promise<{ run: CanonicalView; events: RunEventRecord[]; latestSeq: number }> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}?since=${since}&events=1`);
    if (!data.run) throw new ApiError(404, 'run_not_found', '未找到该研究。');
    return { run: data.run, events: data.events ?? [], latestSeq: data.latestSeq ?? 0 };
  }

  async cancelRun(id: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}'
    });
    if (!data.run) throw new ApiError(404, 'run_not_found', '未找到该研究。');
    return data.run;
  }

  async resumeRun(id: string, resolution: string | ResumeInput): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: JSON.stringify(typeof resolution === 'string' ? { seedUrl: resolution } : resolution)
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return data.run;
  }

  async retryRun(id: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      headers: { 'idempotency-key': this.nextIdempotencyKey('retry') },
      body: '{}'
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return data.run;
  }

  async followup(id: string, question: string): Promise<CanonicalView> {
    const data = await this.request<ApiEnvelope>(`/api/runs/${encodeURIComponent(id)}/followup`, {
      method: 'POST',
      headers: { 'idempotency-key': this.nextIdempotencyKey('followup') },
      body: JSON.stringify({ question })
    });
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return data.run;
  }

  async deleteRun(id: string): Promise<void> {
    await this.request(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async exportRun(id: string, format: 'markdown' | 'json'): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/api/runs/${encodeURIComponent(id)}/export?format=${format}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) {
      throw new ApiError(response.status, 'export_failed', '导出失败。');
    }
    return response.text();
  }

  async exportBlob(id: string, format: ExportFormat, revision: number): Promise<Blob> {
    const response = await fetch(
      `${this.baseUrl}/api/runs/${encodeURIComponent(id)}/export?format=${format}&revision=${revision}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiEnvelope | null;
      throw new ApiError(response.status, body?.error?.code ?? body?.code ?? 'export_failed',
        body?.error?.message ?? body?.message ?? '导出失败，请稍后重试。');
    }
    return response.blob();
  }

  async setExclusion(
    id: string,
    sourceKey: string,
    exclude: boolean,
    expectedRevision: number
  ): Promise<{ run: CanonicalView; changed: boolean }> {
    const action = exclude ? 'exclude' : 'restore';
    const data = await this.request<ApiEnvelope>(
      `/api/runs/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceKey)}/${action}`,
      { method: 'POST', body: JSON.stringify({ expectedRevision }) }
    );
    if (!data.run) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究数据。');
    return { run: data.run, changed: Boolean(data.changed) };
  }

  /* ---------------- annotation workbench ---------------- */

  async seedReviewCases(): Promise<{ inserted: number; total: number; badge: string }> {
    return this.request<{ inserted: number; total: number; badge: string }>('/api/review/seed', {
      method: 'POST',
      body: '{}'
    });
  }

  async listReviewCases(): Promise<{ cases: ReviewQueueItem[]; progress: ReviewProgress }> {
    const data = await this.request<{ cases?: ReviewQueueItem[]; progress?: ReviewProgress }>(
      '/api/review/cases'
    );
    return {
      cases: data.cases ?? [],
      progress: data.progress ?? { total: 0, reviewed: 0, draft: 0, unreviewed: 0 }
    };
  }

  async createReviewCase(input: {
    title?: string;
    question: string;
    asOf?: string | null;
    sources: { title: string; text: string; locator?: string | null }[];
    candidates: { response: string; origin?: string | null; model?: string | null; notes?: string | null }[];
  }): Promise<ReviewQueueItem> {
    const data = await this.request<{ case?: ReviewQueueItem }>('/api/review/cases', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    if (!data.case) throw new ApiError(500, 'invalid_response', '服务器响应缺少案例数据。');
    return data.case;
  }

  async getReviewCase(caseId: string): Promise<ReviewCaseResponse> {
    const data = await this.request<ReviewCaseResponse>(
      `/api/review/cases/${encodeURIComponent(caseId)}`
    );
    if (!data.case) throw new ApiError(404, 'case_not_found', '未找到该标注案例。');
    return { case: data.case, annotation: data.annotation ?? null, history: data.history ?? [] };
  }

  async saveReviewAnnotation(
    caseId: string,
    input: ReviewAnnotationSaveInput
  ): Promise<{ annotation: ReviewAnnotationView; acknowledgment: string }> {
    const data = await this.request<{ annotation?: ReviewAnnotationView; acknowledgment?: string }>(
      `/api/review/cases/${encodeURIComponent(caseId)}/annotation`,
      { method: 'PUT', body: JSON.stringify(input) }
    );
    if (!data.annotation) throw new ApiError(500, 'invalid_response', '服务器响应缺少保存结果。');
    return { annotation: data.annotation, acknowledgment: data.acknowledgment ?? '已保存' };
  }

  async deleteReviewCase(caseId: string): Promise<void> {
    await this.request(`/api/review/cases/${encodeURIComponent(caseId)}`, { method: 'DELETE' });
  }

  async getReviewInsights(): Promise<ReviewInsights> {
    const data = await this.request<{ insights?: ReviewInsights }>('/api/review/insights');
    if (!data.insights) throw new ApiError(500, 'invalid_response', '服务器响应缺少汇总数据。');
    return data.insights;
  }

  async getReviewHistory(
    caseId: string
  ): Promise<{ history: ReviewHistoryEntry[]; revisions: ReviewAnnotationView[] }> {
    const data = await this.request<{ history?: ReviewHistoryEntry[]; revisions?: ReviewAnnotationView[] }>(
      `/api/review/cases/${encodeURIComponent(caseId)}/history`
    );
    return { history: data.history ?? [], revisions: data.revisions ?? [] };
  }

  async exportReview(format: 'json' | 'jsonl', filter: 'all' | 'reviewed'): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/api/review/export?format=${format}&filter=${filter}`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) throw new ApiError(response.status, 'export_failed', '导出失败。');
    return response.text();
  }

  /* ------------- candidate-free research task library ------------- */

  async listResearchTasks(): Promise<{ tasks: ResearchTaskListItem[]; note: string }> {
    const data = await this.request<{ tasks?: ResearchTaskListItem[]; note?: string }>(
      '/api/review/research-tasks'
    );
    return { tasks: data.tasks ?? [], note: data.note ?? '' };
  }

  async createResearchTask(
    input: ResearchTaskInput
  ): Promise<{ task: ResearchTaskView; created: boolean }> {
    const data = await this.request<{ task?: ResearchTaskView; created?: boolean }>(
      '/api/review/research-tasks',
      { method: 'POST', body: JSON.stringify(input) }
    );
    if (!data.task) throw new ApiError(500, 'invalid_response', '服务器响应缺少研究任务数据。');
    return { task: data.task, created: Boolean(data.created) };
  }

  async getResearchTask(taskId: string): Promise<ResearchTaskView> {
    const data = await this.request<{ task?: ResearchTaskView }>(
      `/api/review/research-tasks/${encodeURIComponent(taskId)}`
    );
    if (!data.task) throw new ApiError(404, 'research_task_not_found', '未找到该研究任务。');
    return data.task;
  }
}
