# Web Fetch 真实 GitHub 接入（GET-99 第一切片）

状态：**已实现的离线可验证切片**。认证同源 `/api/fetch` + 应用内 Web Fetch 入口 + 两阶段持久链路（真实 GitHub 公开抓取 → 冻结快照处理）。本切片只处理**公开 GitHub 账号 / 显式选定的公开仓库**；不启用 Exa、X 或网站抓取。真实线上验收、部署与合并由父级持有（见文末「验证状态」）。

## 范围与硬边界

- **只读公开资源**：`https://api.github.com` 生成路径（API 版本 `2026-03-10`），严格 `private=false` 目标；即使配置 `GITHUB_TOKEN` 也不读取私有资源。账号与组织端点区分（组织仓库列表走 `/orgs/{login}/repos`，个人走 `/users/{login}/repos?type=owner`）。
- **账号切片**：公开用户/组织资料 → 公开自有仓库列表（真实 Link 分页）→ 每仓库 README / 当前公开工作快照。账号资料须验证 login、正整数 numeric ID 与 User/Organization 类型；HTTP 200 但语义无效只保留缺口，不猜测账号类型继续枚举。**明确不是完整贡献历史**（不抓 commit、贡献者、star、参与度）。
- **仓库切片**：显式选定仓库的 issues（**含 PR**，`state=all`，真实 Link 续页）→ issue/PR 正文 → 每条目的**首页** issue 评论。不抓 review 线程、完整评论线程、代码或媒体。
- **归属边界**：`sourceAccountId`（权限/发布边界，即用户确认的目标账号）与 `authorAccountId`（实际作者）严格分开；评论归属保留实际 login/id、原始 permalink 与完整正文，第三方/未知角色原样保留。组织/仓库作者**不假定**为研究对象；账号研究**不认定**同一人关联；README 仓库归属不代表作者身份。
- **无语义综合、无质量结论**：研究问题保持未回答（除非有已实现的验证器支持）；待核证据与覆盖是有用输出。确定性调度器**零外部模型请求/令牌**，绝不把本地调度决策呈现为真实 LLM 使用。

## 端点契约（父级 2026-10-08 官方文档核对 + 实测预检）

- [List repositories for a user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)、[Get repository content](https://docs.github.com/en/rest/repos/contents#get-repository-content)、[List repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues)、[List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments)、[Using pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)。
- **Link 规范化**（实测）：issues 续页会返回数值仓库 id 形式 `https://api.github.com/repositories/{id}/issues?...&page=2&after=<opaque cursor>`，与 `/repos/{owner}/{name}/issues` 等价。续页校验**只在绑定公开元数据后**接受数值 id 形式（`GET /repos/{owner}/{name}` 返回的权威 `id` 与 `private=false`）。
- **续页严格性**：冻结非分页参数（`state`/`sort`/`direction`/`per_page`/`type`）必须**逐键完整、唯一且精确相等**（缺失即替换，例如去掉 `state=all` 会静默退回默认 `open`）；分页参数 `page`/`since`/`after`/`before` 语法有界；主机/端口/凭据/片段/重复参数/循环 token 一律拒绝并保留缺口；`rel="next"` 重复即歧义拒绝。初始隐式 `page=1` 参与循环检测。

## 两个持久阶段（阶段边界）

1. **阶段 1 · 真实采集**（`fetch-github-acquisition.ts`）：所有真实 HTTP 只经**一个受控 transport**，且必须在**持久 intent 之后**发出（绝不预取）；每次落定的 响应 + 语义校验 + 折叠 + checkpoint **同一事务原子提交**。请求键幂等：**已成功的请求绝不重复**；失败/限流/超限/私有/缺失保留为显式缺口（不是零结果、不是完成）；**结果未知**（超时/传输故障/被控制栅栏拒绝的迟到包）立即 `unreconciled` 停止，绝不自动重试，只能显式 `retry`（新记账尝试、先前费用未知）或 `skip`（永久缺口）；retry 授权在同一 intent 事务中仅消费一次，后续失败/再次未知不能继承它；关机取消及响应正文读取故障保留 unknown；调和记录、版本化授权与恢复状态同一事务提交，旧版裸 retry key 失效停机，必须重新明确选择，不能覆盖历史 skip。HTTP 落定与**语义捕获**分开记账：`semantic_state=valid/partial/invalid`——200 非数组/不可解析行/非字符串正文**绝不**算成功读取，也绝不伪造空正文。暂停/恢复/停止用控制 revision 栅栏拒绝旧代迟到包（不持久化正文/捕获）；scope/owner 漂移在请求前与原子折叠内都拒绝。快照冻结与阶段移交原子且拒绝未决 intent。
2. **阶段 2 · 冻结快照处理**（现有 `runFetchPipeline`）：**零新 HTTP、不重复计费**；生产缓存处理器（`fetch-github-catalog.ts`）只为精确捕获材料服务，经 GET-59 `dispatch` 校验网关 → GET-95 覆盖回执 → GET-60 确定性评估 + 隔离 verify。可信能力注入声明真实能力面（`read_thread`/`read_media` 显式 unsupported、评论只读首页），**不携带合成 capability 声明、不捏造 token 用量**。媒体显式 unknown/未读（绝不假造缺席）；README 评论面为**冻结理由的结构性不适用**；语义校验失败的评论页在缓存处理器中显式失败（绝不变成成功空页）。采集缺口（失败/未知/被拒/循环/不可读行）注入 GET-60 枚举观测：**耗尽快照 ≠ 耗尽真实历史**，分母保持未知。

## `/api/fetch` 请求/视图契约（`shared/research-fetch-github.ts`）

- `POST /api/fetch/start`：`{ targetUrl, question, accessScope, confirmation: true, confirmedTarget, confirmedQuestion, confirmedAccessScope }`。**开始任何 HTTP 前**必须显式确认目标 GitHub 账号或仓库、冻结的问题与支持的访问范围（三者逐字回显一致，否则 400）；`screenQuestion` 拒绝越界请求（422）；访问范围与目标形状不匹配 → 422。
- 会话 owner 只来自 middleware；运行按 owner 隔离（他人运行一律 404，不泄漏存在性）。`Idempotency-Key` + 请求指纹与既有路由同语义（同键同请求复用、同键异请求 409）；启动速率/并发边界复用既有 `checkStartAllowed`/`recordStart`；`expectedRevision` 版本冲突返回 409。
- `GET /api/fetch/runs`、`GET /api/fetch/runs/:id`：状态/计数/冻结限制/显式缺口/待核证据（来源链接 + 纯文本引文，**绝不渲染原始 HTML**）/快照处理摘要。`pause` / `resume`（未决未知结果必须显式 `reconcileUnknown: retry|skip`）/ `stop`。
- Web 确认绑定当前目标、问题和访问范围；编辑输入后必须重新勾选。未知请求恢复选择绑定当前 run 与控制 revision，切换运行或身份会清空；`needsReconciliation` 来自当前未决 intent，不把已经处理的历史 unknown 计数当成新授权义务。
- `GET /api/health` 的 `capabilities.fetchGithub` **独立于** legacy `research`（后者仍需 DeepSeek + Exa）；无「只有 Exa 可用」的提示。

## 持久化（SQLite 增量迁移）

`research_fetch_github_runs / _requests / _listing_rows / _items / _comments / _events`：每请求 intent/outcome、**精确完整返回正文**及其 SHA-256、来源 hash/revision（CaseStore 不可变 source pin）、request key、游标与缺口、逐条评论归属。无累计语料/请求上限：HTTP 请求与调度 quantum 均可恢复，用户可暂停/恢复；重启时未决 in-flight 一律 `unreconciled` 停止（绝不盲目重放）；单进程 worker（不主张 GET-79 分布式租约），有界单并发与关机接线。账号 ID 绑定 case（`ghacct:{caseId}:{login}`），同名账号跨 case 不碰撞不合并。

## 验证状态（离线、零外网/付费调用）

- 仓库测试（`apps/web/src/tests/fetch-*.test.ts`，36 项新增）：真实 SQLite 文件关闭重开 + 注入 HttpTransport 的采集链（真实 Link 多页、精确正文 hash（含超长正文）、同源去重、逐评论归属、私有目标、迟到包、未知结果、重启 fail-stop、零重复成功 HTTP）；真实 worker 全链（采集 → 冻结 → GET-59/95/60，未回答问题/诚实 partial、错误评论页不产生成功回执、媒体 unknown、零外部模型用量）；共享 `sourceAccountId` 绑定（可信 pin + 第三方作者接受，foreign/缺 pin/错误角色拒绝，旧跨账号拒绝不变）；认证 HTTP API（Origin/owner 404/幂等 409/无确认零 HTTP/速率 429/控制路径非 500）；重试失败/再次 unknown 后 skip、真实 worker 关机 AbortError/正文传输故障、同评论 ID 变更正文保留首次捕获并记录缺口、调和事务写入失败回滚、旧裸 retry key 迁移的显式 retry/skip；DOM 竞态（迟到 list/detail/start/control、stale 401/finally、新选择不被覆盖）。既有合成链回归（immutable manifests/read-back/chunking）保持全绿。
- 独立不可变探针（父级持有）：pagination 19/19、parser 6/6、comment-boundary 2/2、start 3/3（零外部请求）。
- **仍属父级**：真实 GitHub 线上验收、托管部署、PR/当前头 CI、合并。本切片不声明 GET-99 全部完成。
