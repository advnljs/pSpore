# Overall Progress

## 2026-09-14 — 用户本地 skills 进入会话（`0.1.26`）

- 阶段目标：用户问"查看你的skills"时 agent 只列出内置的 `aegis-search`、`doc-extract`，看不到用户早已放进 `~/.pspore/workspace/skills/ccb-mail/` 的邮件技能套件，只能靠 shell 翻目录"发现"。修好并发布新版。
- 根因（两层）：
  1. `ExtensionManager.skillPaths()` 只返回 staging 信任安装的 skill 与 bundled 链接，而 adapter 以 `noSkills: true` 关闭了 Pi 自带目录发现——用户直接放进 `workspace/skills/` 的目录**从未**交给 Pi。
  2. 即使交给 Pi，Pi 的加载器遇到 frontmatter 不是合法 YAML（中文描述里未加引号的 `: `，实测 `description: 发送邮件: 支持附件` 即触发）或缺 `description` 时会**静默丢弃**，只留一条无人看到的 diagnostic。
- 完成内容：
  - 新增 `src/plugins/workspace-skills.ts`：按 Pi 的发现规则扫描（含 `SKILL.md` 的目录即 skill；否则向下最多 3 层；根目录 `.md` 需 frontmatter 带 description；跳过点目录、`node_modules`、bundled 链接与带 `.pspore-bundled.json` 的旧副本；realpath 防环；128 个 / 256 KiB 上限）。frontmatter 先用 Pi 导出的 `parseFrontmatter`，失败再逐行读取；缺描述时用首个标题 + 首段（CJK 换行不插空格）。读不了的给出原因（非 UTF-8、超限、`skill.md` 大小写、只有 `SKILL_*.md`、悬空链接）。
  - `ExtensionManager.sessionSkills()` / `skillCatalog()`；adapter 新增 `createSkills`，经 Pi `skillsOverride` 注入，同名时 installed/bundled 优先（Pi 同款 collision diagnostic）。每次 session factory 都重新扫描，运行中新增的 skill 在新会话即可见。
  - 新命令 `skills.catalog`：CLI `pspore skills` 改用它（help 文案同步）、TUI `/skills` 显示来源/状态/原因、GUI 集成页新增「Skills · N」chips 与「未加载 Skill」条目；desktop IPC 白名单加入该 action。旧 `skills.list` 不变。
  - 安全补偿：policy 把 `edit` 写入 `<workspace>/skills/**` 标为风险（`ask_risky` 下需审批），读取与在该目录跑 shell 不受影响，维持"模型生成的 skill 不得自动加载"的设计约束。
  - Electron smoke 在两个临时 home 预置一个 YAML 不合法的本地 skill 与一个只有子文档的目录，新增断言：两者分别出现在「Skills」与「未加载 Skill」中，且 skill 不被算作内置工具。
  - 文档：README（英文）、`docs/project-overview.md`、`docs/detailed-design.md` §10.2、memory-bank 模块/架构/导航/需求/待办。
  - 版本 `0.1.25 → 0.1.26`（PATCH）。
- 修改文件：`src/plugins/{workspace-skills.ts(新),extension-manager.ts,types.ts}`、`src/pi/pi-runtime-adapter.ts`、`src/daemon/daemon.ts`、`src/application/agent-application.ts`、`src/policy/policy.ts`、`src/cli/main.ts`、`src/ui/tui/tui-app.ts`、`src/desktop/{ipc-contract.ts,main.ts}`、`src/desktop/renderer/renderer.ts`、`scripts/electron-smoke.mjs`、`src/version.ts`、`package.json`、`package-lock.json`（仅版本号）、`test/unit/{workspace-skills.test.ts(新),policy-approval.test.ts,desktop-ipc-validation.test.ts}`、`test/integration/{extension-manager,daemon}.test.ts`、`test/contract/pi-runtime-adapter.test.ts`、README/docs、`dist/**`。
- 验证方式与结果：
  - 针对性测试：workspace-skills 7 项、policy/IPC 12 项、extension-manager 5 项、adapter skill 契约 2 项（含 XML 转义、`disable-model-invocation`、同名冲突）、daemon `skills.catalog` 协议用例，全部通过。
  - `npm run typecheck` 通过；`npm test` 234 项中 233 通过，唯一失败为 todo 中已记录的 MCP `-32001 Request timed out` 抖动用例（两轮分别落在 `daemon.test.ts` 与 `mcp-manager.test.ts`，在**未改动的 HEAD worktree 上同样失败**；实测 fixture `node --import tsx` 冷启动 2.04 s，已超过用例的 2 s 请求超时）；`npm run build` 通过。本地 `node_modules` 缺 lockfile 中已有的 `pdfjs-dist`，以 `npm install --no-save --ignore-scripts` 补回（lockfile 校验和不变），PDF 用例随后通过。
  - 端到端（构建产物）：本机没有 DeepSeek 凭据（`~/.pspore/credentials/` 为空），改用真实 daemon + 真实 Pi adapter 指向本地 OpenAI 兼容 mock，抓取实际发出的系统提示词。修复后 `<available_skills>` 含 `aegis-search`、`doc-extract`、`ccb-mail`（YAML 不合法的描述原样保留）、`weekly-report`（无 frontmatter，描述"周报助手 — 根据本周会议纪要生成周报并发给部门负责人。"）；只有 `SKILL_DRAFT.md` 的 `half-done` 在 `pspore skills` 中为 `skipped` 并说明原因。**对照组**（未改动 HEAD 的 dist，同一场景）只发出 `aegis-search`、`doc-extract` 两个——与用户截图症状一致。
  - GUI（主基准 `1920×1080`）：本机无 `xvfb-run`，经 X 转发显示运行 `npm run test:electron`，完整 smoke 因 2–3 s 时序等待超时失败（设置弹层关闭 / 重连遮罩），**未改动的 HEAD 在同一环境同样失败**，判定为环境问题；Chromium headless Ozone 后端直接 SIGSEGV，私有解包的 Xvfb 需要 `/usr/bin/xkbcomp` 无法使用。改为在 dist 临时插桩（随后 `npm run build` 覆盖，已确认无残留）截取集成页：「Skills · 3 · 新会话可用」列出 aegis-search / doc-extract / smoke-mail，「未加载 Skill · smoke-draft · 本地 · 已跳过」附原因与路径，换行正常无溢出。完整 smoke（含新断言）由 CI ARM64 job 在发版前执行。
- 当前状态：代码、测试、文档与 memory-bank 已完成；待提交推送并由 CI 发布 `v0.1.26`。
- 遗留问题：已存在会话不热加载运行中新增的 skill（新会话或服务重启后可见）；本机 MCP 用例超时与 Electron smoke 时序问题；均见 `todo.md`。

## 2026-09-09 — 窗口缩放不重排、发布不再经过制品存储

- 阶段目标：修掉"缩放窗口时内容不跟着变"，并根治发布被 GitHub Actions 制品配额卡死的问题。
- **窗口缩放不重排（根因）**：转录区是变高虚拟列表，`transcriptState.heights` 里每一条高度都是按**当时的宽度**测出来的。而 resize 只调 `syncResponsivePanels`，它在断点未变时直接 early-return——**同一断点内拖动窗口，转录区既不重新测量也不重绘**，间隔条继续按旧布局撑着，内容看起来就不跟着窗口走。
  - 修法：resize 后防抖 120ms，丢弃高度索引并重绘。同时清 `messageSource`——渲染只在消息变化时才 `heights.sync()`，一个从未 sync 的新索引里一条目都没有，`totalSize()` 归零会把转录区直接打空（实测 scrollHeight 181884 → 546，改对后为 182054）。
  - 新增验收：在**同一断点内**缩放（1920→1700，面板不动），断言宽度确实变小、`panelsUnchanged`、且 `scrollHeight` 发生变化。这正是原有 smoke 完全没覆盖的情况——它只测跨断点的缩小。
- **发布改为直传 Release（根治配额）**：
  - 真因不是"账面滞后"。GitHub Free 私有仓库 Actions 存储额度 500 MB，而 9-08 清理后仍有 844 MB（aegis-searcher 436 + pSpore 408），所以 24 小时后重跑照样被拒。已把两个仓库的未过期制品全部清空（15 个 / 844 MB → 0）。
  - `release.yml`：`validate-release` 先建**草稿** Release；x64 与 ARM64 各自把 6 个资产带标签直传草稿；`publish-release` 从草稿下载、逐个核对 SHA-256 与架构，再 `gh release edit --draft=false` 转正。制品存储占用降为 0，而"两架构都验证通过才对外可见"的性质由草稿保留。
  - `package-arm64.yml`：新增 `release_tag` 输入。有它就传草稿，没有就保持原来的预览件行为（`main` 推送的预览不受影响）。
- **预览件不再能否决 ARM64 的结论**：`v0.1.23` 首次推送后，CI 停在"Wait for the native ARM64 build"，而 ARM64 run 是在**最后一步** `Upload ARM64 CI packages` 挂的——`Artifact storage quota has been hit`。构建、`npm run check`、Electron smoke 全部已经通过，只是一个给人下载用的便利件传不上去，整个 run 就判失败，于是 tag 打不出来、版发不了。
  - 这条路径正是上面刻意没动的**预览**路径（`main` 推送，`release_tag == ''`），发布路径已经不碰制品了。
  - 修法：给该步骤加 `continue-on-error: true`——run 的结论应该由构建和 smoke 决定，不该由一个便利上传决定；同时把预览件保留期从 14 天缩到 2 天（单个约 400 MB，一周攒下来必然再次撞满 500 MB 额度）。
  - 注意：清理后 API 查到的未过期制品是 **0 字节 / 10 个（均已过期）**，但配额仍在拒绝上传——GitHub 的用量按 6~12 小时重算，账面确实滞后。这次不再依赖它恢复。
  - 资产标签在**上传时**带上：`gh release edit` 无法附加标签，而在 publish 阶段为了加标签重传 800 MB 会把刚省下的流量又还回去。
- **ARM64 job 一直在 dash 里跑 bash 脚本（长期潜伏）**：`v0.1.23` 的 Release run 里 x64 的 6 个资产已经进了草稿，ARM64 在 `Upload ARM64 assets to the draft release` 挂掉，`exit 2`。原因是该 job 跑在 `ubuntu:20.04` **容器**里，runner 给的默认 shell 是 `sh -e {0}`（dash），不是 bash——本仓库其他 job 都直接跑在 runner 上，所以只有它踩到。
  - 直接症状：新步骤第一行 `set -euo pipefail`，dash 不支持 `-o pipefail`。
  - 顺带查出的老问题：打包步骤里的 `if [[ -n "$EXPECTED_VERSION" && ... ]]` 在 dash 里是 `[[: not found`，返回非零 → `if` 判假 → 整个版本一致性校验**从写下那天起就没生效过**，而且 `set -e` 对 `if` 条件不生效，所以一直静默。
  - 修法：给该 job 加 `defaults: run: shell: bash`（容器里确有 bash——打包步骤本来就用 `bash scripts/package-desktop.sh` 跑通过）。`test/unit/version.test.ts` 增加断言锁住这一条。
- **容器里没有 `gh`**：改成 bash 之后 `v0.1.24` 又在同一步挂了，但这次报的是真错误——`gh: command not found`，exit 127。`gh` 是 **runner 宿主机**预装的；x64 job 直接跑在 runner 上所以能用，ARM64 跑在容器里就没有。
  - 修法：release 路径（`release_tag != ''`）在上传前装一份**版本钉死**的 `gh 2.100.0`（`linux_arm64` tarball，静态链接的 aarch64 ELF，与容器 glibc 2.31 无关；URL、包内路径 `gh_.../bin/gh`、架构均已本地实测核对）。预览路径不受影响，不多这一次下载。
  - 同时给 `gh release upload` 加 `--repo "$GITHUB_REPOSITORY"`：checkout 出来的工作区属于 `pspore-builder`，而这一步以 root 运行，让 gh 走 git 去解析仓库有 dubious-ownership 的风险，直接指定就绕开整类问题。
  - apt 安装列表加 `curl`（此前该 job 不需要它）。
- **每修一次为什么就进一个补丁号**：本地 reusable workflow 按**调用方的 ref** 解析，`v0.1.23` / `v0.1.24` 指向的提交里都是当时那份坏的 `package-arm64.yml`，重跑必然重蹈覆辙；而移动或删除已推送的 tag 属于破坏性操作。所以 `0.1.23 → 0.1.24 → 0.1.25` 各对应一次修复。`v0.1.22`、`v0.1.23`、`v0.1.24` 都留下了废弃 tag，其中后两个各带一个含 6 个 x64 资产的**草稿** Release（未发布、对外不可见）。
- 修改文件：`src/desktop/renderer/renderer.ts`、`src/desktop/main.ts`、`.github/workflows/{release,package-arm64}.yml`、`test/unit/version.test.ts`、`memory-bank/*`、`dist/**`
- 验证方式与结果：
  - `npm run check`：typecheck 通过；223 项全通过；build 通过。
  - `npm run test:electron`（Xvfb，**主基准 1920×1080**）：通过。同断点缩放实测 `{beforeWidth:1220, afterWidth:1066, beforeScrollHeight:181884, afterScrollHeight:182054, panelsUnchanged:true}`。
  - workflow 改造由 `test/unit/version.test.ts` 断言覆盖：release 路径不得出现任何 `upload-artifact`/`download-artifact`，必须是"建草稿 → 上传 → 校验 → undraft"，且预览路径仍走制品、永不 `gh release create`。
- 发布与远端复验（`v0.1.25`，Release run `34321497458`）：
  - Release 非 draft、非 prerelease，**12 项资产**，两架构各 6 项且标签齐全；overlay 为 38.2 MB / 37.9 MB（x64 / arm64），仍在 50 MB 以内。
  - 下载 `pspore-desktop-0.1.25-linux-x64-overlay.zip` 实测：`sha256sum --check` 通过；`overlay-manifest.json` 为 `appVersion 0.1.25` / `electron 43.3.0` / `x64`；包内 `app.asar` 含 `PSPORE_VERSION = "0.1.25"` 与本轮全部新代码（`scheduleResizeReflow`、`run-activity`、`tools.list`、`session.delete`、`listTime`）。
  - **本次发布占用的 Actions 制品存储为 0**：仓库现存 10 个制品全部已过期、未过期用量 0 字节，且发布 run 未产生任何制品。草稿路径达成设计目标。
- 收尾清理：删除废弃 tag `v0.1.22`/`v0.1.23`/`v0.1.24`（三者指向的提交均已在 `main` 上，删 tag 不丢历史，已逐个 `merge-base --is-ancestor` 核对）与 `v0.1.23`/`v0.1.24` 两个草稿 Release（只含被 `0.1.25` 取代的 x64 资产）。远端现只剩 `v0.1.25` 及历史正式版本。
- 当前状态：完成、已发布、已远端复验；`dist/` 已同步。
- 遗留问题：见 `todo.md`。

## 2026-09-08 — 会话列表排序与时间、内置工具可见、运行状态指示

- 阶段目标：用户提的五点——新会话排到上面、展示会话时间、队列消息"卡住"、集成页展示已安装 skills 与内置 tools、用不同 loading 区分卡住与等待工具。
- 完成内容：
  - **会话按创建时间倒序**：`presentSessions` 不再把 `main` 钉在顶部——在任何有多个会话的 home 里它都是最老的那个，钉顶等于让新建会话永远沉在下面。没有 catalog 记录（因而没有创建时间）的会话排在最后，而不是因为空字符串跳到倒序首位。
  - **会话行显示时间**：新增 `listTime()`，按"离现在多远"选择精度——今天 `14:32`、今年 `08-10`、更早 `2025-08-10`，narrow 列里不会两行歧义。
  - **内置工具进集成页**：新增 `tools.list` 命令。工具列表取自守护进程交给运行时的**同一份数组**（`daemon.ts` 的 `tools`），不另抄一份，避免展示与实际能力漂移。渲染为 chips（15 个短标识符，逐行排会把面板撑成一列近空行）。
  - **运行状态指示器**：转录区下方新增一行，四种状态各自的标记与动画——等待批准（琥珀脉冲，**不动就永远不动**）、执行 `<工具名>`（横向滑动条，活儿在屏幕外）、生成回复中（稳定闪烁）、等待模型响应（旋转 spinner）。超过 2 秒才显示"已 N 秒/N 分"。`prefers-reduced-motion` 下停用动画。
- **关于"队列消息卡住"的结论：不是队列 bug**。用 `deepseek-v4-flash` 真机实测——运行中 3.0s 插入、5.0s 第一轮结束即被排空、5.8s 答完；10 轮不同时序的竞态测试 0/10 滞留。查证 Pi：agent-loop 在回合结束会排空 follow-up 队列，队列消息真正开始时会发 `queue_update` 清掉界面显示，两条链路都通。曾怀疑自动压缩窗口（它挂在 `prompt()` 的 `.then()` 里、在 loop 排空之后），但 Pi 的 `compact()` 不置 `_isAgentRunActive`，那期间 `isStreaming` 为 false、消息走正常 prompt，假设不成立。用户补充"消息 pop 出来了但界面没动静"后定死了根因：`hasStreaming = Boolean(streaming || thinking)`，**没有文字就什么都不画**——等首 token 和整个工具执行期间转录区一片空白，看起来像死了。运行状态指示器即为其修复。
- **顺带修掉的既有缺陷**：`renderApproval` 每次渲染都 `replaceChildren` 重建按钮，销毁掉持有焦点的那个，而重新聚焦只在请求 id 变化时才做——审批弹层开着时任何别处的重绘都会把焦点悄悄丢回 document。改为只在请求变化时重建。这解释了此前被当作"时序竞态"的 smoke 偶发失败。
- 修改文件：
  - `src/ui/shared/presentation.ts`（排序、`listTime`、`SessionListItem.createdAt`）
  - `src/application/agent-application.ts`、`src/daemon/daemon.ts`（`tools.list` 与 `builtinTools`）
  - `src/desktop/ipc-contract.ts`（`tools.list` 进白名单与映射）
  - `src/desktop/renderer/{renderer.ts,index.html,styles.css}`
  - `src/desktop/main.ts`、`src/desktop/smoke-fixture.ts`（新增断言与 fixture 修正）
  - `dist/**`（构建产物同步）
- 验证方式与结果：
  - `npm run check`：typecheck 通过；223 项全部通过 / 0 失败 / 0 skipped；build 通过。
  - `npm run test:electron`（Xvfb，**主基准 1920×1080**）：通过。新增断言实测值——会话栏 `rootOrder=["session-later","main"]`、`times=["08-10","08-10"]`；运行状态 `toolPhase="tool"`、`toolLabel="执行 shell"`、`streamingPhase="streaming"`、`hiddenWhenIdle=true`；集成页列出全部 15 个内置工具与已安装 skill。人工复核截图确认指示器在转录区下方显示「生成回复中」、顶栏同步 RUNNING。
  - 真实模型端到端：临时 home 配 `deepseek/deepseek-v4-flash`（经 CLI `config set` + `config key` 正规路径，手改 config.json 不会生成 `state/pi/models.json`，会导致 preflight 失败）。
- 顺带修正的 smoke fixture 失真：工具事件缺 `toolCallId`，导致 started/completed 用 `event.id` 回落成不同 id、活动永远显示 running；主会话状态写死 `idle` 却同时在流式输出。
- 当前状态：完成并验证；`dist/` 已同步。
- 遗留问题：见 `todo.md`。

## 2026-09-08 — 发行包瘦身：overlay 72.3 → 38.2 MB

- 阶段目标：用户反馈 overlay 超过 50 MB。定位真实构成并回收其中不该进包的部分。
- 实测构成（v0.1.21 overlay 共 72.2 MB，压缩后）：`app.asar` 32.4 MB、aegis-search 及其依赖库 20.2 MB、`@napi-rs/canvas` 13.7 MB、clipboard 各平台原生库 5.5 MB。`app.asar` 内部按 gzip 估算：source map 11.3 MB、其余依赖代码 11.3 MB、pdfjs 用不到的部分 2.6 MB、其他厂商 SDK 2.2 MB、pdfjs 必需部分 2.1 MB、gsap 副本 1.1 MB、自有 dist 代码 0.3 MB。
- 完成内容（全部在 `electron-builder.yml` 的 `files` 排除规则里，不动业务代码）：
  - **source map**：未压缩 65 MB，其中 64 MB 来自依赖、自有代码只占 1 MB。生产环境没有任何东西读它。
  - **`@napi-rs/canvas`**：pdfjs 的 optionalDependency，34 MB 预编译 Skia。抽取只调 `getTextContent()`，实测移除后中文 PDF 照常抽出，只多两条 rendering polyfill 警告。
  - **clipboard 非 Linux 平台原生库**：darwin/win32/riscv64。两个 Linux 架构都保留——arm64 包在独立 runner 上产出，本机验证不了，为省 0.6 MB 冒险不划算。
  - **pdfjs 用不到的部分**：非 legacy 的重复构建、浏览器查看器、wasm、图像解码器、sandbox、min 版。逐文件试出必需集只有 `legacy/build/pdf.mjs`、`legacy/build/pdf.worker.mjs`（去掉会报 `Setting up fake worker failed`，且必须是非 min 版）、`cmaps/`、`standard_fonts/`。
  - **gsap**：`motion.ts` 只有 `import type`，编译后擦除；运行时加载的是 `copy-desktop-assets.mjs` vendor 进 dist 的那份。同时把它从 `dependencies` 移到 `devDependencies`，`npm install -g p-spore` 也不再白下 6 MB。
  - 顺带修掉 Electron smoke 的一个既有竞态：渲染器把审批弹层标成 visible 后，焦点在**下一帧**才移到「拒绝」按钮，而 smoke 等的是前者、断言的是后者。机器负载高时 rAF 迟到就会假失败。改为直接等待被断言的条件本身。
- 修改文件：`electron-builder.yml`、`package.json` / `package-lock.json`、`src/desktop/main.ts`、`src/version.ts`、`memory-bank/*`、`dist/**`
- 验证方式与结果：
  - overlay `72,295,803` → `38,201,393` 字节（**-47%**），比引入 PDF 之前的 52.1 MB 还小 14 MB；全量包 177.6 → 163.7 MB。
  - 逐项确认排除生效且必需文件仍在：asar 250.1 → 126.1 MB，node_modules 194.9 → 72.0 MB，pdfjs 34.4 → 6.5 MB；`pdf.mjs`/`pdf.worker.mjs`/`cmaps`/`standard_fonts`/两个 Linux clipboard 库/`dist` 内 vendor 版 gsap 全部在位。
  - **打包后实测**：用打包出的 Electron 运行时从 asar 内抽取，中文 CID 字体 PDF、docx、doc、ppt、GB18030 文本全部正确；打包版 GUI 完整 smoke 通过（connected、1920×1080、双主题、`focusLabel='拒绝'`、IPC 白名单拒绝生效）；`aegis-search` 二进制可执行。
  - `npm run check`：223 项全通过（本次本机成功拉到 aegis-search 二进制，此前 skip 的 4 条排序用例也真实跑了）；`npm run test:electron` 通过。
- 当前状态：完成并验证；`dist/` 已同步。
- 遗留问题：见 `todo.md`。

## 2026-09-08 — 通用文档正文抽取

- 阶段目标：让 pSpore 能读用户自己的文档（pdf / ppt·pptx / doc·docx / xls·xlsx / 各类文本），补上"总结 .docx"这条一直走不通的路。
- 完成内容：
  - 新增 `src/documents/`，`extractDocument()` 为唯一入口。**格式一律按文件头字节判断，不看扩展名**——WPS 会用自己的扩展名存标准格式，邮件附件常丢扩展名，`.txt` 里放 docx 也很常见。
    - `zip.ts` + `ooxml.ts`：docx/xlsx/pptx，Node 内置 `zlib`，零依赖。xlsx 走共享字符串表，公式取缓存值，空行略过；幻灯片按数字序排（`slide10` 不能排到 `slide2` 前面）。
    - `ole.ts` + `legacy-office.ts`：复合文档容器 + doc（FIB 与分片表）、xls（BIFF 记录与 SST）、ppt（记录树与文本原子），同样零依赖。
    - `pdf.ts`：`pdfjs-dist@6.3.289`（用户批准的新增生产依赖）。中文 PDF 普遍用 Type0/CID 字体，必须带上 `cmaps/` 里的预定义 CMap 才能正确解码，自己实现极易抽出乱码——这是唯一引入依赖的地方。
    - `plain-text.ts`：BOM → 严格 UTF-8 → GB18030 的编码嗅探。Windows/WPS 存的中文 txt 基本都是 GB18030，按 UTF-8 读会整篇变成替换字符。
  - 对模型暴露为固定工具 `document`（`path`/`offset`/`limit`，单次默认 30000 字符，返回头写明 `characters: A-B of TOTAL` 与下一段的 `offset`）。
  - 新增内置 skill `bundled-skills/doc-extract/`：说明何时用、输出形态、扫描件 PDF 抽不出文字要如实说明、WPS 私有格式怎么办。
  - `read` 的二进制拒绝消息改为指向 `document` 工具；`aegis-search` skill 同步更新（升到 `0.2.2`），检索到 pdf/docx 时不再引导去 `read`。
  - WPS 私有 `.wps`/`.et`/`.dps` 按用户意见不支持，命中时明确提示另存为 OOXML。
- 修改文件：
  - 新增 `src/documents/{extract,errors,zip,ooxml,ole,legacy-office,pdf,plain-text}.ts`
  - `src/tools/core-tools.ts`、`bundled-skills/doc-extract/SKILL.md`（新增）、`bundled-skills/aegis-search/SKILL.md`
  - `test/fixtures/documents.ts`（新增）、`test/unit/document-extract.test.ts`（新增）、`test/integration/core-tools.test.ts`、`test/integration/daemon.test.ts`
  - `package.json` / `package-lock.json`、`memory-bank/*`、`dist/**`
- 验证方式与结果：
  - `npm run check`：typecheck 通过；223 项、219 通过 / 0 失败 / 4 skipped；build 通过。新增 12 条抽取用例，fixture 由 `test/fixtures/documents.ts` 现场构造，不提交二进制样本。
  - **对真实产出物交叉验证**（开发期，非提交内容）：`.xls` 用 Python `xlwt` 生成真实 BIFF8 文件读通；CFB fixture 用独立实现 `olefile` 反向校验；中文 PDF 用 `reportlab` 以 `STSong-Light` + `UniGB-UCS2-H` 预定义 CMap 生成，抽取结果与 `pdftotext` 逐字一致。
  - **打包后实测**：`bash scripts/package-desktop.sh 0.1.20` 后，用打包出的 Electron 运行时从 `app.asar` 内加载 `dist/documents/extract.js`，pdf/docx/xls/doc/ppt/gbk-txt 六种全部正确抽出中文——这是最大的打包风险（pdfjs 及其 169 个 cmap、16 个字体能否从 asar 读到），已证实可用。
  - 独立 SEA CLI 二进制体积仍为 140M（未变），确认 esbuild 没有把 pdfjs 打进去；该形态下 PDF 会抛明确的降级错误，其余格式不受影响。
  - `npm run test:electron`（Xvfb，主基准 1920×1080）：通过。
- 发布：`v0.1.21`。CI `34182242711`、ARM64 preview `34182242698` 与 Release `34182501782` 全部成功，12 项资产已发布（<https://github.com/advnljs/pSpore/releases/tag/v0.1.21>）。
  - 远端复验：下载 x64 全量包，SHA-256 校验通过；用**发行包自带的 Electron 运行时**从其 `app.asar` 内加载抽取模块，9 个样本全部正确——中文 CID 字体 PDF、纯 ASCII PDF、docx、xlsx、pptx、doc、xls、ppt、GB18030 文本。包内确认 `doc-extract` skill 已随发行版携带，pdfjs 的 169 个 cmap 齐全。
- 当前状态：完成、已验证并随 `v0.1.21` 发布；`dist/` 已同步。
- 遗留问题：见 `todo.md`。

## 2026-09-08 — 二进制内容导致桌面端被永久锁死

- 阶段目标：修掉用户截图里的 `kernel state.sessions.<id>.messages[2].text must be a bounded string`。
- 根因：守护进程的 `boundPublishedText` 只裁长度，从不清理 `\u0000`；而客户端的 `boundedString` 对任何含 NUL 的字符串一律拒绝，且拒的是**整份权威快照**。用户让模型总结 `.docx`，`read` 工具把这个 ZIP 容器按 UTF-8 解码，NUL 进入 transcript → 进入快照 → 每次重连都重放同一份被拒的快照，桌面端再也连不上。已用脚本精确复现出与截图逐字一致的报错。
- 完成内容：
  - `boundPublishedText` 把 NUL 替换成 `\uFFFD`（替换而非删除，读者能看出这里原本有东西；长度不变，不会把字符串顶回上限之上；未命中时保持原引用，不破坏上层的结构共享）。这是唯一的发布收口——hello 快照、事件广播、命令响应都走 `boundPublishedValue`，因此一处修好覆盖全部通道，且对已经写进 JSONL 的历史会话同样生效。
  - `read` 工具遇到含 NUL 的文件直接报 `Not a UTF-8 text file`，不再把二进制容器的乱码塞进上下文——这既是本次 NUL 的来源，本身也是缺陷（模型拿到几百行 mojibake 什么也总结不出来）。
  - `bundled-skills/aegis-search/SKILL.md` 相应更正并升到 `0.2.1`：检索结果里的 `pdf/docx/xlsx` 不能直接 `read`，多数问题用 `snippet` 就能回答。
- 修改文件：
  - `src/protocol/limits.ts`、`src/tools/core-tools.ts`、`bundled-skills/aegis-search/SKILL.md`
  - `test/unit/protocol-limits.test.ts`、`test/integration/core-tools.test.ts`、`test/integration/daemon.test.ts`
  - `package.json` / `package-lock.json` / `src/version.ts`、`dist/**`
- 验证方式与结果：
  - `npm run check`：typecheck 通过；211 项、207 通过 / 0 失败 / 4 skipped；build 通过。
  - 新增三条回归用例，并**实测反向验证**：把 `limits.ts` 的清理改回原样后，三条全部失败——其中 daemon 端到端那条是 5 秒超时失败，正是"桌面端永远连不上"的原状。恢复修改后全部通过。
  - `npm run test:electron`（Xvfb，主基准 1920×1080）：通过。
- 发布：`v0.1.20`。CI `34178346302`、ARM64 preview `34178346305` 与 Release `34178563608` 全部成功，12 项资产已发布（<https://github.com/advnljs/pSpore/releases/tag/v0.1.20>）。
  - 远端复验：x64 overlay 的 SHA-256 校验通过，`overlay-manifest.json` 为 `appVersion 0.1.20 / electron 43.3.0 / x64`。从包内 `app.asar` 解出 `dist/protocol/limits.js`、`dist/desktop/validation.js` 与 `dist/kernel/state.js`，用**发行版自己的代码**跑截图那份快照：结果是 accept，NUL 已变成 `\uFFFD`（尾部为 `\n\nPK��binary`）。`dist/tools/core-tools.js` 含 `Not a UTF-8 text file` 守卫，`app.asar.unpacked` 里的 aegis-search skill 为 `0.2.1`。
- 当前状态：修复完成、已验证并随 `v0.1.20` 发布；`dist/` 已同步。
- 遗留问题：见 `todo.md`。

## 2026-09-08 — 会话删除与索引状态一致性

- 阶段目标：按用户要求补上会话删除能力，并修掉"设置面板已勾选并生效的本机索引，右侧面板仍显示未配置"的矛盾。
- 完成内容：
  - **会话删除**：新增 `session.delete` 协议命令。先取消该会话的审批与子 agent、abort 运行中的会话，再 dispose runtime、删除 `session-catalog.json` 记录并删除 `state/sessions/` 下对应的 Pi JSONL；只存在于 catalog（未 attach）的记录同样可删，因此恢复失败的会话也能清理。
    - `SessionCatalog.remove()` 承担删除边界：JSONL 路径在 unlink 前重新用 `resolveSessionFile` 对 sessions root 做一次解析，指向 root 之外的记录只丢条目、不碰文件系统。
    - 三个客户端都接上：GUI 会话行右侧新增 `✕` → `确认删除` 两步内联确认（5 秒后自动解除，子 agent 行不提供删除）；TUI `/delete [ID]`；CLI `session delete ID`。
    - 客户端选中项无需额外处理：删除广播的 `session.closed` 经既有 `selectAvailable` 自动切到其他会话。
  - **索引状态**：`IndexingStatus` 增加 `enabled` 字段并把 `disabled` 拆成三个 phase——`disabled`（真的关掉）、`unconfigured`（已启用但没选目录）、`unavailable`（缺索引程序）。此前三种情况都上报 `disabled`，右侧面板一律显示"未启用"，与刚勾选完的设置面板直接矛盾。
    - GUI 右侧面板：新增"缺少目录"标签、按 phase 给出具体原因文案，并固定加一行"设置：已启用/未启用"直接回放配置开关。
    - 设置面板与保存回执：勾选但没选目录、或发行版缺索引程序时，`saveIndexing` 的回执与面板说明都会明说"索引不会运行"，不再只报"已保存并应用"。
- 修改文件：
  - `src/domain/indexing.ts`、`src/indexing/index-service.ts`
  - `src/sessions/session-catalog.ts`、`src/application/agent-application.ts`
  - `src/desktop/ipc-contract.ts`、`src/desktop/main.ts`、`src/desktop/smoke-fixture.ts`
  - `src/desktop/renderer/renderer.ts`、`src/desktop/renderer/styles.css`
  - `src/ui/tui/tui-app.ts`、`src/ui/tui/commands.ts`、`src/cli/main.ts`
  - `test/unit/index-service.test.ts`、`test/unit/session-catalog.test.ts`、`test/unit/desktop-ipc-validation.test.ts`、`test/integration/daemon.test.ts`
  - `README.md`、`memory-bank/*`、`dist/**`（构建产物同步）
- 验证方式与结果：
  - `npm run typecheck`：通过。
  - `npm test`：208 项，204 通过 / 0 失败 / 4 skipped。新增用例覆盖 catalog 删除边界（只删自己的 JSONL、缺文件也删记录、幂等）、daemon 端到端删除（live state + catalog + JSONL 全部消失，重启后不恢复，其余会话不受影响）、IPC decode/映射、以及索引三态。
  - `npm run build`：通过。
  - `npm run test:electron`（Xvfb，主基准 1920×1080）：通过。新增断言实测结果——会话栏 `{rootRows:1, deleteControls:1, agentDeleteControls:0, hiddenUntilHover:true, armedLabel:"确认删除", rowsAfterFirstClick 未变}`；索引面板 `{phase:"unconfigured", phaseLabel:"缺少目录", counts:"本机索引已启用，但还没有选择要索引的目录", note:"设置：已启用 · 在设置 → 本机索引中添加目录后开始索引"}`。新增 `desktop-session-delete-armed.png` 作为破坏性控件的视觉证据，已人工复核。
  - 真实守护进程手测（临时 home + 假 aegis-search）：`enabled+无目录` → `unconfigured`；`enabled+有目录` → `idle 3/3`；`关闭` → `disabled`。CLI `session delete` 实测删除 catalog 记录与 JSONL、保留其他会话、重复删除返回 `Root session does not exist`、错误子命令给出用法。
- 发布：`v0.1.19`。CI `34176353928`、ARM64 preview `34176353925` 与 Release `34176598025` 全部成功，12 项资产已发布（<https://github.com/advnljs/pSpore/releases/tag/v0.1.19>）。
  - 远端复验：x64 CLI 的 SHA-256 校验通过，`version` 报 `pSpore 0.1.19 (Pi 0.84.1, Node 24.20.0)`，`help` 含新的 `session delete ID`；x64 overlay 的 SHA-256 校验通过，`overlay-manifest.json` 为 `appVersion 0.1.19 / electron 43.3.0 / x64`，包内 `app.asar` 含 `session.delete`（52 处）与 `unconfigured`（19 处）。
- 当前状态：两项改动完成、已验证并随 `v0.1.19` 发布；`dist/` 已同步。
- 遗留问题：见 `todo.md`。

## 2026-08-22 — GUI 重构与交互优化

- 阶段目标：按用户要求重构桌面 GUI——Enter 发送/Ctrl+Enter 换行、白蓝配色浅色默认、精致深色模式、GSAP 动效。
- 完成内容：
  - composer 键盘行为改为 Enter 发送、Ctrl/Cmd/Shift/Alt+Enter 换行，含 IME 合成态守卫；发送按钮提示更新。
  - styles.css 全量重写为 "cobalt paper" 设计系统：浅色默认（`#f4f7fb` 纸面 + 钴蓝 `#2563eb`）、深色板岩藏青克制配色；topbar 去卡片化、panel 发丝边框、消息/建议卡片/表格/代码块全面翻新；保留全部响应式断点与可访问性基线。
  - 新增 `src/desktop/renderer/motion.ts`：GSAP 入场编排、消息 stagger/单条入场（流式不重复触发）、设置/审批弹层出入场（退出后置 hidden + 状态守卫）、连接徽章脉冲、发送按钮微动效；`prefers-reduced-motion` 与引擎缺失时全部降级。
  - `gsap@3.15.0` 加入 dependencies，UMD 构建经 `copy-desktop-assets.mjs` vendor 到 `dist/desktop/renderer/vendor/gsap.min.js`，index.html classic script 加载。
  - renderer 安全测试契约显式放行且仅放行 `./vendor/gsap.min.js` 与 `./renderer.js` 两个本地脚本。
- 修改文件：
  - `package.json` / `package-lock.json`
  - `scripts/copy-desktop-assets.mjs`
  - `src/desktop/renderer/index.html`、`styles.css`、`renderer.ts`、`motion.ts`（新增）
  - `test/unit/desktop-security.test.ts`
  - `dist/**`（构建产物同步）
- 验证方式与结果：
  - `npm run typecheck`：通过。
  - `npm test`：113/113 通过（中途两次 MCP 集成用例在并行负载下 UDS 超时抖动，隔离运行基线与改动版均通过，最终全量通过）。
  - `npm run build`：通过，vendor 文件就位。
  - `npm run test:electron`（Xvfb）：通过——1920×1080 主基准明暗双主题、1440×900、1180×720 布局、设置弹层 containment/inert、审批 modal、CSP、字号下限、IPC allowlist 全部断言成功；人工复核明/暗主题与设置弹层截图确认新视觉生效。
- 当前状态：GUI 重构完成并已验证；工作树待提交。
- 遗留问题：见 `todo.md`。

## 2026-08-09 20:17 CST — 详细设计阶段

- 阶段目标：把 `initial_design.txt` 的概念草案整理为可实施、可验证的 pSpore 详细设计。
- 完成内容：
  - 核对 Pi 官方仓库、`v0.84.1` 包名、Node 要求、SDK、AgentSession、JSONL session、skills/extensions、tool gate、安全边界和实验性 client/server/protocol。
  - 核对 OpenClaw `BOOT.md` 的启动语义，并设计为 Daemon ready 后的非阻塞、可审计 run。
  - 完成总体架构、kernel loop、Pi adapter、记忆/BM25、权限/Shell、cron、subagent、MCP、实时协议、持久化、token/KV cache、测试与分阶段路线图。
  - 明确设计状态与安全警告，增加项目 README 与 `.gitignore`。
- 修改文件：
  - `README.md`
  - `.gitignore`
  - `docs/detailed-design.md`
  - `memory-bank/*.md`
- 验证方式与结果：
  - 只读脚本检查 13 个 Markdown 文件的内部链接与代码围栏：通过。
  - `curl` 检查选取的 Pi `v0.84.1` 与 OpenClaw BOOT 官方链接：HTTP 200。
  - 敏感模式扫描：未发现 token、API key 或 private key。
  - 环境检查：本机 Node.js `v22.17.1`，低于未来实现所需 `>=22.19.0`，已记录为 P0 待办。
- 当前状态：详细设计内容与文档验证已完成；尚无实现代码、build、测试套件或运行服务。
- 遗留问题：见 `todo.md`，主要为 Phase 0 兼容性 spike 与后续实现。

## 2026-08-09 20:35 CST — GitHub 私有仓库发布

- 阶段目标：将完整设计安全发布到同名 GitHub 私有仓库。
- 完成内容：初始化本地 `main` 分支，逐项暂存本阶段 15 个文件，创建 `advnljs/pSpore` 私有仓库并推送。
- 验证方式与结果：
  - `git diff --cached --check`：通过。
  - staged diff 敏感模式扫描：通过。
  - GitHub `visibility`：`PRIVATE`。
  - 本地 `465aad7f8461d57c0d8566849f58ea5e0f055287` 与远端首次设计提交一致。
  - `main` 已跟踪 `origin/main`；首次推送后工作树干净。
- 当前状态：设计文档已发布；当前阶段没有实现代码，因此没有可编译、可启动或可预览的服务。
- 遗留问题：本次为新仓库首次提交，没有既有 base branch 可供代码评审，未创建 draft PR；后续实现从独立 feature branch + PR 开始。

## 2026-08-09 22:32 CST — Phase 0 运行时与风险契约

- 阶段目标：建立 Node/TypeScript 工程，验证 Pi `v0.84.1` 与 Linux Shell/PTY 的关键上游假设。
- 完成内容：
  - 固定 Node.js 24、Pi `v0.84.1`、Electron `43.3.0` 与已确认的最小依赖，生成 npm lockfile；Electron 二进制通过中国大陆镜像安装并验证。
  - 实现唯一 Pi SDK 边界 `PiRuntimeAdapter`，完成领域事件/快照映射、session create/resume/new/fork、订阅重绑、prompt/steer/followUp/abort/compact、usage/cache 和 fail-closed tool gate。
  - 使用 Pi 官方 faux provider 完成不调用付费模型的 contract tests。
  - 实现 Linux login shell pipe/PTY、超时、输出上限、私有 artifact、SHA-256、进程组终止与 secret 流式脱敏。
  - 记录 ADR 0001，并把最终客户端从 Tauri 更新为 Electron 43；核心仍先以 TUI 验收。
- 修改文件：`package*.json`、`tsconfig*.json`、`src/domain/`、`src/pi/`、`src/shell/`、`test/`、`docs/adr/0001-runtime-and-pi-baseline.md`、`README.md`、`docs/detailed-design.md`、`memory-bank/*.md`。
- 验证方式与结果：
  - `npm run typecheck`：通过。
  - Pi adapter contract：7 项通过，包含 steer/followUp 次序与 manual compaction 生命周期。
  - Shell Linux integration：4 项通过，包括 PTY secret 不落 artifact。
  - `npm run build`：通过。
  - `electron --version`：`v43.3.0`；Node：`v24.19.0`。
  - `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 当前状态：Phase 0 关键假设已验证；尚无可启动 Daemon/TUI，进入 Phase 1 纵向切片。
- 遗留问题：真实 sudo smoke test 未执行（避免无必要提权）；steer/followUp/compaction 将在 Phase 1 集成路径继续扩充。

## 2026-08-09 23:16 CST — Phase 1 可运行核心纵切

- 阶段目标：让 Node 24 核心以真实 Daemon + UDS + CLI/TUI 运行，并打通单 session、基础工具与审批路径。
- 完成内容：
  - 实现严格 config/home 初始化、`0700`/`0600` 权限、同目录 fsync/rename 原子写、JSONL append、PID + process-start 单实例锁和 stale recovery。
  - 实现纯 Kernel reducer 与串行 commit loop；Application 串行化同 session command，并将 Pi runtime snapshot/event 回投 Kernel。
  - 实现 capability/risk policy、显式 deny 优先、durable pending approval、first-response-wins、timeout/restart/persistence failure fail closed、audit 与 session grant。
  - 实现带 expected SHA-256 的 `read/edit`、有界 ripgrep `search`、复用 ShellService artifact 的 `shell` 固定工具集。
  - 实现私有 UDS v1 协议：严格 hello/command decoder、ASCII LF 分帧、大小/深度限制、revision、command idempotency、bounded replay/背压与 snapshot。
  - 实现 `init/daemon/status/doctor/tui/prompt/version` CLI；TUI 使用 Pi TUI primitives，支持流、审批、显式 steer/follow-up/abort、seq gap 重连与双 Ctrl+C 清理退出。
- 修改文件：`src/application/`、`src/cli/`、`src/config/`、`src/daemon/`、`src/gateway/`、`src/kernel/`、`src/policy/`、`src/protocol/`、`src/storage/`、`src/tools/`、`src/ui/tui/`、对应测试、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check`：通过；严格类型检查、28 项测试和 production build 全部成功。
  - TUI 固定 `160×45` snapshot：45 行、每行 160 cells，关键操作可达，golden SHA-256 固定。
  - 构建产物 live smoke：Daemon ready、`status/doctor` UDS 连接、第二实例拒绝、未配置模型 prompt 明确失败、SIGINT exit 0。
  - graceful shutdown 后 socket、endpoint、lock 均不存在；临时验收 home 已删除。
- 当前状态：Phase 1 单 session 可运行纵切完成；当前没有常驻预览实例（验收实例已按 graceful shutdown 停止）。
- 遗留问题：memory token/path/hash 约束、BM25、durable event/session recovery、cron/BOOT、subagent、MCP 与 Electron 尚未实现；真实 provider/sudo 未用于自动化测试。

## 2026-08-09 23:33 CST — Memory 与 lexical retrieval 纵切

- 阶段目标：完成 v1 pinned context、受控记忆写入、exact/BM25、引用与增量 rebuild。
- 完成内容：
  - 实现中英 Unicode tokenizer、中文 `Intl.Segmenter`/2-gram fallback、`k1=1.2`/`b=0.75` BM25 与 token estimator。
  - 实现 pinned context 固定顺序、missing diagnostics、workspace/symlink/sensitive path 边界、单文件大小、总 token budget、内容 hash 与稳定 prefix hash。
  - 实现带 session/run 来源的 daily `memory_append`，credential/private-key/base64 过滤；实现 `MEMORY.md` expected-hash、source、去重 marker 与 atomic `memory_curate`。
  - 实现 Markdown paragraph/heading 与 Pi JSONL entry chunk、exact boost + BM25 合并、scope/glob/path、返回 token budget、source ref/path/line/hash。
  - 索引按 canonical path、size、mtime、content hash 增量刷新并原子保存；排除 secret、vendor/cache、symlink、binary/oversized 文件；cache 损坏可重建。
  - Daemon 已注入 memory tools 与 lexical provider；`read.expectedSha256` 可验证 search 后引用未变。
- 修改文件：`src/memory/`、`src/tools/core-tools.ts`、`src/daemon/daemon.ts`、相关 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：针对性严格 typecheck 与 10 项 memory/search/core/daemon 测试通过；完整阶段检查在提交前执行。
- 当前状态：memory/search v1 纵切已完成；尚无常驻实例，本阶段不涉及 Electron/PC viewport。
- 遗留问题：索引 cache 不是备份；durable event/session mapping、cron/BOOT、subagent、MCP 与 Electron 仍待实现。

## 2026-08-10 00:01 CST — Phase 2 Cron、BOOT 与 durable run

- 阶段目标：完成可验证的主动触发主链路，并让 cron/BOOT/run 与审批状态通过同一 Daemon/UDS/TUI 暴露。
- 完成内容：
  - 实现严格标准五字段 cron 与 IANA timezone adapter，并固定 Croner 在 DST 跳时/重复时刻的 UTC 行为。
  - 实现用户可编辑 job schema、canonical directory cwd、budget/delivery/concurrency/misfire 校验。
  - 实现 monthly append-only run ledger、schedule slot claim 去重、queued 恢复、running→unknown、破损尾行 recovery 与中间损坏 fail closed。
  - 实现 `forbid/replace/allow`、全局并发、timeout/budget/cancel、run_once/skip misfire 与 user/cron/recovery trigger。
  - Daemon 在 UDS ready 后启动 scheduler；BOOT 使用独立 run/session、每实例去重且不阻塞 ready。CLI/TUI 增加 jobs/runs/run/cancel。
  - 实现 automation run 的 agent/command executor、run 级授权上下文和跨重启 durable job grant；非法 approval scope 不消费请求，显式 deny 始终优先。
- 修改文件：`src/automation/`、`src/storage/jsonl.ts`、Kernel/Application/Daemon/CLI/TUI、policy/Pi runtime contract、相关 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：增量 `npm run typecheck` 通过；Pi/policy 契约 13 项通过；scheduler/daemon/run-ledger/cron/TUI 组合 13 项通过；完整 `npm run check` 通过（严格类型检查、49 项测试、production build）。构建产物 live smoke 验证 Daemon ready、status/jobs/runs/doctor 与 graceful SIGINT，socket/endpoint/lock 和验收进程均已清理。
- 当前状态：Phase 2 主动 run 纵切已完成；验收临时 home 已删除，当前无常驻实例。TUI 视觉基准仍为固定 `160×45`，Electron 尚未开始。
- 遗留问题：schedule 原子 mutation/runtime reload 与 delivery/notification 尚待 bundled tools 阶段补齐；subagent、MCP、plugin trust 与 Electron 进入后续阶段。

## 2026-08-10 00:21 CST — Schedule mutation 与 durable notification

- 阶段目标：补齐 Phase 2 用户可操作缺口，让 job 无需重启即可安全更新，并让 agent/run 结果可持久投递到共享客户端 store。
- 完成内容：
  - `JobStore.put` 使用当前 source SHA-256 compare-and-swap、严格 schema/canonical cwd、regular-file 校验与 `0600` atomic replace；Scheduler 成功写入后停止旧 timer 并热重载新 cron。
  - 新增 UDS `job.put`、CLI `schedule put FILE` 与 bundled `schedule` list/put tool；schedule write 进入统一 `schedule.write` 风险审批。
  - 新增 durable `NotificationService`、bundled `notify` tool、terminal run delivery 与 Kernel/protocol/TUI notification state；`delivery=none` 不投递。
  - CLI/TUI 新增 notifications 列表；提供禁用状态的 `examples/jobs/heartbeat.json`，不会安装时自行触发。
- 修改文件：JobStore/Scheduler/Application/Daemon/CLI/Kernel/TUI/policy、`src/notifications/`、automation tool、示例、相关 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：增量严格 typecheck 与 21 项 schedule/notification/policy/daemon/scheduler/TUI 测试通过；完整 `npm run check` 通过（51 项测试 + production build）。最新构建 live smoke 完成 `schedule put → jobs → run heartbeat → notifications → status`，run succeeded 且通知持久可读；graceful SIGINT 后 endpoint/socket/lock 与临时 home 已清理。
- 当前状态：schedule/notify 纵切可运行；验收实例已停止，当前无常驻实例，TUI 仍按 `160×45` 验收。
- 遗留问题：进入 Phase 3 subagent、MCP 与 plugin trust。

## 2026-08-10 00:52 CST — Phase 3 Subagent 双工纵切

- 阶段目标：用同进程独立 Pi session 完成可限制、可取消、可观测的 child agent tree 与用户/parent 双工消息。
- 完成内容：
  - 实现 `AgentManager`、独立 child session、全局并发队列、默认深度/活动 child/root child 上限、workspace realpath 边界、per-agent turn/tool/token/cost budget 与终态结果。
  - 实现带 sender/recipient/sequence/correlation/priority/mode/token estimate 的串行 mailbox，支持 `steer/follow_up/next`、join deadline/abort、parent-child 路由、结构化 completion 回传与级联取消。
  - 新增 bundled `agent_spawn/send/join/cancel` tools，并将 child 授权与 parent ceiling 求交；`shared-read` 明确禁止写、Shell、网络与外部副作用，`allow_all` 也不能越过 ceiling。
  - UDS/CLI/TUI 新增 agent list/spawn/send/join/cancel；Kernel/protocol store 广播 agent tree/message。TUI 可选中活动 child session 查看实时 transcript。
  - Daemon 关停顺序先停止 child tree，automation root 结束时取消子树并清理独立 session。
- 修改文件：`src/agents/`、Application/Daemon/Kernel/policy/Pi adapter/CLI/TUI、对应 unit/integration tests、README 与 memory-bank。
- 验证方式与结果：`npm run check` 通过（严格类型检查、55 项测试、production build）；Daemon/UDS fake-model 集成用例实际完成两个 child 并发、用户中途 steering、parent 收到两个结构化结果与 child session 清理。
- 运行验证：最新 `dist/` 在真实 PTY `160×45` 下启动 TUI，连接 Daemon、执行 `/agents`、`/quit` 后正常恢复 terminal；Daemon SIGINT exit 0，验收 home 已删除。
- 当前状态：Subagent 纵切完成并已用 TUI/UDS 验证；当前无常驻验收实例。
- 遗留问题：继续 Phase 3 MCP lazy adapter、plugin trust/staging 与 skills/resource reload；随后进入 Electron 43。

## 2026-08-10 01:21 CST — Phase 3 MCP lazy adapter

- 阶段目标：把第三方 MCP tool 通过严格信任、按需生命周期和统一 policy 接入现有 Pi/Daemon/UDS/TUI 主链路。
- 完成内容：
  - 使用官方 `@modelcontextprotocol/sdk@1.30.0` 实现 stdio 与 Streamable HTTP client adapter；server 初始不启动，只在 discover/call/ping 时连接，空闲关闭并可重连。
  - 严格解析 server ID、transport、allow/deny、timeout、trust 与 `envRefs/headerRefs`；拒绝 inline secret、不安全远端 HTTP、重复 ID 和 allow/deny 冲突。
  - 对 tool 数量、分页、名称、schema 与调用参数设硬边界；归一化 tool 名避免碰撞，发现后的动态 schema 只进入新 session，当前 session 使用固定 `mcp_call`。
  - 所有模型发起的 MCP discovery/call 进入 `external.side_effect` policy gate；shared-read child ceiling 拒绝。`sandboxed` 配置在 v1 无 sandbox executor 时 fail closed。
  - 支持 timeout/AbortSignal、transport health、指数退避、secret 脱敏和 graceful stop；大结果写入私有 MCP artifact，audit 仅保存参数 SHA-256、结果与耗时。
  - Kernel/TUI 增加 MCP health，UDS/CLI 增加 `mcp list/tools/discover/ping`，TUI 增加 `/mcp` 与 `/mcp-discover`。
- 修改文件：`src/mcp/`、Config/Application/Daemon/Kernel/policy/CLI/TUI、fake MCP fixture、unit/integration tests、README 与 memory-bank。
- 验证方式与结果：`npm run check` 通过（严格类型检查、59 项测试、production build）；真实 SDK stdio contract 覆盖 discovery、allow/deny、schema、call、artifact `0600`、abort、audit、idle reconnect、backoff 与 secret redaction。构建产物 live smoke 完成 Daemon ready、doctor/status、`mcp list → discover → tools → ping`，随后 SIGINT exit 0 并删除临时 home。
- 当前状态：MCP 纵切完成；当前无常驻验收实例。TUI 以 `160×45` 实际渲染并固定 golden SHA-256，新增 MCP 状态和命令均可见。
- 遗留问题：继续 plugin trust/staging 与 skills/resource reload；随后进入 Electron 43。

## 2026-08-10 01:47 CST — Phase 3 Resource trust、Skills 与 Host Plugin

- 阶段目标：确保模型生成或外部复制的 skill/plugin 在未经用户审查和 exact trust 前绝不加载，并在受控 session/restart 边界生效。
- 完成内容：
  - 实现 `workspace/staging` canonical containment、目录/文件/深度/byte 上限、special file/symlink/node_modules 拒绝、严格 `SKILL.md`/`pspore.plugin.json` schema、依赖/lifecycle 展示与 host entry `node --check`。
  - 对排序后的 path/mode/content 生成 deterministic SHA-256；install 必须提交 expected digest，使用内存 byte snapshot 写入私有临时目录、目标重验、atomic rename，并把 exact record 写入 `0600 state/resource-trust.json`。
  - Skills 安装到内容寻址目录；每个新 Pi session/replacement 都重验 digest，并只通过 `additionalSkillPaths` 加载。Pi contract 证明 system prompt 只有 name/description/path，不含完整 skill body。
  - Host plugin 安装不 import；只有 trust record、`config.plugins` exact digest、manifest capabilities 与 grantedCapabilities 完全匹配后，才在 Daemon restart import/start。生命周期 timeout/error 转为 resource degraded，stop 在 graceful shutdown 执行。
  - 支持 trust revoke（保留内容、不热卸载）、tamper blocked health、Kernel/protocol/TUI resource health，以及 CLI/TUI `resources/skills/plugins/inspect/install/disable`。
- 修改文件：`src/plugins/`、Config/Home/Pi adapter/Application/Daemon/Kernel/CLI/TUI、对应 contract/integration/unit tests、README 与 memory-bank。
- 验证方式与结果：`npm run check` 通过（严格类型检查、66 项测试、production build）；测试覆盖 staging escape/symlink、错误 digest、篡改、未安装代码不执行、capability 缺失阻止、可信 plugin restart start/health/stop、UDS install/revoke 和 Pi session-boundary progressive disclosure。
- 运行验证：最新 `dist/` 完成 `init → daemon → resource inspect → exact install → skills/status/doctor`；真实 `160×45` TTY 显示 active skill，执行 `/skills` 与 `/quit` 后终端恢复；Daemon SIGINT exit 0，临时 home 已删除。
- 当前状态：Phase 3 完成，当前无常驻验收实例；进入 Electron 43 最后阶段。
- 遗留问题：Electron 43 客户端与最终跨客户端/安全/视觉验收。

## 2026-08-10 02:28 CST — Phase 4 Electron 43 与功能 v1 完成

- 阶段目标：在不采用 Tauri 的前提下完成 Electron 43 客户端，使其与 TUI 共享同一 Daemon，并通过安全、重连、交互和 `1920×1080` 视觉验收。
- 完成内容：
  - 实现 Electron main process `DaemonBridge`：独占 UDS、authoritative snapshot/cursor、gap 断开、指数退避重连和保序连续 delta coalescing；Electron 退出不停止 Daemon。
  - 实现严格 `DesktopCommand` allowlist 与 runtime decoder；renderer 不可提交 protocol type/channel 或任意路径。resource 操作只接受单层 staging name，由 main 解析到配置 workspace，Daemon 再做 canonical containment。
  - main 对 server hello、Kernel snapshot、event type/payload 和返回值做 JSON depth/node/string/collection 边界校验；不把未经验证的 UDS 对象送入 renderer。
  - preload 仅暴露 `bootstrap/dispatch/subscribe`；BrowserWindow 启用 `contextIsolation/sandbox`，关闭 Node integration/webview/insecure content，拒绝权限、下载、远程请求、外部导航和新窗口；HTML 使用严格 CSP。
  - 使用原生 DOM/TypeScript 实现 main/child session tree、transcript/streaming、prompt/steer/follow-up/abort/compact、child spawn/send/join/cancel、approval overlay、job/run、MCP、trusted resource、notification 和 activity UI；动态内容只写 Text node/`textContent`。
  - 构建流程同步 preload/HTML/CSS；新增 `pspore desktop`、`npm run desktop` 与自包含 `npm run test:electron`。
- 修改文件：`src/desktop/`、`scripts/copy-desktop-assets.mjs`、`scripts/electron-smoke.mjs`、`src/cli/main.ts`、`package.json`、4 个 desktop unit/integration test、README、详细设计与 memory-bank。
- 验证方式与结果：
  - `npm run check`：通过；严格 typecheck、75 项测试、production build 全部成功。
  - `npm run test:electron`：通过；真实临时 Daemon + Electron `43.3.0` + Xvfb，精确 viewport/capture 均为 `1920×1080`，自动验证断线重连与 allowlisted IPC round trip。
  - renderer probe：`process/require/Buffer/electron` 全为 `undefined`，全局 API 仅 `bootstrap/dispatch/subscribe`；任意 `shell.exec` action 被 main 拒绝；CSP 与安全基线一致。
  - 视觉/交互 probe 与人工截图检查：document 无横纵溢出；transcript 可滚动、长代码在自身区域横向滚动、tool output 默认折叠、streaming delta 可见、composer 完整固定可见、approval modal 不越界、背景 inert 且初始焦点落在“拒绝”。
  - 跨客户端 live smoke：真实 `160×45` TUI 与 Electron 同时连接同一 socket，`ss` 显示两个 ESTAB；TUI `/quit` exit 0 并恢复 terminal，Electron 单独 SIGTERM exit 0，Daemon SIGINT exit 0。
  - 环境与供应链：Node `v24.19.0`、Electron `v43.3.0`；`npm audit --omit=dev --audit-level=high` 为 0 vulnerabilities；源码与 `dist` desktop 静态资源一致，package/lockfile 无 Tauri dependency。
- 当前状态：Phase 0—4 与功能 v1 全部完成；最新 `dist/` 已构建。当前无常驻验收实例，因为 Xvfb、Daemon 和临时 home 均已在验证后正常停止/删除；可用 `npm run desktop` 启动真实客户端，或用 `npm run test:electron` 完整复现验收。
- 遗留问题：真实付费 provider 与真实 sudo 未在自动测试中使用；sandbox/vector/remote/mobile 仍按 v1 非目标延期，不阻塞 v1。

## 2026-08-11 10:10 CST — Desktop 双主题、AppImage Daemon 自启与 DeepSeek 实验

- 阶段目标：优化 PC Electron 界面与字号，支持深色/浅色切换，修复 AppImage 独立启动一直等待 `daemon.sock` 的问题，并用 `deepseek-v4-flash` 真实验证模型链路。
- 完成内容：
  - 新增 `DesktopDaemonSupervisor`与可类型化 `DaemonAlreadyRunningError`；Desktop create-only 初始化 home，通过原子单实例锁决定 `owned/external`，启动时等 Daemon ready 再连接，退出只停止自己拥有的 Daemon。
  - renderer 重构为暖深色/暖浅色语义主题，增加持久化切换、`color-scheme/theme-color`、焦点/跳转链接、表单 name/autocomplete、可减少动效，并将对话/输入/分区/侧栏主次字号固定为 `15/14/15/13/11.5px` 基线。
  - Electron smoke 扩展到外部 Daemon 复用与桌面 Daemon 自启两条路径，截取深色/浅色/审批三张 1920×1080 截图，并直接断言 computed font sizes、主题色、overflow、焦点、sandbox 和 IPC allowlist。
  - `ds_key.txt` 已加入 `.gitignore` 并收紧为 `0600`；只在临时 Daemon 进程环境注入 `DEEPSEEK_API_KEY`，未输出、未写入 config/session/memory/Git。
- 修改文件：`src/desktop/main.ts`、`daemon-supervisor.ts`、renderer HTML/TS/CSS、`src/storage/daemon-lock.ts`、`scripts/electron-smoke.mjs`、desktop supervisor tests、`.gitignore`、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、78 项测试、production build 全部成功。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：Electron `43.3.0`，精确 `1920×1080`，owned/external Daemon、双主题、字号、重连、隔离、overflow、composer 与审批焦点全部通过；人工检查深色/浅色/审批截图无明显遮挡或不可读文字。
  - 临时构建 AppImage 从空 home 实际启动：`daemonOwnership=owned`、`connection=connected`，reconnect 通过，退出后 socket/endpoint 清理；验证包 SHA-256 为 `27865b3bbbf6eab537296495c95b766ee76fc288ddb518427f7bb40bb0ea5d4c`，已更新到 `release-dist/pspore-desktop-0.1.0-linux-x64.AppImage`。
  - 真实 DeepSeek 链路返回 `PSPRORE_DEEPSEEK_OK`；snapshot 确认 model `deepseek/deepseek-v4-flash`、thinking `off`、input/output/total `2729/8/2737`、cost `$0.0003843`。
- 当前状态：最新 `dist/` 已构建，修复后 AppImage 已放入 `release-dist/`；所有验收 Daemon/Electron 进程均已停止，未留下运行 socket。本轮按用户要求只验证 PC `1920×1080`，未执行手机端验收。
- 遗留问题：真实 sudo 仍未执行（避免无必要提权）；sandbox/vector/remote/mobile 继续作为明确非目标。

## 2026-08-11 10:59 CST — Desktop 工作台重设计与安全模型设置

- 阶段目标：重新设计桌面端为简洁、低密度但高空间利用率的 PC 工作台，并让用户可在界面内安全配置 LLM provider、model、Base URL、API 协议、thinking 与 API key。
- 完成内容：
  - 先生成三套桌面风格对比稿，选择 Calm Command 与 Editorial Workbench 的组合方向；默认只保留会话侧栏和主对话区，活动/自动化/集成/资源检查器改为按需展开，消除常驻空面板。
  - 重写深色/浅色语义主题、对话层级、输入区、审批层、空状态与设置弹窗；主内容随窗口连续伸缩，窄桌面下检查器以覆盖层打开，不实现手机端布局。
  - 新增受限 settings IPC 与 `DesktopSettingsService`；模型配置写入 `config.json`/`state/pi/models.json`，API key 单独写入 `credentials/<provider>.api-key`（`0600`），renderer 只接收 `hasApiKey`，不会获得密钥正文。
  - 保存前使用 Pi `ModelRuntime` 在临时目录验证 provider/model 组合；owned Daemon 自动安全重启并重连，external Daemon 明确提示需由用户重启后生效。
  - Electron smoke 新增设置表单、密钥不泄漏、双主题、字号、默认检查器关闭与 `1920×1080`、`1440×900`、`1180×720` 三档 PC viewport 验收。
- 修改文件：`src/desktop/renderer/`、`src/desktop/main.ts`、`src/desktop/ipc-contract.ts`、`src/desktop/preload.cjs`、`src/desktop/settings-service.ts`、`scripts/electron-smoke.mjs`、desktop unit tests、`docs/design/desktop-style-comparison.png`、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、81 项测试、production build 全部成功。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：三档 PC viewport 无页面级 overflow；深色/浅色/设置/审批均已截图并人工检查；正文 `15.5px`、输入 `15px`、会话主文案 `14px`、设置字段 `14px`，紧凑辅助字号最低 `11.5px`。
  - 使用隔离临时 home 和 `ds_key.txt` 实际保存 `deepseek/deepseek-v4-flash` 设置并调用 Daemon，模型精确返回 `PSPRORE_SETTINGS_OK`；验证目录已删除，密钥未输出或写入项目。
- AppImage 验证：基于当前工作树重新打包 `release-dist/pspore-desktop-0.1.0-linux-x64.AppImage`（SHA-256 `da4131f8b247e8bf92922749ce35ef48e813d7fe799f183e7ff1c52dfbb6b575`）；从全新临时 home 启动后报告 `daemonOwnership=owned`、`connection=connected`，三档 viewport 与字号/设置断言通过，退出后 `daemon.sock`/`endpoint.json` 均不存在。
- 当前状态：桌面重设计和安全模型设置已完成，最新 `dist/` 与 AppImage 已构建；自动验收进程均已停止。
- 遗留问题：TUI/CLI 的模型设置入口与跨界面配置抽象按用户要求放到下一独立阶段；手机端明确不在验收范围。

## 2026-08-11 11:46 CST — 共享客户端内核、完整 TUI 与 npm CLI

- 阶段目标：让 TUI/CLI 与桌面端复用相同的协议状态、会话路由、Daemon 生命周期和模型设置内核；补齐 TUI 功能、响应式终端布局、wizard/命令双配置入口，并形成可直接 npm 安装的 CLI 包。
- 完成内容：
  - 抽出 `src/ui/shared/protocol-state.ts` 与 `presentation.ts`，GUI/TUI 共享 authoritative snapshot/event/delta reducer、session/metric presentation 与 main/child conversation intent；修复选中 child 后普通输入误发给 main 的路由问题。
  - 抽出 `src/daemon/supervisor.ts`，桌面与 TUI 统一 owned/external Daemon 语义；`pspore tui` 从空 home 自动初始化并启动 Daemon，退出只清理自己拥有的实例。
  - 抽出 `src/settings/llm-settings*.ts`，GUI/TUI/CLI 精确支持 `deepseek`、`openai`、`custom-openai`。Preset 固定 provider 默认 endpoint/API；自定义 OpenAI 支持 Base URL 与 Chat/Responses。
  - TUI 重写为简洁响应式会话工作台：`160×45` 双栏、`96×30` 单栏，完整 jobs/runs/notifications/agents/MCP/resources 面板、PgUp/PgDn、`/help` 命令面板；普通对话和审批/自动化/集成功能均走同一 Daemon 内核。
  - TUI 同时实现 `/config wizard` 引导配置与 `/config` 命令配置；wizard 支持取消和最终确认，Key 输入只显示遮罩。CLI 增加等价 `config show/set/provider/model/endpoint/thinking/key/clear-key`，Key 不接受 argv，只从隐藏 TTY 或 stdin 读取。
  - npm package 改为 public-ready，限制发布内容为 `dist/**/*`，增加 prepack/prepublish 检查与安全 `dist` clean；修复 npm bin 符号链接导致入口判断不执行的问题。纯 npm 安装不拉取 Electron，`desktop` 给出 AppImage 指引。
  - GUI Provider 改为 DeepSeek/OpenAI/自定义 OpenAI 下拉；只有自定义项开放 Base URL/API 类型。设置表单 input/select 计算字号明确不低于 `14px`。
- 修改文件：`src/settings/`、`src/ui/shared/`、`src/ui/tui/`、`src/daemon/supervisor.ts`、desktop main/IPC/renderer、CLI、package/scripts、相关 unit/smoke tests、README 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、86 项测试和干净 production build 全部成功。
  - 真 TTY 验证 `160×45` TUI 自动启动/清理 Daemon，`/help` 同时展示 wizard/commands；真实 wizard 可逐步到 review 并取消，`/config key` 只显示遮罩，credential mode `0600`，日志和 `models.json` 无明文。
  - 最终 npm tarball 为 261 entries、269325 bytes、SHA-1 `4053214b5c0a50183f3461e3892bcd96812b6fd3`，顶层只有 README/`dist`/`package.json`；全新 prefix 安装后 bin mode `775`，`pspore --version/config show/tui` 均可运行，生产依赖中无 Electron。
  - 使用该 npm 安装包和隔离 home 配置 `deepseek/deepseek-v4-flash`，真实 API 精确返回 `PSPRORE_NPM_DEEPSEEK_OK`；Key 文件 `0600`，模型配置只含 `!cat --` 外部引用，密钥未输出或提交。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：`1920×1080` 主视口及 `1440×900`、`1180×720` PC 响应式、双主题、三 Provider、设置、owned/external Daemon、安全边界与字号全部通过；人工检查保留截图无明显遮挡/溢出。
  - 最新 AppImage 从全新 home 实际启动为 `daemonOwnership=owned`、`connection=connected`，Provider 选项精确、设置字号 `14px`，退出后 socket/endpoint 清理；SHA-256 `ea03243750f37861c55ec2a00c1ff216b64dffbfc587b08b575d70655ae03ef4`。
- 当前状态：共享客户端内核、GUI/TUI/CLI 三 Provider、TUI 双配置入口、npm 安装包与最新 AppImage 已完成并验证；所有临时 Daemon/Electron 进程已停止。npm registry 发布仍待浏览器认证后执行。
- 遗留问题：真实 sudo 仍未执行；sandbox/vector/remote/mobile 继续为非目标。npm 发布结果将在认证后另行记录。

## 2026-08-11 14:24 CST — npm 首发前清单加固

- 阶段目标：在 `pspore@0.1.0` 首次发布到 npm registry 前，复核真实发布清单与全局 CLI 入口。
- 完成内容：
  - 浏览器 `npm login` 成功，`npm whoami` 确认当前用户；registry 在本次尝试前不存在 `pspore` 包。
  - 首次 `npm publish` 预检发现 npm 11 会将带 `./` 前缀的 `bin.pspore` 视为无效并从发布 manifest 删除；已规范化为 `dist/cli/main.js`，并新增 manifest 回归测试。
  - 修复后 `npm publish --dry-run` 无 `bin` 警告，tarball 内 package manifest 保留 `pspore` 映射。
- 修改文件：`package.json`、`test/unit/cli-config.test.ts`、`memory-bank/overall-progress.md`、`memory-bank/todo.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、87 项测试与 production build 全部成功。
  - 修复后 tarball 为 261 entries、269321 bytes、SHA-1 `399f68e6f7cd0ede377915f2054d9391f48fd9f7`；全新临时 prefix 安装后 `pspore --version` 与 `--help` 均成功，临时目录已删除。
- 当前状态：待发布代码与包已完成加固；没有常驻服务或前端视觉改动，不需要新的 viewport 验收。
- 遗留问题：正式上传被 npm registry 拒绝且未创建版本；账号 profile 显示 `tfa: false`，需由用户先在 npm 账号中启用 2FA，再重试 `npm publish`。

## 2026-08-11 15:46 CST — `p-spore@0.1.0` npm 首发

- 阶段目标：在 npm 名称保护与 2FA 约束下完成可安装、可验证的 CLI 公开首发。
- 完成内容：
  - npm 拒绝未作用域名称 `pspore`，用户明确选定 `p-spore`；已同步 `package.json`、lockfile、README、测试与项目导航，全局 CLI 命令仍为 `pspore`。
  - 用户启用 npm `auth-and-writes` 2FA，发布使用 npm 浏览器 WebAuthn 流程，未读取、粘贴或保存 token/OTP。
  - `p-spore@0.1.0` 已发布为 public 包且 `latest=0.1.0`；远端 manifest 保留 `bin.pspore=dist/cli/main.js`。
- 修改文件：`package.json`、`package-lock.json`、`README.md`、`test/unit/cli-config.test.ts`、`memory-bank/*.md`。
- 验证方式与结果：
  - 改名后与正式发布前的 `npm run check` 均通过：严格 typecheck、87 项测试和 production build 成功。
  - 发布 tarball 为 261 entries、269347 bytes、SHA-1 `68f3204636914f049b7df53b035d5868000913c9`、SHA-512 integrity `sha512-lKDQW54aMwbPHHrF40Z55eCPF+R5sSJuesnYSfeWTsKeCiilBj82L+ZlPUmBkcXhqrdAdDH5GceWLCggAUpZOg==`。
  - 使用全新临时 npm cache/prefix 从 registry 安装 `p-spore@0.1.0`；远端 hash/integrity 与发布产物一致，installed manifest 正确，`pspore --version` 与 `--help` 成功，临时目录已删除。
- 当前状态：v1 共享客户端内核与 npm CLI 发布阶段完成；当前无常驻服务，本阶段无前端视觉改动，不需要新的 viewport 验收。
- 遗留问题：真实 sudo 仍未执行；sandbox/vector/remote/mobile 继续为明确非目标。

## 2026-08-13 09:30 CST — 修复 npm 安装后命令不存在，并统一 CLI/npm 页面为英文

- 阶段目标：消除 `npm install --global p-spore` 之后 `p-spore` 命令不存在的问题，并让 npm 展示页与 CLI 文案面向 CLI 用户、全部使用英文。
- 完成内容：
  - 复现根因：包名为 `p-spore`，但 `bin` 只映射 `pspore`，全局安装只生成 `pspore` 一个 symlink，用户按包名执行 `p-spore` 必然 command not found。
  - `bin` 增加 `p-spore` 别名，与 `pspore` 指向同一入口，两者等价；版本升到 `0.1.1` 以便发布修复。
  - `resolveInvokedName` 按 `process.argv[1]` basename 回显用户实际使用的命令名，help usage 与 `status`/`tui` 提示不再硬编码 `pspore`。
  - 端到端安装验证时发现并修复一个真实缺陷：`BIN_ALIASES` 常量原本声明在顶层 entrypoint 调用之后，`--help` 在 TDZ 中崩溃（`Cannot access 'BIN_ALIASES' before initialization`）；常量已上移到 `runCli` 之前。
  - 新增以子进程方式执行 entrypoint 的回归测试，覆盖 import 无法发现的初始化顺序问题；已先注入缺陷确认该测试会失败。
  - README 重写为英文、面向 CLI 功能（安装、双命令、模型配置、日常命令、cron job、child agent、MCP、skills/plugins、安全模型），原中文项目文档移至 `docs/project-overview.md`，不再作为 npm 展示页。
  - CLI/TUI 唯一中文文案 `主会话` 改为 `Main session`。
- 修改文件：`package.json`、`src/version.ts`、`src/cli/main.ts`、`src/ui/shared/presentation.ts`、`test/unit/cli-config.test.ts`、`README.md`（新英文页）、`docs/project-overview.md`（由原 README 移动）、`memory-bank/*.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、89 项测试（新增 2 项）与 production build 全部成功。
  - `npm pack` 后在全新临时 prefix 全局安装：`bin/` 同时生成 `p-spore` 与 `pspore` 两个 symlink；经 PATH 执行 `p-spore --version`、`p-spore --help`、`pspore --help`、`p-spore init`、`p-spore status` 均符合预期，且 `status` 提示正确回显 `p-spore daemon`。
  - 对照验证：从 registry 安装的已发布 `p-spore@0.1.0` 只生成 `pspore`，执行 `p-spore` 报“没有那个文件或目录”，确认为用户报告的同一问题。
- 当前状态：修复已在本地打包产物上端到端验证；本阶段无常驻服务与前端视觉改动，不需要新的 viewport 验收。`0.1.1` 尚未发布到 npm。
- 遗留问题：Electron 桌面 renderer 仍为中文文案，本次未改（用户本次只要求 CLI 英文）；已记入 todo。

## 2026-08-13 09:52 CST — `p-spore@0.1.1` 发布并完成 registry 实装验证

- 阶段目标：把 `p-spore` 命令缺失的修复正式发布到 npm，并以全新用户视角验证。
- 完成内容：
  - `npm login` 会话已过期，重新以浏览器 web 流程登录（`ljdavns`）；未读取、粘贴或保存 token/OTP。
  - 首次 `npm publish` 在非 TTY 后台进程中直接以 `EOTP` 失败，且 npm 把 2FA URL 在 stdout 和 debug log 中都打码为 `***`；改用 `script` 分配伪终端重跑，取得完整 URL 并由浏览器完成 2FA。
  - `p-spore@0.1.1` 发布成功，`latest` 指向 `0.1.1`；远端 manifest 同时包含 `pspore` 与 `p-spore` 两个 bin。
- 修改文件：无源码改动（发布 `f625261` 已提交的内容）；本次仅更新 `memory-bank/*.md`。
- 验证方式与结果：
  - `prepublishOnly` 的 `npm run check` 在发布前自动通过：typecheck、89 项测试、build 全绿。
  - 远端 `dist.shasum` `3de29b49bac96dc9d70795cb9ec07f02000c22a7` 与本地 `npm pack` 产物一致；`integrity` 为 `sha512-ems5KA+Fe5e3u...myDScMWCEbnDA==`；261 files、267.3 kB。
  - 全新 cache + prefix 从 registry 安装 `p-spore@0.1.1`：`bin/` 同时生成 `p-spore` 与 `pspore`；`--version`、`--help`、`init`、`doctor`、`status` 均正常，help usage 正确回显所用命令名。
  - 从仓库外启动 daemon 成功（`ready`，UDS socket 建立），`status` 与 `jobs` 经 UDS 正常返回，daemon 干净退出（exit 0）。
  - 临时 cache/prefix/home 已全部删除。
- 当前状态：用户报告的“安装后命令不存在”问题已在 registry 上修复并验证。当前无常驻服务，本阶段无前端视觉改动，不需要 viewport 验收。
- 遗留问题：当 `PSPORE_HOME` 导致 UDS 路径超过 108 字节时，daemon 只报 `listen EINVAL: invalid argument`，错误信息不明确；已记入 todo。Electron renderer 中文文案仍未英文化。

## 2026-08-13 10:30 CST — 首次启动 TUI 推荐进入模型配置 wizard

- 阶段目标：用户首次启动、尚无模型配置时，主动推荐进入配置 wizard，并由用户 y/n 确认，不强制。
- 完成内容：
  - `LlmSettingsService.isModelConfigured()`：以 `config.model !== null` 为判定，与 Daemon 触发 `model_not_configured` 的门槛完全一致；通过 config.json + 环境变量凭据配好的用户不会被反复打扰。
  - `TuiSettingsPort` 增加可选 `isModelConfigured()`；TUI `run()` 启动后调用 `#offerModelSetup()`。
  - 未配置时展示 `Model setup recommended` 面板并询问 `Run the model setup wizard now? [Y/n]`；直接回车或 y/yes 进入既有 6 步 wizard，n/no 或 Esc 跳过并提示 `/config wizard`。
  - 决策逻辑抽为纯函数 `acceptsModelSetupOffer` 与常量 `MODEL_SETUP_OFFER_PROMPT/LINES`，可单元测试。
  - 真机验证时发现并修复一个自写缺陷：`#offerModelSetup` 从 `run()` 以 `void` 调用，不经过 `#submit` 的 `finally { requestRender() }`，导致拒绝路径改了 store 却不重绘，界面仍停在推荐面板；已按既有模式补 `finally` 重绘。
- 修改文件：`src/settings/llm-settings-service.ts`、`src/ui/tui/tui-app.ts`、`test/unit/cli-config.test.ts`、`test/unit/tui-store-view.test.ts`。
- 验证方式与结果：
  - `npm run check` 通过：typecheck、92 项测试（新增 3 项）、build 全绿。
  - 真实 TUI 在 PTY 下端到端验证（注意 raw 模式回车是 `\r` 而非 `\n`）：全新 home 弹出推荐面板；回车进入 `1/6 provider`；`n` 与 Esc 均显示 `Skipped model setup…` 并退回会话；完整走完 6 步后 `config.json` 写入 `{"provider":"deepseek","model":"deepseek-v4-flash","thinking":"off"}`；用已配置 home 再次启动不再提示。
  - 临时 home 与日志已清理。
- 当前状态：首启动引导已可用，未改变既有 `/config wizard` 行为与 CLI `config` 语义。TUI 主基准 `160×45` 未改布局，本次仅新增面板与问句。
- 遗留问题：TUI 顶栏在尚无会话时恒显示 `model not configured`（读的是 `selected?.model` 而非配置），属既有显示问题，已记入 todo；桌面端未加同样引导。

## 2026-08-13 10:47 CST — `p-spore@0.1.2` 发布（首启动模型配置引导）

- 阶段目标：把首次启动推荐进入模型配置 wizard 的能力发布到 npm。
- 完成内容：
  - 版本升到 `0.1.2`（`package.json`、`src/version.ts`、lockfile 同步）。
  - 首次 `npm publish` 因 2FA 认证链接在点击前过期失败（`E404 GET /-/v1/done?authId=***`），registry 未产生任何版本；确认 `0.1.2` 未被占用后重试。
  - 重试改用 `--ignore-scripts` 跳过发布前重复的 `prepublishOnly`，让 2FA 链接立即出现、把完整有效期留给点击；等价校验已在发布前手动执行并确认 `dist/` 为 0.1.2 最新构建。
  - `p-spore@0.1.2` 发布成功，`latest` 指向 `0.1.2`。
- 修改文件：`package.json`、`package-lock.json`、`src/version.ts`、`memory-bank/*.md`。
- 验证方式与结果：
  - 发布前 `npm run check` 通过：typecheck、92 项测试、build 全绿。
  - 远端 `dist.shasum` `7f26f90ef739dffe4073e457e3b8a0b2d9a9654b`；全新 cache + prefix 安装 `p-spore@latest` 得到 `0.1.2`，`p-spore` 与 `pspore` 两个 bin 均生成。
  - 用 registry 安装的产物在 PTY 中真实首启动：全新 home 正确弹出 `MODEL SETUP RECOMMENDED` 面板与 `Run the model setup wizard now? [Y/n]`；`p-spore --version` 为 `0.1.2`。
  - 临时 cache/prefix/home 已清理。
- 当前状态：首启动引导已在 registry 上可用并验证。无常驻服务，本阶段无前端视觉改动。
- 遗留问题：TUI 顶栏无会话时恒显示 `model not configured`；桌面端未加同样引导；Electron renderer 中文文案未英文化。

## 2026-08-13 16:20 CST — Cowork TUI 活动体验与 DeepSeek 桌面/记忆验证（0.1.4）

- 阶段目标：以真实 `deepseek/deepseek-v4-flash` 执行桌面文件、系统诊断与长期记忆任务，记录基线后优化 TUI 的 cowork 表现，并确保活动核心同步用于 Electron GUI。
- 优化前真实基线：
  - 行程计划文件创建：1 次 `edit`，5.581 s，正确生成总额 `¥1180`。跨文件摘要正确，但多执行 1 次不必要的 `shell ls`。
  - 系统检查中 `node --version 2>/dev/null` 被误判为 device mutation，需要 1 次人工审批；批准后生成正确 `system-check.md`。
  - 长期偏好保存：14 次工具、8 次 `memory_curate` 参数失败、25.899 s；根因为工具实现要求 `session:/run:/file:` source，但 model-facing schema 未公开格式。最终用 `session:main` 成功，Daemon 重启后 1.941 s 可无工具召回。
- 完成内容：
  - 新增 `src/ui/shared/activity.ts`，将 tool started/updated/completed 按 `toolCallId` 合并成一个 `CoworkActivity`，统一 cowork 语义 label、target、running/succeeded/failed、result、duration 与 8 KB 脱敏详情；同时保留 run/compaction/retry/error/automation/agent/integration 活动。
  - TUI 区分 user 蓝、pSpore 绿、working 琥珀、success 绿、failure 红、memory 紫，并尊重 `NO_COLOR`/`TERM=dumb`；顶栏会以 120 ms spinner 在 Thinking / Writing response / 当前工作步骤间切换。
  - 会话不再重复显示 raw tool message，改为 `WORK STEPS` 卡片；`/work` 查看历史，`/work <ID-prefix>` 查看脱敏详情。配置 wizard 增加进度和步骤说明，顶栏在无 session 时回退显示已保存 model。
  - Electron renderer store 消费同一 `CoworkActivity` reducer，工具卡在原位更新状态点、语义 label、目标和结果，技术详情保持可折叠，其他活动不回退。
  - `memory_curate` schema 补齐 exact hash 与 source 格式；Shell risk 仅从 device 写入检测中排除精确 `/dev/null` 重定向，其他 `/dev/*` 仍需审批。
- 优化后真实 DeepSeek 结果：
  - 系统检查：4 次 `shell` + `edit` + `read`，8.487 s，0 失败、0 审批，正确生成 `system-check.md`。
  - 长期记忆：1 次 `read` + 1 次 `memory_curate`，6.690 s，0 失败，仅新增 1 条。Daemon 重启后 3.629 s 无工具正确召回“中文、开头决策、随后负责人与截止日期”。
  - 真实 TUI 文件任务：`edit` 从 `Updating file` spinner 原位变为 `Updated file`，显示 `92 B written · 14 ms`；生成的 `tui-brief.md` 内容精确，`/work` 历史与详情面板均正常。
- 验证方式与当前结果：针对性 typecheck 与 20 项 TUI/desktop/memory/policy 测试通过；`npm run check` 通过严格 typecheck、94 项测试和 production build；真 TTY 在 `160×45` 和 `96×30` 验证配色、动画、换行、工作历史与详情无溢出；`npm run test:electron` 通过 `1920×1080`、`1440×900`、`1180×720`、双主题、设置、owned/external Daemon、重连与 IPC allowlist。
- npm 发布门禁：`npm pack` 生成 265 entries、282293 bytes，SHA-1 `29939fc938e4e879c825ab24dcaf26508d11787f`，顶层只有 README/`dist`/`package.json`；全新 cache + prefix 安装后 `p-spore`/`pspore --version` 均为 0.1.4，从仓库外运行 help 成功，临时产物已清理。
- 发布结果：功能与版本提交 `c9d0152` 已 push 到 `origin/main`；通过 npm 短时浏览器 WebAuthn 流程发布 `p-spore@0.1.4`，未读取或保存 token/OTP。Registry 直连确认 `latest=0.1.4`、SHA-1 `29939fc938e4e879c825ab24dcaf26508d11787f`、SHA-512 `sha512-yIttaEGj5xw6hI4nae++7DMLowLr99RWkJgR6MASYHWvbOijba+0tgfiaaFobJf5TNFC3wPe2toVN/HEzebl4w==`，与本地包一致。
- Registry 实装：全新 cache/prefix 安装指定的 `p-spore@0.1.4`，`p-spore`/`pspore` 均报告 0.1.4；从远端包初始化全新 home、启动 Daemon 到 `ready`，`status`/`jobs` 经 UDS 成功，SIGTERM 后 socket 已清理。
- 当前状态：0.1.4 已在 GitHub main 与 npm registry 发布并完成全新用户实装验证；最新 `dist/` 已构建，验收 Daemon/TUI/Electron 进程全部停止，DeepSeek/npm 临时 home、临时凭据副本、发布认证 transcript 与安装目录已删除（不可恢复，均为本轮临时产物）。
- 遗留问题：桌面端首次启动引导、UDS 超长路径提示、Electron renderer 英文化未纳入本轮；sandbox/vector/remote/mobile 仍为非目标。

## 2026-08-13 16:54 CST — 0.1.4 Electron GUI AppImage 重新发行

- 阶段目标：为已发布的 npm 0.1.4 生成同版本 Linux x86_64 GUI AppImage，直接从发行包完成启动、视觉和安全验收后创建 GitHub Release。
- 完成内容：使用 Electron 43.3.0 / electron-builder 26.15.3 从提交 `d12bcbb` 构建 `release-dist/pspore-desktop-0.1.4-linux-x64.AppImage`；包内含最新共享 `CoworkActivity` reducer、TUI/GUI 工具语义与 0.1.4 版本元数据。
- 产物：156,349,369 bytes，mode `0755`，SHA-256 `02a3d74d669977284019c9ba623c42ccc912dee666337db60e2a74c79baad017`，Linux x86-64 ELF/AppImage 结构可执行。
- AppImage 本体验证：从全新临时 home 直接启动 AppImage，`daemonOwnership=owned`、`connection=connected`、reconnect 通过，退出后 socket/endpoint 均清理。检查 `1920×1080` 深/浅主题、设置/审批，以及 `1440×900`、`1180×720` 响应式布局；无 document overflow，composer/检查器可见，字号下限、password input、密钥不回读和 IPC allowlist 断言全部通过。人工检查 1920×1080 与 1180×720 截图无明显遮挡/溢出。
- 发布结果：发行前记录提交 `a2f9cef` 已 push；签名标签 `v0.1.4` 已 push 并以 `pSpore v0.1.4` 创建公开 GitHub Release，成为 Latest。远端资产 `pspore-desktop-0.1.4-linux-x64.AppImage` 的 media type 为 `application/vnd.appimage`，size 为 156,349,369 bytes，GitHub digest 为 `sha256:02a3d74d669977284019c9ba623c42ccc912dee666337db60e2a74c79baad017`。
- 远端反向验证：从 GitHub Release 全新下载该资产，重新计算 SHA-256 与本地/GitHub digest 完全一致，`file` 确认仍为 Linux x86-64 ELF/AppImage；下载验证目录已删除。Release URL：`https://github.com/advnljs/pSpore/releases/tag/v0.1.4`。
- 当前状态：0.1.4 GUI AppImage 已在 GitHub Release 发布并完成发行包本体与远端下载双重验证；本地构建产物保留在 ignored `release-dist/`，其他构建中间目录、smoke home/截图/报告和 release notes 临时文件已删除（不可恢复，均为本轮临时产物）。
- 遗留问题：electron-builder 依旧使用默认 Electron 图标且未设置 `desktopName`/WM_CLASS，不影响启动、布局或安全验收，已记录为后续打包体验待办。

## 2026-08-13 11:20 CST — CLI 侧补齐配置引导入口（0.1.3 待发布）

- 阶段目标：用户反馈裸跑 `p-spore` 只看到帮助、看不到配置引导入口；把引导补到 CLI 本身，而不只在 TUI 内。
- 完成内容：
  - 新增 `p-spore setup` 命令（`config wizard` 为同义写法），CLI 原生 5 步引导：provider、model、custom 时的 Base URL/API、thinking、API key；不依赖 TUI。
  - 裸跑 `p-spore`（无任何参数）且 `config.model` 为空时，先输出说明与 `setup` 指引；在交互式 TTY 下追加 `Run the model setup wizard now? [Y/n]`，接受即进入引导，拒绝则打印帮助。
  - `--help`/`help` 显式请求时只加指引横幅、不提问，保持可脚本化。
  - `helpText()` 增加 `setup` 与 `config wizard` 两行，使入口可被发现。
  - 新增 `readLineInput()` 明文单行输入；API key 仍走既有隐藏输入 `readSecretInput()`。
  - `modelNeedsSetup()` 在 home 尚不存在时判定为未配置，且不会因此创建目录；settings 异常不遮挡帮助输出。
- 修改文件：`src/cli/main.ts`、`test/unit/cli-config.test.ts`、`package.json`、`package-lock.json`、`src/version.ts`。
- 验证方式与结果：
  - `npm run check` 通过：typecheck、92 项测试、build 全绿；entrypoint 测试改为隔离临时 home，同时断言未配置时出现指引、配置后指引消失。
  - PTY 真机验证（注意 `script` 必须带 `-f` 才会实时刷新日志，否则轮询读不到输出）：裸跑弹出 `[Y/n]`，回车后依次走完 1/5→5/5，`config.json` 写入 `{"provider":"deepseek","model":"deepseek-v4-flash","thinking":"off"}`，并正确提示尚未配置 API key。
  - 已配置后裸跑不再出现指引横幅；`--help` 可见 `setup` 与 `config wizard`；非 TTY 下 `setup` 明确报错并指向 `config set`。
  - 临时 home 已清理。
- 当前状态：`p-spore@0.1.3` 已于 2026-08-13 11:26 CST 发布，`latest` 指向 0.1.3；全新 cache/prefix 从 registry 安装后，裸跑即出现引导、完整走完 5 步并写入 `config.model`、配置后引导消失，均已验证。
- 遗留问题：TUI 顶栏无会话时恒显示 `model not configured`；桌面端未加同样引导；Electron renderer 中文文案未英文化。

## 2026-08-17 21:34 CST — GUI/TUI 全面视觉与可用性优化（spore print 设计语言）

- 阶段目标：用统一的视觉识别重做 Electron 桌面端与 TUI 的呈现层，修掉主基准下的空区、层级失衡与文案不一致，信息架构与全部功能保持不变。
- 设计方向：确立 "spore print" 设计语言。深色为暖腐殖土底 `#141310` + 骨白文字，浅色为暖纸 `#ede9dc` + 墨字；`--accent`（骨白/墨）只用于主操作、焦点环与选中文本，饱和色留给状态语义：`--live` moss=存活/成功、`--honey`=等待/审批、`--rust`=失败、`--lichen`=用户消息。标识符（session id、会话标题、指标、状态、代码）统一 mono，人类语句用 sans。
- 桌面端完成内容：
  - 重写 `styles.css` 全量 token 与组件层；圆角 13/9/6、去掉发光与重阴影，`select` 用自绘 chevron，禁用态可见，`.composer:focus-within` 有明确焦点环。
  - 会话正文测量宽度收敛到 `820px`（原 980px），长代码块恢复容器内横向滚动；message meta 改为 mono 标签 + 细线分隔；代码块前后多余空行由 `appendRichText` 修剪。
  - 左栏用 `--session-depth` + `└` 型连接线呈现 agent 树，右侧标记从无意义的 `ROOT/L1` 改为真实会话状态；底部常驻 `工作区` 摘要（运行/MCP/资源/待批准），与 TUI WORKSPACE 同源指标，填掉长期空区。
  - `>=1600px` 默认打开检查器（此前 1920×1080 主基准右侧长期空白）；`1321–1599` 会话+对话双栏、`<=1320` 检查器抽屉、`<=1160` 会话栏抽屉，行为不变。
  - 审批弹层重新分配视觉权重：`拒绝` 为中性实心默认焦点，允许类操作改为 honey 描边（不再把“允许”做成最亮按钮）。
  - 设置弹层去掉装饰性 `01/02/03` 编号；全局删除 8 处装饰性 eyebrow，只保留 `ACTIVE SESSION` 与 `PERMISSION REQUIRED` 两个真正在标注内容的标签。
  - 空会话状态改为可点击的三条真实本地任务示例，点击填入输入框而不直接发送。
  - GUI 文案统一中文（notice、错误、空状态、工具输出摘要）；浅色主题 `--faint` 提到 `#746d5c` 以满足 4.5:1 小字对比度，并新增 `prefers-contrast: more` 兜底。
- TUI 完成内容：
  - 配色与桌面语义对齐（brand/bone 187、live 108、agent 151、lichen 109、honey 179、rust 174、memory 182、muted 245、faint 242）。
  - header/context 行改为左右分栏（`sideBySide`），会话内容自输入行向上生长（`anchorBottom`），左栏 SESSIONS 置顶、WORKSPACE 贴底（`composeColumn`）；子 agent 用 `└─` 分枝。
  - 消息角色改为固定 8 列 gutter 对齐；footer 去掉多余分隔线，节省一行正文空间；help 行的命令 token 用 bone 高亮；空会话给出三条英文示例任务。
- 修改文件：`src/desktop/renderer/styles.css`、`index.html`、`renderer.ts`、`store.ts`、`src/ui/tui/view.ts`、`test/unit/tui-store-view.test.ts`、`memory-bank/module-desktop.md`、`memory-bank/module-interface-protocol.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、94 项测试、production build 全绿。
  - `npm run test:electron` 通过：1920×1080 主基准 + 1440×900 + 1180×720，双主题、设置、审批、owned/external Daemon、重连、字号下限与 IPC allowlist 断言全部通过；逐张人工检查深色/浅色/设置/审批/响应式截图。
  - 修复前基线 smoke 实际是失败的（`long code did not exercise contained horizontal scrolling`：980px 测量宽度下 fixture 长代码不再溢出）；收敛测量宽度后该断言恢复真实覆盖。
  - TUI `160×45` golden snapshot 哈希更新为 `95a5f403…1db57a9c`，并新增两条结构断言（对话贴近输入行、WORKSPACE 位于 SESSIONS 之下）；`96×30` 单栏渲染同步核对。
- 当前状态：最新代码已构建到 `dist/`，桌面 smoke 与全量测试均基于当前工作树；本轮验收用的 Daemon/Electron 进程已随 smoke 结束退出，临时 home 与截图位于系统临时目录，未进入仓库。
- 遗留问题：`src/ui/shared/activity.ts` 的 cowork label/summary 仍是英文（TUI/CLI 要求英文且两端共用），中文 GUI 内呈现为混排；transcript 每次渲染整树重建，长会话下有性能风险，均已记入 `todo.md`。

## 2026-08-18 — GitHub Actions 自动构建 GUI 并发布到 Release

- 阶段目标：增加 GitHub CI，在推送版本 tag 时自动构建 Linux Electron GUI AppImage 并放到 GitHub Release。
- 完成内容：
  - 抽出共享打包配置 `electron-builder.yml` 与脚本 `scripts/package-desktop.sh`，产物仍为 `pspore-desktop-<version>-linux-x64.AppImage` 及 SHA-256。
  - `package.json` 增加 `package:desktop`；本地 `scripts/release.sh` 改为调用同一打包脚本，并在 Release 已存在时上传而不是失败。
  - `.github/workflows/ci.yml`：PR 与 `main` 上运行 `npm run check`，并校验提交的 `dist/` 与当前构建一致。
  - `.github/workflows/release.yml`：推送到 `main` 或与 `package.json` 版本一致的 `v*` tag 时构建 AppImage，并直接创建或更新 `v<version>` GitHub Release（不再只留在 Actions artifact）。
- 修改文件：`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`electron-builder.yml`、`scripts/package-desktop.sh`、`scripts/release.sh`、`package.json`、`memory-bank/*.md`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、94 项测试、production build 全绿；`git diff --exit-code -- dist` 无差异。
  - 本环境用 Node `v24.19.0` 执行 `bash scripts/package-desktop.sh 0.1.4`：electron-builder `26.15.3` 产出 `release-dist/pspore-desktop-0.1.4-linux-x64.AppImage`（约 150M，mode `0755`，ELF x86-64），SHA-256 `8bebd70eff1ffceb88245637081b8ee2250ad09321b0650f58c1541c14c072f4`。本地产物在 ignored `release-dist/`，未提交。
  - 顺带修复 `scripts/release.sh` / `package-desktop.sh` 的 Node 主版本检查（原先把 JS `true` 误当成 `"1"`，会在 Node 24 上误报不合格）。
- 当前状态：CI 与 Release 工作流已加入仓库并完成本地打包验证。合并到 `main` 后，Release 工作流会把 AppImage 直接上传到 `v<package.version>` GitHub Release。
- 遗留问题：electron-builder 默认图标与 WM_CLASS 仍待补齐；AppImage 本体视觉 smoke 仍需在发行前按既有约束从包本身跑 `--smoke-dir/--smoke-fixture`。

## 2026-08-20 — 桌面 zip 发行、纵向铺满与 LLM 代理 Cookie

- 阶段目标：把 GUI 发行从 AppImage 改为可解压的压缩包（含一键创建桌面快捷方式），另提供不含 Chromium 的 overlay 覆盖升级包；修复主界面初始未纵向铺满；调用 LLM proxy API 时支持设置 Cookie。
- 完成内容：
  - 版本升到 `0.1.5`。
  - `electron-builder.yml` 改为 linux `dir`；`scripts/package-desktop.sh` 产出全量 `pspore-desktop-<version>-linux-x64.zip`（含可执行 `创建桌面快捷方式.sh`）与 overlay `pspore-desktop-<version>-linux-x64-overlay.zip`（仅 `resources/app.asar` + `覆盖升级.sh`）。
  - 共享 LLM settings 增加可选 Cookie：私有文件 `credentials/<provider>.cookie`（`0600`），`models.json` 通过 `headers.Cookie` 的 `!cat` 引用，GUI/TUI/CLI 同步，read API 只返回 `hasCookie`。
  - 桌面 CSS 改为 `body` flex + `.app-shell`/`workspace-grid`/`panel` 纵向拉伸，去掉初始 `translateY` 动画，首屏铺满窗口高度。
- 验证方式与结果：
  - Node `v24.19.0`：`npm run check` 95 项测试、typecheck 与 production build 通过。
  - `npm run test:electron`：1920×1080 / 1440×900 / 1180×720、双主题、设置 password（含 Cookie）、密钥不回读通过。
  - 本地打包：全量 zip 147M，SHA-256 `c1e3531777361e57115d1cf29b5a97c42111d91affc07673272c9db32b6079b9`；overlay zip 21M，SHA-256 `813fab8e001eb4c7fd3a4fb4a4e5ba7ed09c4f64356de3ed37ebd8c42856868a`。
- 当前状态：代码与 `dist/` 已更新；GitHub Release `v0.1.5` 上传全量 zip 与 overlay zip。

## 2026-08-21 — GUI Markdown 渲染、Bypass 授权模式与首屏铺满修复

- 阶段目标：增强桌面端 Markdown 渲染；提供跳过所有授权确认的 bypass 选项；修复 GUI 初始未占满窗口高度。
- 完成内容：
  - 新增共享纯解析器 `src/ui/shared/markdown.ts`（CommonMark/GFM 子集）：ATX 标题、围栏代码（含 streaming 未闭合围栏）、引用、有序/无序/任务列表与嵌套、分隔线、GFM 表格与对齐、行内 code/strong/em/strike/链接与转义；带深度上限，非法或不成对标记原样保留。
  - 新增 `src/desktop/renderer/markdown-view.ts` 只用 `createElement`/`textContent` 构建 DOM（不使用 `innerHTML`，符合既有 CSP 与渲染约束）；代码块带语言标签与复制按钮（`navigator.clipboard` 失败时回退 `execCommand`）；链接因主进程禁止外部导航而渲染为惰性文本 + 可复制 URL，非 http/https/mailto/file 协议不识别为链接。
  - `renderMessage` 与 streaming 消息统一走 Markdown 渲染，`styles.css` 增加 spore print 风格的标题、列表、任务勾选、引用、表格（自身横向滚动）、行内 code 与链接样式。
  - 共享 settings 契约增加 `permissionMode`，写入 `config.permissions.mode`：GUI 设置弹层新增“权限”区与 bypass 风险告警；TUI `/config permissions MODE`；CLI `config permissions MODE`（`bypass` 为 `allow_all` 别名），`config show` / `/config` 均显示当前模式。owned Daemon 保存后自动重启生效，external Daemon 提示重启。
  - 修复首屏纵向留白：`.app-shell` 由固定三行 grid 改为 flex column（连接横幅 `display:none` 时原模板仍保留空轨道与 8px gap）；`desktopWindowOptions` 按主显示器 work area 收敛初始尺寸（1920×1080 content 在 1080p 屏上原本超出屏幕底部 31px），首次显示时 `maximize()`；窗口 `backgroundColor` 对齐 `--canvas`。
  - Electron smoke 新增断言：`app-shell` 高度等于 viewport、workspace 底部留白 ≤12px（三档分辨率均校验）、权限下拉选项固定四项、切到 bypass 时风险告警出现且切回后消失。
- 修改文件：`src/ui/shared/markdown.ts`、`src/desktop/renderer/markdown-view.ts`、`src/desktop/renderer/renderer.ts`、`src/desktop/renderer/index.html`、`src/desktop/renderer/styles.css`、`src/desktop/main.ts`、`src/desktop/security.ts`、`src/desktop/smoke-fixture.ts`、`src/settings/llm-settings.ts`、`src/settings/llm-settings-service.ts`、`src/cli/main.ts`、`src/ui/tui/tui-app.ts`、`src/ui/tui/commands.ts`、`README.md`、`test/unit/markdown.test.ts`、`test/unit/desktop-settings.test.ts`、`test/unit/desktop-security.test.ts`、`test/unit/desktop-ipc-validation.test.ts`、`test/unit/cli-config.test.ts`、`memory-bank/*.md`。
- 验证方式与结果：
  - Node `v24.19.0`：`npm run check`（typecheck + 128 项测试 + production build）通过。
  - `npm run test:electron` 通过：1920×1080 主基准与 1440×900、1180×720 补测，双主题、设置、字号、owned/external Daemon、重连、IPC allowlist，以及新增的铺满与 bypass 告警断言。
  - Xvfb 实测窗口尺寸：1920×1080 屏由原先 content bottom 1111（越界 31px）收敛为 1079；1366×768 与 2560×1440 下 `app-shell` 高度均等于 viewport，workspace 底部仅剩 10px 设计留白。
  - Markdown 解析器 16 项单测覆盖标题/围栏/未闭合围栏/列表切换/任务项/表格/行内标记/危险链接协议/深度上限。
- 当前状态：版本升到 `0.1.6`，源码与 `dist/` 已同步重建并推送到 `main`（commit `98888cb`）。GitHub Actions `CI` 与 `Release desktop` 均 success，已发布 https://github.com/advnljs/pSpore/releases/tag/v0.1.6 ，含 `pspore-desktop-0.1.6-linux-x64.zip` / `-overlay.zip` 及各自 SHA-256。 已按发行验收要求直接从 Release 下载全量 zip，`sha256sum -c` 通过，并用包内 `pspore-desktop --smoke-dir --smoke-fixture` 在 Xvfb 2048×1200 下跑通全部断言（owned Daemon、双主题、三档布局、`app-shell` 高度 1080/900/720、workspace 底部留白均为 10px、权限四模式与 bypass 告警）。
- 遗留问题：Markdown 链接仍不可点击跳转（主进程按安全基线禁止外部导航）；`allow_all` 只是策略放开，不构成沙箱；本轮未发布 npm 新版本。

## 2026-08-22 — 打包流程并入本地 release 二进制包

- 阶段目标：按用户新 spec，让每次打包在本地同时生成 CLI release 二进制包，且二进制产物保持被 Git 忽略。
- 完成内容：
  - 新增 `scripts/build-cli-binary.sh`：从 `dist/cli/main.js` 经 esbuild CJS bundle、`import_meta` 补丁、Node SEA blob 与 postject 注入，产出 `release-dist/pspore-<version>-linux-x64`，并自检 `version` 与 `--help`；完成后清理中间产物（bundle/blob/sea-config）。
  - `scripts/package-desktop.sh` 在产出全量 zip 与 overlay zip 后调用上述脚本，`npm run package:desktop` 现在一次性生成桌面双 zip + CLI 二进制。
  - `scripts/release.sh` 删除内联 SEA 构建逻辑，改为复用 `build-cli-binary.sh`，上传行为与产物清单不变。
  - `memory-bank/specs.md` 增加对应约束与本地打包验收标准（2026-08-22）。
- 验证方式与结果：
  - `npm run package:desktop` 实跑通过：全量 zip 147M（sha256 `1b09c93d…265c008`）、overlay zip 21M（sha256 `7627bd6c…85d039c`）、CLI 二进制 140M。
  - 二进制自检：`pspore-0.1.6-linux-x64 version` 输出 `pSpore 0.1.6 (Pi 0.84.1, Node 24.19.0)`，`--help` 正常（50 行）。
  - `git check-ignore` 确认二进制与 zip 均被 `.gitignore` 的 `release-dist/` 规则忽略，`git status` 无打包产物。
- 当前状态：脚本改动与 memory-bank 已提交；`release-dist/pspore-0.1.6-linux-x64` 留在本地供直接使用。
- 遗留问题：CI（`release.yml`）仍只上传桌面双 zip，不上传该 CLI 二进制（沿用 `scripts/release.sh` 手动发布路径）；如需 CI Release 也附带二进制需另行确认。

## 2026-08-22（下午）— 本地 release 产物管线固化

- 阶段目标：落实"每次都构建和 release 一样的可执行二进制目录到本地"的 spec，并补齐 GUI 重构后缺失的最新打包。
- 完成内容：
  - `scripts/package-desktop.sh` 新增步骤：每次打包自动把 staging 内容复制为 `release-dist/pspore-desktop-<version>-linux-x64/` 可执行目录（与全量 zip 内容一致，等价 release.sh 的解压结果）。
  - 重新执行 `npm run package:desktop`：全量 zip、overlay zip、sha256、SEA CLI 二进制、可执行目录全部刷新至 c688a50（含 cobalt paper GUI + GSAP vendor），已用 grep 确认 app.asar 内含新样式与 gsap 脚本引用。
- 验证方式与结果：
  - 打包脚本 exit=0；CLI 二进制自检 `--help` OK；产物时间戳与内容核验通过。
- 当前状态：spec 已记录到 `memory-bank/specs.md`，本地产物与最新代码一致。
- 遗留问题：无新增。

## 2026-08-26 — 生产 Daemon 改由 systemd 用户服务托管

- 阶段目标：让完整 pSpore 后端成为可自动注册、登录后自启、异常重启的系统服务；GUI/TUI 仅作为客户端壳，退出时不再关闭后端。
- 完成内容：
  - 新增 `SystemServiceManager`，以私有、原子方式维护 XDG `systemd/user` unit，执行 `daemon-reload`、`enable --now`、重启、状态、日志和卸载；unit 不经 Shell 启动，包含 `Restart=always`。
  - 新增 Node/npm、SEA 和 Electron-as-Node 三类稳定启动命令生成器；默认 home 使用 `pspore.service`，自定义 home 使用稳定哈希 unit 名，避免多实例冲突。
  - CLI 新增 `service install|start|restart|stop|status|logs|uninstall`；TUI 启动时自动确保服务已安装并运行，退出只断开连接。
  - Electron 生产启动自动确保 systemd 服务并仅维护 UDS bridge；设置保存后重启服务并重连。桌面 smoke 测试继续使用隔离的 `DaemonSupervisor`，不污染真实用户服务。
  - 启动前会温和关闭旧版非 systemd 管理的 Daemon，以避免旧锁和 socket 阻止迁移；尝试启用 user linger，并在权限不足时返回可理解警告。
- 修改文件：`src/service/*`、`src/cli/main.ts`、`src/desktop/main.ts`、`test/unit/system-service.test.ts`、`README.md`、`docs/project-overview.md`、`memory-bank/*`，以及同步构建的 `dist/`。
- 验证方式与结果：`npm run check` 通过（严格 typecheck、117/117 测试、production build）；新增 4 项服务测试覆盖 unit 转义、隔离 systemd 生命周期、三类发行启动命令与多 home 命名；`git diff --check` 通过。
- 当前状态：源码与 `dist/` 已同步；生产客户端不再拥有或随退出停止后端。尚未在本阶段启动真实用户服务，待后续会话协议改造完成后用最新完整服务做端到端验收。
- 遗留问题：跨 session 恢复、自动 follow-up/队列直接发送、compact 设置、流式 Markdown/虚拟渲染和桌面快捷方式仍在本次任务后续阶段实现。

## 2026-08-26 — 多根 session 恢复与统一发送队列

- 阶段目标：支持跨客户端/跨服务重启的新建与切换 session，启动加载完整历史；删除 GUI 三模式 composer，让普通发送自动排队，并给每条 follow-up 提供“继续排队/直接发送消息”。
- 完成内容：
  - 新增私有原子 `SessionCatalog`，持久映射根 session ID、标题、时间、cwd 与 Pi JSONL；服务 ready 前逐个 `resume`，旧安装无 catalog 时只迁移最近的 legacy JSONL 为 `main`。agent/automation 临时 session 不进入目录。
  - Application 新增 `session.create`、`session.queue.send-now`；`session.prompt` 默认 `auto`，空闲时 prompt、运行中时 follow-up。根 session metadata 随 Kernel snapshot 进入 GUI/TUI；每个根 session 注册独立 subagent root。
  - Pi adapter 增加 follow-up 提升操作：清空并保持原队列顺序，把指定 follow-up 重排到 steering 队列，不重复发送消息。
  - GUI 左栏新增 `＋` 并立即切换新会话，所有 prompt/abort/compact/spawn 都使用当前 session；删除 Prompt/Steer/Follow-up 下拉。排队卡逐条显示“继续排队”和“直接发送消息”。
  - TUI 新增 `/new [TITLE]`、`/send-now N`，`/select` 可切换任意根会话及历史；普通输入不再因运行中而拒绝。CLI 新增 `sessions`、`session new [TITLE]` 与 `prompt --session ID TEXT`。
- 修改文件：`src/sessions/session-catalog.ts`、`src/application/agent-application.ts`、`src/daemon/daemon.ts`、`src/pi/pi-runtime-adapter.ts`、`src/domain/runtime.ts`、`src/agents/agent-manager.ts`、`src/ui/shared/presentation.ts`、`src/ui/tui/*`、`src/desktop/ipc-contract.ts`、`src/desktop/renderer/*`、`src/cli/main.ts`、相关测试/文档及同步构建的 `dist/`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、124/124 测试、production build。
  - 新增真实 Pi contract 验证队列提升后的用户消息顺序为“指定直接发送项 → 其余继续排队项”，且不重复；Daemon 集成测试验证多 session 创建、服务重启恢复标题/完整历史、auto follow-up 与 send-now。
  - `npm run test:electron` 通过：PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`，双主题、设置、排版、smoke Daemon ownership、重连和 IPC allowlist 全绿。
  - TUI 主基准 `160×45` golden 与 `96×30` 补测通过，并新增“继续排队/直接发送消息”逐项文案断言。
- 当前状态：源码与 `dist/` 同步构建；全部根 session 会在服务启动时加载，GUI/TUI composer 已统一。当前 smoke 使用隔离 Daemon，未改动真实用户 home/service。
- 遗留问题：自动 compact 设置、流式 Markdown/字符清理、GUI/TUI 长历史虚拟渲染和桌面快捷方式仍在后续阶段。

## 2026-08-26 15:27 CST — 自动 compact、流式 Markdown 与长历史虚拟渲染

- 阶段目标：让自动 compact 长度可配置，清理正文中的内部工具标记，并让 GUI/TUI 在恢复长历史后保持流畅。
- 完成内容：
  - `config.context.autoCompaction` 增加 `enabled/reserveTokens/keepRecentTokens`；缺少字段的旧 v1 config 自动使用 `true/16384/20000`。共享 settings 接入 GUI“自动压缩”、TUI/CLI `config compact`，保存后服务重启应用到全部新建/恢复 session。
  - Pi adapter 为每个 session 注入同一 compact 策略；assistant transcript 只提取公开 text block，不再把 tool call/thinking 合成为 `[tool:shell]` 等正文。
  - GUI streaming frame 合并到 animation frame；store 不再每帧深拷贝完整 Kernel。新增 Fenwick tree 变高虚拟列表、测量校正和 128 项消息 DOM LRU，只渲染视口与 overscan。
  - TUI store 同样复用不可变快照引用，历史从尾部反向格式化到 `rows + offset + overscan` 即停止；Braille spinner 改为兼容最小 Linux console 的 ASCII，GUI 字体链补 Emoji/Symbol fallback。
- 修改文件：`src/settings/*`、`src/config/config.ts`、`src/pi/pi-runtime-adapter.ts`、`src/daemon/daemon.ts`、`src/ui/shared/virtual-list.ts`、GUI/TUI renderer/store、smoke fixture、相关测试/文档及同步 `dist/`。
- 验证方式与结果：
  - `npm run typecheck` 通过；49 项针对性 unit/contract 测试通过，含旧 config 兼容、compact 持久化、工具标记清理、10000 条 TUI/虚拟索引性能边界。
  - `npm run test:electron` 通过；PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`。fixture 含 1007 条权威历史并断言实际 DOM 少于 40，同时覆盖 streaming Markdown、compact 设置、双主题、重连、owned/external Daemon 与 IPC 安全。
  - 首轮 smoke 捕获到 browser renderer 因共享常量误导入 Node config 模块而被 CSP 阻止；已拆出 browser-safe `compaction-settings.ts` 后在相同压力 fixture 复跑通过，未放宽 CSP。
  - `npm run package:desktop` 通过并刷新本地产物：全量 zip 149M（sha256 `3c56e6d5…23180878`）、overlay 23M（sha256 `dc65c344…569424f`）、140M SEA CLI（`version` 与 61 行 `--help` 自检通过）及可执行目录；均位于被 Git 忽略的 `release-dist/`。
- 当前状态：源码与 `dist/` 已同步构建；compact/Markdown/虚拟历史阶段完成，尚未启动真实用户 service。
- 遗留问题：Linux 快捷方式、overlay 跨版本升级验证与最终完整打包/系统服务端到端验收仍待后续阶段。

## 2026-08-27 09:40 CST — Linux 快捷方式与 `v0.1.5 → 0.1.6` 无 Chromium 升级

- 阶段目标：修复 zip 内 `.desktop` 无法启动的问题，并确认不含 Chromium 的 overlay 能从上一版真实发行物安全升级到当前版本。
- 完成内容：
  - 快捷方式安装器不再直接把安装目录和错误的 `Path="..."` 写进 Desktop Entry；改为固定 XDG launcher + `0600` 安装路径记录，launcher 进入真实安装目录后启动 GUI，并将诊断写到 `XDG_STATE_HOME/pspore/desktop-launcher.log`（1 MiB 轮转、右键可打开日志）。
  - overlay 从单个盲覆盖 `app.asar` 改为完整应用 payload（`app.asar`、`app.asar.unpacked`、`app-update.yml`），仍不包含 Electron/Chromium。manifest 固定应用版本、Electron 精确版本、Linux/x64 与目录 SHA-256；updater 使用目标 Electron-as-Node 验证兼容性和 payload，升级前后执行 CLI 自检，原子替换顶层资源，保留 `.pspore-backup-*` 并重启匹配的 systemd unit。
  - 修复 Electron ASAR hook 对完整性校验的干扰（hash 时 `process.noAsar=true`）；修复虚拟历史仍使用 CSS smooth scroll 导致 1007 条历史自动尾随停在中段的问题，改为即时窗口定位。smoke 不再要求长代码块与 streaming 尾部同时存在于同一虚拟 DOM 窗口，而是在独立捕获状态验证两者。
  - GitHub Release notes、本地 release 脚本、README 与中文项目说明已同步新的执行方式和兼容门禁。
- 修改文件：`scripts/linux/create-desktop-shortcut.sh`、`scripts/linux/apply-overlay-upgrade.sh`、`scripts/package-desktop.sh`、`scripts/release.sh`、`.github/workflows/release.yml`、`src/desktop/main.ts`、`src/desktop/renderer/styles.css`、`test/integration/release-scripts.test.ts`、同步 `dist/`、README/docs 与 memory-bank。
- 验证方式与结果：
  - 新增 3 项发行脚本集成测试：稳定 launcher/日志、完整 payload 替换+回滚+服务重启、篡改 payload 写入前拒绝；最终 `npm run check` 通过 TypeScript 检查、132/132 测试与生产构建。
  - 旧脚本生成的 `Path="..."` 被 `desktop-file-validate` 明确警告为非绝对路径；新脚本在安装目录含空格和 `%` 时通过 validator，并由隔离 XDG/HOME 下的 `gtk-launch pSpore.desktop` 实际启动到 launcher 日志。
  - 下载 GitHub `v0.1.5` 全量 zip 并通过其 SHA-256；旧目录实测 `pSpore 0.1.5 / Electron 43.3.0 x64`。应用当前 29M overlay 后变为 `pSpore 0.1.6`，Electron 仍为 `43.3.0/x64`；从该升级目录执行 Electron smoke 通过 owned Daemon、connected、1920×1080、1007 条权威历史仅 7 个消息 DOM、streaming 可见且尾部距离 0。
  - `npm run test:electron` 通过 external/owned Daemon、1920×1080 主基准、1440×900、1180×720、双主题、设置、安全与重连；人工复核升级目录的 1920×1080 明/暗截图，无明显溢出、遮挡或旧界面。
  - 最终本地产物：全量 zip 149M，SHA-256 `b4e5465109b386657fb1cc83ccb514af27e01481d0bfd3e64ff7147920510552`；overlay 29M，SHA-256 `16d620dd9f0ea9c148007d8ee9f7bf5e448612011bf53ba1e0ef1fcf36758a3c`；SEA CLI 140M，SHA-256 `b508219de7363d07b44e88489402249ba09c0256ebab416320bb27a3a73a7e84`，`version` 与 61 行 `--help` 自检通过。overlay 文件名扫描未发现 Electron/Chromium 运行时文件。
- 当前状态：快捷方式与上一版跨版本升级目标均完成；构建/视觉验收进程已退出，本地 `release-dist/` 保留最新可运行目录和被忽略的发行产物。
- 遗留问题：产品图标/WM_CLASS、GUI activity 中英混排、Markdown 外链与代码高亮等既有非本轮问题仍见 `todo.md`。

## 2026-08-27 11:03 CST — `0.1.7` 发布候选、thinking 分流与 `v0.1.6 → 0.1.7` 覆盖升级

- 阶段目标：把本周已完成的系统服务、多 session、统一发送、compact、流式/虚拟历史和安装升级修复作为新版本 `0.1.7` 发布；修正 reasoning 混入正文的问题，并用上周官方 `v0.1.6` 基线验证无 Chromium overlay。
- 完成内容：
  - 版本统一升到 `0.1.7`；增加自动测试，约束 `package.json`、`package-lock.json` 根版本和 `src/version.ts` 始终一致。
  - `message.thinking.delta` 与正文 delta 在共享 reducer、Desktop IPC/bridge、GUI 和 TUI 中拆为独立通道；GUI 使用“思考中”临时面板，TUI 使用 `thought` gutter，`message.completed` / run settle / error / session replacement 后自动清除，不进入最终 Markdown 或历史。
  - Release workflow 改为只接受匹配 package 版本的新 annotated `v*` tag；已有 tag/Release 时拒绝覆盖，普通 `main` push 只跑 CI。CLI、全量 zip、overlay zip 均生成并发布 SHA-256；预发行版本按 SemVer 后缀自动标记 prerelease。
  - 本地发布脚本改为固定 `npm ci → npm run check → 完整打包 → 六项资产/可运行目录校验 → annotated tag push`，不再调用 `gh release upload --clobber`。
- 修改文件：共享 protocol state、Desktop bridge/IPC/renderer/smoke、TUI store/view、相关 contract/unit/integration tests、版本与打包/Release 脚本、README/docs、同步构建的 `dist/` 与 memory-bank。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、135/135 测试和 production build 全绿；`release.yml` 通过 YAML parser，发布脚本通过 `bash -n`。
  - `npm run test:electron` 通过 external/owned Daemon、`1920×1080` 主基准及 `1440×900`、`1180×720`；两份报告均为 `thinkingVisible=true`、`thinkingSeparate=true`、`thinkingHiddenAfterCompletion=true`、`legacyComposerModes=0`，1007 条权威历史只渲染 7 个可见消息节点。人工复核深/浅截图，运行态思考与正文分区，完成态思考区消失。
  - 官方 `v0.1.6` tag 已拉取并确认指向上周提交 `98888cb9ee0c32f8ccd437bf7218e7437259a2db`。该 Release 创建于 8 月 21 日，但现有附件创建于 8 月 27 日，不能作为旧二进制基线；因此从 tag 的干净 detached worktree 执行 `npm ci` 和原版 `npm run package:desktop`，还原出自检为 `pSpore 0.1.6 / Electron 43.3.0 x64` 的全量安装。
  - 对还原安装应用本地 `0.1.7` overlay 成功：版本变为 `pSpore 0.1.7`，Electron 保持 `43.3.0/x64`；`pspore-desktop`、`chrome-sandbox`、`libffmpeg.so` 的升级前后 SHA-256 分别保持 `57defb64…e973d`、`d7d2a29b…43cc9`、`d80e1fdb…ff03`，并生成 `.pspore-backup-*`。从升级目录直接启动 Daemon + GUI 后连接为 `connected`，`1920×1080` smoke 与 thinking/composer/虚拟历史断言全部通过。
  - 本地 `0.1.7` 全套产物完成并通过三份 `sha256sum -c`：CLI `e6079825…f930`（146,148,544 bytes）、全量 zip `30eb5a98…950e`（155,294,013 bytes）、overlay `22774161…87b7`（29,767,197 bytes）；overlay manifest 为 `0.1.7 / Electron 43.3.0 / linux x64`，文件名扫描未发现 Electron/Chromium 运行时文件。
- 当前状态：本地 `0.1.7` release candidate 与上周基线升级验收完成；尚待提交并推送 `main`、等待 CI、创建 `v0.1.7` annotated tag、等待 GitHub Release，并从远端重新下载资产做最终复验。
- 遗留问题：旧 `v0.1.6` Release 附件已被历史流程覆盖，无法再作为上周原始二进制证据；本轮保持其现状、不再次覆盖，改以稳定 tag 源码还原。既有非本轮产品待办继续见 `todo.md`。

## 2026-08-27 15:18 CST — 修复 systemd 245 用户服务启动并准备 `0.1.9`

- 阶段目标：修复 `pspore.service` 的 bad unit file setting，让发行目录桌面应用能自动安装并启动真实用户服务；修通新版本 Release 的 annotated tag 校验。
- 完成内容：
  - 定位到 systemd 245 将 `WorkingDirectory="/home/ljdavns/.pspore/workspace"` 的整值引号视为路径字符，从而判定路径不是绝对路径；`WorkingDirectory` 改为 directive 专用的无整值引号绝对路径序列化，并继续将 `%` 转义为 `%%`。`ExecStart` 与 `Environment` 保持安全的逐参数 quoting。
  - 回归测试覆盖无引号 `WorkingDirectory`、路径空格和 `%`，并保留命令/环境转义与无 Shell 启动断言。
  - 远端不可变 `v0.1.7` annotated tag 的 Release workflow 因 checkout 把 tag ref 物化为 peeled commit 而失败；`fetch-depth: 0` + `fetch-tags: true` 仍会被 action 最后的 commit refspec 覆盖，`v0.1.8` 实跑捕获相同失败。最终改为直接读取 origin 的 tag object 与 `^{}` peeled commit，并验证 peeled commit 等于 `GITHUB_SHA`，新增配置回归断言。
  - 因远端 `v0.1.7`、`v0.1.8` tag 已存在且不得移动，版本统一升到 PATCH `0.1.9`，同步 `package.json`、lockfile、`src/version.ts` 与 `dist/`。
- 修改文件：`src/service/system-service.ts`、`test/unit/system-service.test.ts`、`.github/workflows/release.yml`、`test/unit/version.test.ts`、版本文件、同步构建的 `dist/` 与相关 `memory-bank/*`。
- 验证方式与结果：
  - 针对性测试 6/6 通过；`npm run check` 通过严格 typecheck、136/136 测试和 production build。
  - `npm run package:desktop` 通过，生成 `0.1.9` SEA CLI、全量 zip、overlay zip、三份 SHA-256 与可运行目录；三份 `sha256sum -c` 全部成功。CLI SHA-256 为 `511f7840…3b932`，全量 zip 为 `f922e42d…f6d9a`，overlay 为 `fd346a08…91135`。
  - 从 `release-dist/pspore-desktop-0.1.9-linux-x64/pspore-desktop` 在真实 X11 会话启动后，unit 自动更新为 `WorkingDirectory=/home/ljdavns/.pspore/workspace`；`systemd-analyze --user verify pspore.service` 无错误，service 为 `enabled/active`，主进程 PID 126591，Daemon `ready`，GUI 使用最新工作树产物运行。
  - `npm run test:electron` 通过：PC 主基准 `1920×1080`，并补测 `1440×900`、`1180×720`，双主题、设置、排版、owned/external Daemon、重连与 IPC allowlist 全绿。
- 当前状态：本地 `0.1.9` 修复、真实服务与 GUI、完整构建/打包/视觉验收均通过；等待提交/push `main`、CI、新 annotated tag、GitHub Release 与远端资产复验。
- 遗留问题：`v0.1.7`、`v0.1.8` 保留不可变失败 tag 且没有 Release；不移动、不删除、不覆盖。既有非本轮待办继续见 `todo.md`。

## 2026-08-27 15:56 CST — 修复聊天历史强制贴底并准备 `0.1.10`

- 阶段目标：聊天窗口首次默认贴底，但允许用户稳定上滚浏览；浏览期间无新消息或收到新输出都不得自动回底，用户回到底部后恢复尾随。
- 完成内容：
  - renderer 增加独立 `followTail` 状态，session 切换时默认开启；scroll 事件通过 24px 边界判断暂停/恢复尾随，不再在每次 render 中用瞬时位置重新推断。
  - transcript 高度测量 RAF 不再捕获上一帧 `shouldPin`，而是执行时读取最新尾随意图，消除用户上滚与旧测量回调之间的竞态。
  - Electron smoke 的 1007 条长历史 fixture 增加三段真实交互：上滚静置保持位置、浏览时收到 streaming delta 保持位置、回到底部后完成消息继续贴底。
  - 用户可见修复按 SemVer 升 PATCH `0.1.10`；源码、lockfile 与 `dist/` 已同步。
  - 上一阶段 `v0.1.9` GitHub Release 已成功发布；重新下载六项资产后三份 `sha256sum -c` 全部成功，SEA CLI 与桌面包内 CLI 均为 `0.1.9`，包内 Electron 为 `43.3.0/x64`。
- 修改文件：`src/desktop/renderer/renderer.ts`、`src/ui/shared/virtual-list.ts`、`src/desktop/main.ts`、`test/unit/virtual-list.test.ts`、版本文件、同步 `dist/` 与相关 `memory-bank/*`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、137/137 测试和 production build。
  - `npm run test:electron` 通过：PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`；新增滚动三段断言与双主题、设置、排版、owned/external Daemon、重连、IPC allowlist 全绿。
  - 规范化 `scripts/release.sh 0.1.10` 再次通过 `npm ci → npm run check → 完整打包`；本地三份 `sha256sum -c` 成功。SEA CLI SHA-256 为 `a6de58e6…27da1b`，全量 zip 为 `76aabd9d…e0b791`，overlay 为 `2a2296f9…b26e4e`；CLI 输出 `pSpore 0.1.10 (Pi 0.84.1, Node 24.19.0)`。
  - 从 `release-dist/pspore-desktop-0.1.10-linux-x64/pspore-desktop` 在真实 X11 会话启动；真实 `pspore.service` 已更新到该目录，状态 `enabled/active`，PID 201877，Daemon `ready`，`WorkingDirectory=/home/ljdavns/.pspore/workspace`。
  - commit `f6c29f8` 已推送 `main`；CI run `33051992448` success，包含 typecheck/test/build 与提交态 `dist` 一致性校验。annotated tag `v0.1.10` 的 object 为 `eab1bd7…12f2`，peeled commit 为 `f6c29f8…882c`；Release workflow run `33052377059` success。
  - GitHub Release `v0.1.10` 已发布并从远端重新下载六项资产；三份随包 SHA-256 校验全部成功。远端 CLI/全量 zip/overlay digest 分别为 `7ca4554e…b6c86`、`f21d3ccd…98385`、`e68f1438…c603e`；SEA CLI 与包内 CLI 均为 `0.1.10`，包内运行时为 Electron `43.3.0`、Node `24.18.1`、Linux x64，overlay manifest 为 `0.1.10 / 43.3.0 / linux x64`。
- 当前状态：聊天历史滚动修复、`0.1.10` 本地与远端不可变发行、真实最新 GUI/服务全部完成并验证。
- 遗留问题：既有非本轮产品待办继续见 `todo.md`；MESA performance warning 不影响功能，未为本轮擅自修改系统 sysctl。

## 2026-08-27 21:38 CST — 修复新会话 JSONL 缺失与直接发送消息延迟展示并准备 `0.1.11`

- 阶段目标：兼容 Pi 延迟创建 session JSONL 的行为，修复桌面新建会话 `realpath ENOENT`；让已提升为直接发送的消息在当前 tool 结束前立即可见。
- 完成内容：
  - 定位到 Pi `v0.84.1` 的 `SessionManager.create/newSession` 会先返回目标路径，默认延迟到首次 assistant 持久化才创建文件；原 `SessionCatalog.add/touch` 立即 `realpath`，因此新会话在 catalog 注册前失败。
  - 新增 `resolveSessionFile`：已有文件保持 realpath/regular file 校验；缺失叶只在 canonical parent 安全且仍位于 session root 时接受，非 JSONL、越界、symlink 逃逸仍 fail closed。
  - Pi adapter 在 create/resume/session rebind 后，以 `wx` 和 `0600` 写入 manager 当前 header/entries，再重载 manager，既让 catalog 可立即注册，也不留下会令 Pi 首次 `_persist(..., wx)` 冲突的空文件；catalog 中缺失的安全旧 JSONL 可在恢复时生成有效 header。
  - GUI `messageQueue` 同时渲染 `queue.steering` 和 `queue.followUp`。直接发送项在当前 tool 尚未完成时显示“直接发送消息”，普通项仍显示“继续排队/直接发送消息”，不暴露内部 `steer` 术语。
  - 用户可见修复按 SemVer 升 PATCH `0.1.11`，源码、lockfile 与 `dist/` 同步。
- 修改文件：`src/sessions/session-file.ts`、`src/sessions/session-catalog.ts`、`src/pi/pi-runtime-adapter.ts`、`src/desktop/renderer/{renderer.ts,styles.css}`、`src/desktop/{main.ts,smoke-fixture.ts}`、相关 contract/unit tests、版本文件、同步 `dist/` 与 `memory-bank/*`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、140/140 测试和 production build；Pi contract 覆盖新 session 文件立即物化及删除后 resume 自动重建，catalog 测试覆盖安全缺失叶与越界拒绝。
  - `PSPORE_KEEP_SMOKE=1 npm run test:electron` 通过：PC 主基准 `1920×1080`，补测 `1440×900`、`1180×720`；在 `tool.completed` frame 发出前已断言直接发送队列卡可见，follow-up 同时显示。人工复核暗色主截图，队列卡没有遮挡 transcript/composer。
  - `npm run package:desktop` 通过并生成 `0.1.11` 全套本地产物；三份 `sha256sum -c` 成功。SEA CLI/full zip/overlay SHA-256 分别为 `cb761694…f5579`、`bf9d4fad…da65c`、`9a291677…a6108`，overlay manifest 为 `0.1.11 / Electron 43.3.0 / linux x64`。
  - 真实 X11 GUI 已切换到 `release-dist/pspore-desktop-0.1.11-linux-x64`；`pspore.service` 为 `enabled/active/ready`。通过包内 CLI 在现有用户配置中新建 `session-7d96ddfb-f680-452a-a43a-5e6dd02d8a13` 成功，对应 catalog JSONL 已立即存在，mode `0600`、Pi header version `3`、cwd 为当前 workspace。
- Git/发行验证：
  - 功能与记忆提交 `2d5a416` 已 push 到 `origin/main`，主分支 CI run `33078288862` 成功，包含完整检查及 committed `dist` 一致性验证。
  - `scripts/release.sh 0.1.11` 再次通过 140/140 检查、打包与 SEA 自检，创建并推送 annotated tag `v0.1.11`；远端 tag object 为 `c617e615…81d31`，peeled commit 精确为 `2d5a416…d53ba`。
  - Release desktop run `33078693382` 成功并创建非 draft、非 prerelease 的不可覆盖 Release。六项资产已从 GitHub 重新下载到独立临时目录，三份随包 `sha256sum -c` 全部通过；远端 CLI/full zip/overlay SHA-256 分别为 `dd046ac3…f8126`、`4630945f…a8311`、`f00af54b…50172`。
  - 远端 SEA CLI 为 `0.1.11 / Pi 0.84.1 / Node 24.19.0`；远端 full zip 包内 CLI 为 `0.1.11 / Pi 0.84.1 / Node 24.18.1`，Electron 运行时为 `43.3.0 / linux / x64`；overlay manifest 为 `0.1.11 / Electron 43.3.0 / linux / x64`，payload SHA-256 为 `e688a3d0…9fa2f`。
- 当前状态：新会话 JSONL 修复、直接发送消息即时展示、`0.1.11` 本地/CI/不可变远端发行及真实最新 GUI/服务均已完成并验证。
- 遗留问题：真实验证新增了一个标题为“0.1.11 会话兼容性验证”的空会话，保留给用户直接确认新建/切换行为；GitHub Actions 报告官方 action 仍以 Node 20 为目标的弃用告警，已登记 `todo.md`，不影响本轮检查/发行成功；既有非本轮待办继续见 `todo.md`。

## 2026-09-02 10:59 CST — 银河麒麟 V10 ARM64 CI 打包链本地阶段

- 阶段目标：依据用户提供的飞腾 FT-2000/4、AArch64、银河麒麟 V10 SP1、glibc 2.31 环境信息，让 GitHub CI 生成可在该用户态基线上自检的 ARM64 CLI、桌面全量包与 overlay。
- 完成内容：
  - `package-desktop.sh`、`build-cli-binary.sh` 与 electron-builder 配置从硬编码 x64 改为原生 `x64|arm64` 参数化；SEA 必须复制同架构 Node，跨架构请求在打包前拒绝，默认 x64 输出命名与正式 Release 流程保持不变。
  - overlay updater 接受 `linux/x64` 或 `linux/arm64` manifest，但仍要求现有 Electron 的精确版本、平台和架构全部匹配；新增 ARM64 fixture 回归。
  - 新增 `Package Linux ARM64` workflow：原生 `ubuntu-24.04-arm` runner 内使用 Ubuntu 20.04/glibc 2.31 容器，安装 ARM runtime/optional dependencies，以非 root 用户执行完整检查和 `1920×1080` Electron smoke，再验证 ELF AArch64、`ld-linux-aarch64.so.1`、Electron/SEA 运行时与三份 checksum；成功时上传保留 14 天的 CI artifact，不操作 GitHub Release。
- 修改文件：`.github/workflows/package-arm64.yml`、`electron-builder.yml`、`scripts/{package-desktop.sh,build-cli-binary.sh}`、`scripts/linux/apply-overlay-upgrade.sh`、发行脚本测试、中文项目文档及 `memory-bank/*`。
- 验证方式与结果：
  - `npm run check` 通过：严格 typecheck、142/142 测试和 production build 全绿，`git diff --exit-code -- dist` 通过；新增 workflow 静态契约和 ARM overlay 升级均在测试内通过。
  - `bash -n`、`git diff --check` 通过；Prettier 成功解析并确认 ARM workflow 与 electron-builder YAML 格式。
  - 最终 `npm run package:desktop` x64 兼容回归通过；三份 `sha256sum -c` 成功，SEA 为 `pSpore 0.1.11 / Node 24.19.0`，包内 Electron 为 `43.3.0/linux/x64`，overlay manifest 为 `0.1.11 / 43.3.0 / linux/x64`。全量 zip 149 MiB、overlay 29 MiB、SEA 140 MiB，均在被 Git 忽略的 `release-dist/`。
- 当前状态：本地实现、检查和既有 x64 打包回归完成；ARM64 workflow 尚待本阶段提交推送 `main` 后在 GitHub 原生 ARM runner 上执行，当前不提前声称远端 ARM 产物成功。
- 遗留问题：CI 用户态不能复现目标机 Linux 5.4 内核、真实 GPU/桌面栈与 systemd 245；远端 ARM job 成功后仍需在实际银河麒麟设备下载安装、快捷方式、GUI 与用户服务复验，已登记 `todo.md`。

## 2026-09-02 11:16 CST — 修复 ARM CI 的 Electron 43 显式安装

- 阶段目标：定位并修复 `Package Linux ARM64` 在原生 ARM runner 上安装依赖后退出的问题。
- 完成内容：通过 GitHub Actions 失败日志确认 job 已进入 Ubuntu 20.04/glibc 2.31 ARM 容器且 `npm ci` 成功；Electron 43.3.0 npm 包不再声明自动 install script，因此补充以非 root 构建用户显式执行 `node node_modules/electron/install.js`，下载并校验同架构 Electron runtime。静态契约同步约束该步骤，避免后续误删。
- 修改文件：`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：失败 run `33585464052` 的日志已读取并定位到 `Install native ARM64 dependencies`；本地确认 Electron 43.3.0 包含 `install.js` 但 package metadata 没有自动安装脚本，显式安装后得到可执行的 `43.3.0/linux/x64` runtime。`actionlint 1.7.12`、针对性 3/3 测试、`npm run check`（142/142）及 committed `dist` 一致性校验均通过。
- 当前状态：根因修复已完成本地验证，待提交推送并观察新 ARM run。
- 遗留问题：远端原生 ARM64 job 尚未复跑通过；通过前不创建正式 Release tag。

## 2026-09-02 11:21 CST — 兼容 GitHub job container 的 Electron smoke

- 阶段目标：修复原生 ARM job 进入 Electron smoke 后因嵌套容器禁止创建 Chromium namespace 而退出的问题。
- 完成内容：失败 run `33586566564` 已证明显式 Electron 安装与 142 项 ARM 检查通过；smoke harness 新增仅由显式环境变量启用的 `--no-sandbox` 参数，ARM workflow 只在 Ubuntu 20.04 GitHub job container 内设置该变量。产品 BrowserWindow 仍保持 `sandbox: true`、context isolation、无 Node integration 与严格 CSP，正常发行启动参数不受影响。
- 修改文件：`scripts/electron-smoke.mjs`、`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：远端失败日志为 Chromium `Failed to move to new namespace ... Operation not permitted`，符合 job container 的 namespace 限制；`actionlint 1.7.12`、`node --check`、针对性安全/工作流测试 7/7、`npm run check`（142/142）与 committed `dist` 一致性校验均通过。本机缺少 `xvfb-run`，实际 ARM smoke 留给原生 runner 复验。
- 当前状态：CI 专用 smoke 兼容修复已完成本地验证，待提交推送并观察新 ARM run。
- 遗留问题：CI 容器无法验证 Chromium OS sandbox 的实际启用；该安全配置继续由静态单测约束，真实银河麒麟设备仍需做最终运行复验。

## 2026-09-02 11:28 CST — 放宽 ARM 软件渲染 smoke 时限

- 阶段目标：处理 ARM job 已启动 Electron、但完整视觉 fixture 超过固定 60 秒而被测试 harness 终止的问题。
- 完成内容：smoke harness 保留默认 60 秒回归门禁，同时支持范围受限的 `PSPORE_ELECTRON_SMOKE_TIMEOUT_MS`；ARM workflow 设置为 180 秒，以容纳无 GPU 的 ARM 软件渲染。超时错误同步附带已捕获的有限 stdout/stderr，便于继续定位而不会输出无限日志。
- 修改文件：`scripts/electron-smoke.mjs`、`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：run `33586842778` 已通过 ARM 环境、Electron 显式安装及 142 项检查，修复后的 Electron 首次启动不再 namespace 崩溃；失败点精确为 harness 的 `xvfb-run timed out after 60000ms`。`actionlint 1.7.12`、`node --check`、针对性安全/工作流测试 7/7、`npm run check`（142/142）与 committed `dist` 一致性校验均通过。
- 当前状态：ARM 专用超时参数已完成本地验证，待提交和原生 runner 复跑。
- 遗留问题：尚未确认完整 ARM smoke 在 180 秒内完成；通过前继续不创建 Release tag。

## 2026-09-02 11:38 CST — 修复 ARM smoke 的 XDG 与 D-Bus 会话

- 阶段目标：根据放宽超时后取得的 Electron stderr，修复 smoke 启动后无法完成的问题，而不是继续增加等待时间。
- 完成内容：显式创建并授权构建用户的 XDG cache/runtime 父目录，避免 root 创建的 `.cache` 阻止 dconf 初始化；Ubuntu 20.04 容器安装 `dbus-x11`，smoke 通过 `dbus-run-session` 获得有效 session bus。配置只作用于 CI 构建用户和测试进程。
- 修改文件：`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：run `33587261873` 证实 180 秒参数生效；有限 stderr 明确记录 `.cache/dconf: Permission denied` 及无效 D-Bus address，因此本轮针对两项环境缺失修复。`actionlint 1.7.12`、`node --check`、本地 `dbus-run-session` 地址断言、针对性测试 7/7、`npm run check`（142/142）和 committed `dist` 一致性校验均通过。
- 当前状态：环境根因修复已完成本地验证，待提交和第四次原生 ARM run。
- 遗留问题：尚未取得 ARM smoke 与打包成功证据；正式 Release tag 继续暂停。

## 2026-09-02 11:47 CST — ARM smoke 共享内存兼容与可观测诊断

- 阶段目标：在有效 XDG/D-Bus 环境下 smoke 仍无报告并于 180 秒超时后，修复容器共享内存限制并确保下一次失败具有阶段证据。
- 完成内容：CI 专用 Electron flags 增加 `--disable-dev-shm-usage`，避免 Chromium renderer 依赖 job container 的小型 `/dev/shm`；失败时 harness 输出 external/owned 目录的已生成文件列表，workflow 额外保留 1 天隔离 smoke 输出 artifact。正常本地 smoke 与正式发行启动仍不携带这些 CI 参数。
- 修改文件：`scripts/electron-smoke.mjs`、`.github/workflows/package-arm64.yml`、`test/unit/version.test.ts`、`memory-bank/overall-progress.md`。
- 验证方式与结果：run `33587731065` 再次于首次 `xvfb-run` 180 秒超时，stderr 已不再出现 dconf 权限或 session bus 地址错误，仅保留缺少 system bus 的 Electron 非致命提示。`actionlint 1.7.12`、`node --check`、针对性测试 7/7、`npm run check`（142/142）与 committed `dist` 一致性校验均通过。
- 当前状态：共享内存兼容和失败诊断已完成本地验证，待提交与第五次 ARM run。
- 遗留问题：尚不知道 renderer 卡住前是否已完成部分截图；下一次失败 artifact/文件列表将提供该证据。

## 2026-09-02 15:57 CST — 银河麒麟兼容 ARM64 CI 全链成功

- 阶段目标：取得原生 ARM64 runner 上从依赖安装、完整检查、桌面 smoke 到打包上传的闭环证据，并独立复核下载产物。
- 完成内容：GitHub Actions run `33588243028` 在 `ubuntu-24.04-arm` + Ubuntu 20.04/glibc 2.31 容器中全部成功，包含原生依赖、142 项测试/build、`1920×1080` Electron smoke、ARM64 CLI/全量 zip/overlay 打包、ELF/运行时/checksum 校验与 artifact 上传；同提交普通 CI run `33588243049` 也成功。下载六项 ARM64 资产到隔离临时目录，三份 SHA-256 均通过；SEA CLI 为 AArch64 little-endian ELF，interpreter 为 `/lib/ld-linux-aarch64.so.1`，overlay manifest 为 `0.1.11 / Electron 43.3.0 / linux / arm64`。用户随后确认 ARM 包可用。
- 修改文件：本阶段远端验证对应 commit `162d018`；当前仅同步 `memory-bank/overall-progress.md` 记录结果。
- 验证方式与结果：通过 `gh run view 33588243028`、`gh run view 33588243049` 复核所有 job/step 为 `success`；隔离目录中 CLI、full zip、overlay zip 大小分别为 `142216320`、`153624859`、`29770501` bytes，三份 `sha256sum --check` 成功，并用 `file`、`readelf`、manifest/payload hash 检查架构与内容。
- 当前状态：ARM64 producer 已通过远端全链与用户可用性确认，可以进入双架构正式 Release 编排。
- 遗留问题：CI 仍不能等价复现目标机 Linux 5.4、GPU/桌面栈与 systemd 245；真实设备的完整快捷方式/服务专项复验继续保留在 `todo.md`。

## 2026-09-02 16:04 CST — 双架构分类 Release 本地候选

- 阶段目标：把已验证的 ARM64 producer 纳入不可变正式 Release，并让用户能在 Release 中直接按架构识别产物。
- 完成内容：`Package Linux ARM64` 改为可被 tag workflow 复用，同时保持 `main`/手动 14 天预览 artifact；`Release desktop` 拆为 tag 校验、原生 x64 producer、Kylin-compatible ARM64 producer 和最终发布四段，只有两侧检查及 checksum 全部成功才创建 Release。12 项资产保留稳定架构文件名，并自动添加 `ARM64 / Kylin V10` 或 `x86_64` display label；Release notes 同步按两个架构分区。版本按 PATCH 更新为 `0.1.12`，发行脚本、静态契约、项目文档和 memory-bank 已同步。
- 修改文件：`.github/workflows/{package-arm64,release}.yml`、`scripts/release.sh`、`test/unit/version.test.ts`、`package.json`、`package-lock.json`、`src/version.ts`、`dist/version.{js,d.ts}`、`docs/project-overview.md` 与相关 `memory-bank/*`。
- 验证方式与结果：`actionlint 1.7.12`、相关 `bash -n`、Prettier YAML check、`git diff --check` 均通过；发布契约针对性测试 4/4、`npm run check` 的严格 typecheck、143/143 测试及 production build 全部通过。本地 `scripts/package-desktop.sh 0.1.12 x64` 生成完整候选，三份 SHA-256 通过；SEA 为 x86-64 ELF、interpreter `/lib64/ld-linux-x86-64.so.2`、CLI 为 `0.1.12 / Node 24.19.0`，桌面 runtime 为 `Electron 43.3.0 / linux / x64`，overlay manifest 为 `0.1.12 / 43.3.0 / linux / x64`。CLI/full/overlay digest 分别为 `e79c6af4…6386d`、`d74de3be…b555f`、`7c82abba…1e5db`。
- 当前状态：本地实现、构建与 x64 发行候选完成；下一阶段提交并推送 `main`，等待普通 CI 与 ARM64 CI 都通过后再创建 annotated `v0.1.12` tag。
- 遗留问题：远端双架构 Release workflow 尚未实跑，`todo.md` 保持 In Progress；当前主机没有 `xvfb-run`，本轮没有重复执行本地 Electron smoke，ARM `1920×1080` smoke 已由成功 run `33588243028` 提供证据。

## 2026-09-02 16:24 CST — `v0.1.12` 双架构分类 Release 完成

- 阶段目标：让 ARM64/Kylin 与 x86_64 产物自动进入同一个不可变 Release，并完成远端资产与分类结果的独立复验。
- 完成内容：commit `942862b` 已推送 `main`；普通 CI run `33606978255` 与 ARM64 run `33606978363` 均成功。随后创建并推送 annotated tag `v0.1.12`（tag object `ee976e5…219b7`，peeled commit `942862b…4a77`）；Release workflow run `33607400527` 的 tag 校验、x64 producer、Kylin-compatible ARM64 producer、双架构发布四个 job 全部成功。GitHub Release 为非 draft、非 prerelease，共 12 项资产；每项分别带 `ARM64 / Kylin V10 - <类型>` 或 `x86_64 - <类型>` display label，正文含对应两个架构章节。
- 修改文件：本阶段发布代码已包含在 `942862b`；完成后同步 `memory-bank/{overall-progress,todo}.md` 的最终状态。
- 验证方式与结果：从 GitHub Release 重新下载全部 12 项文件到 `/tmp/pspore-release-v0.1.12.lnOgw4`，六份随包 `sha256sum --check` 全部通过，四个 zip 均通过 CRC。远端 ARM64/x64 SEA 与包内 Electron 分别为 AArch64/x86-64 ELF，interpreter 分别为 `/lib/ld-linux-aarch64.so.1`、`/lib64/ld-linux-x86-64.so.2`；x64 SEA 为 `0.1.12 / Node 24.19.0`，包内 CLI 为 `0.1.12 / Node 24.18.1`，runtime 为 `Electron 43.3.0 / linux / x64`。ARM64/x64 overlay manifest 均为 `0.1.12 / Electron 43.3.0 / linux / 对应架构`，payload SHA-256 均为 `9b8515a8…ac3b`。远端 ARM CLI/full/overlay digest 分别为 `ec3efe2c…265bb`、`308826d9…ff60`、`8745a370…7b2a`；x64 分别为 `291cd0ac…db96`、`b08e44c0…d9db`、`b248d840…8851`。
- 当前状态：`v0.1.12` 双架构自动分类 Release 已完整发布并验证，地址为 `https://github.com/advnljs/pSpore/releases/tag/v0.1.12`；无需新增仓库 secret 或用户配置。
- 遗留问题：真实银河麒麟设备的快捷方式、GPU/桌面栈与 systemd 245 专项验证仍保留在 `todo.md`，不影响用户已确认可用的 ARM 包与本次 Release 自动分类结果。GitHub Release 下载独立二进制后需按 Linux 常规执行 `chmod +x`；全量 zip 内文件权限已保留。

## 2026-09-04 10:35 CST — GUI 文件/目录拖拽路径引用本地候选

- 阶段目标：允许把文件或目录拖入 GUI 聊天框，同时确保 drop 只增加引用，不自动发送或读取内容。
- 完成内容：composer 增加 drag active overlay 与可移除引用 chips；通过 preload 的 Electron `webUtils.getPathForFile` 仅解析真实 OS-backed `File` 的绝对路径，按路径去重并限制为 32 项。目录保持单一引用而不展开；drop 保留文字草稿且不提交，发送时仅追加 JSON 引号保护的绝对 `@` path token，成功后清空、失败时保留。安全基线继续禁用 drag navigation，renderer 没有 Node/文件读取能力。版本按 PATCH 更新为 `0.1.13`。
- 修改文件：`src/desktop/{ipc-contract.ts,main.ts,preload.cjs}`、`src/desktop/renderer/{index.html,renderer.ts,styles.css,composer-file-references.ts}`、对应 `dist/`、`scripts/electron-smoke.mjs`、desktop 单测、版本文件、README、详细设计与相关 `memory-bank/*`。
- 验证方式与结果：TypeScript typecheck、146/146 全量测试、production build 与 `git diff --check` 全部通过。最新源码 Electron smoke 在 `1920×1080` 主基准并补测 `1440×900`、`1180×720`；真实拖入一个文件和一个目录后报告 `activeIndicatorVisible/inputPreserved/notSubmitted/overlayHiddenAfterDrop=true`、引用数 2、类型为 `file,directory`，所有布局/安全/主题断言通过。打包后应用同一 smoke 复跑通过，`1920×1080` document 为 `1920×1080`、composer 可见且无页面 overflow。
- 发行候选：本地 x64 SEA、全量 zip、overlay zip 与可运行解包目录已生成；三份 SHA-256 均通过。SEA 为 x86-64 ELF、`0.1.13 / Node 24.19.0`；桌面 runtime 为 `Electron 43.3.0 / Node 24.18.1 / x64`；overlay manifest 为 `0.1.13 / Electron 43.3.0 / linux / x64`。CLI/full/overlay digest 分别为 `eba6d376…3e08`、`fdd19c66…9baa`、`946e9526…edfa`。
- 当前状态：功能、文档、本地构建、实机拖拽视觉验收和 x64 发行候选均完成；下一阶段提交并推送 `main`，等待普通 CI 与 ARM64 CI 通过后创建 annotated `v0.1.13` tag。
- 遗留问题：远端双架构 Release 尚未执行；当前容器没有 `xvfb-run` 和系统 Electron 运行库，本地 smoke 通过已有 DISPLAY 与仅对测试进程生效的临时解包运行库完成，未修改系统依赖。隔离 smoke 在验收后正常退出，当前未保持长期 GUI 服务。

## 2026-09-04 11:03 CST — `v0.1.13` GUI 拖拽路径引用 Release 完成

- 阶段目标：把已通过本地验证的 GUI 文件/目录拖拽路径引用作为不可变双架构版本发布，并独立复核远端产物。
- 完成内容：commit `6b97f2e` 已推送 `main`；普通 CI run `33830207814` 和 ARM64 preview run `33830207836` 均成功，后者包含 glibc 2.31 原生 ARM64 的 146 项检查、`1920×1080` Electron 真实拖拽 smoke、打包与 checksum。标准 `scripts/release.sh 0.1.13` 二次完成 `npm ci`、146/146、build 和 x64 全套打包，随后创建并推送 annotated `v0.1.13`（tag object `bce0399…db092`，peeled commit `6b97f2e…a6924`）。Release workflow `33830862920` 的 tag 校验、x64 producer、Kylin-compatible ARM64 producer、最终发布四个 job 全部成功。
- 远端验证：GitHub Release 为非 draft、非 prerelease，共 12 项资产，全部具有 `ARM64 / Kylin V10` 或 `x86_64` display label，正文含双架构章节。从 Release 下载全部资产后，六份 `sha256sum --check` 与四个 zip CRC 均通过。ARM64/x64 SEA 和包内 Electron 均为对应 AArch64/x86-64 ELF，interpreter 分别为 `/lib/ld-linux-aarch64.so.1`、`/lib64/ld-linux-x86-64.so.2`；x64 SEA 为 `0.1.13 / Node 24.19.0`，远端全量包为 `0.1.13 / Electron 43.3.0 / Node 24.18.1 / x64`。两个 overlay manifest 均为 `0.1.13 / Electron 43.3.0 / linux / 对应架构`，payload digest 相同为 `736f9d6d…78eac`。
- 远端摘要：ARM CLI/full/overlay SHA-256 分别为 `5bf4a126…fb2f`、`81ccae7a…7fff`、`635b78ab…60a`；x64 分别为 `8b67c1f5…9e67a`、`6a25c965…1381`、`45dc535f…6ece`。
- 当前状态：`v0.1.13` 已完整发布并验证，地址为 `https://github.com/advnljs/pSpore/releases/tag/v0.1.13`；本地 `release-dist/` 保持最新 `0.1.13` x64 可执行目录与六项发行文件且三份 checksum 再次通过。
- 遗留问题：本轮没有新增生产依赖；发布脚本的默认 `npm audit` 报告锁定依赖中 1 moderate/1 high，生产依赖专项 audit 请求在当前 registry 响应超时，已记录到 `todo.md` 后续独立复核，不在本功能中自动升级依赖。真实银河麒麟设备专项复验仍沿用既有待办。

## 2026-09-04 16:32 CST — 长会话 frame 与直接 compact 阈值本地候选

- 阶段目标：修复长会话 snapshot/event 超过 1 MiB 时客户端报 `server frame exceeded protocol limit`，并增加可由 GUI/TUI/CLI 共享配置的自动上下文压缩直接 token 阈值。
- 完成内容：UDS hello 新增 `server-frame-chunks.v1` capability；协商后的超大 server message 在 64 MiB 逻辑上限内选择 gzip/原始 bytes，并以严格有序 base64 chunks 发送，物理 frame 继续保持 1 MiB 上限。客户端校验 ID、顺序、数量、声明长度、canonical base64、解压上限、协议版本与 kind 后才交付。自动 compact 新增默认 `100000` 的 `triggerTokens`，在 prompt 前及 turn 完成后按 Pi active-context usage 达到阈值即调用原生 `compact()`；Pi 模型上限 reserve 保护继续并行生效。旧 config 缺新字段时自动迁移默认值，GUI/TUI/CLI 设置、帮助和文档已同步。版本按 PATCH 更新为 `0.1.14`，未增加依赖。
- 修改文件：`src/protocol/{client,server-frame-codec}.ts`、`src/gateway/local-gateway.ts`、`src/pi/pi-runtime-adapter.ts`、`src/{config,settings,desktop,ui,cli}/**`、对应测试与 `dist/`、版本文件、README、设计文档和相关 `memory-bank/*`。
- 验证方式与结果：针对性协议/Pi/config/desktop 测试 41/41，通过严格 TypeScript typecheck；第二轮 `npm run check` 的 152/152、production build 全部通过。首轮全量检查遇到已记录的 MCP stdio 2 秒负载超时，隔离复跑 2/2 通过且第二轮全量干净通过。生产默认边界下用 1,400,608-byte snapshot 实测拆为 2 帧，每帧不超过 1,048,576 bytes（最大 1,048,329），重组内容完全一致。源码 Electron smoke 在 `1920×1080` 主基准及 `1440×900`、`1180×720` 全部通过；打包后 GUI 再以 `1920×1080` 验证 owned Daemon、连接、重连、设置、字号、响应式布局和 IPC allowlist。`npm pack --dry-run --json` 验证 `p-spore@0.1.14` tarball 仅含 README/package metadata/最新 `dist`，包括新 server frame codec。
- 发行候选：本地 x64 SEA、全量 zip、overlay zip 与可运行解包目录已生成；三份 SHA-256 与两个 zip CRC 均通过。SEA 为 x86-64 ELF、`0.1.14 / Node 24.19.0`；全量包内 CLI 为 `0.1.14 / Pi 0.84.1 / Node 24.18.1`；overlay manifest 为 `0.1.14 / Electron 43.3.0 / linux / x64`。CLI/full/overlay digest 分别为 `076ee111…a486`、`fb859a27…e8cd`、`a60138fb…e6fb`。
- 当前状态：实现、文档、完整测试、最新 build、PC 实机 smoke 和本地 x64 发行候选均完成；当前 smoke 进程已退出，未改动用户正在运行的服务。下一阶段提交并推送 `main`，等待普通 CI 与 ARM64 preview 成功后创建 annotated `v0.1.14` tag。
- 遗留问题：远端双架构 Release 与 12 项资产复验尚未执行；`refer/` 是用户原有未跟踪目录，本阶段未读取、修改或纳入提交。

## 2026-09-07 CST — 配置集中、长任务连接抖动修复、GSAP 扩展与整包 overlay

- 阶段目标：把设置面板全部配置项收敛到 `config.json` 并展示凭据文件地址；消除长任务中界面与守护进程连接“短暂丢失、不断跳动”；扩展 GSAP 动效；让 overlay 打包 Chromium 之外的全部文件并整体替换，配置增量补齐、已有配置不动，并提供最基础的图形界面升级与快捷方式重指向。
- 完成内容：
  - **配置集中**：新增 `src/settings/model-api.ts` 作为 `ModelApi` 的唯一定义；`config.model` 扩展可选 `baseUrl`/`api`/`customModel`/`apiKeyFile`/`cookieFile`。`LlmSettingsService` 以 `config.json` 为权威读写，`state/pi/models.json` 降级为 Pi 运行时派生产物（仅在读取 0.1.15 之前的 home 时回退）。`LlmSettings` 新增 `configPath`/`apiKeyPath`/`cookiePath`/`modelsPath`，GUI 设置面板、CLI `config show` 与 TUI `/config` 均展示实际文件地址（仍不展示密钥值），GUI 增加“复制路径”。
  - **连接抖动根因**：`LocalGateway.publish()` 在 `socket.writableNeedDrain` 时静默丢弃非 durable 事件，但全局 `seq` 已自增，客户端据 `seq !== cursor+1` 判定事件缺口并主动 `close()` 重连——长任务高频 `message.delta` 下反复触发。修复：`EventEnvelope` 新增可选 `skipped`，网关按连接累计被丢弃的瞬时事件数并随下一条事件下发；`DaemonBridge`、`applyProtocolEvent`、`applyProtocolDelta` 以 `cursor + 1 + skipped` 判定期望序号。同时把“客户端太慢”硬杀改为仅对 durable frame 生效，瞬时 frame 一律计数丢弃。
  - **界面稳定期**：`DesktopStore`/`TuiStore` 增加 2 秒 settle window 与 `stableConnection`/`reconnecting`；窗口内的重连保持呈现为已连接，仅徽标指示灯转为暖色呼吸，横幅、通知行与所有连接门控按钮不再跳动；超时的真实掉线仍会如实显示。GUI 在被遮蔽的重连期内对“尚未写入 socket”的命令（`DAEMON_NOT_CONNECTED_MESSAGE`）自动等待并重试一次，不会重复已执行命令。
  - **GSAP**：`motion.ts` 扩展为完整动效层——重连呼吸循环、指标数字 tween、列表 stagger、检查器 tab 淡入、离线横幅滑入滑出、状态 chip 翻转、文件引用 chip 弹入、状态行交叉淡入；全部走 transform/opacity，尊重 `prefers-reduced-motion`，引擎缺失时立即降级。
  - **overlay 整包**：payload 由“仅 `resources/`”改为“`STAGE_FULL` 减去 Electron/Chromium 运行时清单”，打包时断言必须含 `resources/app.asar` 与 `创建桌面快捷方式.sh`、必须不含任何运行时条目。updater 改为在安装根目录整体替换、备份到 `<install>/.pspore-backup-*`，输出 `[ NN%] …` 进度行，升级后重跑随包的 `创建桌面快捷方式.sh` 把已有桌面快捷方式重新指向本次升级目录。新增 `scripts/linux/overlay-upgrade-gui.sh`（打包为「图形界面升级.sh」）：zenity/kdialog 选目录 + 进度条，缺少对话框工具时回落终端模式。
  - **配置增量覆盖**：`parseConfig` 先经 `withConfigDefaults` 按段/按键补齐缺失默认值（已有值一律保留、未知键仍严格拒绝），`initializePsporeHome` 在检测到缺键时把合并结果原子写回，因此 overlay 升级后新增配置项自动补齐而用户已有取值不变。
- 修改文件：`src/settings/{model-api.ts,llm-settings.ts,llm-settings-service.ts}`、`src/config/config.ts`、`src/storage/home.ts`、`src/protocol/schema.ts`、`src/gateway/local-gateway.ts`、`src/desktop/{daemon-bridge.ts,ipc-contract.ts,validation.ts,main.ts}`、`src/desktop/renderer/{store.ts,renderer.ts,motion.ts,index.html,styles.css}`、`src/ui/shared/protocol-state.ts`、`src/ui/tui/{store.ts,tui-app.ts}`、`src/cli/main.ts`、`scripts/package-desktop.sh`、`scripts/linux/{apply-overlay-upgrade.sh,overlay-upgrade-gui.sh}`、对应测试与 `dist/`。
- 验证方式与结果：`npm run check` 全绿——严格 typecheck、158/158 测试、production build。新增用例覆盖：网关背压下不产生序号缺口且必然投递 durable 尾事件、desktop store 的 settle window 与 `skipped` delta、config 增量升级只补缺键、`config.model` 端点与凭据路径持久化、overlay 根级整体替换 + 备份 + 快捷方式重指向、overlay GUI 选目录/进度/拒绝错误目录。CLI 实测：`config set custom-openai …` 后 `config.json#model` 含 `baseUrl/api/customModel/apiKeyFile/cookieFile`，`config show` 输出四个文件地址；用缺 `memory/shell/scheduler/boot/plugins/mcpServers` 的旧 `config.json` 执行 `init`，自定义 workspace、`maxConcurrentAgents=9`、`thinking=high`、`maxPinnedTokens=4242`、`mode=allow_all` 全部保持原值，仅补齐缺失段。渲染层 98 个 `byId` 目标全部在 `index.html` 中存在，构建产物 `renderer.js`/`motion.js` 解析通过。
- 当前状态：源码与 `dist/` 同步，构建通过。
- 补充验证（推送后）：本机没有 `xvfb-run` 且缺 `libnspr4`，无法本地执行 Electron smoke；但 commit `4ccee4c` 的 ARM64 CI run `34080267184` 在 xvfb + dbus 下跑通了 `npm run test:electron`，日志为 “Electron 43 smoke passed: 1920x1080, 1440x900 and 1180x720 desktop layouts, path-only file/directory drop references, dark/light themes, settings, typography, owned/external daemon, reconnect and IPC allowlist verified.”。由于本轮在 smoke 校验中新增了 `reconnectMasked` 失败项，该通过结果即证明连接稳定期在真实 Electron 上按预期工作：停掉 bridge 后 3 秒内出现 `dataset.reconnecting === 'true'` 且 `dataset.connection` 仍为 `connected`，随后在 8 秒内如实降级为 `disconnected` 并重连成功。设置面板与三档布局断言通过也说明新增的路径行 DOM 与 GSAP 动效层没有破坏 renderer 加载。
- 遗留问题：GSAP 动效与设置面板路径行的截图未单独人工审美复核；overlay 整包升级仅通过隔离 fixture 验证，未在真实安装目录上实跑。本机未安装 Node，本地验证使用先前构建残留的 `/tmp/pspore-node.zT4XXY/node-v24.19.0-linux-x64`。

## 2026-09-07 CST — CI 自动发版

- 阶段目标：CI 通过后自动把版本推到 GitHub Release，不再依赖手动执行 `scripts/release.sh` 打 tag。
- 背景：`4ccee4c` 推送后普通 CI（run `34080267300`）与 ARM64 preview（run `34080267184`）都成功，但 `Release desktop` 只在 `v*` tag push 时触发，而该提交没有创建 tag，因此没有产生 Release。
- 完成内容：`.github/workflows/ci.yml` 新增 `release` job（`needs: check`，仅 `push` 到 `main` 且仓库变量 `AUTO_RELEASE != 'false'` 时运行）。流程为：校验 `package.json` 版本是合法 SemVer 且与 `src/version.ts` 一致 → 若 `v<version>` 的 tag 或 Release 已存在则跳过（普通提交因此完全不发版）→ 等待同 commit 的 `Package Linux ARM64` preview 成功（最多 30 分钟；5 分钟内没有该 commit 的 run 就放行，由 Release workflow 自行构建 ARM64）→ 在同一步内创建 annotated tag、push，并显式 `gh workflow run "Release desktop" --ref <tag>`，随后轮询确认 Release run 已排队，未排队则失败并打印手动派发命令。
- 关键约束：用 `GITHUB_TOKEN` 推送的 tag **不会**触发 `on: push: tags`，所以必须显式 `workflow_dispatch`（这是 `GITHUB_TOKEN` 仍可触发的事件）。tag 与派发放在同一步，避免 CI 并发取消在两者之间留下“有 tag 无 Release”。job 权限为 `contents: write` + `actions: write`。
- 修改文件：`.github/workflows/ci.yml`、`scripts/release.sh`（说明手动路径现为可选）、`memory-bank/{nav,architecture,overall-progress,todo}.md`。
- 验证方式与结果：`yaml.safe_load` 解析通过，两个 job 结构正确；对 job 内每段 `run` 脚本单独执行 `bash -n` 均通过；版本抽取一行式在本地实测得到 `package.json=0.1.15 / src/version.ts=0.1.15` 并匹配，SemVer 守卫正确接受 `0.1.15`/`0.2.0-rc.1` 并拒绝 `1.0`/`abc`；两条 `gh` 查询按 job 中完全相同的形式对真实仓库实测——ARM64 查询对 `4ccee4c` 返回 `completed success`，Release run 按 `headBranch == "v0.1.14"` 正确解析到 run `33855210573`，证实 tag 触发的 run 其 `headBranch` 就是 tag 名。仓库允许 `contents: write` 有既有证据：`release.yml` 的 `publish-release` job 已用同一权限成功发布过 `v0.1.13`/`v0.1.14`。
- 当前状态：本次提交推送 `main` 后，`release` job 会对尚无 tag 的 `0.1.15` 生效，自动打 `v0.1.15` 并派发 Release workflow。
- 遗留问题：`release` job 本身尚未在真实 CI 上跑过，首次运行即为本次；如果 `gh workflow run` 因仓库 Actions 设置被拒，job 会失败并提示手动派发命令，tag 已存在时需改用 `gh workflow run 'Release desktop' --ref v0.1.15` 补发。本轮未改动 Electron smoke 相关的既有待办。


## 2026-09-07 CST — overlay 打包守卫加固

- 起因：本地对 `package-desktop.sh` 的 overlay payload 构造做 dry-run（用真实 0.1.14 包布局做 fixture）时发现，"payload 不得含运行时条目"的断言遍历的是**与拷贝同一份** `ELECTRON_RUNTIME_ENTRIES`，因此只能发现拷贝 bug，永远发现不了清单过期。而清单过期正是真正危险的情形：Electron 新增或改名一个顶层文件后，它会静默进入 overlay，从而替换掉 overlay 承诺不碰的 Chromium 运行时。
- 完成内容：新增与清单无关的独立守卫——payload 根目录只允许 `resources`、`*.sh`、`*.txt`，出现任何其他顶层条目立即失败并提示应加入运行时清单还是应用白名单；另加一条"payload 根目录不得含 ELF/可执行镜像"的检查（`resources/app.asar.unpacked` 下的原生 `.node` 不在范围内，属于合法内容）。
- 验证方式与结果：以真实 `release-dist/pspore-desktop-0.1.14-linux-x64` 的目录布局构造 fixture，把 `package-desktop.sh` 中的 payload 构造段原样抽出执行。正常包产出恰好为 `resources/`、`创建桌面快捷方式.sh`、`安装说明.txt`，排除了全部 Chromium 条目且 `0755` 权限保留；删掉清单中的 `pspore-desktop` 模拟清单过期 → 加固前 exit 0（漏过），加固后正确失败；凭空新增 `libnewthing.so` → 正确失败；缺少快捷方式安装器、缺少 `app.asar` 两个既有守卫也分别正确失败。
- 当前状态：`scripts/package-desktop.sh` 已加固，`release-scripts` 集成测试仍全部通过。


## 2026-09-07 04:53 UTC — `v0.1.15` 由 CI 自动发布并复验

- 阶段目标：确认新增的 CI `release` job 能端到端把版本推到 Release，并复验产物确实是本轮重做的整包 overlay。
- 完成内容：commit `6d6b0d6` 推送后，CI run `34084272469` 通过，`release` job 自动创建 annotated tag `v0.1.15`（`2f89706b…`）并派发 `Release desktop`；run `34084496369` 成功，Release 于 `2026-09-07T04:53:12Z` 发布。
- 验证方式与结果：`gh release view v0.1.15` 为非 draft、非 prerelease，恰好 12 项资产。x64 overlay 为 29,800,192 bytes（全量包 155,321,157 bytes），下载后 `sha256sum --check` 通过。解压清单确认 overlay 顶层为 `overlay-manifest.json`、`payload/`、`覆盖升级.sh`、`图形界面升级.sh`、`覆盖升级说明.txt`；`payload/` 顶层恰为 `resources`、`创建桌面快捷方式.sh`、`安装说明.txt`，不含任何 Chromium/Electron 运行时条目。manifest 为 `0.1.15 / Electron 43.3.0 / linux / x64`，payload digest `fc664ee2…3738`。
- 当前状态：`https://github.com/advnljs/pSpore/releases/tag/v0.1.15` 已发布；整包 overlay 与图形界面升级脚本均已进入正式产物。
- 遗留问题：overlay 升级仍未在真实安装目录上实跑——本机 Electron 缺 `libasound2`、`libnspr4`、`libnss3` 系列共 5 个 so，而 updater 依赖目标安装的 Electron 充当 Node。是否安装这些系统包需用户决定。


## 2026-09-07 CST — bundled skills 机制、aegis-search CLI 与守护进程持续索引

- 阶段目标：把用户的 aegis-searcher 做成最小二进制 CLI、包装为随发行版携带的 skill，pSpore 启动时链接进 workspace 并按版本升级；守护进程负责持续索引，状态在 GUI 右侧面板展示。
- **aegis-searcher 侧**（另一个仓库，改动已备好待推）：新增 `src/cli/` 无 Qt 的 `aegis-search`（`search`/`index`/`status`，`--json`），默认复用桌面版索引目录；修复整串匹配排序（CJK 单字分词导致拆字散落可压过完整字串，新增整串精确短语 boost 12、邻近短语 boost 4、文件名整串 boost 6 三条只影响排序的 SHOULD 子句）；新增 `--sort newest|oldest`（`mtime` 本就是 NOT_ANALYZED 字符串字段，用 `SortField::STRING` 排序，无需重建索引）；顺带修复 `extFilter`/`scopePath` 此前被完全忽略；`scripts/package.sh` 随包产出 CLI 与其启动器；版本 0.1.3 → 0.2.0。
- **pSpore 侧**：新增 `src/plugins/bundled-skills.ts`（读取、asar-unpacked 路径解析、workspace 链接、版本比对升级、保护用户自有目录）并接入 `ExtensionManager`/`Daemon`，链接后的路径一并进入 Pi 的 `additionalSkillPaths`；新增 `bundled-skills/aegis-search/SKILL.md`；构建把 `bundled-skills/` 复制进 `dist/` 并在 `electron-builder.yml` 用 `asarUnpack` 保持为真实文件；新增 `config.indexing` 与 `src/indexing/index-service.ts` 驱动增量索引，进度经 `indexing.status` 领域事件进入 Kernel 权威状态；GUI 检查器"自动化"页新增只读索引面板（进度条、计数、当前文件、下次检查时间）。
- 修改文件：`src/plugins/{bundled-skills.ts,extension-manager.ts}`、`src/indexing/index-service.ts`、`src/daemon/daemon.ts`、`src/kernel/{state.ts,reducer.ts}`、`src/config/config.ts`、`src/desktop/validation.ts`、`src/ui/shared/protocol-state.ts`、`src/desktop/renderer/{index.html,styles.css,renderer.ts}`、`scripts/copy-desktop-assets.mjs`、`electron-builder.yml`、`bundled-skills/**`、新增 `test/unit/{bundled-skills,index-service}.test.ts`。
- 验证方式与结果：`npm run check` 全绿——严格 typecheck、**174/174** 测试、production build。新增 15 项用例覆盖：bundled skill 的读取与版本校验、首次链接与幂等、旧安装路径重指向、真实目录按版本升级、**用户自有目录永不被覆盖**、单个 skill 失败不影响其余、SemVer（含 prerelease）比较、dist/源码/asar 三种布局的根解析且 unpacked 优先；索引服务的 JSON 进度解析、参数传递、失败上报后仍保留下次调度、未启用/无目录/二进制缺失三种降级。渲染层 104 个 `byId` 目标全部存在，构建产物解析通过。测试暴露并修复了 `runNow()` 的真实缺陷——它在定时器回调赋值 `#pass` 之前就 await，导致根本没等待本次索引。
- 当前状态：pSpore 侧机制完整可用；bundled skill 目前只含 `SKILL.md`，二进制待 aegis-searcher 发 release 后接入，此前 `IndexService` 会如实报告 `unavailable`。**版本保持 0.1.15 未提升**，因此 CI 的 release job 会跳过，不会在功能未完整时发版。
- 遗留问题：见 `todo.md` 的四项（二进制接入、C++ 编译验证、boost 调优、索引目录配置入口）。本机无 C++ 工具链与 lucene++/Qt5 开发包，aegis-searcher 的 C++ 改动只能由其自身 CI 编译验证。


## 2026-09-07 CST — aegis-search 二进制接入完成并实机验证

- 阶段目标：把 aegis-searcher 的 CLI 二进制真正接入 pSpore 的 bundled skill，并用真实二进制验证两处检索修复。
- **aegis-searcher 侧**：PR #1 squash 合并到 master；把 loongarch cross job 标记 `continue-on-error` 并从 release 的 `needs` 移除（用户明确只做 x86_64 与 ARM64），`v0.2.0` 首次成功发布 2 项资产。随后实机验证发现 `--sort` 下 `--json` 输出 `"score":nan` 不是合法 JSON（Lucene 字段排序时不计算得分，`ScoreDoc::score` 保持 NaN），修复为非有限值输出 `0`，发布 `v0.2.1`。
- **实机验证（真实 x64 二进制 + 真实索引）**：
  - **排序修复确认生效**：构造等长、等词频、仅相邻性不同的两篇文档，查询「授信 业务」时相邻文档 `0.05652` vs 分离文档 `0.00043`，相差 **130 倍**。排除了长度归一化与词频影响，确认整串短语 boost 是排序差异的来源。relevance 排序的得分未被 nan 修复误清零。
  - **时间排序**：`--sort newest` 得到 2026/2022/2019，`oldest` 相反。
  - **过滤器修复**：`--ext md`→0、`--ext txt`→3、`--scope /nope`→0、`--scope 真实目录`→3（此前 `extFilter`/`scopePath` 被 `parse()` 完全忽略）。
  - **端到端**：pSpore 的 `IndexService` 驱动该真实二进制完成一次索引，状态经 scanning → indexing → idle，处理 3 个文件并安排下次运行；未传 `--index` 时写入 `~/.local/share/aegis/aegis-searcher/index`，即与桌面版共用的索引目录。
- **打包链路**：`bundled-skills/binaries.json` 改为用 `assetTemplate` 派生资产名（资产名内嵌版本号，此前版本与文件名两处重复导致 `--version` 升级后指向旧资产）。`fetch-bundled-binaries.sh` 只取 CLI 二进制与其真正加载的库：排除 ~200MB 的 Qt GUI 二进制与 Qt 插件，再按 `ldd` 闭包裁剪未使用库（74 个 → 33 个，59MB → 51MB），裁剪后复检不得出现 `not found`。私有上游仓库的 release 无法匿名下载，因此优先使用已认证的 `gh`，`curl` 作为公开 release 的回退。
- **CI 取二进制**：`release.yml` 的 x64 打包步骤与 `package-arm64.yml`（经 `secrets: inherit` 并在 `runuser` 环境中显式转发）都接受 `secrets.BUNDLED_BINARIES_TOKEN`，缺失时回退到默认 token —— 此时打包仍成功，skill 不带二进制，运行时如实报 `unavailable`。
- 验证方式与结果：`npm run check` 全绿（174/174），版本提升为 `0.1.16`。
- 遗留问题：需要在 pSpore 仓库创建 `BUNDLED_BINARIES_TOKEN` secret（对 advnljs/aegis-searcher 只读的 fine-grained PAT），否则 CI 发出的包不含索引二进制。排序 boost 的 12/4/6 仍未在大规模真实语料上调优。


## 2026-09-07 CST — 修复渲染器模块图触达 Node 内置模块

- 现象：`0.1.16` 推送后 CI 的 release job 拒绝打 tag，因为同 commit 的 ARM64 构建失败；失败点是 Electron smoke 等待 `document.documentElement.dataset.ready === 'true'` 超时 10 秒。重跑一次仍然失败，说明不是偶发。
- **根因（本轮自己引入）**：`KernelState` 被 Electron renderer 通过 `store.ts` / `protocol-state.ts` 导入，而我把 `IndexingStatus` 与 `initialIndexingStatus()` 放在了 `src/indexing/index-service.ts` 里，该模块导入 `node:child_process`、`node:fs/promises`、`node:path`。渲染器以 `sandbox: true`、`nodeIntegration: false` 运行，无法解析 Node 内置模块，整个模块图加载失败 —— 于是 `initialize()` 根本没执行，`dataset.ready` 永远不会被置位。
- 完整链路：`renderer.ts → store.ts → protocol-state.ts → kernel/state.ts → indexing/index-service.ts → node:child_process`。
- **修复**：新增 `src/domain/indexing.ts` 承载纯类型与 `initialIndexingStatus()`；`kernel/state.ts` 改为从它导入；`index-service.ts` 保留进程/文件系统职责并 re-export 该形状，渲染器永远不会导入它。
- **防回归**：新增 `test/unit/renderer-module-graph.test.ts`，静态遍历渲染器入口的 import 图，发现任何可达的 Node 内置模块即失败并打印完整链路（`import type` 因编译期擦除不计入）。已用「把 bug 改回去」验证该用例确实会失败并准确报出上述链路。这类问题类型检查看不到，x64 CI 也跑不到（只有 ARM 跑真实 Electron smoke），因此必须由单测守住。
- **可诊断性**：`src/desktop/main.ts` 增加渲染器诊断缓冲（console-message / did-fail-load / preload-error / render-process-gone），`waitForRenderer` 超时时一并抛出，避免下次只看到一句无信息的 timeout。
- 验证：`npm run check` 176/176 通过。版本保持 `0.1.16`（此前的 tag 被安全门拒绝，未被消耗）。
- 反思：我先前判断"ARM 失败与我的改动无关"是错的。依据是一个纯文档提交也失败、而 v0.1.15 的 Release 用同一 workflow 构建 ARM 成功；但重跑两次仍失败推翻了该判断，最终静态追踪 import 图定位到确实是本轮改动引入。


## 2026-09-07 CST — 打包环节两处自伤修复

- 上一轮的渲染器修复**生效了**：ARM64 run 34097102036 的「Run Electron desktop smoke」步骤成功，失败点前移到「Package ARM64」。
- **自伤 1：overlay 的 ELF 守卫误伤 shell 脚本**。我加的独立守卫用 `grep -E "ELF|executable"`，而 `file` 对 shell 脚本的描述是 `Bourne-Again shell script, ASCII text executable` —— 含 "executable"，于是随包的 `创建桌面快捷方式.sh` 直接把打包打挂。改为只匹配 `": *ELF "`。**此前的 fixture 用的是零字节 .sh 文件，`file` 报 "empty"，所以完全没覆盖到**；现在 fixture 改用真实内容（真 shell 脚本 + 真 ELF），并验证旧写法在该 fixture 下确实失败、新写法通过、放入真实二进制时仍被拒绝。
- **自伤 2：ARM 构建容器没有 `unzip`**。fetch 脚本硬性要求它。改用 python3 的 `zipfile`（脚本本就依赖 python3 读 manifest），并显式从 `external_attr` 还原权限位。已在把 `unzip` 屏蔽成 exit 127 的 PATH 下实测跑通：校验 → 裁剪 59MB→51MB → 安装 → 二进制可执行。
- 同时验证：skill 二进制位于 `payload/resources/app.asar.unpacked/dist/bundled-skills/...`，确实在 overlay payload 内 —— 即 overlay 升级会一并替换索引器（此前只是推断，现已由 fixture 证实）。
- 验证：`npm run check` 176/176。


## 2026-09-07 CST — v0.1.16 发布、真实安装目录 overlay 升级验收、索引配置 CLI

- **v0.1.16 已发布**：`https://github.com/advnljs/pSpore/releases/tag/v0.1.16`，非 draft，12 项资产，overlay checksum 校验通过。下载实际 overlay 确认其中含 `bundled-skills/{README.md,binaries.json,aegis-search/SKILL.md}`；**不含二进制**，因为仓库尚未配置 `BUNDLED_BINARIES_TOKEN`——这是预期的降级路径，打包不失败。
- **真实安装目录 overlay 升级验收（此前记为受阻的 P1）**：用先前解包在 `/tmp/pspore-electron-libs-*` 的运行库（只对测试进程生效，未改系统）让目标安装的 Electron 可作 Node 运行，于是能在 `release-dist` 真实 0.1.14 安装的副本上实跑发布出来的 0.1.16 overlay。结果：进度条 5%→100%；逐项复核——`pspore-desktop`、`libGLESv2.so`、`icudtl.dat`、`resources.pak` 四个 Chromium 文件 SHA-256 与升级前**完全一致**（确未替换运行时）；应用版本由 0.1.14 变为 0.1.16；bundled skill 随 `resources/app.asar.unpacked/dist/` 一同进入；指向**其它目录**的既有快捷方式被重新指向本次升级目录（`install-dir` 已更新，desktop entry 仍用稳定 launcher）；回滚备份中保存的是 0.1.14。
- **升级后的安装可正常启动**：以短路径 `PSPORE_HOME` 启动守护进程（长路径会触发 UDS 108 字节限制，属测试环境问题而非缺陷），`status` 显示 `Daemon: ready`；`workspace/skills/aegis-search` 已被链接为指向 `resources/app.asar.unpacked/dist/bundled-skills/aegis-search` 的 symlink，且可透过它读到 `SKILL.md`；`config.json` 中已含新的 `indexing` 段。
- **新增索引配置 CLI**：`pspore config indexing show|on|off|add DIR|remove DIR|interval MINUTES|ext a,b,c`。目录解析为绝对路径并校验存在且为目录（打错字会静默索引不到任何东西），写回前用 `parseConfig` 按守护进程的读取方式复验。新增 1 项集成用例覆盖：默认关闭且无目录、增删改查、重复添加不产生重复项、写回后仍能被 `parseConfig` 读出、以及不存在目录/非法间隔/未知子命令三条错误路径。
- 验证：`npm run check` 177/177。


## 2026-09-07 CST — 索引 GUI 设置项与排序实机调优结论

- **GUI 设置项**：设置弹层新增「本机索引」区——启用开关、检查间隔、文件类型、以及可增删的索引目录列表。渲染器没有文件系统权限，绝对路径只能来自主进程的原生目录选择器（新增 `pspore:desktop:indexing:{get,save,pick}` 三个 IPC 通道）。保存与模型设置共用同一个按钮：先存 LLM 设置，再存索引设置，两条消息合并显示。索引配置由新的 `IndexingSettingsService` 读写，写入前一律经 `parseConfig` 复验，客户端不可能留下守护进程读不了的文件。若发行版未附带索引二进制，面板会如实说明"启用后会报告不可用"。
- **排序 boost 实机调优结论：维持 12/4/6，不调整**。构造 75 篇语料（60 篇干扰文档刻意使用与查询共享单字的词汇，使单字分词真正产生碰撞；另有整串/近距/远距各 5 篇）：
  - 「授信业务」（单词查询）仅 5 篇整串文档命中——短语查询要求连续，精确率 100%。
  - 「授信 业务」（空格分词）整串文档占据前五，得分 0.05–0.077，其余为 0.008–0.012，约 **5–7 倍**差距。
  - 语料中 near/far 交错是我构造时长度与词频不一致所致，非 boost 失效：在等长等词频的受控实验中，整串/拆字为 **130 倍**、近距离/远距离为 **11.3 倍**，三个 boost 均确认生效。
- **新增回归守护**：`test/integration/aegis-search-ranking.test.ts` 用真实二进制锁定四条不变量（整串优先、近距优先、单词查询要求完整短语、按时间排序且 JSON 中 score 为有限数）。二进制未随包时自动 `skip`，因此 CI 不会因缺少它而失败；本机有二进制时 4/4 通过。
- 验证：`npm run check` **183/183**（有二进制），无二进制时 4 项跳过、其余全通过。


## 2026-09-07 CST — 二进制随包发布前的两处修复

- **ARM 构建容器既没有 `gh` 也没有 `curl`**（`ubuntu:20.04` 容器只装了 `python3`、`ca-certificates` 等）。原下载逻辑优先 `gh`、回退 `curl`，在 ARM 上两者皆无 → 静默走 best-effort 警告，结果会是 **x64 带二进制、ARM 不带**的不对称发布。这是读 workflow 的依赖清单时发现的，不是等它失败才发现。改为统一用 `python3` 走 GitHub API 下载（先按 tag 取 release 找到 asset id，再以 `Accept: application/octet-stream` 拉取；私有仓库的 browser URL 不对 API token 提供服务，所以必须走 asset id）。已在把 `gh`/`curl`/`wget` 全部屏蔽为 exit 127 的 PATH 下实测：校验 → 裁剪 → 安装 → 二进制可运行；无 token 时给出 `HTTP 404 / 该仓库可能是私有的，请设置 GH_TOKEN` 的明确提示。
- **preload API 面被固定，新增方法会让 smoke 失败**：`main.ts` 用一个精确字符串固定 preload 暴露的方法名，这是有意的安全断言——preload 是渲染器唯一的能力面。本轮新增 `getIndexing`/`saveIndexing`/`pickIndexDirectory` 后未同步该列表，ARM smoke 报 `preload API surface changed`。已更新固定列表并让失败信息打印实际值与期望值。
- **新增漂移守护**：`test/unit/desktop-security.test.ts` 增加一项用例，解析 `preload.cjs` 实际暴露的方法名与 `main.ts` 固定列表比对。已用"临时给 preload 加一个方法"验证该用例确实失败。此前这类漂移只有那个跑真实 Electron 的 ARM job 能发现。
- 验证：`npm run check` **184/184**。


## 2026-09-07 CST — 长任务掉线与"重启也连不上"的根因修复

- 阶段目标：用户报告长任务运行中与守护进程 `lost connection`，且出现后重启应用一直保持 lost connection。定位真实根因并修复，而不是继续调重连体验。

### 复现（用当前发布代码 HEAD `1deca2f`，在临时 worktree 中跑同一套压测脚本）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 长任务：1 MiB transcript（2000 条消息）+ 20000 个流式 token + 200 次工具调用 | 耗时 **147561 ms**，GUI bridge **断开 66 次**，结束时仍停在 `connecting`，守护进程堆 **752 MiB** | 耗时 **2341 ms**，GUI bridge **断开 0 次**，`connected`，堆 **167 MiB** |
| 会话中存在一条 300000 字符的消息（大文件读取/长构建日志/长回答） | GUI bridge 5 秒内 **重连 95 次**，消息为 `Protocol string exceeds 262144 characters`；因为该消息在权威快照里、快照又从 JSONL 恢复，**重启守护进程也永远连不上** | 立即 `connected`，attempts `0` |

### 根因

1. **每个流式 token 都要复制整份会话**。`AgentApplication.#onRuntimeEvent` 对所有 runtime 事件（含 `message.delta`）重建 `AgentSnapshot`：`session.messages.map()` 再加 `sessionManager.getBranch()` 全量渲染文本；reducer 又 `structuredClone` 一次；`KernelLoop` 还对**每个事件**深拷贝整份 kernel state（effect runner 参数）以及 `dispatch()` 的返回快照。实测 1 MiB transcript 下单次深拷贝 1.33 ms，20000 token 的一轮任务光复制就要 26.5 s，事件循环被占满 → socket 积压 → 客户端被判定为"太慢"而断开。
2. **每个 durable 事件都把整份 transcript 搬上线**。一次工具调用产生 4 条 durable 事件，每条都带完整 `session`，`AgentSnapshot.entries`（未压缩的完整分支、全项目无人读取）还让体积翻倍。
3. **超限内容会永久锁死客户端**。桌面端校验单串 262144 字符/集合 10000 项/深度 32/节点 100000，超限即关连接；权威快照每次重连都重发同一份内容，`entries` 又随会话无界增长，于是"一次超限 = 永久掉线"，且重启无效。
4. **systemd start limit**。守护进程若反复崩溃（例如未捕获 rejection 或内存压力），5 次后 unit 进入 `failed`，之后 `enable --now` 一直被 "start request repeated too quickly" 拒绝，跨客户端重启保留——这是"重启应用也没用"的第二条路径。

### 完成内容

- 新增 `src/protocol/limits.ts`：客户端上限与守护进程出站上限集中定义；`boundPublishedValue`/`measurePublishedValue` 未超限时结构共享（典型 delta payload 0.001 ms），超限时截断字符串（保留头部并注明截断量）、保留数组尾部、按 8 MiB 单值预算从尾部开始分配，深度超限替换为占位串。
- `LocalGateway`：hello 快照 / 事件 payload / 命令响应各裁剪一次；进出背压预算分离（新增 `maxOutgoingBytes`，默认 64 MiB），只有真正停止读取的客户端才被断开；replay window 增加 16 MiB 字节上限；帧编码失败只断开该连接而不影响其它客户端与守护进程；断开原因经 `onWarning` 写 journal。收包缓冲改为带扫描偏移，不再对每次读取重扫整段。
- `ProtocolClient`：同样的扫描偏移；hello 与单订阅者事件不再重复 `structuredClone`。
- `AgentApplication`：瞬时事件不再构建快照；`runtime.received` 新增 `publishSnapshot`，settling 事件（run.started/run.settled/session.replaced/runtime.error/message.completed/compaction.completed/queue.updated）必带快照，其余每 session 250 ms 最多带一次；kernel state 始终吸收快照，因此 `status.get`/hello 仍然权威。
- `KernelLoop`：`dispatch()` 返回值与 effect runner 参数改为共享不可变 state（注释写明约定），去掉每事件两次整份 state 深拷贝；`snapshot()` 作为协议边界仍深拷贝。
- 删除 `AgentSnapshot.entries`，改由 `PiRuntimeAdapter.branch(sessionId)` 按需取（fork 定位 entry id 的能力保留）。
- `SystemServiceManager`：启动/重启前检查 `is-failed` 并 `reset-failed`，结果经 `recoveredFromFailure` 上报，CLI/GUI 各打印一行。
- 守护进程可诊断性：`p-spore daemon` 注册 `unhandledRejection` 只写 journal 不退出；`daemon.ts` 中所有回调式 `kernel.dispatch` 经带 catch 的 `emit` 包装。
- `DaemonBridge`：拒帧/缺口的真实原因作为断线消息上报（此前静默重连无从诊断）；退避睡眠可被 `stop()` 打断（关窗不再最多等 5 秒）。
- `desktop/validation.ts` 改为引用共享常量，节点上限提到 2000000（守护进程出站已远低于此，留足余量避免"合法但大"被误杀）。

### 修改文件

- 新增：`src/protocol/limits.ts`、`test/unit/protocol-limits.test.ts`
- 协议/网关：`src/gateway/local-gateway.ts`、`src/protocol/client.ts`
- 内核/应用：`src/kernel/loop.ts`、`src/kernel/reducer.ts`、`src/kernel/state.ts`、`src/application/agent-application.ts`、`src/domain/runtime.ts`、`src/pi/pi-runtime-adapter.ts`、`src/daemon/daemon.ts`
- 客户端/服务：`src/desktop/validation.ts`、`src/desktop/daemon-bridge.ts`、`src/desktop/smoke-fixture.ts`、`src/desktop/main.ts`、`src/cli/main.ts`、`src/service/system-service.ts`
- 测试：`test/unit/protocol-limits.test.ts`、`test/unit/system-service.test.ts`、`test/integration/local-gateway.test.ts`、`test/integration/daemon.test.ts`、`test/integration/desktop-daemon-bridge.test.ts`、`test/contract/pi-runtime-adapter.test.ts` 及移除 `entries` 的若干 fixture
- `dist/**`（构建产物同步）

### 验证方式与结果

- `npm run check`：**195/195** 通过（严格 typecheck + 全量测试 + production build）。新增 9 项用例：出站裁剪四项（客户端上限内、结构共享、深度占位、整体预算优先保留尾部）、网关裁剪与 replay 字节上限两项、守护进程"超长消息下桌面端仍可连接"与"快照按需附带"两项、systemd `reset-failed` 一项、bridge 拒帧/缺口原因两项。
- 前后对比压测：见上表，脚本在 scratchpad（`stress.ts` / `lockout-check.mts`），基线用 `git worktree` 跑 HEAD，未污染工作树。
- 微基准：1 MiB transcript 深拷贝 1.327 ms/次、JSON 编码 1.461 ms/次；`boundPublishedValue` 对典型 delta payload 0.001 ms、对整份快照 0.541 ms。
- **未执行 Electron 实机 smoke**：本机缺 `xvfb-run` 与 `libnspr4`（与历史记录一致），由 CI 的 ARM64 job 执行 `npm run test:electron`。本轮改动触及 `daemon-bridge`/`validation`/`smoke-fixture`，需要关注 CI 的 reconnect 与 preload 断言。

### 当前状态

- 长任务掉线与"重启也连不上"两条链路均已在真实守护进程 + 真实 UDS + 真实 GUI bridge 上验证修复。
- 未发版；`dist/` 已随源码同步。

### 遗留问题

- GUI transcript 现在最多显示最近 2000 条消息 / 8 MiB；超出部分只在守护进程侧保留（JSONL 完整）。若要在客户端保留完整历史，需要改为按 offset 的增量 transcript 协议，见 `todo.md`。
- 多根会话都很大时，hello 的 8 MiB 预算按 sessions 插入顺序分配，靠后的会话可能拿到较短的 transcript；它们在下一次自身 settling 事件时会恢复。


## 2026-09-07 CST — 阶段 1／3：服务器级快照瘦身（参考 Pi / Codex / OpenClaw）

- 阶段目标：消除"快照体积随会话长度增长"这一结构性问题的第一层——服务器级快照不再携带每个会话的完整 transcript。
- 参考实现（三家做法一致，pSpore 此前每条都反着来）：
  - **Pi**（我们的上游）：`ServerSnapshot` 只含 `SessionMetadata[]`（id/name/cwd/时间），**不含 transcript**；带 transcript 的 `SessionSnapshot` 按会话 open 时取一次并带 `revision`；增量走 item 级 `item_started`/`item_updated`/`item_finished` + `assistant_delta{messageId,contentIndex,kind}`；客户端把 progress 作 overlay 叠在 snapshot 上（`applyTranscriptProgress`/`selectTranscript`）。
  - **Codex**：纯 item-scoped，`AgentMessageContentDelta{item_id,turn_id}`、`ExecCommandBegin/OutputDelta/End{call_id}`，**没有任何事件携带完整历史**。
  - **OpenClaw**：`sessions.messages.subscribe` 按会话订阅，`session.message`/`session.operation`/`session.tool` 都是单条增量；历史走 `chat.history` 分页 + 不透明 `deltaCursor`，cursor 失效返回 `{kind:"reset"}`。
- 完成内容：
  - `src/domain/runtime.ts` 拆出三层：`SessionMetadata`（不含 transcript，新增 `messageCount`/`firstUserText`）、`SessionView`（元数据 + 有界尾窗 + `messageOffset`，**广播用**）、`AgentSnapshot`（运行时自用，含完整 messages）。
  - `KernelState.sessions` 改为 `Record<string, SessionView>`；广播的尾窗固定 200 条（`SESSION_VIEW_TAIL_MESSAGES`），与会话长度无关。
  - 新增 `session.transcript {from?, limit?}` 命令（单页上限 500 条），按范围取历史；桌面 IPC 增加对应 action 与严格解码。
  - 会话标题改用 `firstUserText`（尾窗里通常已经没有开场白），TUI 160×45 快照哈希与改动前**逐字节一致**，证明渲染未变。
  - `desktop/validation.ts` 的 `validateAgentSnapshot` 改为 `validateSessionView`，校验 `messageCount`/`messageOffset`/`firstUserText`。
- 修改文件：`src/domain/runtime.ts`、`src/pi/pi-runtime-adapter.ts`、`src/kernel/state.ts`、`src/application/agent-application.ts`、`src/ui/shared/presentation.ts`、`src/ui/shared/protocol-state.ts`、`src/desktop/{validation,ipc-contract,smoke-fixture}.ts`、若干测试 fixture、`dist/**`。
- 验证方式与结果：
  - `npm run check`：**196/196** 通过（严格 typecheck + 全量测试 + production build）。新增用例断言 602 条消息的会话广播出 200 条尾窗、`messageOffset=402`、`messageCount=602`，`session.transcript` 能取任意区间与默认尾页，新客户端 hello 同样只拿 200 条。
  - 压测（1 MiB transcript + 20000 token + 200 次工具调用）：**1042 ms**、GUI 断开 0 次、堆 **113 MiB**。对照：修复前 147561 ms / 66 次 / 752 MiB，上一轮 2341 ms / 0 次 / 167 MiB。
- 当前状态：广播与 hello 的体积已与会话长度解耦；`limits.ts` 的整体预算退化为纯安全网。
- 下一步（阶段 2）：把事件改为 item 级——adapter 保留 Pi 的 item 身份，广播 `transcript.item.{started,updated,finished}` 与 `transcript.delta{itemId,contentIndex,kind}`，客户端按 Pi 的 overlay 模型合并；随后即可撤掉 250 ms 快照节流与 `publishSnapshot`。


## 2026-09-07 CST — 阶段 2／3：item 级 transcript 事件

- 阶段目标：让事件只描述"变了什么"，而不是每次都重新描述整段对话。
- 关键事实（读 Pi 源码得到）：Pi 的 `Message` 对象**没有 id**，只有 `SessionManager` 持久化的 branch entry 有。所以 item 身份必须由 adapter 分配——Pi 自己的服务端也是这么做的。
- 完成内容：
  - 新增 `TranscriptItem`（id/role/text/thinking/status/ts）与 `TranscriptDeltaKind`；`message.started`/`message.delta`/`message.thinking.delta`/`message.completed` 四个事件被 `transcript.item.started`/`transcript.delta`/`transcript.item.finished` 三个取代。
  - adapter 为每个流式 item 分配 `${upstreamSessionId}:${n}` 的 id 并维持整个生命周期；每条 delta 携带 `itemId` + `kind`；`message_start` 缺失时也会自动开一个 item，delta 永远有落点。
  - **广播只在必要时携带 transcript**：`run.settled`/`session.replaced`/`runtime.error`/`compaction.completed` 携带尾窗，其余非瞬时事件只携带会话元数据（无 `messages`）。客户端合并元数据时保留自己已有的消息。
  - **`transcript.item.finished` 不再搬运尾窗**：事件本身就带着这条消息的完整文本，客户端直接追加并把 `messageCount` 加一；`run.settled` 的权威尾窗负责校正任何漂移（Pi 的 snapshot-resets-overlay、OpenClaw 的 cursor-stale-reset 都是这个思路）。
  - 撤掉阶段 1 引入的 250 ms 快照节流与 `#snapshotPublishedAt`——不再有"整份快照"需要节流，状态更新恢复为即时。
  - 客户端新增 `streamingItems`（每会话当前流式 item），delta 属于被取代的 item 时另起缓冲，不会再把两次回答粘在一起。desktop delta 合并键从 `sessionId+channel` 改为 `sessionId+itemId+channel`。
- 修改文件：`src/domain/runtime.ts`、`src/pi/pi-runtime-adapter.ts`、`src/kernel/{state,reducer}.ts`、`src/application/agent-application.ts`、`src/ui/shared/protocol-state.ts`、`src/ui/tui/store.ts`、`src/desktop/{validation,ipc-contract,daemon-bridge,main}.ts`、`src/desktop/renderer/store.ts`、`src/cli/main.ts`、相应测试、`dist/**`。
- 验证方式与结果：
  - `npm run check`：**198/198**（严格 typecheck + 全量测试 + production build）。新增两项用例：finished item 直接追加进 transcript 且 `messageCount` 同步；被取代 item 的 delta 不会污染屏幕上的消息。daemon 用例改为断言"只有 `run.settled` 带 `messages`，工具事件只带元数据"。
  - 压测（1 MiB transcript + 20000 token + 200 次工具调用，统计单个客户端收到的字节）：**10.2 MiB → 5.9 MiB**（阶段 1 → 阶段 2），耗时 1064 ms、0 次断开、堆 108 MiB。
  - 说明：把 `transcript.item.finished` 从"携带尾窗"改为"客户端追加"之前，字节数是 11.0 MiB（比阶段 1 还略高，因为 delta 多了 itemId/kind 字段）。真正的收益来自不再重复搬运尾窗。
- 当前状态：非结算事件的 payload 与会话长度完全无关；transcript 只在产生时传一次。
- 下一步（阶段 3）：GUI 虚拟列表滚到顶时用 `session.transcript` 向前翻页；历史改从持久化分支读，使 compaction 后仍能看到完整对话；单条超长消息改为"截断 + 按需取全文"。


## 2026-09-07 CST — 阶段 3／3：历史分页与运行时不再物化 transcript

- 阶段目标：把"客户端只能看到最近 200 条"这个阶段 1 的取舍还回去，并让守护进程本身也不再随手物化整份对话。
- 完成内容：
  - **`AgentRuntimePort` 换形**：`snapshot()` 返回 `SessionMetadata`（**不含 messages**），新增 `transcript(sessionId, {from, limit})` 返回 `TranscriptPage`。`AgentSnapshot` 类型被删除——守护进程里已经没有任何地方需要"整份 transcript"这个对象。
  - **历史读持久化分支**：`transcript()` 走 `sessionManager.getBranch()` 而不是模型 context，因此 **compaction 之后仍能翻到被压缩掉的对话**。只渲染被请求的那一段文本；`messageCount` 只数条目不渲染文本；`firstUserText` 带缓存并在 fork/newSession 时失效。
  - **GUI 滚动回溯**：滚到距顶 240px 时自动请求前一页（200 条），合并后按"距底距离"复位视口而不是按 scrollTop，因此不跳动；虚拟列表的 key 改用**绝对位置**（`messageOffset + index`），前插历史不会让已测高度全部失效。
  - **TUI 回溯**：PageUp 到已加载历史顶部时发同样的请求；失败只在状态行提示。
  - **共享 `applyTranscriptPage`**：只允许前插，拒绝会留下空洞的页与已覆盖的重复页。
  - `session.snapshot` 命令改为返回有界的 `SessionView`（此前是完整 transcript），CLI/GUI/TUI 的用法不变。
- 修改文件：`src/domain/runtime.ts`、`src/pi/pi-runtime-adapter.ts`、`src/application/agent-application.ts`、`src/agents/agent-manager.ts`、`src/ui/shared/protocol-state.ts`、`src/ui/tui/{store,view,tui-app}.ts`、`src/desktop/renderer/{store,renderer}.ts`、`src/cli/main.ts`、相应测试、`dist/**`。
- 验证方式与结果：
  - `npm run check`：**199/199**（严格 typecheck + 全量测试 + production build）。新增用例：真实 Pi adapter 手动 compaction 之后 `transcript()` 仍能取到被压缩掉的 `create history 0`，且默认尾页定位正确；`applyTranscriptPage` 的前插、空洞拒绝与重复拒绝三条路径。
  - 压测（同一场景）：1036 ms、0 次断开、单客户端 5.9 MiB、堆 124 MiB。
- 当前状态：三阶段完成。事件只描述变化，快照与会话长度解耦，历史按需分页且比改造前更完整（compaction 不再吞掉可见历史）。
- 遗留：GUI 回溯的实机滚动手感只有 CI 的 Electron smoke 覆盖，本机无 `xvfb-run`/`libnspr4`；`limits.ts` 的整体预算现在只是安全网，正常路径不会触发。


## 2026-09-08 CST — 三阶段改造复审修复与单条超长消息按需取全文（`0.1.18`）

- 阶段目标：复审 `391efff` 之后三个提交（`4626e5e`/`2d172a7`/`c99b745`）引入的问题，并实现 todo 里的"单条超长消息仍按 64 KiB 截断显示"。
- 复审发现并修复：
  - **回溯的历史会被下一次权威尾窗丢掉**（P1，`src/ui/shared/protocol-state.ts`）：`run.settled`/`compaction.completed` 携带 200 条尾窗时，客户端整体替换 `messages`，读者刚翻上来的历史立刻消失、视口跳动。改为 `mergeScrollback()`：同一 `upstreamSessionId` 且旧前缀能接上新尾窗时保留前缀；`session.replaced` 会重编号，因此仍整体替换。
  - **`p-spore sessions` 的消息数被尾窗截断**（P2，`src/cli/main.ts:889`）：`session.messages.length` 最大只有 200，改用 `session.messageCount`。
  - **`firstUserText` 缓存了"没找到"**（P2，`src/pi/pi-runtime-adapter.ts`）：新会话在第一条用户消息之前被 snapshot 时会把 `""` 永久缓存，此后标题回退永远拿不到首条用户消息。改为只缓存已经找到的值。
  - **回填历史会重放尾部消息的入场动画**（P3，`src/desktop/renderer/renderer.ts`）：`messages.length > previousCount` 把"前插 200 条"误判为"尾部新增 200 条"。改为比较绝对位置 `messageOffset + length`。
  - **TUI 每次 PageUp 都请求一页历史**（P3，`src/ui/tui/view.ts`）：不管有没有翻到已加载的最旧一条都发请求。改为由渲染发现"窗口已越过全部已加载消息"时才回调 `onHistoryExhausted`。
- 单条超长消息按需取全文：
  - `limits.ts` 新增 `publishedTextTruncation()`，解析 `boundPublishedText()` 自己写下的截断标记；标记格式仍只有一处定义。
  - `AgentRuntimePort` 新增 `transcriptMessage(sessionId, {id|index, offset, limit})`，按持久化 branch entry id 定位（index 作为回退），**分片**返回原文；单片上限等于 `MAX_PUBLISHED_STRING_CHARS`，因此出站不会被二次截断。
  - 新命令 `session.message`，desktop IPC 同步加入允许列表并做边界校验。
  - GUI：被截断的消息下方出现"仅显示前 N / M 个字符 · 载入全文"；点击后由共享的 `readFullMessage()` 逐片取回、拼接、就地替换重渲染；失败按钮回到"重试载入全文"。已恢复的全文按 session+entry 缓存，最多保留 4 条。
- 修改文件：`src/protocol/limits.ts`、`src/domain/runtime.ts`、`src/pi/pi-runtime-adapter.ts`、`src/application/agent-application.ts`、`src/ui/shared/{protocol-state,full-message}.ts`、`src/ui/tui/view.ts`、`src/desktop/{ipc-contract,main,smoke-fixture}.ts`、`src/desktop/renderer/{renderer.ts,styles.css}`、`src/cli/main.ts`、`src/version.ts`、`package.json`、相应测试、`dist/**`。
- 验证方式与结果：
  - `npm run check`：**205 项、201 通过、4 跳过、0 失败**（严格 typecheck + 全量测试 + production build）。新增用例：权威尾窗到达时保留回溯历史且 `session.replaced` 仍整体替换；`session.message` 端到端把 300 000 字符消息分 5 片取回并与原文逐字相等，id 缺失时报错；adapter contract 按 entry id 分片读取；`readFullMessage` 的多片拼接、错位拒绝与空片保护；`publishedTextTruncation` 的正反例；desktop IPC 对 `session.message` 的边界与必填校验；TUI 只在越过已加载历史时请求下一页。
  - `npm run test:electron`：**本机实跑通过**（此前 todo 记录本机缺 `xvfb-run`/`libnspr4`，本轮确认两者均已具备，`electron` 二进制经 npmmirror 下载）。`1920×1080` 主基准 + `1440×900`/`1180×720` 补测、双主题、owned/external Daemon、重连与 IPC allowlist 全部通过；新增两条断言：截断消息渲染出"载入全文"入口，且被拒绝的载入会把按钮恢复为"重试载入全文"。截图已人工复核（深/浅两套主题下提示行与按钮排版正确）。
- 发布：CI run `34142793645` 与 ARM64 preview `34142793667` 均成功，`release` job 创建 annotated `v0.1.18` 并派发 Release run `34143092977`（成功，12 项资产，非 draft/prerelease）。远端复验：`pspore-desktop-0.1.18-linux-x64-overlay.zip` 的 SHA-256 校验通过，`overlay-manifest.json` 为 `appVersion 0.1.18` / `electron 43.3.0` / `x64`，包内 `app.asar` 含 `PSPORE_VERSION = "0.1.18"` 与本轮新增的 `session.message`、`message-truncated`、`载入全文`。
- 当前状态：`v0.1.18` 已发布并远端复验通过。
- 遗留：TUI 侧未提供"载入全文"入口（TUI 本身按宽度截行，价值低）；守护进程对每个非瞬时事件仍会渲染 200 条尾窗，虽然与会话长度无关，但对非结算事件是白做的。两项已记入 `todo.md`。
