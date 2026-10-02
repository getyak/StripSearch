# 有界研究回放 v2

从 v1 原始合成材料派生，原 v1 数据与历史证据保持不变。期望于本次深度契约变更后冻结，仍为 unreviewed，不是人工 gold。沿用 [回放实施契约](../research-baseline-v1/CONTRACT.md) 的 schema、网络守卫、账本与哈希规则。

v2 改变：rb-001/010 的两页工作材料不足以完成五类综合研究，改为 partial；rb-006 工具预算耗尽后保留最终综合/核验；rb-007 某分支失败后仍可综合已读材料。原来源和费用断言未放宽。所有 11 个案例仍进入分母。

运行：`npm --prefix apps/web run eval:research -- --dataset evals/research-baseline-v2/cases.jsonl --output _private/evals/research-baseline-v2/latest`。此命令无外部请求、无模型调用，不证明真人研究质量。
