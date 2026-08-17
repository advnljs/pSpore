import type { JobStore } from "./job-store.js";
import type { RunLedger } from "./run-ledger.js";
import type { JobDefinition, RunRecord, RunTriggerSpec } from "./types.js";
export interface RunExecutionResult {
    status: "succeeded" | "blocked" | "budget_exhausted";
    reason?: string;
}
export interface RunExecutor {
    execute(run: RunRecord, signal: AbortSignal): Promise<RunExecutionResult>;
}
export interface SchedulerOptions {
    jobs: Pick<JobStore, "loadAll" | "put">;
    ledger: RunLedger;
    executor: RunExecutor;
    maxConcurrentRuns: number;
    replaceGraceMs?: number;
    clock?: () => Date;
    onRun?: (run: RunRecord) => void;
    deliverRun?: (run: RunRecord) => Promise<void>;
    onError?: (error: Error) => void;
}
export declare class Scheduler {
    #private;
    constructor(options: SchedulerOptions);
    initialize(): Promise<void>;
    start(): Promise<void>;
    applyMisfires(now: Date): Promise<void>;
    triggerJob(jobId: string, scheduledFor: Date, source?: "cron" | "recovery" | "user"): Promise<RunRecord>;
    trigger(spec: RunTriggerSpec): Promise<RunRecord>;
    cancel(runId: string, reason?: string): Promise<RunRecord>;
    listRuns(): RunRecord[];
    listJobs(): JobDefinition[];
    putJob(value: unknown, expectedSha256: string | null): Promise<JobDefinition>;
    stop(): Promise<void>;
}
//# sourceMappingURL=scheduler.d.ts.map