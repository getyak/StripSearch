# 版本化平台目录（GET-90）

状态：2026-09-30 已实施目录契约、初始数据与三个投影。本文描述已落地的数据与接口，不代表任何平台已 live 验证，也不启用或导入任何发现规则。

数据：[`apps/web/data/platforms/catalog.json`](../apps/web/data/platforms/catalog.json)（目录）与 [`manifest.json`](../apps/web/data/platforms/manifest.json)（独立核对清单）。代码：共享契约 [`platform-catalog.ts`](../apps/web/src/shared/platform-catalog.ts)、加载器与投影 [`catalog.ts`](../apps/web/src/server/platforms/catalog.ts)、维护生成器 [`generate-platform-catalog.mjs`](../apps/web/scripts/generate-platform-catalog.mjs)。测试全部离线：[`platform-catalog.test.ts`](../apps/web/src/tests/platform-catalog.test.ts)。

## 目录内容

一份快照（`PlatformCatalogSnapshot`）带 `schemaVersion`、`registryVersion`（`2026-09-30.1`）、内容 SHA-256（`contentHash`）、生成时间、来源清单与 entries。`manifest.json` 另记 `catalog.json` 的文件字节 hash，加载器两级都校验：内容被改动会以 `content_hash_mismatch` 或 `file_hash_mismatch` 拒绝加载，不会静默修复。

| 群组 | 数量 | 说明 |
| --- | --- | --- |
| TikHub 平台 | 20 | 抖音、TikTok、小红书、Lemon8、哔哩哔哩、快手、皮皮虾、微博、微信公众号、微信视频号、今日头条、西瓜视频、Instagram、YouTube、X、Threads、Reddit、LinkedIn、Telegram、知乎 |
| 替代平台 | 30 | Facebook、Pinterest、Snapchat、Bluesky、Mastodon/Fediverse、GitHub、GitLab、Hacker News、Stack Overflow/Stack Exchange、Hugging Face、Medium、Substack、Twitch、Steam、Naver、VK、Spotify、SoundCloud、Kick、Rumble、Truth Social、Linktree、Quora、豆瓣、百度贴吧、即刻、小宇宙、WhatsApp、LINE、Discord |
| 个人网站 | 1 | 作为原作/自链入口登记（`homepage_url` 输入），不与出版账号或自然人合并 |
| legacy_only | 3 | DEV Community、npm、PyPI：旧探测规则基线保留，防止 legacy 投影丢失规则；不在上表 50 平台清单内 |

平台数量与路线数量分开计数（当前 54 平台 / 91 路线 / 8 来源 / 378 条能力记录）；微信搜一搜只登记为微信条目上的辅助路线（`wechat_search`），不算第 21 个内容平台。

## 七项能力、四个独立维度、逐维证据

每条 entry 登记七项能力：发现、主页、列表、正文、媒体、评论、分页；评论另记本人回复/父链，分页另记游标、排序、日期范围限制。每项能力把四个维度分开记录，互不替代：文档依据（documented / not_documented / unknown）、实现状态（integrated / not_integrated / unsupported，指本项目当前 adapter）、访问条件（public / credentials_required / authorization_required / inaccessible / unknown，缺 key 与端点失效分开）、验证依据（documented_only / offline_verified / live_verified，live_verified 必须绑定验收回执，加载器拒绝无回执的 live_verified）。

**逐维证据规则（加载器强制）**：`documented` 只在该维度有具体端点事实（`endpoints`）或精确原始来源定位（`sourceLocator`，如 `tikhub-path-index:/api/v1/...`、`project-legacy-registry:github`）时成立；指向 provider/开发者首页的通用链接不构成任何能力维度的证据，此类维度一律 `unknown`。TikHub 端点事实来自已冻结的 V5.3.2 OpenAPI/path index（全部入选 method/path/requestBody 已逐条对账，见任务审计回执）：微信公众号/视频号与抖音 douplus 搜索为 POST + requestBody schema；Threads 的 `fetch_user_posts` 官方描述为无分页，`end_cursor` 无效（分页记录 `cursor: "invalid"` 并携带定位）；Telegram 登记路径均为频道端点，不含个人账号读取。

**逐操作描述（`operations`）**：每条能力携带逐操作描述（operationId、method、requestBody schema、端点、是否已接入、访问条件、费用、来源），混合来源维度（如 Reddit：匿名单页 listing + TikHub 游标 listing）不会被一条路线的条件抹平；聚合字段只从实际操作派生（有集成操作时取其条件，否则无单一口径则记 unknown），加载器校验一致性，API 原样保留。

**规范主页规则**（`profileUrlRule`）只记录有公开文档模式的显式规则（旧探测模板、GitHub REST `htmlUrl` 形式、Bluesky/Mastodon 文档模式）；未核对到模式的平台保持 `null`，绝不从主页合成 `/{username}` 猜测。

**实现状态只认真实路径**：存在性探测只算 discovery，不构成 profile 读取（npm/PyPI/devto 等同理）；profile 只有 GitHub 研究 adapter 与 TikHub X 工具两条具体路径（X 工具仅支持已知 handle 的资料/帖子读取，不支持人物搜索，搜索路线保持 not_integrated），list 另含既有帖子追踪读取器（devto/HN/Medium/Reddit）与 GitHub 研究 adapter（仅读取本人拥有的仓库、仅首页、有数量上限，均已记录）；分页只有 devto/HN 的页码翻页被读取器实际消费，Reddit 分页只属于 TikHub 游标路线（credentials_required + TikHub 价格依据），不跨路线照搬官方 after/before 语义。所有新路径的验证依据保持 `documented_only`，旧 GitHub 规则的 `live_verified` 标签不被新能力继承。

**读线程（read_thread）是独立能力**：评论列表的回执/父链文档/分页/任意文本都不能验证线程读取器或深度；读线程有自己的 integration/access/verification 三维与独立结构化验收回执（绑定 `read_thread` 操作、adapter、端点、日期、回执 id 与已验证深度上限）。只有“已接入线程能力 + 自身 live 验证回执 + 满足访问条件”才映射 GET-59 `supported`，且 `maxDepth` 不得超出回执验证的上限（加载器拒绝无回执 live 声明、无验证的深度与不匹配的上限）；无 adapter → `unsupported`，仅文档/离线/不完备证明 → `unverified`，缺凭据 → `unsupported`。当前目录全部线程记录 `not_integrated` / 未 live，投影一律 `unsupported` 且 `maxDepth: null`。

**访问与费用属于具体操作/路线**：同一平台不同维度可以不同（Reddit 的匿名单页 listing 维度是 `public`，TikHub 游标分页是 `credentials_required` + TikHub 价格依据）；没有已建立操作的维度记 `unknown` + 显式依据。所有价格都是显式 `null` + 公开依据（TikHub 公开价格目录按端点列 `endpoint_cost`，未标币种/计量单位，未选定端点；目录响应的 request_id/time 不是费用回执）；**null 不等于免费**。

## 来源清单（元数据冻结，未导入）

| 来源 | 版本/哈希 | 许可 | 状态 |
| --- | --- | --- | --- |
| Maigret | commit `b6642744988e…`，sha256 `3ac973e4…`，抓取 2026-09-30T05:30:59Z | MIT（LICENSE hash `9748c279…`） | `metadata_only_not_imported` |
| WhatsMyName | commit `062bcfe48df7…`，sha256 `507d2f8a…`，抓取 2026-09-30T05:31:03Z | CC BY-SA 4.0（LICENSE hash `3eab49aa…`） | `metadata_only_not_imported` |
| TikHub OpenAPI | V5.3.2，sha256 `b97eb0f6…`，抓取 2026-09-30T05:29:49Z | — | `frozen`（仅元数据） |
| TikHub 价格元数据 | sha256 `859e6687…`，抓取 2026-09-30T05:29:52Z | — | `frozen`（仅元数据） |

两个公共长尾来源只冻结元数据（版本/hash/抓取/许可），**没有导入、没有启用任何规则**；`counts.raw/loaded/excluded` 保持 `null`，来源数据集的站点记录数（Maigret 6206、WhatsMyName 717）只是来源记录数，不是导入数。规则编译、完整导入与排除计数属 GET-91；导入时保留 MIT / CC BY-SA 4.0 归属与修改说明。来源字节不入库，本仓库不复制第三方文档或数据全文。

## 三个投影（同版携带）

1. **旧 probe registry**（`toLegacyRegistry`）：13 条旧规则的 probe / posts / 限速 / 验证标签逐字保留（含 GitHub 的 `live_verified` 标签与 x/Instagram/哔哩哔哩的 `probe: null`），与 `BUILTIN_PLATFORM_REGISTRY` 逐条 deep-equal 由测试锁定；作为探测引擎的默认注册表。
2. **GET-60 完成注册表**（`toCompletionRegistry`）：适用性只由输入种类、实例提示与授权策略决定，不由 adapter 是否存在决定——无 adapter 平台仍在冻结分母里并带确定性理由；无 adapter ≠ not_applicable。
3. **GET-59 能力快照**（`toCapabilitySnapshot`）：每平台映射 7 个 GET-59 操作（`discover_accounts` / `read_profile` / `list_posts` / `read_post` / `read_media` / `list_comments` / `read_thread`），`read_thread` 使用独立线程能力、访问条件与绑定回执（不借用评论列表证据），`list_*` 携带分页的排序/日期限制。状态映射是精确的：
   - `unsupported`：平台不提供该能力、项目无 adapter（GET-59 `not_implemented`）、不可访问、或当前缺凭据/授权；
   - `unverified`：访问条件 unknown，或 `documented_only` / `offline_verified`——**凭据不能把 documented_only 提升为 supported**；
   - `supported`：仅当能力是绑定回执的 `live_verified` 且访问条件当前满足。本目录当前没有任何 `supported` 项。

## 加载、打包与运行

`loadPlatformCatalog(dataDir)` 校验文件 hash、内容 hash、重复 ID、冲突别名（别名不得与任何 platformId 或其他别名重复）、来源引用与完整形状（七维度齐全、枚举合法、价格 null/正数、documented 必有逐维证据、路由非空且带理由）。快照深冻结并深拷贝：后续改动输入不会改变已冻结快照；版本/hash 变化只影响新 round，旧 snapshot 不变。

生产数据路径是模块相对且显式的：编译产物读 `<dist>/data/platforms`（`npm run build:data` 只把 `data/platforms` 复制进 `dist/data/platforms`，先用 lstat 拒绝源码子树与生成目录祖先中的符号链接/非普通条目（拒绝时源/旁路/旧产物一律不动），再把生成的公共命名空间 `dist`、`dist/data`、bundle 目录归一化为 755/644，保证非属主可读；`data/` 同时是本地 SQLite/用户研究存储位置，**绝不整体复制**，打包回归用合成 canary 验证旁路数据不进 dist、源目录权限不变）；源码运行读 `apps/web/data/platforms`。不做祖先目录回退：production bundle 缺失时即使源码目录存在也确定性抛 `data_not_found`（编译产物回归覆盖两种情况）。因此编译产物在任意 cwd（含 Docker runtime，经现有 dist 复制打包）都读自带数据，不依赖仓库目录。测试注入构造器/加载结果，全部离线。

`GET /api/discovery/registry` 在保留原有 `registry` / `summary` 字段与行为的前提下，附加 `catalog`：版本、hash、汇总、来源清单（版本/hash/许可/状态等公开溯源）、逐平台能力（含 docUrls、endpoints、sourceLocator、sourceRefs、verificationRef、评论/分页详情、费用依据与条件）、路线与缺口。缺口显式列出：无 adapter 能力、未 live 验证能力、费用未知（null ≠ 免费）、访问受限能力。不注入目录时响应保持旧形状；不暴露任何凭据或 owner 访问上下文。

## 未做与边界

- 没有任何真实端点请求、live 验证或费用回执；文档核对不提升验证等级，通用文档链接不构成能力证据。
- 路线是登记（operation、adapterId、端点、所需条件、不可执行原因），GET-92 才做规划与受控执行；站点定向搜索、自链抽取、微信搜一搜均未接入。
- Telegram 频道/个人账号、Threads 无效游标、出版账号与自然人的边界在条目 notes 与 accountKinds 中保留；缺失可信依据一律记 unknown，不补造数值。
