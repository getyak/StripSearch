# 公共账号规则（GET-91）

状态：2026-09-30 已实施（Task 2 导入/目录 + Task 3 独立受限执行器）并已交付：PR21 合并为 `27f1075`（8 项 exact-head CI 通过；合并后 build、目录测试 181 pass / 1 环境门控 skip、来源审计 4 项、design 检查及 main CI 通过）；不代表任何站点 live 验证。所有测试离线（合成输入、fake DNS/transport），无启动/CI 下载，无付费请求。

数据：[`apps/web/data/platforms/public-rules/`](../apps/web/data/platforms/public-rules/)（归一化规则、排除回执、逐来源归属/许可/修改说明、manifest）。代码：共享契约 [`public-discovery-rules.ts`](../apps/web/src/shared/public-discovery-rules.ts)、编译器/加载器 [`public-rules.ts`](../apps/web/src/server/platforms/public-rules.ts)、维护导入 CLI [`import-public-rules.ts`](../apps/web/scripts/import-public-rules.ts)、目标策略 [`request-policy.ts`](../apps/web/src/server/discovery/request-policy.ts)、固定地址传输 [`pinned-transport.ts`](../apps/web/src/server/discovery/pinned-transport.ts)、评估/执行 [`rule-executor.ts`](../apps/web/src/server/discovery/rule-executor.ts)。

## 固定来源与全量导入计数

来源字节只在父任务的本地缓存中（不入 Git；raw 数据集不复制），导入是显式维护动作：`node --import tsx scripts/import-public-rules.ts --maigret-data <本地文件> ... --out data/platforms/public-rules`。字节 hash、commit、抓取时间、许可 hash 全部按固定 manifest 核对后才编译。

| 来源 | 固定版本 | 许可 | raw = loaded + excluded | 主要排除原因（逐行回执） |
| --- | --- | --- | --- | --- |
| Maigret | commit `b6642744988e…`，sha256 `3ac973e4…` | MIT | 6206 = 3952 + 2254 | regex 谓词 750、缺模板替换值 600、disabled 698、非 https 96、错误 URL 18、非安全头 28、ID 类型 25、非 https 协议 12、similarSearch 9、非 GET 方法 7、activation 5、缺 checkType 6 |
| WhatsMyName | commit `062bcfe48df7…`，sha256 `507d2f8a…` | CC BY-SA 4.0 | 717 = 651 + 66 | post_body 23、strip_bad_char 23、非安全头 12、非 https 7、凭据查询模板 1（`credential_bearing_template`） |

每行来源记录要么载入要么留下 `exclusions.json` 里仅含 `rowId`/`rowSha256`/`reason` 的回执；没有默认 500、没有抽样替代。规则合并后的并集：4603 条规则 / 4375 个平台+实例组 / 4422 条共享请求路线（8 组按**精确**规范主页模板映射进既有目录平台，其余生成 `pub-<hash>` 平台）。来源行数、规则数、并集平台/实例数、路线数在 `catalogSummary` 中各自独立计数。

**凭据模板护栏**：含凭据型 query 参数（api_key/token/auth/password/secret 等，含大小写/百分号编码与替换后的 urlMain/urlSubpath）的请求/主页模板在归一化前整行排除（`credential_bearing_template`），不剥离后冒充公开路线；已载入规则中此类参数为 0（全量审计），排除回执只存行号/hash/原因，任何上游凭据值都不进入输出/日志/测试/文档；合法 username/profile query 语义（id/user/q/tab…）原样保留。严格加载器即使面对重算 hash 的伪造包也会拒绝凭据模板。

## 归一化语义（受限数据，不是代码）

- 模板只支持 `username`/`urlMain`/`urlSubpath` 占位替换；`{account}` 归一为 `{username}`，scheme/host 大小写归一，**路径语义精确保留（含末尾斜杠与 fragment 定位符）**。请求模板只含请求侧占位（fragment 里的账号位置不能上请求线，显式排除）；规范化后重新校验占位数量，URL 归一化不得吞掉账号位置。
- 检测谓词只有受限字面量（≤200 字符，**逐字节保留，包括前后空白**；空/纯空白 marker 显式排除）与文档化状态码：`bounded_strings` 有界正/负证明，`status_only` 与 `url_redirect` 无有界正向证明（200 单独永远不是候选；重定向永远不是身份）。
- 请求头只保留安全字面子集（`accept`/`accept-language`）；authorization/cookie/Host 覆盖/app-token/guesttoken/antiabuse 等一律整行排除，值从不进入任何输出。无原始用户名示例、无第三方全文、无标签/描述字段。
- 未知站点 ID 为确定性 ASCII 哈希（`pub-<12hex>` / 规则 `pr-<16hex>`），不做 `normalizePlatformId` 式合并；只按**精确**规范主页模板 + 实例 host + 账号种类分组合并，显示名/TLD 永不合并；同组不同谓词保持独立规则、共享同一响应请求，逐路线 sourceRefs 只列本请求规则的来源。

## 许可与归属（数据集许可 ≠ 代码许可）

仓库代码/原创文档为 Apache-2.0；衍生数据集按逐来源上游条款：Maigret MIT（`maigret-LICENSE.txt` 全文 + `maigret-NOTICE.md` 归属/修改说明）、WhatsMyName CC BY-SA 4.0（`whatsmyname-LICENSE.txt` 保留上游通知与许可 URL、链接完整条款 + `whatsmyname-NOTICE.md`）、汇总见 `LICENSE-DATASETS.md`。share-alike 只及于这些衍生数据文件。加载器强制每来源 LICENSE/NOTICE 文件存在、被 manifest 逐文件 hash/大小绑定，且 `licenseHash` 与许可文件字节一致。

## 目录身份与 API 分页

- 生产 manifest 显式声明 `requiresPublicRuleBundle: true`：**缺规则包确定性失败**，不静默回退到 54 条目录身份；仅显式 curated-only 夹具可声明 `false`（mode `curated_only`，身份即原 catalog hash）。
- 组合快照有自己的确定性身份：`contentHash = sha256(curated hash + curated 版本 + 规则包 manifest hash + 计数)`、`registryVersion = <curated>+pr.<hash12>`；不同规则包/排除/许可 artifact 必然产生不同身份。curated 54 条 entry 与 13 条 legacy 探测规则逐字保留。组合 sources 合入验证过的导入计数（`imported_pinned_bytes`），不重复 sourceId、不虚构可用性/价格/live 证明。
- `GET /api/discovery/registry` 保留 `registry`/`summary` 旧字段；平台详情是**有界分页**（默认/最大 100）带显式 `platformsTotal` 与 `platformsNextCursor`。游标是服务端 HMAC 绑定（全组合身份 + offset）的真实 token：篡改 → `invalid_cursor`，跨注册表/规则包身份 → `stale_cursor`，offset 越界/数组/对象/空/非十进制/超长 query 一律 400。key 为进程内服务端密钥：重启/多实例会让旧游标失效（客户端从第一页继续）。第一页永远不等于全量覆盖。

## 独立受限执行器（未接线）

`validateDiscoveryTarget` + `createPinnedHttpsTransport` + `executeDiscoveryRequest` 是**独立可调用端口**：尚未接入 legacy 探测/研究运行时、未启用任何模型工具面（GET-59 网关与工具名不变），运行时激活属 GET-63（GET-62 合并后）。

- 目标策略：仅 https/443、拒绝凭据 URL；IPv4 特殊用途前缀（含 192.88.99/24）与 IPv6 特殊用途前缀（2001::/23、2001:db8/32、2002::/16、3fff::/20、5f00::/16、NAT64/6to4/Teredo 等）保守拒绝；IPv6 还必须落在**当前已分配**普通单播前缀内（维护在源码里的 34 条 IANA 分配清单，含 2024 年新增的 2410::/12；`2000::/3` 只是可分配空间，不等于已分配，邻居永不由毗邻推断）。来源：IANA IPv6 Unicast Address Assignments（<https://www.iana.org/assignments/ipv6-unicast-address-assignments/>，registry last updated 2025-10-10，2026-09-30 按官方分配表冻结核对）；清单显式维护，无运行时下载/自动更新/新依赖。数字/hex 主机别名先归一；DNS **全部**记录都须安全（无首条豁免）、family 与归一化地址矛盾即拒；无解析后再默认抓取的路径。
- 传输：TLS SNI/Host/证书校验用原始 hostname，`agent:false`（无池/无代理环境/无凭据），自定义 lookup（含 `options.all`）钉住已验证地址，socket remoteAddress 复核（含 IPv4-mapped 归一）且**无法确认即失败关闭**；每次重定向重新走完整 URL+DNS 策略、限制跳数、不转发凭据头；**执行入口取一次绝对 deadline**（含初次 DNS/排队/权威等待/每次重定向/提交，不因排队重置），abort/settle 内部守卫使迟到 DNS/结果/权威都不会再派发或写入；字节流式上界；`sendCount` 记录每次真实派发（含重定向跳）。
- 评估（固定优先级）：主页面结构证据（parse5：登录表单 + 登录标题/路径、已知挑战页标记）在正向**与负向**判定之前（登录墙既不能证实也不能否证）；普通 profile 的侧栏登录链接/CDN 页脚/简介文本不会被裸词误判为墙，其独立正向证明仍成立；401/403/429/5xx 正负判定都不成立；规则自身的错误标记优先于正向与缺失标记，混合标记保留反向证据、返回受限结果且不缓存；**通用软 404/占位页歧义优先于来源缺失判定**（批准 spec §5：登录/验证码/占位/软 404/无效 marker/重定向/未知 → 受限或 unknown）；只有规则自带的有界缺失证明（缺失字面量或**非成功**缺失状态）才 `checked_no_match`——2xx 缺失状态 + 无 marker 不是有界负证明（实际 WMN Evolution CMS）；通用登录短语字面量（`LOGIN`、`data-template="login"` 等）逐字保留为 metadata 但**永不作为有界正证明**。截断/非法 UTF-8/非 UTF-8 编码/压缩编码 → unknown。结果只是**候选线索 + 出处**（短可定位摘录，不存全文），不是身份。
- 调度边界：按 origin 串行（未知域名默认）+ 规则/全局上限 + Retry-After；**每次真实发送按实际验证目标的 origin 获取租约**（重定向跳在下一跳获取前先释放上一跳，无嵌套全局令牌死锁），429/503 Retry-After 在释放发送名额前记给**实际响应 origin**；未过期的 minInterval/冷却状态在空闲清理与其他 origin 活动后保留；注入时钟统一驱动队列/限流/TTL/回执/transport deadline。权威/scope 刷新在 dispatch、排队后、每次实际发送（含重定向）与 commit/cache-hit 之前；权威抛错/停摆是失败（fail closed）不是证明；commit 被拒/抛错/停摆时返回显式 scope 失败（不是 completed/ok/候选、响应不复用）但保留已发送用量回执；取消/截止优先于缓存重放与提交。缓存键隔离 owner/case/inputVersion/registry/policy，带服务端 TTL（注入时钟），只复用可靠结果并保留原 `observedAt`、零新请求/计费回执；unknown/超时不落负缓存、不自动重试。回执如实区分 sent_completed/sent_failed/cancelled/unknown/not_sent 与 `sendCount`，费用一律 null + 依据（null ≠ 免费）。缓存端口仅限内存（持久复用/重启恢复属 Task 5）。

## 测试与证据边界

- 合成回归（`public-rules*.test.ts`、`discovery-rule-executor*.test.ts`）+ 固定字节审计（`public-rules-source-audit.test.ts`：常驻常量核对 raw=loaded+excluded 与逐行回执完整性；`PUBLIC_RULE_SOURCE_DIR` 指向本地缓存时额外逐字节重编译并要求与提交产物字节一致——该字节审计是维护者步骤，不设私有路径入 Git）。
- 离线验证：typecheck、生产 build 与 `python3 scripts/check_design.py` 均通过；目标测试 181 pass / 1 skip（182 项，skip 为环境门控的维护者字节审计），全套 Web 测试 550 pass / 0 fail / 0 skip。另行使用固定本地来源运行维护者审计 4/4 无 skip，两次实际导入 CLI 生成产物逐字节一致。第四轮修复前行为回归为 3 pass / 6 fail / 0 cancel / 0 skip，修复后转绿。另补初次/重定向租约同回合 grant/abort 的两项回归：修复前 0 pass / 2 fail，修复后 2/2，通过共享一次释放包装器避免重复释放。
- 没有任何 live 验证：目录能力保持 documented_only/未接线，无 GET-59 `supported`、无假回执；真实端点验证单列后续任务。
- Git 字节检查：窄 `.gitattributes` 保留数据及原许可字节；实际索引导出、生产构建、仓库外默认目录加载与全部 manifest 文件 hash 核对通过，WhatsMyName 原许可保持 309 字节。GET-91 已按交付门禁完成：独立复审、PR21 head CI（8 项）与合并（`27f1075`）后验证（build、目录 181 pass / 1 环境门控 skip、来源审计 4 项、design）及 main CI 均读回通过。GET-92 的纯规划/请求键/账号键见 [`discovery-route-planning.md`](discovery-route-planning.md)（未接线、无 live 验证）。
