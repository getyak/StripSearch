# Search / Fetch 工具接口契约（GET-59）

状态：2026-09-30 离线接口契约。**Search 8 个与 Fetch 10 个工具接口**收敛为 15 个去重后的模型工具：权威注册表与严格输入/输出 schema 在 [`apps/web/src/server/research/research-tool-contracts.ts`](../apps/web/src/server/research/research-tool-contracts.ts)，可执行入口 `dispatch(trustedContext, modelCall, ports, signal)`、可信注入端口与可复用 server factory 在 [`apps/web/src/server/research/research-tool-dispatch.ts`](../apps/web/src/server/research/research-tool-dispatch.ts)。类型直接复用 GET-58（`ResearchCase / AccountSelection / ScopeVersion / SourceRevision / EvidenceRef / CoverageLocator`）与 GET-60 契约，不另造范围或账本模型。

**2026-09-30 基线是离线接口契约与验证网关地基。** 2026-10-08 的受限 GitHub Fetch 接入复用此网关，范围与验证状态见 [fetch-integration.md](fetch-integration.md)；不因此声明更广泛的 Search / Fetch 已上线。该离线基线不接 legacy Web 研究循环、不跑 provider、不建 GET-76 技能目录、GET-78 持久预算、GET-79 租约或 GET-95 批次 worker。遗留 alpha 工具面（`tool-contracts.ts` / `toolkit.ts` / `research-store.ts`）保持原样并与本契约完全分离。

## 15 个工具与角色 × 阶段

| 集合 | 精确名称 |
| --- | --- |
| 共享 3 | `get_platform_capabilities` `read_evidence` `load_skill` |
| Search 独有 5 | `discover_accounts` `read_profile` `search_web` `submit_candidates` `request_confirmation` |
| Fetch 独有 7 | `list_posts` `read_post` `list_comments` `read_thread` `read_media` `save_findings` `report_progress` |

角色只有 Search（发现与归属）与 Fetch（深读与核验）两种。**核验是 Fetch 的一个阶段（phase `verify`），不是第三个角色**，且只允许 `read_evidence / load_skill / save_findings` 三件工具——共享身份不因此放行 `get_platform_capabilities`。注册表携带 name、角色、阶段、provider/local 计费与底层请求数上限（`search_web` 恰好 1 次适配器请求；`read_thread` 可展开多个子请求；其余每页 1 个请求，不隐式全量翻页）；测试用固定独立名称数组断言 exact set，不从注册表自证。schema 一律 own-property 严格校验：未知键（含 `constructor / toString / __proto__` 这类原型名）与模型自填的权限/归属/预算字段（`ownerId / caseId / role / phase / allowedScope / scopeVersion / budget / estimatedUsd / usage / identitySupport …`）在任何层级出现都拒绝。

## 权威检查（单一入口，多处复用）

owner / case / scopeVersion / role / phase / 账号允许范围 / capability 快照 / 技能 pin / 媒体转换授权一律由服务端可信上下文注入。**案例授权集中在一道闸门**，在进入时、awaited step 记账之后、**每个实际底层请求之前**、任何本地写入之前、以及返回可用内容之前重复执行：读取当前 Store 状态（fresh 端口，**缺省 fail closed/not_implemented**，可信初始快照永不替代当前状态）、取消、scopeVersion、可信账号切片与当前 `allowedScope`、证据撤回。原 dispatch `AbortSignal` 始终生效，handler 换用自己的 signal 不能绕过；取消/范围/依赖变化只阻止**新的**执行，已执行请求照常结算一次（不主张 GET79 持久租约）。

- 账号是请求主体边界：目标 `accountId` 必须在可信切片内。`profile_only` 不能读历史（`list_posts / read_post / list_comments / read_thread / read_media`）；`none` 拒绝受限读取（含 `read_profile`）。case 级发现（`discover_accounts / search_web / submit_candidates / request_confirmation`）不需要伪造账号；未选择候选以 candidateRef 表达，用户选择只记意图、永不证明身份。
- **证据与 finding/coverage locator 统一走账号授权**：切片成员 + 当前范围 + 可信**来源访问分类器**（`SourceAccessPort`，不进模型输入）。默认 Store 工厂把 `originalUrl` 与真实 `account.profileUrl` 完全一致的 pinned 来源判为 `profile`，其余/未知来源判为 `history` 并要求历史权限或显式可信分类；`profile_only` 只读真正的 profile 材料，绝不从"证据已存在"或证据角色推导授权；`public_history` 继续读 pinned 来源。分类器未绑定时按 history 从严拒绝。
- sort / date / depth 在调用 handler 前按可信 capability 记录核验：带能力约束的操作必须有 **`supported`** 的可信记录，`unverified`、缺记录或只有一份数组都不构成能力确认（fail closed）；具体参数仍逐项核对 sortOptions / dateRange / maxDepth，未知即拒绝、不静默降级。
- native 游标经可信不透明记录端口绑定**完整请求身份**（case + 账号 + 工具/端点 + scopeVersion + sort + 时间窗 + 目标 item + 搜索 query/发现 rules），跨帖子/跨查询/跨账号/跨窗口重放一律拒绝；模型自填 wrapper 字段或无签名哈希不构成绑定。未绑定游标端口时相关操作 fail closed。
- 输出校验核对请求主体与 locator：`read_post / list_comments / read_thread / read_media` 的目标 itemId/root/parent/mediaRef 必须对应请求（替换目标 locator 一律拒绝）；评论/父链中的第三方作者合法保留、标 `third_party`，且永不进入选定范围。`read_thread` 节点携带可读 `text` 或显式 `textUnavailableReason`（null 正文必须给原因，`missing/deleted/hidden` 节点不得携带正文），父/根链、缺失节点与截断保真。
- `save_findings` 只进 pending：逐条经受约束 `SubmissionPort` 原子比较 owner/case/expectedScopeVersion 与证据依赖后落库，不能写 completed、不能提升身份、不能扩大范围；核验阶段只接受对**已有证据**的检查结果（`verification_check`），拒绝新来源、正文与 coverage；收集产物（`collected_finding`）与核验结果 schema 分开。**每条 finding 独立推导自己的授权账号集合**（多账号综合显式记录，绝不继承第一条依赖的账号）。批次部分接受返回真实 partial 回执（已接受的 pendingRef + 未提交原因，`staged=true`，不整批重试）；端口意外失败时明示 `commit_outcome_unknown`，绝不谎称没写过、也不重试成重复。GET-60 没有通用 pending 仓库，端口默认未绑定即 `not_implemented`，绝不偷用 `addClaim` 或 `recordCompletionObservation`。本地 Fetch 控制器（GET-99）按这些 per-call/per-finding 限额做**确定性分块**（`save_findings` ≤50 findings/调用、≤100 支持/反证/覆盖每 finding；`read_evidence` ≤100 条/调用），逐条保留依赖与覆盖身份，注册表限额本身不改；调用清单由不可变阶段 manifest 冻结（拒绝/partial 材料不换 key 重试），回读按完整 pin（身份/revision/role/quoteHash）校验（分块语义见 [fetch-pipeline.md](fetch-pipeline.md)）。
- 控制器提交端口（候选/确认/进度）带同样的 commit 义务（`expectedScopeVersion` + dependencies 原子比较，拒绝抛 `SubmissionRejectedError`），fresh 闸门在副作用之前；端口只记录候选/意图/进度，不授予权限。`report_progress` 的费用/预算来自回执，模型自报一律拒绝。

## 统一返回封套

状态枚举 `success / partial / blocked / not_applicable / not_implemented / failed`，拒绝与失败路径同样满足 schema。每条适用内容逐条携带 `author / originalUrl / publishedAt / retrievedAt / sourceRevision / locator`：适用但未知的日期/费用是显式 `null`，本地元数据（技能、提交回执、进度）用 `applicable:false + reason`。封套携带 continuation 游标、gaps、逐动作回执与 usage。诚实性规则：发现超时绝不记 `checked_no_match`；评论保留实际排序（含 `provider_default`）；媒体区分已有文本/字幕、`media_unread` 与有授权的转换。

## 计量端口（GET-78 缝隙）

受控请求执行器是唯一外发通道：每个实际底层请求（含失败、未知费用、重试）走 `reserve → execute → settle`，一次尝试一个 actionId，结算恰一次。**端点状态与费用在结算前校验**：HTTP 非 2xx 是一次已结算的 failed 尝试并 fail-stop（先前成功产物保留为 partial）；有效申报费用照记，缺失/非法费用（负数/NaN）记 unknown 并给 `invalid_fee` 诊断，绝不出现负余额、NaN 或被丢弃的回执。输出 schema / 晚到范围 / 撤回 / 取消拒绝结果时，已执行请求仍结算；**结算失败立即 fail-stop**——停止后续执行与 staging，回执标 `unreconciled/unknown`，绝不重发远端请求或二次结算补账（不主张崩溃 exactly-once）。多请求工具在某次失败后 fail-stop：保留已成功结果与失败/未知费用，计划中的后续请求标 `not_dispatched`。预算拒绝 = 零 handler 调用；没有计量端口就没有计费派发；本地 `read_evidence / load_skill` 零 provider 请求但保留步骤/上下文记账。本任务只定义可注入端口与调用顺序，不建第二账本（遗留 run 账本语义不变）。

## 固定历史 pin 策略

证据按捕获时的 `sourceRevision` 精确固定；**同一来源出现更新 revision 不使旧 pin 自动失效**，回读返回被 pin 的不可变 revision 元数据。只有撤回（`revokedAt`）或请求 pin 与捕获版本不一致才拒绝。

## 验证

`apps/web/src/tests/research-tool-contracts.test.ts` 以 fake 端口 + 真实 SQLite CaseStore 覆盖：exact 名称集合与完整 role×phase 矩阵、注入字段/账号/scope/游标/capability 拒绝、撤回与固定历史回读、异步晚到范围变更/撤回/取消、技能 pin 不符、pending-only 提交与核验隔离、逐条输出元数据与非法 handler 响应、逐请求记账顺序/次数、部分失败 fail-stop、未知费用、预算拒绝、结算失败 fail-stop，以及边界回归的正反向对照：缺 fresh state fail closed、step 后/逐请求前权威复查与 AbortSignal 防绕过、真实 Store 切片外/none/profile_only 证据边界、控制器 commit 义务、跨帖子/跨查询游标重放拒绝、unverified capability 拒绝、thread/media locator 绑定与第三方父链正文、HTTP 失败/非法费用诚实计量、批次 partial 回执与未知 commit 结果、逐 finding 账号集合、thread 正文可表示性、原型键拒绝。静态检查 `python3 scripts/check_design.py` 不验证运行时行为；legacy 回归（`research-toolkit.test.ts` / `research-controller.test.ts`）证明旧边界未被改动。

## GitHub 发布主体与实际作者（2026-10-08）

帖子材料输出可携带 `sourceAccountId` 与 `authorRole`，将用户授权的发布主体和实际 `authorAccountId` 分开。另一个作者的材料只有在 `sourceId` + `sourceRevision` 精确匹配当前 case、授权发布主体的可信不可变来源 pin，且作者角色一致时才接受；缺失、外来 pin 或错误角色均拒绝。未声明替代发布主体的旧输出继续遵守严格账号归属规则。组织 README、仓库 issue 和第三方评论不因此成为目标本人创作，也不证明同一人关联。对应新增网关正反例在 `fetch-github-integration.test.ts`，既有严格边界在 `research-tool-contracts.test.ts`；实际抓取与冻结处理的独立验证见 GitHub 接入文档。
