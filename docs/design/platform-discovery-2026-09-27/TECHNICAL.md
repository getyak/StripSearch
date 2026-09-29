# 技术设计：平台发现、一次性身份校正与帖子深度追踪

状态：**部分已实施**。共享契约先于任何渲染面更新；`apps/web` 的服务端、API 与离线测试均遵守本契约。live 平台语义、真实 CLI 端到端与误报率**未验证**（见 [REVIEW](REVIEW.md)）。来源与版本见 [SOURCES](SOURCES.md)。

实现位置：`apps/web/src/shared/platform-discovery.ts`（共享契约）· `apps/web/src/server/platforms/registry.ts`（注册表）· `apps/web/src/server/adapters/discovery.ts`（探测与追踪）· `apps/web/src/server/services/discovery-runner.ts`（任务状态机）· `apps/web/src/server/discovery-store.ts`（持久化）· `apps/web/src/server/routes/discovery.ts`（API）。

## 1. 边界先于能力

| 边界 | 契约位置 |
|---|---|
| 探测只回答“平台此刻是否持有匹配账号”，不回答“这是不是研究对象” | `ProbeResultDraft` 与 `AccountLink` 分离 |
| 身份归属必须显式：自动确认只接受确定性互链 | `planOnePassCorrection` |
| 每个结果带收据与验证标签，导入结果永为 `live_unverified` | `ProbeReceipt` / `ProbeVerification` |
| 研究必须声明授权依据（本人 / 已获授权 / 公开职业人物） | `DiscoveryAuthorization` |
| 帖子只读已确认归属的账号；撤回归属即撤回帖子 | `attributionFor` / `postAttribution` |
| 只抓固定注册表端点；主题串 URL 编码进模板；重定向不跟随 | `resolveRuleUrl` / `fetchBounded` |

## 2. 共享契约（`stripsearch/platform-discovery/v1`）

### 2.1 研究对象与探测结果

```ts
type DiscoverySubjectKind = 'username' | 'email';
interface DiscoverySubject { kind; value }          // email 统一小写；用户名 1–64 [A-Za-z0-9._-]
type ProbeStatus = 'found' | 'not_found' | 'unknown' | 'blocked' | 'error';
type ProbeMethod = 'api_http' | 'profile_http' | 'external_report';
type ProbeVerification = 'offline_fixture' | 'live_verified' | 'live_unverified';
```

不变量：

1. **状态语义诚实。** 403/429 → `blocked`（平台拦截，不是不存在）；标记探测不匹配 → `unknown`；5xx → `error`；3xx → `unknown` + `redirect_not_followed`。任何意外输入都不会被升级成 `found`。
2. **收据必填。** `receipt = { tool, toolVersion, generatedAt, reportFormat }`。原生探测 tool 为 `stripsearch-http-probe`；导入为 `maigret` / `holehe`。
3. **验证标签不粉饰。** 注册表规则默认 `rule_live_unverified` 随结果落下；仅 GitHub 端点标 `live_verified`（沿用既有 GitHub adapter 验收范围）。
4. **超时记账未知。** 超时/中断的结果带 `billing_outcome_unknown`，usage 记 `outcomeUnknown`，不假装零费用。

### 2.2 账号链接与一次性校正

```ts
type LinkState = 'proposed' | 'confirmed' | 'dismissed';
type LinkBasis = 'exact_handle' | 'display_name' | 'cross_link' | 'self_declared' | 'tool_report' | 'manual_review';
type CorrectionAction = 'confirm' | 'dismiss' | 'reopen';
```

- `proposed` 是候选，`confirmed` 才有归属力，`dismissed` 撤回归属。`attributionFor(state)` → `linked | unattributed | revoked`，帖子与导出只认 `linked`。
- **一次性校正 = 一个批次一次修订。** `POST /corrections` 提交 N 条 decisions，整个批次在同一事务内落 `account_link_revisions`（actor、from/to、basis、note、counterevidence）；任一条失败时，账号、帖子、事件与任务修订全部回滚，成功时任务 `revision` 只 +1。
- **自动确认仅接受明确自链**：种子页必须位于服务端平台注册表允许的 origin，成功返回 HTML，且实际 `a[rel~=me]` 的规范化 URL 与候选主页完全一致。普通文本、URL 前缀、评论/脚本和错误页均不构成归属证据。未在允许列表内的个人网站不由服务端直接抓取，降为人工确认；安全的远端正文接入另行实现。种子页请求同样计入任务预算。**用户名一致永远只进 `needsReview`**，附带理由“同名/同用户名不等于同一人”。
- **撤回级联对称**：`dismiss` → 该链接下所有帖子 `excluded=1`（`attribution_revoked` 事件）；`reopen` / 从 dismissed 确认 → 恢复（`attribution_restored`）。帖子不删除，只失效——审计可回放。

### 2.3 任务连续性（检查点）

```ts
interface DiscoveryCheckpoint {
  version: 1;
  stage: 'discover' | 'correct' | 'track' | 'done';
  plannedProbeKeys: string[];
  completedProbeKeys: string[];      // probeKey = kind:value:platform:method，稳定
  trackCursors: Record<linkId, string | null>;
  finishedLinkIds: string[];
}
```

- **落盘先于下一问。** 每个探测结果持久化并写入 `completedProbeKeys` 后才发下一个请求；恢复时 `remainingProbeKeys` 直接跳过已答问题，不重复计费。
- **重启语义。** 未完成任务标 `partial + interrupted`，保留检查点；显式 `POST /resume` 才继续（含中止陈旧 in-flight 尝试），`resumed` 事件记录恢复点。对比 runs 把中断当终态，这是连续性的直接改进。
- **迟到结果守卫。** 一切进度写入走 `updateTaskIfActive`（仅 queued/discovering/correcting/tracking/needs_input 可写）；取消/完成后晚到的响应被丢弃，任务不复活。
- **幂等。** `Idempotency-Key` + 请求指纹（含授权声明）；同键同体回放，同键异体 409。`probe_key` 唯一索引保证续跑不重复落账。

### 2.4 帖子深度追踪

```ts
interface TrackedPostDraft {
  postKey;        // platform:remoteId，跨续跑稳定
  accountLinkId;  // 归属来源
  url; title; publishedAt; excerpt; excerptLocator;
  fetchStatus: 'ok' | 'truncated' | 'inaccessible' | 'excluded';
  limits: string[];  // 恒含 'listing_excerpt_only'、'full_text_not_fetched'
}
```

- 只追踪 `confirmed` 链接；`proposed` 挂起期间 `POST /track` 返回 409。
- 分页：游标（页码）入检查点，每链接上限 `maxPostsPerLink`，全局 requests/bytes 预算超出即 `partial + budget:*`。
- 支持 `json_list`（dotted path 字段映射，unix 秒自动转 ISO）与 `rss`（严格 item 抽取、CDATA/标签剥离）；坏载荷一律降级（`unparsable_body` / `items_path_mismatch` / `posts_fetch_failed`），不编造帖子。
- 摘录 ≤200 字符带定位；正文不抓取。帖子保持原始 URL 与发布时间。

## 3. 平台注册表

`PlatformRegistry = { version, generatedAt, rules: PlatformRule[] }`，版本 `2026-09-27.1`。每条规则：

| 字段 | 语义 |
|---|---|
| `probe` | `http_status` 或 `http_marker`（found/notFound 标记串）+ 固定 URL 模板；`null` = 仅接受外部工具报告导入 |
| `posts` | `none` / `json_list` / `rss` + 模板与字段映射 |
| `verification` | 该规则的验证状态，结果按此打标签 |
| `rateLimitPerMinute` | 期望限速；被限流如实记 `blocked` |

当前 13 条规则：GitHub（`live_verified` 语义）、DEV Community、Hacker News、Medium、Reddit、npm、PyPI、Hugging Face、GitLab、Bluesky 为可探测；X、Instagram、哔哩哔哩为 import-only（登录墙/UID 映射不确定，未登录探测不可靠）。**除 GitHub 外全部 `live_unverified`。** 加规则必须 bump 版本；任务记录运行时注册表版本，结果可复现。

## 4. 外部工具集成（“用这个包真实查询”）

集成姿势：**在受控环境外运行 CLI，把机器可读报告导入任务**；本仓库不 vendor、不子进程调用第三方代码，报告按不可信数据解析。

### 4.1 maigret（MIT）

按 [maigret/report.py](https://github.com/soxoj/maigret/blob/main/maigret/report.py) 与 [result.py](https://github.com/soxoj/maigret/blob/main/maigret/result.py) 源码核实的输出契约：

- `maigret <user> --json simple` → `{ "<sitename>": <entry> }`，只含 `Claimed` 站点；
- `--json ndjson` → 每行一个 entry，带 `sitename`；
- entry 关键字段：`username`、`url_main`、`url_user`、`http_status`、`is_similar`、`status: { username, site_name, url, status, ids, tags, keywords, keyword_match_status }`、`ids_usernames`、`ids_data`；
- 状态词表 `Claimed / Available / Unknown / Illegal`（`MaigretCheckStatus`）。

映射：`Claimed→found`、`Available→not_found`、`Illegal/Unknown/其它→unknown`（带 warning）；`is_similar=true` 整条丢弃（maigret 自己也丢）。未知拼写**永不**变 `found`。

### 4.2 holehe（GPL-3.0）

按 [holehe README](https://github.com/megadose/holehe) 核实的模块输出契约：

```json
{ "name": "example", "rateLimit": false, "exists": true,
  "emailrecovery": "ex****e@gmail.com", "phoneNumber": "0*******78", "others": null }
```

接受模块字典数组 / NDJSON / 单字典。映射：`rateLimit=true→blocked`（优先）、`exists=true→found`、`false→not_found`、缺失→unknown。

**隐私最小化**：`emailrecovery` / `phoneNumber` 是再联系线索（个人数据），解析即丢弃并记 warning `已丢弃恢复邮箱/电话等再联系字段`，导出断言不含这些字段（有测试固定）。

### 4.3 许可边界

holehe 是 **GPL-3.0**，本仓库是 Apache-2.0：不复制其代码、不引入其模块，只解析用户提供的 JSON 输出（数据）。maigret 为 MIT，同样只按文档解析报告。这不构成对任何第三方服务条款的合规认证（见 [REVIEW](REVIEW.md)）。

## 5. HTTP API

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/discovery/registry` | 平台能力面（含逐规则验证状态） |
| POST | `/api/discovery/tasks` | 创建任务（须 `authorization`；支持 `Idempotency-Key`） |
| GET | `/api/discovery/tasks` · `/:id` | 列表 / 详情（探针、链接+修订、帖子、导入、事件） |
| POST | `/api/discovery/tasks/:id/corrections` | 一次性批量校正（confirm/dismiss/reopen） |
| POST | `/api/discovery/tasks/:id/imports` | 导入 maigret / holehe 报告（独立 256 KiB 体限） |
| POST | `/api/discovery/tasks/:id/track` | 对已确认链接启动/继续深度追踪 |
| POST | `/api/discovery/tasks/:id/resume` | 从检查点恢复（有待决归属时 409） |
| POST | `/api/discovery/tasks/:id/cancel` | 取消（终态，迟到结果被守卫丢弃） |
| GET | `/api/discovery/tasks/:id/export.json` | 带收据、验证标签与限制清单的规范导出 |

状态机：`queued → discovering → correcting → (needs_input) → tracking → completed | partial | failed | cancelled`；`mode='discover'` 跳过 tracking。所有接口 owner 校验；修改接口走共享 Origin 中间件。

## 6. 未验证清单（实施门槛，不得当已通过）

1. 除 GitHub 外每个注册表规则的 live 端点语义（含标记串）——预期失败模式是降级为 `unknown`，不是误报 `found`，但仍需逐条实测。
2. 真实 `maigret` / `holehe` CLI 运行的端到端收据（版本、参数、报告落盘）。
3. 已授权对象上的发现精度 / 归属精度 / 误报率（见 [EVAL](EVAL.md)）。
4. 各平台 ToS 与限流策略的合规复核；探测流量的合法性判断由部署者负责。
5. RSS/JSON 列表端点的长期稳定性与分页语义。
