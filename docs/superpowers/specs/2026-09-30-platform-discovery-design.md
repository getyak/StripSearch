# 全目录账号发现 · 首批设计规范

日期：2026-09-30。范围：GET-90、GET-91、GET-92、GET-63。

状态：用户于 2026-09-30 批准本规范及对应实施计划。本文约定分批交付行为；各任务的实际完成状态以实施计划和验收记录为准。

## 1. 用户目标与成功条件

从姓名、用户名或公开主页开始，以少量操作了解研究对象；每个账号线索能查看来源、缺口和真实处理状态，页面保持清晰、精美且方便核查。默认研究目的为“了解这个人”，具体用途渐进展开。邮箱沿用 GET-62 的本地解析和授权边界，真实邮箱匹配属于 GET-66。

本批先消除发现覆盖的盲区：冻结本轮平台目录，每个适用项都有队列记录；优先显示已有主页和已取得的候选，剩余长尾按预算继续。相同平台的同一账号归并，但保留各条来源和冲突。账号命中、身份支持、用户选择、读取权限、正文覆盖互不替代。

成功必须同时满足：目录来源可复核；全部适用项有状态；请求和候选正确去重；刷新后状态一致；API、Web 和 SQLite 使用同一份服务端投影。不得把无 adapter、失败或尚未执行展示为“没有账号”，不得用四个深读样本限制发现范围。

## 2. 选择的方案与任务边界

采用“共享目录 → 规则导入和路线规划 → 持久发现轮 → Web 展示”。相比先改全部视觉，它让界面有真实状态可展示；相比一次做完整 Search 自治系统，它保留较小、可独立验收的边界。

| Issue | 本批交付 | 独立完成条件 |
| --- | --- | --- |
| GET-90 | 版本化目录、逐能力状态、来源和费用依据、缺口投影 | 20 个 TikHub 平台、30 个替代平台及长尾版本信息全部登记，文档与运行支持分开 |
| GET-91 | Maigret / WhatsMyName 公共规则导入、合并、受控执行 | 实际导入数和排除原因可读；限流、缓存、超时、占位页有离线验收；命中仅产生候选 |
| GET-92 | 自链、用户名、平台搜索、官方搜索和允许的站点搜索路线 | 每个目录项有可执行路线或明确原因；相同底层请求归并；失败不是无匹配 |
| GET-63 | 接受统一输入，排队全目录，持久状态、候选归并、Web 展示 | GET-62 与前三项合并后，真实 Web/API/SQLite 联合验收通过 |

GET-90 可以先交付，GET-91/92 依赖它；GET-63 集成等待 GET-62 的已合并输入契约。保留四个 issue 的验收条件，不把合批等同同时关闭。父任务 GET-52–57 不因此直接完成。

本批不实现身份裁决 GET-64、范围确认 GET-93/65、自治 Search GET-94、Fetch 长研究、媒体读取、通用租约恢复或完整工作台 GET-84。保留现有 alpha 行为；新发现命中不调用 legacy 自动归属/深读阶段，不启动 Fetch。

## 3. 代码基线与模块边界

基线为 `00a1787`：Express、BetterAuth、SQLite、原生 TypeScript 客户端。复用现有结构，不换前端框架。

- `shared/research-case.ts` 的 `ResearchCase / AccountSelection / ScopeVersion` 是对象、账号和权限的唯一权威契约。
- `shared/research-completion.ts` 的目录快照是冻结范围的投影，不能由当前启用 adapter 反向缩小。
- GET-59 的 `research-tool-contracts.ts`、`research-tool-dispatch.ts` 提供验证网关；保持 Search 8 / Fetch 10、去重后 15 个工具。核验仍为 Fetch 阶段。
- `server/platforms/registry.ts` 与 `shared/platform-discovery.ts` 的旧规则保留兼容读取；`rulesForSubject()` 只选有 probe 的规则，不能再作为新发现轮的覆盖全集。
- 新增共享目录契约、服务端目录 loader、规则编译器、路线规划器、发现轮 store/runner 和客户端发现视图。数据库迁移、API 和 client 遵循现有项目命名。共享契约先落地，独立 renderer 后接入。

一份目录快照产生三个显式投影：旧 probe registry、GET-60 completion registry、GET-59 capability snapshot。不要再维护独立的前端平台列表。所有投影携带相同版本；目录哈希在持久发现轮和冻结记录中保存。

GET-62 合并后，以其服务端保存的解析角色、输入版本、owner 和 scopeVersion 为入口。仅研究者输入不能证明自然人归属。组织、出版账号或角色歧义保留输入阶段的状态；未解决歧义不调网络。不得绕过新 intake，从客户端自行解析字符串并创建权限。

## 4. 版本化目录与逐能力状态（GET-90）

目录快照含 schemaVersion、registryVersion、内容 SHA-256、生成时间、来源清单和 entries。来源记录公开原始 URL、上游 commit/版本、抓取日期、内容 hash、许可、导入器版本以及原始/载入/排除数量。来源更新是显式维护动作，生产任务与离线测试不自动拉取上游。

每个 entry 含稳定 platformId、名称、别名、实例限定方式、规范主页规则、支持的输入种类、适用性条件和 routes。七个能力必须逐项登记：发现、主页、列表、正文、媒体、评论、分页；评论另记本人回复/父链，分页另记游标、排序和日期范围的限制。

每项能力分别记录：

| 维度 | 值与语义 |
| --- | --- |
| 文档依据 | documented / not_documented / unknown；对应来源和端点，不外推完整历史 |
| 实现状态 | integrated / not_integrated / unsupported；指本项目当前 adapter |
| 访问条件 | public / credentials_required / authorization_required / inaccessible / unknown；缺 key 与端点失效区分 |
| 验证依据 | documented_only / offline_verified / live_verified；绑定具体 adapter/端点/日期/验收回执 |
| 费用 | provider、计价单位、币种、数值或 null、查询日期、来源、有效条件；unknown 不等于免费 |

“可用”仅由所需操作已有 adapter、当前凭据/授权满足和其验证策略共同派生。单次平台 200 不提升整个平台全部能力；旧 GitHub 研究 adapter 的验证也不自动覆盖新执行路径。费用来自真实请求回执，不能由模型或 UI 声称。

初始目录登记的 TikHub 20 项：抖音、TikTok、小红书、Lemon8、Bilibili、快手、皮皮虾、微博、微信公众号、微信视频号、今日头条、西瓜视频、Instagram、YouTube、X、Threads、Reddit、LinkedIn、Telegram、知乎。微信搜一搜是辅助路线，不再计作第 21 个内容平台。

替代平台 30 项：Facebook、Pinterest、Snapchat、Bluesky、Mastodon/Fediverse、GitHub、GitLab、Hacker News、Stack Overflow/Stack Exchange、Hugging Face、Medium、Substack、Twitch、Steam、Naver、VK、Spotify、SoundCloud、Kick、Rumble、Truth Social、Linktree、Quora、豆瓣、百度贴吧、即刻、小宇宙、WhatsApp、LINE、Discord。个人网站另作为原作/自链入口登记。平台数量与路线数量分别计数，不把同一平台的多个 provider 算成多个账号平台。

上述是文档核对的导入目标，不是 50 个平台已经可读。平台能力与价格依据使用公开端点目录、官方文档及项目原创摘要；不复制私有设计文档或供应商完整文档。Threads 无效游标、Telegram 频道与个人账号、出版账号与自然人等限制明确保留。缺少可信依据时记 unknown，不补造数值。

## 5. 公共长尾规则与执行（GET-91）

Maigret 与 WhatsMyName 是来源和规则，不是一个万能人物 API。导入固定版本的完整来源；按本项目可执行/许可/访问条件分类，每条未载入记录保留来源标识、hash 和排除原因。实际并集计数由 manifest 计算，禁止把默认 500 或宣传数量当本轮全量。

Maigret 上游为 MIT；WhatsMyName 数据集为 CC BY-SA 4.0。许可文本、归属和修改说明与数据一起保留；衍生数据放独立目录并标明相应许可，执行器代码不复制上游实现或人物正文。导入前核对固定版本的许可；不满足许可的来源显式阻断，不能静默以少量样例替代全量验收。

归一化按平台实例、账号类型和规范主页模板识别同一站点；不能仅按顶级域名或显示名合并。规则合并保留来源集合，检测条件冲突时保留两个规则、复用同一次响应，再独立判定。规则表达式是受限数据，不能 eval、运行任意代码或任意正则；不支持的模板/检测形式记录 unsupported。

执行器只访问通过校验的公共 HTTPS 目标：拒绝内网、回环、link-local、凭据 URL 和不允许的端口；首次连接及重定向/DNS 变化均受同一地址策略限制。新自链与用户 URL 同样受约束。不得从规则自动导入代理、绕过验证、私有域、登录 Cookie 或 CAPTCHA 自动解题；不支持路线给原因。

具备明确存在/不存在检测条件且响应匹配才判定候选/无匹配。登录页、验证码、通用占位页、软 404、无效 marker、重定向和未知响应为受限或 unknown；状态码 200 本身不证明账号存在。保留校验所需短摘要/locator 和时间，不保存第三方完整人物正文。

按 origin 限流，遵守 Retry-After；域名没有显式速率时保守串行，规则速率和服务端全局上限共同约束。请求有 timeout、响应字节上限及 AbortSignal。缓存按 owner/case、规范请求、规则版本和有效期隔离；成功/可靠无匹配允许复用，超时/未知不长期负缓存。缓存复用记录原始时间，不新增 provider 计费回执。

重启后已经结算的请求不再发送；执行结果未知的请求标 unknown，等待明确重试决策，不自动再付一次。显式重试产生新 attempt，历史不被覆盖。本批实现此发现轮的最小持久状态，不宣称 GET-79 的通用租约系统已完成。

## 6. 路线规划、请求和账号去重（GET-92）

对每个适用目录项按顺序规划：已有可追溯自链 → 输入用户名的公开检测 → 已实现的平台搜人/官方搜索 → 当前允许的 site 定向搜索。多条路线可互补；可靠自链提供候选后，其他路线按本轮明确预算继续，不能偷偷删目录项。没有路线时记录 no_adapter/unsupported 及原因。

搜人平台的数字 ID、用户名检测、账号主页读取是不同动作；不把数字 ID 填入通用用户名模板。搜索结果只作为发现线索，不能充当已读正文或完整帖子历史。只从页面实际输出的可定位链接抽取自链，普通提及和脚本文本不当互链；自链在本批仍只产生候选，归属裁决交 GET-64。

每条路线记录 operation、adapterId、endpoint、所需条件、判定策略、预算估计依据、不可执行原因。必须至少保留一个可执行计划或明确不支持原因；fallback 只选已实现且满足条件的 adapter。缺少 provider key 不改用未经许可的浏览器采集。

底层请求 key 由 owner/case、输入版本、registry hash、adapter/endpoint、规范 query/body 和有效分页范围组成；同一请求只执行一次，各条规则/路线引用同一回执。请求成功复用和未知请求重试是不同动作，不能依靠进程内 Set 宣称跨刷新幂等。

账号 key 优先用 `(platformId, instance, accountKind, nativeAccountId)`；没有 ID 用该平台明确大小写规则下的规范 profile URL，再其次用户名。去除 tracking 参数只遵循平台白名单，不删除身份定位参数。Mastodon/GitLab 等保留实例，publication/channel/organization 与 person 分开。不同平台或同平台不同账号不因相同名称合并；URL 与原生 ID 后续关联需要确定性依据。

归并 candidate 保留全部 origin、route、rule、请求回执、线索和冲突；身份 facet 保持 proposed，用户选择 unanswered、allowedScope none。原始 seed 的已选范围继承 GET-62，不被发现结果降级或新增归属证明。用户需要的信息是“在哪里找到、为何仍不确定”，不是伪造置信度百分比。

## 7. 持久发现轮与接口（GET-63）

服务端从当前 owner 的已解析输入创建 round，绑定 caseId、inputRevision、scopeVersion、personRevision、目录 snapshot/hash、预算和授权依据。在同一事务中为所有适用项写 plan 行；无 adapter 也有终止状态。非适用项保留理由，不进入请求队列。适用性由输入种类和访问政策决定，不由 adapter 是否存在决定。

新增发现轮、逐平台计划、逐路线 attempt/receipt、候选来源关系记录；复用 GET-58 account store 进行候选 pending 写入，不引入第二套账号权限。迁移为增量，旧 alpha 行和历史目录保留原版本与验证状态。GET-60 冻结范围保存同版目录的完整投影，新增候选不能改写旧冻结切片。

每个平台有状态和 detailCode 两层：

| 状态 | 含义 |
| --- | --- |
| queued / running | 计划已保存、尚未执行 / 执行中 |
| candidates | 已发现一个或多个候选；未证明归属 |
| checked_no_match | 所有计划内可执行路线完成，明确无匹配，且没有未知/未执行缺口 |
| inaccessible | 登录、权限、平台拦截或限流；detailCode 区分原因 |
| no_adapter | 目录存在，本项目尚无可执行 adapter |
| timeout / unknown | 请求超时 / 响应或执行结果不确定 |
| deferred | 预算、取消、等待条件或进程中断而未执行完 |
| not_applicable | 不适用，保留明确理由 |

候选和缺口同时存在时主状态为 candidates，并保留 partial 和所有未完成路线；不能因一条路线成功删除另一条失败。平台的 checked_no_match 仅限本轮明确计划与输入，不推断此人没有其他用户名的账号。发现轮 finished 表示调度停止，coverageComplete 独立判断；有缺口展示 partial，不能提升 GET-60 的研究完成结论。

接口接入 GET-62 合并后的 case API 前缀，提供创建、详情/增量、候选分页、取消及明确重试；路径和输入 ID 使用已合并命名。创建请求需幂等键，同 owner/同请求读回原 round；内容不同 409。用户/模型不得注入 owner、scope、预算、身份支持或能力快照。所有读取和写入 owner checked，状态返回 JSON 仅含公开输入或邮箱脱敏信息。

调度前和提交前重新检查 case 版本及取消状态。scope/input 变化使旧 attempt 不再写入新范围，晚到结果只进入旧回执/计费核对，不写当前候选。请求已发出但提交失败时保留真实 usage，不能记 zero。取消先 abort，再持久阻断写入。并发调度仅允许一个有效 round attempt，数据库条件更新阻止重复抢占；通用跨机器 lease 留待 GET-79。

GET-59 工具封套保持既有 schema：超时/未知以 failed/partial、gaps 和 stopReason 表达，no_adapter 映射 not_implemented/unsupported；不要把新内部状态硬塞入 strict enum。`discover_accounts` 单页最多 50 候选，可信游标绑定当前 owner/case/输入/目录版本；全部目录状态使用分页 HTTP 投影，不放入单个模型工具输出。capability 的 supported/unsupported/unverified 显式映射并保留 limitation。

GET-60 观测按其既有协议投影：排队项尚无观测；no_adapter 为 unsupported；超时/未知为 failed attempt 且 known_gap；取消为 cancelled/operator_stop；预算未执行为 deferred/budget_exhausted。candidates 只有计划内路线全部处理、没有剩余缺口时才提交 succeeded 且无阻断 stopReason；已有候选但仍有缺口时保留 result=candidates，同时携带对应 known_gap/budget_exhausted 等阻断原因。这样 UI 能展示已有候选，完成评估仍保留未解决义务，不靠一个成功候选消除发现缺口。

## 8. Web 与 Figma 交互

延续原稿深绿、暖白、克制排版及“覆盖与范围”入口。本批只改发现状态及其相关详情，不把完整报告/档案库/主页重设计混入目录开发。

提交后直达发现状态，显示已识别输入、当前活动、真实计数和当前目录版本。顶部文案示例：“已处理 12 个目录项 · 找到 3 个候选 · 8 个存在缺口”；数字来自服务端互斥主状态，候选账号数与候选平台数清楚区分。有限目录分母可用于目录处理计数，但不表示互联网账号完整率或身份置信度。无真实数据时展示 loading/unknown。

默认列表按“已有种子/已发现候选 → 正在处理 → 缺口 → 已处理无匹配”分区，组内稳定排序，避免每次更新跳动。默认保留当前阅读位置和展开详情；更新不抢焦点。筛选为全部、候选、处理中、缺口，带真实计数；长尾分页/渐进载入，避免数千条 DOM。

平台一行展示名称、状态、候选数及简短原因；点击行内“查看”展开依据/路线/时间/缺口，同页查看，不强迫往返。每个账号独立显示原始主页链接、发现方式、身份未确认提示；不要把多个账号合成一个确认按钮。重试仅在可执行、预算允许且无未知计费障碍时提供；否则给明确缺项。离线/未接入提供补充公开主页入口，沿用输入版本，不假称点击即可接通。

桌面详情用 inline disclosure 或侧面板；小屏改为单列与全宽详情。状态不能只靠颜色；链接/按钮可键盘触达，Escape 关闭 overlay、焦点返回触发按钮；动态播报只报阶段/重要计数变化，避免逐条刷屏。390px、键盘、浏览器缩放和刷新恢复均需真实验收。

Figma 仅使用 Figwright：先确认目标文件和插件连接，再用 get_design_context、变量/组件映射和截图获取真实数值；测量、字体、颜色、间距不从截图猜测。优化稿另建本批页面/复制相关 frame，保留原稿和可复核前后截图。未连接时不写 Figma，不伪报参数精确匹配；本文交互规则不依赖编造 px 数值。真正视觉实现前完成 Figwright grounding，复用现有 tokens/assets，再截图检查。

## 9. 验收与交付

测试全部离线，使用原创合成输入、transport mock 和临时 SQLite；不请求 example.org，不在默认测试/CI 使用 paid API 或下载规则。

1. 目录：独立 manifest 核对 20/30/网站入口、七项能力、来源/费用未知值、别名去重；缺 adapter 仍在 completion 投影；版本/hash 改动只影响新 round，旧 snapshot 不变。
2. 规则/路线：完整固定来源导入计数与排除原因；相同请求两种检测规则只一次 fetch；软 404、占位页、受限、429、超时、字节上限、取消；重定向/内网防护；规则注入拒绝；用户名大小写和实例差异不误并。
3. Store/runner：所有适用项落盘；同账号不同线索归并且出处保留；多账号不误并；owner 隔离、幂等、重复调度、旧 scope/input 晚到写入拒绝；刷新读回、重启未知不自动请求、请求费用未知不改免费；没有自动 identity/selection/Fetch 写入。
4. 联合 UI：真实 Express 路由 + SQLite + Web，注入本地合成 provider 结果；部分候选伴随缺口、无匹配、错误、无适配器、长列表、移动/键盘/焦点、取消和明确重试。运行 typecheck/build、受影响宿主测试和 `python3 scripts/check_design.py`，保留截图与检查输出。
5. 分 issue 独立审查与交付：Pi/MiMo 实现及局部验证后开启独立 sub-agent review；修复全部确认的 P0/P1 并复核。PR 关联四个 issue，最新 head 全部适用 CI/门禁通过后自动合并；读回合并状态、完成要求的合并后验证后才关闭验收已满足的 issue 并读回。

真实端点验证单列，不用离线 mock 提升 live_verified。启用需要真实必要凭据/参数或费用预算而缺失时，记录具体缺项、保持对应验收未完成；不以“已提交代码”关闭任务。本批不运行 iOS Simulator，不清理其他活动任务的测试产物。

## 10. 自审与可复核依据

本文已对照四个 Linear issue 的验收条件、仓库产品/路线图、GET-58/59/60 共享契约及可到达的 Figma 原型。交付顺序、状态映射、归属/选择分离、目录冻结、请求去重和 GET-62 集成门槛已明确。未核实的 provider 支持留在目录维度中，不当事实。

公开规则依据：[Maigret](https://github.com/soxoj/maigret)、[WhatsMyName](https://github.com/WebBreacher/WhatsMyName)。平台入口依据：[TikHub OpenAPI](https://api.tikhub.io/openapi.json)、[TikHub 端点价格元数据](https://api.tikhub.io/api/v1/tikhub/user/get_all_endpoints_info)、[GitHub REST](https://docs.github.com/en/rest)。公开页面是来源入口；实际导入需在实现维护步骤保存版本/hash，不把可变 main 当冻结版本。

规范与实施计划已获批准，按既定 Pi/MiMo 实现与独立审查流程推进。Figwright 目标文件连接、逐节点参数、优化 frame 与生产 UI 尚待后续验证，不计入 GET-90 的目录交付。
