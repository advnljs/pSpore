# module: documents（文档正文抽取）

## 模块职责

把用户本机的文档转成纯文本，供模型回答关于这些文档的问题。只抽文字，不还原排版。

## 入口文件

- `src/documents/extract.ts` — 唯一对外入口 `extractDocument(path, options)`，负责识别格式并分派。

## 关键文件

| 文件 | 职责 |
|---|---|
| `extract.ts` | 按魔数识别格式、分派、统一结果形状、按 `limit` 截断并报告总长度 |
| `errors.ts` | `UnsupportedDocumentError`：区分"读不了这个格式"与"文档损坏"，两者给的建议不同 |
| `zip.ts` | 最小 ZIP 读取（中央目录 + `inflateRawSync`），含 ZIP64 与解压炸弹上限 |
| `ooxml.ts` | docx/xlsx/pptx。用扫描器而非 DOM 取文本 |
| `ole.ts` | 复合文档容器（CFB）：FAT/miniFAT/目录，`.doc`/`.xls`/`.ppt` 都住在里面 |
| `legacy-office.ts` | doc（FIB + 分片表）、xls（BIFF 记录 + SST）、ppt（记录树 + 文本原子） |
| `pdf.ts` | pdfjs-dist 包装，只取文本，不渲染、不联网 |
| `plain-text.ts` | 编码嗅探：BOM → 严格 UTF-8 → GB18030 → 带替换字符的 UTF-8 |

## 对外接口

- `extractDocument(path, { maxBytes?, limit? })` → `{ format, formatLabel, text, bytes, sections, truncatedFrom?, encoding? }`
- 工具层：`src/tools/core-tools.ts` 里的 `document` 工具，参数 `path` / `offset` / `limit`，单次默认 30000 字符。
- Skill：`bundled-skills/doc-extract/`，告诉模型什么时候用这个工具、输出长什么样、扫描件和 WPS 私有格式怎么处理。

## 内部依赖

- 只依赖 Node 内置模块（`zlib`、`fs`、`TextDecoder`），PDF 除外。

## 外部依赖

- `pdfjs-dist`（生产依赖，用户已批准）。中文 PDF 普遍用 Type0/CID 字体，需要
  `cmaps/` 里的预定义 CMap 才能正确解码，自己实现极易抽出乱码——这是唯一引入依赖的理由。

## 注意事项

- **格式一律按文件头字节判断，不看扩展名**。WPS 会用自己的扩展名存标准格式，
  邮件附件常丢扩展名，`.txt` 里放着 docx 也很常见。
- 短流（< 4096 字节）必须走 mini stream。真实的小 `.doc` 正是这条路径，测试
  fixture 也据此构造，不要为了省事把所有流都放进常规扇区。
- `pdf.ts` 用 `createRequire` + 动态 `import()` 解析 pdfjs：esbuild 静态分析不到，
  所以独立 SEA CLI 不会打包它（二进制体积无回归），运行时会抛
  `UnsupportedDocumentError` 明确降级。桌面版从 `app.asar` 内加载正常，已实测。
- 渲染器不得 import 本模块（用了 Node 内置模块），由
  `test/unit/renderer-module-graph.test.ts` 把关。
- 扫描件 PDF 没有文字层，抽出来是空的；skill 里已要求如实说明而不是编造。

## 常见修改点

- 加格式：在 `extract.ts` 的分派链上加一段魔数判断 + 一个解析模块。
- 调整单次返回长度：`core-tools.ts` 的 `DEFAULT_DOCUMENT_CHUNK`。
- 测试 fixture 构造器在 `test/fixtures/documents.ts`，不提交二进制样本。
