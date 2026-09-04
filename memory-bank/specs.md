# Specifications

## 用户明确需求

1. 基于 Pi 构建自己的主动式 Agent。
2. 代码与核心算法极简，复杂能力模块解耦、配置化、可插拔。
3. 顶层生命周期与复杂子流程由一个简洁 main loop 归并，包含类似 OpenClaw `BOOT.md` 的设计。
4. 使用本地目录和若干固定文件作为常驻记忆；其余文件与聊天通过 grep/BM25 动态搜索；向量搜索默认不实现但可插拔。
5. 可接入 skills 与 MCP。
6. TUI 和 Electron UI 使用同一套底层；核心先以 TUI 验收，Electron 最后实现。
7. 首版 Linux；默认基于当前登录用户 shell 和权限运行，包括可用的 sudo；用户可选择高危询问、全部询问或完全放权。
8. 允许用户自定义 cron job。
9. 上下文 token 友好并尽可能利用 LLM API KV cache。
10. 支持 subagent，以及主/子 agent 实时双工通信。
11. 与用户保持实时双工通信。
12. 多轮校核并完成详细设计。
13. 完成后自动提交到 GitHub 同名 `pSpore` 私有仓库。

## 约束与偏好

- 默认中文沟通，技术标识保持英文。
- 核心功能先通过 TUI 开发与验收；桌面客户端最后实现。
- 放弃 Tauri，桌面客户端固定使用 Electron 43；项目运行时基线固定为 Node.js 24。
- 当前已进入实现阶段；只汇报真实代码、build、测试和服务状态。
- 首版 local-first、单用户、Linux-first；公网 Web、多租户、vector 和 mobile 不自行扩 scope。
- `allow_all` 的风险必须明确，不得把 in-process policy 宣称为 sandbox。
- Pi 上游以 2026-08-09 核对到的 `v0.84.1` 为设计基线，实现前需 contract spike。
- 新增生产依赖必须另行征求用户确认。
- 用户已确认当前实现依赖，并允许安装/下载时使用中国大陆相关镜像源；不得因此静默改写全局 npm 配置。
- 用户已明确授权在其休息期间不等待新指令，在现有范围与安全边界内持续开发，直到 v1 完成。
- 2026-08-11 桌面优化必须简洁大气，支持深色/浅色模式切换，并重点实际验证字号与可读性。
- 本轮明确只做 PC Electron 桌面端，不做手机端或移动 viewport 验收。
- 独立桌面客户端启动后不得因为缺失 `~/.pspore/run/daemon.sock` 无限等待；必须自动初始化/启动或安全复用 Daemon。
- 使用用户提供但不得提交/输出的 `ds_key.txt` 实际验证 `deepseek-v4-flash`。
- 桌面界面重新设计前可用 image generation 比较多种风格；最终不要高信息密度，应简洁大气。所谓高利用率是修复侧栏长期占位、上下区块失衡和无意义空区，不是缩小字号或塞满信息。
- PC Electron 主工作区必须配合窗口缩放响应式调整；不增加手机布局。辅助检查器应按需展开，会话与输入保持稳定可见。
- 设置菜单至少支持 LLM provider、model、Base URL、API Key、Cookie（LLM 代理 HTTP Cookie 头）、API 兼容类型与 thinking；Key 与 Cookie 不得回读明文、进入日志、会话、memory 或 Git。
- GUI 与 TUI 的 Provider 选择必须精确提供 `deepseek`、`openai`、`custom-openai`（中文显示“自定义 OpenAI”），不暴露其他 Provider。
- TUI 模型配置必须同时支持 launch wizard 与命令方式；wizard 可取消且确认前不持久化，命令方式可直接设置同一共享配置。
- TUI/CLI 与桌面版必须基于相同 Kernel、Daemon、协议状态、会话路由和模型设置内核，功能面覆盖 prompt、main/child、审批、自动化、MCP、资源与设置；平台渲染组件可以独立。
- CLI/TUI 必须可以从 npm 直接安装使用；npm CLI 包不应把 Electron 作为生产依赖。如需发布认证，使用 npm 浏览器认证，不读取或粘贴 token。
- 用户明确选定公开 npm 包名 `p-spore`；安装后的全局 CLI 命令保持为 `pspore`。
- 基于真实 `deepseek/deepseek-v4-flash` 执行多种本地桌面文件、系统检查与长期记忆任务，记录优化前后的工具次数、失败、审批、耗时与重启召回结果。
- TUI 的工具调用必须可见且有运行中动效，使用样式/色彩区分用户、pSpore、运行中、成功、失败和记忆操作；并遵循 `NO_COLOR`/`TERM=dumb`。
- 可参考 OpenCode、Codex CLI 与 Claude Code 的公开交互方式，不使用泄露或非公开源码。pSpore 定位是 cowork agent：能力可与 coding agent 对齐，展示应围绕任务、文件、记忆、自动化和集成等工作语义，而非只呈现编码事件。
- TUI 优化的事件归一、语义标签、状态、结果、耗时和脱敏逻辑必须对 GUI 同时生效；平台只允许在渲染层有差异。
- 本轮完成、验证和记录后必须发布新 npm 版本。
- 2026-08-20 桌面发行改为全量 zip（含可点击的创建桌面快捷方式脚本）与不含 Chromium 的 overlay 覆盖升级 zip；主工作区必须在初始加载时纵向铺满窗口。
- 2026-08-21 GUI 必须增强 Markdown 渲染（标题、列表、任务项、表格、引用、行内标记与代码块），且仍不得使用 `innerHTML` 或放开 CSP。
- 2026-08-21 必须提供 bypass permissions 选项跳过所有授权确认；GUI/TUI/CLI 共用同一持久化设置，并明确说明它不是沙箱。
- 2026-08-21 桌面首屏必须纵向铺满：窗口初始尺寸不得超出主显示器 work area，且主工作区底部留白不得超过设计留白。
- 2026-08-17 界面优化：GUI 与 TUI 一起做；重塑视觉识别，但保留既有信息架构、功能面与验收基准（桌面 `1920×1080`，TUI `160×45`）。
- 视觉识别统一为 "spore print"：暖土/暖纸底色，骨白（深色）或墨色（浅色）只用于主操作与焦点，饱和色仅承担状态语义（moss 存活/成功、honey 等待/审批、rust 失败、lichen 用户）；GUI 与 TUI 共用同一套语义色映射。
- 审批类弹层不得把“允许”做成视觉上最强的按钮；默认焦点保持在拒绝，允许类操作使用告警色描边。
- GitHub Actions 只在与 `package.json` 版本一致的不可变 `v*` tag 上构建 Linux x86_64 与 ARM64 CLI、GUI 全量 zip（含创建桌面快捷方式脚本）及不含 Chromium 的 overlay zip，并在两种架构全部通过后创建一次包含各自 SHA-256 的 GitHub Release；普通 `main` push 不得创建或覆盖 Release。
- 2026-08-22 每次执行打包（`npm run package:desktop` / `scripts/package-desktop.sh`）时，必须在本地同时生成与 GitHub Release 完全一致的全套可执行产物到 `release-dist/`：Node SEA 独立 CLI 二进制 `pspore-<version>-linux-x64`、全量 zip、overlay zip 及三者各自的 sha256，以及解包后可直接运行的可执行二进制目录 `release-dist/pspore-desktop-<version>-linux-x64/`（由脚本自动从 staging 复制，等价于 release.sh 解压结果）。每次阶段性代码改动完成后都要重新打包，保证 `release-dist/` 始终对应最新工作树代码；这些产物只保留在本地并保持被 Git 忽略（`release-dist/`），不得进入仓库、npm 包或 CI 上传清单。
- 2026-08-26 用户要求确认不含 Chromium 的升级包能否从上一版本升级到当前版本；本轮验收必须使用真实 GitHub `v0.1.5` 全量发行物直接升级到 `0.1.6`，验证版本、Electron 运行时保持不变和 GUI 启动。overlay 必须在写入前严格校验 Electron 精确版本、Linux/x64 与 payload hash，不兼容时拒绝并提示使用全量包。
- 2026-08-27 `0.1.7` 发布前必须使用 GitHub 上周不可变 `v0.1.6` tag（提交 `98888cb`）对应的完整安装基线，应用 `0.1.7` overlay，验证应用版本更新、Electron/Chromium 未替换、服务连接及 `1920×1080` GUI 启动。由于旧 `v0.1.6` 二进制资产曾被错误覆盖，基线须从官方 tag 源码还原构建并记录这一事实。
- 2026-09-02 ARM 包目标为用户提供的 `refer/arm_env_check_result.txt` 环境：飞腾 FT-2000/4、AArch64 little-endian、银河麒麟 V10 SP1、glibc 2.31。必须在 GitHub 原生 ARM64 runner 的 glibc 2.31 容器内安装 ARM64 optional dependencies、运行完整检查和 `1920×1080` Electron smoke，再生成 `linux-arm64` SEA CLI、全量 zip、overlay zip 与三份 SHA-256。`main`/手动运行上传保留 14 天的预览 artifact；用户随后明确要求正式打包产物进入 Release，因此新版本 tag 必须复用该链并与 x64 资产一起发布，不得覆盖已有 Release。这是对 2026-08-22“不得进入 CI 上传清单”的 ARM 产物特例。
- 2026-09-02 用户确认 ARM 包可用，并要求正式 Release 自动分类。Release 中必须保留稳定的 `linux-arm64` / `linux-x64` 文件名，为 12 项资产分别添加 `ARM64 / Kylin V10` 或 `x86_64` display label，同时在发行说明中按这两个架构分区。

## 版本与发布规则（2026-08-27 用户要求）

- 每次包含用户可见功能或修复的新发行都必须先更新版本号，并推送独立 GitHub Release；不得继续复用已经发布的版本号或用 `--clobber` 替换历史资产。
- 版本采用 SemVer，并按本次发行中最大的变化决定：向后兼容的修复/小改动升 PATCH，向后兼容的重要功能升 MINOR，不兼容的公开接口、数据或部署变化升 MAJOR；预发行使用标准 `-alpha` / `-beta` / `-rc` 后缀。本次按用户指定从 `0.1.6` 升到 `0.1.7`。
- `package.json`、`package-lock.json`、`src/version.ts` 与 `v<version>` tag 必须一致。Release 只允许由该 tag 触发；tag 或 GitHub Release 已存在时流程必须失败并要求再次升版，历史 tag、Release 和资产均保持不可变。
- 新版本提交先推送 `main` 并通过 CI，再创建和推送 annotated `v<version>` tag；tag 工作流必须再次执行检查、打包、发布完整资产及 SHA-256，发布后从 GitHub 重新下载校验。
- 2026-08-27 继续处理桌面启动失败：必须兼容本机 systemd 245，生成的 `WorkingDirectory=` 不得因整值引号而被判定为非绝对路径；修复后须以真实用户服务验证 `enabled`、`active`、Daemon `ready`。远端 `v0.1.7`、`v0.1.8` tag 已存在且其 Release 均失败，按不可变规则改发 PATCH `0.1.9`，不得移动或覆盖已有 tag。
- Release workflow 必须直接核对 origin 上同时存在 annotated tag object 与 `^{}` peeled commit，并验证 peeled commit 等于 `GITHUB_SHA`；不能信任 `actions/checkout` 写入本地的 tag ref，因为该 action 会在 tag event 中用 peeled commit 覆盖同名本地 ref。

## 设计验收标准

- 详细设计覆盖系统边界、模块、接口、状态机、数据、权限、异常、恢复、验证和路线图。
- 原始 11 条思路均有明确落点或工程修正，不能只做概念扩写。
- TUI/Electron 的“同底层”和用户/agent 双工有协议级定义。
- cron、BOOT 与外部副作用的去重/故障语义明确。
- subagent 有预算、权限继承、取消、文件并发和消息路由定义。
- token/KV cache 有稳定前缀、动态上下文与真实指标策略。
- Electron 后置阶段视觉测试主基准为 `1920 × 1080`；核心 v1 使用固定 `160 × 45` TUI snapshot，未要求时不扩展设备矩阵。
- Electron renderer 必须保持 `contextIsolation + sandbox`、关闭 Node integration，只暴露固定 allowlisted API；外部导航、新窗口、下载、远程 script 和任意 channel/path IPC 均不得开放。
- Electron 验收必须覆盖与 TUI 同时连接同一 Daemon、断线重连、streaming delta、长消息/代码 overflow、transcript scroll、工具输出折叠、固定 composer、审批 modal 与焦点。
- 桌面 smoke 还必须覆盖 owned/external Daemon 两种启动路径、深色/浅色截图和计算后字号下限；本轮不扩展移动端矩阵。
- 响应式桌面验收在 `1920×1080` 主基准通过后，补测 `1440×900` 与 `1180×720`；三档均不得产生 document overflow，composer 必须完整可见，窄窗口检查器以受控抽屉呈现。
- 设置弹层必须留在 viewport 内、锁定背景焦点、API Key 与 Cookie input 保持 password，read API 只返回 `hasApiKey` / `hasCookie` 状态。
- 桌面 smoke 必须断言 `app-shell` 高度等于 viewport、主工作区底部无多余留白，并覆盖权限下拉的四个模式与 bypass 风险告警的显示/隐藏。
- TUI 主基准 `160×45` 必须保持简洁双栏、完整输入和可访问命令；补测 `96×30` 单栏，不要求手机端。完整命令经 `/help` 展示，不用常驻高密度底栏。
- TUI 在真实模型运行中必须显示可变思考/输出/工具状态，工具完成后在同一步上显示成功或失败、简要结果和耗时；`/work [STEP_ID]` 可回看历史与经脱敏/限长的技术详情。
- npm tarball 只能包含运行需要的 README、`dist` 与 package metadata；全新 prefix 安装后 bin 必须可执行，并能从仓库外启动 TUI、自动管理 Daemon。
- 全局安装后必须存在与包名一致的 `p-spore` 命令；`pspore` 作为等价短命令保留，两者指向同一入口。
- npm 展示页（根 `README.md`）必须为英文，且面向 p-spore CLI 自身功能与用法，不放项目记忆、开发流程或阶段进度；中文项目文档放在 `docs/project-overview.md`。
- p-spore CLI（含 TUI）的用户可见文案必须为英文。
- 首次启动 TUI 且 `config.model` 为空时，必须主动推荐进入模型配置 wizard 并由用户 y/n 确认；不得强制进入，拒绝后仍可正常使用其余功能。
- 裸跑 `p-spore` 且未配置模型时，必须直接给出配置引导入口并在 TTY 下 y/n 询问；引导必须是 CLI 原生命令（`setup`），不能只存在于 TUI 内，且必须出现在 `--help` 列表中。
- memory-bank 完整同步。
- GitHub 仓库必须是同名私有仓库；提交前检查敏感信息与范围。
- 推送 `main` 后 CI 必须检查源码、测试和 `dist` 一致性；推送匹配 `package.json` 的新 `v*` tag 后，Release workflow 必须在原生 x64/ARM64 环境分别构建 CLI、全量 zip、overlay zip 与三份 SHA-256，只有两侧都通过才创建新的 `v<version>` GitHub Release，已有 Release 时必须拒绝覆盖。
- 本地打包验收：`release-dist/` 下必须同时存在全量 zip、overlay zip、三份对应 sha256 文件与可执行的 `pspore-<version>-linux-x64`；二进制能通过 `version` 与 `--help` 自检，且 `git status` 不得出现任何打包产物。

## GUI 交互与视觉（2026-08-22 用户要求）

- composer 默认 Enter 发送；Ctrl/Cmd+Enter、Shift+Enter、Alt+Enter 为换行；中文输入法合成态（`isComposing`）回车不触发发送。
- 2026-09-04：GUI composer 必须支持拖入一个或多个文件/目录，并只增加可移除的路径引用；drop 不自动发送、不读取/复制/上传内容、不递归展开目录，保留已有草稿。重复路径去重并限制数量；发送时仅附加带引号的绝对 `@"/path"`，发送失败须保留引用供重试。
- 默认主题为浅色（白天模式）白蓝配色（cobalt paper）；深色模式保持精致克制，无廉价感/广告感（无渐变光晕、单一强调色、发丝级边框）。
- 动效使用 GSAP：入场编排、消息/弹层过渡、状态微交互；必须尊重 `prefers-reduced-motion`，引擎缺失时直接降级为无动画可用。
- GSAP 以本地 vendored UMD 文件分发，不引入 bundler、不加载远程脚本；renderer 安全测试只放行 `./vendor/gsap.min.js` 与 `./renderer.js`。

## 后台服务、会话与长历史优化（2026-08-26 用户要求）

- 自动注册用户级系统服务并启用开机自启；完整功能常驻服务独立于 GUI/TUI 生命周期，GUI/TUI 只作为可重连壳层。
- 用系统服务替代由 GUI/TUI 临时托管、退出即停止且容易失联的 daemon；异常退出必须由服务管理器自动拉起。
- 支持多个根 session、新建 session、跨客户端选择，以及服务每次启动时恢复历史 session 和历史消息。
- 新建根 session 返回前必须把 Pi JSONL 物化为私有 `0600` 文件；兼容 catalog 中父目录仍安全存在但 JSONL 叶文件缺失的旧状态，启动恢复时自动重建有效 Pi session header。越界路径、非 JSONL、父目录缺失或 symlink 逃逸仍须拒绝。
- 普通发送不再展示 prompt/steer/follow-up 三模式：会话空闲时开始新 turn，仍在执行时自动进入 follow-up 队列。
- 每条 follow-up 排队消息必须使用用户语言展示“继续排队/直接发送消息”；底层 `steer` 术语不直接暴露，使用户可把该消息提前送入当前任务。
- 提升为“直接发送消息”的队列项必须在当前 tool 尚未完成时立即继续显示，不能等 tool result 后才以正文消息出现；可提示等待当前工具步骤，但不得向用户暴露底层 `steer` 术语。
- 自动 compact 的 token 长度必须能在共享设置中调整，并由 GUI/TUI/CLI 使用同一持久配置。
- 优化 Markdown 流式输出；正文不得再显示适配器生成的 `[tool:shell]` 等占位字符，并改善 Unicode/emoji 字体回退。
- reasoning/thinking 必须使用独立的临时流式通道，与 assistant 正文分区展示；正文 `message.completed` 或 run 结束后自动隐藏，不得混入最终 Markdown、持久化历史或工具输出。GUI 使用中文“思考中”区块，TUI 使用独立 `thought` gutter。
- 修复 Linux 桌面快捷方式：应用菜单与桌面入口必须能稳定启动，并提供可诊断的 launcher 日志。
- GUI session 历史使用真实窗口化虚拟渲染；TUI 只格式化当前可见历史窗口，避免长历史全量重建。
- GUI 聊天历史首次进入或切换 session 时默认滚动到底部；用户向上滚动后必须保持浏览位置，无新消息时不得自行回底，收到 streaming delta/新回复时也不得抢走位置；只有用户重新滚动到最底部后才恢复后续消息自动跟随。
- 本轮默认客户端仍为 PC；Electron 视觉主基准保持 `1920×1080`，TUI 保持 `160×45`。
