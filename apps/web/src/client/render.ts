import {
  KIND_LABELS,
  SOURCE_KIND_LABELS,
  stateLabel
} from '../shared/canonical.js';
import type {
  CanonicalSource,
  CanonicalView,
  ClaimKind,
  RunEventRecord,
  RunState,
  RunSummary,
  SourceKind
} from '../shared/types.js';
import { byId, clear, formatDate, formatDateTime, hostnameOf, make } from './dom.js';

export type SourceFilter = 'all' | 'profile' | 'work' | 'third_party' | 'excluded';

export interface ReportHandlers {
  onCitation(sourceKey: string): void;
}

export interface SourceHandlers {
  onSelect(sourceKey: string): void;
  onExclude(sourceKey: string): void;
  onRestore(sourceKey: string): void;
  onUndo(sourceKey: string): void;
}

export interface StageView {
  key: string;
  index: number;
  total: number;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error' | 'unavailable';
  detail: string | null;
}

const STAGE_TAGS: Record<StageView['status'], string> = {
  pending: '待处理',
  active: '正在查看',
  done: '已完成',
  error: '无法访问',
  unavailable: '不可用'
};

function citationButton(sourceKey: string, handlers: ReportHandlers): HTMLButtonElement {
  return make('button', {
    className: 'citation',
    text: `[${sourceKey}]`,
    attrs: { type: 'button', 'data-source': sourceKey, 'aria-label': `查看来源 ${sourceKey}` },
    on: {
      click: () => handlers.onCitation(sourceKey)
    }
  });
}

function bulletNode(
  text: string,
  sourceKeys: string[],
  kind: ClaimKind,
  validity: 'valid' | 'review',
  reviewReason: string | null,
  handlers: ReportHandlers
): HTMLElement {
  const wrapper = make('div', { className: 'finding' });
  if (validity === 'review') {
    wrapper.dataset.validity = 'review';
    wrapper.appendChild(make('span', { className: 'review-flag', text: `待复核 · ${reviewReason ?? '来源已撤下'}` }));
  }
  const paragraph = make('p', {});
  paragraph.appendChild(document.createTextNode(text));
  if (kind === 'attributed_statement') {
    paragraph.appendChild(make('span', { className: 'limit-note', text: '（本人自述）' }));
  }
  if (kind === 'page_statement') {
    paragraph.appendChild(make('span', { className: 'limit-note', text: '（来源页面表述）' }));
  }
  if (kind === 'inference') {
    paragraph.appendChild(make('span', { className: 'limit-note', text: '（推断，非已核实事实）' }));
  }
  for (const key of sourceKeys) {
    paragraph.appendChild(citationButton(key, handlers));
  }
  wrapper.appendChild(paragraph);
  return wrapper;
}

export function renderReport(
  container: HTMLElement,
  view: CanonicalView | null,
  handlers: ReportHandlers
): void {
  clear(container);
  if (!view) {
    container.appendChild(
      make('div', {
        className: 'empty-state enter',
        text: '从一个名字或公开主页开始，逐步了解一个人。'
      })
    );
    return;
  }
  const header = make('header', { className: 'report-header enter' });
  header.appendChild(
    make('h2', { text: view.identity.displayName || (view.identity.handle ? `@${view.identity.handle}` : view.question) })
  );
  header.appendChild(
    make('p', {
      className: 'report-meta',
      text: `${stateLabel(view.state)} · 更新于 ${formatDateTime(view.updatedAt)} · v${view.revision}`
    })
  );
  if (view.interrupted) {
    header.appendChild(
      make('p', { className: 'review-flag', text: '服务重启，这份报告被标记为中断，可以手动重试。' })
    );
  }
  if (view.identity.status !== 'resolved' && view.identity.note) {
    header.appendChild(make('p', { className: 'identity-note', text: view.identity.note }));
  } else if (view.identity.profileUrl) {
    header.appendChild(make('p', { className: 'identity-note', text: '基于该账号及本次读取的公开资料。' }));
  }
  container.appendChild(header);
  if (view.answer.length === 0 && (view.state === 'queued' || view.state === 'researching')) {
    container.appendChild(make('p', { className: 'reading-arrival', text: '正在核对人物线索。找到的资料会逐步出现在这里。' }));
  }

  for (const section of view.answer) {
    if (!section.body.trim() && section.bullets.length === 0) continue;
    const sectionEl = make('section', { className: 'report-section' });
    sectionEl.appendChild(make('h3', { text: section.heading }));
    const copy = make('div', { className: 'report-copy' });
    if (section.body) copy.appendChild(make('p', { text: section.body }));
    section.bullets.forEach((bullet, index) => {
      const node = bulletNode(
        bullet.text,
        bullet.sourceKeys,
        bullet.kind,
        bullet.validity,
        bullet.reviewReason,
        handlers
      );
      node.classList.add('enter');
      node.style.animationDelay = `${Math.min(index * 40, 240)}ms`;
      copy.appendChild(node);
    });
    sectionEl.appendChild(copy);
    container.appendChild(sectionEl);
  }

  if (view.observations.length > 0) {
    const details = make('details', { className: 'report-observations' });
    details.appendChild(
      make('summary', { text: `观察项（${view.observations.length}）`, attrs: { role: 'button' } })
    );
    const list = make('ul', { className: 'observation-list' });
    for (const observation of view.observations) {
      const item = make('li', {});
      if (observation.validity === 'review') {
        item.appendChild(
          make('span', { className: 'review-flag', text: `待复核 · ${observation.reviewReason ?? '来源已撤下'}` })
        );
      }
      item.appendChild(document.createTextNode(`${observation.statement} `));
      item.appendChild(
        make('span', { className: 'limit-note', text: `（${KIND_LABELS[observation.kind]}）` })
      );
      for (const key of observation.sourceKeys) item.appendChild(citationButton(key, handlers));
      if (observation.limitations.length > 0) {
        item.appendChild(make('span', { className: 'limit-note', text: `限制：${observation.limitations.join('；')}` }));
      }
      list.appendChild(item);
    }
    details.appendChild(list);
    container.appendChild(details);
  }
}

export function filtersFor(view: CanonicalView | null): { id: SourceFilter; label: string }[] {
  const base: { id: SourceFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'profile', label: '主页' },
    { id: 'work', label: '作品' },
    { id: 'third_party', label: '第三方' }
  ];
  if (view?.sources.some((source) => source.excluded)) base.push({ id: 'excluded', label: '已排除' });
  return base;
}

function matchesFilter(source: CanonicalSource, filter: SourceFilter): boolean {
  if (filter === 'all') return !source.excluded;
  if (filter === 'excluded') return source.excluded;
  return !source.excluded && source.kind === (filter as SourceKind);
}

export function renderSourceFilters(
  container: HTMLElement,
  view: CanonicalView | null,
  active: SourceFilter,
  onChange: (filter: SourceFilter) => void
): void {
  clear(container);
  for (const filter of filtersFor(view)) {
    container.appendChild(
      make('button', {
        className: 'filter',
        text: filter.label,
        attrs: { type: 'button', 'aria-pressed': filter.id === active ? 'true' : 'false' },
        on: { click: () => onChange(filter.id) }
      })
    );
  }
}

export function renderSourceList(
  container: HTMLElement,
  view: CanonicalView | null,
  selectedKey: string | null,
  filter: SourceFilter,
  onSelect: (sourceKey: string) => void
): void {
  clear(container);
  const sources = (view?.sources ?? []).filter((source) => matchesFilter(source, filter));
  if (sources.length === 0) {
    container.appendChild(
      make('p', { className: 'empty-state', text: filter === 'excluded' ? '没有已排除的来源。' : '这一筛选下没有来源。' })
    );
    return;
  }
  for (const source of sources) {
    const row = make('button', {
      className: 'source-row enter',
      attrs: { type: 'button', role: 'option', 'aria-selected': source.sourceKey === selectedKey ? 'true' : 'false' },
      on: { click: () => onSelect(source.sourceKey) }
    });
    row.dataset.status = source.excluded ? 'excluded' : 'ok';
    row.appendChild(make('span', { className: 'source-code', text: source.sourceKey }));
    const body = make('span', {});
    body.appendChild(make('strong', { text: source.title }));
    body.appendChild(
      make('span', {
        text: `${SOURCE_KIND_LABELS[source.kind]} · ${formatDate(source.publishedAt)}${source.excluded ? ' · 已排除' : ''}`
      })
    );
    row.appendChild(body);
    container.appendChild(row);
  }
}

function detailRow(label: string, value: string): HTMLElement {
  const wrapper = make('div', {});
  wrapper.appendChild(make('dt', { text: label }));
  wrapper.appendChild(make('dd', { text: value }));
  return wrapper;
}

export function renderSourceDetail(
  container: HTMLElement,
  view: CanonicalView | null,
  selectedKey: string | null,
  handlers: SourceHandlers
): void {
  clear(container);
  const source = view?.sources.find((item) => item.sourceKey === selectedKey) ?? null;
  if (!source) {
    container.appendChild(make('p', { className: 'source-placeholder', text: '选择一条来源查看原文、状态与操作。' }));
    return;
  }
  container.appendChild(make('span', { className: 'source-label', text: `${source.sourceKey} · ${SOURCE_KIND_LABELS[source.kind]}` }));
  container.appendChild(make('h3', { text: source.title }));

  if (source.excerpt) {
    const quote = make('div', { className: 'source-quote' });
    quote.appendChild(make('span', { className: 'source-label', text: source.excerptLocator ?? '原文摘录' }));
    quote.appendChild(make('p', { text: source.excerpt }));
    container.appendChild(quote);
  } else {
    container.appendChild(make('p', { className: 'source-placeholder', text: '这份来源没有可用于展示的短摘录。' }));
  }

  const list = make('dl', {});
  const link = make('a', { text: source.url, attrs: { href: source.url, target: '_blank', rel: 'noopener noreferrer' } });
  const linkRow = make('div', {});
  linkRow.appendChild(make('dt', { text: '链接' }));
  const linkDd = make('dd', {});
  linkDd.appendChild(link);
  linkRow.appendChild(linkDd);
  list.appendChild(linkRow);
  list.appendChild(detailRow('发表时间', formatDate(source.publishedAt)));
  list.appendChild(detailRow('获取时间', formatDateTime(source.retrievedAt)));
  list.appendChild(
    detailRow('身份归属', source.identityConfirmed ? '已确认（种子账号）' : '未确认，不合并同名')
  );
  list.appendChild(
    detailRow(
      '状态',
      source.excluded ? '已不采用' : source.fetchStatus === 'ok' ? '已读取' : source.fetchStatus
    )
  );
  list.appendChild(
    detailRow('已知限制', source.limits.length > 0 ? source.limits.join('；') : '没有额外限制记录。')
  );
  container.appendChild(list);

  if (source.excluded) {
    const box = make('div', { className: 'exclusion-status' });
    box.appendChild(document.createTextNode(`已不采用 ${source.sourceKey}，相关结论标记为待复核。`));
    box.appendChild(
      make('button', {
        className: 'button',
        text: '撤销',
        attrs: { type: 'button' },
        on: { click: () => handlers.onUndo(source.sourceKey) }
      })
    );
    container.appendChild(box);
  }

  const actions = make('div', { className: 'source-actions' });
  actions.appendChild(
    make('button', {
      className: source.excluded ? 'button' : 'button danger',
      text: source.excluded ? '恢复来源' : '不采用这条来源',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (source.excluded) handlers.onRestore(source.sourceKey);
          else handlers.onExclude(source.sourceKey);
        }
      }
    })
  );
  container.appendChild(actions);
  container.appendChild(
    make('p', { className: 'limit-note', text: `URL 主机：${hostnameOf(source.url)}` })
  );
}

export function stagesFromEvents(events: RunEventRecord[]): StageView[] {
  const map = new Map<string, StageView>();
  let total = 0;
  for (const event of events) {
    if (event.type !== 'stage') continue;
    const payload = event.payload as Partial<StageView> | null;
    if (!payload || typeof payload.key !== 'string') continue;
    total = Math.max(total, typeof payload.total === 'number' ? payload.total : 0);
    map.set(payload.key, {
      key: payload.key,
      index: typeof payload.index === 'number' ? payload.index : 0,
      total: typeof payload.total === 'number' ? payload.total : total,
      label: typeof payload.label === 'string' ? payload.label : payload.key,
      status: (payload.status as StageView['status']) ?? 'pending',
      detail: typeof payload.detail === 'string' ? payload.detail : null
    });
  }
  return [...map.values()].sort((a, b) => a.index - b.index).map((stage) => ({ ...stage, total: total || stage.total }));
}

export function renderActivity(
  list: HTMLElement,
  progressFill: HTMLElement,
  progressBar: HTMLElement,
  progressText: HTMLElement,
  activityState: HTMLElement,
  indicator: HTMLElement,
  stages: StageView[],
  state: RunState,
  openEnded = false
): void {
  clear(list);
  const total = stages[0]?.total ?? 0;
  const done = stages.filter((stage) => stage.status === 'done').length;
  if (stages.length === 0) {
    list.appendChild(make('p', { className: 'stage-empty', text: '还没有可观察的研究步骤。' }));
  } else {
    for (const stage of stages) {
      const item = make('div', { className: 'stage-item enter' });
      item.dataset.status = stage.status;
      item.appendChild(make('span', { className: 'stage-index', text: String(stage.index + 1).padStart(2, '0') }));
      item.appendChild(make('span', { className: 'stage-label', text: stage.label }));
      item.appendChild(make('span', { className: 'stage-tag', text: STAGE_TAGS[stage.status] }));
      if (stage.detail) item.appendChild(make('span', { className: 'stage-detail', text: stage.detail }));
      list.appendChild(item);
    }
  }
  progressBar.hidden = openEnded;
  const ratio = total > 0 ? done / total : 0;
  progressFill.style.transform = `scaleX(${ratio})`;
  progressBar.setAttribute('aria-valuemax', String(total || 1));
  progressBar.setAttribute('aria-valuenow', String(done));
  progressBar.setAttribute('aria-valuetext', `${done} / ${total || 0} 步已完成`);
  progressText.textContent = openEnded ? `${done} 个步骤已完成` : `${done} / ${total || 0}`;
  activityState.textContent = [...stages].reverse().find((stage) => stage.status === 'active')?.label ?? stateLabel(state);
  const running = state === 'researching' || state === 'queued';
  indicator.hidden = !running;
}

export function renderHistory(
  container: HTMLElement,
  runs: RunSummary[],
  currentRunId: string | null,
  onSelect: (runId: string) => void,
  emptyText = '还没有研究记录。'
): void {
  clear(container);
  if (runs.length === 0) {
    container.appendChild(make('p', { className: 'empty-state', text: emptyText }));
    return;
  }
  for (const run of runs) {
    const button = make('button', {
      className: 'history-item',
      attrs: { type: 'button', 'aria-current': run.runId === currentRunId ? 'true' : 'false' },
      on: { click: () => onSelect(run.runId) }
    });
    button.appendChild(make('strong', { text: run.question }));
    button.appendChild(
      make('small', {
        text: `${stateLabel(run.state)} · ${run.sourceCount} 个来源${run.reviewCount > 0 ? ` · ${run.reviewCount} 处待复核` : ''}`
      })
    );
    container.appendChild(button);
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  label: string;
  text: string;
}

export function renderMessages(container: HTMLElement, messages: ChatMessage[]): void {
  clear(container);
  for (const message of messages) {
    const node = make('div', { className: `message enter ${message.role === 'user' ? 'user' : ''}` });
    node.appendChild(make('small', { text: message.label }));
    node.appendChild(document.createTextNode(message.text));
    container.appendChild(node);
  }
}

export function renderFollowupRail(
  container: HTMLElement,
  prompts: string[],
  onPrompt: (prompt: string) => void
): void {
  clear(container);
  container.hidden = prompts.length === 0;
  for (const prompt of prompts) {
    container.appendChild(
      make('button', {
        className: 'prompt-chip',
        text: prompt,
        attrs: { type: 'button' },
        on: { click: () => onPrompt(prompt) }
      })
    );
  }
}

export function sourceStatusLabel(source: CanonicalSource): string {
  if (source.excluded) return '已不采用';
  if (source.fetchStatus === 'ok') return '已读取';
  if (source.fetchStatus === 'truncated') return '被截断';
  return source.fetchStatus;
}

export { byId };
