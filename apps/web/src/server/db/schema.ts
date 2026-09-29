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
`;
