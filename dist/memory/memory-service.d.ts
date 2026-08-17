export interface MemorySource {
    sessionId: string;
    runId?: string;
}
export interface CuratedEntry {
    fact: string;
    sources: string[];
}
export interface MemoryServiceOptions {
    workspaceRoot: string;
    clock?: () => Date;
    idFactory?: () => string;
    timeZone?: string;
}
export declare class MemoryService {
    #private;
    constructor(options: MemoryServiceOptions);
    append(fact: string, source: MemorySource): Promise<{
        path: string;
        id: string;
        sha256: string;
    }>;
    curate(expectedSha256: string, entries: readonly CuratedEntry[]): Promise<{
        path: string;
        previousSha256: string;
        sha256: string;
        added: number;
    }>;
}
//# sourceMappingURL=memory-service.d.ts.map