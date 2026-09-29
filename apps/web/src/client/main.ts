import { isTerminalState } from '../shared/types.js';
import type { CanonicalView, RunEventRecord, RunSummary, SessionUser } from '../shared/types.js';
import {
  validateQuestion,
  validateSeedUrl
} from '../shared/validation.js';
import { ApiClient, ApiError } from './api.js';
import type { ExportFormat, ResumeInput } from './api.js';
import { createAuthController, renderUserNav, showToast } from './auth.js';
import { byId, clear, make, setText, show } from './dom.js';
import { createReviewWorkbench } from './review.js';
import {
  renderActivity,
  renderFollowupRail,
  renderHistory,
  renderMessages,
  renderReport,
  renderSourceDetail,
  renderSourceFilters,
  renderSourceList,
  stagesFromEvents
} from './render.js';
import type { ChatMessage, SourceFilter, StageView } from './render.js';

type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface AppState {
  user: SessionUser | null;
  capabilities: { github: boolean; exa: boolean; research?: boolean } | null;
  runs: RunSummary[];
  run: CanonicalView | null;
  events: RunEventRecord[];
  latestSeq: number;
  stages: StageView[];
  messages: ChatMessage[];
  selectedSourceKey: string | null;
  filter: SourceFilter;
  stream: EventSource | null;
  streamState: StreamState;
  reconnectAttempts: number;
  reconnectTimer: number | null;
  refreshTimer: number | null;
  /** Bumped whenever the active run/user context changes; async results check it. */
  runEpoch: number;
  copyToken: number;
  copyBusy: boolean;
  copiedRevision: number | null;
  pendingSubmit: boolean;
  submitBusy: boolean;
  submitAttempt: { ownerId: string; input: string; key: string } | null;
  resumeBusy: boolean;
  activeRunId: string | null;
  signOutBusy: boolean;
}

const state: AppState = {
  user: null,
  capabilities: null,
  runs: [],
  run: null,
  events: [],
  latestSeq: 0,
  stages: [],
  messages: [],
  selectedSourceKey: null,
  filter: 'all',
  stream: null,
  streamState: 'idle',
  reconnectAttempts: 0,
  reconnectTimer: null,
  refreshTimer: null,
  runEpoch: 0,
  copyToken: 0,
  copyBusy: false,
  copiedRevision: null,
  pendingSubmit: false,
  submitBusy: false,
  submitAttempt: null,
  resumeBusy: false,
  activeRunId: null,
  signOutBusy: false
};

const api = new ApiClient();
const auth = createAuthController(api);

const FOLLOWUP_PROMPTS = [
  '还有哪些公开项目？',
  '最近更新集中在哪些方向？',
  '哪些结论还需要核对？'
];

const els = {
  home: byId('view-home'),
  app: byId('view-app'),
  appShell: byId<HTMLDivElement>('app-shell'),
  footer: byId('site-footer'),
  form: byId<HTMLFormElement>('research-form'),
  question: byId<HTMLTextAreaElement>('research-question'),
  questionError: byId('question-error'),
  formStatus: byId('form-status'),
  clearQuestion: byId<HTMLButtonElement>('clear-question'),
  submit: byId<HTMLButtonElement>('submit-research'),
  candidates: byId('identity-candidates'),
  statusSummary: byId('run-status-summary'),
  researchDetails: byId('research-details'),
  historyRail: byId('history-list'),
  drawerHistory: byId('drawer-history-list'),
  workTitle: byId('work-title-text'),
  deskState: byId('desk-state'),
  workRevision: byId('work-revision'),
  stopRun: byId<HTMLButtonElement>('stop-run'),
  copyReport: byId<HTMLButtonElement>('copy-report'),
  downloadMd: byId<HTMLButtonElement>('download-md'),
  downloadJson: byId<HTMLButtonElement>('download-json'),
  downloadHtml: byId<HTMLButtonElement>('download-html'),
  downloadPdf: byId<HTMLButtonElement>('download-pdf'),
  retryRun: byId<HTMLButtonElement>('retry-run'),
  deleteRun: byId<HTMLButtonElement>('delete-run'),
  toggleInspector: byId<HTMLButtonElement>('toggle-inspector'),
  reportQuestion: byId('report-question'),
  needsPanel: byId<HTMLElement>('needs-input-panel'),
  needsPrompt: byId('needs-input-prompt'),
  resumeSeed: byId<HTMLInputElement>('resume-seed'),
  resumeError: byId('resume-error'),
  resumeRun: byId<HTMLButtonElement>('resume-run'),
  activityPanel: byId<HTMLDetailsElement>('activity-panel'),
  activityState: byId('activity-state'),
  runIndicator: byId('run-indicator'),
  runProgress: byId('run-progress'),
  runProgressFill: byId('run-progress-fill'),
  runProgressText: byId('run-progress-text'),
  stageList: byId('stage-list'),
  report: byId('report'),
  chatLog: byId('chat-log'),
  followupRail: byId('followup-rail'),
  chatForm: byId<HTMLFormElement>('chat-form'),
  chatInput: byId<HTMLInputElement>('chat-input'),
  chatSend: byId<HTMLButtonElement>('chat-send'),
  chatHint: byId('chat-hint'),
  sourceInspector: byId('source-inspector'),
  sourceFilters: byId('source-filters'),
  inspectorSourceList: byId('inspector-source-list'),
  inspectorDetail: byId('inspector-detail'),
  drawerSourceFilters: byId('drawer-source-filters'),
  drawerSourceList: byId('drawer-source-list'),
  drawerSourceDetail: byId('drawer-source-detail'),
  sourceDrawer: byId<HTMLDialogElement>('source-drawer'),
  historyDrawer: byId<HTMLDialogElement>('history-drawer'),
  review: byId('view-review'),
  openReview: byId<HTMLButtonElement>('open-review')
};

const review = createReviewWorkbench({
  api,
  root: els.review,
  onToast: showToast,
  onUnauthorized: handleReviewUnauthorized,
  onNavigate: (caseId) => {
    const target = caseId ? `#/review/${encodeURIComponent(caseId)}` : '#/review';
    if (window.location.hash !== target) window.location.hash = target;
  }
});

/**
 * Drop every piece of owner-private state (research run, stream, messages and
 * review workbench) so an expired session or an account switch can never show
 * one account's data to another.
 */
function clearPrivateState(): void {
  state.user = null;
  state.runs = [];
  state.run = null;
  state.activeRunId = null;
  state.events = [];
  state.messages = [];
  state.selectedSourceKey = null;
  state.stages = [];
  state.latestSeq = 0;
  state.pendingSubmit = false;
  state.submitBusy = false;
  state.submitAttempt = null;
  state.resumeBusy = false;
  els.submit.disabled = false;
  els.form.removeAttribute('aria-busy');
  // Unsent input is private too; renderAll only clears rendered run content.
  els.question.value = '';
  els.chatInput.value = '';
  els.resumeSeed.value = '';
  els.clearQuestion.hidden = true;
  setText(els.questionError, '');
  setText(els.resumeError, '');
  setFormStatus('');
  state.runEpoch += 1;
  closeStream();
  review.reset();
  renderUserNav(null);
  // Render the cleared DOM synchronously so an identity switch can never
  // flash the previous account's research while its run list is pending.
  renderAll();
}

/** A review request returning 401 means the session ended; drop all private state. */
function handleReviewUnauthorized(): void {
  clearPrivateState();
  showToast('登录已失效，请重新登录。', 'error');
  if (window.location.hash !== '#/') window.location.hash = '#/';
  auth.open('signin', handleAuthSuccess);
}

function isCurrentUser(userId: string | null | undefined): boolean {
  return (state.user?.id ?? null) === (userId ?? null);
}

function isCurrentRun(runId: string, epoch: number): boolean {
  return state.runEpoch === epoch && state.run?.runId === runId;
}

function isNarrow(): boolean {
  return window.matchMedia('(max-width: 1220px)').matches;
}

/* ---------------- routing ---------------- */

function route(): void {
  const hash = window.location.hash;
  const appMatch = hash.match(/^#\/app(?:\/([^/?#]+))?$/);
  const wantsApp = Boolean(appMatch);
  const reviewMatch = hash.match(/^#\/review(?:\/([^/?#]+))?/);
  const wantsReview = Boolean(reviewMatch);
  if ((wantsApp || wantsReview) && !state.user) {
    window.location.hash = '#/';
    auth.open('signin', (user) => {
      handleAuthSuccess(user);
      window.location.hash = hash;
    });
    return;
  }
  els.home.hidden = wantsApp || wantsReview;
  els.app.hidden = !wantsApp;
  els.review.hidden = !wantsReview;
  els.footer.hidden = wantsApp || wantsReview;
  if (wantsReview) {
    let caseId: string | null = null;
    if (reviewMatch?.[1]) {
      try {
        caseId = decodeURIComponent(reviewMatch[1]);
      } catch {
        caseId = null;
      }
    }
    void review.open(caseId);
    return;
  }
  if (wantsApp && state.user) {
    let requestedRunId: string | null = null;
    if (appMatch?.[1]) {
      try { requestedRunId = decodeURIComponent(appMatch[1]); } catch { /* Invalid bookmarks fall back to history. */ }
    }
    if (requestedRunId && requestedRunId !== state.activeRunId) {
      void selectRun(requestedRunId);
    } else if (!requestedRunId && !state.activeRunId && state.runs.length > 0) {
      void selectRun(state.runs[0]!.runId);
    }
  }
}

function goHome(): void {
  window.location.hash = '#/';
}

/* ---------------- research flow ---------------- */

function setFormStatus(message: string): void {
  setText(els.formStatus, message);
}

function validateForm(): string | null {
  setText(els.questionError, '');
  const input = els.question.value.trim();
  const checked = validateQuestion(input);
  if (!checked.ok) {
    els.question.setAttribute('aria-invalid', 'true');
    setText(els.questionError, input.length < 2 ? '请输入一个姓名、公开主页或人物线索。' : checked.error ?? '输入内容过长。');
    els.question.focus();
    return null;
  }
  els.question.removeAttribute('aria-invalid');
  return input;
}

async function submitResearch(): Promise<void> {
  if (state.submitBusy || state.pendingSubmit) return;
  const input = validateForm();
  if (!input) return;
  if (!state.user) {
    state.pendingSubmit = true;
    auth.open('signin', (user) => {
      state.pendingSubmit = false;
      handleAuthSuccess(user);
      void submitResearch();
    });
    return;
  }
  const userId = state.user.id;
  const submissionEpoch = state.runEpoch;
  if (!state.submitAttempt || state.submitAttempt.ownerId !== userId || state.submitAttempt.input !== input) {
    state.submitAttempt = { ownerId: userId, input, key: `person-${crypto.randomUUID()}` };
  }
  const attempt = state.submitAttempt;
  state.submitBusy = true;
  els.submit.disabled = true;
  els.form.setAttribute('aria-busy', 'true');
  setFormStatus('已收到，正在开始了解…');
  try {
    const created = await api.createResearch(input, attempt.key);
    if (!isCurrentUser(userId) || state.runEpoch !== submissionEpoch) return;
    state.submitAttempt = null;
    closeStream();
    const epoch = ++state.runEpoch;
    state.activeRunId = created.run.runId;
    state.selectedSourceKey = null;
    state.messages = [];
    applySnapshot(created.run, [], 0);
    window.location.hash = `#/app/${encodeURIComponent(created.run.runId)}`;
    route();
    if (!isTerminalState(created.run.state) && created.run.state !== 'needs_input') {
      openStream(created.run.runId, 0, epoch);
    }
    void loadRuns();
    setFormStatus('');
  } catch (error) {
    if (!isCurrentUser(userId) || state.runEpoch !== submissionEpoch) return;
    if (error instanceof ApiError && error.status === 401) {
      auth.open('signin', (user) => {
        handleAuthSuccess(user);
        void submitResearch();
      });
    }
    setFormStatus(error instanceof ApiError ? error.message : '暂时未能确认请求结果。再次提交同一输入会继续核对，不会重复创建研究。');
    if (error instanceof ApiError && error.code === 'scope_disallowed') setText(els.questionError, error.message);
  } finally {
    if (isCurrentUser(userId) && (state.submitAttempt === attempt || state.submitAttempt === null)) {
      state.submitBusy = false;
      els.submit.disabled = false;
      els.form.removeAttribute('aria-busy');
    }
  }
}

function handleAuthSuccess(user: SessionUser): void {
  const previousUserId = state.user?.id ?? null;
  if (previousUserId !== null && previousUserId !== user.id) {
    // Identity switch: never carry the previous account's private state over.
    clearPrivateState();
  }
  state.user = user;
  // Invalidate anything queued for a previous session.
  state.runEpoch += 1;
  renderUserNav(user);
  void loadRuns();
  if (state.pendingSubmit) state.pendingSubmit = false;
  route();
}

async function signOut(): Promise<void> {
  if (state.signOutBusy) return;
  if (
    review.hasUnsavedChanges() &&
    !window.confirm('标注有未保存的修改，退出将丢失这些修改。确定退出吗？')
  ) {
    return;
  }
  state.signOutBusy = true;
  try {
    await api.signOut();
  } catch {
    showToast('退出失败，请重试。', 'error');
    return;
  } finally {
    state.signOutBusy = false;
  }
  // Only clear local state after the server confirms the session ended.
  clearPrivateState();
  setFormStatus('已退出登录。');
  goHome();
}

/* ---------------- run selection & streaming ---------------- */

async function loadRuns(): Promise<void> {
  const userId = state.user?.id ?? null;
  if (!userId) {
    state.runs = [];
    renderHistoryRail();
    return;
  }
  let runs: RunSummary[] = [];
  try {
    runs = await api.listRuns();
  } catch {
    runs = [];
  }
  if (!isCurrentUser(userId)) return;
  state.runs = runs;
  renderHistoryRail();
}

async function selectRun(runId: string): Promise<void> {
  const epoch = ++state.runEpoch;
  state.activeRunId = runId;
  state.resumeBusy = false;
  state.selectedSourceKey = null;
  state.filter = 'all';
  state.messages = [];
  state.copyToken += 1;
  state.copiedRevision = null;
  closeStream();
  let snapshot: { run: CanonicalView; events: RunEventRecord[]; latestSeq: number };
  try {
    snapshot = await api.getRun(runId);
  } catch (error) {
    if (state.runEpoch !== epoch) return;
    showToast(error instanceof ApiError ? error.message : '读取研究失败。', 'error');
    return;
  }
  if (state.runEpoch !== epoch) return;
  applySnapshot(snapshot.run, snapshot.events, snapshot.latestSeq);
  if (window.location.hash.startsWith('#/app')) {
    window.history.replaceState(null, '', `#/app/${encodeURIComponent(runId)}`);
    lastHash = window.location.hash;
  }
  if (state.run && !isTerminalState(state.run.state)) {
    openStream(runId, state.latestSeq, epoch);
  }
}

function applySnapshot(run: CanonicalView, events: RunEventRecord[], latestSeq: number): void {
  state.run = run;
  state.events = events;
  state.latestSeq = latestSeq;
  state.stages = stagesFromEvents(events);
  if (state.selectedSourceKey && !run.sources.some((source) => source.sourceKey === state.selectedSourceKey)) {
    state.selectedSourceKey = null;
  }
  renderAll();
}

function scheduleSnapshotRefresh(runId: string, epoch: number): void {
  if (state.refreshTimer !== null) window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    void (async () => {
      let snapshot: { run: CanonicalView; events: RunEventRecord[]; latestSeq: number };
      try {
        snapshot = await api.getRun(runId, state.latestSeq);
      } catch {
        return;
      }
      if (!isCurrentRun(runId, epoch)) return;
      // A request started before a newer SSE event cannot roll identity or evidence back.
      if (snapshot.latestSeq < state.latestSeq || snapshot.run.revision < (state.run?.revision ?? 0)) return;
      state.run = snapshot.run;
      state.events = mergeEvents(state.events, snapshot.events);
      state.latestSeq = Math.max(state.latestSeq, snapshot.latestSeq);
      state.stages = stagesFromEvents(state.events);
      renderAll();
    })();
  }, 90);
}

function mergeEvents(existing: RunEventRecord[], incoming: RunEventRecord[]): RunEventRecord[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, RunEventRecord>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function closeStream(): void {
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  state.streamState = 'idle';
}

function openStream(runId: string, since: number, epoch: number): void {
  closeStream();
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${since}`);
  state.stream = source;
  state.streamState = 'connecting';
  source.onopen = () => {
    if (state.runEpoch !== epoch || state.stream !== source) return;
    state.streamState = 'open';
    state.reconnectAttempts = 0;
  };
  for (const type of ['state', 'stage', 'source', 'observation', 'answer', 'needs_input', 'error', 'interrupted', 'revision', 'identity', 'person', 'usage']) {
    source.addEventListener(type, (event) => {
      if (state.runEpoch !== epoch || state.stream !== source) return;
      const message = event as MessageEvent<string>;
      let payload: unknown = null;
      try {
        payload = JSON.parse(message.data);
      } catch {
        payload = null;
      }
      handleEvent(type, payload, Number(message.lastEventId), epoch);
    });
  }
  source.addEventListener('done', () => {
    if (state.stream !== source) return;
    source.close();
    state.stream = null;
    state.streamState = 'idle';
    if (state.runEpoch === epoch) scheduleSnapshotRefresh(runId, epoch);
  });
  source.onerror = () => {
    if (state.stream !== source) return;
    source.close();
    state.stream = null;
    if (state.runEpoch !== epoch) return;
    state.streamState = 'reconnecting';
    updateStreamHint();
    scheduleReconnect(runId, epoch);
  };
}

function scheduleReconnect(runId: string, epoch: number): void {
  if (state.reconnectTimer !== null) window.clearTimeout(state.reconnectTimer);
  const attempt = Math.min(state.reconnectAttempts + 1, 6);
  state.reconnectAttempts = attempt;
  const delay = Math.min(500 * 2 ** (attempt - 1), 8000);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    void (async () => {
      let snapshot: { run: CanonicalView; events: RunEventRecord[]; latestSeq: number };
      try {
        snapshot = await api.getRun(runId, state.latestSeq);
      } catch {
        if (state.runEpoch === epoch) scheduleReconnect(runId, epoch);
        return;
      }
      if (!isCurrentRun(runId, epoch)) return;
      state.run = snapshot.run;
      state.events = mergeEvents(state.events, snapshot.events);
      state.latestSeq = Math.max(state.latestSeq, snapshot.latestSeq);
      state.stages = stagesFromEvents(state.events);
      renderAll();
      if (!isTerminalState(state.run.state)) openStream(runId, state.latestSeq, epoch);
    })();
  }, delay);
}

function handleEvent(type: string, payload: unknown, seq: number, epoch: number): void {
  if (state.runEpoch !== epoch || !state.run) return;
  if (Number.isFinite(seq) && seq > 0) {
    state.latestSeq = Math.max(state.latestSeq, seq);
    state.events.push({ seq, type, payload, createdAt: new Date().toISOString() });
  }
  const runId = state.run.runId;
  switch (type) {
    case 'stage':
      state.stages = stagesFromEvents(state.events);
      renderActivityPanel();
      break;
    case 'source': {
      const source = payload as CanonicalView['sources'][number] | null;
      if (source && !state.run.sources.some((item) => item.sourceKey === source.sourceKey)) {
        state.run.sources = [...state.run.sources, source];
      }
      renderSourcePanels();
      break;
    }
    case 'observation': {
      const observation = payload as {
        statement: string;
        kind: CanonicalView['observations'][number]['kind'];
        sourceKeys: string[];
      } | null;
      if (observation) {
        state.run.observations = [
          ...state.run.observations,
          {
            observationId: `live-${seq}`,
            statement: observation.statement,
            kind: observation.kind,
            sourceKeys: observation.sourceKeys ?? [],
            limitations: [],
            validity: 'valid',
            reviewReason: null
          }
        ];
        renderReportView();
      }
      break;
    }
    case 'answer': {
      const payloadObject = payload as { sections?: CanonicalView['answer'] } | null;
      if (payloadObject?.sections) {
        state.run.answer = payloadObject.sections.map((section) => ({
          ...section,
          bullets: section.bullets.map((bullet) => ({ ...bullet, validity: 'valid', reviewReason: null }))
        }));
        renderReportView();
      }
      scheduleSnapshotRefresh(runId, epoch);
      break;
    }
    case 'state': {
      const next = (payload as { state?: CanonicalView['state'] } | null)?.state;
      if (next) state.run.state = next;
      renderHeader();
      renderActivityPanel();
      if (next && isTerminalState(next)) scheduleSnapshotRefresh(runId, epoch);
      break;
    }
    case 'needs_input': {
      const data = payload as { prompt?: unknown; candidates?: unknown; revision?: unknown } | null;
      const prompt = typeof data?.prompt === 'string' ? data.prompt : '还需要一个能区分人物的线索。';
      state.run.identity = { ...state.run.identity, status: 'needs_input', note: prompt, candidates: parseCandidates(data?.candidates) };
      if (typeof data?.revision === 'number' && Number.isInteger(data.revision)) state.run.revision = data.revision;
      state.run.state = 'needs_input';
      renderHeader();
      renderNeedsPanel();
      break;
    }
    case 'error': {
      const message = (payload as { message?: string } | null)?.message ?? '研究失败。';
      showToast(message, 'error');
      scheduleSnapshotRefresh(runId, epoch);
      break;
    }
    case 'interrupted': {
      showToast((payload as { message?: string } | null)?.message ?? '研究中断。', 'error');
      scheduleSnapshotRefresh(runId, epoch);
      break;
    }
    case 'identity':
    case 'person':
    case 'usage':
    case 'revision':
      scheduleSnapshotRefresh(runId, epoch);
      break;
    default:
      break;
  }
}

/* ---------------- rendering ---------------- */

function renderAll(): void {
  renderHeader();
  renderNeedsPanel();
  renderRunSummary();
  renderActivityPanel();
  renderReportView();
  renderSourcePanels();
  renderHistoryRail();
  renderMessages(els.chatLog, state.messages);
  renderFollowup();
  updateStreamHint();
}

const RUN_STATE_LABELS: Record<CanonicalView['state'], string> = {
  queued: '排队中',
  researching: '正在查看资料',
  needs_input: '等待确认',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
};

function chatSupported(run: CanonicalView | null): boolean {
  return Boolean(run && String(run.provider) !== 'github');
}

function renderHeader(): void {
  const run = state.run;
  setText(els.workTitle, run ? run.identity.displayName || run.identity.handle || run.question : '未命名研究');
  setText(els.deskState, run ? RUN_STATE_LABELS[run.state] ?? run.state : '等待确认');
  setText(els.workRevision, run ? `v${run.revision}` : '');
  setText(els.reportQuestion, run ? run.question : '等待研究问题');
  const active = run ? run.state === 'queued' || run.state === 'researching' : false;
  const ready = Boolean(run && run.answer.length > 0);
  show(els.stopRun, active);
  els.stopRun.disabled = !active;
  show(els.retryRun, Boolean(run && isTerminalState(run.state)));
  show(els.deleteRun, Boolean(run));
  els.copyReport.disabled = !ready;
  els.downloadMd.disabled = !ready;
  els.downloadJson.disabled = !ready;
  els.downloadHtml.disabled = !ready;
  els.downloadPdf.disabled = !ready;
  const chatEnabled = Boolean(run && isTerminalState(run.state) && ready && chatSupported(run));
  els.chatInput.disabled = !chatEnabled;
  els.chatSend.disabled = !chatEnabled;
  setText(els.chatHint, chatHint(run, chatEnabled));
}

function chatHint(run: CanonicalView | null, chatEnabled: boolean): string {
  if (state.streamState === 'reconnecting') return '实时连接中断，正在重连；报告内容不会丢失。';
  if (!run) return '报告完成后可以继续追问。';
  if (!chatSupported(run)) return '这份旧资料只包含账号与作品记录。可返回首页开始新的完整研究。';
  if (chatEnabled) return '继续了解感兴趣的细节；新的研究会单独保存。';
  return '报告完成后可以继续追问。';
}

type IdentityCandidate = CanonicalView['identity']['candidates'][number] & { candidateId?: string; profileUrl?: string | null };

function parseCandidates(raw: unknown): IdentityCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is IdentityCandidate => Boolean(item && typeof item === 'object' && typeof item.label === 'string' && typeof item.detail === 'string'));
}

function renderNeedsPanel(): void {
  const run = state.run;
  const needs = Boolean(run && run.state === 'needs_input');
  show(els.needsPanel, needs);
  clear(els.candidates);
  if (needs && run) {
    setText(els.needsPrompt, run.identity.note ?? '补充一个公开主页，让我们确认你想了解的人。');
    if (els.resumeSeed.dataset.runId !== run.runId) {
      els.resumeSeed.dataset.runId = run.runId;
      els.resumeSeed.value = '';
    }
    for (const candidate of parseCandidates(run.identity.candidates)) {
      const card = make('div', { className: 'identity-candidate' });
      const content = make('div', {});
      content.append(make('strong', { text: candidate.label }), make('p', { text: candidate.detail }));
      if (typeof candidate.profileUrl === 'string') content.appendChild(make('small', { text: candidate.profileUrl }));
      card.appendChild(content);
      if (typeof candidate.candidateId === 'string' && candidate.candidateId) {
        const id = candidate.candidateId;
        const choose = make('button', { className: 'button', text: '选择此人', attrs: { type: 'button', 'data-candidate-id': id, 'aria-label': `选择 ${candidate.label}，${candidate.detail}` }, on: { click: () => void resumeRun(id) } });
        choose.disabled = state.resumeBusy;
        card.appendChild(choose);
      }
      els.candidates.appendChild(card);
    }
  }
  els.resumeRun.disabled = state.resumeBusy;
}

// Optional fields keep historical reports readable while the research contract evolves.
type ResearchProgress = {
  phase: string; steps: number; stopReason: string | null;
  budget: { toolCalls: number; modelCalls: number; estimatedUsd: number; unknownCost: boolean; limits: { toolCalls: number; modelCalls: number } };
};

function renderRunSummary(): void {
  const run = state.run;
  const research = (run as (CanonicalView & { research?: ResearchProgress }) | null)?.research;
  clear(els.researchDetails);
  const messages: Record<string, string> = {
    budget_exhausted: '本次研究已达到预算，已保留目前找到的资料。',
    budget_limit: '本次研究已达到预算，已保留目前找到的资料。',
    request_limit: '本次研究已达到读取上限，已保留现有资料。',
    max_steps: '本次研究已达到步骤上限，部分问题仍待补充。',
    outcome_unknown: '有一次请求的结果尚未确认，研究已停止，避免重复调用。',
    identity_ambiguous: '仍无法确定资料是否属于同一个人，需要补充身份线索。',
    interrupted: '研究曾中断，已保存当时找到的资料。',
    cancelled: '研究已停止，已有资料仍可查看。'
  };
  const stopReason = research?.stopReason ?? run?.stopReason;
  let message = stopReason ? messages[stopReason] ?? '' : '';
  if (!message && run?.state === 'partial') message = '已保留目前找到的资料，部分内容尚未完成。';
  if (!message && run?.state === 'failed') message = '这次研究未能完成。你的输入已保留，可以重试或补充线索。';
  if (run?.state === 'needs_input') message = '';
  if (!message && research && (run?.state === 'queued' || run?.state === 'researching')) {
    const phases: Record<string, string> = { resolving: '正在核对人物身份。', identity: '正在核对人物身份。', identity_resolution: '正在核对人物身份。', researching: '正在阅读公开资料，核对相关证据。', collecting: '正在阅读公开资料，核对相关证据。', synthesizing: '正在整理有出处的发现。', validating: '正在核对报告与出处。' };
    message = phases[research.phase] ?? '正在阅读与核对公开资料。';
  }
  setText(els.statusSummary, message);
  show(els.statusSummary, Boolean(message));
  if (research?.budget) {
    const details = make('details', {});
    const budget = research.budget;
    details.appendChild(make('summary', { text: '本次研究用量' }));
    details.appendChild(make('p', { text: `读取 ${budget.toolCalls} / ${budget.limits.toolCalls} 次 · 分析 ${budget.modelCalls} / ${budget.limits.modelCalls} 轮` }));
    const estimatedCost = Number.isFinite(budget.estimatedUsd) ? `估算费用 $${budget.estimatedUsd.toFixed(4)}` : '费用暂不可估算';
    details.appendChild(make('p', { text: `${estimatedCost}。${budget.unknownCost ? '部分费用尚未确认，实际金额可能更高。' : '以服务商的实际账单为准。'}` }));
    els.researchDetails.appendChild(details);
  }
  if (run?.limitations.length) {
    const details = make('details', {});
    details.appendChild(make('summary', { text: '本次读取的范围与限制' }));
    const list = make('ul', {});
    for (const limit of run.limitations) list.appendChild(make('li', { text: limit }));
    details.appendChild(list);
    els.researchDetails.appendChild(details);
  }
}

function renderActivityPanel(): void {
  const run = state.run;
  const hasStages = state.stages.length > 0 || els.researchDetails.childElementCount > 0 || Boolean(run && (run.state === 'queued' || run.state === 'researching'));
  show(els.activityPanel, hasStages);
  if (!hasStages) return;
  renderActivity(
    els.stageList,
    els.runProgressFill,
    els.runProgress,
    els.runProgressText,
    els.activityState,
    els.runIndicator,
    state.stages,
    run?.state ?? 'queued',
    String(run?.provider) === 'research'
  );
}

function renderReportView(): void {
  if (!state.run && state.runs.length === 0) {
    clear(els.report);
    const empty = make('div', { className: 'stage-panel enter' });
    const content = make('div', { className: 'panel-content' });
    content.appendChild(make('h3', { text: '从一个公开账号开始' }));
    content.appendChild(make('p', { text: '例如 simonw 的 GitHub 公开作品。' }));
    content.appendChild(
      make('button', {
        className: 'button primary',
        text: '用 simonw 示例开始',
        attrs: { type: 'button' },
        on: { click: fillExample }
      })
    );
    empty.appendChild(content);
    els.report.appendChild(empty);
    return;
  }
  renderReport(els.report, state.run, {
    onCitation: (sourceKey) => focusSource(sourceKey)
  });
}

function renderSourcePanels(): void {
  const run = state.run;
  const handlers = {
    onSelect: (key: string) => focusSource(key),
    onExclude: (key: string) => void toggleExclusion(key, true),
    onRestore: (key: string) => void toggleExclusion(key, false),
    onUndo: (key: string) => void toggleExclusion(key, false)
  };
  const filters = (container: HTMLElement): void =>
    renderSourceFilters(container, run, state.filter, (filter) => {
      state.filter = filter;
      renderSourcePanels();
    });
  filters(els.sourceFilters);
  filters(els.drawerSourceFilters);
  renderSourceList(els.inspectorSourceList, run, state.selectedSourceKey, state.filter, handlers.onSelect);
  renderSourceList(els.drawerSourceList, run, state.selectedSourceKey, state.filter, handlers.onSelect);
  renderSourceDetail(els.inspectorDetail, run, state.selectedSourceKey, handlers);
  renderSourceDetail(els.drawerSourceDetail, run, state.selectedSourceKey, handlers);
}

function renderHistoryRail(): void {
  renderHistory(els.historyRail, state.runs, state.activeRunId, (runId) => void selectRun(runId));
  renderHistory(els.drawerHistory, state.runs, state.activeRunId, (runId) => {
    els.historyDrawer.close();
    void selectRun(runId);
  });
}

function renderFollowup(): void {
  const ready = Boolean(
    state.run && state.run.answer.length > 0 && isTerminalState(state.run.state) && chatSupported(state.run)
  );
  renderFollowupRail(els.followupRail, ready ? FOLLOWUP_PROMPTS : [], (prompt) => void sendFollowup(prompt));
}

function updateStreamHint(): void {
  if (state.streamState === 'reconnecting') {
    setText(els.chatHint, '实时连接中断，正在重连；报告内容不会丢失。');
  }
}

function focusSource(sourceKey: string): void {
  if (!state.run) return;
  state.selectedSourceKey = sourceKey;
  state.filter = 'all';
  const narrow = isNarrow();
  if (!narrow) {
    els.appShell.classList.remove('inspector-collapsed');
    els.toggleInspector.setAttribute('aria-pressed', 'true');
    els.toggleInspector.textContent = '收起出处';
  }
  renderSourcePanels();
  const detail = narrow ? els.drawerSourceDetail : els.inspectorDetail;
  detail.classList.add('emphasis');
  window.setTimeout(() => detail.classList.remove('emphasis'), 400);
  if (narrow && !els.sourceDrawer.open) els.sourceDrawer.showModal();
  detail.scrollIntoView({ block: 'nearest' });
}

function restoreSourceFocus(): void {
  const narrow = isNarrow();
  const detail = narrow ? els.drawerSourceDetail : els.inspectorDetail;
  if (narrow && !els.sourceDrawer.open) return;
  detail.querySelector<HTMLElement>('.source-actions .button')?.focus();
}

async function toggleExclusion(sourceKey: string, exclude: boolean): Promise<void> {
  const run = state.run;
  if (!run) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  let result: { run: CanonicalView; changed: boolean };
  try {
    result = await api.setExclusion(runId, sourceKey, exclude, run.revision);
  } catch (error) {
    if (!isCurrentRun(runId, epoch)) return;
    if (error instanceof ApiError && error.code === 'stale_revision') {
      showToast('报告已更新，请刷新后重试。', 'error');
      scheduleSnapshotRefresh(runId, epoch);
      return;
    }
    showToast(error instanceof ApiError ? error.message : '操作失败。', 'error');
    return;
  }
  if (!isCurrentRun(runId, epoch)) return;
  state.run = result.run;
  state.selectedSourceKey = sourceKey;
  renderAll();
  restoreSourceFocus();
  showToast(
    result.changed
      ? exclude
        ? `已不采用 ${sourceKey}，相关结论标记为待复核。`
        : `已恢复 ${sourceKey}。`
      : '状态没有变化。'
  );
}

async function sendFollowup(question: string): Promise<void> {
  const run = state.run;
  if (!run || !chatSupported(run)) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  const userId = state.user?.id ?? null;
  const trimmed = question.trim();
  if (trimmed.length === 0) return;
  state.messages.push({ role: 'user', label: '你', text: trimmed });
  renderMessages(els.chatLog, state.messages);
  let child: CanonicalView;
  try {
    child = await api.followup(runId, trimmed);
  } catch (error) {
    if (!isCurrentRun(runId, epoch)) return;
    state.messages.push({
      role: 'assistant',
      label: '系统',
      text: error instanceof ApiError ? error.message : '追问失败，草稿已保留。'
    });
    renderMessages(els.chatLog, state.messages);
    els.chatInput.value = trimmed;
    return;
  }
  if (!isCurrentUser(userId) || !isCurrentRun(runId, epoch)) return;
  state.messages.push({
    role: 'assistant',
    label: '子研究',
    text: `已创建子研究「${child.question}」并开始查看。`
  });
  renderMessages(els.chatLog, state.messages);
  await loadRuns();
  if (!isCurrentUser(userId)) return;
  await selectRun(child.runId);
}

/* ---------------- actions ---------------- */

function fillExample(): void {
  els.question.value = 'https://github.com/simonw';
  els.clearQuestion.hidden = false;
  setText(els.questionError, '');
  setFormStatus('已填入公开主页；点击「开始了解」后才会开始研究。');
  els.question.focus();
}

async function cancelRun(): Promise<void> {
  const run = state.run;
  if (!run) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  els.stopRun.disabled = true;
  try {
    const updated = await api.cancelRun(runId);
    if (!isCurrentRun(runId, epoch)) return;
    state.run = updated;
    renderAll();
    showToast('已取消研究。');
  } catch (error) {
    if (!isCurrentRun(runId, epoch)) return;
    showToast(error instanceof ApiError ? error.message : '取消失败。', 'error');
  } finally {
    if (isCurrentRun(runId, state.runEpoch)) els.stopRun.disabled = false;
  }
}

async function retryRun(): Promise<void> {
  const run = state.run;
  if (!run) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  const userId = state.user?.id ?? null;
  let child: CanonicalView;
  try {
    child = await api.retryRun(runId);
  } catch (error) {
    if (!isCurrentRun(runId, epoch)) return;
    showToast(error instanceof ApiError ? error.message : '重试失败。', 'error');
    return;
  }
  if (!isCurrentUser(userId)) return;
  await loadRuns();
  if (!isCurrentUser(userId)) return;
  await selectRun(child.runId);
  showToast('已创建新的重试研究。');
}

async function deleteRun(): Promise<void> {
  const run = state.run;
  if (!run) return;
  if (!window.confirm('删除这份研究及其来源和事件？此操作不可恢复。')) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  const userId = state.user?.id ?? null;
  try {
    await api.deleteRun(runId);
  } catch (error) {
    if (!isCurrentRun(runId, epoch)) return;
    showToast(error instanceof ApiError ? error.message : '删除失败。', 'error');
    return;
  }
  if (!isCurrentUser(userId)) return;
  if (isCurrentRun(runId, state.runEpoch)) {
    closeStream();
    state.run = null;
    state.events = [];
    state.activeRunId = null;
  }
  await loadRuns();
  renderAll();
  showToast('已删除研究。');
}

async function copyReport(): Promise<void> {
  const run = state.run;
  if (!run || state.copyBusy) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  state.copyBusy = true;
  state.copyToken += 1;
  const token = state.copyToken;
  const revision = run.revision;
  els.copyReport.disabled = true;
  try {
    const markdown = await api.exportRun(runId, 'markdown');
    if (token !== state.copyToken || !isCurrentRun(runId, epoch)) return;
    await navigator.clipboard.writeText(markdown);
    if (!isCurrentRun(runId, epoch) || revision !== state.run?.revision) {
      showToast('报告已更新，请重新复制。', 'error');
      state.copiedRevision = null;
    } else {
      state.copiedRevision = revision;
      showToast('报告已复制。');
    }
  } catch {
    if (token === state.copyToken && isCurrentRun(runId, epoch)) {
      showToast('复制失败，请改用「下载 Markdown」。', 'error');
    }
  } finally {
    state.copyBusy = false;
    if (isCurrentRun(runId, state.runEpoch)) els.copyReport.disabled = false;
  }
}

async function downloadReport(format: ExportFormat): Promise<void> {
  const run = state.run;
  if (!run) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  const revision = run.revision;
  try {
    const blob = await api.exportBlob(runId, format, revision);
    if (!isCurrentRun(runId, epoch)) return;
    if (state.run?.revision !== revision) {
      showToast('资料已更新，请重新下载最新版本。', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const extension = format === 'markdown' ? 'md' : format;
    const anchor = make('a', { attrs: { href: url, download: `stripsearch-${runId}-v${revision}.${extension}` } });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已发起 ${extension.toUpperCase()} 下载。`);
  } catch (error) {
    if (isCurrentRun(runId, epoch)) showToast(error instanceof ApiError ? error.message : '导出失败，请稍后重试。', 'error');
  }
}

async function resumeRun(candidateId?: string): Promise<void> {
  const run = state.run;
  if (!run || state.resumeBusy) return;
  const runId = run.runId;
  const epoch = state.runEpoch;
  let resolution: ResumeInput;
  if (candidateId) {
    resolution = { candidateId, expectedRevision: run.revision };
  } else {
    const seedCheck = validateSeedUrl(els.resumeSeed.value);
    if (!seedCheck.ok || !seedCheck.url) {
      els.resumeError.textContent = seedCheck.error ?? '请输入有效的公开主页链接。';
      els.resumeSeed.focus();
      return;
    }
    resolution = { seedUrl: seedCheck.url };
  }
  state.resumeBusy = true;
  els.resumeError.textContent = '';
  renderNeedsPanel();
  try {
    const updated = await api.resumeRun(runId, resolution);
    if (!isCurrentRun(runId, epoch)) return;
    state.run = updated;
    renderAll();
    if (!isTerminalState(updated.state) && updated.state !== 'needs_input') openStream(runId, state.latestSeq, epoch);
  } catch (error) {
    if (!isCurrentRun(runId, epoch)) return;
    els.resumeError.textContent = error instanceof ApiError ? error.message : '继续失败，请稍后重试。';
    if (error instanceof ApiError && error.status === 409) scheduleSnapshotRefresh(runId, epoch);
  } finally {
    if (isCurrentRun(runId, epoch)) {
      state.resumeBusy = false;
      renderNeedsPanel();
    }
  }
}

/* ---------------- wiring ---------------- */

function wire(): void {
  window.addEventListener('hashchange', onHashChange);
  byId<HTMLDialogElement>('auth-dialog').addEventListener('close', () => { state.pendingSubmit = false; });

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitResearch();
  });
  els.question.addEventListener('input', () => {
    els.clearQuestion.hidden = els.question.value.length === 0;
  });
  els.question.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing && !event.repeat) {
      event.preventDefault();
      void submitResearch();
    }
  });
  els.clearQuestion.addEventListener('click', () => {
    els.question.value = '';
    els.clearQuestion.hidden = true;
    els.question.focus();
  });
  byId<HTMLButtonElement>('open-example').addEventListener('click', fillExample);
  byId<HTMLButtonElement>('open-auth').addEventListener('click', () => auth.open('signin', handleAuthSuccess));
  els.openReview.addEventListener('click', () => {
    if (window.location.hash === '#/review') {
      void review.refresh();
    } else {
      window.location.hash = '#/review';
    }
  });
  byId<HTMLButtonElement>('sign-out').addEventListener('click', () => void signOut());
  byId<HTMLButtonElement>('open-app').addEventListener('click', () => {
    window.location.hash = '#/app';
  });
  byId<HTMLButtonElement>('new-research').addEventListener('click', () => {
    state.runEpoch += 1;
    closeStream();
    state.run = null;
    state.activeRunId = null;
    state.submitAttempt = null;
    state.resumeBusy = false;
    state.events = [];
    state.messages = [];
    renderAll();
    goHome();
    els.question.focus();
  });
  byId<HTMLButtonElement>('app-return-home').addEventListener('click', goHome);
  byId<HTMLButtonElement>('rail-return-home').addEventListener('click', goHome);
  byId<HTMLAnchorElement>('brand-home').addEventListener('click', () => {
    if (window.location.hash.startsWith('#/app')) goHome();
  });

  els.stopRun.addEventListener('click', () => void cancelRun());
  els.retryRun.addEventListener('click', () => void retryRun());
  els.deleteRun.addEventListener('click', () => void deleteRun());
  els.copyReport.addEventListener('click', () => void copyReport());
  els.downloadMd.addEventListener('click', () => void downloadReport('markdown'));
  els.downloadJson.addEventListener('click', () => void downloadReport('json'));
  els.downloadHtml.addEventListener('click', () => void downloadReport('html'));
  els.downloadPdf.addEventListener('click', () => void downloadReport('pdf'));
  els.resumeRun.addEventListener('click', () => void resumeRun());

  els.toggleInspector.addEventListener('click', () => {
    const collapsed = els.appShell.classList.toggle('inspector-collapsed');
    els.toggleInspector.setAttribute('aria-pressed', String(!collapsed));
    els.toggleInspector.textContent = collapsed ? '展开出处' : '收起出处';
  });
  byId<HTMLButtonElement>('desktop-close-inspector').addEventListener('click', () => {
    els.appShell.classList.add('inspector-collapsed');
    els.toggleInspector.setAttribute('aria-pressed', 'false');
    els.toggleInspector.textContent = '展开出处';
  });
  byId<HTMLButtonElement>('open-mobile-history').addEventListener('click', () => {
    renderHistoryRail();
    els.historyDrawer.showModal();
  });
  byId<HTMLButtonElement>('open-mobile-sources').addEventListener('click', () => {
    renderSourcePanels();
    els.sourceDrawer.showModal();
  });
  for (const element of document.querySelectorAll('[data-close-history]')) {
    element.addEventListener('click', () => els.historyDrawer.close());
  }
  for (const element of document.querySelectorAll('[data-close-source]')) {
    element.addEventListener('click', () => els.sourceDrawer.close());
  }

  els.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.chatInput.value.trim();
    if (value.length === 0) return;
    els.chatInput.value = '';
    els.chatInput.focus();
    void sendFollowup(value);
  });

  window.matchMedia('(max-width: 1220px)').addEventListener('change', () => {
    if (els.sourceDrawer.open) els.sourceDrawer.close();
  });
}

/* ---------------- boot ---------------- */

let lastHash = window.location.hash;
let suppressHashGuard = false;

/**
 * Guard in-app hash/back navigation away from a case with unsaved review or
 * new-case input. A confirmed navigation proceeds; a declined one restores the
 * previous hash without reloading the workbench.
 */
function onHashChange(): void {
  const next = window.location.hash;
  if (next === lastHash) {
    suppressHashGuard = false;
    route();
    return;
  }
  const inReview = (hash: string): boolean => hash.startsWith('#/review');
  if (inReview(lastHash) && lastHash !== next && !suppressHashGuard && review.hasUnsavedChanges()) {
    if (!window.confirm('标注有未保存的修改，确定要离开当前案例吗？')) {
      suppressHashGuard = true;
      window.location.hash = lastHash;
      return;
    }
  }
  suppressHashGuard = false;
  lastHash = next;
  route();
}

async function boot(): Promise<void> {
  wire();
  renderUserNav(null);
  try {
    const health = await api.health();
    state.capabilities = health.capabilities;
  } catch {
    // Entry stays usable; the actual request returns a recoverable service error.
  }
  const session = await api.session();
  if (session) {
    state.user = session.user;
    renderUserNav(session.user);
    await loadRuns();
  }
  route();
  renderAll();
}

void boot();

/** Exposed only for DOM regression tests; not part of the app surface. */
export const __test = {
  state,
  review,
  selectRun,
  loadRuns,
  signOut,
  cancelRun,
  toggleExclusion,
  retryRun,
  sendFollowup,
  deleteRun,
  copyReport,
  resumeRun,
  applySnapshot,
  renderAll,
  isCurrentRun,
  isCurrentUser
};
