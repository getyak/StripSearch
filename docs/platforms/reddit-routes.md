# Reddit 两条路线：能力与验收缺项

核对日期：2026-09-30。代码基准：`d739694`。本页与[机器可读登记](reddit-routes.json)只记录文档和代码核对；没有调用人物端点。两条路线均未启用、未 live 验证，GET-69 的实测验收仍未完成。登记不是运行时 PlatformRegistry，不能用于自动开启能力。

## 文档中的读取能力

TikHub 路径前缀为 `/api/v1/reddit/app/`；官方路线使用获准的 OAuth 接入。

| 能力 | TikHub 文档端点 | Reddit 官方文档端点 | 仍须验证 |
| --- | --- | --- | --- |
| 账号资料 | `fetch_user_profile(username)` | `/user/{username}/about` | 稳定账号 ID、删除/受限状态 |
| 本人发帖 | `fetch_user_posts(username, after)` | `/user/{username}/submitted` | 连续两页、作者、原生 permalink、时间 |
| 本人评论 | `fetch_user_comments(username, after, page_size)` | `/user/{username}/comments` | 连续两页、所在根帖与父节点 |
| 帖子评论 | `fetch_post_comments(post_id, after)` | `/comments/{article}` | 排序、首层与子层的实际区分 |
| 更多子评论 | `fetch_comment_replies(post_id, cursor)` | `/api/morechildren` | 缺失分支、重复项、游标/ID 消耗 |
| 父链与上下文 | `fetch_post_details` 的 `include_comment_id=true` 与 `comment_id` | `/comments/{article}` 的 `comment/context` | 返回的祖先链是否完整；不能把向下回复当作父链 |

依据：[TikHub OpenAPI](https://api.tikhub.io/openapi.json)、[Reddit API](https://www.reddit.com/dev/api/)。TikHub `V5.3.2` 当前列出 28 个 Reddit 路径；本登记只选择上表六个相关端点，不复制完整文档。关键响应的 `data` schema 未限定结构，因此此时不能据文档冻结真实字段解析器。

分页必须按路线保存：TikHub 列表传 `after`，子评论传独立 `cursor`；官方 listing 使用 `after/before`，评论树另用 `morechildren`（文档单次最多 100 个 children ID，且该端点同时只允许一个请求；必须串行，不能只依赖整体 QPM 限流）。分页结束只证明该接口本轮可访问范围结束，不证明账号完整历史。排序枚举不能跨路线直接照搬。

## 使用条件、限额和费用

- 官方路线需明确项目访问批准；商业用途另需书面批准。当前未提供批准证据，不表示已被拒绝。匿名账号不得被反向识别到现实身份，也不推断敏感特征。[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- 官方文档的每 OAuth client 100 QPM 只适用于符合免费资格的访问；项目资格与价格仍未知。执行时依据限额响应头等待，并处理删除内容及作者信息撤除义务。[Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- TikHub 上表六端点的 `endpoint_cost` 目录值均为 `0.001`、目录限额 `10/second`，免费额度/折扣标志均关闭；这些是[公开价格元数据](https://api.tikhub.io/api/v1/tikhub/user/get_all_endpoints_info)，不是项目账单。币种、账号适用性及实际扣费未验证，实际费用保持 `null`。仅出现在价格目录的其他路径不作为已验证 API；购买服务也不能替代数据用途许可。

## 当前代码与阻塞

现有 [Reddit 规则](../../apps/web/src/server/platforms/registry.ts) 是匿名 `about.json` 和 `submitted.json?limit=25` 单页，标记 `live_unverified`；它不是上表任一路线的已完成适配器。[通用读取器](../../apps/web/src/server/adapters/discovery.ts) 不消费 Reddit `after`，其 `nextCursor:null` 不表示历史读完。现有 `data.url` 字段可能是站外链接，不保证 Reddit permalink。

[TikHub 工具](../../apps/web/src/server/research/toolkit.ts) 目前仅接 X；应用尚无 Reddit OAuth 适配与配置消费。没有读取用户凭据，也不据此断言用户没有凭据。

| 路线 | 激活前缺项 |
| --- | --- |
| TikHub Reddit | adapter；端点权限/账号可用额度确认；数据用途许可依据；获准样本与调用预算；真实字段、分页、父链和扣费回执 |
| Reddit 官方 OAuth | 项目批准依据；OAuth adapter/配置；获准样本；真实字段、分页、父链与限额回执 |

匿名入口的 403/429 不能推导另一条路线不可用；分别记录路线和能力状态。GET-70/71 可依本契约开发离线适配，但在缺项关闭前不能标成 live_verified 或开放真实采集。

## 每条路线独立验收

1. 确认用途、项目权限、获准样本和调用上限；私人审批材料与研究对象清单不进公开 Git。
2. 对本人帖子与评论各读连续两页，验证作者、permalink、日期、续页去重、游标和停止原因。
3. 验证根帖→问题→作者回复路径，并保留缺失/删除父节点、未展开分支及截断；不编造关系。
4. 保存每个底层请求的版本、输入指纹、结果、限流头、游标及已知或未知费用；失败同样入账。
5. 仅提升有对应回执的单项能力；保留另一条路线的独立状态。文档核对或单页成功不能替代上述验收。

本次验证只包括本地链接、JSON 结构与目录事实一致性，不包括供应商响应契约、权限批准、实际费用或研究效果。
