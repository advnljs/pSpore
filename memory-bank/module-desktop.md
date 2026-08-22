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
- `getSettings()`：只返回模型设置和 `hasApiKey` / `hasCookie` 布尔状态，不返回 secret。
- `saveSettings(settings)`：发送严格解码的模型设置；owned Daemon 自动重启应用，external Daemon 只保存并提示用户重启。
- `subscribe(listener)`：订阅 main 已校验的 connection/snapshot/event/delta frame。

支持 main prompt/steer/follow-up/abort/compact、approval resolve、job/run、subagent、MCP 与 trusted resource 操作。resource IPC 只接受单层 staging name；renderer 不能提交任意绝对路径。

## 内部依赖

`ProtocolClient`、Kernel snapshot/event types、已有 Application UDS commands、resource staging root。renderer 不依赖 Electron、Node 或 Daemon implementation。

## 外部依赖

仅使用已锁定的 dev toolchain `electron@43.3.0`；renderer 无新增 framework/runtime dependency。自动视觉验收依赖 Linux `xvfb-run`。

## 注意事项

- 窗口初始尺寸由 `desktopInitialSize()` 按主显示器 work area 收敛（上限 1920×1080，下限 1180×720），首次显示时 `maximize()`；smoke 路径不走该分支，仍用显式 `setContentSize`。
- `.app-shell` 是 flex column 而非固定行 grid：连接横幅 `display:none` 时固定模板会留下空轨道与 gap，导致首屏底部留白。
- BrowserWindow 固定 `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`、`webviewTag=false`、`webSecurity=true`。
- main 拒绝权限请求、下载、外部/非 exact-file 导航、新窗口、webview 和 HTTP(S)/WS 请求；HTML CSP 不允许 remote content、inline script、object、form 或 frame。
- renderer 所有动态内容都通过 `textContent`/Text node 写入，不使用 `innerHTML`；Markdown 也走 `src/ui/shared/markdown.ts` 解析 + `markdown-view.ts` 建 DOM 的两段式，绝不拼 HTML 字符串。
- Markdown 支持标题、围栏代码（含 streaming 未闭合围栏）、引用、有序/无序/任务列表、分隔线、GFM 表格与行内标记；链接因主进程禁止外部导航而渲染为惰性文本加可复制 URL，且只识别 http/https/mailto/file。
- 设置弹层含“权限”区，写入共享 `permissionMode` → `config.permissions.mode`；选择 `allow_all` 时必须显示 bypass 风险告警，保存结果文案也会复述该风险。
- snapshot 是权威恢复点；renderer event gap 不猜状态，main bridge 断开并重新获取 snapshot。
- 桌面启动先以 create-only 方式初始化 home；无现有锁时在 Electron main process 拥有 Daemon，有活跃锁时复用外部 Daemon。退出始终先关闭 bridge，仅在 `owned` 模式下停止 Daemon，不影响外部/TUI 会话。
- renderer 通过语义色变量提供持久化深色/浅色主题，默认浅色（白天模式），localStorage 键 `pspore.desktop.theme` 可覆盖；正文/消息/输入分别不低于 `15/15.5/15px`，设置字段不低于 `14px`，辅助标签不低于 `11.5px`。
- 视觉语言为 "cobalt paper"（2026-08-22 重构，替代旧 "spore print"）：浅色为默认主题——冷白纸面 `#f4f7fb` + 白面板 + 深藏青墨字 `#16243d`，主强调色是钴蓝 `#2563eb`（仅用于主按钮、焦点环、选中态、链接、用户消息）；深色是去饱和板岩藏青 `#0b1119` 底 + 分层表面 + 发丝级边框，单一克制蓝 `#5f8dff`，无渐变光晕（避免廉价感/广告感）。语义色：`--live` 存活/成功、`--honey` 等待与审批告警、`--rust` 失败、`--lichen` 用户消息。标识符（session id、会话标题、指标、状态、代码）统一用 mono，人类语句用 sans。topbar 无卡片化（透明浮于 canvas），panel 用发丝边框替代重阴影。
- composer 键盘行为：Enter 直接发送；Ctrl/Cmd+Enter、Shift+Enter、Alt+Enter 插入换行；`event.isComposing` 时忽略（中文输入法合成回车不发送）。发送按钮 kbd 提示为 `↵`。
- 动效由 GSAP 3.15 驱动（`src/desktop/renderer/motion.ts` 封装）：应用入场编排（topbar/三栏 stagger expo.out）、会话切换消息 stagger 入场、新消息单条滑入（流式 delta 不重复触发）、设置/审批弹层出入场（含退出动画后置 `hidden` 与状态守卫防竞态）、连接徽章状态切换弹性脉冲、发送按钮按压微动效。所有动效在 `prefers-reduced-motion: reduce` 或引擎缺失时立即降级为直接显示。
- GSAP 以 UMD 构建 vendored 进产品：`node_modules/gsap/dist/gsap.min.js` 由 `scripts/copy-desktop-assets.mjs` 复制到 `dist/desktop/renderer/vendor/gsap.min.js`，index.html 以 classic script 加载（CSP `script-src 'self'` 允许同源）；renderer 通过 `import type { gsap } from "gsap"` 取类型、运行时读 `window.gsap`，不引入 bundler。安全测试 `desktop-security.test.ts` 已显式放行且仅放行 `./vendor/gsap.min.js` 与 `./renderer.js` 两个本地脚本路径，内联与其它 src 仍被拒绝。
- 会话正文测量宽度固定 `820px`，长代码块在自身容器内横向滚动；消息 meta 用 mono 小写标签加细线分隔；左栏用缩进 + `└` 型连接线呈现 agent 树（`--session-depth`），右侧标记显示会话状态。
- 三栏在 `>=1600px` 默认全开；`1321–1599px` 只开会话+对话；`<=1320px` 检查器为覆盖抽屉；`<=1160px` 会话栏也转为抽屉。左栏底部常驻 `工作区` 摘要（运行/MCP/资源/待批准），与 TUI 的 WORKSPACE 块保持同一组指标。
- GUI 文案统一中文（含 notice、错误与空状态）；只有 `src/ui/shared/activity.ts` 的 cowork label/summary 保持英文，因为 TUI/CLI 要求英文且两端共用同一归一层。
- activity inspector 对 started/updated/completed 工具事件只保留一张持续更新的卡片，使用与 TUI 一致的 cowork label、状态点、目标、结果与脱敏详情；其他运行/系统活动保持可见。
- 布局为 conversation-first：左侧会话常驻，右侧 activity/automation/integration/resource 共用一个按需检查器；`<=1320px` 使用覆盖抽屉，不压缩主会话，未实现 mobile layout。
- Provider 下拉精确提供 DeepSeek、OpenAI、自定义 OpenAI。只有自定义 OpenAI 开放 Base URL 和 Chat/Responses 选择，预设 Provider 使用固定默认 endpoint/API。
- API Key 与 Cookie 保存到 `credentials/<provider>.api-key` 与 `<provider>.cookie` 且 mode `0600`；`models.json` 只存私有文件读取引用，Cookie 写入 `headers.Cookie`。renderer 始终只看见 `hasApiKey` / `hasCookie`。
- smoke 使用 2048×1200 Xvfb screen 承载 `1920×1080` 主视口，并补测 `1440×900`、`1180×720`；报告自动断言外部/拥有 Daemon、双主题、设置、计算后字号、响应式收纳、overflow、焦点、隔离、重连与 IPC allowlist。
- GitHub GUI 发行产物使用全量 `pspore-desktop-<version>-linux-x64.zip`（含可点击的 `创建桌面快捷方式.sh`）与 overlay `pspore-desktop-<version>-linux-x64-overlay.zip`（仅 `resources/app.asar`，不含 Chromium）；版本与 npm/package 对齐。
- 打包入口是 `npm run package:desktop`（`scripts/package-desktop.sh` + `electron-builder.yml` linux dir）。GitHub Actions `Release desktop` 在推送到 `main` 或 `v*` tag 时构建这两个 zip，并直接上传到 `v<version>` GitHub Release（已有 Release 则覆盖同名资产）。
- 主工作区使用 `body` flex + `.app-shell` 纵向拉伸，初始加载即铺满窗口高度。

## 常见修改点

新增用户动作时同时修改 `DesktopCommand` decoder、protocol mapping、renderer 控件和测试；不得增加通用 `send(channel, payload)`。模型设置改动同时检查 shared decoder/service、desktop IPC alias、TUI/CLI、owned/external restart 语义与 secret 回读。新增 Kernel 顶层字段或 event type 时优先修改 shared protocol reducer，再同步 main validation。修改视觉布局后运行 `npm run test:electron`，并用 `PSPORE_KEEP_SMOKE=1` 检查深色、浅色、设置、响应式和审批截图。
