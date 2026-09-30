# 开发 brief / 路线

目标：交付一个能核验身份、沿证据研究公开职业活动，并通过 Agent / MCP 返回可修订报告的本地工具。

## M0 · 设计基线（本次交付）

产品、研究方法、架构、接口、工具取舍、evaluation、合成样例与工作模板。公开材料不含真实个人档案。当前静态检查仅验证设计文件一致性。独立 Web alpha 的运行范围与验收见 [Web 运行时契约](web-runtime.md)，不视为后续里程碑整体完成。

2026-09-26 Web 增量已实现有预算的 DSH 研究循环、Exa/TikHub/Firecrawl 工具、Person Object 与 HTML/PDF 导出；范围和验证边界见[实现说明](person-research-release.md)。这不替代下述 30 页面试验、人工裁决、CLI/MCP 或质量对照验收。

## M1 · 最小可审计闭环

初始化前置调研与探针见 [实施方案](initialization-research.md) 和 [验证记录](initialization-validation.md)。探针不代表 M1 已完成；生产 schema、研究语义闭环与人工裁决仍按以下验收推进。

输入一个合成人物种子与问题 → 固定语料读取 → 身份归属 → 原子断言 → 引用核验 → 同一份 JSON / Markdown。先实现确定性状态、证据引用、版本与存储，再接模型生成。

**验收：** 同名案例不混人；不明确的身份进入 needs_input；换格式不新增事实；自述不升级为独立事实；撤销材料归属后，旧报告失效；所有人工裁决过的回放案例可重现。尚未裁决的案例不能算通过 benchmark。

## M2 · 两个真实适配器

接入 Exa 与 TikHub；先做 30 页面契约试验，再用许可明确的公开职业材料跑小规模研究。基础读取不足才加 Firecrawl。逐端点记录可用性、分页、限制和实际费用。

2026-09-27 增补：[平台发现、身份一次性校正与帖子深度追踪](design/platform-discovery-2026-09-27/README.md) 已在 `apps/web` 落地（探测引擎 + maigret / holehe 报告导入 + 检查点续跑 + 帖子追踪，离线验证）；除 GitHub 外平台规则未 live 验证、效果未评测，不计入里程碑验收，其验收门槛见该提案的 [REVIEW](design/platform-discovery-2026-09-27/REVIEW.md) 与 [EVAL](design/platform-discovery-2026-09-27/EVAL.md)。

**验收：** 原 URL 与定位保真；失败可见；预算耗尽正确 partial；网络重试不静默重复扣费；依赖未报告费用时不假装保证硬费用上限。

## M3 · Agent / MCP 与本地档案

同一 core 接 CLI 和 stdio MCP；提供已验证的安装方式、七个工具、异步作业/恢复/取消、资源分页。加入显式本地导入、外发控制和权限继承。

**验收：** 选定两个 MCP 宿主完成 tools/list、启动、needs_input/resume、查询、取消、证据读取；重启可恢复；未授权 collection 不可访问；public 导出不带私有事实或本地路径。此时才能在 README 标为可运行 alpha。

## M4 · 对照实验与发布判断

扩展标注数据集，完成普通研究 prompt / 通用研究工具 / StripSearch 的配对评估与用户任务。公开所有配置、失败计数、成本、切片和材料许可说明。

**验收：** 没有已知严重错人或伪证失败被掩盖；在相同预算下，覆盖不明显下降，人工核查成本有可复现改善。若证据不足或收益消失，调整定位，不用长报告与演示视频代替结果。

## 下一阶段 Agent 设计

[2026-09-29 设计稿](superpowers/specs/2026-09-29-person-research-agent-design.md)（2026-09-30 修订）是未实施提案：Search / Fetch 两个角色 + 持久程序控制器；发现覆盖首次冻结的 PlatformRegistry（TikHub 多平台目录、替代工具与公开长尾规则只是文档/目录目标），X / Reddit / GitHub / 个人网站为首批深读验证样本；默认枚举约定可访问历史并分批处理每个可读正文，每帖一页首层评论；预算分总额与分批两级。8 分钟 / 80 次请求 / 固定 2 并发是2026-09-29 设计试验配置（非当前运行默认值），不是新设计的产品上限；当前 Web alpha 行为不变。它把后续工作拆成：统一约定与基线、身份发现与确认、平台深读、可靠运行、可修订报告、效果验证。先更新共享契约，再逐批实施；具体任务和依赖在 Linear 维护，长期原则在 Notion 保存，仓库保留版本化规范。此拆分不改变 M1–M4 的验收标准，也不表示这些里程碑已完成。

2026-09-30：[Reddit 两条接入路线核对](platforms/reddit-routes.md)记录文档能力、费用口径与独立验收缺项；未启用新适配器，未完成 live 验证。

## 第一批可领取工作

| 工作 | 交付物 | Definition of done |
|---|---|---|
| 定稿身份与报告契约 | 类型/schema + 边界示例 | 同名、无主页、错误撤回、权限过滤均能表达 |
| 建立离线回放 | fixture reader + 结果比较器 | 禁网；保留失败；不把 specification 当人工 gold |
| 实现作业与证据存储 | SQLite migration + core | 幂等冲突、恢复、取消、版本失效可验证 |
| 验证 provider | 适配器 + 30 页面试验记录 | 失败/费用/分页/链接完整记录，不宣布未经测量的覆盖 |
| 验证宿主接入 | stdio server + 集成记录 | tools/list schema 与行为一致；两个宿主通过完整流程 |

不预设截止日期和负责人。优先完成第一个能失败、能核查、能修正的小闭环。

2026-09-30：[研究案例领域契约（GET-58）](research-case-domain.md) 已落地：`ResearchCase / AccountSelection / ScopeVersion / SourceRevision / EvidenceRef / ItemCoverage` 共享契约、原子范围快照与增量 SQLite 案例持久化。它是后续任务的地基，未启用 Search / Fetch 运行时。

2026-09-30：[研究范围与完成契约（GET-60）](research-completion-domain.md) 已落地：研究前冻结范围/完成规则（问题适用性、全目录发现、时间窗、正文/媒体/默认评论页/选定分支深度）、最小观测回执协议与追加式确定性评估；分母未知不显示假百分比。它仍是持久化政策地基，不是 GET94/95/99 自治运行时。

2026-09-30：[Search / Fetch 工具接口契约（GET-59）](research-tool-contracts.md) 已落地：Search 8 / Fetch 10 去重后 15 个工具的可执行注册表、`dispatch(trustedContext, modelCall, ports, signal)` 验证网关、统一返回封套、逐底层请求计量端口与 pending-only 提交端口；核验是 Fetch 阶段（仅 3 件工具）而非第三角色。它是离线接口契约地基，不代表 Search / Fetch 上线，旧 alpha 工具面保持不变。

## 已采纳的设计基线

| 决定 | 理由 | 什么会使它改变 |
|---|---|---|
| canonical JSON + 确定性呈现 | 格式切换不改变事实 | 出现必须独立交互的消费者，仍不能另造事实 |
| 单机 SQLite / 文件优先 | MVP 可观察、易回放 | 真实跨用户并发与迁移需求 |
| 接入器可替换 | 检索性能与端点会变化 | 基准显示另一组合有稳定独立增益 |
| 身份与事实分别核验 | 找对人不代表说法为真 | 不取消，仅优化成本 |
| 开源引擎、用户自带服务 | 避免把商业 API 当开源能力 | 托管需求与成本得到验证后另立方案 |

设计变化使用 [decision 模板](../templates/decision.md)，质量/成本变化使用 [experiment 模板](../templates/experiment.md)。Notion 仅保存摘要与决定，仓库是版本化规范的唯一来源。
