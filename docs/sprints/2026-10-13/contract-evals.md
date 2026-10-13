# 独立离线契约评测（2026-10-13）

新增 [Sprint contract v1](../../../evals/sprint-contract-v1/README.md)：**33/33 个生产契约场景通过；46/46 个评测器与禁网自检通过**。Node `22.23.2`，无外部网络尝试、无 provider/model 调用。结果只说明当前合成输入下的确定性契约，不属于人工 gold、真人识别质量、provider 验收或部署验收。

## 可复现入口

仓库根目录：

```bash
node apps/web/src/evals/sprint-contract-v1/run.mjs
node --import ./apps/web/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 apps/web/src/tests/sprint-evals.test.ts
```

在 `apps/web` 可直接 `node src/evals/sprint-contract-v1/run.mjs`。输出路径参数统一相对仓库根目录。默认本地完整证据在 `_private/evals/sprint-contract-v1/latest/`；无本机路径的 [永久机器可读摘要](contract-evals-replay.json) 保存每例期望、实际投影、失败列表、数据/schema/lockfile/运行时源码与生成 JS 的 SHA256。完整原文与输入在公开合成 fixture 中，可随时重放恢复逐例证据。

## 实际验证

- 13 个链接/身份用例直接调用生产提取、上下文归属、身份评估和默认建议。覆盖否认与冲突、第三方、作品作者、组织和未知类型、搜索索引不冒充原文、同源不增加独立支持；精确引文/locator/hash 不因 URL 解码改写。
- 6 个实名自述用例直接调用 `namedOwnerQuote`，验证正向原文与标题、引语、错误 receipt、索引、指令形文本的边界。
- 14 个工具用例直接调用 GET-59 `dispatch`。受限动作若到达 handler、provider 或 submission 探针则失败；合法 catalog 读取必须实际成功。
- 评测器自检拒绝未知场景、漏字段、未知字段、无效类型、不一致期望、重复案例和伪造已评审标签。故意修改一条预期时退出 1、保留全部 33 条记录；非法场景退出 2、不伪造成功；故意执行异常后仍跑完后续案例。
- 两次 guarded CLI 重放输出字节相同。12 个禁网探针覆盖 fetch、HTTP/HTTPS/HTTP2、DNS promises/Resolver、TCP/TLS、子进程、worker 与 UDP；吞异常仍写独立日志并非零退出。探针只调用预先拦截的 API，没有真实网络发送。

所有新增内容独立版本化；既有 Runtime/Research/Behavior/FRAMES 数据未改动。运行时依赖图转译只用于启动禁网 worker；全项目 typecheck/build/full suite/CI 由冲刺集成任务单独记录。

## 仍需后续验证

1. 本套不读取真实 Store 的跨事务状态；工具端口提供固定合成可信快照。持久范围/撤回/竞争由仓库既有与本轮集成测试覆盖，不能由本套替代。
2. 不模拟 provider 输出质量、分页或付费预算；当前工具场景专注授权前门与 verify 隔离。真实请求和模型质量另行许可与验收。
3. 当前 raw-span 验证针对 HTML/Markdown 字符串；原生账号 payload、动态页面、OCR、媒体和语言变体需要独立补充。
4. guard 是进程 API 层，未声称 OS 级隔离；新增网络接口或原生依赖时要扩展守卫和安全 probe。
