# Fetch coverage projection：行为保持重构与离线基准

`FetchCoverageStore.getFetchCoverageView` 的来源相关查询从每 source 一次降为复用同一事务内已有的批量快照；本轮两个规模均与 `0017e11` 的完整 `JSON.stringify` 结果逐字一致。没有改 schema、外部接口、写入校验、GET-60 依赖算法或完成判定，没有跨调用缓存授权状态。

## 范围与原因

原实现先调用 `CaseStore.reportView`，逐 source 查询 revisions，还构造本投影未使用的 claims、coverage 和身份派生字段；随后 completion snapshot 再次批量读取来源、证据与 observations。现在账号仍由 `CaseStore.listAccounts` 读取；来源、证据、observations 使用当前读取事务内的 authoritative completion snapshot。来源 revision 上限仍取实际 revision 最大值，receipt 证据仍逐条检查角色、账号与撤回状态。

另按内容/维度建立局部 receipt 索引，保留 `seq` 顺序；按账号建立局部 item 索引，避免每个账号扫描全部 item。冻结 scope 选择、receipt 历史与 parent 合并顺序、中文 limitation 文案、分母与 `null` 百分比语义保持一致。`CompletionStore` 的 pinned coverage 查询本轮未改。

## 测量

[原始结果](coverage-benchmark.json)记录每次样本、源码/harness SHA-256、完整输出字节数/hash、查询数和环境。Node `22.23.2`，macOS arm64，真实 SQLite `:memory:`，同一数据库分别实例化基线和当前生产 store。合成资料由公开 Store API 写入，不含真人材料、不发网络或付费请求。

每个规模先验证完整 JSON 等价，双方各 warmup 3 次，然后交替顺序各测 9 次，取中位数。计时包含真实事务、SQLite 读取、依赖验证与整个投影；排除 fixture 构建、JSON 序列化和查询计数 instrumentation。SELECT 数单独统计 `prepare` 调用；该路径每条 SELECT 均执行一次。每个计时结果在计时外再核对完整 JSON。

| 合成规模 | 回执数 | SELECT 基线 → 重构后 | 中位数基线 → 重构后 | 本次倍率 |
|---|---:|---:|---:|---:|
| 12 账号 × 20 内容，每项 3 分支 | 1,572 | 260 → 12 | 25.27 → 14.23 ms | 1.78× |
| 60 账号 × 40 内容，每项 3 分支 | 15,720 | 2,420 → 12 | 207.98 → 141.32 ms | 1.47× |

两个规模包含重复枚举、重放、receipt-only、未知/窗外日期、媒体矛盾、更新 revision、回拨时钟、选定与未选分支。大规模输出约 19 MB，未削减历史来换取速度。

**计时限制：** 运行前资源检查为 321 个 Node/npm 进程、21.70 GiB swap；没有启动服务、容器、模拟器或额外全量构建。保留[重构前同实现对照](coverage-baseline.json)：同一基线通过两个模块入口得到约 1.10×/1.12×差异，展示环境/JIT/GC噪声，不能把这种差异当收益。本次两个中位数均改善，但单次样本有重叠；查询消除是确定性证据，倍率不是生产延迟或吞吐承诺。固定 3 分支不能推出任意高分支数的增益；本轮未测文件 I/O、堆峰值或真实 provider。

## 行为验证与复现

先在未修改生产 store 时运行 15 个新特征测试，全部通过；重构后与 24 个既有 coverage 测试一起运行，39/39 通过。新增用例覆盖 revoked 与传递枚举失效、旧 frozen scope 混入新回执、损坏/缺失/外案证据、缺失来源/revision、错误角色、损坏非权威元数据、空/未知分母、owner/case/spec miss。只在损坏存储特征测试中关闭外键后构造非法行，随后立即恢复；不作为生产写入方式。

在仓库根目录运行：

```sh
cd apps/web
node --import tsx --test --test-concurrency=1 src/tests/sprint-coverage-projection.test.ts src/tests/fetch-coverage.test.ts
STRIPSEARCH_COVERAGE_BASELINE_COMPARE=1 node --import tsx --test --test-concurrency=1 src/tests/sprint-coverage-projection.test.ts
node --import tsx scripts/benchmark-coverage.ts --output ../../docs/sprints/2026-10-13/coverage-benchmark.json
node node_modules/typescript/bin/tsc --noEmit --strict --noUncheckedIndexedAccess --target ES2023 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck scripts/benchmark-coverage.ts src/tests/sprint-coverage-projection.test.ts
```

新增测试默认使用显式状态/计数/历史断言与重复读取稳定性检查，适配浅克隆 CI；第二条命令额外执行基线全 JSON 差分，15/15 通过。差分与 benchmark 必须能在本地解析 Git revision `0017e11`，缺少即失败，不自动联网取历史。基线源码通过 `git show` 加载到现有忽略规则覆盖的 `.env.coverage-baseline-<pid>.ts`，`finally` 精确删除；不提交第二份 store。所有 SQLite fixture 在结束后关闭，没有磁盘数据库产物。

输出 hash 绑定一次运行中的合成 ID/时间戳；不同运行会重新生成 ID，故跨运行 hash 可不同。同一次运行的两实现共享同一持久数据，完全比较包括 ID、时间戳、body hash、顺序和全部字段，没有归一化抹掉差异。

后续可独立研究 completion snapshot 的 pinned coverage 批量读取、文件数据库与高分支规模，以及投影输出体积；均需保留当前撤回/范围校验，不能改用长生命周期权威缓存。
