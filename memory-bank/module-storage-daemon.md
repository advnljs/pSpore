# Module: Storage and Daemon

## 模块职责

初始化私有 pSpore home/workspace/state，提供同目录原子替换与 append-only JSONL，使用 PID + Linux process start identity 实现单实例锁，并组装/关闭 Daemon 与 CLI。

## 入口文件

- `src/storage/home.ts`
- `src/storage/atomic.ts`
- `src/storage/daemon-lock.ts`
- `src/daemon/daemon.ts`
- `src/daemon/supervisor.ts`
- `src/service/system-service.ts`
- `src/service/service-launch.ts`
- `src/service/legacy-daemon.ts`
- `src/sessions/session-catalog.ts`
- `src/sessions/session-file.ts`
- `src/cli/main.ts`

## 关键文件

- `src/config/config.ts`：严格、拒绝未知字段的 v1 配置 decoder。
- `test/unit/config-home.test.ts`、`test/unit/daemon-lock.test.ts`。
- `test/integration/daemon.test.ts`。

## 对外接口

- `initializePsporeHome` / `loadConfig` / `psporePaths`
- `atomicWriteFile` / `atomicWriteJson` / `appendJsonLine`
- `acquireDaemonLock` / `writeEndpoint`
- `DaemonAlreadyRunningError`：为桌面端复用已有实例提供可类型化的单实例分支，不匹配错误文本。
- `PsporeDaemon.start` / `stop` / `whenStopped`
- `SystemServiceManager.ensureRunning/restart/status/logs/uninstall`：生产 GUI/TUI 共用 systemd user service 管理。
- `serviceLaunchSpec`：为 npm/Node、SEA 与 Electron-as-Node 生成无 shell 的稳定 `ExecStart`。
- `SessionCatalog.list/get/add/touch`：严格、原子地维护交互式根 session 与 Pi JSONL 的映射；首次升级只迁移最近的 legacy JSONL 为 `main`。
- `resolveSessionFile`：在保持 JSONL/root/real parent 边界校验的前提下，允许 Pi 延迟创建的叶文件暂时缺失；已有文件仍须为 regular file。
- `DaemonSupervisor.start/stop`：仅供隔离 smoke 使用的 owned/external 临时 Daemon 生命周期。
- CLI：`init | daemon | status | doctor | tui | desktop | config | jobs | runs | notifications | agents | mcp | resources | schedule put | run | cancel | prompt | version`

## 内部依赖

Daemon 组装 Kernel、Application、Pi adapter、policy/approval、Shell、基础 tools 与 LocalGateway；Storage 本身不依赖这些上层模块。

## 外部依赖

Node.js 24 filesystem/process/net API 与 Linux `/proc/<pid>/stat`。

## 注意事项

- home/运行目录为 `0700`，配置、workspace 模板、lock/endpoint/approval/audit/artifact 为 `0600`。
- 初始化使用 create-only，不覆盖已有 workspace 文件；配置存在但 malformed 时 fail closed。
- atomic write 在同目录 write + fsync + rename + directory fsync，失败时清理临时文件。
- stale lock 不能只依赖 PID，必须同时核对 process start identity；release 只删除本 instance lock。
- 生产 GUI/TUI 退出不得停止服务；systemd unit 使用 `Restart=always`、`WantedBy=default.target` 与 `UMask=0077`，并尽力启用 linger。
- unit 参数直接交给 systemd，不经 shell；路径中的 `%`、反斜线与引号必须正确转义。自定义 home 使用带 SHA-256 短摘要的独立 unit 名。
- legacy owned daemon 不能被 systemd 收养，首次迁移只允许通过 `daemon.shutdown` 协议优雅停止，再启动 service。
- service ready 前恢复 catalog 中全部根 session；损坏/越界记录 fail closed，单个 runtime resume 失败会让服务进入 degraded，但不会删除历史文件。
- Pi `SessionManager.create/newSession` 返回路径后由 adapter 立即以 `wx/0600` 写入当前 header/entries，再让 manager 从该文件重载并进入 flushed 状态；catalog 中安全父目录下缺失的旧 JSONL 在 resume 时同样重建，避免空占位破坏 Pi 首次持久化语义。
- stop 即使某一步失败也继续尝试关闭 approval/session/gateway 并释放 endpoint/lock，最后回报首个错误。
- monthly run JSONL 只把完整 newline 视为 commit；破损尾行备份后截断，中间损坏拒绝启动。
- job JSON 使用 source hash compare-and-swap + atomic replace；notification 使用 `state/events/notifications.jsonl` durable append。

## 常见修改点

config migration、目录 schema、retention、event/run persistence、session mapping/recovery、shutdown grace deadline 与 CLI diagnostics。


## 2026-09-07：config.json 增量升级

- `parseConfig` 先经 `withConfigDefaults(value, home)` 按段/按键补齐缺失默认值：已有值一律保留，缺失键取 `defaultConfig(home)`，未知键仍严格拒绝（拼写错误不会被静默吞掉）。
- `initializePsporeHome` 通过 `sectionsComplete` 判断存储文档是否已含本版本全部键；缺键时把合并结果原子写回 `0600`。
- 效果：overlay 只替换应用文件也不会因为新版本新增配置段而启动失败，用户已有取值（自定义 workspace、并发上限、权限模式等）一字不改。
