# pSpore

pSpore 是一个基于 [Pi](https://github.com/earendil-works/pi) 的 Linux 本地主动式 Agent。目标是在保留 Pi 极简 agent loop 的前提下，增加持久记忆、权限治理、计划任务、subagent、MCP，以及共享同一后端的 TUI/Electron UI。

## 当前状态

功能 v1 已完成。Phase 0—4 的 Node/Pi 契约、Kernel、私有存储、权限/审批、Shell、pinned memory、exact/BM25、cron/BOOT、durable run ledger、双工 subagent tree、按需 MCP、受信资源生命周期、UDS Daemon、CLI、可重连 TUI，以及安全 Electron 43 客户端均已落地。TUI 与 Electron 同时连接同一个权威 Daemon；桌面 renderer 不拥有 Node 或文件系统权限。

- 原始想法：[initial_design.txt](initial_design.txt)
- 主设计文档：[docs/detailed-design.md](docs/detailed-design.md)
- 项目记忆与导航：[memory-bank/nav.md](memory-bank/nav.md)

运行时基线为 Node.js 24，Pi 精确锁定 `v0.84.1`；最终桌面客户端使用 Electron 43，核心功能先通过 TUI 验证。版本决策见 [ADR 0001](docs/adr/0001-runtime-and-pi-baseline.md)。

## 核心边界

- Linux-first、local-first、单用户；默认不提供多租户或公网服务。
- 主进程与工具默认使用启动 pSpore 的登录用户权限，不构成沙箱。
- `allow_all` 会允许模型以当前用户身份执行任意工具操作；当用户拥有免密或已缓存的 `sudo` 权限时，影响可能扩大到 root。
- skills、Pi extensions、pSpore plugins 和本地 MCP server 都可能执行任意代码，只能在显式信任后加载。
- 默认记忆检索为精确搜索与 BM25；向量搜索保留为可插拔扩展，不属于首版范围。

## 当前可运行流程

要求 Node.js 24。发布包可直接安装并启动 TUI；`p-spore tui` 会初始化缺失的 home，并在没有现有实例时自动拥有/启动 Daemon，退出时只关闭自己拥有的实例。

```bash
npm install --global p-spore
p-spore tui
```

安装后同时提供 `p-spore` 和等价的短命令 `pspore`，两者指向同一入口，可以任选其一；帮助与提示信息会回显你实际使用的那个名字。也可以用 `npx p-spore --help` 临时运行。npm CLI 包不携带 Electron；桌面端请使用 GitHub Release 中的全量 zip（含 `创建桌面快捷方式.sh`），升级可使用不含 Chromium 的 overlay zip。源码开发使用 npm lockfile；在中国大陆网络环境中可按需使用 npm/Electron 镜像，但不会写入全局 npm 配置。

```bash
npm install
npm run check
npm run test:electron
npm run build

node dist/cli/main.js init
node dist/cli/main.js daemon
```

桌面客户端无需预先手动启动 Daemon；它会初始化缺失的 pSpore home，在没有现有实例时拥有并启动一个 Daemon，已有实例时安全复用。

另开终端后可运行：

```bash
node dist/cli/main.js status
node dist/cli/main.js doctor
node dist/cli/main.js tui
node dist/cli/main.js desktop
node dist/cli/main.js jobs
node dist/cli/main.js runs
node dist/cli/main.js notifications
node dist/cli/main.js agents
node dist/cli/main.js agent spawn "inspect the workspace API"
node dist/cli/main.js agent send <agent-id> "focus on error handling"
node dist/cli/main.js agent join <agent-id>
node dist/cli/main.js agent cancel <agent-id>
node dist/cli/main.js mcp list
node dist/cli/main.js mcp discover <server-id>
node dist/cli/main.js mcp tools
node dist/cli/main.js mcp ping <server-id>
node dist/cli/main.js resources
node dist/cli/main.js resource inspect <staging-path>
node dist/cli/main.js resource install <staging-path> <sha256>
node dist/cli/main.js resource disable <skill|host-plugin> <name> <sha256>
node dist/cli/main.js schedule put examples/jobs/heartbeat.json
node dist/cli/main.js run <job-id>
node dist/cli/main.js cancel <run-id>
```

Daemon 在没有模型配置时仍会 ready，便于检查健康状态；首次 prompt 会明确返回 `model_not_configured`。GUI、TUI 与 CLI 共享同一设置 decoder/service，只提供 `deepseek`、`openai`、`custom-openai`（界面显示“自定义 OpenAI”）三类 Provider。TUI 同时支持 `/config wizard` 引导配置和 `/config …` 命令配置；CLI 使用相同命令语义：

```bash
pspore config show
pspore config set deepseek deepseek-v4-flash off
pspore config set openai gpt-5.6-terra low
pspore config set custom-openai my-model https://gateway.example.com/v1 responses off
pspore config compact on 16384 20000 100000  # 上限预留 / 压缩后保留 / 直接触发 tokens
pspore config key                 # TTY 中隐藏输入，也可从 stdin 安全读取
pspore config cookie              # LLM 代理可选 Cookie 头，隐藏输入
pspore config clear-key
pspore config clear-cookie
```

`deepseek/deepseek-v4-flash` 已通过真实 API 端到端验证。设置可配置 provider、model、Base URL、OpenAI Chat/Responses 兼容类型、thinking、自动 compact 开关/直接触发 tokens/模型上限预留 tokens/压缩后保留 tokens、API Key 与代理 Cookie；直接阈值默认 `100000`，与模型上限预留保护中先到者触发。Key 和 Cookie 独立保存到 `~/.pspore/credentials/<provider>.api-key` 与 `<provider>.cookie`（`0600`），`models.json` 只保存对该私有文件的引用（Cookie 写入 `headers.Cookie`），不写入 `config.json`、会话或日志。旧版 v1 config 未包含 compact 或 `triggerTokens` 字段时会读取为安全默认值，无需手动迁移。也可继续通过 Daemon 进程环境变量或 Pi 私有 auth store 提供 credential。

用户可在 `workspace/jobs/<job-id>.json` 定义严格的五字段 cron job，也可用 `schedule put` 基于 source hash 原子创建/更新并即时重载；示例见 `examples/jobs/heartbeat.json`。CLI/TUI 可列出、手动触发或取消 run，并读取 durable notification。交互式根会话由私有 `session-catalog.json` 映射到 Pi JSONL；服务启动会恢复全部目录会话及历史，旧安装首次迁移最近的主会话。GUI 用 `＋` 新建，TUI 用 `/new [TITLE]` 与 `/select ID` 创建/切换。普通输入发送到当前根会话或 child；根会话运行中时服务端自动按 follow-up 排队，每项显示“继续排队/直接发送消息”（TUI `/send-now N`），不再要求选择三种发送模式。还可以用 `/agent-spawn`、`/agent`、`/agent-join` 和 `/agent-cancel` 操作 child tree。输入 `/help` 打开完整命令面板，`/back` 或 Esc 返回对话。MCP server 在 `config.json` 中使用 `envRefs/headerRefs` 引用环境变量，只有 `trusted-local` server 会被按需启动；`sandboxed` 配置在 v1 中 fail closed。发现后的动态 schema 从下一 session 起生效，当前 session 可使用通用 `mcp_call`。

生成或复制来的 skill/host plugin 必须先放在 `workspace/staging/`。`resource inspect` 只执行 schema、路径、依赖、语法和内容摘要检查，不 import 代码；`resource install` 必须回传刚才看到的精确 SHA-256，随后复制到不可变私有目录并写入 trust store。Skills 从下一 session 边界进入 Pi progressive disclosure，常驻上下文只有 name/description/path。Host plugin 使用 `pspore.plugin.json`，安装后还需在 `config.plugins` 固定相同 digest 与完整 capability grant，并重启 Daemon；disable 只撤销信任，不删除内容，也不会热卸载已运行代码。

源码仓库中的 Electron 可用会自动构建的 `npm run desktop`，或在已有最新构建后用 `node dist/cli/main.js desktop` 启动。解压 GitHub Release 全量 zip 后运行 `创建桌面快捷方式.sh` 即可从桌面启动；脚本安装稳定 XDG launcher，应用目录带空格或 `%` 时也不再直接进入 Desktop Entry，并把启动诊断写到 `~/.local/state/pspore/desktop-launcher.log`。生产 GUI/TUI 会自动安装、启用并连接 systemd user service，同时尽力启用 linger；完整 Kernel、session、定时任务和集成能力独立常驻，关闭任一客户端都不会停止服务。main process 独占 UDS 连接，preload 仅暴露 `bootstrap/dispatch/getSettings/saveSettings/getPathForFile/subscribe` 六个固定 API；其中 `getPathForFile` 只把用户通过操作系统拖入的 `File` 解析成路径，不接受任意字符串路径，也不读取文件系统。renderer 使用轻量原生 DOM、严格 CSP、`contextIsolation + sandbox`，并关闭 Node integration、外部导航、新窗口、下载和网络请求。GUI 聊天框可接收文件与目录拖拽并显示可移除引用；拖入只记录路径，不自动发送、不读/复制/上传内容，也不展开目录，真正发送时仅附加带引号的绝对 `@"/path"` 引用。GUI 以变高虚拟列表只保留视口附近消息，TUI 从历史尾部按可见行反向格式化；正文与 thinking 使用独立流式通道，thinking 只在生成期间单独显示并在回复完成后隐藏，不进入最终 Markdown 或历史。工具调用通过活动视图展示而不再把 `[tool:*]` 混入正文。后续升级运行 overlay 内的 `覆盖升级.sh`：它校验 Electron 精确版本、平台、架构与完整应用 payload，保留回滚备份并重启匹配的 systemd 服务，因此无需重复下载 Chromium；运行时不匹配时会拒绝并提示使用全量包。每次用户可见更新使用新的 SemVer tag 和不可变 GitHub Release，历史资产不再原地覆盖。

ARM64 包由 `Package Linux ARM64` GitHub Actions 工作流生成：它在原生 `ubuntu-24.04-arm` runner 上进入 Ubuntu 20.04 容器，以与银河麒麟 V10 SP1 相同的 `glibc 2.31` 执行依赖安装、完整测试、Electron `1920 × 1080` 主基准 smoke、Electron/SEA 架构自检和 SHA-256 校验。`main` 相关改动或手动运行时保留 14 天预览 artifact；正式 annotated `v<version>` tag 会复用同一 ARM 链，并在 x64 与 ARM64 两侧都成功后，把两种架构的 CLI、全量桌面 zip、overlay zip 及各自校验文件一次性发布到新的不可变 GitHub Release。Release 资产使用 `ARM64 / Kylin V10` 与 `x86_64` 显示标签自动分类，发行说明同步按架构分区。打包脚本只允许当前 Node 原生架构，手工 ARM 构建入口为 `bash scripts/package-desktop.sh <version> arm64`，必须在 ARM64 Node 24 环境运行。

`npm run test:electron` 需要 Linux `xvfb-run`，会构建最新代码、创建临时 pSpore home，并以 `1920 × 1080` 为主基准、补充 `1440 × 900` 与 `1180 × 720` PC 窗口，自动验证外部/桌面拥有两种 Daemon 路径、重连、IPC allowlist、renderer 权限隔离、深浅主题、设置弹层、计算后字号下限、响应式面板收纳、真实文件/目录拖拽仅形成路径引用且不提交消息、长内容 overflow、transcript scroll、streaming delta、固定 composer 与审批弹层/焦点；长历史 fixture 含 1007 条消息，并断言实际 DOM 少于 40 条。成功后清理临时数据。设置 `PSPORE_KEEP_SMOKE=1` 可保留深色、浅色、文件拖拽、设置、响应式与审批截图及 JSON 探针。

## v1 之后

默认不继续扩大到 sandbox executor、vector、remote transport、mobile 或插件市场；这些能力只有在明确提出需求并重新评估边界后进入后续版本。
