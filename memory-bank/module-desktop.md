# Module: Electron Desktop

## 模块职责

提供 Linux Electron 43 桌面客户端，同时保持 Daemon 为唯一权威状态 owner。main process 连接私有 UDS；preload 暴露最小 API；sandboxed renderer 负责可丢弃状态归并与 DOM 展示。

## 入口文件

- CLI：`node dist/cli/main.js desktop`
- npm：`npm run desktop`
- Electron main：`src/desktop/main.ts`
- renderer：`src/desktop/renderer/index.html`、`renderer.ts`、`store.ts`、`styles.css`
- preload：`src/desktop/preload.cjs`

## 关键文件

- `ipc-contract.ts`：离散 `DesktopCommand` union、严格 decoder 与 protocol mapping。
- `daemon-bridge.ts`：UDS owner、cursor、gap/reconnect、snapshot、连续 delta coalescing。
- `src/daemon/supervisor.ts`：桌面/TUI 共用；原子判定客户端拥有新 Daemon 还是复用现有实例，只关闭自己拥有的实例。`src/desktop/daemon-supervisor.ts` 仅保留兼容导出。
- `src/settings/llm-settings*.ts`：GUI/TUI/CLI 共用严格设置 decoder/service；验证并原子持久化 Provider、模型、Base URL、自定义兼容 API 与私有 API Key 引用，保存前用 Pi `ModelRuntime` 验证模型可解析。
- `validation.ts`：snapshot/event/result 的结构、类型、深度、节点和 string 上限。
- `src/ui/shared/activity.ts`：与 TUI 共享的 cowork 活动归一、工具事件合并、语义摘要、结果/耗时与脱敏详情。
- `security.ts`：BrowserWindow security flags、严格 CSP 与 exact local navigation 检查。
- `smoke-fixture.ts`：只由显式 `--smoke-fixture` 使用的长内容、agent、run、MCP/resource 和审批视觉状态。
- `scripts/copy-desktop-assets.mjs`：构建时复制 CJS preload、HTML 与 CSS。
- `scripts/electron-smoke.mjs`：真实 Daemon + Electron + Xvfb 自包含验收。

## 对外接口

preload 仅暴露：

- `bootstrap()`：读取 connection、authoritative snapshot、cursor 与版本。
- `dispatch(command)`：发送严格 allowlisted action；不接受 channel 名或协议 type。
- `getSettings()`：只返回模型设置和 `hasApiKey` 布尔状态，不返回 secret。
- `saveSettings(settings)`：发送严格解码的模型设置；owned Daemon 自动重启应用，external Daemon 只保存并提示用户重启。
- `subscribe(listener)`：订阅 main 已校验的 connection/snapshot/event/delta frame。

支持 main prompt/steer/follow-up/abort/compact、approval resolve、job/run、subagent、MCP 与 trusted resource 操作。resource IPC 只接受单层 staging name；renderer 不能提交任意绝对路径。

## 内部依赖

`ProtocolClient`、Kernel snapshot/event types、已有 Application UDS commands、resource staging root。renderer 不依赖 Electron、Node 或 Daemon implementation。

## 外部依赖

仅使用已锁定的 dev toolchain `electron@43.3.0`；renderer 无新增 framework/runtime dependency。自动视觉验收依赖 Linux `xvfb-run`。

## 注意事项

- BrowserWindow 固定 `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`、`webviewTag=false`、`webSecurity=true`。
- main 拒绝权限请求、下载、外部/非 exact-file 导航、新窗口、webview 和 HTTP(S)/WS 请求；HTML CSP 不允许 remote content、inline script、object、form 或 frame。
- renderer 所有动态内容都通过 `textContent`/Text node 写入，不使用 `innerHTML`。
- snapshot 是权威恢复点；renderer event gap 不猜状态，main bridge 断开并重新获取 snapshot。
- 桌面启动先以 create-only 方式初始化 home；无现有锁时在 Electron main process 拥有 Daemon，有活跃锁时复用外部 Daemon。退出始终先关闭 bridge，仅在 `owned` 模式下停止 Daemon，不影响外部/TUI 会话。
- renderer 通过语义色变量提供持久化深色/浅色主题；正文/消息/输入分别不低于 `15/15.5/15px`，设置字段不低于 `14px`，辅助标签不低于 `11.5px`。
- 视觉语言为 "spore print"：深色是暖腐殖土底 `#141310` + 骨白文字，浅色是暖纸 `#ede9dc` + 墨字；`--accent` 是骨白/墨（仅用于主操作、焦点环、选中文本），`--live` moss 表示存活/成功、`--honey` 表示等待与审批、`--rust` 表示失败、`--lichen` 表示用户消息。标识符（session id、会话标题、指标、状态、代码）统一用 mono，人类语句用 sans。
- 会话正文测量宽度固定 `820px`，长代码块在自身容器内横向滚动；消息 meta 用 mono 小写标签加细线分隔；左栏用缩进 + `└` 型连接线呈现 agent 树（`--session-depth`），右侧标记显示会话状态。
- 三栏在 `>=1600px` 默认全开；`1321–1599px` 只开会话+对话；`<=1320px` 检查器为覆盖抽屉；`<=1160px` 会话栏也转为抽屉。左栏底部常驻 `工作区` 摘要（运行/MCP/资源/待批准），与 TUI 的 WORKSPACE 块保持同一组指标。
- GUI 文案统一中文（含 notice、错误与空状态）；只有 `src/ui/shared/activity.ts` 的 cowork label/summary 保持英文，因为 TUI/CLI 要求英文且两端共用同一归一层。
- activity inspector 对 started/updated/completed 工具事件只保留一张持续更新的卡片，使用与 TUI 一致的 cowork label、状态点、目标、结果与脱敏详情；其他运行/系统活动保持可见。
- 布局为 conversation-first：左侧会话常驻，右侧 activity/automation/integration/resource 共用一个按需检查器；`<=1320px` 使用覆盖抽屉，不压缩主会话，未实现 mobile layout。
- Provider 下拉精确提供 DeepSeek、OpenAI、自定义 OpenAI。只有自定义 OpenAI 开放 Base URL 和 Chat/Responses 选择，预设 Provider 使用固定默认 endpoint/API。
- API Key 保存到 `credentials/<provider>.api-key` 且 mode `0600`；`models.json` 只存私有文件读取引用。renderer 始终只看见 `hasApiKey`。
- smoke 使用 2048×1200 Xvfb screen 承载 `1920×1080` 主视口，并补测 `1440×900`、`1180×720`；报告自动断言外部/拥有 Daemon、双主题、设置、计算后字号、响应式收纳、overflow、焦点、隔离、重连与 IPC allowlist。
- GitHub GUI 发行产物使用 `pspore-desktop-<version>-linux-x64.AppImage`，版本与 npm/package 对齐；发布前必须直接从 AppImage 运行 `--smoke-dir/--smoke-fixture`，不得只验证源码 Electron。

## 常见修改点

新增用户动作时同时修改 `DesktopCommand` decoder、protocol mapping、renderer 控件和测试；不得增加通用 `send(channel, payload)`。模型设置改动同时检查 shared decoder/service、desktop IPC alias、TUI/CLI、owned/external restart 语义与 secret 回读。新增 Kernel 顶层字段或 event type 时优先修改 shared protocol reducer，再同步 main validation。修改视觉布局后运行 `npm run test:electron`，并用 `PSPORE_KEEP_SMOKE=1` 检查深色、浅色、设置、响应式和审批截图。
