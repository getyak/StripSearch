# 研究来源与事实边界

核对日期：2026-09-29。只读官方资料及部分公开源码；没有运行外部 Agent benchmark、账号探测或付费采集。以下为简要原创归纳，未收录第三方全文。

## Agent 框架

| 来源 | 本轮核对内容 | 设计使用与边界 |
| --- | --- | --- |
| [Pi agent-core README](https://github.com/earendil-works/pi/blob/1d74741e1777f7cc147d65bdfbcd08bb752972cd/packages/agent/README.md) | AgentMessage 到模型消息的转换、上下文处理、事件、工具钩子 | 借鉴边界；不据此承诺迁移后更快或更准确 |
| [Pi agent-loop 源码](https://github.com/earendil-works/pi/blob/1d74741e1777f7cc147d65bdfbcd08bb752972cd/packages/agent/src/agent-loop.ts) | 阅读入口与事件流、继续运行的消息边界 | 静态代码阅读，未启动该运行时 |
| [Pi skills 文档](https://github.com/earendil-works/pi/blob/1d74741e1777f7cc147d65bdfbcd08bb752972cd/packages/coding-agent/docs/skills.md) | 名称/描述目录与按需读取 SKILL.md | 借鉴延迟加载；强制义务另由控制器保证 |
| [DSH skills 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/docs/subsystems/skills.md) | provider registry、目录、模型 skill 工具、调用政策 | 最新上游能力，不等同当前锁定 SDK 已完成集成 |
| [DSH workflow 文档](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/workflow/workflow/README.md) | 子 Agent 编排、取消、无重启 journaling/resume、无全局 token-budget 词汇 | 持久状态与全局账本由领域控制器承担 |
| [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | 稳定前缀、外部记忆、保留失败与目标提示 | 借鉴公开工程经验；没有检查 Manus 内部代码，不复制其原文与具体收益数字 |
| [Manus Wide Research](https://manus.im/blog/introducing-wide-research) | 独立任务的通用子 Agent 并行 | 仅借鉴分解原则；本方案实例数按账号/时间窗设界并用方法专门化，效果待验证 |

Pi 原地址 `badlogic/pi-mono` 在本次访问重定向到 `earendil-works/pi`。上述 Pi SHA 的提交时间为 2026-09-29，DSH SHA 为 2026-09-28；当前 StripSearch 锁定 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2`，不可直接混用最新 API。

## 发现、帖子与评论

| 来源 | 可以支持的事实 | 不能据此承诺 |
| --- | --- | --- |
| [Sherlock 官方仓库](https://github.com/sherlock-project/sherlock) | 按用户名发现社交账号 | 同用户名属于同人、所有平台稳定可查 |
| [WhatsMyName 官方仓库](https://github.com/WebBreacher/WhatsMyName) | 公共用户名发现规则的目录来源（纳入设计；本轮未逐条验证） | 规则命中不证明身份；不代表本站可用或已授权 |
| [Maigret 官方仓库](https://github.com/soxoj/maigret) | 用户名发现与资料解析工具 | 输出档案的身份正确性；本方案不执行无边界递归 |
| [Gravatar Profiles](https://docs.gravatar.com/sdk/profiles/) | 邮箱 SHA256/slug 查询公开 profile；主邮箱匹配有限制 | 任意邮箱都命中、哈希匿名、跨平台事实为真 |
| [Gravatar verified accounts](https://support.gravatar.com/your-profile/verified-accounts/) | 服务通过账号登录关联的语义 | 当前所有目标平台均支持、关联永久有效 |
| [TikHub X 产品页](https://tikhub.io/twitter-api) | 用户、帖子、回复、搜索与评论类端点目录 | 历史全量、严格 top 顺序、任意深度回复树 |
| [TikHub 官方 Go SDK 的 X 接口说明](https://github.com/TikHub/TikHub-API-GoLang-SDK/blob/main/docs/TwitterWebAPIApi.md) | 评论、最新评论、帖子、本人回复及游标参数 | 未实测的响应完整性；main 文档会变化，实施应锁版本 |
| [Reddit Data API 文档](https://www.reddit.com/dev/api/) | 账号资料、submitted/comments、listing 游标、评论与 morechildren | 账号本机已获准调用、无限历史、删除内容可恢复 |
| [Reddit MoreChildren 类型](https://developers.reddit.com/docs/api/redditapi/interfaces/MoreChildrenRequest) | children、linkId、depth、sort 等结构词汇 | Devvit API 与外部 Data API 的权限和参数完全相同 |
| [Reddit 数据访问说明](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data) | 平台提供不同开发者与研究数据路线 | 本产品已获批或可以用搜索工具绕开限制 |
| [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms) | 使用与商业接入存在条件，需按获准用途接入 | 本轮法律审查或供应商授权已完成 |
| [GitHub REST 文档](https://docs.github.com/en/rest) | 用户、PR、issue、review、release 等官方数据入口 | 仓库归属等于个人贡献 |

没有用供应商营销价格估算整份报告；本轮没有实测可用性、费用、身份准确率或时延。新设计的 PlatformRegistry 把 TikHub 多平台 API 目录（2026-09-29 列出 20 个平台）、官方 API 与其他服务、Maigret / WhatsMyName 适用公共站点规则的并集登记为文档/目录目标；文档核对均不代表逐端点验证过的运行时支持。

## 本地代码依据

- `apps/web/src/server/research/controller.ts`：身份入口、单步决策、finish/verify、最多 12 claims。
- `apps/web/src/server/research/dsh-decision.ts`：只允许 submit_decision、一次模型请求、隔离 profile。
- `apps/web/src/server/research/toolkit.ts`：六类现有动作、X 单页与本人作者筛选。
- `apps/web/src/server/research/research-store.ts`：预算与动作预留/回执。
- `apps/web/src/server/store.ts`：当前 Person Object 构建、来源继承与撤回。

本地现状、新设计决策和外部项目事实在主设计稿与网页中分别标注。
