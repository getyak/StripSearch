# Burn-down Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans; this sprint uses explicitly authorized parallel independent workstreams and independent final review. Track progress in STATUS.md.

**Goal:** Deliver A–E with a source-backed architecture inventory, meaningful hotspot tests, a behavior-preserving measured refactor, synthetic offline evals and history-backed release drafts.

**Architecture:** Keep the existing authority/storage/contracts intact. Independent workers own disjoint files; the controller owns docs/status/package integration, full verification and PR delivery. Optimize Fetch coverage projection with call-local indexes only, retaining fresh authority and revocation evaluation.

**Tech Stack:** Node 22.23.2, TypeScript, node:test, SQLite, Python stdlib.

**Spec:** User sprint checklist plus [architecture map](../../sprints/2026-10-13/architecture-map.md), [coverage contract](../../fetch-coverage.md), [maintenance contract](../../code-maintenance.md), [evaluation boundary](../../evaluation.md).

## Global Constraints

- No network/paid API calls in offline checks; never fetch example.org fixture URLs.
- No credentials, private research, local paths or private Notion IDs in committed artifacts.
- Preserve identity/factual/analysis separation, provenance, revocation, canonical hashes and explicit partial/unknown states.
- Hosted signup remains open by default; no changes to production provider protocols, budgets or distributed execution claims.
- Read README, relevant design documents and roadmap before behavior changes. Full checks run once centrally to respect resource constraints.

## Review Focus

- Same-name, denial and third-party biography evidence cannot promote unsupported identity.
- Late result or scope revision cannot revive revoked authority.
- Projection indexing must preserve receipt ordering, content identity, stale dimensions and empty/unknown denominators.
- Eval runner must reject malformed fixture/expectation, retain failures and remain offline.
- Benchmark must compare equal observable outputs, disclose methodology and avoid production latency claims.

## Tasks

1. [x] A — Map current process, HTTP, stores, providers, contracts, renderers, evals and release boundary; inventory reproducible static imports/size/churn.
2. [x] B — Add independently meaningful tests in new `apps/web/src/tests/sprint-*.test.ts`; prioritize first-step identity/authority and runtime failure paths. Before fixes reproduce a failure; report discovered production bugs to controller rather than overlap C. Write `docs/sprints/2026-10-13/hotspot-tests.md` with command/count/limits.
3. [x] C — First inspect `FetchCoverageStore.project`; characterize outputs including receipt history, revocation and scope. Refactor only `server/research/fetch-coverage-store.ts` plus optional tightly scoped helper. Add a benchmark script, characterization tests and `coverage-benchmark.md` with repeated equal-output baseline/current measurements. No long-lived authority cache, no schema/hash changes. Optimize a proven repeated lookup rather than rewrite subsystem.
4. [x] D — Create `evals/sprint-contract-v1` synthetic fixtures and a separate `src/evals/sprint-contract-v1` offline runner with schema/expectation validation and actual production calls. Cover identity, uncertainty, revocation or tool-role boundaries; emit machine-readable case results and nonzero on failure. Add dedicated tests, README and replay output; do not edit existing versioned baselines or advertise human gold.
5. [x] E — Write sprint history changelog and release draft from verified first-parent git history. Include commit references, verification boundaries and unreleased current sprint items; no inferred release/deployment success.
6. [ ] Integration — Run full tests, typecheck/build, static design/dataset checks, existing and new evals. Dispatch strongest-model independent review, fix confirmed findings, rerun affected checks, commit and create draft PR with exact evidence. Attach PR and preserve worktree/source. Record local-service/Notion verification only when actually performed.
