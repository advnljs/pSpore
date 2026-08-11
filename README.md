# pSpore

pSpore 是一个基于 [Pi](https://github.com/earendil-works/pi) 的 Linux 本地主动式 Agent。目标是在保留 Pi 极简 agent loop 的前提下，增加持久记忆、权限治理、计划任务、subagent、MCP，以及共享同一后端的 TUI/Electron UI。

## 当前状态

功能 v1 已完成。Phase 0—4 的 Node/Pi 契约、Kernel、私有存储、权限/审批、Shell、pinned memory、exact/BM25、cron/BOOT、durable run ledger、双工 subagent tree、按需 MCP、受信资源生命周期、UDS Daemon、CLI、可重连 TUI，以及安全 Electron 43 客户端均已落地。TUI 与 Electron 同时连接同一个权威 Daemon；桌面 renderer 不拥有 Node 或文件系统权限。

- 原始想法：[initial_design.txt](initial_design.txt)
- 主设计文档：[docs/detailed-design.md](docs/detailed-design.md)
- 项目记忆与导航：[memory-bank/nav.md](memory-bank/nav.md)

运行时基线为 Node.js 24，Pi 精确锁定 `v0.84.1`；最终桌面客户端使用 Electron 43，核心功能先通过 TUI 验证。版本决策见 [ADR 0001](docs/adr/0001-runtime-and-pi-baseline.md)。

## 核心边界

- Linux-first、local-first、单用户；默认不提供多租户或公网服务。
- 主进程与工具默认使用启动 pSpore 的登录用户权限，不构成沙箱。
- `allow_all` 会允许模型以当前用户身份执行任意工具操作；当用户拥有免密或已缓存的 `sudo` 权限时，影响可能扩大到 root。
- skills、Pi extensions、pSpore plugins 和本地 MCP server 都可能执行任意代码，只能在显式信任后加载。
- 默认记忆检索为精确搜索与 BM25；向量搜索保留为可插拔扩展，不属于首版范围。

## 当前可运行流程

要求 Node.js 24。项目使用 npm lockfile；在中国大陆网络环境中可按需使用 npm/Electron 镜像，但不会写入全局 npm 配置。

```bash
npm install
npm run check
npm run test:electron
npm run build

node dist/cli/main.js init
node dist/cli/main.js daemon
```

桌面客户端无需预先手动启动 Daemon；它会初始化缺失的 pSpore home，在没有现有实例时拥有并启动一个 Daemon，已有实例时安全复用。

另开终端后可运行：

```bash
node dist/cli/main.js status
node dist/cli/main.js doctor
node dist/cli/main.js tui
node dist/cli/main.js desktop
node dist/cli/main.js jobs
node dist/cli/main.js runs
node dist/cli/main.js notifications
node dist/cli/main.js agents
node dist/cli/main.js agent spawn "inspect the workspace API"
node dist/cli/main.js agent send <agent-id> "focus on error handling"
node dist/cli/main.js agent join <agent-id>
node dist/cli/main.js agent cancel <agent-id>
node dist/cli/main.js mcp list
node dist/cli/main.js mcp discover <server-id>
node dist/cli/main.js mcp tools
node dist/cli/main.js mcp ping <server-id>
node dist/cli/main.js resources
node dist/cli/main.js resource inspect <staging-path>
node dist/cli/main.js resource install <staging-path> <sha256>
node dist/cli/main.js resource disable <skill|host-plugin> <name> <sha256>
node dist/cli/main.js schedule put examples/jobs/heartbeat.json
node dist/cli/main.js run <job-id>
node dist/cli/main.js cancel <run-id>
```

Daemon 在没有模型配置时仍会 ready，便于检查健康状态；首次 prompt 会明确返回 `model_not_configured`。`deepseek/deepseek-v4-flash` 已通过真实 API 端到端验证。桌面设置可配置 provider、model、Base URL、API 兼容类型、thinking 与 API Key；Key 独立保存到 `~/.pspore/credentials/<provider>.api-key`（`0600`），`models.json` 只保存对该私有文件的引用，不写入 `config.json`、会话或日志。也可继续通过 Daemon 进程环境变量或 Pi 私有 auth store 提供 credential。用户可在 `workspace/jobs/<job-id>.json` 定义严格的五字段 cron job，也可用 `schedule put` 基于 source hash 原子创建/更新并即时重载；示例见 `examples/jobs/heartbeat.json`。CLI/TUI 可列出、手动触发或取消 run，并读取 durable notification。TUI 普通输入创建新 prompt，忙时必须显式使用 `/steer` 或 `/follow`；还可以用 `/agent-spawn`、`/select`、`/agent`、`/agent-join` 和 `/agent-cancel` 操作 child tree。MCP server 在 `config.json` 中使用 `envRefs/headerRefs` 引用环境变量，只有 `trusted-local` server 会被按需启动；`sandboxed` 配置在 v1 中 fail closed。发现后的动态 schema 从下一 session 起生效，当前 session 可使用通用 `mcp_call`。完整快捷命令在 TUI 底部始终可见。

生成或复制来的 skill/host plugin 必须先放在 `workspace/staging/`。`resource inspect` 只执行 schema、路径、依赖、语法和内容摘要检查，不 import 代码；`resource install` 必须回传刚才看到的精确 SHA-256，随后复制到不可变私有目录并写入 trust store。Skills 从下一 session 边界进入 Pi progressive disclosure，常驻上下文只有 name/description/path。Host plugin 使用 `pspore.plugin.json`，安装后还需在 `config.plugins` 固定相同 digest 与完整 capability grant，并重启 Daemon；disable 只撤销信任，不删除内容，也不会热卸载已运行代码。

Electron 可用会自动构建的 `npm run desktop`，或在已有最新构建后用 `node dist/cli/main.js desktop` 启动。AppImage 双击启动时也会自动初始化/启动本地 Daemon；如已有同 home Daemon 则复用，退出时只关闭桌面自己拥有的实例。main process 独占 UDS 连接，preload 仅暴露 `bootstrap/dispatch/getSettings/saveSettings/subscribe` 五个固定 API；renderer 使用轻量原生 DOM、严格 CSP、`contextIsolation + sandbox`，并关闭 Node integration、外部导航、新窗口、下载和网络请求。桌面端采用会话常驻、检查器按需展开的对话优先布局，支持窗口缩放、主/子会话、流式消息、steer/follow-up/abort、审批、run、MCP、受信资源、模型设置与持久化深色/浅色主题切换。

`npm run test:electron` 需要 Linux `xvfb-run`，会构建最新代码、创建临时 pSpore home，并以 `1920 × 1080` 为主基准、补充 `1440 × 900` 与 `1180 × 720` PC 窗口，自动验证外部/桌面拥有两种 Daemon 路径、重连、IPC allowlist、renderer 权限隔离、深浅主题、设置弹层、计算后字号下限、响应式面板收纳、长内容 overflow、transcript scroll、streaming delta、固定 composer 与审批弹层/焦点；成功后清理临时数据。设置 `PSPORE_KEEP_SMOKE=1` 可保留深色、浅色、设置、响应式与审批截图及 JSON 探针。

## v1 之后

默认不继续扩大到 sandbox executor、vector、remote transport、mobile 或插件市场；这些能力只有在明确提出需求并重新评估边界后进入后续版本。
