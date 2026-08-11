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

## 2026-08-10 00:01 CST — Phase 2 Cron、BOOT 与 durable run

- 阶段目标：完成可验证的主动触发主链路，并让 cron/BOOT/run 与审批状态通过同一 Daemon/UDS/TUI 暴露。
- 完成内容：
  - 实现严格标准五字段 cron 与 IANA timezone adapter，并固定 Croner 在 DST 跳时/重复时刻的 UTC 行为。
  - 实现用户可编辑 job schema、canonical directory cwd、budget/delivery/concurrency/misfire 校验。
  - 实现 monthly append-only run ledger、schedule slot claim 去重、queued 恢复、running→unknown、破损尾行 recovery 与中间损坏 fail closed。
  - 实现 `forbid/replace/allow`、全局并发、timeout/budget/cancel、run_once/skip misfire 与 user/cron/recovery trigger。
  - Daemon 在 UDS ready 后启动 scheduler；BOOT 使用独立 run/session、每实例去重且不阻塞 ready。CLI/TUI 增加 jobs/runs/run/cancel。
  - 实现 automation run 的 agent/command executor、run 级授权上下文和跨重启 durable job grant；非法 approval scope 不消费请求，显式 deny 始终优先。
- 修改文件：`src/automation/`、`src/storage/jsonl.ts`、Kernel/Application/Daemon/CLI/TUI、policy/Pi runtime contract、相关 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：增量 `npm run typecheck` 通过；Pi/policy 契约 13 项通过；scheduler/daemon/run-ledger/cron/TUI 组合 13 项通过；完整 `npm run check` 通过（严格类型检查、49 项测试、production build）。构建产物 live smoke 验证 Daemon ready、status/jobs/runs/doctor 与 graceful SIGINT，socket/endpoint/lock 和验收进程均已清理。
- 当前状态：Phase 2 主动 run 纵切已完成；验收临时 home 已删除，当前无常驻实例。TUI 视觉基准仍为固定 `160×45`，Electron 尚未开始。
- 遗留问题：schedule 原子 mutation/runtime reload 与 delivery/notification 尚待 bundled tools 阶段补齐；subagent、MCP、plugin trust 与 Electron 进入后续阶段。

## 2026-08-10 00:21 CST — Schedule mutation 与 durable notification

- 阶段目标：补齐 Phase 2 用户可操作缺口，让 job 无需重启即可安全更新，并让 agent/run 结果可持久投递到共享客户端 store。
- 完成内容：
  - `JobStore.put` 使用当前 source SHA-256 compare-and-swap、严格 schema/canonical cwd、regular-file 校验与 `0600` atomic replace；Scheduler 成功写入后停止旧 timer 并热重载新 cron。
  - 新增 UDS `job.put`、CLI `schedule put FILE` 与 bundled `schedule` list/put tool；schedule write 进入统一 `schedule.write` 风险审批。
  - 新增 durable `NotificationService`、bundled `notify` tool、terminal run delivery 与 Kernel/protocol/TUI notification state；`delivery=none` 不投递。
  - CLI/TUI 新增 notifications 列表；提供禁用状态的 `examples/jobs/heartbeat.json`，不会安装时自行触发。
- 修改文件：JobStore/Scheduler/Application/Daemon/CLI/Kernel/TUI/policy、`src/notifications/`、automation tool、示例、相关 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：增量严格 typecheck 与 21 项 schedule/notification/policy/daemon/scheduler/TUI 测试通过；完整 `npm run check` 通过（51 项测试 + production build）。最新构建 live smoke 完成 `schedule put → jobs → run heartbeat → notifications → status`，run succeeded 且通知持久可读；graceful SIGINT 后 endpoint/socket/lock 与临时 home 已清理。
- 当前状态：schedule/notify 纵切可运行；验收实例已停止，当前无常驻实例，TUI 仍按 `160×45` 验收。
- 遗留问题：进入 Phase 3 subagent、MCP 与 plugin trust。

## 2026-08-10 00:52 CST — Phase 3 Subagent 双工纵切

- 阶段目标：用同进程独立 Pi session 完成可限制、可取消、可观测的 child agent tree 与用户/parent 双工消息。
- 完成内容：
  - 实现 `AgentManager`、独立 child session、全局并发队列、默认深度/活动 child/root child 上限、workspace realpath 边界、per-agent turn/tool/token/cost budget 与终态结果。
  - 实现带 sender/recipient/sequence/correlation/priority/mode/token estimate 的串行 mailbox，支持 `steer/follow_up/next`、join deadline/abort、parent-child 路由、结构化 completion 回传与级联取消。
  - 新增 bundled `agent_spawn/send/join/cancel` tools，并将 child 授权与 parent ceiling 求交；`shared-read` 明确禁止写、Shell、网络与外部副作用，`allow_all` 也不能越过 ceiling。
  - UDS/CLI/TUI 新增 agent list/spawn/send/join/cancel；Kernel/protocol store 广播 agent tree/message。TUI 可选中活动 child session 查看实时 transcript。
  - Daemon 关停顺序先停止 child tree，automation root 结束时取消子树并清理独立 session。
- 修改文件：`src/agents/`、Application/Daemon/Kernel/policy/Pi adapter/CLI/TUI、对应 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：`npm run check` 通过（严格类型检查、55 项测试、production build）；Daemon/UDS fake-model 集成用例实际完成两个 child 并发、用户中途 steering、parent 收到两个结构化结果与 child session 清理。
- 运行验证：最新 `dist/` 在真实 PTY `160×45` 下启动 TUI，连接 Daemon、执行 `/agents`、`/quit` 后正常恢复 terminal；Daemon SIGINT exit 0，验收 home 已删除。
- 当前状态：Subagent 纵切完成并已用 TUI/UDS 验证；当前无常驻验收实例。
- 遗留问题：继续 Phase 3 MCP lazy adapter、plugin trust/staging 与 skills/resource reload；随后进入 Electron 43。

## 2026-08-10 01:21 CST — Phase 3 MCP lazy adapter

- 阶段目标：把第三方 MCP tool 通过严格信任、按需生命周期和统一 policy 接入现有 Pi/Daemon/UDS/TUI 主链路。
- 完成内容：
  - 使用官方 `@modelcontextprotocol/sdk@1.30.0` 实现 stdio 与 Streamable HTTP client adapter；server 初始不启动，只在 discover/call/ping 时连接，空闲关闭并可重连。
  - 严格解析 server ID、transport、allow/deny、timeout、trust 与 `envRefs/headerRefs`；拒绝 inline secret、不安全远端 HTTP、重复 ID 和 allow/deny 冲突。
  - 对 tool 数量、分页、名称、schema 与调用参数设硬边界；归一化 tool 名避免碰撞，发现后的动态 schema 只进入新 session，当前 session 使用固定 `mcp_call`。
  - 所有模型发起的 MCP discovery/call 进入 `external.side_effect` policy gate；shared-read child ceiling 拒绝。`sandboxed` 配置在 v1 无 sandbox executor 时 fail closed。
  - 支持 timeout/AbortSignal、transport health、指数退避、secret 脱敏和 graceful stop；大结果写入私有 MCP artifact，audit 仅保存参数 SHA-256、结果与耗时。
  - Kernel/TUI 增加 MCP health，UDS/CLI 增加 `mcp list/tools/discover/ping`，TUI 增加 `/mcp` 与 `/mcp-discover`。
- 修改文件：`src/mcp/`、Config/Application/Daemon/Kernel/policy/CLI/TUI、fake MCP fixture、unit/integration tests、README 与 memory-bank。
- 验证方式与结果：`npm run check` 通过（严格类型检查、59 项测试、production build）；真实 SDK stdio contract 覆盖 discovery、allow/deny、schema、call、artifact `0600`、abort、audit、idle reconnect、backoff 与 secret redaction。构建产物 live smoke 完成 Daemon ready、doctor/status、`mcp list → discover → tools → ping`，随后 SIGINT exit 0 并删除临时 home。
- 当前状态：MCP 纵切完成；当前无常驻验收实例。TUI 以 `160×45` 实际渲染并固定 golden SHA-256，新增 MCP 状态和命令均可见。
- 遗留问题：继续 plugin trust/staging 与 skills/resource reload；随后进入 Electron 43。

## 2026-08-10 01:47 CST — Phase 3 Resource trust、Skills 与 Host Plugin

- 阶段目标：确保模型生成或外部复制的 skill/plugin 在未经用户审查和 exact trust 前绝不加载，并在受控 session/restart 边界生效。
- 完成内容：
  - 实现 `workspace/staging` canonical containment、目录/文件/深度/byte 上限、special file/symlink/node_modules 拒绝、严格 `SKILL.md`/`pspore.plugin.json` schema、依赖/lifecycle 展示与 host entry `node --check`。
  - 对排序后的 path/mode/content 生成 deterministic SHA-256；install 必须提交 expected digest，使用内存 byte snapshot 写入私有临时目录、目标重验、atomic rename，并把 exact record 写入 `0600 state/resource-trust.json`。
  - Skills 安装到内容寻址目录；每个新 Pi session/replacement 都重验 digest，并只通过 `additionalSkillPaths` 加载。Pi contract 证明 system prompt 只有 name/description/path，不含完整 skill body。
  - Host plugin 安装不 import；只有 trust record、`config.plugins` exact digest、manifest capabilities 与 grantedCapabilities 完全匹配后，才在 Daemon restart import/start。生命周期 timeout/error 转为 resource degraded，stop 在 graceful shutdown 执行。
  - 支持 trust revoke（保留内容、不热卸载）、tamper blocked health、Kernel/protocol/TUI resource health，以及 CLI/TUI `resources/skills/plugins/inspect/install/disable`。
- 修改文件：`src/plugins/`、Config/Home/Pi adapter/Application/Daemon/Kernel/CLI/TUI、对应 contract/integration/unit tests、README 与 memory-bank。
- 验证方式与结果：`npm run check` 通过（严格类型检查、66 项测试、production build）；测试覆盖 staging escape/symlink、错误 digest、篡改、未安装代码不执行、capability 缺失阻止、可信 plugin restart start/health/stop、UDS install/revoke 和 Pi session-boundary progressive disclosure。
- 运行验证：最新 `dist/` 完成 `init → daemon → resource inspect → exact install → skills/status/doctor`；真实 `160×45` TTY 显示 active skill，执行 `/skills` 与 `/quit` 后终端恢复；Daemon SIGINT exit 0，临时 home 已删除。
- 当前状态：Phase 3 完成，当前无常驻验收实例；进入 Electron 43 最后阶段。
- 遗留问题：Electron 43 客户端与最终跨客户端/安全/视觉验收。

## 2026-08-10 02:28 CST — Phase 4 Electron 43 与功能 v1 完成

- 阶段目标：在不采用 Tauri 的前提下完成 Electron 43 客户端，使其与 TUI 共享同一 Daemon，并通过安全、重连、交互和 `1920×1080` 视觉验收。
- 完成内容：
  - 实现 Electron main process `DaemonBridge`：独占 UDS、authoritative snapshot/cursor、gap 断开、指数退避重连和保序连续 delta coalescing；Electron 退出不停止 Daemon。
  - 实现严格 `DesktopCommand` allowlist 与 runtime decoder；renderer 不可提交 protocol type/channel 或任意路径。resource 操作只接受单层 staging name，由 main 解析到配置 workspace，Daemon 再做 canonical containment。
  - main 对 server hello、Kernel snapshot、event type/payload 和返回值做 JSON depth/node/string/collection 边界校验；不把未经验证的 UDS 对象送入 renderer。
  - preload 仅暴露 `bootstrap/dispatch/subscribe`；BrowserWindow 启用 `contextIsolation/sandbox`，关闭 Node integration/webview/insecure content，拒绝权限、下载、远程请求、外部导航和新窗口；HTML 使用严格 CSP。
  - 使用原生 DOM/TypeScript 实现 main/child session tree、transcript/streaming、prompt/steer/follow-up/abort/compact、child spawn/send/join/cancel、approval overlay、job/run、MCP、trusted resource、notification 和 activity UI；动态内容只写 Text node/`textContent`。
  - 构建流程同步 preload/HTML/CSS；新增 `pspore desktop`、`npm run desktop` 与自包含 `npm run test:electron`。
- 修改文件：`src/desktop/`、`scripts/copy-desktop-assets.mjs`、`scripts/electron-smoke.mjs`、`src/cli/main.ts`、`package.json`、4 个 desktop unit/integration test、README、详细设计与 memory-bank。
- 验证方式与结果：
  - `npm run check`：通过；严格 typecheck、75 项测试、production build 全部成功。
  - `npm run test:electron`：通过；真实临时 Daemon + Electron `43.3.0` + Xvfb，精确 viewport/capture 均为 `1920×1080`，自动验证断线重连与 allowlisted IPC round trip。
  - renderer probe：`process/require/Buffer/electron` 全为 `undefined`，全局 API 仅 `bootstrap/dispatch/subscribe`；任意 `shell.exec` action 被 main 拒绝；CSP 与安全基线一致。
  - 视觉/交互 probe 与人工截图检查：document 无横纵溢出；transcript 可滚动、长代码在自身区域横向滚动、tool output 默认折叠、streaming delta 可见、composer 完整固定可见、approval modal 不越界、背景 inert 且初始焦点落在“拒绝”。
  - 跨客户端 live smoke：真实 `160×45` TUI 与 Electron 同时连接同一 socket，`ss` 显示两个 ESTAB；TUI `/quit` exit 0 并恢复 terminal，Electron 单独 SIGTERM exit 0，Daemon SIGINT exit 0。
  - 环境与供应链：Node `v24.19.0`、Electron `v43.3.0`；`npm audit --omit=dev --audit-level=high` 为 0 vulnerabilities；源码与 `dist` desktop 静态资源一致，package/lockfile 无 Tauri dependency。
- 当前状态：Phase 0—4 与功能 v1 全部完成；最新 `dist/` 已构建。当前无常驻验收实例，因为 Xvfb、Daemon 和临时 home 均已在验证后正常停止/删除；可用 `npm run desktop` 启动真实客户端，或用 `npm run test:electron` 完整复现验收。
- 遗留问题：真实付费 provider 与真实 sudo 未在自动测试中使用；sandbox/vector/remote/mobile 仍按 v1 非目标延期，不阻塞 v1。

## 2026-08-11 10:10 CST — Desktop 双主题、AppImage Daemon 自启与 DeepSeek 实验

- 阶段目标：优化 PC Electron 界面与字号，支持深色/浅色切换，修复 AppImage 独立启动一直等待 `daemon.sock` 的问题，并用 `deepseek-v4-flash` 真实验证模型链路。
- 完成内容：
  - 新增 `DesktopDaemonSupervisor`与可类型化 `DaemonAlreadyRunningError`；Desktop create-only 初始化 home，通过原子单实例锁决定 `owned/external`，启动时等 Daemon ready 再连接，退出只停止自己拥有的 Daemon。
  - renderer 重构为暖深色/暖浅色语义主题，增加持久化切换、`color-scheme/theme-color`、焦点/跳转链接、表单 name/autocomplete、可减少动效，并将对话/输入/分区/侧栏主次字号固定为 `15/14/15/13/11.5px` 基线。
  - Electron smoke 扩展到外部 Daemon 复用与桌面 Daemon 自启两条路径，截取深色/浅色/审批三张 1920×1080 截图，并直接断言 computed font sizes、主题色、overflow、焦点、sandbox 和 IPC allowlist。
  - `ds_key.txt` 已加入 `.gitignore` 并收紧为 `0600`；只在临时 Daemon 进程环境注入 `DEEPSEEK_API_KEY`，未输出、未写入 config/session/memory/Git。
- 修改文件：`src/desktop/main.ts`、`daemon-supervisor.ts`、renderer HTML/TS/CSS、`src/storage/daemon-lock.ts`、`scripts/electron-smoke.mjs`、desktop supervisor tests、`.gitignore`、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、78 项测试、production build 全部成功。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：Electron `43.3.0`，精确 `1920×1080`，owned/external Daemon、双主题、字号、重连、隔离、overflow、composer 与审批焦点全部通过；人工检查深色/浅色/审批截图无明显遮挡或不可读文字。
  - 临时构建 AppImage 从空 home 实际启动：`daemonOwnership=owned`、`connection=connected`，reconnect 通过，退出后 socket/endpoint 清理；验证包 SHA-256 为 `27865b3bbbf6eab537296495c95b766ee76fc288ddb518427f7bb40bb0ea5d4c`，已更新到 `release-dist/pspore-desktop-0.1.0-linux-x64.AppImage`。
  - 真实 DeepSeek 链路返回 `PSPRORE_DEEPSEEK_OK`；snapshot 确认 model `deepseek/deepseek-v4-flash`、thinking `off`、input/output/total `2729/8/2737`、cost `$0.0003843`。
- 当前状态：最新 `dist/` 已构建，修复后 AppImage 已放入 `release-dist/`；所有验收 Daemon/Electron 进程均已停止，未留下运行 socket。本轮按用户要求只验证 PC `1920×1080`，未执行手机端验收。
- 遗留问题：真实 sudo 仍未执行（避免无必要提权）；sandbox/vector/remote/mobile 继续作为明确非目标。

## 2026-08-11 10:59 CST — Desktop 工作台重设计与安全模型设置

- 阶段目标：重新设计桌面端为简洁、低密度但高空间利用率的 PC 工作台，并让用户可在界面内安全配置 LLM provider、model、Base URL、API 协议、thinking 与 API key。
- 完成内容：
  - 先生成三套桌面风格对比稿，选择 Calm Command 与 Editorial Workbench 的组合方向；默认只保留会话侧栏和主对话区，活动/自动化/集成/资源检查器改为按需展开，消除常驻空面板。
  - 重写深色/浅色语义主题、对话层级、输入区、审批层、空状态与设置弹窗；主内容随窗口连续伸缩，窄桌面下检查器以覆盖层打开，不实现手机端布局。
  - 新增受限 settings IPC 与 `DesktopSettingsService`；模型配置写入 `config.json`/`state/pi/models.json`，API key 单独写入 `credentials/<provider>.api-key`（`0600`），renderer 只接收 `hasApiKey`，不会获得密钥正文。
  - 保存前使用 Pi `ModelRuntime` 在临时目录验证 provider/model 组合；owned Daemon 自动安全重启并重连，external Daemon 明确提示需由用户重启后生效。
  - Electron smoke 新增设置表单、密钥不泄漏、双主题、字号、默认检查器关闭与 `1920×1080`、`1440×900`、`1180×720` 三档 PC viewport 验收。
- 修改文件：`src/desktop/renderer/`、`src/desktop/main.ts`、`src/desktop/ipc-contract.ts`、`src/desktop/preload.cjs`、`src/desktop/settings-service.ts`、`scripts/electron-smoke.mjs`、desktop unit tests、`docs/design/desktop-style-comparison.png`、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、81 项测试、production build 全部成功。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：三档 PC viewport 无页面级 overflow；深色/浅色/设置/审批均已截图并人工检查；正文 `15.5px`、输入 `15px`、会话主文案 `14px`、设置字段 `14px`，紧凑辅助字号最低 `11.5px`。
  - 使用隔离临时 home 和 `ds_key.txt` 实际保存 `deepseek/deepseek-v4-flash` 设置并调用 Daemon，模型精确返回 `PSPRORE_SETTINGS_OK`；验证目录已删除，密钥未输出或写入项目。
- AppImage 验证：基于当前工作树重新打包 `release-dist/pspore-desktop-0.1.0-linux-x64.AppImage`（SHA-256 `da4131f8b247e8bf92922749ce35ef48e813d7fe799f183e7ff1c52dfbb6b575`）；从全新临时 home 启动后报告 `daemonOwnership=owned`、`connection=connected`，三档 viewport 与字号/设置断言通过，退出后 `daemon.sock`/`endpoint.json` 均不存在。
- 当前状态：桌面重设计和安全模型设置已完成，最新 `dist/` 与 AppImage 已构建；自动验收进程均已停止。
- 遗留问题：TUI/CLI 的模型设置入口与跨界面配置抽象按用户要求放到下一独立阶段；手机端明确不在验收范围。

## 2026-08-11 11:46 CST — 共享客户端内核、完整 TUI 与 npm CLI

- 阶段目标：让 TUI/CLI 与桌面端复用相同的协议状态、会话路由、Daemon 生命周期和模型设置内核；补齐 TUI 功能、响应式终端布局、wizard/命令双配置入口，并形成可直接 npm 安装的 CLI 包。
- 完成内容：
  - 抽出 `src/ui/shared/protocol-state.ts` 与 `presentation.ts`，GUI/TUI 共享 authoritative snapshot/event/delta reducer、session/metric presentation 与 main/child conversation intent；修复选中 child 后普通输入误发给 main 的路由问题。
  - 抽出 `src/daemon/supervisor.ts`，桌面与 TUI 统一 owned/external Daemon 语义；`pspore tui` 从空 home 自动初始化并启动 Daemon，退出只清理自己拥有的实例。
  - 抽出 `src/settings/llm-settings*.ts`，GUI/TUI/CLI 精确支持 `deepseek`、`openai`、`custom-openai`。Preset 固定 provider 默认 endpoint/API；自定义 OpenAI 支持 Base URL 与 Chat/Responses。
  - TUI 重写为简洁响应式会话工作台：`160×45` 双栏、`96×30` 单栏，完整 jobs/runs/notifications/agents/MCP/resources 面板、PgUp/PgDn、`/help` 命令面板；普通对话和审批/自动化/集成功能均走同一 Daemon 内核。
  - TUI 同时实现 `/config wizard` 引导配置与 `/config` 命令配置；wizard 支持取消和最终确认，Key 输入只显示遮罩。CLI 增加等价 `config show/set/provider/model/endpoint/thinking/key/clear-key`，Key 不接受 argv，只从隐藏 TTY 或 stdin 读取。
  - npm package 改为 public-ready，限制发布内容为 `dist/**/*`，增加 prepack/prepublish 检查与安全 `dist` clean；修复 npm bin 符号链接导致入口判断不执行的问题。纯 npm 安装不拉取 Electron，`desktop` 给出 AppImage 指引。
  - GUI Provider 改为 DeepSeek/OpenAI/自定义 OpenAI 下拉；只有自定义项开放 Base URL/API 类型。设置表单 input/select 计算字号明确不低于 `14px`。
- 修改文件：`src/settings/`、`src/ui/shared/`、`src/ui/tui/`、`src/daemon/supervisor.ts`、desktop main/IPC/renderer、CLI、package/scripts、相关 unit/smoke tests、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、86 项测试和干净 production build 全部成功。
  - 真 TTY 验证 `160×45` TUI 自动启动/清理 Daemon，`/help` 同时展示 wizard/commands；真实 wizard 可逐步到 review 并取消，`/config key` 只显示遮罩，credential mode `0600`，日志和 `models.json` 无明文。
  - 最终 npm tarball 为 261 entries、269325 bytes、SHA-1 `4053214b5c0a50183f3461e3892bcd96812b6fd3`，顶层只有 README/`dist`/`package.json`；全新 prefix 安装后 bin mode `775`，`pspore --version/config show/tui` 均可运行，生产依赖中无 Electron。
  - 使用该 npm 安装包和隔离 home 配置 `deepseek/deepseek-v4-flash`，真实 API 精确返回 `PSPRORE_NPM_DEEPSEEK_OK`；Key 文件 `0600`，模型配置只含 `!cat --` 外部引用，密钥未输出或提交。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：`1920×1080` 主视口及 `1440×900`、`1180×720` PC 响应式、双主题、三 Provider、设置、owned/external Daemon、安全边界与字号全部通过；人工检查保留截图无明显遮挡/溢出。
  - 最新 AppImage 从全新 home 实际启动为 `daemonOwnership=owned`、`connection=connected`，Provider 选项精确、设置字号 `14px`，退出后 socket/endpoint 清理；SHA-256 `ea03243750f37861c55ec2a00c1ff216b64dffbfc587b08b575d70655ae03ef4`。
- 当前状态：共享客户端内核、GUI/TUI/CLI 三 Provider、TUI 双配置入口、npm 安装包与最新 AppImage 已完成并验证；所有临时 Daemon/Electron 进程已停止。npm registry 发布仍待浏览器认证后执行。
- 遗留问题：真实 sudo 仍未执行；sandbox/vector/remote/mobile 继续为非目标。npm 发布结果将在认证后另行记录。
