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
6. UI 共享 backend/domain/protocol，不共享 TUI/DOM 组件。
7. 所有工具走统一 policy；plugin/extension/MCP 加载另做代码信任。
8. cron slot 去重但外部副作用不承诺 exactly-once。
9. BOOT 在 ready 后异步运行，不阻塞服务可用性。
10. KV cache 通过稳定前缀、稳定 tool 顺序和真实 usage 指标优化，不作供应商无关保证。
11. cron job JSON 是用户可编辑事实源；monthly append-only run ledger 保存 slot claim 与状态转换，尾行可恢复、中间损坏 fail closed。
12. job approval grant 以 job ID、canonical capability 与 target 精确持久化；显式 deny 永远先于 session/job grant。
13. schedule mutation 使用 source SHA-256 compare-and-swap 后原子替换并热重载；notification 先 append JSONL，再发布到客户端 store。
14. MCP server 只在 discover/call/ping 时连接；配置只保存环境变量引用，不保存 secret。允许列表过滤后才激活 schema，动态 tool registry 在 session 边界更新；当前 session 使用固定的 `mcp_call` bridge。
15. MCP 结果受 byte budget 约束，超限内容写入私有 artifact；audit 只保存参数哈希。transport 失败进入指数退避，空闲连接自动关闭；v1 没有 sandbox executor，因此 `sandboxed` 配置 fail closed。

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
