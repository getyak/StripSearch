# 代码维护契约：重复收敛与保留差异（2026-10-11）

基线 `a0fd4c3`。本文档是本轮重复代码重构的**共享契约**：先定契约，再改实现。重构目标是行为保持——不改 canonical JSON、持久化 digest、provider 预算结算、身份归并、注册开放性、取消/重放、API 响应形状或能力声明。任何差异语义都在此显式列出，不靠阅读代码猜。

## 收敛后的共享模块

| 契约 | 模块 | 消费者 | 保留的差异 |
|---|---|---|---|
| 路由请求输入 | `server/http/request-input.ts` | `routes/{runs,review,discovery,first-step,fetch}.ts` | 三种字符串助手语义不同，见下 |
| URL 归一化 / 主机判定规则数据 | `shared/url-policy.ts`（纯，无 Node 依赖） | `shared/first-step-discovery.ts`、`server/discovery/route-planner.ts`（re-export）、`server/research/toolkit.ts`、`client/dom.ts`、`server/adapters/exa.ts` | 各层组合与严格度保留，见"URL 安全策略分层" |
| 账号键形状 | `shared/discovery-plan.ts` 的 `urlFallbackAccountKey` | `server/discovery/account-key.ts`、`shared/first-step-discovery.ts` | first-step 与 GET-92 的归一化阶梯差异保留，见下 |
| 响应原始类型助手 | `shared/response-primitives.ts`（`server/adapters/http.ts` re-export） | `server/adapters/*`、`server/research/toolkit.ts`、`server/research/fetch-github-acquisition.ts`、`shared/platform-discovery.ts` | `asFiniteNumber` vs `asSafeIntegerNumber` 显式分开 |
| 12/24 hex 哈希 | `server/util/hash.ts`：`hash12`、`jsonDigest24` | `server/discovery/route-planner.ts`、`server/platforms/public-rules.ts`、`server/research/controller.ts`、`server/research/first-step-discovery.ts` | `jsonDigest24` 用普通 `JSON.stringify`（非 canonical JSON），保持持久化 digest/重放键逐字节不变 |
| 存储行微助手 | `server/db/row-helpers.ts`：`nowIso`、`newRecordId`、`parseJson` | `server/store.ts`（re-export `nowIso`/`newId`）及各 store | ID 前缀由调用点显式传入，逐一保留（`run_/src_/obs_/rtask_/rcase_/rann_/dtask_/dimport_` 等）；`parseJson` 宽化为 `string \| null`（null 回退），字符串路径行为不变 |
| 文本控制字符清理 | `shared/validation.ts` 的 `stripControlCharacters` | `sanitizeText`、`routes/review.ts`（`cleanText`）、`shared/research-task.ts`（`stripControls`） | 保留 `\t\n\r`；review 的"超长即拒绝"语义不动 |
| 客户端属性转义 / 动效偏好 | `client/dom.ts`：`escapeAttrValue`、`prefersReducedMotion` | `client/main.ts`、`client/citation-return.ts`、`client/local-search.ts` | 转义规则逐字不变（反斜杠、引号、`\n\r\f` 十六进制空格） |
| eval CLI / git 元数据 | `src/evals/shared/cli.ts`：`findRepoRoot`、`gitInfo`、`safeFilename`、`parseEvalCliArgs` | `evals/runner.ts`、`evals/research-baseline-v1/runner.ts` | 两套基线的数据集形状、评分、报告器、退出码语义保持各自实现 |
| 计量 reserve/settle/replay 脚手架 | `server/research/metered.ts` 的 `meteredInvoke` | `server/research/controller.ts`（tool + model）、`server/research/first-step-discovery.ts`（`run` + `withModel`） | 见"计量与回执"，差异全部以显式参数保留；`services/runner.ts` 的 fetch 种子读取变体（失败重放→缺口+继续，不抛错）不走此助手，保留本地实现 |
| HTML 链接归一化 | `server/research/link-context.ts` 的 `normalizeHref(raw, base, policy)` | `link-context.resolveLink`、`services/discovery-runner.profileKey` | 两套策略显式参数化，见下；parse5 遍历/产物（证据上下文 vs 自链 URL 集）保留各自实现 |

## 保留的差异语义（不得顺手"修掉"）

### 路由输入字符串助手

- `optionalBoundedString`（runs）：trim 后**空或超过 max 一律返回 null**（拒绝式）。
- `optionalClippedText`（discovery）：trim 后**截断到 max**（裁剪式）。
- review 的 `requireText`/`optionalText`：人类裁决输入，超长**抛 400 拒绝**并带字段错误码，留在 `routes/review.ts`。

### URL 安全策略分层（4 层，各守各的边界）

| 层 | 位置 | 职责 | 与他层的已知差异 |
|---|---|---|---|
| 输入接受 | `shared/validation.ts` `isPublicHttpsUrl`/`isPrivateHost` | 存储前的来源 URL 校验；私有 IPv4/IPv6、localhost、`.local/.internal/.localhost` | 不拦 `example.com`/`.test`/`.invalid`；拦私有 IP |
| first-step 分类 | `shared/first-step-discovery.ts` `isBlockedHost` | 发现输入/工具结果分类 | 拦 `example.*`、`.test/.invalid/.localdomain` 与**一切字面 IP**；不查私有 DNS 名以外的 IP 段 |
| 工具出站 | `server/research/toolkit.ts` `publicUrl` | 每次真实抓取前的出站目标校验 | 拒端口、凭据、字面 IP（`node:net` isIP）、`.invalid/.test/.localhost/.local/.internal`；**不拦 example.***（fixture 由禁网测试层守） |
| GET-92 规划 | `server/discovery/route-planner.ts` `staticHttpsUrlPreflight` | 规划期静态预检（未接线） | 最严：控制字符、userinfo、凭据 query/fragment、非保留字节 URL、字面 IP 走 `request-policy` |

共享的只是**规则数据与纯判定**（`shared/url-policy.ts` 的后缀表、`matchesNonPublicHostSuffix`、`isLiteralIpHost`）；各层组合、严格度和"实际传输权限"不合并。已知分歧保留并有对照测试钉住：公网字面 IP 能过 `isPublicHttpsUrl` 但死于 first-step/toolkit；`example.com` 只在 first-step 被挡（toolkit 保留允许）；`.test`、`.invalid` 在 first-step/toolkit 被挡；三者均在 `isPrivateHost` 放行。

### 账号键（first-step vs GET-92）

- **共用**：URL-fallback 键形状（`ACCOUNT_KEY_PREFIX` + `canonicalJson` + `mode:'url'`）由 `shared/discovery-plan.ts` 的 `urlFallbackAccountKey` 单点构造，两侧调用同一实现。
- **保留差异**：GET-92 `canonicalAccountKey` 有 native-id（verified issuer）→ URL（`staticHttpsUrlPreflight` + 可配置 tracking 参数白名单，默认空）→ verified handle 三级阶梯；first-step `firstStepAccountKey` 只有 URL 回退、**无 preflight、无 tracking 剥离**、handle/native 不参与。差异是角色差异（first-step 输入已在分类层把关，GET-92 面向规划期证据），不合并；边界对照测试钉住两者的键形状一致性和分歧点。

### 响应原始类型

- `asFiniteNumber`（`Number.isFinite`）：provider 报价/估算（Exa、toolkit）。
- `asSafeIntegerNumber`（`Number.isSafeInteger`）：GitHub 持久采集（`fetch-github-acquisition.ts`）的 id/计数解析。
- 同一响应在两条链解析结果可能不同，这是有意的；测试分别钉住。

### GitHub / Exa facade

三套 GitHub（`adapters/github.ts` 报告链、`toolkit.github()` 旧 alpha 研究、`fetch-github-acquisition.ts` 持久 Fetch）与两套 Exa（`adapters/exa.ts`、`toolkit.exa()`）承担不同角色（报告 / 研究工具 / 持久采集），请求构造、URL 资格校验与解析**保留各自实现**。本轮只收敛响应原始类型助手；不合并 facade，不做 provider 客户端所有权迁移（超出行为保持重构的安全范围）。DSH 决策隔离（`research/dsh-decision.ts`）不动。

### 计量与回执（reserve → settle → replay）

共用脚手架 `meteredInvoke` 承载：reserve（同键旧回执原样重放、inflight 不重放、失败回执在 `allowSettledFailure` 下返回）→ 执行 → settle；失败结算 try/catch（已取消/已删除 run 拒收迟到结算）。**保留差异（显式参数）**：

- 失败结算用量：controller tool 用 `failedUsage(error)`（predispatch 拒绝不计费、已派发失败保留已派发成本）；model 与 first-step 用 `{estimatedUsd:null,unknownCost:true}`。
- 失败结算门槛：controller 为 `!options.signal.aborted`（已中止不再写迟到回执）；first-step 始终尝试。
- 失败重放错误消息逐角色保留（不改 API 文案）。
- first-step 的 attempt 命名空间预算上限、per-URL 读取预留、回执日志（`note`）与 settle 后 `throwIfAborted`/`assertActive` 保留在调用点。

### parse5 链接归一化（rel=me / 自链）

- legacy `discovery-runner.profileKey`：允许端口、保留 query、去 hash、折叠尾斜杠（平台发现匹配语义）。
- first-step `link-context.resolveLink`：拒端口、拒 `//` 协议相对、去 hash、保留尾斜杠（作者自链证据语义）。
- 共用 `normalizeHref(raw, base, policy)` 纯解析核心；两侧策略常量显式命名，边界测试钉住四点差异（端口、尾斜杠、协议相对、query 保留）。parse5 树遍历与产物（证据上下文 vs 自链集合）职责不同，保留各自实现。

### 记录 ID 形状

`newRecordId(prefix)` 统一 `${prefix}_${24 hex}` 形状（原 `newId`/`newRecordId`/`recordId` 六份），前缀逐调用点保留（含 `first-step-store` 的 `excl_`）。`review-store` 的 `cand_`/`cl_`（16/12 hex 随机）与 `store.ts` 的 `person_`/`first-step-store` 的 `acct_fs_`（字符串拼接 digest）是不同形状/不同配方的 ID，不在收敛范围，保留原样。

## 明确排除（有意不合并且有理由）

1. **schema 校验孪生**（`evals/schema.ts` vs `server/platforms/catalog.ts`）：失败契约不同（`EvalSchemaError` 带路径 vs `CatalogLoadError` 带错误码）、字符串规则不同（min/max vs 非空 trim），合并会改变错误形状，排除。
2. **两套 evals 报告器与 dataset schema**（`evals/report.ts`/`schema.ts` vs `research-baseline-v1/*`）：两套冻结基线的产物形状已分叉，属语义差异；只收敛 CLI/仓库元数据脚手架。
3. **`canonicalJson` / `stableStringify` 多实现**：undefined/非有限数/键序处理不同，直接影响持久化 hash、账号键与回放，按契约不得触碰。
4. **serializer 设计基线**（`shared/canonical.ts` 单点渲染）与 design/ 历史原型：原有设计判断，非重复。
5. **工具契约双文件**（`tool-contracts.ts` vs `research-tool-contracts.ts`）：头注释声明有意分层。
6. **probes/evidence_gate**：独立验证件，非生产重复。
7. **GET-91/92 未接线栈**：路线图地基，非死代码；本轮只让新代码与其共享纯 helper，不接线。
8. **fetch-github-acquisition 的 URL 资格校验（`sameGithubRepoUrl` 等）与 toolkit/adapters 的 facade 结构**：见上，角色差异保留。

## 依赖

`apps/web/package.json` 审计结论：**无可证明未使用的声明**。`better-call` 经 `server/http/middleware.ts` 的 `better-call/node` 在用；DSH、SQLite（better-sqlite3）、Chromium（playwright-core PDF）功能保留。`npm test` 默认限制 2 并发，避免一次启动全部测试进程。保留原有 `fflate` override 与 `allowScripts`，仅为下述已核实安全补丁调整版本和锁文件：

| 告警 | 修复版本 | 范围与依据 |
|---|---|---|
| MCP OAuth 凭据 issuer 绑定 | v2 client/core/server `2.2.0`；兼容 probe 的 v1 SDK alias `1.31.0` | Web DSH 的 client 传递依赖采用精确 override，probe 直接依赖升级。[官方 advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)。本项目 stdio probe 不使用 OAuth；不删除应用认证数据或全局连接凭据。 |
| sharp 的 librsvg 漏洞 | `sharp@0.35.5`（`@img/sharp-libvips-*` 包 `1.3.4`） | DSH 传递依赖精确 override；保留图片处理能力。[官方 advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)。 |
| source-map-js 事件循环拒绝服务 | `1.2.2` | Web 构建与 design QA 精确 override。[官方发布](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)。 |

兼容 probe 只显式允许已使用的 `better-sqlite3@13.0.3` 安装脚本；依赖目录和复用符号链接均排除在 Git 外。三份锁文件仅变更这些包及对应平台二进制，依赖缓存与运行发布按新锁文件隔离；保留当前和必要回滚版本引用的旧缓存。

## 回归保护

新增 `src/tests/code-maintenance.test.ts`（及少量既有测试补充）钉住：请求输入三种语义、有限 vs 安整数解析差异、账号键形状一致 + 梯度差异、URL 策略分层分歧、12/24 hex digest 稳定值、记录 ID 前缀、链接归一化四点差异、控制字符清理保留 `\t\n\r`、属性转义逐字行为。既有全量测试（含 identity/digest/settlement 相关用例）不删不弱化。

验证命令（离线）：`npm --prefix apps/web run typecheck`、`run build`、`node --import tsx --test --test-concurrency=2 src/tests/*.test.ts`、`run eval`、`run eval:research`、`python3 scripts/check_design.py`。

源码证据：研究回放 source manifest 包含新抽出的 CLI、计量、hash、存储行、响应类型和 URL 规则模块；既有回放测试核对这些模块的实际 SHA-256，避免重构后丢失来源绑定。
