export type LocalPathAction = "open" | "reveal";
export interface LocalPathRequest {
    path: string;
    action: LocalPathAction;
}
/** A string is the original click payload: open the path. */
export declare function decodeLocalPathRequest(value: unknown): LocalPathRequest;
/**
 * The renderer may request only a local, existing regular file or directory.
 * Opening an executable is refused — the system opener may run it — but
 * revealing it in the file manager does not.
 */
export declare function resolveLocalPath(value: string, action: LocalPathAction): Promise<string>;
export declare function decodeOpenLocalPath(value: unknown): Promise<string>;
//# sourceMappingURL=local-path.d.ts.map