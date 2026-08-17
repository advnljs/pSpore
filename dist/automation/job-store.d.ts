import type { JobDefinition } from "./types.js";
export declare class JobStore {
    #private;
    constructor(options: {
        jobsDirectory: string;
        workspaceRoot: string;
    });
    loadAll(): Promise<JobDefinition[]>;
    put(value: unknown, expectedSha256: string | null): Promise<JobDefinition>;
}
export declare function parseJob(value: unknown, expectedId: string, workspaceRoot: string): Promise<JobDefinition>;
//# sourceMappingURL=job-store.d.ts.map