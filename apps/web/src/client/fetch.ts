/**
 * Web Fetch panel (GET-99): the visible authenticated entry for the real
 * GitHub public Fetch slice.
 *
 * The form requires explicit confirmation of the EXACT target account or
 * repository, the frozen question and the supported access scope before any
 * HTTP request can start — the start request echoes all three and the server
 * refuses anything else. The panel renders persisted runs after refresh,
 * shows real counts/progress with the frozen provider limitations and gaps,
 * lists pending evidence with source links and plain-text quotes (rendered
 * as text only, never as raw HTML) and offers pause / resume / stop. Resume
 * of a run with unknown-outcome requests demands an explicit choice: keep the
 * gap or re-issue the request with unknown prior cost — never a blind replay.
 */

import {
  accessScopeFor,
  parseFetchGithubTarget,
  type FetchGithubResumeRequest,
  type FetchGithubRunSummary,
  type FetchGithubRunView,
  type FetchGithubStartRequest,
  type FetchGithubTarget
} from '../shared/research-fetch-github.js';
import type { ApiClient } from './api.js';

type ById = <T extends HTMLElement>(id: string) => T;

export interface FetchPanelDeps {
  api: Pick<
    ApiClient,
    'fetchStart' | 'fetchList' | 'fetchView' | 'fetchPause' | 'fetchResume' | 'fetchStop'
  >;
  byId: ById;
  /** Called when a request fails with 401 so the app can open sign-in. */
  onUnauthorized?: () => void;
}

export interface FetchPanel {
  open(): Promise<void>;
  refresh(): Promise<void>;
  select(runId: string): Promise<void>;
  /** Identity switch / sign-out: drop every private run immediately. */
  reset(): void;
}

const STATE_LABELS: Record<FetchGithubRunView['state'], string> = {
  acquiring: '抓取中',
  paused: '已暂停',
  unreconciled: '有未确认结果（已停止，需显式处理）',
  processing: '快照处理中',
  finished: '已完成本次计划（研究问题仍以评估为准）',
  stopped: '已停止'
};

const SCOPE_LABELS = {
  github_public_account: '公开账号的自有仓库与 README',
  github_public_repository: '所选公开仓库的 issue、PR 正文及首页评论'
};
const EVIDENCE_LABELS: Record<string, string> = {
  identity_support: '身份支持（待核验）',
  identity_counterevidence: '身份反向证据（待核验）',
  factual_support: '事实支持（待核验）',
  factual_counterevidence: '事实反向证据（待核验）'
};
const PROCESSING_LABELS: Record<string, string> = {
  finished: '本轮已整理', yielded: '整理中', cancelled: '已取消', blocked: '需要处理缺口', failed: '整理失败'
};

export function createFetchPanel(deps: FetchPanelDeps): FetchPanel {
  const { api, byId } = deps;
  const state = {
    runs: [] as FetchGithubRunSummary[],
    selected: null as FetchGithubRunView | null,
    selectedRunId: null as string | null,
    identityEpoch: 0,
    listRequest: 0,
    detailRequest: 0,
    reconciliationFor: null as string | null,
    submitBusy: false,
    actionBusy: false,
    startAttempt: null as { input: string; key: string } | null
  };

  const setText = (id: string, text: string): void => {
    byId(id).textContent = text;
  };

  const fillList = (id: string, entries: { primary: string; secondary?: string }[]): void => {
    const list = byId<HTMLUListElement>(id);
    list.replaceChildren(
      ...entries.map((entry) => {
        const li = document.createElement('li');
        const strong = document.createElement('strong');
        strong.textContent = entry.primary;
        li.appendChild(strong);
        if (entry.secondary) {
          const small = document.createElement('small');
          small.textContent = entry.secondary;
          li.appendChild(small);
        }
        return li;
      })
    );
  };

  const parseTargetEcho = (): { target: FetchGithubTarget | null } => {
    const raw = byId<HTMLInputElement>('fetch-target').value.trim();
    const parsed = parseFetchGithubTarget(raw);
    const echo = byId('fetch-target-echo');
    if (parsed.ok) {
      const scope = accessScopeFor(parsed.target);
      echo.textContent = `确认目标：${parsed.target.canonicalUrl} · 访问范围：${SCOPE_LABELS[scope]}`;
      return { target: parsed.target };
    }
    echo.textContent = raw.length === 0 ? '' : '链接无法识别：请填写 https://github.com/<账号> 或 https://github.com/<账号>/<仓库>。';
    return { target: null };
  };

  const renderRunList = (): void => {
    const list = byId<HTMLUListElement>('fetch-run-list');
    list.replaceChildren(
      ...state.runs.map((summary) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button';
        button.dataset.fetchRunId = summary.runId;
        button.textContent = `${summary.targetUrl} · ${STATE_LABELS[summary.state] ?? summary.state}`;
        button.addEventListener('click', () => void panel.select(summary.runId));
        const detail = document.createElement('small');
        detail.textContent = `条目 ${String(summary.progress.items)} · 评论 ${String(summary.progress.comments)} · 请求 ${String(summary.progress.requests)} · 缺口 ${String(summary.progress.gaps)}`;
        li.append(button, detail);
        return li;
      })
    );
  };

  const renderDetail = (run: FetchGithubRunView): void => {
    byId<HTMLDivElement>('fetch-detail').hidden = false;
    setText('fetch-detail-title', `${run.target.canonicalUrl}`);
    setText(
      'fetch-detail-state',
      `状态：${STATE_LABELS[run.state] ?? run.state} · 阶段：${run.phase === 'acquire' ? '真实抓取' : '冻结快照处理'} · 问题：${run.question}`
    );
    const p = run.progress.requests;
    setText(
      'fetch-detail-progress',
      `请求 ${String(p.total)}（成功 ${String(p.succeeded)} · 失败 ${String(p.failed)} · 结果未知 ${String(p.unknown)} · 已拒绝 ${String(p.rejected)}） · 条目 ${String(run.progress.items)} · 首页评论 ${String(run.progress.comments)} · 快照${run.snapshot.frozen ? '已冻结' : '未冻结'}`
    );
    fillList(
      'fetch-limitations',
      run.limitations.map((limitation) => ({ primary: limitation }))
    );
    fillList(
      'fetch-gaps',
      run.gaps.length === 0
        ? [{ primary: '暂无显式缺口。' }]
        : run.gaps.map((gap) => ({ primary: gap.code, secondary: gap.detail }))
    );
    const evidence = byId<HTMLUListElement>('fetch-evidence');
    evidence.replaceChildren(
      ...run.pendingEvidence.map((entry) => {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.textContent = entry.sourceTitle ?? entry.sourceUrl ?? entry.evidenceId;
        if (entry.sourceUrl) {
          link.href = entry.sourceUrl;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
        }
        const quote = document.createElement('blockquote');
        // Plain text only: untrusted captured prose is never rendered as HTML.
        quote.textContent = entry.revokedAt === null ? entry.quote : `（已撤回）${entry.quote}`;
        const meta = document.createElement('small');
        meta.textContent = `${EVIDENCE_LABELS[entry.role] ?? '证据角色待确认'} · ${entry.author ?? '作者未知'} · ${entry.publishedAt ?? '时间未标注'}${entry.revokedAt !== null ? ' · 已撤回' : ''}`;
        li.append(link, quote, meta);
        return li;
      })
    );
    const processing = run.processing;
    setText(
      'fetch-processing',
      processing === null
        ? '尚未进入快照处理阶段。'
        : `证据整理：${PROCESSING_LABELS[processing.state] ?? '待核查'} · 已暂存 ${String(run.pendingEvidence.length)} 条证据 · 研究问题仍待核验。`
    );
    byId<HTMLButtonElement>('fetch-pause').disabled = run.state !== 'acquiring' && run.state !== 'processing';
    byId<HTMLButtonElement>('fetch-resume').disabled = run.state !== 'paused' && run.state !== 'unreconciled';
    const needsChoice = (run.state === 'paused' || run.state === 'unreconciled') &&
      (run.needsReconciliation ?? (run.state === 'unreconciled' || run.progress.requests.unknown > 0 || run.progress.requests.inFlight > 0));
    const reconciliationFor = needsChoice ? `${run.runId}:${String(run.revision)}` : null;
    const resumeChoice = byId<HTMLSelectElement>('fetch-resume-choice');
    if (state.reconciliationFor !== reconciliationFor) resumeChoice.value = '';
    state.reconciliationFor = reconciliationFor;
    resumeChoice.hidden = !needsChoice;
    byId<HTMLButtonElement>('fetch-stop').disabled = run.state === 'finished' || run.state === 'stopped';
  };

  const refreshDetail = async (runId: string): Promise<void> => {
    const identityEpoch = state.identityEpoch;
    const detailRequest = ++state.detailRequest;
    try {
      const { run } = await api.fetchView(runId);
      if (identityEpoch !== state.identityEpoch || detailRequest !== state.detailRequest || state.selectedRunId !== runId) return;
      state.selected = run;
      renderDetail(run);
    } catch (error) {
      if (identityEpoch !== state.identityEpoch || detailRequest !== state.detailRequest) return;
      handleActionError(error);
    }
  };

  const handleActionError = (error: unknown): void => {
    const status = (error as { status?: number }).status;
    if (status === 401 && deps.onUnauthorized) {
      deps.onUnauthorized();
      return;
    }
    const message = (error as { message?: string }).message ?? '请求失败，请重试。';
    setText('fetch-detail-status', message);
    setText('fetch-form-status', message);
  };

  const panel: FetchPanel = {
    async open(): Promise<void> {
      await panel.refresh();
    },
    async refresh(): Promise<void> {
      const identityEpoch = state.identityEpoch;
      const listRequest = ++state.listRequest;
      try {
        const { runs } = await api.fetchList();
        if (identityEpoch !== state.identityEpoch || listRequest !== state.listRequest) return;
        state.runs = runs;
        renderRunList();
        if (state.selectedRunId) await refreshDetail(state.selectedRunId);
      } catch (error) {
        if (identityEpoch !== state.identityEpoch || listRequest !== state.listRequest) return;
        handleActionError(error);
      }
    },
    async select(runId: string): Promise<void> {
      state.reconciliationFor = null;
      byId<HTMLSelectElement>('fetch-resume-choice').value = '';
      state.selectedRunId = runId;
      state.selected = null;
      byId<HTMLDivElement>('fetch-detail').hidden = true;
      await refreshDetail(runId);
    },
    reset(): void {
      state.identityEpoch++;
      state.listRequest++;
      state.detailRequest++;
      state.runs = [];
      state.selected = null;
      state.selectedRunId = null;
      state.reconciliationFor = null;
      byId<HTMLSelectElement>('fetch-resume-choice').value = '';
      state.startAttempt = null;
      state.submitBusy = false;
      state.actionBusy = false;
      renderRunList();
      byId<HTMLDivElement>('fetch-detail').hidden = true;
      for (const id of ['fetch-detail-title', 'fetch-detail-state', 'fetch-detail-progress', 'fetch-detail-status', 'fetch-processing', 'fetch-target-echo']) setText(id, '');
      for (const id of ['fetch-limitations', 'fetch-gaps', 'fetch-evidence']) byId(id).replaceChildren();
      byId<HTMLInputElement>('fetch-target').value = '';
      byId<HTMLTextAreaElement>('fetch-question').value = '';
      byId<HTMLInputElement>('fetch-confirm').checked = false;
      byId<HTMLButtonElement>('fetch-submit').disabled = false;
      setText('fetch-form-status', '');
    }
  };

  const submit = async (): Promise<void> => {
    if (state.submitBusy) return;
    const { target } = parseTargetEcho();
    const question = byId<HTMLTextAreaElement>('fetch-question').value.trim();
    const confirmed = byId<HTMLInputElement>('fetch-confirm').checked;
    if (!target) {
      setText('fetch-form-status', '请填写有效的 GitHub 公开链接。');
      return;
    }
    if (question.length < 2) {
      setText('fetch-form-status', '请写一个具体的研究问题。');
      return;
    }
    const accessScope = accessScopeFor(target);
    if (!confirmed) {
      // Explicit confirmation of target + question + access scope is required
      // BEFORE any HTTP request.
      setText('fetch-form-status', '请先勾选确认目标、冻结的问题与支持的访问范围。');
      return;
    }
    const input: FetchGithubStartRequest = {
      targetUrl: target.canonicalUrl,
      question,
      accessScope,
      confirmation: true,
      confirmedTarget: target.canonicalUrl,
      confirmedQuestion: question,
      confirmedAccessScope: accessScope
    };
    const inputKey = JSON.stringify(input);
    if (!state.startAttempt || state.startAttempt.input !== inputKey) {
      state.startAttempt = { input: inputKey, key: `fetch-${crypto.randomUUID()}` };
    }
    const attempt = state.startAttempt;
    const identityEpoch = state.identityEpoch;
    state.submitBusy = true;
    byId<HTMLButtonElement>('fetch-submit').disabled = true;
    setText('fetch-form-status', '已确认，正在开始抓取…');
    try {
      const { run } = await api.fetchStart(input, attempt.key);
      if (identityEpoch !== state.identityEpoch) return;
      state.startAttempt = null;
      state.detailRequest++;
      state.selectedRunId = run.runId;
      state.selected = run;
      renderDetail(run);
      await panel.refresh();
      if (identityEpoch !== state.identityEpoch) return;
      setText('fetch-form-status', '');
    } catch (error) {
      if (identityEpoch !== state.identityEpoch) return;
      handleActionError(error);
    } finally {
      if (identityEpoch === state.identityEpoch) {
        state.submitBusy = false;
        byId<HTMLButtonElement>('fetch-submit').disabled = false;
      }
    }
  };

  const action = async (fn: () => Promise<{ run: FetchGithubRunView }>): Promise<void> => {
    if (state.actionBusy || !state.selected) return;
    const identityEpoch = state.identityEpoch;
    const runId = state.selected.runId;
    state.actionBusy = true;
    try {
      const { run } = await fn();
      if (identityEpoch !== state.identityEpoch || state.selectedRunId !== runId) return;
      state.selected = run;
      renderDetail(run);
      await panel.refresh();
      if (identityEpoch !== state.identityEpoch || state.selectedRunId !== runId) return;
      setText('fetch-detail-status', '');
    } catch (error) {
      if (identityEpoch !== state.identityEpoch || state.selectedRunId !== runId) return;
      handleActionError(error);
    } finally {
      if (identityEpoch === state.identityEpoch) state.actionBusy = false;
    }
  };

  // Wiring (the panel owns exactly the Web Fetch view elements).
  byId<HTMLFormElement>('fetch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  byId<HTMLInputElement>('fetch-target').addEventListener('input', () => {
    byId<HTMLInputElement>('fetch-confirm').checked = false;
    state.startAttempt = null;
    parseTargetEcho();
    setText('fetch-form-status', '');
  });
  byId<HTMLTextAreaElement>('fetch-question').addEventListener('input', () => {
    byId<HTMLInputElement>('fetch-confirm').checked = false;
    state.startAttempt = null;
    setText('fetch-form-status', '');
  });
  byId<HTMLButtonElement>('fetch-refresh').addEventListener('click', () => void panel.refresh());
  byId<HTMLButtonElement>('fetch-pause').addEventListener('click', () => {
    const selected = state.selected;
    if (!selected) return;
    void action(() => api.fetchPause(selected.runId, selected.revision));
  });
  byId<HTMLButtonElement>('fetch-resume').addEventListener('click', () => {
    const selected = state.selected;
    if (!selected) return;
    const choice = byId<HTMLSelectElement>('fetch-resume-choice').value;
    if (state.reconciliationFor !== null && choice !== 'retry' && choice !== 'skip') {
      setText('fetch-detail-status', '请先选择：保留未确认请求为缺口，或明确同意重新发起。');
      return;
    }
    const input: FetchGithubResumeRequest = {
      ...(state.reconciliationFor !== null ? { reconcileUnknown: choice as 'retry' | 'skip' } : {}),
      expectedRevision: selected.revision
    };
    void action(() => api.fetchResume(selected.runId, input));
  });
  byId<HTMLButtonElement>('fetch-stop').addEventListener('click', () => {
    const selected = state.selected;
    if (!selected) return;
    void action(() => api.fetchStop(selected.runId, selected.revision));
  });

  return panel;
}
