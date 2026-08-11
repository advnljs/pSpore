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
- `decodeLlmSettingsUpdate()`
- `defaultModelFor()`
- `LlmSettingsService.get()` / `save()`

## 内部依赖

严格 home/config decoder、atomic private file、Pi `ModelRuntime`、共享 Daemon ownership lifecycle。

## 外部依赖

使用已有 `@earendil-works/pi-coding-agent`；不增加生产依赖。

## 注意事项

- DeepSeek/OpenAI preset 不接受自定义 Base URL 或 API 类型；`custom-openai` 必须提供无凭据、无 query/fragment 的 HTTP(S) Base URL，并只允许 OpenAI Chat Completions/Responses。
- Key 不接受命令行 argv，不回读明文，不进入 renderer/TUI state、日志、会话或 memory；只写 `credentials/<provider>.api-key`（`0600`），`models.json` 使用 `!cat -- <path>` 引用。
- TUI wizard 在最终确认前不写文件，Esc 可取消；`/config key` 使用遮罩输入。CLI `config key` 在 TTY 隐藏输入，也允许从 stdin 注入。
- 保存到 owned Daemon 的客户端会安全重启并重连；external Daemon 只提示 restart-required。

## 常见修改点

新增 Provider、API 类型或字段时，必须先修改共享 schema/service，再同步 GUI 选项、TUI wizard/commands、CLI help、secret tests 与 Electron smoke；不得在某个客户端单独扩展配置格式。
