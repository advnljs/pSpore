import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PsporeConfig } from "../config/config.js";
import type { AgentRuntimePort, ToolGate } from "../domain/runtime.js";
import { KernelLoop } from "../kernel/loop.js";
import { type PsporePaths } from "../storage/home.js";
export interface DaemonRuntimeFactoryContext {
    paths: PsporePaths;
    config: PsporeConfig;
    toolGate: ToolGate;
    tools: readonly ToolDefinition[];
    skillPaths: () => Promise<readonly string[]>;
}
export interface StartDaemonOptions {
    home: string;
    runtimeFactory?: (context: DaemonRuntimeFactoryContext) => Promise<AgentRuntimePort>;
    clock?: () => Date;
    idFactory?: () => string;
}
export declare class PsporeDaemon {
    #private;
    readonly home: string;
    readonly paths: PsporePaths;
    readonly instanceId: string;
    readonly kernel: KernelLoop;
    private constructor();
    static start(options: StartDaemonOptions): Promise<PsporeDaemon>;
    stop(): Promise<void>;
    whenStopped(): Promise<void>;
}
//# sourceMappingURL=daemon.d.ts.map