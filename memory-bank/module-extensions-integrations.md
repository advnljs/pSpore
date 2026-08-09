# Module: Extensions and Integrations

## 模块职责

发现与加载 Pi skills/extensions、pSpore host plugins 和 MCP servers；管理 trust、capabilities、lazy lifecycle、tool schema 激活与健康状态。

## 入口文件

- MCP：`src/mcp/mcp-manager.ts`、`src/mcp/mcp-tools.ts`、`src/mcp/types.ts`。
- Resource/plugin：`src/plugins/resource-inspector.ts`、`src/plugins/extension-manager.ts`、`src/plugins/types.ts`。
- Pi resource bridge：`src/pi/pi-runtime-adapter.ts#createSkillPaths`。

## 关键文件

- `src/config/config.ts`：stdio/Streamable HTTP 严格配置与 secret reference decoder。
- `src/daemon/daemon.ts`：MCP 生命周期、Kernel health 与 session tool factory 组装。
- `src/policy/policy.ts`：MCP discovery/call 的 `external.side_effect` 分类与 child ceiling。
- `test/integration/mcp-manager.test.ts`：真实 SDK stdio contract、结果边界、取消、idle reconnect、backoff 与脱敏。
- 详细契约：`docs/detailed-design.md` 第 10 节。

## 对外接口

- 已实现：`McpServerConfig`、`McpManager`、`mcp_discover`、`mcp_call`、动态 normalized MCP tools、`mcp.*` UDS commands。
- 已实现：`HostPluginManifest` / `HostPlugin` lifecycle、exact activation config、trusted skills resource paths、resource inspect/install/disable UDS commands。

## 内部依赖

Policy、Kernel activity runner、Pi tool registry、secret refs、process/network adapters、health/diagnostics。

## 外部依赖

Pi `DefaultResourceLoader`；官方 `@modelcontextprotocol/sdk@1.30.0`。

## 注意事项

- Pi resources 与 host plugins 是不同生命周期。
- extension/plugin/MCP server 均是受信代码，tool approval 不构成代码 sandbox。
- 生成物先进入 staging，验证和用户信任后才能安装；不得自动加载。
- MCP schema/tool 只按需激活，降低 token 和 cache 抖动。
- MCP stdio/HTTP 配置不得内联 secret；只解析显式 env/header reference。结果超限落 `0600` artifact，audit 不保存参数正文。
- v1 仅执行显式 `trusted-local` MCP；`sandboxed` 在 sandbox executor 实现前拒绝启动。
- 首版 service plugins 不热替换，skills/resources 只在 session 边界 reload。
- Staging inspection 不 import host entry；只运行 `node --check` 语法检查。安装复制已读取的有界 byte snapshot，并在目标端重算 digest。
- `resource-trust.json` 损坏时 Daemon fail closed；已安装内容被修改时 health 变为 blocked，skill 不进入新 session，host plugin 不 import。
- Host plugin 是同用户 in-process 受信代码，manifest/capability grant 是治理与可见性，不是 sandbox；同步死循环仍可能阻塞 Daemon。

## 常见修改点

manifest apiVersion、trust store、install/update、capability grants、MCP transport/schema、lazy connect/backoff、plugin isolation。
