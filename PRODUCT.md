# StripSearch

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

采访准备者、研究者与技术作品读者，带着姓名、公开主页和研究问题核对一个人的公开工作。依据现有产品文档与 GET-288 的明确任务，不增加新的受众假设。

## Product Purpose

沿出处阅读公开材料，分清身份归属、事实支持与分析，让判断可以核查、修订和撤回。

## Operating Context

Search 发现账号并确认范围；Fetch 在明确授权的范围内读取材料；报告、出处与导出共享 canonical 状态。GitHub 公开 Fetch 是已实现切片，其余平台能力、研究质量和部署状态分别验收。

## Capabilities and Constraints

- 现有实现是 Express、Better Auth、SQLite 与 TypeScript Web alpha；不替换认证、账号隔离、开放注册默认策略或已有 API。
- 自述、来源页面表述、原文支持的事实与推断分别标注。待核原文不能改称已核实结论。
- 暂停、恢复、停止、结果未知及费用未知必须保留真实状态；恢复未知请求仍要求显式选择。
- 来源撤回与证据失效依赖不变。格式和样式不能新增事实、改变引用或隐去反证。
- 离线验收仅使用原创合成数据，禁止外部研究请求和抓取 fixture URL；不代表真实人物质量已通过。

## Brand Commitments

沿用 StripSearch 名称、纸面与森林绿阅读基线、现有术语和本地字体。GET-288 只细化 Search/Fetch 结果及证据阅读，不改营销页。

## Evidence on Hand

现有契约见 [Web 设计](docs/web-design.md)、[连续研究体验](docs/research-experience.md)及 [GitHub Fetch](docs/fetch-integration.md)。合成报告与离线测试是程序和呈现证据，不构成用户偏好、竞品优势或研究质量结论。

## Product Principles

1. 判断旁就近给出出处，打开后能回到原句。
2. 先读材料，再按需查看运行与版本记录。
3. 不确定、反证与恢复条件在需要判断时可见。
4. 修订沿现有依赖传播，账号与数据边界保持完整。

## Accessibility & Inclusion

键盘可达、可见焦点、至少 44px 触控目标；窄屏、深色、减少动效及 200% 文字可用。状态不能只靠颜色表达。
