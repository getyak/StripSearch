# 人物研究 Web alpha · 2026-09-26

## 交互与输出

首屏只输入姓名、研究问题或 HTTPS 公开主页。明确主页直接读取，省去来源选择；姓名检索返回候选后确认一次，即使只找到一个候选也不把检索数量当身份依据。候选按账号和运行隔离，确认带修订号，刷新可恢复。主界面呈现阶段、发现和出处，技术预算折叠展示。

同一 canonical 快照派生 Person Object、JSON、Markdown、独立 HTML 和 PDF。Person Object 保存稳定的账号内人物 ID、claim、原文证据片段和未知项。自述、网页陈述与推断分别标记；不将模型生成的陈述自动升级为独立事实。引用片段必须出现在来源中，再经单独模型步骤核对语义与人物归属。模型复核仍可能出错，不能替代人工质量评测。

撤回来源会递归失效后代研究中的依赖，并推进修订号；身份锚点被撤回时人物身份回到待确认。PDF 在渲染后重新核对完整快照，途中发生撤回或删除返回冲突，避免下载过期结论。

## 实际执行

服务端 controller 持久化 checkpoint 与每次动作的 reservation / receipt；模型通过锁定版本的 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2` 决策。每步独立最小 DSH runtime，只开放结构化决策工具；禁 shell、MCP、上传日志、自动重试，隔离 HOME 和环境变量。真正的 DeepSeek 凭据只留在父进程。DSH 当前为预发布依赖，升级须重新验证生命周期和 Linux 容器。

工具覆盖：Exa 搜索 / 正文，GitHub 公开主页，TikHub X 公开主页 / 一页本人帖子，Firecrawl 普通 HTML。每个动作恰好一个供应商 HTTP 请求，无隐藏重试。X 转发、引用作者原文和账号不匹配内容不并入本人表达；帖子保留最多 10 条，分页未覆盖会明确提示。Firecrawl 拒绝 X、PDF 与 AI 摘要路线。

单次上限：12 工具、8 模型请求、150k 输入 / 16k 输出 token、240 秒；预留最后一次模型请求验证 claim。失败、预算耗尽和未知扣费返回已有材料与 partial；进程恢复不盲重试结果未知的付费动作。取消后不继续发布，但仍记录已经返回的消费回执。仅按精确动作复用成功回执，follow-up 复用未撤回的同账号证据。

成本展示为供应商估算 / 目录估价与 credits；缺失用量明确标 unknown。token / 请求上限不等于硬美元账单上限。网页材料截断、社交单页和多轮模型上下文会限制覆盖；当前未承诺采访全集或完整人物图谱。

## 配置、发布与验收

必需 `DEEPSEEK_API_KEY`、`EXA_API_KEY`；可选 `TIKHUB_API_KEY`、`FIRECRAWL_API_KEY`。密钥仅服务器配置，不进入 Git、客户端或报告。PDF 容器包含 Chromium 和中文字体；离线渲染禁止网络、脚本与 Service Worker。

运行检查：`npm --prefix apps/web run typecheck`、`npm --prefix apps/web test`、`npm --prefix apps/web run build`、`npm --prefix apps/web run eval`、`python3 scripts/check_design.py`。合成测试验证执行与安全边界；真实公开账号验收检验供应商和实际报告，两者均不等同于人工质量 benchmark。原始材料和运行回执保存在授权私有工作区，不进入公开仓库。

发布镜像另由 CI 在无外网、非 root、只读文件系统及 noexec 临时目录下执行 `deploy/runtime-smoke.mjs`：真实 DSH runtime 处理一次合成模型响应，再生成中文 PDF 并核对临时目录清理。DSH 关闭原生依赖的临时目录复制缓存，直接加载镜像中锁定的依赖文件；不放宽容器挂载权限。

通过现有不可变 SHA 容器发布，SQLite 先备份，健康和 `/release.json` 不匹配时恢复旧镜像。新增表为兼容迁移，旧 GitHub/Exa 显式 API 和历史报告继续可读。CLI/MCP、电话/邮箱定位、跨平台自动身份合并与批量质量评测不在本次范围。
