/** Independently authored synthetic specifications; this is not human gold. */
export const SUITE = 'sprint-contract-v1';
export const KINDS = ['links', 'named_owner', 'dispatch'] as const;
export const LINK_ROLES = ['self_account_section', 'explicit_directory', 'explicit_claim', 'explicit_denial', 'prose_mention', 'unknown_role'] as const;
export const TOOLS = ['get_platform_capabilities', 'discover_accounts', 'read_profile', 'search_web', 'submit_candidates', 'request_confirmation', 'read_evidence', 'load_skill', 'list_posts', 'read_post', 'list_comments', 'read_thread', 'read_media', 'save_findings', 'report_progress'] as const;

export interface LinkCase {
  id: string; kind: 'links'; boundary: string; rationale: string;
  input: {
    targetUrl: string; accountKind: 'person' | 'organization' | 'unknown';
    documents: { sourceUrl: string; original: string; retrieval: 'read' | 'indexed' }[];
  };
  expected: {
    roles: (typeof LINK_ROLES)[number][];
    state: 'supported' | 'proposed' | 'rejected' | 'disputed';
    basis: 'explicit_self_link' | 'explicit_directory_link' | 'search_index' | 'none';
    supportCount: number; counterevidenceCount: number; candidateCount: number;
    independentSources: number; suggested: boolean; rawSpanExact: boolean;
  };
}
export interface OwnerCase {
  id: string; kind: 'named_owner'; boundary: string; rationale: string;
  input: {
    pageUrl: string; requestedUrl: string; original: string; personName: string;
    retrieval: 'read' | 'search';
    documentBinding: { requestedUrl: string; returnedUrl: string } | null;
  };
  expected: { accepted: boolean; quote: string | null; offset: number | null; rawSpanExact: boolean };
}
export interface DispatchCase {
  id: string; kind: 'dispatch'; boundary: string; rationale: string;
  input: {
    role: 'search' | 'fetch'; phase: 'search' | 'fetch' | 'verify'; tool: (typeof TOOLS)[number];
    /** Deliberately untrusted model arguments; injected keys are test data. */
    args: Record<string, unknown>;
    scope: 'none' | 'profile_only' | 'public_history';
    currentScope: 'none' | 'profile_only' | 'public_history';
    currentVersion: number; stateAvailable: boolean; cancelled: boolean;
    capability: 'supported' | 'unverified' | 'unsupported' | 'missing';
  };
  expected: {
    status: 'success' | 'blocked' | 'not_implemented' | 'not_applicable';
    reasonIncludes: string | null; providerCalls: number; handlerCalls: number;
    staged: boolean; contentNull: boolean;
  };
}
export type ContractCase = LinkCase | OwnerCase | DispatchCase;
export interface Dataset {
  suite: typeof SUITE; schemaVersion: 1; material: 'synthetic'; reviewStatus: 'unreviewed';
  track: 'offline_deterministic_contract'; networkAccess: false; license: 'Apache-2.0';
  cases: ContractCase[];
}

type Rule = {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean' | 'null';
  const?: unknown; enum?: readonly unknown[]; properties?: Record<string, Rule>;
  required?: string[]; additionalProperties?: boolean; items?: Rule;
  minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; pattern?: string; oneOf?: Rule[];
};
const text: Rule = { type: 'string', minLength: 1, maxLength: 100_000 };
const url: Rule = { type: 'string', minLength: 9, maxLength: 4096, pattern: '^https://[^\\s]+$' };
const count: Rule = { type: 'integer', minimum: 0 };
const bool: Rule = { type: 'boolean' };
const enumeration = (values: readonly unknown[]): Rule => ({ enum: values });
const nullable = (rule: Rule): Rule => ({ oneOf: [rule, { type: 'null' }] });
const obj = (properties: Record<string, Rule>): Rule => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: Rule, minItems = 0, maxItems = 100): Rule => ({ type: 'array', items, minItems, maxItems });
const scope = enumeration(['none', 'profile_only', 'public_history']);
const common = {
  id: { type: 'string', pattern: '^SC-[0-9]{3}$' } as Rule,
  boundary: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[a-z][a-z0-9_]+$' } as Rule,
  rationale: text
};
const linkRule = obj({
  ...common, kind: { const: 'links' },
  input: obj({ targetUrl: url, accountKind: enumeration(['person', 'organization', 'unknown']),
    documents: list(obj({ sourceUrl: url, original: text, retrieval: enumeration(['read', 'indexed']) }), 1, 8) }),
  expected: obj({ roles: list(enumeration(LINK_ROLES), 1, 20),
    state: enumeration(['supported', 'proposed', 'rejected', 'disputed']),
    basis: enumeration(['explicit_self_link', 'explicit_directory_link', 'search_index', 'none']),
    supportCount: count, counterevidenceCount: count, candidateCount: count,
    independentSources: count, suggested: bool, rawSpanExact: { const: true } })
});
const ownerRule = obj({
  ...common, kind: { const: 'named_owner' },
  input: obj({ pageUrl: url, requestedUrl: url, original: text, personName: text,
    retrieval: enumeration(['read', 'search']),
    documentBinding: nullable(obj({ requestedUrl: url, returnedUrl: url })) }),
  expected: obj({ accepted: bool, quote: nullable(text), offset: nullable(count), rawSpanExact: { const: true } })
});
const dispatchRule = obj({
  ...common, kind: { const: 'dispatch' },
  input: obj({ role: enumeration(['search', 'fetch']), phase: enumeration(['search', 'fetch', 'verify']),
    tool: enumeration(TOOLS), args: { type: 'object', additionalProperties: true }, scope, currentScope: scope,
    currentVersion: { type: 'integer', minimum: 1 }, stateAvailable: bool, cancelled: bool,
    capability: enumeration(['supported', 'unverified', 'unsupported', 'missing']) }),
  expected: obj({ status: enumeration(['success', 'blocked', 'not_implemented', 'not_applicable']),
    reasonIncludes: nullable(text), providerCalls: count, handlerCalls: count, staged: bool, contentNull: bool })
});
export const DATASET_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:stripsearch:eval:sprint-contract-v1',
  ...obj({ suite: { const: SUITE }, schemaVersion: { const: 1 }, material: { const: 'synthetic' },
    reviewStatus: { const: 'unreviewed' }, track: { const: 'offline_deterministic_contract' },
    networkAccess: { const: false }, license: { const: 'Apache-2.0' },
    cases: list({ oneOf: [linkRule, ownerRule, dispatchRule] }, 16, 100) })
};

export class DatasetError extends Error {
  constructor(message: string) { super(message); this.name = 'DatasetError'; }
}
function validate(rule: Rule, value: unknown, path: string): void {
  const fail = (detail: string): never => { throw new DatasetError(`${path}: ${detail}`); };
  if (Object.hasOwn(rule, 'const') && value !== rule.const) fail(`expected constant ${JSON.stringify(rule.const)}`);
  if (rule.enum && !rule.enum.includes(value)) fail(`unknown value ${JSON.stringify(value)}`);
  if (rule.oneOf) {
    const matches = rule.oneOf.filter((candidate) => { try { validate(candidate, value, path); return true; } catch { return false; } });
    if (matches.length !== 1) fail('must match exactly one known case/value schema');
    return;
  }
  switch (rule.type) {
    case 'null': if (value !== null) fail('expected null'); break;
    case 'boolean': if (typeof value !== 'boolean') fail('expected boolean'); break;
    case 'integer': if (!Number.isSafeInteger(value) || (value as number) < (rule.minimum ?? 0)) fail('expected bounded safe integer'); break;
    case 'string':
      if (typeof value !== 'string') fail('expected string');
      if ((value as string).length < (rule.minLength ?? 0) || (value as string).length > (rule.maxLength ?? Infinity)) fail('string length invalid');
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value as string)) fail('string pattern invalid');
      break;
    case 'array':
      if (!Array.isArray(value)) fail('expected array');
      if ((value as unknown[]).length < (rule.minItems ?? 0) || (value as unknown[]).length > (rule.maxItems ?? Infinity)) fail('array length invalid');
      (value as unknown[]).forEach((item, i) => validate(rule.items!, item, `${path}[${i}]`));
      break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail('expected plain object');
      const object = value as Record<string, unknown>;
      for (const key of rule.required ?? []) if (!Object.hasOwn(object, key)) fail(`missing ${key}`);
      for (const key of Object.keys(object)) {
        if (rule.properties && Object.hasOwn(rule.properties, key)) validate(rule.properties[key]!, object[key], `${path}.${key}`);
        else if (rule.additionalProperties !== true) fail(`unknown key ${key}`);
      }
    }
  }
}

function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new DatasetError('fixture must be acyclic JSON with finite numbers');
  seen.add(value);
  for (const child of Object.values(value)) assertJson(child, seen);
  seen.delete(value);
}

export function parseDataset(value: unknown): Dataset {
  assertJson(value);
  validate(DATASET_SCHEMA, value, '$');
  const dataset = value as Dataset;
  const ids = new Set<string>(), boundaries = new Set<string>(), payloads = new Set<string>();
  for (const entry of dataset.cases) {
    if (ids.has(entry.id)) throw new DatasetError(`duplicate case id ${entry.id}`);
    if (boundaries.has(entry.boundary)) throw new DatasetError(`duplicate boundary ${entry.boundary}`);
    const payload = JSON.stringify({ kind: entry.kind, input: entry.input });
    if (payloads.has(payload)) throw new DatasetError(`duplicate input ${entry.id}`);
    ids.add(entry.id); boundaries.add(entry.boundary); payloads.add(payload);
    if (entry.kind === 'named_owner') {
      if (entry.expected.accepted !== (entry.expected.quote !== null && entry.expected.offset !== null)) throw new DatasetError(`${entry.id}: inconsistent named-owner expectation`);
      if (!entry.expected.accepted && (entry.expected.quote !== null || entry.expected.offset !== null)) throw new DatasetError(`${entry.id}: rejected owner must have null quote and offset`);
    }
    if (entry.kind === 'links') {
      const e = entry.expected;
      if (e.supportCount + e.counterevidenceCount + e.candidateCount !== e.roles.length || e.independentSources > e.supportCount) throw new DatasetError(`${entry.id}: inconsistent observation counts`);
    }
    if (entry.kind === 'dispatch' && ((entry.expected.status === 'success') !== (entry.expected.reasonIncludes === null))) throw new DatasetError(`${entry.id}: rejection requires an explicit reason; success requires null`);
  }
  return dataset;
}
