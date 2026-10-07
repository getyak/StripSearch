/**
 * Checked-in core SQL for the StripSearch web alpha.
 *
 * Better Auth owns its own user/session/account tables and applies them through
 * `getMigrations`; this schema only covers research runs, sources, observations
 * and the ordered event log.
 */
export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  parent_run_id TEXT,
  retry_of TEXT,
  followup INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  question TEXT NOT NULL,
  seed_url TEXT,
  provider TEXT NOT NULL,
  idempotency_key TEXT,
  body_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  identity_json TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  stop_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS runs_owner_created ON runs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);

CREATE TABLE IF NOT EXISTS research_checkpoints (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 data_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_actions (
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 action_key TEXT NOT NULL,
 kind TEXT NOT NULL,
 state TEXT NOT NULL,
 request_json TEXT NOT NULL,
 result_json TEXT,
 usage_json TEXT,
 reserved_input INTEGER NOT NULL DEFAULT 0,
 reserved_output INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 settled_at TEXT,
 PRIMARY KEY (run_id, action_key)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  fetch_status TEXT NOT NULL,
  excerpt TEXT,
  excerpt_locator TEXT,
  identity_label TEXT NOT NULL,
  identity_confirmed INTEGER NOT NULL DEFAULT 0,
  limits_json TEXT NOT NULL DEFAULT '[]',
  excluded INTEGER NOT NULL DEFAULT 0,
  excluded_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, source_key)
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_keys_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS run_events_run_seq ON run_events(run_id, seq);

-- Annotation workbench: immutable case snapshots and append-only human labels.
CREATE TABLE IF NOT EXISTS review_cases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  seed_key TEXT,
  dataset_version TEXT NOT NULL,
  split TEXT NOT NULL DEFAULT 'discovery',
  kind TEXT NOT NULL DEFAULT 'user',
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  as_of TEXT,
  badge TEXT,
  rubric_version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS review_cases_owner ON review_cases(owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS review_cases_seed ON review_cases(owner_id, seed_key) WHERE seed_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_annotations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_pseudonym TEXT NOT NULL,
  case_hash TEXT NOT NULL,
  rubric_version INTEGER NOT NULL,
  decisions_json TEXT NOT NULL,
  preference TEXT,
  rationale TEXT,
  reason_tags_json TEXT NOT NULL DEFAULT '[]',
  reference_answer TEXT,
  must_include_json TEXT NOT NULL DEFAULT '[]',
  must_avoid_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(case_id, revision)
);
CREATE INDEX IF NOT EXISTS review_annotations_case ON review_annotations(case_id, revision DESC);
CREATE INDEX IF NOT EXISTS review_annotations_owner ON review_annotations(owner_id, created_at DESC);

-- Candidate-free research task library: immutable, owner-scoped evaluation
-- specifications. Never executed here (executionStatus is always not_run and
-- human labels are always empty); fully separate from review_cases so the
-- existing answer-pair cases keep their schemas, hashes and records.
CREATE TABLE IF NOT EXISTS review_research_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, dataset_version, external_id)
);
CREATE INDEX IF NOT EXISTS review_research_tasks_owner ON review_research_tasks(owner_id, created_at ASC, id ASC);

-- Platform discovery: durable tasks with checkpoints, explicit identity
-- corrections and post tracking whose attribution can be revoked.
CREATE TABLE IF NOT EXISTS discovery_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_value TEXT NOT NULL,
  authorization TEXT NOT NULL,
  seed_url TEXT,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  idempotency_key TEXT,
  body_fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  checkpoint_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  stop_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  needs_input_prompt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS discovery_tasks_owner ON discovery_tasks(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS discovery_tasks_state ON discovery_tasks(state);

CREATE TABLE IF NOT EXISTS discovery_idempotency_keys (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TABLE IF NOT EXISTS discovery_probes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES discovery_tasks(id) ON DELETE CASCADE,
  probe_key TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  handle TEXT,
  profile_url TEXT,
  evidence_json TEXT NOT NULL,
  verification TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL DEFAULT '[]',
  requests INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, probe_key)
);
CREATE INDEX IF NOT EXISTS discovery_probes_task ON discovery_probes(task_id, sort_order);

CREATE TABLE IF NOT EXISTS account_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES discovery_tasks(id) ON DELETE CASCADE,
  platform_id TEXT NOT NULL,
  handle TEXT,
  profile_url TEXT,
  state TEXT NOT NULL,
  basis_json TEXT NOT NULL DEFAULT '[]',
  counterevidence TEXT,
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, platform_id)
);
CREATE INDEX IF NOT EXISTS account_links_task ON account_links(task_id, created_at);

CREATE TABLE IF NOT EXISTS account_link_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES discovery_tasks(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES account_links(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  note TEXT,
  counterevidence TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(link_id, revision)
);
CREATE INDEX IF NOT EXISTS account_link_revisions_task ON account_link_revisions(task_id, id);

CREATE TABLE IF NOT EXISTS tracked_posts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES discovery_tasks(id) ON DELETE CASCADE,
  account_link_id TEXT NOT NULL REFERENCES account_links(id) ON DELETE CASCADE,
  post_key TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT,
  excerpt_locator TEXT,
  fetch_status TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '[]',
  excluded INTEGER NOT NULL DEFAULT 0,
  excluded_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, post_key)
);
CREATE INDEX IF NOT EXISTS tracked_posts_task ON tracked_posts(task_id, sort_order);

CREATE TABLE IF NOT EXISTS discovery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES discovery_tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS discovery_events_task_seq ON discovery_events(task_id, seq);

CREATE TABLE IF NOT EXISTS discovery_imports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES discovery_tasks(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  report_format TEXT NOT NULL,
  tool_version TEXT,
  generated_at TEXT,
  result_count INTEGER NOT NULL,
  warning_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discovery_imports_task ON discovery_imports(task_id, created_at);

-- GET-58 research case domain (shared/research-case.ts). Additive only: old
-- alpha databases, tables and reports stay readable. Stable case/person/
-- account/source/evidence/claim ids, immutable scope versions with real
-- per-account selection/allowedScope snapshots, and append-only source
-- revisions. Foundations for later scheduling/coverage issues; no tasks,
-- leases or workers here.
CREATE TABLE IF NOT EXISTS research_cases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  scope_version INTEGER NOT NULL DEFAULT 1,
  person_revision INTEGER NOT NULL DEFAULT 1,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS research_cases_owner ON research_cases(owner_id, created_at DESC);

-- Append-only scope journal: every row is an immutable before/after snapshot
-- of the actual per-account selection and allowed scope. Version-advancing
-- scope mutations write one row at the new version; account baselines are
-- recorded at the version in effect, so old scope stays readable after later
-- changes and across reopens.
CREATE TABLE IF NOT EXISTS research_case_scope_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  scope_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '[]',
  after_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_case_scope_versions_case ON research_case_scope_versions(case_id, id);

CREATE TABLE IF NOT EXISTS research_case_accounts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT,
  profile_url TEXT,
  identity_support_json TEXT NOT NULL,
  user_selection_json TEXT NOT NULL,
  allowed_scope_json TEXT NOT NULL,
  research_value_json TEXT NOT NULL,
  access_coverage_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Same-platform multiple accounts are allowed; no UNIQUE(case_id, platform).
CREATE INDEX IF NOT EXISTS research_case_accounts_case ON research_case_accounts(case_id, created_at);

CREATE TABLE IF NOT EXISTS research_case_sources (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES research_case_accounts(id) ON DELETE CASCADE,
  latest_revision INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_case_sources_case ON research_case_sources(case_id, created_at);

CREATE TABLE IF NOT EXISTS research_case_source_revisions (
  source_id TEXT NOT NULL REFERENCES research_case_sources(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  author TEXT,
  original_url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  locator TEXT,
  content_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, revision)
);

CREATE TABLE IF NOT EXISTS research_case_evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES research_case_accounts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  role TEXT NOT NULL,
  quote TEXT NOT NULL,
  locator TEXT,
  quote_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (source_id, source_revision)
    REFERENCES research_case_source_revisions(source_id, revision)
);
CREATE INDEX IF NOT EXISTS research_case_evidence_case ON research_case_evidence(case_id, created_at);

CREATE TABLE IF NOT EXISTS research_case_claims (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES research_case_accounts(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  kind TEXT NOT NULL,
  limitations_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  withdrawn_at TEXT
);
CREATE INDEX IF NOT EXISTS research_case_claims_case ON research_case_claims(case_id, created_at);

CREATE TABLE IF NOT EXISTS research_case_claim_evidence (
  claim_id TEXT NOT NULL REFERENCES research_case_claims(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES research_case_evidence(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (claim_id, evidence_id, role)
);

-- Per-content coverage items: keyed by (locator, taskRef) where the locator is
-- accountId + stable source id + source revision, so cross-account data is
-- never mixed and different posts/revisions stay distinct. Items are never
-- rebound; writes append immutable revisions that keep each write's
-- scopeVersion as historical provenance.
CREATE TABLE IF NOT EXISTS research_case_item_coverage (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES research_case_accounts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  task_ref_key TEXT NOT NULL,
  task_ref_json TEXT NOT NULL,
  latest_revision INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(case_id, account_id, source_id, source_revision, task_ref_key),
  FOREIGN KEY (source_id, source_revision)
    REFERENCES research_case_source_revisions(source_id, revision)
);
CREATE INDEX IF NOT EXISTS research_case_coverage_case ON research_case_item_coverage(case_id, sort_order);

CREATE TABLE IF NOT EXISTS research_case_item_coverage_revisions (
  item_id TEXT NOT NULL REFERENCES research_case_item_coverage(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  scope_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  counterevidence_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, revision)
);

-- GET-60 completion policy foundations (shared/research-completion.ts).
-- Additive only. Frozen scope specifications are immutable rules (questions
-- with applicability reasons, full platform registry snapshot, account range,
-- time window, body/media/default comment/thread depth), never a hand-picked
-- corpus. One row per authoritative case scopeVersion; the first freeze binds
-- the version in effect and later edits advance the version through the
-- shared case-level scope path and append a new row. The account slice is
-- copied and hashed in the same transaction (scope_event_id anchors the
-- journal row), so old scope is never reconstructed from current account rows.
CREATE TABLE IF NOT EXISTS research_case_completion_scopes (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  scope_version INTEGER NOT NULL,
  registry_version TEXT NOT NULL,
  registry_hash TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  account_slice_json TEXT NOT NULL,
  account_slice_hash TEXT NOT NULL,
  scope_event_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, scope_version)
);
CREATE INDEX IF NOT EXISTS research_case_completion_scopes_case ON research_case_completion_scopes(case_id, created_at);

-- Immutable observation/attempt receipts bound to case + frozen spec +
-- obligation. Structured action/result/stop reason/access boundary/remaining
-- unknown plus validated account/source/evidence/coverage references. A free
-- text note can never establish completion; unattempted, budget exhaustion,
-- permission failure and unsupported stay distinct recorded states.
CREATE TABLE IF NOT EXISTS research_case_completion_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  scope_spec_id TEXT NOT NULL REFERENCES research_case_completion_scopes(id) ON DELETE CASCADE,
  scope_version INTEGER NOT NULL,
  obligation_key TEXT NOT NULL,
  obligation_json TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  attempt_state TEXT NOT NULL,
  stop_reason TEXT,
  access_boundary TEXT,
  remaining_unknown TEXT,
  note TEXT,
  payload_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  synthetic INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_case_completion_obs_case
  ON research_case_completion_observations(case_id, scope_spec_id, seq);

-- Append-only assessments: each stores the exact selected input snapshot, the
-- original deterministic verdict and policyVersion/scopeVersion/
-- evidenceRevision/inputHash. Historical verdicts are never rewritten;
-- current validity is derived separately at read time.
CREATE TABLE IF NOT EXISTS research_case_completion_assessments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  scope_spec_id TEXT NOT NULL REFERENCES research_case_completion_scopes(id) ON DELETE CASCADE,
  scope_version INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  verdict TEXT NOT NULL,
  evaluation_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_case_completion_assessments_case
  ON research_case_completion_assessments(case_id, created_at, id);

-- GET-95 fetch processing coverage (shared/research-fetch-coverage.ts).
-- Additive only. Append-only per-content processing receipts with caller
-- replay identity: re-recording the same receipt key with the same body is a
-- no-op and the same key with a different body is a rejected conflict. Every
-- receipt binds one immutable case source revision and one independent
-- processing dimension (body / media / default first-page comments / one
-- selected thread branch). seq is the only ordering authority (never the
-- clock). Successes and skips here never change frozen completion rules,
-- identity or publication state; nothing in this table is a GET-60 policy
-- observation, assessment or report.
CREATE TABLE IF NOT EXISTS research_case_fetch_receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  case_id TEXT NOT NULL REFERENCES research_cases(id) ON DELETE CASCADE,
  receipt_key TEXT NOT NULL,
  scope_version INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES research_case_accounts(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  branch_key TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  parents_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  counterevidence_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  body_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, receipt_key),
  FOREIGN KEY (source_id, source_revision)
    REFERENCES research_case_source_revisions(source_id, revision)
);
CREATE INDEX IF NOT EXISTS research_case_fetch_receipts_content
  ON research_case_fetch_receipts(case_id, account_id, source_id, source_revision, seq);
CREATE INDEX IF NOT EXISTS research_case_fetch_receipts_case
  ON research_case_fetch_receipts(case_id, seq);
`;
