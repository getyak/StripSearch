# 版本化平台目录（GET-90）

状态：2026-09-30 已实施目录契约、初始数据与三个投影（GET-90），并由 GET-91 导入公共规则并集组成组合快照。本文描述已落地的数据与接口；**不代表任何平台已 live 验证**。原始 curated 目录（`catalog.json`）本身不内嵌发现规则——规则在独立的 `data/platforms/public-rules/` 归一化包（GET-91 已按固定字节全量导入，见 [`public-account-rules.md`](public-account-rules.md)），加载器按需组合。

数据：[`apps/web/data/platforms/catalog.json`](../apps/web/data/platforms/catalog.json)（目录）与 [`manifest.json`](../apps/web/data/platforms/manifest.json)（独立核对清单）。代码：共享契约 [`platform-catalog.ts`](../apps/web/src/shared/platform-catalog.ts)、加载器与投影 [`catalog.ts`](../apps/web/src/server/platforms/catalog.ts)、维护生成器 [`generate-platform-catalog.mjs`](../apps/web/scripts/generate-platform-catalog.mjs)。测试全部离线：[`platform-catalog.test.ts`](../apps/web/src/tests/platform-catalog.test.ts)。

## 目录内容

一份快照（`PlatformCatalogSnapshot`）带 `schemaVersion`、`registryVersion`、内容 SHA-256（`contentHash`）、生成时间、来源清单、entries 与 `mode`。`manifest.json` 另记 `catalog.json` 的文件字节 hash 并声明 `requiresPublicRuleBundle`，加载器两级都校验：内容被改动会以 `content_hash_mismatch` 或 `file_hash_mismatch` 拒绝加载，不会静默修复。

身份分两层（GET-91）：curated 目录保持 `2026-09-30.1` / 原 `contentHash`；携带公共规则包的**组合快照**（`mode: 'public_rule_union'`）另有确定性全量身份 `registryVersion = 2026-09-30.1+pr.<hash12>`、`contentHash = sha256(curated hash + curated 版本 + 规则包 manifest hash + 计数)`，不同规则包/排除/许可 artifact 绝不共用身份（旧 cursor 因此失效）。curated-only 夹具必须显式声明 `requiresPublicRuleBundle: false`（`mode: 'curated_only'`，身份即原 hash）；生产数据缺必需规则包确定性失败，不回退。

| 群组 | 数量 | 说明 |
| --- | --- | --- |
| TikHub 平台 | 20 | 抖音、TikTok、小红书、Lemon8、哔哩哔哩、快手、皮皮虾、微博、微信公众号、微信视频号、今日头条、西瓜视频、Instagram、YouTube、X、Threads、Reddit、LinkedIn、Telegram、知乎 |
| 替代平台 | 30 | Facebook、Pinterest、Snapchat、Bluesky、Mastodon/Fediverse、GitHub、GitLab、Hacker News、Stack Overflow/Stack Exchange、Hugging Face、Medium、Substack、Twitch、Steam、Naver、VK、Spotify、SoundCloud、Kick、Rumble、Truth Social、Linktree、Quora、豆瓣、百度贴吧、即刻、小宇宙、WhatsApp、LINE、Discord |
| 个人网站 | 1 | 作为原作/自链入口登记（`homepage_url` 输入），不与出版账号或自然人合并 |
| legacy_only | 3 | DEV Community、npm、PyPI：旧探测规则基线保留，防止 legacy 投影丢失规则；不在上表 50 平台清单内 |

平台数量与路线数量分开计数。**原始 curated 目录（GET-90 冻结）**：54 平台 / 91 路线 / 8 来源 / 378 条能力记录；**权威组合快照（GET-91，含公共规则并集）**：4421 entries（54 curated + 4367 生成）/ 4502 路线 / 30947 条能力记录，逐维证据全部 documented_only、价格 null（null ≠ 免费）。微信搜一搜只登记为微信条目上的辅助路线（`wechat_search`），不算第 21 个内容平台。

## 七项能力、四个独立维度、逐维证据

每条 entry 登记七项能力：发现、主页、列表、正文、媒体、评论、分页；评论另记本人回复/父链，分页另记游标、排序、日期范围限制。每项能力把四个维度分开记录，互不替代：文档依据（documented / not_documented / unknown）、实现状态（integrated / not_integrated / unsupported，指本项目当前 adapter）、访问条件（public / credentials_required / authorization_required / inaccessible / unknown，缺 key 与端点失效分开）、验证依据（documented_only / offline_verified / live_verified，live_verified 必须绑定验收回执，加载器拒绝无回执的 live_verified）。

**逐维证据规则（加载器强制）**：`documented` 只在该维度有具体端点事实（`endpoints`）或精确原始来源定位（`sourceLocator`，如 `tikhub-path-index:/api/v1/...`、`project-legacy-registry:github`）时成立；指向 provider/开发者首页的通用链接不构成任何能力维度的证据，此类维度一律 `unknown`。TikHub 端点事实来自已冻结的 V5.3.2 OpenAPI/path index（全部入选 method/path/requestBody 已逐条对账，见任务审计回执）：微信公众号/视频号与抖音 douplus 搜索为 POST + requestBody schema；Threads 的 `fetch_user_posts` 官方描述为无分页，`end_cursor` 无效（分页记录 `cursor: "invalid"` 并携带定位）；Telegram 登记路径均为频道端点，不含个人账号读取。

**逐操作描述（`operations`）**：每条能力携带逐操作描述（operationId、method、requestBody schema、端点、是否已接入、访问条件、费用、来源），混合来源维度（如 Reddit：匿名单页 listing + TikHub 游标 listing）不会被一条路线的条件抹平；聚合字段只从实际操作派生（有集成操作时取其条件，否则无单一口径则记 unknown），加载器校验一致性，API 原样保留。

**规范主页规则**（`profileUrlRule`）只记录有公开文档模式的显式规则（旧探测模板、GitHub REST `htmlUrl` 形式、Bluesky/Mastodon 文档模式）；未核对到模式的平台保持 `null`，绝不从主页合成 `/{username}` 猜测。

**实现状态只认真实路径**：存在性探测只算 discovery，不构成 profile 读取（npm/PyPI/devto 等同理）；profile 只有 GitHub 研究 adapter 与 TikHub X 工具两条具体路径（X 工具仅支持已知 handle 的资料/帖子读取，不支持人物搜索，搜索路线保持 not_integrated），list 另含既有帖子追踪读取器（devto/HN/Medium/Reddit）与 GitHub 研究 adapter（仅读取本人拥有的仓库、仅首页、有数量上限，均已记录）；分页只有 devto/HN 的页码翻页被读取器实际消费，Reddit 分页只属于 TikHub 游标路线（credentials_required + TikHub 价格依据），不跨路线照搬官方 after/before 语义。所有新路径的验证依据保持 `documented_only`，旧 GitHub 规则的 `live_verified` 标签不被新能力继承。

**读线程（read_thread）是独立能力**：评论列表的回执/父链文档/分页/任意文本都不能验证线程读取器或深度；读线程有自己的 integration/access/verification 三维与独立结构化验收回执（绑定 `read_thread` 操作、adapter、端点、日期、回执 id 与已验证深度上限）。只有“已接入线程能力 + 自身 live 验证回执 + 满足访问条件”才映射 GET-59 `supported`，且 `maxDepth` 不得超出回执验证的上限（加载器拒绝无回执 live 声明、无验证的深度与不匹配的上限）；无 adapter → `unsupported`，仅文档/离线/不完备证明 → `unverified`，缺凭据 → `unsupported`。当前目录全部线程记录 `not_integrated` / 未 live，投影一律 `unsupported` 且 `maxDepth: null`。

**访问与费用属于具体操作/路线**：同一平台不同维度可以不同（Reddit 的匿名单页 listing 维度是 `public`，TikHub 游标分页是 `credentials_required` + TikHub 价格依据）；没有已建立操作的维度记 `unknown` + 显式依据。所有价格都是显式 `null` + 公开依据（TikHub 公开价格目录按端点列 `endpoint_cost`，未标币种/计量单位，未选定端点；目录响应的 request_id/time 不是费用回执）；**null 不等于免费**。

## 来源清单（GET-90 冻结元数据表，GET-91 已验证全量导入见下）

| 来源 | 版本/哈希 | 许可 | 状态 |
| --- | --- | --- | --- |
| Maigret | commit `b6642744988e…`，sha256 `3ac973e4…`，抓取 2026-09-30T05:30:59Z | MIT（LICENSE hash `9748c279…`） | `metadata_only_not_imported` |
| WhatsMyName | commit `062bcfe48df7…`，sha256 `507d2f8a…`，抓取 2026-09-30T05:31:03Z | CC BY-SA 4.0（LICENSE hash `3eab49aa…`） | `metadata_only_not_imported` |
| TikHub OpenAPI | V5.3.2，sha256 `b97eb0f6…`，抓取 2026-09-30T05:29:49Z | — | `frozen`（仅元数据） |
| TikHub 价格元数据 | sha256 `859e6687…`，抓取 2026-09-30T05:29:52Z | — | `frozen`（仅元数据） |

两个公共长尾来源已在 GET-91 以固定字节完整导入（Maigret 6206 = 3952 + 2254、WhatsMyName 717 = 651 + 66，逐行载入/排除回执见 [`public-account-rules.md`](public-account-rules.md) 与 `data/platforms/public-rules/`）；`catalog.json` 内的来源记录仍保留 GET-90 冻结的元数据事实（`counts` 为 null、`metadata_only_not_imported`），组合快照把验证过的导入计数/版本合入 sources（`imported_pinned_bytes`，不重复 sourceId）。来源字节不入库，本仓库只提交归一化规则、排除回执（rowId/hash/reason）、归属/许可/修改说明与 manifest，不复制第三方全文。衍生数据集许可（MIT / CC BY-SA 4.0）与代码许可分开，见 `data/platforms/public-rules/LICENSE-DATASETS.md`。

## 三个投影（同版携带）

1. **旧 probe registry**（`toLegacyRegistry`）：13 条旧规则的 probe / posts / 限速 / 验证标签逐字保留（含 GitHub 的 `live_verified` 标签与 x/Instagram/哔哩哔哩的 `probe: null`），与 `BUILTIN_PLATFORM_REGISTRY` 逐条 deep-equal 由测试锁定；作为探测引擎的默认注册表。
2. **GET-60 完成注册表**（`toCompletionRegistry`）：适用性只由输入种类、实例提示与授权策略决定，不由 adapter 是否存在决定——无 adapter 平台仍在冻结分母里并带确定性理由；无 adapter ≠ not_applicable。`name_query` 轮保留全部公共账号义务：无 name 处理器/缺实例提示是显式缺口（理由中点名），不缩小分母；语义见 [`discovery-route-planning.md`](discovery-route-planning.md) 的共享契约。
3. **GET-59 能力快照**（`toCapabilitySnapshot`）：每平台映射 7 个 GET-59 操作（`discover_accounts` / `read_profile` / `list_posts` / `read_post` / `read_media` / `list_comments` / `read_thread`），`read_thread` 使用独立线程能力、访问条件与绑定回执（不借用评论列表证据），`list_*` 携带分页的排序/日期限制。状态映射是精确的：
   - `unsupported`：平台不提供该能力、项目无 adapter（GET-59 `not_implemented`）、不可访问、或当前缺凭据/授权；
   - `unverified`：访问条件 unknown，或 `documented_only` / `offline_verified`——**凭据不能把 documented_only 提升为 supported**；
   - `supported`：仅当能力是绑定回执的 `live_verified` 且访问条件当前满足。本目录当前没有任何 `supported` 项。

## 加载、打包与运行

`loadPlatformCatalog(dataDir)` 校验文件 hash、内容 hash、重复 ID、冲突别名（别名不得与任何 platformId 或其他别名重复）、来源引用与完整形状（七维度齐全、枚举合法、价格 null/正数、documented 必有逐维证据、路由非空且带理由）；携带 `public-rules/` 时还严格校验规则包（每文件 hash/大小、逐来源 LICENSE/NOTICE 必需且 licenseHash 与字节一致、检测谓词/标记/布尔/速率/头/规则引用全形状、空正向标记或缺 bounded 标志即拒）。快照深冻结并深拷贝：后续改动输入不会改变已冻结快照；版本/hash 变化只影响新 round，旧 snapshot 不变。

生产数据路径是模块相对且显式的：编译产物读 `<dist>/data/platforms`（`npm run build:data` 只把 `data/platforms`（含 `public-rules/` 子树）复制进 `dist/data/platforms`，先用 lstat 拒绝源码子树与生成目录祖先中的符号链接/非普通条目，缺失必需文件（目录/manifest/规则/回执/许可/声明）拒绝打包，复制前还逐文件核对规则包归一化 hash（拒绝时源/旁路/旧产物一律不动），再把生成的公共命名空间归一化为 755/644；`data/` 同时是本地 SQLite/用户研究存储位置，**绝不整体复制**）；源码运行读 `apps/web/data/platforms`。不做祖先目录回退：production bundle 缺失时即使源码目录存在也确定性抛 `data_not_found` / `public_rules_missing`。编译产物在任意 cwd 都读自带数据；独立回归用拷贝到仓库外的 production build 加载规则包并验 hash。

`GET /api/discovery/registry` 在保留原有 `registry` / `summary` 字段与行为的前提下，附加 `catalog`：版本、hash、汇总、来源清单（版本/hash/许可/状态等公开溯源）、**有界平台详情分页**（默认/最大 100）、显式 `platformsTotal` 与 `platformsNextCursor`（服务端 HMAC 绑定全组合身份+offset 的游标：篡改 → `invalid_cursor`，跨注册表/规则包身份 → `stale_cursor`，数组/对象/空/非十进制/超长 query 一律 400）、逐平台能力（含 docUrls、endpoints、sourceLocator、sourceRefs、ruleIds、verificationRef、评论/分页详情、费用依据与条件）、路线与缺口（随分页，不藏全局大数组）。第一页计数永不冒充全量覆盖；不注入目录时响应保持旧形状；不暴露任何凭据或 owner 访问上下文。

## 未做与边界

- 没有任何真实端点请求、live 验证或费用回执；文档核对不提升验证等级，通用文档链接不构成能力证据。公共规则条目的能力全部 documented_only + 未接线（独立受限执行器离线可用但未进 legacy/model 运行时），没有 GET-59 `supported`。
- 路线是登记（operation、adapterId、端点、所需条件、不可执行原因）；GET-92 已实现**纯**规划、请求键与账号键（见 [`discovery-route-planning.md`](discovery-route-planning.md)），受控执行与运行时接线属 GET-63；站点定向搜索、自链抽取、微信搜一搜均未接入。公共规则路线带 ruleIds（逐路线 sourceRefs 只列本请求规则的来源），执行语义与边界见 [`public-account-rules.md`](public-account-rules.md)。
- Telegram 频道/个人账号、Threads 无效游标、出版账号与自然人的边界在条目 notes 与 accountKinds 中保留；缺失可信依据一律记 unknown，不补造数值。
