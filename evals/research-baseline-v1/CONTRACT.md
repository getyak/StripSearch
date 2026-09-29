# Research baseline v1 · 实施契约

目标：用生产 `runResearch` + `Store` 在隔离进程中回放冻结脚本，检查研究控制器的程序契约。此轨道衡量程序行为，不冒充真实检索、语义蕴含或人物事实准确率。与 Runtime v1（provider 契约回放）分轨。数据为原创合成、`unreviewed`；期望是带哈希的版本化合成断言，改动期望必须提升 `dataset_version` 并重建证据，不宣称历史上先于断言冻结。

## 数据格式

`cases.jsonl` 每行一个对象；未知字段与非法类型拒绝，不静默忽略：

```json
{
  "case_id": "rb-001",
  "dataset_version": "research-baseline-v1",
  "title": "…", "scenario": "completed_profile_linked_evidence",
  "split": "regression", "review_status": "unreviewed", "provenance": "original-synthetic",
  "tags": ["completed"],
  "input": {"question": "…", "seedUrl": "https://…"},
  "limits": {"toolCalls": 2},
  "pre_state": {"inflightReceipts": [{"key": "model:0", "kind": "model", "request": {}}], "cancelRequested": true},
  "tools": [{"action": {"type": "read", "url": "https://…"}, "result": {"pages": [{"url": "…", "title": "…", "text": "…", "kind": "profile", "publishedAt": null, "links": [], "limitations": []}], "requests": 1, "bytes": 1, "estimatedUsd": 0.0004, "credits": null, "limitations": []}}],
  "planner": [{"mode": "plan", "decision": {"action": "finish", "claims": [], "unknowns": []}, "expectClaims": 2}],
  "expect": {"state": "completed", "stopReason": "research_complete", "identityStatus": "resolved",
    "toolCalls": 1, "plannerCalls": 1, "modelCalls": 0,
    "receipts": {"total": 1, "completed": 1, "failed": 0, "inflight": 0},
    "unknownCost": false, "claimsRetained": 1, "candidates": 0,
    "includeText": ["…"], "excludeText": ["…"], "claimKinds": [{"contains": "…", "kind": "page_statement"}],
    "runnerError": "ResearchStop", "runnerErrorIncludes": ["run_inactive"]}
}
```

- `tools` 是**严格有序**脚本：每次实际调用必须精确匹配下一个 `action`（类型 + 输入，键序无关）；多调、错配都会被拒绝并记录为 fixture 违规；`result` / `error` 二选一（`error.kind=provider|error`）。`networkAttempt` 是仅测试用的越网注入：由守卫拦截，命中即硬失败。
- `planner` 是**严格有序**脚本：必须匹配 `mode`（plan/verify）与可选 `expectClaims`。脚本决策从不调用模型 `invoke`。
- `pre_state.inflightReceipts` 用真实 `ResearchStore.reserve` 写入同一 run 的账本（历史恢复证据）；`cancelRequested` 制造 runner 级 `run_inactive` 错误。
- `limits` 合并在真实 `RESEARCH_LIMITS` 之上；逐案生效值记录在报告 `actual.effectiveLimits`。
- `expect.modelCalls` 是**本次执行的真实模型调用**（恒 0）；账本 `modelReceipts` 另计。`includeText`/`excludeText` 对整个 canonical 输出（Markdown 或 canonical JSON）匹配；纯渲染转义不算缺失，排除项两边都必须缺席。
- `case_id` 字母数字开头；`tags` 不重复；全数据集 `modelCalls` 必须为 0（脚本决策不调用模型）。

## 执行与评分

`npm --prefix apps/web run eval:research`（`--dataset` / `--output` 可选）：

1. **引导**：先把 worker 及其导入的生产模块用 `tsc` 预编译到临时目录（记录每个执行字节的 SHA256），守卫进程内**没有转译器**，`network-guard.mjs` 在任何生产导入前禁用 fetch / WebSocket / http / https / net / tls / child_process / worker_threads，越界尝试抛错并追加到独立违规日志（控制器吞掉异常也藏不住）；日志不可写时立即失败，内存中存在违规也使进程非零退出。
2. **回放**：worker 用真实 `runResearch` + `Store`（同一 run）逐案执行；`case-start` / `case-done` 增量落 JSONL，进程崩溃保留已完成前例。不使用 `persistResult`（它写的是另一个 run）。
3. **评分**：结构断言 = expect 字段 + fixture 全消费 + 无网络违规 + 无意外执行错误；研究状态分布单独统计。计划（scheduled）案例无论 finished / unfinished / not_run 都留在分母。

退出码：0 全过；1 任何断言 / fixture / 网络守卫 / worker 进程失败（含 worker 退出码非零或被信号杀死）；2 数据集或用法无效。内部一致性问题写入 `report.run.failures` 而不是丢弃报告。

## 哈希

- `hashes.normalizedResult`：显式归一化易变字段后的确定性哈希。归一化仅限 `runId/run_id/parentRunId/retryOf/ownerId`、时间戳键、时长键（清单见报告 `normalization`）；`inheritedFrom` 保留 `sourceKey` 与 null/存在差异，仅其 runId 归一化。回执按 `kind`+`key` 稳定排序后再哈希（同毫秒回执顺序不影响哈希），原始账本顺序保留在 raw 产物。
- `hashes.serialized`：各原始子对象（result/checkpoint/receipts/canonical/markdown）稳定序列化字节的 SHA256，是序列化哈希而非文件哈希。
- `hashes.artifact` / `manifest.json`：最终写盘字节（已脱敏、含结尾换行）的 SHA256；manifest 不含自身。测试会重算真实文件哈希对账。

## 费用与用量记账

- `plannerDecisionCalls` 与 `modelInvocations` 分开；`modelReceipts` 保留账本历史（含历史在途回执）。真实 token / 模型费用 `not_measured`，实际支付费用 `null`。
- fixture `estimatedUsd` 一律 `simulated`：报告 `knownSimulatedSubtotal` 只含已知项，任一费用未知则 `simulatedTotal` 为 `null`，不做误导性合计。
- 中断且没有完整用量记录的案例计入 `unknownUsageCases`，`simulatedTotal=null`，观测调用与回执计数标记 `lower_bound`；未启动案例不制造未知用量。

## 网络守卫边界

进程级 API 守卫，**不是 OS 级网络隔离**；不覆盖原生插件、dgram、dns 或调试器注入。测试用异步探针以仅 loopback 的正常连接校验父进程监听器，再用端口与标记文件证明被拒路径没有触达底层连接器（TCP 连接数 0、无逃逸标记文件）。

## 测试钩子（仅测试用，不可由数据集触发）

- `STRIPSEARCH_WORKER_FAULT_EXIT=<n>`：全部案例完成后以 n 退出（验证「记录完整但进程失败」仍非零退出）。
- `STRIPSEARCH_WORKER_FAULT_CRASH_AT=<caseId>`：该案例 `case-start` 后 SIGKILL（验证中途崩溃保留前例、unfinished/not_run 分类与分母完整）。

评估器自身的测试见 `apps/web/src/tests/research-baseline.test.ts`。不得为让成绩好看放宽已有期望或改写既有 runtime-v1 fixture。
