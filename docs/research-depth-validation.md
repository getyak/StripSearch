# 有界研究深度修复验证

2026-10-02，关联 GET-132。范围见 [深度契约](research-depth-contract.md)。真人资料与原始供应商回执保存在授权私有工作区，没有纳入 Git。

- TypeScript typecheck、完整 client/server/public-data 构建通过。
- 全套离线测试：645 项，644 通过、1 跳过、0 失败；随后研究过程展示修复的 5 项 DOM 测试通过。供应商调用均使用合成回放；没有启动 iOS 或 Docker。
- v2 控制器回放：11/11 structural pass，0 hard failure，20 个规划决策，0 模型调用，0 外部网络/子进程尝试。它只验证程序行为，案例未人工裁决，不能报告研究质量得分。
- 独立 sub-agent 审查和复核关闭全部 P1：搜索覆盖原文、已撤回来源派生证据、URL 变体丢依赖、社交帖子绕过账号撤回；无残留 P0/P1。审查另验证两代 follow-up 的祖先撤回传播。
- 实际浏览器离线验收：单用户名 → 候选确认 → 一个读取分支失败且另一分支成功 → 有出处的 partial 报告；五类研究问题区分有核验材料/待补查，撤回后重新计算。合成材料不代表真实自主规划。
- `python3 scripts/check_design.py`、`python3 scripts/check_eval_datasets.py`、`git diff --check` 通过。静态和数据完整性检查不衡量模型质量。

早期未完整构建公共 data bundle 的全套运行失败；完成 `npm run build` 后重跑通过。历史 v1 数据与证据未改写，v2 的期望变化明确记录。

会话中的 Search/Fetch 连接器已读取获授权账号的公开网站、机器身份文件、原创文章与具体 GitHub PR；X/知乎等读取失败仍保留缺口。生产 Web 服务的真实自主规划尚缺已有 Exa/DeepSeek 服务配置位置，未执行 live 全链路验收。24 页面容量、完整历史/评论分页及新 Search/Fetch 长研究运行时仍未交付，GET-132 保持进行中。
