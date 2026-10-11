# 单实例本机服务与发布契约

StripSearch 本机常驻服务只有 Web：一个 launchd job、一个 loopback listener、一份持久数据库、一个 Tailscale HTTPS 入口。Search / Discovery / Fetch 是这个 Web 进程内的角色，不单独启动副本。公网部署是独立宿主的交付目标，不能把两个宿主的数据合并。

`python3 deploy/local_service.py --config <private-config.json> update --repo <checkout> --revision <full-sha>` 是本机更新入口。修改必须先经过离线检查、review 和提交；更新入口从指定提交构建，不接受未提交源码。成功的含义是 loopback 和 Tailnet 的 health、release revision、首页与全部入口资源字节均核对通过。`status` 查看实际版本，`verify` 重新校验，`start` / `stop` 幂等控制同一个 launchd job。

发布前构建，服务停写后备份 SQLite 与 auth-secret。数据库和密钥独立于发布目录。失败时先停新写入者、保留失败数据现场，验证并恢复旧数据库/密钥后才启动旧版本；恢复失败则保持停止。每次更新只协调配置中属于本应用的 Tailscale port，禁止 reset、Funnel 或更改其他项目入口。同一提交重复 update 不重建或重复启动，但仍执行 Tailnet 校验。保留当前、上一版本及至少最近五个已验证提交版本；不按目录年龄删除回滚版本。

生产依赖按锁文件与 Node 版本缓存，`npm ci --omit=dev` 安装；构建依赖可以显式复用已核对锁文件的开发安装。禁止手工删传递依赖：DSH 的依赖树仍承担受限模型执行，SQLite、PDF/Chromium 与认证保留。删除缓存前核对发布引用与活动进程，不删除源码、worktree、数据卷或其他任务内容。

Label Studio / Identity Desk 与 promptfoo / 身份网关是辅助工具，默认按需启动，不随登录启动。`tools start annotation|evaluation` / `tools stop annotation|evaluation` 通过同一管理入口启停各自必要组件及所属 Tailnet 入口；其数据、密钥与原生能力保持独立，运行辅助工具时实际进程数会增加。网关身份及 Origin 检查不能因服务整合被绕过。

完成发布后，读回 Notion 项目工作区并更新核验日期、主分支与运行版本、唯一常驻入口、辅助工具状态和未验证能力。Notion 更新失败必须单独报告；不能用页面旧状态宣称发布已完成。具体私有路径、Tailnet hostname、Notion ID、凭据保存在部署方私有配置/交付证据中，不提交。

配置字段见 `deploy/local_service.example.json`；`node`、`npm`、`tailscale` 为绝对可执行路径，`stateDir`、`dataDir`、`envFile` 和可选 `buildDependencies` 均由部署方提供。首次接管旧服务必须同时配置其 PID 与精确工作目录，拒绝终止其他 listener。

依据：[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)、[launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)、[npm ci omit](https://docs.npmjs.com/cli/v11/commands/npm-ci/)、[SQLite backup](https://www.sqlite.org/backup.html)。这些机制已用于本机交付；不代表外部 provider 或人物研究质量通过验收。
