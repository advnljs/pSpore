# Project Navigation

## 当前重要文件

| 路径 | 用途 |
|---|---|
| `README.md` | 项目入口、当前状态、安全边界和下一步 |
| `initial_design.txt` | 用户原始 11 条设计思路，不作为最终契约 |
| `docs/detailed-design.md` | 当前唯一完整详细设计与 v1 验收契约 |
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
- `module-interface-protocol.md`：Gateway、协议、TUI/Web 与重连。
- `module-extensions-integrations.md`：skills、plugins、MCP 与信任边界。

## 未来实现入口（设计目标，尚不存在）

- CLI：`src/cli/`
- Kernel：`src/kernel/`
- Pi 边界：`src/pi/`
- Protocol/Gateway：`src/protocol/`、`src/gateway/`
- 测试：`test/unit/`、`test/contract/`、`test/integration/`、`test/visual/`

## 构建、运行与测试

当前没有 `package.json`、实现代码、构建命令、测试命令或运行服务。进入 Phase 0 后必须从实际 package scripts 更新本文件，不能提前猜测命令。

## 配置与运行数据（设计目标，尚不存在）

- 默认根目录：`~/.pspore/`
- 配置：`~/.pspore/config.json`
- workspace：`~/.pspore/workspace/`
- runtime socket/endpoint：`~/.pspore/run/`
- sessions/runs/audit：`~/.pspore/state/`
