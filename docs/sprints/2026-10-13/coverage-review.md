# Fetch coverage 独立复核（2026-10-13）

结论：**未发现需要修复的 P0 / P1 / P2 问题**。本复核只读检查 C 工作流的生产 diff、新增特征测试与基准，未修改 C 文件；没有重复全量测试或大规模计时。

审查对象：

- `apps/web/src/server/research/fetch-coverage-store.ts`，SHA256 `dd3617f825617cf23cacae2871caeaf6518b0d048f2cb89387a57c29a4244954`。
- `apps/web/src/tests/sprint-coverage-projection.test.ts`。
- `apps/web/scripts/benchmark-coverage.ts`，SHA256 `fdac5eedec194a1f41e15c0d46523518e67d5f3554c72dc1a4d747374abc67f3`。
- [基准说明](coverage-benchmark.md)与 [原始数据](coverage-benchmark.json)。两个记录的生产/harness SHA256 与本次读到的文件相同。

## 已核对的行为边界

1. **同事务与 owner/case。** `getFetchCoverageView` 外层 SQLite transaction 保留；`getCurrentCompletionSnapshot` 的嵌套事务仍使用同一 DB。source JOIN 由 `s.case_id` 限定，evidence 由 `case_id` 限定；账号仍通过 `listAccounts(ownerId, caseId)` 加载。新 map 附加 `caseId` 没有把外案 evidence 纳入当前案例。冻结 scope 已在相同快照读到，随后 snapshot 缺失时 fail closed。
2. **数据等价。** 旧 `reportView` 额外派生的身份/claim/coverage 字段原投影并未消费；替代读集保留实际使用的账号、来源 revision/publishedAt、证据角色/账号/撤回标记。最新 revision 仍取持久记录最大 revision，没有改用 latest 指针推断正文；`dependencyValidationMap` 仍是 GET-60 共同权威。
3. **历史与撤回。** 原始 receipt 查询仍为 `ORDER BY seq ASC`。局部 dimension bucket 仅按相同 `fetchDimensionKey` 分组，未过滤旧/撤回记录、未按时钟排序；frozen-scope 内最后一条优先规则与完整 history 保留。分支 parents 仍取该分支最后一条回执，与选定分支观测合并。跨调用无授权缓存。
4. **扫描成本。** dimension bucket 消除各分支重复扫描整项 receipts；account bucket 消除每账号重扫全部 items。索引只保存原对象引用并在单次调用内构造；输出仍保留每条 history。后续固定维度统计与 GET-60 pinned coverage 读取未宣称已全部优化。
5. **基准工作量与措辞。** 两实现使用同一真实 SQLite 数据和同一生产入口，逐次完整 `JSON.stringify` 比较，未先删历史或归一化差异。双方各 3 次预热、9 次测量且交替顺序；序列化和 SELECT instrumentation 在计时外。原始数据保存全部样本并明确高 swap/进程噪声、固定分支数、无生产延迟保证。SELECT 计数描述为 `prepare` 次数，未伪称 DB profiler 指标。

## 独立执行证据

在 `apps/web` 执行：

```bash
STRIPSEARCH_COVERAGE_BASELINE_COMPARE=1 node --import tsx --test --test-concurrency=1 src/tests/sprint-coverage-projection.test.ts
```

结果 **15/15 通过，0 fail / skip**。本次实际加载 Git `0017e11` 的原实现，逐字比较完整投影，覆盖正常/空/未知分母、撤回及传递依赖、scope 漂移、新旧回执、角色/账号/外案证据、缺失 source/revision 和损坏非权威 metadata。

默认浅克隆 CI 路径不加载历史基线，执行固定语义断言与同实现重复读取；因此仅在显式设置上述环境变量时称作 baseline differential。现有文档已作此区分，本次独立运行实际启用它。

## 保留限制

本次没有独立重跑 240/2400 项计时，因此倍率属于 C 已保存且 hash 匹配的测量记录；复核确认的是方法、工作量与输出等价策略。文件数据库 I/O、高分支规模、堆峰值和跨进程并发都未在本次复核中验证，不影响本次局部行为保持结论，也不据此宣称全系统性能或发布完成。
