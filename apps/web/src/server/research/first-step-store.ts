/**
 * First-step persistence: run -> CaseStore link, append-only discovery
 * revisions, one atomic version-bound account selection and explicit user
 * exclusion statements.
 *
 * Guarantees (docs/superpowers/specs/2026-10-05-search-first-step-design.md):
 * - The selection transaction binds `run.revision`, `case.scopeVersion` and
 *   `discoveryRevision` plus owner and idempotency key; any mismatch fails
 *   closed and nothing is written. The whole batch commits or rolls back.
 * - A selection never touches identity evidence. An exclusion statement
 *   ("不是此人") is recorded separately from an unchecked box, is revocable,
 *   and revocation never becomes identity support.
 * - Fetch scope is checked before dispatch AND before result ingestion: an
 *   excluded, unselected or later-discovered account can never be auto-read
 *   or become a person conclusion.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import {
  asScopeVersion,
  type AllowedScope,
  type CaseReportView,
  type RecordProvenance,
  type ResearchCase,
  type ScopeVersion,
  type UserSelectionState
} from '../../shared/research-case.js';
import type { ScopeAccountChange } from './case-store.js';
import {
  FIRST_STEP_SCHEMA_VERSION,
  classifyFirstStepUrl,
  validateClusterChoice,
  validateDecisionCompleteness,
  validateFirstStepSelectionInput,
  validateSelectionDecision,
  type FirstStepAccountDecision,
  type FirstStepAccountRef,
  type FirstStepAccountView,
  type FirstStepDiscoveryView,
  type FirstStepEvidenceView,
  type FirstStepFrozenPlan,
  type FirstStepInput,
  type FirstStepPhase,
  type FirstStepSelectionInput,
  type FirstStepSelectionStateView
} from '../../shared/first-step-discovery.js';
import type { IdentityCandidate } from '../../shared/types.js';
import type { FirstStepBinding, ResearchCheckpoint } from './research-store.js';
import type { Store } from '../store.js';
import {namedOwnerQuote,normalizedPersonName} from './named-owner.js';
import type {ResearchToolAction,ResearchToolResult} from './tool-contracts.js';

export type FirstStepErrorCode =
  | 'run_not_found'
  | 'not_first_step'
  | 'run_not_waiting'
  | 'stale_run_revision'
  | 'stale_scope_version'
  | 'stale_discovery_revision'
  | 'foreign_account'
  | 'incomplete_batch'
  | 'invalid_cluster'
  | 'empty_selection'
  | 'expand_not_allowed'
  | 'invalid_decision'
  | 'idempotency_conflict'
  | 'scope_changed'
  | 'out_of_scope';

export class FirstStepSelectionError extends Error {
  constructor(readonly code: FirstStepErrorCode, readonly detail: string) {
    super(detail);
    this.name = 'FirstStepSelectionError';
  }
}

/** Honest provenance for user-initiated public discovery: intent confirmed, identity not. */
export function firstStepProvenance(note: string): RecordProvenance {
  return {
    authorization: 'user_confirmed',
    collector: 'first-step-discovery',
    note: `${note} 身份归属仍是提议，未经用户确认。`
  };
}

export function firstStepAccountId(caseId: string, accountKey: string): string {
  return `acct_fs_${createHash('sha256').update(`${caseId}|${accountKey}`).digest('hex').slice(0, 24)}`;
}

export interface FirstStepLinkRecord {
  runId: string;
  caseId: string;
  inputRevision: number;
  discoveryRevision: number;
  selectionRevision: number;
  phase: FirstStepPhase;
  /** Manual hint for the next discovery revision; never identity evidence. */
  hint: string | null;
  selectionScopeVersion: number | null;
  selectionDiscoveryRevision: number | null;
  selectedAccountIds: string[];
  excludedAccountIds: string[];
  submittedAt: string | null;
}

export interface FirstStepDiscoveryRecord {
  runId: string;
  discoveryRevision: number;
  input: FirstStepInput;
  plan: FirstStepFrozenPlan;
  view: FirstStepDiscoveryView;
  createdAt: string;
}

export type FirstStepViewResult =
  | { mode: 'first_step'; view: FirstStepDiscoveryView; link: FirstStepLinkRecord }
  | { mode: 'legacy'; candidates: IdentityCandidate[]; prompt: string | null }
  | null;

export interface FirstStepSelectionResult {
  runRevision: number;
  scopeVersion: ScopeVersion;
  discoveryRevision: number;
  /** Bound person cluster; null = independent-only scope. */
  clusterId: string | null;
  selectedAccountIds: string[];
  independentAccountIds: string[];
  excludedAccountIds: string[];
  submittedAt: string;
  idempotent: boolean;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function fingerprintOf(input: FirstStepSelectionInput): string {
  return createHash('sha256').update(JSON.stringify({
    expectedRunRevision: input.expectedRunRevision,
    expectedScopeVersion: input.expectedScopeVersion,
    discoveryRevision: input.discoveryRevision,
    clusterId: input.clusterId,
    accounts: [...input.accounts].sort((a, b) => a.accountId.localeCompare(b.accountId))
  })).digest('hex');
}

interface LinkRow {
  run_id: string;
  case_id: string;
  input_revision: number;
  discovery_revision: number;
  selection_revision: number;
  phase: string;
  hint: string | null;
  selection_scope_version: number | null;
  selection_discovery_revision: number | null;
  selected_json: string;
  excluded_json: string;
  submitted_at: string | null;
}

function mapLink(row: LinkRow): FirstStepLinkRecord {
  return {
    runId: row.run_id,
    caseId: row.case_id,
    inputRevision: row.input_revision,
    discoveryRevision: row.discovery_revision,
    selectionRevision: row.selection_revision,
    phase: row.phase as FirstStepPhase,
    hint: row.hint && row.hint.length > 0 ? row.hint : null,
    selectionScopeVersion: row.selection_scope_version,
    selectionDiscoveryRevision: row.selection_discovery_revision,
    selectedAccountIds: parseJson<string[]>(row.selected_json, []),
    excludedAccountIds: parseJson<string[]>(row.excluded_json, []),
    submittedAt: row.submitted_at
  };
}

export class FirstStepStore {
  constructor(private readonly db: DB, private readonly store: Store) {}

  private get cases() {
    return this.store.cases;
  }

  link(runId: string): FirstStepLinkRecord | null {
    const row = this.db.prepare('SELECT * FROM first_step_links WHERE run_id = ?').get(runId) as LinkRow | undefined;
    return row ? mapLink(row) : null;
  }

  /** Attach a fresh run to a new case. One link per run; never re-attached. */
  attachRun(run: { id: string; ownerId: string; question: string }, intent?: string): FirstStepLinkRecord {
    return this.db.transaction(() => {
      const existing = this.link(run.id);
      if (existing) return existing;
      const record = this.cases.createCase({
        ownerId: run.ownerId,
        intent: intent ?? run.question,
        provenance: firstStepProvenance('用户提交姓名或公开链接，启动第一步公开检索。')
      });
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO first_step_links (
            run_id, case_id, input_revision, discovery_revision, selection_revision, phase,
            selection_scope_version, selection_discovery_revision, selected_json, excluded_json,
            submitted_at, created_at, updated_at
          ) VALUES (?, ?, 1, 0, 0, 'freezing', NULL, NULL, '[]', '[]', NULL, ?, ?)`
        )
        .run(run.id, record.caseId, timestamp, timestamp);
      return this.link(run.id)!;
    })();
  }

  currentDiscovery(runId: string): FirstStepDiscoveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM first_step_discoveries WHERE run_id = ? ORDER BY discovery_revision DESC LIMIT 1')
      .get(runId) as
      | { run_id: string; discovery_revision: number; input_json: string; plan_json: string; view_json: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      discoveryRevision: row.discovery_revision,
      input: parseJson<FirstStepInput>(row.input_json, { kind: 'name_query', value: '' }),
      plan: parseJson<FirstStepFrozenPlan>(row.plan_json, {
        frozenAt: row.created_at,
        input: { kind: 'name_query', value: '' },
        registryVersion: 'unknown',
        contentHash: null,
        policyVersion: 'first-step/v2',
        budget: { maxSearchQueries: 0, maxSearchResults: 0, maxProfileReads: 0, maxModelCalls: 0, policyVersion: 'first-step/v2' },
        obligations: []
      }),
      view: parseJson<FirstStepDiscoveryView>(row.view_json, null as unknown as FirstStepDiscoveryView),
      createdAt: row.created_at
    };
  }

  discoveryRevisionCount(runId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM first_step_discoveries WHERE run_id = ?').get(runId) as { n: number }).n;
  }

  /**
   * Append one immutable discovery revision and bind it to a fresh run
   * revision in the same transaction. The stored view is the authoritative
   * projection; later reads only refresh live user facets.
   */
  appendDiscoveryRevision(input: {
    runId: string;
    input: FirstStepInput;
    plan: FirstStepFrozenPlan;
    view: FirstStepDiscoveryView;
    phase: FirstStepPhase;
    readyForChoice: boolean;
    stopReason: string | null;
  }): FirstStepDiscoveryRecord {
    return this.db.transaction(() => {
      const link = this.link(input.runId);
      if (!link) throw new FirstStepSelectionError('not_first_step', '该研究没有第一步发现记录。');
      const revision = link.discoveryRevision + 1;
      const timestamp = nowIso();
      const view: FirstStepDiscoveryView = {
        ...input.view,
        runId: input.runId,
        caseId: link.caseId,
        discoveryRevision: revision,
        inputRevision: link.inputRevision,
        phase: input.phase,
        readyForChoice: input.readyForChoice,
        stopReason: input.stopReason,
        updatedAt: timestamp
      };
      this.db
        .prepare(
          'INSERT INTO first_step_discoveries (run_id, discovery_revision, input_json, plan_json, view_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(input.runId, revision, JSON.stringify(input.input), JSON.stringify(input.plan), JSON.stringify(view), timestamp);
      this.db
        .prepare('UPDATE first_step_links SET discovery_revision = ?, phase = ?, updated_at = ? WHERE run_id = ?')
        .run(revision, input.phase, timestamp, input.runId);
      const run = this.store.getRun(input.runId);
      if (run) {
        this.store.updateRun(input.runId, { revision: run.revision + 1 });
        this.store.addEvent(input.runId, 'first_step_discovery', {
          discoveryRevision: revision,
          phase: input.phase,
          readyForChoice: input.readyForChoice,
          stopReason: input.stopReason
        });
      }
      return {
        runId: input.runId,
        discoveryRevision: revision,
        input: input.input,
        plan: input.plan,
        view,
        createdAt: timestamp
      };
    })();
  }

  /**
   * Record one discovered account as an `unanswered` case account. Discovery
   * never implies a user selection. The write is bound to the caller's frozen
   * `expectedScopeVersion`, so a late result arriving after a selection or a
   * person change fails with StaleScopeError instead of writing.
   */
  recordDiscoveredAccount(input: {
    ownerId: string;
    caseId: string;
    expectedScopeVersion: ScopeVersion;
    ref: FirstStepAccountRef;
    displayName: string | null;
    personName?: string;
    researchSummary: string;
    researchValue: { state: 'unassessed' | 'high' | 'medium' | 'low'; rationale: string | null };
    accessCoverage: { state: 'unassessed' | 'inaccessible' | 'partial' | 'capped' | 'interface_complete'; earliestReadAt: string | null; note: string | null };
  }): string {
    const accountId = firstStepAccountId(input.caseId, input.ref.accountKey);
    const existing = this.cases.listAccounts(input.ownerId, input.caseId).find((a) => a.accountId === accountId);
    if (existing) {
      this.cases.updateAccountFacets(
        { ownerId: input.ownerId, caseId: input.caseId, accountId, expectedScopeVersion: input.expectedScopeVersion },
        { researchValue: input.researchValue, accessCoverage: input.accessCoverage }
      );
      return accountId;
    }
    this.cases.addAccount(
      { ownerId: input.ownerId, caseId: input.caseId, accountId, expectedScopeVersion: input.expectedScopeVersion },
      {
        accountId,
        platform: input.ref.platform,
        handle: input.ref.handle,
        profileUrl: input.ref.profileUrl,
        identitySupport: { state: 'proposed', evidenceIds: [], counterevidenceIds: [], policyVersion: 'first-step/v1', note: null,
          ...(input.personName?{ownerAnchor:{state:'unbound',personLabel:input.personName,policyVersion:'named-owner/v1',claims:[],counterevidenceIds:[]}}:{}) },
        userSelection: { state: 'unanswered', note: null, recordedAt: null },
        allowedScope: { state: 'none', note: null },
        researchValue: input.researchValue,
        accessCoverage: input.accessCoverage
      }
    );
    void input.displayName;
    void input.researchSummary;
    return accountId;
  }

  /**
   * Record one real identity observation as case evidence. The source is
   * keyed by the observed page URL per account, so repeated reads of one page
   * append revisions of the SAME source and never count as independent
   * evidence. Quotes without a real retrieval receipt are rejected by the
   * caller; this method only stores what it is given.
   */
  recordIdentityObservation(input: {
    ownerId: string;
    caseId: string;
    accountId: string;
    expectedScopeVersion: ScopeVersion;
    source: { url: string; title: string; author: string | null; retrievedAt: string; contentHash: string; locator: string | null };
    role: 'identity_support' | 'identity_counterevidence';
    quote: string;
    evidenceLocator: string | null;
  }): { evidenceId: string; sourceId: string; sourceRevision: number; duplicate: boolean } {
    // Identity evidence needs an actually stored quoted span; an empty quote
    // can never become identity_support or identity_counterevidence.
    if (typeof input.quote !== 'string' || input.quote.trim().length < 2) {
      throw new FirstStepSelectionError('invalid_decision', '身份依据必须携带实际摘录文本。');
    }
    const ctx = {
      ownerId: input.ownerId,
      caseId: input.caseId,
      accountId: input.accountId,
      expectedScopeVersion: input.expectedScopeVersion
    };
    return this.db.transaction(() => {
      // Same URL under one account = one source: repeats append revisions.
      const found = this.db
        .prepare(
          `SELECT s.id AS source_id, s.latest_revision AS revision FROM research_case_sources s
           JOIN research_case_source_revisions r ON r.source_id = s.id
           WHERE s.case_id = ? AND s.account_id = ? AND r.original_url = ?
           ORDER BY s.created_at ASC LIMIT 1`
        )
        .get(input.caseId, input.accountId, input.source.url) as { source_id: string; revision: number } | undefined;
      const existingEvidence = this.db
        .prepare(
          `SELECT e.id FROM research_case_evidence e
           JOIN research_case_source_revisions r ON r.source_id=e.source_id AND r.revision=e.source_revision
           WHERE e.case_id = ? AND e.account_id = ? AND e.role = ? AND e.quote = ? AND e.revoked_at IS NULL
           AND r.original_url = ? AND r.content_hash = ?`
        )
        .get(input.caseId, input.accountId, input.role, input.quote,input.source.url,input.source.contentHash) as { id: string } | undefined;
      if (found && existingEvidence) {
        return { evidenceId: existingEvidence.id, sourceId: found.source_id, sourceRevision: found.revision, duplicate: true };
      }
      const revision = this.cases.recordSourceRevision(ctx, {
        ...(found ? { sourceId: found.source_id } : {}),
        author: input.source.author,
        originalUrl: input.source.url,
        title: input.source.title,
        publishedAt: null,
        retrievedAt: input.source.retrievedAt,
        locator: input.source.locator,
        contentHash: input.source.contentHash,
        provenance: firstStepProvenance('公开页面身份线索读取记录。')
      });
      const evidence = this.cases.addEvidence(ctx, {
        sourceId: revision.sourceId,
        sourceRevision: revision.sourceRevision,
        role: input.role,
        quote: input.quote,
        locator: input.evidenceLocator,
        provenance: firstStepProvenance('公开页面身份线索摘录。')
      });
      const account = this.cases.listAccounts(input.ownerId, input.caseId).find((a) => a.accountId === input.accountId);
      if (account) {
        const support = account.identitySupport;
        const evidenceIds = input.role === 'identity_support' ? [...new Set([...support.evidenceIds, evidence.evidenceId])] : support.evidenceIds;
        const counterevidenceIds =
          input.role === 'identity_counterevidence' ? [...new Set([...support.counterevidenceIds, evidence.evidenceId])] : support.counterevidenceIds;
        const state =
          evidenceIds.length > 0 && counterevidenceIds.length > 0
            ? 'disputed'
            : evidenceIds.length > 0
              ? 'supported'
              : counterevidenceIds.length > 0
                ? 'rejected'
                : 'proposed';
        this.cases.updateAccountFacets(ctx, {
          identitySupport: { ...support, state, evidenceIds, counterevidenceIds }
        });
      }
      return { evidenceId: evidence.evidenceId, sourceId: revision.sourceId, sourceRevision: revision.sourceRevision, duplicate: false };
    })();
  }

  /** Derive the named self-claim from the saved original receipt, not a model or title. */
  recordNamedOwner(input:{ownerId:string;runId:string;caseId:string;accountId:string;expectedScopeVersion:ScopeVersion;personName:string;receiptKey:string;pageUrl:string}):void {
    const link=this.link(input.runId),run=this.store.getRun(input.runId);
    if(link?.caseId!==input.caseId||run?.ownerId!==input.ownerId)throw new FirstStepSelectionError('foreign_account','姓名归属回执不属于当前研究。');
    const receipt=this.store.research.receipts(input.runId).find(row=>row.key===input.receiptKey&&row.kind==='tool'&&row.state==='completed');
    const page=(receipt?.result as ResearchToolResult|undefined)?.pages?.find(page=>page.url===input.pageUrl);
    const account=this.cases.listAccounts(input.ownerId,input.caseId).find(account=>account.accountId===input.accountId);
    const observed=classifyFirstStepUrl(input.pageUrl),stored=account?.profileUrl?classifyFirstStepUrl(account.profileUrl):null;
    if(!receipt||!page||!account||!observed.ok||!stored?.ok||observed.ref.accountKey!==stored.ref.accountKey)return;
    const owner=namedOwnerQuote(page,receipt.request as ResearchToolAction,input.personName);
    if(!owner)return;
    this.db.transaction(()=>{
      const ctx={ownerId:input.ownerId,caseId:input.caseId,accountId:input.accountId,expectedScopeVersion:input.expectedScopeVersion};
      const hash=createHash('sha256').update(page.text).digest('hex');
      const prior=this.cases.reportView(input.ownerId,input.caseId).sources.find(source=>source.accountId===input.accountId&&source.revisions.some(revision=>revision.originalUrl===page.url));
      const matching=prior?.revisions.find(revision=>revision.contentHash===hash&&revision.originalUrl===page.url);
      const revision=matching??this.cases.recordSourceRevision(ctx,{...(prior?{sourceId:prior.sourceId}:{}),author:page.author??null,originalUrl:page.url,title:page.title,publishedAt:null,retrievedAt:receipt.createdAt,locator:null,contentHash:hash,provenance:firstStepProvenance('账号姓名自述；未经独立验证。')});
      const existing=this.cases.reportView(input.ownerId,input.caseId).evidence.find(evidence=>evidence.accountId===input.accountId&&evidence.sourceId===revision.sourceId&&evidence.sourceRevision===revision.sourceRevision&&evidence.role==='owner_declaration'&&evidence.quote===owner.quote&&evidence.revokedAt===null);
      const evidence=existing??this.cases.addEvidence(ctx,{sourceId:revision.sourceId,sourceRevision:revision.sourceRevision,role:'owner_declaration',quote:owner.quote,locator:`原文第 ${owner.offset+1}–${owner.offset+owner.quote.length} 字符`,provenance:firstStepProvenance('原生姓名字段或第一人称姓名原文；仅为自述。')});
      const previous=account.identitySupport.ownerAnchor;
      if(previous&&normalizedPersonName(previous.personLabel)!==normalizedPersonName(input.personName))throw new FirstStepSelectionError('invalid_decision','已有姓名声明属于其他姓名；不能隐式覆盖原声明或反证。');
      const claims=previous?[...previous.claims]:[];
      if(!claims.some(claim=>claim.evidenceId===evidence.evidenceId))claims.push({evidenceId:evidence.evidenceId,kind:'owner_self_declaration',sourceReceiptKey:receipt.key,sourceContentHash:hash,quoteOffset:owner.offset,...(owner.nativeField?{nativeField:owner.nativeField}:{})});
      const counterevidenceIds=previous?.counterevidenceIds??[];
      this.cases.updateAccountFacets(ctx,{identitySupport:{...account.identitySupport,ownerAnchor:{state:counterevidenceIds.length?'disputed':claims.some(claim=>claim.kind==='publisher_named_biography')?'independently_supported':'self_declared',personLabel:previous?.personLabel??input.personName,policyVersion:'named-owner/v1',claims,counterevidenceIds}}});
    })();
  }

  setPhase(runId: string, phase: FirstStepPhase): void {
    this.db.prepare('UPDATE first_step_links SET phase = ?, updated_at = ? WHERE run_id = ?').run(phase, nowIso(), runId);
  }

  /** Manual hint for the next discovery revision; recorded, never evidence. */
  setHint(runId: string, hint: string): void {
    this.db.prepare('UPDATE first_step_links SET hint = ?, input_revision = input_revision + 1, updated_at = ? WHERE run_id = ?').run(hint.slice(0, 500), nowIso(), runId);
  }

  /**
   * Authoritative read. A first-step run returns the latest immutable
   * discovery projection with live user facets overlaid; a historical run
   * without a link stays on the legacy projection and can never be silently
   * presented as a new search result.
   */
  getFirstStepView(ownerId: string, runId: string): FirstStepViewResult {
    const run = this.store.getRunForOwner(runId, ownerId);
    if (!run) return null;
    const link = this.link(runId);
    if (!link) {
      const checkpoint: ResearchCheckpoint | null = this.store.research.checkpoint(runId);
      return {
        mode: 'legacy',
        candidates: checkpoint?.candidates ?? [],
        prompt: checkpoint?.phase === 'needs_input' ? '请确认你要研究的公开主页。' : null
      };
    }
    const liveScopeVersion = this.cases.getCase(ownerId, link.caseId)?.scopeVersion ?? 0;
    const current = this.currentDiscovery(runId);
    if (!current) {
      const view = this.emptyView(link, liveScopeVersion);
      if (run.errorMessage) view.gaps = [run.errorMessage];
      view.stopReason = run.stopReason;
      return { mode: 'first_step', view, link };
    }
    let accounts = this.projectCurrentAccounts(ownerId, link.caseId, current.view.accounts);
    const activeEvidence = new Set(accounts.flatMap(account => [...account.identity.evidence, ...account.identity.counterevidence].map(item => item.evidenceId)));
    const original = new Map(current.view.accounts.map(account => [account.accountId, account]));
    const invalidClusters = new Set(current.view.clusters.filter(cluster => cluster.accountIds.some(id => {
      const account = accounts.find(item => item.accountId === id);
      return account?.identity.validity === 'review' || original.get(id)?.identity.state === 'supported' && account?.identity.state !== 'supported';
    })).map(cluster => cluster.clusterId));
    const invalidMembership = new Set(current.view.clusters.filter(cluster => invalidClusters.has(cluster.clusterId)).flatMap(cluster => cluster.accountIds));
    const dependencyReason = '人物关联路径中的归属依据已失效；账号自身材料仍可独立研究，请重新确认人物关联。';
    accounts = accounts.map(account => invalidMembership.has(account.accountId) ? { ...account,
      identity: { ...account.identity, validity: 'review' as const, reviewReason: account.identity.reviewReason ?? dependencyReason,
        conflicts: [...new Set([...account.identity.conflicts, dependencyReason])] },
      defaultSuggestion: { suggested: false, reason: dependencyReason }, requiresIndependentScope: true } : account);
    const exclusions = this.activeExclusions(runId);
    const view: FirstStepDiscoveryView = {
      ...current.view,
      // The live link phase is authoritative: after a submitted selection the
      // projection advances to the fetch stage instead of replaying
      // ready_for_choice from the stored revision.
      phase: link.phase,
      readyForChoice: link.phase === 'ready_for_choice',
      accounts,
      clusters: current.view.clusters.map(cluster => ({ ...cluster,
        ...(invalidClusters.has(cluster.clusterId) ? { conflicts: [...new Set([...cluster.conflicts, dependencyReason])], leads: [] } : {
          leads: cluster.leads.filter(lead => lead.evidenceIds.every(id => activeEvidence.has(id))) }) })),
      selection: this.selectionState(link, liveScopeVersion)
    };
    void exclusions;
    return { mode: 'first_step', view, link };
  }

  /** Re-derive dependency validity without rewriting stored evidence or facets. */
  private projectCurrentAccounts(ownerId: string, caseId: string, stored: readonly FirstStepAccountView[]): FirstStepAccountView[] {
    const report=this.cases.reportView(ownerId,caseId);
    const live = new Map(report.accounts.map(account => [account.accountId, account]));
    const evidence = this.accountEvidenceViews(ownerId, caseId);
    return stored.map(account => {
      const current = live.get(account.accountId);
      if (!current) return account;
      const valid = current.identityValidity === 'valid';
      const ownerValid=current.ownerValidity!=='review'&&!['disputed','contradicted'].includes(current.identitySupport.ownerAnchor?.state??'unbound');
      const active = evidence.get(account.accountId) ?? [];
      return { ...account,
        identity: { ...account.identity, state: current.identitySupport.state,
          validity: valid ? 'valid' : 'review', reviewReason: current.identityReviewReason,
          evidence: active.filter(item => item.role === 'identity_support'),
          counterevidence: active.filter(item => item.role === 'identity_counterevidence'),
          conflicts: [...account.identity.conflicts, ...valid ? [] : [current.identityReviewReason ?? '原归属依据已失效，请重新核对。']],
          ...this.ownerView(ownerId,caseId,account.accountId,report) },
        defaultSuggestion: valid && ownerValid && current.identitySupport.state === 'supported' && active.some(item => item.role === 'identity_support' && current.identitySupport.evidenceIds.includes(item.evidenceId))
          ? account.defaultSuggestion : { suggested: false, reason: !ownerValid?'姓名归属依据已失效或存在冲突，不再默认推荐。':valid ? '当前没有有效归属支撑，不默认推荐。' : '原归属依据已失效，不再默认推荐。' },
        requiresIndependentScope: account.requiresIndependentScope || !valid || !ownerValid || current.identitySupport.state !== 'supported',
        userSelection: current.userSelection, allowedScope: current.allowedScope,
        researchValue: current.researchValue, accessCoverage: current.accessCoverage };
    });
  }

  ownerView(ownerId:string,caseId:string,accountId:string,snapshot?:CaseReportView):Pick<FirstStepAccountView['identity'],'ownerAnchor'|'ownerValidity'|'ownerReviewReason'|'ownerEvidence'> {
    const report=snapshot??this.cases.reportView(ownerId,caseId),account=report.accounts.find(account=>account.accountId===accountId),anchor=account?.identitySupport.ownerAnchor;
    if(!anchor)return {};
    return {ownerAnchor:anchor,ownerValidity:account!.ownerValidity,ownerReviewReason:account!.ownerReviewReason,
      ownerEvidence:[...anchor.claims.map(claim=>claim.evidenceId),...anchor.counterevidenceIds].flatMap(id=>{
        const evidence=report.evidence.find(evidence=>evidence.evidenceId===id);
        if(!evidence)return [];
        const source=report.sources.find(source=>source.sourceId===evidence.sourceId)?.revisions.find(revision=>revision.sourceRevision===evidence.sourceRevision);
        return [{evidenceId:evidence.evidenceId,quote:evidence.quote,sourceUrl:source?.originalUrl??'',sourceTitle:source?.title??evidence.sourceId,revoked:evidence.revokedAt!==null}];
      })};
  }

  private selectionState(link: FirstStepLinkRecord, liveScopeVersion: number): FirstStepSelectionStateView {
    return {
      // Authoritative live CaseStore version: the selection must echo exactly
      // this value. The frozen version of a submitted selection is separate.
      scopeVersion: liveScopeVersion,
      frozenScopeVersion: link.selectionScopeVersion,
      submitted: link.submittedAt !== null,
      submittedAt: link.submittedAt,
      selectedAccountIds: link.selectedAccountIds,
      excludedAccountIds: link.excludedAccountIds
    };
  }

  private emptyView(link: FirstStepLinkRecord, liveScopeVersion: number): FirstStepDiscoveryView {
    return {
      schemaVersion: FIRST_STEP_SCHEMA_VERSION,
      runId: link.runId,
      caseId: link.caseId,
      discoveryRevision: link.discoveryRevision,
      inputRevision: link.inputRevision,
      registryVersion: 'unknown',
      catalogHash: null,
      policyVersion: 'first-step/v2',
      phase: link.phase,
      stopReason: null,
      readyForChoice: false,
      input: { kind: 'name_query', value: '' },
      clusters: [],
      accounts: [],
      relatedLeads: [],
      routes: [],
      gaps: [],
      receipts: [],
      budget: { toolCalls: 0, modelCalls: 0, estimatedUsd: 0, unknownCost: true },
      selection: this.selectionState(link, liveScopeVersion),
      updatedAt: nowIso()
    };
  }

  activeExclusions(runId: string): Array<{ accountId: string; statement: string; recordedAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM first_step_exclusions WHERE run_id = ? AND revoked_at IS NULL ORDER BY recorded_at')
      .all(runId) as Array<{ account_id: string; statement: string; recorded_at: string }>;
    return rows.map((row) => ({ accountId: row.account_id, statement: row.statement, recordedAt: row.recorded_at }));
  }

  /**
   * All active identity evidence of the case, projected from the PERSISTED
   * rows with their real source revisions. Repeated discovery attempts keep
   * showing the existing evidence instead of losing the inspector.
   */
  accountEvidenceViews(ownerId: string, caseId: string): Map<string, FirstStepEvidenceView[]> {
    const out = new Map<string, FirstStepEvidenceView[]>();
    if (!this.cases.getCase(ownerId, caseId)) return out;
    const rows = this.db
      .prepare('SELECT * FROM research_case_evidence WHERE case_id = ? AND revoked_at IS NULL ORDER BY sort_order, id')
      .all(caseId) as Array<{
      id: string;
      case_id: string;
      account_id: string;
      source_id: string;
      source_revision: number;
      role: 'identity_support' | 'identity_counterevidence';
      quote: string;
      locator: string | null;
      created_at: string;
    }>;
    for (const row of rows) {
      if (row.role !== 'identity_support' && row.role !== 'identity_counterevidence') continue;
      const revision = this.db
        .prepare(
          `SELECT r.original_url, r.title, r.retrieved_at, r.locator FROM research_case_source_revisions r
           WHERE r.source_id = ? AND r.revision = ?`
        )
        .get(row.source_id, row.source_revision) as
        | { original_url: string; title: string; retrieved_at: string; locator: string | null }
        | undefined;
      const list = out.get(row.account_id) ?? [];
      list.push({
        evidenceId: row.id,
        sourceId: row.source_id,
        sourceRevision: row.source_revision,
        sourceUrl: revision?.original_url ?? '',
        sourceTitle: revision?.title ?? row.source_id,
        sourceLocator: revision?.locator ?? null,
        sourceRetrievedAt: revision?.retrieved_at ?? row.created_at,
        role: row.role,
        quote: row.quote,
        locator: row.locator,
        retrieval: 'read',
        label: `来源《${revision?.title ?? row.source_id}》的原文摘录`,
        limitation:
          row.role === 'identity_counterevidence'
            ? '否认声明来自来源原文；保留上下文，不代表其他依据自动失效。'
            : '出链/声明为来源原文摘录；归属线索不能证明跨平台同一人。',
        observedAt: row.created_at
      });
      out.set(row.account_id, list);
    }
    return out;
  }

  /**
   * The single atomic selection path. Every version, owner and account bound
   * is checked before anything is written; the case scope change, run update,
   * checkpoint binding, exclusion statements and the idempotency receipt
   * commit together or not at all.
   */
  applyFirstStepSelection(
    ownerId: string,
    runId: string,
    raw: unknown,
    idempotencyKey: string | null
  ): FirstStepSelectionResult {
    const validated = validateFirstStepSelectionInput(raw);
    if (!validated.ok) throw new FirstStepSelectionError('invalid_decision', validated.error);
    const input = validated.input;
    const fingerprint = fingerprintOf(input);
    return this.db.transaction((): FirstStepSelectionResult => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM first_step_selections WHERE owner_id = ? AND idempotency_key = ?')
          .get(ownerId, idempotencyKey) as { fingerprint: string; result_json: string; run_id: string } | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.run_id !== runId) {
            throw new FirstStepSelectionError('idempotency_conflict', '同一幂等键已用于不同的选择请求。');
          }
          return { ...parseJson<FirstStepSelectionResult>(existing.result_json, null as unknown as FirstStepSelectionResult), idempotent: true };
        }
      }
      const run = this.store.getRunForOwner(runId, ownerId);
      if (!run) throw new FirstStepSelectionError('run_not_found', '未找到该研究。');
      const link = this.link(runId);
      if (!link) throw new FirstStepSelectionError('not_first_step', '该研究不是第一步发现作业。');
      if (run.state !== 'needs_input') {
        throw new FirstStepSelectionError('run_not_waiting', '该研究不在等待范围确认状态。');
      }
      if (run.revision !== input.expectedRunRevision) {
        throw new FirstStepSelectionError('stale_run_revision', '研究已更新，请刷新后重新提交。');
      }
      const record = this.currentDiscovery(runId);
      if (!record || record.discoveryRevision !== input.discoveryRevision) {
        throw new FirstStepSelectionError('stale_discovery_revision', '发现结果已更新，请刷新后重新提交。');
      }
      const caseRecord = this.cases.getCase(ownerId, link.caseId);
      if (!caseRecord) throw new FirstStepSelectionError('run_not_found', '未找到该研究的案例。');
      if (caseRecord.scopeVersion !== input.expectedScopeVersion) {
        throw new FirstStepSelectionError('stale_scope_version', '研究范围已更新，请刷新后重新提交。');
      }
      const currentAccounts = this.projectCurrentAccounts(ownerId, link.caseId, record.view.accounts);
      const known = new Map(currentAccounts.map((account) => [account.accountId, account]));
      const decisions = new Map<string, FirstStepAccountDecision>();
      for (const decision of input.accounts) {
        const account = known.get(decision.accountId);
        if (!account) {
          throw new FirstStepSelectionError('foreign_account', `账号 ${decision.accountId} 不属于本次发现结果。`);
        }
        decisions.set(decision.accountId, decision);
      }
      // Full-state contract: every current account gets an explicit decision.
      const completeness = validateDecisionCompleteness(record.view.accounts, input.accounts);
      if (!completeness.ok) throw new FirstStepSelectionError('incomplete_batch', completeness.error);
      // The person cluster is bound here: nonexistent clusters and cross-cluster
      // same-person merges are rejected; independent scopes stay separate.
      const clusterChoice = validateClusterChoice(record.view.clusters, currentAccounts, input.accounts, input.clusterId);
      if (!clusterChoice.ok) throw new FirstStepSelectionError('invalid_cluster', clusterChoice.error ?? '人物选择无效。');
      const chosen = [...decisions.values()].filter((d) => d.selection === 'selected' || d.selection === 'only_this_account');
      if (chosen.length === 0) {
        throw new FirstStepSelectionError('empty_selection', '没有选择任何账号：请至少选择一个研究账号，或改用“都不是”。');
      }
      const changes: ScopeAccountChange[] = [];
      // The chosen cluster's own anchor is the person home the user just
      // confirmed: it may join the person scope as intent (identity evidence
      // is never upgraded) with its inspectable linkage basis. This exception
      // binds the cluster's OWN anchor account — never a globally proposed
      // anchor set. Every other uncertain account stays independent-scope only.
      const anchorAccountIds = new Set<string>(
        clusterChoice.cluster === null
          ? []
          : clusterChoice.cluster.anchorAccountId
            ? [clusterChoice.cluster.anchorAccountId]
            : [...known.values()]
                .filter((account) => account.profileUrl === clusterChoice.cluster!.anchorUrl)
                .map((account) => account.accountId)
      );
      for (const decision of chosen) {
        const account = known.get(decision.accountId)!;
        const check = validateSelectionDecision(account, decision, { anchorAccountIds });
        if (!check.ok) throw new FirstStepSelectionError('invalid_decision', check.error);
      }
      const selectedAccountIds = chosen.map((d) => d.accountId);
      const independentAccountIds = clusterChoice.independentAccountIds;
      const clusterId = clusterChoice.cluster?.clusterId ?? null;
      const timestamp = nowIso();
      // Explicit exclusion statements and revocations, append-only. Submitting
      // `excluded: false` revokes an earlier statement; revocation never adds
      // identity support.
      const excludedAccountIds: string[] = [];
      for (const decision of decisions.values()) {
        const active = this.db
          .prepare('SELECT id FROM first_step_exclusions WHERE run_id = ? AND account_id = ? AND revoked_at IS NULL')
          .get(runId, decision.accountId) as { id: string } | undefined;
        if (decision.excluded) {
          excludedAccountIds.push(decision.accountId);
          if (!active) {
            this.db
              .prepare(
                'INSERT INTO first_step_exclusions (id, run_id, case_id, account_id, statement, recorded_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
              )
              .run(`excl_${randomUUID().replace(/-/g, '').slice(0, 24)}`, runId, link.caseId, decision.accountId, decision.note ?? '用户声明：不是此人。', timestamp);
          }
        } else if (active) {
          this.db.prepare('UPDATE first_step_exclusions SET revoked_at = ? WHERE id = ?').run(timestamp, active.id);
        }
      }
      // Excluded accounts can never stay selected.
      for (const id of excludedAccountIds) {
        if (selectedAccountIds.includes(id)) {
          throw new FirstStepSelectionError('invalid_decision', '排除声明与选择互相冲突。');
        }
      }
      for (const decision of chosen) {
        const state: UserSelectionState = decision.selection === 'only_this_account' ? 'only_this_account' : 'selected';
        changes.push({
          accountId: decision.accountId,
          userSelection: {
            state,
            note: decision.note ?? null,
            recordedAt: timestamp
          },
          allowedScope: { state: 'public_history', note: '用户在第一步确认的研究范围。' }
        });
      }
      for (const decision of decisions.values()) {
        if (chosen.includes(decision)) continue;
        const state: UserSelectionState = decision.selection === 'unanswered' ? 'unanswered' : 'not_selected';
        changes.push({
          accountId: decision.accountId,
          userSelection: {
            state,
            note: decision.note ?? null,
            recordedAt: decision.selection === 'unanswered' ? null : timestamp
          },
          allowedScope: { state: 'none', note: null }
        });
      }
      const scopeResult = this.cases.applyScopeChange({
        ownerId,
        caseId: link.caseId,
        expectedScopeVersion: asScopeVersion(input.expectedScopeVersion),
        reason: `first_step_selection run=${runId} discovery=${String(input.discoveryRevision)}`,
        accounts: changes
      });
      const nextScopeVersion = scopeResult.case.scopeVersion;
      const runRevision = run.revision + 1;
      // Bind the frozen scope into the checkpoint in this same transaction.
      const checkpoint: ResearchCheckpoint | null = this.store.research.checkpoint(runId);
      const binding: FirstStepBinding = {
        caseId: link.caseId,
        discoveryRevision: input.discoveryRevision,
        scopeVersion: nextScopeVersion,
        clusterId,
        displayName: clusterChoice.cluster?.displayName ?? known.get(selectedAccountIds[0] ?? '')?.displayName ?? null,
        // The Fetch anchor must be one of the SELECTED accounts: choosing a
        // person never grants reading their unselected accounts.
        anchorUrl:
          selectedAccountIds
            .map((id) => known.get(id)!)
            .find((account) => clusterChoice.cluster !== null && account.profileUrl === clusterChoice.cluster.anchorUrl)?.profileUrl ??
          known.get(selectedAccountIds[0] ?? '')?.profileUrl ??
          null,
        selectedAccountIds,
        independentAccountIds,
        identityDependencyAccountIds: (clusterChoice.cluster?.accountIds ?? selectedAccountIds)
          .filter(id => !independentAccountIds.includes(id) && (known.get(id)?.identity.state === 'supported' || known.get(id)?.profileUrl === clusterChoice.cluster?.anchorUrl)),
        accountKeys: Object.fromEntries(
          selectedAccountIds.map((id) => [known.get(id)!.accountKey, id])
        ),
        accounts: selectedAccountIds.map((id) => {
          const account = known.get(id)!;
          return {
            accountId: id,
            accountKey: account.accountKey,
            profileUrl: account.profileUrl ?? '',
            allowedScope: 'public_history' as const,
            independent: independentAccountIds.includes(id),
            accessCoverage: account.accessCoverage.state
          };
        })
      };
      const nextCheckpoint: ResearchCheckpoint =
        checkpoint !== null
          ? { ...checkpoint, firstStep: binding }
          : {
              phase: 'fetching',
              steps: 0,
              startedAt: Date.now(),
              elapsedMs: 0,
              // No limits field here on purpose: the fetch binds the OPERATOR's
              // configured ceilings (0 = disabled) instead of silently
              // overriding them with zeros.
              anchorUrl: null,
              identity: null,
              candidates: [],
              pages: [],
              claims: [],
              unknowns: [],
              stopReason: null,
              firstStep: binding
            };
      this.db
        .prepare(
          `INSERT INTO research_checkpoints (run_id, data_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
        )
        .run(runId, JSON.stringify(nextCheckpoint), timestamp);
      this.db
        .prepare(
          `UPDATE first_step_links SET selection_revision = selection_revision + 1, selection_scope_version = ?,
             selection_discovery_revision = ?, selected_json = ?, excluded_json = ?, submitted_at = ?, phase = 'fetching', updated_at = ?
           WHERE run_id = ?`
        )
        .run(nextScopeVersion, input.discoveryRevision, JSON.stringify(selectedAccountIds), JSON.stringify(excludedAccountIds), timestamp, timestamp, runId);
      this.store.updateRun(runId, {
        revision: runRevision,
        state: 'queued',
        cancel_requested: 0,
        error_code: null,
        error_message: null,
        stop_reason: null
      });
      this.store.addEvent(runId, 'first_step_selection', {
        revision: runRevision,
        scopeVersion: nextScopeVersion,
        discoveryRevision: input.discoveryRevision,
        clusterId,
        selectedAccountIds,
        independentAccountIds,
        excludedAccountIds
      });
      const result: FirstStepSelectionResult = {
        runRevision,
        scopeVersion: nextScopeVersion,
        discoveryRevision: input.discoveryRevision,
        clusterId,
        selectedAccountIds,
        independentAccountIds,
        excludedAccountIds,
        submittedAt: timestamp,
        idempotent: false
      };
      if (idempotencyKey) {
        this.db
          .prepare(
            'INSERT INTO first_step_selections (owner_id, idempotency_key, run_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(ownerId, idempotencyKey, runId, fingerprint, JSON.stringify(result), timestamp);
      }
      return result;
    })();
  }

  /** Frozen scope binding of a submitted selection, or null when unsubmitted. */
  selectionBinding(runId: string): FirstStepBinding | null {
    const checkpoint = this.store.research.checkpoint(runId);
    return checkpoint?.firstStep ?? null;
  }

  /**
   * Inherit a parent's FROZEN scope into a follow-up child run, atomically:
   * the child repeats no confirmation and can never read accounts outside the
   * inherited binding. A first-step parent without a frozen selection cannot
   * be followed up at all.
   */
  inheritFirstStepScope(
    ownerId: string,
    childRun: { id: string; ownerId: string; question: string },
    parentRunId: string
  ): FirstStepLinkRecord {
    return this.db.transaction(() => {
      const parentLink = this.link(parentRunId);
      const binding = this.selectionBinding(parentRunId);
      if (!parentLink || !binding) {
        throw new FirstStepSelectionError('expand_not_allowed', '父研究尚未冻结研究范围，无法追问。');
      }
      const parent = this.store.getRunForOwner(parentRunId, ownerId);
      if (!parent) throw new FirstStepSelectionError('run_not_found', '未找到父研究。');
      if (childRun.ownerId !== ownerId) throw new FirstStepSelectionError('run_not_found', '未找到子研究。');
      const timestamp = nowIso();
      // The follow-up shares the existing case and its live facets. Creating
      // a second empty case would disagree with the inherited scope binding.
      this.db.prepare(`INSERT INTO first_step_links (
        run_id, case_id, input_revision, discovery_revision, selection_revision, phase,
        selection_scope_version, selection_discovery_revision, selected_json, excluded_json,
        submitted_at, created_at, updated_at
      ) VALUES (?, ?, 1, 0, 0, 'fetching', NULL, NULL, '[]', '[]', NULL, ?, ?)`)
        .run(childRun.id, binding.caseId, timestamp, timestamp);
      const current = this.currentDiscovery(parentRunId);
      if (current) {
        this.db
          .prepare(
            'INSERT INTO first_step_discoveries (run_id, discovery_revision, input_json, plan_json, view_json, created_at) VALUES (?, 1, ?, ?, ?, ?)'
          )
          .run(
            childRun.id,
            JSON.stringify(current.input),
            JSON.stringify(current.plan),
            JSON.stringify({
              ...current.view,
              runId: childRun.id,
              discoveryRevision: 1,
              phase: 'fetching',
              readyForChoice: false,
              selection: { ...current.view.selection, frozenScopeVersion: binding.scopeVersion, submitted: true }
            }),
            timestamp
          );
        this.db
          .prepare(
            `UPDATE first_step_links SET discovery_revision = 1, phase = 'fetching', selection_scope_version = ?,
               selection_discovery_revision = ?, selected_json = ?, excluded_json = '[]', submitted_at = ?, updated_at = ? WHERE run_id = ?`
          )
          .run(binding.scopeVersion, binding.discoveryRevision, JSON.stringify(binding.selectedAccountIds), timestamp, timestamp, childRun.id);
      }
      const checkpoint: ResearchCheckpoint = {
        phase: 'fetching',
        steps: 0,
        startedAt: Date.now(),
        elapsedMs: 0,
        anchorUrl: binding.anchorUrl,
        identity: {
          displayName: binding.displayName ?? binding.anchorUrl ?? '',
          handle: null,
          profileUrl: binding.anchorUrl,
          status: 'resolved',
          note: '追问继承父研究已冻结的研究范围；不重新确认、不扩大范围。',
          candidates: []
        },
        pages: [],
        claims: [],
        candidates: [],
        unknowns: [],
        stopReason: null,
        firstStep: binding
      };
      this.db
        .prepare(
          `INSERT INTO research_checkpoints (run_id, data_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
        )
        .run(childRun.id, JSON.stringify(checkpoint), timestamp);
      this.store.addEvent(childRun.id, 'first_step_selection', {
        inheritedFrom: parentRunId,
        scopeVersion: binding.scopeVersion,
        selectedAccountIds: binding.selectedAccountIds
      });
      return this.link(childRun.id)!;
    })();
  }

  /**
   * The one atomic expand/补线索 path: only a run truly awaiting its first-step
   * selection (or a legacy paused job) may start a NEW discovery attempt in
   * place. A submitted selection can never be raced back into discovery (use a
   * new linked run), an active job is never cancelled or reset, and a repeated
   * Idempotency-Key replays the exact receipt. Prior revisions, receipts and
   * reports are preserved append-only; new candidates stay `unanswered`.
   */
  applyFirstStepExpand(
    ownerId: string,
    runId: string,
    hint: string | null,
    idempotencyKey: string | null
  ): { caseId: string; discoveryRevision: number; runRevision: number; idempotent: boolean } {
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind: 'expand', hint })).digest('hex');
    return this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare('SELECT * FROM first_step_selections WHERE owner_id = ? AND idempotency_key = ?')
          .get(ownerId, idempotencyKey) as { fingerprint: string; result_json: string; run_id: string } | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.run_id !== runId) {
            throw new FirstStepSelectionError('idempotency_conflict', '同一幂等键已用于不同的请求。');
          }
          return {
            ...parseJson<{ caseId: string; discoveryRevision: number; runRevision: number }>(existing.result_json, {
              caseId: '',
              discoveryRevision: 0,
              runRevision: 0
            }),
            idempotent: true
          };
        }
      }
      const run = this.store.getRunForOwner(runId, ownerId);
      if (!run) throw new FirstStepSelectionError('run_not_found', '未找到该研究。');
      if (run.state !== 'needs_input') {
        throw new FirstStepSelectionError('run_not_waiting', '只有等待确认的研究才能原地扩展发现。');
      }
      const existingLink = this.link(runId);
      if (existingLink && this.selectionBinding(runId)) {
        throw new FirstStepSelectionError(
          'expand_not_allowed',
          '已提交范围的研究不能原地重新发现；请新建研究继续扩展，已提交报告保持不变。'
        );
      }
      const link = this.attachRun(run, run.question);
      if (hint && hint.trim().length > 0) this.setHint(runId, hint.trim());
      else if (existingLink) {
        // An explicit new discovery without a new clue still owns a fresh
        // attempt; replaying the previous request keys cannot refresh sources.
        this.db.prepare('UPDATE first_step_links SET input_revision = input_revision + 1, updated_at = ? WHERE run_id = ?').run(nowIso(), runId);
      }
      this.setPhase(runId, 'freezing');
      const runRevision = run.revision + 1;
      this.store.updateRun(runId, {
        state: 'queued',
        revision: runRevision,
        seed_url: run.seedUrl ?? (hint && /^https:\/\//i.test(hint) ? hint.trim() : run.seedUrl)
      });
      this.store.addEvent(runId, 'state', {
        state: 'queued',
        expanded: true,
        discoveryRevision: link.discoveryRevision
      });
      const result = { caseId: link.caseId, discoveryRevision: link.discoveryRevision, runRevision };
      if (idempotencyKey) {
        this.db
          .prepare(
            'INSERT INTO first_step_selections (owner_id, idempotency_key, run_id, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(ownerId, idempotencyKey, runId, fingerprint, JSON.stringify(result), nowIso());
      }
      return { ...result, idempotent: false };
    })();
  }

  /* ---------------------------------------------------------------- */
  /* Fetch scope enforcement                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Build a scope guard for the fetch stage. The guard re-checks the live case
   * state before every dispatch AND every ingestion, so an account excluded or
 *   unselected after the fact, or discovered later, can never be read or mixed
   * into the person conclusions.
   */
  scopeGuard(ownerId: string, runId: string): FirstStepScopeGuard {
    return new FirstStepScopeGuard(this.db, this.store, ownerId, runId);
  }
}

export class FirstStepScopeGuard {
  constructor(
    private readonly db: DB,
    private readonly store: Store,
    readonly ownerId: string,
    readonly runId: string
  ) {}

  private binding(): FirstStepBinding {
    const binding = this.store.research.checkpoint(this.runId)?.firstStep;
    if (!binding) throw new FirstStepSelectionError('not_first_step', '该研究没有已冻结的范围绑定。');
    return binding;
  }

  private assertScopeCurrent(binding: FirstStepBinding): void {
    const caseRow = this.db
      .prepare('SELECT scope_version FROM research_cases WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(binding.caseId, this.ownerId) as { scope_version: number } | undefined;
    if (!caseRow) throw new FirstStepSelectionError('scope_changed', '案例不可用，读取范围失效。');
    if (caseRow.scope_version !== binding.scopeVersion) {
      throw new FirstStepSelectionError('scope_changed', '研究范围已变更，冻结范围失效。');
    }
    if (!this.store.isFirstStepIdentityActive(this.ownerId, binding)) {
      throw new FirstStepSelectionError('scope_changed', '人物关联路径的归属依据已失效，人物研究暂停；原记录保留。');
    }
  }

  /** Check the frozen scope even when an operation has no target URL. */
  assertCurrent(): void {
    this.assertScopeCurrent(this.binding());
  }

  /**
   * Resolve one URL to an in-scope account by ACCOUNT ATTRIBUTION ONLY.
   * Observed links never grant authority: an account reachable only through a
   * link from a selected page is refused exactly like any unselected account.
   * Excluded, unselected and later-discovered accounts, shared hosts and
   * unsafe URLs can never pass; only content actually attributable to an
   * already selected account inside its live allowed scope may expand locally.
   * Ownership, selection, exclusion and scope version are re-checked live on
   * every call — before dispatch AND before ingestion.
   */
  resolveUrl(url: string): {
    accountId: string;
    allowedScope: AllowedScope['state'];
    accountUrl: string;
    entry: 'profile' | 'page';
  } {
    const binding = this.binding();
    this.assertScopeCurrent(binding);
    const classified = classifyFirstStepUrl(url);
    if (!classified.ok) {
      throw new FirstStepSelectionError('out_of_scope', `不安全或无效的地址不能读取：${url}`);
    }
    const ref: FirstStepAccountRef = classified.ref;
    const accountId = binding.accountKeys[ref.accountKey];
    if (!accountId) {
      // The link map is gone on purpose: linking never authorizes a read.
      throw new FirstStepSelectionError('out_of_scope', `该地址不属于任何已选账号，链接不授予权限：${url}`);
    }
    const account = this.db
      .prepare('SELECT id, user_selection_json, allowed_scope_json FROM research_case_accounts WHERE id = ? AND case_id = ? AND owner_id = ?')
      .get(accountId, binding.caseId, this.ownerId) as
      | { id: string; user_selection_json: string; allowed_scope_json: string }
      | undefined;
    if (!account) {
      throw new FirstStepSelectionError('out_of_scope', `账号 ${accountId} 不属于当前范围：${url}`);
    }
    const excluded = this.excludedInChain(accountId);
    if (excluded) {
      throw new FirstStepSelectionError('out_of_scope', `已排除的账号不能读取：${url}`);
    }
    const selection = parseJson<{ state: string }>(account.user_selection_json, { state: 'unanswered' });
    const allowed = parseJson<AllowedScope>(account.allowed_scope_json, { state: 'none', note: null });
    if (selection.state !== 'selected' && selection.state !== 'only_this_account') {
      throw new FirstStepSelectionError('out_of_scope', `未选择的账号不能读取：${url}`);
    }
    if (allowed.state === 'none') {
      throw new FirstStepSelectionError('out_of_scope', `该账号没有读取权限：${url}`);
    }
    if (allowed.state === 'profile_only' && (ref.entry !== 'profile' || ref.accountUrl !== ref.profileUrl)) {
      throw new FirstStepSelectionError('out_of_scope', `仅主页范围不能读取内容页：${url}`);
    }
    return { accountId, allowedScope: allowed.state, accountUrl: ref.accountUrl, entry: ref.entry };
  }

  /** Live revocation dependencies include both follow-up and retry ancestry. */
  private excludedInChain(accountId: string): boolean {
    const pending = [this.runId];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const row = this.db
        .prepare('SELECT id FROM first_step_exclusions WHERE run_id = ? AND account_id = ? AND revoked_at IS NULL')
        .get(current, accountId) as { id: string } | undefined;
      if (row) return true;
      const parent = this.db.prepare('SELECT parent_run_id, retry_of FROM runs WHERE id = ? AND owner_id = ?').get(current, this.ownerId) as
        | { parent_run_id: string | null; retry_of: string | null }
        | undefined;
      if (parent?.parent_run_id) pending.push(parent.parent_run_id);
      if (parent?.retry_of) pending.push(parent.retry_of);
    }
    return false;
  }

  /**
   * Before dispatch. Search stays allowed inside the frozen scope; after the
   * selection, `public_history` permits the selected account's real content
   * operations (posts included), while `profile_only` only allows the profile
   * itself. The X Firecrawl prohibition stays in force here as well.
   */
  assertDispatch(action: { type: string; url?: string }): {
    accountId: string;
    allowedScope: AllowedScope['state'];
  } | null {
    if (action.type === 'search') {
      this.assertScopeCurrent(this.binding());
      return null;
    }
    if (!action.url) throw new FirstStepSelectionError('out_of_scope', '缺少读取地址。');
    let host = '';
    try {
      host = new URL(action.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      throw new FirstStepSelectionError('out_of_scope', `无效的读取地址：${action.url}`);
    }
    if (action.type === 'firecrawl' && (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com'))) {
      throw new FirstStepSelectionError('out_of_scope', 'X 资料不能通过网页抓取读取。');
    }
    const scope = this.resolveUrl(action.url);
    if (action.type === 'social_posts' && scope.allowedScope !== 'public_history') {
      throw new FirstStepSelectionError('out_of_scope', `仅主页范围不能读取历史帖子：${action.url}`);
    }
    return { accountId: scope.accountId, allowedScope: scope.allowedScope };
  }

  /**
   * Before ingestion: re-check every returned page against the live scope and
   * reject the ENTIRE result if any page is out of scope — nothing is absorbed
   * and no link is ever published as authority. Links are inert metadata; a
   * later-discovered account reached through one is refused like any other.
   */
  assertIngest(pages: Array<{ url: string; links?: string[]; accountId?: string }>): Array<{
    url: string;
    accountId: string;
    allowedScope: AllowedScope['state'];
  }> {
    const checked = pages.map((page) => {
      const scope = this.resolveUrl(page.url);
      return { url: page.url, accountId: scope.accountId, allowedScope: scope.allowedScope };
    });
    return checked;
  }
}
