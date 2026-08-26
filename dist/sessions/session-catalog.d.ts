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
    touch(id: string, options?: {
        prompt?: string;
        sessionFile?: string;
    }): Promise<RootSessionRecord | undefined>;
}
//# sourceMappingURL=session-catalog.d.ts.map