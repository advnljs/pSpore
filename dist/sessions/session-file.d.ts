export interface ResolveSessionFileOptions {
    root?: string;
    allowMissing?: boolean;
}
/**
 * Canonicalize a Pi JSONL session path without requiring the leaf file to
 * exist. Pi intentionally defers creating a new file until persistence starts,
 * so callers may validate the existing canonical parent first and materialize
 * the leaf afterwards.
 */
export declare function resolveSessionFile(path: string, options?: ResolveSessionFileOptions): Promise<string>;
//# sourceMappingURL=session-file.d.ts.map