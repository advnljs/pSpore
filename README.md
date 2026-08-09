# pSpore

pSpore 是一个基于 [Pi](https://github.com/earendil-works/pi) 的 Linux 本地主动式 Agent。目标是在保留 Pi 极简 agent loop 的前提下，增加持久记忆、权限治理、计划任务、subagent、MCP，以及共享同一后端的 TUI/Electron UI。

## 当前状态

项目已进入实现阶段：Phase 0 的 Node/TypeScript 工程、Pi adapter contract 和 Linux Shell/PTY 风险 spike 已落地；Kernel、Daemon、TUI 与其余 v1 模块仍在开发中。不要把详细设计中尚未落地的接口或命令误认为已经实现。

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

## 下一步

继续完成详细设计的 Phase 1：Kernel、storage、policy、UDS 和 TUI 的可运行纵向切片。
