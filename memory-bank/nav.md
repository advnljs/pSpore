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

## 未来实现入口（设计目标，尚不存在）

- CLI：`src/cli/`
- Kernel：`src/kernel/`
- Pi 边界：`src/pi/`
- Protocol/Gateway：`src/protocol/`、`src/gateway/`
- 测试：`test/unit/`、`test/contract/`、`test/integration/`、`test/visual/`

## 构建、运行与测试

- 安装：`npm install`
- 类型检查：`npm run typecheck`
- 测试：`npm test`
- 构建：`npm run build`
- 全量阶段检查：`npm run check`
- 当前尚无可启动 Daemon/TUI；`npm run dev` 将在 Phase 1 CLI 入口落地后可用。
- Electron 工具链：`electron@43.3.0`；中国大陆环境可临时使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 下载二进制，不修改全局 npm 配置。

## 配置与运行数据（设计目标，尚不存在）

- 默认根目录：`~/.pspore/`
- 配置：`~/.pspore/config.json`
- workspace：`~/.pspore/workspace/`
- runtime socket/endpoint：`~/.pspore/run/`
- sessions/runs/audit：`~/.pspore/state/`
