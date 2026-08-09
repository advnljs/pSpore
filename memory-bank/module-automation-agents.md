# Module: Automation and Agents

## 模块职责

把 user/BOOT/cron/recovery/plugin 输入规范化为 bounded trigger/run；管理 cron ledger、misfire/concurrency；管理 subagent tree、mailbox、预算、权限继承与双工消息。

## 入口文件

设计目标：`src/automation/`、`src/agents/`。当前尚未实现。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 8、13、14 节。

## 对外接口

- `TriggerEvent`、`JobDefinition`、`RunBudget`
- `agent_spawn`、`agent_send`、`agent_join`
- Job/run state 与 delivery events

## 内部依赖

Kernel、Pi runtime port、policy、storage、notification/gateway、clock。

## 外部依赖

标准 5 字段 cron + IANA timezone parser 待 Phase 2 选择；subagent 首版复用同进程 Pi sessions。

## 注意事项

- 所有主动 run 必须有限 objective、deadline、turn/token/cost/child budget。
- BOOT 在 ready 后运行，不阻塞 Gateway。
- cron 只去重 schedule slot，不保证任意外部副作用 exactly-once。
- child policy/budget 只能收窄，不能超过 parent/root。
- parent cancel 默认级联，模型不能自行 detach。

## 常见修改点

cron parser、misfire/concurrency、run recovery、BOOT policy、agent depth/concurrency、mailbox priority、child result schema、workspace mode。
