# pSpore

pSpore 是一个设计中的、基于 [Pi](https://github.com/earendil-works/pi) 的 Linux 本地主动式 Agent。目标是在保留 Pi 极简 agent loop 的前提下，增加持久记忆、权限治理、计划任务、subagent、MCP，以及共享同一后端的 TUI/Web UI。

## 当前状态

项目当前处于**详细设计完成、尚未开始编码**阶段。不要把本文档中的接口或命令误认为已经实现。

- 原始想法：[initial_design.txt](initial_design.txt)
- 主设计文档：[docs/detailed-design.md](docs/detailed-design.md)
- 项目记忆与导航：[memory-bank/nav.md](memory-bank/nav.md)

设计基线为 Pi `v0.84.1`（2026-08-07 发布），实现时首先完成版本兼容性 spike，再锁定实际依赖版本。

## 核心边界

- Linux-first、local-first、单用户；默认不提供多租户或公网服务。
- 主进程与工具默认使用启动 pSpore 的登录用户权限，不构成沙箱。
- `allow_all` 会允许模型以当前用户身份执行任意工具操作；当用户拥有免密或已缓存的 `sudo` 权限时，影响可能扩大到 root。
- skills、Pi extensions、pSpore plugins 和本地 MCP server 都可能执行任意代码，只能在显式信任后加载。
- 默认记忆检索为精确搜索与 BM25；向量搜索保留为可插拔扩展，不属于首版范围。

## 下一步

按详细设计的 Phase 0 先验证 Pi SDK、事件映射、权限钩子、会话恢复和 KV cache 指标，再进入可运行的纵向切片。
