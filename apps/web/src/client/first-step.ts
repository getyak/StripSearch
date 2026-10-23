/**
 * First-step controlled renderer (2026-10-21 account comparison workspace):
 * a compact person summary ABOVE an aligned account-row comparison, one atomic
 * scope confirmation, and honest identity/linkage presentation.
 *
 * Real state only ever comes from the server projection (`GET
 * /api/runs/:id/first-step/discovery`); the local draft (checkboxes,
 * independent scopes, exclusion statements) is user input that SSE/refresh
 * updates NEVER overwrite. Suggestions are visual defaults only: a fresh
 * account is never auto-checked after the user started editing, and unchecking
 * is never an exclusion. Filtering and search are presentation-only windows
 * over the displayed candidates: they never touch the draft or the payload.
 */

import { clear, make } from './dom.js';
import { firstStepDraftCache } from './first-step-draft-storage.js';
import {
  excerptText,
  shortUrl,
  accountRowFor,
  accountMatchesFilter,
  accountMatchesQuery,
  personLabelFor,
  FIRST_STEP_FILTER_LABELS,
  FIRST_STEP_FILTER_ORDER,
  type FirstStepAccountFilter
} from './first-step-presentation.js';
import type {
  FirstStepDiscoveryResponse,
  FirstStepSelectionPayload,
  FirstStepSelectionResponse,
  PersonConfirmationPayload
} from './api.js';
import { renderPersonConfirmation } from './person-confirmation.js';
import type {
  FirstStepAccountCategory,
  FirstStepAccountView,
  FirstStepDiscoveryView,
  FirstStepPersonClusterView
} from '../shared/first-step-discovery.js';
import { validateSelectionDecision } from '../shared/first-step-discovery.js';

export interface FirstStepPanelApi {
  getFirstStepDiscovery(runId: string): Promise<FirstStepDiscoveryResponse>;
  submitFirstStepSelection(
    runId: string,
    payload: FirstStepSelectionPayload,
    idempotencyKey: string
  ): Promise<FirstStepSelectionResponse>;
  expandFirstStep(runId: string, body: { hint?: string; url?: string }, idempotencyKey: string): Promise<{ queued: boolean }>;
  /** GET-213 explicit person confirmation; versions + one candidate id only. */
  confirmPerson?(runId: string, payload: PersonConfirmationPayload, idempotencyKey: string): Promise<{ confirmation: { runRevision: number; candidateId: string; idempotent: boolean }; view?: FirstStepDiscoveryView | null }>;
}

export interface FirstStepDecisionDraft {
  selection: 'selected' | 'not_selected' | 'only_this_account' | 'unanswered';
  excluded: boolean;
}

export interface FirstStepPanelDeps {
  api: FirstStepPanelApi;
  container: HTMLElement;
  runId: string;
  /**
   * Optional dedicated actions host OUTSIDE the scrollable work body. When
   * given, the confirmation footer (count, errors, primary action) renders
   * there so it stays reachable with many rows or expanded evidence. Other
   * callers keep the in-panel footer unchanged.
   */
  footerContainer?: HTMLElement;
  /** Owner isolates optional local input drafts; the server remains authority. */
  ownerId?: string;
  /** Called after a successful submit so the host can refresh the run view. */
  onAfterSubmit?: (result: FirstStepSelectionResponse) => void;
  /** GET-213: host refresh after the explicit person confirmation. */
  onAfterPersonConfirm?: () => void;
  onAfterExpand?: () => void;
  now?: () => number;
}

export interface FirstStepPanel {
  /** GET the authoritative view and render; the draft is preserved. */
  refresh(): Promise<void>;
  /** Push a view (SSE/parent); the draft is preserved and never overwritten. */
  applyView(view: FirstStepDiscoveryView, runRevision?: number): void;
  renderLegacy(response: FirstStepDiscoveryResponse): void;
  draft(): Map<string, FirstStepDecisionDraft>;
  selectedCount(): number;
  submit(): Promise<FirstStepSelectionResponse | null>;
  expand(hint: string): Promise<void>;
  destroy(): void;
  statusText(): string;
}

const CATEGORY_ORDER: FirstStepAccountCategory[] = [
  'identity_work',
  'writing',
  'expression',
  'video_audio',
  'academic',
  'related_material',
  'organization'
];

const CATEGORY_LABELS: Record<FirstStepAccountCategory, string> = {
  identity_work: '身份与作品',
  writing: '文章与通讯',
  expression: '公开表达',
  video_audio: '视频与音频',
  academic: '学术与机构资料',
  related_material: '相关资料',
  organization: '组织与第三方'
};

/** Relevance chooses a visual recommendation only; it never proves identity. */
function clusterFitsInput(cluster: FirstStepPersonClusterView, current: FirstStepDiscoveryView): boolean {
  if (current.input.kind === 'homepage_url') {
    return cluster.accountIds.some(id => current.accounts.some(account => account.accountId === id && account.profileUrl?.replace(/\/$/, '') === current.input.value.replace(/\/$/, '')));
  }
  const title = cluster.displayName.toLocaleLowerCase();
  const names = current.input.value.split(/\s*[\/／]\s*/).map(name => name.trim().toLocaleLowerCase()).filter(name => name.length >= 2);
  return names.some(name => title === name || title.startsWith(`${name} `) || title.startsWith(`${name} |`) || title.startsWith(`${name}’`) || title.startsWith(`${name}'`));
}

export function createFirstStepPanel(deps: FirstStepPanelDeps): FirstStepPanel {
  const draft = new Map<string, FirstStepDecisionDraft>();
  const cache = firstStepDraftCache(deps.ownerId, deps.runId);
  let destroyed = false;
  let view: FirstStepDiscoveryView | null = null;
  let runRevision = 0;
  let clusterId: string | null = null;
  let saving = false;
  let errorText = '';
  let selectionNotice = '';
  let status = 'loading';
  let submitKey: string | null = null;
  let submitIntent: string | null = null;
  let hintDraft = '';
  let hintStatus = '';
  let expanding = false;
  /** GET-213 person stage: chosen candidate id; never auto-submitted. */
  let personCandidateId: string | null = null;
  let idempotencySeq = 0;
  /** Presentation-only comparison window; never part of the draft or payload. */
  let accountFilter: FirstStepAccountFilter = 'all';
  let accountSearch = '';
  let composingAccountSearch = false;
  const now = deps.now ?? ((): number => Date.now());
  let openEvidence: { close: () => void } | null = null;
  // Closed is a deliberate state, not an absence of a previous open state.
  const disclosureState = new Map<string, boolean>();

  const selectedCount = (): number =>
    (view?.accounts ?? []).filter(account => {
      const decision = draft.get(account.accountId);
      return decision && !decision.excluded && (decision.selection === 'selected' || decision.selection === 'only_this_account');
    }).length;

  const persistDraft = (): void => {
    if (!view) return;
    if (view.selection.submitted) { cache.remove(); return; }
    cache.write({ caseId: view.caseId, scopeVersion: view.selection.scopeVersion, clusterId,
      decisions: [...draft].filter(([id]) => view!.accounts.some(account => account.accountId === id)),
      hint: hintDraft.slice(0, 500), submitKey, submitIntent, sequence: idempotencySeq });
  };

  const decisionFor = (account: FirstStepAccountView): FirstStepDecisionDraft => {
    const existing = draft.get(account.accountId);
    if (existing) return existing;
    // A suggestion is only an initial visual default for accounts the user has
    // not touched; later-discovered accounts never become auto-checked.
    const initial: FirstStepDecisionDraft = {
      selection: account.defaultSuggestion.suggested ? 'selected' : 'unanswered',
      excluded: false
    };
    draft.set(account.accountId, initial);
    return initial;
  };

  /** Supplied Figma platform assets (inline 18px emblems; no watermarks). */
  const PLATFORM_ICONS: Readonly<Record<string, string>> = { github: 'github', x: 'x', youtube: 'youtube', bilibili: 'bilibili' };

  /** One shared disclosure behaviour: Esc closes and returns to the trigger. */
  const wireDisclosure = (details: HTMLDetailsElement, summary: HTMLElement): void => {
    details.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Escape' && details.open) {
        event.stopPropagation();
        details.open = false;
        summary.focus();
      }
    });
  };

  /**
   * Clicks on interactive parts or inside a nested evidence/provenance
   * disclosure never act as a card/row blank-area choice. The change-person
   * disclosure itself is NOT a blocker: its candidate cards stay clickable.
   */
  const selectionBlocked = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return Boolean(
      element && element.closest('button, a, input, summary, label, details.first-step-cluster-basis, details.first-step-evidence')
    );
  };

  /** Readable presentation plus an inspectable immutable literal excerpt. */
  const appendEvidenceQuote = (container:HTMLElement,quote:string):void => {
    container.appendChild(make('blockquote',{text:excerptText(quote)}));
    if (/<[^>]*>|&(?:[a-z]+|#x?[0-9a-f]+);/i.test(quote)) {
      const original=make('details',{className:'first-step-original'});
      original.appendChild(make('summary',{text:'查看原始摘录（含标记）'}));
      original.appendChild(make('pre',{text:quote}));container.appendChild(original);
    }
  };

  /** GET-213: NEW name attempts confirm the person BEFORE the account workspace. */
  const personStageActive = (current: FirstStepDiscoveryView): boolean =>
    current.personConfirmation?.required === true &&
    current.personConfirmation.status !== 'confirmed' &&
    !current.selection.submitted;

  const render = (): void => {
    if (destroyed || composingAccountSearch) return;
    if (view && personStageActive(view)) {
      const current = view;
      renderPersonConfirmation(
        deps.container,
        deps.footerContainer ?? null,
        { view: current, selectedCandidateId: personCandidateId, pending: saving || current.phase === 'expanding_accounts', expanding, error: errorText, hint: hintDraft },
        {
          onSelect: (candidateId) => {
            if (saving || expanding || current.phase === 'expanding_accounts') return;
            personCandidateId = candidateId;
            render();
          },
          onConfirm: () => { void submit(); },
          onHintInput: (hint) => { hintDraft = hint; persistDraft(); },
          onHintCompositionStart: () => { composingAccountSearch = true; },
          onHintCompositionEnd: () => { composingAccountSearch = false; render(); },
          onExpand: () => {
            if (expanding || saving) return;
            expanding = true;
            errorText = '';
            render();
            void deps.api
              .expandFirstStep(deps.runId, { hint: hintDraft }, `expand-${String(now())}-${String(++idempotencySeq)}`)
              .then(() => {
                if (!destroyed) deps.onAfterExpand?.();
              })
              .catch((error) => {
                if (!destroyed) errorText = error instanceof Error ? error.message : '重新发现失败，请重试。';
              })
              .finally(() => {
                expanding = false;
                if (!destroyed) render();
              });
          }
        }
      );
      return;
    }
    const root = deps.container;
    const footerHost = deps.footerContainer ?? null;
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const inPanel = (node: Node | null): boolean => Boolean(node && (root.contains(node) || footerHost?.contains(node)));
    const focusKey = active && inPanel(active) ? active.dataset.focusKey : null;
    const editControl = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      ? active as HTMLInputElement | HTMLTextAreaElement : null;
    const caret = editControl && typeof editControl.selectionStart === 'number' && typeof editControl.selectionEnd === 'number'
      ? {start: editControl.selectionStart, end: editControl.selectionEnd, direction: editControl.selectionDirection ?? 'none'} : null;
    const focusables = (): HTMLElement[] => [
      ...root.querySelectorAll<HTMLElement>('[data-focus-key]'),
      ...(footerHost ? [...footerHost.querySelectorAll<HTMLElement>('[data-focus-key]')] : [])
    ];
    const scroller = root.closest<HTMLElement>('.work-body');
    const scrollTop = scroller?.scrollTop;
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details[data-detail-key]')) {
      disclosureState.set(details.dataset.detailKey!, details.open);
    }
    for (const sources of root.querySelectorAll<HTMLElement>('.first-step-sources[data-detail-key]')) {
      disclosureState.set(sources.dataset.detailKey!, sources.dataset.open === 'true');
    }
    const previousHint = root.querySelector<HTMLInputElement>('[data-focus-key="hint"]');
    if (previousHint) hintDraft = previousHint.value;
    // The search box is owned by `accountSearch` (its input listener); never
    // re-read a possibly stale DOM value over the user's latest entry.
    persistDraft();
    clear(root);
    if (footerHost) clear(footerHost);
    root.className = 'first-step';
    if (!view) {
      root.appendChild(make('p', { className: 'first-step-status', text: status === 'loading' ? '正在读取发现结果…' : status }));
      return;
    }
    const intro = make('header', { className: 'first-step-intro' });
    const progress = make('nav', { className: 'first-step-progress', attrs: { 'aria-label': '研究进度' } });
    progress.append(
      make('span', { className: 'current', text: '确认研究范围', attrs: { 'aria-current': 'step' } }),
      make('span', { text: '深入研究' }),
      make('span', { text: '整理报告' })
    );
    intro.append(progress,
      make('h2', {text:'选择本轮账号'}));
    root.appendChild(intro);

    // ---- Person summary ABOVE the account rows (comparison workspace) ----
    const personBox = make('section', { className: 'first-step-clusters', attrs: { 'aria-label': '目标人物候选', 'data-single': view.clusters.length <= 1 ? 'true' : 'false' } });
    const chosen = clusterId === null ? null : (view.clusters.find((item) => item.clusterId === clusterId) ?? null);
    personBox.dataset.compact = chosen !== null ? 'true' : 'false';
    personBox.appendChild(make('h3', { className:'sr-only',text: chosen ? '目标人物' : '确认目标人物' }));
    const linkedChoices = view.clusters.filter(cluster => cluster.linkage === 'linked' && cluster.conflicts.length === 0 && clusterFitsInput(cluster, view!));
    const recommendedOnly = linkedChoices.length === 1 && clusterId === linkedChoices[0]!.clusterId;
    const competing = view.clusters.filter(cluster => cluster.clusterId !== clusterId);
    // Literal input matches lead the visible order; this never upgrades identity.
    const orderedCompeting = [...competing].sort((a, b) => Number(clusterFitsInput(b, view!)) - Number(clusterFitsInput(a, view!)));
    const chooseCandidate = (cluster: FirstStepPersonClusterView): void => {
      if (view?.selection.submitted) return;
      clusterId = cluster.clusterId;
      // Changing the person cannot grant reading a different person's accounts.
      let removed = 0;
      for (const [id, decision] of draft) {
        if (decision.selection === 'selected' && !cluster.accountIds.includes(id)) { decision.selection = 'not_selected'; removed++; }
      }
      selectionNotice = removed > 0 ? `已更换目标，移除 ${String(removed)} 个不属于此分组的账号选择。独立账号范围仍保留。` : '';
      render();
    };
    const renderCandidate = (cluster: FirstStepPersonClusterView, isChosen: boolean): HTMLElement => {
      const label = personLabelFor(cluster, view!);
      // ONE compact card per candidate: the choice button and its expandable
      // provenance share a single frame — never a double border box.
      const candidate = make('article', {
        className: `first-step-candidate${isChosen ? ' chosen first-step-person' : ''}`,
        attrs: { 'aria-label': `${label.label} · 人物候选` }
      });
      const button = make('button', {
        className: `first-step-cluster${isChosen ? ' chosen' : ''}`,
        attrs: { type: 'button', 'aria-pressed': isChosen ? 'true' : 'false', 'data-focus-key': `cluster-${cluster.clusterId}` },
        on: { click: () => chooseCandidate(cluster) }
      });
      const titles = make('div', { className: 'first-step-cluster-titles' });
      if (view?.selection.submitted) button.setAttribute('disabled', '');
      titles.appendChild(make('strong', { text: label.label }));
      titles.appendChild(make('span', { className: 'first-step-choice-tag', text: isChosen ? '已选择为目标' : '选择此候选' }));
      titles.appendChild(make('span', { className: 'first-step-cluster-label-kind', text: label.kindLabel }));
      if (label.pageTitle && !isChosen) titles.appendChild(make('span', {className:'first-step-cluster-title',text:`页面标题：${label.pageTitle}`}));
      titles.appendChild(make('span', { className: 'first-step-cluster-anchor', text: shortUrl(cluster.anchorUrl) || cluster.anchorLabel }));
      titles.appendChild(
        make('span', {
          className: `first-step-cluster-linkage${cluster.linkage === 'unconfirmed' ? ' uncertain' : ''}`,
          text: cluster.linkage === 'unconfirmed' ? '未确认候选 · 同名不合并' : '有公开原文链接依据'
        })
      );
      button.appendChild(titles);
      // Prefer the longest readable author excerpt already backed by a source;
      // full linkage evidence stays in the adjacent inspector.
      const previewLead = [...cluster.leads].filter(lead => lead.quote).sort((a,b)=>Number(/\bI (?:create|build|write|research|teach|lead|founded)\b/i.test(excerptText(b.quote!)))*1000+Math.min(excerptText(b.quote!).length,240)-Number(/\bI (?:create|build|write|research|teach|lead|founded)\b/i.test(excerptText(a.quote!)))*1000-Math.min(excerptText(a.quote!).length,240))[0];
      const excerpt = previewLead?.quote ?? cluster.anchorBasis?.quote;
      const excerptSource = previewLead?.sourceUrl ?? cluster.anchorBasis?.sourceUrl;
      if (excerpt) {
        const readable = excerptText(excerpt);
        const previewLength = isChosen ? 120 : 80;
        button.appendChild(make('small', { className: 'first-step-lead', text: `原文摘录：“${readable.slice(0,previewLength)}${readable.length>previewLength?'…':''}”` }));
        if (excerptSource && (!isChosen || shortUrl(excerptSource) !== shortUrl(cluster.anchorUrl))) button.appendChild(make('small', { className: 'first-step-lead-source', text: `来源：${shortUrl(excerptSource)}` }));
      }
      if (cluster.conflicts.length > 0) {
        button.appendChild(make('small', { className: 'first-step-conflict', text: cluster.conflicts.join('；') }));
      }
      candidate.appendChild(button);
      // Inspectable linkage basis: exact spans of the retained originals,
      // rendered as escaped plain text; the original stays inspectable.
      const basis = make('details', { className: 'first-step-cluster-basis', attrs: { 'data-detail-key': `basis-${cluster.clusterId}` } });
      const basisSummary = make('summary', { text: `辨识依据与出处（${label.label}）`, attrs: { 'data-focus-key': `basis-${cluster.clusterId}` } });
      basis.appendChild(basisSummary);
      wireDisclosure(basis, basisSummary);
      const basisList = make('div', {});
      if (label.pageTitle) basisList.appendChild(make('p', { className: 'first-step-cluster-title', text: `页面标题：${label.pageTitle}` }));
      if (cluster.anchorBasis) {
        const block = make('div', { className: 'first-step-evidence-item' });
        block.appendChild(make('p', { text: `${cluster.anchorBasis.label}（${cluster.anchorBasis.sourceUrl ?? '来源未记录'}）` }));
        if (cluster.anchorBasis.quote) appendEvidenceQuote(block, cluster.anchorBasis.quote);
        basisList.appendChild(block);
      }
      for (const lead of cluster.leads) {
        const block = make('div', { className: 'first-step-evidence-item' });
        block.appendChild(make('p', { text: `${lead.statement}（来源：${lead.sourceUrl ?? '来源未记录'}）` }));
        if (lead.quote) appendEvidenceQuote(block, lead.quote);
        basisList.appendChild(block);
      }
      if (!cluster.anchorBasis && cluster.leads.length === 0) {
        basisList.appendChild(make('p', { className: 'muted', text: '暂无可展示的原文依据；这只是候选线索。' }));
      }
      basis.appendChild(basisList);
      candidate.appendChild(basis);
      // Clicking the card body chooses this candidate; provenance/evidence
      // actions inside the details never change the selection.
      candidate.addEventListener('click', (event) => {
        if (selectionBlocked(event.target)) return;
        chooseCandidate(cluster);
      });
      return candidate;
    };

    if (view.clusters.length === 0) {
      personBox.appendChild(make('p', { className: 'muted', text: '暂未辨识出可确认的人物；可以补充一个公开主页或区分线索。' }));
    }
    if (chosen) {
      personBox.appendChild(renderCandidate(chosen, true));
      if (recommendedOnly && competing.length > 0) {
        personBox.appendChild(make('p', { className: 'muted', text: '建议目标 · 可展开其它候选更换；点击继续才会提交。' }));
      }
    }
    if (chosen === null ? view.clusters.length > 0 : competing.length > 0) {
      // Competing people stay discoverable behind ONE explicit disclosure; the
      // count and the "never merged" state are visible on the trigger itself.
      const others = make('details', { className: 'first-step-other-people', attrs: { 'data-detail-key': 'other-people' } });
      const othersSummary = make('summary', {
        text: chosen
          ? `更换目标人物 · 其它候选 ${String(competing.length)} 个（同名不合并，展开核对）`
          : `人物候选 ${String(view.clusters.length)} 个 · 同名不合并，请先核对`,
        attrs: { 'data-focus-key': 'change-person' }
      });
      others.appendChild(othersSummary);
      wireDisclosure(others, othersSummary);
      for (const cluster of chosen ? orderedCompeting : [...view.clusters].sort((a, b) => Number(clusterFitsInput(b, view!)) - Number(clusterFitsInput(a, view!)))) {
        others.appendChild(renderCandidate(cluster, false));
      }
      // Without a chosen person the decision IS the person choice: show it.
      if (chosen === null && !disclosureState.has('other-people')) others.open = true;
      personBox.appendChild(others);
    }
    root.appendChild(personBox);

    // ---- Aligned account rows: fixed account/content/basis/status/selection --
    const personal = (account:FirstStepAccountView):boolean => account.accountKind!=='organization' && account.category!=='organization';
    const inMain = (account: FirstStepAccountView): boolean => personal(account) && (chosen !== null
        ? chosen.accountIds.includes(account.accountId)
        : account.identity.state === 'supported' || account.defaultSuggestion.suggested);
    const mainAccounts = view.accounts.filter(inMain);
    const otherLinkedAccounts = chosen === null ? [] : view.accounts.filter(account => personal(account) && !inMain(account) && account.identity.state === 'supported' && !account.requiresIndependentScope);
    const otherLinkedIds = new Set(otherLinkedAccounts.map(account => account.accountId));
    const matchingClusters = view.clusters.filter(cluster => clusterFitsInput(cluster, view!));
    const namedLabels = new Map<string,string>();
    if (chosen && view.input.kind === 'name_query') {
      for (const cluster of matchingClusters) {
        if (cluster.clusterId === chosen.clusterId) continue;
        for (const id of cluster.accountIds) namedLabels.set(id,cluster.displayName);
      }
    }
    // Actual name-matching titles help people inspect other public profiles;
    // they never prove that these profiles belong to the chosen person.
    const namedAccounts=view.accounts.filter(account=>personal(account)&&!inMain(account)&&namedLabels.has(account.accountId)&&account.requiresIndependentScope&&account.identity.state!=='rejected'&&account.identity.counterevidence.length===0);
    const namedIds=new Set(namedAccounts.map(account=>account.accountId));
    const linkedLeads=view.accounts.filter(account=>personal(account)&&!inMain(account)&&!namedIds.has(account.accountId)&&account.requiresIndependentScope&&account.identity.state!=='rejected'&&!account.identity.nativeIdConflict&&account.identity.counterevidence.length===0&&
      chosen!==null&&(account.profileLinkSources??[]).some(source=>chosen.accountIds.includes(source.accountId)));
    const linkedLeadIds=new Set(linkedLeads.map(account=>account.accountId));
    const organizationAccounts=view.accounts.filter(account=>!personal(account));
    const secondaryAccounts = view.accounts.filter((account) => personal(account)&&!inMain(account)&&!namedIds.has(account.accountId)&&!linkedLeadIds.has(account.accountId)&&!otherLinkedIds.has(account.accountId));

    const rowVisible = (account: FirstStepAccountView): boolean =>
      accountMatchesFilter(account, decisionFor(account), accountFilter) && accountMatchesQuery(account, accountSearch);
    /** Compact categorized rows: one aligned list, never a 90-card wall. */
    const renderRows = (accounts: FirstStepAccountView[], labels?:ReadonlyMap<string,string>): HTMLElement => {
      const wrap = make('div', { className: 'first-step-groups' });
      const ordered = [...accounts].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
      for (const account of ordered) {
        const row = renderRow(account, labels?.get(account.accountId));
        row.hidden = !rowVisible(account);
        wrap.appendChild(row);
      }
      return wrap;
    };

    const cardsBox = make('section', { className: 'first-step-accounts', attrs: { 'aria-label': '选择研究账号' } });
    cardsBox.appendChild(make('h3', { className:'sr-only', text: '选择研究账号' }));
    // Selection semantics are explained ONCE here; rows only state their own
    // boundary. The checkbox is a reading scope, never an ownership claim.
    cardsBox.appendChild(make('p', {
      className: 'first-step-scope-note',
      text: '勾选只决定本轮读取范围，不代表归属已确认；待核对或不属于目标分组的账号将单独研究。可读仅指主页资料，不代表已读帖子、视频或评论。'
    }));
    if (mainAccounts.length === 0 && view.clusters.length > 0) {
      cardsBox.appendChild(make('p', { className: 'muted', text: '请先确认目标人物；这个人的公开账号会显示在这里。' }));
    }

    // Comparison window: filter + search over the displayed candidate scope.
    const tools = make('div', { className: 'first-step-account-tools' });
    const filters = make('div', { className: 'first-step-filters', attrs: { role: 'group', 'aria-label': '筛选账号' } });
    for (const filter of FIRST_STEP_FILTER_ORDER) {
      const count = view.accounts.filter(account => accountMatchesFilter(account, decisionFor(account), filter)).length;
      filters.appendChild(make('button', {
        className: `first-step-filter${accountFilter === filter ? ' active' : ''}`,
        text: `${FIRST_STEP_FILTER_LABELS[filter]} ${String(count)}`,
        attrs: {
          type: 'button',
          'data-filter': filter,
          'data-focus-key': `filter-${filter}`,
          'aria-pressed': accountFilter === filter ? 'true' : 'false'
        },
        on: { click: () => { accountFilter = filter; render(); } }
      }));
    }
    const searchInput = make('input', {
      className: 'first-step-search',
      attrs: { type: 'search', placeholder: '按平台或 handle 搜索', 'aria-label': '按平台或 handle 搜索账号', 'data-focus-key': 'account-search' }
    }) as HTMLInputElement;
    searchInput.value = accountSearch;
    searchInput.addEventListener('compositionstart', () => { composingAccountSearch = true; });
    searchInput.addEventListener('compositionend', () => { composingAccountSearch = false; accountSearch = searchInput.value; render(); });
    searchInput.addEventListener('input', () => { accountSearch = searchInput.value; render(); });
    tools.append(filters, searchInput);
    cardsBox.appendChild(tools);

    const rowHead = make('div', { className: 'first-step-row-head', attrs: { 'aria-hidden': 'true' } });
    for (const label of ['账号', '能了解什么', '归属依据', '状态', '选择']) rowHead.appendChild(make('span', { text: label }));
    cardsBox.appendChild(rowHead);

    cardsBox.appendChild(renderRows(mainAccounts));
    if(organizationAccounts.length){
      const organizations=make('details',{className:'first-step-related',attrs:{'data-detail-key':'organizations'}});
      organizations.append(make('summary',{text:`组织与第三方 · ${organizationAccounts.length} 个入口`}),make('p',{className:'muted',text:'与人物有关的组织可以提供背景；其账号和成果不作为本人账号或个人贡献。'}),renderRows(organizationAccounts));
      organizations.hidden = organizationAccounts.every(account => !rowVisible(account));
      cardsBox.appendChild(organizations);
    }
    if (otherLinkedAccounts.length > 0) {
      const separate = make('section', {className:'first-step-other-linked',attrs:{'aria-label':'其它分组的账号，单独研究'}});
      separate.append(make('h3',{text:`其它分组的账号 · 单独研究（${String(otherLinkedAccounts.length)}）`}),make('p',{className:'muted',text:'这些账号已有原文链接依据，但尚未关联到所选人物分组。默认不选；勾选后仅研究该账号，不并入此人的身份结论。'}),renderRows(otherLinkedAccounts));
      separate.hidden = otherLinkedAccounts.every(account => !rowVisible(account));
      cardsBox.appendChild(separate);
    }
    if(linkedLeads.length>0){
      const linked=make('section',{className:'first-step-profile-links first-step-name-matches',attrs:{'aria-label':'该主页发现的账号，归属待核对'}});
      linked.append(make('h3',{text:`该主页发现的账号 · 归属待核对（${String(linkedLeads.length)}）`}),make('p',{className:'muted',text:'这些账号入口出现在已读主页的外链中，链接本身不能证明归属。默认不选；勾选后仅研究该账号，不并入人物身份结论。'}),renderRows(linkedLeads));
      linked.hidden = linkedLeads.every(account => !rowVisible(account));
      cardsBox.appendChild(linked);
    }
    if (namedAccounts.length>0) {
      const named=make('section',{className:'first-step-name-matches',attrs:{'aria-label':'同名公开主页，分别核对'}});
      named.append(make('h3',{text:`同名公开主页 · 分别核对（${String(namedAccounts.length)}）`}),make('p',{className:'muted',text:'这些主页的实际标题也匹配你输入的姓名，可能属于同名的人。默认不选；勾选后仅以独立账号范围研究，不并入此人的身份结论。'}),renderRows(namedAccounts,namedLabels));
      named.hidden = namedAccounts.every(account => !rowVisible(account));
      cardsBox.appendChild(named);
    }
    if (secondaryAccounts.length > 0 || (view.relatedLeads ?? []).length > 0) {
      const secondary = make('details', { className: 'first-step-related', attrs: { 'data-detail-key': 'related-leads' } });
      secondary.appendChild(
        make('summary', { text: `其它账号线索（${String(secondaryAccounts.length)}） · 材料链接（${String((view.relatedLeads ?? []).length)}）` })
      );
      secondary.appendChild(
        make('p', { className: 'muted', text: '未确认 / 不并入人物结论。保留的真实线索默认不勾选，可单独以独立账号范围研究。' })
      );
      secondary.appendChild(renderRows(secondaryAccounts));
      if ((view.relatedLeads ?? []).length > 0) {
        const materials = make('div', { className: 'first-step-materials' });
        materials.appendChild(make('h4', { text: '材料链接（不是账号入口）' }));
        const list = make('ul', {});
        for (const lead of (view.relatedLeads ?? []).slice(0, 24)) {
          list.appendChild(
            make('li', {
              children: [
                make('span', { text: `${lead.title ? `${lead.title} · ` : ''}${shortUrl(lead.url)}` }),
                make('small', { className: 'first-step-limit', text: lead.note })
              ]
            })
          );
        }
        materials.appendChild(list);
        secondary.appendChild(materials);
      }
      secondary.hidden = secondaryAccounts.length > 0 && secondaryAccounts.every(account => !rowVisible(account));
      cardsBox.appendChild(secondary);
    }
    const allLists = [...mainAccounts, ...organizationAccounts, ...otherLinkedAccounts, ...linkedLeads, ...namedAccounts, ...secondaryAccounts];
    if (allLists.length > 0 && allLists.every(account => !rowVisible(account))) {
      cardsBox.appendChild(make('p', { className: 'first-step-empty-filter muted', text: '没有符合当前筛选或搜索的账号；可切换筛选或清空搜索。已选账号与草稿不受影响。' }));
    }
    root.appendChild(cardsBox);

    // Discovery status and honest gaps.
    const statusBox = make('section', { className: 'first-step-status-box', attrs: { 'aria-label': '发现状态' } });
    statusBox.appendChild(
      make('p', {
        className: 'first-step-status',
        text: view.readyForChoice ? `找到 ${String(view.accounts.length)} 个公开入口 · 请核对后选择` : '正在寻找公开主页与跨平台线索…'
      })
    );
    if (view.gaps.length > 0) {
      const details = make('details', { className: 'first-step-gaps', attrs: {'data-detail-key':'gaps'} });
      details.appendChild(make('summary', { text: `发现边界与缺口（${String(view.gaps.length)}）` }));
      const list = make('ul', {});
      for (const gap of view.gaps.slice(0, 12)) list.appendChild(make('li', { text: gap }));
      details.appendChild(list);
      statusBox.appendChild(details);
    }
    root.appendChild(statusBox);

    // Secondary actions: manual clue / continue search.
    const secondary = make('details', { className: 'first-step-secondary', attrs: {'data-detail-key':'hint'} });
    secondary.appendChild(make('summary', { text: '补充一个公开主页或区分线索' }));
    const hintInput = make('input', {
      attrs: { type: 'text', placeholder: '例如：他是 Lantern 的作者', 'aria-label': '补线索', 'data-focus-key': 'hint' }
    }) as HTMLInputElement;
    hintInput.value = hintDraft;
    hintInput.addEventListener('input', () => { hintDraft = hintInput.value; persistDraft(); });
    const hintState = make('span', { className: 'muted', text: hintStatus, attrs:{role:'status'} });
    secondary.appendChild(hintInput);
    secondary.appendChild(
      make('button', {
        className: 'button',
        text: expanding ? '正在提交…' : '发起新的发现',
        attrs: { type: 'button', 'data-focus-key':'expand', ...(expanding ? {disabled:true} : {}) },
        on: {
          click: () => {
            void (async () => {
              const hint = hintInput.value.trim();
              if (!hint) {
                hintState.textContent = '请先填写线索。';
                return;
              }
              if (expanding) return;
              expanding = true;
              hintStatus = '正在提交新的发现请求…';
              hintState.textContent = hintStatus;
              try {
                await deps.api.expandFirstStep(deps.runId, { hint }, `expand-${String(now())}-${String(++idempotencySeq)}`);
                hintStatus = '已排队，正在寻找更多公开线索。';
                hintState.textContent = hintStatus;
                if (!destroyed) deps.onAfterExpand?.();
              } catch (error) {
                hintStatus = error instanceof Error ? error.message : '扩展失败。';
                hintState.textContent = hintStatus;
              } finally {
                expanding = false;
              }
            })();
          }
        }
      })
    );
    secondary.appendChild(hintState);
    root.appendChild(secondary);

    // One primary action.
    const footer = make('footer', { className: 'first-step-footer' });
    const count = selectedCount();
    footer.appendChild(
      make('div', {
        className: 'first-step-selection-title',
        text: count > 0 ? `已选 ${String(count)} 个账号` : '还没有选择研究账号'
      })
    );
    if (errorText) footer.appendChild(make('p', { className: 'error-text', text: errorText, attrs: { role: 'alert' } }));
    if (selectionNotice) footer.appendChild(make('p', { className: 'muted first-step-selection-notice', text: selectionNotice, attrs: { role: 'status' } }));
    const primary = make('button', {
      className: 'button primary first-step-primary',
      text: count > 0 ? `继续研究（${String(count)} 个账号）` : '继续研究',
      attrs: { type: 'button', 'data-focus-key':'submit' },
      on: {
        click: () => {
          void submit();
        }
      }
    }) as HTMLButtonElement;
    primary.disabled = count === 0 || saving || !view.readyForChoice || view.selection.submitted;
    if (view.selection.submitted) primary.textContent = '范围已提交';
    footer.appendChild(primary);
    if (count === 0) {
      footer.appendChild(make('p', { className: 'muted', text: '请至少选择一个账号；不确定的账号可选“仅研究这个公开账号”。' }));
    }
    (footerHost ?? root).appendChild(footer);
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details')) {
      const key = details.dataset.detailKey;
      if (key && disclosureState.has(key)) details.open = disclosureState.get(key)!;
    }
    for (const sources of root.querySelectorAll<HTMLElement>('.first-step-sources')) {
      if (disclosureState.get(sources.dataset.detailKey!)) {
        const list = sources.querySelector<HTMLElement>(':scope > .first-step-sources-list');
        const toggle = sources.querySelector<HTMLElement>(':scope > .first-step-sources-toggle');
        if (list) list.hidden = false;
        toggle?.setAttribute('aria-expanded', 'true');
        sources.dataset.open = 'true';
      }
    }
    if (focusKey) {
      let replacement = focusables().find(el => el.dataset.focusKey === focusKey);
      // An action can close its own menu before re-rendering. Restore focus
      // to the visible trigger instead of an unreachable hidden action.
      const closed = replacement?.closest<HTMLDetailsElement>('details:not([open])');
      if (closed) replacement = closed.querySelector<HTMLElement>(':scope > summary') ?? replacement;
      replacement?.focus({preventScroll:true});
      if (caret && replacement && (replacement.tagName === 'INPUT' || replacement.tagName === 'TEXTAREA')) {
        (replacement as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(caret.start, caret.end, caret.direction);
      }
    }
    if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
  };

  /**
   * One aligned comparison row: fixed account / content / basis / status /
   * selection columns. The evidence disclosure expands UNDER its own row and
   * never changes the selection.
   */
  const renderRow = (account: FirstStepAccountView, matchedTitle?:string): HTMLElement => {
    const decision = decisionFor(account);
    const personCluster=view?.clusters.find(cluster => cluster.clusterId === clusterId);
    const ownAnchor=personCluster?.anchorAccountId===account.accountId || !personCluster?.anchorAccountId&&personCluster?.anchorUrl===account.profileUrl;
    const mayJoinPerson=Boolean(personCluster?.accountIds.includes(account.accountId))&&validateSelectionDecision(account,{accountId:account.accountId,selection:'selected',excluded:false},{anchorAccountIds:ownAnchor?new Set([account.accountId]):new Set()}).ok;
    const requiresIndependentScope = account.accountKind==='organization' || !mayJoinPerson;
    const checked = decision.selection === 'selected' || decision.selection === 'only_this_account';
    const row = accountRowFor(account, view?.accounts ?? [account], {
      requiresIndependentScope,
      submitted: view?.selection.submitted === true,
      matchedTitle: matchedTitle ?? null
    });
    const iconKey = PLATFORM_ICONS[account.platform];
    const card = make('article', {
      className: `first-step-card${checked ? ' checked' : ''}${decision.excluded ? ' excluded' : ''}`,
      attrs: { 'data-platform': account.platform, 'data-account-id': account.accountId }
    });
    const applyChecked = (next: boolean): void => {
      if (decision.excluded || view?.selection.submitted) return;
      if (next) {
        decision.selection = requiresIndependentScope ? 'only_this_account' : 'selected';
      } else {
        decision.selection = 'not_selected';
      }
      render();
    };

    // Column 1 — account: the literal handle leads; platform, site host and a
    // source-backed person label share one quiet meta line. Full literal page
    // titles stay inspectable in the row's evidence disclosure.
    const cellAccount = make('div', { className: 'first-step-cell first-step-cell-account', attrs: { 'data-col': '账号' } });
    const emblem = make('span', {className:`first-step-platform-tile platform-${account.platform}`,attrs:{'aria-hidden':'true'}});
    if (iconKey) emblem.appendChild(make('span',{className:`first-step-platform-icon icon-${iconKey}`}));
    else if (account.platform === 'personal_site') emblem.appendChild(make('span',{className:'first-step-platform-icon icon-website'}));
    else emblem.appendChild(make('span',{className:'first-step-platform-initial',text:account.platformLabel.slice(0,2)}));
    const accountLabels = make('div',{className:'first-step-account-labels'});
    accountLabels.appendChild(make('p', { className: 'first-step-handle', text: row.handleLabel,attrs:{title:row.handleLabel} }));
    const metaLine = make('p', { className: 'first-step-platform' });
    metaLine.appendChild(make('span', { text: account.platformLabel }));
    if (row.hostLabel && row.handleLabel !== row.hostLabel) metaLine.appendChild(make('span', { className: 'first-step-host', text: ` · ${row.hostLabel}` }));
    if (row.personLabel) metaLine.appendChild(make('span', { className: 'first-step-person-tag', text: ` · ${row.personLabel.kindLabel}：${row.personLabel.text}` }));
    accountLabels.appendChild(metaLine);
    cellAccount.append(emblem,accountLabels);
    card.appendChild(cellAccount);

    // Column 2 — content: the account-specific clue/conflict/invalidity first,
    // the generic research summary only as a last fallback.
    const cellContent = make('div', { className: `first-step-cell first-step-cell-content content-${row.contentKind}`, attrs: { 'data-col': '能了解什么' } });
    cellContent.appendChild(make('p', { className: 'first-step-value', text: row.contentClue }));
    if (matchedTitle) cellContent.appendChild(make('small', { className: 'first-step-limit', text: '标题匹配 · 归属未确认' }));
    card.appendChild(cellContent);

    // Column 3 — basis: identity state and its source, never a score.
    const cellBasis = make('div', { className: 'first-step-cell first-step-cell-basis', attrs: { 'data-col': '归属依据' } });
    const attribution = make('p', { className: 'first-step-attribution' });
    attribution.appendChild(make('span', {
      className: `first-step-badge${row.badgeTone === 'uncertain' ? ' uncertain' : ''}`,
      text: row.badgeLabel
    }));
    attribution.appendChild(make('span', { className: 'first-step-reason', text: row.basisLabel }));
    cellBasis.appendChild(attribution);
    if (row.ownerNote) cellBasis.appendChild(make('small', { className: 'first-step-reason', text: row.ownerNote }));
    card.appendChild(cellBasis);

    // Column 4 — status: read/access state plus concise row indicators; the
    // complete boundary sentence lives in the shared note and the disclosure.
    const cellStatus = make('div', { className: 'first-step-cell first-step-cell-status', attrs: { 'data-col': '状态' } });
    cellStatus.appendChild(make('p', { className: 'first-step-access', text: row.statusLabel }));
    if (row.boundaryChip) cellStatus.appendChild(make('p', { className: 'first-step-boundary', text: row.boundaryChip }));
    if (decision.excluded) cellStatus.appendChild(make('p', { className: 'first-step-limit', text: '已声明“不是此人”' }));
    card.appendChild(cellStatus);

    // Column 5 — selection: reading scope only; statements stay explicit.
    const cellSelect = make('div', { className: 'first-step-cell first-step-cell-select', attrs: { 'data-col': '选择' } });
    const label = make('label', { className: 'first-step-select' });
    const checkbox = make('input', {
      attrs: { type: 'checkbox', 'data-focus-key': `account-${account.accountId}`, 'aria-label': `选择 ${account.platformLabel} ${account.handle ?? ''} · ${shortUrl(account.profileUrl)}`, ...(checked ? { checked: true } : {}) }
    }) as HTMLInputElement;
    checkbox.checked = checked;
    checkbox.disabled = decision.excluded || view?.selection.submitted === true;
    // Click flips the render-time state (the native toggle applies later);
    // change re-syncs from the element state — both converge, never double-flip.
    const syncFromCheckbox = (): void => applyChecked(checkbox.checked);
    checkbox.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    checkbox.addEventListener('change', (event) => {
      event.stopPropagation();
      syncFromCheckbox();
    });
    label.append(checkbox, make('span', { className: 'first-step-select-text', text: checked ? '已加入' : '加入本轮' }));
    cellSelect.appendChild(label);
    const actions = make('div', { className: 'first-step-row-actions' });
    if (!decision.excluded && !view?.selection.submitted) {
      actions.appendChild(
        make('button', {
          className: 'text-button',
          text: '不是此人',
          attrs: { type: 'button', 'aria-label': `声明 ${account.platformLabel} 不是此人`, 'data-focus-key': `exclude-${account.accountId}` },
          on: {
            click: (event) => {
              event.stopPropagation();
              decision.excluded = true;
              decision.selection = 'not_selected';
              render();
            }
          }
        })
      );
      // Linkage evidence never obliges the user to merge this account into a person.
      if (!decision.excluded) {
        actions.appendChild(
          make('button', {
            className: 'text-button',
            text: decision.selection === 'only_this_account' ? '已选为独立账号范围' : '仅研究这个公开账号',
            attrs: { type: 'button', 'data-focus-key': `independent-${account.accountId}` },
            on: {
              click: (event) => {
                event.stopPropagation();
                decision.selection = decision.selection === 'only_this_account' ? 'not_selected' : 'only_this_account';
                render();
              }
            }
          })
        );
      }
    }
    if (decision.excluded && !view?.selection.submitted) {
      actions.appendChild(
        make('button', {
          className: 'text-button',
          text: '撤销排除声明',
          attrs: { type: 'button', 'data-focus-key': `exclude-${account.accountId}` },
          on: {
            click: (event) => {
              event.stopPropagation();
              // Revoking an exclusion is NOT selecting the account.
              decision.excluded = false;
              decision.selection = 'unanswered';
              render();
            }
          }
        })
      );
    }
    card.appendChild(cellSelect);
    if (actions.children.length > 0) {
      const menu = make('details',{className:'first-step-row-menu',attrs:{'data-detail-key':`actions-${account.accountId}`}});
      const menuTrigger = make('summary',{text:'⋯',attrs:{'aria-label':`更多操作：${account.platformLabel} ${row.handleLabel}`,'data-focus-key':`actions-${account.accountId}`}});
      menu.append(menuTrigger,actions);
      wireDisclosure(menu,menuTrigger);
      // An explicit menu choice completes the menu interaction.
      actions.addEventListener('click',()=>{menu.open=false;},{capture:true});
      card.appendChild(menu);
    }

    // Inline evidence disclosure: opens UNDER its own row; the exact original
    // stays inspectable and the selection is never touched.
    const evidence = make('details', { className: 'first-step-evidence', attrs:{'data-detail-key':`evidence-${account.accountId}`} });
    const summary = make('summary', { attrs:{'data-focus-key':`evidence-${account.accountId}`} });
    summary.append(
      make('span', { className: 'first-step-disclosure-open', text: '查看资料' }),
      make('span', { className: 'first-step-disclosure-open', text: '⌄', attrs: { 'aria-hidden': 'true' } }),
      make('span', { className: 'first-step-disclosure-close', text: '收起资料' }),
      make('span', { className: 'first-step-disclosure-close', text: '⌃', attrs: { 'aria-hidden': 'true' } })
    );
    evidence.appendChild(summary);
    evidence.addEventListener('toggle', () => {
      if (evidence.open) {
        openEvidence = {
          close: () => {
            evidence.open = false;
            summary.focus();
          }
        };
      }
    });
    wireDisclosure(evidence, summary);
    const evidenceList = make('div', {});
    const owner=account.identity.ownerAnchor;
    // Secondary context and heavy originals stay nested but complete: the
    // attribution summary, raw declarations, exact quote spans, counterevidence
    // and full conflicts stay one disclosure away.
    const ownerItems = account.identity.ownerEvidence ?? [];
    const supportItems = account.identity.evidence;
    const counterItems = account.identity.counterevidence;
    const declarationItems = account.nativeWebsiteDeclarations ?? [];
    const contextLines: HTMLElement[] = [];
    contextLines.push(make('p',{className:'first-step-reason',text:`读取情况：${account.accessLabel}`}));
    if (row.pageTitle) contextLines.push(make('p', { className: 'first-step-page-title', text: `页面标题：${row.pageTitle}` }));
    if (row.boundaryLabel) contextLines.push(make('p', { className: 'first-step-boundary', text: row.boundaryLabel }));
    if (row.ownerNote) contextLines.push(make('p', {className:'first-step-reason',text:row.ownerNote}));
    if(account.attribution) contextLines.push(make('p',{className:'first-step-reason',text:`${account.attribution.reason} 支撑来源组：${account.attribution.sourceGroups}；同源页面不增加独立性。`}));
    contextLines.push(make('p', {className:'first-step-reason', text:`${account.identity.basisLabel}；${account.defaultSuggestion.reason}`}));
    if(owner?.state==='self_declared')contextLines.push(make('p',{className:'first-step-reason',text:'这是账号或页面的自述；尚未获得独立人物身份验证。'}));
    const originalCount = declarationItems.length + ownerItems.length + supportItems.length + counterItems.length + account.identity.conflicts.length;
    const preview = counterItems.find(item => item.quote) ?? supportItems.find(item => item.quote);
    const ownerPreview = preview ? null : ownerItems.find(item => item.quote);
    if (preview || ownerPreview) {
      const source = preview ?? ownerPreview!;
      const role = ownerPreview ? (ownerPreview.revoked ? '已撤回的姓名自述' : '姓名自述原文') : counterItems.includes(preview!) ? '反证原文' : '归属依据原文';
      evidenceList.appendChild(make('p', {className:'first-step-source-heading',text:`${role} · ${source.sourceTitle}`}));
      const readable = excerptText(source.quote!);
      evidenceList.appendChild(make('blockquote', {className:'first-step-source-preview',text:readable.length > 100 ? `${readable.slice(0,100)}…` : readable}));
    }
    if (originalCount === 0) {
      for (const line of contextLines) evidenceList.appendChild(line);
      evidenceList.appendChild(make('p', { className: 'muted', text: '只有候选线索，没有可展示的原文依据。' }));
    } else {
      const sources = make('div', { className: 'first-step-sources', attrs: { 'data-detail-key': `sources-${account.accountId}`, 'data-open': 'false' } });
      const sourcesToggle = make('button', {
        className: 'first-step-sources-toggle',
        text: `原始出处与完整依据（${String(originalCount)}）`,
        attrs: { type: 'button', 'aria-expanded': 'false', 'data-focus-key': `sources-${account.accountId}` }
      });
      const sourceList = make('div', { className: 'first-step-sources-list', attrs: { hidden: true } });
      for (const line of contextLines) sourceList.appendChild(line);
      for (const declaration of declarationItems) {
        const block=make('div',{className:'first-step-evidence-item'});
        block.append(make('p',{text:'账号自述的网站字段'}),make('p',{text:declaration.rawLiteral}),
          make('small',{className:'first-step-limit',text:declaration.protocol==='https'?'网站字段由该账号自行填写；不代表独立身份核验。':'尚未核对安全 HTTPS 入口；不会自动改写协议或选择网站。'}));
        sourceList.appendChild(block);
      }
      for (const item of ownerItems) {
        const block=make('blockquote');
        block.appendChild(make('p',{text:`${item.sourceTitle} · ${item.revoked?'已撤回的姓名自述':'姓名自述原文'}`}));
        block.appendChild(make('p',{text:item.quote}));
        sourceList.appendChild(block);
      }
      for (const item of supportItems) {
        const block = make('div', { className: 'first-step-evidence-item' });
        block.appendChild(make('p', { text: `${item.sourceTitle}（${item.sourceUrl}）· ${item.role === 'identity_support' ? '归属依据' : '反证' }` }));
        if (item.quote) appendEvidenceQuote(block, item.quote);
        block.appendChild(make('small', { className: 'first-step-limit', text: item.limitation }));
        sourceList.appendChild(block);
      }
      for (const item of counterItems) {
        const block = make('div', { className: 'first-step-evidence-item counter' });
        block.appendChild(make('p', { text: `反证：${item.sourceTitle}（${item.sourceUrl}）` }));
        if (item.quote) appendEvidenceQuote(block, item.quote);
        block.appendChild(make('small', { className: 'first-step-limit', text: item.limitation }));
        sourceList.appendChild(block);
      }
      for (const conflict of account.identity.conflicts) {
        sourceList.appendChild(make('p', { className: 'first-step-limit', text: conflict }));
      }
      sourcesToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const opening = sourceList.hidden;
        sourceList.hidden = !opening;
        sourcesToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
        sources.dataset.open = opening ? 'true' : 'false';
      });
      sources.append(sourcesToggle, sourceList);
      evidenceList.appendChild(sources);
    }
    evidence.appendChild(evidenceList);
    card.appendChild(evidence);

    // Rows are readable/selectable text. Only the dedicated checkbox changes
    // scope; opening evidence and reading/copying a row never select it.
    return card;
  };

  /** GET-213: the person confirmation is its own explicit action. */
  const submitPersonConfirmation = async (): Promise<null> => {
    const current = view!;
    if (!personCandidateId || !current.personOverview?.candidates.some(candidate => candidate.candidateId === personCandidateId)) {
      errorText = '请先选择一个人物候选，再确认。';
      render();
      return null;
    }
    if (!deps.api.confirmPerson) {
      errorText = '当前客户端不支持人物确认，请刷新页面后重试。';
      render();
      return null;
    }
    saving = true;
    errorText = '';
    render();
    const payload: PersonConfirmationPayload = {
      expectedRunRevision: runRevision,
      expectedScopeVersion: current.selection.scopeVersion,
      discoveryRevision: current.discoveryRevision,
      candidateId: personCandidateId
    };
    const intent = JSON.stringify(payload);
    if (submitIntent !== intent) {
      submitIntent = intent;
      submitKey = `person-${deps.runId}-${String(now())}-${String(++idempotencySeq)}`;
    }
    try {
      const result = await deps.api.confirmPerson(deps.runId, payload, submitKey!);
      if (destroyed) return null;
      saving = false;
      status = 'ready';
      if (result.view) applyView(result.view, result.confirmation.runRevision);
      else if (typeof result.confirmation.runRevision === 'number') runRevision = result.confirmation.runRevision;
      render();
      deps.onAfterPersonConfirm?.();
      return null;
    } catch (error) {
      saving = false;
      errorText = error instanceof Error ? error.message : '确认失败，请刷新后重试。';
      render();
      return null;
    }
  };

  const submit = async (): Promise<FirstStepSelectionResponse | null> => {
    if (destroyed || !view || saving) return null;
    if (personStageActive(view)) return submitPersonConfirmation();
    const count = selectedCount();
    if (count === 0) {
      errorText = '请至少选择一个账号后再提交。';
      render();
      return null;
    }
    saving = true;
    errorText = '';
    render();
    // The versions come EXACTLY from the last authoritative GET/view.
    const payload: FirstStepSelectionPayload = {
      expectedRunRevision: runRevision,
      expectedScopeVersion: view.selection.scopeVersion,
      discoveryRevision: view.discoveryRevision,
      clusterId,
      accounts: view.accounts.map((account) => {
        const decision = decisionFor(account);
        return { accountId: account.accountId, selection: decision.selection, excluded: decision.excluded };
      })
    };
    const intent = JSON.stringify(payload);
    if (submitIntent !== intent) {
      submitIntent = intent;
      submitKey = `select-${deps.runId}-${String(now())}-${String(++idempotencySeq)}`;
    }
    try {
      persistDraft();
      const result = await deps.api.submitFirstStepSelection(deps.runId, payload, submitKey!);
      if (destroyed) return null;
      saving = false;
      status = 'submitted';
      if (result.view) applyView(result.view, result.selection.runRevision);
      render();
      deps.onAfterSubmit?.(result);
      return result;
    } catch (error) {
      saving = false;
      errorText = error instanceof Error ? error.message : '提交失败，请刷新后重试。';
      render();
      return null;
    }
  };

  const applyView = (next: FirstStepDiscoveryView, nextRunRevision?: number): void => {
    if (destroyed) return;
    const saved = view === null && !next.selection.submitted ? cache.read(next.caseId, next.selection.scopeVersion) : null;
    if (saved) {
      for (const [id, decision] of saved.decisions) if (next.accounts.some(account => account.accountId === id)) draft.set(id, decision);
      clusterId = next.clusters.some(cluster => cluster.clusterId === saved.clusterId) ? saved.clusterId : null;
      hintDraft = saved.hint; submitKey = saved.submitKey; submitIntent = saved.submitIntent; idempotencySeq = saved.sequence;
    }
    const initialSnapshot = view === null && saved === null;
    const sameView = view !== null && JSON.stringify(view) === JSON.stringify(next) && (nextRunRevision === undefined || nextRunRevision === runRevision);
    const personRevisionChanged = view !== null && (view.discoveryRevision !== next.discoveryRevision ||
      view.inputRevision !== next.inputRevision || view.personOverview?.attemptId !== next.personOverview?.attemptId);
    if (personRevisionChanged || !next.personOverview?.candidates.some(candidate => candidate.candidateId === personCandidateId)) personCandidateId = null;
    view = next;
    if (typeof nextRunRevision === 'number') runRevision = nextRunRevision;
    if (clusterId === null && next.clusters.length === 1 && clusterFitsInput(next.clusters[0]!, next)) clusterId = next.clusters[0]!.clusterId;
    if (clusterId === null && initialSnapshot) {
      const linked = next.clusters.filter(cluster => cluster.linkage === 'linked' && cluster.conflicts.length === 0 && clusterFitsInput(cluster, next));
      if (linked.length === 1) clusterId = linked[0]!.clusterId;
    }
    // The draft survives every server push: existing decisions are never
    // overwritten and NEW accounts start unchecked regardless of suggestions.
    for (const account of next.accounts) {
      if (!draft.has(account.accountId)) {
        const belongs = next.clusters.find(c => c.clusterId === clusterId)?.accountIds.includes(account.accountId) ?? false;
        const suggested = initialSnapshot && belongs && account.defaultSuggestion.suggested && account.identity.state === 'supported' && !account.requiresIndependentScope;
        const persisted = next.selection.submitted && next.selection.selectedAccountIds.includes(account.accountId);
        draft.set(account.accountId, { selection: persisted ? (account.userSelection.state === 'only_this_account' ? 'only_this_account' : 'selected') : suggested ? 'selected' : 'unanswered', excluded: next.selection.excludedAccountIds.includes(account.accountId) });
      }
    }
    // A single source-backed candidate may be preselected as a VISUAL default;
    // the explicit confirm click is still the only user intent.
    if (personCandidateId === null && next.personOverview?.candidates.length === 1) {
      personCandidateId = next.personOverview.candidates[0]!.candidateId;
    }
    status = 'ready';
    if (!sameView) render();
  };

  const renderLegacy = (response: FirstStepDiscoveryResponse): void => {
    if (destroyed) return;
    if (deps.footerContainer) clear(deps.footerContainer);
    clear(deps.container);
    deps.container.className = 'first-step legacy';
    deps.container.appendChild(make('h3', { text: '先确认你想了解的人' }));
    if (response.prompt) deps.container.appendChild(make('p', { text: response.prompt }));
    for (const candidate of response.candidates ?? []) {
      deps.container.appendChild(
        make('div', {
          className: 'identity-candidate',
          children: [make('strong', { text: candidate.label }), make('p', { text: candidate.detail })]
        })
      );
    }
    deps.container.appendChild(make('p', {className:'muted', text:'保留原有记录，继续查找个人网站、作品、社交与其它公开平台。'}));
    const action = make('button', {className:'button primary', text:'继续发现这个人的公开账号', attrs:{type:'button'}, on:{click:()=>{
      if (expanding) return;
      expanding = true; action.disabled = true; action.textContent = '正在启动发现…';
      void deps.api.expandFirstStep(deps.runId, {}, `legacy-expand-${String(now())}-${String(++idempotencySeq)}`).then(()=>{
        if (!destroyed) deps.onAfterExpand?.();
      }).catch(error=>{
        if (destroyed) return;
        const message = make('p',{className:'error-text',text:error instanceof Error ? error.message : '启动失败，请重试。',attrs:{role:'alert'}});
        deps.container.appendChild(message);
      }).finally(()=>{expanding=false;action.disabled=false;action.textContent='继续发现这个人的公开账号';});
    }}});
    if (response.canExpand) deps.container.appendChild(action);
  };

  return {
    async refresh() {
      if (destroyed) return;
      try {
        const response = await deps.api.getFirstStepDiscovery(deps.runId);
        if (destroyed) return;
        if (response.mode === 'legacy') {
          renderLegacy(response);
          return;
        }
        if (response.view) {
          applyView(response.view, response.runRevision);
        }
      } catch (error) {
        status = error instanceof Error ? error.message : '读取发现结果失败。';
        render();
      }
    },
    applyView,
    renderLegacy,
    draft: () => draft,
    selectedCount,
    submit,
    async expand(hint: string) {
      if (destroyed) return;
      await deps.api.expandFirstStep(deps.runId, { hint }, `expand-${String(now())}-${String(++idempotencySeq)}`);
    },
    destroy() {
      persistDraft();
      destroyed = true;
      openEvidence?.close();
      clear(deps.container);
      // The dedicated actions host is panel-owned: a run switch, destroy or
      // logout must never leave stale selection/error controls behind.
      if (deps.footerContainer) clear(deps.footerContainer);
      draft.clear(); view = null; hintDraft = '';
    },
    statusText() {
      return status;
    }
  };
}

export type { FirstStepPersonClusterView };
