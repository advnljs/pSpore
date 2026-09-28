---
name: article-canvas
description: Write and revise long documents in the article panel instead of the chat. Use when the user asks for an article, report, essay, draft, writeup, or any piece of writing they will read as a document.
version: 0.1.2
---

# 文稿面板

长文不要写进聊天回复。用内置的 `article` 工具维护一份文稿，桌面端会打开 Markdown 面板，边写边渲染，并在每次更新后展示和上一版的差异。

## 何时使用

- 用户要一篇文章、报告、说明、草稿、周报、方案，或明确说「写成一篇」
- 内容会长过一段聊天回复，或者用户还会要求修改
- 不要用于改用户自己的代码或文件；那仍然用 `edit`

## 怎么写

1. **生成文稿用 `article action=write`**：新文稿带 `title`，修改已有文稿带 `id`，并用简短 `instruction` 说明要求、字数、结构、参考材料与修改范围。不要在参数里预先写出正文。工具会沿用当前模型和接口，通过普通文本流直接把正文送进面板，完成后只保存一个版本。
2. writer 自动接收当前工具调用之前的会话上下文，修改时还接收完整已保存文稿。先完成资料检索，再调用 write；重要事实和来源可在 instruction 中明确指定。聊天里只用一两句话说明写了什么。
3. 可以先单独 `action=open`（新文稿只带 title，已有文稿只带 id）提前打开；等待返回后再 write。open 不保存版本。
4. `create/update` 仅用于保存用户提供的确切正文或执行简短、精确的 `{find, replace}` 替换。不要用它们生成长文：部分 OpenAI 兼容接口会缓冲整个工具参数，主对话能流式也不能保证参数能流式。
5. 上下文被压缩后如果记不清正文，用 `action=read` 取回。读到的正文不要复制进聊天。writer 被中止、报错或输出被截断时不保存不完整版本。

## 不要做的事

- 不要把正文粘贴进聊天回复。面板负责展示、对照版本和导出。
- 不要用 `edit` 去改文稿目录里的文件。版本历史只认 `article` 工具。
