---
name: article-canvas
description: Write and revise long documents in the article panel instead of the chat. Use when the user asks for an article, report, essay, draft, writeup, or any piece of writing they will read as a document.
version: 0.1.0
---

# 文稿面板

长文不要写进聊天回复。用内置的 `article` 工具维护一份文稿，桌面端会打开 Markdown 面板，边写边渲染，并在每次更新后展示和上一版的差异。

## 何时使用

- 用户要一篇文章、报告、说明、草稿、周报、方案，或明确说「写成一篇」
- 内容会长过一段聊天回复，或者用户还会要求修改
- 不要用于改用户自己的代码或文件；那仍然用 `edit`

## 怎么写

1. `article` `action=create`，带上 `title` 和完整 markdown `content`。聊天里只用一两句话说明写了什么。
2. 需要改时对同一个 `id` 调用 `action=update`。整篇重写就再传 `content`；只改一段就传 `edits`（`find` 必须是文稿里原样存在的文字，`replace` 是替换后的文字）。每次成功的修改都是新版本。
3. 适合分几次更新：先大纲，再展开，再润色。不要把所有版本挤在一次回复里。
4. 上下文被压缩后如果记不清正文，用 `action=read` 取回，然后继续 `update`。读到的正文不要复制进聊天。

## 不要做的事

- 不要把正文粘贴进聊天回复。面板负责展示、对照版本和导出。
- 不要用 `edit` 去改文稿目录里的文件。版本历史只认 `article` 工具。
