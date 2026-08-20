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
| `electron-builder.yml` | Linux x86_64 Electron unpacked dir 打包配置 |
| `.github/workflows/ci.yml` | PR/`main` 上的 typecheck、测试、build 与 `dist/` 同步检查 |
| `.github/workflows/release.yml` | `main` 或 `v*` tag 时构建 GUI 全量 zip 与 overlay zip 并直接上传到 GitHub Release |
| `src/pi/pi-runtime-adapter.ts` | 唯一 Pi SDK 边界与领域事件映射 |
| `src/shell/shell-service.ts` | Linux login shell、pipe/PTY、artifact 与 secret 脱敏 |
| `src/daemon/daemon.ts` | Daemon 组装、ready/draining/stopped 与资源清理 |
| `src/daemon/supervisor.ts` | GUI/TUI 共用 Daemon owned/external 生命周期管理 |
| `src/application/agent-application.ts` | UDS command use cases 与 per-session 串行化 |
| `src/kernel/` | 纯 reducer、权威 state 与串行 effect loop |
| `src/storage/` | home/config 初始化、atomic write、JSONL、PID+start lock |
| `src/policy/` | capability/risk、审批持久化、scope grant 与 Pi tool gate |
| `src/tools/core-tools.ts` | read/edit/search/shell 固定基础工具 |
| `src/memory/` | pinned loader、daily/curated memory、tokenizer、BM25 与增量 search cache |
| `src/automation/` | cron adapter、job parser、run ledger、scheduler 与 Daemon executor |
| `src/agents/` | subagent tree、独立 session、双工 mailbox、budget/permission ceiling 与 bundled tools |
| `src/mcp/` | MCP 严格配置对应的 lazy transport、schema 激活、结果 artifact、audit、health 与 bundled tools |
| `src/plugins/` | staged resource 检查、exact-digest trust/install、host plugin lifecycle 与 skill path catalog |
| `src/notifications/` | durable notification store、run delivery 与 notify tool |
| `src/protocol/` / `src/gateway/` | v1 envelope、严格 decoder、UDS client/server、幂等/replay |
| `src/settings/` | GUI/TUI/CLI 共用 LLM schema、三类 Provider、私有 Key 与持久化 service |
| `src/ui/shared/` | GUI/TUI 共用 protocol reducer、presentation/input routing 与 `CoworkActivity` 事件归一/脱敏 |
| `src/ui/tui/` | Pi TUI 客户端、wizard/命令配置、动态工作步骤、`/work`、160×45 双栏与 96×30 单栏 renderer |
| `src/desktop/renderer/styles.css` | 桌面 design token 与组件样式唯一来源（spore print 双主题、语义色、字号下限） |
| `src/desktop/` | Electron 43 main/preload/renderer、Daemon bridge、三 Provider 设置、响应式双主题、IPC validation、安全基线与 smoke fixture |
| `scripts/clean-dist.mjs` | 构建前只清理仓库内精确 `dist/`，避免已删除模块混入 npm 包 |
| `scripts/copy-desktop-assets.mjs` | 将 preload/HTML/CSS 静态资源复制到最新 `dist/` |
| `scripts/package-desktop.sh` | 使用 electron-builder 生成全量 zip 与不含 Chromium 的 overlay zip |
| `scripts/linux/create-desktop-shortcut.sh` | 全量 zip 内可点击的桌面快捷方式脚本 |
| `scripts/linux/apply-overlay-upgrade.sh` | overlay zip 内覆盖 `resources/app.asar` 的升级脚本 |
| `scripts/release.sh` | 本地发布辅助：CLI SEA 二进制 + 调用 `package-desktop.sh` 后上传 GitHub Release |
| `scripts/electron-smoke.mjs` | 外部/桌面拥有 Daemon + Xvfb + 1920×1080/1440×900/1180×720 Electron 双主题、设置与字号自动验收 |
| `src/cli/main.ts` | init/daemon/status/doctor/tui/desktop/prompt/version 入口 |
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
- 源码 CLI：`npm run dev -- <command>`；构建后 CLI：`node dist/cli/main.js <command>`。
- 初始化：`npm run dev -- init`。
- 前台 Daemon：`npm run dev -- daemon`；SIGINT/SIGTERM graceful shutdown。
- 状态/诊断：`npm run dev -- status`、`npm run dev -- doctor`。
- npm 安装：`npm install --global p-spore`；运行：`pspore tui` 或 `npx p-spore --help`。npm 包名为 `p-spore`，全局 CLI 命令为 `pspore`，包中不含 Electron。
- TUI：`npm run dev -- tui`（要求真实 TTY；自动拥有/复用 Daemon；主基准 `160×45`，响应式补测 `96×30`；`/work [STEP_ID]` 查看工作历史/脱敏详情）。
- 模型配置：TUI 使用 `/config wizard` 或 `/config ...`；CLI 使用 `config show|set|provider|model|endpoint|thinking|key|clear-key|cookie|clear-cookie`。
- Electron：`npm run desktop` 或构建后 `node dist/cli/main.js desktop`；自动初始化并拥有/复用 Daemon，主视觉基准 `1920×1080`，PC 响应式补测 `1440×900`、`1180×720`。
- Electron 自动验收：`npm run test:electron`（Linux `xvfb-run`；自动验证 owned/external Daemon、双主题、设置、三档 PC 布局、字号和安全边界；`PSPORE_KEEP_SMOKE=1` 保留证据）。
- GUI 桌面包：`npm run package:desktop` 生成 `release-dist/pspore-desktop-<version>-linux-x64.zip`（含创建桌面快捷方式脚本）与 `pspore-desktop-<version>-linux-x64-overlay.zip`（仅应用代码）。推送到 `main` 或匹配 `package.json` 的 `v*` tag 后，GitHub Actions 会构建同一产物并直接上传到 `v<version>` GitHub Release。
- 单 prompt：`npm run dev -- prompt "..."`。
- 自动化：`npm run dev -- jobs`、`runs`、`run <job-id>`、`cancel <run-id>`；job 事实源位于 `workspace/jobs/*.json`。
- Job 原子更新：`npm run dev -- schedule put examples/jobs/heartbeat.json`；通知：`npm run dev -- notifications`。
- Subagent：`npm run dev -- agents`；`agent spawn <objective>`、`agent send <id> <message>`、`agent join <id...>`、`agent cancel <id>`。
- MCP：`npm run dev -- mcp list`；`mcp discover <server-id>`、`mcp tools`、`mcp ping <server-id>`。配置位于 `config.json#mcpServers`，secret 仅通过 `envRefs/headerRefs` 引用。
- 资源：`npm run dev -- resources|skills|plugins`；`resource inspect <staging-path>`、`resource install <path> <sha256>`、`resource disable <kind> <name> <sha256>`。staging 位于 `workspace/staging/`，trust store 位于 `state/resource-trust.json`。
- Electron 工具链：`electron@43.3.0`；中国大陆环境可临时使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 下载二进制，不修改全局 npm 配置。`npm run build` 会同步 desktop 静态资源。

## 配置与运行数据

- 默认根目录：`~/.pspore/`
- 配置：`~/.pspore/config.json`
- LLM 扩展配置：`~/.pspore/state/pi/models.json`；GUI/TUI/CLI 保存的 Provider Key：`~/.pspore/credentials/<provider>.api-key`（`0600`）。
- workspace：`~/.pspore/workspace/`
- runtime socket/endpoint：`~/.pspore/run/`
- sessions/runs/approval grants/notifications/audit：`~/.pspore/state/`
- resource trust：`~/.pspore/state/resource-trust.json`；installed skill：`workspace/skills/.installed/<name>/<digest>/`；host plugin：`plugins/<name>/<digest>/`。
- lexical search cache：`~/.pspore/cache/search/index.json`（可删除、可重建）。
