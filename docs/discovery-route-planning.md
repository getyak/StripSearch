# 发现路线规划、请求键与账号键（GET-92）

状态：2026-09-30 已实现 Task 4 的**纯**全目录路线规划器、不透明请求键与保守账号键（TDD 红绿、离线验证通过）；初版经独立 native 审查 **REQUEST CHANGES**（5 P1 + 5 P2）后已集中修复，并补充复审发现的凭据元数据边界回归，**仍待独立复审通过 + 当前 head CI + 合并 + 合并后验收 + Linear Done**（均归父级）。规划是数据，不是发送：本模块不做网络/DNS/provider/付费调用、不写数据库、不注册模型工具、不确认身份。运行时接入属 GET-63，且 GET-63 仍被最终合并的 GET-62 输入契约阻塞。

代码：共享契约 [`discovery-plan.ts`](../apps/web/src/shared/discovery-plan.ts)（含平台义务 `platformObligation` 与 `canonicalJson`）、纯规划器 [`route-planner.ts`](../apps/web/src/server/discovery/route-planner.ts)（`planDiscoveryRound` / `discoveryRequestKey` 与默认操作清单）、账号键 [`account-key.ts`](../apps/web/src/server/discovery/account-key.ts)（`canonicalAccountKey` / `newCandidateDraft` / `mergeCandidateOrigins`）。测试全部离线：[`discovery-route-planner.test.ts`](../apps/web/src/tests/discovery-route-planner.test.ts)、[`discovery-account-key.test.ts`](../apps/web/src/tests/discovery-account-key.test.ts)，并在 [`platform-catalog.test.ts`](../apps/web/src/tests/platform-catalog.test.ts) 补 name_query 完成投影与加载器语义。

## 平台发现义务 ≠ 操作接受输入

共享契约把两件事分开：**平台发现义务**（该平台是否是本轮查找义务）只由显式约束决定——账号种类、授权策略、目录声明的输入种类与实例提示；**操作接受输入**（`ROUTE_KIND_ACCEPTED_OPERANDS`）由路线种类决定，`username_probe` 只接受显式 username 值。名字/文本、数字 native ID、邮箱前缀**永不**填充 username 模板（gap `name_query_no_handler` / `native_id_not_a_handle` / `input_kind_unsupported`）。

- `name_query` 轮：全部公共账号条目保留为义务（分母不缩小）；无 name 处理器、缺实例提示是**显式缺口**。**义务与 handler 准备度分离**：路线种类只是目录描述，不证明 handler 存在；完成投影不判定准备度（理由明写「不在本投影判定」，不宣称「缺口：无」），计划器按可信操作清单记录真实结构化缺口（如 `name_query_no_handler` / `no_adapter` / `credentials_missing`）。GET-90 冻结数据无需重写：`name_query` 语义放在共享发现计划类型里，`CatalogInputKind` 仅类型级扩展，加载器/投影/测试同步更新。
- 授权策略（如私密通信平台只限本人/已授权）与账号种类约束保持显式 not_applicable + 理由；`unknown` 账号种类永不缩小分母。
- 授权邮箱输入本批显式不支持（隐私边界）：隐私拒收发生在**任何 hint 采纳之前**——即使携带 selflink/username/instance 提示，计划也零派发、零 operation/selflink/请求、无原始地址/地址哈希/不安全链接（类型无法携带地址）；真实邮箱匹配属 GET-66。未知/空未分类文本是显式 invalid input（抛 `DiscoveryPlanInputError`），不是隐式 username。
- 无 adapter 仍是「适用义务 + 无可执行路线 + 结构化理由」；adapter 存在与否永不决定义务。冲突的同平台 username 提示记 `conflicting_username_hints`，绝不猜选。

## planDiscoveryRound（纯数据）

`planDiscoveryRound(snapshot, input, access, options?)` 枚举**完整**目录快照（真实 4421 条，不是首个 API 页、无四平台上限），每个 entry 输出一行平台计划（状态 + 结构化理由）与按优先级排序的可执行路线操作：自链 → 已知用户名规则 → 已实现平台搜人 → 官方搜索 → 允许的 site 搜索（spec §6 顺序）。每个目录路线都保留显式理由：缺凭据（`credentials_missing`）、登录受限（`login_required`，本批无登录自动化）、缺授权（`authorization_missing`）、缺实例提示、无 adapter、无安全 handler、无受限正向证明（`unsupported_route`）、外部报告导入不进队列等。失败/未知永远不是结果状态（计划里不存在 `checked_no_match`/候选，执行语义属 GET-91 执行器与 GET-63 轮）。

**默认服务端操作清单只有一个真实可调用安全端口**：GET-91 独立受限执行器（`get91-rule-executor`，`productionWired: false` 明示未接线），只服务带真实公共规则的 username 探测请求（模板按显式 username 精确转义渲染）。legacy 探测默认 fetch、GitHub 研究 adapter、Exa 全量研究 provider 都不是安全搜索 handler，绝不作为搜人/绕过路径（缺 key 也绝不用浏览器/legacy fetch 顶替）。测试可注入**可信操作清单**演练真实请求契约（路由排序/门槛），但永远改不了目录事实（capability/verification 不提升，planned 操作仍 `productionWired: false`、费用 `null + 依据`，无伪造覆盖百分比）。

自链只做**严格确定性模板/实例匹配**（精确规范模板，实例固定模板需可信实例提示；无 TLD/名字相似匹配）；命中只是候选线索（URL 逐字保留：大小写、编码斜杠、末尾斜杠、身份查询、fragment），不安全链接显式拒收并记录理由。**用户名定位保真**：模板渲染后按模板上下文校验最终 HTTP URL 仍把用户名值精确定位在原位；路径位置的 `.`/`..` 会被 HTTP dot-segment 消除（`%2e` 也会），这类不可保真值给显式 `input_location_not_preserved` 缺口、拒绝整条路线（不丢规则血缘）；query 位置用户名与普通含点名字照常保留。不同检测谓词在 method+URL+安全头+body+页窗口**精确**相同处共享一条计划请求（与不透明键用同一份 HTTP 请求规范材料，仅剔不发送的 HTTP fragment；完整性比较用全量材料而非截短 digest；同路线 requestId 也去重），但每个 ruleId/routeId/来源出处都是独立 consumer（同响应不合并事实），原始 URL 变体（含身份 fragment）逐条保存在 `urlVariants`；单条请求可服务多个平台计划，平台义务不消失。

## 不透明请求键 discoveryRequestKey

`discoveryRequestKey(request, binding)` = `sdrk/1:<sha256(规范 JSON)>`，绑定 owner/case/inputRevision/registryHash/ruleHash/policyHash/authorityVersion/accessIdentity + adapter/operation/method/端点/安全头/body/页窗口。语义：

- 只规范化普通对象的**键序**；数组、类型、显式 null 保留（`{a:null}` ≠ `{}`，`[1,2]` ≠ `[2,1]` ≠ `['1','2']`；body 是逐字节字符串，不重排）。
- 查询重复键与顺序、编码斜杠、路径大小写、末尾斜杠、字面 `+` vs `%20` 全部逐字保留；**只有 HTTP fragment 被排除**（不随请求发送；身份 fragment 在账号键里保守保留）。身份查询永不剥离。
- 拒绝凭据（与公开计划物化前同一套纯校验 `validatePlannedRequest`）：凭据型查询参数、**fragment 元数据**（含 `#access_token=…`、`#?access_token=…` 与 SPA 路由参数；无害身份 fragment 保留）、凭据型 **body 键**（JSON 嵌套/数组/大小写/百分号编码、form 结构化键如 `payload[api_key]`；从不剥离后冒充公开）、非安全头（仅 accept/accept-language）、非 https/控制字符/非法 authority/userinfo/localhost/静态非公网字面 IP/会被 HTTP 解析改写的 URL；一律抛 `DiscoveryRequestKeyError`。支持的安全字面 body 逐字节保留（不重排 JSON 字符串）；普通提及 “token” 的文本不误杀。凭据从不进入键或公开计划。不同权威/凭据身份（`accessIdentity`）不折叠——实际响应可能不同。请求血缘即使共享响应也互相独立；不宣称持久化/重启幂等（那是 GET-63 的事务语义）。
- 共享离线静态 URL 预检 `staticHttpsUrlPreflight` 同时服务于账号 URL 回退、请求键/公开计划与自链入口（规划器导出、account-key 复用，无环；字面 IP 复用 `request-policy` 只读 `checkPublicAddress`）：不发 DNS、不把 URL 解析后重新序列化改写，合法原始字节保留；实际执行仍会重新校验 DNS 与权威（结构校验不是 live 验证）。

## 保守账号键 canonicalAccountKey

优先顺序：**native ID（仅当带已验证发行方命名空间）→ 公开安全 HTTPS 规范 URL → 已验证 handle（+ 实例 + 账号种类）**，都没有则返回 `null` 保留未解决证据。

- Opaque ID 是字符串：字母、前导零、大值逐字保留（`007` ≠ `7`）；发行方命名空间进键——同一 home 实例 + 同一 ID 但发行方不同**不合并**；home 实例不是远程/联邦账号的 ID 发行方；无发行方绝不冒充（URL 保守回退）。跨发行方关联只认确定性同 actor/资料证明（`associationProof`）。
- URL 回退仅公开安全 https（共享预检）：拒绝明文 http/凭据 URL/凭据型查询与 **fragment 元数据**/非法或本地地址/会被 HTTP 改写的 URL；仅 scheme/host 大小写归一（host 大小写不是身份），路径大小写、编码斜杠、末尾斜杠、身份查询与 fragment 逐字保留；tracking 参数剥离**只**按显式已验证逐平台白名单（默认为空）。
- Handle 保留原大小写（无默认 casefold；平台标签不提供大小写保证）；`invalid_handle` 占位符永远不是已验证 handle；`user@domain` 远程 acct 是域名绑定 handle，不是邮箱。实例（含端口/子域）与账号种类（publication/channel/organization/person）互不合并。

`newCandidateDraft` 物化及 `mergeCandidateOrigins` 合并前统一校验 profile/actor/关联证明 URL 元数据，即使原生 ID 已提供规范键也不能绕过；不安全 URL 以 `unsafe_identity_url` 拒绝，不剥离后冒充公开；合并前也检查双方历史冲突的 profile/actor URL 值，安全历史原样保留。

`mergeCandidateOrigins` 只在**重新计算**的规范键相等或确定性关联证明成立时合并（同平台边界内）；合并前校验存档键与当前身份证据一致，过期/伪造键（含直接改 draft.identity 或源对象变更后的别名）一律 `stale_canonical_key` 拒绝，身份/证明/出处均独立快照，选择/范围永不被带到另一身份。关联证明必须是支持的 basis + 非空可定位 evidenceRef，并以 nativeID+已验证发行方或 actor/profile URL 精确绑定**双方**；空引用/非法 basis/单侧绑定/内部未验证发行方一律 `invalid_association_proof` 拒绝，真实可信同 actor 跨 API 发行方映射仍为正向。仅凭显示名/host/用户名/相似度**永不**合并，跨平台永不合并。合并时**两侧历史冲突数组都保留**（仅逐字节结构去重；原字段/值/originIds/note 不丢，多阶段/双向合并都不丢矛盾），新旧 ID/actor/home/kind 证据整体保留为显式冲突（不裁决，归属裁决属 GET-64）；全部出处（provenance/observedAt/locator/rule/source）保留，结构去重不产生身份支持；新候选恒为 proposed/unanswered/scope none，既有用户选择与范围不被重置。

## 与 GET-59 严格封套的关系

本模块只产计划数据，不新增 ToolName、不改 GET-59 schema。未来轮投影沿用既有映射：超时/未知 → `failed`/`partial` + gaps 与 stopReason，`no_adapter` → `not_implemented`/`unsupported`；`checked_no_match` 只来自受限负证明执行结果，失败/未知永不映射为无匹配。

## 测试与证据边界

全部离线（真实 4421 条组合快照 + 合成夹具，无网络/无 provider/无 example.org）：规划器 28 项、账号键 22 项、目录 43 项。初版行为 RED 后实现；审查修复前 84 项中 10 项行为失败。补充冻结旧版 canonicalJson 的负向对照，以及凭据元数据残留的 4 项行为失败，再修复并验证；历史 URL 冲突的补充回归也先行为失败再修复通过。不声称一个测试恰好对应一个缺陷。当前目标套件 322 项：321 通过、1 环境门控跳过、0 失败；全量 Web 603 项：602 通过、1 环境门控跳过、0 失败（含 3 项真实 Chromium PDF）。typecheck、生产 build 与 `python3 scripts/check_design.py` 退出码均为 0。历史初版 binary-PDF 失败（`pdf_unavailable`）根因未确认；当前阶段诊断通过不证明旧失败已解释。

**没有 live 验证**。目录能力保持 documented_only/未接线，未提升 GET-59 `supported`；GET-62 输入适配、GET-63 持久轮/调度/API/Web 和 GET-64 归属裁决尚未实施。独立复审及后续交付门禁仍需完成。
