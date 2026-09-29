/**
 * Shared contract for platform discovery, one-pass identity correction and
 * deep post tracking ("platform-discovery/v1").
 *
 * Scope and honesty rules baked into the contract:
 *
 * - A discovery probe answers "does this platform hold an account matching the
 *   subject string right now?" — never "is this the person under study".
 *   Identity attribution is a separate, explicit correction step
 *   (`AccountLink` state machine), because username equality is not identity.
 * - Every probe result carries a `receipt` saying how it was produced
 *   (native HTTP probe vs an imported external tool report) and a
 *   `verification` label. Nothing in this module upgrades `live_unverified`
 *   evidence into verified fact.
 * - External tool reports (maigret, holehe) are parsed as untrusted data with
 *   pure parsers. Their obfuscated recovery contacts are deliberately dropped:
 *   re-contact hints are personal data this product does not need.
 * - Tracked posts inherit the attribution state of their account link. When a
 *   link is dismissed, every post attributed through it becomes `revoked` and
 *   can no longer support anything (see `attributionFor`).
 *
 * This file has no runtime dependencies so the server, the client and tests
 * share one authority for shapes, bounds and state transitions.
 */

export const PLATFORM_DISCOVERY_VERSION = 'stripsearch/platform-discovery/v1';

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

export type DiscoverySubjectKind = 'username' | 'email';

/**
 * Why this subject may be researched. Required at task creation and carried
 * through exports: the product only handles self-research, explicitly
 * consented material, or clearly public professional activity.
 */
export type DiscoveryAuthorization = 'self' | 'consent_obtained' | 'public_professional';

export const DISCOVERY_AUTHORIZATIONS: DiscoveryAuthorization[] = [
  'self',
  'consent_obtained',
  'public_professional'
];

export interface DiscoverySubject {
  kind: DiscoverySubjectKind;
  value: string;
}

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function normalizeSubject(raw: unknown): DiscoverySubject {
  if (raw === null || typeof raw !== 'object') return { kind: 'username', value: '' };
  const record = raw as Record<string, unknown>;
  const kind: DiscoverySubjectKind = record.kind === 'email' ? 'email' : 'username';
  const value = typeof record.value === 'string' ? record.value.trim() : '';
  return { kind, value: kind === 'email' ? value.toLowerCase() : value };
}

export function validateSubject(subject: DiscoverySubject): { ok: boolean; error: string | null } {
  if (subject.kind === 'email') {
    if (subject.value.length === 0 || subject.value.length > 254 || !EMAIL_RE.test(subject.value)) {
      return { ok: false, error: '请提供有效的邮箱地址。' };
    }
    return { ok: true, error: null };
  }
  if (subject.value.length === 0 || subject.value.length > 64 || !USERNAME_RE.test(subject.value)) {
    return { ok: false, error: '用户名只能包含字母、数字、点、下划线与连字符，长度 1–64。' };
  }
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Probe results
// ---------------------------------------------------------------------------

export type ProbeMethod = 'api_http' | 'profile_http' | 'external_report';

export type ProbeStatus = 'found' | 'not_found' | 'unknown' | 'blocked' | 'error';

/**
 * Whether anybody has rechecked this result against the live platform.
 * `live_unverified` is the default for both native probes and imported
 * reports: the engine ran, but no independent live verification receipt
 * exists yet.
 */
export type ProbeVerification = 'offline_fixture' | 'live_verified' | 'live_unverified';

export interface ProbeEvidence {
  url: string;
  excerpt: string | null;
  locator: string | null;
}

/** Provenance receipt: which tool produced the result, and in which format. */
export interface ProbeReceipt {
  tool: string;
  toolVersion: string | null;
  generatedAt: string | null;
  reportFormat: string;
}

export interface ProbeResultDraft {
  platformId: string;
  method: ProbeMethod;
  status: ProbeStatus;
  handle: string | null;
  profileUrl: string | null;
  evidence: ProbeEvidence | null;
  verification: ProbeVerification;
  receipt: ProbeReceipt;
  limitations: string[];
  requests: number;
  bytes: number;
}

/** Native probe receipt. The engine itself is the tool. */
export function nativeReceipt(reportFormat: string): ProbeReceipt {
  return { tool: 'stripsearch-http-probe', toolVersion: null, generatedAt: null, reportFormat };
}

// ---------------------------------------------------------------------------
// Account links and one-pass correction
// ---------------------------------------------------------------------------

export type LinkState = 'proposed' | 'confirmed' | 'dismissed';

/**
 * Why a link is believed (or doubted). `exact_handle` alone never auto
 * confirms: many unrelated people share a handle.
 */
export type LinkBasis =
  | 'exact_handle'
  | 'display_name'
  | 'cross_link'
  | 'self_declared'
  | 'tool_report'
  | 'manual_review';

export type CorrectionAction = 'confirm' | 'dismiss' | 'reopen';

export interface LinkCorrectionInput {
  linkId: string;
  action: CorrectionAction;
  basis: LinkBasis[];
  note: string | null;
  counterevidence: string | null;
}

export const LINK_BASIS_LABELS: Record<LinkBasis, string> = {
  exact_handle: '用户名一致（不足以确认身份）',
  display_name: '显示名一致（弱证据）',
  cross_link: '已归属来源互链（确定性依据）',
  self_declared: '账号自述与研究对象一致（仍是自述）',
  tool_report: '外部工具报告命中',
  manual_review: '人工复核'
};

export function isTerminalLinkState(state: LinkState): boolean {
  return state === 'confirmed' || state === 'dismissed';
}

/**
 * Only confirmed links may attribute posts or support conclusions. Proposed
 * links stay visible as candidates; dismissed links revoke attribution.
 */
export function attributionFor(state: LinkState): 'linked' | 'unattributed' | 'revoked' {
  if (state === 'confirmed') return 'linked';
  if (state === 'dismissed') return 'revoked';
  return 'unattributed';
}

export function nextLinkState(current: LinkState, action: CorrectionAction): LinkState | null {
  if (action === 'confirm') return current === 'confirmed' ? null : 'confirmed';
  if (action === 'dismiss') return current === 'dismissed' ? null : 'dismissed';
  return isTerminalLinkState(current) ? 'proposed' : null;
}

export function validateCorrection(input: LinkCorrectionInput): { ok: boolean; error: string | null } {
  if (!input.linkId || input.linkId.length > 120) {
    return { ok: false, error: '缺少要修订的账号链接。' };
  }
  if (input.action !== 'confirm' && input.action !== 'dismiss' && input.action !== 'reopen') {
    return { ok: false, error: '修订动作必须是 confirm / dismiss / reopen。' };
  }
  if (input.action !== 'reopen' && input.basis.length === 0) {
    return { ok: false, error: '确认或排除必须给出依据。' };
  }
  if (input.basis.length > 6) {
    return { ok: false, error: '依据不能超过 6 项。' };
  }
  return { ok: true, error: null };
}

export interface CorrectionCandidate {
  linkId: string;
  platformId: string;
  handle: string | null;
  profileUrl: string | null;
  state: LinkState;
  /** Deterministic cross-link evidence: an already attributed source links here. */
  crossLinked: boolean;
  /** The probe that produced the candidate reported found with an exact handle match. */
  exactHandleMatch: boolean;
}

export interface AutoCorrectionProposal {
  linkId: string;
  action: 'confirm';
  basis: LinkBasis[];
  reason: string;
}

export interface AutoCorrectionPlan {
  proposals: AutoCorrectionProposal[];
  needsReview: string[];
}

/**
 * The one-pass correction planner. It only auto-confirms when the basis is
 * deterministic (an already-attributed source links to the candidate profile).
 * Handle equality is recorded as a basis and a recommendation, never as an
 * automatic identity decision — see REVIEW.md for the false-positive cases.
 */
export function planOnePassCorrection(candidates: CorrectionCandidate[]): AutoCorrectionPlan {
  const proposals: AutoCorrectionProposal[] = [];
  const needsReview: string[] = [];
  for (const candidate of candidates) {
    if (candidate.state !== 'proposed') continue;
    if (candidate.crossLinked && candidate.profileUrl) {
      proposals.push({
        linkId: candidate.linkId,
        action: 'confirm',
        basis: ['cross_link'],
        reason: '已归属来源明确互链到该账号主页，作为确定性归属依据。'
      });
      continue;
    }
    needsReview.push(candidate.linkId);
  }
  return { proposals, needsReview };
}

/** Human-facing summary of why a candidate still needs review. */
export function reviewReasonFor(candidate: CorrectionCandidate): string {
  if (candidate.exactHandleMatch) {
    return '用户名一致，但同名/同用户名不等于同一人；请用自述、互链或人工复核确认。';
  }
  return '缺少确定性归属依据；请补充互链或人工复核。';
}

// ---------------------------------------------------------------------------
// Task continuity: stages, checkpoints, budget
// ---------------------------------------------------------------------------

export type DiscoveryStage = 'discover' | 'correct' | 'track' | 'done';

export type DiscoveryTaskState =
  | 'queued'
  | 'discovering'
  | 'correcting'
  | 'tracking'
  | 'needs_input'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type TerminalDiscoveryState = Extract<
  DiscoveryTaskState,
  'completed' | 'partial' | 'failed' | 'cancelled'
>;

export function isTerminalDiscoveryState(state: DiscoveryTaskState): state is TerminalDiscoveryState {
  return state === 'completed' || state === 'partial' || state === 'failed' || state === 'cancelled';
}

export function isActiveDiscoveryState(state: DiscoveryTaskState): boolean {
  return state === 'queued' || state === 'discovering' || state === 'correcting' || state === 'tracking';
}

/**
 * Durable checkpoint. Resume never re-runs a persisted probe: probe keys are
 * stable (subject + platform + method), so a restarted task continues instead
 * of re-billing the same question.
 */
export interface DiscoveryCheckpoint {
  version: 1;
  stage: DiscoveryStage;
  plannedProbeKeys: string[];
  completedProbeKeys: string[];
  trackCursors: Record<string, string | null>;
  finishedLinkIds: string[];
}

export function emptyCheckpoint(): DiscoveryCheckpoint {
  return {
    version: 1,
    stage: 'discover',
    plannedProbeKeys: [],
    completedProbeKeys: [],
    trackCursors: {},
    finishedLinkIds: []
  };
}

export function probeKey(platformId: string, method: ProbeMethod, subject: DiscoverySubject): string {
  return `${subject.kind}:${subject.value}:${platformId}:${method}`;
}

export function remainingProbeKeys(planned: string[], completed: string[]): string[] {
  const done = new Set(completed);
  return planned.filter((key) => !done.has(key));
}

export function stageAfter(stage: DiscoveryStage): DiscoveryStage {
  if (stage === 'discover') return 'correct';
  if (stage === 'correct') return 'track';
  return 'done';
}

export interface DiscoveryLimits {
  maxProbes: number;
  maxPostsPerLink: number;
  maxRequests: number;
  maxBytes: number;
}

export interface DiscoveryUsage {
  probes: number;
  posts: number;
  requests: number;
  bytes: number;
  /** In-flight requests whose billing outcome may never be confirmed. */
  outcomeUnknown: number;
}

export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxProbes: 40,
  maxPostsPerLink: 20,
  maxRequests: 80,
  maxBytes: 2 * 1024 * 1024
};

export function emptyUsage(): DiscoveryUsage {
  return { probes: 0, posts: 0, requests: 0, bytes: 0, outcomeUnknown: 0 };
}

export type BudgetStop = 'max_probes' | 'max_requests' | 'max_bytes' | null;

/** Global request/byte/probe budgets. The post budget is per link and is
 * enforced where link state is known (see the discovery runner). */
export function budgetStop(usage: DiscoveryUsage, limits: DiscoveryLimits): BudgetStop {
  if (usage.probes >= limits.maxProbes) return 'max_probes';
  if (usage.requests >= limits.maxRequests) return 'max_requests';
  if (usage.bytes >= limits.maxBytes) return 'max_bytes';
  return null;
}

// ---------------------------------------------------------------------------
// Deep post tracking
// ---------------------------------------------------------------------------

export type TrackedPostFetchStatus = 'ok' | 'truncated' | 'inaccessible' | 'excluded';

export interface TrackedPostDraft {
  /** Stable across resumes: platform + remote id (or URL when no id exists). */
  postKey: string;
  accountLinkId: string;
  platformId: string;
  url: string;
  title: string;
  publishedAt: string | null;
  excerpt: string | null;
  excerptLocator: string | null;
  fetchStatus: TrackedPostFetchStatus;
  limits: string[];
}

export function trackedPostKey(platformId: string, remoteIdOrUrl: string): string {
  return `${platformId}:${remoteIdOrUrl}`;
}

/** Attribution carried by a tracked post after the current link revision. */
export function postAttribution(
  linkState: LinkState
): { attribution: 'linked' | 'unattributed' | 'revoked'; valid: boolean } {
  const attribution = attributionFor(linkState);
  return { attribution, valid: attribution === 'linked' };
}

// ---------------------------------------------------------------------------
// External tool report parsers (maigret / holehe)
// ---------------------------------------------------------------------------

export type ImportTool = 'maigret' | 'holehe';

export interface ImportParseResult {
  ok: boolean;
  results: ProbeResultDraft[];
  warnings: string[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function importReceipt(
  tool: ImportTool,
  reportFormat: string,
  options: ImportReceiptOptions | undefined
): ProbeReceipt {
  return {
    tool,
    toolVersion: options?.toolVersion ?? null,
    generatedAt: options?.generatedAt ?? null,
    reportFormat
  };
}

export interface ImportReceiptOptions {
  toolVersion?: string | null;
  generatedAt?: string | null;
}

const IMPORT_BASE_LIMITATIONS = ['third_party_report', 'not_rechecked_by_stripsearch'];

/**
 * Map a maigret check status string to a probe status. Unknown spellings never
 * become `found`; they degrade to `unknown` with a warning.
 */
function maigretStatus(raw: string | null, warnings: string[], siteName: string): ProbeStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'claimed':
      return 'found';
    case 'available':
      return 'not_found';
    case 'illegal':
      warnings.push(`${siteName}: 站点拒绝该用户名（Illegal），按 unknown 处理。`);
      return 'unknown';
    case 'unknown':
      return 'unknown';
    default:
      if (raw) warnings.push(`${siteName}: 无法识别的状态 "${raw}"，按 unknown 处理。`);
      return 'unknown';
  }
}

function maigretEntryToResult(
  siteName: string,
  entry: Record<string, unknown>,
  receipt: ProbeReceipt,
  warnings: string[]
): ProbeResultDraft | null {
  if (entry.is_similar === true) {
    warnings.push(`${siteName}: 相似账号结果被丢弃（is_similar）。`);
    return null;
  }
  const statusObject = isRecord(entry.status) ? entry.status : {};
  const statusRaw = str(statusObject.status) ?? (typeof entry.status === 'string' ? entry.status : null);
  const status = maigretStatus(statusRaw, warnings, siteName);
  const handle = str(statusObject.username) ?? str(entry.username);
  const profileUrl = str(statusObject.url) ?? str(entry.url_user);
  const limitations = [...IMPORT_BASE_LIMITATIONS];
  if (str(statusObject.keyword_match_status) === 'Keywords Not Found') {
    limitations.push('keywords_not_found');
  }
  return {
    platformId: normalizePlatformId(siteName),
    method: 'external_report',
    status,
    handle,
    profileUrl,
    evidence: profileUrl ? { url: profileUrl, excerpt: null, locator: 'maigret-report-entry' } : null,
    verification: 'live_unverified',
    receipt,
    limitations,
    requests: 0,
    bytes: 0
  };
}

/**
 * Parse a maigret JSON report. Accepted shapes (verified against maigret's
 * `maigret/report.py` at commit 477b4f42-era main, `generate_json_report`):
 *
 * - "simple": `{ "<sitename>": <entry> }` — only CLAIMED sites appear.
 * - "ndjson": one entry per line, each carrying `sitename`.
 *
 * Entries whose `status.status` is not `Claimed` are still parsed so that
 * `Available` / `Unknown` results keep their honest meaning.
 */
export function parseMaigretReport(
  raw: unknown,
  options?: ImportReceiptOptions & { format?: 'simple' | 'ndjson' }
): ImportParseResult {
  const warnings: string[] = [];
  const receipt = importReceipt('maigret', `maigret-${options?.format ?? 'simple'}`, options);
  const results: ProbeResultDraft[] = [];

  if (options?.format === 'ndjson' && typeof raw === 'string') {
    return parseMaigretNdjson(raw, options);
  }
  if (typeof raw === 'string') {
    return parseMaigretNdjson(raw, options);
  }
  if (!isRecord(raw)) {
    return { ok: false, results: [], warnings, error: 'maigret 报告必须是 JSON 对象或 NDJSON 文本。' };
  }
  for (const [siteName, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      warnings.push(`${siteName}: 条目不是对象，已跳过。`);
      continue;
    }
    const result = maigretEntryToResult(siteName, entry, receipt, warnings);
    if (result) results.push(result);
  }
  return { ok: true, results, warnings, error: null };
}

export function parseMaigretNdjson(
  text: string,
  options?: ImportReceiptOptions
): ImportParseResult {
  const warnings: string[] = [];
  const receipt = importReceipt('maigret', 'maigret-ndjson', options);
  const results: ProbeResultDraft[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      warnings.push('存在无法解析的行，已跳过。');
      continue;
    }
    if (!isRecord(entry)) continue;
    const siteName = str(entry.sitename) ?? str(entry.site_name) ?? 'unknown-site';
    const result = maigretEntryToResult(siteName, entry, receipt, warnings);
    if (result) results.push(result);
  }
  return { ok: true, results, warnings, error: null };
}

/**
 * Parse holehe module output. Accepted shapes (verified against holehe's
 * README "Module Output" section):
 *
 * - a JSON array of module dictionaries
 * - newline-delimited module dictionaries
 * - a single module dictionary
 *
 * `{ "name", "rateLimit", "exists", "emailrecovery", "phoneNumber", "others" }`
 *
 * `emailrecovery` / `phoneNumber` are obfuscated re-contact hints: they are
 * personal data this product does not need, so they are dropped and the drop
 * is recorded as a warning instead of silently kept.
 */
export function parseHoleheReport(
  raw: unknown,
  options?: ImportReceiptOptions
): ImportParseResult {
  const warnings: string[] = [];
  const receipt = importReceipt('holehe', 'holehe-module-json', options);
  const results: ProbeResultDraft[] = [];
  let entries: Record<string, unknown>[] = [];

  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) entries.push(parsed);
      } catch {
        warnings.push('存在无法解析的行，已跳过。');
      }
    }
  } else if (Array.isArray(raw)) {
    entries = raw.filter(isRecord);
  } else if (isRecord(raw)) {
    entries = [raw];
  } else {
    return { ok: false, results: [], warnings, error: 'holehe 报告必须是模块字典、数组或 NDJSON 文本。' };
  }

  for (const entry of entries) {
    const name = str(entry.name);
    if (!name) {
      warnings.push('存在缺少 name 的模块结果，已跳过。');
      continue;
    }
    const rateLimited = bool(entry.rateLimit) === true;
    const exists = bool(entry.exists);
    let status: ProbeStatus;
    if (rateLimited) {
      status = 'blocked';
    } else if (exists === true) {
      status = 'found';
    } else if (exists === false) {
      status = 'not_found';
    } else {
      status = 'unknown';
      warnings.push(`${name}: exists 字段缺失，按 unknown 处理。`);
    }
    const limitations = [...IMPORT_BASE_LIMITATIONS, 'email_registration_probe'];
    if (rateLimited) limitations.push('third_party_rate_limited');
    if (entry.emailrecovery != null || entry.phoneNumber != null) {
      warnings.push(`${name}: 已丢弃恢复邮箱/电话等再联系字段。`);
      limitations.push('recontact_fields_dropped');
    }
    results.push({
      platformId: normalizePlatformId(name),
      method: 'external_report',
      status,
      handle: null,
      profileUrl: null,
      evidence: null,
      verification: 'live_unverified',
      receipt,
      limitations,
      requests: 0,
      bytes: 0
    });
  }
  return { ok: true, results, warnings, error: null };
}

export function parseImportReport(
  tool: ImportTool,
  raw: unknown,
  options?: ImportReceiptOptions & { format?: string }
): ImportParseResult {
  if (tool === 'maigret') {
    return parseMaigretReport(raw, {
      ...options,
      format: options?.format === 'ndjson' ? 'ndjson' : 'simple'
    });
  }
  return parseHoleheReport(raw, options);
}

/** Platform ids are lowercase slugs; imported site names are normalized. */
export function normalizePlatformId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unknown-platform';
}

// ---------------------------------------------------------------------------
// Platform registry rules (shared so the client can render honest capability)
// ---------------------------------------------------------------------------

export type PlatformProbeKind = 'http_status' | 'http_marker';

export interface PlatformProbeRule {
  kind: PlatformProbeKind;
  method: 'GET';
  /** Template with a single `{username}` placeholder. Never user-supplied. */
  urlTemplate: string;
  foundStatuses: number[];
  notFoundStatuses: number[];
  blockedStatuses: number[];
  /** Body markers that confirm presence/absence for `http_marker` probes. */
  foundMarker: string | null;
  notFoundMarker: string | null;
  /** `api_http` when the endpoint is a documented JSON API, else `profile_http`. */
  transport: 'api_http' | 'profile_http';
}

export type PlatformPostsKind = 'none' | 'json_list' | 'rss';

export interface PlatformPostsRule {
  kind: PlatformPostsKind;
  /** Template with `{username}` and optionally `{page}` placeholders. */
  urlTemplate: string;
  maxPages: number;
  /** Dotted path to the array of items for `json_list` ("" = root array). */
  itemsPath: string;
  /** Dotted paths inside one item. */
  fields: {
    id: string | null;
    url: string | null;
    title: string | null;
    publishedAt: string | null;
    excerpt: string | null;
  };
}

export interface PlatformRule {
  platformId: string;
  name: string;
  category: 'code' | 'writing' | 'social' | 'professional' | 'other';
  subjectKinds: DiscoverySubjectKind[];
  homepage: string;
  probe: PlatformProbeRule | null;
  posts: PlatformPostsRule;
  rateLimitPerMinute: number;
  verification: ProbeVerification;
  verificationNote: string;
  notes: string[];
}

export interface PlatformRegistry {
  version: string;
  generatedAt: string;
  rules: PlatformRule[];
}

export function rulesForSubject(
  registry: PlatformRegistry,
  kind: DiscoverySubjectKind
): PlatformRule[] {
  return registry.rules.filter((rule) => rule.subjectKinds.includes(kind) && rule.probe !== null);
}

export function postsRulesFor(
  registry: PlatformRegistry,
  platformId: string
): PlatformPostsRule | null {
  const rule = registry.rules.find((item) => item.platformId === platformId);
  if (!rule || rule.posts.kind === 'none') return null;
  return rule.posts;
}
