# Overall Progress

## 2026-08-09 20:17 CST — 详细设计阶段

- 阶段目标：把 `initial_design.txt` 的概念草案整理为可实施、可验证的 pSpore 详细设计。
- 完成内容：
  - 核对 Pi 官方仓库、`v0.84.1` 包名、Node 要求、SDK、AgentSession、JSONL session、skills/extensions、tool gate、安全边界和实验性 client/server/protocol。
  - 核对 OpenClaw `BOOT.md` 的启动语义，并设计为 Daemon ready 后的非阻塞、可审计 run。
  - 完成总体架构、kernel loop、Pi adapter、记忆/BM25、权限/Shell、cron、subagent、MCP、实时协议、持久化、token/KV cache、测试与分阶段路线图。
  - 明确设计状态与安全警告，增加项目 README 与 `.gitignore`。
- 修改文件：
  - `README.md`
  - `.gitignore`
  - `docs/detailed-design.md`
  - `memory-bank/*.md`
- 验证方式与结果：
  - 只读脚本检查 13 个 Markdown 文件的内部链接与代码围栏：通过。
  - `curl` 检查选取的 Pi `v0.84.1` 与 OpenClaw BOOT 官方链接：HTTP 200。
  - 敏感模式扫描：未发现 token、API key 或 private key。
  - 环境检查：本机 Node.js `v22.17.1`，低于未来实现所需 `>=22.19.0`，已记录为 P0 待办。
- 当前状态：详细设计内容与文档验证已完成；尚无实现代码、build、测试套件或运行服务。
- 遗留问题：见 `todo.md`，主要为 Phase 0 兼容性 spike 与后续实现。

## 2026-08-09 20:35 CST — GitHub 私有仓库发布

- 阶段目标：将完整设计安全发布到同名 GitHub 私有仓库。
- 完成内容：初始化本地 `main` 分支，逐项暂存本阶段 15 个文件，创建 `advnljs/pSpore` 私有仓库并推送。
- 验证方式与结果：
  - `git diff --cached --check`：通过。
  - staged diff 敏感模式扫描：通过。
  - GitHub `visibility`：`PRIVATE`。
  - 本地 `465aad7f8461d57c0d8566849f58ea5e0f055287` 与远端首次设计提交一致。
  - `main` 已跟踪 `origin/main`；首次推送后工作树干净。
- 当前状态：设计文档已发布；当前阶段没有实现代码，因此没有可编译、可启动或可预览的服务。
- 遗留问题：本次为新仓库首次提交，没有既有 base branch 可供代码评审，未创建 draft PR；后续实现从独立 feature branch + PR 开始。

## 2026-08-09 22:32 CST — Phase 0 运行时与风险契约

- 阶段目标：建立 Node/TypeScript 工程，验证 Pi `v0.84.1` 与 Linux Shell/PTY 的关键上游假设。
- 完成内容：
  - 固定 Node.js 24、Pi `v0.84.1`、Electron `43.3.0` 与已确认的最小依赖，生成 npm lockfile；Electron 二进制通过中国大陆镜像安装并验证。
  - 实现唯一 Pi SDK 边界 `PiRuntimeAdapter`，完成领域事件/快照映射、session create/resume/new/fork、订阅重绑、prompt/steer/followUp/abort/compact、usage/cache 和 fail-closed tool gate。
  - 使用 Pi 官方 faux provider 完成不调用付费模型的 contract tests。
  - 实现 Linux login shell pipe/PTY、超时、输出上限、私有 artifact、SHA-256、进程组终止与 secret 流式脱敏。
  - 记录 ADR 0001，并把最终客户端从 Tauri 更新为 Electron 43；核心仍先以 TUI 验收。
- 修改文件：`package*.json`、`tsconfig*.json`、`src/domain/`、`src/pi/`、`src/shell/`、`test/`、`docs/adr/0001-runtime-and-pi-baseline.md`、`README.md`、`docs/detailed-design.md`、`memory-bank/*.md`。
- 验证方式与结果：
  - `npm run typecheck`：通过。
  - Pi adapter contract：7 项通过，包含 steer/followUp 次序与 manual compaction 生命周期。
  - Shell Linux integration：4 项通过，包括 PTY secret 不落 artifact。
  - `npm run build`：通过。
  - `electron --version`：`v43.3.0`；Node：`v24.19.0`。
  - `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 当前状态：Phase 0 关键假设已验证；尚无可启动 Daemon/TUI，进入 Phase 1 纵向切片。
- 遗留问题：真实 sudo smoke test 未执行（避免无必要提权）；steer/followUp/compaction 将在 Phase 1 集成路径继续扩充。

## 2026-08-09 23:16 CST — Phase 1 可运行核心纵切

- 阶段目标：让 Node 24 核心以真实 Daemon + UDS + CLI/TUI 运行，并打通单 session、基础工具与审批路径。
- 完成内容：
  - 实现严格 config/home 初始化、`0700`/`0600` 权限、同目录 fsync/rename 原子写、JSONL append、PID + process-start 单实例锁和 stale recovery。
  - 实现纯 Kernel reducer 与串行 commit loop；Application 串行化同 session command，并将 Pi runtime snapshot/event 回投 Kernel。
  - 实现 capability/risk policy、显式 deny 优先、durable pending approval、first-response-wins、timeout/restart/persistence failure fail closed、audit 与 session grant。
  - 实现带 expected SHA-256 的 `read/edit`、有界 ripgrep `search`、复用 ShellService artifact 的 `shell` 固定工具集。
  - 实现私有 UDS v1 协议：严格 hello/command decoder、ASCII LF 分帧、大小/深度限制、revision、command idempotency、bounded replay/背压与 snapshot。
  - 实现 `init/daemon/status/doctor/tui/prompt/version` CLI；TUI 使用 Pi TUI primitives，支持流、审批、显式 steer/follow-up/abort、seq gap 重连与双 Ctrl+C 清理退出。
- 修改文件：`src/application/`、`src/cli/`、`src/config/`、`src/daemon/`、`src/gateway/`、`src/kernel/`、`src/policy/`、`src/protocol/`、`src/storage/`、`src/tools/`、`src/ui/tui/`、对应测试、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check`：通过；严格类型检查、28 项测试和 production build 全部成功。
  - TUI 固定 `160×45` snapshot：45 行、每行 160 cells，关键操作可达，golden SHA-256 固定。
  - 构建产物 live smoke：Daemon ready、`status/doctor` UDS 连接、第二实例拒绝、未配置模型 prompt 明确失败、SIGINT exit 0。
  - graceful shutdown 后 socket、endpoint、lock 均不存在；临时验收 home 已删除。
- 当前状态：Phase 1 单 session 可运行纵切完成；当前没有常驻预览实例（验收实例已按 graceful shutdown 停止）。
- 遗留问题：memory token/path/hash 约束、BM25、durable event/session recovery、cron/BOOT、subagent、MCP 与 Electron 尚未实现；真实 provider/sudo 未用于自动化测试。

## 2026-08-09 23:33 CST — Memory 与 lexical retrieval 纵切

- 阶段目标：完成 v1 pinned context、受控记忆写入、exact/BM25、引用与增量 rebuild。
- 完成内容：
  - 实现中英 Unicode tokenizer、中文 `Intl.Segmenter`/2-gram fallback、`k1=1.2`/`b=0.75` BM25 与 token estimator。
  - 实现 pinned context 固定顺序、missing diagnostics、workspace/symlink/sensitive path 边界、单文件大小、总 token budget、内容 hash 与稳定 prefix hash。
  - 实现带 session/run 来源的 daily `memory_append`，credential/private-key/base64 过滤；实现 `MEMORY.md` expected-hash、source、去重 marker 与 atomic `memory_curate`。
  - 实现 Markdown paragraph/heading 与 Pi JSONL entry chunk、exact boost + BM25 合并、scope/glob/path、返回 token budget、source ref/path/line/hash。
  - 索引按 canonical path、size、mtime、content hash 增量刷新并原子保存；排除 secret、vendor/cache、symlink、binary/oversized 文件；cache 损坏可重建。
  - Daemon 已注入 memory tools 与 lexical provider；`read.expectedSha256` 可验证 search 后引用未变。
- 修改文件：`src/memory/`、`src/tools/core-tools.ts`、`src/daemon/daemon.ts`、相关 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：针对性严格 typecheck 与 10 项 memory/search/core/daemon 测试通过；完整阶段检查在提交前执行。
- 当前状态：memory/search v1 纵切已完成；尚无常驻实例，本阶段不涉及 Electron/PC viewport。
- 遗留问题：索引 cache 不是备份；durable event/session mapping、cron/BOOT、subagent、MCP 与 Electron 仍待实现。
