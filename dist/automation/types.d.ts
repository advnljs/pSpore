export interface RunBudget {
    maxTurns: number;
    maxToolCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxChildren: number;
    maxCostUsd?: number;
}
export type DeliveryTarget = {
    kind: "session";
    sessionId: string;
} | {
    kind: "local-notification";
} | {
    kind: "none";
};
export type RunActivity = {
    kind: "agent";
    prompt: string;
    cwd: string;
} | {
    kind: "command";
    command: string;
    cwd: string;
};
export interface JobDefinition {
    version: 1;
    id: string;
    enabled: boolean;
    schedule: {
        cron: string;
        timezone: string;
    };
    policyRef: string;
    concurrency: "forbid" | "replace" | "allow";
    misfire: "skip" | "run_once";
    timeoutMs: number;
    budget: RunBudget;
    delivery: DeliveryTarget;
    activity: RunActivity;
    sourceSha256?: string;
}
export type RunSource = "user" | "boot" | "cron" | "recovery";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "budget_exhausted" | "unknown" | "skipped";
export interface RunRecord {
    version: 1;
    revision: number;
    id: string;
    slotKey: string;
    source: RunSource;
    jobId?: string;
    scheduledFor: string;
    receivedAt: string;
    objective: string;
    activity: RunActivity;
    policyRef: string;
    concurrency: JobDefinition["concurrency"];
    timeoutMs: number;
    budget: RunBudget;
    delivery: DeliveryTarget;
    status: RunStatus;
    startedAt?: string;
    finishedAt?: string;
    reason?: string;
    error?: string;
}
export interface RunTriggerSpec {
    slotKey: string;
    source: RunSource;
    jobId?: string;
    scheduledFor: string;
    receivedAt: string;
    objective: string;
    activity: RunActivity;
    policyRef: string;
    concurrency: JobDefinition["concurrency"];
    timeoutMs: number;
    budget: RunBudget;
    delivery: DeliveryTarget;
}
//# sourceMappingURL=types.d.ts.map