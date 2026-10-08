# Search / Fetch 批次执行边界

本地接口 `runResearchRuntimeBatch` 将可信 task/context、模型 gateway 和 GET-59 工具 gateway 组合成有限步骤的批次。Search 只能选择八个工具，Fetch 只能选择十个工具；Fetch verify 阶段只允许 `read_evidence`、`load_skill`、`save_findings`。

模型只返回严格校验的一个工具调用或 yield。每次模型调用前、返回后、工具调用后都重新读取权威 owner/case/scope/accounts/capabilities/skill pins/media 权限。作用域变化、取消、非法决策及未结算动作停止本批次；yield 和批次额度耗尽均不证明研究完成。

`maxStepsPerBatch` 是可继续运行的批次调度单位，未设置累计研究上限。事件记录工具回执和模型 usage；未知 token/费用保留 null。注入的模型 gateway 负责 reserve/execute/settle。DSH adapter 保持现有单决策调用协议，接收计量过的 invoke；本接口未提供新的持久预算账本。

当前边界经过合成离线测试，尚未提供持久任务调度、真实平台适配、自动研究质量结论或部署。GET-95 处理回执及 GET-60 完成判定是独立的存储和策略组件。

验证：`apps/web/src/tests/research-runtime.test.ts` 覆盖跨批次继续执行、verify 权限、异步作用域变化、权限注入、取消、未结算动作和单次 DSH usage。

本地合成 Fetch 链复用本批次边界与 GET-59 网关，提供单进程持久 checkpoint/intent；真实调度与模型策略质量仍未验收，见 [本地 Fetch 批次链](fetch-pipeline.md)。真实 GitHub 切片的阶段 2 也复用本边界：其调度器是确定性本地调度器，**外部模型请求/令牌为诚实零**，绝不把本地调度决策呈现为真实 LLM 使用，见 [Web Fetch 真实 GitHub 接入](fetch-integration.md)。
