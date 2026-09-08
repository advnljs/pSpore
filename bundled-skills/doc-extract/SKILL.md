---
name: doc-extract
description: Read the contents of a user's own documents — Word, Excel, PowerPoint, PDF, and text files in any encoding. Use when the user asks to summarize, quote, check or answer a question about a specific file on their machine, or when a search result needs to be opened to answer properly.
version: 0.1.0
---

# 文档正文抽取

用内置的 `document` 工具把用户本机的文档转成纯文本再回答。

## 何时使用

- 用户点名某个文件，要求总结、摘录、核对或据此回答
- `aegis-search` 检索到了文件，但 `snippet` 不足以回答问题
- `read` 拒绝了一个文件并提示它不是 UTF-8 文本

## 用法

```
document(path="/home/user/文档/会议纪要.docx")
document(path="/home/user/报表.xlsx", offset=30000)
```

- `path`：绝对路径。
- `offset` / `limit`：按字符分页。默认单次返回 30000 字符，返回内容开头会写明
  `characters: A-B of TOTAL`；还有剩余时会给出下一次该用的 `offset`。

## 支持的格式

| 类别 | 格式 |
|---|---|
| Word | `.docx`、`.doc`（97-2003） |
| Excel | `.xlsx`、`.xls`（97-2003） |
| PowerPoint | `.pptx`、`.ppt`（97-2003） |
| PDF | `.pdf`（含中文 CID 字体） |
| 纯文本 | `.txt`、`.md`、`.csv`、源码等，自动识别 UTF-8 / UTF-16 / GB18030 |

格式按**文件头字节**判断，不看扩展名。因此扩展名缺失、被改过，或是 WPS 存出来的
文件，只要内容是上述格式就能读。

## 输出形态

- Word：段落文本。
- Excel：每张工作表一节，单元格按制表符分隔，空行略过。
- PowerPoint / PDF：每张幻灯片或每页一节，节标题形如 `## 第 3 页`，可直接引用。

## 注意

- 抽取的是文字，不是排版。表格会变成制表符分隔的行，图片、图表、页眉页脚、
  批注和修订记录都不会出现。
- 扫描件 PDF 里没有文字层，只有图像；这种文件抽出来是空的。遇到空结果要如实说明
  是扫描件，不要根据文件名编造内容。
- WPS 的私有格式（`.wps`、`.et`、`.dps`）不支持。工具会明确报错，此时请用户在 WPS 里
  另存为 `.docx`/`.xlsx`/`.pptx`。
- 大文档不要一次性全部读进来再回答；先读第一段判断结构，需要哪一部分再按 `offset` 取。
- 只读取用户明确指向的文件，不要顺带遍历目录。
