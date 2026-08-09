# Module: Memory and Search

## 模块职责

构造稳定 pinned context，管理受控记忆写入，索引 workspace/project/session 文本，并提供 exact + BM25 检索和引用读取。

## 入口文件

当前 Phase 1 基础入口：`src/daemon/daemon.ts` 读取配置中的 pinned files；`src/tools/core-tools.ts` 提供有输出上限的 ripgrep exact search。受限 context loader、memory tools、BM25/index 尚未实现。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 9、18 节。

## 对外接口

- `RetrievalProvider.search/index`
- `search`、`memory_append`、`memory_curate`
- `SearchHit`：path/entry、line、heading、score、snippet、hash

## 内部依赖

storage atomic writer、token estimator、path policy、artifact reader。

## 外部依赖

优先使用系统 `rg` 做精确检索；缺失时回退内置流式搜索。BM25 与中英 tokenizer 首版设计为本地实现，不需要向量服务。

## 注意事项

- index 只是 cache，源文件/JSONL 才是事实源。
- 搜索片段进入上下文后会发送给模型 provider。
- 默认排除 secret、binary、vendor/cache；symlink 必须 canonicalize。
- `MEMORY.md` 修改会影响 KV prefix，应低频、受控、可追踪。
- 当前 pinned loader 尚未执行 `maxPinnedTokens`、workspace 边界与 hash reload 约束，因此只算基础接线，不能宣称 memory v1 完成。

## 常见修改点

pinned files、chunk/token 限制、tokenizer、ranking、exclude globs、session parser、vector provider 扩展。
