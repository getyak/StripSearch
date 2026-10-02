# Hosted Web alpha

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

The release script rolls back the image if startup or served-revision verification fails. It does not reverse schema changes. Review future migrations for rollback compatibility before deployment. Keep the previous source/image and pre-upgrade backup until acceptance passes.

## Backup and recovery

`stripsearch-backup.timer` takes a consistent SQLite online backup daily, checks integrity, and includes the file-based auth secret. Only this application's completed snapshots older than 14 days are pruned. Backups are under `/var/backups/stripsearch`; they protect against application mistakes, not host loss. Configure off-host copies separately before making durability guarantees.

Run `systemctl start stripsearch-backup.service` and inspect its result. To restore, stop only the `stripsearch` Compose project, preserve the current data directory for rollback, copy a verified snapshot's database and auth secret into a clean data directory, set owner `1000:1000` and private permissions, then restart and verify login/report readback. Never copy a live SQLite database with plain `cp` or restore over leftover WAL files. Preserve separately supplied auth secrets if `BETTER_AUTH_SECRET` was used.

Certificate renewal belongs to the host. Confirm the timer covers this hostname and reloads Nginx after renewal; do not create competing Certbot jobs sharing the same certificate store.

## Official configuration sources

- [Better Auth options](https://better-auth.com/docs/reference/options) and [cookie policy](https://better-auth.com/docs/concepts/cookies): fixed base URL, trusted origins and secure sessions.
- [Nginx proxy headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) and [response buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering): overwritten proxy metadata and immediate SSE delivery.
- [Docker host networking](https://docs.docker.com/engine/network/drivers/host/): Linux loopback topology.
- [SQLite online backup](https://www.sqlite.org/backup.html): consistent backup while the application runs.

## 线上验收记录

2026-09-22：官网与工作台已部署到临时 HTTPS 地址 <https://stripsearch.103.195.188.236.sslip.io>。版本读取 `/release.json`，代码交付见 [PR #3](https://github.com/cubxxw/StripSearch/pull/3)。

- 本地：88 项 Web 测试、类型检查、生产构建、设计与数据集完整性检查通过；40 个冻结回放通过（0 网络 / 模型调用）。
- 服务器：镜像构建及健康检查通过；进程为非 root、只读容器，监听 loopback；HTTPS 证书有效；持久化目录和每日备份已配置，首次备份完整性检查通过。
- 公网 API：Secure 登录、注册关闭、外来 / 缺失 Origin 拒绝、账号隔离、SSE、来源修订和同一版本 Markdown / JSON 导出通过。
- 真实 GitHub：2 次请求，9 条来源，completed。真实 Exa：2 次请求，5 条来源，partial；生成摘要未被采用，界面与报告保留限制。这是连通性与契约验收，不是研究质量评测。
- 初始账号由运营者私下交付；未迁移本机历史研究或其他账号。临时 DNS、单主机运行、仅同机备份和未实现邮件找回仍是使用边界。
