# Todo

| 优先级 | 待办任务 | 状态 | 阻塞项 | 下一步建议 |
|---|---|---|---|---|
| P0 | 将实现环境 Node.js 升级到 Pi 支持范围 | Pending | 当前本机为 `v22.17.1`，Pi `v0.84.1` 要求 `>=22.19.0` | Phase 0 开始前选择受支持版本并记录安装方式 |
| P0 | 建立 Node.js/TypeScript 工程并锁定 Pi 版本 | Pending | 需进入实现阶段；新增依赖前需用户确认 | 按详细设计 Phase 0 建最小 fake-provider spike |
| P0 | 验证 Pi adapter contract | Pending | 尚无代码 | 覆盖 create/resume/steer/followUp/abort/tool gate/compaction/usage |
| P0 | 验证 Linux login shell、PTY 与 sudo secret channel | Pending | 尚无代码 | 使用 fake command 和人工 opt-in sudo smoke test |
| P1 | 实现 Kernel、storage、policy、UDS 和 TUI 纵向切片 | Pending | Phase 0 | 保持单 session 先跑通 |
| P1 | 实现 pinned memory、exact search 与 artifact truncation | Pending | Phase 0 | 先不加入 BM25/vector |
| P2 | 选择 cron parser 依赖 | Pending | 需要用户确认生产依赖 | 比较 timezone/DST、维护性和包体积 |
| P2 | 选择 Web UI renderer/framework | Pending | 需完成 protocol-store spike | 默认优先轻量方案，不影响 domain/protocol |
| P2 | 实现 BM25、中英 tokenizer、Web UI、cron 与 BOOT | Pending | Phase 1 | 按详细设计测试边界推进 |
| P3 | 选择 MCP SDK 与版本 | Pending | 需要用户确认生产依赖 | 只通过 MCP adapter port 引入 |
| P3 | 实现 subagent 双工、MCP 与 plugin trust 流程 | Pending | Phase 2 | 先用 fake MCP 和 fake model 做集成测试 |
| P4 | sandbox/vector/remote/mobile | Deferred | 不属于 v1 范围 | 只有明确需求和基准证据时重评 |

## 已知风险

- Pi 上游 API 演进较快，必须依赖 contract tests 与 adapter 隔离。
- `ask_risky` 不能完备识别任意 Shell 的真实副作用。
- 同用户运行、Pi extension、host plugin 和 MCP server 均不构成安全沙箱。
- 外部副作用在崩溃边界不能普遍保证 exactly-once。
- 当前仓库只有设计文档，没有 build、test 或运行实例。
