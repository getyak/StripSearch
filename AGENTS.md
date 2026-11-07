# StripSearch contributor instructions

- Read README, the relevant design document, and docs/roadmap.md before changing behavior.
- The design baseline now has a local Web alpha in apps/web. Keep its verified GitHub/authentication scope separate from unverified Exa, broader Agent/MCP milestones, benchmarks and deployment. Never claim a capability without verification.
- Hosted registration is open by default. Do not reintroduce implicit email allowlists or close signup when environment settings are omitted. Restricted deployments require an explicit operator-selected `STRIPSEARCH_SIGNUP_MODE=allowlist` policy.
- Keep identity linkage, factual support and analysis separate. Preserve uncertainty, counterevidence, provenance and revocation dependencies.
- Never fetch example.org fixture URLs. No network or paid API calls in offline checks.
- Never commit credentials, user research archives, local paths, private Notion URLs or third-party full text without an explicit redistribution grant.
- Author public examples from synthetic or clearly licensed materials. User research belongs in an authorized local workspace excluded from Git.
- Keep docs concise and update the shared contract before independent renderers. Format changes must not create new facts.
- Use python3 scripts/check_design.py for this baseline. Runtime and model evaluations are separate and must be reported honestly.
- After a committed local Web change, use the single-instance release manager in docs/local-service.md; read back the Tailscale health, release revision and entry assets before claiming the change is available. Update the existing Notion project workspace with actual verified state. Keep annotation/evaluation tools on demand and avoid starting another Web instance.

## Development data ownership

- Before manual acceptance, persistent E2E checks, seed imports or paid research, resolve the developer-designated default test account from local private credentials. Read `_private/development-data-policy.md` when present. Reuse that account for long-lived test/demo data and resources; do not silently create unrelated persistent test accounts or fall back to an operator account when login fails. For temporary acceptance that needs real-account ownership, first read back the environment, account and supported isolated test space, verify owner/target, then clean up only the task's resources; never claim a child workspace exists when the service has no such feature.
- Derive `owner_id` from the authenticated session and verify ownership after writes. Web, Label Studio and promptfoo have separate storage and identity boundaries; matching email addresses do not create shared user IDs or SSO. Use each service's supported import/membership operations and retain an owner-linked private artifact manifest where native ownership is unavailable.
- Keep offline unit, integration, authorization and replay tests isolated with synthetic identities and disposable databases. They must not write to the persistent default account, use its real credentials, fetch fixture URLs or make paid calls. Multi-account isolation tests still require separate synthetic accounts.
- Preserve existing users, authorship, human annotations, content hashes, append-only revisions, idempotency tombstones and revocation dependencies. New-data defaults do not authorize bulk reassignment of historical records. Any later migration needs an explicit source manifest, consistent backup, dependency-aware plan and verified readback.
- Store private resources and delivery evidence outside tracked source. Keep public synthetic/licensed fixtures and platform rules in their versioned directories; a test-account preference must not turn shared reference data into private user records. See [database and development data contract](docs/database.md).
