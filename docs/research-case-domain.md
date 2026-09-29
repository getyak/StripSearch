# 研究案例领域契约（GET-58）

状态：2026-09-30 落地。`ResearchCase / AccountSelection / ScopeVersion / SourceRevision / EvidenceRef / ItemCoverage` 是**权威共享契约**（[`apps/web/src/shared/research-case.ts`](../apps/web/src/shared/research-case.ts)），后续任务导入这些类型而不是另造形状。SQLite 案例持久化（[`apps/web/src/server/research/case-store.ts`](../apps/web/src/server/research/case-store.ts)）挂在现有 `Store.cases` 生命周期上，表结构在 [`server/db/schema.ts`](../apps/web/src/server/db/schema.ts) 以增量迁移添加。

**这是地基，不是启用的 Search / Fetch 运行时。** 没有任务队列、租约、worker 或调度；typed task references 与逐条覆盖记录留给后续 scheduling / coverage 任务扩展。旧 alpha 运行契约保持诚实遗留；`research-task.ts` 仍是评测 rubric。设计背景见[人物研究 Agent 设计稿](superpowers/specs/2026-09-29-person-research-agent-design.md)。

## 边界与修订维度

- `ownerId` 是租户边界：跨 owner 的读写一律拒绝（owner 不符报告“不存在”，不泄露存在性）。
- `accountId` 是被研究账号边界：账号只属于一个案例，同平台多账号是一等状态，永不自动合并。
- 四个修订维度互不替代：遗留 run `revision`、`personRevision`（撤回推进）、`scopeVersion`（范围变更推进）、每源 `sourceRevision`（来源更新推进）。

## AccountSelection：五个互不推导的分面

`identitySupport`（证据支持）、`userSelection`（用户声明/研究意图）、`allowedScope`（允许范围）、`researchValue`（研究价值）、`accessCoverage`（访问覆盖）分开存储：用户选择不升级证据支持，研究价值不扩大允许范围，访问覆盖不证明归属。发现到的候选记录为 `unanswered`——发现不代表用户选择。

## 证据角色与引用完整性

| 引用位置 | 允许角色 |
| --- | --- |
| `identitySupport.evidenceIds` / `.counterevidenceIds` | `identity_support` / `identity_counterevidence` |
| 结论 `supportIds` / `counterevidenceIds` | `factual_support` / `factual_counterevidence` |
| 覆盖记录 `evidenceIds` / `counterevidenceIds` | 任一 support / counterevidence 角色（按极性） |

每次写入都在一个事务内校验 owner + case + account + `expectedScopeVersion` 与证据归属/角色：不存在、跨案例/跨账号或角色不符的引用整体拒绝（回滚，不静默丢弃、不虚构证据）；身份证据永远不能支持事实结论。

## 范围变更：原子、可回读、不可绕过

`applyScopeChange`（批量，一次提交）与 `updateAccountFacets` 涉及 `userSelection` / `allowedScope` 的补丁走**同一条**原子路径：同一事务内写入真实的逐账号 before/after 选择与允许范围快照并推进 `scopeVersion`。旧 `expectedScopeVersion` 的写入被拒绝（StaleScopeError）；混合有效/无效的批量整体回滚。`addAccount` 只记录 `unanswered` 基线；带用户选择的创建必须走 `applyScopeChange`。范围快照追加不可变，推进新版本并重开数据库后仍可回读旧范围。

## 撤回与导出

撤回只写时间戳：E1 撤回后 E2/C2 的 ID 与内容在 canonical JSON/Markdown 导出中逐字不变，被过滤的记录不重编号（遗留 run 沿用 PR15 的 checkpoint 序号修复；新领域记录用持久 ID）。撤回是**对称**的：支持或反证依赖被撤回都强制待复核；`identitySupport` 引用被撤回的身份证据时，即使状态仍是 `supported` 也在视图中标记“需重新评估”。JSON 与 Markdown 从同一份 canonical 案例视图派生：结论按 `查到的事实 / 本人自述 / 来源页面表述 / 推断` 标注，支持与反证分开呈现，格式转换不把分析变成事实，也不从用户选择推断真相。

## 逐帖覆盖记录（ItemCoverage）

覆盖按**逐内容定位**存储：`CoverageLocator` = accountId + 稳定 sourceId + sourceRevision，唯一键为（locator + taskRef）。同一案例的两个账号、同一账号的两篇内容、同一内容的两个 sourceRevision 永不共用一条记录，跨账号数据不混用。`recordSourceRevision` 即可建立定位，所以无证据的 `unseen` 也能落库；显式 itemId 必须匹配完整的绑定身份（账号/内容/revision/taskRef），重新绑定被拒绝且事务不改任何记录。每次写入追加不可变 revision：旧范围（scopeVersion）的覆盖保留为历史来源而非被静默覆盖；导出逐项标注自身范围版本，旧范围记录标“待复核”，页尾当前版本不替代项版本。`taskRefKey` 对任意合法字符串单射（research_task 用长度前缀元组编码，question_matrix 保留可读形式）。完成判定、body/media/评论执行与跨批次聚合留给 GET-60/95。

## 遗留数据

老数据库只做增量迁移（旧表、旧报告保持可读）。旧 alpha 材料进入新领域时使用 `legacyNoAuthorizationProvenance()`——`legacy_no_authorization`，绝不由系统虚构用户同意。

## 验证

`apps/web/src/tests/research-case.test.ts` 覆盖：同平台双候选、选择不提升身份、隔离（owner/case/account）、无效引用整体回滚、旧范围写入拒绝、来源修订历史跨重开、旧库迁移与报告可读、E1 撤回后 E2/C2 稳定（JSON/Markdown）、修订维度独立、逐帖覆盖定位（跨账号/跨内容/跨 revision 不混用、itemId 重新绑定拒绝、失败整体回滚）、taskRefKey 单射性与跨重开稳定、范围推进后导出的逐项范围版本诚实性。静态检查 `python3 scripts/check_design.py` 不验证运行时行为。
