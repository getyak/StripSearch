import { readableSourceText } from './source-text.js';
/**
 * First-step controlled renderer (2026-10-05 design): evidence-aware person
 * clusters, per-account research cards and ONE atomic scope confirmation.
 *
 * Real state only ever comes from the server projection (`GET
 * /api/runs/:id/first-step/discovery`); the local draft (checkboxes,
 * independent scopes, exclusion statements) is user input that SSE/refresh
 * updates NEVER overwrite. Suggestions are visual defaults only: a fresh
 * account is never auto-checked after the user started editing, and unchecking
 * is never an exclusion.
 */

import { clear, make } from './dom.js';
import { firstStepDraftCache } from './first-step-draft-storage.js';
import type {
  FirstStepDiscoveryResponse,
  FirstStepSelectionPayload,
  FirstStepSelectionResponse
} from './api.js';
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
   * there so it stays reachable with many cards or expanded evidence. Other
   * callers keep the in-panel footer unchanged.
   */
  footerContainer?: HTMLElement;
  /** Owner isolates optional local input drafts; the server remains authority. */
  ownerId?: string;
  /** Called after a successful submit so the host can refresh the run view. */
  onAfterSubmit?: (result: FirstStepSelectionResponse) => void;
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

const STATE_LABELS: Record<string, string> = {
  supported: '原文支持账号关联',
  proposed: '可能相关',
  disputed: '存在冲突',
  rejected: '已被否定',
  revoked: '依据已撤回'
};

function shortUrl(url: string | null): string {
  if (!url) return '';
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/** Presentation-only excerpt; retained evidence below keeps the exact original. */
const excerptText=readableSourceText;

/** Readable presentation plus an inspectable immutable literal excerpt. */
function appendEvidenceQuote(container:HTMLElement,quote:string):void {
 container.appendChild(make('blockquote',{text:excerptText(quote)}));
 if (/<[^>]*>|&(?:[a-z]+|#x?[0-9a-f]+);/i.test(quote)) {
  const original=make('details',{className:'first-step-original'});
  original.appendChild(make('summary',{text:'查看原始摘录（含标记）'}));
  original.appendChild(make('pre',{text:quote}));container.appendChild(original);
 }
}

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
  let idempotencySeq = 0;
  const now = deps.now ?? ((): number => Date.now());
  let openEvidence: { close: () => void } | null = null;

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

  /** Supplied Figma platform assets (emblem 18px / watermark 128px slots). */
  const PLATFORM_ICONS: Readonly<Record<string, string>> = { github: 'github', x: 'x', youtube: 'youtube', bilibili: 'bilibili' };
  const PLATFORM_WATERMARKS: Readonly<Record<string, string>> = { github: 'github', x: 'x', personal_site: 'website', youtube: 'youtube', bilibili: 'bilibili', linkedin: 'linkedin' };

  const monogramOf = (name: string): string => ([...name.trim()][0] ?? '·').toLocaleUpperCase();

  const render = (): void => {
    if (destroyed) return;
    const root = deps.container;
    const footerHost = deps.footerContainer ?? null;
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const inPanel = (node: Node | null): boolean => Boolean(node && (root.contains(node) || footerHost?.contains(node)));
    const focusKey = active && inPanel(active) ? active.dataset.focusKey : null;
    const focusables = (): HTMLElement[] => [
      ...root.querySelectorAll<HTMLElement>('[data-focus-key]'),
      ...(footerHost ? [...footerHost.querySelectorAll<HTMLElement>('[data-focus-key]')] : [])
    ];
    const scroller = root.closest<HTMLElement>('.work-body');
    const scrollTop = scroller?.scrollTop;
    const openKeys = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(el => el.dataset.detailKey));
    const previousHint = root.querySelector<HTMLInputElement>('[data-focus-key="hint"]');
    if (previousHint) hintDraft = previousHint.value;
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
      make('h2', {text: clusterId === null && view.clusters.length > 1 ? '先确认目标人物' : '选择要了解的公开账号'}),
      make('p', {text: clusterId === null && view.clusters.length > 1 ? '先核对人物，再决定本轮研究哪些公开账号。' : '核对归属与出处，选择本轮研究范围。'}));
    root.appendChild(intro);

    // Person choice (left) and account choice (right) in one workspace.
    const workspace = make('section', { className: 'first-step-workspace' });
    const peopleBox = make('section', { className: 'first-step-clusters', attrs: { 'aria-label': '目标人物候选', 'data-single': view.clusters.length === 1 ? 'true' : 'false' } });
    peopleBox.appendChild(make('h3', { text: '确认目标人物' }));
    const linkedChoices = view.clusters.filter(cluster => cluster.linkage === 'linked' && cluster.conflicts.length === 0 && clusterFitsInput(cluster, view!));
    const recommendedOnly = linkedChoices.length === 1 && clusterId === linkedChoices[0]!.clusterId;
    const matchingClusters = view.clusters.filter(cluster => clusterFitsInput(cluster, view!));
    const prominentCandidates = matchingClusters.length > 0 ? matchingClusters : view.clusters;
    const prominentIds = new Set(recommendedOnly ? [clusterId] : [clusterId, ...prominentCandidates.filter(cluster => cluster.clusterId !== clusterId).slice(0, clusterId ? 2 : 3).map(cluster => cluster.clusterId)]);
    const otherCount = view.clusters.filter(cluster => !prominentIds.has(cluster.clusterId)).length;
    const others = make('details', {className:'first-step-other-people', attrs:{'data-detail-key':'other-people'}});
    others.appendChild(make('summary', {text:`其它人物或主页线索（${String(otherCount)}）`}));
    peopleBox.dataset.single = recommendedOnly || view.clusters.length === 1 ? 'true' : 'false';
    peopleBox.dataset.compact = clusterId !== null ? 'true' : 'false';
    if (recommendedOnly&&otherCount>0) peopleBox.appendChild(make('p',{className:'muted',text:'建议目标 · 可展开其它候选更换；点击继续才会提交。'}));
    for (const cluster of view.clusters) {
      const destination = prominentIds.has(cluster.clusterId) ? peopleBox : others;
      const chosen = clusterId === cluster.clusterId;
      const compact = recommendedOnly && chosen;
      const chooseCandidate = (): void => {
        clusterId = cluster.clusterId;
        // Changing the person cannot grant reading a different person's accounts.
        let removed = 0;
        for (const [id, decision] of draft) {
          if (decision.selection === 'selected' && !cluster.accountIds.includes(id)) { decision.selection = 'not_selected'; removed++; }
        }
        selectionNotice = removed > 0 ? `已更换目标，移除 ${String(removed)} 个不属于此分组的账号选择。独立账号范围仍保留。` : '';
        render();
      };
      // ONE compact card per competing candidate: the choice button and its
      // expandable provenance share a single frame — never a double border box.
      const candidate = make('article', {
        className: `first-step-candidate${chosen ? ' chosen' : ''}`,
        attrs: { 'aria-label': `${cluster.displayName} · 人物候选` }
      });
      const button = make('button', {
        className: `first-step-cluster${chosen ? ' chosen' : ''}`,
        attrs: { type: 'button', 'aria-pressed': chosen ? 'true' : 'false', 'data-focus-key': `cluster-${cluster.clusterId}` },
        on: { click: chooseCandidate }
      });
      const titles = make('div', { className: 'first-step-cluster-titles' });
      if (chosen) {
        // Person reference (runtime carries no verified avatar URL): a paper
        // monogram block with an honest "头像尚未取得" note — never a photo.
        const reference = make('div', { className: 'first-step-person-ref' });
        reference.appendChild(make('div', { className: 'first-step-person-image', attrs: { 'aria-hidden': 'true' }, children: [make('span', { text: monogramOf(cluster.displayName) })] }));
        reference.appendChild(make('p', { className: 'first-step-person-caption', text: `人物参照 · ${shortUrl(cluster.anchorUrl) || cluster.anchorLabel}` }));
        titles.appendChild(reference);
      }
      titles.appendChild(make('strong', { text: cluster.displayName }));
      titles.appendChild(make('span', { className: 'first-step-choice-tag', text: chosen ? '已选择为目标' : '选择此候选' }));
      titles.appendChild(make('span', { className: 'first-step-cluster-anchor', text: shortUrl(cluster.anchorUrl) || cluster.anchorLabel }));
      titles.appendChild(
        make('span', {
          className: `first-step-cluster-linkage${cluster.linkage === 'unconfirmed' ? ' uncertain' : ''}`,
          text: cluster.linkage === 'unconfirmed' ? '未确认候选 · 同名不合并' : '有公开原文链接依据'
        })
      );
      button.appendChild(titles);
      // Grounded concise descriptor: plain statement text with its real source
      // label — never a raw URL dump, and never discarded just because the
      // source URL exists beside the summary.
      // Prefer the longest readable author excerpt already backed by a source;
      // keep full linkage evidence in the adjacent inspector.
      const previewLead = [...cluster.leads].filter(lead => lead.quote).sort((a,b)=>Number(/\bI (?:create|build|write|research|teach|lead|founded)\b/i.test(excerptText(b.quote!)))*1000+Math.min(excerptText(b.quote!).length,240)-Number(/\bI (?:create|build|write|research|teach|lead|founded)\b/i.test(excerptText(a.quote!)))*1000-Math.min(excerptText(a.quote!).length,240))[0];
      const excerpt = previewLead?.quote ?? cluster.anchorBasis?.quote;
      const excerptSource = previewLead?.sourceUrl ?? cluster.anchorBasis?.sourceUrl;
      if (excerpt) {
        const previewLength = chosen && !compact ? 120 : 80;
        button.appendChild(make('small', { className: 'first-step-lead', text: `原文摘录：“${excerptText(excerpt).slice(0,previewLength)}${excerptText(excerpt).length>previewLength?'…':''}”` }));
        if (excerptSource && (!compact || shortUrl(excerptSource) !== shortUrl(cluster.anchorUrl))) button.appendChild(make('small', { className: 'first-step-lead-source', text: `来源：${shortUrl(excerptSource)}` }));
      }
      if (cluster.conflicts.length > 0) {
        button.appendChild(make('small', { className: 'first-step-conflict', text: cluster.conflicts.join('；') }));
      }
      candidate.appendChild(button);
      // Inspectable linkage basis and descriptor sources: exact spans of the
      // retained originals, rendered as escaped plain text (source HTML never
      // executes) while the original stays inspectable.
      const basis = make('details', { className: 'first-step-cluster-basis', attrs: { 'data-detail-key': `basis-${cluster.clusterId}` } });
      basis.appendChild(make('summary', { text: `辨识依据与出处（${cluster.displayName}）`, attrs: { 'data-focus-key': `basis-${cluster.clusterId}` } }));
      const basisList = make('div', {});
      if (cluster.anchorBasis) {
        const block = make('div', { className: 'first-step-evidence-item' });
        block.appendChild(make('p', { text: `${cluster.anchorBasis.label}（${shortUrl(cluster.anchorBasis.sourceUrl)}）` }));
        if (cluster.anchorBasis.quote) appendEvidenceQuote(block, cluster.anchorBasis.quote);
        basisList.appendChild(block);
      }
      for (const lead of cluster.leads) {
        const block = make('div', { className: 'first-step-evidence-item' });
        block.appendChild(make('p', { text: `${lead.statement}（来源：${shortUrl(lead.sourceUrl ?? null)}）` }));
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
        const target = event.target as HTMLElement | null;
        if (target && target.closest('button, a, input, summary, details, label')) return;
        chooseCandidate();
      });
      destination.appendChild(candidate);
    }
    if (otherCount > 0) peopleBox.appendChild(others);
    if (view.clusters.length === 0) {
      peopleBox.appendChild(make('p', { className: 'muted', text: '暂未辨识出可确认的人物；可以补充一个公开主页或区分线索。' }));
    }
    workspace.appendChild(peopleBox);

    // Account cards: the chosen person's accounts are the main choices;
    // unconfirmed/unrelated leads live in a clearly labeled COLLAPSED secondary
    // area. Nothing here ever widens the submitted scope automatically.
    const chosen = clusterId === null ? null : (view.clusters.find((item) => item.clusterId === clusterId) ?? null);
    const personal = (account:FirstStepAccountView):boolean => account.accountKind!=='organization' && account.category!=='organization';
    const inMain = (account: FirstStepAccountView): boolean => personal(account) && (chosen !== null
        ? chosen.accountIds.includes(account.accountId)
        : account.identity.state === 'supported' || account.defaultSuggestion.suggested);
    const mainAccounts = view.accounts.filter(inMain);
    workspace.dataset.choosingPerson = chosen === null && view.clusters.length > 0 && mainAccounts.length === 0 ? 'true' : 'false';
    const otherLinkedAccounts = chosen === null ? [] : view.accounts.filter(account => personal(account) && !inMain(account) && account.identity.state === 'supported' && !account.requiresIndependentScope);
    const otherLinkedIds = new Set(otherLinkedAccounts.map(account => account.accountId));
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
    const cardsBox = make('section', { className: 'first-step-accounts', attrs: { 'aria-label': '选择研究账号' } });
    cardsBox.appendChild(make('h3', { className: chosen ? 'sr-only' : '', text: '选择研究账号' }));
    if (mainAccounts.length === 0 && view.clusters.length > 0) {
      cardsBox.appendChild(make('p', { className: 'muted', text: '请先确认目标人物；这个人的公开账号会显示在这里。' }));
    }
    cardsBox.appendChild(renderGroups(mainAccounts));
    if(organizationAccounts.length){
      const organizations=make('details',{className:'first-step-related',attrs:{'data-detail-key':'organizations'}});
      organizations.append(make('summary',{text:`组织与第三方 · ${organizationAccounts.length} 个入口`}),make('p',{className:'muted',text:'与人物有关的组织可以提供背景；其账号和成果不作为本人账号或个人贡献。'}),renderGroups(organizationAccounts));
      cardsBox.appendChild(organizations);
    }
    if (otherLinkedAccounts.length > 0) {
      const separate = make('section', {className:'first-step-other-linked',attrs:{'aria-label':'其它分组的账号，单独研究'}});
      separate.append(make('h3',{text:`其它分组的账号 · 单独研究（${String(otherLinkedAccounts.length)}）`}),make('p',{className:'muted',text:'这些账号已有原文链接依据，但尚未关联到所选人物分组。默认不选；勾选后仅研究该账号，不并入此人的身份结论。'}),renderGroups(otherLinkedAccounts));
      cardsBox.appendChild(separate);
    }
    if(linkedLeads.length>0){
      const linked=make('section',{className:'first-step-profile-links first-step-name-matches',attrs:{'aria-label':'该主页发现的账号，归属待核对'}});
      linked.append(make('h3',{text:`该主页发现的账号 · 归属待核对（${String(linkedLeads.length)}）`}),make('p',{className:'muted',text:'这些账号入口出现在已读主页的外链中，链接本身不能证明归属。默认不选；勾选后仅研究该账号，不并入人物身份结论。'}),renderGroups(linkedLeads));
      cardsBox.appendChild(linked);
    }
    if (namedAccounts.length>0) {
      const named=make('section',{className:'first-step-name-matches',attrs:{'aria-label':'同名公开主页，分别核对'}});
      named.append(make('h3',{text:`同名公开主页 · 分别核对（${String(namedAccounts.length)}）`}),make('p',{className:'muted',text:'这些主页的实际标题也匹配你输入的姓名，可能属于同名的人。默认不选；勾选后仅以独立账号范围研究，不并入此人的身份结论。'}),renderGroups(namedAccounts,namedLabels));
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
      secondary.appendChild(renderGroups(secondaryAccounts));
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
      cardsBox.appendChild(secondary);
    }
    workspace.appendChild(cardsBox);
    root.appendChild(workspace);

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
      if (openKeys.has(details.dataset.detailKey)) details.open = true;
    }
    if (focusKey) {
      const replacement = focusables().find(el => el.dataset.focusKey === focusKey);
      replacement?.focus({preventScroll:true});
    }
    if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
  };

  /** Compact categorized card groups: a presentation window, never a 90-card wall. */
  const renderGroups = (accounts: FirstStepAccountView[], labels?:ReadonlyMap<string,string>): HTMLElement => {
    const wrap = make('div', { className: 'first-step-groups' });
    for (const category of CATEGORY_ORDER) {
      const groupAccounts = accounts.filter((account) => account.category === category);
      if (groupAccounts.length === 0) continue;
      const group = make('div', { className: 'first-step-group' });
      group.appendChild(make('h3', { text: `${CATEGORY_LABELS[category]}（${String(groupAccounts.length)}）` }));
      const cards = make('div', { className: 'first-step-cards' });
      for (const account of groupAccounts.slice(0, 6)) cards.appendChild(renderCard(account,labels?.get(account.accountId)));
      group.appendChild(cards);
      if (groupAccounts.length > 6) {
        const more = make('details', { className: 'first-step-more', attrs: { 'data-detail-key': `more-${category}` } });
        more.appendChild(make('summary', { text: `展开其余 ${String(groupAccounts.length - 6)} 个` }));
        const extraCards = make('div', { className: 'first-step-cards' });
        for (const account of groupAccounts.slice(6)) extraCards.appendChild(renderCard(account,labels?.get(account.accountId)));
        more.appendChild(extraCards);
        group.appendChild(more);
      }
      wrap.appendChild(group);
    }
    return wrap;
  };

  const renderCard = (account: FirstStepAccountView, matchedTitle?:string): HTMLElement => {
    const decision = decisionFor(account);
    const repeatedHandle=view?.accounts.some(other=>other.accountId!==account.accountId&&other.platform===account.platform&&other.handle===account.handle);
    const accountLabel=account.handle&&account.handle!==shortUrl(account.profileUrl)?`@${account.handle}${account.platform==='mastodon'||repeatedHandle?` · ${account.instance??(account.profileUrl?new URL(account.profileUrl).host:'')}`:''}`:shortUrl(account.profileUrl);
    const personCluster=view?.clusters.find(cluster => cluster.clusterId === clusterId);
    const ownAnchor=personCluster?.anchorAccountId===account.accountId || !personCluster?.anchorAccountId&&personCluster?.anchorUrl===account.profileUrl;
    const mayJoinPerson=Boolean(personCluster?.accountIds.includes(account.accountId))&&validateSelectionDecision(account,{accountId:account.accountId,selection:'selected',excluded:false},{anchorAccountIds:ownAnchor?new Set([account.accountId]):new Set()}).ok;
    const requiresIndependentScope = account.accountKind==='organization' || !mayJoinPerson;
    const checked = decision.selection === 'selected' || decision.selection === 'only_this_account';
    const iconKey = PLATFORM_ICONS[account.platform];
    const watermarkKey = PLATFORM_WATERMARKS[account.platform];
    const card = make('article', {
      className: `first-step-card${checked ? ' checked' : ''}${decision.excluded ? ' excluded' : ''}`,
      attrs: { 'data-platform': account.platform }
    });
    const applyChecked = (next: boolean): void => {
      if (decision.excluded) return;
      if (next) {
        decision.selection = requiresIndependentScope ? 'only_this_account' : 'selected';
      } else {
        decision.selection = 'not_selected';
      }
      render();
    };
    const toggle = (): void => applyChecked(!checked);
    // Card head: 64px paper monogram avatar (runtime has no verified avatar
    // URL — an honest "头像尚未取得" note, never a fabricated identity photo),
    // platform emblem or external-link mark and the account name.
    const head = make('div', { className: 'first-step-card-head' });
    head.appendChild(make('div', { className: 'first-step-avatar', attrs: { 'aria-hidden': 'true' }, children: [make('span', { text: monogramOf(account.displayName || account.handle || account.platformLabel) })] }));
    const titles = make('div', { className: 'first-step-card-titles' });
    const platformLine = make('p', { className: 'first-step-platform' });
    if (iconKey) {
      platformLine.appendChild(make('span', { className: `first-step-platform-icon icon-${iconKey}`, attrs: { 'aria-hidden': 'true' } }));
    } else if (account.platform === 'personal_site') {
      platformLine.appendChild(make('span', { className: 'first-step-platform-icon icon-link', text: '↗', attrs: { 'aria-hidden': 'true' } }));
    }
    platformLine.appendChild(make('span', { text: account.platformLabel }));
    titles.append(
      platformLine,
      make('p', { className: 'first-step-name', text: account.displayName || account.handle || accountLabel }),
      make('p', { className: 'first-step-avatar-note', text: '头像尚未取得' })
    );
    head.appendChild(titles);
    card.appendChild(head);
    if (watermarkKey) card.appendChild(make('span', { className: `first-step-watermark wm-${watermarkKey}`, attrs: { 'aria-hidden': 'true' } }));
    card.appendChild(make('p', { className: 'first-step-handle', text: accountLabel }));
    if(matchedTitle)card.appendChild(make('p',{className:'first-step-value',text:`匹配的主页标题：${matchedTitle}；归属未确认。`}));
    card.appendChild(make('p', { className: 'first-step-value', text: account.researchSummary }));

    // Attribution row: quiet compact state tag plus the grounded reason; the
    // full basis, quotes and counterevidence stay in the card disclosure.
    const attribution = make('p', { className: 'first-step-attribution' });
    attribution.appendChild(make('span', {
      className: `first-step-badge${account.identity.state === 'supported' && account.identity.validity !== 'review' ? '' : ' uncertain'}`,
      text: account.accountKind==='organization'?'组织账号':account.identity.validity === 'review' ? '原归属依据已失效' : STATE_LABELS[account.identity.state] ?? account.identity.state
    }));
    if(account.identity.ownerAnchor){
      const owner=account.identity.ownerAnchor;
      attribution.appendChild(make('span', {className:'first-step-reason',text:account.identity.ownerValidity==='review'?'姓名归属依据已失效，请核对原文':owner.state==='self_declared'?'账号自述姓名一致 · 尚未独立验证':owner.state==='unbound'?'姓名归属尚未核对':owner.state==='independently_supported'?'姓名归属有独立支持':'姓名归属存在冲突，请核对'}));
    } else if (account.attribution) {
      attribution.appendChild(make('span', {className:'first-step-reason',text:account.attribution.reason}));
    }
    card.appendChild(attribution);
    if(requiresIndependentScope)card.appendChild(make('p',{className:'first-step-boundary',text:view?.selection.submitted?'范围已提交 · 单独研究，不并入人物结论。':'单独研究，不并入人物结论。'}));

    // Bottom row: independent selection at bottom-left, inline provenance
    // disclosure at bottom-right — the disclosure lives INSIDE its card.
    const bottom = make('div', { className: 'first-step-card-bottom' });
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
    bottom.appendChild(label);

    // Evidence panel: source title/URL, exact span, role and limitation.
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
    // Keyboard: Esc closes the evidence panel and returns to its trigger.
    evidence.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Escape' && evidence.open) {
        event.stopPropagation();
        evidence.open = false;
        summary.focus();
      }
    });
    const evidenceList = make('div', {});
    evidenceList.appendChild(make('p',{className:'first-step-reason',text:`读取情况：${account.accessLabel}`}));
    if(account.attribution) evidenceList.appendChild(make('p',{className:'first-step-reason',text:`${account.attribution.reason} 支撑来源组：${account.attribution.sourceGroups}；同源页面不增加独立性。`}));
    evidenceList.appendChild(make('p', {className:'first-step-reason', text:`${account.identity.basisLabel}；${account.defaultSuggestion.reason}`}));
    const owner=account.identity.ownerAnchor;
    if(owner){
      const labels={unbound:'姓名归属尚未核对',self_declared:'账号自述姓名与查询一致',independently_supported:'姓名归属有独立支持',disputed:'姓名归属存在冲突',contradicted:'姓名归属受到否认'};
      evidenceList.appendChild(make('p',{className:'first-step-reason',text:account.identity.ownerValidity==='review'?'姓名归属依据需重新核对':labels[owner.state]}));
      if(owner.state==='self_declared')evidenceList.appendChild(make('p',{className:'first-step-reason',text:'这是账号或页面的自述；尚未获得独立人物身份验证。'}));
      for(const evidence of account.identity.ownerEvidence??[]){
        const block=make('blockquote');
        block.appendChild(make('p',{text:`${evidence.sourceTitle} · ${evidence.revoked?'已撤回的姓名自述':'姓名自述原文'}`}));
        block.appendChild(make('p',{text:evidence.quote}));
        evidenceList.appendChild(block);
      }
    }
    for (const declaration of account.nativeWebsiteDeclarations ?? []) {
      const block=make('div',{className:'first-step-evidence-item'});
      block.append(make('p',{text:'账号自述的网站字段'}),make('p',{text:declaration.rawLiteral}),
        make('small',{className:'first-step-limit',text:declaration.protocol==='https'?'网站字段由该账号自行填写；不代表独立身份核验。':'尚未核对安全 HTTPS 入口；不会自动改写协议或选择网站。'}));
      evidenceList.appendChild(block);
    }
    for (const item of account.identity.evidence) {
      const block = make('div', { className: 'first-step-evidence-item' });
      block.appendChild(make('p', { text: `${item.sourceTitle}（${shortUrl(item.sourceUrl)}）· ${item.role === 'identity_support' ? '归属依据' : '反证' }` }));
      if (item.quote) appendEvidenceQuote(block, item.quote);
      block.appendChild(make('small', { className: 'first-step-limit', text: item.limitation }));
      evidenceList.appendChild(block);
    }
    for (const item of account.identity.counterevidence) {
      const block = make('div', { className: 'first-step-evidence-item counter' });
      block.appendChild(make('p', { text: `反证：${item.sourceTitle}（${shortUrl(item.sourceUrl)}）` }));
      if (item.quote) appendEvidenceQuote(block, item.quote);
      block.appendChild(make('small', { className: 'first-step-limit', text: item.limitation }));
      evidenceList.appendChild(block);
    }
    for (const conflict of account.identity.conflicts) {
      evidenceList.appendChild(make('p', { className: 'first-step-limit', text: conflict }));
    }
    if (account.identity.evidence.length === 0 && account.identity.counterevidence.length === 0) {
      evidenceList.appendChild(make('p', { className: 'muted', text: '只有候选线索，没有可展示的原文依据。' }));
    }
    evidence.appendChild(evidenceList);
    bottom.appendChild(evidence);
    card.appendChild(bottom);

    // Card-level statements stay explicit buttons, never implied by the checkbox.
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
      if (requiresIndependentScope && !decision.excluded) {
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
    if (actions.children.length > 0) card.appendChild(actions);

    // Card-level click toggles the checkbox, but never on interactive parts.
    card.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest('button, a, input, summary, details, label')) return;
      toggle();
    });
    return card;
  };

  const submit = async (): Promise<FirstStepSelectionResponse | null> => {
    if (destroyed || !view || saving) return null;
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
