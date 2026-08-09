# Module: Kernel Runtime

## 模块职责

用单一串行 reducer 归并所有权威状态；管理 session actor registry、effects、Daemon 生命周期与 Pi runtime adapter。

## 入口文件

当前入口：`src/pi/pi-runtime-adapter.ts`；Kernel loop/reducer 将在 Phase 1 实现。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 6、7 节。
- 架构摘要：`memory-bank/architecture.md`。
- 版本与兼容决策：`docs/adr/0001-runtime-and-pi-baseline.md`。

## 对外接口

- `KernelEvent` / `Effect`
- `AgentRuntimePort`
- session/create/resume/prompt/steer/followUp/abort/compact/snapshot/subscribe

## 内部依赖

只依赖 domain types、ports、clock/id 事件；Kernel 不直接依赖 Node I/O。

## 外部依赖

`PiRuntimeAdapter` 计划依赖锁定版本的 `@earendil-works/pi-coding-agent`，Kernel 本身不依赖 Pi。

## 注意事项

- 单 main loop 指单一状态 commit，不指禁止异步 activity。
- session replacement 后必须重新绑定 Pi 事件订阅。
- Pi `agent_end` 不是 settled；需要等 retry/compaction/follow-up 全部结束。
- effect 成功、失败、取消都必须回投事件，不能直接改 state。

## 常见修改点

状态机、effect 类型、Pi 事件映射、并发上限、graceful shutdown 与上游 contract tests。
