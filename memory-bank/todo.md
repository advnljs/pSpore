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
| P2 | GitHub CI 自动构建双架构 GUI zip 并分类上传 Release | Done | 无；`v0.1.12` 全链与 12 项远端资产已验证 | 后续新 `v*` tag 继续等待原生 x64/ARM64 producer，校验两侧 CLI/全量/overlay 与 SHA-256 后创建不可变 Release；资产按 `ARM64 / Kylin V10`、`x86_64` 标签及说明章节分类；`main` 不创建 Release |
| P0 | 发布并远端复验 GUI 拖拽路径引用 `v0.1.13` | Done | 无；`main` CI、ARM64 preview、Release 四段工作流与 12 项远端资产均已验证 | 后续用户可从不可变 `v0.1.13` Release 按架构下载全量包或 overlay；历史资产不得覆盖 |
| P0 | 发布并远端复验长会话 frame/直接 compact 阈值修复 `v0.1.14` | In Progress | 本地实现已完成，尚待完整检查、PC smoke、双架构 CI/Release 与远端资产复验 | 生成最新 x64 候选并通过本地验收后推送 `main`；CI/ARM64 preview 成功后创建 annotated tag |
| P2 | 复核锁定依赖的 npm audit 告警 | Pending | `scripts/release.sh` 的默认 audit 报告 1 moderate/1 high；本轮未新增依赖，`npm audit --omit=dev` 在当前 registry 请求未及时返回 | 后续单独取得 production-only advisory/依赖路径，评估兼容修复；不得在无验证时直接 `npm audit fix` 或混入功能提交 |
| P0 | 发布并远端复验 `v0.1.9` | Done | 无；Release workflow 与六项远端资产均已验证 | 远端三份 SHA-256 校验通过，CLI/包内应用为 `0.1.9`，Electron `43.3.0/x64` |
| P0 | 发布并远端复验聊天滚动修复 `v0.1.10` | Done | 无；本地/CI/Release/远端资产均已验证 | Release 为不可变 annotated tag `v0.1.10`，后续版本继续按 SemVer 新增 |
| P0 | 发布并远端复验新会话 JSONL/直接发送展示修复 `v0.1.11` | Done | 无；本地/CI/Release/远端资产均已验证 | Release 为 annotated tag `v0.1.11`，远端三份 SHA-256、SEA/包内 CLI、Electron runtime 与 overlay manifest 均通过 |
| P1 | 在真实银河麒麟 V10 SP1 飞腾 FT-2000/4 上复验 ARM64 CI 全量包 | Pending | 当前只能在 ARM runner 的 glibc 2.31 容器模拟用户态，不能复现目标机 Linux 5.4 内核、GPU/桌面栈与 systemd 245 | CI 成功后下载 full zip 到目标机，核对 SHA-256，运行包内 version、创建快捷方式并实际启动 `1920×1080` GUI/用户服务 |
| P2 | 消除 GitHub Actions Node 20 action runtime 弃用告警 | Todo | Release/ARM workflow 已使用 Node 24 action 版本，`.github/workflows/ci.yml` 仍为 `actions/{checkout,setup-node}@v4` | 后续独立升级普通 CI workflow，不与发版修复混做 |
| P0 | 生产后端由 systemd 用户服务托管 | Done | 无 | CLI/TUI/GUI 自动确保 unit 已安装并 `enable --now`，客户端退出不再停止服务；隔离 systemd 集成测试及 external/owned Electron smoke 已通过 |
| P0 | 跨 session 创建、恢复与历史加载 | Done | 无 | 私有 catalog 映射 Pi JSONL；服务 ready 前恢复全部根会话，GUI/TUI/CLI 均可创建和切换 |
| P1 | 统一发送与排队消息直接发送 | Done | 无 | 普通发送由 Application 自动 prompt/follow-up；每条队列项只显示“继续排队/直接发送消息”，内部 steer 术语不暴露 |
| P1 | 可配置自动 compact 长度 | Done | 无 | 共享配置支持 enabled/direct trigger/reserve/keepRecent，GUI/TUI/CLI 可调；Daemon 注入每个 Pi session，旧 v1 config 缺字段时自动补默认值 |
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
| P2 | GUI GSAP 动效细节扩展（可选） | Done | 无 | 已增加重连呼吸、指标数字 tween、列表 stagger、tab 淡入、横幅滑动、状态 chip 翻转、chip 弹入与状态行交叉淡入；仍遵守 reduced-motion 与 transform/opacity-only |
| P0 | 补跑 Electron 实机 smoke 验收本轮 GUI 改动 | Done | 无 | 本机跑不了（缺 `xvfb-run` 与 `libnspr4`），但 ARM64 CI run `34080267184` 对 commit `4ccee4c` 执行了 `npm run test:electron` 并通过：`1920×1080`/`1440×900`/`1180×720` 三档布局、设置、字号、双主题、owned/external Daemon、reconnect 与 IPC allowlist 全部验证，其中包含本轮新增的 `reconnectMasked` 断言（短暂掉线先被遮蔽、超时后才显示）。GSAP 与设置面板新增路径行的静态视觉截图未单独人工复核 |
| P1 | 在真实安装目录实跑 overlay 整包升级 | Done | 无。用 `/tmp/pspore-electron-libs-*` 中先前解包的运行库（仅对测试进程生效，未改动系统）让目标安装的 Electron 可作 Node 运行 | 在有桌面环境的机器上：下载 `pspore-desktop-0.1.15-linux-x64-overlay.zip`，校验 sha256，解压后运行「图形界面升级.sh」并选择已有 0.1.14/0.1.15 安装目录；确认进度条从 5% 走到 100%、`payload/` 三个条目整体替换、`<install>/.pspore-backup-*` 生成、桌面快捷方式指向该目录、匹配的 systemd 用户服务被重启。当前该逻辑由 `test/integration/release-scripts.test.ts` 的 5 项隔离 fixture 用例覆盖 |
| P1 | 观察 CI `release` job 首次真实运行 | Done | 无 | 两条路径均已在生产验证：版本变更时 CI run `34084272469` 自动创建 `v0.1.15` 并派发 Release run `34084496369`（成功，12 项资产）；版本未变更时 CI run `34084898498` 的 job 正确输出 “Tag v0.1.15 already exists; nothing to release for this commit.” 并跳过。`gh workflow run` 用 `GITHUB_TOKEN` 派发未被仓库设置拒绝 |
| P0 | 把 aegis-search 二进制接入 bundled skill | Done | 无 | `v0.2.1` 已发布，digest 已记录，fetch 脚本实测通过（校验 → 裁剪 → 安装 → 运行），`IndexService` 已驱动真实二进制跑通一次索引 |
| P0 | aegis-searcher 的 loongarch64 cross 构建失败挡住发版 | Done | master 上 `linux-loongarch64 (cross)` job 长期失败（x64/arm64 均成功），而 `Create GitHub Release` job `needs` 它，因此无法发出 release——而 pSpore 正是要按版本从该 release 下载 `aegis-search`。2026-03 的日志已过期（410），PR run 会产生新日志 | 用户决定只做 x86_64 与 ARM64。已把 loongarch job 标记 `continue-on-error` 并从 release 的 `needs` 中移除，下载 pattern 收窄为 `{x64,arm64}`。`v0.2.0` 已成功发布 2 项资产 |
| P1 | aegis-searcher C++ 改动的编译验证 | Done | 本机无 cmake/pkg-config 与 lucene++/Qt5 等开发包，只编译并单测了 `src/cli/paths.cpp`、`src/cli/json_out.cpp` | run 34091667516 暴露链接失败（lucene++ 需要 `boost_system` 在链接行上，pkg-config 不带、静态库也不传递），对齐 `src/app` 依赖列表后 run 34092351755 的 x64 与 arm64 均成功。PR #1 已 squash 合并到 master |
| P1 | 排序 boost 取值实机调优 | Done | 无 | 在 75 篇（含 60 篇共享查询字的干扰文档）语料上实测：「授信业务」仅 5 篇整串文档命中；「授信 业务」整串文档占据前五、0.05–0.077 对其余 0.008–0.012，约 5–7 倍。受控实验（等长等词频）下整串/拆字 130 倍、近距离/远距离 11.3 倍，确认三个 boost 均生效，**无需调整**。已用 `test/integration/aegis-search-ranking.test.ts` 锁定该行为（二进制缺失时自动跳过）|
| P2 | 索引目录的 GUI 设置项 | Done | 无 | 设置弹层新增「本机索引」区：启用开关、间隔、文件类型、目录列表（经主进程原生选择器添加、可逐条移除）。渲染器无文件系统权限，绝对路径只能由 `dialog.showOpenDialog` 提供 |
| P0 | 在 pSpore 仓库创建 `BUNDLED_BINARIES_TOKEN` secret | Pending | 需要用户创建对 advnljs/aegis-searcher 只读的 fine-grained PAT | 没有它时 CI 打出的包不含索引二进制，skill 运行时报 unavailable；workflow 已写好 `secrets.BUNDLED_BINARIES_TOKEN || github.token` 的回退 |
| P0 | 长任务掉线与重启后仍 lost connection | Done | 无 | 根因是每 token 复制整份会话 + 每 durable 事件搬运整份 transcript + 超限内容让桌面端永久拒帧 + systemd start limit 死锁。已用出站裁剪、快照节流、共享不可变 state、`reset-failed` 自愈修复；压测由 147.5 s/66 次断开降到 2.3 s/0 次断开，300000 字符消息场景由 5 秒 95 次重连变为立即连接 |
| P0 | 阶段 1／3：服务器级快照瘦身 | Done | 无 | `KernelState.sessions` 改为 `SessionView`（元数据 + 200 条有界尾窗 + `messageOffset`/`messageCount`），新增 `session.transcript` 分页命令。广播与 hello 体积不再随会话长度增长；压测 1042 ms / 0 次断开 / 堆 113 MiB |
| P0 | 阶段 2／3：item 级 transcript 事件 | Done | 无 | adapter 停止把 Pi 事件压扁成 `{role,text}`，保留 item id 与 status；广播 `transcript.item.{started,updated,finished}` + `transcript.delta{itemId,contentIndex,kind}`；客户端照 Pi 的 `applyTranscriptProgress`/`selectTranscript` 做 overlay 合并。已完成：三个 item 级事件取代四个 message 事件，`transcript.item.finished` 由客户端追加而非重发尾窗，250 ms 节流已撤销。单客户端字节数 10.2 → 5.9 MiB |
| P1 | 阶段 3／3：历史分页与完整历史 | Done | 无 | GUI 虚拟列表滚到顶时用 `session.transcript` 向前翻页（OpenClaw 的 cursor/reset 语义）。已完成：`AgentRuntimePort.snapshot()` 不再含 messages、新增 `transcript()` 读持久化分支、GUI 滚动回溯（绝对 key + 视口锚定）、TUI PageUp 回溯、共享 `applyTranscriptPage`。单条超长消息的"按需取全文"未做，见下一行 |
| P3 | 单条超长消息仍按 64 KiB 截断显示 | Done | 无 | `session.message` 按持久化 entry id 分片返回原文（单片 = `MAX_PUBLISHED_STRING_CHARS`，出站不会二次截断）；GUI 在被截断的消息下方给出「仅显示前 N / M 个字符 · 载入全文」，共享的 `readFullMessage()` 负责逐片拼接与错位拒绝。TUI 未做入口 |
| P0 | 发布并远端复验三阶段复审修复与按需取全文 `v0.1.18` | Done | 无 | CI `34142793645`、ARM64 preview `34142793667`、Release `34143092977` 全部成功；12 项资产已发布，x64 overlay 的 SHA-256、manifest 版本与包内 `PSPORE_VERSION`/新命令字符串均已远端核对 |
| P3 | TUI 没有"载入全文"入口 | Pending | 价值低：TUI 本身按终端宽度截行 | 若要做，可复用 `src/ui/shared/full-message.ts` 与 `session.message`，加一条 `/full N` 命令把原文送进 panel |
| P2 | 每个非瞬时事件都会渲染 200 条尾窗，非结算事件却会丢掉它 | Pending | 不是回归：代价与会话长度无关，只是常数级白做 | `AgentApplication.#onRuntimeEvent` 无条件调用 `#view()`，reducer 再对非结算事件 `withoutTranscript()`。可在 adapter 里按 branch entry id 缓存已渲染的 `RuntimeMessage`（entry 持久化后不可变），或让 kernel 只在事件真的改动 transcript 时刷新尾窗 |
| P3 | hello 的 8 MiB 预算在多个大会话间按插入顺序分配 | Pending | 单值预算是防止 hello 超过 64 MiB 逻辑消息上限 | 可改为按会话平分预算，或只给选中会话完整 transcript、其余给摘要 |
| P1 | 会话删除 | Done | 无 | `session.delete` 命令 + `SessionCatalog.remove()`；GUI 两步内联确认、TUI `/delete [ID]`、CLI `session delete ID`。删除会连同 Pi JSONL 一起清掉，unlink 前对 sessions root 重新解析路径 |
| P1 | 设置面板已启用的索引在右侧面板显示为未启用 | Done | 无 | 根因是 `IndexService` 把「关掉」「已启用但没选目录」「缺索引程序」都上报成 `disabled`。已拆出 `unconfigured` phase 并给 `IndexingStatus` 加 `enabled` 字段，面板同时展示配置开关与具体原因；保存回执也会说明索引不会运行 |
| P0 | `.docx` 等二进制内容让桌面端被永久锁死 | Done | 无 | `boundPublishedText` 把 NUL 替换成 `\uFFFD`；`read` 拒绝非 UTF-8 文件。已反向验证：撤掉修复后三条回归用例全部失败 |
| P2 | 新 GUI 连旧 daemon 时仍可能被旧快照锁死 | Pending | 实际风险低：overlay 升级同时替换 GUI 与 daemon，且桌面端会重启服务，版本错配只是瞬时的 | 若要彻底消除，可让客户端校验器对 NUL 做净化而不是拒帧；但校验器是渲染器与守护进程之间的信任边界，改成"修正数据"要单独权衡 |
| P2 | pSpore 没有文档正文抽取能力 | Pending | 用户真正想做的是"总结 .docx"，现在只会得到一句可执行的报错 | `aegis-search` 只给 `snippet`，没有导出单个文件全文的子命令。可考虑给它加一个 extract 子命令，或在 pSpore 侧加一个受限的文档转文本工具 |
| P1 | 通用文档正文抽取 | Done | 无 | `src/documents/` + `document` 工具 + `doc-extract` 内置 skill，覆盖 docx/xlsx/pptx、doc/xls/ppt、pdf、纯文本（含 GB18030）。打包后从 app.asar 内实测六种格式全通 |
| P1 | 发行包体积回收 | Done | 无 | `electron-builder.yml` 排除 source map、`@napi-rs/canvas`、非 Linux clipboard 原生库、pdfjs 无用部分与 gsap 副本；gsap 改为 devDependency。overlay 72.3 → 38.2 MB |
| P0 | 切到 aegis-search CLI 独立包（等上游 Release） | Pending | GitHub Actions 制品配额账面未重算，aegis-searcher v0.2.2 的构建成功但制品传不上去，Release 未创建 | 上游 `advnljs/aegis-searcher` 已提交并打好 `v0.2.2` tag，CLI 包实测 zip 7.6 MB（现用桌面包 32.2 MB）、lib 21 MB（现 51 MB）。配额恢复后重跑 `gh run rerun 34195399620 --failed -R advnljs/aegis-searcher`，拿到两个架构的 `aegis-search-cli-0.2.2-linux-{x64,arm64}-glibc227.zip` 后：① `binaries.json` 的 `version` 改 0.2.2、`assetTemplate` 改为 `aegis-search-cli-{version}-linux-{releaseArch}-glibc227.zip`、填新 sha256；② 应用 `fetch-bundled-binaries.sh` 的简化补丁（已验证，暂存于本次会话 scratchpad，内容是删掉"下载桌面包再 ldd 裁剪"那段，只留库解析兜底）。**两者必须同一次提交**：只改 fetch 会因为没有 prune 而把整个桌面 lib（含 Qt/ICU，78MB）装进 skill，反而变大 |
| P1 | 发布经过制品存储导致配额撑满 | Done | 无 | 真因是 GitHub Free 私有仓库 Actions 存储只有 500 MB，而清理后仍有 844 MB。已清空两仓库全部未过期制品，并把 release 改为直传草稿 Release、验证后 undraft，制品占用降为 0 |
| P2 | 云端 routine 的 GitHub 集成没有 Actions 写权限 | Pending | 2026-09-08 21:00 那次 routine 触发正常，但 `rerun_failed_jobs`/`rerun_workflow_run` 都返回 `403 Resource not accessible by integration` | 云端 agent 只能读 run/日志/release，不能触发重跑。若要让 routine 真能自愈发布，需在 claude.ai 的 GitHub 连接里补 Actions:write |
| P2 | GitHub Actions 制品存储配额会被 ARM64 预览件撑满 | Partly | release 路径已不再产生制品；仅剩 main 推送的 ARM64 预览件仍是 14 天保留 | 2026-09-08 配额满导致 aegis-searcher v0.2.2 的制品传不上去、Release 未创建。当时 pSpore 占 10.06 GB：中转件 `release-assets-*` 4.4 GB（1 天保留，是当天连发四版叠出来的，会自然消失），ARM64 预览件 5.6 GB（`package-arm64.yml:239` 的 14 天保留，从 09-02 累积）。已一次性清掉 9.98 GB，降到 0.4 GB。若要根治，把预览件保留期从 14 天缩到 3~5 天 |
| P2 | aegis-search 的 libicudata.so.60 单文件 26.9 MB | Done | 无 | 已在 advnljs/aegis-searcher v0.2.2 解决：ICU 是发行版 boost_regex 为 u32regex 带进来的，而 lucene++ 与 CLI 对这些符号的引用数都是 0。上游改为 CLI 单独成包并摘除该链接依赖，CLI 的 lib 从 51 MB 降到 21 MB、zip 从 32.2 MB 降到 7.6 MB。桌面包不变（Qt5Core 确实需要 ICU）|
| P3 | 没有发行包体积的回归护栏 | Pending | 目前靠人工发现 | 可在 `scripts/package-desktop.sh` 里对 overlay 大小加一个上限断言（例如超过 45 MB 就失败），避免下次依赖变更悄悄把包撑大 |
| P2 | 扫描件 PDF 没有文字层 | Pending | 需要 OCR，本轮不做 | 抽取结果为空时 skill 已要求如实说明是扫描件。若要支持，需引入 OCR 引擎与中文模型，体积和离线可用性都要单独评估 |
| P3 | 独立 SEA CLI 不支持 PDF | Pending | 影响面小：守护进程实际跑在 Electron 运行时下，npm 全局安装也能解析到 pdfjs | esbuild 静态分析不到动态 import，所以 pdfjs 未打进二进制（也因此没有体积回归）。若要支持，需在 SEA 里附带 pdfjs 及其 cmaps/standard_fonts 数据文件 |
| P3 | WPS 私有 `.wps`/`.et`/`.dps` 不支持 | Pending | 用户已明确"麻烦就先不支持" | 命中时报错并提示另存为 OOXML。注意 WPS 存的标准格式文件已经能读，因为识别走魔数而非扩展名 |
| P3 | 文档抽取只取文字，不还原表格结构 | Pending | 摘要类问题够用 | Excel 现在按制表符分隔行输出；若要支持"第几行第几列"这类精确定位，需要保留单元格坐标 |
| P3 | 删除会话没有撤销入口 | Pending | 破坏性操作已用两步确认兜住 | 若要做，可在删除前把 JSONL 移到 `state/sessions/.trash/<id>-<ts>.jsonl` 并加保留期清理，而不是直接 unlink |
| P3 | TUI 删除会话没有二次确认 | Pending | TUI 命令本身是显式输入，误触概率低于 GUI 点击 | 若要做，可让 `/delete` 先回显会话标题并要求 `/delete ID confirm` |
| P2 | TUI 连接稳定期的视觉复核 | Pending | 需要真实 TTY | 在 `160×45` 下人工制造短暂断连，确认状态行不再闪烁且真实掉线仍会显示 |
| P2 | `main` 推送的 ARM64 预览件仍传不上去 | Pending | GitHub 制品配额用量按 6~12 小时重算，删除后账面尚未恢复 | 现在 `continue-on-error: true`，失败不再拖垮 run（`v0.1.25` 正是靠这个才发得出去），但预览包暂时下载不到。保留期已从 14 天缩到 2 天；等账面刷新后确认 run `34321174622` 之后的预览件能正常产出 |
| P3 | 三个废弃 tag 与两个草稿 Release | Pending | 草稿对外不可见，不影响用户 | `v0.1.22` 空 tag；`v0.1.23`、`v0.1.24` 各带一个含 6 个 x64 资产的草稿 Release。删除远端 tag / 草稿属破坏性操作，等用户确认再清 |

