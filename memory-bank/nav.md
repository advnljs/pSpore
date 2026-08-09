# Project Navigation

## 当前重要文件

| 路径 | 用途 |
|---|---|
| `README.md` | 项目入口、当前状态、安全边界和下一步 |
| `initial_design.txt` | 用户原始 11 条设计思路，不作为最终契约 |
| `docs/detailed-design.md` | 当前唯一完整详细设计与 v1 验收契约 |
| `docs/adr/0001-runtime-and-pi-baseline.md` | Node 24、Pi/Electron 锁定与 Phase 0 兼容决策 |
| `package.json` / `package-lock.json` | npm 工程、精确依赖、构建与验证命令 |
| `src/pi/pi-runtime-adapter.ts` | 唯一 Pi SDK 边界与领域事件映射 |
| `src/shell/shell-service.ts` | Linux login shell、pipe/PTY、artifact 与 secret 脱敏 |
| `src/daemon/daemon.ts` | Daemon 组装、ready/draining/stopped 与资源清理 |
| `src/application/agent-application.ts` | UDS command use cases 与 per-session 串行化 |
| `src/kernel/` | 纯 reducer、权威 state 与串行 effect loop |
| `src/storage/` | home/config 初始化、atomic write、JSONL、PID+start lock |
| `src/policy/` | capability/risk、审批持久化、scope grant 与 Pi tool gate |
| `src/tools/core-tools.ts` | read/edit/search/shell 固定基础工具 |
| `src/memory/` | pinned loader、daily/curated memory、tokenizer、BM25 与增量 search cache |
| `src/automation/` | cron adapter、job parser、run ledger、scheduler 与 Daemon executor |
| `src/agents/` | subagent tree、独立 session、双工 mailbox、budget/permission ceiling 与 bundled tools |
| `src/mcp/` | MCP 严格配置对应的 lazy transport、schema 激活、结果 artifact、audit、health 与 bundled tools |
| `src/notifications/` | durable notification store、run delivery 与 notify tool |
| `src/protocol/` / `src/gateway/` | v1 envelope、严格 decoder、UDS client/server、幂等/replay |
| `src/ui/tui/` | Pi TUI 客户端、协议 store、160×45 renderer |
| `src/cli/main.ts` | init/daemon/status/doctor/tui/prompt/version 入口 |
| `.gitignore` | 未来 Node 产物、环境文件、私钥与本地 pSpore 数据排除 |
| `memory-bank/specs.md` | 用户约束与验收标准 |
| `memory-bank/architecture.md` | 架构摘要、边界、决策与历史 |
| `memory-bank/todo.md` | 尚未实施的阶段和风险 |
| `memory-bank/overall-progress.md` | 已实际完成的阶段成果与验证 |

## 模块说明

- `module-kernel-runtime.md`：Kernel、Pi adapter、状态与生命周期。
- `module-memory-search.md`：pinned memory、exact/BM25、写入与检索。
- `module-policy-shell.md`：权限、审批、Shell、PTY、sudo 与安全。
- `module-automation-agents.md`：trigger、BOOT、cron、subagent 与双工。
- `module-interface-protocol.md`：Gateway、协议、TUI/Electron 与重连。
- `module-extensions-integrations.md`：skills、plugins、MCP 与信任边界。
- `module-storage-daemon.md`：home、原子存储、锁、Daemon 启停与 CLI。

## 实现入口

- CLI：`src/cli/main.ts`
- Kernel/Application/Daemon：`src/kernel/`、`src/application/`、`src/daemon/`
- Pi 边界：`src/pi/pi-runtime-adapter.ts`
- Protocol/Gateway：`src/protocol/`、`src/gateway/`
- TUI：`src/ui/tui/`
- 测试：`test/unit/`、`test/contract/`、`test/integration/`

## 构建、运行与测试

- 安装：`npm install`
- 类型检查：`npm run typecheck`
- 测试：`npm test`
- 构建：`npm run build`
- 全量阶段检查：`npm run check`
- 源码 CLI：`npm run dev -- <command>`；构建后 CLI：`node dist/cli/main.js <command>`。
- 初始化：`npm run dev -- init`。
- 前台 Daemon：`npm run dev -- daemon`；SIGINT/SIGTERM graceful shutdown。
- 状态/诊断：`npm run dev -- status`、`npm run dev -- doctor`。
- TUI：`npm run dev -- tui`（要求真实 TTY；固定视觉基准 `160×45`）。
- 单 prompt：`npm run dev -- prompt "..."`。
- 自动化：`npm run dev -- jobs`、`runs`、`run <job-id>`、`cancel <run-id>`；job 事实源位于 `workspace/jobs/*.json`。
- Job 原子更新：`npm run dev -- schedule put examples/jobs/heartbeat.json`；通知：`npm run dev -- notifications`。
- Subagent：`npm run dev -- agents`；`agent spawn <objective>`、`agent send <id> <message>`、`agent join <id...>`、`agent cancel <id>`。
- MCP：`npm run dev -- mcp list`；`mcp discover <server-id>`、`mcp tools`、`mcp ping <server-id>`。配置位于 `config.json#mcpServers`，secret 仅通过 `envRefs/headerRefs` 引用。
- Electron 工具链：`electron@43.3.0`；中国大陆环境可临时使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 下载二进制，不修改全局 npm 配置。

## 配置与运行数据

- 默认根目录：`~/.pspore/`
- 配置：`~/.pspore/config.json`
- workspace：`~/.pspore/workspace/`
- runtime socket/endpoint：`~/.pspore/run/`
- sessions/runs/approval grants/notifications/audit：`~/.pspore/state/`
- lexical search cache：`~/.pspore/cache/search/index.json`（可删除、可重建）。
