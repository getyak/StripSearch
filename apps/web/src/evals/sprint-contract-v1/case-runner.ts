import { createHash } from 'node:crypto';
import {
  assessIdentityLink, classifyFirstStepUrl, firstStepDefaultSuggestion, linkRoleFromContext,
  type FirstStepLinkObservation
} from '../../shared/first-step-discovery.js';
import { extractOriginalLinkContexts } from '../../server/research/link-context.js';
import { namedOwnerQuote } from '../../server/research/named-owner.js';
import { dispatch, type ResearchToolPorts, type TrustedContext, type ToolHandler } from '../../server/research/research-tool-dispatch.js';
import type { ProviderToolName } from '../../server/research/research-tool-contracts.js';
import type { ContractCase, DispatchCase, LinkCase, OwnerCase } from './schema.js';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface CaseExecution {
  observed: Record<string, unknown>;
  evidence: unknown[];
}
function links(entry: LinkCase): CaseExecution {
  const target = classifyFirstStepUrl(entry.input.targetUrl);
  if (!target.ok) throw new Error('invalid target URL');
  const observations: FirstStepLinkObservation[] = [];
  const evidence: unknown[] = [];
  let rawSpanExact = true;
  for (const [documentIndex, document] of entry.input.documents.entries()) {
    const source = classifyFirstStepUrl(document.sourceUrl);
    if (!source.ok) throw new Error('invalid source URL');
    const contexts = extractOriginalLinkContexts(document.original, document.sourceUrl).filter((context) => context.url === entry.input.targetUrl);
    for (const context of contexts) {
      const result = linkRoleFromContext({
        quote: context.quote, targetUrl: context.url, targetOffset: context.targetOffset,
        binding: context.binding, surface: context.surface,
        sourceIsOwnProfilePage: source.ref.entry === 'profile', sourceIsDirectory: source.ref.platform === 'linktree',
        sourceIsRestrictedSurface: source.ref.entry !== 'profile' && source.ref.platform !== 'personal_site',
        sourceIsSocialPlatform: !['personal_site', 'web_page', 'rss_blog'].includes(source.ref.platform)
      });
      const location = /第 (\d+)–(\d+) 字符$/u.exec(context.locator);
      const start = location ? Number(location[1]) - 1 : -1, end = location ? Number(location[2]) : -1;
      const exact = start >= 0 && document.original.slice(start, end) === context.quote &&
        context.targetOffset !== undefined && context.targetOffset >= 0 && context.targetOffset < context.quote.length;
      rawSpanExact &&= exact;
      const observation: FirstStepLinkObservation = {
        observationId: `observation-${observations.length + 1}`, sourceId: `source-${documentIndex + 1}`,
        sourceRevision: 1, sourceUrl: document.sourceUrl, sourceContentHash: sha256(document.original),
        sourceRetrievedAt: '2026-10-13T00:00:00.000Z', fromAccountKey: source.ref.accountKey,
        targetAccountKey: target.ref.accountKey, targetUrl: context.url, linkRole: result.role,
        direction: 'outbound', retrieval: document.retrieval === 'indexed' ? 'indexed' : result.retrieval,
        quote: context.quote, locator: context.locator, observedAt: '2026-10-13T00:00:00.000Z'
      };
      observations.push(observation);
      evidence.push({ ...observation, binding: context.binding, surface: context.surface, targetOffset: context.targetOffset, start, end, rawSpanExact: exact });
    }
  }
  const assessment = assessIdentityLink(target.ref.accountKey, observations);
  const suggestion = firstStepDefaultSuggestion(assessment, entry.input.accountKind, { readable: true, note: null });
  return { observed: {
    roles: observations.map((o) => o.linkRole), state: assessment.state, basis: assessment.basis,
    supportCount: assessment.supportObservationIds.length, counterevidenceCount: assessment.counterevidenceObservationIds.length,
    candidateCount: assessment.candidateObservationIds.length, independentSources: assessment.independentSources,
    suggested: suggestion.suggested, rawSpanExact: observations.length > 0 && rawSpanExact
  }, evidence };
}
function owner(entry: OwnerCase): CaseExecution {
  const input = entry.input;
  const result = namedOwnerQuote({
    url: input.pageUrl, title: 'Synthetic profile', text: input.original, kind: 'profile',
    publishedAt: null, links: [], limitations: [], retrieval: input.retrieval,
    ...(input.documentBinding ? { documentBinding: input.documentBinding } : {})
  }, { type: 'read', url: input.requestedUrl }, input.personName);
  return {
    observed: { accepted: result !== null, quote: result?.quote ?? null, offset: result?.offset ?? null,
      rawSpanExact: result === null || input.original.slice(result.offset, result.offset + result.quote.length) === result.quote },
    evidence: [{ sourceUrl: input.pageUrl, requestedUrl: input.requestedUrl, sourceContentHash: sha256(input.original), result }]
  };
}
async function tool(entry: DispatchCase): Promise<CaseExecution> {
  const input = entry.input;
  let providerCalls = 0, handlerCalls = 0, submissionCalls = 0, reservations = 0;
  const events: string[] = [];
  const trusted: TrustedContext = {
    ownerId: 'synthetic-owner', caseId: 'synthetic-case', role: input.role, phase: input.phase,
    scopeVersion: 3, cancelled: false,
    accounts: [{ accountId: 'acct-1', platform: 'synthetic', handle: 'lumen', allowedScope: input.scope }],
    capabilities: { registryVersion: 'synthetic/v1', operations: input.capability === 'missing' ? [] : [
      { platform: 'synthetic', operation: 'list_posts', state: input.capability, sortOptions: ['new'], dateRange: 'unsupported', maxDepth: null, limitation: null }
    ] }, skillPins: []
  };
  // These are fail-fast seams, not answer fixtures: a forbidden action reaching
  // any handler/executor/submission is recorded and fails its case expectation.
  const trap: ToolHandler = async () => { handlerCalls++; throw new Error('forbidden handler reached'); };
  const handlers = Object.fromEntries(['discover_accounts', 'read_profile', 'search_web', 'list_posts', 'read_post', 'list_comments', 'read_thread', 'read_media'].map((name) => [name, trap])) as Partial<Record<ProviderToolName, ToolHandler>>;
  const ports: ResearchToolPorts = {
    handlers,
    accounting: {
      reserve(request) {
        const actionId = `synthetic-action-${++reservations}`;
        events.push(`reserve:${request.kind}`);
        return { actionId, tool: request.tool, descriptor: request.kind === 'provider_request' ? request.descriptor : { endpoint: 'local-contract', note: 'offline contract step' } };
      },
      settle(_reservation, outcome) { events.push(`settle:${outcome.state}`); }
    },
    executor: { async execute() { providerCalls++; throw new Error('forbidden provider reached'); } },
    submissions: { async stagePendingFinding() { submissionCalls++; throw new Error('forbidden submission reached'); } },
    ...(input.stateAvailable ? { state: {
      readCaseState() { return { scopeVersion: input.currentVersion, cancelled: input.cancelled, accounts: [{ accountId: 'acct-1', allowedScope: input.currentScope }] }; },
      revokedEvidence(_ownerId: string, _caseId: string, ids: string[]) { return Object.fromEntries(ids.map((id) => [id, false])); }
    } } : {})
  };
  const result = await dispatch(trusted, { tool: input.tool, input: input.args }, ports, new AbortController().signal);
  return { observed: {
    status: result.status, reason: result.reason, providerCalls, handlerCalls, submissionCalls,
    staged: result.staged, contentNull: result.content === null
  }, evidence: [{ events, envelope: result }] };
}
export async function executeCase(entry: ContractCase): Promise<CaseExecution> {
  switch (entry.kind) {
    case 'links': return links(entry);
    case 'named_owner': return owner(entry);
    case 'dispatch': return tool(entry);
    default: throw new Error(`unknown case kind: ${String((entry as { kind?: unknown }).kind)}`);
  }
}
