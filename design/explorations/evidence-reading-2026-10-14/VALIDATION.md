# 官网与 Web 设计验收

2026-10-15。基线 `20bd69c`，方向选择与实现依据见[体验设计](../../../docs/design/experience-2026-10-14.md)。所有页面内容为原创合成材料；截图不代表真实人物研究结果。文件摘要见 [manifest](evidence/manifest.json)。

## 可见比较

| 页面 | 原版 | 当前实现 |
| --- | --- | --- |
| 桌面首页 | [1440×900](evidence/before-home-desktop.jpg) | [1440×900](evidence/after-home-desktop.jpg) · [整页](evidence/after-home-full-desktop.jpg) |
| 手机首页 | [390×844](evidence/before-home-mobile.jpg) | [390×844](evidence/after-home-mobile.jpg) · [深色/减少动效](evidence/after-home-dark-reduced.jpg) |
| 报告阅读 | [桌面](evidence/before-workspace-desktop.jpg) | [桌面](evidence/after-workspace-desktop.jpg) · [手机](evidence/after-workspace-mobile.jpg) · [深色手机](evidence/after-workspace-dark-mobile.jpg) |
| 人物/账号确认 | [桌面](evidence/before-identity-desktop.jpg) · [手机](evidence/before-identity-mobile.jpg) | [桌面](evidence/after-identity-desktop.jpg) · [手机](evidence/after-identity-mobile.jpg) |
| 未确认同名人物 | — | [桌面双列](evidence/after-ambiguous-desktop.jpg) · [手机单列](evidence/after-ambiguous-mobile.jpg) |
| 出处检查 | — | [桌面](evidence/after-source-desktop.jpg) · [手机深色抽屉](evidence/after-source-dark-mobile.jpg) |
| 其他页面 | — | [登录校验](evidence/after-auth-error-mobile.jpg) · [Fetch 桌面](evidence/after-fetch-desktop.jpg) · [Fetch 手机](evidence/after-fetch-mobile.jpg) · [审阅桌面](evidence/after-review-desktop.jpg) · [审阅手机](evidence/after-review-mobile.jpg) |

[A/B 原型](index.html)保留两种不同结构；设计者选 A，因为真实输入与有据结果同时可见。它不是用户偏好实验。

## 测量与交互

同一浏览器、同一视口、默认字号，页面顶端测量 CSS 像素；[原始基线](evidence/baseline-metrics.json)与[最终测量](evidence/final-metrics.json)保留。

| 视口 | 首个引用距页面顶端：原版 → 当前 | 当前主按钮底部 | 当前页面宽度 |
| --- | --- | --- | --- |
| 1440×900 | 1718 → 493px | 677px | 1440px |
| 390×844 | 2666 → 709px | 493px | 390px |

浏览器确认：320/390/850/1440px 首页无横向页面溢出；850px 访客/已登录均有网站导航；390px 登录错误按钮高 44px。引用显式展开后焦点在视口内，[减少动效证据](evidence/after-citation-visible-mobile.jpg)中披露行位于约 400–444px，动画为 none。报告来源排除后 v2 标记依赖结论待复核，撤销后 v3 恢复；返回原句恢复可见引用焦点。移动出处使用原生 dialog，返回后关闭。未选人物桌面两张卡各约 549px，手机单张 358px；固定确认操作仍可达。

Fetch 只检查空值与授权范围披露，没有提交真实 GitHub 抓取；审阅只载入内存中的原创练习。登录只检查本地错误与焦点，没有把合成身份写入真实账号系统。

## 检查结果与边界

- `npm --prefix apps/web run typecheck`、`build`：通过；没有新增依赖或远程字体。
- `npm --prefix apps/web test`：1410 项，1409 通过、0 失败、1 跳过。跳过维护者上游字节审计，缺少 `PUBLIC_RULE_SOURCE_DIR`；不计为通过。
- 最后的 CSS 修复后：客户端重建及 12 项受影响行为测试通过。最终提交的完整门禁以关联 PR 的 CI 为准。
- 冻结用例 40/40，合成对抗契约 33/33；模型调用 0、外部网络调用 0。数据集完整性与 `python3 scripts/check_design.py` 通过。
- 独立只读 review 检查完整客户端 diff，确认问题均已修复复核，无未解决的确认问题。对比度配对见[设计规范](../../../docs/web-design.md)。

未测真实用户偏好、转化、性能 trace、外部 provider 或公网生产。没有原生客户端交付。布局改进与设计取舍不构成“超过 Ambi”的客观结论。

## 交付记录

实现提交 `c22806aa86116fd25d6330461e3d649e691bbfd2` 已通过单实例管理入口发布。随后独立 `verify` 读回：loopback 与 Tailnet health、release revision、首页及两份入口资源一致；唯一 loopback listener、注册模式 `open`。部署地址、持久数据路径与原始回执保存在部署方私有证据中。

远程分支 `codex/ambi-design-refinement` 已推送并关联 [PR #44](https://github.com/getyak/StripSearch/pull/44)；本轮未合并 `main`、未部署公网宿主。实现提交的 push/PR 共 10 项检查成功；追加本交付文档后继续以 PR 最新提交的 checks 为准。运行源码仍为上述实现提交，交付文档不改变客户端资源。

Notion 现有项目页已原位更新核验日期、main/运行版本、唯一入口与本轮边界，并刷新读回确认。连接工具本次不可调用，使用已登录 UI 完成，没有创建新工作区或改变共享权限。辅助工具按需配置未改，本轮未复核其运行状态。
