# 本地 Fetch 批次链（GET-99 本地原型，离线合成）

状态：2026-10-07 落地的**本地可运行合成链**。本地 Fetch 控制器在 [`apps/web/src/server/research/fetch-pipeline.ts`](../apps/web/src/server/research/fetch-pipeline.ts)，持久化（runs / append events / 可恢复 checkpoint / dispatch intent / 逐请求计量回执 / 本地原文 / pending findings）在 [`fetch-pipeline-store.ts`](../apps/web/src/server/research/fetch-pipeline-store.ts)，确定性合成语料与注入网关在 [`fetch-pipeline-synthetic.ts`](../apps/web/src/server/research/fetch-pipeline-synthetic.ts)，共享调度契约在 [`apps/web/src/shared/research-fetch-pipeline.ts`](../apps/web/src/shared/research-fetch-pipeline.ts)。可运行 CLI：`npm --prefix apps/web run fetch:offline -- --db /tmp/fetch-offline.db`（[`apps/web/scripts/fetch-offline.ts`](../apps/web/scripts/fetch-offline.ts)）。

**这是离线合成链，不是上线 Fetch。** 全程禁网；只有注入的合成 gateway（GET-59 `dispatch` 校验网关、research-runtime 模型网关、逐请求计量 executor），没有任何真实平台端点、付费 provider 或付费模型调用，不部署，合成通过**从不**把任何 provider 档案标为已验证。真实 provider 摄取（原始全文索引）仍然 pending：控制器只接受适配器预先准备的精确 source pin（sourceId + sourceRevision + 全文 canonical hash），绝不发明 revision pin、绝不把 metadata-only hash 当全文。遗留 Web alpha 与 legacy 工具面不接线、不改动。

## 复用的权威组件（不另造模型）

- GET-58 `CaseStore`：case / scopeVersion / 账号切片 / 不可变 source revision / 证据（含撤回）。
- GET-60 `CompletionStore`：冻结 scope + `enumerate_history / read_body / read_comments / read_media / select_branch / read_thread` 观测回执与**确定性 assessment**（唯一完成判定）。问题与 required check 从不被伪造回答：未回答就是未回答。
- GET-95 `FetchCoverageStore`：body / media / 默认一页首层评论 / 选定分支四维处理回执与只读投影。
- GET-59 `dispatch(trustedContext, modelCall, ports, signal)`：唯一的工具出入口。**Fetch 角色 fetch 阶段恰好暴露 10 件工具，verify 阶段恰好 3 件**（`read_evidence / load_skill / save_findings`），由注册表静态矩阵决定。
- research-runtime `runResearchRuntimeBatch`：有限批次调度边界；DSH 单决策兼容（`createDshRuntimeModelGateway` 原样保留），模型 gateway 自带 usage 记账。

## 核心步骤（确定性本地策略）

1. 枚举授权账号页（`list_posts`，按适配器分页顺序；**不按互动量取舍**）。
2. 处理每一个可读列出正文（`read_post`）：**来源绑定**要求返回的 item / source / account 身份 + sourceRevision + 全文 sha256 与 pin 完全一致，否则显式拒绝（保留计量回执、不建证据、不计读取）。列表摘要永远不算正文读取。
3. 每个条目的默认首页评论（`list_comments`，`provider_default` 排序原样保留）。
4. 显式选择 important / 作者本人 / 矛盾分支（`select_branch` + `read_thread`），用实际 `parentRef` 与冻结深度（frozen `threadDepth`）；缺失/删除/隐藏祖先与第三方作者归属逐条保留，绝不抹平。
5. 媒体：已有文本/字幕记 `read`；不可读记显式 `unread`；`hasMedia=unknown` 显式记录未知/未读（无 provider 调用）；可信缺席只来自 GET-60 枚举元数据。
6. 暂存**证据绑定的 pending finding**（`save_findings` → pending-only 端口；永不发布、不写 claim/报告）。
7. 隔离 verify（独立 verify 批次，仅 3 件工具）：先 `read_evidence` 成功回读并逐条校验，**回读成功之前绝不暂存 verification_check**，statement 只陈述实际回读内容。
8. 确定性 GET-60 assessment（append-only）；批次额度耗尽只让运行保持可恢复（`running`），绝不制造完成。

**绝不因为这些而"完成"**：模型 yield、连续空转/无操作轮、游标单独为 null、finding 仅暂存、provider 缺能力。完成判定只属于 GET-60 assessment，且问题/check 未答就保持未答。

## 派发纪律（crash-safe）

每次工具派发前，控制器把**精确调用**（碰撞自由的规范 step 身份 = 完整 tool + input + pin revision 身份，见 `fetchPlanStepKey`）与新鲜计划/阶段和持久 done / refused / in-flight 状态比对：不在计划内、已完成或已有未解决 intent 的调用**在触达 provider 之前**被拒绝（同一 batch 内重复调用同样被拒）。每个实际派发先持久化 **intent**，再持久化**权威 raw outcome + 计量回执**，最后在**同一个 `Store.inTransaction` 事务**里原子折叠派生产物（本地原文、证据、GET-60 观测、GET-95 回执、checkpoint）。任何中断（崩溃、折叠故障、范围变化）都留下未解决 intent：运行停为 `unreconciled`，**不自动重放**，只能经显式权威调和（`reconcileUnresolvedIntents: 'abandon'`）后继续。范围/取消漂移立即停止新的证据/原文/覆盖/checkpoint 成功写入，已执行调用的计量回执照常保留；冻结范围保持 stale，绝不合成新冻结。模型/gateway 回调拿到克隆，无法改写可信 checkpoint 与已记录事件。

## 分块暂存与核验（确定性 chunks，尊重 GET-59 限额）

GET-59 的每调用/每 finding 限额（`save_findings` 每次至多 50 条 finding、每条至多 100 支持 + 100 反证 + 100 覆盖条目；`read_evidence` 每次至多 100 条证据）由确定性分块计划遵守（纯助手 [`fetch-pipeline-plan.ts`](../apps/web/src/server/research/fetch-pipeline-plan.ts)，注册表限额本身不改、不放松）：

- **不可变阶段 manifest**：stage / read_evidence / verification-save 的调用清单在**首次派发前**冻结进 checkpoint（显式 planner 版本），此后绝不按成功子集重新打包：partial/被拒调用保持原 step key，被拒材料绝不换新 key 自动重试，显式保持未完成。
- **暂存**：manifest 材料按账号分块打包（单条目材料自身超限时按 lane 切块、覆盖身份只随首块出现一次；同批共享支持/反证引用全局去重，计数=唯一引用）；**依赖与覆盖身份逐条保留恰好一次**，绝不静默切片丢弃。完成判定核对 manifest 计划的引用/覆盖身份与**实际 durable collected findings**：拒绝的 key、partial 提交的调用或空 findings 集都不算暂存完成；未全量暂存不进入成功核验、不写成功进度，缺口显式披露（`stage_incomplete`）。
- **核验**：read manifest 在**全部暂存材料实际提交后**一次性冻结；全部回读调用落定后，verification-save manifest 由**实际验证过的 fresh pinned 回读**一次性冻结（允许诚实 partial 子集，缺口显式披露）。pin 缓存记录完整不可变绑定（evidenceId+账号+sourceId+sourceRevision+role+quoteHash，含实际 SHA256 校验），任何后续使用（fold/核验规划/提交/最终判定）都对当前权威状态复验：错误 sourceRevision、撤回或失效的回读绝不解锁核验，事后撤回使已验证缓存失效。每条 verification_check 只引用成功回读的依赖、陈述计数=实际引用；最终完成还要求每个 staged 依赖都有**当前有效的 verification pending finding** 覆盖——仅凭缓存 ID 永不算核验完成。
- **恢复与 legacy 升级**：step 身份是精确输入的不可变 key，关闭重开只继续未落定的 manifest 调用，绝不重放已知成功调用（块大小只是单次调用上限，无累计语料/请求/时间上限）。已 finished 的 run 以**只读**方式恢复：零派发/事件/checkpoint 写入/新评估，只返回历史事实与带当前有效性标注的持久化评估（绝不隐式续跑）。没有 manifest 且已尝试 stage/verify 的旧 checkpoint **fail closed**（`stopReason=upgrade_required`，显式 upgrade/new-run 缺口），绝不发明 key 或重放历史材料；stage 之前的旧 run 可安全进入新 planner（不重放已落定的枚举/正文/评论动作）。checkpoint 无需 SQL 迁移（新增可选 JSON 字段，旧持久化运行原样保留）；目录/pin/planner 版本不兼容一律 fail closed。
- **诚实 partial**：回读失败/被拒/不可用、依赖撤回或 pin 校验失败时，verification 只引用实际成功回读的依赖，运行**不标记 finished**（`verify_readback_incomplete`）；暂存材料缺失为 `stage_incomplete`；绝不产生语义事实、质量结论或完成声明。

## 可恢复调度（不是总量上限）

`maxStepsPerBatch` / `maxBatches` / 空转轮数只是**可恢复调度额度**：额度耗尽返回 `running + batch_quantum_exhausted`（义务仍开放），不是 `finished`。没有累计语料、历史、请求或时间上限。SQLite checkpoint 记录每个账号的精确列表游标（持久不透明游标端口）与每个条目的步骤状态；关闭重开同一输出库后在原游标/原步骤继续，已知成功动作绝不重放（回执键按 run 隔离）。**跨 worker 租约/attempt fencing 未实现，GET-79 保持未完成、不作声明。** 逐请求计量只有 run 本地回执（reserve → settle），不构成完整持久计费子系统；未知 token/费用保持 null；派发 intent 无权威 outcome 时，总费用未知，已知模型费用子项保留。

## 合成语料与 CLI

确定性语料：2 个账号 × 2 个平台、28 个条目（>25），全部正文完整本地原文、混合媒体状态（含 unknown / unread / 无媒体）、默认评论页、10 个被选分支（含作者本人深回复 + 缺失/删除/隐藏祖先、第三方归属、截断分支）+ 2 个未选分支（显式缺口）。一次完整运行 ≈ 82 次真实工具动作（>80）、10+ 批次、全部正文读取。CLI 输出简洁结构化摘要：真实计数、pending findings、assessment 状态、剩余缺口，并演示同库关闭重开续跑。

## 验证

`apps/web/src/tests/fetch-pipeline-keys.test.ts` 覆盖 step 身份（stage/verify/evidence/含冒号原生 ID/媒体条目/分块调用不碰撞）；`fetch-pipeline-chunks.test.ts` 覆盖分块计划与执行：>100 同账号条目/依赖与 >50 stage findings 在 planner + 真实 GET-59 输入校验层的恰好一次保留与限额遵守（含旧切片/越界缺陷的复现断言）、真实 SQLite + 真实 GET-59/GET-95 网关的分块执行（中断在首个 stage/verify 块后关闭重开，无遗漏、无重复成功调用）、独立复审反例回归（partial stage 拒绝不换 key 重试/不重复 coverage、全拒不假 finished、撤回证据不靠缓存 ID 保持已核验、共享反证唯一计数、已覆盖身份不重复发 coverage、无歧义身份元组、错误 sourceRevision 回读不入账）、partial verification-save 拒绝/重开不重试、finished 旧式 checkpoint 只读恢复、legacy 中断边界（已尝试 stage/verify 的旧 checkpoint fail closed、stage 之前安全续跑）；`fetch-pipeline.test.ts` 用真实 SQLite（含文件库关闭重开、全程禁 fetch）覆盖：>25 条目 />80 工具动作多批次全链、重复页/游标循环/空页开放游标保持 partial-unknown、缺失 pin 的列出行保留缺口且不假分母、深作者回复 + 缺失/删除/隐藏祖先与第三方归属、unknown/no-media、来源 hash 变更拒绝、运行中范围变化与证据撤回、调度中断后在精确游标/条目步骤续跑且不重复成功调用、中断 intent 与原子折叠回滚、真实模型 usage/费用跨重开一致、未解决运行不可静默变 finished、未计划/重复调用派发前拒绝、调度额度可恢复、目录/source pin 变更的续跑拒绝、模型权限注入与网关改写防护、隔离 verify（恰好 3 件工具、回读门控）、问题/check 保持未完成、无自动报告、部分响应不制造读取覆盖、CLI 合成链 + 重开续跑。`research-tool-contracts.test.ts` / `research-runtime.test.ts` 证明 GET-59 与批次边界未被改动。静态检查 `python3 scripts/check_design.py` 不验证运行时行为。

## 已知限制

- 合成通过只证明本地契约与调度正确；真实平台端点可用性、分页、费用、研究质量与部署全部未验证。分块/核验诚实性只在合成注入路径验证；被拒/部分接受的材料以显式拒绝/缺口保留，不重试、不补写。
- GET-59 输出 schema 不携带列表级媒体元数据与分支选择信号：这些来自适配器目录缝隙（与 source pin 同类的 adapter-produced 元数据），真实 provider 摄取仍待接入。
- 未实现跨 worker 租约/attempt fencing（GET79 不作声明）；未实现完整持久计费子系统（只有 run 本地计量回执）。
- 验证只覆盖合成注入路径；模型策略质量、发现/身份归属（Search 链）与真实研究效果评测均不在本批。

评论反证使用独立的不可变评论摘录来源：保留说话者、父评论 ID 与 adapter 原始 permalink，正文来源只作上下文关联；摘录 hash 不代表评论全文或主体正文。无法绑定的评论保留 gap。

CLI 的 `state=finished` 只表示本地计划已排空；研究是否完成看 `assessment.verdict`。本合成场景仍为 partial，问题/check 未回答，不能发布完成结论。
