# Module: Interface and Protocol

## 模块职责

通过 transport-neutral 命令、事件和快照连接 Daemon、TUI 与 Web；处理认证、重连、幂等、revision、背压和 UI state reduction。

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

TUI 使用 Pi TUI primitives；UDS/HTTP/WebSocket 具体库在实现时最小化选择。Web framework 尚未决定。

## 注意事项

- Snapshot/complete event 权威；delta/progress 可合并或丢弃。
- 相同 command id 必须幂等；seq gap 触发 snapshot，不由客户端猜状态。
- Web 默认 loopback、校验 origin、一次性 nonce、严格 CSP。
- UI 同底层指共享 domain/protocol/store，不指共享终端与 DOM 组件。
- Web 首版视觉基准为 `1920 × 1080`。

## 常见修改点

schema version、event mapping、replay window、backpressure、nonce/auth、TUI keymap、Web state/render、visual tests。
