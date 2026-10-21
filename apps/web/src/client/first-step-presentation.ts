/**
 * First-step account comparison presentation (2026-10-21 contract).
 *
 * Pure helpers shared by the comparison-workspace renderer. They keep four
 * identity-shaped strings in SEPARATE, honest slots:
 *
 * - the query / person label: only a genuinely source-backed
 *   `ownerAnchor.personLabel` (current, valid) may stand as a person name;
 *   otherwise the label is explicitly the user's query or the account handle;
 * - the account handle;
 * - the site host;
 * - the literal page title, always kept verbatim.
 *
 * A page title is NEVER heuristically stripped into a person name. These
 * helpers are presentation only: they never change the draft, the selection
 * payload, identity state or any server authority.
 */

import { readableSourceText } from './source-text.js';
import type {
  FirstStepAccountView,
  FirstStepDiscoveryView,
  FirstStepPersonClusterView
} from '../shared/first-step-discovery.js';

/** Presentation-only excerpt; retained evidence keeps the exact original. */
export const excerptText = readableSourceText;

export function shortUrl(url: string | null): string {
  if (!url) return '';
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

export function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Person label: source-backed name, or honestly labelled query/handle */
/* ------------------------------------------------------------------ */

export type PersonLabelKind =
  | 'owner_self_declared'
  | 'owner_supported'
  | 'query_match'
  | 'query_only'
  | 'handle_only';

export interface PersonLabelView {
  /** Compact label for the person slot. Never derived from a page title. */
  label: string;
  kind: PersonLabelKind;
  /** Honest qualifier shown beside the label. */
  kindLabel: string;
  /** Literal page title kept OUT of the name slot, verbatim. */
  pageTitle: string | null;
}

/**
 * A person label may only come from a CURRENTLY VALID, genuinely source-backed
 * owner claim. Unbound, disputed or contradicted anchors and review validity
 * never turn a query/handle into a source claim; owner evidence that is entirely
 * withdrawn is not a source either. This mirrors `personLabelFor`'s gate.
 */
export function sourceBackedPersonLabel(account: FirstStepAccountView): { text: string; kindLabel: string } | null {
  const owner = account.identity.ownerAnchor;
  if (!owner) return null;
  if (account.identity.ownerValidity === 'review') return null;
  if (owner.state !== 'self_declared' && owner.state !== 'independently_supported') return null;
  const label = owner.personLabel.trim();
  if (label.length === 0) return null;
  const evidence = account.identity.ownerEvidence ?? [];
  if (evidence.length > 0 && evidence.every((item) => item.revoked)) return null;
  return {
    text: label,
    kindLabel: owner.state === 'independently_supported' ? '姓名有独立来源支持' : '账号自述姓名'
  };
}

/**
 * The person label for one cluster. A page title such as
 * `Lin Zhou | Synthetic University` is never cut into a name: without a valid
 * source-backed owner label the person slot honestly reuses the query text or
 * the anchor handle, and the title stays visible as a literal page title.
 */
export function personLabelFor(cluster: FirstStepPersonClusterView, view: FirstStepDiscoveryView): PersonLabelView {
  const anchor =
    (cluster.anchorAccountId
      ? view.accounts.find((account) => account.accountId === cluster.anchorAccountId)
      : view.accounts.find(
          (account) => account.profileUrl && shortUrl(account.profileUrl) === shortUrl(cluster.anchorUrl)
        )) ?? null;
  const title = cluster.displayName.trim();
  const owner = anchor?.identity.ownerAnchor;
  const backed = anchor ? sourceBackedPersonLabel(anchor) : null;
  if (owner && backed) {
    const label = owner.personLabel.trim();
    return {
      label,
      kind: owner.state === 'independently_supported' ? 'owner_supported' : 'owner_self_declared',
      kindLabel: owner.state === 'independently_supported' ? '姓名有独立来源支持' : '账号自述姓名 · 尚未独立验证',
      pageTitle: title && title.toLocaleLowerCase() !== label.toLocaleLowerCase() ? title : null
    };
  }
  if (view.input.kind === 'name_query') {
    const names = view.input.value
      .split(/\s*[\/／]\s*/)
      .map((name) => name.trim().toLocaleLowerCase())
      .filter((name) => name.length >= 2);
    const exact = names.includes(title.toLocaleLowerCase());
    if (exact) {
      // The literal title is exactly the name the user typed: still only a
      // query match, never an identity confirmation.
      return { label: title, kind: 'query_match', kindLabel: '与输入姓名一致 · 尚未确认', pageTitle: null };
    }
    if (anchor?.handle) {
      // A title like `Lin Zhou | Synthetic University` is a page title, not a
      // name: distinguish the candidate by its literal handle and keep the
      // title verbatim instead of stripping it into a person.
      return {
        label: `@${anchor.handle}`,
        kind: 'handle_only',
        kindLabel: '按账号 handle 称呼 · 未确认姓名',
        pageTitle: title || null
      };
    }
    return {
      label: view.input.value.trim(),
      kind: 'query_only',
      kindLabel: '按查询称呼 · 未确认姓名',
      pageTitle: title || null
    };
  }
  return {
    label: anchor?.handle ? `@${anchor.handle}` : cluster.anchorLabel || shortUrl(cluster.anchorUrl) || view.input.value.trim(),
    kind: 'handle_only',
    kindLabel: '按账号 handle 称呼 · 未确认姓名',
    pageTitle: title || null
  };
}

/* ------------------------------------------------------------------ */
/* Account row: account / content / basis / status / selection columns  */
/* ------------------------------------------------------------------ */

export const STATE_LABELS: Record<string, string> = {
  supported: '原文支持账号关联',
  proposed: '可能相关',
  disputed: '存在冲突',
  rejected: '已被否定',
  revoked: '依据已撤回'
};

export type FirstStepContentKind = 'conflict' | 'invalid' | 'counterevidence' | 'linkage' | 'summary';

export interface AccountRowView {
  /** Literal handle label; the instance is appended only where it disambiguates. */
  handleLabel: string;
  /** Site host in its own slot; never repeated as an identity claim. */
  hostLabel: string;
  /** Literal page title (matched title or display title), verbatim. */
  pageTitle: string | null;
  /** Person label slot; only a source-backed owner label, else null. */
  personLabel: { text: string; kindLabel: string } | null;
  /** Account-specific clue first; the generic summary is the last fallback. */
  contentClue: string;
  contentKind: FirstStepContentKind;
  badgeLabel: string;
  badgeTone: 'settled' | 'uncertain';
  basisLabel: string;
  ownerNote: string | null;
  statusLabel: string;
  /** Concise row chip for the independent-scope boundary. */
  boundaryChip: string | null;
  /** Complete boundary sentence; inspectable in the row disclosure. */
  boundaryLabel: string | null;
}

/** The handle label keeps the historical `@mira · mastodon.social` contract. */
export function accountHandleLabel(account: FirstStepAccountView, accounts: readonly FirstStepAccountView[]): string {
  const repeatedHandle =
    Boolean(account.handle) &&
    accounts.some(
      (other) => other.accountId !== account.accountId && other.platform === account.platform && other.handle === account.handle
    );
  const host = account.instance ?? hostOf(account.profileUrl);
  if (account.handle && account.handle !== shortUrl(account.profileUrl)) {
    return `@${account.handle}${account.platform === 'mastodon' || repeatedHandle ? ` · ${host}` : ''}`;
  }
  return shortUrl(account.profileUrl);
}

function ownerNoteFor(account: FirstStepAccountView): string | null {
  const owner = account.identity.ownerAnchor;
  if (!owner) return null;
  const evidence = account.identity.ownerEvidence ?? [];
  if (evidence.length > 0 && evidence.every(item => item.revoked)) return '姓名归属原文已撤回，请核对';
  if (account.identity.ownerValidity === 'review') return '姓名归属依据已失效，请核对原文';
  if (owner.state === 'self_declared') return '账号自述姓名一致 · 尚未独立验证';
  if (owner.state === 'unbound') return '姓名归属尚未核对';
  if (owner.state === 'independently_supported') return '姓名归属有独立支持';
  return '姓名归属存在冲突，请核对';
}

/**
 * The "能了解什么" cell: an account-specific linkage clue, conflict or
 * invalidity always outranks the repetitive generic research summary.
 */
export function contentClueFor(account: FirstStepAccountView): { text: string; kind: FirstStepContentKind } {
  if (account.identity.nativeIdConflict === true) {
    return { text: '实际原生 ID 冲突 · 只能独立研究', kind: 'conflict' };
  }
  if (account.identity.validity === 'review') {
    return { text: account.identity.reviewReason?.trim() || '原归属依据已失效 · 请核对原文', kind: 'invalid' };
  }
  if (account.identity.conflicts.length > 0) {
    return { text: account.identity.conflicts.join('；'), kind: 'conflict' };
  }
  if (account.identity.counterevidence.length > 0) {
    return { text: `存在反证：${account.identity.counterevidence[0]!.label}`, kind: 'counterevidence' };
  }
  if (account.attribution) {
    return { text: account.attribution.reason, kind: 'linkage' };
  }
  return { text: account.researchSummary, kind: 'summary' };
}

export function accountRowFor(
  account: FirstStepAccountView,
  accounts: readonly FirstStepAccountView[],
  options: { requiresIndependentScope: boolean; submitted: boolean; matchedTitle?: string | null }
): AccountRowView {
  const clue = contentClueFor(account);
  const displayTitle = account.displayName?.trim() ?? '';
  // The account's own literal page title leads; a matched title is only shown
  // when the account carries no separate display title.
  const pageTitle =
    (displayTitle && displayTitle.toLocaleLowerCase() !== (account.handle ?? '').toLocaleLowerCase() ? displayTitle : null) ||
    options.matchedTitle?.trim() ||
    null;
  // Only a currently valid source-backed owner label may occupy the name slot;
  // unbound/disputed/contradicted anchors never become a source claim.
  const ownerLabel = sourceBackedPersonLabel(account);
  const stateLabel = STATE_LABELS[account.identity.state] ?? account.identity.state;
  const badgeLabel =
    account.accountKind === 'organization'
      ? '组织账号'
      : account.identity.validity === 'review'
        ? '原归属依据已失效'
        : account.identity.state === 'rejected' || account.identity.state === 'revoked'
          ? stateLabel
          : account.identity.nativeIdConflict === true || account.identity.conflicts.length > 0
            ? '存在冲突'
            : stateLabel;
  return {
    handleLabel: accountHandleLabel(account, accounts),
    hostLabel: hostOf(account.profileUrl),
    pageTitle,
    personLabel: ownerLabel,
    contentClue: clue.text,
    contentKind: clue.kind,
    badgeLabel,
    badgeTone: account.identity.state === 'supported' && account.identity.validity !== 'review' ? 'settled' : 'uncertain',
    basisLabel: account.identity.basisLabel,
    ownerNote: ownerNoteFor(account),
    statusLabel: account.accessLabel,
    // The row carries a concise chip; the complete boundary sentence stays in
    // the row's evidence disclosure and in the one shared scope note.
    boundaryChip: options.requiresIndependentScope ? (options.submitted ? '范围已提交 · 单独研究，不并入人物结论。' : '独立账号范围') : null,
    boundaryLabel: options.requiresIndependentScope ? '单独研究，不并入人物结论。' : null
  };
}

/* ------------------------------------------------------------------ */
/* Filter & search: presentation-only windows over the displayed scope  */
/* ------------------------------------------------------------------ */

export type FirstStepAccountFilter = 'all' | 'selected' | 'needs_check' | 'invalid_basis';

export const FIRST_STEP_FILTER_ORDER: readonly FirstStepAccountFilter[] = ['all', 'selected', 'needs_check', 'invalid_basis'];

export const FIRST_STEP_FILTER_LABELS: Record<FirstStepAccountFilter, string> = {
  all: '全部',
  selected: '已选',
  needs_check: '待核对',
  invalid_basis: '依据失效'
};

export interface FirstStepRowDecision {
  selection: 'selected' | 'not_selected' | 'only_this_account' | 'unanswered';
  excluded: boolean;
}

/** Cleanly settled account-to-account support; anything else needs a check. */
export function isSettledSupport(account: FirstStepAccountView): boolean {
  return (
    account.identity.state === 'supported' &&
    account.identity.validity !== 'review' &&
    account.identity.nativeIdConflict !== true &&
    account.identity.conflicts.length === 0 &&
    account.identity.counterevidence.length === 0 &&
    !hasInvalidBasis(account) &&
    account.identity.ownerValidity !== 'review' &&
    account.identity.ownerAnchor?.state !== 'unbound' &&
    account.identity.ownerAnchor?.state !== 'disputed' &&
    account.identity.ownerAnchor?.state !== 'contradicted'
  );
}

/** Current dependency validity is broken: review, withdrawn or revoked basis. */
export function hasInvalidBasis(account: FirstStepAccountView): boolean {
  return (
    account.identity.validity === 'review' ||
    account.identity.state === 'revoked' ||
    account.identity.ownerValidity === 'review' ||
    Boolean(account.identity.ownerEvidence?.length && account.identity.ownerEvidence.every(item => item.revoked))
  );
}

export function accountMatchesFilter(
  account: FirstStepAccountView,
  decision: FirstStepRowDecision,
  filter: FirstStepAccountFilter
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'selected':
      return !decision.excluded && (decision.selection === 'selected' || decision.selection === 'only_this_account');
    case 'needs_check':
      return !isSettledSupport(account);
    case 'invalid_basis':
      return hasInvalidBasis(account);
    default:
      return true;
  }
}

/** Search matches only strings the row actually displays: platform, handle,
 * display title, instance, host and the literal profile URL. */
export function accountMatchesQuery(account: FirstStepAccountView, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [
    account.platformLabel,
    account.handle ?? '',
    account.displayName ?? '',
    account.instance ?? '',
    hostOf(account.profileUrl),
    shortUrl(account.profileUrl)
  ]
    .join('\n')
    .toLocaleLowerCase();
  return haystack.includes(needle);
}
