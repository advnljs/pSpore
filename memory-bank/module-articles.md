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
| `diff.ts` | 按空行切段，围栏代码整段保留。LCS；段落积超过 250_000 时退化为前后缀。渲染器可导入，无 Node |
| `preview.ts` / `draft.ts` | 从 Pi `toolcall_delta` 里取出正在写的 `content`。预览总线 120 ms 节流。事件只带 toolCallId、标题、id 和字数，正文留在进程内 |
| `publish.ts` | 广播前去掉工具参数里的 `content` / `edits`，工具结果只留前 4 行，避免正文冲上 64 KiB 出站上限 |
| `receipt.ts` | 解析回执，供面板和聊天卡片定位文稿 |
| `plain.ts` / `html.ts` / `docx.ts` / `zip-write.ts` | txt 去掉 Markdown 标记；pdf 用 HTML；docx 是自写的 WordprocessingML ZIP（`node:zlib`，无新依赖）。`plain.ts` 与 `html.ts` 无 Node，可被渲染器导入；`docx.ts` 与 `zip-write.ts` 不行 |
| `article-export.ts` | 保存对话框。pdf 用隐藏、关 JavaScript 的沙箱窗口 `printToPDF`，中文走系统字体 |
| `article-panel.ts` | 流式重绘、版本芯片、对照上一版、新增段 GSAP 脉冲（最多 16 段，只动 opacity/位移） |

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
