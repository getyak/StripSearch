# StripSearch Web Alpha (`apps/web`)

一个可运行的、同源的 StripSearch Web alpha：Express + Better Auth + SQLite + 原生 TypeScript 客户端。
它实现认证、按账号隔离的研究作业、姓名或链接单输入、DeepSeek / DSH 多步研究、Exa / TikHub / Firecrawl 工具、来源排除 / 恢复、
同一份 Person Object 的 Markdown / JSON / HTML / PDF 导出。运行边界见[人物研究说明](../../docs/person-research-release.md)。

> 状态：**可运行 alpha**。它不改变仓库既有的 M1–M4 验收，也不代表 Exa 回答质量、MCP 宿主或评测已经通过。
> 静态设计原稿仍保留在 [design/web](../../design/web/DESIGN.md)，未修改。

## 运行

要求：Node **22.23.2**，npm 12。

```bash
npm --prefix apps/web ci          # 安装锁定依赖（联网）
npm --prefix apps/web run build   # 构建客户端与服务器到 apps/web/dist
npm --prefix apps/web start        # 单端口同源服务 http://localhost:4392
```

打开 <http://localhost:4392>。默认只绑定 loopback；远程访问使用下述 hosted 模式和 HTTPS 反向代理。

## 部署模式

`STRIPSEARCH_DEPLOYMENT` 默认 `local`，保持上述 HTTP loopback 行为。

`hosted` 用于「本机反向代理终止 TLS、进程仍只绑定 loopback」的场景：

```bash
STRIPSEARCH_DEPLOYMENT=hosted \
STRIPSEARCH_PUBLIC_ORIGIN=https://search.example.com \
STRIPSEARCH_SIGNUP_EMAILS=alice@example.com,bob@example.com \
PORT=4392 npm --prefix apps/web start
```

- `STRIPSEARCH_PUBLIC_ORIGIN` 必填，必须是 HTTPS，且无凭据 / 路径 / 查询 / 片段 / 通配符；hosted 只信任这一个 Origin，`baseURL` 固定为它。
- cookie 变为 Secure（名称 `__Secure-stripsearch.*`），其余属性不变。
- `STRIPSEARCH_SIGNUP_EMAILS` 是逗号分隔、大小写不敏感、精确地址的注册允许名单。未设置或为空时拒绝全部新注册，但已有账号仍可登录；被拒时 UI 显示可读提示。
- 反向代理契约：代理终止公网 HTTPS，并转发到 loopback `PORT`，用真实客户端 IP **覆盖**（不要追加）`X-Forwarded-For`，可选覆盖 `X-Real-IP`。服务端只在 hosted 模式信任来自 loopback（`127.0.0.1` / `::1`）的这些头，用于认证限流 IP 归并；不信任 `X-Forwarded-Host` / `X-Forwarded-Proto`。hosted 认证变更与业务变更都要求精确 Origin，缺失或外来 Origin 返回 403。
- 部署、持久化、备份与发布验收步骤见[部署说明](../../docs/deployment.md)。

开发：

```bash
npm --prefix apps/web run dev        # 构建客户端后以 tsx watch 启动服务器
npm --prefix apps/web run dev:client # 仅监听客户端改动并重建 dist/client
```

## 测试与检查（离线）

```bash
npm --prefix apps/web test           # node:test + tsx，注入合成 provider，不访问网络
npm --prefix apps/web run typecheck  # server / client / tests 三套 tsconfig
npm --prefix apps/web run build
python3 scripts/check_design.py      # 仓库根目录
```

测试覆盖认证 cookie 与退出、跨账号授权、Origin 拒绝、请求边界（含 chunked 超限）、幂等键语义、并发上限、取消 / 删除后晚回包、
重启中断保留、GitHub / Exa 适配器（固定端点、账号归属校验、超时、重定向、429/403/404、非法 URL 与引用）、来源修订与导出一致性、
SSE 终态与会话撤销，以及基于 jsdom 的真实控制器回归（迟到请求 / 退出 / 切换运行不污染 UI）与渲染转义、链接安全。
适配器测试使用注入的离线 transport，不发出真实请求。

## 配置

复制 [`.env.example`](.env.example) 为 `apps/web/.env`（已被 Git 忽略）。所有值只在服务端使用：

| 变量 | 作用 |
| --- | --- |
| `EXA_API_KEY` | 人物研究必需；网页搜索与正文读取。 |
| `DEEPSEEK_API_KEY` | 人物研究必需；仅父进程用于计量后的模型调用。 |
| `STRIPSEARCH_DEEPSEEK_MODEL` | 默认 `deepseek-flash`；Flash/Pro 使用版本化估价，未知模型费用标未知。 |
| `TIKHUB_API_KEY` | 可选，启用 X 公开主页及单页本人帖子。 |
| `FIRECRAWL_API_KEY` | 可选，普通 HTML 网页读取；禁用 X 与 PDF/AI 格式。 |
| `CHROMIUM_EXECUTABLE_PATH` | PDF 使用本机 Chromium；容器已安装 Chromium 与中文字体。 |
| `GITHUB_TOKEN` | 可选。GitHub 公开读取无需 token；配置后只提高匿名配额。 |
| `PORT` | 默认 `4392`。 |
| `STRIPSEARCH_DATA_DIR` | 默认 `apps/web/.data`（已忽略）。 |
| `STRIPSEARCH_DEPLOYMENT` | 默认 `local`；`hosted` 启用 HTTPS 部署约束、Secure cookie 与注册名单。 |
| `STRIPSEARCH_PUBLIC_ORIGIN` | 受信任的同源地址。local 默认 `http://localhost:4392` 且必须是 loopback HTTP 并匹配 `PORT`；hosted 必填 HTTPS，无路径 / 凭据 / 通配符，仅信任该 Origin。 |
| `STRIPSEARCH_SIGNUP_EMAILS` | 仅 hosted 生效。逗号分隔、大小写不敏感的注册允许名单；为空则拒绝全部新注册，已有账号仍可登录。 |
| `BETTER_AUTH_SECRET` | 可选。缺省时在数据目录生成一次 `auth-secret`（权限 `0600`），没有共享默认值。 |

服务端绝不把供应商密钥写入客户端 bundle、日志或 `/api/health`。

## 实际限制（与 `src/shared/limits.ts` 一致）

| 项 | 值 |
| --- | --- |
| 研究问题 | 2–500 字符 |
| 主页链接 | ≤ 2048 字符，仅 http(s) |
| 密码 | 8–128 字符 |
| 认证请求体 | 实际读取 ≤ 8 KiB（含 chunked）；应用 JSON ≤ 32 KiB |
| Provider 超时 / 响应上限 | 15 s / 512 KiB |
| 人物研究 | 单次最多 12 工具 / 8 模型请求，150k 输入 / 16k 输出 token 预留预算，240 秒；未知用量保留预留额 |
| GitHub（legacy） | 每个账号 2 次请求；一页最多 30 个仓库；最多展示 8 个非 fork 作品 |
| Exa（legacy） | 固定 `https://api.exa.ai`；`/search` 6 条结果、每条摘录 ≤ 1200 字符；`/answer` ≤ 4000 字符；引用必须全部有效且映射到来源，否则不采用整理结果 |
| 并发 | 每用户 1 个运行中作业，全局 3 |
| 启动限流 | 每用户 60 秒 10 次 |
| 记录上限 | 每用户 200 份研究 |
| 会话 | 7 天，HttpOnly、SameSite=Lax，cookie 前缀 `stripsearch`；hosted 追加 Secure（名称 `__Secure-stripsearch.*`） |

## API 契约（同源，`/api/*`）

认证（Better Auth，`basePath=/api/auth`）：`sign-up/email`、`sign-in/email`、`sign-out`、`get-session`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 仅返回能力标记，不含密钥。 |
| GET | `/api/runs` | 当前账号的研究摘要列表。 |
| POST | `/api/runs` | 创建研究；`Idempotency-Key` 可选：同一键 + 同一规范化请求返回同一运行；已删除返回 410；新键或省略键创建新运行。 |
| GET | `/api/runs/:id` | 规范化视图 + 有序事件（`?since=`）。 |
| GET | `/api/runs/:id/events` | SSE 事件流，支持 `Last-Event-ID` / `?after=`，终态后发送 `done`。 |
| POST | `/api/runs/:id/cancel` | 取消并中止后续写入；幂等。 |
| POST | `/api/runs/:id/resume` | 以存储的 `candidateId` + `expectedRevision` 确认人物；旧接口仍可补充主页。 |
| POST | `/api/runs/:id/retry` | 显式重试，创建新的子运行；可带幂等键重复提交。 |
| POST | `/api/runs/:id/followup` | 追问（人物研究或旧 Exa 来源），创建关联子研究。 |
| DELETE | `/api/runs/:id` | 删除研究、来源与事件。 |
| GET | `/api/runs/:id/export?format=markdown\|json\|html\|pdf` | 与界面同一份规范化视图。 |
| POST | `/api/runs/:id/sources/:key/exclude\|restore` | 需 `expectedRevision`，过期返回 `409 stale_revision`。 |

所有 `/api/*` 应用路由都要求登录并对资源做所有权校验（其他账号得到 `404`），变更请求要求精确匹配的 `Origin`（否则 `403`）。

## 标注工作台（`/#/review`）

认证后的中文标注工作台，用于产出**版本化人工标签**：

- 顶部导航「标注工作台」或 `/#/review`（深链案例 `/#/review/<caseId>`）。
- 「载入 10 个练习案例」显式且幂等地写入 10 个原创合成练习（8 个改编自 [Behavior v1](../../evals/behavior-v1/README.md) + 2 个身份 / 引用）；`GET` 不会创建；每个账号最多 200 个案例，达上限时只插入剩余容量。
- 两阶段评审：证据 + 逐条论断 `支持 / 矛盾 / 证据不足 / 无法判断`；盲选前展示两个候选全文，再选 `A / B / 平局 / 都不好 / 无法判断`，带理由标签与自由理由；参考答案 / 必须包含 / 必须避免作为可编辑人工 rubric。
- 草稿可保存不完整内容；提交要求逐条判断、真实证据 ID、偏好与理由。保存带 `expectedRevision`，过期返回 `409 stale_revision`；字段超长 / 列表超限 / 原型键 / 错误类型都返回 `400`，不静默截断。
- 队列显示未评审 / 草稿 / 已提交、进度、搜索与筛选；支持上一题 / 下一题与 `⌘ / Ctrl + Enter` 保存并下一题；保存与进度固定在评审区顶部。
- 案例内容在创建时写入 SHA-256 `contentHash` 后不可变；A/B 映射在服务端随机一次并持久化，提交前不返回候选来源 / 模型元数据，提交后才揭示。
- 历史版本可只读查看旧判断、证据、偏好、理由与 rubric；导出包含全部追加修订与可复现的哈希 payload。
- 未保存的评审或新建表单会在刷新、站内导航与退出登录前提示；账号切换或会话失效会清空工作台并使迟到请求失效。
- 汇总只统计已提交的最新修订，并显示「这些判断用于形成评估标准，尚未运行模型对照」，只给需人工确认的下一步建议。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/review/seed` | 幂等载入 10 个练习案例（仅显式调用） |
| GET | `/api/review/cases` | 队列、状态与进度 |
| POST | `/api/review/cases` | 自建案例：问题、证据行、两个粘贴回答（每行一条论断） |
| GET | `/api/review/cases/:id` | 案例、最新评审与历史 |
| GET | `/api/review/cases/:id/history` | 历史修订 |
| PUT | `/api/review/cases/:id/annotation` | 保存草稿 / 提交；成功后返回 `已保存` |
| DELETE | `/api/review/cases/:id` | 删除案例及其全部评审 |
| GET | `/api/review/insights` | 已提交最新修订的聚合计数 |
| GET | `/api/review/export?format=json\|jsonl&filter=all\|reviewed` | 用户触发的导出下载 |

数据模型、导出结构与限制见 [标注工作台文档](../../docs/annotation-workbench.md)。固定 `split=discovery`，全部标签为人工单评审探索，不是 gold、不是双盲、尚未运行模型对照。内置练习候选是开发时生成的合成示例，不是模型实测结果。

## 验收与限制

- 离线自动化测试全部通过（`npm --prefix apps/web test`），覆盖认证 cookie / hosted Secure 与退出、受限注册拒绝、跨账号授权、Origin 缺失 / 伪造拒绝（含认证变更）、幂等键语义、并发上限、取消 / 删除后晚回包、重启中断保留、GitHub / Exa 适配器、来源修订与导出一致性、SSE，以及编译产物从 `dist/client` 提供真实客户端资源。
- 真实验收（历史）：GitHub 调研（2 次请求、9 条来源）、账号隔离、导出、修订和重启持久化；记录仅保留状态与计数，不提交人物档案。
- hosted 模式的线上验收须单独核对证书、代理、会话、持久化及发布版本，不能仅用本地测试代替。
- Safari 与内嵌 Chromium 验证登录、来源操作、刷新恢复；375px 无横向溢出，明暗与 reduced-motion 跟随系统。
- 2026-09-22 托管验收中 Exa 真实调用返回 5 条来源，但没有采用可用整理结果，状态为 partial；不代表回答质量验收。邮箱验证、密码找回与 OAuth 尚未实现。
- 仅读取 GitHub 公开元数据，不读取仓库代码；仓库归属不代表个人贡献。GitHub 来源不解释任意问题，追问需要配置 Exa。
- Exa 的整理结果是供应商生成的摘要，不是独立核实事实；引用不完整时直接不采用。
- 不含 MCP 宿主、本地档案导入或质量 benchmark；TikHub 当前只覆盖已验证的 X 主页 / 单页本人帖子。姓名候选必须确认；明确主页链接直接读取。
