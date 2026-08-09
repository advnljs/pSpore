# ADR 0001: Node 24、Pi v0.84.1 与首版运行时基线

- 状态：Accepted
- 日期：2026-08-09

## 背景

Phase 0 必须先证明 Pi SDK、session replacement、工具 gate、JSONL 恢复、usage/cache 字段和 Linux Shell/PTY 语义，再允许这些假设进入 Kernel 与 UI。用户同时明确放弃 Tauri，最终桌面客户端使用 Electron 43，但核心 v1 先通过 TUI 验证。

## 决策

1. pSpore 固定 Node.js 24，`package.json#engines` 为 `>=24.0.0 <25`；首次验证环境为 `v24.19.0`。
2. 精确锁定 `@earendil-works/pi-coding-agent@0.84.1`、`pi-tui@0.84.1`，并用 npm overrides 固定相关 Pi 内部包为 `0.84.1`。
3. 官方 `v0.84.1` tag 在 Phase 0 实测解析到 commit `53fa77ccd8a279eb87e92294ef3687b03ff80112`。旧设计记录的 `936aff…` 不作为实现校验依据。
4. `PiRuntimeAdapter` 是唯一 Pi SDK 边界，公共事件、快照与模型引用只使用 pSpore 类型；不暴露 Pi experimental protocol。
5. Pi contract tests 使用官方 `fauxProvider`，不调用付费模型。必须覆盖流式事件、settled、session new/fork rebind、JSONL resume、tool gate fail-closed、abort 和 cache usage。
6. Linux PTY 首版复用 util-linux `script`，由静态 Node bridge 以 argv 启动解析后的 login shell。实际命令通过子进程环境传递，不拼入 bridge shell command。
7. secret input 在写入 PTY 前注册内存态流式 redactor；stdout/stderr 跨 chunk 脱敏后才能进入 UI、摘要或 artifact。
8. 最终桌面工具链锁定 `electron@43.3.0`，Electron 客户端在核心/TUI v1 稳定后实现。

## TypeScript 声明兼容

项目代码保留 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess` 与其他本地严格检查。`skipLibCheck=true` 仅用于隔离 Pi 依赖树中已发布声明的兼容问题：部分 provider `.d.ts` 缺少 JSON import attribute，部分供应商/MCP 声明假设 DOM globals。它不跳过 pSpore 源码类型检查。

## 结果

- Pi 上游变化被 contract tests 和 adapter 边界约束。
- PTY 依赖 Linux `script`；`pspore doctor` 必须报告其可用性，缺失时 pipe 模式仍可用。
- Electron 的 Node/Chromium 运行时不替代 Daemon 的 Node 24 基线。
- 升级 Node、Pi 或 Electron 都必须单独更新本 ADR/后续 ADR，并运行相应 contract tests。
