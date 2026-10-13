# B 工作流独立审查

审查结论：**没有确认的未解决 P0/P1/P2/P3 问题**。独立执行三份新增测试，74/74 通过。此结论针对下面的源码与离线合成测试，不证明真实人物识别效果、外部 provider 或线上发布。

## 审查范围

- `apps/web/src/server/research/first-step-discovery.ts` 中 `verifyFirstStepModelProposals` 的一行 URL 回执绑定修复。
- `apps/web/src/tests/sprint-hotspot-identity.test.ts`。
- `apps/web/src/tests/sprint-hotspot-runtime.test.ts`。
- `apps/web/src/tests/sprint-hotspot-search.test.ts`。

审查者为独立 `coverage_refactor` 子代理，未实现或修改上述文件。对照 `0017e11` 的相关原实现及既有 `first-step-search`、`first-step-semantic`、`research-runtime`、`search-agent` 用例；检查真实 checked Search → toolkit → metered ledger 的 `request: action` 写入链。

审查绑定 SHA-256（工作树尚未提交）：

| 文件 | SHA-256 |
|---|---|
| first-step-discovery.ts | `4d63f06bc2f6cf11703909c0e3a7bdbf52a332f9a8c16c06c751ec350a2b6e01` |
| sprint-hotspot-identity.test.ts | `63f625a4ad51488ce799d3fe973ce84f364bd968072d04546bcb4b4e704aa3af` |
| sprint-hotspot-runtime.test.ts | `ebf228e3a50681393ffd9562acb815d9b14ebfa7d3c9ed7b39a782530b8245fb` |
| sprint-hotspot-search.test.ts | `fc84967ae8ad4fd43375aeb08abbea9fed290ddf0e29c75027076bb2ef4fce3f` |

## 检查结论与价值

1. **URL 来源绑定。** 新 guard 在 `comparableUrl` 前要求 URL 为非空字符串；缺失、`null`、number、空字符串、全空白和不同来源 URL 均拒绝。有效同来源 URL 沿用原比较规则，未扩大目标 URL 或账号权限。模型有单独已读正文不能替代请求回执与来源的绑定。
2. **真实账本兼容。** 生产 checked reader 以真实 action 写入计量账本，获准的 `read`/profile action 已包含 URL；新 guard 对这些路径保留原行为。新增合成 transport 正例使用真实 Store/toolkit，验证一次读取、重放、原 request key/时间和费用；拒绝表验证无外部调用、无预留或计费写入。
3. **测试增量。** 原用例已覆盖部分不匹配回执、否认与 scope drift；新增价值是缺失 URL 可绕过的具体回归、精确 Unicode/空白字节、组织来源到共享 assessment 的候选降级、17 类 authority 变更在模型前后两个窗口、真实持久 scope 变更期间迟到模型响应，以及 malformed usage 的明确无 dispatch/无伪用量结果。这些测试调用生产校验器和 stores，未用同构伪实现证明自己。
4. **隔离与收尾。** 变更 authority 的每个子例有新 SQLite `:memory:`，通过 `t.after` 关闭；组织/否认/混批次用例独立创建输入，明确断言 verifier 不改输入与 model proposal。Search 仅注入合成 HTTP transport，runtime 模型是本地假响应；未启动服务、浏览器、模拟器或真实模型。此轮审查未修改生产输入或外部系统。

审查中建议补充非字符串、`null` 与纯空白 URL 的参数化用例；B 作者已补齐，独立复跑通过，建议已关闭。没有其他需要阻断交付的发现。

## 独立验证

在 `apps/web` 目录执行：

```sh
node --import tsx --test --test-concurrency=1 src/tests/sprint-hotspot-identity.test.ts src/tests/sprint-hotspot-runtime.test.ts src/tests/sprint-hotspot-search.test.ts
```

结果：15 个顶层 test、74 个含子项测试，74 pass / 0 fail / 0 skip。未重跑全仓构建/测试；父任务负责最新集成树的完整检查。本审查不把离线成功当作质量或发布验收。
