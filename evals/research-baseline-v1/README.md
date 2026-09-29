# Research baseline v1 · 离线控制器回放

`offline_controller_replay` 轨道：在隔离进程中用**生产 `runResearch` + `Store`**（同一 run 的检查点、回执、预算与 canonical 输出）回放严格的脚本化工具 / 规划 fixture，验证研究控制器的程序行为。与 [Runtime v1](../runtime-v1/README.md) 的 provider 契约回放（`offline_provider_contract`）分轨、互不替代：那条轨道测生产适配器，这条轨道测控制器状态机。

11 个原创合成案例（**ORIGINAL synthetic · unreviewed · 不是人工 gold · 不是研究质量 benchmark**）。期望是带哈希的版本化合成断言；改动期望需要新的 `dataset_version` 与新的证据快照，不宣称历史上先于断言冻结。格式与规则见 [CONTRACT.md](CONTRACT.md)。

| case | scenario | 验证的程序行为 |
|---|---|---|
| rb-001 | completed_profile_linked_evidence | 主页→关联证据→finish→verify 全支持 → completed |
| rb-002 | needs_input_one_unconfirmed_candidate | 只有一个未确认候选 → needs_input |
| rb-003 | invalid_citation_partial | 引用不在来源内 → invalid_evidence partial |
| rb-004 | verifier_rejection | 核验驳回一条断言 → limited_evidence partial |
| rb-005 | malformed_verifier_excerpt_fallback | 核验结果畸形 → 回退保留逐字摘录 |
| rb-006 | budget_partial_no_extra_request | 预算耗尽 partial，且不再发出额外请求 |
| rb-007 | tool_failure_failed_receipt_unknown_fee | 工具失败保留 failed 回执与未知费用 |
| rb-008 | unknown_inflight_recovery_no_refetch | 未知在途回执恢复时不重复抓取 |
| rb-009 | runner_error_retained | runner 错误（run_inactive）被保留 |
| rb-010 | post_runner_error_continuation | runner 错误之后的后续案例仍执行 |
| rb-011 | historical_inflight_model_receipt | 历史在途模型回执 ≠ 本次模型调用 |

```bash
npm --prefix apps/web run eval:research          # 默认离线跑冻结回放
npm --prefix apps/web run eval:research -- --dataset evals/research-baseline-v1/cases.jsonl \
  --output evals/research-baseline-v1/evidence   # 重新生成公开证据快照
```

默认输出到 `_private/evals/research-baseline/latest`；`evidence/` 是发布用合成证据快照（本地路径已脱敏，含精确运行命令、配置、源码清单哈希、锁文件哈希、数据集哈希、逐案 raw/serialized/artifact 哈希）。断言失败、fixture 违规、网络守卫违规或 worker 进程失败都会以非零退出。

## 记账规则（诚实性）

- `plannerDecisionCalls`（脚本决策）与 `modelInvocations`（本次执行的真实模型调用，恒为 0）分开；`modelReceipts` 单独保留同 run 账本历史。真实 token / 模型费用是 `not_measured`，不是 0。
- fixture 声明的 `estimatedUsd` 全部标记 `simulated`：只报已知小计，任一费用未知则完整合计为 `null`；实际支付费用为 `null`。
- 结构通过 / 失败与研究状态分布（completed / partial / needs_input / runner_error）分开；全部计划案例计入分母。
- 归一化只替换易变 ID / 时间戳 / 时长；依赖结构（如 `inheritedFrom.sourceKey`）保留。`manifest.json` 记录最终写盘字节哈希。

## 边界（不能证明什么）

- 网络守卫是**进程级 API 守卫**（fetch/http/https/net/tls + child_process/worker_threads），在生产代码导入前安装于隔离回放进程；**不自动提供 OS 级网络隔离**；如额外使用系统禁网配置验收，须单独保留该次执行记录。
- 只证明程序行为（状态、预算、回执、恢复、导出一致性）；语义蕴含、真实检索质量、身份精度与人工核查成本未评估。
- 2026-09-30 后的基线生成命令与环境记录在 `evidence/report.json` 的 `runCommands` / `source`；CI 结果以外部运行记录为准。
