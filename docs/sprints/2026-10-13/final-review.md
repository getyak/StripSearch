# 最终独立审查 — 2026-10-13

结论：**补充复审通过，无未解决的 P0–P3 问题。** 扩大检查后确认的旧测试 harness P1 隔离缺口已修复并独立复验关闭；历史完整运行的外发次数仍为未测量。这不是全量 CI、合并、发布或人物研究质量验收。

初审时间：2026-10-13 05:06:31 UTC；初审结论仅绑定下列原 22 个文件。补充复审时间：2026-10-13 08:29:53 UTC；新增范围、已关闭发现和新 hash 见文末。

审查对象是 `codex/burndown-sprint-20261013` 相对基线 `0017e1159f77a1b2dfd99ba335590d1ab12d71dd` 的实际 tracked diff 与新增文件。审查前未把其他 reviewer 的结论作为事实来源；已阅读项目规则、README、路线、代码维护/覆盖/评估契约及 STATUS。生产修改仅包括 coverage projection 局部重构与缺失回执 URL 的防御拒绝。最终 B 测试的 branded `ScopeVersion` 修复已包含在下面的文件绑定内。

## 初审排序结果

| 等级 | 未解决发现 |
|---|---|
| P0 | 无 |
| P1 | 无 |
| P2 | 无 |
| P3 | 无 |

没有待修复发现，因此没有虚构的复现步骤或新增实现要求。

## 独立核对

- `fetch-coverage-store.ts:412` 的外层读取事务未移除；账号仍由 owner/case 约束的 `listAccounts` 读取。snapshot 的 sources/evidence 查询限制同一 case，observations 限制同一 frozen spec，且按 `seq` 排序。旧 `reportView` 额外派生的 identity/claim 字段不参与该投影输出。复用 snapshot 不建立跨调用权威缓存，也不改写完成规则或证据状态。
- receipt 索引使用已有无碰撞维度键；输入、history、最新 parent 与 supersession 保留追加序。账号分组之后仍按原规则排序。撤回、角色/账号不符、stale scope、未知日期、零/未知分母及 source revision 的行为通过基线差分核对。
- `first-step-discovery.ts:534` 的 guard 对缺失、非字符串与空 URL 失败关闭，保留原 URL 比较和角色语义。正常 matching receipt 的正向路径、原文 Unicode/空白保真、混合批次与否认/组织场景均有实际执行。
- 新 eval 的独立 fixture 期望与实际生产执行分开；schema 拒绝未知/遗漏字段和不一致期望，逐例异常保留并继续后续案例。CLI 非零退出、默认 manifest 绑定、显式 dataset override 标签、guard 违规独立日志和 worker 环境不继承 provider key 的实现均已检查。当前运行图先转译再加载 guard 的 worker 执行；网络守卫的 callback/promises/Resolver、HTTP2、进程与 worker 入口在报告中可审计。
- benchmark 比较同一 SQLite 数据中的完整 `JSON.stringify` 输出；计时不包含 setup、序列化和 SELECT instrumentation，历史源码固定 `0017e11`。默认测试不依赖完整 Git 历史，显式 differential/benchmark 缺少该 revision 时失败，未自动联网补齐。inventory 的 regex/type-import 可达明确标为静态信息；changelog 来自 first-parent 历史且不推断部署。
- 公开 benchmark 的生产源码与 harness SHA-256 均匹配当前文件；公开 eval replay 的全部 runtime source SHA-256，以及 launcher、guard、dataset、schema、lockfile SHA-256 均匹配当前文件。新文件范围未发现本机私有路径、private Notion URL 或凭据；合成/未经人工裁决/非质量 benchmark 的限制保持明确。

## Reviewer 实际验证

在 `apps/web` 运行：

```sh
STRIPSEARCH_COVERAGE_BASELINE_COMPARE=1 node --import tsx --test --test-concurrency=1 src/tests/sprint-coverage-projection.test.ts src/tests/sprint-hotspot-identity.test.ts
```

结果：**22 tests / 22 pass / 0 fail / 0 skip**；其中 15 个 projection 用例实际加载固定历史实现并逐字比较完整 JSON，7 个 identity 用例实际运行生产 verifier。`git diff --check` 退出 0。未重复运行全量测试、build 或完整 benchmark；其结果由[集成验证记录](verification.md)承担。

测试前 storage audit 已执行：可用 30 GiB，设备池外模拟器 0；退出 2 对应既有 Compose/会话日志警告。此审查只使用内存 SQLite 和短命历史源码载入文件，未启动服务、容器、模拟器，未触达 fixture URL/付费 API；历史源码载入文件由 `finally` 删除。

## 源码绑定与限制

以下 22 个文件在结论形成时逐文件 SHA-256 绑定。表按路径排序，其紧凑 JSON 数组（每项 `path`、`sha256`）的 SHA-256 为 `d0a247bf6d91f544121d8c54b6f0759bb59c80fa6771e8dedc704bd8b06ab045`；四个 tracked implementation/integration 文件的 `git diff --binary` SHA-256 为 `f3725d4753853633013e1c27964a8ea76cc375254e5446afff675a58dcb2d112`。后续仅更新 STATUS、验证/发布说明或其他证据文档不会更改此源码结论；实现、测试、fixture、schema、harness 或 CI 变化需要相应复核。

| 文件 | SHA-256 |
|---|---|
| `.github/workflows/web-evals.yml` | `8ac306c1a1aa03ab366349acd1be47a9dfc6364d5c7544d2d4f6198a18892cd8` |
| `apps/web/package.json` | `eda04dd107138e41f3eee26485a01ae7b3ecc31fdcacfe2767944d4c14377245` |
| `apps/web/scripts/benchmark-coverage.ts` | `fdac5eedec194a1f41e15c0d46523518e67d5f3554c72dc1a4d747374abc67f3` |
| `apps/web/src/evals/sprint-contract-v1/case-runner.ts` | `a4bb4c453c498a094b9eaf900f49b6f95b76bb49ef0359dfe7753bfa708c887f` |
| `apps/web/src/evals/sprint-contract-v1/grade.ts` | `534f48fc234d60e693baf9a040f066e7636e9904f8c1ce28277bc4dc705571b2` |
| `apps/web/src/evals/sprint-contract-v1/network-guard.mjs` | `c8405d70d6ea89adb35586ae67a267a4210b39470bc105e773042eafd4462a79` |
| `apps/web/src/evals/sprint-contract-v1/run.mjs` | `b259ce34ef1d676a8a37182ad0ffb5dc1c795cd18bcbfc72c96f7ffab34ee43a` |
| `apps/web/src/evals/sprint-contract-v1/schema.ts` | `0c36c5ca373646cb0689d1d42d1e25d0f0ccdcdbd54d6019e207fc0345048f1f` |
| `apps/web/src/evals/sprint-contract-v1/worker.ts` | `dbc1f5e0f20711f5e9b9c45cd3b00c582951b31079016881ee65586400214efb` |
| `apps/web/src/server/research/fetch-coverage-store.ts` | `dd3617f825617cf23cacae2871caeaf6518b0d048f2cb89387a57c29a4244954` |
| `apps/web/src/server/research/first-step-discovery.ts` | `4d63f06bc2f6cf11703909c0e3a7bdbf52a332f9a8c16c06c751ec350a2b6e01` |
| `apps/web/src/tests/sprint-coverage-projection.test.ts` | `b09a271ca49de93695473c41c975dcb2089991cac6d77a0dfa6fd2ce3972d5ac` |
| `apps/web/src/tests/sprint-evals.test.ts` | `40e3647b227a98b20065ec34802d3fcf97dc44152c1ac48b4df376f4e2ef0df0` |
| `apps/web/src/tests/sprint-hotspot-identity.test.ts` | `63f625a4ad51488ce799d3fe973ce84f364bd968072d04546bcb4b4e704aa3af` |
| `apps/web/src/tests/sprint-hotspot-runtime.test.ts` | `c14e66f4315e65d7b49313b8dd869e30f12e362f83bd768b021dbd85b0858696` |
| `apps/web/src/tests/sprint-hotspot-search.test.ts` | `fc84967ae8ad4fd43375aeb08abbea9fed290ddf0e29c75027076bb2ef4fce3f` |
| `evals/sprint-contract-v1/README.md` | `3248f6249ab7e2e6f3cef22d64294f987d1f089412c649562cb5eec8a5bbfd40` |
| `evals/sprint-contract-v1/cases.json` | `4dd6a31064ff3e072f585430e6b3562ecc51333abbee40b6df175935c369444c` |
| `evals/sprint-contract-v1/manifest.json` | `a91324db0e0b452bd5a569285d3267f058d45b1c6a730649fa22ab983cb24728` |
| `evals/sprint-contract-v1/schema.json` | `06b7ff0e3de4dabd8070a02cd2fb76d43b1850a615d4f568265fcf7b5da939d9` |
| `scripts/architecture_inventory.py` | `681095520e9808b6e7e7deb3f2a961bdc043b41feb0f75e1ec95a3403177d491` |
| `scripts/draft_changelog.py` | `bf3948fe220bd3397883fce65a1ffc88ead6e9e69473a1be47ed1e35cbb2d937` |

限制：本次没有 live provider、模型、真人/人工 gold、OS 网络沙箱、文件数据库负载、部署或多 worker 并发验收。当前 process API guard 不承诺阻止原生扩展或恶意运行时代码绕过。源码审查与上述有限差分不能穷尽所有输入；最终 typecheck/build/full-suite 与当前 PR head 的 CI 仍须由主流程实际完成并读回，不能由此报告替代。


## 补充复审：旧测试 harness 的离线隔离

主流程完整运行出现两个异步 timeout 后扩大检查范围。原 `harness.ts` 与本节涉及的 Runner/bootstrap 路径不在初审 22 文件的变更集合中；它们属于这次补充审查。下述是确认并关闭的发现，不把先前完整测试失败改写成通过。

| 等级 | 发现 | 当前状态 |
|---|---|---|
| P1 | 旧测试服务器继承部分真实 provider 凭据，并在未显式注入 transport 时启用生产 HTTP fallback | 已修复，独立 3/3 回归通过；无未解决 P0–P3 |

**位置与原因：**基线 `harness.ts:160–168` 复制 `process.env`，只清理 Exa/GitHub，然后 `bootstrap(env, overrides)`；`server/index.ts:82` 使用 `overrides.transport ?? defaultTransport`。`services/runner.ts:356–363` 在 DeepSeek 与 Exa key 有值时独立创建 proposal/Search Agent；注入 `researchPlanner` 并不替换该 Agent。`research/planner.ts:165` 最终可调用真实 DeepSeek endpoint。bootstrap 还会启动恢复/pump，因此只在服务器 listen 之后安装边界不够。

**安全复现与修复要求：**在调用前拦截全局 fetch 的所有非 loopback 目标，仅计数并抛错；向真实 first-step 路由提供合成 tools、fake keys 与显式 `transport: undefined`。旧实现不会调用默认拒绝端口；继承 DeepSeek/Firecrawl/TikHub 的合成环境值也未清空。作者的安全红灯结果为 1 pass / 2 fail，详见[诊断记录](timeout-diagnosis.md)；本 reviewer 没有再次运行有缺口的旧 harness，也未接触外部 provider。历史完整运行没有请求计数，外发次数与费用仍是 **unmeasured**，不能从 fake key、通过率或 timeout 推断零请求。

**修复复核：**当前 `harness.ts:177` 在 bootstrap 前使用 `{ ...overrides, transport: overrides.transport ?? offlineTestTransport }`；显式 `undefined` 仍拒绝，显式合成 transport 保留。`harness.ts:169` 在应用 fixture override 前清理 `loadConfig` 读取的五类 provider 凭据。新增测试有非 loopback fetch 后备拦截，读取真实 model receipt 的 failed/completed 状态与计量；没有用预期结果代替生产执行。生产代码、旧 recovery 的 4000 ms 和旧 metering 的 10000 ms 均未改动。新增 DSH 专项自身 30 秒状态等待 / 40 秒测试上界不改变旧失败断言。

Reviewer 仅独立执行新增三例：

```sh
node --import tsx --test --test-concurrency=1 src/tests/harness-offline.test.ts
```

结果：**3 tests / 3 pass / 0 fail / 0 skip，约 26.41 秒**。默认 transport 拒绝调用 1 次，实际 model receipt 为已结算 failed；显式 synthetic transport 调用 1 次，receipt 为 completed，usage 为 20/10。两条实际模型路径的全局外部 fetch 计数均为 0。凭据继承清理与显式 fixture override 正例也通过。这里的零请求仅限新回归实际监测的路径/本次运行，不追溯覆盖历史完整运行。

作者另已完成四个受影响测试文件 30/30 与全项目 typecheck；本 reviewer 查阅了其精确命令/计数并未重复全套。主流程已开始新的完整串行验证及独立 PDF；最终结果和 PR 当前 head CI 仍以[集成验证记录](verification.md)为准。

本次复验前执行 storage audit/resources：可用约 30 GiB、设备池外模拟器 0；既有 Compose/会话日志与 371 Node/npm、22.62 GiB swap 导致警告。仅新增测试所需短命 loopback 测试服务器/受限 DSH worker，没有常驻服务、模拟器或容器；测试 teardown 已完成。`git diff --check` 退出 0。

### 补充源码绑定

原 22 文件逐一重新计算，全部与初审 hash 相同；新增两文件如下。诊断/STATUS/验证文档是证据更新，单独保持其诚实范围。

| 文件 | SHA-256 |
|---|---|
| `apps/web/src/tests/harness.ts` | `c4b3f841a529c23df438362cf337be4bf0e38ea5d975d4664f60fc885f8f0938` |
| `apps/web/src/tests/harness-offline.test.ts` | `40395f85dabf121a5104a66dd7fe550c7e72b97f2aaa30794d1fb95d90e7b58e` |

合并后的 24 文件紧凑 JSON manifest SHA-256：`84237d2824f8d199b0c018183375397c08d046928b42d4d6d6414c6b3845f7e9`。包含新增 harness 修改的五个 tracked 文件 `git diff --binary` SHA-256：`f98f2c99b4a9f96ca76d6d60df5002924269925de16ed5c7066263487cd15d66`。新的实现或测试变化需要对应复核；单纯补充全量结果不使本节提前代表 CI/部署已通过。
