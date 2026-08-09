# Module: Interface and Protocol

## 模块职责

通过 transport-neutral 命令、事件和快照连接 Daemon、TUI 与后置 Electron 客户端；处理认证、重连、幂等、revision、背压和 UI state reduction。

## 入口文件

设计目标：`src/protocol/`、`src/gateway/`、`src/ui/tui/`、`web/`。当前尚未实现。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 15 节。

## 对外接口

- `CommandEnvelope<v1>` / `EventEnvelope<v1>`
- snapshot/replay/ack/auth handshake
- session prompt/steer/follow-up/abort、approval、agent/job commands

## 内部依赖

Application use cases、Kernel event bus、policy approval service、protocol schemas。

## 外部依赖

TUI 使用 Pi TUI primitives；Daemon/TUI/Electron main 使用 Node UDS。Electron renderer framework 尚未决定。

## 注意事项

- Snapshot/complete event 权威；delta/progress 可合并或丢弃。
- 相同 command id 必须幂等；seq gap 触发 snapshot，不由客户端猜状态。
- Electron renderer 必须 context-isolated、sandboxed、关闭 Node integration，只暴露 allowlisted preload API。
- UI 同底层指共享 domain/protocol/store，不指共享终端与 DOM 组件。
- Electron 后置阶段视觉基准为 `1920 × 1080`；核心 v1 先用固定 TUI snapshot 验收。

## 常见修改点

schema version、event mapping、replay window、backpressure、nonce/auth、TUI keymap、Web state/render、visual tests。
