# 全目录账号发现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 GET-90/91/92/63 的全目录发现，让每个适用平台都有可复核状态，并保留候选的出处和不确定性。

**Architecture:** 一份版本化目录产生 legacy、completion 和 capability 三个投影。规则编译、路线规划、请求执行、发现轮持久化和 Web 展示各有独立模块；候选通过 GET-58 pending 账号接口保存。GET-63 在 GET-62 合并后接入统一输入，不调用 legacy 自动归属或 Fetch。

**Tech Stack:** Node.js 22.23.2、TypeScript、Express 5、BetterAuth、better-sqlite3、parse5、vanilla TypeScript/Vite、node:test、现有 jsdom/浏览器验收。

**Spec:** [已批准设计规范](../specs/2026-09-30-platform-discovery-design.md)。用户于 2026-09-30 批准书面规范。

**Execution:** 沿用用户指定的 Pi + MiMo Pro 实现、Codex 定义接口/验收/交付，使用 executing-plans 跟踪；独立 native sub-agent 审查各交付 PR。执行前需用户审阅本文，执行方式无需再次选择。

## Global Constraints

- “账号命中、身份支持、用户选择、读取权限、正文覆盖互不替代。”
- “共享契约先落地，独立 renderer 后接入。”保持既有 15 个不同工具与 strict 封套。
- “每个适用项都有队列记录”；没有 adapter 也保留，不能限于四个平台或 Maigret 默认 500。
- “生产任务与离线测试不自动拉取上游。”固定来源、许可和内容 hash 是可复核的导入前提。
- “测试全部离线”，provider mock；不请求 example.org，不在测试/CI 下载规则或调用付费 API。
- “GET-63 集成等待 GET-62 的已合并输入契约。”不得以未合并 worktree 的接口为发布基线。
- “Figma 仅使用 Figwright”，真实参数和 token grounding 完成后才实现视觉；不猜尺寸、颜色或字体。
- 增量 SQLite 迁移，owner/case/input/scope 隔离；新候选 proposed/unanswered/none；不清理其他任务数据。
- 一次一个 Pi writer。独立 review、当前 PR head CI、合并读回及验收完成后才关闭相应 Linear issue。

## Review Focus

1. 同域不同出版账号、Mastodon 实例、用户名大小写差异不能误合并：Task 4 的规范化测试。
2. 两套规则访问相同 URL，但检测条件不同：Task 2/3 共享响应、独立判定及来源保留测试。
3. 已发现候选同时发生超时或预算中断：Task 5 completion 投影保留阻断原因，不能显示完整。
4. 服务重启、双调度与 scope 变更发生在 provider 请求后：Task 5 事务竞争和晚到回执测试。
5. 平台标签、候选 URL 含 HTML 或用户退出后刷新晚到：Task 6 安全渲染、owner 清空和焦点稳定测试。

## 文件与类型约定

新增共享 `platform-catalog.ts` 定义 `PlatformCatalogSnapshot / CatalogSourceManifest / CatalogEntry / CapabilityRecord / DiscoveryRoute`；`discovery-round.ts` 定义 round、平台状态和候选来源投影。不要改名覆盖已有两个 `PlatformRegistry`；用明确类型 alias 构造投影。

目录模块放 `server/platforms/`，发现轮模块放 `server/discovery/`，客户端新增 `client/discovery.ts`。测试仍放 `src/tests/`。目录和规则数据放 `apps/web/data/platforms/`，固定版本规则/许可独立子目录；生产构建必须复制所需数据，不能依赖源码 cwd。只提交许可允许的数据、许可和原创摘要，不提交私有设计资料、人物档案或完整供应商文档。

持久状态枚举使用 spec §7 的值；详细失败原因单列 `detailCode`。下列签名为模块边界；类型字段按 spec §4–7 定义，`DB`、`HttpTransport`、`ScopeVersion` 和 existing store 类型从原模块导入。任务可细分函数内部，不自行扩大工具面或权限。

## Task 1: 目录契约、初始数据和投影（GET-90）

**Files:** Create `apps/web/src/shared/platform-catalog.ts`, `apps/web/src/server/platforms/catalog.ts`, `apps/web/data/platforms/catalog.json`, `apps/web/data/platforms/manifest.json`, `apps/web/src/tests/platform-catalog.test.ts`, `docs/platform-catalog.md`. Modify `server/platforms/registry.ts`, `server/routes/discovery.ts`, `shared/platform-discovery.ts`, build/data packaging and `docs/roadmap.md` only as required for compatibility.

**Interfaces:**
- `loadPlatformCatalog(dataDir: string): PlatformCatalogSnapshot` validates sources/schema/hash, rejects duplicate IDs and conflicting aliases.
- `toLegacyRegistry(snapshot: PlatformCatalogSnapshot): LegacyPlatformRegistry` keeps executable old probe shapes; `toCompletionRegistry(snapshot, input: CatalogApplicabilityInput): CompletionPlatformRegistry` keeps all entries with reason; `toCapabilitySnapshot(snapshot, access: CatalogAccessContext): CapabilitySnapshot` maps GET-59 enum/limitations.
- `catalogSummary(snapshot: PlatformCatalogSnapshot): CatalogSummary` counts platforms/routes/source records separately. `CatalogApplicabilityInput` contains accepted kind, platform/instance hints and authorization policy; no owner/email material belongs in the public catalog.

- [ ] **1. Add failing `platform-catalog.test.ts` tests:** independently list spec's 20 TikHub and 30 alternative IDs plus website; assert every entry has seven capabilities, unknown price is null, no-adapter entries survive completion projection, duplicate aliases fail, credentials cannot promote documented-only to live_verified, mutated input cannot change frozen snapshot.
- [ ] **2. Run:** from `apps/web`, `node --import tsx --test src/tests/platform-catalog.test.ts`; confirm failures come from missing module/behavior, not environment.
- [ ] **3. Implement the interfaces and data:** use separate documentation/integration/access/verification axes. Record public source URLs/date/hash and historical uncertainty; no fabricated endpoint availability. Extend `/api/discovery/registry` compatibly with a versioned catalog surface. Add data-copy step to existing build and a compiled-runtime read test.
- [ ] **4. Verify:** targeted test, existing platform-discovery/research-completion/research-tool-contracts tests, `npm run typecheck`, `npm run build`; assert data loads outside repository cwd with a temporary copied production build. `python3 scripts/check_design.py` from repo root.
- [ ] **5. Commit:** `feat(platforms): add versioned capability catalog (GET-90)`; review and deliver GET-90 independently using Delivery Gate below. Its acceptance is directory/documentation honesty, not all platforms live.

## Task 2: 固定版本规则导入与合并（GET-91）

**Files:** Create `server/platforms/public-rules.ts`, `scripts/import-public-rules.ts`, `data/platforms/public-rules/manifest.json`, per-source normalized JSON/attribution/license files, `src/tests/public-rules.test.ts`; extend `shared/platform-catalog.ts` with normalized rule/source types and docs.

**Interfaces:**
- `compilePublicRules(input: PublicRuleSourceInput): PublicRuleImport` consumes fixed source bytes, source kind, commit/hash/license, importer version. Produces normalized `PublicDiscoveryRule[]`, rejected records with reason/hash, raw/loaded/excluded counts and source manifest; no network inside this function.
- `mergePublicRules(imports: PublicRuleImport[]): PublicRuleUnion` produces platform/instance/template union with all source refs; conflicting detection predicates remain separate.
- `PublicDiscoveryRule` includes stable ruleId, platform/instance/accountKind, allowed HTTPS request template, profile template, supported detection predicate, rate bound and source refs. It is data; never arbitrary JS or unbounded regex.

- [ ] **1. Add tests:** synthetic Maigret and WMN inputs with overlapping request, different predicates, duplicate names across domains, unsupported request method/template, disabled rules, malicious regex/code, missing license and malformed bytes. Assert independent counts reconcile raw=loaded+excluded and both provenance refs survive overlap.
- [ ] **2. Run:** `node --import tsx --test src/tests/public-rules.test.ts`; confirm meaningful red state.
- [ ] **3. Implement importer and one explicit maintenance import:** retrieve full official source datasets, freeze commit/hash, check fixed-version licenses, preserve MIT/CC BY-SA attribution and modification notices. Incorporate entire admissible union into new catalog version; list all exclusions instead of replacing the dataset with samples. Maintenance networking is separate from offline checks and never fetches人物 fixture pages.
- [ ] **4. Verify:** offline parser tests plus catalog tests; compare manifest counts against the fixed source files through an independent JSON count, check license/attribution and reproducible hashes. Build reads normalized data without any startup download.
- [ ] **5. Commit:** `feat(discovery): import versioned public account rules (GET-91)`. GET-91 remains open until Task 3 execution acceptance also passes.

## Task 3: 受控规则执行和请求复用（GET-91）

**Files:** Create `server/discovery/request-policy.ts`, `server/discovery/rule-executor.ts`, `src/tests/discovery-rule-executor.test.ts`; reuse `server/adapters/http.ts` bounded response helpers and existing `HttpTransport` through explicit wrappers. Do not silently broaden old adapter behavior.

**Interfaces:**
- `validateDiscoveryTarget(url: string, policy: DiscoveryTargetPolicy): Promise<ValidatedDiscoveryTarget>` consumes an injectable DNS resolver and approved port/host policy; executor transport must connect to the validated address or equivalently enforce it, not merely resolve then blindly fetch again.
- `evaluateRule(rule: PublicDiscoveryRule, response: BoundedDiscoveryResponse): RuleOutcome` independently returns candidates/checked_no_match/inaccessible/unknown plus reason and locator.
- `executeDiscoveryRequest(request: PlannedDiscoveryRequest, context: DiscoveryRequestContext): Promise<DiscoveryRequestOutcome>` accepts signal, bounded transport, authority check, timeout/bytes/rate/cache/receipt ports. No model-supplied key/budget/authority.
- `DiscoveryRequestOutcome` retains original response receipt and observation time; a shared response can feed multiple predicates without another request.

- [ ] **1. Add tests:** one response for two rules; present/missing markers; soft 404, generic placeholder and CAPTCHA never candidates/no-match; 429 Retry-After, timeout, byte cap, cancellation, unsupported URL, private IPv4/IPv6 and DNS-change defense; cached response retains old observedAt and zero new provider requests.
- [ ] **2. Run:** `node --import tsx --test src/tests/discovery-rule-executor.test.ts`; ensure no real fetch/DNS in tests.
- [ ] **3. Implement:** approved public HTTPS requests, reject unsafe URL/addresses and unauthorized redirects; literal/restricted predicates only. Unknown-host rate defaults to serial, configured per-origin bound and global existing discovery limits both apply. Supply pure fake clock/transport hooks for tests. Persistent reuse/unknown recovery handled by Task 5 ports.
- [ ] **4. Verify:** rule-executor, public-rules, existing discovery-adapters/regressions tests, typecheck/build. Verify every paid/unknown request outcome has a receipt; unsupported/authority refusal dispatches zero requests. Do not promote rule documentation to live verification.
- [ ] **5. Commit:** `feat(discovery): execute public rules with bounded requests (GET-91)`; independently review and deliver GET-91 after full import and executor acceptance, retaining any unmet live claims as unverified.

## Task 4: 路线、请求键与账号键（GET-92）

**Files:** Create `server/discovery/route-planner.ts`, `server/discovery/account-key.ts`, `src/tests/discovery-route-planner.test.ts`, `src/tests/discovery-account-key.test.ts`; catalog route descriptors and docs as needed.

**Interfaces:**
- `planDiscoveryRound(snapshot: PlatformCatalogSnapshot, input: CatalogDiscoveryInput, access: CatalogAccessContext): DiscoveryRoundPlan` produces one platform plan for every catalog entry, explicit applicability/no-route reason and ordered route operations.
- `discoveryRequestKey(request: PlannedDiscoveryRequest, binding: DiscoveryBinding): string` binds owner/case/inputRevision/registryHash plus canonical endpoint/query/body/page scope.
- `canonicalAccountKey(candidate: DiscoveredAccountIdentity): string | null` uses native ID, else platform-specific URL, else handle with instance/accountKind and platform case rules. `mergeCandidateOrigins(existing: CandidateDraft, incoming: CandidateDraft): CandidateDraft` keeps distinct origins/conflicts.
- `CatalogDiscoveryInput` is accepted public classification plus server-owned input reference; an authorized email remains unsupported with no provider dispatch.

- [ ] **1. Add tests:** no-route platform remains present; no four-platform cap; selflink/username/platform/official/site-search ordering; missing credentials gives explicit reason; email dispatch zero; same canonical request key dedupes but different owner/input/page does not. Account tests cover Mastodon instances, two same-platform accounts, organization/publication/person, native ID vs URL evidence, case-sensitive handle and allowed/identity-bearing URL parameters.
- [ ] **2. Run:** route-planner/account-key tests and confirm red state.
- [ ] **3. Implement:** enumerate full catalog first, then choose admissible implemented operations; retain why each route is unavailable. Existing search adapters only through their real implemented API and receipts; no new provider integration or bypass fallback. Extract only traceable selflinks; results remain candidate clues.
- [ ] **4. Verify:** targeted tests, catalog/rule-executor tests and GET-59 contracts; inspect strict envelope mappings (timeouts via failed/partial+gaps, no_adapter via not_implemented/unsupported) without new ToolName. Run typecheck/build.
- [ ] **5. Commit:** `feat(discovery): plan catalog routes and deduplicate accounts (GET-92)`; independently review/deliver GET-92.

## Task 5: 发现轮存储与调度（GET-63，GET-62 合并后）

**Files:** Create `shared/discovery-round.ts`, `server/discovery/round-store.ts`, `server/discovery/round-runner.ts`, `server/discovery/completion-projection.ts`, `src/tests/discovery-round-store.test.ts`, `src/tests/discovery-round-runner.test.ts`; extend `server/db/schema.ts` incrementally and bootstrap dependency injection.

**Interfaces:**
- `DiscoveryBinding` contains ownerId, caseId, inputRevision, scopeVersion, personRevision and registryHash; model/client cannot supply it.
- `DiscoveryRoundStore.create(binding, plan, idempotencyKey, fingerprint): {round: DiscoveryRoundRecord; replayed: boolean}` atomically saves frozen snapshot and all platform plans; conflicting replay throws 409-compatible domain error.
- `getForOwner(ownerId, roundId)`, `listCandidatesForOwner(ownerId, roundId, cursor, limit)`, `claimAttempt(binding, requestKey)`, `settleAttempt(binding, requestKey, outcome)`, `cancelForOwner(ownerId, roundId)`, `retryForOwner(ownerId, roundId, platformId)` are owner checked. Opaque candidate cursor binds round/input/registry and max page 50.
- `DiscoveryRoundRunner.start(roundId): void`, `cancel(roundId): void`, `stopAll(): void` use authoritative input/case refresh before dispatch and commit; store guards late results and duplicate attempts.
- `toDiscoveryCompletionObservation(platform: DiscoveryPlatformRecord, context: CompletionObservationContext): PlatformDiscoveryObservation | null` preserves GET-60 strict attempt/result/stopReason protocol.

- [ ] **1. Rebase on latest merged main and read finalized GET-62:** assert its accepted input revision/binding read path; do not cherry-pick or modify the other task. Add store/runner tests for all statuses and a candidate plus known_gap; owner mismatch, reused key with changed body, atomic failure, duplicate scheduler, input/scope drift during in-flight request, cancellation, same account multiple origins, restart completed vs unknown request and seed scope preservation.
- [ ] **2. Run:** round-store/runner tests using real temporary SQLite and mock transports; confirm meaningful red state. Create task artifacts using dev-storage-guard, not a permanent /tmp evidence directory.
- [ ] **3. Implement:** full plan transaction, persisted request/outcome reuse, conditional attempt claim and commit, pending candidate insert through CaseStore; no auto-confirmation or Fetch. Interrupted unknown attempts remain deferred/unknown, explicit retry is new attempt. Append completion observations with candidates+blocking stopReason for partial outcomes; no freeze mutation or denominator shrink.
- [ ] **4. Verify:** targeted real-store tests, existing research-input/case/completion/tool-contract tests, typecheck/build. Restart a local synthetic round against the same DB and show no additional requests for settled work; failed commit after network retains usage and doesn't write current candidates.
- [ ] **5. Commit:** `feat(discovery): persist full-catalog discovery rounds (GET-63)`. Keep GET-63 open until Task 6 joint acceptance and delivery.

## Task 6: API、Figwright 设计与 Web 状态（GET-63）

**Files:** Create `server/routes/discovery-rounds.ts`, `client/discovery.ts`, `src/tests/discovery-round-api.test.ts`, `src/tests/discovery-round-client.test.ts`; extend `server/app.ts`, `client/api.ts`, `client/main.ts`, `client/index.html`, `client/styles.css`, docs. Preserve unrelated report/alpha UI.

**Interfaces:**
- `registerDiscoveryRoundRoutes(router: Router, deps: DiscoveryRoundRouteDeps): void` exposes `/api/discovery/rounds` and `/:id`, `/:id/candidates`, `/:id/cancel`, `/:id/retry`. Creation accepts a finalized GET-62 public input reference only, not raw email/owner/scope/budget; finalized input naming is captured after Task 5's baseline check.
- Detail returns `DiscoveryRoundView` from shared contract with platform status pagination, server counts, frozen registry identity and safe input. Candidate HTTP/tool page size max 50; platform page max 100. GET status polling only while visible/active, one request at a time; no synthetic timer-derived progress.
- `renderDiscoveryRound(view: DiscoveryRoundView, ui: DiscoveryUiState): void` and `bindDiscoveryActions(actions: DiscoveryUiActions): () => void` are separate render/events; stable platform and account IDs preserve disclosure/focus/scroll, cancel pending fetch on logout/object switch. Text uses textContent and links require validated public HTTPS.

- [ ] **1. Add tests:** real Express+SQLite auth/Origin/API paths, all state mappings/counts/pagination, invalid/stale cursor, cross-owner no-existence leak, forged authority rejected, unsupported email no raw/hash leaks or requests. jsdom tests assert stable disclosure/focus, keyboard action, logout late response rejection, hostile platform label/URL rendering and no fake percentages.
- [ ] **2. Run:** API/client tests; confirm red state with local mocked providers only.
- [ ] **3. Ground and implement:** connect Figwright plugin to target StripSearch file, verify file key, get_design_context and token/component mappings of coverage `12:1386` and relevant discovery/scope frames; save private before snapshots. Create a separate batch page/copy frames for improved states, keep original. Build green/warm-white status rows and same-page detail from real tokens. If plugin remains unavailable, complete API/semantic tests but keep visual acceptance and GET-63 incomplete; do not claim precise design fidelity.
- [ ] **4. Verify joint UI:** local signed-in synthetic research input → round → candidate+gap → refresh SQLite readback → cancel/retry. Capture desktop and 390px screenshots with actual service data; exercise keyboard/zoom, overlay Escape/focus return and large catalog pagination. Check state changes don't jump reading position. Run full Web tests/typecheck/build, design integrity and existing offline eval commands only where mandated by current CI.
- [ ] **5. Commit:** `feat(web): show honest full-directory discovery status (GET-63)`; independent review and delivery gate, then close GET-63 only after full acceptance. Update README/roadmap with implemented scope and live-verification limits.

## Delivery Gate（每个可独立交付的 issue/PR）

- [ ] Parent checks fresh origin/main, current other work/active Pi writer, signed-off interface boundary; creates scoped private Pi contract using xiaomi-token-plan-cn/mimo-v2.6-pro and frozen base. Setup verifies locked Node runtime and dependencies before implementation; local logs/DB/screenshots remain outside Git.
- [ ] Parent checks worker diff, summary and revision-bound verification receipts; independent native sub-agent review inspects code, migration, security and acceptance. Confirmed P0/P1 fixed and reviewer closes them; ready_for_review is not completion.
- [ ] Create PR linking only acceptance-relevant issues; attach PR artifact. Inspect all applicable checks and repository gates on latest head, repair failures, re-review changes affecting conclusions. Do not trigger redundant @codex review; use authorized local mimo-review first GitHub model review when applicable.
- [ ] All current-head checks/gates pass → allowed merge method → read back merged SHA → required postmerge verification. Linear workspace GetYak `8c969130-4eed-4049-85f9-ae04796db4be` verified before writes; completed acceptance issue only then Done and read back. Keep unmet issue open with exact reason.
- [ ] Save formal evidence before removing this task's disposable registered artifacts; preserve reviewable sources/worktrees and other active task artifacts. No iOS simulator or permanent Docker stack for this Web batch.

## 自审与当前进度

spec §1–4 → Task 1；§5 → Task 2/3；§6 → Task 4；§7 → Task 5/6；§8 → Task 6；§9 → all verification steps and Delivery Gate。五个 Review Focus 已分配明确测试。模块名/签名一致，GET-62 合并和 Figwright grounding 保留为真实执行条件。

当前仅规范批准、计划编写/自审完成。以上执行 checkbox 均未完成；未宣称代码、PR、合并、平台接入或 Linear 关闭。本文审阅后才启动实施，沿用已指定的 Pi/MiMo 执行方式。
