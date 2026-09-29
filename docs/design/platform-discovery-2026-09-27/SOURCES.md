# 来源

调研截面：2026-09-27。以下为官方仓库/文档与源码的静态核实；标注“声称”的内容未独立复算，冲突数字如实并列。本轮未运行任何真实平台请求或第三方 CLI。

## 邮箱 → 注册网站

- [megadose/holehe](https://github.com/megadose/holehe)（GPL-3.0，Python）：README 声称覆盖 120+ 站点（其在线版本自称 200+，两数字不一致，均为声称），通过“忘记密码”流程探测注册痕迹，并声称不会惊动目标邮箱。**模块输出契约已按 README 核实**：`{ name, rateLimit, exists, emailrecovery, phoneNumber, others }`。维护状态与各模块存活率未验证；第三方对比称“很多模块已过期”，属外部观点。
- [sharsil/mailcat](https://github.com/sharsil/mailcat)：昵称 → 邮箱（SMTP/API 校验），声称 26 个 provider、158+ 域名；可靠性随邮件服务商限制波动。用途与 holehe 相反（找邮箱而非查注册），本轮仅列为生态参考。
- [Epieos vs Holehe 对比](https://revealer.us/blog/epieos-vs-holehe)：两工具回答不同问题（Epieos 偏向 Google/Microsoft 账号画像，holehe 列注册站点），互补而非替代。属第三方评测观点。

## 用户名 → 全平台账号

- [soxoj/maigret](https://github.com/soxoj/maigret)（MIT，Sherlock 分支）：默认查流量前 500 站，`-a` 全量，`--tags` 按国家/主题过滤；`--json simple|ndjson`、`--csv`、`--txt`、`--graph`、`--neo4j` 等导出。站点数各来源不一致（3000+ / 5900 / 6K），按约数对待。
- **输出契约按源码核实**：[report.py `generate_json_report`](https://github.com/soxoj/maigret/blob/main/maigret/report.py)（simple 只含 `Claimed` 站点；ndjson 每行带 `sitename`；`is_similar` 结果在报告生成时被跳过）、[result.py `MaigretCheckResult.json`](https://github.com/soxoj/maigret/blob/main/maigret/result.py)（`status` 词表 `Claimed/Available/Unknown/Illegal`，字段 `ids`、`tags`、`keyword_match_status`）。
- [maigret README](https://github.com/soxoj/maigret/blob/main/README.md)：报告模板自带“Possible false positives / Ethical use”段落，明确警告同用户名可能属于不同人——这与本项目“用户名一致不等于身份一致”的校正设计一致。
- [Bellingcat 工具库条目](https://bellingcat.gitbook.io/toolkit/more/all-tools/maigret) 与公开讨论指出其双用途（stalkerware 争议）。安全研究界将其列为 OSINT 工具同时强调授权边界。
- [maigret.dev](https://maigret.dev/)（托管试用）：免费扫描限前 100 站点与固定超时。属产品限制声明。

## 维护与替代品

- [User-Scanner](https://github.com/topics/username-enumeration)（外部对比提及）被列为 holehe 的活跃替代；本项目不依赖单一工具存活。
- socialscan（holehe README 致谢）：邮箱/用户名 → 平台与泄露检查。泄露库查询**不在本项目范围**（产品红线）。

## 对本项目的含义

1. 两工具的**输出都是候选发现，不是身份结论**；maigret 自己的报告模板就这么写。
2. holehe 的探测手段（密码重置流量）在部分站点可能触发风控或违反 ToS；本项目不实现该原生路径，只导入外部运行的报告（见 [REVIEW](REVIEW.md)）。
3. 数字（站点数、准确率）无独立基准；本仓库不引用它们作能力宣称。所有准确度问题转 [EVAL](EVAL.md) 的实测设计。
4. 许可：holehe GPL-3.0 / maigret MIT——集成只解析输出数据，不 vendor 代码（见 [TECHNICAL](TECHNICAL.md) §4.3）。

## 本仓库内相关来源

- [DSH / Person Object 提案](../person-object-2026-09-26/SOURCES.md)：Agent 执行层与成本来源，与本提案的执行层选择互补。
- [工具选型与调研](../../providers.md)：Exa / TikHub / Firecrawl / MCP 生态取舍。
