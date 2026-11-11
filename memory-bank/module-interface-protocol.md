# Module: Interface and Protocol

## 2026-11-11 TUI 在 xterm 中丢失大写字母

- Pi TUI 在终端不支持 Kitty 键盘协议时启用 xterm modifyOtherKeys（`CSI >4;2m`），Shift+字母以 `CSI 27;2;码点~` 到达；pi-tui 0.84.1 的 `Input` 只解码 Kitty CSI-u，于是 xterm 里所有大写字母被丢弃（隐藏输入同理）。`src/ui/tui/view.ts` 的 `modifyOtherKeysPrintable` 先把这类序列（仅 Shift/锁定键修饰）还原成字符再交给 `Input`；Ctrl/Alt 组合仍是快捷键。真实 xterm 中实测 "Hello World ABC xyz Q" 完整输入。
- 同期修复：TUI 提交后提示「继续排队」的判断改为发送前的会话状态（此前每条普通消息都被误报为排队）；帮助里 `/delete`、`/send-now` 两行改为英文（队列项标签「继续排队 / 直接发送消息」保持用户指定的中文）。

## 模块职责

通过 transport-neutral 命令、事件和快照连接 Daemon、TUI 与 Electron 客户端；处理认证、重连、幂等、revision、背压和 UI state reduction。

## 入口文件

当前入口：`src/protocol/schema.ts`、`src/protocol/server-frame-codec.ts`、`src/protocol/client.ts`、`src/gateway/local-gateway.ts`、`src/ui/shared/`、`src/ui/tui/`、`src/desktop/daemon-bridge.ts`、`src/desktop/renderer/store.ts`。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 15 节。
- UDS integration：`test/integration/local-gateway.test.ts`。
- 大消息 codec：`test/unit/server-frame-codec.test.ts`。
- TUI store/固定画面：`test/unit/tui-store-view.test.ts`。
- Electron bridge/store：`test/integration/desktop-daemon-bridge.test.ts`、`test/unit/desktop-store.test.ts`。
- 共享客户端状态与表现：`src/ui/shared/protocol-state.ts`、`src/ui/shared/presentation.ts`、`src/ui/shared/activity.ts`。

## 对外接口

- `CommandEnvelope<v1>` / `EventEnvelope<v1>`
- snapshot/replay/ack/auth handshake
- session create/delete/auto-prompt/queue-send-now/abort/compact、approval、agent/job commands
- `session.delete` 只接受根会话：先取消审批与子 agent、abort 运行中的会话，再 dispose runtime、删除 catalog 记录与 Pi JSONL；只在 catalog 里的记录（未 attach）同样可删。客户端靠已有的 `session.closed` 广播与 `selectAvailable` 自动切走选中项。
- Electron renderer 固定 `bootstrap/dispatch/getSettings/saveSettings/getPathForFile/subscribe` preload API；`DesktopCommand` 在 main process 严格解码并映射到既有 UDS command。`getPathForFile` 不是 IPC command，只把用户真实拖入的 Chromium `File` 交给 Electron `webUtils` 取绝对路径，不读取内容或接受任意路径字符串。

## 内部依赖

Application use cases、Kernel event bus、policy approval service、protocol schemas。

## 外部依赖

TUI 使用 Pi TUI primitives；Daemon/TUI/Electron main 使用 Node UDS。Electron renderer 使用原生 DOM/TypeScript，不新增 UI runtime dependency。

## 注意事项

- Snapshot/complete event 权威；delta/progress 可合并或丢弃。
- Daemon 出站一律经 `src/protocol/limits.ts` 裁剪到客户端上限以内；瞬时事件不携带 session 视图，其余非瞬时事件带元数据，只有 `run.settled`/`session.replaced`/`runtime.error`/`compaction.completed` 额外带 transcript 尾窗。单条被裁剪的消息可用 `session.message` 分片取回原文。
- 新客户端在 hello 中声明 `server-frame-chunks.v1`；新 Daemon 仅对声明该 capability 的连接分片。逻辑 server message 上限为 64 MiB，物理 frame 仍为 1 MiB；chunk 必须有序、同 ID/encoding/count/length，并在有界 gunzip 与完整 JSON/kind 校验后交付。普通小 frame 和未声明 capability 的旧客户端保持 v1 newline wire format。
- 相同 command id 必须幂等；seq gap 触发 snapshot，不由客户端猜状态。
- Electron renderer 已启用 context isolation/sandbox 并关闭 Node integration；只暴露 allowlisted preload API，main 对 command 与 server frame 再校验。
- UI 同底层指共享 domain/protocol、权威 snapshot/event reducer、presentation model、会话输入路由、设置与 Daemon 生命周期；终端与 DOM 组件保持平台原生。
- Electron 视觉基准为 `1920 × 1080`，补测 `1440×900`、`1180×720`；TUI 主基准为 `160×45`，补测 `96×30` 单栏。均只覆盖桌面/终端，不实现手机布局。
- 当前 replay window 位于内存，受 1024 条与 16 MiB 双上限约束；Daemon 重启后的 durable event replay 尚待 event log 实现，重连仍可用最新 snapshot 恢复。
- TUI clientId 在进程内稳定，seq gap 会断开并指数退避重连；相同 command ID 由 Daemon 缓存首次响应。
- job/run/notification 状态已经进入 Kernel snapshot；CLI/TUI 可列出 job/run/notification、触发 job、取消 run，CLI/agent 可原子更新 job。
- Electron bridge 保存 cursor、检测 gap、指数退避重连，并在不改变 seq 语义的前提下按 `text` / `thinking` channel 分别合并连续同 session delta；renderer 只保留可丢弃 store。
- renderer 不能指定任意 IPC channel 或路径；resource UI 只提交单层 staging name，main 才解析为配置 workspace 下的 staging 路径，Daemon 再执行 canonical containment。
- TUI >=104 cells 使用会话+内容双栏，较窄终端使用单内容区；`/help` 打开完整命令面板，`/config wizard` 与 `/config` 子命令使用同一 settings service。
- TUI 版式：header 左侧 `∴ pSpore` 品牌、右侧 ONLINE + model；context 行左侧 session/活动、右侧 context/rev/approvals；会话内容自输入行向上生长（`anchorBottom`），左栏 SESSIONS 置顶、WORKSPACE 指标贴底（`composeColumn`）；子 agent 用 `└─` 分枝表示树层级；footer 去掉多余分隔线，只保留 notice/help/prompt 三行。
- `activity.ts` 将 tool 三段事件按 `toolCallId` 合并，并对 run/compaction/retry/error/automation/agent/integration 事件保持语义化活动；TUI 和 Electron 共用 label/summary/status/result/duration/detail redaction。
- TUI 与桌面共用同一套语义色：brand/bone `187`、live moss `108`、agent `151`、lichen（用户/会话 id）`109`、honey（等待/审批）`179`、rust（失败）`174`、memory `182`、muted `245`、faint `242`、border `240`；动画只在选中 session 运行或存在运行中活动时以 120 ms 刷新，并尊重 `NO_COLOR`/dumb terminal。
- `/work` 展示最近 30 个工作步骤，`/work <ID-prefix>` 展示一步的脱敏、限深、8 KB 限长详情；会话区不再重复渲染 raw tool result 消息。
- 普通输入根据共享 `conversationIntent` 路由到当前选中的任意根 session/child，避免 child 输入误发给其他根会话；根 session 运行中由 Application 自动 follow-up。GUI 不显示发送模式，follow-up 每项仅显示“继续排队/直接发送消息”；TUI 用 `/send-now N` 执行同一操作，底层 Pi steer 术语不暴露。
- GUI/TUI store 的协议 reducer 保持不可变更新并在 IPC 校验边界 clone；`snapshot()` 返回只读当前引用，避免 streaming delta 深拷贝完整历史。GUI 用共享 `VirtualHeightIndex` 窗口化 DOM，TUI 只格式化 `rows + scrollOffset + overscan` 的历史尾窗。
- `transcript.delta{kind:"thinking"}` 只进入 `streamingThinking`，不拼进 `streamingText` 或持久 `messages`；`transcript.item.finished`、`run.settled`、`runtime.error` 和 `session.replaced` 会清理两类临时流。Desktop coalesced delta frame 必须显式携带 `itemId` 与 `channel: "text" | "thinking"`。
- `SessionMetadata.rootSession` 只为持久交互式根会话携带 title/createdAt/updatedAt；`presentSessions` 将多个根会话及各自 agent tree 分组呈现，没有 rootSession 时回退到 `firstUserText`。
- `AgentSnapshot` 类型已删除：守护进程里没有任何地方需要"整份 transcript"这个对象。会话状态用 `SessionMetadata`（无 messages），历史用 `transcript()` 分页，单条原文用 `transcriptMessage()` 分片；需要完整分支（fork 定位 entry id）时才用 `PiRuntimeAdapter.branch(sessionId)`。
- npm 分发包名为 `p-spore`，全局可执行命令为 `pspore`；纯 npm 包不包含 Electron 生产依赖，桌面端由 GitHub Release 全量 zip / overlay zip 分发。

## 常见修改点

schema version、event mapping、共享 reducer/presentation、replay window、backpressure、nonce/auth、TUI keymap/wizard、Electron action allowlist/store、visual tests。


## 2026-09-07：瞬时事件背压与界面连接稳定期

- **根因**：`LocalGateway.publish()` 过去在 `socket.writableNeedDrain` 时直接跳过非 durable 事件，但全局 `seq` 已经自增。客户端按 `seq === cursor + 1` 判定连续性，于是把背压当成事件缺口并主动 `close()`，长任务的高频 `message.delta` 会不断触发“断开—重连”，界面随之跳动。
- **协议**：`EventEnvelope` 新增可选 `skipped`，语义是“本连接在这条事件之前被丢弃的瞬时事件数”。网关按连接累计并在下一条投递的事件上携带后清零，因此同一 `seq` 对不同连接可携带不同 `skipped`。客户端期望序号变为 `cursor + 1 + skipped`；超出仍视为真实缺口并重连取快照。
- **丢弃策略**：durable 事件永不丢弃；超过 `maxPendingBytes` 时只有 durable/response/hello 会断开慢客户端，瞬时事件一律计数丢弃。
- **desktop delta 合并**：`DaemonBridge` 的 delta 合并在跨越 skip 时仍可继续，`DesktopFrame.delta` 只在 `skipped > 0` 时携带该字段。
- **界面稳定期**：`DesktopStore`/`TuiStore` 各持有 2 秒 settle window（`CONNECTION_SETTLE_MS` / `TUI_CONNECTION_SETTLE_MS`），对外暴露 `stableConnection`/`reconnecting`。窗口内保持呈现为已连接，只有指示灯变暖色呼吸；超时才降级并更新状态行。渲染层用 250ms 定时器驱动 `settleConnection()`，保证无新帧时真实掉线也会显现。
- **重连期命令**：GUI 只对 `DAEMON_NOT_CONNECTED_MESSAGE`（bridge 在写 socket 之前抛出）重试一次，等待连接恢复后再发，因此不会重复已经执行的命令。

## 2026-09-07：出站上限、快照节流与掉线自愈

- **协议出站上限（`src/protocol/limits.ts`）**：客户端上限（单串 262144 字符、集合 10000 项、深度 32、节点 2000000）与守护进程上限（单串 65536 字符、集合 2000 项、深度 24、单值 8 MiB）在同一处定义；`desktop/validation.ts` 直接引用客户端常量，两侧不会漂移。
- **裁剪点在网关**：`LocalGateway` 对 hello 快照、每条事件 payload、每条命令响应各裁剪一次（`boundPublishedValue`/`measurePublishedValue`，未超限时结构共享、零拷贝）。字符串保留头部并注明截断到多少；数组保留**尾部**（transcript 都是追加型，客户端看的就是尾巴），共享预算也从尾部开始花，用尽后丢弃更旧的条目。
- **为什么必须裁剪**：客户端校验失败会关连接，而权威快照每次重连都会重发同一份内容——一条超限消息一旦进入会话，桌面端就会永久重连失败，重启守护进程也无效（快照从 JSONL 恢复）。裁剪把这一整类"永久锁死"变成"最旧内容被截断"。
- **快照附带策略**：`runtime.received` 新增 `publishSnapshot`。瞬时事件（token delta、tool partial）完全不构建快照；durable 事件中 `run.started`/`run.settled`/`session.replaced`/`runtime.error`/`message.completed`/`compaction.completed`/`queue.updated` 必带，其余每个 session 每 250 ms 最多带一次。Kernel state 始终吸收快照，只是广播不重复搬运整份 transcript。
- **背压**：进出预算分离——`maxPendingBytes` 只管连接的入站缓冲，新增 `maxOutgoingBytes`（默认 64 MiB）管出站；只有真正停止读取的客户端才会被断开，断开原因经 `onWarning` 写入 journal。
- **replay window 双上限**：除 1024 条外还有 16 MiB 字节上限（`maxReplayBytes`）。durable 事件带快照，只按条数计会在长任务中滞留数百 MiB transcript；游标落在窗口外的客户端改由 hello 快照恢复。
- **诊断**：`DaemonBridge` 记录自己拒帧/判缺口的原因并作为断线消息上报，重连不再静默；退避睡眠可被 `stop()` 打断，关窗不必等定时器。

## 2026-09-07：阶段 1 —— 会话视图与 transcript 分页

- `SessionMetadata` / `SessionView` / `AgentSnapshot` 三层分开：广播只用 `SessionView`（元数据 + 最近 200 条 + `messageOffset`/`messageCount`），`AgentSnapshot`（完整 messages）只在守护进程内部与 `session.snapshot` 命令响应中出现。
- `session.transcript {from?, limit?}`（sessionId 必填，单页 ≤ 500）按范围取历史；`from` 省略时返回尾页。索引是当前 transcript 的下标，compaction 重写上下文后会位移，客户端据 `messageCount` 变化重取即可。
- 会话标题来源改为 `SessionView.firstUserText`，因为尾窗里通常已经没有开场白。

## 2026-09-07：阶段 2 —— item 级事件

- `transcript.item.started` / `transcript.delta{itemId,kind}` / `transcript.item.finished` 取代原来的四个 `message.*` 事件。item id 由 adapter 分配（`${upstreamSessionId}:${n}`），因为 Pi 的 `Message` 对象没有 id，只有持久化 branch entry 才有。
- `transcript.item.started` 与 `transcript.item.finished` 的 `item` 都必须是完整的 `TranscriptItem`（含 `status` 与 `ts`），不能直接把 adapter 内部的流式对象发出去。桌面端 `validateEventEnvelope` 会拒掉不合规的帧并**关闭连接**，代价是整条连接而不是这一个事件；2026-09-22 之前 `started` 少了这两个字段，导致每条助手消息都触发一次重连。`test/contract/pi-runtime-adapter.test.ts` 用桌面端自己的校验器逐条检查 adapter 发出的事件。
- 携带 transcript 尾窗的事件只剩 `run.settled`/`session.replaced`/`runtime.error`/`compaction.completed`；其余非瞬时事件只带会话元数据，客户端合并时保留自己已有的消息。
- `transcript.item.finished` 由客户端**追加**（事件里就有完整文本），`run.settled` 的权威尾窗负责校正漂移——对应 Pi 的 snapshot-resets-overlay 与 OpenClaw 的 cursor-stale-reset。
- 客户端维护 `streamingItems`（每会话当前流式 item id），delta 属于被取代的 item 时另起缓冲；desktop delta 合并键为 `sessionId+itemId+channel`。

## 2026-09-07：阶段 3 —— 历史分页

- `AgentRuntimePort.snapshot()` 返回 `SessionMetadata`（无 messages），新增 `transcript(sessionId, {from, limit})` → `TranscriptPage`；`AgentSnapshot` 类型已删除。
- `transcript()` 读 `sessionManager` 的持久化分支而非模型 context，因此 compaction 之后仍能翻到被压缩掉的历史；只渲染被请求的那一段文本。
- 客户端用共享 `applyTranscriptPage` 前插历史：拒绝会留下空洞的页与已覆盖的重复页。GUI 在距顶 240px 处自动取前 200 条并按"距底距离"复位视口；虚拟列表 key 用绝对位置，前插不会让已测高度失效。TUI 用 PageUp 触发同一请求。
- `session.snapshot` 命令返回有界的 `SessionView`（不再是完整 transcript）。

## 2026-09-08：回溯保留与单条消息按需取全文

- **权威尾窗不再吞掉回溯历史**：客户端收到带 `messages` 的 `SessionView` 时走 `mergeScrollback()`——`upstreamSessionId` 相同且已有前缀能接上新尾窗时保留前缀，否则整体替换。`session.replaced` 会重编号 transcript，所以那条路径仍是整体替换。
- **`session.message {id?, index?, offset?, limit?}`**（sessionId 必填）返回 `TranscriptMessageSlice{id?, index, role, offset, length, text}`。优先按持久化 branch entry id 定位（index 只是回退，因为运行中的 transcript 会在客户端脚下位移）；单片上限 = `MAX_PUBLISHED_STRING_CHARS`(65 536)，因此响应不会被 `boundPublishedValue` 二次截断，长消息靠多次请求拼回。
- `publishedTextTruncation()`（`src/protocol/limits.ts`）解析 `boundPublishedText()` 写下的截断标记，是客户端判断"这条消息被截过"的唯一依据；标记格式仍只在 `limits.ts` 定义一次。
- 客户端拼接逻辑在 DOM 无关的 `src/ui/shared/full-message.ts`：`readFullMessage(fetchSlice)` 逐片取回，遇到 offset 对不上或空片不前进时返回 `undefined`，由调用方决定提示文案——避免把同一条消息的两个版本拼在一起。
- GUI 在被截断的消息下方渲染 `.message-truncated`（"仅显示前 N / M 个字符" + 载入全文按钮）；恢复的全文按 `session + entry` 缓存，最多 4 条，被截断消息的虚拟 key 因文本变化自然失效并重测高度。
- TUI 的历史回溯改为渲染侧触发：`renderTuiSnapshot` 发现请求窗口越过全部已加载消息时才回调 `onHistoryExhausted`，PageUp 本身不再无条件请求。
