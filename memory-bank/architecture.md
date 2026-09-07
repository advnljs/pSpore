# Architecture

## 系统边界

pSpore 是 Linux 本地单用户 Agent。Daemon 是会话、任务、审批和事件序号的唯一写入者；TUI/Electron 是无权威状态客户端。模型循环复用 Pi SDK，OS 权限边界来自启动 Daemon 的用户，不提供默认 sandbox。

## 主要组件

- `Kernel`：串行归并 domain events，产生 effects；不做 I/O。
- `PiRuntimeAdapter`：唯一 Pi SDK 边界，管理 `AgentSessionRuntime`、事件映射和 JSONL session。
- `Gateway/Protocol`：TUI 与 Electron main process 共享 UDS 命令、事件和快照 schema；renderer 只经窄化 IPC bridge 访问。
- `Policy/Shell`：capability、risk、approval、audit、login shell、PTY 和进程生命周期。
- `Memory/Search`：pinned files、exact search、BM25、session index 和 artifact references。
- `Automation`：cron、BOOT、trigger、run ledger 和故障恢复。
- `Notification`：durable local/session delivery，进入共享 Kernel snapshot，由 TUI/Electron 表现。
- `Subagent Router`：session actor tree、mailbox、budget、权限继承和双工消息。
- `Extension Host`：Pi skills/extensions、pSpore plugins 和 MCP adapter。
- `Shared Client Core`：GUI/TUI 共用 protocol state reducer、presentation model、会话输入路由与 LLM settings service；DOM/terminal widget 各自渲染。
- `Cowork Activity`：将 tool/run/retry/compaction/error/automation/agent/integration 事件归一为共享的语义活动模型；TUI 用动态工作步骤表现，Electron 用可折叠活动卡表现。
- `Storage`：atomic JSON、append-only JSONL、lock、schema migration 和 recovery。
- `System Service`：生产 GUI/TUI 自动安装并连接 systemd user service；服务负责完整 Kernel/automation/integration 生命周期，客户端退出不改变服务状态。
- `Session Catalog`：将多个交互式根 session 的稳定 ID/标题/时间映射到 Pi JSONL；服务 ready 前恢复全部历史，agent/automation 临时 session 不进入目录。

## 数据流

客户端 command → Gateway 校验/去重 → Application use case → Kernel event → reducer 更新状态并产生 effect → adapter 异步执行 → completion/failure 回投 Kernel → durable append/snapshot → event broadcast → TUI/Electron reducer。

模型 tool call → Pi policy hook → capability/risk → allow/deny 或 durable approval request → 用户响应 → effect 恢复/阻止 tool → Pi event → pSpore domain event。

## 关键技术决策

1. 模块化单体，不提前拆微服务/npm 多包。
2. 一个顶层状态归并 loop，复用 Pi 内部 agent loop；异步 activity 不阻塞 Kernel。
3. 主会话 in-process 使用 Pi SDK，不用 Pi RPC 子进程。
4. pSpore 公共协议自有且稳定；Pi experimental server/protocol 不外泄。
5. 文件/JSONL 为事实源，index 为可删除 cache；不引入默认数据库或向量库。
6. UI 共享 backend/domain/protocol，以及纯 protocol state/presentation/input-routing/config/lifecycle primitive；TUI 与 DOM 组件因渲染环境不同而独立。
7. 所有工具走统一 policy；plugin/extension/MCP 加载另做代码信任。
8. cron slot 去重但外部副作用不承诺 exactly-once。
9. BOOT 在 ready 后异步运行，不阻塞服务可用性。
10. KV cache 通过稳定前缀、稳定 tool 顺序和真实 usage 指标优化，不作供应商无关保证。
11. cron job JSON 是用户可编辑事实源；monthly append-only run ledger 保存 slot claim 与状态转换，尾行可恢复、中间损坏 fail closed。
12. job approval grant 以 job ID、canonical capability 与 target 精确持久化；显式 deny 永远先于 session/job grant。
13. schedule mutation 使用 source SHA-256 compare-and-swap 后原子替换并热重载；notification 先 append JSONL，再发布到客户端 store。
14. MCP server 只在 discover/call/ping 时连接；配置只保存环境变量引用，不保存 secret。允许列表过滤后才激活 schema，动态 tool registry 在 session 边界更新；当前 session 使用固定的 `mcp_call` bridge。
15. MCP 结果受 byte budget 约束，超限内容写入私有 artifact；audit 只保存参数哈希。transport 失败进入指数退避，空闲连接自动关闭；v1 没有 sandbox executor，因此 `sandboxed` 配置 fail closed。
16. 生成资源只允许从 `workspace/staging` 检查；目录内容形成 deterministic SHA-256，显式安装必须提交相同 digest。安装使用不可变私有目录，trust store 只信任 exact content，不执行 staging 代码，也不自动运行依赖 lifecycle scripts。
17. Skill 信任在下一 Pi session factory 调用时重验 digest，并通过 `additionalSkillPaths + noSkills` 实现受控 progressive disclosure；现有 session 不热变更。Host plugin 除 exact trust 外还需 config digest/capability 完整匹配和 Daemon restart，不做热替换。
18. Electron main 是桌面侧唯一 UDS owner；renderer 使用原生 DOM，仅通过固定 preload API 发送离散 action。main 对 action、snapshot/event、JSON 深度/大小和 event type 做二次校验，连续 delta 可合并但 cursor 顺序不可跳过。
19. 生产 Desktop/TUI 不再拥有 Daemon：首次启动原子写入 systemd user unit，执行 `enable --now` 并尝试启用 linger；服务使用 `Restart=always`，客户端只连接 UDS。旧的 owned/external supervisor 仅保留给隔离 Electron smoke，测试不得写真实用户服务。
20. 模型设置由 GUI/TUI/CLI 共用 `LlmSettingsService` 与严格 decoder，不进入公共 Daemon command union。非 secret 设置写入 `config.json/models.json`；Key 单独写 `0600 credentials/<provider>.api-key`，GUI/TUI 状态只获得存在状态。owned Daemon 保存后安全重启，external Daemon 不被客户端擅自中断。
21. 用户级 Provider 只暴露 `deepseek`、`openai`、`custom-openai`；前两者使用受控默认 endpoint/API，只有自定义 OpenAI 可写 Base URL 并选择 Chat Completions/Responses。TUI 同时提供无副作用预览/确认的 wizard 与可脚本化配置命令。
22. `SystemServiceManager` 是生产桌面和 TUI 的共享服务控制层；Node/npm/SEA 使用 CLI 入口，Electron 包使用 `ELECTRON_RUN_AS_NODE=1` 执行 asar 内 CLI。`DaemonSupervisor` 仅作为 smoke fixture 的临时生命周期工具。
23. GUI/TUI 不再各自解释原始 tool event；`CoworkActivity` 在共享 reducer 中按 `toolCallId` 合并 started/updated/completed，生成 cowork 语义标签、目标、状态、结果与耗时。技术详情在共享层统一脱敏、限深和限制为 8 KB，平台层仅决定视觉表现。
24. 交互式根 session 通过私有原子 catalog 持久映射到 Pi JSONL，服务启动逐个 `resume`；普通输入由 Application 按运行状态自动选择 prompt/follow-up。follow-up 可通过重排 Pi 队列提升为内部 steer，但客户端只呈现“继续排队/直接发送消息”。
25. 自动 compact 配置属于共享 `config.context.autoCompaction`，旧 v1 config 缺字段时读取 Pi 默认值；Daemon 为每个新建/恢复 session 注入独立 in-memory `SettingsManager`。GUI 使用 Fenwick tree 维护变高虚拟窗口并缓存有限 DOM，TUI 从尾部只格式化目标行窗；客户端 store reducer 保持不可变引用，流式帧不再复制完整历史。
26. assistant 正文与 reasoning 使用独立的 transient stream channel；共享 reducer 分别维护 `streamingText` / `streamingThinking`，正文完成、run settle、错误或 session replacement 时同时清理，thinking 不写入最终消息历史。发行版本按 SemVer 递增，只有匹配版本的新 annotated tag 能创建一次 GitHub Release，任何既有 tag/Release 都拒绝覆盖。
27. systemd unit 按 directive 语法分别序列化：`ExecStart`/`Environment` 使用 systemd command quoting，`WorkingDirectory` 使用未包裹整值引号的绝对路径并转义 `%` specifier，以兼容 systemd 245。Release 通过 origin 的 tag object + `^{}` peeled commit 双引用验证 annotated tag 及目标提交，不信任 checkout 写入的同名本地 tag ref。
28. GUI 虚拟历史的尾随意图是 renderer 独立状态，不从每次 render 的瞬时 `scrollTop` 反复推导；用户滚离底部即暂停，异步测量读取最新意图，用户回到底部才恢复，使普通重渲染和流式增量都不能覆盖历史浏览位置。
29. Pi session path 与文件存在性分离处理：catalog 可记录安全 canonical parent 下暂缺的 `.jsonl` 叶路径，Pi adapter 在 create/resume/rebind 边界把 manager 当前 header/entries 原子式 create-only 物化为 `0600`，再重载为 flushed 状态。GUI 队列则同时投影 follow-up 与 steering，使直接发送意图在当前 tool 执行期间也可见。
30. Linux 打包脚本以 Node 原生 `process.arch` 为默认目标，并只接受 `x64|arm64`；SEA 直接复制当前 Node，因此禁止跨架构伪打包。ARM64 CI 使用原生 GitHub ARM runner，并在 Ubuntu 20.04 容器中把可执行自检基线固定为 glibc 2.31；`main` 保留短期 ARM Actions artifact，正式 annotated tag 则并行构建 x64/ARM64，只有两侧检查、打包和 checksum 全部成功才创建含 12 项资产的不可变 Release。Release 资产继续使用架构后缀作为稳定文件名，并用 `ARM64 / Kylin V10`、`x86_64` display label 与对应发行说明章节分类。
31. GUI 文件/目录拖拽保持为 renderer 草稿状态：preload 仅用 Electron `webUtils.getPathForFile` 把用户真实拖入的 `File` 转成绝对路径，不增加任意路径 IPC 或文件读取能力；renderer 去重并显示可移除引用，发送时只把路径序列化为带引号的 `@` token，目录不展开，drop 不触发 command。
32. UDS server 大消息使用显式协商的 `server-frame-chunks.v1` transport capability：超过 1 MiB 的完整 snapshot/event 先在 64 MiB 逻辑上限内选择 gzip 或原始 bytes，再用有序 base64 chunk envelopes 发送；每个物理 frame 仍受原上限约束，客户端严格校验顺序、长度、编码和解压上限后才交给既有 reducer。自动 compact 仍复用 Pi 原生算法，同时增加共享 `triggerTokens` 直接阈值，在新 turn 前及 turn 完成后检查 active context；模型上限 reserve 保护继续独立生效。

## 重要约束

- Node 基线固定为 24；Pi 锁定 `v0.84.1`，对应实测 tag commit `53fa77c…`。
- `allow_all` 等价于当前用户级任意工具授权，sudo 可进一步扩大影响。
- 同一 session 只允许一个 Pi run；不同 session 在全局预算内并发。
- child 权限不得超过 parent/root ceiling。
- secret input 不进入模型、日志、事件、session、artifact 或 memory。
- 不提供公网 Web；Electron renderer 不拥有 Node/Daemon 权限。

## 架构变更历史

- 2026-08-09：从概念草案建立首版详细架构；修正“单物理 loop”“完全相同 shell 环境”“cron exactly-once”“审批可约束插件代码”等不成立假设。
- 2026-08-09：实现阶段固定 Node 24 与 Pi `v0.84.1`，最终客户端由 Tauri 改为 Electron 43；核心先由 TUI 验收。
- 2026-08-09：Phase 1 落地模块化单体纵切；Daemon 通过私有 UDS 暴露自有 v1 协议，Application 串行化同 session 命令，Kernel 仍是唯一权威状态提交点，TUI 仅维护可丢弃的协议 store。
- 2026-08-09：默认 lexical retrieval 落地为可删除 JSON cache；源 Markdown/JSONL 始终是事实源，索引按内容 hash 重建，pinned context 超预算或越界时拒绝启动而不静默截断。
- 2026-08-10：Phase 2 自动化落地：五字段/IANA cron adapter、durable run ledger、slot 去重、并发/misfire/timeout、非阻塞 BOOT，以及跨重启 job approval grant；run 状态进入共享 Kernel/protocol store。
- 2026-08-10：补齐 schedule 原子 create/update 与 runtime cron reload；run delivery/agent notify 统一写 durable notification JSONL，再由 TUI 与 Electron 共享消费。
- 2026-08-10：Subagent 落地为同进程独立 Pi session actor；`AgentManager` 管理有界 tree、串行 mailbox、budget/permission ceiling 和级联取消，Kernel 仅归并 agent/message 领域事件。
- 2026-08-10：MCP 落地为官方 SDK adapter；stdio/Streamable HTTP 均严格配置、lazy connect、allow/deny schema 激活、统一 policy gate、取消/超时/空闲关闭/退避和 health event，不将第三方协议对象泄漏到公共协议。
- 2026-08-10：资源信任与扩展生命周期落地：staging inspect、内容寻址安装/撤销、symlink/tamper fail closed、host manifest/capability/restart activation，以及 Pi skills 的 session-boundary progressive disclosure。
- 2026-08-10：Phase 4 Electron 43 落地：安全 main/preload/原生 DOM renderer、固定 action IPC、UDS 重连与 delta coalescing、共享 protocol store、审批/agent/automation/integration UI，以及可重复的 1920×1080 Xvfb 安全视觉验收。
- 2026-08-11：Desktop 增加 Daemon ownership supervisor，修复 AppImage 独立启动 `daemon.sock` ENOENT；原生 renderer 建立双主题语义色/字号基线，smoke 扩展到 owned/external Daemon、双主题和 computed typography。
- 2026-08-11：Desktop 改为会话常驻、检查器按需展开的响应式 PC 工作台；新增严格模型设置 IPC 与私有 key-file storage，smoke 覆盖 1920×1080、1440×900、1180×720 和设置弹层。
- 2026-08-11：GUI/TUI/CLI 抽出共享 protocol reducer、presentation/input routing、Daemon supervisor 与 LLM settings core；TUI 补齐响应式双栏、完整状态面板和 wizard/命令双配置入口，npm CLI 包可独立安装运行。
- 2026-08-13：增加 GUI/TUI 共享 `CoworkActivity` reducer，TUI 升级为有角色语义色、动态思考/工具状态、工作历史和脱敏详情的 cowork 工作台；Electron 活动卡同步消费该模型。
- 2026-08-20：Linux GUI 发行改为全量 zip（含创建桌面快捷方式脚本）与不含 Chromium 的 overlay zip；LLM 设置增加私有 Cookie 头以调用代理 API；主工作区初始纵向铺满窗口。
- 2026-08-26：生产后台生命周期迁移到 systemd user service；GUI/TUI 自动安装、启用、重连但不再启停服务，legacy daemon 在首次迁移时经协议优雅退出，Electron smoke 继续使用隔离 supervisor。
- 2026-08-26：根 session 目录、多会话创建/恢复与历史加载落地；GUI/TUI 取消三模式 composer，普通发送自动 follow-up，并提供逐条“继续排队/直接发送消息”。
- 2026-08-26：共享设置接入自动 compact 开关/reserve/keepRecent；GUI/TUI 完成长历史窗口化，流式 GUI 按帧刷新，Pi transcript 不再合成 `[tool:*]`，终端 spinner 改为通用 ASCII 并补 GUI Emoji/Symbol 字体回退。
- 2026-08-27：Linux zip 安装改为 Desktop Entry → 稳定 XDG launcher → 当前安装目录的间接启动链，消除 `Path="..."` 误解析并增加私有滚动日志；overlay 改为带 manifest 的完整应用 payload，在复用 Electron/Chromium 前校验精确运行时、架构和目录摘要，原子替换并保留回滚目录。变高历史禁用 CSS smooth scroll，避免自动跟随 1000+ 条历史时停在中段。
- 2026-08-27：thinking delta 与正文 delta 在 GUI/TUI 中拆为两个临时通道，正文完成后自动隐藏 reasoning；发行流程改为 SemVer 新版本 → annotated tag → 不可覆盖 GitHub Release，并为 CLI、全量桌面包和 overlay 各生成 SHA-256。
- 2026-08-27：修复 systemd 245 将 `WorkingDirectory="/absolute/path"` 视为非绝对路径的问题，路径 directive 改用无整值引号的绝对路径；Release annotated tag 校验改为直接读取 origin tag object 与 peeled commit，规避 `actions/checkout` 覆盖本地 tag ref。
- 2026-08-27：GUI transcript 改用显式尾随状态，消除上一帧异步测量把用户上滚位置重新拉到底部的竞态；Electron smoke 覆盖静置浏览、浏览时新 delta 与回底恢复三段交互。
- 2026-08-27：修复 Pi 延迟创建 JSONL 与 catalog `realpath` 的冲突，新 session 返回前立即生成有效私有文件，安全缺失叶可在恢复时重建；GUI 同时展示 follow-up/直接发送队列，steering 不再等 tool 完成后才可见。
- 2026-09-02：Linux 桌面/SEA 打包从硬编码 x64 改为原生 `x64|arm64` 参数化；新增 glibc 2.31 ARM64 GitHub CI 链，覆盖 ARM optional dependency、Electron PC smoke、ELF/动态链接器/运行时架构与 checksum 验证。正式 tag Release 改为等待 x64/ARM64 两条原生链后统一发布，`main` 仍只产生短期 ARM 预览 artifact。
- 2026-09-04：Electron composer 增加文件/目录拖拽引用；安全桥只解析真实拖入对象的路径，renderer 不获得 Node/文件读取能力，真实 CDP 拖拽 smoke 覆盖路径引用与不自动提交。
- 2026-09-04：长会话 UDS 响应增加协商式 gzip/base64 有界分片，消除单个 1 MiB server frame 失败且不放宽物理边界；共享自动 compact 设置增加默认 100000 tokens 的直接触发阈值，GUI/TUI/CLI 和新建/恢复 Pi session 使用同一配置。


## 2026-09-07 变更：配置事实源与瞬时事件背压

- **配置事实源**：`~/.pspore/config.json` 是设置面板每一项的权威存储，包括此前只存在于 `state/pi/models.json` 的 `baseUrl`/`api`/`customModel`。`models.json` 变为由 `LlmSettingsService.save()` 生成的 Pi 运行时派生产物；读取时只在缺少 `config.model` 端点字段（0.1.15 之前的 home）时回退到它。凭据本身仍只落在 `credentials/<provider>.{api-key,cookie}`（`0600`），`config.json` 只记录其绝对路径。
- **配置增量升级**：`parseConfig` 先经 `withConfigDefaults` 按段/按键补齐缺失默认值；已有值一律保留，未知键仍严格拒绝。`initializePsporeHome` 检测到缺键时把合并结果原子写回，因此 overlay 只替换应用文件也不会让新版本因缺字段启动失败。
- **瞬时事件背压契约**：`EventEnvelope.skipped` 是可选的“本连接在这条事件之前被丢弃的瞬时事件数”。网关在 socket 需要 drain 时丢弃非 durable 事件并计数，durable 事件永不丢弃（超限仍会断开慢客户端）。客户端的期望序号因此是 `cursor + 1 + skipped`，背压不再被误判为事件缺口。这消除了长任务中“丢连接—重连”循环的根因。
- **界面连接稳定期**：GUI/TUI store 各自维护 2 秒 settle window，向视图暴露 `stableConnection`/`reconnecting`。窗口内的重连保持呈现为已连接（仅指示灯提示），超时才如实降级；GUI 对尚未写入 socket 的命令在该窗口内自动重试一次。
- **overlay 边界**：overlay payload = 完整安装目录减去 Electron/Chromium 运行时清单，升级时在安装根目录整体替换。运行时版本/架构必须与目标完全一致，否则在写入前拒绝。升级后重跑随包的快捷方式安装器，保证已有桌面快捷方式指向本次升级的目录。

- **发版触发**：`main` 上的 CI 在 `check` 通过后运行 `release` job。它以 `package.json` 版本是否已有 tag/Release 作为唯一开关：已存在则跳过，不存在则等待同 commit 的 ARM64 preview 成功，再创建 annotated `v<version>` 并显式 `gh workflow run "Release desktop" --ref <tag>`。显式派发是必需的——用 `GITHUB_TOKEN` 推送的 tag 不会触发 `on: push: tags`，`workflow_dispatch` 是 `GITHUB_TOKEN` 仍可触发的事件。`scripts/release.sh` 保留为“先在本机完整打包验证再打 tag”的手动路径，两条路径都受同一套不可变校验保护。
