import type { ToolAuthorizationRequest, ToolAuthorizationResult, ToolGate } from "../domain/runtime.js";
import type { Capability, PolicyEngine, PolicyEvaluation } from "./policy.js";
export type ApprovalScope = "once" | "session" | "job";
export interface ApprovalRequest {
    id: string;
    sessionId: string;
    agentPath: string[];
    toolCallId: string;
    runId?: string;
    jobId?: string;
    capability: Capability;
    canonicalTarget?: string;
    display: {
        summary: string;
        command?: string;
        cwd?: string;
    };
    riskReasons: string[];
    requestedAt: string;
    expiresAt: string;
    allowedScopes: ApprovalScope[];
}
export interface ApprovalResolution {
    approved: boolean;
    scope: ApprovalScope;
    actor: string;
}
export interface JobGrant {
    version: 1;
    id: string;
    jobId: string;
    capability: Capability;
    canonicalTarget?: string;
    actor: string;
    createdAt: string;
}
export interface ApprovalServiceOptions {
    pendingPath: string;
    auditPath: string;
    grantsPath?: string;
    timeoutMs: number;
    clock?: () => Date;
    idFactory?: () => string;
    onRequested?: (request: ApprovalRequest) => void;
    onResolved?: (request: ApprovalRequest, resolution: ApprovalResolution | {
        interrupted: true;
    }) => void;
}
export declare class ApprovalService {
    #private;
    constructor(options: ApprovalServiceOptions);
    initialize(): Promise<void>;
    request(input: Omit<ApprovalRequest, "id" | "requestedAt" | "expiresAt">): Promise<ApprovalResolution>;
    resolve(id: string, resolution: ApprovalResolution): Promise<{
        status: "resolved" | "already_resolved" | "not_found" | "invalid_scope";
    }>;
    list(): ApprovalRequest[];
    listJobGrants(): JobGrant[];
    hasJobGrant(jobId: string, evaluation: Pick<PolicyEvaluation, "capability" | "canonicalTarget">): boolean;
    cancelSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
}
export declare class PolicyToolGate implements ToolGate {
    #private;
    constructor(policy: PolicyEngine, approvals: ApprovalService);
    authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>;
}
//# sourceMappingURL=approval-service.d.ts.map