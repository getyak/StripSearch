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
  /** Called after a successful submit so the host can refresh the run view. */
  onAfterSubmit?: (result: FirstStepSelectionResponse) => void;
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

export function createFirstStepPanel(deps: FirstStepPanelDeps): FirstStepPanel {
  const draft = new Map<string, FirstStepDecisionDraft>();
  let view: FirstStepDiscoveryView | null = null;
  let runRevision = 0;
  let clusterId: string | null = null;
  let saving = false;
  let errorText = '';
  let status = 'loading';
  let submitKey: string | null = null;
  let idempotencySeq = 0;
  const now = deps.now ?? ((): number => Date.now());
  let openEvidence: { close: () => void } | null = null;

  const selectedCount = (): number =>
    [...draft.values()].filter((decision) => decision.selection === 'selected' || decision.selection === 'only_this_account').length;

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
    const root = deps.container;
    clear(root);
    root.className = 'first-step';
    if (!view) {
      root.appendChild(make('p', { className: 'first-step-status', text: status === 'loading' ? '正在读取发现结果…' : status }));
      return;
    }
    // Person cluster choice.
    const clusterBox = make('section', { className: 'first-step-clusters', attrs: { 'aria-label': '人物候选' } });
    clusterBox.appendChild(make('h3', { text: '确认目标人物' }));
    for (const cluster of view.clusters) {
      const chosen = clusterId === cluster.clusterId;
      const button = make('button', {
        className: `first-step-cluster${chosen ? ' chosen' : ''}`,
        attrs: { type: 'button', 'aria-pressed': chosen ? 'true' : 'false' },
        on: {
          click: () => {
            clusterId = cluster.clusterId;
            render();
          }
        }
      });
      button.append(
        make('strong', { text: cluster.displayName }),
        make('span', { className: 'first-step-cluster-anchor', text: shortUrl(cluster.anchorUrl) || cluster.anchorLabel })
      );
      for (const lead of cluster.leads.slice(0, 3)) {
        button.appendChild(make('small', { text: lead.statement }));
      }
      if (cluster.conflicts.length > 0) {
        button.appendChild(make('small', { className: 'first-step-conflict', text: cluster.conflicts.join('；') }));
      }
      clusterBox.appendChild(button);
    }
    if (view.clusters.length === 0) {
      clusterBox.appendChild(make('p', { className: 'muted', text: '暂未辨识出可确认的人物；可以补充一个公开主页或区分线索。' }));
    }
    root.appendChild(clusterBox);

    // Discovery status and honest gaps.
    const statusBox = make('section', { className: 'first-step-status-box', attrs: { 'aria-label': '发现状态' } });
    statusBox.appendChild(
      make('p', {
        className: 'first-step-status',
        text: `发现修订 v${String(view.discoveryRevision)} · ${view.readyForChoice ? '可选择研究范围' : '发现仍在进行'}`
      })
    );
    if (view.gaps.length > 0) {
      const details = make('details', { className: 'first-step-gaps' });
      details.appendChild(make('summary', { text: `发现边界与缺口（${String(view.gaps.length)}）` }));
      const list = make('ul', {});
      for (const gap of view.gaps.slice(0, 12)) list.appendChild(make('li', { text: gap }));
      details.appendChild(list);
      statusBox.appendChild(details);
    }
    root.appendChild(statusBox);

    // Account cards grouped by research purpose.
    const cardsBox = make('section', { className: 'first-step-accounts', attrs: { 'aria-label': '公开账号候选' } });
    for (const category of CATEGORY_ORDER) {
      const accounts = view.accounts.filter((account) => account.category === category);
      if (accounts.length === 0) continue;
      const group = make('div', { className: 'first-step-group' });
      group.appendChild(make('h3', { text: `${CATEGORY_LABELS[category]}（${String(accounts.length)}）` }));
      const cards = make('div', { className: 'first-step-cards' });
      for (const account of accounts) cards.appendChild(renderCard(account));
      group.appendChild(cards);
      cardsBox.appendChild(group);
    }
    root.appendChild(cardsBox);

    // Secondary actions: manual clue / continue search.
    const secondary = make('details', { className: 'first-step-secondary' });
    secondary.appendChild(make('summary', { text: '补充一个公开主页或区分线索' }));
    const hintInput = make('input', {
      attrs: { type: 'text', placeholder: '例如：他是 Lantern 的作者', 'aria-label': '补线索' }
    }) as HTMLInputElement;
    const hintState = make('span', { className: 'muted', text: '' });
    secondary.appendChild(hintInput);
    secondary.appendChild(
      make('button', {
        className: 'button',
        text: '发起新的发现',
        attrs: { type: 'button' },
        on: {
          click: () => {
            void (async () => {
              const hint = hintInput.value.trim();
              if (!hint) {
                hintState.textContent = '请先填写线索。';
                return;
              }
              hintState.textContent = '已提交新的发现请求…';
              try {
                await deps.api.expandFirstStep(deps.runId, { hint }, `expand-${String(now())}-${String(++idempotencySeq)}`);
                hintState.textContent = '已排队；新的发现结果会以新修订出现。';
              } catch (error) {
                hintState.textContent = error instanceof Error ? error.message : '扩展失败。';
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
      attrs: { type: 'button' },
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
  };

  const renderCard = (account: FirstStepAccountView): HTMLElement => {
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
      attrs: { type: 'checkbox', 'aria-label': `选择 ${account.platformLabel} ${account.handle ?? ''}`, ...(checked ? { checked: true } : {}) }
    }) as HTMLInputElement;
    checkbox.checked = checked;
    checkbox.disabled = decision.excluded || view?.selection.submitted === true;
    // Click flips the render-time state (the native toggle applies later);
    // change re-syncs from the element state — both converge, never double-flip.
    const syncFromCheckbox = (): void => applyChecked(checkbox.checked);
    checkbox.addEventListener('click', (event) => {
      event.stopPropagation();
      applyChecked(!checked);
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
        className: `first-step-badge${account.identity.state === 'supported' ? '' : ' uncertain'}`,
        text: STATE_LABELS[account.identity.state] ?? account.identity.state
      })
    );
    card.appendChild(top);
    card.appendChild(make('p', { className: 'first-step-value', text: account.researchSummary }));
    card.appendChild(
      make('p', {
        className: 'first-step-reason',
        text: `${account.identity.basisLabel}；${account.defaultSuggestion.reason}`
      })
    );
    card.appendChild(make('p', { className: 'first-step-boundary', text: `当前边界：${account.accessLabel}${account.requiresIndependentScope ? '；需要独立账号范围' : ''}` }));

    const actions = make('div', { className: 'first-step-row-actions' });
    if (!decision.excluded && !view?.selection.submitted) {
      actions.appendChild(
        make('button', {
          className: 'text-button',
          text: '不是此人',
          attrs: { type: 'button', 'aria-label': `声明 ${account.platformLabel} 不是此人` },
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
            attrs: { type: 'button' },
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
          attrs: { type: 'button' },
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
    const evidence = make('details', { className: 'first-step-evidence' });
    const summary = make('summary', { text: `为什么推荐（${String(account.identity.evidence.length)} 条依据）` });
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
    for (const item of account.identity.evidence) {
      const block = make('div', { className: 'first-step-evidence-item' });
      block.appendChild(make('p', { text: `${item.sourceTitle}（${shortUrl(item.sourceUrl)}）· ${item.role === 'identity_support' ? '归属依据' : '反证'}` }));
      if (item.quote) block.appendChild(make('blockquote', { text: item.quote }));
      block.appendChild(make('small', { className: 'first-step-limit', text: item.limitation }));
      evidenceList.appendChild(block);
    }
    for (const item of account.identity.counterevidence) {
      const block = make('div', { className: 'first-step-evidence-item counter' });
      block.appendChild(make('p', { text: `反证：${item.sourceTitle}（${shortUrl(item.sourceUrl)}）` }));
      if (item.quote) block.appendChild(make('blockquote', { text: item.quote }));
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
    if (!view || saving) return null;
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
    submitKey = submitKey ?? `select-${deps.runId}-${String(now())}`;
    try {
      const result = await deps.api.submitFirstStepSelection(deps.runId, payload, submitKey);
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
    view = next;
    if (typeof nextRunRevision === 'number') runRevision = nextRunRevision;
    if (clusterId === null && next.clusters.length > 0) clusterId = next.clusters[0]!.clusterId;
    // The draft survives every server push: existing decisions are never
    // overwritten and NEW accounts start unchecked regardless of suggestions.
    for (const account of next.accounts) {
      if (!draft.has(account.accountId)) {
        draft.set(account.accountId, { selection: 'unanswered', excluded: false });
      }
    }
    status = 'ready';
    render();
  };

  const renderLegacy = (response: FirstStepDiscoveryResponse): void => {
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
    deps.container.appendChild(
      make('p', { className: 'muted', text: '这是历史作业的旧候选记录；可发起新的发现生成新修订。' })
    );
  };

  return {
    async refresh() {
      try {
        const response = await deps.api.getFirstStepDiscovery(deps.runId);
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
      await deps.api.expandFirstStep(deps.runId, { hint }, `expand-${String(now())}-${String(++idempotencySeq)}`);
    },
    destroy() {
      openEvidence?.close();
      clear(deps.container);
    },
    statusText() {
      return status;
    }
  };
}

export type { FirstStepPersonClusterView };
