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
- `validation.ts`：snapshot/event/result 的结构、类型、深度、节点和 string 上限。
- `security.ts`：BrowserWindow security flags、严格 CSP 与 exact local navigation 检查。
- `smoke-fixture.ts`：只由显式 `--smoke-fixture` 使用的长内容、agent、run、MCP/resource 和审批视觉状态。
- `scripts/copy-desktop-assets.mjs`：构建时复制 CJS preload、HTML 与 CSS。
- `scripts/electron-smoke.mjs`：真实 Daemon + Electron + Xvfb 自包含验收。

## 对外接口

preload 仅暴露：

- `bootstrap()`：读取 connection、authoritative snapshot、cursor 与版本。
- `dispatch(command)`：发送严格 allowlisted action；不接受 channel 名或协议 type。
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
- Electron 退出不停止 Daemon；SIGINT/SIGTERM 会先关闭 bridge 再退出。
- smoke 使用 2048×1200 Xvfb screen 承载精确 1920×1080 content viewport；报告会自动断言尺寸、overflow、焦点、隔离、重连与 IPC allowlist。

## 常见修改点

新增用户动作时同时修改 `DesktopCommand` decoder、protocol mapping、renderer 控件和测试；不得增加通用 `send(channel, payload)`。新增 Kernel 顶层字段或 event type 时同步更新 main validation 与 renderer store。修改视觉布局后运行 `npm run test:electron`，并用 `PSPORE_KEEP_SMOKE=1` 检查两张截图。
