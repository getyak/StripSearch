# X single-account deep research implementation plan

> Execute through superpowers:subagent-driven-development with separate provider, analysis and integration ownership. The user explicitly authorized implementation and real acceptance, so continue through delivery without another design approval gate.

**Goal:** Read accessible X history and contextual originals, analyze and independently verify Chinese account findings, then accept the real account through the existing product.

**Spec:** `docs/design/x-account-deep-research-2026-10-22.md`.

**Architecture:** A dedicated single-X-account workflow uses the existing action ledger, source store, frozen first-step binding and canonical report. Existing multi-account/person runs keep their historical semantics. Provider responses are parsed from documented requests and privately observed payload shapes. Separate analysis and verification ports return source-bound account findings; the same projection serves UI and exports.

## Global constraints

- No credentials, private paths or third-party originals in Git. Synthetic offline fixtures only.
- Preserve earlier user work and the original failed research; live acceptance is a new account-only task.
- No automatic retry of unknown paid actions; stop on cancellation, scope withdrawal or source revocation.
- A cursor ending proves only endpoint-accessible history, never all X history or a full comment tree.
- Keep actual authors distinct, including reposts and third-party context.
- Deploy only the existing managed Web and verify health, release and entry assets; keep auxiliary tools on demand.

## Tasks

1. Provider: verify official endpoints and live shapes, implement a one-request port with pagination, detail and comments, test malformed/foreign/long-text responses.
2. Analysis: bounded full-corpus batches, independent semantic verification, final Chinese synthesis and re-verification, source/hash/actor-aware canonical projection and withdrawal tests.
3. Integration: durable feed/context queues with replay-safe metering, native account binding, active checks, progress/coverage; route new selected single-X scopes into this workflow, keep account and person exports separate.
4. Acceptance: run targeted and full offline checks, independent review, managed release; create a real single-X-account task for the specified account, inspect actual pagination/context/model receipts and Chinese report, correct failures and repeat the affected flow.

## Review focus

Empty filtered pages with a next cursor; cursor cycles and overlapping pages; replies listed under other authors; target retweets containing someone else's text; short replies-list previews; unknown paid results after restart; withdrawn roots and derived findings; non-Chinese or unsupported synthesis; a useful partial analysis when a provider scope is incomplete.
