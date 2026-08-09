# pSpore

pSpore 是一个基于 [Pi](https://github.com/earendil-works/pi) 的 Linux 本地主动式 Agent。目标是在保留 Pi 极简 agent loop 的前提下，增加持久记忆、权限治理、计划任务、subagent、MCP，以及共享同一后端的 TUI/Electron UI。

## 当前状态

项目已进入实现阶段：Phase 0 运行时契约、Phase 1 可运行核心纵切以及 Phase 2 memory/automation 已落地。当前已有 Kernel、私有文件存储、权限/审批、基础工具、pinned memory、exact/BM25、cron/BOOT、durable run ledger、UDS Daemon、CLI 和可重连 TUI；subagent、MCP、plugin trust 与 Electron 仍在开发中。不要把详细设计中尚未落地的接口或命令误认为已经实现。

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
npm run build

node dist/cli/main.js init
node dist/cli/main.js daemon
```

另开终端后可运行：

```bash
node dist/cli/main.js status
node dist/cli/main.js doctor
node dist/cli/main.js tui
node dist/cli/main.js jobs
node dist/cli/main.js runs
node dist/cli/main.js run <job-id>
node dist/cli/main.js cancel <run-id>
```

Daemon 在没有模型配置时仍会 ready，便于检查健康状态；首次 prompt 会明确返回 `model_not_configured`。用户可在 `workspace/jobs/<job-id>.json` 定义严格的五字段 cron job，使用 CLI/TUI 列出、手动触发或取消 run。TUI 普通输入创建新 prompt，忙时必须显式使用 `/steer` 或 `/follow`；`/abort`、`/approve`、`/deny`、`/compact`、`/jobs`、`/runs`、`/run`、`/cancel` 和 `/quit` 可直接使用。

## 下一步

继续完成详细设计的 Phase 3：subagent tree/mailbox/budget、MCP lazy adapter 与 plugin trust/staging。
