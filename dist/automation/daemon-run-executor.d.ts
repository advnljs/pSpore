import { AgentApplication } from "../application/agent-application.js";
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
export declare class DaemonRunExecutor implements RunExecutor {
    #private;
    constructor(options: DaemonRunExecutorOptions);
    execute(run: RunRecord, signal: AbortSignal): Promise<RunExecutionResult>;
}
//# sourceMappingURL=daemon-run-executor.d.ts.map