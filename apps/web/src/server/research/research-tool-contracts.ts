/**
 * GET-59 Search 8 / Fetch 10 tool contracts: one frozen registry of 15
 * de-duplicated model tools plus strict runtime input/output schemas.
 *
 * Roles are exactly two: `search` (discovery & attribution) and `fetch`
 * (deep reading & verification). Verification is a Fetch *phase*, never a
 * third role, and allows only read_evidence / load_skill / save_findings.
 *
 * These contracts are the offline foundation for the planned Search/Fetch
 * runtime: they do not enable online Search/Fetch, the legacy alpha toolkit
 * (`tool-contracts.ts` / `toolkit.ts`) stays unchanged and separate, and every
 * envelope is schema-valid on success *and* refusal paths.
 */

/** Exactly 15 tool names; tests assert against fixed independent arrays. */
export type ToolName =
  | 'get_platform_capabilities'
  | 'read_evidence'
  | 'load_skill'
  | 'discover_accounts'
  | 'read_profile'
  | 'search_web'
  | 'submit_candidates'
  | 'request_confirmation'
  | 'list_posts'
  | 'read_post'
  | 'list_comments'
  | 'read_thread'
  | 'read_media'
  | 'save_findings'
  | 'report_progress';

export type ToolRole = 'search' | 'fetch';
/** `verify` is the Fetch verification phase, not a third role. */
export type ToolPhase = 'search' | 'fetch' | 'verify';

/* ------------------------------------------------------------------ */
/* Validators: strict objects (unknown keys rejected) everywhere        */
/* ------------------------------------------------------------------ */

export class ContractViolation extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

export type Validator<T> = (value: unknown, path: string) => T;

export interface OptionalField<T> {
  readonly optional: true;
  readonly run: Validator<T>;
}

type Shape = Record<string, Validator<unknown> | OptionalField<unknown>>;
type Infer<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalField<infer U> ? U : S[K] extends Validator<infer U> ? U : never;
};

function fail(path: string, message: string, code = 'invalid_field'): never {
  throw new ContractViolation(code, `${path}: ${message}`);
}

export function str(max = 4000): Validator<string> {
  return (value, path) => {
    if (typeof value !== 'string' || value.length > max) fail(path, `expected string of at most ${max} characters`);
    return value;
  };
}

export function strNull(max = 4000): Validator<string | null> {
  return (value, path) => (value === null ? null : str(max)(value, path));
}

export function int(min: number, max: number): Validator<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(path, `expected integer in [${min}, ${max}]`);
    return value;
  };
}

export function intNull(min: number, max: number): Validator<number | null> {
  return (value, path) => (value === null ? null : int(min, max)(value, path));
}

export function numNull(min = 0): Validator<number | null> {
  return (value, path) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(path, `expected number >= ${min} or null`);
    return value;
  };
}

export function bool(): Validator<boolean> {
  return (value, path) => {
    if (typeof value !== 'boolean') fail(path, 'expected boolean');
    return value;
  };
}

export function enumOf<T extends string>(values: readonly T[]): Validator<T> {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value as T)) fail(path, `expected one of ${values.join(', ')}`);
    return value as T;
  };
}

export function arr<T>(item: Validator<T>, max = 200): Validator<T[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > max) fail(path, `expected array of at most ${max} items`);
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
  };
}

export function opt<T>(run: Validator<T>): OptionalField<T> {
  return { optional: true, run };
}

export function nullable<T>(run: Validator<T>): Validator<T | null> {
  return (value, path) => (value === null ? null : run(value, path));
}

export function obj<S extends Shape>(shape: S) {
  return (value: unknown, path: string): Infer<S> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected object');
    const record = value as Record<string, unknown>;
    // Own-property checks only: `constructor`/`toString`/`__proto__` names must
    // be refused like any unknown key, never accepted via the prototype chain.
    for (const key of Object.keys(record)) {
      if (!Object.hasOwn(shape, key)) fail(`${path}.${key}`, 'unknown key', 'unknown_key');
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const optional = (field as OptionalField<unknown>).optional === true;
      const run = optional ? (field as OptionalField<unknown>).run : (field as Validator<unknown>);
      if (!Object.hasOwn(record, key)) {
        if (optional) continue;
        fail(`${path}.${key}`, 'missing required field', 'missing_field');
      }
      out[key] = run(record[key], `${path}.${key}`);
    }
    return out as Infer<S>;
  };
}

/* ------------------------------------------------------------------ */
/* Untrusted fields: model-supplied privilege/ownership/budget refusal  */
/* ------------------------------------------------------------------ */

/** Keys a model may never supply: authority comes from trusted context only. */
export const UNTRUSTED_PRIVILEGE_KEYS: readonly string[] = [
  'ownerId', 'caseId', 'role', 'phase', 'allowedScope', 'scopeVersion', 'personRevision',
  'identitySupport', 'userSelection', 'authorization', 'permissions', 'capabilitySnapshot',
  'skillPins', 'budget', 'estimatedUsd', 'credits', 'costUsd', 'usage', 'receipts', 'actionId'
];

/** Deep scan so privilege fields cannot hide inside wrappers or arrays. */
export function assertNoPrivilegeFields(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivilegeFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNTRUSTED_PRIVILEGE_KEYS.includes(key)) {
      throw new ContractViolation('untrusted_privilege_field', `${path}.${key}: privilege, ownership and budget fields are injected by the server, never model-supplied`);
    }
    assertNoPrivilegeFields(entry, `${path}.${key}`);
  }
}

/* ------------------------------------------------------------------ */
/* Uniform envelope                                                    */
/* ------------------------------------------------------------------ */

export type ToolStatus = 'success' | 'partial' | 'blocked' | 'not_applicable' | 'not_implemented' | 'failed';

/**
 * Per-content provenance. Applicable content carries author / original URL /
 * published + retrieved timestamps / source revision / locator; unknown values
 * are explicit `null`, never empty strings or fabricated dates. Inapplicable
 * local metadata (skills, acks, progress) uses an explicit reason.
 */
export type ContentMetadata =
  | {
      applicable: true;
      author: string | null;
      originalUrl: string | null;
      publishedAt: string | null;
      retrievedAt: string | null;
      sourceRevision: number | null;
      locator: string | null;
    }
  | { applicable: false; reason: string };

export interface Gap {
  code: string;
  detail: string;
}

export interface ActionReceiptView {
  actionId: string | null;
  kind: 'provider_request' | 'provider_step' | 'local_step' | 'not_dispatched';
  endpoint: string;
  state: 'completed' | 'failed' | 'unknown' | 'not_dispatched' | 'unreconciled';
  estimatedUsd: number | null;
  credits: number | null;
  note: string;
}

/** Derived from receipts only; model assertions of cost are always refused. */
export interface UsageSummary {
  providerRequests: number;
  settledRequests: number;
  unknownFeeRequests: number;
  notDispatchedRequests: number;
  localSteps: number;
  estimatedUsd: number | null;
  credits: number | null;
  unaccounted: boolean;
}

export interface CursorState {
  /** Trusted opaque token bound to account/tool/scope/sort/date window. */
  token: string | null;
  /** The provider-native cursor as returned by the adapter. */
  nativeCursor: string | null;
}

export interface ToolEnvelope {
  tool: ToolName;
  status: ToolStatus;
  /** Explicit reason for every non-success status and for local metadata. */
  reason: string | null;
  content: unknown;
  cursor: CursorState;
  gaps: Gap[];
  actions: ActionReceiptView[];
  usage: UsageSummary;
  /** True only when a pending submission port actually committed. */
  staged: boolean;
}

export const contentMetadata: Validator<ContentMetadata> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected metadata object');
  const record = value as Record<string, unknown>;
  if (record.applicable === true) {
    return obj({
      applicable: bool(),
      author: strNull(400),
      originalUrl: strNull(2000),
      publishedAt: strNull(100),
      retrievedAt: strNull(100),
      sourceRevision: intNull(1, Number.MAX_SAFE_INTEGER),
      locator: strNull(2000)
    })(value, path) as ContentMetadata;
  }
  if (record.applicable === false) {
    return obj({ applicable: bool(), reason: str(400) })(value, path) as ContentMetadata;
  }
  return fail(path, 'metadata must declare applicable true/false with full provenance or an explicit reason');
};

const gapV: Validator<Gap> = obj({ code: str(80), detail: str(2000) });
const cursorV: Validator<CursorState> = obj({ token: strNull(200), nativeCursor: strNull(2000) });
export const actionReceiptV: Validator<ActionReceiptView> = obj({
  actionId: strNull(200),
  kind: enumOf(['provider_request', 'provider_step', 'local_step', 'not_dispatched'] as const),
  endpoint: str(200),
  state: enumOf(['completed', 'failed', 'unknown', 'not_dispatched', 'unreconciled'] as const),
  estimatedUsd: numNull(),
  credits: numNull(),
  note: str(2000)
});
export const usageSummaryV: Validator<UsageSummary> = obj({
  providerRequests: int(0, 1_000_000),
  settledRequests: int(0, 1_000_000),
  unknownFeeRequests: int(0, 1_000_000),
  notDispatchedRequests: int(0, 1_000_000),
  localSteps: int(0, 1_000_000),
  estimatedUsd: numNull(),
  credits: numNull(),
  unaccounted: bool()
});

export const envelopeV: Validator<ToolEnvelope> = obj({
  tool: enumOf([
    'get_platform_capabilities', 'read_evidence', 'load_skill', 'discover_accounts', 'read_profile',
    'search_web', 'submit_candidates', 'request_confirmation', 'list_posts', 'read_post',
    'list_comments', 'read_thread', 'read_media', 'save_findings', 'report_progress'
  ] as const),
  status: enumOf(['success', 'partial', 'blocked', 'not_applicable', 'not_implemented', 'failed'] as const),
  reason: strNull(2000),
  content: (value: unknown) => value,
  cursor: cursorV,
  gaps: arr(gapV, 50),
  actions: arr(actionReceiptV, 100),
  usage: usageSummaryV,
  staged: bool()
});

/* ------------------------------------------------------------------ */
/* Per-tool payloads (output schemas)                                  */
/* ------------------------------------------------------------------ */

const localMeta = (reason: string): Validator<ContentMetadata> => (value, path) => {
  const meta = contentMetadata(value, path);
  if (meta.applicable !== false || meta.reason !== reason) fail(path, `expected inapplicable metadata with reason ${reason}`);
  return meta;
};

export const capabilitiesOutputV = obj({
  registryVersion: str(200),
  platform: str(200),
  operations: arr(obj({
    operation: str(200),
    state: enumOf(['supported', 'unsupported', 'unverified'] as const),
    sortOptions: arr(str(80), 20),
    dateRange: enumOf(['supported', 'unsupported'] as const),
    maxDepth: intNull(0, 64),
    limitation: strNull(2000),
    metadata: localMeta('catalog_entry')
  }), 32)
});

export const discoverAccountsOutputV = obj({
  discoveryStatus: enumOf(['checked_no_match', 'candidates', 'needs_input', 'inaccessible', 'unsupported', 'deferred'] as const),
  stopReason: strNull(200),
  nativeCursor: strNull(2000),
  items: arr(obj({
    candidateRef: str(200),
    platform: str(200),
    handle: strNull(200),
    profileUrl: strNull(2000),
    clue: strNull(2000),
    metadata: contentMetadata
  }), 50)
});

export const readProfileOutputV = obj({
  items: arr(obj({
    pageRole: enumOf(['profile', 'work', 'third_party'] as const),
    title: str(500),
    summary: str(8000),
    externalLinks: arr(str(2000), 40),
    metadata: contentMetadata
  }), 10)
});

export const searchWebOutputV = obj({
  items: arr(obj({
    clueKind: enumOf(['candidate', 'source'] as const),
    title: str(500),
    excerpt: str(8000),
    limitation: strNull(2000),
    metadata: contentMetadata
  }), 20),
  nativeCursor: strNull(2000)
});

export const submitCandidatesOutputV = obj({
  batchRef: strNull(200),
  acceptedCount: int(0, 500),
  note: strNull(2000),
  metadata: localMeta('controller_ack')
});

export const requestConfirmationOutputV = obj({
  confirmationRef: strNull(200),
  question: str(2000),
  options: arr(obj({ optionId: str(200), label: str(500), discriminator: str(2000) }), 10),
  selectionSemantics: enumOf(['records_intent_only'] as const),
  metadata: localMeta('controller_ack')
});

export const readEvidenceOutputV = obj({
  items: arr(obj({
    evidenceId: str(200),
    sourceId: str(200),
    sourceRevision: int(1, Number.MAX_SAFE_INTEGER),
    role: enumOf(['identity_support', 'identity_counterevidence', 'factual_support', 'factual_counterevidence'] as const),
    quote: str(20000),
    quoteHash: str(200),
    metadata: contentMetadata
  }), 100)
});

export const loadSkillOutputV = obj({
  skillId: str(200),
  version: str(200),
  hash: str(200),
  body: str(100000),
  dependencies: arr(str(200), 50),
  metadata: localMeta('local_skill')
});

export const saveFindingsOutputV = obj({
  status: enumOf(['pending'] as const),
  submitted: arr(obj({
    pendingRef: strNull(200),
    findingKind: enumOf(['collected_finding', 'verification_check'] as const),
    // One finding allows 100 support + 100 counter + 100 coverage accounts.
    accountIds: arr(str(200), 300),
    dependencyEvidenceIds: arr(str(200), 200)
  }), 50),
  notSubmitted: arr(obj({ index: int(0, 1000), reason: str(2000) }), 50),
  metadata: localMeta('submission_ack')
});

export const reportProgressOutputV = obj({
  recorded: bool(),
  gaps: arr(str(2000), 50),
  note: strNull(4000),
  metadata: localMeta('progress_receipt')
});

export const listPostsOutputV = obj({
  items: arr(obj({
    itemId: str(200),
    sourceId: str(200),
    sourceRevision: int(1, Number.MAX_SAFE_INTEGER),
    authorAccountId: str(200),
    title: str(500),
    excerpt: str(8000),
    metadata: contentMetadata
  }), 50),
  sort: str(80),
  nativeCursor: strNull(2000)
});

export const readPostOutputV = obj({
  item: obj({
    itemId: str(200),
    sourceId: str(200),
    sourceRevision: int(1, Number.MAX_SAFE_INTEGER),
    authorAccountId: str(200),
    title: str(500),
    text: str(100000),
    metadata: contentMetadata
  })
});

export const listCommentsOutputV = obj({
  items: arr(obj({
    commentId: str(200),
    rootItemId: str(200),
    parentCommentId: strNull(200),
    authorAccountId: str(200),
    authorRole: enumOf(['subject', 'third_party', 'unknown'] as const),
    createdAt: strNull(100),
    excerpt: str(8000),
    metadata: contentMetadata
  }), 100),
  ordering: enumOf(['top', 'new', 'provider_default'] as const),
  nativeCursor: strNull(2000)
});

export const readThreadOutputV = obj({
  nodes: arr(obj({
    nodeId: str(200),
    parentNodeId: strNull(200),
    rootNodeId: str(200),
    authorAccountId: str(200),
    authorRole: enumOf(['subject', 'third_party', 'unknown'] as const),
    depth: intNull(0, 64),
    createdAt: strNull(100),
    state: enumOf(['present', 'missing', 'deleted', 'hidden'] as const),
    /** Readable dialogue text/excerpt; null requires an explicit reason. */
    text: strNull(100000),
    textUnavailableReason: strNull(500),
    metadata: contentMetadata
  }), 200),
  missingNodeIds: arr(str(200), 100),
  truncation: obj({
    truncated: bool(),
    reason: strNull(2000),
    depthRequested: intNull(0, 64),
    depthReached: intNull(0, 64)
  })
});

export const readMediaOutputV = obj({
  mediaRef: str(200),
  text: strNull(100000),
  captions: strNull(100000),
  mediaUnread: bool(),
  conversion: obj({
    authorized: bool(),
    state: enumOf(['not_attempted', 'succeeded', 'failed', 'blocked'] as const),
    note: strNull(2000)
  }),
  metadata: contentMetadata
});

/* ------------------------------------------------------------------ */
/* Per-tool inputs (strict, untrusted)                                 */
/* ------------------------------------------------------------------ */

const taskRefV = (value: unknown, path: string) => {
  if (typeof value !== 'object' || value === null) fail(path, 'expected task reference');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'research_task') return obj({ kind: enumOf(['research_task'] as const), taskId: str(200), checkId: str(200) })(value, path);
  if (kind === 'question_matrix') return obj({ kind: enumOf(['question_matrix'] as const), slot: enumOf(['experience', 'work', 'expression', 'interaction', 'change', 'counterevidence'] as const) })(value, path);
  return fail(path, 'unknown task reference kind', 'unknown_key');
};

const coverageDeltaV = obj({
  locator: obj({ accountId: str(200), sourceId: str(200), sourceRevision: int(1, Number.MAX_SAFE_INTEGER) }),
  taskRef: taskRefV,
  status: enumOf(['unseen', 'evidence_found', 'conflicting', 'resolved_unknown', 'blocked'] as const)
});

export const toolInputs = {
  get_platform_capabilities: obj({ platform: str(200) }),
  discover_accounts: obj({ platform: str(200), query: str(2000), rules: opt(strNull(2000)), cursor: opt(strNull(200)) }),
  read_profile: obj({ accountId: str(200) }),
  search_web: obj({ query: str(2000), platform: opt(strNull(200)), dateFrom: opt(strNull(100)), dateTo: opt(strNull(100)), cursor: opt(strNull(200)) }),
  submit_candidates: obj({
    candidates: arr(obj({
      candidateRef: str(200),
      platform: str(200),
      handle: strNull(200),
      supportEvidenceIds: arr(str(200), 50),
      counterEvidenceIds: arr(str(200), 50),
      sourceGroup: strNull(200)
    }), 50),
    note: opt(strNull(2000))
  }),
  request_confirmation: obj({
    question: str(2000),
    options: arr(obj({ optionId: str(200), label: str(500), discriminator: str(2000) }), 10),
    note: opt(strNull(2000))
  }),
  read_evidence: obj({
    evidence: arr(obj({ evidenceId: str(200), sourceRevision: opt(intNull(1, Number.MAX_SAFE_INTEGER)), locator: opt(strNull(2000)) }), 100)
  }),
  load_skill: obj({ skillId: str(200), version: str(200), hash: str(200) }),
  save_findings: obj({
    findings: arr(obj({
      kind: enumOf(['collected_finding', 'verification_check'] as const),
      statement: str(20000),
      supportEvidenceIds: arr(str(200), 100),
      counterEvidenceIds: arr(str(200), 100),
      coverageDelta: opt(arr(coverageDeltaV, 100)),
      note: opt(strNull(4000))
    }), 50)
  }),
  report_progress: obj({ note: opt(strNull(4000)), gaps: opt(arr(str(2000), 50)), completedSteps: opt(intNull(0, 1_000_000)) }),
  list_posts: obj({ accountId: str(200), sort: opt(strNull(80)), dateFrom: opt(strNull(100)), dateTo: opt(strNull(100)), cursor: opt(strNull(200)) }),
  read_post: obj({ accountId: str(200), itemId: str(200) }),
  list_comments: obj({ accountId: str(200), itemId: str(200), sort: opt(strNull(80)), cursor: opt(strNull(200)) }),
  read_thread: obj({ accountId: str(200), itemId: str(200), parentRef: opt(strNull(200)), depth: opt(intNull(0, 64)) }),
  read_media: obj({ accountId: str(200), itemId: str(200), mediaRef: str(200) })
} satisfies Record<ToolName, Validator<unknown>>;

export const toolOutputs = {
  get_platform_capabilities: capabilitiesOutputV,
  discover_accounts: discoverAccountsOutputV,
  read_profile: readProfileOutputV,
  search_web: searchWebOutputV,
  submit_candidates: submitCandidatesOutputV,
  request_confirmation: requestConfirmationOutputV,
  read_evidence: readEvidenceOutputV,
  load_skill: loadSkillOutputV,
  save_findings: saveFindingsOutputV,
  report_progress: reportProgressOutputV,
  list_posts: listPostsOutputV,
  read_post: readPostOutputV,
  list_comments: listCommentsOutputV,
  read_thread: readThreadOutputV,
  read_media: readMediaOutputV
} satisfies Record<ToolName, Validator<unknown>>;

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/** The 8 provider-backed tools; unwired handlers return not_implemented. */
export type ProviderToolName =
  | 'discover_accounts' | 'read_profile' | 'search_web'
  | 'list_posts' | 'read_post' | 'list_comments' | 'read_thread' | 'read_media';

export interface ToolContract {
  readonly name: ToolName;
  readonly roles: readonly ToolRole[];
  readonly phases: readonly ToolPhase[];
  readonly billing: 'provider' | 'local';
  /** Underlying adapter requests one call may expand to. */
  readonly providerRequests: { readonly min: number; readonly max: number };
  readonly requiresAccount: boolean;
  readonly usesCursor: boolean;
  readonly input: Validator<unknown>;
  readonly output: Validator<unknown>;
}

const local = (name: ToolName, roles: readonly ToolRole[], phases: readonly ToolPhase[]): ToolContract => ({
  name, roles, phases, billing: 'local', providerRequests: { min: 0, max: 0 }, requiresAccount: false, usesCursor: false,
  input: toolInputs[name], output: toolOutputs[name]
});

const provider = (
  name: ProviderToolName,
  roles: readonly ToolRole[],
  phases: readonly ToolPhase[],
  options: { min: number; max: number; requiresAccount: boolean; usesCursor: boolean }
): ToolContract => ({
  name, roles, phases, billing: 'provider',
  providerRequests: { min: options.min, max: options.max },
  requiresAccount: options.requiresAccount,
  usesCursor: options.usesCursor,
  input: toolInputs[name], output: toolOutputs[name]
});

const SEARCH: readonly ToolRole[] = ['search'];
const FETCH: readonly ToolRole[] = ['fetch'];
const BOTH: readonly ToolRole[] = ['search', 'fetch'];
const ALL_PHASES: readonly ToolPhase[] = ['search', 'fetch', 'verify'];
const FETCH_PHASES: readonly ToolPhase[] = ['fetch'];
const SEARCH_PHASES: readonly ToolPhase[] = ['search'];

export const TOOL_REGISTRY: Readonly<Record<ToolName, ToolContract>> = {
  get_platform_capabilities: local('get_platform_capabilities', BOTH, ALL_PHASES),
  read_evidence: local('read_evidence', BOTH, ALL_PHASES),
  load_skill: local('load_skill', BOTH, ALL_PHASES),
  discover_accounts: provider('discover_accounts', SEARCH, SEARCH_PHASES, { min: 0, max: 1, requiresAccount: false, usesCursor: true }),
  read_profile: provider('read_profile', SEARCH, SEARCH_PHASES, { min: 0, max: 1, requiresAccount: true, usesCursor: false }),
  search_web: provider('search_web', SEARCH, SEARCH_PHASES, { min: 1, max: 1, requiresAccount: false, usesCursor: true }),
  submit_candidates: local('submit_candidates', SEARCH, SEARCH_PHASES),
  request_confirmation: local('request_confirmation', SEARCH, SEARCH_PHASES),
  list_posts: provider('list_posts', FETCH, FETCH_PHASES, { min: 0, max: 1, requiresAccount: true, usesCursor: true }),
  read_post: provider('read_post', FETCH, FETCH_PHASES, { min: 0, max: 1, requiresAccount: true, usesCursor: false }),
  list_comments: provider('list_comments', FETCH, FETCH_PHASES, { min: 0, max: 1, requiresAccount: true, usesCursor: true }),
  read_thread: provider('read_thread', FETCH, FETCH_PHASES, { min: 0, max: 6, requiresAccount: true, usesCursor: false }),
  read_media: provider('read_media', FETCH, FETCH_PHASES, { min: 0, max: 1, requiresAccount: true, usesCursor: false }),
  save_findings: local('save_findings', FETCH, ['fetch', 'verify']),
  report_progress: local('report_progress', FETCH, FETCH_PHASES)
};

export const TOOL_NAMES: readonly ToolName[] = Object.keys(TOOL_REGISTRY) as ToolName[];

/** Verify is a Fetch phase with a strict three-tool allowlist; shared tools earn no extra entry. */
export const VERIFY_PHASE_TOOLS: readonly ToolName[] = ['read_evidence', 'load_skill', 'save_findings'];

/** Static role×phase admission used by dispatch and by contract tests. */
export function toolAllowedFor(name: ToolName, role: ToolRole, phase: ToolPhase): boolean {
  const contract = TOOL_REGISTRY[name];
  if (!contract) return false;
  if (!contract.roles.includes(role)) return false;
  if (phase === 'verify') return role === 'fetch' && (VERIFY_PHASE_TOOLS as readonly string[]).includes(name);
  if (role === 'search' && phase !== 'search') return false;
  if (role === 'fetch' && phase !== 'fetch') return false;
  return contract.phases.includes(phase);
}
