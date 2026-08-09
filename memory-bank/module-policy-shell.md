# Module: Policy and Shell

## 模块职责

为所有工具统一解析 capability、目标、风险与审批；以当前用户身份运行 login shell/PTY，管理进程、sudo secret 输入、输出 artifact 与审计。

## 入口文件

当前入口：`src/policy/policy.ts`、`src/policy/approval-service.ts`、`src/shell/shell-service.ts`、`src/tools/core-tools.ts`。

## 关键文件

- 详细契约：`docs/detailed-design.md` 第 11、12 节。
- Linux contract：`test/integration/shell-service.test.ts`。
- policy/approval contract：`test/unit/policy-approval.test.ts`。
- 基础工具 integration：`test/integration/core-tools.test.ts`。

## 对外接口

- `PolicyDecision = allow | ask | deny`
- `ApprovalRequest` / first-valid resolution
- `ShellRequest` / process handle / output events

## 内部依赖

Kernel event bus、storage/audit、gateway approval channel、run budget、path canonicalization。

## 外部依赖

Linux user/shell/process APIs；PTY 通过系统 util-linux `script` 与受控 Node bridge 实现，不新增 native PTY 依赖。

## 注意事项

- policy 不是 sandbox，Shell classifier 不可完备。
- `allow_all` 可导致当前用户级任意代码执行；sudo 可能到 root。
- secret input 必须是用户到 PTY 的独立通道，模型不可见且不可持久化。
- plugin/extension/MCP server 加载属于代码信任，不能只靠 tool approval。
- approval 必须先写 `pending.json` 再发布；first response wins，timeout/持久化失败/重启恢复均 fail closed。
- session scope grant 仅在当前 Daemon/session 生效；job scope 以 job ID + canonical capability/target 精确持久化并跨重启恢复。
- resolution scope 必须属于 request 的 `allowedScopes`；非法 scope 不消费 pending approval。显式 deny 在任何 grant 之前判定。

## 常见修改点

capability taxonomy、policy precedence、risk rules、approval scope/TTL、shell argv/env、timeout/output cap、process shutdown、redaction。
