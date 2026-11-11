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
- Daemon 把共享 auto-compaction 设置注入每个新建/恢复 Pi session；有效阈值为 `min(triggerTokens, contextWindow - reserveTokens)`。adapter 在 prompt 前、整轮完成后及工具批次完成后的 `shouldStopAfterTurn` 检查当前上下文，达到阈值复用 Pi `compact()`，事件 reason 映射为 `token_threshold`。
- 长工具循环压缩：在完整工具批次后停下、暂存 steering/follow-up 队列、添加不可见的合法压缩边界、压缩、恢复队列并用不可见 custom message 继续原任务。整个过程只产生一次 `run.started`/`run.settled`；失败明确报错，中止同时取消压缩且不再续跑。
- `SessionMetadata.context` 与累计 `usage` 分离；优先使用 Pi 的当前 usage，压缩后无新 usage 时以 system prompt、工具 schema 与当前消息保守估算，中文不按四字符一 token 低估。`estimated` 明示它是估算。
- `context-budget.ts` 在自定义工具返回进入 Pi 历史前统一处理：文本合计超过 24000 字符时保存 `sessions/artifacts/tool-results/<uuid>.txt`（0600），仅头尾摘录和全文路径进入上下文；图片保留、正常小结果原样返回。全文读取沿用 `read`/`shell` 权限边界。归档暂不自动清理。
- 全文引用与 512 字符尾部预览必须位于摘录开头：Pi v0.84.1 压缩时每条工具结果只序列化前 2000 字符。UTF-16 截断不得切断 surrogate pair；归档 I/O 错误明确显示，但不改变已经成功执行的工具状态。
- `activeTask` 必须在 pre-prompt 压缩之前建立，并提前受理会进入压缩的请求，否则应用层按 session 串行的 abort 被 prompt 阻塞。最终答复后的压缩也必须排空新来的队列再 settled。当前 usage 之后的未测量中文尾部需要校正 Pi 的 chars/4 估计。
- effect 成功、失败、取消都必须回投事件，不能直接改 state。
- Kernel state 按不可变约定共享：`dispatch()` 的返回值与 effect runner 的 state 参数都是当前状态对象本身，调用方不得修改；只有 `snapshot()`（协议边界）仍深拷贝。此前每个事件都深拷贝整份 state，长会话下每个流式 token 都要复制全部 transcript。
- `#onRuntimeEvent` 只为非瞬时事件构建 `SessionView`；`runtime.received` 的 `publishTranscript` 决定广播是否附带 transcript 尾窗（只有 `run.settled`/`session.replaced`/`runtime.error`/`compaction.completed` 附带，其余只带元数据）。250 ms 节流已在阶段 2 撤销。
- 守护进程里的 `void kernel.dispatch(...)` 一律经带 catch 的 `emit`/`#dispatch` 包装：未捕获的 rejection 会结束进程，反复重启则触发 systemd start limit，客户端就再也连不上了。
- 当前只完成单 main session 纵切；durable event log、session mapping/resume、run ledger 与多 actor budget 尚未实现。

## 常见修改点

状态机、effect 类型、Pi 事件映射、并发上限、graceful shutdown 与上游 contract tests。
