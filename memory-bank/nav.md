# Project Navigation

## 当前重要文件

| 路径 | 用途 |
|---|---|
| `README.md` | npm 展示页：英文、面向 p-spore CLI 安装与用法 |
| `docs/project-overview.md` | 中文项目文档：当前状态、安全边界、开发流程与下一步（原 README） |
| `initial_design.txt` | 用户原始 11 条设计思路，不作为最终契约 |
| `docs/detailed-design.md` | 当前唯一完整详细设计与 v1 验收契约 |
| `docs/design/desktop-style-comparison.png` | 本轮三种桌面重设计方向的 imagegen 对比稿 |
| `docs/adr/0001-runtime-and-pi-baseline.md` | Node 24、Pi/Electron 锁定与 Phase 0 兼容决策 |
| `package.json` / `package-lock.json` | npm 工程、精确依赖、构建与验证命令 |
| `electron-builder.yml` | Linux Electron unpacked dir 通用打包配置；具体 `x64|arm64` 由原生架构脚本参数选择。`files` 里的排除规则是发行包体积的唯一控制点：source map、`@napi-rs/canvas`、非 Linux clipboard 原生库、pdfjs 无用部分、gsap 副本 |
| `.github/workflows/ci.yml` | PR/`main` 上的 typecheck、测试、build 与 `dist/` 同步检查；`main` 上额外的 `release` job 在 `package.json` 版本尚无 tag 时自动创建 annotated tag 并派发 Release workflow |
| `.github/workflows/release.yml` | 从 origin 验证 annotated `v*` tag，先建**草稿** Release，x64/ARM64 各自带标签直传资产（不经过 Actions 制品存储——额度只有 500 MB，曾被撑满后阻塞所有发布），publish job 从草稿下载校验 12 项资产的 SHA-256 与架构后 `--draft=false` 转正 |
| `.github/workflows/package-arm64.yml` | 可独立/复用的原生 ARM64 + Ubuntu 20.04/glibc 2.31 构建链；运行 PC smoke，向 `main` 上传预览 artifact 或向 Release 提供 ARM 资产 |
| `src/pi/pi-runtime-adapter.ts` | 唯一 Pi SDK 边界与领域事件映射 |
| `bundled-skills/` | 随发行版携带的 skills；启动时由守护进程链接进 `workspace/skills/<name>`，见 `src/plugins/bundled-skills.ts` |
| `src/plugins/bundled-skills.ts` | 发行版 skills 的读取、asar-unpacked 路径解析、workspace 链接与版本比对升级 |
| `src/plugins/workspace-skills.ts` | 用户自己放进 `workspace/skills/` 的 skill：按 Pi 规则发现、宽容解析 frontmatter/描述、同名遮蔽与未加载原因；结果供会话注入与 `skills.catalog` |
| `src/domain/indexing.ts` | 索引状态的纯类型与初始值；`KernelState` 经渲染器导入，因此这里必须不含任何 Node 内置模块 |
| `src/indexing/index-service.ts` | 守护进程持续调用 `aegis-search` CLI 做增量索引，解析 `--json` 进度并发布 `indexing.status` |
| `src/desktop/renderer/indexing-view.ts` | GUI 本机索引面板的纯展示逻辑（阶段文案、确定/不确定进度、已用时、上次结果），DOM 无关、可单测 |
| `src/settings/model-api.ts` | `ModelApi` 与 `MODEL_APIS` 的唯一定义，供 `config.json` 校验与设置面板共用 |
| `src/protocol/server-frame-codec.ts` | 协商式 server 大消息 gzip/base64 有界分片与严格重组；物理 frame 仍保持 1 MiB 上限 |
| `src/protocol/limits.ts` | 客户端/守护进程双侧出站上限、`boundPublishedValue` 裁剪、NUL→`\uFFFD` 净化与 `publishedTextTruncation` 截断标记解析（标记格式的唯一定义处）|
| `src/shell/shell-service.ts` | Linux login shell、pipe/PTY、artifact 与 secret 脱敏 |
| `src/daemon/daemon.ts` | Daemon 组装、ready/draining/stopped 与资源清理 |
| `src/daemon/supervisor.ts` | Electron smoke 隔离使用的临时 Daemon owned/external 生命周期管理 |
| `src/application/agent-application.ts` | UDS command use cases 与 per-session 串行化 |
| `src/kernel/` | 纯 reducer、权威 state 与串行 effect loop |
| `src/storage/` | home/config 初始化、atomic write、JSONL、PID+start lock |
| `src/service/` | systemd user service 安装/状态/重启、Node/SEA/Electron 启动规格与 legacy daemon 迁移 |
| `src/sessions/session-catalog.ts` | 持久根会话目录、legacy 最近会话迁移与 Pi JSONL 路径边界 |
| `src/policy/` | capability/risk、审批持久化、scope grant 与 Pi tool gate |
| `src/tools/core-tools.ts` | read/document/edit/search/shell 固定基础工具 |
| `src/documents/` | 文档正文抽取：按魔数分派到 OOXML(zip)/OLE 复合文档/PDF/纯文本，`extract.ts` 是唯一入口 |
| `src/articles/` | 长文文稿：版本文件、段落 diff、预览节流、txt/docx 转换。面板在 `src/desktop/renderer/article-panel.ts`，导出在 `src/desktop/article-export.ts` |
| `src/articles/writer.ts` / `writer-context.ts` | article write 普通文本流与参考上下文隔离；正文走私有进度，回执识别/单次重试，成功后保存版本 |
| `src/desktop/renderer/article-split.ts` | 文稿/对话分屏的唯一边界规则：最小宽度、比例让步、占比↔像素换算；无 DOM，`test/unit/desktop-article-split.test.ts` 覆盖 |
| `src/articles/edits.ts` | `find/replace` 的唯一实现：提交用的 `applyArticleEdits`（严格、抛错）与流式预览用的 `previewArticleEdits`（跳过未匹配、最后一处替换可能写到一半）。无 Node，可被渲染器导入 |
| `bundled-skills/article-canvas/` | 告诉模型长文用 `article` 工具，不要把正文贴进聊天 |
| `src/memory/` | pinned loader、daily/curated memory、tokenizer、BM25 与增量 search cache |
| `src/automation/` | cron adapter、job parser、run ledger、scheduler 与 Daemon executor |
| `src/agents/` | subagent tree、独立 session、双工 mailbox、budget/permission ceiling 与 bundled tools |
| `src/mcp/` | MCP 严格配置对应的 lazy transport、schema 激活、结果 artifact、audit、health 与 bundled tools |
| `src/plugins/` | staged resource 检查、exact-digest trust/install、host plugin lifecycle 与 skill path catalog |
| `src/notifications/` | durable notification store、run delivery 与 notify tool |
| `src/protocol/` / `src/gateway/` | v1 envelope、严格 decoder、UDS client/server、幂等/replay |
| `src/settings/` | GUI/TUI/CLI 共用 LLM schema、三类 Provider、私有 Key 与持久化 service |
| `src/sessions/session-file.ts` | Pi session JSONL canonical path、缺失叶兼容与 root/symlink 边界校验 |
| `src/ui/shared/` | GUI/TUI 共用 protocol reducer、presentation/input routing 与 `CoworkActivity` 事件归一/脱敏 |
| `test/unit/renderer-module-graph.test.ts` | 静态遍历渲染器 import 图，禁止其触达 Node 内置模块（沙箱渲染器加载不了，类型检查与 x64 CI 都发现不了）|
| `src/ui/shared/markdown.ts` | 共享纯 Markdown 解析器（CommonMark/GFM 子集），无 DOM 依赖、可单测 |
| `src/ui/shared/local-links.ts` | 从普通回复文字中提取本地绝对路径和 `file://` 链接；不扫描代码块 |
| `src/desktop/local-path.ts` | 主进程打开本地路径前的解码、存在性、类型和可执行文件检查 |
| `src/ui/shared/markdown-stream.ts` | 流式重解析后哪些块没变：块 key 与公共前缀。无 DOM，可单测；`markdown-view.ts` 的增量渲染面据此工作 |
| `src/desktop/renderer/dom-reconcile.ts` | `reconcileChildren`：只移动位置不对的节点，先删后排。transcript 与文稿面板共用；用 `replaceChildren` 会摘掉选区与动画 |
| `src/ui/shared/virtual-list.ts` | GUI 变高虚拟历史的 Fenwick 索引，以及“接近底部”尾随状态判定 |
| `src/ui/shared/full-message.ts` | 被出站上限截断的单条消息的分片重组（`readFullMessage`），DOM 无关、可单测 |
| `src/desktop/renderer/markdown-view.ts` | 把 Markdown 树渲染为 DOM（只用 `createElement`/`textContent`），代码块复制、本地路径点击与外部惰性链接 |
| `src/desktop/renderer/composer-file-references.ts` | GUI 拖入文件/目录的绝对路径校验、去重上限、展示名称与 path-only `@` 引用序列化 |
| `src/ui/tui/` | Pi TUI 客户端、wizard/命令配置、动态工作步骤、`/work`、160×45 双栏与 96×30 单栏 renderer |
| `src/desktop/renderer/styles.css` | 桌面 design token 与组件样式唯一来源（spore print 双主题、语义色、字号下限） |
| `src/desktop/` | Electron 43 main/preload/renderer、Daemon bridge、三 Provider 设置、响应式双主题、IPC validation、安全基线与 smoke fixture |
| `scripts/clean-dist.mjs` | 构建前只清理仓库内精确 `dist/`，避免已删除模块混入 npm 包 |
| `scripts/copy-desktop-assets.mjs` | 将 preload/HTML/CSS 静态资源复制到最新 `dist/` |
| `scripts/package-desktop.sh` | 按当前原生 `x64|arm64` 使用 electron-builder 生成全量/overlay zip，并调用 `build-cli-binary.sh` 生成同架构 CLI |
| `scripts/build-cli-binary.sh` | esbuild bundle + 当前原生 Node SEA 注入，产出 `release-dist/pspore-<version>-linux-<arch>` 并自检；拒绝跨架构复制 Node |
| `scripts/linux/create-desktop-shortcut.sh` | 全量 zip 内快捷方式安装器：生成稳定 XDG launcher、Desktop Entry 与私有启动日志 |
| `scripts/linux/apply-overlay-upgrade.sh` | overlay updater：校验 manifest/运行时/payload，在安装根目录整体替换 Chromium 之外的全部应用文件、输出 `[ NN%] …` 进度、保留回滚、重指向已有桌面快捷方式并重启匹配服务 |
| `scripts/linux/overlay-upgrade-gui.sh` | overlay 图形界面升级（打包为「图形界面升级.sh」）：zenity/kdialog 选目录 + 进度条，无对话框工具时回落终端 |
| `scripts/release.sh` | 本地不可变发布入口：验证新 SemVer、完整打包、创建 annotated tag 并 push；tag workflow 负责 Release |
| `scripts/electron-smoke.mjs` | 外部/桌面拥有 Daemon + Xvfb + 1920×1080/1440×900/1180×720 Electron 双主题、真实文件/目录拖拽、设置与字号自动验收；并预置一篇两版文稿验收文稿面板（入场、版本芯片、首屏定位、对照上一版、四个导出按钮） |
| `scripts/article-stream-smoke.mjs` | `npm run test:article-stream`：临时 home、本地 OpenAI SSE、真实 Daemon/Bridge/preload/renderer 的 1920×1080 文稿验证；20× CPU、250 ms 取稿、120 ms 参数分片、通知丢失/读取失败恢复、长文持续刷新与中止停止补取；另覆盖短 write 调用后无 tools 的正文文本流、修订/截断/中止、回执误存重试/拒绝和聊天隔离，`PSPORE_KEEP_SMOKE=1` 保留截图和 report.json；自动结束隔离进程 |
| `test/unit/article-writer.test.ts` | 写稿上下文过滤、选择/参考资料/图片保留，完成回执识别与短文/引用不误判 |
| `test/fixtures/article-api.ts` / `test/integration/article-stream.test.ts` | 无真实凭据的本地 OpenAI 流服务；按测试阶段暂停 SSE，断言正文到达前的打开回执、工具参数预览，以及 write 普通文本流的增量、无 tools、上下文、usage 与失败不存版本 |
| `src/cli/main.ts` | init/service/daemon/status/doctor/tui/desktop/sessions/session/prompt/version 入口 |
| `dist/` | 构建产物，2026-08-17 起按用户要求纳入 Git；改动源码后必须 `npm run build` 并与源码一起提交，否则仓库产物会与源码不一致 |
| `.gitignore` | 环境文件、私钥、`release-dist/` 与本地 pSpore 数据排除；`dist/` 已不再忽略 |
| `memory-bank/specs.md` | 用户约束与验收标准 |
| `memory-bank/architecture.md` | 架构摘要、边界、决策与历史 |
| `memory-bank/todo.md` | 尚未实施的阶段和风险 |
| `memory-bank/overall-progress.md` | 已实际完成的阶段成果与验证 |

## 模块说明

- `module-kernel-runtime.md`：Kernel、Pi adapter、状态与生命周期。
- `module-memory-search.md`：pinned memory、exact/BM25、写入与检索。
- `module-policy-shell.md`：权限、审批、Shell、PTY、sudo 与安全。
- `module-automation-agents.md`：trigger、BOOT、cron、subagent 与双工。
- `module-interface-protocol.md`：Gateway、协议、TUI/Electron 与重连。
- `module-desktop.md`：Electron main/preload/renderer、安全边界、视觉与 smoke harness。
- `module-settings.md`：GUI/TUI/CLI 共用 LLM Provider、验证、持久化和 secret 边界。
- `module-documents.md`：文档正文抽取（OOXML/OLE/PDF/纯文本）、`document` 工具与 doc-extract skill。
- `module-articles.md`：长文文稿面板、版本 diff、txt/md/docx/pdf 导出。与文档抽取不是同一个模块。
- `module-extensions-integrations.md`：skills、plugins、MCP 与信任边界。
- `module-storage-daemon.md`：home、原子存储、锁、Daemon 启停与 CLI。

## 实现入口

- CLI：`src/cli/main.ts`
- Kernel/Application/Daemon：`src/kernel/`、`src/application/`、`src/daemon/`
- Pi 边界：`src/pi/pi-runtime-adapter.ts`
- Protocol/Gateway：`src/protocol/`、`src/gateway/`
- TUI：`src/ui/tui/`
- 测试：`test/unit/`、`test/contract/`、`test/integration/`；Electron 实机 smoke 由 `scripts/electron-smoke.mjs` 驱动。

## 构建、运行与测试

- 安装：`npm install`
- 类型检查：`npm run typecheck`
- 测试：`npm test`
- 构建：`npm run build`
- 全量阶段检查：`npm run check`
- 发版：把 `package.json` 与 `src/version.ts` 的版本一起提升并推送 `main`，CI 的 `release` job 会在 `check` 通过、同 commit 的 ARM64 preview 成功后创建 annotated `v<version>` 并派发 `Release desktop`；版本未变更的提交不会发版。关闭方式是设置仓库变量 `AUTO_RELEASE=false`。需要先在本机完整打包验证时仍可用 `bash scripts/release.sh <version>`。
- 源码 CLI：`npm run dev -- <command>`；构建后 CLI：`node dist/cli/main.js <command>`。
- 初始化：`npm run dev -- init`。
- 系统服务：`npm run dev -- service install|status|restart|logs|stop|uninstall`；生产 GUI/TUI 会自动 `enable --now`，退出壳层不停止服务。unit 生成入口为 `src/service/system-service.ts`，可用 `systemd-analyze --user verify pspore.service` 验证兼容性。
- 前台服务进程：`npm run dev -- daemon`；仅用于 systemd/诊断，SIGINT/SIGTERM graceful shutdown。
- 状态/诊断：`npm run dev -- status`、`npm run dev -- doctor`。
- npm 安装：`npm install --global p-spore`；运行：`pspore tui` 或 `npx p-spore --help`。npm 包名为 `p-spore`，全局 CLI 命令为 `pspore`，包中不含 Electron。
- TUI：`npm run dev -- tui`（要求真实 TTY；自动安装/连接 systemd user service；主基准 `160×45`，响应式补测 `96×30`；`/work [STEP_ID]` 查看工作历史/脱敏详情）。
- 会话：GUI 左栏 `＋` 新建、会话行右侧 `✕`→`确认删除` 两步删除；TUI `/new [TITLE]`、`/select ID`、`/send-now N`、`/delete [ID]`；CLI `sessions`、`session new [TITLE]`、`session delete ID`、`prompt --session ID TEXT`。删除会同时移除 session-catalog 记录与 `state/sessions/` 下的 Pi JSONL。
- 模型配置：TUI 使用 `/config wizard` 或 `/config ...`；CLI 使用 `config show|set|provider|model|endpoint|thinking|permissions|compact|key|clear-key|cookie|clear-cookie`。
- 端到端测试模型：统一用 `deepseek` / `deepseek-v4-flash`，Key 在 `~/.pspore/credentials/deepseek.api-key`。临时 home 做真实会话测试时复制该 Key 并配同样的 provider/model；用假 provider 会被 Pi 以 `Configured model is unavailable` 拒绝。见 `specs.md`。
- 文档抽取：`document` 工具（`src/documents/extract.ts`）支持 docx/xlsx/pptx、doc/xls/ppt、pdf 与纯文本（UTF-8/UTF-16/GB18030）；格式按文件头字节判断，不看扩展名。PDF 依赖 `pdfjs-dist`，桌面版与 npm 安装可用，独立 SEA CLI 解析不到会明确报错降级（其余格式不受影响）。WPS 私有 `.wps`/`.et`/`.dps` 不支持，会提示另存为 OOXML。
- 本机索引：`pspore config indexing show|on|off|add DIR|remove DIR|interval MINUTES|ext a,b,c`，写入 `config.indexing`，需 `service restart` 生效；默认关闭且目录为空。`indexing.status.phase` 区分 `disabled`（未启用）/`unconfigured`（已启用但没选目录）/`unavailable`（缺索引程序），`status.enabled` 直接反映 `config.indexing.enabled`，GUI 右侧面板据此不再把已启用的索引显示成未启用。扫描阶段另有 `scanning`/`comparing`（CLI 在这两段不报计数），GUI 显示不确定进度条与已用时；`status.lastPass` 保留上次完成的结果，重扫期间与无变化的增量扫描后都能看出索引可用。
- 自动 compact：GUI 设置 → 自动压缩；TUI `/config compact on|off [RESERVE] [KEEP] [TRIGGER]`；CLI `config compact on|off [RESERVE] [KEEP] [TRIGGER]`。`TRIGGER` 是直接 active-context token 长度，默认 100000；保存于 `config.context.autoCompaction`，服务重启后应用。
- 授权模式：`config permissions ask_risky|ask_all|allow_all|deny`（`bypass` = `allow_all`）；TUI `/config permissions MODE`；GUI 设置弹层“权限”区。写入 `config.permissions.mode`，需要 Daemon 重启生效（owned Daemon 由 GUI 自动重启）。
- Electron：`npm run desktop` 或构建后 `node dist/cli/main.js desktop`；自动初始化并拥有/复用 Daemon，主视觉基准 `1920×1080`，PC 响应式补测 `1440×900`、`1180×720`。
- Electron 自动验收：`npm run test:electron`（Linux `xvfb-run`；自动验证 owned/external Daemon、双主题、设置、三档 PC 布局、字号和安全边界；`PSPORE_KEEP_SMOKE=1` 保留证据）。
- GUI 桌面包：`npm run package:desktop` 默认按当前 Node 原生架构生成全量 zip、overlay zip、本地 SEA CLI 及三份 SHA-256；x64 文件名保持 `linux-x64`，ARM 原生环境可用 `bash scripts/package-desktop.sh <version> arm64` 生成 `linux-arm64`。全部本地产物被 Git 忽略，overlay 只复用 Electron 精确版本及 Linux 架构一致的安装。正式新 annotated `v<version>` tag 并行构建 x64/ARM64 并在同一不可变 GitHub Release 发布 12 项资产，以 `ARM64 / Kylin V10`、`x86_64` 标签和 notes 章节分类；`Package Linux ARM64` 在 `main` 相关改动或手动触发时仍上传保留 14 天的预览 artifact。
- 单 prompt：`npm run dev -- prompt "..."`。
- 自动化：`npm run dev -- jobs`、`runs`、`run <job-id>`、`cancel <run-id>`；job 事实源位于 `workspace/jobs/*.json`。
- Job 原子更新：`npm run dev -- schedule put examples/jobs/heartbeat.json`；通知：`npm run dev -- notifications`。
- Subagent：`npm run dev -- agents`；`agent spawn <objective>`、`agent send <id> <message>`、`agent join <id...>`、`agent cancel <id>`。
- MCP：`npm run dev -- mcp list`；`mcp discover <server-id>`、`mcp tools`、`mcp ping <server-id>`。配置位于 `config.json#mcpServers`，secret 仅通过 `envRefs/headerRefs` 引用。
- Skills 目录：`npm run dev -- skills`（= `skills.catalog`，列出 installed/bundled/workspace 三类 skill 的状态与未加载原因）；TUI `/skills`；GUI 集成页「Skills · N」与「未加载 skill」条目。用户自己的 skill 放 `~/.pspore/workspace/skills/<name>/SKILL.md`，新会话生效。
- 资源：`npm run dev -- resources|plugins`；`resource inspect <staging-path>`、`resource install <path> <sha256>`、`resource disable <kind> <name> <sha256>`。staging 位于 `workspace/staging/`，trust store 位于 `state/resource-trust.json`。
- Electron 工具链：`electron@43.3.0`；中国大陆环境可临时使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 下载二进制，不修改全局 npm 配置。`npm run build` 会同步 desktop 静态资源。

## 配置与运行数据

- 默认根目录：`~/.pspore/`
- 配置：`~/.pspore/config.json`（设置面板全部配置项的权威来源，含 `model.baseUrl`/`api`/`customModel`/`apiKeyFile`/`cookieFile`；缺失键在启动时按默认值增量补齐，已有值不变）
- Pi 派生模型目录：`~/.pspore/state/pi/models.json`（由 `config.json` 生成，不再作为配置事实源）；GUI/TUI/CLI 保存的 Provider Key：`~/.pspore/credentials/<provider>.api-key`（`0600`），Cookie：`~/.pspore/credentials/<provider>.cookie`。GUI 设置面板、CLI `config show` 与 TUI `/config` 都会显示这些绝对路径。
- workspace：`~/.pspore/workspace/`
- runtime socket/endpoint：`~/.pspore/run/`
- 根 session mapping：`~/.pspore/state/session-catalog.json`；Pi JSONL：`~/.pspore/state/sessions/`；runs/approval grants/notifications/audit：`~/.pspore/state/`
- resource trust：`~/.pspore/state/resource-trust.json`；installed skill：`workspace/skills/.installed/<name>/<digest>/`；host plugin：`plugins/<name>/<digest>/`。
- lexical search cache：`~/.pspore/cache/search/index.json`（可删除、可重建）。
