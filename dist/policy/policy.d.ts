import type { PermissionMode, PermissionRule } from "../config/config.js";
import type { ToolAuthorizationRequest } from "../domain/runtime.js";
export type Capability = "fs.read" | "fs.write" | "fs.delete" | "process.exec" | "process.signal" | "process.pty" | "network.connect" | "network.publish" | "privilege.escalate" | "schedule.read" | "schedule.write" | "agent.spawn" | "agent.message" | "memory.read" | "memory.write" | "external.side_effect";
export interface PolicyEvaluation {
    decision: "allow" | "ask" | "deny";
    capability: Capability;
    canonicalTarget?: string;
    summary: string;
    command?: string;
    cwd?: string;
    riskReasons: string[];
}
export interface PolicyEngineOptions {
    mode: PermissionMode;
    rules: readonly PermissionRule[];
    workspaceRoot: string;
    cwd: string;
}
export declare class PolicyEngine {
    #private;
    private constructor();
    static create(options: PolicyEngineOptions): Promise<PolicyEngine>;
    evaluate(request: ToolAuthorizationRequest): Promise<PolicyEvaluation>;
}
export declare function classifyShellRisk(command: string): string[];
//# sourceMappingURL=policy.d.ts.map