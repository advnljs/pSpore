# Module: Kernel Runtime

## 模块职责

用单一串行 reducer 归并所有权威状态；管理 session actor registry、effects、Daemon 生命周期与 Pi runtime adapter。

## 入口文件

当前入口：`src/daemon/daemon.ts`、`src/application/agent-application.ts`、`src/kernel/loop.ts`、`src/kernel/reducer.ts`、`src/pi/pi-runtime-adapter.ts`。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 6、7 节。
- 架构摘要：`memory-bank/architecture.md`。
- 版本与兼容决策：`docs/adr/0001-runtime-and-pi-baseline.md`。
- `test/unit/kernel.test.ts`：纯 reducer 与串行 commit。
- `test/integration/daemon.test.ts`：ready、懒 session、UDS prompt、幂等与 graceful shutdown。

## 对外接口

- `KernelEvent` / `Effect`
- `AgentRuntimePort`
- session/create/resume/prompt/steer/followUp/abort/compact/snapshot/subscribe

## 内部依赖

只依赖 domain types、ports、clock/id 事件；Kernel 不直接依赖 Node I/O。

## 外部依赖

`PiRuntimeAdapter` 依赖锁定版本的 `@earendil-works/pi-coding-agent`；Kernel 本身只依赖领域类型，不导入 Pi、Node I/O 或 UI。

## 注意事项

- 单 main loop 指单一状态 commit，不指禁止异步 activity。
- session replacement 后必须重新绑定 Pi 事件订阅。
- Pi `agent_end` 不是 settled；需要等 retry/compaction/follow-up 全部结束。
- Daemon 把共享 auto-compaction 设置注入每个新建/恢复 Pi session；Pi 自身按模型上限 reserve 触发，adapter 另在 prompt 前和 turn 完成后读取 `getContextUsage()`，达到 `triggerTokens` 时调用同一个 Pi `compact()`，事件 reason 映射为 `token_threshold`。
- effect 成功、失败、取消都必须回投事件，不能直接改 state。
- Kernel state 按不可变约定共享：`dispatch()` 的返回值与 effect runner 的 state 参数都是当前状态对象本身，调用方不得修改；只有 `snapshot()`（协议边界）仍深拷贝。此前每个事件都深拷贝整份 state，长会话下每个流式 token 都要复制全部 transcript。
- `#onRuntimeEvent` 只为非瞬时事件构建 `AgentSnapshot`；`runtime.received` 的 `publishSnapshot` 决定广播是否附带快照（settling 事件必带，其余每 session 250 ms 最多一次）。
- 守护进程里的 `void kernel.dispatch(...)` 一律经带 catch 的 `emit`/`#dispatch` 包装：未捕获的 rejection 会结束进程，反复重启则触发 systemd start limit，客户端就再也连不上了。
- 当前只完成单 main session 纵切；durable event log、session mapping/resume、run ledger 与多 actor budget 尚未实现。

## 常见修改点

状态机、effect 类型、Pi 事件映射、并发上限、graceful shutdown 与上游 contract tests。
