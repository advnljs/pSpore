# module: articles（文稿面板）

## 模块职责

长文不进聊天。模型用 `article` 工具在工作区里维护一份 Markdown 文稿；桌面端打开独立面板，流式渲染当前草稿，提交后对照上一版并做段落动画。导出在主进程完成。

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
| `tool.ts` | `create` / `update` / `read`。回执第一行固定 `article art_xxxxxxxxxxxx version N`，随后是标题、字数和版本变化。`read` 把正文给模型，广播侧会裁掉 |
| `diff.ts` | 按空行切段，围栏代码整段保留。LCS；段落积超过 250_000 时退化为前后缀。另有 `diffArticleLines()`：先裁公共首尾再对中间 LCS，`token` 粒度把相邻的删除串/新增串按位配对、逐 token 求 LCS，只在相似度 ≥ 0.4 时标到行内。分词按拉丁串/空白成串、其余逐字，中英都成立。渲染器可导入，无 Node |
| `preview.ts` / `draft.ts` | 从 Pi `toolcall_delta` 里取出正在写的 `content`。预览总线 120 ms 节流。事件只带 toolCallId、标题、id 和字数，正文留在进程内 |
| `publish.ts` | 广播前去掉工具参数里的 `content` / `edits`，工具结果只留前 4 行，避免正文冲上 64 KiB 出站上限 |
| `receipt.ts` | 解析回执，供面板和聊天卡片定位文稿 |
| `plain.ts` / `html.ts` / `docx.ts` / `zip-write.ts` | txt 去掉 Markdown 标记，嵌套列表按两空格逐级缩进；pdf 用 HTML，列表项的首段直接内联进 `<li>`（包成 `<p>` 会让 ☑ 和文字分行、每项多一段行距）；docx 是自写的 WordprocessingML ZIP（`node:zlib`，无新依赖），`numbering.xml` 声明 9 级、字体用 Calibri/Consolas/宋体这类目标机上真实存在的名字，ZIP 条目写 1980-01-01 的合法 DOS 日期。`plain.ts` 与 `html.ts` 无 Node，可被渲染器导入；`docx.ts` 与 `zip-write.ts` 不行 |
| `article-export.ts` | 保存对话框。pdf 用隐藏、关 JavaScript 的沙箱窗口 `printToPDF`，中文走系统字体 |
| `article-panel.ts` | 三段视图 `正文/修订/行级`、版本芯片、导出。块按渲染内容取键并就地复用，新块 GSAP 脉冲、消失的块先折叠再摘除。`onSessionChanged()` 每帧调用，失败后自带定时重试；打开/切版本锚定顶部，提交新版本时保留贴底；无基线时禁用两个修订段，打开第 N 版后补取第 N−1 版作基线 |

## 对外接口

协议命令（都带 sessionId）：

- `article.list` → 当前会话最近的文稿摘要
- `article.get` → 指定版本的切片（`offset` / `length` / `text`）加标题和版本列表
- `article.preview` → 正在写的草稿切片；草稿不在时返回 null

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
- 内置 skill 在新会话或服务重启后才进入提示词，已打开的会话不热加载。
- 渲染器不得导入 `store.ts`、`docx.ts`、`zip-write.ts`、`article-export.ts`。
- 面板靠 `article.preview` / `tool.completed` 两个事件活着。这两个事件走的是通用广播路径，所以**任何让桌面端拒帧断连的协议缺陷都会静默掐掉整个面板的实时行为**：2026-09-22 实机验证发现 `transcript.item.started` 少了 `status`/`ts`，桌面端每条助手消息都断一次连，流式预览与 diff 动画从未到达过面板，而聊天靠重连快照看起来正常。`test/contract/pi-runtime-adapter.test.ts` 现在用桌面端自己的 `validateEventEnvelope` 逐条校验 adapter 发出的事件，守住这个边界。
- 只调用工具、没有正文的助手轮次在聊天里折叠（`.message-silent`，`display:none`），保留虚拟列表槽位，不动绝对索引。
- Electron smoke 在临时 home 里预置 `art_5c0de0000001`（两版，`sessionId: "main"`，其中一行是改写而非替换，以便验证行内标记），断言面板入场、版本芯片、首屏定位、「导出」Label、修订视图的增/删行与行内标记、行级视图不标行内、切版本后未改动的块仍是同一元素。导出按钮不点击——每个都会拉起系统保存对话框。
- **流式期间文档不能塌掉**。草稿是最终文档的前缀，直接渲染草稿等于从零重打整篇。`alignArticleDraft()` 把草稿与上一版对齐：已写出的块照原样给出并标明是否有变化，上一版中还没写到的尾部继续留在屏幕上。衡量指标是「流式全程的最小块数」，不是「提交后的节点复用率」——后者会在过程已经塌掉的情况下依然好看（实测：对齐前最小块数 1～2，对齐后恒为 18）。
- **面板是"在上一版上打补丁"，不是重画**。块的键只包含渲染出来的内容，不含 diff 结论，所以一个块从"新增"变成"未变"仍复用同一元素。关键在于**流式草稿也必须走同一套键控渲染**：草稿一旦 `replaceChildren`，模型刚开始写就把上一版清空了，等版本落地已无可复用。草稿会经过每个块的半成品形态，因此还需要一个 512 条的块缓存池，暂时不匹配的元素留在池里、块写完整后原样取回（实测：有池 18 块复用 17，无池只复用 2）。折叠退场的元素带 `data-leaving`，复用时必须清掉 GSAP 留下的 inline style。
