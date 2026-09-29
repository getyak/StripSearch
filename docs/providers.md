# 工具选型与生态调研

调研截面：2026-09-20。以下是官方资料与部分代码的静态评估；没有调用付费采集 API，也没有同条件性能榜单。

## 首选组合：先验证 Exa + TikHub，按需 Firecrawl

| 层 | 候选 | 在本项目中的职责 | 不负责什么 |
|---|---|---|---|
| 发现 | [Exa MCP](https://exa.ai/docs/get-started/exa-mcp) | 跨站搜索、基础页面读取；其 Agent 可作为完整系统对照 | 不将相关性分数当身份概率 |
| 平台读取 | [TikHub MCP](https://mcp.tikhub.io/) | 已确认公开账号的资料、作品、相关公开评论及分页 | 不保证归属、真实性或全量历史 |
| 正文补全 | [Firecrawl MCP](https://docs.firecrawl.dev/mcp-server/tools) | 已知公开 URL 的正文读取和结构化提取，必要时站点发现 | 不对每条已取得正文的结果重复付费 |
| 搜索替换 | [Tavily MCP](https://docs.tavily.com/documentation/mcp) | Exa 的同题同预算替代试验 | 未证实独立增量前不默认双搜索器 |
| 原始作品 | 官方项目站、GitHub PR / issue / release、出版/论文原页 | 验证具体贡献、交付与时间 | 不把组织职务等同个人成果 |

选择 Exa 是能力匹配假设，**没有证据表明它在本项目中文任务上优于 Tavily**。最小原型可以只开两个服务；以正文缺失率和可测增量决定第三个是否值得。连接器开源也不意味着服务本身可免费自建。

## TikHub 是否足够

[小红书官方产品页](https://tikhub.io/xiaohongshu-api)列出资料、笔记、搜索与评论等读取能力，并推荐 App V2，部分旧版本已弃用。它适合补足社交平台内容，但研究所需的身份判断、独立证实、冲突、时间和解释仍需自己实现。

实施时逐端点验证 canonical URL、正文/评论完整性、分页顺序、父评论、限制与错误。API 成功不能自动记为完整覆盖，临时 `cache_url` 不能作为永久证据链接。费用按[具体端点与请求](https://tikhub.io/pricing)核算；不能用一个请求的价格推算完整人物报告。

官方支持按平台接入 MCP；只启用与任务有关的少量工具。当前环境此前对 `/health`、`/platforms` 的无认证请求返回 403，因此认证可用性仍未验证，不能据此断言服务停机。

Firecrawl 当前文档将旧 Extract 工具标为 deprecated；结构化读取优先核对 Scrape 的 JSON 能力。所有工具名与 schema 均以实施时锁定版本的 `tools/list` 和契约试验为准，不复制过时教程。

## 用户提供的三个项目

| 项目 | 实际定位与值得参考的部分 | 对 StripSearch 的判断 |
|---|---|---|
| [rjn32s/osint-mcp](https://github.com/rjn32s/osint-mcp) | MIT；多个传统 OSINT 工具与配置/安装包装 | 参考适配组织方式，不整体引入；默认 bootstrap 与输入 schema 需真实验证 |
| [frishtik/osint-tools-mcp-server](https://github.com/frishtik/osint-tools-mcp-server) | MIT；七类 CLI 工具封装 | 不是人物证据工作流；需要另做持久作业、总超时、取消和统一结果 |
| [soxoj/awesome-osint-mcp-servers](https://github.com/soxoj/awesome-osint-mcp-servers) | MIT；分类索引 | 用于发现组件，不是可运行系统，也不是质量背书 |

第一项静态审查版本 [`dbf9ca6`](https://github.com/rjn32s/osint-mcp/tree/dbf9ca6d430428869b0d92bc1c275b38026a3354)：具名声明包含管理工具，[registry](https://github.com/rjn32s/osint-mcp/blob/dbf9ca6d430428869b0d92bc1c275b38026a3354/src/osint_mcp/tools/registry.py#L48) 的通用 handler 注册方式需要验证生成的参数 schema；未运行，不宣称必然失效。

第二项静态审查版本 [`6a64661`](https://github.com/frishtik/osint-tools-mcp-server/tree/6a6466105c00ea39e754e9a556c5ce4d1f9da943)：[子进程包装](https://github.com/frishtik/osint-tools-mcp-server/blob/6a6466105c00ea39e754e9a556c5ce4d1f9da943/src/osint_tools_mcp_server.py#L16)未见整体 supervisor 超时；底层个别工具 timeout 不能替代作业级控制。上述项目的账号枚举、泄露/位置与主动扫描能力不属于本项目接入范围。

## 相近项目说明了什么

- [GPT Researcher](https://github.com/assafelovic/gpt-researcher)、[Local Deep Research](https://github.com/LearningCircuit/local-deep-research)：通用研究闭环已经丰富，是基线或可复用组件的候选；人物归属和行为证据必须单独评估。
- [Verified Person Research](https://github.com/liewcf/verified-person-research)：更接近公开经历、转折与观点的研究方法；作者的小样本示例不是独立效果验证。
- [PeopleHub 展示](https://github.com/smallnest/langgraphgo-showcases/tree/main/pepolehub)：展示人物检索编排思路；存在示例不代表已解决长期证据与身份撤回。
- [open_deep_research](https://github.com/langchain-ai/open_deep_research)：可参考架构，调研时仓库已归档；不把它默认当作持续维护底座。

**判断：市场不缺搜索包装器；身份、证据和修订是否有可测收益，才决定项目是否值得继续。** 未运行基线前，不宣称 StripSearch 更准确。

## 账号枚举 CLI：holehe / maigret 如何接入

调研截面：2026-09-27。设计与实现见[平台发现提案](design/platform-discovery-2026-09-27/README.md)。

| 项目 | 职责 | 许可 | 接入姿势 |
|---|---|---|---|
| [holehe](https://github.com/megadose/holehe) | 邮箱 → 注册过的网站（密码重置探测，声称 120+ 站） | GPL-3.0 | 只导入其模块 JSON 输出；不 vendor 代码、不实现原生密码重置探测；恢复邮箱/电话字段解析即丢弃 |
| [maigret](https://github.com/soxoj/maigret) | 用户名 → 全平台候选账号（约 3000+ 站，数字各来源不一致） | MIT | 导入 `--json simple/ndjson` 报告（格式按源码核实）；`Claimed/Available/Unknown/Illegal` 诚实映射，`is_similar` 丢弃 |

**判断：** 两工具输出都是候选发现，不是身份结论（maigret 报告模板自带误报警告）。StripSearch 自带受约束的原生探测引擎（固定注册表端点、限速限体、blocked/not_found 分离）补覆盖面，外部报告保持 `live_unverified` 与收据；用户名一致永不自动确认身份。发现质量、归属精度与合规均未实测（[评测设计](design/platform-discovery-2026-09-27/EVAL.md)）。

## 适配器的统一返回

每次调用至少给出 provider 与版本、query/URL、状态、canonical URL、正文/结构化内容、获取时间、下一页游标、排序、已读范围、限制、请求 ID 与费用。status 区分 success / empty / inaccessible / rate_limited / timeout / error。

30 页面试验建议分为：10 个普通网页、10 个公开社交内容页、10 个分页或失败场景。固定题目与预算，记录原链接保真、实际正文覆盖、重复率、恢复行为、延迟和费用；对失败保留原始错误类别。测试材料许可与再分发另行审查。没有真实账号/费用授权前，只运行离线 mock，不假装已经接通。
