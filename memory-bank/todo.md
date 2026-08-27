# Todo

| 优先级 | 待办任务 | 状态 | 阻塞项 | 下一步建议 |
|---|---|---|---|---|
| P0 | 将实现环境 Node.js 升级到 Pi 支持范围 | Done | 无；当前本机为 Node.js `v24.19.0` | 通过 `engines` 固定 Node.js 24 基线 |
| P0 | 建立 Node.js/TypeScript 工程并锁定 Pi 版本 | Done | 无 | 已生成精确 npm lockfile与 ADR 0001 |
| P0 | 验证 Pi adapter contract | Done | 无 | 已覆盖 create/resume/new/fork/rebind/steer/followUp/abort/compact/tool gate/cache usage |
| P0 | 验证 Linux login shell、PTY 与 sudo secret channel | Done | 未执行真实 sudo（避免无必要提权） | 已验证 login shell、pipe/PTY、timeout、output cap、artifact 与 secret 跨 chunk 脱敏 |
| P1 | 实现 Kernel、storage、policy、UDS 和 TUI 纵向切片 | Done | 无 | 已有真实 Daemon/CLI、单 session fake runtime 集成与 160×45 TUI snapshot |
| P1 | 实现 pinned memory、exact/BM25 search 与 artifact truncation | Done | 无 | 已覆盖 token/path/hash、memory append/curate、source ref、exclude 与增量 rebuild |
| P2 | 选择 cron parser 依赖 | Done | 无；用户已确认 | 已锁定无额外 runtime dependency 的 `croner@10.0.1`，Phase 2 验证 timezone/DST |
| P2 | 实现 BM25 与中英 tokenizer | Done | 无 | 默认 lexical provider 已接入 Daemon search tool |
| P2 | 实现 cron、BOOT、run ledger 与恢复 | Done | 无 | 已覆盖 slot 去重、DST、misfire、并发、timeout、unknown/queued 恢复和非阻塞 BOOT |
| P2 | 实现 schedule 原子 mutation 与 run delivery/notification | Done | 无 | 已实现 expected-hash atomic put、runtime reload、notify tool、run delivery 与 durable protocol state |
| P3 | 选择 MCP SDK 与版本 | Done | 无；用户已确认 | 已锁定官方 `@modelcontextprotocol/sdk@1.30.0`，只通过 adapter port 使用 |
| P3 | 实现 subagent tree/mailbox/budget/cancel 双工 | Done | 无 | 已用 fake model + Daemon/UDS 覆盖两 child 并发、steering、result、ceiling 与 cascade cancel |
| P3 | 实现 MCP lazy adapter | Done | 无 | 已用官方 SDK fake stdio server 与真实 UDS/CLI 验证 discover/activation/policy/abort/health/idle reconnect/backoff |
| P3 | 实现 plugin trust/staging 与 skills reload | Done | 无 | 已覆盖 exact digest、symlink/tamper、capability grant、restart lifecycle 与 Pi progressive disclosure |
| P0 | 发布 `p-spore@0.1.1` 修复全局安装后 `p-spore` 命令不存在 | Done | 无 | 已发布且 `latest=0.1.1`；全新 cache/prefix registry 安装、两个 bin、daemon 启停均已验证 |
| P2 | TUI 顶栏未开会话时恒显示 `model not configured` | Done | 无 | TUI 启动时通过共享 settings service 读取已保存 model，顶栏在 session snapshot 缺失时回退到该值 |
| P3 | 桌面端首次启动同样推荐模型配置 | Pending | 本次只做 TUI | 可复用 `LlmSettingsService.isModelConfigured()` |
| P3 | daemon 在 UDS 路径超长时给出可理解的错误 | Pending | 无 | 现在只报 `listen EINVAL: invalid argument`；应在 `listen` 前检查 socket 路径长度（sun_path 上限 108 字节）并提示改用更短的 `PSPORE_HOME` |
| P3 | GUI 内共享 cowork 活动文案为英文 | Pending | TUI/CLI 必须英文，两端共用 `src/ui/shared/activity.ts` | 2026-08-17 起 GUI 其余文案已统一中文；若要彻底消除混排，需要给 activity label/summary 加平台级 i18n 映射，而不是改共享层 |
| P2 | `dist/` 已纳入 Git，需防止与源码不同步 | Done | 无 | `ci.yml` 在 PR/`main` 上执行 `npm run check` 后 `git diff --exit-code -- dist` |
| P3 | transcript 每次渲染整树重建 | Done | 无 | GUI 使用变高虚拟列表 + 有界 DOM 缓存；TUI 从尾部只格式化当前行窗，10000 条单测与 1007 条 Electron fixture 已验证 |
| P3 | 为桌面 zip 补齐产品图标与 WM_CLASS/desktopName | Pending | 不影响当前启动与功能 | 增加受控图标资产，并在 electron-builder 配置中设置 `desktopName` / `linux.syncDesktopName` |
| P5 | sandbox/vector/remote/mobile | Deferred | 不属于 v1 范围 | 只有明确需求和基准证据时重评 |
| P4 | Electron 43 桌面客户端 | Done | 无 | 已完成安全 main/preload/renderer、AppImage 自启/复用 Daemon、响应式双主题、LLM 设置与 1920×1080/1440×900/1180×720 验收；未实现 Tauri/mobile |
| P4 | GUI/TUI/CLI 共享客户端内核与 TUI 完善 | Done | 无 | `p-spore@0.1.0` 已发布；全新 cache/prefix registry 安装、远端 integrity 与 `pspore` CLI 均已验证 |
| P2 | GitHub CI 自动构建 GUI zip 并上传 Release | Done | 无 | `main` 只跑 CI；匹配 package 的新 `v*` tag 构建 CLI、全量/overlay zip 并创建不可变 Release，拒绝覆盖历史版本 |
| P0 | 发布并远端复验 `v0.1.9` | Done | 无；Release workflow 与六项远端资产均已验证 | 远端三份 SHA-256 校验通过，CLI/包内应用为 `0.1.9`，Electron `43.3.0/x64` |
| P0 | 发布并远端复验聊天滚动修复 `v0.1.10` | Done | 无；本地/CI/Release/远端资产均已验证 | Release 为不可变 annotated tag `v0.1.10`，后续版本继续按 SemVer 新增 |
| P0 | 生产后端由 systemd 用户服务托管 | Done | 无 | CLI/TUI/GUI 自动确保 unit 已安装并 `enable --now`，客户端退出不再停止服务；隔离 systemd 集成测试及 external/owned Electron smoke 已通过 |
| P0 | 跨 session 创建、恢复与历史加载 | Done | 无 | 私有 catalog 映射 Pi JSONL；服务 ready 前恢复全部根会话，GUI/TUI/CLI 均可创建和切换 |
| P1 | 统一发送与排队消息直接发送 | Done | 无 | 普通发送由 Application 自动 prompt/follow-up；每条队列项只显示“继续排队/直接发送消息”，内部 steer 术语不暴露 |
| P1 | 可配置自动 compact 长度 | Done | 无 | 共享配置支持 enabled/reserve/keepRecent，GUI/TUI/CLI 可调；Daemon 注入每个 Pi session，旧 v1 config 自动补默认值 |
| P1 | 流式 Markdown 与长历史虚拟渲染 | Done | 无 | 去除 `[tool:*]`/thinking 占位、GUI 按帧刷新和字体回退；GUI/TUI 均只渲染可见历史窗口 |
| P1 | 修复 zip 桌面快捷方式 | Done | 无 | 稳定 XDG launcher、启动日志与应用菜单/桌面入口已通过隔离 `desktop-file-validate` + `gtk-launch` 验收 |
| P1 | 验证无 Chromium overlay 从上一版升级 | Done | 无；`0.1.5` 与 `0.1.6` 均为 Electron `43.3.0/x64` | 真实 GitHub `v0.1.5` 全量包已升级到 `0.1.6` 并通过发行目录 Electron smoke；运行时不匹配时 updater 会在替换前拒绝 |

| P3 | Markdown 链接在 GUI 中不可点击跳转 | Pending | 主进程按安全基线禁止外部导航与新窗口 | 若要支持，需要显式引入受控的 `shell.openExternal` 白名单（仅 http/https）并重新评估安全边界 |
| P3 | Markdown 代码块无语法高亮 | Pending | 无 | 当前只显示语言标签；如需高亮需引入自实现 tokenizer 或新依赖（须先征求用户确认） |

## 已知风险

- Pi 上游 API 演进较快，必须依赖 contract tests 与 adapter 隔离。
- `ask_risky` 不能完备识别任意 Shell 的真实副作用。
- 同用户运行、Pi extension、host plugin 和 MCP server 均不构成安全沙箱。
- 外部副作用在崩溃边界不能普遍保证 exactly-once。
- 当前 UDS replay 与 command cache 仅在进程内；重启靠 snapshot，durable event log/session mapping 尚未完成。
- `permissions.mode = allow_all`（bypass）会跳过全部批准；它只是策略放开，同用户进程内不构成沙箱，风险由用户承担。
- 当前模型未配置时 Daemon 可正常 ready，但 prompt 会返回 `model_not_configured`；`deepseek/deepseek-v4-flash` 已于 2026-08-11 使用临时 credential 完成真实 API 验证，不将付费调用纳入默认自动化。
- npm 包要求 Node 24；`desktop` 命令在纯 npm 安装中不会下载 Electron，而是提示使用 GitHub Release 中的桌面 zip。
- `p-spore@0.1.0` 只安装 `pspore` 命令；已由 `0.1.1` 修复，仍停留在 `0.1.0` 的用户需要升级才能使用 `p-spore` 命令。
- 非 TTY 环境下 `npm publish` 会直接以 `EOTP` 失败并把 2FA URL 打码；后续发布需在真实终端或伪终端（`script`）中执行。
- 发布后 `npm view` 可能仍显示旧版本（本地/CDN 缓存延迟）；用 `curl -s https://registry.npmjs.org/p-spore` 直连确认，不要据此判断发布失败。
- npm web 2FA 认证链接有效期很短；发布前先跑完 `npm run check`，再用 `--ignore-scripts` 发布，让链接立即出现并尽快点击，否则会以 `E404 /-/v1/done` 失败（失败不会产生半发布版本）。

| P3 | MCP 集成测试偶发 UDS 超时 | Pending | 全量并行跑 `npm test` 时 `mcp-manager` 两个用例曾出现 `MCP error -32001: Request timed out`；隔离运行与复跑均通过，疑似负载相关抖动 | 如需稳定化，可给测试内 discover 超时加裕量或降低用例并行度 |
| P2 | GUI GSAP 动效细节扩展（可选） | Pending | 已完成入场/消息/弹层/微交互基础编排 | 后续可按需增加主题切换过渡、抽屉动画；须继续遵守 reduced-motion 与 transform/opacity-only 约束 |
