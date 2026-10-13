# 集成超时诊断与测试隔离修复

2026-10-13。结论：确认 **P1 离线测试 harness 缺少默认外部 transport 拒绝，并继承三类 provider 凭据**；已补修复及安全回归。没有证据把两次超时归因于本轮身份 URL guard，也不将所有失败简单归因于机器负载。

## 实际等待链

| 失败用例 | 等待内容和真实执行路径 | 本轮判断 |
|---|---|---|
| `first-step-recovery.test.ts` 的 retry API 用例 | 失败位于第 47 行、初次研究等待 `needs_input`，尚未进入 retry/selection。`waitFor` 默认阈值是 **4000 ms**，不是配置 6 秒；父任务串行重放日志该例整体约 4563 ms。工具与 Fetch planner 是 fake，但 Runner 在 DeepSeek+Exa key 非空时独立创建 Search Agent | 测试未注入 transport；原 harness → bootstrap → defaultTransport 可进入全局 HTTP fetch。假 API key 不是禁网边界。真实外部连接或响应时延可以阻塞等待；历史运行无 request counter，不能宣称已观察某个实际端点响应或精确外发次数 |
| `first-step-search.test.ts` 的初始 Fetch 计量用例 | 自有 10 秒循环先等待状态不再为 queued/researching，再等待 `runner.activeCount() === 0`；选择后重复。假 tools 与 Fetch planner 并不替代第一阶段 Search Agent，仍有真实 DSH worker 初始化/清理 | 此例直接构造 Runner，并将一个 async function 强转成 transport；真正 `invokeDeepSeek` 使用 `.fetch`，该值没有此方法。因此它不会通过 production defaultTransport 外发，但会在 DSH 初始化后失败。父任务串行重放已通过；本轮未证明确定性的状态机 bug，也未改它的 timeout |

Runner 的 Search Agent 在原文读取后通过真实 DSH 单决策适配器执行。模型失败先结算 failed receipt，发现器保留材料/缺口并继续到 `needs_input`。URL guard 仅在有效模型提议的同步验证阶段核对完成 read receipt 的 URL；它没有定时器、IO 或新增循环。上述两例正常工具 action 均携带实际 URL；Search Agent 请求失败时尚未形成提议，不会经该 guard 造成等待。

资源方面，父任务报告约 361 个 Node 进程、23.63 GiB swap 和降至约 29.31 GiB 的可用磁盘。这是执行噪声/调度压力证据，不足以证明任何单次超时的唯一原因。未终止其他任务、未调整并发门禁或 timeout。

## 修复与安全红绿验证

- [`harness.ts`](../../../apps/web/src/tests/harness.ts) 在 `bootstrap` 前注入默认 `offlineTestTransport`，直接拒绝 provider IO；使用 `{ ...overrides, transport: overrides.transport ?? offlineTestTransport }`，显式 `undefined` 不能重启生产 fallback，持久作业恢复/pump 也受边界约束。
- 构造 env 后、应用显式 fixture override 前，清理 `GITHUB_TOKEN`、`EXA_API_KEY`、`DEEPSEEK_API_KEY`、`FIRECRAWL_API_KEY`、`TIKHUB_API_KEY`；这些是 `loadConfig` 的五类 provider 凭据。原逻辑只清理前两类。显式合成 key 与自定义 transport 继续有效。
- 新增 [`harness-offline.test.ts`](../../../apps/web/src/tests/harness-offline.test.ts) 三例：实际第一阶段默认拒绝且 model receipt 落为 failed；五类继承值清空、显式值保留；实际第一阶段经明确合成 SSE transport 返回 finish 且 usage 为 20/10。每例均在调用前拦截全局 fetch 的非 loopback 目标，即使跑旧实现也只计数并抛错，绝不访问外部服务。
- 修复前安全回归：3 tests，1 pass / 2 fail。默认拒绝 transport 调用为 0（要求 1），继承的 DeepSeek/Firecrawl/TikHub 合成凭据仍存在；显式合成 transport 正例通过。未打印旧 fallback 的精确拦截次数，因此不补造该数字。
- 修复后回归：默认拒绝调用恰好 1、全局外部 fetch 计数 0、一个已结算 failed model receipt；显式 synthetic transport 调用恰好 1、全局外部 fetch 计数 0、一个 completed model receipt。

新增两个 DSH 专项回归各有 30 秒状态等待与 40 秒测试上界，用于覆盖真实 worker 初始化；**既有恢复用例的 4000 ms 和计量用例的 10000 ms 未修改**。这不是放宽原失败断言。

## 定向验证

在 `apps/web` 执行：

```sh
node --import tsx --test --test-concurrency=1 \
  src/tests/harness-offline.test.ts \
  src/tests/first-step-recovery.test.ts \
  src/tests/first-step-search.test.ts \
  src/tests/first-step-ui.test.ts
```

结果：**30 tests / 30 pass / 0 fail / 0 skipped**，总计约 30.12 秒。原 recovery 用例整体约 4.22 秒（包含多个独立等待阶段），原 metering 用例约 0.91 秒。3 项新增 harness 回归单独计数，不改原 B 热点 suite 的 74 项。

随后 `npm run typecheck`（server/client/test 三份配置）退出 0，`git diff --check` 通过。修复文件 SHA-256：`harness.ts` = `c4b3f841a529c23df438362cf337be4bf0e38ea5d975d4664f60fc885f8f0938`；`harness-offline.test.ts` = `40395f85dabf121a5104a66dd7fe550c7e72b97f2aaa30794d1fb95d90e7b58e`。未更动的生产 guard 所在文件 hash 为 `4d63f06bc2f6cf11703909c0e3a7bdbf52a332f9a8c16c06c751ec350a2b6e01`。

全量测试仍由主任务集中重跑，不能把先前 1398 tests 中的 2 fail 当成通过。此前完整测试的外发次数 **未测量**；fake key 不能证明零请求。新回归和修复后的共享默认边界均有直接断言，其离线结论限定于已覆盖的路径和本次运行。

生产身份 guard 在本诊断中保持不变；没有执行回退 guard 的网络对照，也没有修改原失败测试来获得绿灯。
