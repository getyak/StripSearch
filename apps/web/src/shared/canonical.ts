import { isPublicHttpsUrl } from './validation.js';
import type {
  CanonicalAnswerSection,
  CanonicalObservation,
  CanonicalSource,
  CanonicalView,
  ClaimKind,
  ProviderName,
  RunState,
  SourceKind,
  Validity
} from './types.js';
import type {
  AccessCoverageState,
  AllowedScopeState,
  CaseReportView,
  ConsentProvenance,
  CoverageStatus,
  EvidenceRole,
  IdentitySupportState,
  ResearchValueState,
  TaskRef,
  UserSelectionState
} from './research-case.js';
import { taskRefKey } from './research-case.js';

export const STATE_LABELS: Record<RunState, string> = {
  queued: '排队中',
  researching: '正在查看资料',
  needs_input: '等待确认',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
};

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  github: 'GitHub 公开账号',
  exa: 'Exa 网页检索',
  research: '公开资料研究'
};

export const KIND_LABELS: Record<ClaimKind, string> = {
  factual: '查到的事实',
  attributed_statement: '本人自述',
  page_statement: '来源页面表述',
  inference: '推断'
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  profile: '主页',
  work: '作品',
  third_party: '第三方'
};

export function stateLabel(state: RunState): string {
  return STATE_LABELS[state] ?? state;
}

export function providerLabel(provider: ProviderName): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Exclusion is the single dependency rule: any statement that leans on an
 * excluded source becomes "review" and is never presented as newly verified.
 */
export function reviewReason(sourceKeys: string[], excludedKeys: ReadonlySet<string>): string | null {
  const hit = sourceKeys.filter((key) => excludedKeys.has(key));
  if (hit.length === 0) return null;
  return `${hit.join('、')} 已撤下`;
}

export function validityFor(sourceKeys: string[], excludedKeys: ReadonlySet<string>): Validity {
  return reviewReason(sourceKeys, excludedKeys) ? 'review' : 'valid';
}

export function excludedSourceKeys(sources: CanonicalSource[]): Set<string> {
  return new Set(sources.filter((source) => source.excluded).map((source) => source.sourceKey));
}

export function countReviewItems(
  observations: CanonicalObservation[],
  answer: CanonicalAnswerSection[]
): number {
  let count = 0;
  for (const observation of observations) if (observation.validity === 'review') count += 1;
  for (const section of answer) {
    for (const bullet of section.bullets) if (bullet.validity === 'review') count += 1;
  }
  return count;
}

function escapeInline(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ').trim()
    .replace(/\\/g, '\\\\').replace(/([`*_[\]])/g, '\\$1');
}

function cite(sourceKeys: string[]): string {
  if (sourceKeys.length === 0) return '';
  return ` ${sourceKeys.map((key) => `[${key}]`).join('')}`;
}

/**
 * Deterministic Markdown rendering of the same canonical view returned as JSON.
 * Exclusion state is written inline so an exported report cannot silently keep
 * a statement that depends on a withdrawn source.
 */
export function renderMarkdown(view: CanonicalView): string {
  const lines: string[] = [];
  const title = view.identity.displayName || view.question;
  lines.push(`# ${escapeInline(title)} · 研究报告`);
  lines.push('');
  lines.push(`> ${escapeInline(view.question)}`);
  lines.push('');
  lines.push(`- 运行状态：${stateLabel(view.state)}`);
  lines.push(`- 数据来源：${providerLabel(view.provider)}`);
  lines.push(`- 报告修订：v${view.revision}`);
  lines.push(`- 更新时间：${view.updatedAt}`);
  lines.push(`- 需要复核：${view.reviewCount} 处`);
  if (view.identity.status !== 'resolved' && view.identity.note) {
    lines.push(`- 身份状态：${escapeInline(view.identity.note)}`);
  }
  lines.push('');
  lines.push('> 本报告整理公开资料，不代替对当事人的核实；自述保持为自述。');
  lines.push('');

  for (const section of view.answer) {
    lines.push(`## ${escapeInline(section.heading)}`);
    lines.push('');
    if (section.body) {
      lines.push(escapeInline(section.body));
      lines.push('');
    }
    for (const bullet of section.bullets) {
      const marker = bullet.validity === 'review' ? `**[待复核 · ${escapeInline(bullet.reviewReason ?? '')}]** ` : '';
      lines.push(`- ${marker}${escapeInline(bullet.text)}${cite(bullet.sourceKeys)}`);
    }
    lines.push('');
  }

  if (view.observations.length > 0) {
    lines.push('## 观察项');
    lines.push('');
    for (const observation of view.observations) {
      const marker = observation.validity === 'review' ? `**[待复核 · ${escapeInline(observation.reviewReason ?? '')}]** ` : '';
      lines.push(`- ${marker}${escapeInline(observation.statement)}${cite(observation.sourceKeys)}`);
      for (const limitation of observation.limitations) {
        lines.push(`  - 限制：${escapeInline(limitation)}`);
      }
    }
    lines.push('');
  }

  lines.push('## 来源');
  lines.push('');
  for (const source of view.sources) {
    const status = source.excluded ? '已不采用' : source.fetchStatus === 'ok' ? '已读取' : source.fetchStatus;
    lines.push(`### ${source.sourceKey} · ${escapeInline(source.title)}`);
    lines.push('');
    lines.push(`- 类型：${SOURCE_KIND_LABELS[source.kind]}`);
    lines.push(`- 链接：${isPublicHttpsUrl(source.url) ? escapeInline(new URL(source.url).href) : '链接无效'}`);
    lines.push(`- 身份归属：${source.identityConfirmed ? '已确认（种子账号）' : '未确认'}`);
    if (source.publishedAt) lines.push(`- 发表时间：${escapeInline(source.publishedAt)}`);
    lines.push(`- 状态：${status}`);
    if (source.excerpt) {
      lines.push(`- 摘录（${escapeInline(source.excerptLocator ?? '位置未标注')}）：`);
      lines.push('');
      lines.push(`  > ${escapeInline(source.excerpt)}`);
      lines.push('');
    }
    for (const limit of source.limits) lines.push(`- 限制：${escapeInline(limit)}`);
    lines.push('');
  }

  if (view.limitations.length > 0) {
    lines.push('## 限制与未知');
    lines.push('');
    for (const limitation of view.limitations) {
      lines.push(`- ${escapeInline(limitation)}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`本报告由 StripSearch 整理，修订 v${view.revision}，schema ${view.schemaVersion}。`);
  lines.push('');
  return lines.join('\n');
}

export function renderJson(view: CanonicalView): string {
  return `${JSON.stringify(view, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* GET-58 case report renderers: derive from one canonical case view  */
/* ------------------------------------------------------------------ */

const EVIDENCE_ROLE_LABELS: Record<EvidenceRole, string> = {
  identity_support: '身份归属支持',
  identity_counterevidence: '身份归属反证',
  factual_support: '事实支持',
  factual_counterevidence: '事实反证'
};

const CONSENT_LABELS: Record<ConsentProvenance, string> = {
  user_confirmed: '用户确认',
  legacy_no_authorization: '旧版记录（无授权）',
  not_recorded: '未记录授权'
};

const IDENTITY_SUPPORT_LABELS: Record<IdentitySupportState, string> = {
  proposed: '候选',
  supported: '证据支持',
  disputed: '有争议',
  rejected: '已排除',
  revoked: '已撤回'
};

const USER_SELECTION_LABELS: Record<UserSelectionState, string> = {
  unanswered: '未选择',
  selected: '用户选择研究',
  only_this_account: '仅研究此账号',
  not_selected: '用户未选'
};

const ALLOWED_SCOPE_LABELS: Record<AllowedScopeState, string> = {
  none: '不允许读取',
  profile_only: '仅主页',
  public_history: '公开历史'
};

const RESEARCH_VALUE_LABELS: Record<ResearchValueState, string> = {
  unassessed: '未评估',
  high: '高',
  medium: '中',
  low: '低'
};

const ACCESS_COVERAGE_LABELS: Record<AccessCoverageState, string> = {
  unassessed: '未检查',
  inaccessible: '不可访问',
  partial: '部分已读',
  capped: '受额度截断',
  interface_complete: '接口范围已读完'
};

const COVERAGE_STATUS_LABELS: Record<CoverageStatus, string> = {
  unseen: '未读',
  evidence_found: '已有证据',
  conflicting: '有冲突',
  resolved_unknown: '已确认为未知',
  blocked: '受阻'
};

function taskRefLabel(ref: TaskRef): string {
  return taskRefKey(ref);
}

/** Reference block keeping support and counterevidence semantics apart. */
function claimRefs(supportIds: string[], counterevidenceIds: string[]): string {
  const parts: string[] = [];
  if (supportIds.length > 0) parts.push(`支持 ${supportIds.map((id) => `[${escapeInline(id)}]`).join('')}`);
  if (counterevidenceIds.length > 0) {
    parts.push(`反证 ${counterevidenceIds.map((id) => `[${escapeInline(id)}]`).join('')}`);
  }
  return parts.join(' ');
}

/** Deterministic JSON export of the canonical case view. Adds no facts. */
export function renderCaseJson(view: CaseReportView): string {
  return `${JSON.stringify(view, null, 2)}\n`;
}

/**
 * Deterministic Markdown export of the same canonical case view. Withdrawn
 * evidence and dependent claims stay visible with markers; stable ids are
 * escaped for Markdown without changing their stored identity or numbering.
 */
export function renderCaseMarkdown(view: CaseReportView): string {
  const lines: string[] = [];
  const record = view.case;
  // Caller-supplied identifiers are data, never Markdown structure.
  // Escaping changes serialization only; canonical identities stay unchanged.
  lines.push(`# 研究案例 · ${escapeInline(record.caseId)}`);
  lines.push('');
  lines.push(`> ${escapeInline(record.intent)}`);
  lines.push('');
  lines.push(`- 人员对象：${escapeInline(record.personId)}`);
  lines.push(`- 范围版本：v${record.scopeVersion}`);
  lines.push(`- 人员修订：r${record.personRevision}`);
  lines.push(`- 授权来源：${CONSENT_LABELS[record.provenance.authorization]}`);
  lines.push('');
  lines.push('> 本报告为领域记录导出；身份归属、事实支持与用户选择分开记录，互不升级。');
  lines.push('');

  lines.push('## 账号选择');
  lines.push('');
  for (const account of view.accounts) {
    lines.push(`### ${escapeInline(account.accountId)} · ${escapeInline(account.platform)}`);
    lines.push('');
    if (account.handle) lines.push(`- 账号：${escapeInline(account.handle)}`);
    if (account.profileUrl) {
      lines.push(`- 主页：${isPublicHttpsUrl(account.profileUrl) ? escapeInline(account.profileUrl) : '链接无效'}`);
    }
    const identityMarker =
      account.identityValidity === 'review'
        ? ` **[需重新评估 · ${escapeInline(account.identityReviewReason ?? '')}]**`
        : '';
    lines.push(`- 身份证据支持：${IDENTITY_SUPPORT_LABELS[account.identitySupport.state]}${identityMarker}`);
    if (account.identitySupport.evidenceIds.length > 0) {
      lines.push(`  - 支持证据：${account.identitySupport.evidenceIds.map((id) => escapeInline(id)).join('、')}`);
    }
    if (account.identitySupport.counterevidenceIds.length > 0) {
      lines.push(`  - 反证：${account.identitySupport.counterevidenceIds.map((id) => escapeInline(id)).join('、')}`);
    }
    lines.push(`- 用户选择（仅研究意图）：${USER_SELECTION_LABELS[account.userSelection.state]}`);
    lines.push(`- 允许范围：${ALLOWED_SCOPE_LABELS[account.allowedScope.state]}`);
    lines.push(`- 研究价值：${RESEARCH_VALUE_LABELS[account.researchValue.state]}`);
    lines.push(`- 访问覆盖：${ACCESS_COVERAGE_LABELS[account.accessCoverage.state]}`);
    lines.push('');
  }

  if (view.claims.length > 0) {
    lines.push('## 结论');
    lines.push('');
    for (const claim of view.claims) {
      const marker = claim.validity === 'review' ? `**[待复核 · ${escapeInline(claim.reviewReason ?? '')}]** ` : '';
      const refs = claimRefs(claim.supportIds, claim.counterevidenceIds);
      lines.push(
        `- ${marker}【${KIND_LABELS[claim.kind]}】${escapeInline(claim.statement)}${refs ? ` ${refs}` : ''}（${escapeInline(claim.claimId)}）`
      );
      for (const limitation of claim.limitations) {
        lines.push(`  - 限制：${escapeInline(limitation)}`);
      }
    }
    lines.push('');
  }

  if (view.evidence.length > 0) {
    lines.push('## 证据');
    lines.push('');
    for (const evidence of view.evidence) {
      const revoked = evidence.revokedAt !== null ? ' · 已撤回' : '';
      lines.push(`### ${escapeInline(evidence.evidenceId)} · ${EVIDENCE_ROLE_LABELS[evidence.role]}${revoked}`);
      lines.push('');
      lines.push(`- 来源：${escapeInline(evidence.sourceId)} rev${evidence.sourceRevision}`);
      if (evidence.locator) lines.push(`- 定位：${escapeInline(evidence.locator)}`);
      lines.push('');
      lines.push(`  > ${escapeInline(evidence.quote)}`);
      lines.push('');
    }
  }

  if (view.sources.length > 0) {
    lines.push('## 来源修订');
    lines.push('');
    for (const source of view.sources) {
      for (const revision of source.revisions) {
        lines.push(`### ${escapeInline(source.sourceId)} rev${revision.sourceRevision} · ${escapeInline(revision.title)}`);
        lines.push('');
        lines.push(`- 作者：${escapeInline(revision.author ?? '未标注')}`);
        lines.push(`- 原始链接：${isPublicHttpsUrl(revision.originalUrl) ? escapeInline(revision.originalUrl) : '链接无效'}`);
        if (revision.publishedAt) lines.push(`- 发表时间：${escapeInline(revision.publishedAt)}`);
        lines.push(`- 取回时间：${escapeInline(revision.retrievedAt)}`);
        if (revision.locator) lines.push(`- 定位：${escapeInline(revision.locator)}`);
        lines.push(`- 内容哈希：${escapeInline(revision.contentHash)}`);
        lines.push(`- 授权来源：${CONSENT_LABELS[revision.provenance.authorization]}`);
        lines.push('');
      }
    }
  }

  if (view.coverage.length > 0) {
    lines.push('## 覆盖记录');
    lines.push('');
    for (const item of view.coverage) {
      // Per-item scope version is authoritative here; the footer's case version
      // never stands in for it, and older-scope coverage is labelled honestly.
      const staleMarker =
        item.scopeValidity === 'review'
          ? ` **[待复核 · ${escapeInline(item.scopeReviewReason ?? '')}]**`
          : '';
      const dependencyMarker = item.dependencyValidity === 'review'
        ? ` **[证据待复核 · ${escapeInline(item.dependencyReviewReason ?? '')}]**`
        : '';
      const refs = claimRefs(item.evidenceIds, item.counterevidenceIds);
      lines.push(
        `- ${escapeInline(item.itemId)} · ${escapeInline(taskRefLabel(item.taskRef))} · ${COVERAGE_STATUS_LABELS[item.status]} · 账号 ${escapeInline(item.locator.accountId)} · 来源 ${escapeInline(item.locator.sourceId)} rev${item.locator.sourceRevision} · 范围 v${String(item.scopeVersion)}${staleMarker}${dependencyMarker}${refs ? ` ${refs}` : ''}`
      );
      if (item.note) lines.push(`  - 备注：${escapeInline(item.note)}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `本导出由 StripSearch 从同一份 canonical 案例视图生成，范围版本 v${record.scopeVersion}，人员修订 r${record.personRevision}，schema ${view.schemaVersion}。`
  );
  lines.push('');
  return lines.join('\n');
}
