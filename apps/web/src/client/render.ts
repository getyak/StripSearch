import {
  KIND_LABELS,
  providerLabel,
  stateLabel
} from '../shared/canonical.js';
import {
  historyPreviewLabel,
  platformCoverageFromSources,
  sourceFetchStatusLabel,
  sourcePresentation
} from '../shared/source-presentation.js';
import { isTerminalState } from '../shared/types.js';
import type {
  CanonicalSource,
  CanonicalView,
  ClaimKind,
  RunEventRecord,
  RunState,
  RunSummary,
  SourceKind
} from '../shared/types.js';
import { byId, clear, formatDate, formatDateTime, make } from './dom.js';
import { readableSourceText } from './source-text.js';

export type SourceFilter = 'all' | 'profile' | 'work' | 'third_party' | 'excluded';

export interface ReportHandlers {
  onCitation(sourceKey: string, button: HTMLElement): void;
}

export interface SourceHandlers {
  onSelect(sourceKey: string, row: HTMLElement | null): void;
  onExclude(sourceKey: string): void;
  onRestore(sourceKey: string): void;
  onUndo(sourceKey: string): void;
  /** Explicit "return to the original sentence" action for citation entries. */
  onReturnToCitation?: () => void;
  canReturnToCitation?: boolean;
}

export interface StageView {
  key: string;
  observedSeq?: number;
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

/**
 * Citation buttons carry a semantic anchor (section/bullet/citation position).
 * The anchor is stable across re-renders of the same report content and lets
 * the return controller find the EXACT citation even when one source is cited
 * several times; it is never derived from the source key alone.
 */
function citationButton(sourceKey: string, anchor: string, context: string, handlers: ReportHandlers): HTMLButtonElement {
  const button = make('button', {
    className: 'citation',
    text: `[${sourceKey}]`,
    attrs: {
      type: 'button',
      'data-source': sourceKey,
      'data-citation-anchor': anchor,
      'data-citation-context': context,
      'aria-label': `查看来源 ${sourceKey}`
    }
  });
  button.addEventListener('click', () => handlers.onCitation(sourceKey, button));
  return button;
}

function bulletNode(
  text: string,
  sourceKeys: string[],
  kind: ClaimKind,
  validity: 'valid' | 'review',
  reviewReason: string | null,
  anchorBase: string,
  handlers: ReportHandlers
): HTMLElement {
  const wrapper = make('div', { className: 'finding' });
  if (validity === 'review') {
    wrapper.dataset.validity = 'review';
    wrapper.appendChild(make('span', { className: 'review-flag', text: `待复核 · ${reviewReason ?? '来源已撤下'}` }));
  }
  const paragraph = make('p', {});
  paragraph.appendChild(document.createTextNode(text));
  const context = make('div', { className: 'finding-context' });
  if (kind === 'attributed_statement') {
    context.appendChild(make('span', { className: 'finding-kind', text: '本人自述' }));
  }
  if (kind === 'page_statement') {
    context.appendChild(make('span', { className: 'finding-kind', text: '来源页面表述' }));
  }
  if (kind === 'inference') {
    context.appendChild(make('span', { className: 'finding-kind', text: '推断，非已核实事实' }));
  }
  for (const [index, key] of sourceKeys.entries()) {
    context.appendChild(citationButton(key, `${anchorBase}c${index}`, text, handlers));
  }
  if (sourceKeys.length === 0) context.appendChild(make('span', { className: 'limit-note', text: '尚无可核对出处' }));
  wrapper.append(paragraph, context);
  return wrapper;
}

export function renderReport(
  container: HTMLElement,
  view: CanonicalView | null,
  handlers: ReportHandlers
): void {
  const observationsOpen = container.dataset.runId === view?.runId
    && Boolean(container.querySelector<HTMLDetailsElement>('.report-observations')?.open);
  const recordOpen = container.dataset.runId === view?.runId
    && Boolean(container.querySelector<HTMLDetailsElement>('.report-record')?.open);
  clear(container);
  if (!view) {
    container.removeAttribute('data-run-id');
    container.appendChild(
      make('div', {
        className: 'empty-state enter',
        text: '从一个名字或公开主页开始，逐步了解一个人。'
      })
    );
    return;
  }
  // The rendered run id is the authority for focus/scroll restoration: polling
  // re-renders must never chase focus into a different report.
  container.dataset.runId = view.runId;
  // While research is running (or waiting for a person decision) the live
  // research surface owns the query, the current action and the status; the
  // report below carries only the material received so far, so partial content
  // stays readable without repeating the same title/status heading.
  if (isTerminalState(view.state)) {
    const header = make('header', { className: 'report-header enter' });
    header.appendChild(
      make('h2', { text: view.identity.displayName || (view.identity.handle ? `@${view.identity.handle}` : view.question) })
    );
    if (view.identity.displayName && view.identity.handle && view.identity.displayName !== view.identity.handle) {
      const handle = view.identity.handle.startsWith('@') ? view.identity.handle : `@${view.identity.handle}`;
      header.appendChild(make('p', { className: 'identity-handle', text: handle }));
    }
    if (view.interrupted) {
      header.appendChild(
        make('p', { className: 'review-flag', text: '服务重启，这份报告被标记为中断，可以手动重试。' })
      );
    }
    if (view.identity.status !== 'resolved' && view.identity.note) {
      header.appendChild(make('p', { className: 'identity-note', text: view.identity.note }));
    } else if (view.identity.profileUrl) {
      header.appendChild(make('p', { className: 'identity-note', text: '基于本次选定范围内已读取的公开资料。' }));
    }
    container.appendChild(header);
  }

  const hasAnswer = view.answer.some(section => section.body.trim() || section.bullets.length > 0);
  if (!hasAnswer && view.observations.length === 0 && !['queued', 'researching', 'needs_input'].includes(view.state)) {
    const incomplete = make('section', { className: 'report-section report-incomplete' });
    incomplete.appendChild(make('h3', { text: '还没有可核对的结论' }));
    const retained = view.sources.filter(source => !source.excluded && source.fetchStatus === 'ok');
    incomplete.appendChild(make('p', { text: retained.length > 0
      ? `已保留 ${retained.length} 个来源，但这次研究未形成有依据的结论。可以先查看已取得的材料。`
      : '这次研究尚未取得足够的公开材料。可以从更多菜单重试，或新建研究补充一个公开主页。' }));
    if (view.limitations.length > 0) {
      const gaps=make('details',{className:'report-incomplete-gaps'});gaps.appendChild(make('summary',{text:`查看未完成原因与限制（${view.limitations.length}）`}));
      const list=make('ul',{});for(const gap of view.limitations)list.appendChild(make('li',{text:gap}));gaps.appendChild(list);incomplete.appendChild(gaps);
    }
    for (const source of retained.slice(0, 6)) incomplete.appendChild(citationButton(source.sourceKey, `retained-${source.sourceKey}`, source.title, handlers));
    container.appendChild(incomplete);
  }

  view.answer.forEach((section, sectionIndex) => {
    if (!section.body.trim() && section.bullets.length === 0) return;
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
        `s${sectionIndex}b${index}`,
        handlers
      );
      node.classList.add('enter');
      node.style.animationDelay = `${Math.min(index * 40, 240)}ms`;
      copy.appendChild(node);
    });
    sectionEl.appendChild(copy);
    container.appendChild(sectionEl);
  });

  if (view.research?.accountMaterials?.length) {
    const section=make('section',{className:'report-section report-account-materials'});
    section.append(make('h3',{text:'独立账号的原文片段'}),make('p',{className:'limit-note',text:'以下是所选账号的原文材料，未独立核实内容，也未并入人物结论。'}));
    for(const [index,material] of view.research.accountMaterials.entries()){
      const quote=make('blockquote',{text:readableSourceText(material.quote)});
      quote.appendChild(citationButton(material.sourceKey,`account-material-${index}`,material.sourceUrl,handlers));section.appendChild(quote);
    }
    container.appendChild(section);
  }
  if (view.observations.length > 0) {
    const details = make('details', { className: 'report-observations' });
    details.open = observationsOpen;
    details.appendChild(
      make('summary', { text: `观察项（${view.observations.length}）`, attrs: { role: 'button' } })
    );
    const list = make('ul', { className: 'observation-list' });
    for (const [observationIndex, observation] of view.observations.entries()) {
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
      for (const [index, key] of observation.sourceKeys.entries()) {
        item.appendChild(citationButton(key, `o${observationIndex}c${index}`, observation.statement, handlers));
      }
      if (observation.limitations.length > 0) {
        item.appendChild(make('span', { className: 'limit-note', text: `限制：${observation.limitations.join('；')}` }));
      }
      list.appendChild(item);
    }
    details.appendChild(list);
    container.appendChild(details);
  }
  if (isTerminalState(view.state)) {
    const record = make('details', { className: 'report-record' });
    record.open = recordOpen;
    record.appendChild(make('summary', { text: '资料与版本', attrs: { 'data-report-control': 'record' } }));
    record.appendChild(make('p', {
      className: 'report-meta',
      text: `${stateLabel(view.state)} · 更新于 ${formatDateTime(view.updatedAt)} · v${view.revision}`
    }));
    record.appendChild(make('p', { text: `资料入口：${providerLabel(view.provider)}` }));
    container.appendChild(record);
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

const SOURCE_PAGE_SIZE = 100;
interface SourcePageState { runId:string; filter:SourceFilter; selectedKey:string|null; page:number; focusKey:string|null }
const sourcePages = new WeakMap<HTMLElement,SourcePageState>();

export function renderSourceList(
  container: HTMLElement,
  view: CanonicalView | null,
  selectedKey: string | null,
  filter: SourceFilter,
  onSelect: (sourceKey: string, row: HTMLElement | null) => void,
  options: { revealSelected?: boolean } = {}
): void {
  const runId=view?.runId ?? '';
  const previous=sourcePages.get(container);
  const sameScope=previous?.runId===runId && previous.filter===filter;
  const paging:SourcePageState=sameScope?previous:{runId,filter,selectedKey:null,page:0,focusKey:null};
  const sources=(view?.sources ?? []).filter(source=>matchesFilter(source,filter));
  const selectedIndex=selectedKey===null?-1:sources.findIndex(source=>source.sourceKey===selectedKey);
  if(selectedIndex>=0 && (!previous || options.revealSelected || (sameScope && paging.selectedKey!==selectedKey))){
    paging.page=Math.floor(selectedIndex/SOURCE_PAGE_SIZE);paging.focusKey=selectedKey;
  }
  paging.selectedKey=selectedKey;
  paging.page=Math.max(0,Math.min(paging.page,Math.ceil(sources.length/SOURCE_PAGE_SIZE)-1));
  sourcePages.set(container,paging);
  const active=container.ownerDocument.activeElement as HTMLElement|null;
  const activeRow=sameScope&&active&&container.contains(active)?active.closest<HTMLElement>('button.source-row'):null;
  const activePage=sameScope&&active&&container.contains(active)?active.dataset.sourcePage:undefined;
  container.dataset.runId=runId;
  // Paging controls are outside the inner listbox so its children remain options.
  const label=container.getAttribute('aria-label') ?? '来源列表';
  container.setAttribute('role','group');

  function draw(focusKey:string|null=null,focusPage?:string,revealFocus=false):void {
    clear(container);
    appendSourceCoverage(container, view);
    if(!sources.length){container.appendChild(make('p',{className:'empty-state',text:filter==='excluded'?'没有已排除的来源。':'这一筛选下没有来源。'}));return;}
    const start=paging.page*SOURCE_PAGE_SIZE;
    const visible=sources.slice(start,start+SOURCE_PAGE_SIZE);
    const tabKey=visible.some(source=>source.sourceKey===paging.focusKey)?paging.focusKey:
      visible.some(source=>source.sourceKey===selectedKey)?selectedKey:visible[0]!.sourceKey;
    if(sources.length>SOURCE_PAGE_SIZE){
      const controls=make('div',{className:'source-filters source-pagination',attrs:{role:'group','aria-label':'来源分页'},style:{position:'sticky',top:'0',background:'var(--bg)',zIndex:'1',alignItems:'center',flexWrap:'wrap'}});
      const changePage=(direction:number,control:string)=>{
        paging.page=Math.max(0,Math.min(Math.ceil(sources.length/SOURCE_PAGE_SIZE)-1,paging.page+direction));
        paging.focusKey=sources[paging.page*SOURCE_PAGE_SIZE]?.sourceKey ?? null;
        container.scrollTop=0;draw(null,control);
      };
      controls.appendChild(make('button',{className:'filter',text:'上一页',attrs:{type:'button','data-source-page':'previous',disabled:paging.page===0},on:{click:()=>changePage(-1,'previous')}}));
      controls.appendChild(make('span',{className:'source-page-range',text:`${start+1}–${Math.min(start+SOURCE_PAGE_SIZE,sources.length)} / ${sources.length}`}));
      controls.appendChild(make('button',{className:'filter',text:'下一页',attrs:{type:'button','data-source-page':'next',disabled:start+SOURCE_PAGE_SIZE>=sources.length},on:{click:()=>changePage(1,'next')}}));
      container.appendChild(controls);
    }
    const list=make('div',{attrs:{role:'listbox','aria-label':label}});
    for(const [offset,source] of visible.entries()){
      const row=make('button',{className:'source-row',attrs:{type:'button',role:'option',tabindex:source.sourceKey===tabKey?'0':'-1','aria-selected':source.sourceKey===selectedKey?'true':'false','aria-posinset':start+offset+1,'aria-setsize':sources.length,'data-source-key':source.sourceKey},on:{click:()=>onSelect(source.sourceKey,row),focus:()=>{paging.focusKey=source.sourceKey;for(const item of list.querySelectorAll<HTMLButtonElement>('button.source-row'))item.tabIndex=item===row?0:-1;}}});
      row.dataset.status=source.excluded?'excluded':'ok';
      const presentation=sourcePresentation(source);
      row.dataset.platform=presentation.id;
      row.appendChild(make('span',{className:'source-code',text:source.sourceKey}));
      const body=make('span',{});body.appendChild(make('strong',{text:source.title}));
      body.appendChild(make('span',{className:'source-row-meta',text:`${presentation.label} · ${presentation.hostLabel} · ${presentation.kindLabel} · ${formatDate(source.publishedAt)} · ${source.excluded?'已排除':presentation.statusLabel}`}));
      row.appendChild(body);list.appendChild(row);
    }
    container.appendChild(list);
    if(focusKey){const row=[...list.querySelectorAll<HTMLButtonElement>('button.source-row')].find(item=>item.dataset.sourceKey===focusKey);row?.focus({preventScroll:!revealFocus});}
    else if(focusPage){const control=[...container.querySelectorAll<HTMLButtonElement>('[data-source-page]')].find(item=>item.dataset.sourcePage===focusPage);if(control&&!control.disabled)control.focus({preventScroll:true});else list.querySelector<HTMLButtonElement>('button.source-row')?.focus({preventScroll:true});}
  }
  container.onkeydown=event=>{
    if(event.isComposing||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const target=event.target as HTMLElement|null;
    if(!target?.matches('button.source-row'))return;
    const index=sources.findIndex(source=>source.sourceKey===target.dataset.sourceKey);if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?sources.length-1:Math.max(0,Math.min(sources.length-1,index+(event.key==='ArrowDown'?1:-1)));
    const key=sources[next]!.sourceKey;const page=Math.floor(next/SOURCE_PAGE_SIZE);paging.focusKey=key;
    if(page!==paging.page){paging.page=page;container.scrollTop=0;draw(key,undefined,true);}
    else [...container.querySelectorAll<HTMLButtonElement>('button.source-row')].find(row=>row.dataset.sourceKey===key)?.focus();
  };
  draw(activeRow?.dataset.sourceKey ?? null,activePage);
}

function detailRow(label: string, value: string): HTMLElement {
  const wrapper = make('div', {});
  wrapper.appendChild(make('dt', { text: label }));
  wrapper.appendChild(make('dd', { text: value }));
  return wrapper;
}

/**
 * Compact coverage over the actual run sources only: never the first-step
 * platform selection, never the discovery catalog and never the active source
 * filter (see docs/design/platform-source-reading-2026-10-23.md).
 */
function appendSourceCoverage(container: HTMLElement, view: CanonicalView | null): void {
  if (!view || view.sources.length === 0) return;
  const summary = platformCoverageFromSources(view.sources);
  const counts = summary.entries
    .map((entry) => `${entry.label} ${entry.total} 条${entry.obtained < entry.total ? `（已取得 ${entry.obtained}）` : ''}`)
    .join(' · ');
  container.appendChild(
    make('p', {
      className: 'source-coverage-line',
      text: `来源平台覆盖（按本次实际来源）：${counts} · 共 ${summary.totalSources} 条来源，${summary.obtainedSources} 条已取得材料`
    })
  );
  container.appendChild(make('p', { className: 'limit-note', text: summary.note }));
}

export function renderSourceCoverage(container: HTMLElement, view: CanonicalView | null): void {
  clear(container);
  appendSourceCoverage(container, view);
}

export function renderSourceDetail(
  container: HTMLElement,
  view: CanonicalView | null,
  selectedKey: string | null,
  handlers: SourceHandlers
): void {
  const recordOpen = container.dataset.runId === view?.runId
    && container.dataset.sourceKey === selectedKey
    && Boolean(container.querySelector<HTMLDetailsElement>('.source-record')?.open);
  clear(container);
  container.dataset.runId = view?.runId ?? '';
  container.dataset.sourceKey = selectedKey ?? '';
  const source = view?.sources.find((item) => item.sourceKey === selectedKey) ?? null;
  if (!source) {
    container.appendChild(make('p', { className: 'source-placeholder', text: '选择一条来源查看原文、状态与操作。' }));
    return;
  }
  const presentation = sourcePresentation(source);
  container.appendChild(make('span', { className: 'source-label', text: `${source.sourceKey} · ${presentation.kindLabel}` }));
  container.appendChild(make('h3', { text: source.title }));
  container.appendChild(
    make('p', {
      className: 'source-platform-note',
      text: `${presentation.label} · ${presentation.hostLabel}${presentation.contentFormLabel ? ` · ${presentation.contentFormLabel}` : ''}`
    })
  );
  if (handlers.canReturnToCitation && handlers.onReturnToCitation) {
    container.appendChild(
      make('button', {
        className: 'button return-citation',
        text: '返回原句',
        attrs: {
          type: 'button',
          'data-source-focus': 'return',
          'aria-label': '返回原句，恢复原引用焦点与阅读位置'
        },
        on: {
          click: () => {
            handlers.onReturnToCitation?.();
          }
        }
      })
    );
  }

  if (source.excerpt) {
    const quote = make('div', { className: 'source-quote' });
    quote.appendChild(make('span', { className: 'source-label', text: source.excerptLocator ?? '原文摘录' }));
    quote.appendChild(make('p', { text: readableSourceText(source.excerpt) }));
    if (/<[^>]*>|&(?:[a-z]+|#x?[0-9a-f]+);/i.test(source.excerpt)) {
      const original=make('details',{className:'source-original'});original.appendChild(make('summary',{text:'查看原始文本（含标记）'}));original.appendChild(make('pre',{text:source.excerpt}));quote.appendChild(original);
    }
    container.appendChild(quote);
  } else {
    container.appendChild(make('p', { className: 'source-placeholder', text: '这份来源没有可用于展示的短摘录。' }));
  }
  container.appendChild(make('p', { className: 'limit-note', text: presentation.materialNote }));

  if (presentation.safeHref) {
    container.appendChild(make('a', {
      className: 'source-original-link', text: '打开原始来源',
      attrs: { href: presentation.safeHref, target: '_blank', rel: 'noopener noreferrer', 'data-source-focus': 'url' }
    }));
  }
  const context = make('div', { className: 'source-reading-context' });
  context.appendChild(make('p', { text: `身份归属：${source.identityConfirmed ? '已确认（种子账号）' : source.identityLabel || '未确认，不合并同名'}` }));
  context.appendChild(make('p', { text: `材料状态：${sourceStatusLabel(source)}` }));
  const limits = [...source.limits, ...presentation.limits];
  if (limits.length > 0) context.appendChild(make('p', { text: `已知限制：${limits.join('；')}` }));
  container.appendChild(context);
  const record = make('details', { className: 'source-record' });
  record.open = recordOpen;
  record.appendChild(make('summary', { text: '来源记录', attrs: { 'data-source-focus': 'record' } }));
  const list = make('dl', {});
  const linkRow = make('div', {});
  linkRow.appendChild(make('dt', { text: '链接' }));
  const linkDd = make('dd', {});
  if (presentation.safeHref) {
    linkDd.appendChild(
      make('span', { text: source.url })
    );
  } else {
    linkDd.appendChild(make('span', { text: source.url }));
    linkDd.appendChild(make('span', { className: 'limit-note', text: '链接不是可安全展示的 http(s) 地址，只按原文显示，不生成可点击链接。' }));
  }
  linkRow.appendChild(linkDd);
  list.appendChild(linkRow);
  list.appendChild(detailRow('平台', presentation.matched ? `${presentation.label}（按链接主机推断）` : '未匹配已知平台，按网站展示'));
  list.appendChild(detailRow('域名', presentation.hostLabel));
  if (presentation.contentFormLabel) {
    list.appendChild(
      detailRow('内容形态', `${presentation.contentFormLabel}${presentation.contentFormNote ? ` · ${presentation.contentFormNote}` : ''}`)
    );
  }
  list.appendChild(detailRow('发表时间', formatDate(source.publishedAt)));
  list.appendChild(detailRow('获取时间', formatDateTime(source.retrievedAt)));
  record.appendChild(list);
  container.appendChild(record);

  if (source.excluded) {
    const box = make('div', { className: 'exclusion-status' });
    box.appendChild(document.createTextNode(`已不采用 ${source.sourceKey}，相关结论标记为待复核。`));
    box.appendChild(
      make('button', {
        className: 'button',
        text: '撤销',
        attrs: { type: 'button', 'data-source-focus': 'undo' },
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
      attrs: { type: 'button', 'data-source-focus': source.excluded ? 'restore' : 'exclude' },
      on: {
        click: () => {
          if (source.excluded) handlers.onRestore(source.sourceKey);
          else handlers.onExclude(source.sourceKey);
        }
      }
    })
  );
  container.appendChild(actions);

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
      observedSeq: event.seq,
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
  const running = state === 'researching' || state === 'queued';
  const currentStage = running ? stages.filter(stage=>stage.status==='active').reduce<StageView|undefined>((latest,stage)=>!latest||(stage.observedSeq??stage.index)>=(latest.observedSeq??latest.index)?stage:latest,undefined) : undefined;
  if (stages.length === 0) {
    list.appendChild(make('p', { className: 'stage-empty', text: '还没有可观察的研究步骤。' }));
  } else {
    for (const stage of stages) {
      const item = make('div', { className: 'stage-item enter' });
      // Stale active stage records must never keep reading as busy once the
      // run stopped or is waiting for a decision: without a running current
      // stage they render as history ("过程记录").
      const isRecord = (!running || openEnded) && stage.status === 'active' && stage !== currentStage;
      item.dataset.status = isRecord ? 'record' : stage.status;
      item.appendChild(make('span', { className: 'stage-index', text: String(stage.index + 1).padStart(2, '0') }));
      item.appendChild(make('span', { className: 'stage-label', text: stage.label }));
      item.appendChild(make('span', { className: 'stage-tag', text: isRecord ? '过程记录' : STAGE_TAGS[stage.status] }));
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
  progressText.textContent = openEnded ? `${stages.length} 条过程记录` : `${done} / ${total || 0}`;
  activityState.textContent = running ? currentStage?.label ?? stateLabel(state) : stateLabel(state);
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
    // Preview-only compression: a question of URL plus prose never renders an
    // enormous percent-encoded path; the full question stays in aria/title.
    const title = historyPreviewLabel(run.question);
    const metadata = `${stateLabel(run.state)}${run.sourceCount > 0 ? ` · ${run.sourceCount} 个来源` : ''}${run.reviewCount > 0 ? ` · ${run.reviewCount} 处待复核` : ''}`;
    const button = make('button', {
      className: 'history-item',
      attrs: {
        type: 'button',
        'aria-current': run.runId === currentRunId ? 'true' : 'false',
        'data-run-id': run.runId,
        'aria-label': `${run.question}，${metadata}`,
        title: run.question
      },
      on: { click: () => onSelect(run.runId) }
    });
    button.appendChild(make('span',{className:'history-item-icon',attrs:{'aria-hidden':'true'}}));
    const copy = make('span',{className:'history-item-copy'});
    copy.appendChild(make('strong', { text: title }));
    copy.appendChild(
      make('small', {
        text: metadata
      })
    );
    button.appendChild(copy);
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
  return sourceFetchStatusLabel(source.fetchStatus);
}

export { byId };
