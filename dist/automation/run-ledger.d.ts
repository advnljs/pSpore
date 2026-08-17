import type { RunRecord, RunTriggerSpec } from "./types.js";
export interface RunLedgerOptions {
    root: string;
    recoveryDirectory: string;
    clock?: () => Date;
    idFactory?: () => string;
}
export declare class RunLedger {
    #private;
    constructor(options: RunLedgerOptions);
    initialize(): Promise<{
        recoveredUnknown: RunRecord[];
        queued: RunRecord[];
    }>;
    claim(spec: RunTriggerSpec): Promise<{
        claimed: boolean;
        record: RunRecord;
    }>;
    transition(id: string, patch: Pick<RunRecord, "status"> & Partial<Pick<RunRecord, "startedAt" | "finishedAt" | "reason" | "error">>): Promise<RunRecord>;
    get(id: string): RunRecord | undefined;
    findSlot(slotKey: string): RunRecord | undefined;
    latestForJob(jobId: string): RunRecord | undefined;
    list(): RunRecord[];
}
//# sourceMappingURL=run-ledger.d.ts.map