/**
 * GET-213 client presentation for the staged person overview + explicit
 * confirmation (docs/design/name-confirmation-2026-10-21.md).
 *
 * Authority rules mirrored from the shared contract:
 * - candidates render from the authoritative overview only (source-backed
 *   descriptor atoms, exact quote spans with locators); search-index clues are
 *   visibly distinct from read originals and nothing here ever upgrades
 *   identity or ownership;
 * - the confirm action submits ONLY versions plus one immutable candidate id —
 *   never sources, URLs or free text; the server revalidates everything;
 * - billing/service failures show a safe structured status with an actionable
 *   manual retry path (never an automatic retry and never a permanent spinner);
 * - empty results invite manual distinguishing clues instead of fabricating a
 *   person; same-name candidates stay separate and uncertainty stays visible.
 */

import { make, clear } from './dom.js';
import { isPublicHttpsUrl } from '../shared/validation.js';
import type { FirstStepDiscoveryView } from '../shared/first-step-discovery.js';
import {
  personSourceAccessLabel,
  type PersonCandidateView,
  type PersonOverviewView
} from '../shared/person-confirmation.js';

export interface PersonConfirmationState {
  view: FirstStepDiscoveryView;
  selectedCandidateId: string | null;
  pending: boolean;
  expanding: boolean;
  error: string | null;
  hint: string;
}

export interface PersonConfirmationHandlers {
  onSelect(candidateId: string): void;
  onConfirm(): void;
  onHintInput(hint: string): void;
  onHintCompositionStart?(): void;
  onHintCompositionEnd?(): void;
  onExpand(): void;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`.slice(0, 64);
  } catch {
    return url.slice(0, 64);
  }
}

function coverageLine(overview: PersonOverviewView): string {
  return `本次有界检索：已读原文 ${String(overview.coverage.sourcesRead)} 篇、搜索索引线索 ${String(overview.coverage.sourcesIndexed)} 条；不代表覆盖全部互联网信息。`;
}

function renderCandidate(
  candidate: PersonCandidateView,
  selected: boolean,
  disabled: boolean,
  handlers: PersonConfirmationHandlers
): HTMLElement {
  const card = make('article', { className: 'person-candidate', attrs: { 'data-candidate': candidate.candidateId } });
  const controlId = 'person-choice-' + candidate.candidateId.replace(/[^a-z0-9_-]/gi, '-');
  const radio = make('input', {
    attrs: { id: controlId, type: 'radio', name: 'person-candidate', value: candidate.candidateId,
      'data-focus-key': 'person-candidate:' + candidate.candidateId, disabled },
    on: { change: () => { if (!disabled) handlers.onSelect(candidate.candidateId); } }
  });
  radio.checked = selected;
  const body = make('div', { className: 'person-candidate-body' });
  const heading = make('label', { className: 'person-candidate-heading', attrs: { for: controlId } });
  heading.appendChild(make('strong', { text: candidate.displayName }));
  body.appendChild(heading);
  const read = candidate.sources.some((source) => source.retrieval === 'read');
  body.appendChild(make('p', { className: 'muted person-candidate-meta', text: read ? '原文已读取' : '仅搜索索引可见，尚未读取原文' }));
  const preview = candidate.descriptors.find((descriptor) => descriptor.kind === 'source_excerpt');
  body.appendChild(make('p', { className: 'person-descriptor', text: preview?.statement ??
    (read ? '已读取来源，暂未提取到可定位的人物描述。' : '当前仅有来源标题，暂无原文描述。') }));
  for (const item of candidate.counterevidence) body.appendChild(make('p', { className: 'person-counterevidence', text: item }));

  const details = make('details', { className: 'person-source-details' });
  const summary = make('summary', { text: '查看来源与原文依据（' + String(candidate.sources.length) + '）' });
  details.appendChild(summary);
  details.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && details.open) {
      event.stopPropagation();
      details.open = false;
      summary.focus();
    }
  });
  const sources = make('ul', { className: 'person-sources', attrs: { 'aria-label': '来源清单' } });
  for (const source of candidate.sources) {
    const item = make('li', { className: 'person-source person-source-' + source.retrieval });
    item.appendChild(make('span', { className: 'person-source-label', text: personSourceAccessLabel(source) }));
    if (isPublicHttpsUrl(source.url)) {
      item.appendChild(make('a', { text: source.title || shortUrl(source.url), attrs: {
        href: source.url, target: '_blank', rel: 'noopener noreferrer' } }));
    } else item.appendChild(make('span', { text: source.title || shortUrl(source.url) }));
    item.appendChild(make('span', { className: 'muted person-source-url', text: source.url }));
    if (source.retrieval === 'read' && source.quote) item.appendChild(make('blockquote', { className: 'person-quote', text: source.quote }));
    if (source.locator) item.appendChild(make('span', { className: 'muted person-locator', text: source.locator }));
    if (source.retrievedAt) item.appendChild(make('span', { className: 'muted', text: '读取时间：' + source.retrievedAt }));
    if (source.contentHash) item.appendChild(make('code', { className: 'muted person-source-hash', text: source.contentHash }));
    // Preserve descriptor atoms beyond the preview without duplicating the
    // source excerpt already shown in this inspector.
    for (const descriptor of candidate.descriptors.filter((atom) => atom.sourceKey === source.sourceKey && atom.kind === 'source_excerpt')) {
      if (descriptor.quote && descriptor.quote !== source.quote) {
        item.appendChild(make('blockquote', { className: 'person-quote', text: descriptor.quote }));
        if (descriptor.locator) item.appendChild(make('span', { className: 'muted person-locator', text: descriptor.locator }));
      }
    }
    item.appendChild(make('p', { className: 'muted', text: source.note }));
    sources.appendChild(item);
  }
  details.appendChild(sources);
  for (const unknown of candidate.unknowns) details.appendChild(make('p', { className: 'muted person-unknown', text: unknown }));
  body.appendChild(details);
  card.append(radio, body);
  return card;
}

/**
 * Render the person-confirmation stage into the panel root + optional footer.
 * Re-render keeps keyboard focus on the same `data-focus-key` control.
 */
export function renderPersonConfirmation(
  root: HTMLElement,
  footer: HTMLElement | null,
  state: PersonConfirmationState,
  handlers: PersonConfirmationHandlers
): void {
  const owner = root.ownerDocument;
  const active = owner.activeElement as HTMLElement | null;
  const inScope = (node: HTMLElement | null): boolean => Boolean(node && (root.contains(node) || footer?.contains(node)));
  const focusKey = inScope(active) ? active?.dataset.focusKey ?? null : null;
  const textInput = inScope(active) && active?.tagName === 'INPUT' ? active as HTMLInputElement : null;
  const selection = textInput && typeof textInput.selectionStart === 'number'
    ? { start: textInput.selectionStart, end: textInput.selectionEnd ?? textInput.selectionStart, direction: textInput.selectionDirection ?? 'none' as const }
    : null;
  clear(root);
  if (footer) clear(footer);
  root.className = 'first-step person-confirmation';
  const overview = state.view.personOverview ?? null;

  const progress = make('nav', { className: 'first-step-progress', attrs: { 'aria-label': '研究进度' } });
  progress.append(
    make('span', { className: 'current', text: '确认目标人物', attrs: { 'aria-current': 'step' } }),
    make('span', { text: '选择研究账号' }),
    make('span', { text: '深入研究' }),
    make('span', { text: '整理报告' })
  );
  const intro = make('header', { className: 'first-step-intro' });
  intro.append(progress, make('h2', { text: '先确认你要研究的人' }));
  root.appendChild(intro);
  if (overview) {
    root.appendChild(make('p', { className: 'muted', text: `本次输入：${overview.queryLabel}。${coverageLine(overview)}` }));
  }

  // Safe structured service failure: actionable operator/manual path, never a
  // fabricated person conclusion and never an automatic retry.
  const serviceError = overview?.serviceError ?? null;
  if (serviceError) {
    const box = make('section', { className: 'person-service-error', attrs: { role: 'alert', 'aria-label': '服务失败' } });
    box.appendChild(make('h3', { text: '检索服务暂时不可用' }));
    box.appendChild(make('p', { text: serviceError.safeDetail }));
    if (serviceError.code === 'provider_billing') {
      box.appendChild(make('p', { text: '这是服务计费问题，不是“没有这个人”。请运营方处理供应商账单或授权后，再手动重新发现；本次不会自动重试，费用未知。' }));
    }
    const retry = make('button', {
      className: 'button',
      text: state.expanding ? '正在重新发现…' : '手动重新发现（新尝试）',
      attrs: { type: 'button', 'data-focus-key': 'person-retry', disabled: state.expanding || state.pending },
      on: { click: () => handlers.onExpand() }
    });
    box.appendChild(retry);
    root.appendChild(box);
  }

  if (overview && overview.candidates.length > 0) {
    const list = make('section', { className: 'person-candidates', attrs: { 'aria-label': '人物候选' } });
    list.appendChild(make('h3', { text: '来源支持的人物候选（同名不合并）' }));
    for (const candidate of overview.candidates) {
      list.appendChild(renderCandidate(candidate, state.selectedCandidateId === candidate.candidateId, state.pending || state.expanding, handlers));
    }
    root.appendChild(list);
  } else if (overview && !serviceError) {
    const empty = make('section', { className: 'person-empty', attrs: { 'aria-label': '未找到候选' } });
    empty.appendChild(make('h3', { text: '本次没有找到可辨识的人物来源' }));
    empty.appendChild(make('p', { text: '这不代表此人不存在。可以补充一个可区分线索（公开主页、机构或作品），我们会发起一次新的有界发现。' }));
    root.appendChild(empty);
  }

  for (const gap of (overview?.gaps ?? []).slice(0, 6)) {
    root.appendChild(make('p', { className: 'muted person-gap', text: gap }));
  }

  const host = make('div', { className: 'person-confirmation-actions', attrs: { 'data-has-candidates': Boolean(overview?.candidates.length) ? 'true' : 'false' } });
  (footer ?? root).appendChild(host);
  if (state.error) host.appendChild(make('p', { className: 'error-text', text: state.error, attrs: { role: 'alert', 'data-focus-key': 'person-error' } }));
  const canConfirm = Boolean(state.selectedCandidateId) && !state.pending && !state.expanding;
  const confirm = make('button', {
    className: 'button primary first-step-primary',
    text: state.view.phase === 'expanding_accounts' ? '正在查找公开账号…' : state.pending ? '正在确认…' : '确认这个人物，查找公开账号',
    attrs: { type: 'button', 'data-focus-key': 'person-confirm', disabled: !canConfirm },
    on: { click: () => handlers.onConfirm() }
  });
  if (overview?.candidates.length) host.appendChild(confirm);
  const hintRow = make('div', { className: 'person-hint-row' });
  const hint = make('input', {
    attrs: {
      type: 'text',
      'aria-label': '补线索',
      'data-focus-key': 'person-hint',
      placeholder: '都不是？补充公开主页、机构或作品线索',
      value: state.hint,
      maxlength: 500,
      disabled: state.pending || state.expanding
    },
    on: {
      input: (event) => {
        const value = (event.target as HTMLInputElement).value;
        handlers.onHintInput(value);
        expand.disabled = state.pending || state.expanding || !value.trim();
      },
      compositionstart: () => handlers.onHintCompositionStart?.(),
      compositionend: () => handlers.onHintCompositionEnd?.()
    }
  });
  const expand = make('button', {
    className: 'button',
    text: state.expanding ? '正在重新发现…' : '补充线索后重新发现',
    attrs: { type: 'button', 'data-focus-key': 'person-expand', disabled: state.expanding || state.pending || !state.hint.trim() },
    on: { click: () => handlers.onExpand() }
  });
  hintRow.append(hint, expand);
  host.appendChild(hintRow);

  const restore = [...root.querySelectorAll<HTMLElement>('[data-focus-key]'), ...(footer ? [...footer.querySelectorAll<HTMLElement>('[data-focus-key]')] : [])]
    .find((element) => element.dataset.focusKey === focusKey);
  if (restore && typeof restore.focus === 'function') {
    restore.focus();
    if (selection && restore.tagName === 'INPUT') {
      try { (restore as HTMLInputElement).setSelectionRange(selection.start, selection.end, selection.direction); } catch { /* Non-text controls have no selection range. */ }
    }
  }
}
