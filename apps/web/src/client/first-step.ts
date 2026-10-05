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
  supported: '有归属依据',
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

  const render = (): void => {
    if (destroyed) return;
    const root = deps.container;
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = active && root.contains(active) ? active.dataset.focusKey : null;
    const scroller = root.closest<HTMLElement>('.work-body');
    const scrollTop = scroller?.scrollTop;
    const openKeys = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(el => el.dataset.detailKey));
    const previousHint = root.querySelector<HTMLInputElement>('[data-focus-key="hint"]');
    if (previousHint) hintDraft = previousHint.value;
    persistDraft();
    clear(root);
    root.className = 'first-step';
    if (!view) {
      root.appendChild(make('p', { className: 'first-step-status', text: status === 'loading' ? '正在读取发现结果…' : status }));
      return;
    }
    const intro = make('header', { className: 'first-step-intro' });
    intro.append(make('p', {className:'first-step-eyebrow', text:'01 确认目标   ·   02 深入研究   ·   03 整理报告'}),
      make('h2', {text:'先认识这个人，再选研究范围'}),
      make('p', {text:'核对人物与公开账号。确认后，我们只深入读取你选择的范围。'}));
    root.appendChild(intro);
    // Person cluster choice.
    const clusterBox = make('section', { className: 'first-step-clusters', attrs: { 'aria-label': '人物候选', 'data-single':view.clusters.length === 1 ? 'true' : 'false' } });
    clusterBox.appendChild(make('h3', { text: '确认目标人物' }));
    const linkedChoices = view.clusters.filter(cluster => cluster.linkage === 'linked' && cluster.conflicts.length === 0 && clusterFitsInput(cluster, view!));
    const recommendedOnly = linkedChoices.length === 1 && clusterId === linkedChoices[0]!.clusterId;
    const matchingClusters = view.clusters.filter(cluster => clusterFitsInput(cluster, view!));
    const prominentCandidates = matchingClusters.length > 0 ? matchingClusters : view.clusters;
    const prominentIds = new Set(recommendedOnly ? [clusterId] : [clusterId, ...prominentCandidates.filter(cluster => cluster.clusterId !== clusterId).slice(0, clusterId ? 2 : 3).map(cluster => cluster.clusterId)]);
    const otherCount = view.clusters.filter(cluster => !prominentIds.has(cluster.clusterId)).length;
    const others = make('details', {className:'first-step-other-people', attrs:{'data-detail-key':'other-people'}});
    others.appendChild(make('summary', {text:`其它人物或主页线索（${String(otherCount)}）`}));
    clusterBox.dataset.single = recommendedOnly || view.clusters.length === 1 ? 'true' : 'false';
    if (recommendedOnly) clusterBox.appendChild(make('p',{className:'muted',text:'建议目标 · 可展开其它候选更换；点击继续才会提交。'}));
    for (const cluster of view.clusters) {
      const destination = prominentIds.has(cluster.clusterId) ? clusterBox : others;
      const chosen = clusterId === cluster.clusterId;
      const button = make('button', {
        className: `first-step-cluster${chosen ? ' chosen' : ''}`,
        attrs: { type: 'button', 'aria-pressed': chosen ? 'true' : 'false', 'data-focus-key': `cluster-${cluster.clusterId}` },
        on: {
          click: () => {
            clusterId = cluster.clusterId;
            // Changing the person cannot grant reading a different person's accounts.
            for (const [id, decision] of draft) {
              if (decision.selection === 'selected' && !cluster.accountIds.includes(id)) decision.selection = 'not_selected';
            }
            render();
          }
        }
      });
      button.append(
        make('strong', { text: cluster.displayName }),
        make('span', { className: 'first-step-cluster-anchor', text: shortUrl(cluster.anchorUrl) || cluster.anchorLabel }),
        make('span', {
          className: `first-step-cluster-linkage${cluster.linkage === 'unconfirmed' ? ' uncertain' : ''}`,
          text: cluster.linkage === 'unconfirmed' ? '未确认候选 · 同名不合并' : '有公开原文链接依据'
        })
      );
      // Grounded concise descriptor: plain statement text with its real source
      // label — never a raw URL dump, and never discarded just because the
      // source URL exists beside the summary.
      // Prefer the longest readable author excerpt already backed by a source;
      // keep full linkage evidence in the adjacent inspector.
      const previewLead = [...cluster.leads].filter(lead => lead.quote).sort((a,b)=>Number(/\bI (?:create|build|write|research|teach|lead|founded)\b/i.test(excerptText(b.quote!)))*1000+Math.min(excerptText(b.quote!).length,240)-Number(/\bI (?:create|build|write|research|teach|lead|founded)\b/i.test(excerptText(a.quote!)))*1000-Math.min(excerptText(a.quote!).length,240))[0];
      const excerpt = previewLead?.quote ?? cluster.anchorBasis?.quote;
      const excerptSource = previewLead?.sourceUrl ?? cluster.anchorBasis?.sourceUrl;
      if (excerpt) {
        button.appendChild(make('small', { className: 'first-step-lead', text: `原文摘录：“${excerptText(excerpt).slice(0,180)}${excerptText(excerpt).length>180?'…':''}”` }));
        if (excerptSource) button.appendChild(make('small', { className: 'first-step-lead-source', text: `来源：${shortUrl(excerptSource)}` }));
      }
      if (cluster.conflicts.length > 0) {
        button.appendChild(make('small', { className: 'first-step-conflict', text: cluster.conflicts.join('；') }));
      }
      destination.appendChild(button);
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
      destination.appendChild(basis);
    }
    if (otherCount > 0) clusterBox.appendChild(others);
    if (view.clusters.length === 0) {
      clusterBox.appendChild(make('p', { className: 'muted', text: '暂未辨识出可确认的人物；可以补充一个公开主页或区分线索。' }));
    }
    root.appendChild(clusterBox);

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

    // Account cards: the chosen person's accounts are the main choices;
    // unconfirmed/unrelated leads live in a clearly labeled COLLAPSED secondary
    // area. Nothing here ever widens the submitted scope automatically.
    const chosen = clusterId === null ? null : (view.clusters.find((item) => item.clusterId === clusterId) ?? null);
    const inMain = (account: FirstStepAccountView): boolean =>
      chosen !== null
        ? chosen.accountIds.includes(account.accountId)
        : account.identity.state === 'supported' || account.defaultSuggestion.suggested;
    const mainAccounts = view.accounts.filter(inMain);
    const namedLabels = new Map<string,string>();
    if (chosen && view.input.kind === 'name_query') {
      for (const cluster of matchingClusters) {
        if (cluster.clusterId === chosen.clusterId) continue;
        for (const id of cluster.accountIds) namedLabels.set(id,cluster.displayName);
      }
    }
    // Actual name-matching titles help people inspect other public profiles;
    // they never prove that these profiles belong to the chosen person.
    const namedAccounts=view.accounts.filter(account=>!inMain(account)&&namedLabels.has(account.accountId)&&account.requiresIndependentScope&&account.identity.state!=='rejected'&&account.identity.counterevidence.length===0);
    const namedIds=new Set(namedAccounts.map(account=>account.accountId));
    const linkedLeads=view.accounts.filter(account=>!inMain(account)&&!namedIds.has(account.accountId)&&account.requiresIndependentScope&&account.identity.state!=='rejected'&&!account.identity.nativeIdConflict&&account.identity.counterevidence.length===0&&
      chosen!==null&&(account.profileLinkSources??[]).some(source=>chosen.accountIds.includes(source.accountId)));
    const linkedLeadIds=new Set(linkedLeads.map(account=>account.accountId));
    const secondaryAccounts = view.accounts.filter((account) => !inMain(account)&&!namedIds.has(account.accountId)&&!linkedLeadIds.has(account.accountId));
    const cardsBox = make('section', { className: 'first-step-accounts', attrs: { 'aria-label': '公开账号候选' } });
    if (mainAccounts.length === 0 && view.clusters.length > 0) {
      cardsBox.appendChild(make('p', { className: 'muted', text: '请先确认目标人物；这个人的公开账号会显示在这里。' }));
    }
    cardsBox.appendChild(renderGroups(mainAccounts));
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
        make('summary', { text: `其它线索（未确认 / 不并入人物结论）（${String(secondaryAccounts.length + (view.relatedLeads ?? []).length)}）` })
      );
      secondary.appendChild(
        make('p', { className: 'muted', text: '保留的真实线索；默认不勾选、不并入人物结论，可单独以独立账号范围研究。' })
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
    root.appendChild(cardsBox);

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
    const primary = make('button', {
      className: 'button primary first-step-primary',
      text: count > 0 ? `确认目标，研究已选 ${String(count)} 个账号` : '确认目标，研究已选账号',
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
    root.appendChild(footer);
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details')) {
      if (openKeys.has(details.dataset.detailKey)) details.open = true;
    }
    if (focusKey) {
      const replacement = [...root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(el => el.dataset.focusKey === focusKey);
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
    const checked = decision.selection === 'selected' || decision.selection === 'only_this_account';
    const card = make('div', {
      className: `first-step-card${checked ? ' checked' : ''}${decision.excluded ? ' excluded' : ''}`
    });
    const applyChecked = (next: boolean): void => {
      if (decision.excluded) return;
      if (next) {
        decision.selection = account.requiresIndependentScope ? 'only_this_account' : 'selected';
      } else {
        decision.selection = 'not_selected';
      }
      render();
    };
    const toggle = (): void => applyChecked(!checked);
    const top = make('div', { className: 'first-step-card-top' });
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
    label.append(
      checkbox,
      make('div', {
        children: [
          make('span', { className: 'first-step-platform', text: account.platformLabel }),
          make('span', { className: 'first-step-handle', text: [account.handle ? `@${account.handle}` : '', shortUrl(account.profileUrl)].filter(Boolean).join(' · ') })
        ]
      })
    );
    top.appendChild(label);
    top.appendChild(
      make('span', {
        className: `first-step-badge${account.identity.state === 'supported' && account.identity.validity !== 'review' ? '' : ' uncertain'}`,
        text: account.identity.validity === 'review' ? '原归属依据已失效' : STATE_LABELS[account.identity.state] ?? account.identity.state
      })
    );
    card.appendChild(top);
    if(matchedTitle)card.appendChild(make('p',{className:'first-step-value',text:`匹配的主页标题：${matchedTitle}；归属未确认。`}));
    card.appendChild(make('p', { className: 'first-step-value', text: account.researchSummary }));

    card.appendChild(make('p', { className: 'first-step-boundary', text: `当前边界：${account.accessLabel}${account.requiresIndependentScope ? '；需要独立账号范围' : ''}` }));

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
      if (account.requiresIndependentScope && !decision.excluded) {
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
    card.appendChild(actions);

    // Evidence panel: source title/URL, exact span, role and limitation.
    const evidence = make('details', { className: 'first-step-evidence', attrs:{'data-detail-key':`evidence-${account.accountId}`} });
    const summary = make('summary', { text: `为什么推荐（${String(account.identity.evidence.length)} 条依据）`, attrs:{'data-focus-key':`evidence-${account.accountId}`} });
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
    evidenceList.appendChild(make('p', {className:'first-step-reason', text:`${account.identity.basisLabel}；${account.defaultSuggestion.reason}`}));
    for (const item of account.identity.evidence) {
      const block = make('div', { className: 'first-step-evidence-item' });
      block.appendChild(make('p', { text: `${item.sourceTitle}（${shortUrl(item.sourceUrl)}）· ${item.role === 'identity_support' ? '归属依据' : '反证'}` }));
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
    card.appendChild(evidence);

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
        draft.set(account.accountId, { selection: persisted ? (account.requiresIndependentScope ? 'only_this_account' : 'selected') : suggested ? 'selected' : 'unanswered', excluded: next.selection.excludedAccountIds.includes(account.accountId) });
      }
    }
    status = 'ready';
    if (!sameView) render();
  };

  const renderLegacy = (response: FirstStepDiscoveryResponse): void => {
    if (destroyed) return;
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
      draft.clear(); view = null; hintDraft = '';
    },
    statusText() {
      return status;
    }
  };
}

export type { FirstStepPersonClusterView };
