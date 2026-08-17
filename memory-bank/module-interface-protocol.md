# Module: Interface and Protocol

## 模块职责

通过 transport-neutral 命令、事件和快照连接 Daemon、TUI 与 Electron 客户端；处理认证、重连、幂等、revision、背压和 UI state reduction。

## 入口文件

当前入口：`src/protocol/schema.ts`、`src/protocol/client.ts`、`src/gateway/local-gateway.ts`、`src/ui/shared/`、`src/ui/tui/`、`src/desktop/daemon-bridge.ts`、`src/desktop/renderer/store.ts`。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 15 节。
- UDS integration：`test/integration/local-gateway.test.ts`。
- TUI store/固定画面：`test/unit/tui-store-view.test.ts`。
- Electron bridge/store：`test/integration/desktop-daemon-bridge.test.ts`、`test/unit/desktop-store.test.ts`。
- 共享客户端状态与表现：`src/ui/shared/protocol-state.ts`、`src/ui/shared/presentation.ts`、`src/ui/shared/activity.ts`。

## 对外接口

- `CommandEnvelope<v1>` / `EventEnvelope<v1>`
- snapshot/replay/ack/auth handshake
- session prompt/steer/follow-up/abort、approval、agent/job commands
- Electron renderer 固定 `bootstrap/dispatch/subscribe` preload API；`DesktopCommand` 在 main process 严格解码并映射到既有 UDS command。

## 内部依赖

Application use cases、Kernel event bus、policy approval service、protocol schemas。

## 外部依赖

TUI 使用 Pi TUI primitives；Daemon/TUI/Electron main 使用 Node UDS。Electron renderer 使用原生 DOM/TypeScript，不新增 UI runtime dependency。

## 注意事项

- Snapshot/complete event 权威；delta/progress 可合并或丢弃。
- 相同 command id 必须幂等；seq gap 触发 snapshot，不由客户端猜状态。
- Electron renderer 已启用 context isolation/sandbox 并关闭 Node integration；只暴露 allowlisted preload API，main 对 command 与 server frame 再校验。
- UI 同底层指共享 domain/protocol、权威 snapshot/event reducer、presentation model、会话输入路由、设置与 Daemon 生命周期；终端与 DOM 组件保持平台原生。
- Electron 视觉基准为 `1920 × 1080`，补测 `1440×900`、`1180×720`；TUI 主基准为 `160×45`，补测 `96×30` 单栏。均只覆盖桌面/终端，不实现手机布局。
- 当前 replay window 位于内存；Daemon 重启后的 durable event replay 尚待 event log 实现，重连仍可用最新 snapshot 恢复。
- TUI clientId 在进程内稳定，seq gap 会断开并指数退避重连；相同 command ID 由 Daemon 缓存首次响应。
- job/run/notification 状态已经进入 Kernel snapshot；CLI/TUI 可列出 job/run/notification、触发 job、取消 run，CLI/agent 可原子更新 job。
- Electron bridge 保存 cursor、检测 gap、指数退避重连，并在不改变 seq 语义的前提下合并连续同 session delta；renderer 只保留可丢弃 store。
- renderer 不能指定任意 IPC channel 或路径；resource UI 只提交单层 staging name，main 才解析为配置 workspace 下的 staging 路径，Daemon 再执行 canonical containment。
- TUI >=104 cells 使用会话+内容双栏，较窄终端使用单内容区；`/help` 打开完整命令面板，`/config wizard` 与 `/config` 子命令使用同一 settings service。
- TUI 版式：header 左侧 `∴ pSpore` 品牌、右侧 ONLINE + model；context 行左侧 session/活动、右侧 context/rev/approvals；会话内容自输入行向上生长（`anchorBottom`），左栏 SESSIONS 置顶、WORKSPACE 指标贴底（`composeColumn`）；子 agent 用 `└─` 分枝表示树层级；footer 去掉多余分隔线，只保留 notice/help/prompt 三行。
- `activity.ts` 将 tool 三段事件按 `toolCallId` 合并，并对 run/compaction/retry/error/automation/agent/integration 事件保持语义化活动；TUI 和 Electron 共用 label/summary/status/result/duration/detail redaction。
- TUI 与桌面共用同一套语义色：brand/bone `187`、live moss `108`、agent `151`、lichen（用户/会话 id）`109`、honey（等待/审批）`179`、rust（失败）`174`、memory `182`、muted `245`、faint `242`、border `240`；动画只在选中 session 运行或存在运行中活动时以 120 ms 刷新，并尊重 `NO_COLOR`/dumb terminal。
- `/work` 展示最近 30 个工作步骤，`/work <ID-prefix>` 展示一步的脱敏、限深、8 KB 限长详情；会话区不再重复渲染 raw tool result 消息。
- 普通输入、steer、follow-up 根据共享 `conversationIntent` 路由到当前选中的 main/child，避免 child 输入误发给 main。
- npm 分发包名为 `p-spore`，全局可执行命令为 `pspore`；纯 npm 包不包含 Electron 生产依赖，桌面端由 AppImage 分发。

## 常见修改点

schema version、event mapping、共享 reducer/presentation、replay window、backpressure、nonce/auth、TUI keymap/wizard、Electron action allowlist/store、visual tests。
