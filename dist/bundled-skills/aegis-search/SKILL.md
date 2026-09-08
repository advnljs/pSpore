---
name: aegis-search
description: Search the user's local documents (PDF, Word, Excel, plain text) by full text. Use when the user asks to find a file, find a document, or find which document mentions something, and when answering needs content from their own files rather than the model's own knowledge.
version: 0.2.1
---

# 本机文档全文搜索

用 `aegis-search` 在用户本机已建立的全文索引中检索文档。索引由 pSpore 守护进程
持续维护，与桌面版 Aegis Searcher 共用同一份数据。

## 何时使用

- 用户想找某个文件、某份文档，或问"哪份文档里提到了 X"
- 需要引用用户自己的资料，而不是模型已有的知识

如果检索结果为空或索引不可用，直接如实说明，不要编造文件名或内容。

## 用法

二进制位于本 skill 目录下的 `bin/aegis-search`。始终加 `--json` 以便解析。

```bash
# 检索（默认按相关度）
bin/aegis-search search "授信业务" --json --limit 10

# 按文件时间排序
bin/aegis-search search "合同" --json --sort newest
bin/aegis-search search "合同" --json --sort oldest

# 限定类型或目录
bin/aegis-search search "报告" --json --ext pdf,docx
bin/aegis-search search "报告" --json --scope /home/user/工作

# 查看索引状态
bin/aegis-search status --json
```

## 输出

`search --json` 返回：

```json
{"totalHits":12,"elapsedMs":8,"results":[
  {"path":"/abs/path.pdf","filename":"path.pdf","ext":"pdf",
   "mtime":1757000000,"size":20480,"score":3.4,"snippet":"...命中片段..."}
]}
```

`mtime` 是 Unix 秒。`snippet` 是纯文本片段，可能包含 `<mark>` 标记命中位置。

## 注意

- 只检索已被索引的目录。若用户提到的目录明显不在结果里，用 `status --json`
  确认索引可用，并提示用户在 pSpore 中把该目录加入索引范围。
- 检索是只读的；本 skill 不修改任何用户文件。
- 返回结果里的路径是本机绝对路径。纯文本文件（`txt`、`md` 等）可以直接 `read`；
  `pdf`、`docx`、`xlsx` 是二进制容器，`read` 会拒绝它们，需要先用 shell 命令抽取文本。
  多数情况下 `snippet` 已经够回答问题，不必再去读原文件。读取前仍需遵守既有权限策略。
