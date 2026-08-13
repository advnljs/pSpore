# Module: Memory and Search

## 模块职责

构造稳定 pinned context，管理受控记忆写入，索引 workspace/project/session 文本，并提供 exact + BM25 检索和引用读取。

## 入口文件

当前入口：`src/memory/context-loader.ts`、`src/memory/memory-service.ts`、`src/memory/memory-tools.ts`、`src/memory/search-service.ts`、`src/memory/bm25.ts`、`src/memory/tokenizer.ts`；`src/tools/core-tools.ts` 暴露统一 search/read reference 路径。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 9、18 节。
- `test/unit/memory-context-bm25.test.ts`：中英 tokenizer、BM25、顺序/budget/path。
- `test/unit/memory-service.test.ts`：daily append、source、credential filter、curate hash/去重。
- `test/integration/search-service.test.ts`：scope/exclude/JSONL/增量 rebuild。

## 对外接口

- `RetrievalProvider.search/index`
- `search`、`memory_append`、`memory_curate`
- `SearchHit`：path/entry、line、heading、score、snippet、hash

## 内部依赖

storage atomic writer、token estimator、path policy、artifact reader。

## 外部依赖

默认 Daemon 使用内置 exact + BM25 provider；基础工具在未注入 provider 的隔离场景仍可回退系统 `rg`。BM25 与中英 tokenizer 均为本地实现，不需要向量服务。

## 注意事项

- index 只是 cache，源文件/JSONL 才是事实源。
- 搜索片段进入上下文后会发送给模型 provider。
- 默认排除 secret、binary、vendor/cache；symlink 必须 canonicalize。
- `MEMORY.md` 修改会影响 KV prefix，应低频、受控、可追踪。
- pinned loader 固定 `AGENTS/SOUL/USER → 其他 → MEMORY` 顺序；缺失只诊断，path/symlink 逃逸、敏感路径、单文件大小和总 token 超限 fail closed。
- `memory_append` 写带 session/run 来源的当日日志并过滤 credential/base64；`memory_curate` 使用 expected SHA-256、来源引用、去重 marker 与原子替换。
- `memory_curate` 的 model-facing schema 必须明示 sources 仅接受 `session:ID` / `run:ID` / `file:path`，并要求调用前立即读取 `MEMORY.md` 取得 exact SHA-256；真实 DeepSeek 验证表明该 schema 能消除重试循环。
- 搜索 cache 为 `cache/search/index.json`，按 canonical path/size/mtime/hash 增量解析；secret/vendor/cache/symlink/binary 默认排除。
- 搜索 hit 返回 path、line、heading、score、mtime、snippet、content hash 与 source ref；`read.expectedSha256` 可验证检索后源内容未变化。

## 常见修改点

pinned files、chunk/token 限制、tokenizer、ranking、exclude globs、session parser、vector provider 扩展。
