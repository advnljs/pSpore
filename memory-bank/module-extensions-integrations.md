# Module: Extensions and Integrations

## 模块职责

发现与加载 Pi skills/extensions、pSpore host plugins 和 MCP servers；管理 trust、capabilities、lazy lifecycle、tool schema 激活与健康状态。

## 入口文件

设计目标：`src/plugins/` 以及 Pi adapter 的 resource-loader bridge。当前尚未实现。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 10 节。

## 对外接口

- `PluginManifest` / `HostPlugin`
- plugin context ports
- `McpServerConfig`、`mcp_discover`、动态 MCP tools

## 内部依赖

Policy、Kernel activity runner、Pi tool registry、secret refs、process/network adapters、health/diagnostics。

## 外部依赖

Pi `DefaultResourceLoader`；MCP SDK/transport 版本待 Phase 3 确认。

## 注意事项

- Pi resources 与 host plugins 是不同生命周期。
- extension/plugin/MCP server 均是受信代码，tool approval 不构成代码 sandbox。
- 生成物先进入 staging，验证和用户信任后才能安装；不得自动加载。
- MCP schema/tool 只按需激活，降低 token 和 cache 抖动。
- 首版 service plugins 不热替换，skills/resources 只在 session 边界 reload。

## 常见修改点

manifest apiVersion、trust store、install/update、capability grants、MCP transport/schema、lazy connect/backoff、plugin isolation。
