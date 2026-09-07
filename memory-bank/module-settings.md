# Module: Shared LLM Settings

## 模块职责

为 GUI、TUI 与 CLI 提供唯一的 LLM 设置 schema、严格校验、默认值、私有凭据存储和 Pi runtime 可解析性验证，避免各客户端产生不同配置语义。

## 入口文件

- `src/settings/llm-settings.ts`
- `src/settings/llm-settings-service.ts`

## 关键文件

- `src/desktop/ipc-contract.ts`：复用共享类型/decoder 的窄 settings IPC。
- `src/desktop/renderer/renderer.ts`：Provider 下拉与受控字段状态。
- `src/ui/tui/tui-app.ts`：`/config wizard` 和 `/config` 命令入口。
- `src/cli/main.ts`：可脚本化 `config` 子命令与隐藏 key 输入。
- `test/unit/desktop-settings.test.ts`、`desktop-ipc-validation.test.ts`、`cli-config.test.ts`、`tui-store-view.test.ts`。

## 对外接口

- `ProviderOption = deepseek | openai | custom-openai`
- `LlmSettings` / `LlmSettingsUpdate`
- `AutoCompactionConfig = enabled + triggerTokens + reserveTokens + keepRecentTokens`
- `decodeLlmSettingsUpdate()`
- `PERMISSION_MODES` / `BYPASS_PERMISSION_MODE` / `permissionModeSummary()`
- `defaultModelFor()`
- `LlmSettingsService.get()` / `save()`

## 内部依赖

严格 home/config decoder、atomic private file、Pi `ModelRuntime`、共享 Daemon ownership lifecycle。

## 外部依赖

使用已有 `@earendil-works/pi-coding-agent`；不增加生产依赖。

## 注意事项

- DeepSeek/OpenAI preset 不接受自定义 Base URL 或 API 类型；`custom-openai` 必须提供无凭据、无 query/fragment 的 HTTP(S) Base URL，并只允许 OpenAI Chat Completions/Responses。
- Key 与 Cookie 不接受命令行 argv，不回读明文，不进入 renderer/TUI state、日志、会话或 memory；Key 写 `credentials/<provider>.api-key`，Cookie 写 `credentials/<provider>.cookie`（均为 `0600`）。`models.json` 使用 `!cat -- <path>` 引用；Cookie 作为 `headers.Cookie` 在调用 LLM proxy API 时发送。
- TUI wizard 在最终确认前不写文件，Esc 可取消；`/config key` 与 `/config cookie` 使用遮罩输入。CLI `config key` / `config cookie` 在 TTY 隐藏输入，也允许从 stdin 注入。
- `permissionMode` 与模型设置走同一 `save()`，写入 `config.permissions.mode`，不改动 `rules` 与 `approvalTimeoutMs`；`allow_all`（CLI/TUI 别名 `bypass`）跳过全部审批，必须在三端都给出风险说明，且不得宣称为沙箱。
- `autoCompactionTriggerTokens` 是 active context 的直接触发长度，默认 `100000`；达到阈值调用 Pi 原生 `compact()`。`reserveTokens` 仍负责模型 context hard limit 前的安全余量，`keepRecentTokens` 决定压缩后保留内容。三项均限制为正整数且不超过 `1000000`，旧配置缺 `triggerTokens` 时读取默认值。
- 保存到 owned Daemon 的客户端会安全重启并重连；external Daemon 只提示 restart-required。

## 常见修改点

新增 Provider、API 类型或字段时，必须先修改共享 schema/service，再同步 GUI 选项、TUI wizard/commands、CLI help、secret tests 与 Electron smoke；不得在某个客户端单独扩展配置格式。


## 2026-09-07：`config.json` 成为设置面板唯一事实源

- `config.model` 除 `provider`/`model`/`thinking` 外，新增可选 `baseUrl`、`api`、`customModel`、`apiKeyFile`、`cookieFile`；`ModelApi` 的唯一定义移到 `src/settings/model-api.ts`，供 `config/config.ts` 校验与本模块共用，避免循环依赖。
- `LlmSettingsService.get()` 以 `config.json` 为准；只有当 `config.model` 没有端点字段（0.1.15 之前写入的 home）时，才回退读取 `state/pi/models.json`。`save()` 仍然写两份：`config.json` 是事实源，`models.json` 是 Pi 运行时派生目录。
- `LlmSettings` 增加 `configPath`、`apiKeyPath`、`cookiePath`、`modelsPath`。GUI 设置面板在「模型/自动压缩/凭据」三处显示这些绝对路径并提供复制按钮，CLI `config show` 与 TUI `/config`、wizard 的 key/cookie 步骤同样显示。secret 值本身仍然不会出现在任何输出中。
- 凭据文件路径记录在 `config.json` 而不是密钥内容；密钥仍只存在于 `credentials/<provider>.{api-key,cookie}`（`0600`），`models.json` 仍只引用 `!cat -- <path>` 命令。
