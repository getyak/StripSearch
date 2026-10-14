# 证据阅览室 Implementation Plan

> **For agentic workers:** Execute with Pi + MiMo under the existing delegation preference. Codex owns independent review and delivery. Steps use checkbox syntax for tracking.

**Goal:** 深度改版官网与现有 Web 界面，使证据、身份与未知的层级成为品牌语言。

**Architecture:** 保持 Express/SQLite、canonical report 与全部 API 不变。重组静态首页，统一共享 CSS token 与组件，简化首页动作控制器；既有业务状态继续由原控制器产生。

**Tech Stack:** Node 22.23.2、原生 TypeScript、CSS、Vite、node:test/jsdom。

**Spec:** [体验设计](../../design/experience-2026-10-14.md)。

## Global Constraints

- 保留当前路由、导航名称、表单 ID、认证与注册默认策略。
- 不调用网络/付费 provider 或模型；不获取 example.org。
- 公开例子仅用原创合成 Lantern/林舟材料；不提交私有资料、本机路径或密钥。
- 不将身份归属、事实、推断、未知合并；来源撤回与导出依赖不变。
- 不添加重型 UI/动效依赖、远程字体与无意义装饰循环。

## Review Focus

1. 390×844 与 320px 长中文、长 URL 时主操作仍可见，无横向页面溢出。
2. 深色、减少动效与无 IntersectionObserver 下所有来源和未知仍能读。
3. 首页引用与 dialog 的键盘焦点、Escape 和返回触发点不回归。
4. 多账号候选与展开证据不挤掉固定确认栏，不改变选择语义。
5. Fetch 的授权、未知结果与标注未保存保护不受通用样式影响。

### Task 1: 官网与引用物

**Files:** 修改 `apps/web/src/client/index.html`、`styles.css`、`home-motion.ts`；对应 `src/tests/home-motion.test.ts`。

**Interfaces:** 保留 `createHomeMotion({doc?,win?})`、`setActive(boolean)` 与 `dispose()`；真实研究表单、合成引文事实与来源 IDs 保留。默认稳定展示证据，不靠滚动搬移 DOM。

- [x] 重构首屏：真实输入 + 分层材料页中的有据内容/出处/未知。
- [x] 将后续身份与证明段改为不同布局族，简化价格展示但保留尚未收费边界。
- [x] 用显式引用展开替代自动阶段叙事，保留静态降级与清理。
- [x] 更新该控制器的实质行为测试，验证禁网、焦点、关闭/切页清理；不削弱既有业务测试。

### Task 2: Web 共享语言

**Files:** 修改 `styles.css`；必要时最小修改 `main.ts`、`render.ts`、`first-step.ts`、`fetch.ts`、`review.ts`、`auth.ts`。

**Interfaces:** 原控制器和 API 不变，样式从共享语义 token 派生。

- [x] 统一环境/主阅读/出处的层级、字阶、边框、输入、按钮、dialog 与状态。
- [x] 完成人物确认、报告、来源、登录、Fetch 和标注的浅深主题与响应式。
- [x] 运行 typecheck、客户端构建、受影响 client/controller tests 和设计检查。

### Task 3: 独立验收与交付

**Files:** 更新 `docs/web-design.md`、本设计验证记录，永久证据仅含合成状态。

- [x] Codex 用浏览器复核桌面、平板、390/320、主题与减少动效，修正可见问题。
- [x] 独立 reviewer 检查真实 diff；关闭确认的 P0/P1，复核修复。
- [x] 运行全套适用离线检查与构建，保存确切计数和未测事项。（typecheck / build / test 1409 通过、0 失败、1 跳过 / check_design 全过；详见[体验设计实施记录](../../design/experience-2026-10-14.md)）
- [ ] 提交并按单实例发布契约更新本机服务，核对 health/revision/assets；记录实际远端交付范围。
