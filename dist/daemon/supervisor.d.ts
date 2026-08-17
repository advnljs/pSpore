interface ManagedDaemon {
    stop(): Promise<void>;
}
export type DaemonOwnership = "owned" | "external";
export interface DaemonSupervisorOptions {
    home: string;
    startDaemon?: (home: string) => Promise<ManagedDaemon>;
}
/** Shares the same single-instance Daemon lifecycle across GUI and TUI shells. */
export declare class DaemonSupervisor {
    #private;
    constructor(options: DaemonSupervisorOptions);
    get ownership(): DaemonOwnership | undefined;
    start(): Promise<DaemonOwnership>;
    stop(): Promise<void>;
}
export {};
//# sourceMappingURL=supervisor.d.ts.map