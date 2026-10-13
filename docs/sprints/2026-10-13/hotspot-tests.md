# Hotspot 边界测试（B）

基线 `0017e11`；2026-10-13 离线验证。新增三个测试文件，执行真实共享身份规则、Search verifier、checked Search、toolkit、SQLite Store/ledger、runtime 与工具 dispatcher。仅外部 HTTP transport 和模型返回使用原创合成替身；未调用网络、付费 API、真实人物模型评测或部署。

## 已执行分支清单

这是一份实际断言的分支清单，**不是行/分支覆盖率**，也不把静态导入可达当执行覆盖。新增 15 个顶层测试，59 个命名子测试；Node 报告合计 74，全部通过。部分顶层测试另有数据表循环，未虚增 Node 测试数。

| 边界 | 既有测试与本轮增量 | 本轮断言 |
|---|---|---|
| 原文请求绑定 | 既有 `first-step-search` 校验异源与搜索回执；缺失请求 URL 没有回归 | 缺 URL、错误 URL、空/全空白 URL、null/number 均拒绝且不抛异常；正确 URL 接受。缺 URL 用例在修复前实际失败 |
| 原文精确性 | 既有 semantic/link-context 校验 HTML/Markdown 定位；本轮加入 Unicode 规范化与空白重写 | NFC 原文接受，NFD 等价字形与增添空格拒绝；不修改来源和模型输入对象 |
| 批内隔离 | 既有单项伪造校验 | 混合真实提议、虚构回执、未读来源与借用其他目标摘录，保留唯一有效提议并分别拒绝三项 |
| 否认与组织归属 | 既有单层角色分类与聚类用例 | verifier → shared assessment → default suggestion 连续断言；真实否认产生 disputed；隐藏/引用/普通正向原文不能造否认；组织第一人称保留候选、无人物支持 |
| runtime authority | 既有 scope/cancel/permission 少量漂移 | 17 个维度分别在模型调用前和模型返回后变化：owner、case、scope、role、phase、cancel、账号增删替换、platform、handle、allowedScope、registry、capability、skill hash/删除、media permission；34 个子测试均零 dispatch |
| usage | 既有负 token 与正常 usage | 17 类非法 shape/值拒绝（缺失/null/数组/缺字段/额外字段、负数/小数/不安全整数/string/NaN/Infinity token、负数/string/NaN/Infinity fee）；保留 unknown、零、合法小数费用的区别 |
| 迟到返回 | 既有同步 model callback 修改内存 context | 独立 deferred promise 挂起模型时，通过真实 CaseStore 推进 scope；迟到结果保留已观测 usage，但零工具执行 |
| 真实工具返回 | 既有 fake dispatcher 的 context/事件测试 | 账号顺序变化仍到达真实 dispatcher，并读回冻结 capability；无 accounting port 的回执仍明确 unaccounted，runtime 因此停止 |
| 第三方身份读取 | 既有机构人物页成功路径与虚构 receipt | 8 类前置拒绝（虚构回执、跨 attempt、无 namespace、未召回 URL、intent URL 不同、新闻页、切换 provider、以 read 替代 search）均不新增 transport 调用/ledger 记录；合法机构原文走真实 toolkit，按原 receipt/key/time 重放且仅一次 contents 请求 |

## 实际发现与最小修复

**P2：缺 URL 的 completed read receipt 跳过来源绑定。**

[`verifyFirstStepModelProposals`](../../../apps/web/src/server/research/first-step-discovery.ts) 原条件仅在 `receipt.request.url !== undefined` 时比较来源 URL。传入真实合成 HTML、自链上下文与 `{state: 'completed', request: {type: 'read'}}`，verifier 实际接受了提议，违背其“绑定实际读取地址”契约。

先新增失败回归：7 tests，6 pass / 1 fail，失败为 `expected accepted.length = 0; actual = 1`。主任务随后授权对该 guard 做单处防御修复：非 string/空 URL 直接拒绝，其余沿用原 `comparableUrl` 比较，不调整 alias、原文或角色语义。最终新增 suite 为 74 pass / 0 fail / 0 skipped。

**可达性限制：**源码唯一生产调用由 `discoverFirstStep` 从持久 ledger 构造 receipts；正常 `ResearchToolAction` 的 read/firecrawl/social_profile/github_profile 都要求 `url: string`，checked Search 将完整 action 持久化。没有证明正常调用会丢失该字段，也没有证明远程用户能注入此 receipt；本修复是对异常/旧数据边界的防御收紧，不宣称已复现线上错人。`ResearchStore` 读回 JSON 后将 request 保持 `unknown`，verifier 边界仍应独立失败关闭。

## 复现

在 `apps/web` 运行（Node `v22.23.2`，锁文件匹配依赖）：

```sh
node --import tsx --test --test-concurrency=1 src/tests/sprint-hotspot*.test.ts
```

最终结果：`tests 74; pass 74; fail 0; cancelled 0; skipped 0; todo 0`。中途真实 dispatcher 正向控制首次发现测试 fixture 未接 accounting，因此返回 `unreconciled_action`；已按契约明确断言未结算停止及成功工具回执，未伪造 accounting 来绕过门禁。

测试前 storage audit：可用 31 GiB；设备池外模拟器 0；审计因已有 Compose/会话日志警告退出 2。本工作流只使用内存 SQLite，没有启动 Simulator/Docker/服务，没有新增磁盘测试产物。全量测试、build 与 design 检查由主任务集中执行；本记录不替代它们。

集成 typecheck 曾发现新增迟到响应测试将普通 `number` 传给要求 branded `ScopeVersion` 的 mutation。已改为在 mutation 前从真实 `CaseStore.getCase` 读回记录、确认存在，并传入该记录的 `scopeVersion`；未增加强制类型转换，未修改生产 guard。随后依次执行新增 suite（74/74 通过）和 `npm run typecheck`（server、client、test 三份 tsconfig，退出 0）；此轮主任务暂停同一命令，未并发重复 typecheck。

文件：[`identity`](../../../apps/web/src/tests/sprint-hotspot-identity.test.ts) · [`runtime`](../../../apps/web/src/tests/sprint-hotspot-runtime.test.ts) · [`checked Search`](../../../apps/web/src/tests/sprint-hotspot-search.test.ts)。

## 限定 suite 的实际 V8 统计

随后仅对上述三份测试启用 Node coverage，仍为 74 pass / 0 fail，不包含既有测试、其他工作流或全仓库测试。以下是本次最终工作树的 **Node/V8 原始报告值**；没有运行基线 coverage，因此不计算百分点增量。

| 目标模块 | 工具报告行数（命中/总量） | 工具报告分支（命中/总量） | 工具报告函数（命中/总量） |
|---|---:|---:|---:|
| `server/research/first-step-discovery.ts` | 807/2033（39.70%） | 85/123（69.11%） | 24/44（54.55%） |
| `server/research/research-runtime.ts` | 119/143（83.22%） | 57/68（83.82%） | 14/15（93.33%） |
| `shared/first-step-discovery.ts` | 1520/2152（70.63%） | 69/154（44.81%） | 22/41（53.66%） |

```sh
node --experimental-test-coverage \
  --test-coverage-include='**/first-step-discovery.ts' \
  --test-coverage-include='**/research-runtime.ts' \
  --import tsx --test --test-concurrency=1 src/tests/sprint-hotspot*.test.ts
```

再加 `--test-reporter=lcov` 可得到表中的 `LH/LF`、`BRH/BRF`、`FNH/FNF` 原始计数；两次都退出 0。首次使用单星号 `*first-step-discovery.ts` / `*research-runtime.ts` 未匹配任何文件，工具打印的空集 `100%` **无效，不计入结果**；修正为 `**/` 后才得到上表。

**解释限制：**统计通过 `tsx` 转译采集。Node 显示 `.ts` 文件名与总行数，但 uncovered 列表包含类型声明所在行，未验证其逐行 source-map 精确性，因此表中行数只能称工具报告值，不能解释成原始 TypeScript 语句的精确执行覆盖率。分支清单及逐项行为断言仍是主要证据；三份定向测试未执行完整发现 coordinator、DSH adapter 或所有 URL 分类分支，也不证明模型质量。
