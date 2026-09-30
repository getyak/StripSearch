# 研究范围与完成契约（GET-60）

状态：2026-09-30 落地。`CompletionScopeSpec / CompletionObservation / CompletionAssessment` 是新的权威共享契约（[`apps/web/src/shared/research-completion.ts`](../apps/web/src/shared/research-completion.ts)），直接复用 GET-58 的 `ResearchCase / ScopeVersion / AccountSelection / ScopeAccountSnapshot / CoverageLocator / ItemCoverageRevision / EvidenceRef / SourceRevision`，不另造身份或范围模型。SQLite 持久化（[`apps/web/src/server/research/completion-store.ts`](../apps/web/src/server/research/completion-store.ts)）挂在现有 `Store.completion` 生命周期，表结构在 [`server/db/schema.ts`](../apps/web/src/server/db/schema.ts) 增量添加；确定性纯函数在 [`server/research/completion-eval.ts`](../apps/web/src/server/research/completion-eval.ts)。

**这是持久化的范围/完成政策地基，不是 GET94/95/99 自治运行时。** 无任务队列、租约、调度或平台采集；遗留 `research_actions` 是旧 run 账本、`TaskRef.research_task` 是评测 rubric，二者都不是新案例调查回执。背景见[人物研究 Agent 设计稿](superpowers/specs/2026-09-29-person-research-agent-design.md)与[研究案例领域契约](research-case-domain.md)。

## 冻结的是义务规则，不是少量帖子清单

`freezeCompletionScope` 在研究开始前冻结规则：问题及适用性原因、完整平台目录 `registryVersion + registryHash + entries` 快照、账号范围（`researched_accounts` / `explicit`）、时间窗（ISO 日期边界，发布日期未知的条目保留在范围内，绝不静默按窗外排除）、正文、适用媒体、每帖默认一页首层评论与选定 thread/作者回复祖先深度（设计默认 4）、以及确定性 required-checks（时间覆盖 / 来源多样性，按显式配置条目做集合判定，不引入未校准分数或任意来源数量阈值）。逐条义务在评估时从**不可变枚举观测**派生：所有已知条目读完但仍有 `nextCursor` 或已知缺口就不算完整；研究中选定的深入分支以不可变 `select_branch` 回执追加义务，按冻结深度验收。

全目录发现义务 = 冻结 registry 中每个平台一条：首批深读样本（X / Reddit / GitHub / 个人网站）之外的平台同样保留，`unsupported / inaccessible / deferred / needs_input` 等真实状态逐条可见，绝不缩减为启用的适配器。空 registry、无适用平台、无适用问题或无 required-checks 一律拒绝；空集合不能空过。真实完整枚举为 0 条可以完成该维度，但 0/未知分母从不显示 100%，维度分开呈现，没有误导性的合计百分比。`endpoint_exhausted` 只在无游标且无已知缺口时合法，且只证明接口可访问范围。

## 有序观测语义与当前依赖有效性

回执不可变且按录入顺序排列；**每个义务的当前状态由其动作族的最新回执决定（有序 supersession）**。更早回执保留为历史并保留其限制：后来的阻断不被历史成功掩盖（例如已声明耗尽后又出现新游标/缺口，枚举变未完成且正文分母变未知；平台已 `checked_no_match` 后又被访问阻断），后来的有效成功解除先前缺口（旧分页游标可由后续耗尽收尾）。枚举条目跨所有枚举回执**累积**，后来的空页不会抹掉已发现条目；每个枚举条目的 sourceId+revision 都在记录事务内按 case + 义务账号校验（不存在/跨案例/跨账号/错误 revision 一律整批拒绝，不依赖调用者自愿写入 refs）。

**媒体元数据保守合并（冻结规则 `mergeMediaMetadata`）**：`hasMedia` 不在不可变 SourceRevision 内，同一 source@revision 的跨页元数据按冻结规则合并：只要任何回执记录过 `present`（含失败/阻断页的发现），媒体义务永久保留，后来的 `none` 不得抹掉；真实媒体读取可以满足该义务，矛盾保留为限制而非永久未完成。从未 `present` 时，只有成功且非阻断的元数据才能 unknown→none，后来的成功 `unknown` 会把旧 `none` 重新变回待判定；失败/阻断的 `none` 不能清除已有 unknown（也不能靠要求另造 sourceRevision 来掩盖合法矛盾）。分母按合并后状态保持诚实，历史观测全部保留。

建立完成还需要**当前依赖有效**：直接或经 coverage pin、前置 observation 间接引用的证据必须存在、未撤回、极性与归属相符；account-scoped 回执的**账号边界沿依赖链继承**（含中间 case 级节点与嵌套账号节点，必须匹配继承账号；case 级问题可合法跨账号汇总），有效性缓存按（observationId, expectedAccount）区分上下文；依赖失效只影响新评估（原因 `dependency_withdrawn`），旧 assessment 的原输入/原 verdict 不变且可重放；独立有效的新依据可以恢复完成。选定分支的父链缺失/删除/隐藏与未解除的 read_thread blocker **不能**因 `depthReached` 达标而完成；后续干净读满冻结深度才解除缺口，历史限制始终保留。

枚举的非空 `accessBoundary` 也是阻断：即使回执写了 `endpoint_exhausted`，当前枚举仍未完成、条目分母未知，且该回执的 `none` 不能清除媒体未知。后续无访问限制的有效枚举可以恢复，先前访问限制保留在历史与维度说明中。

## 冻结与修订：一次绑定、版本化变更、整体回滚

首次 `freezeCompletionScope` 绑定当前权威 `scopeVersion` 一次，在没有任何账号时也可用——不为发现义务发明假账号。同一事务内复制并 hash 当时真实账号切片并写入 case 级 scope journal 事件作为锚点（`scopeEventId`）；同版后续发现候选追加事件也不改变冻结记录，旧范围永不按当前账号行回构。持久化的是深拷贝规范：调用者事后改对象、同版发现、关闭重开都不改变冻结 spec、registry 快照、账号切片与 hash。

问题 / 时间窗 / 深度 / 账号范围的修改走 `reviseCompletionScope`：复用 GET-58 的 case 级原子 scope 路径（`CaseStore.applyCaseScopeMutation`），推进且只推进一版并追加新 spec；旧 spec 与旧 partial 评估永久可读。任何无效条目（如第二个账号引用 foreign）把版本、journal 与 spec 一起回滚。旧 context（旧 `expectedScopeVersion` 或旧 spec）的写入被拒绝。**难题不能事后删除**：修订必须保留此前冻结的每个问题 id（上一版按权威 `scope_version` 选取，同毫秒或时钟回拨都绕不过），最多标注 `not_applicable` 并给出冻结原因；缩小范围是新版本、新报告明确新 scope，不能冒称原约定完成。列表顺序按权威版本（评估按插入序），永不按墙钟或随机 ID 排序。

## 最小观测/尝试回执协议

`recordCompletionObservation` 追加不可变回执，绑定 case + scopeSpec + obligation，结构化记录 action / result / attemptState / stopReason / accessBoundary / remainingUnknown / 显式 synthetic 出处，并校验 account / source / evidence（按支持与反证极性）/ coverage itemId+revision+locator / 前置 observation 引用；无效引用整体拒绝。自由文本 note 或调用者 "completed" 标志永远不能建立完成。`resolved_unknown` 只有在满足**冻结的调查资格协议**时才算已处理未知：前置动作必须是真正产出结果的调查（`isEligibleInvestigation`：非 note/answer/select 类动作、成功状态、产出型 result、无阻断 stopReason、无 accessBoundary）**且结构化 payload 显示工作真的完成**——thread 必须读满冻结深度且无未解除 blocker、枚举不得有游标/已知缺口（省略 stopReason 不能抹掉已记录的未完成）、required-check 必须覆盖冻结的必需条目（`observed` 标签本身不证明达标）——并携带当前有效的具体依赖（证据/覆盖/来源，经前置 observation 间接引用同样受检且继承账号边界）；`unsupported` / 权限 / 预算类回执或纯文本不能升级为已处理未知。`unattempted`、预算耗尽、权限失败、`unsupported`、`deferred`、`failed`、`cancelled`、`needs_input` 各自保留，绝不冒充 `no_match` 或已处理未知。缺父、删除、隐藏、截断上下文保持显式（缺失父链的分支义务只能 partial 并保留原因）。失败/取消/待输入的回答即使带结果与证据也不满足问题义务；后续有效成功可以解决，历史失败不会永久污染后续评估。

## 评估与追加式 assessment

`assessCompletion` 读一份一致持久快照（冻结 spec + 账号切片 + 观测 + 精确 pin 的 coverage itemId/revision/locator + source/evidence/identity 状态），交给确定性纯函数 `evaluateCompletion`，随后追加 assessment：持久化所选输入、原 verdict 与 `policyVersion / scopeVersion / evidenceRevision / inputHash`。调用者无法传入最终计数、百分比或缩减后的 registry。维度分开判定：`platform_discovery / history_enumeration / body / media / comments / thread / questions / required_checks`，每个问题需要支持/冲突说明或已充分调查的未知，正文、适用媒体、默认评论页与选定分支义务都参与。

旧 assessment 的 verdict 与 input 永不改写；当前有效性在读取时单独派生（`currentValidity` + `staleReasons`）。`evidenceRevision` 是排序后持久 source（revision + contentHash）/ evidence（角色/归属/quoteHash/revokedAt）/ 身份支持状态与引用的确定性摘要，不依赖 `personRevision`（插入证据或身份 patch 都可能不推进它）；新增或撤回支持/反证依赖、身份状态变化、来源修订都会使旧 assessment 转为待复核，而 `replayCompletionAssessment` 仍可用原输入重放出相同语义与 digest（磁盘重开后一致）。

## 边界与诚实限制

- 不实现调度、租约、抓取或模型运行；GET-58 不存全文，持久哈希只证明记录未被改写，不证明网络原文真实性。
- 枚举完成只称接口可访问范围（endpoint-accessible range），不代表账号完整历史。
- 覆盖完成只来自协议回执；GET-58 的 `ItemCoverage.status` 是调用者记录，不作为完成依据。
- owner 隔离按 GET-58 规则：跨 owner 一律"不存在"；stale context 拒绝写入与评估。

## 验证

`apps/web/src/tests/research-completion.test.ts` 用合成 fixture 与真实 SQLite（含关闭重开、同输入确定性重放）覆盖验收矩阵：无账号全目录冻结、调用者变更/同版发现/重开不漂移、事务回滚与恰好一版、缩范围保旧 partial、claims 充分但正文/评论/媒体/父链未做、已处理未知 vs 未尝试/预算/权限/不支持、游标/缺口 vs 诚实零条目接口完成、source/evidence/身份依赖失效、跨账号/跨帖/跨 revision 的精确 coverage 绑定、failed/cancelled/needs_input 保留；独立复审修复批另有确定性回归：撤回依赖不重新宣告完成（含经 coverage/前置观测的间接依赖）且有效替代可恢复、失败/阻断回答不满足问题义务且可恢复、双向有序 supersession（耗尽→新缺口变未完成/分母未知；游标→后续耗尽可完成，含 discovery）、枚举条目持久归属校验整批回滚、缺父链不因深度达标而完成后可恢复且历史限制保留、调查资格协议正反例、同毫秒/时钟回拨下的删除守卫与版本序列表。修复批 2 再补：媒体元数据保守合并（none↔unknown↔present 各向、失败 none 不得抹除已知、真实媒体读取恢复且矛盾保留）、调查资格的结构化 payload 正反例（thread 深度/blocker、枚举游标/缺口、required-check 条目）与干净正例、直接/一层/多层跨账号链拒绝、同账号链与真实 case 级多账号汇总正例、共享中间节点双顺序矩阵与（observationId, expectedAccount）memo 顺序矩阵。`research-case.test.ts` 保持 GET-58 行为不变。静态检查 `python3 scripts/check_design.py` 不验证运行时行为。
