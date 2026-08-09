# Module: Automation and Agents

## 模块职责

把 user/BOOT/cron/recovery/plugin 输入规范化为 bounded trigger/run；管理 cron ledger、misfire/concurrency；管理 subagent tree、mailbox、预算、权限继承与双工消息。

## 入口文件

当前入口：`src/automation/`；subagent 设计目标为 `src/agents/`，尚未实现。

## 关键文件

- `src/automation/cron-adapter.ts`：标准五字段 cron、IANA timezone 与 Croner 边界。
- `src/automation/job-store.ts`：严格 job decoder 与 canonical cwd。
- `src/automation/run-ledger.ts`：monthly JSONL、slot claim、状态转换与恢复。
- `src/automation/scheduler.ts`：misfire、concurrency、timeout、cancel 与 trigger。
- `src/automation/daemon-run-executor.ts`：agent/command run 执行与统一 policy gate。
- 契约测试：`test/unit/cron-job-store.test.ts`、`test/unit/run-ledger.test.ts`、`test/integration/scheduler.test.ts`、`test/integration/daemon.test.ts`。

## 对外接口

- `JobDefinition`、`RunTriggerSpec`、`RunRecord`、`RunBudget`
- UDS/CLI/TUI：jobs/runs list、manual run、cancel
- `agent_spawn`、`agent_send`、`agent_join`
- Job/run state 与 delivery events

## 内部依赖

Kernel、Pi runtime port、policy、storage、notification/gateway、clock。

## 外部依赖

精确锁定 `croner@10.0.1`；subagent 首版将复用同进程 Pi sessions。

## 注意事项

- 所有主动 run 必须有限 objective、deadline、turn/token/cost/child budget。
- BOOT 在 ready 后运行，不阻塞 Gateway。
- cron 只去重 schedule slot，不保证任意外部副作用 exactly-once。
- `forbid/replace/allow` 仍受全局 run concurrency；timeout/budget/cancel 都进入明确终态。
- 启动时 running run 标记 `unknown`；queued run 可重新入队；损坏 JSONL 尾行先复制 recovery artifact 再截断。
- `job` scope approval 持久化到 `state/approvals/job-grants.json`，但显式 deny 仍优先。
- child policy/budget 只能收窄，不能超过 parent/root。
- parent cancel 默认级联，模型不能自行 detach。

## 常见修改点

job mutation/reload、delivery/notification、misfire/concurrency、run recovery、BOOT policy、agent depth/concurrency、mailbox priority、child result schema、workspace mode。
