# 发布说明草稿 — 2026-10-13

**状态：本轮尚未发布。** 历史范围 `82acaf3..0017e11`；完整、可再生的 commit 清单见 [changelog](changelog-draft.md)。此草稿只汇总仓库实现，实际运行版本、外部 provider 与人物研究质量须各自验收。

## 已合入 main 的历史变更

- **发现与选择**：第一阶段姓名/URL 发现、目录义务冻结、人物簇与账号卡、原文身份约束、一次原子范围确认、恢复草稿与历史；Search 模型决策和第三方/机构线索处理合入 `a0fd4c3`。`0017e11` 更新账号工作台及响应式呈现。现有材料约束不代表真人身份判断准确率已测量。
- **可恢复 Fetch**：`0ffddad` 持久处理覆盖；`6ef1ed5` 本地合成 Fetch 批次链；`9861130` 完整证据与不可变阶段计划恢复；`60f4014` 接入认证 Web GitHub 公开采集与显式未知结果调和。已完成本地调度计划不代表研究问题已回答。
- **证据与研究边界**：`f49788d` 原文 provenance、研究缺口和撤回；`72008c7` 新作业不设固定累计上限，旧账本规则保留；`a0fd4c3` 限定 scope/祖先授权重新核验及发布回滚安全。
- **认证与入口资源**：`adf7ab9` hosted 注册默认开放；限制注册须显式 allowlist。`ac0076c` 入口资源避免旧缓存；邮件找回/OAuth 仍需要独立配置与验收。
- **维护与共享边界**：`508bf95` 收敛请求/计量/链接/URL/行助手与 eval CLI，保留 serializer/hash/provider facade 的不同语义并更新依赖锁。

## 本轮冲刺候选（未合并）

1. 当前实现架构、风险地图及静态 import/size/churn inventory。
2. 身份与运行授权热点的新增边界测试；异常完成回执缺 URL 时拒绝升级为原文依据。
3. Fetch coverage projection 局部索引重构，附同语料输出等价与前后基准。
4. 原创合成 adversarial contract eval、严格 fixtures 与离线 runner。
5. 可复用 git changelog 生成脚本、验证摘要和持续 STATUS。
6. 共享测试入口在 bootstrap 前默认拒绝 provider 请求并清除五类继承凭据；假密钥不再被当作离线隔离。

具体测试计数、基准值、eval 结果与独立审查状态在完成集成后填入 [验证记录](verification.md)。这里不预填结果。

## 兼容性与发布边界

本轮不计划 SQL/schema、报告格式、身份升级、计费或 provider 协议变更；重构以已有输出与撤回规则为约束。发布前仍需当前提交 CI、独立审查及仓库门禁。升级本机服务须走[单实例发布管理器](../../local-service.md)，核对实际 health/revision/入口资源；Notion 记录必须来自实际读回。

未交付/未验收：全平台历史与评论覆盖、真人/模型研究质量对照、人工裁决 gold、GET-79 分布式租约、完整 Fetch 核验→补查→综合、CLI/MCP、本轮生产部署。Synthetic contract pass 只能支持本地确定性规则，不产生研究准确率或 provider 可用性结论。
