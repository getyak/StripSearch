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
