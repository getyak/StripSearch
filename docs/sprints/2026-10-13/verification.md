# 冲刺验证记录

基线 `0017e11`；日期 2026-10-13。人物/来源资料为合成。独立guarded eval/probe明确零外部请求；旧完整测试harness未默认拒绝transport，外发次数未记录，不能宣称零请求。已发现并已在bootstrap前默认拒绝provider transport并清除5类继承凭据；新增回归与复审通过。结果随当前工作流更新；未运行不写通过。

| 检查 | 状态 | 说明 |
|---|---|---|
| 设计一致性 | 通过（初始） | `python3 scripts/check_design.py`：12 cases / 12 sources；不证明 runtime |
| 完整基线 runtime tests | 1263 pass / 1 fail / 6 skip | 1270 tests；唯一失败为本机 Chromium 10 秒启动限时，PDF 文件独立复跑 7/7 pass；最终继续分离 PDF |
| B targeted tests | 74/74 pass，独立审查通过 | missing URL guard 先红后绿；限定 V8 统计详见 hotspot-tests.md；整合类型错误已修复 |
| C characterization + benchmark | 39/39 pass；15/15 历史差分复核 pass | 两规模 JSON 字节一致；SELECT 260/2420→12；计时 1.78×/1.47×，环境噪声明示 |
| D new contract suite | 33/33 pass；46/46 evaluator tests pass | strict schema/manifest/hash、失败保留与12种禁网探针；synthetic/unreviewed，不是质量 benchmark |
| typecheck / build | 通过 | 修复测试 branded ScopeVersion 类型后3份 tsconfig 通过；client/server/data build 退出0 |
| 完整最终 runtime tests | offline重跑1399 pass / 1 fail / 1 skip | 原两个first-step timeout已修复；新失败为既有DSH SDK关闭时1s SIGKILL退出事件限时遮盖oversized错误；独立完整DSH文件7/7复跑通过、无残留DSH worker；不改写原完整结果；不放宽timeout |
| 原有 eval / eval:research | runtime 40/40 pass；research 11/11 structural pass | runtime model/network calls=0；research 20 planner decisions / 0 model invocations / 0 network-subprocess attempts，token/cost not_measured |
| dataset / design / deployment unit checks | 静态通过；deploy 27/27；evidence gate 33/33 | 合成 probe 23 cases / 134 checks pass，forbidden calls=0；不证明 provider/model 质量 |
| 独立 review / 当前提交 CI | fresh review + P1复审通过；实现提交1cfc92d的10 CI全部成功 | 24文件hash绑定；独立22/22 + 新harness3/3；CI完整Web/PDF及新eval步骤实际success |
| 实际本机发布 / Notion | 本机1cfc92d已验证；Notion blocked login | 单实例管理器成功；Tailnet health/revision/首页及2 assets字节一致，存储run状态计数未变；未验证公网与真人provider |

补充：测试harness新增P1隔离修复已独立复核关闭（3/3，所监测外部fetch=0），相关四文件30/30通过；这是新回归路径计数，不能追溯覆盖历史完整运行。安全缓存清理用官方pnpm prune，仅未使用包/metadata，回收817MB；已核对无活动pnpm安装，保留所有源码/数据库/发布版本。

当前PDF完整文件为6/7通过：首个真实Chromium binary PDF启动限时失败（pdf_unavailable）；其余PDF撤回与无写权限HOME用例通过。同代码基线PDF曾独立7/7通过；正在只复跑失败用例，未修改渲染器或放宽timeout。保留本机资源限制，不声称一次完整本机绿灯；干净CI将承担整套验证。

交付：实现提交1cfc92d的10项CI均completed/success（push与PR各5项）；[Web job](https://github.com/getyak/StripSearch/actions/runs/38408978238/job/115335975823)的完整runtime/PDF、typecheck/build、所有eval与脚本步骤实际成功。失败PDF用例独立1/1通过。机器回执保存各本机日志hash/计数与CI元数据；保留本机失败，未声称单次完整本机绿灯。
