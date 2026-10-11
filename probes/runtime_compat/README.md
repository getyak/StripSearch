# Runtime compatibility smoke

仅验证安装包、stdio 工具/资源调用与 SQLite rollback；不是 StripSearch MCP server，也没有实现七个业务工具。使用纯合成 echo，无搜索、模型或付费服务。Node ≥22，依赖精确版本写入 package-lock.json。

```sh
cd probes/runtime_compat
npm ci --no-audit --no-fund
npm test
```

安装依赖需要网络；测试本身仅启动本地 stdio 子进程与内存数据库。两个 SDK client（v1/v2）不等于两个真实宿主。所有子进程由 client.close 清理，SQLite 使用内存库并关闭。

验证：initialize、tools/list 的 schema、structuredContent 与文本一致、非法输入拒绝、resource read、约束失败后 SQLite 事务回滚。任一断言失败退出非零。

API 依据：[官方 server 教程](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md)、[官方 client 教程](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md)、[better-sqlite3 transaction](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#databasetransactionfunction---function)。

本机结果与限制记录在 [初始化验证](../../docs/initialization-validation.md)。

2026-10-11 安全维护：v2 client/server/core 使用 `2.2.0`，v1 `mcp-v1` alias 使用 `1.31.0`；保留两个代际的 stdio 与 SQLite smoke，版本依据见[代码维护契约](../../docs/code-maintenance.md#依赖)。
