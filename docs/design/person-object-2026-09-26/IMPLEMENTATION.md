# Person Research Release Implementation Plan

**Goal:** Ship the approved person-first research flow with bounded iterative research, evidence-backed Person Object, exports, real provider verification and an exact-revision deployment.
**Architecture:** Keep existing authentication, SQLite owner isolation, runs and SSE. Add a persistent research controller and narrow provider tools. DSH is the intended model execution adapter; the controller owns durable state, budgets, evidence and identity.
**Tech stack:** Node 22.23.2, TypeScript, SQLite, Express, vanilla client; locked DSH runtime/SDK.
**Spec:** docs/design/person-object-2026-09-26/{PRODUCT,TECHNICAL,COST-EVAL,REVIEW}.md.

## Constraints
- The user approved implementation, PR and deployment. Use isolated branches and independent review.
- Never put keys, user archives, raw third-party research or private receipts in Git. Offline tests use synthetic data and make no network requests.
- Preserve legacy explicit github/exa requests, old records, authentication, exclusion/revision semantics and evaluation workbench.
- No source selector in normal entry. Input may be a name, research request or HTTPS profile URL.
- Research budget is enforced per outbound call; no unmetered retries. Unknown charges are described as estimates, not a provider invoice.
- API/live validation cap for this delivery: at most 6 full research tasks, 40 model calls, 60 search/fetch/social calls; stop at first usable evidence for each acceptance case. Operational balance/metadata calls separately recorded.

## Frozen integration surface
- ProviderName adds 'research'. POST /api/runs accepts {input:string} as new canonical entry; legacy {question,seedUrl,provider} remains supported. No provider means research when available; no silent provider substitution.
- CanonicalView gains optional personObject and research fields; existing fields remain renderable.
- Research metadata includes phase, stopReason, unresolved questions, steps and budget summary. Keep existing RunState values and stage events.
- Identity candidate adds optional candidateId and profileUrl. POST /api/runs/:id/resume accepts {candidateId,expectedRevision} and resolves only stored candidates for that owner/run; legacy seedUrl remains validated.
- Research plan decision boundary is JSON: action search/read/social/finish; query or URL; reason. Final claims must cite known active source keys; unknown citations are rejected. A source's identity match, factual support and inference remain separate.
- Exports: existing export?format=json|md plus html|pdf. Same canonical projection and revision; PDF may be unavailable only with clear typed error when renderer not installed.
- New planner module must expose an injectable interface so DSH can be integrated without altering persistence/budget semantics. Never claim direct HTTP is DSH.

## Work packages
1. Backend (Pi): types, provider routing/config, persistent checkpoints/action ledger, identity resolution, bounded model/tool loop, evidence validation, stable owner-scoped person IDs, canonical exports and offline failure tests.
2. Client (native agent): single input, immediate run display, concise stages, candidate choice, person summary/evidence, exports, mobile/accessibility/error states. Preserve auth/history/review.
3. DSH (native agent): exact version, minimal no-shell profile, disabled session telemetry, isolated worker lifecycle, typed decision adapter and offline lifecycle validation. All real model requests must use metered boundary.
4. Integration and release (root): configure keys in secret manager and runtime only; verify provider authentication with bounded live calls; assemble modules; run applicable checks, independent review, PR exact-head CI, merge/deploy/readback; update user-facing docs and Notion.

## Review focus / acceptance
- Wrong-person evidence never produces resolved/completed claims; ambiguous names enter needs_input and choices survive refresh.
- Crash after a charged action does not blindly repeat it; completed receipts survive resume; unknown outcome is partial with explanation.
- Cancel/delete/revoke prevents late publication; excluded sources invalidate all dependent facts/exports.
- Malicious URLs, returned URL mismatch, untrusted model tool requests and source prompt injection cannot read local networks/files or expose secrets.
- Cap reached, 401/403/429, invalid structured output, stale identity choice, unavailable provider and PDF failure are visible and bounded.
- Run tests/typecheck/build/offline eval/design checks, then authenticated real browser and API acceptance with public professional or self-authorized material; keep artifacts private.
- Delivery evidence must identify PR, CI head, merge SHA and /release.json; no quality perfection or broad platform claims without evidence.

