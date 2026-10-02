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
