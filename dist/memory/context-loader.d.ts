import type { PinnedContextFile } from "../domain/runtime.js";
export interface PinnedFileDiagnostic {
    path: string;
    status: "loaded" | "missing";
    estimatedTokens: number;
    sha256?: string;
}
export interface PinnedContextSnapshot {
    files: readonly PinnedContextFile[];
    diagnostics: readonly PinnedFileDiagnostic[];
    estimatedTokens: number;
    prefixSha256: string;
}
export interface PinnedContextLoaderOptions {
    workspaceRoot: string;
    pinnedFiles: readonly string[];
    maxPinnedTokens: number;
    maxFileBytes?: number;
}
export declare class PinnedContextLoader {
    #private;
    constructor(options: PinnedContextLoaderOptions);
    load(): Promise<PinnedContextSnapshot>;
}
export declare function orderPinnedFiles(files: readonly string[]): string[];
//# sourceMappingURL=context-loader.d.ts.map