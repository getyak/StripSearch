# Account reading refinement implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement the existing account-comparison direction in this session, task by task.

**Goal:** Keep account selection predictable and make the real workspace as readable as the approved account-comparison concept.

**Architecture:** Preserve discovery, identity and frozen-scope decisions. Fix presentation state in the controlled renderer, simplify row actions and improve the existing workspace styles. Keep the current single Web service and its data.

**Tech Stack:** Existing TypeScript, native HTML disclosures, CSS and Node tests. No new runtime dependencies.

**Spec:** `docs/design/account-comparison-2026-10-21.md`, root `DESIGN.md`, and the supplied account-comparison concept.

## Global constraints

- Preserve unrelated local design work, credentials and research data.
- Selection never grants identity support; conflicts and independent scope remain visible.
- No provider, model or fixture network calls in offline checks.
- Ship only through the existing single-instance service manager; verify the actual entry and revision.

## Review focus

- Explicitly closed disclosures stay closed after checkboxes, search and refreshed results.
- Reading or copying row text never changes a checkbox.
- More actions remain reachable by keyboard; Escape restores focus.
- Long account handles, invalid evidence and narrow screens remain readable.
- Old unresolved-person runs keep their original scope restrictions.

## Task 1: Stable presentation state

- [x] Add regression tests for closed disclosures across choices, filters and updates; observe the original failures.
- [x] Preserve both true and false disclosure states; remove blank-row selection.
- [x] Verify selection counts, drafts, focus and existing identity/scope regressions.

## Task 2: Readable comparison and sidebar

- [x] Keep secondary actions in an explicit native menu; test Escape and selection isolation.
- [x] Keep shared boundary boilerplate out of the content column, without hiding conflict or provenance.
- [x] Apply readable type, platform tiles, aligned tracks, neutral workspace surfaces and compact history labels.
- [x] Verify desktop, medium and narrow viewports using the real renderer.

## Task 3: Verification and delivery

- [x] Run typecheck, full offline tests, production build and design check.
- [x] Review the scoped diff and commit only this task's files.
- [x] Update the existing managed service, read back health/revision/assets, and test selection and disclosure in the actual workspace.
- [x] Record verified state in the existing Notion workspace; report any remaining gates separately.
