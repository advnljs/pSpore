# Todo

| 优先级 | 待办任务 | 状态 | 阻塞项 | 下一步建议 |
|---|---|---|---|---|
| P0 | 将实现环境 Node.js 升级到 Pi 支持范围 | Done | 无；当前本机为 Node.js `v24.19.0` | 通过 `engines` 固定 Node.js 24 基线 |
| P0 | 建立 Node.js/TypeScript 工程并锁定 Pi 版本 | Done | 无 | 已生成精确 npm lockfile与 ADR 0001 |
| P0 | 验证 Pi adapter contract | Done | 无 | 已覆盖 create/resume/new/fork/rebind/steer/followUp/abort/compact/tool gate/cache usage |
| P0 | 验证 Linux login shell、PTY 与 sudo secret channel | Done | 未执行真实 sudo（避免无必要提权） | 已验证 login shell、pipe/PTY、timeout、output cap、artifact 与 secret 跨 chunk 脱敏 |
| P1 | 实现 Kernel、storage、policy、UDS 和 TUI 纵向切片 | Done | 无 | 已有真实 Daemon/CLI、单 session fake runtime 集成与 160×45 TUI snapshot |
| P1 | 实现 pinned memory、exact/BM25 search 与 artifact truncation | Done | 无 | 已覆盖 token/path/hash、memory append/curate、source ref、exclude 与增量 rebuild |
| P2 | 选择 cron parser 依赖 | Done | 无；用户已确认 | 已锁定无额外 runtime dependency 的 `croner@10.0.1`，Phase 2 验证 timezone/DST |
| P2 | 实现 BM25 与中英 tokenizer | Done | 无 | 默认 lexical provider 已接入 Daemon search tool |
| P2 | 实现 cron、BOOT、run ledger 与恢复 | Done | 无 | 已覆盖 slot 去重、DST、misfire、并发、timeout、unknown/queued 恢复和非阻塞 BOOT |
| P2 | 实现 schedule 原子 mutation 与 run delivery/notification | Done | 无 | 已实现 expected-hash atomic put、runtime reload、notify tool、run delivery 与 durable protocol state |
| P3 | 选择 MCP SDK 与版本 | Done | 无；用户已确认 | 已锁定官方 `@modelcontextprotocol/sdk@1.30.0`，只通过 adapter port 使用 |
| P3 | 实现 subagent tree/mailbox/budget/cancel 双工 | Done | 无 | 已用 fake model + Daemon/UDS 覆盖两 child 并发、steering、result、ceiling 与 cascade cancel |
| P3 | 实现 MCP lazy adapter | Done | 无 | 已用官方 SDK fake stdio server 与真实 UDS/CLI 验证 discover/activation/policy/abort/health/idle reconnect/backoff |
| P3 | 实现 plugin trust/staging 与 skills reload | Done | 无 | 已覆盖 exact digest、symlink/tamper、capability grant、restart lifecycle 与 Pi progressive disclosure |
| P5 | sandbox/vector/remote/mobile | Deferred | 不属于 v1 范围 | 只有明确需求和基准证据时重评 |
| P4 | Electron 43 桌面客户端 | Done | 无 | 已完成安全 main/preload/renderer、AppImage 自启/复用 Daemon、响应式双主题、LLM 设置与 1920×1080/1440×900/1180×720 验收；未实现 Tauri/mobile |
| P4 | GUI/TUI/CLI 共享客户端内核与 TUI 完善 | Done | 无 | `p-spore@0.1.0` 已发布；全新 cache/prefix registry 安装、远端 integrity 与 `pspore` CLI 均已验证 |

## 已知风险

- Pi 上游 API 演进较快，必须依赖 contract tests 与 adapter 隔离。
- `ask_risky` 不能完备识别任意 Shell 的真实副作用。
- 同用户运行、Pi extension、host plugin 和 MCP server 均不构成安全沙箱。
- 外部副作用在崩溃边界不能普遍保证 exactly-once。
- 当前 UDS replay 与 command cache 仅在进程内；重启靠 snapshot，durable event log/session mapping 尚未完成。
- 当前模型未配置时 Daemon 可正常 ready，但 prompt 会返回 `model_not_configured`；`deepseek/deepseek-v4-flash` 已于 2026-08-11 使用临时 credential 完成真实 API 验证，不将付费调用纳入默认自动化。
- npm 包要求 Node 24；`desktop` 命令在纯 npm 安装中不会下载 Electron，而是提示使用 AppImage。
