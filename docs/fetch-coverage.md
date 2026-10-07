# Fetch 处理覆盖契约（GET-95 第一批）

状态：2026-10-07 落地的**离线覆盖地基**。Fetch 处理覆盖的权威共享契约在 [`apps/web/src/shared/research-fetch-coverage.ts`](../apps/web/src/shared/research-fetch-coverage.ts)，可信 record/get-view 持久化在 [`apps/web/src/server/research/fetch-coverage-store.ts`](../apps/web/src/server/research/fetch-coverage-store.ts)（挂在 `Store.fetchCoverage` 生命周期），表结构在 [`server/db/schema.ts`](../apps/web/src/server/db/schema.ts) 增量添加。它直接复用 GET-58 的 `CoverageLocator / AccountSelection / ScopeVersion / EvidenceRef` 与 GET-60 的冻结时间窗、`mergeMediaMetadata`、`isEligibleInvestigation` 语义，不另造身份、范围或完成模型。

**这是离线处理覆盖地基，不是上线的 Fetch，也没有质量 benchmark。** 不发任何网络请求、不接 provider/worker/调度、不接生产运行时；[GET-58](research-case-domain.md)、[GET-60](research-completion-domain.md)、[GET-59](research-tool-contracts.md) 行为不变。回执是处理记录而非事实：来源正文或自由文本永远不是权威，结构化状态才是。

## 内容身份与独立维度

内容身份 = case + account + 稳定 sourceId + sourceRevision（GET-58 `CoverageLocator`）；同一案例的两个账号、同一账号的两篇内容、同一内容的两个 sourceRevision 永不共用一条记录。四个处理维度互相独立：`body` 正文、`media` 媒体、`comments` 每帖默认一页首层评论、`thread_branch` 每个选定 thread/作者回复分支（branchKey 区分）。

显式状态枚举 `listed / unread / read / skipped / context_missing / inaccessible / unsupported / deleted / truncated / failed`：`read` 是唯一成功态且不得携带 reason；**其余每个非成功状态都强制非空 reason**（跳过、截断、缺上下文必须写明原因）。thread 分支回执携带显式 `parents`（`present / missing / deleted / hidden`），缺失/删除/隐藏父节点从不被抹平；父链上下文只在 thread_branch 维度可表示。

## 回执、重放身份与原子写入

- **append-only 回执 + 重放身份**：调用方提供 `receiptKey`；同 key + 同 body 重放是 no-op（返回原回执 id/seq，不重复计数），同 key + 异 body 是 `FetchReceiptConflictError`。`occurredAt` 记录处理实际发生时间但**永不参与排序**。
- **原子权威校验**（一次事务）：owner / case / account / allowedScope / 当前 scopeVersion 与不可变 sourceRevision 绑定一次校验。历史处理要求 `public_history`；`profile_only` / `none` 账号一律 `FetchScopeDeniedError`；stale 或 future scope 一律 `StaleScopeError`；跨账号/跨案例的来源、证据引用与角色错位整体 `ForeignReferenceError` / `EvidenceRoleError`；已撤回依赖在写入时拒绝。
- **批量全有或全无**：任一条目无效则整批回滚、零行写入；批内重放 no-op 不掩盖兄弟条目失败。
- **成功与跳过什么都不改变**：处理回执不推进 `scopeVersion` / `personRevision`、不改冻结完成规则、身份或发布状态；不写 GET-60 观测、assessment、claim 或报告。GET-60 观测与派生处理回执始终是两套记录。

## 投影语义（只读 get-view）

- 每（平台 / 账号）按**冻结发布窗口**计数，另加逐条 state/reason/history；同平台多账号永不合并。
- **有序 supersession**：同一 scope 内每个维度的当前状态由最后录入（`seq`）的回执决定，绝不用时钟（`occurredAt` / `created_at` 回拨不改变结果）；后来的 `failed` / `inaccessible` 回执重开先前成功，历史全部保留。
- **不重复计数**：重复枚举页与重放回执按去重内容身份 + 当前维度状态聚合。
- **显式保留**：来源新 revision（旧 revision 的处理记录不传递到新 revision）、旧 scope 回执、缺失/删除/隐藏父链、无 `select_branch` 记录的分支都逐条可见。
- **时间窗**：未知发布日期保留在冻结窗口内并标 limitation，绝不静默按窗外排除；窗外条目单列不计入窗口计数。
- **百分比诚实**：未知分母、游标未耗尽、已知缺口 → `percent=null`；零分母 → `percent=null`，绝不显示 100%。分母只来自去重内容身份。
- **枚举耗尽只认 GET-60 协议**：只有协议 conforming 的 GET-60 `enumerate_history` 观测（成功、无访问边界、无阻断、显式 `endpoint_exhausted`、无游标、无已知缺口）才证明“接口可访问范围已读完”；游标为 null 本身不算耗尽，后来的游标/缺口会把它重开。
- **媒体保守合并**：复用冻结 `mergeMediaMetadata`——任一回执记录过 `present` 义务永久保留、矛盾作为 limitation 保留；`unknown` 媒体不算完成；缺席只有可信元数据（成功且非阻断的枚举回执）才能确立。
- **当前依赖有效性读取时派生**：证据事后撤回/缺失/角色不符的回执保留为历史（`dependencyValidity=review`）但不计为有效读取；stale scope 回执同样保留不计。独立有效的新回执可恢复覆盖。
- **无第二个完成判定**：视图只有计数与 null-safe 百分比，complete verdict 仍由 GET-60 assessment 独占；视图永不产生自动 completed/报告写入。

已知限制：枚举耗尽判定复用 GET-60 的协议门槛（`isEligibleInvestigation` + 显式 `endpoint_exhausted`）与直接证据依赖检查；前置观测的传递依赖链完整判定仍以 GET-60 评估为准。持久哈希只证明记录未被改写，不证明网络原文真实性。

## 持久化

additive SQLite 一张表 `research_case_fetch_receipts`：`seq`（自增、唯一排序权威）+ `UNIQUE(case_id, receipt_key)` 重放键 + `body_hash` 冲突判定 + 不可变 sourceRevision 外键绑定。旧库增量迁移、旧表旧报告不变；关闭重开后回执、重放身份与聚合可原样回读。

## 验证

`apps/web/src/tests/fetch-coverage.test.ts` 用合成 fixture + 真实 SQLite（含文件库关闭重开，全程禁用真实 fetch）覆盖：四维度独立、选定分支与显式父链、重复页/重放/冲突、未知与零分母、枚举耗尽协议正反例、owner/scope/权限拒绝、跨账号/跨案例引用与整批回滚、来源 revision 变更、回拨时钟下的确定性追加序、后续失败/受限重开成功、证据撤回与 stale scope 保留不计、未知/窗外日期、媒体冲突与可信缺席、持久化与聚合、以及“回执不改变完成/身份/发布状态”的副作用隔离。`research-case.test.ts` / `research-completion.test.ts` / `research-tool-contracts.test.ts` 证明 GET-58/59/60 边界未被改动。静态检查 `python3 scripts/check_design.py` 不验证运行时行为。
