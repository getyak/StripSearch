# Evaluation 数据集入口

人物深度研究的下一版准则见 [综合人物研究及评估](../docs/person-intent-evaluation.md)。工作台 10 个合成练习只用于练习标注；真实人物探索包保存在授权的本地研究目录，不包含在以下离线通过计数中。

| 数据 | 数量 | 当前用途 |
|---|---:|---|
| [Runtime v1](runtime-v1/README.md) | 40 案例 / 20 对照组 | 生产适配器冻结回放、存储与导出规则 |
| [Research baseline v1](research-baseline-v1/README.md) | 11 案例 / 11 场景 | 控制器离线回放（`offline_controller_replay`）；unreviewed 合成期望 |
| [Behavior v1](behavior-v1/README.md) | 8 案例 / 18 来源 | 待评审研究判断 rubric；尚未运行 |
| [FRAMES 子集](external/frames-v1/README.md) | 24 问题 | 固定版本外部 discovery；尚未运行 |
| 原有设计种子（本页以下） | 12 案例 / 12 来源 | 设计规格；尚未人工裁决 |

外部选型见 [目录](external/README.md)。默认执行 `npm --prefix apps/web run eval` 只跑 Runtime v1（provider 契约回放，`offline_provider_contract`）；`npm --prefix apps/web run eval:research` 只跑 Research baseline v1（控制器回放，`offline_controller_replay`）。两条轨道分开报告、互不替代；原有种子、Behavior 与 FRAMES 不计入通过率。

```bash
python3 scripts/check_eval_datasets.py
npm --prefix apps/web run eval
npm --prefix apps/web run eval -- --split regression --output _private/evals/regression
```

默认报告写入 `_private/evals/latest/report.md` 与 `report.json`。逐案保留期望、实际值、失败原因，汇总按 provider、split、tag 分组；源码 commit、dirty 状态和数据 SHA256 随报告保存。结构断言失败退出 1，非法数据或参数退出 2。来源正文、候选结果与运行数据库不进公开仓库。

`.github/workflows/web-evals.yml` 已配置推送 / PR 时执行 Web 测试、类型检查、构建、数据完整性与离线回放。只有 GitHub 对具体提交运行后，才有远端 CI 结果；本地通过不表示远端已经通过。

## 原有 Dataset card · v0.1-draft

12 个原创合成任务、12 份合成来源；中文；一个共享实体族；全部为 `synthetic / discovery / unreviewed`。来源为本项目设计阶段编写的虚构材料，不对应真实个人。按仓库 Apache-2.0 许可提供。

## 能验证什么

身份种子、同名歧义、公开笔名、转载去重、履历时效、冲突、自述、缺失、不可访问、文档注入、格式一致与范围拒绝。case 的 required/forbidden assertions 是待人工裁决的验收规格。

## 不能证明什么

没有真实搜索环境，没有 provider 覆盖统计，没有真实人物精度，也没有人工 gold。12 个 case 不是 12 个独立人物，不能用它们宣传总体可靠性。行为研究的 8 个扩展规格尚未加入这些 fixture。

## 使用约束

- 只从 `fixtures.json` 读取；`network_access=false`，不得访问合成 URL。
- 所有 `available_source_ids` 都应能解析；inaccessible 来源没有正文。
- 评估器必须保留每个失败，不只汇总成功输出。case 未执行不得标 pass。
- 当前期望由设计生成，review_status 保持 unreviewed；评审后另发布版本和变更理由。
- frozen-source 测试主要测抽取和核验；要评检索需补充查询→候选的回放环境。

扩展与 split 见[评估设计](../docs/evaluation.md)。公开真实材料前，逐条确认必要性与再分发许可，不以“在网上找得到”为准。
