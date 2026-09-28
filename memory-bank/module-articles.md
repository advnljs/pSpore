# module: articles（文稿面板）

## 模块职责

长文不进聊天。模型用 `article` 工具在工作区里维护一份 Markdown 文稿；桌面端打开独立面板，流式渲染当前草稿，提交后对照上一版并做段落动画。导出在主进程完成。

### 正文改走普通文本流（0.1.32）

- 用户确认目标机是自研代理，主对话能流式但 article 仍等结束；增加 `action=write`，参数仅传短 `instruction` 与新文稿 `title` / 修订 `id`。通过当前 ModelRuntime、模型、认证与 thinking 配置发起普通文本流，正文不再装进工具参数。
- `writer.ts` 继承压缩后的会话上下文与修订基线，去掉当前未完成工具调用，把历史工具结果标成参考资料，移除历史 tool calls/thinking，保证 OpenAI 请求不携带 `tools`（包括空数组）。不创建额外 agent，不新增配置或依赖。
- 文本 delta → 私有 tool progress → adapter 的 `ArticlePreviewBus` → 原有单循环取稿/面板。先发送空草稿打开面板，后续正文不进 transcript、工具活动或广播；广播也裁剪 instruction、edits-only 输入和私有进度字段。
- 只有成功结束且非空、未超大小上限才提交一个版本；中止、断流、length 截断不保存半篇，也不覆盖原版。返回 Pi 原生工具结果 `usage`，纳入持久化会话 token/费用统计。
- 工具提示与内置 article-canvas skill 0.1.2 默认指导生成/修订使用 write。旧 create/update 保留给用户提供的精确正文或小补丁；open 为可选准备步骤，返回后使用 write。
- 集成测试用真实 HTTP/SSE → Pi → Daemon → UDS → Bridge，验证工具参数整块到达后仍能从文本流增量取正文、创建/修订请求均无 tools、正文不泄露到聊天、usage 统计与失败保护。Electron smoke 同时验证正文尚未结束时已多次刷新。
- 需重启 Daemon 并新建会话以载入新工具/skill 提示；仍需目标机实测确认自研代理的普通文本请求行为。

### 打开后停在少量文字的恢复（0.1.31）

- `ArticlePreviewBus` 的 120 ms 节流改为首条立即发布、被合并的最后一条定时补发；网关发完一批参数后暂停，也不会把末次草稿通知一直留到工具结束。完成调用、会话结束/中止、dispose 都清理待发计时器与草稿。
- 面板保留单个取稿循环，在循环空闲后 300 ms 补取一次，直到提交、失败、中止、关闭或切换会话。用于恢复瞬时通知被背压丢弃、一次取稿失败后不再来事件的场景；不并行堆叠请求，相同草稿不重绘。
- 实际 Electron 对照：旧渲染器在屏上已有正文后丢弃预览通知、注入一次读取错误，10 s 内无法显示新内容；新实现不需要新事件或工具结束就能恢复。1920×1080 / 20× CPU / 250 ms 读延迟下，约 1.34 万字 Markdown 在结束前多次刷新；中止不保存版本且停止补取。
- 这修复的是已有草稿未及时送到面板的路径。尚未收到的 API 字节仍无法展示；未直接连接内网目标机，目标机升级复验仍需单独完成。

### OpenAI 兼容接口的提前打开（0.1.30）

- 文本 SSE 与工具参数 SSE 是不同能力；接口可以流式发送文本，却把 `tool_calls[].function.arguments` 缓冲到最后。客户端无法在字节到达前渲染正文。
- `article action=open` 是独立的短准备调用：新文稿传 `title`，已有文稿传 `id`，必须等其返回后在下一轮调用 `create/update`。工具 description、promptGuidelines 与内置 skill 都包含该要求，避免只依赖模型读取 skill。
- `open` 不创建文件或版本，也不返回已有文稿正文；读取已有 id 仍检查 session，标题复用 `cleanTitle` 校验。携带 content/edits/version 会报错。
- 新回执 `article open`（已有文稿为 `article open <id> version N`）由 `parseArticleOpenReceipt` 识别。面板通过既有 `tool.completed` 提前展开，显示「等待正文/修改」；新文稿清理上一篇内容并禁用导出，已有文稿先显示已保存版本。未写入即结束/中止时清理等待提示。
- 支持参数增量的接口继续使用原有 120 ms 预览与单取稿循环。缓冲接口按小节完成后更新，不伪造逐字输出。提前打开仍取决于模型遵循独立短调用，整个响应均被服务端延迟时无法消除第一轮延迟。
- 回归：`test/integration/article-stream.test.ts` 经真实本地 HTTP/SSE → Pi → Daemon → UDS → `DaemonBridge`；`npm run test:article-stream` 在实际 Electron DOM 中验收 `1920×1080`、20× CPU、250 ms 取稿延迟、120 ms 连续参数分片、缓冲正文、失败与中止。仅本地模拟 API，不代表目标机/真实模型已复验。

这和 `src/documents/` 的 `document` 工具不是一回事：`document` 只抽取用户已有文件的正文。也和 shell/MCP 溢出的 `~/.pspore/artifacts` 不是一回事。

## 入口文件

- 工具：`src/articles/tool.ts` 的 `createArticleTools`，由 `src/daemon/daemon.ts` 注册。
- 存储：`src/articles/store.ts` 的 `ArticleStore`。
- 面板：`src/desktop/renderer/article-panel.ts`。
- 导出：`src/desktop/article-export.ts` 的 `exportArticleFile`。
- Skill：`bundled-skills/article-canvas/SKILL.md`。

## 关键文件

| 文件 | 职责 |
|---|---|
| `store.ts` | `~/.pspore/workspace/articles/<id>/`：`meta.json`、`v0001.md`…、`current.md`。id 为 `art_` + 12 位十六进制。单篇最多 400_000 个 UTF-16 码元、100 个版本。内容不变不追加版本。读和改都核对 session。路径经 realpath，拒绝逃出目录。NUL 换成 U+FFFD |
| `tool.ts` | `open` / `write` / `create` / `update` / `read`。write 用短指令启动普通文本流；open 返回独立 `article open` 回执，不存版本；其他回执第一行固定 `article art_xxxxxxxxxxxx version N`，随后是标题、字数和版本变化。`read` 把正文给模型，广播侧会裁掉 |
| `writer.ts` | 当前模型普通文本流、会话参考材料、修订基线、大小/中止/结束校验及原生 usage。仅服务端使用 |
| `diff.ts` | 按空行切段，围栏代码整段保留。LCS；段落积超过 250_000 时退化为前后缀。另有 `diffArticleLines()`：先裁公共首尾再对中间 LCS，`token` 粒度把相邻的删除串/新增串按位配对、逐 token 求 LCS，只在相似度 ≥ 0.4 时标到行内。分词按拉丁串/空白成串、其余逐字，中英都成立。渲染器可导入，无 Node |
| `preview.ts` / `draft.ts` | 从 Pi `toolcall_delta` 里取出正在写的调用：`action` 为 `create`/`update` 即算数（不等正文），`read` 忽略；`content` 整篇草稿，或 `edits` 中 `find` 已写完整的那几处（键顺序即解析顺序：`replace` 出现在 `find` 之后才算引文闭合），最后一处的 `replace` 可能还在写（`editOpen`）。`id` 必须完整匹配 `art_` + 12 位十六进制，半截 id 不算。预览总线 120 ms 节流，edits 按长度判等（参数只增不减）。write 的正文从私有工具进度接入同一总线。事件只带 toolCallId、标题、id 和字数，正文留在进程内 |
| `edits.ts` | `applyArticleEdits`（提交：按序替换首次出现，找不到抛错）与 `previewArticleEdits`（预览：找不到跳过；写到一半的替换若仍是原文前缀则原文不动，已分岔则按块 1:1 顶替、没写到的旧块留着）。无 Node |
| `publish.ts` | 广播前去掉工具参数里的 `content` / `edits` / `instruction` 及工具进度里的 `articleDraft`，工具结果只留前 4 行，避免正文冲上 64 KiB 出站上限 |
| `receipt.ts` | 解析回执，供面板和聊天卡片定位文稿 |
| `plain.ts` / `html.ts` / `docx.ts` / `zip-write.ts` | txt 去掉 Markdown 标记，嵌套列表按两空格逐级缩进；pdf 用 HTML，列表项的首段直接内联进 `<li>`（包成 `<p>` 会让 ☑ 和文字分行、每项多一段行距）；docx 是自写的 WordprocessingML ZIP（`node:zlib`，无新依赖），`numbering.xml` 声明 9 级、字体用 Calibri/Consolas/宋体这类目标机上真实存在的名字，ZIP 条目写 1980-01-01 的合法 DOS 日期。`plain.ts` 与 `html.ts` 无 Node，可被渲染器导入；`docx.ts` 与 `zip-write.ts` 不行 |
| `article-export.ts` | 保存对话框。pdf 用隐藏、关 JavaScript 的沙箱窗口 `printToPDF`，中文走系统字体 |
| `article-panel.ts` | 预览事件只累加计数并保证**同一时刻只有一个取稿在飞行、且总取最新**（`#pumpPreview`/`#drainPreview`），不再每个事件作废上一次结果；草稿按 `whole` 走整篇 diff 或前缀对齐；流式时跟着笔走（edits 跟最后一个变化块，整篇跟最后写出的块），读者滚轮/触摸/点击/按键即停止跟随。三段视图 `正文/修订/行级`、版本芯片、导出。块按渲染内容取键并就地复用，新块 GSAP 脉冲、消失的块先折叠再摘除。`onSessionChanged()` 每帧调用，失败后自带定时重试；打开/切版本锚定顶部，提交新版本时保留贴底；无基线时禁用两个修订段，打开第 N 版后补取第 N−1 版作基线 |

## 对外接口

协议命令（都带 sessionId）：

- `article.list` → 当前会话最近的文稿摘要
- `article.get` → 指定版本的切片（`offset` / `length` / `text`）加标题和版本列表
- `article.preview` → 正在写的草稿切片；草稿不在时返回 null。`whole: false` 表示切片是下一版的开头（整篇草稿，按前缀对齐）；`whole: true` 表示是已应用 edits 的整篇文档（按整篇 diff），并带 `edits`（已应用处数）。`update` 另带 `baseVersion`（它修改的已保存版本），面板不在这一版上时先载入它。Application 按 toolCallId 缓存 base 正文（最多 4 条）——工具在模型输出结束后才执行，流式期间 base 不会变

桌面导出不走协议，走 `pspore:desktop:article:export`。preload 增加 `exportArticle`。

## 内部依赖

`ArticleStore` 用 `storage/atomic`。面板用共享的 `readFullMessage` 和 `markdown-view`（`textContent` / `createElement`，不用 `innerHTML`）。预览事件由 `PiRuntimeAdapter` 发出，Application 提供三个命令。

## 外部依赖

无新增生产依赖。docx 用 Node 自带的 `zlib`。pdf 用已锁定的 Electron `printToPDF`。

## 注意事项

- 默认 `ask_risky` 不逐次询问，因为工具不接受路径，只能写文稿目录，`riskReasons` 为空。`ask_all` 仍会问：`fs.write` 属于会改文件的能力。
- 聊天卡片只显示「打开文稿」。TUI/CLI 没有面板，回执里带 `current.md` 的绝对路径；`read` 的正文仍会出现在 TUI 的工具记录里。
- 流式阶段整篇重绘，不做逐 token 的 diff。提交后若面板里还没有上一版，会先取 `version - 1` 再对照。打开已有文稿不会把整篇当成新增来闪。
- 面板默认隐藏，避免 Electron smoke 在 1920×1080 上多出一列。打开时检查器让位；宽度 ≤1320 时文稿是抽屉。
- 列宽由 `--article-width` 决定，可拖拽（面板内左缘 10px 分隔条，`role="separator"`，方向键每次 24px），存在 `localStorage`。上下界：文稿 ≥380px，对话 ≥560px，文稿 ≤视口 72%。分隔条必须放在面板**内侧**——`.panel` 有 `overflow: hidden`，挂在外侧会被裁掉，而且面板不设 `position: relative` 的话它会按 `.workspace-grid` 定位、跑到工作区最左边。
- 开关动画在宽模式下动的是**栅格列宽**（对话让出/收回空间），抽屉模式下动的是面板本身。收起时 `data-article` 要保留到动画结束才移除，否则栅格中途丢掉变量会瞬间塌掉。
- 内置 skill 在新会话或服务重启后才进入提示词，已打开的会话不热加载。
- 渲染器不得导入 `store.ts`、`docx.ts`、`zip-write.ts`、`article-export.ts`。
- 面板靠 `article.preview` / `tool.completed` 两个事件活着。这两个事件走的是通用广播路径，所以**任何让桌面端拒帧断连的协议缺陷都会静默掐掉整个面板的实时行为**：2026-09-22 实机验证发现 `transcript.item.started` 少了 `status`/`ts`，桌面端每条助手消息都断一次连，流式预览与 diff 动画从未到达过面板，而聊天靠重连快照看起来正常。`test/contract/pi-runtime-adapter.test.ts` 现在用桌面端自己的 `validateEventEnvelope` 逐条校验 adapter 发出的事件，守住这个边界。
- 只调用工具、没有正文的助手轮次在聊天里折叠（`.message-silent`，`display:none`），保留虚拟列表槽位，不动绝对索引。
- Electron smoke 在临时 home 里预置 `art_5c0de0000001`（两版，`sessionId: "main"`，其中一行是改写而非替换，以便验证行内标记），断言面板入场、版本芯片、首屏定位、「导出」Label、修订视图的增/删行与行内标记、行级视图不标行内、切版本后未改动的块仍是同一元素。导出按钮不点击——每个都会拉起系统保存对话框。
- **面板保留的状态属于「一个会话里的一篇文稿」**：上一版正文（用于对齐与 diff）和渲染块缓存池。切会话或换文稿时必须 `#forget()` 全部清掉，否则上一篇会挂在新草稿下面。判断依据是草稿带的 `id`——不带 `id`（create）或 id 不同，一律不做对齐。smoke 有对应断言。
- **流式期间文档不能塌掉**。草稿是最终文档的前缀，直接渲染草稿等于从零重打整篇。`alignArticleDraft()` 把草稿与上一版对齐：已写出的块照原样给出并标明是否有变化，上一版中还没写到的尾部继续留在屏幕上。衡量指标是「流式全程的最小块数」，不是「提交后的节点复用率」——后者会在过程已经塌掉的情况下依然好看（实测：对齐前最小块数 1～2，对齐后恒为 18）。
- **慢机器上不能"写完才出现"**（2026-09-23）。旧实现每来一个预览事件就 `++#token` 并发起一次取稿，结果返回时 token 已变就丢弃。只要"取稿 + 重绘"比事件间隔（120 ms）慢——飞腾 FT-2000/4 上很容易——每次结果都被下一个事件作废，面板要到模型停笔才画出来。实测（Electron + CDP 20× CPU 降速，约 3500 字长文）：修复前前 6 秒空白、10 秒只画 2 次；修复后持续刷新。现在事件只累加计数，单个读取循环读完就画、画完若有更新再读；只有新调用、提交、失败、切会话或关闭才作废。
- **面板在 `action` 一出现就打开**，不等正文；`update` 先显示当前版本，edits 写到哪里画到哪里（状态行「修改中 · 已改 N 处」）。关闭面板视为对这次调用的选择：同一调用的后续预览不再弹开，版本提交时照常打开。写入失败会恢复显示已保存的版本，而不是留下一份不存在的草稿。
- **面板是"在上一版上打补丁"，不是重画**。块的键只包含渲染出来的内容，不含 diff 结论，所以一个块从"新增"变成"未变"仍复用同一元素。关键在于**流式草稿也必须走同一套键控渲染**：草稿一旦 `replaceChildren`，模型刚开始写就把上一版清空了，等版本落地已无可复用。草稿会经过每个块的半成品形态，因此还需要一个 512 条的块缓存池，暂时不匹配的元素留在池里、块写完整后原样取回（实测：有池 18 块复用 17，无池只复用 2）。折叠退场的元素带 `data-leaving`，复用时必须清掉 GSAP 留下的 inline style。
