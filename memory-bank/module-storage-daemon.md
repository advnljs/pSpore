# Module: Storage and Daemon

## 模块职责

初始化私有 pSpore home/workspace/state，提供同目录原子替换与 append-only JSONL，使用 PID + Linux process start identity 实现单实例锁，并组装/关闭 Daemon 与 CLI。

## 入口文件

- `src/storage/home.ts`
- `src/storage/atomic.ts`
- `src/storage/daemon-lock.ts`
- `src/daemon/daemon.ts`
- `src/daemon/supervisor.ts`
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
- `DaemonSupervisor.start/stop`：GUI/TUI 共用 owned/external Daemon 生命周期。
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
- 共享 supervisor 的 `owned/external` 决策必须经过同一单实例锁；只有 `owned` 实例随 GUI/TUI 退出。
- stop 即使某一步失败也继续尝试关闭 approval/session/gateway 并释放 endpoint/lock，最后回报首个错误。
- monthly run JSONL 只把完整 newline 视为 commit；破损尾行备份后截断，中间损坏拒绝启动。
- job JSON 使用 source hash compare-and-swap + atomic replace；notification 使用 `state/events/notifications.jsonl` durable append。

## 常见修改点

config migration、目录 schema、retention、event/run persistence、session mapping/recovery、shutdown grace deadline 与 CLI diagnostics。
