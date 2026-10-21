/**
 * GET-214 shared client presentation contract for the live research surface.
 *
 * One small module: a pure derivation from the ACTUAL `CanonicalView`, the
 * ACTUAL observed `StageView[]` (server events only) and the real stream state,
 * plus one renderer for the single dynamic section that replaces the old
 * duplicate request/status/activity shells while research is running.
 *
 * Honesty rules encoded here:
 * - labels come from real run state / research phase / observed stage events;
 * - never a completion percentage or an elapsed-time milestone (the remaining
 *   step count is unknown, so the path is semantic current/upcoming only);
 * - previous stages are never marked completed just because the phase moved;
 * - zero received sources never asserts that nothing has been read (the
 *   first-step overview is a separate authority) — arrival copy stays neutral;
 * - needs_input is never busy, whatever historical stage events remain active.
 */
import type { CanonicalView } from '../shared/types.js';
import { isActiveState } from '../shared/types.js';
import { make, clear, setText } from './dom.js';
import type { StageView } from './render.js';

export type ResearchStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting';

/** 'active' renders the surface; the other modes leave it hidden. */
export type ResearchLoadingMode = 'active' | 'needs_input' | 'stopped' | 'none';

export interface LoadingStep {
  key: string;
  label: string;
  status: 'current' | 'upcoming';
}

export interface LoadingMaterial {
  sourceKey: string;
  title: string;
  statusLabel: string;
}

export interface LoadingProcessRecord {
  key: string;
  label: string;
  detail: string | null;
  tag: string;
}

export interface ResearchLoadingModel {
  mode: ResearchLoadingMode;
  runId: string | null;
  busy: boolean;
  compact: boolean;
  query: string;
  heading: string;
  context: string[];
  steps: LoadingStep[];
  materials: LoadingMaterial[];
  materialNote: string | null;
  process: LoadingProcessRecord[];
}

export interface ResearchLoadingInput {
  run: CanonicalView | null;
  stages: StageView[];
  streamState: ResearchStreamState;
}

/**
 * The settled user-facing research vocabulary (queued → identity → reading →
 * verifying → synthesizing). Used only to label the current and upcoming part
 * of the path; completed work is never derived from this table.
 */
const PATH_LABELS: string[] = [
  '排队等待开始',
  '核对人物身份',
  '阅读公开资料',
  '核验陈述与出处',
  '整理有出处的发现'
];

const PHASE_ACTIONS: Record<string, string> = {
  resolving: '正在核对人物身份',
  identity: '正在核对人物身份',
  identity_resolution: '正在核对人物身份',
  searching: '正在发现原作、账号线索与反证',
  planning: '正在按研究问题安排下一批资料',
  reading: '正在读取原文与讨论上下文',
  verifying: '正在独立核验断言与出处',
  researching: '正在阅读公开资料，核对相关证据',
  collecting: '正在阅读公开资料，核对相关证据',
  synthesizing: '正在整理有出处的发现',
  validating: '正在核对报告与出处'
};

const PHASE_POSITION: Record<string, number> = {
  resolving: 1,
  identity: 1,
  identity_resolution: 1,
  searching: 2,
  planning: 2,
  reading: 2,
  collecting: 2,
  researching: 2,
  verifying: 3,
  synthesizing: 4,
  validating: 4
};

const PROCESS_TAGS: Record<StageView['status'], string> = {
  pending: '待处理',
  active: '进行中',
  done: '已完成',
  error: '无法访问',
  unavailable: '不可用'
};

function hasReportContent(run: CanonicalView): boolean {
  return run.answer.some((section) => section.body.trim() || section.bullets.length > 0)
    || run.observations.length > 0 || (run.research?.accountMaterials?.length ?? 0) > 0;
}

function latestActiveStage(stages: StageView[]): StageView | null {
  let latest: StageView | null = null;
  for (const stage of stages) {
    if (stage.status !== 'active') continue;
    if (!latest || (stage.observedSeq ?? stage.index) >= (latest.observedSeq ?? latest.index)) latest = stage;
  }
  return latest;
}

function sourceStatusText(source: CanonicalView['sources'][number]): string {
  if (source.excluded) return '已不采用';
  if (source.fetchStatus === 'ok') return '已读取';
  if (source.fetchStatus === 'truncated') return '被截断';
  if (source.fetchStatus === 'inaccessible') return '未能读取';
  return '状态未知';
}

/**
 * Pure derivation. Everything shown comes from the canonical run, its research
 * metadata, received events or the live stream state — nothing is synthesized.
 */
export function deriveResearchLoading(input: ResearchLoadingInput): ResearchLoadingModel {
  const { run, stages, streamState } = input;
  const base: ResearchLoadingModel = {
    mode: 'none',
    runId: run?.runId ?? null,
    busy: false,
    compact: false,
    query: run?.question ?? '',
    heading: '',
    context: [],
    steps: [],
    materials: [],
    materialNote: null,
    process: []
  };
  if (!run) return base;

  const research = (run as CanonicalView & { research?: { phase?: unknown } }).research;
  const phase = typeof research?.phase === 'string' ? research.phase : null;
  const mode: ResearchLoadingMode = isActiveState(run.state)
    ? 'active'
    : run.state === 'needs_input'
      ? 'needs_input'
      : 'stopped';
  const latest = latestActiveStage(stages);

  // Process records are the actual observed stage events, nothing else. The
  // newest active record is "进行中"; older active ones are history.
  const process: LoadingProcessRecord[] = stages.map((stage) => ({
    key: stage.key,
    label: stage.label,
    detail: stage.detail,
    tag:
      stage.status === 'active' && stage !== latest
        ? '过程记录'
        : stage.status === 'active' && mode !== 'active'
          ? '过程记录'
          : PROCESS_TAGS[stage.status]
  }));

  if (mode !== 'active') {
    return {
      ...base,
      mode,
      busy: false,
      process
    };
  }

  // ---- heading: the actual current action ---------------------------------
  let heading: string;
  let position: number | null = null;
  if (run.state === 'queued') {
    heading = '研究已排队，等待开始';
    position = 0;
  } else if (latest) {
    // Stage events arrive between canonical snapshots. The newest explicitly
    // active event is the current observed action; an older phase snapshot
    // must not keep the visible heading stuck on planning.
    heading = latest.label.startsWith('正在') ? latest.label : `正在${latest.label}`;
    position = PHASE_POSITION[latest.key] ?? null;
  } else if (phase && PHASE_ACTIONS[phase]) {
    heading = PHASE_ACTIONS[phase];
    position = PHASE_POSITION[phase] ?? null;
  } else {
    heading = '正在查找和核对公开资料';
  }

  // ---- restrained semantic path: current + upcoming only ------------------
  const steps: LoadingStep[] = [];
  if (position !== null) {
    for (let index = position; index < PATH_LABELS.length; index += 1) {
      steps.push({
        key: `path-${index}`,
        label: PATH_LABELS[index] ?? '',
        status: index === position ? 'current' : 'upcoming'
      });
    }
  } else if (latest) {
    steps.push({ key: latest.key, label: latest.label, status: 'current' });
    for (const stage of stages) {
      if (stage.status === 'pending') steps.push({ key: stage.key, label: stage.label, status: 'upcoming' });
    }
  }

  // ---- concise context from actually received material --------------------
  const eligible = run.sources.filter((source) => !source.excluded);
  const materials: LoadingMaterial[] = eligible.slice(0, 6).map((source) => ({
    sourceKey: source.sourceKey,
    title: source.title,
    statusLabel: sourceStatusText(source)
  }));
  const materialNote = eligible.length > materials.length
    ? `另有 ${eligible.length - materials.length} 条来源，可在出处面板查看。`
    : null;
  const context: string[] = [];
  const received: string[] = [];
  const readCount = eligible.filter((source) => source.fetchStatus === 'ok').length;
  if (readCount > 0) received.push(`已读取 ${readCount} 条来源`);
  const otherCount = eligible.length - readCount;
  if (otherCount > 0) received.push(`${otherCount} 条来源仍需查看读取状态`);
  if (run.observations.length > 0) received.push(`收到 ${run.observations.length} 项观察`);
  if (hasReportContent(run)) received.push('已有部分内容可以先读');
  if (received.length > 0) context.push(`${received.join('，')}。`);
  else context.push('找到的资料会逐步出现在这里。');
  if (run.interrupted) context.push('服务重启，这次研究被标记为中断，可以手动重试。');
  if (streamState === 'reconnecting') context.push('实时连接中断，正在重连；已收到的内容不会丢失。');

  return {
    mode,
    runId: run.runId,
    busy: true,
    compact: hasReportContent(run),
    query: run.question,
    heading,
    context,
    steps,
    materials,
    materialNote,
    process
  };
}

export interface ResearchLoadingHandlers {
  onInspectSource(sourceKey: string, row: HTMLElement): void;
}

export interface ResearchLoadingSurface {
  element: HTMLElement;
  update(model: ResearchLoadingModel): void;
}

/**
 * The single live research surface. The host element is created once and
 * updated in place: process disclosure state and focus inside the surface
 * survive updates within the same run; another run starts with fresh UI state.
 */
export function createResearchLoadingSurface(handlers: ResearchLoadingHandlers): ResearchLoadingSurface {
  const element = make('section', {
    className: 'research-live',
    attrs: { id: 'research-live', 'aria-label': '研究进展' }
  });

  const query = make('div', { className: 'research-live-query' });
  query.appendChild(make('span', { text: '你想了解' }));
  const queryText = make('p', { className: 'report-question' });
  query.appendChild(queryText);

  const status = make('div', {
    className: 'research-live-status',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  const heading = make('h2', { className: 'research-live-heading' });
  const context = make('div', { className: 'research-live-context' });
  status.append(heading, context);

  const path = make('ol', { className: 'stage-path', attrs: { 'aria-label': '研究步骤' } });
  const materials = make('div', {
    className: 'live-materials',
    attrs: { role: 'group', 'aria-label': '已收到的资料' }
  });
  const process = make('details', { className: 'live-process' });
  const processSummary = make('summary', { text: '实际过程记录' });
  const processList = make('ul', {});
  process.append(processSummary, processList);

  element.append(query, status, path, materials, process);

  function update(model: ResearchLoadingModel): void {
    const active = document.activeElement as HTMLElement | null;
    const sameRun = Boolean(model.runId) && element.dataset.runId === model.runId;
    const focusKey = sameRun && active && element.contains(active) ? (active.dataset.focusKey ?? null) : null;
    const processOpen = sameRun && process.open;

    element.hidden = model.mode !== 'active';
    element.dataset.mode = model.mode;
    element.dataset.runId = model.runId ?? '';
    element.dataset.busy = model.busy ? 'true' : 'false';
    element.dataset.compact = model.compact ? 'true' : 'false';
    if (model.mode !== 'active') {
      // The host survives route/session changes. Hiding it alone would leave
      // the previous authenticated query and source titles in the document.
      setText(queryText, '');
      setText(heading, '');
      clear(context);
      clear(path);
      clear(materials);
      clear(processList);
      setText(processSummary, '查看研究过程');
      process.open = false;
      process.hidden = true;
      return;
    }

    setText(queryText, model.query);
    setText(heading, model.heading);

    clear(context);
    for (const line of model.context) context.appendChild(make('p', { text: line }));

    clear(path);
    for (const step of model.steps) {
      const item = make('li', { attrs: { 'data-status': step.status } });
      item.append(
        make('span', { className: 'stage-path-tag', text: step.status === 'current' ? '当前' : '待开始' }),
        make('span', { className: 'stage-path-label', text: step.label })
      );
      path.appendChild(item);
    }
    path.hidden = model.steps.length === 0;

    clear(materials);
    for (const material of model.materials) {
      const row = make('button', {
        className: 'live-material',
        attrs: {
          type: 'button',
          'data-source-key': material.sourceKey,
          'data-focus-key': `material:${material.sourceKey}`
        },
        on: { click: () => handlers.onInspectSource(material.sourceKey, row) }
      });
      row.append(
        make('span', { className: 'source-code', text: material.sourceKey }),
        make('strong', { text: material.title }),
        make('span', { className: 'live-material-status', text: material.statusLabel })
      );
      materials.appendChild(row);
    }
    if (model.materialNote) materials.appendChild(make('p', { className: 'limit-note', text: model.materialNote }));
    materials.hidden = model.materials.length === 0 && !model.materialNote;

    setText(processSummary, `实际过程记录（${model.process.length}）`);
    clear(processList);
    for (const record of model.process) {
      const item = make('li', {});
      item.append(
        make('span', { className: 'stage-tag', text: record.tag }),
        make('span', { className: 'stage-label', text: record.label })
      );
      if (record.detail) item.appendChild(make('span', { className: 'stage-detail', text: record.detail }));
      processList.appendChild(item);
    }
    process.hidden = model.process.length === 0;
    process.open = processOpen;

    if (focusKey) {
      const target = element.querySelector<HTMLElement>(`[data-focus-key="${focusKey.replace(/["\\]/g, '\\$&')}"]`);
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
  }

  return { element, update };
}
