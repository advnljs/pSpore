export interface DaemonLock {
    instanceId: string;
    release(): Promise<void>;
}
export declare class DaemonAlreadyRunningError extends Error {
    readonly pid: number;
    constructor(pid: number);
}
export declare function acquireDaemonLock(path: string, now?: Date): Promise<DaemonLock>;
export declare function writeEndpoint(path: string, value: {
    instanceId: string;
    socket: string;
    pid: number;
    state: string;
    startedAt: string;
}): Promise<void>;
//# sourceMappingURL=daemon-lock.d.ts.map