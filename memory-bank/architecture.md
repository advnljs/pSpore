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
- `Shared Client Core`：GUI/TUI 共用 protocol state reducer、presentation model、会话输入路由、Daemon supervisor 与 LLM settings service；DOM/terminal widget 各自渲染。
- `Cowork Activity`：将 tool/run/retry/compaction/error/automation/agent/integration 事件归一为共享的语义活动模型；TUI 用动态工作步骤表现，Electron 用可折叠活动卡表现。
- `Storage`：atomic JSON、append-only JSONL、lock、schema migration 和 recovery。

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
19. Desktop 通过同一 PID + process-start 单实例锁决定 Daemon 所有权：锁可获取时在 Electron main process 内启动并标记 `owned`，活跃锁存在时标记 `external` 并复用；退出只停止 `owned` 实例。
20. 模型设置由 GUI/TUI/CLI 共用 `LlmSettingsService` 与严格 decoder，不进入公共 Daemon command union。非 secret 设置写入 `config.json/models.json`；Key 单独写 `0600 credentials/<provider>.api-key`，GUI/TUI 状态只获得存在状态。owned Daemon 保存后安全重启，external Daemon 不被客户端擅自中断。
21. 用户级 Provider 只暴露 `deepseek`、`openai`、`custom-openai`；前两者使用受控默认 endpoint/API，只有自定义 OpenAI 可写 Base URL 并选择 Chat Completions/Responses。TUI 同时提供无副作用预览/确认的 wizard 与可脚本化配置命令。
22. `DaemonSupervisor` 是桌面和 TUI 的共享生命周期 owner；通过单实例锁区分 `owned/external`，只停止自己拥有的 Daemon，解决独立 AppImage/TUI 启动时缺失 socket 的问题。
23. GUI/TUI 不再各自解释原始 tool event；`CoworkActivity` 在共享 reducer 中按 `toolCallId` 合并 started/updated/completed，生成 cowork 语义标签、目标、状态、结果与耗时。技术详情在共享层统一脱敏、限深和限制为 8 KB，平台层仅决定视觉表现。

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
