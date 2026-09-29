# Web 运行时实施契约

状态：本文件定义的独立可运行 Web alpha 已落在 `apps/web`（同源认证 + SQLite 作业 + GitHub 适配器 + 可选 Exa + 导出 + UI）。静态设计仍位于 `design/web`。该 alpha **不代表** M1–M4 整体通过，也不代表 Exa 回答质量或研究效果评测已验收。

## 本轮交付

- 沿用 Evidence Terminal 的问题入口、三栏研究页、系统明暗主题和精简中文；正式入口位于 `apps/web`。
- 邮箱密码注册、登录、退出、持久会话。账号用于本机应用，不声称邮箱已验证；邮件找回和 OAuth 待配置后另行验收。
- 真实 GitHub 公开账号 / 仓库读取，无需密钥；可配置 Exa 网页检索与带引用回答。供应商未配置、限流、失败明确显示。
- 研究记录按账号隔离并保存在 SQLite。支持进度事件、取消、刷新恢复、追问、新建、删除、来源排除 / 恢复和 Markdown / JSON 导出。
- 动效对应请求、消息进入、引用定位、抽屉展开与按钮反馈；支持减少动态效果，不制造进度百分比。

## 技术基线

Node 22.23.2、TypeScript、Express 5.2.1、Better Auth 1.7.5、SQLite（better-sqlite3）、Vite 8.3.0 vanilla TypeScript。依赖锁定版本并提交 lockfile。认证交给 Better Auth，不自行设计密码哈希协议。

只绑定 loopback；浏览器与 API 同源。会话为 HttpOnly cookie，独立 cookie 前缀、SameSite、服务端校验、认证与任务限流。所有研究、来源、事件、导出接口校验资源所有者；修改接口校验 Origin。密钥只在服务端，运行数据与本地认证 secret 排除 Git。

### 部署模式（`STRIPSEARCH_DEPLOYMENT=local|hosted`，默认 local）

- `local` 保持既有 HTTP loopback 行为：`STRIPSEARCH_PUBLIC_ORIGIN` 默认 `http://localhost:PORT`，必须是 loopback HTTP 且端口匹配 `PORT`，cookie 不带 Secure。
- `hosted` 要求显式 HTTPS `STRIPSEARCH_PUBLIC_ORIGIN`（无凭据、路径、查询、片段或通配符），只信任这一个 Origin，cookie 变为 Secure（名称为 `__Secure-stripsearch.*`），仍只绑定 loopback，由本机反向代理终止 TLS。`host/port` 与反向代理无关：进程继续监听 loopback `PORT`，公网端口不必等于 `PORT`。
- `baseURL` 固定为配置的 Origin，不信任 `X-Forwarded-Host` / `X-Forwarded-Proto`。hosted 下认证变更（注册 / 登录 / 退出）与其它变更接口一样必须携带精确 Origin，缺失或外来 Origin 返回 403。
- hosted 注册要求服务端配置 `STRIPSEARCH_SIGNUP_EMAILS`（逗号分隔、大小写不敏感、精确地址，不支持通配符）。名单为空时拒绝全部新注册，但已存在账号仍可登录；被拒注册在 UI 显示可读提示。local 模式不受此名单限制。
- 反向代理头契约：代理终止公网 HTTPS，并转发到 loopback `PORT`，用客户端真实 IP **覆盖**（不是追加）`X-Forwarded-For`，可选择同时覆盖 `X-Real-IP`。服务端仅在 hosted 模式信任来自 loopback（`127.0.0.1` / `::1`）的这些头，用于认证限流的 IP 归并；不信任任意转发头来改写 origin、主机或协议。
- 部署拓扑、持久化和线上验收流程见[部署说明](deployment.md)。离线检查不代替证书、代理、真实会话和重启持久化验收。

## 研究与数据契约

`queued → researching → completed | partial | failed | cancelled`。无可靠对象时要求补充主页。进度来自实际阶段和来源数；断线仅重新读取，不隐式重跑付费调用。重启时未完成作业转为 partial 并注明中断，不自动追加费用。

每个 run 有 owner、输入、parent run、幂等键、revision、时间、来源、观察项、整理结果、限制、调用账和有序事件。幂等键与用户及输入摘要绑定。追问创建可见的子研究，不把固定脚本当回答。

GitHub 只请求固定 API origin 的已验证用户名和仓库路径，不读取私人邮箱或位置。自述为自述；仓库归属不等于个人贡献。最多读取一页仓库，并记录截断限制。

Exa 使用固定官方 endpoint、超时、响应大小和结果数限制，不由本机抓取用户任意 URL。结果保持原 URL、获取时间和可用的短摘录。Exa 的回答标为整理结果，引用必须能映射到实际返回的来源；不把摘要或模型回答升级为独立核实事实。搜索结果不会自动确认同名身份。排除来源后，所有依赖该来源的内容失效，导出使用相同修订模型。

离线测试注入合成 provider，不访问网络或示例域名。真实验收仅记录请求状态、计数及验证结果，人物材料留在忽略目录，不提交第三方全文或个人研究档案。

## 平台发现与帖子追踪（2026-09-27 新增）

契约全文见[平台发现提案](design/platform-discovery-2026-09-27/TECHNICAL.md)。要点：

- **发现**：`POST /api/discovery/tasks` 创建持久任务（用户名/邮箱 + `authorization` 授权声明），探测引擎只打注册表固定 https 端点（限速/限体/重定向不跟随），状态诚实分为 found / not_found / unknown / blocked / error；支持导入 maigret / holehe 报告，每条结果带工具收据与 `live_unverified`。
- **一次纠正**：用户名一致只进待确认；仅确定性互链自动确认。`POST .../corrections` 批量 confirm / dismiss / reopen，一次修订一条审计，撤回级联到帖子。
- **深度追踪**：只读已确认归属账号的帖子列表（JSON / RSS、分页、摘录+定位），正文不抓取；归属撤回则帖子失效，重开恢复。
- **连续性**：每问先落检查点再发下一请求；重启转 `partial` 并保留检查点，显式 `resume` 续跑不重复计费；取消为终态，迟到结果被守卫丢弃。
- **未验证**：除 GitHub 外全部平台规则、真实 maigret / holehe CLI 端到端、发现/归属精度、ToS 合规（见[审查](design/platform-discovery-2026-09-27/REVIEW.md)）。UI 尚未接入，入口为 HTTP API 与规范导出。

## 验证重点

认证 cookie、错误密码、退出失效、跨账号隔离、Origin 拒绝、幂等冲突、重启持久化、取消不被晚回包覆盖、来源撤回与导出一致、供应商超时 / 429 / 错误 / 非法引用、UI 空白 / 加载 / 错误 / 重试、375px 不溢出、系统主题与 reduced motion。

## 已实现与实测限制

入口为 `apps/web`（TypeScript、Express 5.2.1、Better Auth 1.7.5、better-sqlite3 13.0.3、Vite 8.3.0，Node 22.23.2，lockfile 已提交）。运行：

```bash
npm --prefix apps/web ci
npm --prefix apps/web run build
npm --prefix apps/web start   # http://localhost:4392
```

- 认证：真实邮箱密码注册 / 登录 / 退出 / 会话；cookie 前缀 `stripsearch`、HttpOnly、SameSite=Lax、7 天（hosted 追加 Secure），名称在 hosted 为 `__Secure-stripsearch.*`；注册输入受限；认证请求体按实际字节限制（含 chunked），限流开发环境也启用；私有 `/api` 响应 `no-store`。
- 作业：单进程持久化队列（每用户 1、全局 3），`queued → researching → completed | partial | failed | cancelled | needs_input`；启动限流每用户 60 秒 10 次，记录上限 200。
- 研究：仅同一 `Idempotency-Key` + 同一规范化请求返回已有运行，已删除记录返回 410，不隐式重新调用；新键或省略键创建新研究；取消 / 删除后晚回包被丢弃（删除先中止作业）；重启把未完成作业转为 `partial` 并记 `interrupted`，不自动重跑。
- Provider：GitHub 固定 `https://api.github.com`，仅接受与请求 handle 一致的账号与仓库，每账号 2 次请求、一页 30 个仓库、最多展示 8 个非 fork 作品；Exa 固定 `https://api.exa.ai`，检索与整理回答都以种子 grounded，引用必须全部有效且映射到来源，否则不采用整理结果；两者超时 15 秒、响应 512 KiB。
- 来源修订：排除 / 恢复基于 `expectedRevision`，过期返回 409；依赖结论、SSE 与 Markdown / JSON 导出读取同一规范化视图。
- 界面：系统明暗主题、reduced motion、SSE 重连与会话撤销后关闭、来源抽屉焦点保留、44px 触控目标；动效只用 transform / opacity；异步请求按运行 / 会话世代丢弃迟到结果。

已由 `npm --prefix apps/web test` 离线验证：认证 cookie 与退出、跨账号授权、Origin 拒绝、边界（含 chunked 超限）与幂等键语义、并发、取消 / 删除晚回包、重启中断保留、适配器固定端点 / 账号归属 / 超时 / 重定向 / 429 / 403 / 404 / 非法引用、来源修订与导出一致、SSE 终态与会话撤销、jsdom 真实控制器回归与渲染转义 / 链接安全；另含 hosted 配置校验（Origin / Secure cookie / 名单）、hosted 注册 / 会话 / 退出与拒绝注册、认证与业务变更的 Origin 缺失 / 伪造拒绝、受限注册的 UI 提示，以及编译产物启动并从 `dist/client` 提供真实客户端资源。

独立验收：63 项运行时测试、36 项静态设计交互测试、三套 TypeScript 检查和生产构建通过。真实 GitHub 调研完成（2 次请求、9 条来源）；账号隔离、退出失效、来源修订、Markdown / JSON 一致和服务重启持久化通过。Safari 完成登录与真实调研；内嵌 Chromium 完成历史恢复、引用、排除 / 恢复、刷新、明暗主题和 375px / reduced-motion 检查，控制台无错误。

2026-09-22 托管部署的真实服务验收见[部署记录](deployment.md#线上验收记录)。未验证：Exa 回答质量、MCP 宿主、TikHub、本地档案和研究效果评测。邮箱未验证，邮件找回与 OAuth 未实现；GitHub 只读元数据。

2026-09-27 平台发现 / 校正 / 追踪模块落地（27 项新离线测试，全量 187 项通过，冻结回放 40 案例无回归）；除 GitHub 端点语义外全部平台规则未 live 验证，发现与归属质量未评测，不得当作已具备的能力。

## 官方接口依据

- [Better Auth 安装与 SQLite](https://better-auth.com/docs/installation)
- [Express handler 与服务端会话](https://better-auth.com/docs/integrations/express)
- [邮箱密码认证](https://better-auth.com/docs/authentication/email-password)
- [认证限流](https://better-auth.com/docs/concepts/rate-limit)
- [Vite vanilla TypeScript](https://vite.dev/guide/)
- [GitHub 用户 API](https://docs.github.com/en/rest/users/users#get-a-user)
- [GitHub 用户公开仓库](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)
- [Exa Search](https://exa.ai/docs/reference/search)
- [Exa Answer](https://exa.ai/docs/reference/answer)
