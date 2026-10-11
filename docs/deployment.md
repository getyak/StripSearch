# Hosted Web alpha

**当前状态（2026-10-11）：临时 HTTPS 站点在线。** 10 月 5 日的下线是历史事件，10 月 8 日已重新部署。实际发布以 `/release.json` 与远端 `main` 的完整 SHA 一致为准；健康接口的 `0.1.0` 是固定包版本，不是发布版本。

The public homepage and authenticated workspace are one Express application. Deploy one Node process behind Nginx HTTPS on a Linux host, with persistent SQLite. Vercel is optional for a future separate marketing site; do not put the current SQLite database or in-process jobs in a stateless function.

This deployment does not complete the research-controller, CLI, MCP or benchmark milestones. Exa availability is distinct from research quality. The existing homepage is the released website; unmerged design prototypes are not a production application.

## Runtime contract

- Node 22.23.2, locked npm dependencies; build from an exact Git revision using the root `Dockerfile`.
- HTML entrypoints (including direct `index.html` and SPA fallback routes) and `/release.json` send `Cache-Control: no-store`; hashed assets retain their one-hour cache. This prevents newly received entrypoints from being reused with assets removed by later releases. Previously cached pages may still require one refresh; a new response cannot retroactively evict an older cache entry. See [HTTP cache directives](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control).
- `deploy/compose.yml` uses Linux host networking so the non-root process still listens only at `127.0.0.1:4392`. Nginx is the public endpoint; do not expose this port through the firewall.
- `/var/lib/stripsearch` holds SQLite and the generated `auth-secret`, outside release images. Keep it private and persistent. The runtime container is read-only except this directory and a bounded temporary filesystem.
- Hosted mode accepts exactly one configured HTTPS origin and uses Secure, HttpOnly session cookies. Nginx must overwrite forwarded IP/host/protocol headers, preserve the actual browser Origin, and disable response buffering for SSE.
- Registration defaults to `STRIPSEARCH_SIGNUP_MODE=open`: any valid email can register, and legacy `STRIPSEARCH_SIGNUP_EMAILS` alone does not impose a restriction. Set `STRIPSEARCH_SIGNUP_MODE=open` in the runtime environment as well, so older images used for rollback keep registration open. Restricted operators must explicitly set `STRIPSEARCH_SIGNUP_MODE=allowlist` and supply exact addresses; an empty list then rejects new accounts while existing login works. Upgrading changes the default: deployments that require restricted signup must set `allowlist` before upgrading. HTTPS cookies, exact Origin checks and auth rate limits still apply. Neither mode verifies email ownership; email delivery and password recovery are not configured.
- Provider keys stay in `/etc/stripsearch/runtime.env` (`0600`, root-owned), never in Git, image layers, browser output, health responses or deployment receipts. Exa is optional; do not reuse an unrelated GitHub account token.

## First deployment

1. Point a hostname at the server. Preserve existing sites, firewall rules and certificate renewal. Add a hostname-specific HTTP ACME challenge location at `/var/www/acme`, obtain its trusted certificate, then render `deploy/nginx.conf.template` with that hostname. Run `nginx -t` before reload. Never replace the server's whole Nginx configuration.
2. Create `/etc/stripsearch/runtime.env` with the following server-only settings. Add optional `EXA_API_KEY` using the authorized secret manager, without logging its value.

   ```dotenv
   NODE_ENV=production
   PORT=4392
   STRIPSEARCH_HOST=127.0.0.1
   STRIPSEARCH_DEPLOYMENT=hosted
   STRIPSEARCH_PUBLIC_ORIGIN=https://YOUR_HOSTNAME
   STRIPSEARCH_DATA_DIR=/var/lib/stripsearch
   STRIPSEARCH_SIGNUP_MODE=open
   ```

3. Transfer only `git archive <full-commit-sha>` into `/opt/stripsearch/releases/<full-commit-sha>`, then run `bash deploy/release.sh <full-commit-sha>` there as root. It builds the image, snapshots existing data, deploys it, checks container health and the served revision, and enables the backup timer. For an intentionally restricted deployment, set `allowlist` and bootstrap an owner privately before enabling the public HTTPS virtual host.
4. Verify the public HTTPS homepage and assets, `/api/health`, `/release.json`, authentication, Origin rejection, research/SSE, source revision/export and logout. Restart this project's container and prove a saved account/report survives. Repeat release verification after merging so the deployed SHA equals `origin/main`.

The release script builds before stopping this app, then snapshots the stopped database and file-based auth secret. If startup or served-revision verification fails, it stops the new writers, preserves their entire data directory under private `failed-releases`, restores the verified pre-upgrade database/secret without leftover WAL files, and only then recreates the prior image. If preservation or restoration fails, the service stays stopped; it must never start an old image on new first-step scope data. Runtime environment secrets remain unchanged. Keep the previous source/image and pre-upgrade backup until acceptance passes; records created during a failed release remain in its preserved scene and need explicit reconciliation.

## Backup and recovery

`stripsearch-backup.timer` takes a consistent SQLite online backup daily, checks integrity, and includes the file-based auth secret. Only this application's completed snapshots older than 14 days are pruned. Backups are under `/var/backups/stripsearch`; they protect against application mistakes, not host loss. Configure off-host copies separately before making durability guarantees.

Run `systemctl start stripsearch-backup.service` and inspect its result. To restore, stop only the `stripsearch` Compose project, preserve the current data directory for rollback, copy a verified snapshot's database and auth secret into a clean data directory, set owner `1000:1000` and private permissions, then restart and verify login/report readback. Never copy a live SQLite database with plain `cp` or restore over leftover WAL files. Preserve separately supplied auth secrets if `BETTER_AUTH_SECRET` was used.

Certificate renewal belongs to the host. Confirm the timer covers this hostname and reloads Nginx after renewal; do not create competing Certbot jobs sharing the same certificate store.

## Official configuration sources

- [Better Auth options](https://better-auth.com/docs/reference/options) and [cookie policy](https://better-auth.com/docs/concepts/cookies): fixed base URL, trusted origins and secure sessions.
- [Nginx proxy headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) and [response buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering): overwritten proxy metadata and immediate SSE delivery.
- [Docker host networking](https://docs.docker.com/engine/network/drivers/host/): Linux loopback topology.
- [SQLite online backup](https://www.sqlite.org/backup.html): consistent backup while the application runs.

## 2026-10-05 旧部署下线记录


2026-10-05：按运营者要求移除过时的临时官网与工作台。

- 删除该部署的容器、全部 `stripsearch` 镜像标签、服务器发布文件与运行环境配置；停用并删除专属备份 timer / service，删除旧域名证书及其续期配置。
- 移除应用反向代理，仅保留域名拒绝规则，避免旧请求落入同机其他站点。公网 HTTP 返回 `410 Gone`，HTTPS 在 TLS 握手阶段拒绝；应用 loopback 端口已关闭。
- 同机 IMStage 容器与 Nginx 配置保持原样，公网健康检查返回 `200`；Nginx 配置校验通过。
- 研究数据库与已有备份保留为私有存档，不提供在线访问；本次下线不包含研究数据销毁。

## 2026-09-22 历史线上验收记录

2026-09-22：官网与工作台已部署到临时 HTTPS 地址 <https://stripsearch.103.195.188.236.sslip.io>。版本读取 `/release.json`，代码交付见 [PR #3](https://github.com/cubxxw/StripSearch/pull/3)。

- 本地：88 项 Web 测试、类型检查、生产构建、设计与数据集完整性检查通过；40 个冻结回放通过（0 网络 / 模型调用）。
- 服务器：镜像构建及健康检查通过；进程为非 root、只读容器，监听 loopback；HTTPS 证书有效；持久化目录和每日备份已配置，首次备份完整性检查通过。
- 公网 API：Secure 登录、注册关闭、外来 / 缺失 Origin 拒绝、账号隔离、SSE、来源修订和同一版本 Markdown / JSON 导出通过。
- 真实 GitHub：2 次请求，9 条来源，completed。真实 Exa：2 次请求，5 条来源，partial；生成摘要未被采用，界面与报告保留限制。这是连通性与契约验收，不是研究质量评测。
- 初始账号由运营者私下交付；未迁移本机历史研究或其他账号。临时 DNS、单主机运行、仅同机备份和未实现邮件找回仍是使用边界。


## 2026-10-08 Fetch 恢复与站点发布验收

按用户授权恢复上述临时 HTTPS 站点，合并前发布版本为 `adf347acd5c0e7b88943ac1ff50d615f82746065`。2026-10-05 下线后保留的数据库与备份继续作为私有存档；本次使用新的持久化目录与认证密钥，未恢复旧账号或研究档案。同机其他服务保持健康。后续发布版本以 `/release.json` 读回为准，合并后仍需部署并核对 `origin/main`。

- 独立复审关闭 4 项 P1 与 3 项 P2；原封 8 个失败反例及 28 个分块/恢复测试通过。当前提交 CI 的 Web 测试为 787 通过、1 跳过，40 个冻结回放通过，类型/构建/设计检查通过。
- CI 与实际服务器的生产镜像均在禁网、只读容器中运行编译后的 Fetch + 真实 SQLite：中断/关闭/重开后完成 82 个工具动作、28 次正文读取，成功动作重复数为 0；DSH 注入、真实 Chromium PDF 和临时目录清理通过。
- 公网 HTTPS 的 10 组验收通过：HTML/资源与 exact SHA、开放注册、Secure/HttpOnly cookie、登录、缺失/外来 Origin 拒绝、跨账号隔离、SSE、同版本四格式导出、撤回/恢复与旧版本导出拒绝、仅本应用重启后的账号/会话/报告保留、退出后访问拒绝。报告由编译后的 Store 在命名合成账号下生成，未执行真实人物研究或外部 provider 请求。
- 实际备份服务成功、SQLite 完整性与认证密钥一致性检查通过；每日备份 timer 已启用。证书有效至 2027-01-06，新增域名沿用服务器既有证书续期 timer 与 webroot，未创建竞争续期任务。

在该次 10 月 8 日验收时未配置 Exa / DeepSeek / TikHub / Firecrawl 凭据，当时健康响应的 `exa` / `research` 为 false，人物研究请求明确返回 `provider_unavailable`。Fetch 新链仍是已验证的本地/容器合成原型，未接入 Web 自主研究与真实平台适配器；GET-99 的完整真实研究验收继续保持未完成。

## 2026-10-11 版本核对与整合边界

整合前公网 `/release.json`、服务器部署回执和运行镜像 label 均为 `60f40141049bfa6e72c7669b4d3ee962fdd28a49`，与远端 `main` 一致；HTML、JS、CSS 的公网字节 hash 与容器文件一致。`/api/health` 返回 healthy 能力响应，`fetchGithub`、`exa`、`research` 标记为 true。能力标记仅反映实现/配置，不能代替真实 provider 连通性与人物研究质量验收。

此次 [整合说明](release-2026-10-11.md) 纳入此前未合并的 Search / 第一阶段优化与设计记录。只有当前 PR head 的 CI、独立 review、合并后镜像与公网验收全部通过，才记录线上新版本交付。保留同一持久化目录、认证密钥和运行配置；禁止用旧的下线步骤处理当前服务。
