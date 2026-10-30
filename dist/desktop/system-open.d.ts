export declare function openerFailure(code: number | null): string | undefined;
/** Arguments for FileManager1.ShowItems, which selects the file in its folder. */
export declare function fileManagerShowItemsArgs(targetPath: string): string[];
/**
 * Spawns a command without a shell. A process that is still running after the
 * grace period has handed off; only a quick non-zero exit or a missing binary
 * is a failure.
 */
export declare function launchCommand(command: string, args: readonly string[], graceMs?: number): Promise<void>;
export declare function openLocalItem(targetPath: string): Promise<void>;
/**
 * Asks the file manager to show the path's parent and select the path. When
 * that service is missing, the parent directory is opened instead.
 */
export declare function revealLocalItem(targetPath: string): Promise<void>;
//# sourceMappingURL=system-open.d.ts.map