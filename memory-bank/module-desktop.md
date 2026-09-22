# Module: Electron Desktop

## 模块职责

提供 Linux Electron 43 桌面客户端，同时保持 Daemon 为唯一权威状态 owner。main process 连接私有 UDS；preload 暴露最小 API；sandboxed renderer 负责可丢弃状态归并与 DOM 展示。

## 入口文件

- CLI：`node dist/cli/main.js desktop`
- npm：`npm run desktop`
- Electron main：`src/desktop/main.ts`
- renderer：`src/desktop/renderer/index.html`、`renderer.ts`、`article-panel.ts`、`composer-file-references.ts`、`store.ts`、`styles.css`
- preload：`src/desktop/preload.cjs`

## 关键文件

- `ipc-contract.ts`：离散 `DesktopCommand` union、严格 decoder 与 protocol mapping。
- `daemon-bridge.ts`：UDS owner、cursor、gap/reconnect、snapshot、连续 delta coalescing。
- `src/service/system-service.ts`：生产桌面/TUI 共用；自动注册、启用并连接 systemd user service，窗口退出不停止服务。
- `src/daemon/supervisor.ts`：只用于 Electron smoke 的隔离临时 Daemon；`src/desktop/daemon-supervisor.ts` 保留测试兼容导出。
- `src/settings/llm-settings*.ts`、`compaction-settings.ts`：GUI/TUI/CLI 共用严格设置 decoder/service；验证并原子持久化 Provider、模型、Base URL、自动 compact 阈值、自定义兼容 API 与私有 API Key 引用，保存前用 Pi `ModelRuntime` 验证模型可解析。
- `src/ui/shared/virtual-list.ts`：GUI 变高历史窗口索引；Fenwick tree 提供 `O(log n)` 视口定位与测量更新，`isScrollNearEnd` 统一判定是否恢复尾部跟随。
- `validation.ts`：snapshot/event/result 的结构、类型、深度、节点和 string 上限。
- `src/ui/shared/activity.ts`：与 TUI 共享的 cowork 活动归一、工具事件合并、语义摘要、结果/耗时与脱敏详情。
- `src/desktop/renderer/composer-file-references.ts`：拖入路径校验、去重/数量限制、短名称展示与路径引用消息序列化；不访问文件内容。
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
- `getPathForFile(file)`：仅调用 Electron `webUtils.getPathForFile` 解析用户从操作系统拖入的 `File`；不接受路径字符串、不读取文件或目录。
- `subscribe(listener)`：订阅 main 已校验的 connection/snapshot/event/delta frame。
- `exportArticle(request)`：把当前会话已保存的文稿版本导出为 txt、md、docx 或 pdf。转换在 main process，见 `module-articles.md`。

支持根 session create/delete/auto-prompt/queue-send-now/abort/compact、approval resolve、job/run、subagent、MCP 与 trusted resource 操作。所有 session 动作携带 renderer 当前选中的严格 sessionId；resource IPC 只接受单层 staging name，renderer 不能提交任意绝对路径。

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
- 设置弹层含“自动压缩”区，配置 `enabled/reserveTokens/keepRecentTokens`；旧客户端未发送这些可选 IPC 字段时保持当前值，避免 overlay 升级窗口重置配置。
- transcript 只创建变高虚拟窗口中的消息节点，完成消息 DOM 使用 128 项 LRU 缓存；streaming frame 合并到下一 animation frame。renderer/store 返回不可变当前引用，不在每个 delta 上 `structuredClone` 全历史。
- **transcript 的子节点只能用 `reconcileChildren()` 更新，不得用 `replaceChildren`**。`replaceChildren` 即使把同一批节点原样挂回去也会先全部摘下，读者的选区随之塌陷——流式期间每帧都会发生，于是"回复还在写的时候复制不了任何东西"。`reconcileChildren` 必须**先删后排**：先摘掉不再需要的子节点，再按顺序归位；反过来在一个将被删除的节点前插入，会把它后面的每个节点都搬移一次，代价与整棵重建相同。虚拟 padding 是两个常驻元素，只改高度。
- 流式气泡建一次、就地更新（`createStreamingView`）。思考正文写进同一个 Text 节点；正文走 `createMarkdownSurface`，按 `src/ui/shared/markdown-stream.ts` 的块 key 公共前缀只重建解析结果真正变了的块，所以已经写出来的段落连同其中的选区都留在原地。思考区与正文区用 `hidden` 开关而不是增删——smoke 探针因此要用 `:not([hidden])` 选择它们。
- 读者按住选区时，贴底跟随让位，虚拟窗口也会保住那条消息（`VirtualHeightIndex.range(..., keep)`）；超出 40 条的旧滚动历史仍然放手，否则要把中间几千条一起渲染。
- transcript 使用显式 `followTail` 状态：首次进入/切换 session 默认贴底，滚离底部 24px 以上即暂停；浏览历史期间普通 render、异步高度测量与 streaming delta 都不得修改用户滚动位置，重新到达底部后才恢复自动跟随。高度测量回调必须读取最新状态，不能捕获上一帧的贴底布尔值。
- reasoning 使用独立的“思考中”临时面板，正文仍走 Markdown renderer；两者可同时可见但不混排，`message.completed` 或 run 结束后面板自动移除，且不进入历史消息 DOM 缓存。
- snapshot 是权威恢复点；renderer event gap 不猜状态，main bridge 断开并重新获取 snapshot。
- 桌面启动先以 create-only 方式初始化 home，再安装/更新 systemd user unit 并 `enable --now`；renderer 只连接 UDS。退出只关闭 bridge，不停止服务。smoke 路径显式绕过 systemd，防止测试污染真实用户服务。
- systemd directive 必须按各自语法生成：`ExecStart`/`Environment` 可逐参数加引号，`WorkingDirectory` 不得用同一个整值 quoting helper；systemd 245 会把该引号当成路径字节并报“path is not absolute”。路径保留合法空格，只对 `%` specifier 做 `%%` 转义。
- renderer 通过语义色变量提供持久化深色/浅色主题，默认浅色（白天模式），localStorage 键 `pspore.desktop.theme` 可覆盖；正文/消息/输入分别不低于 `15/15.5/15px`，设置字段不低于 `14px`，辅助标签不低于 `11.5px`。
- 视觉语言为 "cobalt paper"（2026-08-22 重构，替代旧 "spore print"）：浅色为默认主题——冷白纸面 `#f4f7fb` + 白面板 + 深藏青墨字 `#16243d`，主强调色是钴蓝 `#2563eb`（仅用于主按钮、焦点环、选中态、链接、用户消息）；深色是去饱和板岩藏青 `#0b1119` 底 + 分层表面 + 发丝级边框，单一克制蓝 `#5f8dff`，无渐变光晕（避免廉价感/广告感）。语义色：`--live` 存活/成功、`--honey` 等待与审批告警、`--rust` 失败、`--lichen` 用户消息。标识符（session id、会话标题、指标、状态、代码）统一用 mono，人类语句用 sans。topbar 无卡片化（透明浮于 canvas），panel 用发丝边框替代重阴影。
- composer 键盘行为：Enter 直接发送；Ctrl/Cmd+Enter、Shift+Enter、Alt+Enter 插入换行；`event.isComposing` 时忽略（中文输入法合成回车不发送）。发送按钮 kbd 提示为 `↵`。
- composer 拖拽行为：文件/目录 drop 只加入最多 32 个按绝对路径去重的可移除引用，保留现有文字且不触发 submit；目录不递归展开，renderer 不读取/复制/上传内容。发送时把引用追加为带 JSON 引号的绝对 `@` path token，成功后清空、失败时保留。
- 动效由 GSAP 3.15 驱动（`src/desktop/renderer/motion.ts` 封装）：应用入场编排（topbar/三栏 stagger expo.out）、会话切换消息 stagger 入场、新消息单条滑入（流式 delta 不重复触发）、设置/审批弹层出入场（含退出动画后置 `hidden` 与状态守卫防竞态）、连接徽章状态切换弹性脉冲、发送按钮按压微动效。所有动效在 `prefers-reduced-motion: reduce` 或引擎缺失时立即降级为直接显示。
- GSAP 以 UMD 构建 vendored 进产品：`node_modules/gsap/dist/gsap.min.js` 由 `scripts/copy-desktop-assets.mjs` 复制到 `dist/desktop/renderer/vendor/gsap.min.js`，index.html 以 classic script 加载（CSP `script-src 'self'` 允许同源）；renderer 通过 `import type { gsap } from "gsap"` 取类型、运行时读 `window.gsap`，不引入 bundler。安全测试 `desktop-security.test.ts` 已显式放行且仅放行 `./vendor/gsap.min.js` 与 `./renderer.js` 两个本地脚本路径，内联与其它 src 仍被拒绝。
- 会话正文测量宽度固定 `820px`，长代码块在自身容器内横向滚动；消息 meta 用 mono 小写标签加细线分隔；左栏用缩进 + `└` 型连接线呈现 agent 树（`--session-depth`），右侧标记显示会话状态。
- 左栏 `＋` 创建独立持久根会话并立即切换；composer 只有普通发送，运行中由服务端自动 follow-up。每条 follow-up 以“继续排队”标识并提供“直接发送消息”按钮。
- 消息队列同时渲染 `followUp` 与已提升的 `steering` 状态：后者继续以用户术语“直接发送消息”显示，并提示会在当前工具步骤结束后发送；不能因为从 follow-up 队列移出就在 tool 完成前消失。
- 三栏在 `>=1600px` 默认全开；`1321–1599px` 只开会话+对话；`<=1320px` 检查器为覆盖抽屉；`<=1160px` 会话栏也转为抽屉。左栏底部常驻 `工作区` 摘要（运行/MCP/资源/待批准），与 TUI 的 WORKSPACE 块保持同一组指标。
- GUI 文案统一中文（含 notice、错误与空状态）；只有 `src/ui/shared/activity.ts` 的 cowork label/summary 保持英文，因为 TUI/CLI 要求英文且两端共用同一归一层。
- activity inspector 对 started/updated/completed 工具事件只保留一张持续更新的卡片，使用与 TUI 一致的 cowork label、状态点、目标、结果与脱敏详情；其他运行/系统活动保持可见。
- 布局为 conversation-first：左侧会话常驻，右侧 activity/automation/integration/resource 共用一个按需检查器；`<=1320px` 使用覆盖抽屉，不压缩主会话，未实现 mobile layout。
- Provider 下拉精确提供 DeepSeek、OpenAI、自定义 OpenAI。只有自定义 OpenAI 开放 Base URL 和 Chat/Responses 选择，预设 Provider 使用固定默认 endpoint/API。
- API Key 与 Cookie 保存到 `credentials/<provider>.api-key` 与 `<provider>.cookie` 且 mode `0600`；`models.json` 只存私有文件读取引用，Cookie 写入 `headers.Cookie`。renderer 始终只看见 `hasApiKey` / `hasCookie`。
- smoke 使用 2048×1200 Xvfb screen 承载 `1920×1080` 主视口，并补测 `1440×900`、`1180×720`；1007 条历史 fixture 断言实际 message DOM 少于 40，并实测上滚后静置不回底、streaming delta 不抢位置、回到底部后新消息恢复尾随。CDP 真实拖入一个文件和一个目录，断言 active overlay、两个路径引用、草稿保留且 submit 次数为零。工具完成 frame 发出前即断言“直接发送消息”队列可见，并确认 follow-up 可并存。报告同时覆盖 thinking/正文分区及完成后隐藏、旧三模式 composer 不存在、外部/拥有 Daemon、双主题、compact 设置、计算后字号、响应式收纳、overflow、焦点、隔离、重连与 IPC allowlist。虚拟 transcript 固定 `scroll-behavior:auto`：平滑滚动会让 1000+ 条历史的自动尾随在采样时仍停在中段，导致 streaming 尾消息不可见。
- GitHub GUI 发行产物使用全量 `pspore-desktop-<version>-linux-x64.zip`（含可点击的 `创建桌面快捷方式.sh`）与 overlay `pspore-desktop-<version>-linux-x64-overlay.zip`（完整应用 payload，不含 Electron/Chromium）；版本与 npm/package 对齐。快捷方式先安装 `XDG_DATA_HOME/pspore/bin/pspore-desktop-launcher`，安装路径单独保存并将 stdout/stderr 追加到 `XDG_STATE_HOME/pspore/desktop-launcher.log`，Desktop Entry 不再写错误的带引号 `Path`。
- overlay 携带 `overlay-manifest.json`、`payload/resources/{app.asar,app.asar.unpacked,app-update.yml}` 与 updater；只接受 manifest 中 Electron 精确版本和 Linux `x64|arm64` 架构匹配的完整安装，使用目标 Electron-as-Node 计算目录 SHA-256、执行升级前后 CLI 自检、保留 `.pspore-backup-*`，并重启 ExecStart 指向同一安装目录的 pSpore systemd user unit。
- 打包入口是 `npm run package:desktop`（当前原生架构）或 `scripts/package-desktop.sh <version> <x64|arm64>`；SEA 必须复制同架构 Node，跨架构请求会在下载/写产物前拒绝。脚本会生成 CLI、全量 zip、overlay zip 及三份 SHA-256。`Package Linux ARM64` 使用 ARM runner + glibc 2.31 容器执行完整检查、PC Electron smoke、ELF/运行时验证；`main`/手动运行上传 14 天预览 artifact，正式 tag workflow 把它作为 ARM release producer，与 x64 producer 都成功后统一创建不可变双架构 Release。12 项资产按 `ARM64 / Kylin V10` 与 `x86_64` display label 分类，Release notes 同步提供两个架构章节。
- 主工作区使用 `body` flex + `.app-shell` 纵向拉伸，初始加载即铺满窗口高度。

## 常见修改点

新增用户动作时同时修改 `DesktopCommand` decoder、protocol mapping、renderer 控件和测试；不得增加通用 `send(channel, payload)`。模型设置改动同时检查 shared decoder/service、desktop IPC alias、TUI/CLI、owned/external restart 语义与 secret 回读。新增 Kernel 顶层字段或 event type 时优先修改 shared protocol reducer，再同步 main validation。修改视觉布局后运行 `npm run test:electron`，并用 `PSPORE_KEEP_SMOKE=1` 检查深色、浅色、设置、响应式和审批截图。


## 2026-09-07：GSAP 动效层与 overlay 整包升级

- `src/desktop/renderer/motion.ts` 扩展为完整动效词汇表：`setReconnectingPulse`（重连呼吸循环）、`tweenMetric`（修订/上下文/缓存/计数数字 tween）、`revealListItems`（会话与活动列表 stagger，超出上限只淡入）、`revealPanel`（检查器 tab 切换）、`toggleBannerMotion`（离线横幅滑入滑出）、`popChips`（拖入文件引用）、`flipStatusChip`（会话状态变化）、`crossfadeText`（状态行）。全部只动 transform/opacity，遵守 `prefers-reduced-motion`，vendored GSAP 缺失时每个 helper 立即降级为直接赋值。
- 高频渲染保护：会话列表与活动列表用签名比较，只有集合真正变化才重放动画，流式增量不会每帧重启 stagger。
- 连接呈现改用 `stableConnection`，`document.documentElement.dataset.reconnecting` 与徽标 `data-reconnecting` 供样式和 smoke 断言使用；smoke 新增 `reconnectMasked`，要求短暂掉线先被遮蔽、随后真实掉线仍会显示。
- overlay payload 从“仅 `resources/`”改为“完整安装目录减去 Electron/Chromium 运行时清单”，updater 在安装根目录整体替换、备份到 `<install>/.pspore-backup-*`、输出 `[ NN%] …` 进度、升级后重跑随包的 `创建桌面快捷方式.sh` 使已有桌面快捷方式指向本次升级目录。`scripts/linux/overlay-upgrade-gui.sh` 提供 zenity/kdialog 的目录选择与进度条，无对话框工具时回落终端模式。

## 输入框的文件与目录引用（2026-09-22）

- 三条入口走同一条 `addComposerFileReferences()`：拖拽（`webUtils.getPathForFile`）、「选择文件」按钮、「选择文件夹」按钮。渲染器自己没有任何路径来源，只有这些。
- **文件和目录必须是两个按钮、两次调用**：Linux 的 GTK 选择器只认 `openFile` 与 `openDirectory` 其中一个，同时给两个时静默按目录处理，于是「选文件」永远选不到文件。`pspore:desktop:composer:attach` 因此带 `kind` 参数。返回时仍用 `stat` 判定实际类型，因为符号链接可能答出另一种。
- 只发送路径，不读内容。
- bootstrap 多了一个 `places` 字段（`desktop` / `home`），由 Electron 主进程用 `app.getPath()` 解析——本地化的目录名（例如「桌面」）因此不需要渲染器去猜。字段是可选的：`DaemonBridge` 不知道 Electron，只有主进程能填。
- 首页第三条示例点击后会把桌面目录挂成引用，让"把目录交给它"这件事在被解释之前就出现在屏幕上。
