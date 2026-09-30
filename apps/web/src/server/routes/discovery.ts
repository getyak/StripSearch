/**
 * Platform discovery HTTP API.
 *
 * Every route is owner-checked; mutations ride the shared Origin middleware.
 * The task detail and export carry receipts and verification labels verbatim:
 * this API never upgrades an imported or unverified result into a fact.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { LIMITS } from '../../shared/limits.js';
import type {
  DiscoveryAuthorization,
  DiscoverySubjectKind,
  ImportTool,
  LinkBasis,
  LinkCorrectionInput,
  PlatformRegistry
} from '../../shared/platform-discovery.js';
import {
  DEFAULT_DISCOVERY_LIMITS,
  DISCOVERY_AUTHORIZATIONS,
  PLATFORM_DISCOVERY_VERSION,
  attributionFor,
  isTerminalDiscoveryState,
  normalizePlatformId,
  normalizeSubject,
  parseImportReport,
  validateSubject
} from '../../shared/platform-discovery.js';
import { isPublicHttpsUrl, validateSeedUrl } from '../../shared/validation.js';
import type { PlatformCatalogSnapshot } from '../../shared/platform-catalog.js';
import { HttpError } from '../http/errors.js';
import { requireUser } from '../http/middleware.js';
import type { DiscoveryStore, DiscoveryTaskRecord } from '../discovery-store.js';
import type { DiscoveryRunner } from '../services/discovery-runner.js';
import { fingerprintDiscoveryTask } from '../services/discovery-runner.js';
import { registrySummary } from '../platforms/registry.js';
import { catalogSummary, platformGaps } from '../platforms/catalog.js';

export interface DiscoveryRouteDeps {
  store: DiscoveryStore;
  runner: DiscoveryRunner;
  registry: PlatformRegistry;
  /** Versioned catalog surface; omitted from the response when null/absent. */
  catalog?: PlatformCatalogSnapshot | null;
}

function readBody(req: Request): Record<string, unknown> {
  const body = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function readIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key');
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 128) : null;
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Large-catalog platform detail paging                                */
/*                                                                     */
/* The authoritative snapshot and summary stay whole; platform DETAIL   */
/* pages are bounded (max 100) with an explicit total and an opaque     */
/* registry-bound cursor. The cursor is a REAL server-bound token: an   */
/* HMAC over (full composed registry identity, offset) keyed by a       */
/* server-owned secret (process-scoped; callers cannot forge payloads), */
/* so tampered cursors are `invalid_cursor` and cursors from another    */
/* registry/bundle identity are `stale_cursor`. Because the key is      */
/* process-scoped, restarts/multi-instance deployments intentionally    */
/* invalidate old cursors (clients resume from the first page).         */

const CATALOG_CURSOR_TAG = 'get91-catalog-cursor/v2';
const CATALOG_PAGE_MAX = 100;
const CATALOG_PAGE_DEFAULT = 100;
const CATALOG_CURSOR_MAX_LENGTH = 512;
const CATALOG_LIMIT_MAX_LENGTH = 4;

const CATALOG_CURSOR_KEY: Buffer = randomBytes(32);

interface CatalogIdentity {
  registryVersion: string;
  contentHash: string;
}

function cursorMac(payload: string): string {
  return createHmac('sha256', CATALOG_CURSOR_KEY).update(`${CATALOG_CURSOR_TAG}\n${payload}`, 'utf8').digest('base64url');
}

export function encodeCatalogCursor(catalog: CatalogIdentity, offset: number): string {
  const payload = JSON.stringify({ v: catalog.registryVersion, h: catalog.contentHash, o: offset });
  return Buffer.from(JSON.stringify({ p: payload, m: cursorMac(payload) }), 'utf8').toString('base64url');
}

export function decodeCatalogCursor(cursor: string, catalog: CatalogIdentity, total: number): number {
  const invalid = (): never => {
    throw new HttpError(400, 'invalid_cursor', '目录分页游标无效，请从第一页重新读取。');
  };
  if (cursor.length === 0 || cursor.length > CATALOG_CURSOR_MAX_LENGTH) return invalid();
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return invalid();
  const { p, m } = envelope as { p?: unknown; m?: unknown };
  if (typeof p !== 'string' || typeof m !== 'string' || p.length > 1024) return invalid();
  // Constant-time-ish comparison of the server-bound MAC.
  const expected = cursorMac(p);
  if (expected.length !== m.length) return invalid();
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ m.charCodeAt(index);
  if (diff !== 0) return invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(p);
  } catch {
    return invalid();
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
  const { v, h, o } = payload as { v?: unknown; h?: unknown; o?: unknown };
  if (typeof v !== 'string' || typeof h !== 'string') return invalid();
  if (typeof o !== 'number' || !Number.isInteger(o) || o < 0) return invalid();
  if (o >= total) return invalid();
  if (v !== catalog.registryVersion || h !== catalog.contentHash) {
    throw new HttpError(400, 'stale_cursor', '目录分页游标属于旧版目录快照（含公共规则包身份），请从第一页重新读取。');
  }
  return o;
}

/** Query values must be single bounded strings — arrays/objects are refused. */
function singleQueryString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, field === 'platformLimit' ? 'invalid_limit' : 'invalid_cursor', `${field} 必须是单个字符串。`);
  }
  if (value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, field === 'platformLimit' ? 'invalid_limit' : 'invalid_cursor', `${field} 取值非法。`);
  }
  return value;
}

function catalogPageWindow(
  req: Request,
  catalog: PlatformCatalogSnapshot
): { limit: number; offset: number } {
  const rawLimit = singleQueryString(req.query.platformLimit, 'platformLimit', CATALOG_LIMIT_MAX_LENGTH);
  let limit = CATALOG_PAGE_DEFAULT;
  if (rawLimit !== null) {
    if (!/^[0-9]{1,4}$/.test(rawLimit)) {
      throw new HttpError(400, 'invalid_limit', 'platformLimit 必须是十进制正整数。');
    }
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new HttpError(400, 'invalid_limit', 'platformLimit 必须是正整数。');
    }
    limit = Math.min(parsed, CATALOG_PAGE_MAX);
  }
  const rawCursor = singleQueryString(req.query.platformCursor, 'platformCursor', CATALOG_CURSOR_MAX_LENGTH);
  const offset = rawCursor !== null ? decodeCatalogCursor(rawCursor, catalog, catalog.entries.length) : 0;
  return { limit, offset };
}

function taskSummary(task: DiscoveryTaskRecord): Record<string, unknown> {
  return {
    taskId: task.id,
    subject: { kind: task.subjectKind, value: task.subjectValue },
    authorization: task.authorization,
    seedUrl: task.seedUrl,
    mode: task.mode,
    state: task.state,
    stage: task.checkpoint.stage,
    registryVersion: task.registryVersion,
    revision: task.revision,
    interrupted: task.interrupted,
    stopReason: task.stopReason,
    needsInputPrompt: task.needsInputPrompt,
    usage: task.usage,
    limits: task.limits,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt
  };
}

export function registerDiscoveryRoutes(router: Router, deps: DiscoveryRouteDeps): void {
  const { store, runner, registry, catalog } = deps;

  /**
   * Honest capability surface: which platforms exist and how verified each
   * rule is. The legacy registry and summary fields are preserved verbatim;
   * when a catalog is wired its versioned snapshot and explicit gaps extend
   * the response without changing old caller behavior.
   */
  router.get('/discovery/registry', (req: Request, res: Response) => {
    const body: Record<string, unknown> = { registry, summary: registrySummary(registry) };
    if (catalog) {
      const { limit, offset } = catalogPageWindow(req, catalog);
      const page = catalog.entries.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      body.catalog = {
        schemaVersion: catalog.schemaVersion,
        registryVersion: catalog.registryVersion,
        contentHash: catalog.contentHash,
        generatedAt: catalog.generatedAt,
        summary: catalogSummary(catalog),
        // Safe public provenance only: versions/hashes/licenses/state of the
        // checked sources. No credentials, owner data or local paths.
        sources: catalog.sources,
        // Bounded platform detail page: explicit total + registry-bound
        // cursor. The first page is NEVER a full-coverage claim.
        platformsTotal: catalog.entries.length,
        platformsNextCursor: nextOffset < catalog.entries.length ? encodeCatalogCursor(catalog, nextOffset) : null,
        platforms: page.map((entry) => ({
          platformId: entry.platformId,
          name: entry.name,
          cohort: entry.cohort,
          aliases: entry.aliases,
          inputKinds: entry.inputKinds,
          instance: entry.instance,
          accountKinds: entry.accountKinds,
          profileUrlRule: entry.profileUrlRule,
          capabilities: entry.capabilities.map((record) => ({
            dimension: record.dimension,
            documentation: record.documentation,
            integration: record.integration,
            access: record.access,
            verification: record.verification,
            verificationRef: record.verificationRef,
            docUrls: record.docUrls,
            endpoints: record.endpoints,
            sourceLocator: record.sourceLocator,
            sourceRefs: record.sourceRefs,
            comments: record.comments ?? null,
            thread: record.thread ?? null,
            pagination: record.pagination ?? null,
            cost: {
              provider: record.cost.provider,
              unit: record.cost.unit,
              currency: record.cost.currency,
              amount: record.cost.amount,
              asOf: record.cost.asOf,
              source: record.cost.source,
              basis: record.cost.basis,
              conditions: record.cost.conditions
            },
            operations: record.operations.map((operation) => ({
              operationId: operation.operationId,
              kind: operation.kind,
              method: operation.method,
              endpoint: operation.endpoint,
              requestBody: operation.requestBody,
              integrated: operation.integrated,
              access: operation.access,
              cost: {
                provider: operation.cost.provider,
                unit: operation.cost.unit,
                currency: operation.cost.currency,
                amount: operation.cost.amount,
                asOf: operation.cost.asOf,
                source: operation.cost.source,
                basis: operation.cost.basis,
                conditions: operation.cost.conditions
              },
              sourceRefs: operation.sourceRefs,
              sourceLocator: operation.sourceLocator,
              notes: operation.notes
            })),
            notes: record.notes
          })),
          routes: entry.routes.map((route) => ({
            routeId: route.routeId,
            kind: route.kind,
            operation: route.operation,
            adapterId: route.adapterId,
            endpoint: route.endpoint,
            requires: route.requires,
            availability: route.availability,
            reason: route.reason,
            sourceRefs: route.sourceRefs,
            ruleIds: route.ruleIds ?? []
          })),
          gaps: platformGaps(entry)
        }))
      };
    }
    res.json(body);
  });

  router.post('/discovery/tasks', (req: Request, res: Response) => {
    const user = requireUser(res);
    const body = readBody(req);
    const rawSubject = (body.subject ?? null) as unknown;
    const subject = normalizeSubject(
      rawSubject !== null && typeof rawSubject === 'object'
        ? rawSubject
        : { kind: body.subjectKind, value: body.subjectValue }
    );
    const subjectCheck = validateSubject(subject);
    if (!subjectCheck.ok) {
      throw new HttpError(400, 'invalid_subject', subjectCheck.error ?? '研究对象无效。');
    }
    const seedCheck = validateSeedUrl(body.seedUrl ?? null);
    if (!seedCheck.ok) {
      throw new HttpError(400, 'invalid_seed_url', seedCheck.error ?? '主页链接无效。');
    }
    if (seedCheck.url && !isPublicHttpsUrl(seedCheck.url)) {
      throw new HttpError(400, 'invalid_seed_url', '种子主页必须是可公开访问的 HTTPS 链接。');
    }
    const rawAuthorization = typeof body.authorization === 'string' ? body.authorization : '';
    if (!DISCOVERY_AUTHORIZATIONS.includes(rawAuthorization as DiscoveryAuthorization)) {
      throw new HttpError(
        400,
        'authorization_required',
        '请声明研究依据：self（本人）、consent_obtained（已获授权）或 public_professional（公开职业人物）。'
      );
    }
    const authorization = rawAuthorization as DiscoveryAuthorization;
    const mode: 'discover' | 'discover_and_track' =
      body.mode === 'discover_and_track' ? 'discover_and_track' : 'discover';

    const gate = runner.checkStartAllowed(user.id);
    if (!gate.allowed) {
      throw new HttpError(429, gate.code ?? 'rate_limited', gate.message ?? '请稍后再试。');
    }

    const fingerprint = fingerprintDiscoveryTask({
      subjectKind: subject.kind,
      subjectValue: subject.value,
      seedUrl: seedCheck.url,
      mode,
      authorization
    });
    const idempotencyKey = readIdempotencyKey(req);
    if (idempotencyKey) {
      const existing = store.findIdempotencyKey(user.id, idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new HttpError(409, 'idempotency_conflict', '同一幂等键提交了不同内容。');
        }
        const prior = store.getTaskForOwner(existing.taskId, user.id);
        if (!prior) throw new HttpError(410, 'task_deleted', '该任务已删除。');
        res.status(200).json({ task: taskSummary(prior), replayed: true });
        return;
      }
    }

    const task = store.insertTask({
      ownerId: user.id,
      subjectKind: subject.kind,
      subjectValue: subject.value,
      authorization,
      seedUrl: seedCheck.url,
      mode,
      registryVersion: registry.version,
      idempotencyKey,
      bodyFingerprint: fingerprint,
      limits: { ...DEFAULT_DISCOVERY_LIMITS }
    });
    if (idempotencyKey) store.recordIdempotencyKey(user.id, idempotencyKey, fingerprint, task.id);
    store.addEvent(task.id, 'created', {
      subject: { kind: subject.kind, value: subject.value },
      authorization,
      mode,
      registryVersion: registry.version
    });
    runner.recordStart(user.id);
    runner.schedule(task.id);
    res.status(201).json({ task: taskSummary(task), replayed: false });
  });

  router.get('/discovery/tasks', (req: Request, res: Response) => {
    const user = requireUser(res);
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), LIMITS.discoveryQueueLimit) : 50;
    const tasks = store.listTasksForOwner(user.id, limit).map(taskSummary);
    res.json({ tasks });
  });

  router.get('/discovery/tasks/:id', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    const links = store.listLinks(task.id).map((link) => ({
      ...link,
      attribution: attributionFor(link.state),
      revisions: store.listLinkRevisions(task.id).filter((rev) => rev.linkId === link.id)
    }));
    res.json({
      task: taskSummary(task),
      checkpoint: task.checkpoint,
      probes: store.listProbes(task.id),
      links,
      posts: store.listPosts(task.id),
      imports: store.listImports(task.id),
      events: store.listEvents(task.id)
    });
  });

  router.post('/discovery/tasks/:id/cancel', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    runner.cancel(task.id);
    const updated = store.getTask(task.id);
    res.json({ task: updated ? taskSummary(updated) : null });
  });

  router.post('/discovery/tasks/:id/resume', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    if (task.state === 'cancelled') {
      throw new HttpError(409, 'task_cancelled', '已取消的任务不能恢复，请新建任务。');
    }
    if (task.state === 'completed') {
      throw new HttpError(409, 'task_completed', '任务已完成，无需恢复。');
    }
    const pending = store.listLinks(task.id).filter((link) => link.state === 'proposed');
    if (pending.length > 0) {
      throw new HttpError(
        409,
        'pending_review',
        '仍有候选账号待确认或排除，请先提交身份修订。',
        { linkIds: pending.map((link) => link.id) }
      );
    }
    if (!runner.resume(task.id)) {
      throw new HttpError(409, 'resume_rejected', '该任务当前不能恢复。');
    }
    res.json({ task: taskSummary(store.getTask(task.id) ?? task) });
  });

  /**
   * The one-pass correction endpoint: a whole batch of confirm / dismiss /
   * reopen decisions applied in one revision, with attribution revocation.
   */
  router.post('/discovery/tasks/:id/corrections', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    const body = readBody(req);
    const rawDecisions = Array.isArray(body.decisions) ? body.decisions : [];
    const decisions: LinkCorrectionInput[] = rawDecisions.slice(0, LIMITS.discoveryCorrectionsMax).map((raw) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const basisRaw = Array.isArray(record.basis) ? record.basis : [];
      const basis = basisRaw
        .filter((item): item is LinkBasis =>
          item === 'exact_handle' ||
          item === 'display_name' ||
          item === 'cross_link' ||
          item === 'self_declared' ||
          item === 'tool_report' ||
          item === 'manual_review'
        )
        .slice(0, 6);
      return {
        linkId: typeof record.linkId === 'string' ? record.linkId.slice(0, 120) : '',
        action: (record.action ?? '') as LinkCorrectionInput['action'],
        basis,
        note: optionalText(record.note, LIMITS.discoveryNoteMax),
        counterevidence: optionalText(record.counterevidence, LIMITS.discoveryCounterevidenceMax)
      };
    });
    if (decisions.length === 0) {
      throw new HttpError(400, 'empty_correction', '至少提交一条修订。');
    }
    try {
      const result = runner.correct(task.id, decisions, `user:${user.id}`);
      res.json({
        task: taskSummary(store.getTask(task.id) ?? task),
        links: result.links.map((link) => ({ ...link, attribution: attributionFor(link.state) })),
        pendingReview: result.pendingReview.map((link) => link.id)
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'CorrectionError') {
        const code = (error as { code?: string }).code ?? 'invalid_correction';
        const status = code === 'link_not_found' || code === 'task_not_found' ? 404 : 400;
        throw new HttpError(status, code, error instanceof Error ? error.message : '修订无效。');
      }
      throw error;
    }
  });

  /** Import an external tool report (maigret / holehe) as probe evidence. */
  router.post('/discovery/tasks/:id/imports', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    const body = readBody(req);
    const rawTool = typeof body.tool === 'string' ? body.tool : '';
    const tool: ImportTool | null = rawTool === 'holehe' ? 'holehe' : rawTool === 'maigret' ? 'maigret' : null;
    if (tool === null) {
      throw new HttpError(400, 'invalid_tool', '报告工具必须是 maigret 或 holehe。');
    }
    const format = body.format === 'ndjson' ? 'ndjson' : 'simple';
    const report = body.report ?? body.reportText ?? null;
    if (report === null || (typeof report !== 'string' && typeof report !== 'object')) {
      throw new HttpError(400, 'invalid_report', '缺少报告内容。');
    }
    const parsed = parseImportReport(tool, report, {
      toolVersion: optionalText(body.toolVersion, 60),
      generatedAt: optionalText(body.generatedAt, 40),
      format
    });
    if (!parsed.ok) {
      throw new HttpError(400, 'invalid_report', parsed.error ?? '报告无法解析。');
    }
    const contentHash = createHash('sha256')
      .update(typeof report === 'string' ? report : JSON.stringify(report))
      .digest('hex');
    const receipt = store.recordImport({
      taskId: task.id,
      tool,
      reportFormat: `${tool}-${format}`,
      toolVersion: optionalText(body.toolVersion, 60),
      generatedAt: optionalText(body.generatedAt, 40),
      resultCount: parsed.results.length,
      warnings: parsed.warnings.slice(0, 50),
      contentHash
    });

    let sortOrder = store.listProbes(task.id).length;
    let linked = 0;
    for (const result of parsed.results.slice(0, LIMITS.discoveryImportReportMax)) {
      const probeKey = `import:${tool}:${normalizePlatformId(result.platformId)}:${contentHash.slice(0, 12)}`;
      store.upsertProbe(task.id, probeKey, result, sortOrder);
      sortOrder += 1;
      if (result.status === 'found') {
        store.upsertLink(task.id, normalizePlatformId(result.platformId), result.handle, result.profileUrl);
        linked += 1;
      }
    }
    store.addEvent(task.id, 'import_applied', {
      tool,
      reportFormat: `${tool}-${format}`,
      contentHash,
      results: parsed.results.length,
      linked,
      warnings: parsed.warnings.slice(0, 10)
    });
    store.updateTask(task.id, { revision: task.revision + 1 });
    res.status(201).json({
      import: receipt,
      results: parsed.results.length,
      linked,
      warnings: parsed.warnings.slice(0, 20),
      task: taskSummary(store.getTask(task.id) ?? task)
    });
  });

  /** Start or continue deep post tracking on confirmed links only. */
  router.post('/discovery/tasks/:id/track', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    const pending = store.listLinks(task.id).filter((link) => link.state === 'proposed');
    if (pending.length > 0) {
      throw new HttpError(
        409,
        'pending_review',
        '仍有候选账号待确认或排除；帖子追踪只读取已确认归属的账号。',
        { linkIds: pending.map((link) => link.id) }
      );
    }
    const confirmed = store.listLinks(task.id).filter((link) => link.state === 'confirmed');
    if (confirmed.length === 0) {
      throw new HttpError(409, 'no_confirmed_links', '没有已确认归属的账号可追踪。');
    }
    if (isTerminalDiscoveryState(task.state) && task.state !== 'partial' && task.state !== 'failed') {
      if (task.state === 'cancelled') {
        throw new HttpError(409, 'task_cancelled', '已取消的任务不能继续。');
      }
    }
    store.updateTask(task.id, {
      mode: 'discover_and_track',
      state: 'queued',
      checkpoint_json: JSON.stringify({ ...task.checkpoint, stage: 'track' }),
      needs_input_prompt: null,
      finished_at: null
    });
    store.addEvent(task.id, 'track_requested', {
      links: confirmed.map((link) => link.platformId)
    });
    runner.schedule(task.id);
    res.json({ task: taskSummary(store.getTask(task.id) ?? task) });
  });

  /** Canonical export: receipts and attribution states travel with the data. */
  router.get('/discovery/tasks/:id/export.json', (req: Request, res: Response) => {
    const user = requireUser(res);
    const task = store.getTaskForOwner(String(req.params.id), user.id);
    if (!task) throw new HttpError(404, 'task_not_found', '未找到该任务。');
    const links = store.listLinks(task.id);
    const linkState = new Map(links.map((link) => [link.id, link.state]));
    res.json({
      schemaVersion: PLATFORM_DISCOVERY_VERSION,
      exportedAt: new Date().toISOString(),
      task: taskSummary(task),
      checkpoint: task.checkpoint,
      probes: store.listProbes(task.id),
      links: links.map((link) => ({
        ...link,
        attribution: attributionFor(link.state),
        revisions: store.listLinkRevisions(task.id).filter((rev) => rev.linkId === link.id)
      })),
      posts: store.listPosts(task.id).map((post) => ({
        ...post,
        valid: attributionFor(linkState.get(post.accountLinkId) ?? 'proposed') === 'linked' && !post.excluded
      })),
      imports: store.listImports(task.id),
      events: store.listEvents(task.id),
      limitations: [
        '探测结果回答平台是否持有匹配账号，不证明身份归属。',
        'live_unverified 结果未经过真实平台复核；不得当作已核实事实。',
        '帖子为列表摘录，正文未抓取。',
        '授权依据为任务创建时的声明，需在合法合规前提下使用。'
      ]
    });
  });
}
