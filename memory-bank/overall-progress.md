# Overall Progress

## 2026-08-22 — GUI 重构与交互优化

- 阶段目标：按用户要求重构桌面 GUI——Enter 发送/Ctrl+Enter 换行、白蓝配色浅色默认、精致深色模式、GSAP 动效。
- 完成内容：
  - composer 键盘行为改为 Enter 发送、Ctrl/Cmd/Shift/Alt+Enter 换行，含 IME 合成态守卫；发送按钮提示更新。
  - styles.css 全量重写为 "cobalt paper" 设计系统：浅色默认（`#f4f7fb` 纸面 + 钴蓝 `#2563eb`）、深色板岩藏青克制配色；topbar 去卡片化、panel 发丝边框、消息/建议卡片/表格/代码块全面翻新；保留全部响应式断点与可访问性基线。
  - 新增 `src/desktop/renderer/motion.ts`：GSAP 入场编排、消息 stagger/单条入场（流式不重复触发）、设置/审批弹层出入场（退出后置 hidden + 状态守卫）、连接徽章脉冲、发送按钮微动效；`prefers-reduced-motion` 与引擎缺失时全部降级。
  - `gsap@3.15.0` 加入 dependencies，UMD 构建经 `copy-desktop-assets.mjs` vendor 到 `dist/desktop/renderer/vendor/gsap.min.js`，index.html classic script 加载。
  - renderer 安全测试契约显式放行且仅放行 `./vendor/gsap.min.js` 与 `./renderer.js` 两个本地脚本。
- 修改文件：
  - `package.json` / `package-lock.json`
  - `scripts/copy-desktop-assets.mjs`
  - `src/desktop/renderer/index.html`、`styles.css`、`renderer.ts`、`motion.ts`（新增）
  - `test/unit/desktop-security.test.ts`
  - `dist/**`（构建产物同步）
- 验证方式与结果：
  - `npm run typecheck`：通过。
  - `npm test`：113/113 通过（中途两次 MCP 集成用例在并行负载下 UDS 超时抖动，隔离运行基线与改动版均通过，最终全量通过）。
  - `npm run build`：通过，vendor 文件就位。
  - `npm run test:electron`（Xvfb）：通过——1920×1080 主基准明暗双主题、1440×900、1180×720 布局、设置弹层 containment/inert、审批 modal、CSP、字号下限、IPC allowlist 全部断言成功；人工复核明/暗主题与设置弹层截图确认新视觉生效。
- 当前状态：GUI 重构完成并已验证；工作树待提交。
- 遗留问题：见 `todo.md`。

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

## 2026-08-11 14:24 CST — npm 首发前清单加固

- 阶段目标：在 `pspore@0.1.0` 首次发布到 npm registry 前，复核真实发布清单与全局 CLI 入口。
- 完成内容：
  - 浏览器 `npm login` 成功，`npm whoami` 确认当前用户；registry 在本次尝试前不存在 `pspore` 包。
  - 首次 `npm publish` 预检发现 npm 11 会将带 `./` 前缀的 `bin.pspore` 视为无效并从发布 manifest 删除；已规范化为 `dist/cli/main.js`，并新增 manifest 回归测试。
  - 修复后 `npm publish --dry-run` 无 `bin` 警告，tarball 内 package manifest 保留 `pspore` 映射。
- 修改文件：`package.json`、`test/unit/cli-config.test.ts`、`memory-bank/overall-progress.md`、`memory-bank/todo.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、87 项测试与 production build 全部成功。
  - 修复后 tarball 为 261 entries、269321 bytes、SHA-1 `399f68e6f7cd0ede377915f2054d9391f48fd9f7`；全新临时 prefix 安装后 `pspore --version` 与 `--help` 均成功，临时目录已删除。
- 当前状态：待发布代码与包已完成加固；没有常驻服务或前端视觉改动，不需要新的 viewport 验收。
- 遗留问题：正式上传被 npm registry 拒绝且未创建版本；账号 profile 显示 `tfa: false`，需由用户先在 npm 账号中启用 2FA，再重试 `npm publish`。

## 2026-08-11 15:46 CST — `p-spore@0.1.0` npm 首发

- 阶段目标：在 npm 名称保护与 2FA 约束下完成可安装、可验证的 CLI 公开首发。
- 完成内容：
  - npm 拒绝未作用域名称 `pspore`，用户明确选定 `p-spore`；已同步 `package.json`、lockfile、README、测试与项目导航，全局 CLI 命令仍为 `pspore`。
  - 用户启用 npm `auth-and-writes` 2FA，发布使用 npm 浏览器 WebAuthn 流程，未读取、粘贴或保存 token/OTP。
  - `p-spore@0.1.0` 已发布为 public 包且 `latest=0.1.0`；远端 manifest 保留 `bin.pspore=dist/cli/main.js`。
- 修改文件：`package.json`、`package-lock.json`、`README.md`、`test/unit/cli-config.test.ts`、`memory-bank/*.md`。
- 验证方式与结果：
  - 改名后与正式发布前的 `npm run check` 均通过：严格 typecheck、87 项测试和 production build 成功。
  - 发布 tarball 为 261 entries、269347 bytes、SHA-1 `68f3204636914f049b7df53b035d5868000913c9`、SHA-512 integrity `sha512-lKDQW54aMwbPHHrF40Z55eCPF+R5sSJuesnYSfeWTsKeCiilBj82L+ZlPUmBkcXhqrdAdDH5GceWLCggAUpZOg==`。
  - 使用全新临时 npm cache/prefix 从 registry 安装 `p-spore@0.1.0`；远端 hash/integrity 与发布产物一致，installed manifest 正确，`pspore --version` 与 `--help` 成功，临时目录已删除。
- 当前状态：v1 共享客户端内核与 npm CLI 发布阶段完成；当前无常驻服务，本阶段无前端视觉改动，不需要新的 viewport 验收。
- 遗留问题：真实 sudo 仍未执行；sandbox/vector/remote/mobile 继续为明确非目标。

## 2026-08-13 09:30 CST — 修复 npm 安装后命令不存在，并统一 CLI/npm 页面为英文

- 阶段目标：消除 `npm install --global p-spore` 之后 `p-spore` 命令不存在的问题，并让 npm 展示页与 CLI 文案面向 CLI 用户、全部使用英文。
- 完成内容：
  - 复现根因：包名为 `p-spore`，但 `bin` 只映射 `pspore`，全局安装只生成 `pspore` 一个 symlink，用户按包名执行 `p-spore` 必然 command not found。
  - `bin` 增加 `p-spore` 别名，与 `pspore` 指向同一入口，两者等价；版本升到 `0.1.1` 以便发布修复。
  - `resolveInvokedName` 按 `process.argv[1]` basename 回显用户实际使用的命令名，help usage 与 `status`/`tui` 提示不再硬编码 `pspore`。
  - 端到端安装验证时发现并修复一个真实缺陷：`BIN_ALIASES` 常量原本声明在顶层 entrypoint 调用之后，`--help` 在 TDZ 中崩溃（`Cannot access 'BIN_ALIASES' before initialization`）；常量已上移到 `runCli` 之前。
  - 新增以子进程方式执行 entrypoint 的回归测试，覆盖 import 无法发现的初始化顺序问题；已先注入缺陷确认该测试会失败。
  - README 重写为英文、面向 CLI 功能（安装、双命令、模型配置、日常命令、cron job、child agent、MCP、skills/plugins、安全模型），原中文项目文档移至 `docs/project-overview.md`，不再作为 npm 展示页。
  - CLI/TUI 唯一中文文案 `主会话` 改为 `Main session`。
- 修改文件：`package.json`、`src/version.ts`、`src/cli/main.ts`、`src/ui/shared/presentation.ts`、`test/unit/cli-config.test.ts`、`README.md`（新英文页）、`docs/project-overview.md`（由原 README 移动）、`memory-bank/*.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、89 项测试（新增 2 项）与 production build 全部成功。
  - `npm pack` 后在全新临时 prefix 全局安装：`bin/` 同时生成 `p-spore` 与 `pspore` 两个 symlink；经 PATH 执行 `p-spore --version`、`p-spore --help`、`pspore --help`、`p-spore init`、`p-spore status` 均符合预期，且 `status` 提示正确回显 `p-spore daemon`。
  - 对照验证：从 registry 安装的已发布 `p-spore@0.1.0` 只生成 `pspore`，执行 `p-spore` 报“没有那个文件或目录”，确认为用户报告的同一问题。
- 当前状态：修复已在本地打包产物上端到端验证；本阶段无常驻服务与前端视觉改动，不需要新的 viewport 验收。`0.1.1` 尚未发布到 npm。
- 遗留问题：Electron 桌面 renderer 仍为中文文案，本次未改（用户本次只要求 CLI 英文）；已记入 todo。

## 2026-08-13 09:52 CST — `p-spore@0.1.1` 发布并完成 registry 实装验证

- 阶段目标：把 `p-spore` 命令缺失的修复正式发布到 npm，并以全新用户视角验证。
- 完成内容：
  - `npm login` 会话已过期，重新以浏览器 web 流程登录（`ljdavns`）；未读取、粘贴或保存 token/OTP。
  - 首次 `npm publish` 在非 TTY 后台进程中直接以 `EOTP` 失败，且 npm 把 2FA URL 在 stdout 和 debug log 中都打码为 `***`；改用 `script` 分配伪终端重跑，取得完整 URL 并由浏览器完成 2FA。
  - `p-spore@0.1.1` 发布成功，`latest` 指向 `0.1.1`；远端 manifest 同时包含 `pspore` 与 `p-spore` 两个 bin。
- 修改文件：无源码改动（发布 `f625261` 已提交的内容）；本次仅更新 `memory-bank/*.md`。
- 验证方式与结果：
  - `prepublishOnly` 的 `npm run check` 在发布前自动通过：typecheck、89 项测试、build 全绿。
  - 远端 `dist.shasum` `3de29b49bac96dc9d70795cb9ec07f02000c22a7` 与本地 `npm pack` 产物一致；`integrity` 为 `sha512-ems5KA+Fe5e3u...myDScMWCEbnDA==`；261 files、267.3 kB。
  - 全新 cache + prefix 从 registry 安装 `p-spore@0.1.1`：`bin/` 同时生成 `p-spore` 与 `pspore`；`--version`、`--help`、`init`、`doctor`、`status` 均正常，help usage 正确回显所用命令名。
  - 从仓库外启动 daemon 成功（`ready`，UDS socket 建立），`status` 与 `jobs` 经 UDS 正常返回，daemon 干净退出（exit 0）。
  - 临时 cache/prefix/home 已全部删除。
- 当前状态：用户报告的“安装后命令不存在”问题已在 registry 上修复并验证。当前无常驻服务，本阶段无前端视觉改动，不需要 viewport 验收。
- 遗留问题：当 `PSPORE_HOME` 导致 UDS 路径超过 108 字节时，daemon 只报 `listen EINVAL: invalid argument`，错误信息不明确；已记入 todo。Electron renderer 中文文案仍未英文化。

## 2026-08-13 10:30 CST — 首次启动 TUI 推荐进入模型配置 wizard

- 阶段目标：用户首次启动、尚无模型配置时，主动推荐进入配置 wizard，并由用户 y/n 确认，不强制。
- 完成内容：
  - `LlmSettingsService.isModelConfigured()`：以 `config.model !== null` 为判定，与 Daemon 触发 `model_not_configured` 的门槛完全一致；通过 config.json + 环境变量凭据配好的用户不会被反复打扰。
  - `TuiSettingsPort` 增加可选 `isModelConfigured()`；TUI `run()` 启动后调用 `#offerModelSetup()`。
  - 未配置时展示 `Model setup recommended` 面板并询问 `Run the model setup wizard now? [Y/n]`；直接回车或 y/yes 进入既有 6 步 wizard，n/no 或 Esc 跳过并提示 `/config wizard`。
  - 决策逻辑抽为纯函数 `acceptsModelSetupOffer` 与常量 `MODEL_SETUP_OFFER_PROMPT/LINES`，可单元测试。
  - 真机验证时发现并修复一个自写缺陷：`#offerModelSetup` 从 `run()` 以 `void` 调用，不经过 `#submit` 的 `finally { requestRender() }`，导致拒绝路径改了 store 却不重绘，界面仍停在推荐面板；已按既有模式补 `finally` 重绘。
- 修改文件：`src/settings/llm-settings-service.ts`、`src/ui/tui/tui-app.ts`、`test/unit/cli-config.test.ts`、`test/unit/tui-store-view.test.ts`。
- 验证方式与结果：
  - `npm run check` 通过：typecheck、92 项测试（新增 3 项）、build 全绿。
  - 真实 TUI 在 PTY 下端到端验证（注意 raw 模式回车是 `\r` 而非 `\n`）：全新 home 弹出推荐面板；回车进入 `1/6 provider`；`n` 与 Esc 均显示 `Skipped model setup…` 并退回会话；完整走完 6 步后 `config.json` 写入 `{"provider":"deepseek","model":"deepseek-v4-flash","thinking":"off"}`；用已配置 home 再次启动不再提示。
  - 临时 home 与日志已清理。
- 当前状态：首启动引导已可用，未改变既有 `/config wizard` 行为与 CLI `config` 语义。TUI 主基准 `160×45` 未改布局，本次仅新增面板与问句。
- 遗留问题：TUI 顶栏在尚无会话时恒显示 `model not configured`（读的是 `selected?.model` 而非配置），属既有显示问题，已记入 todo；桌面端未加同样引导。

## 2026-08-13 10:47 CST — `p-spore@0.1.2` 发布（首启动模型配置引导）

- 阶段目标：把首次启动推荐进入模型配置 wizard 的能力发布到 npm。
- 完成内容：
  - 版本升到 `0.1.2`（`package.json`、`src/version.ts`、lockfile 同步）。
  - 首次 `npm publish` 因 2FA 认证链接在点击前过期失败（`E404 GET /-/v1/done?authId=***`），registry 未产生任何版本；确认 `0.1.2` 未被占用后重试。
  - 重试改用 `--ignore-scripts` 跳过发布前重复的 `prepublishOnly`，让 2FA 链接立即出现、把完整有效期留给点击；等价校验已在发布前手动执行并确认 `dist/` 为 0.1.2 最新构建。
  - `p-spore@0.1.2` 发布成功，`latest` 指向 `0.1.2`。
- 修改文件：`package.json`、`package-lock.json`、`src/version.ts`、`memory-bank/*.md`。
- 验证方式与结果：
  - 发布前 `npm run check` 通过：typecheck、92 项测试、build 全绿。
  - 远端 `dist.shasum` `7f26f90ef739dffe4073e457e3b8a0b2d9a9654b`；全新 cache + prefix 安装 `p-spore@latest` 得到 `0.1.2`，`p-spore` 与 `pspore` 两个 bin 均生成。
  - 用 registry 安装的产物在 PTY 中真实首启动：全新 home 正确弹出 `MODEL SETUP RECOMMENDED` 面板与 `Run the model setup wizard now? [Y/n]`；`p-spore --version` 为 `0.1.2`。
  - 临时 cache/prefix/home 已清理。
- 当前状态：首启动引导已在 registry 上可用并验证。无常驻服务，本阶段无前端视觉改动。
- 遗留问题：TUI 顶栏无会话时恒显示 `model not configured`；桌面端未加同样引导；Electron renderer 中文文案未英文化。

## 2026-08-13 16:20 CST — Cowork TUI 活动体验与 DeepSeek 桌面/记忆验证（0.1.4）

- 阶段目标：以真实 `deepseek/deepseek-v4-flash` 执行桌面文件、系统诊断与长期记忆任务，记录基线后优化 TUI 的 cowork 表现，并确保活动核心同步用于 Electron GUI。
- 优化前真实基线：
  - 行程计划文件创建：1 次 `edit`，5.581 s，正确生成总额 `¥1180`。跨文件摘要正确，但多执行 1 次不必要的 `shell ls`。
  - 系统检查中 `node --version 2>/dev/null` 被误判为 device mutation，需要 1 次人工审批；批准后生成正确 `system-check.md`。
  - 长期偏好保存：14 次工具、8 次 `memory_curate` 参数失败、25.899 s；根因为工具实现要求 `session:/run:/file:` source，但 model-facing schema 未公开格式。最终用 `session:main` 成功，Daemon 重启后 1.941 s 可无工具召回。
- 完成内容：
  - 新增 `src/ui/shared/activity.ts`，将 tool started/updated/completed 按 `toolCallId` 合并成一个 `CoworkActivity`，统一 cowork 语义 label、target、running/succeeded/failed、result、duration 与 8 KB 脱敏详情；同时保留 run/compaction/retry/error/automation/agent/integration 活动。
  - TUI 区分 user 蓝、pSpore 绿、working 琥珀、success 绿、failure 红、memory 紫，并尊重 `NO_COLOR`/`TERM=dumb`；顶栏会以 120 ms spinner 在 Thinking / Writing response / 当前工作步骤间切换。
  - 会话不再重复显示 raw tool message，改为 `WORK STEPS` 卡片；`/work` 查看历史，`/work <ID-prefix>` 查看脱敏详情。配置 wizard 增加进度和步骤说明，顶栏在无 session 时回退显示已保存 model。
  - Electron renderer store 消费同一 `CoworkActivity` reducer，工具卡在原位更新状态点、语义 label、目标和结果，技术详情保持可折叠，其他活动不回退。
  - `memory_curate` schema 补齐 exact hash 与 source 格式；Shell risk 仅从 device 写入检测中排除精确 `/dev/null` 重定向，其他 `/dev/*` 仍需审批。
- 优化后真实 DeepSeek 结果：
  - 系统检查：4 次 `shell` + `edit` + `read`，8.487 s，0 失败、0 审批，正确生成 `system-check.md`。
  - 长期记忆：1 次 `read` + 1 次 `memory_curate`，6.690 s，0 失败，仅新增 1 条。Daemon 重启后 3.629 s 无工具正确召回“中文、开头决策、随后负责人与截止日期”。
  - 真实 TUI 文件任务：`edit` 从 `Updating file` spinner 原位变为 `Updated file`，显示 `92 B written · 14 ms`；生成的 `tui-brief.md` 内容精确，`/work` 历史与详情面板均正常。
- 验证方式与当前结果：针对性 typecheck 与 20 项 TUI/desktop/memory/policy 测试通过；`npm run check` 通过严格 typecheck、94 项测试和 production build；真 TTY 在 `160×45` 和 `96×30` 验证配色、动画、换行、工作历史与详情无溢出；`npm run test:electron` 通过 `1920×1080`、`1440×900`、`1180×720`、双主题、设置、owned/external Daemon、重连与 IPC allowlist。
- npm 发布门禁：`npm pack` 生成 265 entries、282293 bytes，SHA-1 `29939fc938e4e879c825ab24dcaf26508d11787f`，顶层只有 README/`dist`/`package.json`；全新 cache + prefix 安装后 `p-spore`/`pspore --version` 均为 0.1.4，从仓库外运行 help 成功，临时产物已清理。
- 发布结果：功能与版本提交 `c9d0152` 已 push 到 `origin/main`；通过 npm 短时浏览器 WebAuthn 流程发布 `p-spore@0.1.4`，未读取或保存 token/OTP。Registry 直连确认 `latest=0.1.4`、SHA-1 `29939fc938e4e879c825ab24dcaf26508d11787f`、SHA-512 `sha512-yIttaEGj5xw6hI4nae++7DMLowLr99RWkJgR6MASYHWvbOijba+0tgfiaaFobJf5TNFC3wPe2toVN/HEzebl4w==`，与本地包一致。
- Registry 实装：全新 cache/prefix 安装指定的 `p-spore@0.1.4`，`p-spore`/`pspore` 均报告 0.1.4；从远端包初始化全新 home、启动 Daemon 到 `ready`，`status`/`jobs` 经 UDS 成功，SIGTERM 后 socket 已清理。
- 当前状态：0.1.4 已在 GitHub main 与 npm registry 发布并完成全新用户实装验证；最新 `dist/` 已构建，验收 Daemon/TUI/Electron 进程全部停止，DeepSeek/npm 临时 home、临时凭据副本、发布认证 transcript 与安装目录已删除（不可恢复，均为本轮临时产物）。
- 遗留问题：桌面端首次启动引导、UDS 超长路径提示、Electron renderer 英文化未纳入本轮；sandbox/vector/remote/mobile 仍为非目标。

## 2026-08-13 16:54 CST — 0.1.4 Electron GUI AppImage 重新发行

- 阶段目标：为已发布的 npm 0.1.4 生成同版本 Linux x86_64 GUI AppImage，直接从发行包完成启动、视觉和安全验收后创建 GitHub Release。
- 完成内容：使用 Electron 43.3.0 / electron-builder 26.15.3 从提交 `d12bcbb` 构建 `release-dist/pspore-desktop-0.1.4-linux-x64.AppImage`；包内含最新共享 `CoworkActivity` reducer、TUI/GUI 工具语义与 0.1.4 版本元数据。
- 产物：156,349,369 bytes，mode `0755`，SHA-256 `02a3d74d669977284019c9ba623c42ccc912dee666337db60e2a74c79baad017`，Linux x86-64 ELF/AppImage 结构可执行。
- AppImage 本体验证：从全新临时 home 直接启动 AppImage，`daemonOwnership=owned`、`connection=connected`、reconnect 通过，退出后 socket/endpoint 均清理。检查 `1920×1080` 深/浅主题、设置/审批，以及 `1440×900`、`1180×720` 响应式布局；无 document overflow，composer/检查器可见，字号下限、password input、密钥不回读和 IPC allowlist 断言全部通过。人工检查 1920×1080 与 1180×720 截图无明显遮挡/溢出。
- 发布结果：发行前记录提交 `a2f9cef` 已 push；签名标签 `v0.1.4` 已 push 并以 `pSpore v0.1.4` 创建公开 GitHub Release，成为 Latest。远端资产 `pspore-desktop-0.1.4-linux-x64.AppImage` 的 media type 为 `application/vnd.appimage`，size 为 156,349,369 bytes，GitHub digest 为 `sha256:02a3d74d669977284019c9ba623c42ccc912dee666337db60e2a74c79baad017`。
- 远端反向验证：从 GitHub Release 全新下载该资产，重新计算 SHA-256 与本地/GitHub digest 完全一致，`file` 确认仍为 Linux x86-64 ELF/AppImage；下载验证目录已删除。Release URL：`https://github.com/advnljs/pSpore/releases/tag/v0.1.4`。
- 当前状态：0.1.4 GUI AppImage 已在 GitHub Release 发布并完成发行包本体与远端下载双重验证；本地构建产物保留在 ignored `release-dist/`，其他构建中间目录、smoke home/截图/报告和 release notes 临时文件已删除（不可恢复，均为本轮临时产物）。
- 遗留问题：electron-builder 依旧使用默认 Electron 图标且未设置 `desktopName`/WM_CLASS，不影响启动、布局或安全验收，已记录为后续打包体验待办。

## 2026-08-13 11:20 CST — CLI 侧补齐配置引导入口（0.1.3 待发布）

- 阶段目标：用户反馈裸跑 `p-spore` 只看到帮助、看不到配置引导入口；把引导补到 CLI 本身，而不只在 TUI 内。
- 完成内容：
  - 新增 `p-spore setup` 命令（`config wizard` 为同义写法），CLI 原生 5 步引导：provider、model、custom 时的 Base URL/API、thinking、API key；不依赖 TUI。
  - 裸跑 `p-spore`（无任何参数）且 `config.model` 为空时，先输出说明与 `setup` 指引；在交互式 TTY 下追加 `Run the model setup wizard now? [Y/n]`，接受即进入引导，拒绝则打印帮助。
  - `--help`/`help` 显式请求时只加指引横幅、不提问，保持可脚本化。
  - `helpText()` 增加 `setup` 与 `config wizard` 两行，使入口可被发现。
  - 新增 `readLineInput()` 明文单行输入；API key 仍走既有隐藏输入 `readSecretInput()`。
  - `modelNeedsSetup()` 在 home 尚不存在时判定为未配置，且不会因此创建目录；settings 异常不遮挡帮助输出。
- 修改文件：`src/cli/main.ts`、`test/unit/cli-config.test.ts`、`package.json`、`package-lock.json`、`src/version.ts`。
- 验证方式与结果：
  - `npm run check` 通过：typecheck、92 项测试、build 全绿；entrypoint 测试改为隔离临时 home，同时断言未配置时出现指引、配置后指引消失。
  - PTY 真机验证（注意 `script` 必须带 `-f` 才会实时刷新日志，否则轮询读不到输出）：裸跑弹出 `[Y/n]`，回车后依次走完 1/5→5/5，`config.json` 写入 `{"provider":"deepseek","model":"deepseek-v4-flash","thinking":"off"}`，并正确提示尚未配置 API key。
  - 已配置后裸跑不再出现指引横幅；`--help` 可见 `setup` 与 `config wizard`；非 TTY 下 `setup` 明确报错并指向 `config set`。
  - 临时 home 已清理。
- 当前状态：`p-spore@0.1.3` 已于 2026-08-13 11:26 CST 发布，`latest` 指向 0.1.3；全新 cache/prefix 从 registry 安装后，裸跑即出现引导、完整走完 5 步并写入 `config.model`、配置后引导消失，均已验证。
- 遗留问题：TUI 顶栏无会话时恒显示 `model not configured`；桌面端未加同样引导；Electron renderer 中文文案未英文化。

## 2026-08-17 21:34 CST — GUI/TUI 全面视觉与可用性优化（spore print 设计语言）

- 阶段目标：用统一的视觉识别重做 Electron 桌面端与 TUI 的呈现层，修掉主基准下的空区、层级失衡与文案不一致，信息架构与全部功能保持不变。
- 设计方向：确立 "spore print" 设计语言。深色为暖腐殖土底 `#141310` + 骨白文字，浅色为暖纸 `#ede9dc` + 墨字；`--accent`（骨白/墨）只用于主操作、焦点环与选中文本，饱和色留给状态语义：`--live` moss=存活/成功、`--honey`=等待/审批、`--rust`=失败、`--lichen`=用户消息。标识符（session id、会话标题、指标、状态、代码）统一 mono，人类语句用 sans。
- 桌面端完成内容：
  - 重写 `styles.css` 全量 token 与组件层；圆角 13/9/6、去掉发光与重阴影，`select` 用自绘 chevron，禁用态可见，`.composer:focus-within` 有明确焦点环。
  - 会话正文测量宽度收敛到 `820px`（原 980px），长代码块恢复容器内横向滚动；message meta 改为 mono 标签 + 细线分隔；代码块前后多余空行由 `appendRichText` 修剪。
  - 左栏用 `--session-depth` + `└` 型连接线呈现 agent 树，右侧标记从无意义的 `ROOT/L1` 改为真实会话状态；底部常驻 `工作区` 摘要（运行/MCP/资源/待批准），与 TUI WORKSPACE 同源指标，填掉长期空区。
  - `>=1600px` 默认打开检查器（此前 1920×1080 主基准右侧长期空白）；`1321–1599` 会话+对话双栏、`<=1320` 检查器抽屉、`<=1160` 会话栏抽屉，行为不变。
  - 审批弹层重新分配视觉权重：`拒绝` 为中性实心默认焦点，允许类操作改为 honey 描边（不再把“允许”做成最亮按钮）。
  - 设置弹层去掉装饰性 `01/02/03` 编号；全局删除 8 处装饰性 eyebrow，只保留 `ACTIVE SESSION` 与 `PERMISSION REQUIRED` 两个真正在标注内容的标签。
  - 空会话状态改为可点击的三条真实本地任务示例，点击填入输入框而不直接发送。
  - GUI 文案统一中文（notice、错误、空状态、工具输出摘要）；浅色主题 `--faint` 提到 `#746d5c` 以满足 4.5:1 小字对比度，并新增 `prefers-contrast: more` 兜底。
- TUI 完成内容：
  - 配色与桌面语义对齐（brand/bone 187、live 108、agent 151、lichen 109、honey 179、rust 174、memory 182、muted 245、faint 242）。
  - header/context 行改为左右分栏（`sideBySide`），会话内容自输入行向上生长（`anchorBottom`），左栏 SESSIONS 置顶、WORKSPACE 贴底（`composeColumn`）；子 agent 用 `└─` 分枝。
  - 消息角色改为固定 8 列 gutter 对齐；footer 去掉多余分隔线，节省一行正文空间；help 行的命令 token 用 bone 高亮；空会话给出三条英文示例任务。
- 修改文件：`src/desktop/renderer/styles.css`、`index.html`、`renderer.ts`、`store.ts`、`src/ui/tui/view.ts`、`test/unit/tui-store-view.test.ts`、`memory-bank/module-desktop.md`、`memory-bank/module-interface-protocol.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、94 项测试、production build 全绿。
  - `npm run test:electron` 通过：1920×1080 主基准 + 1440×900 + 1180×720，双主题、设置、审批、owned/external Daemon、重连、字号下限与 IPC allowlist 断言全部通过；逐张人工检查深色/浅色/设置/审批/响应式截图。
  - 修复前基线 smoke 实际是失败的（`long code did not exercise contained horizontal scrolling`：980px 测量宽度下 fixture 长代码不再溢出）；收敛测量宽度后该断言恢复真实覆盖。
  - TUI `160×45` golden snapshot 哈希更新为 `95a5f403…1db57a9c`，并新增两条结构断言（对话贴近输入行、WORKSPACE 位于 SESSIONS 之下）；`96×30` 单栏渲染同步核对。
- 当前状态：最新代码已构建到 `dist/`，桌面 smoke 与全量测试均基于当前工作树；本轮验收用的 Daemon/Electron 进程已随 smoke 结束退出，临时 home 与截图位于系统临时目录，未进入仓库。
- 遗留问题：`src/ui/shared/activity.ts` 的 cowork label/summary 仍是英文（TUI/CLI 要求英文且两端共用），中文 GUI 内呈现为混排；transcript 每次渲染整树重建，长会话下有性能风险，均已记入 `todo.md`。

## 2026-08-18 — GitHub Actions 自动构建 GUI 并发布到 Release

- 阶段目标：增加 GitHub CI，在推送版本 tag 时自动构建 Linux Electron GUI AppImage 并放到 GitHub Release。
- 完成内容：
  - 抽出共享打包配置 `electron-builder.yml` 与脚本 `scripts/package-desktop.sh`，产物仍为 `pspore-desktop-<version>-linux-x64.AppImage` 及 SHA-256。
  - `package.json` 增加 `package:desktop`；本地 `scripts/release.sh` 改为调用同一打包脚本，并在 Release 已存在时上传而不是失败。
  - `.github/workflows/ci.yml`：PR 与 `main` 上运行 `npm run check`，并校验提交的 `dist/` 与当前构建一致。
  - `.github/workflows/release.yml`：推送到 `main` 或与 `package.json` 版本一致的 `v*` tag 时构建 AppImage，并直接创建或更新 `v<version>` GitHub Release（不再只留在 Actions artifact）。
- 修改文件：`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`electron-builder.yml`、`scripts/package-desktop.sh`、`scripts/release.sh`、`package.json`、`memory-bank/*.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、94 项测试、production build 全绿；`git diff --exit-code -- dist` 无差异。
  - 本环境用 Node `v24.19.0` 执行 `bash scripts/package-desktop.sh 0.1.4`：electron-builder `26.15.3` 产出 `release-dist/pspore-desktop-0.1.4-linux-x64.AppImage`（约 150M，mode `0755`，ELF x86-64），SHA-256 `8bebd70eff1ffceb88245637081b8ee2250ad09321b0650f58c1541c14c072f4`。本地产物在 ignored `release-dist/`，未提交。
  - 顺带修复 `scripts/release.sh` / `package-desktop.sh` 的 Node 主版本检查（原先把 JS `true` 误当成 `"1"`，会在 Node 24 上误报不合格）。
- 当前状态：CI 与 Release 工作流已加入仓库并完成本地打包验证。合并到 `main` 后，Release 工作流会把 AppImage 直接上传到 `v<package.version>` GitHub Release。
- 遗留问题：electron-builder 默认图标与 WM_CLASS 仍待补齐；AppImage 本体视觉 smoke 仍需在发行前按既有约束从包本身跑 `--smoke-dir/--smoke-fixture`。

## 2026-08-20 — 桌面 zip 发行、纵向铺满与 LLM 代理 Cookie

- 阶段目标：把 GUI 发行从 AppImage 改为可解压的压缩包（含一键创建桌面快捷方式），另提供不含 Chromium 的 overlay 覆盖升级包；修复主界面初始未纵向铺满；调用 LLM proxy API 时支持设置 Cookie。
- 完成内容：
  - 版本升到 `0.1.5`。
  - `electron-builder.yml` 改为 linux `dir`；`scripts/package-desktop.sh` 产出全量 `pspore-desktop-<version>-linux-x64.zip`（含可执行 `创建桌面快捷方式.sh`）与 overlay `pspore-desktop-<version>-linux-x64-overlay.zip`（仅 `resources/app.asar` + `覆盖升级.sh`）。
  - 共享 LLM settings 增加可选 Cookie：私有文件 `credentials/<provider>.cookie`（`0600`），`models.json` 通过 `headers.Cookie` 的 `!cat` 引用，GUI/TUI/CLI 同步，read API 只返回 `hasCookie`。
  - 桌面 CSS 改为 `body` flex + `.app-shell`/`workspace-grid`/`panel` 纵向拉伸，去掉初始 `translateY` 动画，首屏铺满窗口高度。
- 验证方式与结果：
  - Node `v24.19.0`：`npm run check` 95 项测试、typecheck 与 production build 通过。
  - `npm run test:electron`：1920×1080 / 1440×900 / 1180×720、双主题、设置 password（含 Cookie）、密钥不回读通过。
  - 本地打包：全量 zip 147M，SHA-256 `c1e3531777361e57115d1cf29b5a97c42111d91affc07673272c9db32b6079b9`；overlay zip 21M，SHA-256 `813fab8e001eb4c7fd3a4fb4a4e5ba7ed09c4f64356de3ed37ebd8c42856868a`。
- 当前状态：代码与 `dist/` 已更新；GitHub Release `v0.1.5` 上传全量 zip 与 overlay zip。

## 2026-08-21 — GUI Markdown 渲染、Bypass 授权模式与首屏铺满修复

- 阶段目标：增强桌面端 Markdown 渲染；提供跳过所有授权确认的 bypass 选项；修复 GUI 初始未占满窗口高度。
- 完成内容：
  - 新增共享纯解析器 `src/ui/shared/markdown.ts`（CommonMark/GFM 子集）：ATX 标题、围栏代码（含 streaming 未闭合围栏）、引用、有序/无序/任务列表与嵌套、分隔线、GFM 表格与对齐、行内 code/strong/em/strike/链接与转义；带深度上限，非法或不成对标记原样保留。
  - 新增 `src/desktop/renderer/markdown-view.ts` 只用 `createElement`/`textContent` 构建 DOM（不使用 `innerHTML`，符合既有 CSP 与渲染约束）；代码块带语言标签与复制按钮（`navigator.clipboard` 失败时回退 `execCommand`）；链接因主进程禁止外部导航而渲染为惰性文本 + 可复制 URL，非 http/https/mailto/file 协议不识别为链接。
  - `renderMessage` 与 streaming 消息统一走 Markdown 渲染，`styles.css` 增加 spore print 风格的标题、列表、任务勾选、引用、表格（自身横向滚动）、行内 code 与链接样式。
  - 共享 settings 契约增加 `permissionMode`，写入 `config.permissions.mode`：GUI 设置弹层新增“权限”区与 bypass 风险告警；TUI `/config permissions MODE`；CLI `config permissions MODE`（`bypass` 为 `allow_all` 别名），`config show` / `/config` 均显示当前模式。owned Daemon 保存后自动重启生效，external Daemon 提示重启。
  - 修复首屏纵向留白：`.app-shell` 由固定三行 grid 改为 flex column（连接横幅 `display:none` 时原模板仍保留空轨道与 8px gap）；`desktopWindowOptions` 按主显示器 work area 收敛初始尺寸（1920×1080 content 在 1080p 屏上原本超出屏幕底部 31px），首次显示时 `maximize()`；窗口 `backgroundColor` 对齐 `--canvas`。
  - Electron smoke 新增断言：`app-shell` 高度等于 viewport、workspace 底部留白 ≤12px（三档分辨率均校验）、权限下拉选项固定四项、切到 bypass 时风险告警出现且切回后消失。
- 修改文件：`src/ui/shared/markdown.ts`、`src/desktop/renderer/markdown-view.ts`、`src/desktop/renderer/renderer.ts`、`src/desktop/renderer/index.html`、`src/desktop/renderer/styles.css`、`src/desktop/main.ts`、`src/desktop/security.ts`、`src/desktop/smoke-fixture.ts`、`src/settings/llm-settings.ts`、`src/settings/llm-settings-service.ts`、`src/cli/main.ts`、`src/ui/tui/tui-app.ts`、`src/ui/tui/commands.ts`、`README.md`、`test/unit/markdown.test.ts`、`test/unit/desktop-settings.test.ts`、`test/unit/desktop-security.test.ts`、`test/unit/desktop-ipc-validation.test.ts`、`test/unit/cli-config.test.ts`、`memory-bank/*.md`。
- 验证方式与结果：
  - Node `v24.19.0`：`npm run check`（typecheck + 128 项测试 + production build）通过。
  - `npm run test:electron` 通过：1920×1080 主基准与 1440×900、1180×720 补测，双主题、设置、字号、owned/external Daemon、重连、IPC allowlist，以及新增的铺满与 bypass 告警断言。
  - Xvfb 实测窗口尺寸：1920×1080 屏由原先 content bottom 1111（越界 31px）收敛为 1079；1366×768 与 2560×1440 下 `app-shell` 高度均等于 viewport，workspace 底部仅剩 10px 设计留白。
  - Markdown 解析器 16 项单测覆盖标题/围栏/未闭合围栏/列表切换/任务项/表格/行内标记/危险链接协议/深度上限。
- 当前状态：版本升到 `0.1.6`，源码与 `dist/` 已同步重建并推送到 `main`（commit `98888cb`）。GitHub Actions `CI` 与 `Release desktop` 均 success，已发布 https://github.com/advnljs/pSpore/releases/tag/v0.1.6 ，含 `pspore-desktop-0.1.6-linux-x64.zip` / `-overlay.zip` 及各自 SHA-256。 已按发行验收要求直接从 Release 下载全量 zip，`sha256sum -c` 通过，并用包内 `pspore-desktop --smoke-dir --smoke-fixture` 在 Xvfb 2048×1200 下跑通全部断言（owned Daemon、双主题、三档布局、`app-shell` 高度 1080/900/720、workspace 底部留白均为 10px、权限四模式与 bypass 告警）。
- 遗留问题：Markdown 链接仍不可点击跳转（主进程按安全基线禁止外部导航）；`allow_all` 只是策略放开，不构成沙箱；本轮未发布 npm 新版本。

## 2026-08-22 — 打包流程并入本地 release 二进制包

- 阶段目标：按用户新 spec，让每次打包在本地同时生成 CLI release 二进制包，且二进制产物保持被 Git 忽略。
- 完成内容：
  - 新增 `scripts/build-cli-binary.sh`：从 `dist/cli/main.js` 经 esbuild CJS bundle、`import_meta` 补丁、Node SEA blob 与 postject 注入，产出 `release-dist/pspore-<version>-linux-x64`，并自检 `version` 与 `--help`；完成后清理中间产物（bundle/blob/sea-config）。
  - `scripts/package-desktop.sh` 在产出全量 zip 与 overlay zip 后调用上述脚本，`npm run package:desktop` 现在一次性生成桌面双 zip + CLI 二进制。
  - `scripts/release.sh` 删除内联 SEA 构建逻辑，改为复用 `build-cli-binary.sh`，上传行为与产物清单不变。
  - `memory-bank/specs.md` 增加对应约束与本地打包验收标准（2026-08-22）。
- 验证方式与结果：
  - `npm run package:desktop` 实跑通过：全量 zip 147M（sha256 `1b09c93d…265c008`）、overlay zip 21M（sha256 `7627bd6c…85d039c`）、CLI 二进制 140M。
  - 二进制自检：`pspore-0.1.6-linux-x64 version` 输出 `pSpore 0.1.6 (Pi 0.84.1, Node 24.19.0)`，`--help` 正常（50 行）。
  - `git check-ignore` 确认二进制与 zip 均被 `.gitignore` 的 `release-dist/` 规则忽略，`git status` 无打包产物。
- 当前状态：脚本改动与 memory-bank 已提交；`release-dist/pspore-0.1.6-linux-x64` 留在本地供直接使用。
- 遗留问题：CI（`release.yml`）仍只上传桌面双 zip，不上传该 CLI 二进制（沿用 `scripts/release.sh` 手动发布路径）；如需 CI Release 也附带二进制需另行确认。

## 2026-08-22（下午）— 本地 release 产物管线固化

- 阶段目标：落实"每次都构建和 release 一样的可执行二进制目录到本地"的 spec，并补齐 GUI 重构后缺失的最新打包。
- 完成内容：
  - `scripts/package-desktop.sh` 新增步骤：每次打包自动把 staging 内容复制为 `release-dist/pspore-desktop-<version>-linux-x64/` 可执行目录（与全量 zip 内容一致，等价 release.sh 的解压结果）。
  - 重新执行 `npm run package:desktop`：全量 zip、overlay zip、sha256、SEA CLI 二进制、可执行目录全部刷新至 c688a50（含 cobalt paper GUI + GSAP vendor），已用 grep 确认 app.asar 内含新样式与 gsap 脚本引用。
- 验证方式与结果：
  - 打包脚本 exit=0；CLI 二进制自检 `--help` OK；产物时间戳与内容核验通过。
- 当前状态：spec 已记录到 `memory-bank/specs.md`，本地产物与最新代码一致。
- 遗留问题：无新增。

## 2026-08-26 — 生产 Daemon 改由 systemd 用户服务托管

- 阶段目标：让完整 pSpore 后端成为可自动注册、登录后自启、异常重启的系统服务；GUI/TUI 仅作为客户端壳，退出时不再关闭后端。
- 完成内容：
  - 新增 `SystemServiceManager`，以私有、原子方式维护 XDG `systemd/user` unit，执行 `daemon-reload`、`enable --now`、重启、状态、日志和卸载；unit 不经 Shell 启动，包含 `Restart=always`。
  - 新增 Node/npm、SEA 和 Electron-as-Node 三类稳定启动命令生成器；默认 home 使用 `pspore.service`，自定义 home 使用稳定哈希 unit 名，避免多实例冲突。
  - CLI 新增 `service install|start|restart|stop|status|logs|uninstall`；TUI 启动时自动确保服务已安装并运行，退出只断开连接。
  - Electron 生产启动自动确保 systemd 服务并仅维护 UDS bridge；设置保存后重启服务并重连。桌面 smoke 测试继续使用隔离的 `DaemonSupervisor`，不污染真实用户服务。
  - 启动前会温和关闭旧版非 systemd 管理的 Daemon，以避免旧锁和 socket 阻止迁移；尝试启用 user linger，并在权限不足时返回可理解警告。
- 修改文件：`src/service/*`、`src/cli/main.ts`、`src/desktop/main.ts`、`test/unit/system-service.test.ts`、`README.md`、`docs/project-overview.md`、`memory-bank/*`，以及同步构建的 `dist/`。
- 验证方式与结果：`npm run check` 通过（严格 typecheck、117/117 测试、production build）；新增 4 项服务测试覆盖 unit 转义、隔离 systemd 生命周期、三类发行启动命令与多 home 命名；`git diff --check` 通过。
- 当前状态：源码与 `dist/` 已同步；生产客户端不再拥有或随退出停止后端。尚未在本阶段启动真实用户服务，待后续会话协议改造完成后用最新完整服务做端到端验收。
- 遗留问题：跨 session 恢复、自动 follow-up/队列直接发送、compact 设置、流式 Markdown/虚拟渲染和桌面快捷方式仍在本次任务后续阶段实现。

## 2026-08-26 — 多根 session 恢复与统一发送队列

- 阶段目标：支持跨客户端/跨服务重启的新建与切换 session，启动加载完整历史；删除 GUI 三模式 composer，让普通发送自动排队，并给每条 follow-up 提供“继续排队/直接发送消息”。
- 完成内容：
  - 新增私有原子 `SessionCatalog`，持久映射根 session ID、标题、时间、cwd 与 Pi JSONL；服务 ready 前逐个 `resume`，旧安装无 catalog 时只迁移最近的 legacy JSONL 为 `main`。agent/automation 临时 session 不进入目录。
  - Application 新增 `session.create`、`session.queue.send-now`；`session.prompt` 默认 `auto`，空闲时 prompt、运行中时 follow-up。根 session metadata 随 Kernel snapshot 进入 GUI/TUI；每个根 session 注册独立 subagent root。
  - Pi adapter 增加 follow-up 提升操作：清空并保持原队列顺序，把指定 follow-up 重排到 steering 队列，不重复发送消息。
  - GUI 左栏新增 `＋` 并立即切换新会话，所有 prompt/abort/compact/spawn 都使用当前 session；删除 Prompt/Steer/Follow-up 下拉。排队卡逐条显示“继续排队”和“直接发送消息”。
  - TUI 新增 `/new [TITLE]`、`/send-now N`，`/select` 可切换任意根会话及历史；普通输入不再因运行中而拒绝。CLI 新增 `sessions`、`session new [TITLE]` 与 `prompt --session ID TEXT`。
- 修改文件：`src/sessions/session-catalog.ts`、`src/application/agent-application.ts`、`src/daemon/daemon.ts`、`src/pi/pi-runtime-adapter.ts`、`src/domain/runtime.ts`、`src/agents/agent-manager.ts`、`src/ui/shared/presentation.ts`、`src/ui/tui/*`、`src/desktop/ipc-contract.ts`、`src/desktop/renderer/*`、`src/cli/main.ts`、相关测试/文档及同步构建的 `dist/`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、124/124 测试、production build。
  - 新增真实 Pi contract 验证队列提升后的用户消息顺序为“指定直接发送项 → 其余继续排队项”，且不重复；Daemon 集成测试验证多 session 创建、服务重启恢复标题/完整历史、auto follow-up 与 send-now。
  - `npm run test:electron` 通过：PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`，双主题、设置、排版、smoke Daemon ownership、重连和 IPC allowlist 全绿。
  - TUI 主基准 `160×45` golden 与 `96×30` 补测通过，并新增“继续排队/直接发送消息”逐项文案断言。
- 当前状态：源码与 `dist/` 同步构建；全部根 session 会在服务启动时加载，GUI/TUI composer 已统一。当前 smoke 使用隔离 Daemon，未改动真实用户 home/service。
- 遗留问题：自动 compact 设置、流式 Markdown/字符清理、GUI/TUI 长历史虚拟渲染和桌面快捷方式仍在后续阶段。

## 2026-08-26 15:27 CST — 自动 compact、流式 Markdown 与长历史虚拟渲染

- 阶段目标：让自动 compact 长度可配置，清理正文中的内部工具标记，并让 GUI/TUI 在恢复长历史后保持流畅。
- 完成内容：
  - `config.context.autoCompaction` 增加 `enabled/reserveTokens/keepRecentTokens`；缺少字段的旧 v1 config 自动使用 `true/16384/20000`。共享 settings 接入 GUI“自动压缩”、TUI/CLI `config compact`，保存后服务重启应用到全部新建/恢复 session。
  - Pi adapter 为每个 session 注入同一 compact 策略；assistant transcript 只提取公开 text block，不再把 tool call/thinking 合成为 `[tool:shell]` 等正文。
  - GUI streaming frame 合并到 animation frame；store 不再每帧深拷贝完整 Kernel。新增 Fenwick tree 变高虚拟列表、测量校正和 128 项消息 DOM LRU，只渲染视口与 overscan。
  - TUI store 同样复用不可变快照引用，历史从尾部反向格式化到 `rows + offset + overscan` 即停止；Braille spinner 改为兼容最小 Linux console 的 ASCII，GUI 字体链补 Emoji/Symbol fallback。
- 修改文件：`src/settings/*`、`src/config/config.ts`、`src/pi/pi-runtime-adapter.ts`、`src/daemon/daemon.ts`、`src/ui/shared/virtual-list.ts`、GUI/TUI renderer/store、smoke fixture、相关测试/文档及同步 `dist/`。
- 验证方式与结果：
  - `npm run typecheck` 通过；49 项针对性 unit/contract 测试通过，含旧 config 兼容、compact 持久化、工具标记清理、10000 条 TUI/虚拟索引性能边界。
  - `npm run test:electron` 通过；PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`。fixture 含 1007 条权威历史并断言实际 DOM 少于 40，同时覆盖 streaming Markdown、compact 设置、双主题、重连、owned/external Daemon 与 IPC 安全。
  - 首轮 smoke 捕获到 browser renderer 因共享常量误导入 Node config 模块而被 CSP 阻止；已拆出 browser-safe `compaction-settings.ts` 后在相同压力 fixture 复跑通过，未放宽 CSP。
  - `npm run package:desktop` 通过并刷新本地产物：全量 zip 149M（sha256 `3c56e6d5…23180878`）、overlay 23M（sha256 `dc65c344…569424f`）、140M SEA CLI（`version` 与 61 行 `--help` 自检通过）及可执行目录；均位于被 Git 忽略的 `release-dist/`。
- 当前状态：源码与 `dist/` 已同步构建；compact/Markdown/虚拟历史阶段完成，尚未启动真实用户 service。
- 遗留问题：Linux 快捷方式、overlay 跨版本升级验证与最终完整打包/系统服务端到端验收仍待后续阶段。

## 2026-08-27 09:40 CST — Linux 快捷方式与 `v0.1.5 → 0.1.6` 无 Chromium 升级

- 阶段目标：修复 zip 内 `.desktop` 无法启动的问题，并确认不含 Chromium 的 overlay 能从上一版真实发行物安全升级到当前版本。
- 完成内容：
  - 快捷方式安装器不再直接把安装目录和错误的 `Path="..."` 写进 Desktop Entry；改为固定 XDG launcher + `0600` 安装路径记录，launcher 进入真实安装目录后启动 GUI，并将诊断写到 `XDG_STATE_HOME/pspore/desktop-launcher.log`（1 MiB 轮转、右键可打开日志）。
  - overlay 从单个盲覆盖 `app.asar` 改为完整应用 payload（`app.asar`、`app.asar.unpacked`、`app-update.yml`），仍不包含 Electron/Chromium。manifest 固定应用版本、Electron 精确版本、Linux/x64 与目录 SHA-256；updater 使用目标 Electron-as-Node 验证兼容性和 payload，升级前后执行 CLI 自检，原子替换顶层资源，保留 `.pspore-backup-*` 并重启匹配的 systemd unit。
  - 修复 Electron ASAR hook 对完整性校验的干扰（hash 时 `process.noAsar=true`）；修复虚拟历史仍使用 CSS smooth scroll 导致 1007 条历史自动尾随停在中段的问题，改为即时窗口定位。smoke 不再要求长代码块与 streaming 尾部同时存在于同一虚拟 DOM 窗口，而是在独立捕获状态验证两者。
  - GitHub Release notes、本地 release 脚本、README 与中文项目说明已同步新的执行方式和兼容门禁。
- 修改文件：`scripts/linux/create-desktop-shortcut.sh`、`scripts/linux/apply-overlay-upgrade.sh`、`scripts/package-desktop.sh`、`scripts/release.sh`、`.github/workflows/release.yml`、`src/desktop/main.ts`、`src/desktop/renderer/styles.css`、`test/integration/release-scripts.test.ts`、同步 `dist/`、README/docs 与 memory-bank。
- 验证方式与结果：
  - 新增 3 项发行脚本集成测试：稳定 launcher/日志、完整 payload 替换+回滚+服务重启、篡改 payload 写入前拒绝；最终 `npm run check` 通过 TypeScript 检查、132/132 测试与生产构建。
  - 旧脚本生成的 `Path="..."` 被 `desktop-file-validate` 明确警告为非绝对路径；新脚本在安装目录含空格和 `%` 时通过 validator，并由隔离 XDG/HOME 下的 `gtk-launch pSpore.desktop` 实际启动到 launcher 日志。
  - 下载 GitHub `v0.1.5` 全量 zip 并通过其 SHA-256；旧目录实测 `pSpore 0.1.5 / Electron 43.3.0 x64`。应用当前 29M overlay 后变为 `pSpore 0.1.6`，Electron 仍为 `43.3.0/x64`；从该升级目录执行 Electron smoke 通过 owned Daemon、connected、1920×1080、1007 条权威历史仅 7 个消息 DOM、streaming 可见且尾部距离 0。
  - `npm run test:electron` 通过 external/owned Daemon、1920×1080 主基准、1440×900、1180×720、双主题、设置、安全与重连；人工复核升级目录的 1920×1080 明/暗截图，无明显溢出、遮挡或旧界面。
  - 最终本地产物：全量 zip 149M，SHA-256 `b4e5465109b386657fb1cc83ccb514af27e01481d0bfd3e64ff7147920510552`；overlay 29M，SHA-256 `16d620dd9f0ea9c148007d8ee9f7bf5e448612011bf53ba1e0ef1fcf36758a3c`；SEA CLI 140M，SHA-256 `b508219de7363d07b44e88489402249ba09c0256ebab416320bb27a3a73a7e84`，`version` 与 61 行 `--help` 自检通过。overlay 文件名扫描未发现 Electron/Chromium 运行时文件。
- 当前状态：快捷方式与上一版跨版本升级目标均完成；构建/视觉验收进程已退出，本地 `release-dist/` 保留最新可运行目录和被忽略的发行产物。
- 遗留问题：产品图标/WM_CLASS、GUI activity 中英混排、Markdown 外链与代码高亮等既有非本轮问题仍见 `todo.md`。

## 2026-08-27 11:03 CST — `0.1.7` 发布候选、thinking 分流与 `v0.1.6 → 0.1.7` 覆盖升级

- 阶段目标：把本周已完成的系统服务、多 session、统一发送、compact、流式/虚拟历史和安装升级修复作为新版本 `0.1.7` 发布；修正 reasoning 混入正文的问题，并用上周官方 `v0.1.6` 基线验证无 Chromium overlay。
- 完成内容：
  - 版本统一升到 `0.1.7`；增加自动测试，约束 `package.json`、`package-lock.json` 根版本和 `src/version.ts` 始终一致。
  - `message.thinking.delta` 与正文 delta 在共享 reducer、Desktop IPC/bridge、GUI 和 TUI 中拆为独立通道；GUI 使用“思考中”临时面板，TUI 使用 `thought` gutter，`message.completed` / run settle / error / session replacement 后自动清除，不进入最终 Markdown 或历史。
  - Release workflow 改为只接受匹配 package 版本的新 annotated `v*` tag；已有 tag/Release 时拒绝覆盖，普通 `main` push 只跑 CI。CLI、全量 zip、overlay zip 均生成并发布 SHA-256；预发行版本按 SemVer 后缀自动标记 prerelease。
  - 本地发布脚本改为固定 `npm ci → npm run check → 完整打包 → 六项资产/可运行目录校验 → annotated tag push`，不再调用 `gh release upload --clobber`。
- 修改文件：共享 protocol state、Desktop bridge/IPC/renderer/smoke、TUI store/view、相关 contract/unit/integration tests、版本与打包/Release 脚本、README/docs、同步构建的 `dist/` 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、135/135 测试和 production build 全绿；`release.yml` 通过 YAML parser，发布脚本通过 `bash -n`。
  - `npm run test:electron` 通过 external/owned Daemon、`1920×1080` 主基准及 `1440×900`、`1180×720`；两份报告均为 `thinkingVisible=true`、`thinkingSeparate=true`、`thinkingHiddenAfterCompletion=true`、`legacyComposerModes=0`，1007 条权威历史只渲染 7 个可见消息节点。人工复核深/浅截图，运行态思考与正文分区，完成态思考区消失。
  - 官方 `v0.1.6` tag 已拉取并确认指向上周提交 `98888cb9ee0c32f8ccd437bf7218e7437259a2db`。该 Release 创建于 8 月 21 日，但现有附件创建于 8 月 27 日，不能作为旧二进制基线；因此从 tag 的干净 detached worktree 执行 `npm ci` 和原版 `npm run package:desktop`，还原出自检为 `pSpore 0.1.6 / Electron 43.3.0 x64` 的全量安装。
  - 对还原安装应用本地 `0.1.7` overlay 成功：版本变为 `pSpore 0.1.7`，Electron 保持 `43.3.0/x64`；`pspore-desktop`、`chrome-sandbox`、`libffmpeg.so` 的升级前后 SHA-256 分别保持 `57defb64…e973d`、`d7d2a29b…43cc9`、`d80e1fdb…ff03`，并生成 `.pspore-backup-*`。从升级目录直接启动 Daemon + GUI 后连接为 `connected`，`1920×1080` smoke 与 thinking/composer/虚拟历史断言全部通过。
  - 本地 `0.1.7` 全套产物完成并通过三份 `sha256sum -c`：CLI `e6079825…f930`（146,148,544 bytes）、全量 zip `30eb5a98…950e`（155,294,013 bytes）、overlay `22774161…87b7`（29,767,197 bytes）；overlay manifest 为 `0.1.7 / Electron 43.3.0 / linux x64`，文件名扫描未发现 Electron/Chromium 运行时文件。
- 当前状态：本地 `0.1.7` release candidate 与上周基线升级验收完成；尚待提交并推送 `main`、等待 CI、创建 `v0.1.7` annotated tag、等待 GitHub Release，并从远端重新下载资产做最终复验。
- 遗留问题：旧 `v0.1.6` Release 附件已被历史流程覆盖，无法再作为上周原始二进制证据；本轮保持其现状、不再次覆盖，改以稳定 tag 源码还原。既有非本轮产品待办继续见 `todo.md`。

## 2026-08-27 15:18 CST — 修复 systemd 245 用户服务启动并准备 `0.1.9`

- 阶段目标：修复 `pspore.service` 的 bad unit file setting，让发行目录桌面应用能自动安装并启动真实用户服务；修通新版本 Release 的 annotated tag 校验。
- 完成内容：
  - 定位到 systemd 245 将 `WorkingDirectory="/home/ljdavns/.pspore/workspace"` 的整值引号视为路径字符，从而判定路径不是绝对路径；`WorkingDirectory` 改为 directive 专用的无整值引号绝对路径序列化，并继续将 `%` 转义为 `%%`。`ExecStart` 与 `Environment` 保持安全的逐参数 quoting。
  - 回归测试覆盖无引号 `WorkingDirectory`、路径空格和 `%`，并保留命令/环境转义与无 Shell 启动断言。
  - 远端不可变 `v0.1.7` annotated tag 的 Release workflow 因 checkout 把 tag ref 物化为 peeled commit 而失败；`fetch-depth: 0` + `fetch-tags: true` 仍会被 action 最后的 commit refspec 覆盖，`v0.1.8` 实跑捕获相同失败。最终改为直接读取 origin 的 tag object 与 `^{}` peeled commit，并验证 peeled commit 等于 `GITHUB_SHA`，新增配置回归断言。
  - 因远端 `v0.1.7`、`v0.1.8` tag 已存在且不得移动，版本统一升到 PATCH `0.1.9`，同步 `package.json`、lockfile、`src/version.ts` 与 `dist/`。
- 修改文件：`src/service/system-service.ts`、`test/unit/system-service.test.ts`、`.github/workflows/release.yml`、`test/unit/version.test.ts`、版本文件、同步构建的 `dist/` 与相关 `memory-bank/*`。
- 验证方式与结果：
  - 针对性测试 6/6 通过；`npm run check` 通过严格 typecheck、136/136 测试和 production build。
  - `npm run package:desktop` 通过，生成 `0.1.9` SEA CLI、全量 zip、overlay zip、三份 SHA-256 与可运行目录；三份 `sha256sum -c` 全部成功。CLI SHA-256 为 `511f7840…3b932`，全量 zip 为 `f922e42d…f6d9a`，overlay 为 `fd346a08…91135`。
  - 从 `release-dist/pspore-desktop-0.1.9-linux-x64/pspore-desktop` 在真实 X11 会话启动后，unit 自动更新为 `WorkingDirectory=/home/ljdavns/.pspore/workspace`；`systemd-analyze --user verify pspore.service` 无错误，service 为 `enabled/active`，主进程 PID 126591，Daemon `ready`，GUI 使用最新工作树产物运行。
  - `npm run test:electron` 通过：PC 主基准 `1920×1080`，并补测 `1440×900`、`1180×720`，双主题、设置、排版、owned/external Daemon、重连与 IPC allowlist 全绿。
- 当前状态：本地 `0.1.9` 修复、真实服务与 GUI、完整构建/打包/视觉验收均通过；等待提交/push `main`、CI、新 annotated tag、GitHub Release 与远端资产复验。
- 遗留问题：`v0.1.7`、`v0.1.8` 保留不可变失败 tag 且没有 Release；不移动、不删除、不覆盖。既有非本轮待办继续见 `todo.md`。

## 2026-08-27 15:56 CST — 修复聊天历史强制贴底并准备 `0.1.10`

- 阶段目标：聊天窗口首次默认贴底，但允许用户稳定上滚浏览；浏览期间无新消息或收到新输出都不得自动回底，用户回到底部后恢复尾随。
- 完成内容：
  - renderer 增加独立 `followTail` 状态，session 切换时默认开启；scroll 事件通过 24px 边界判断暂停/恢复尾随，不再在每次 render 中用瞬时位置重新推断。
  - transcript 高度测量 RAF 不再捕获上一帧 `shouldPin`，而是执行时读取最新尾随意图，消除用户上滚与旧测量回调之间的竞态。
  - Electron smoke 的 1007 条长历史 fixture 增加三段真实交互：上滚静置保持位置、浏览时收到 streaming delta 保持位置、回到底部后完成消息继续贴底。
  - 用户可见修复按 SemVer 升 PATCH `0.1.10`；源码、lockfile 与 `dist/` 已同步。
  - 上一阶段 `v0.1.9` GitHub Release 已成功发布；重新下载六项资产后三份 `sha256sum -c` 全部成功，SEA CLI 与桌面包内 CLI 均为 `0.1.9`，包内 Electron 为 `43.3.0/x64`。
- 修改文件：`src/desktop/renderer/renderer.ts`、`src/ui/shared/virtual-list.ts`、`src/desktop/main.ts`、`test/unit/virtual-list.test.ts`、版本文件、同步 `dist/` 与相关 `memory-bank/*`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、137/137 测试和 production build。
  - `npm run test:electron` 通过：PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`；新增滚动三段断言与双主题、设置、排版、owned/external Daemon、重连、IPC allowlist 全绿。
  - 规范化 `scripts/release.sh 0.1.10` 再次通过 `npm ci → npm run check → 完整打包`；本地三份 `sha256sum -c` 成功。SEA CLI SHA-256 为 `a6de58e6…27da1b`，全量 zip 为 `76aabd9d…e0b791`，overlay 为 `2a2296f9…b26e4e`；CLI 输出 `pSpore 0.1.10 (Pi 0.84.1, Node 24.19.0)`。
  - 从 `release-dist/pspore-desktop-0.1.10-linux-x64/pspore-desktop` 在真实 X11 会话启动；真实 `pspore.service` 已更新到该目录，状态 `enabled/active`，PID 201877，Daemon `ready`，`WorkingDirectory=/home/ljdavns/.pspore/workspace`。
  - commit `f6c29f8` 已推送 `main`；CI run `33051992448` success，包含 typecheck/test/build 与提交态 `dist` 一致性校验。annotated tag `v0.1.10` 的 object 为 `eab1bd7…12f2`，peeled commit 为 `f6c29f8…882c`；Release workflow run `33052377059` success。
  - GitHub Release `v0.1.10` 已发布并从远端重新下载六项资产；三份随包 SHA-256 校验全部成功。远端 CLI/全量 zip/overlay digest 分别为 `7ca4554e…b6c86`、`f21d3ccd…98385`、`e68f1438…c603e`；SEA CLI 与包内 CLI 均为 `0.1.10`，包内运行时为 Electron `43.3.0`、Node `24.18.1`、Linux x64，overlay manifest 为 `0.1.10 / 43.3.0 / linux x64`。
- 当前状态：聊天历史滚动修复、`0.1.10` 本地与远端不可变发行、真实最新 GUI/服务全部完成并验证。
- 遗留问题：既有非本轮产品待办继续见 `todo.md`；MESA performance warning 不影响功能，未为本轮擅自修改系统 sysctl。

## 2026-08-27 21:38 CST — 修复新会话 JSONL 缺失与直接发送消息延迟展示并准备 `0.1.11`

- 阶段目标：兼容 Pi 延迟创建 session JSONL 的行为，修复桌面新建会话 `realpath ENOENT`；让已提升为直接发送的消息在当前 tool 结束前立即可见。
- 完成内容：
  - 定位到 Pi `v0.84.1` 的 `SessionManager.create/newSession` 会先返回目标路径，默认延迟到首次 assistant 持久化才创建文件；原 `SessionCatalog.add/touch` 立即 `realpath`，因此新会话在 catalog 注册前失败。
  - 新增 `resolveSessionFile`：已有文件保持 realpath/regular file 校验；缺失叶只在 canonical parent 安全且仍位于 session root 时接受，非 JSONL、越界、symlink 逃逸仍 fail closed。
  - Pi adapter 在 create/resume/session rebind 后，以 `wx` 和 `0600` 写入 manager 当前 header/entries，再重载 manager，既让 catalog 可立即注册，也不留下会令 Pi 首次 `_persist(..., wx)` 冲突的空文件；catalog 中缺失的安全旧 JSONL 可在恢复时生成有效 header。
  - GUI `messageQueue` 同时渲染 `queue.steering` 和 `queue.followUp`。直接发送项在当前 tool 尚未完成时显示“直接发送消息”，普通项仍显示“继续排队/直接发送消息”，不暴露内部 `steer` 术语。
  - 用户可见修复按 SemVer 升 PATCH `0.1.11`，源码、lockfile 与 `dist/` 同步。
- 修改文件：`src/sessions/session-file.ts`、`src/sessions/session-catalog.ts`、`src/pi/pi-runtime-adapter.ts`、`src/desktop/renderer/{renderer.ts,styles.css}`、`src/desktop/{main.ts,smoke-fixture.ts}`、相关 contract/unit tests、版本文件、同步 `dist/` 与 `memory-bank/*`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、140/140 测试和 production build；Pi contract 覆盖新 session 文件立即物化及删除后 resume 自动重建，catalog 测试覆盖安全缺失叶与越界拒绝。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`；在 `tool.completed` frame 发出前已断言直接发送队列卡可见，follow-up 同时显示。人工复核暗色主截图，队列卡没有遮挡 transcript/composer。
  - `npm run package:desktop` 通过并生成 `0.1.11` 全套本地产物；三份 `sha256sum -c` 成功。SEA CLI/full zip/overlay SHA-256 分别为 `cb761694…f5579`、`bf9d4fad…da65c`、`9a291677…a6108`，overlay manifest 为 `0.1.11 / Electron 43.3.0 / linux x64`。
  - 真实 X11 GUI 已切换到 `release-dist/pspore-desktop-0.1.11-linux-x64`；`pspore.service` 为 `enabled/active/ready`。通过包内 CLI 在现有用户配置中新建 `session-7d96ddfb-f680-452a-a43a-5e6dd02d8a13` 成功，对应 catalog JSONL 已立即存在，mode `0600`、Pi header version `3`、cwd 为当前 workspace。
- Git/发行验证：
  - 功能与记忆提交 `2d5a416` 已 push 到 `origin/main`，主分支 CI run `33078288862` 成功，包含完整检查及 committed `dist` 一致性验证。
  - `scripts/release.sh 0.1.11` 再次通过 140/140 检查、打包与 SEA 自检，创建并推送 annotated tag `v0.1.11`；远端 tag object 为 `c617e615…81d31`，peeled commit 精确为 `2d5a416…d53ba`。
  - Release desktop run `33078693382` 成功并创建非 draft、非 prerelease 的不可覆盖 Release。六项资产已从 GitHub 重新下载到独立临时目录，三份随包 `sha256sum -c` 全部通过；远端 CLI/full zip/overlay SHA-256 分别为 `dd046ac3…f8126`、`4630945f…a8311`、`f00af54b…50172`。
  - 远端 SEA CLI 为 `0.1.11 / Pi 0.84.1 / Node 24.19.0`；远端 full zip 包内 CLI 为 `0.1.11 / Pi 0.84.1 / Node 24.18.1`，Electron 运行时为 `43.3.0 / linux / x64`；overlay manifest 为 `0.1.11 / Electron 43.3.0 / linux / x64`，payload SHA-256 为 `e688a3d0…9fa2f`。
- 当前状态：新会话 JSONL 修复、直接发送消息即时展示、`0.1.11` 本地/CI/不可变远端发行及真实最新 GUI/服务均已完成并验证。
- 遗留问题：真实验证新增了一个标题为“0.1.11 会话兼容性验证”的空会话，保留给用户直接确认新建/切换行为；GitHub Actions 报告官方 action 仍以 Node 20 为目标的弃用告警，已登记 `todo.md`，不影响本轮检查/发行成功；既有非本轮待办继续见 `todo.md`。

## 2026-09-02 10:59 CST — 银河麒麟 V10 ARM64 CI 打包链本地阶段

- 阶段目标：依据用户提供的飞腾 FT-2000/4、AArch64、银河麒麟 V10 SP1、glibc 2.31 环境信息，让 GitHub CI 生成可在该用户态基线上自检的 ARM64 CLI、桌面全量包与 overlay。
- 完成内容：
  - `package-desktop.sh`、`build-cli-binary.sh` 与 electron-builder 配置从硬编码 x64 改为原生 `x64|arm64` 参数化；SEA 必须复制同架构 Node，跨架构请求在打包前拒绝，默认 x64 输出命名与正式 Release 流程保持不变。
  - overlay updater 接受 `linux/x64` 或 `linux/arm64` manifest，但仍要求现有 Electron 的精确版本、平台和架构全部匹配；新增 ARM64 fixture 回归。
  - 新增 `Package Linux ARM64` workflow：原生 `ubuntu-24.04-arm` runner 内使用 Ubuntu 20.04/glibc 2.31 容器，安装 ARM runtime/optional dependencies，以非 root 用户执行完整检查和 `1920×1080` Electron smoke，再验证 ELF AArch64、`ld-linux-aarch64.so.1`、Electron/SEA 运行时与三份 checksum；成功时上传保留 14 天的 CI artifact，不操作 GitHub Release。
- 修改文件：`.github/workflows/package-arm64.yml`、`electron-builder.yml`、`scripts/{package-desktop.sh,build-cli-binary.sh}`、`scripts/linux/apply-overlay-upgrade.sh`、发行脚本测试、中文项目文档及 `memory-bank/*`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、142/142 测试和 production build 全绿，`git diff --exit-code -- dist` 通过；新增 workflow 静态契约和 ARM overlay 升级均在测试内通过。
  - `bash -n`、`git diff --check` 通过；Prettier 成功解析并确认 ARM workflow 与 electron-builder YAML 格式。
  - 最终 `npm run package:desktop` x64 兼容回归通过；三份 `sha256sum -c` 成功，SEA 为 `pSpore 0.1.11 / Node 24.19.0`，包内 Electron 为 `43.3.0/linux/x64`，overlay manifest 为 `0.1.11 / 43.3.0 / linux/x64`。全量 zip 149 MiB、overlay 29 MiB、SEA 140 MiB，均在被 Git 忽略的 `release-dist/`。
- 当前状态：本地实现、检查和既有 x64 打包回归完成；ARM64 workflow 尚待本阶段提交推送 `main` 后在 GitHub 原生 ARM runner 上执行，当前不提前声称远端 ARM 产物成功。
- 遗留问题：CI 用户态不能复现目标机 Linux 5.4 内核、真实 GPU/桌面栈与 systemd 245；远端 ARM job 成功后仍需在实际银河麒麟设备下载安装、快捷方式、GUI 与用户服务复验，已登记 `todo.md`。

## 2026-09-02 11:16 CST — 修复 ARM CI 的 Electron 43 显式安装

- 阶段目标：定位并修复 `Package Linux ARM64` 在原生 ARM runner 上安装依赖后退出的问题。
- 完成内容：通过 GitHub Actions 失败日志确认 job 已进入 Ubuntu 20.04/glibc 2.31 ARM 容器且 `npm ci` 成功；Electron 43.3.0 npm 包不再声明自动 install script，因此补充以非 root 构建用户显式执行 `node node_modules/electron/install.js`，下载并校验同架构 Electron runtime。静态契约同步约束该步骤，避免后续误删。
- 修改文件：`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：失败 run `33585464052` 的日志已读取并定位到 `Install native ARM64 dependencies`；本地确认 Electron 43.3.0 包含 `install.js` 但 package metadata 没有自动安装脚本，显式安装后得到可执行的 `43.3.0/linux/x64` runtime。`actionlint 1.7.12`、针对性 3/3 测试、`npm run check`（142/142）及 committed `dist` 一致性校验均通过。
- 当前状态：根因修复已完成本地验证，待提交推送并观察新 ARM run。
- 遗留问题：远端原生 ARM64 job 尚未复跑通过；通过前不创建正式 Release tag。

## 2026-09-02 11:21 CST — 兼容 GitHub job container 的 Electron smoke

- 阶段目标：修复原生 ARM job 进入 Electron smoke 后因嵌套容器禁止创建 Chromium namespace 而退出的问题。
- 完成内容：失败 run `33586566564` 已证明显式 Electron 安装与 142 项 ARM 检查通过；smoke harness 新增仅由显式环境变量启用的 `--no-sandbox` 参数，ARM workflow 只在 Ubuntu 20.04 GitHub job container 内设置该变量。产品 BrowserWindow 仍保持 `sandbox: true`、context isolation、无 Node integration 与严格 CSP，正常发行启动参数不受影响。
- 修改文件：`scripts/electron-smoke.mjs`、`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：远端失败日志为 Chromium `Failed to move to new namespace ... Operation not permitted`，符合 job container 的 namespace 限制；`actionlint 1.7.12`、`node --check`、针对性安全/工作流测试 7/7、`npm run check`（142/142）与 committed `dist` 一致性校验均通过。本机缺少 `xvfb-run`，实际 ARM smoke 留给原生 runner 复验。
- 当前状态：CI 专用 smoke 兼容修复已完成本地验证，待提交推送并观察新 ARM run。
- 遗留问题：CI 容器无法验证 Chromium OS sandbox 的实际启用；该安全配置继续由静态单测约束，真实银河麒麟设备仍需做最终运行复验。

## 2026-09-02 11:28 CST — 放宽 ARM 软件渲染 smoke 时限

- 阶段目标：处理 ARM job 已启动 Electron、但完整视觉 fixture 超过固定 60 秒而被测试 harness 终止的问题。
- 完成内容：smoke harness 保留默认 60 秒回归门禁，同时支持范围受限的 `PSPORE_ELECTRON_SMOKE_TIMEOUT_MS`；ARM workflow 设置为 180 秒，以容纳无 GPU 的 ARM 软件渲染。超时错误同步附带已捕获的有限 stdout/stderr，便于继续定位而不会输出无限日志。
- 修改文件：`scripts/electron-smoke.mjs`、`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：run `33586842778` 已通过 ARM 环境、Electron 显式安装及 142 项检查，修复后的 Electron 首次启动不再 namespace 崩溃；失败点精确为 harness 的 `xvfb-run timed out after 60000ms`。`actionlint 1.7.12`、`node --check`、针对性安全/工作流测试 7/7、`npm run check`（142/142）与 committed `dist` 一致性校验均通过。
- 当前状态：ARM 专用超时参数已完成本地验证，待提交和原生 runner 复跑。
- 遗留问题：尚未确认完整 ARM smoke 在 180 秒内完成；通过前继续不创建 Release tag。

## 2026-09-02 11:38 CST — 修复 ARM smoke 的 XDG 与 D-Bus 会话

- 阶段目标：根据放宽超时后取得的 Electron stderr，修复 smoke 启动后无法完成的问题，而不是继续增加等待时间。
- 完成内容：显式创建并授权构建用户的 XDG cache/runtime 父目录，避免 root 创建的 `.cache` 阻止 dconf 初始化；Ubuntu 20.04 容器安装 `dbus-x11`，smoke 通过 `dbus-run-session` 获得有效 session bus。配置只作用于 CI 构建用户和测试进程。
- 修改文件：`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：run `33587261873` 证实 180 秒参数生效；有限 stderr 明确记录 `.cache/dconf: Permission denied` 及无效 D-Bus address，因此本轮针对两项环境缺失修复。`actionlint 1.7.12`、`node --check`、本地 `dbus-run-session` 地址断言、针对性测试 7/7、`npm run check`（142/142）和 committed `dist` 一致性校验均通过。
- 当前状态：环境根因修复已完成本地验证，待提交和第四次原生 ARM run。
- 遗留问题：尚未取得 ARM smoke 与打包成功证据；正式 Release tag 继续暂停。
