import { randomUUID } from "node:crypto";

import { AgentApplication, AgentRunBudgetError } from "../application/agent-application.js";
import type { ToolGate } from "../domain/runtime.js";
import { ShellService } from "../shell/shell-service.js";
import type { RunExecutor, RunExecutionResult } from "./scheduler.js";
import type { RunRecord } from "./types.js";

export interface DaemonRunExecutorOptions {
  application: AgentApplication;
  shell: ShellService;
  toolGate: ToolGate;
  maxShellOutputBytes: number;
  idFactory?: () => string;
}

export class DaemonRunExecutor implements RunExecutor {
  readonly #application: AgentApplication;
  readonly #shell: ShellService;
  readonly #toolGate: ToolGate;
  readonly #maxShellOutputBytes: number;
  readonly #idFactory: () => string;

  constructor(options: DaemonRunExecutorOptions) {
    this.#application = options.application;
    this.#shell = options.shell;
    this.#toolGate = options.toolGate;
    this.#maxShellOutputBytes = options.maxShellOutputBytes;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async execute(run: RunRecord, signal: AbortSignal): Promise<RunExecutionResult> {
    if (run.activity.kind === "agent") {
      try {
        await this.#application.executeAgentRun(run, signal);
        return { status: "succeeded" };
      } catch (error) {
        if (error instanceof AgentRunBudgetError) return { status: "budget_exhausted", reason: error.message };
        throw error;
      }
    }

    const authorization = await this.#toolGate.authorize({
      sessionId: `run:${run.id}`,
      toolCallId: this.#idFactory(),
      toolName: "shell",
      input: { command: run.activity.command, cwd: run.activity.cwd },
      agentPath: ["automation", run.jobId ?? run.source, run.id],
      runId: run.id,
      ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
      allowedApprovalScopes: run.jobId === undefined ? ["once", "session"] : ["once", "session", "job"],
    });
    if (authorization.decision === "deny") return { status: "blocked", reason: authorization.reason };
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Run aborted");
    const handle = await this.#shell.start({
      command: run.activity.command,
      cwd: run.activity.cwd,
      mode: "pipe",
      timeoutMs: run.timeoutMs,
      maxOutputBytes: this.#maxShellOutputBytes,
    });
    const abort = () => handle.signal("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await handle.completion;
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Run aborted");
      if (result.outputLimitExceeded) return { status: "budget_exhausted", reason: "shell output limit exceeded" };
      if (result.timedOut) return { status: "budget_exhausted", reason: "shell timeout exceeded" };
      if (result.exitCode !== 0) throw new Error(`Scheduled command exited with code ${String(result.exitCode)}`);
      return { status: "succeeded" };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
