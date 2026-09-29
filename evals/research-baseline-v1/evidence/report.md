# Research baseline v1 · 离线控制器回放

> offline controller replay (production runResearch + Store with injected scripted fixtures)

- 报告类型：`offline_controller_replay`（与 runtime-v1 的 provider 契约回放 `offline_provider_contract` 分轨，互不替代）
- 数据集：`evals/research-baseline-v1/cases.jsonl`（计划 11 案例，SHA256 `c97c7da377c876a5…`）
- 数据来源：ORIGINAL synthetic 案例，全部 `unreviewed`，不是人工 gold，也不是研究质量 benchmark；期望是带哈希的版本化合成断言，不宣称历史上先于断言冻结
- 源码版本：commit `498c5b70330cde2bb9fe176bd9ab42f02fd95aff` · Node v22.23.2 · lockfile SHA256 `1292536f72542c35…`
- 源码清单聚合哈希：`06bfb806f0c972e5…` · 配置哈希：`118f573717f5033f…` · 执行字节聚合哈希：`8cedd3066bf3d2e8…`
- 引导方式：tsc-precompiled worker (no transpiler in the guarded process); executed bytes hashed below
- 网络边界：process-level network/subprocess API guard in the isolated replay worker; NOT OS network isolation and not claimed as such

## 结构结果（与研究状态分布分开）

- 计划 / 启动 / 完成 / 未完成 / 未运行：11 / 11 / 11 / 0 / 0
- 全部计划案例计入分母；结构通过 / 失败：11 / 0
- 通过率：1.000（分母 11）
- 硬失败：0 · fixture 违规：0 · 网络 / 子进程越界尝试：0 · 记录的执行错误：2

## 研究状态分布（描述性，不是分数）

- completed: 2
- partial: 7
- needs_input: 1
- runner_error: 1

## 调用与费用记账

- 观测调用与回执计数：`exact`；用量记录缺失案例：0（未启动案例不计入未知用量）。以下计数来自完整的执行记录。
- 脚本化规划决策（plannerDecisionCalls）：16
- 实际模型调用（modelInvocations）：0；同一次运行账本中的模型回执（modelReceipts）：1（可含历史恢复证据，不是本次调用）
- 模型 token / 费用：`not_measured` / `not_measured`；实际支付费用：`null`
- fixture 工具调用：14（注入的 `scripted-research-tools-v1`）
- fixture 声明费用（measurement=`simulated`）：已知小计 0.0048000000000000004；完整模拟合计 null（费用或用量未知，或无可合计记录）；含未知费用的案例 4

## 逐案结构断言

| case | scenario | 进度 | 期望状态 | 实际状态 | 结构 | 失败原因 |
|---|---|---|---|---|---|---|
| rb-001 | completed_profile_linked_evidence | finished | completed | completed | pass | — |
| rb-002 | needs_input_one_unconfirmed_candidate | finished | needs_input | needs_input | pass | — |
| rb-003 | invalid_citation_partial | finished | partial | partial | pass | — |
| rb-004 | verifier_rejection | finished | partial | partial | pass | — |
| rb-005 | malformed_verifier_excerpt_fallback | finished | partial | partial | pass | — |
| rb-006 | budget_partial_no_extra_request | finished | partial | partial | pass | — |
| rb-007 | tool_failure_failed_receipt_unknown_fee | finished | partial | partial | pass | — |
| rb-008 | unknown_inflight_recovery_no_refetch | finished | partial | partial | pass | — |
| rb-009 | runner_error_retained | finished | runner_error | runner_error | pass | — |
| rb-010 | post_runner_error_continuation | finished | completed | completed | pass | — |
| rb-011 | historical_inflight_model_receipt | finished | partial | partial | pass | — |

## 哈希与可重现性

- 每案记录 normalized result hash（显式归一化 ID / 时间戳 / 时长字段，回执按 kind+key 稳定排序后哈希）；`serialized` 是各原始子对象稳定序列化的哈希；`artifact` 是最终写盘字节的哈希，`manifest.json` 汇总全部产物文件哈希。
- 归一化字段：ids=runId, run_id, parentRunId, retryOf, ownerId；timestamps=startedAt, createdAt, updatedAt, settledAt, retrievedAt, finishedAt, generatedAt, asOf；durations=elapsedMs, durationMs, monotonicElapsedMs。依赖结构（如 inheritedFrom.sourceKey 与 null/存在差异）不参与归一化。

## 未评估

- semantic_entailment: citations are structurally checked only; no human judged whether quotes support statements
- research_quality: coverage, identity precision and recall, and human verification cost are not evaluated
- model_usage: the scripted planner never invokes a model, so real token counts and model cost are not_measured, not zero
- provider_costs: fixture estimatedUsd values are simulated; unknown fees stay unknown and the simulatedTotal stays null when any fee is unknown
- os_network_isolation: the replay runs under a process-level network API guard, not under an OS network sandbox
- freeze_chronology: dataset expectations are versioned synthetic assertions with recorded hashes; no historical pre-registration is claimed

## 运行命令

- `npm --prefix apps/web ci --prefer-offline --no-audit --no-fund`
- `npm --prefix apps/web run typecheck`
- `node --import ./apps/web/node_modules/tsx/dist/loader.mjs --test apps/web/src/tests/research-baseline.test.ts`
- `npm --prefix apps/web run eval:research`
- `npm --prefix apps/web run eval:research -- --dataset evals/research-baseline-v1/cases.jsonl --output evals/research-baseline-v1/evidence`
