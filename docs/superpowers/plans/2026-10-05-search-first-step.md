# 多平台发现与账号选择 Implementation Plan

> **For agentic workers:** Use the user-authorized Pi/MiMo coding workflow for implementation batches; Codex owns architecture, independent review and real acceptance. No recursive delegation. Steps use checkbox tracking.

**Goal:** 将已批准的多平台 Search、人物辨识与一次账号范围确认接入实际 Web 入口，验证选定账号交给 Fetch 的链路。

**Architecture:** 沿用现有 Express、认证、动作账本与 SQLite CaseStore。独立第一步协调器复用既有搜索/读取工具与策略，用真实回执构建发现投影；选择通过 CaseStore 原子范围变更；前端从同一投影渲染并提交版本绑定选择。旧报告保留，旧暂停任务显式扩展，新的生产任务启用新流程。

**Tech Stack:** Node 22.23.2、TypeScript、Express 5、Better Auth、better-sqlite3、现有 Exa/DSH/TikHub/GitHub 适配器、原生 DOM/CSS、node:test/tsx/jsdom。

**Spec:** `docs/superpowers/specs/2026-10-05-search-first-step-design.md`

## Global Constraints

- 用户已选择 Pi/MiMo Pro 实现与 Codex 独立验收；无需再次选择执行方法。
- 既有 dirty README/部署修改不属于本任务；在独立冻结 worktree 工作。
- 不改注册策略、凭据、人工标签或冻结 v1/v2 与旧真实评测输出；不将 Token Plan Key 放进产品后端。
- 离线测试不访问网络/付费 API，不读取 example.org/.com/.net 夹具 URL；不引入新依赖。
- 默认建议、用户选择、身份支持、访问覆盖与读取权限分开；缺回执保持未观测；任何失败不记无账号。
- 本批完整交付第一步与受选定范围约束的现有 Fetch 交接；全历史/评论/全平台可读性依旧逐能力报告。

## Review Focus

- 主页 URL 直接输入也必须显示关联账号选择，不能绕过范围直接跨平台读取；Task 2/3 增加 URL 输入回归。
- 同名或组织/粉丝候选不混人；Task 1/2 测试冲突、第三方与同平台多账号。
- 双击提交、旧发现版本、跨 owner、改目标后迟到返回；Task 3 逐项验证原子失败、幂等与作用域失效。
- 手工补链、部分供应商失败、已开始但未知结果；Task 2/3 测试新修订与失败回执，不自动重放。
- 移动端操作区、证据入口误勾选、草稿被 SSE 覆盖；Task 4 测试并进行真实桌面/手机宽度验收。

## 文件与接口边界

- 新增 `shared/first-step-discovery.ts`：版本化 `FirstStepDiscoveryView`、`FirstStepAccountView`、`FirstStepSelectionInput` 与严格验证；复用 research-case 的五个分面，不复制事实库。
- 新增 `server/research/first-step-discovery.ts`：`discoverFirstStep(context): Promise<FirstStepDiscoveryView>`；context 提供 Store/owner/run、仅 Search 可用的 checked tool/model 回调、signal、冻结批次策略与目录；没有任意 fetch 或 shell。
- 新增 `server/research/first-step-store.ts`：run→CaseStore 链接、追加发现修订、批量选择事务和幂等回执；`getFirstStepView(ownerId,runId)` 与 `applyFirstStepSelection(ownerId,runId,input,idempotencyKey)`。
- 新增 `server/routes/first-step.ts`：认证后的 discovery、selection、expand/补线索入口；旧 resume 兼容历史读取，不能绕过新任务的批量选择。
- 新增 `client/first-step.ts`：独立受控渲染器与草稿状态，整合 main.ts/api.ts；样稿是视觉参考，真实状态只来自服务端。
- 受影响现有文件：controller/planner/research-store/toolkit/tool-contracts、services/runner、store/schema、routes/runs、shared/types/canonical、client/main/api/index/styles；必要导出投影同步，不做无关重构。

### Task 1: 发现投影与证据规则

**Produces:** 上述 shared types；账号保守键、真实证据投影及默认建议规则。

- [ ] 写 `first-step-discovery.test.ts`：主页根路径、About、GitHub、X、YouTube @/channel-ID、Substack 出版物、Mastodon 实例、Scholar user、同平台多账号与不安全 URL。
- [ ] 运行目标测试观察缺失新契约的失败。
- [ ] 实现身份/平台归一与证据规则：只有实际来源中的明确、角色正确的关联可支持归属；同名/handle/头像只候选；搜索索引不当原文；同源不算独立证据。
- [ ] 验证测试通过；原始证据与冲突保留，不靠丢候选通过。
- [ ] 提交完整共享契约与规则。

### Task 2: 可持久化 Search 与实际 Web 接线

**Consumes:** Task 1 投影与验证。
**Produces:** `discoverFirstStep(context)`；新 production run 的第一步 checkpoint、真实回执、人物簇与逐平台路线状态。

- [ ] 写协调器合成回归：姓名不得因第一条 LinkedIn 就暂停；个人站自链扩展出多个材料类型；一个平台失败不掩盖其它成功；同名簇分开；URL 输入进入范围确认。
- [ ] 运行回归看到旧单次搜索行为失败。
- [ ] 实现初始宽召回与自链扩展、受限 Search 模型决策与服务端支撑校验；适用完整目录义务保留，缺适配器/访问/线索明示，不盲扫 4421 条规则。
- [ ] 接入现有工具预算/尝试账本、取消、重启、来源回执与阶段事件；新生产 run 默认启用，旧 checkpoint 与冻结 replay 保留旧版本语义，旧 paused 可显式 expand 新修订。
- [ ] 扩展 toolkit 搜索可配置结果数（历史请求默认 5 不变）；Search 仅读取身份所需资料，不启动帖子深读。URL 分类不再依赖旧白名单误丢候选；真实请求失败保留 unknown/blocked。
- [ ] 运行目标测试、typecheck 并提交。

### Task 3: 原子选择与 Fetch 范围约束

**Consumes:** Task 2 的 current discoveryRevision 与真实 CaseStore 账号。
**Produces:** 版本绑定的批量选择、选定 ScopeVersion 及受范围约束的 Fetch 入口。

- [ ] 写 `first-step-selection.test.ts` 与 `first-step-scope.test.ts`：跨 owner、外来账号、旧 run/scope/discovery 修订、重复/冲突幂等键、零选择、整批回滚、选择不升级支持、排除后零深读。
- [ ] 运行测试观察旧 resume 单链接无法表达上述事务。
- [ ] 实现 selection route：同一个数据库事务验证所有版本/账号、调用 CaseStore 范围原子变更、绑定 checkpoint 与 run 状态；提交失败不推进。明确用户排除声明与取消勾选不同。
- [ ] 实现手工线索/expand 新发现尝试；不能伪装已有回执为新发现。新候选保持 unanswered，新增范围需显式提交。
- [ ] 每次 Fetch 派发/提交检查当前 ScopeVersion 与权限；未选账号或新关联账号不自动深读/混入人物结论。归属未定的选定账号只走明确独立范围；若现有 Fetch 无法可靠隔离，则明确阻止同人混合并给可执行路径，不能默默当同人。
- [ ] 验证刷新/重启、取消与迟到结果的失效；更新同一 canonical 导出投影并提交。

### Task 4: 真实页面的视觉与交互

**Consumes:** `GET discovery` 权威投影、Task 3 selection/expand 响应。
**Produces:** 同一页完整第一步；真实 SSE 状态与可恢复草稿。

- [ ] 写 `first-step-ui.test.ts`：建议不写 userSelection、checkbox 与证据按钮分离、排除撤销不自动选中、同名切换不漏旧范围、SSE 不覆盖草稿、错误与保存中状态、零选择禁用。
- [ ] 实现真实人物摘要、用途分组账号卡、证据/反证面板、发现状态、次要补线索入口与唯一主按钮。
- [ ] 复用既有绿色品牌、系统字体、清楚层级与克制动效；360px 单列、桌面两区、200% 缩放、键盘焦点、减少动态效果。移除重复 URL 和与当前阶段无关的报告操作/追问噪声；不改全站无关界面。
- [ ] 运行 UI 测试、完整 Web test/typecheck/build、静态 design 检查和冻结 replay；只修真实回归，冻结标签不变。
- [ ] 提交实现与能力/失败边界说明。

### Task 5: 独立验收、真实 Agent 与运行服务

- [ ] Codex 审查当前 head 的 diff、非跟踪文件、真实回执与 scope 边界；运行独立 Pi/MiMo review 并关闭所有已确认重大问题。
- [ ] 独立隔离测试账号/数据库验证真实 API→队列→Search→SSE→页面→selection→Fetch；提供桌面和移动截图、控制台/网络/时序证据。先 CUA，不可用时记录原因并使用任务已授权的非 Browser 渲染测试；不绕过 TLS。
- [ ] 冻结新 Agent/代码/工具配置，用现有被授权人物的原始姓名/URL查询跑第一步，评审侧对照 63 条参考；不输入期望账号清单；保留旧失败和所有新未知。
- [ ] 发布到用户正在使用的应用服务前保存数据库备份、旧构建与 PID/启动方式；不覆盖并行部署修改，不变更其它 Tailscale 路由；实际新构建访问 14443 读回并验证。
- [ ] 保存精确 head 的验收证据与已知缺口，再清理本任务测试进程与临时产物；不清理其它任务、Docker 或模拟器。

## 95 分验收约定

这是可复核目标，不是模型自报成功。评分与范围在真实运行前冻结。

- Agent 效果 40：已标注选择账号的必备召回 20、归属建议与证据正确性 15、平台与失败覆盖 5。
- 用户交互 25：姓名只需一次范围提交、选择反馈、纠错、同名消歧、草稿/刷新/错误状态，每项有实际操作证据。
- 视觉与可访问性 25：层级/辨识、账号阅读、证据就近、移动布局、键盘与缩放，每项由截图和操作验证。
- 链路可靠性 10：队列/SSE/取消/恢复/版本与权限/真实调用账本验证。
- 严重错人、伪造来源、越权读取、静默扩范围、原始记录被覆盖或关键流程无法提交，任何一项失败都不能声称 >95。
- 未验证项不记满分；独立模型审美分只是评审意见，不能替代功能、真实 Agent 指标或用户满意度。只报告已证实的分项与不足。

## 执行记录

- 2026-10-05：用户已明确授权完整实现和全链路测试，保留既定 Pi/MiMo 执行方式；不再增加同一工作的重复审批。
