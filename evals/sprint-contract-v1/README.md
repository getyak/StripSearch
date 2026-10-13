# Sprint contract v1

33 个原创合成、未经人工裁决的确定性契约规格，独立于所有既有冻结数据集。许可为 Apache-2.0；人名、正文和账号均为虚构测试材料，不代表真实人物。URL 只作为字符串输入，禁止抓取（包括 `example.org`）。

## 执行

Node `22.23.2`，复用 `apps/web/package-lock.json` 对应依赖，无新增依赖。仓库根目录：

```bash
node apps/web/src/evals/sprint-contract-v1/run.mjs
```

或在 `apps/web`：

```bash
node src/evals/sprint-contract-v1/run.mjs
node --import tsx --test --test-concurrency=1 src/tests/sprint-evals.test.ts
```

`--dataset` 与 `--output` 均相对**仓库根目录**解析，也接受绝对路径。默认输出 `_private/evals/sprint-contract-v1/latest/report.json` 与 `network-violations.jsonl`。默认数据由 [manifest.json](manifest.json) 的 SHA256 与完整案例顺序冻结；显式 `--dataset` 标为 `explicit_override`，仍须通过相同严格 schema。未知/重复/缺值参数拒绝；断言或执行失败退出 1，非法数据/参数退出 2。

## 覆盖与评分

| 案例 | 独立边界 | 实际生产入口 |
|---|---|---|
| SC-001–013 | 编码 href 原文保真、明确否认、支持/否认冲突、祖先第三方归属、作品作者、隐藏 rel=me、未知 surface、索引文本、组织/未知类型、来源独立性、社交帖子、显式目录 | `extractOriginalLinkContexts` → `linkRoleFromContext` → `assessIdentityLink` → `firstStepDefaultSuggestion` |
| SC-014–019 | 原始实名自述、标题不能证明、自述引语、错误 document binding、索引自述、来源注入 | `namedOwnerQuote` |
| SC-020–033 | verify 工具集合、Search 提交限制、owner 注入、profile-only、当前撤回、scope 漂移、缺少 fresh authority、外来账号、未核验 capability、sort 限制、取消、核验拒绝新采集、正向 local catalog、prototype 名键 | `dispatch` |

期望在 [cases.json](cases.json) 中独立编写，runner 不从生产注册表生成期望，也不把预期答案作为 handler 输出。工具端口仅提供合成可信状态、记账和会抛错的禁止操作探针；实际拒绝与返回封套由生产 dispatcher 决定。正向身份/目录/自述/local catalog 用例防止“全部拒绝”通过。

[公开 JSON Schema](schema.json) 与 TypeScript 严格校验规则一致；额外检查拒绝重复 ID、重复边界/输入、不一致计数与 owner 期望。所有实际结果、固定期望、逐字段失败和执行异常保留；失败案例不阻止后续执行。报告包含原始引文、生产 locator、UTF-16 字符偏移与 UTF-8 全文 SHA256。固定顺序、固定合成时间、无随机 ID/耗时，重复运行可字节一致。

## 禁网与解释边界

launcher 仅在本地转译运行时 import graph，保存源码与生成 JS 的 SHA256，随后启动**没有 tsx** 的 worker，并在任何生产 import 前加载守卫。worker 环境不继承 provider key。守卫拒绝 fetch、WebSocket、HTTP/HTTPS/HTTP2、TCP/TLS、DNS 回调与 promises/Resolver、UDP socket 创建、子进程和 worker 创建；每次尝试立即写入独立日志，即使调用方吞掉异常也使进程失败。测试使用 `.invalid` 目标且先安装守卫；不会实际发出测试请求。

这是进程 API 守卫，**不是操作系统网络沙箱**；不声称隔离原生扩展、调试器或恶意重写运行时。每次报告保留实际 guard API 清单。运行时语法转译不替代项目 typecheck/build；该检查由集成验收执行。

本套只验证这些输入下的程序契约，没有模型请求、真实 provider 请求、搜索覆盖率、真人身份精度、盲测、人工 gold 或研究质量分数。33 个案例不能当成 33 个独立人物；全部保持 `synthetic / unreviewed / offline_deterministic_contract`。本轮结果与限制见 [冲刺评测记录](../../docs/sprints/2026-10-13/contract-evals.md)。
