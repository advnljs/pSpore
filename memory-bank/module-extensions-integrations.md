# Module: Extensions and Integrations

## 模块职责

发现与加载 Pi skills/extensions、pSpore host plugins 和 MCP servers；管理 trust、capabilities、lazy lifecycle、tool schema 激活与健康状态。

## 入口文件

- MCP：`src/mcp/mcp-manager.ts`、`src/mcp/mcp-tools.ts`、`src/mcp/types.ts`。
- Resource/plugin：`src/plugins/resource-inspector.ts`、`src/plugins/extension-manager.ts`、`src/plugins/types.ts`。
- Workspace skills：`src/plugins/workspace-skills.ts#scanWorkspaceSkills`（用户自己放进 `workspace/skills/` 的 skill）。
- Pi resource bridge：`src/pi/pi-runtime-adapter.ts#createSkillPaths`（installed/bundled，走 Pi 路径加载）与 `#createSkills`（已解析好的 workspace skill，经 `skillsOverride` 注入）。

## 关键文件

- `src/config/config.ts`：stdio/Streamable HTTP 严格配置与 secret reference decoder。
- `src/daemon/daemon.ts`：MCP 生命周期、Kernel health 与 session tool factory 组装。
- `src/policy/policy.ts`：MCP discovery/call 的 `external.side_effect` 分类与 child ceiling。
- `test/integration/mcp-manager.test.ts`：真实 SDK stdio contract、结果边界、取消、idle reconnect、backoff 与脱敏。
- 详细契约：`docs/detailed-design.md` 第 10 节。

## 对外接口

- 已实现：`McpServerConfig`、`McpManager`、`mcp_discover`、`mcp_call`、动态 normalized MCP tools、`mcp.*` UDS commands。
- 已实现：`HostPluginManifest` / `HostPlugin` lifecycle、exact activation config、trusted skills resource paths、resource inspect/install/disable UDS commands。
- 已实现：`skills.catalog` UDS 命令（`ExtensionManager.skillCatalog()`），返回 `SkillCatalogEntry[]`：`source` = `installed|bundled|workspace`，`status` = `active|skipped|shadowed`，`message` 说明未加载原因或做了什么宽容处理。CLI `pspore skills`、TUI `/skills`、GUI 集成页都用它；旧 `skills.list`（只含信任库记录）保留不变。

## 内部依赖

Policy、Kernel activity runner、Pi tool registry、secret refs、process/network adapters、health/diagnostics。

## 外部依赖

Pi `DefaultResourceLoader`；官方 `@modelcontextprotocol/sdk@1.30.0`。

## 注意事项

- Pi resources 与 host plugins 是不同生命周期。
- extension/plugin/MCP server 均是受信代码，tool approval 不构成代码 sandbox。
- 生成物先进入 staging，验证和用户信任后才能安装；不得自动加载。
- Skill 的三个来源：installed（staging exact-digest）、bundled（随发行版，链接到 `workspace/skills/<name>`）、workspace（用户自己放进 `workspace/skills/` 的目录）。前两者以路径交给 Pi；workspace 由 pSpore 自己解析后经 `skillsOverride` 注入，**同名时前两者优先**，workspace 副本在目录里标 `shadowed`。
- Workspace 扫描规则与 Pi `loadSkillsFromDir` 一致：含 `SKILL.md` 的目录即一个 skill 且不再深入；否则最多向下 3 层找；根目录的 `.md` 只有 frontmatter 带 `description` 才算（README 不算）；跳过点开头目录（含 `.installed`）、`node_modules`、bundled 链接名和带 `.pspore-bundled.json` 标记的旧副本；realpath 去重防符号链接环；上限 128 个、单文件 256 KiB。
- 比 Pi 宽容的两点（Pi 遇到会**静默丢弃**）：frontmatter 不是合法 YAML（最常见是中文描述里未加引号的 `: `）→ 逐行 `key: value` 读取；缺 `description` → 用首个标题 + 首段（CJK 换行不插空格、列表项用分号，限 280 字）。frontmatter 解析复用 Pi 导出的 `parseFrontmatter`，保证 Pi 接受的内容语义一致。
- 读不了的 skill 不消失，而是 `skipped` 并给原因：非 UTF-8、超 256 KiB、`skill.md` 大小写不对、目录里只有 `SKILL_*.md`、悬空符号链接、无任何可作描述的文字。
- 每次 session factory（create/resume/newSession）都重新扫描；**已存在的会话不热更新**，服务重启恢复会话或新建会话才会看到新加的 skill。
- 安全补偿：workspace skill 不经审批就进入之后每个会话，所以 policy 把 `edit` 写入 `<workspace>/skills/**` 标为风险（`ask_risky` 下需审批）；读取和在该目录下跑 shell 不受影响。shell 写入无法识别，属已知风险。
- MCP schema/tool 只按需激活，降低 token 和 cache 抖动。
- MCP stdio/HTTP 配置不得内联 secret；只解析显式 env/header reference。结果超限落 `0600` artifact，audit 不保存参数正文。
- v1 仅执行显式 `trusted-local` MCP；`sandboxed` 在 sandbox executor 实现前拒绝启动。
- 首版 service plugins 不热替换，skills/resources 只在 session 边界 reload。
- Staging inspection 不 import host entry；只运行 `node --check` 语法检查。安装复制已读取的有界 byte snapshot，并在目标端重算 digest。
- `resource-trust.json` 损坏时 Daemon fail closed；已安装内容被修改时 health 变为 blocked，skill 不进入新 session，host plugin 不 import。
- Host plugin 是同用户 in-process 受信代码，manifest/capability grant 是治理与可见性，不是 sandbox；同步死循环仍可能阻塞 Daemon。

## 常见修改点

manifest apiVersion、trust store、install/update、capability grants、MCP transport/schema、lazy connect/backoff、plugin isolation；workspace skill 的发现/容错规则改在 `workspace-skills.ts`，测试在 `test/unit/workspace-skills.test.ts`、`test/integration/extension-manager.test.ts`（"skills the user put in the workspace"）与 adapter 契约测试。
