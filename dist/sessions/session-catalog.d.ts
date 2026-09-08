import type { RootSessionMetadata } from "../domain/runtime.js";
export interface RootSessionRecord extends RootSessionMetadata {
    id: string;
    sessionFile: string;
    cwd: string;
    titleSource: "default" | "user" | "prompt";
}
export interface SessionCatalogOptions {
    path: string;
    sessionsRoot: string;
    workspaceId: string;
    cwd: string;
    clock?: () => Date;
}
export declare class SessionCatalog {
    #private;
    private constructor();
    static open(options: SessionCatalogOptions): Promise<SessionCatalog>;
    list(): RootSessionRecord[];
    get(id: string): RootSessionRecord | undefined;
    idle(): Promise<void>;
    add(input: {
        id: string;
        sessionFile: string;
        cwd: string;
        title?: string;
    }): Promise<RootSessionRecord>;
    /**
     * Forgets a root session and deletes the transcript it owns.
     *
     * The stored path is re-resolved against the sessions root before anything is
     * unlinked, so a catalog entry that points outside the root loses its record
     * without the filesystem being touched. Deleting is the point of the command,
     * so a transcript that is already gone is not an error.
     */
    remove(id: string): Promise<{
        record: RootSessionRecord;
        transcriptRemoved: boolean;
    } | undefined>;
    touch(id: string, options?: {
        prompt?: string;
        sessionFile?: string;
    }): Promise<RootSessionRecord | undefined>;
}
//# sourceMappingURL=session-catalog.d.ts.map