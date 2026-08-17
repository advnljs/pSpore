import type { RunRecord } from "../automation/types.js";
export type NotificationLevel = "info" | "success" | "warning" | "error";
export interface NotificationRecord {
    version: 1;
    id: string;
    ts: string;
    level: NotificationLevel;
    title: string;
    body: string;
    source: {
        kind: "agent";
        sessionId: string;
    } | {
        kind: "run";
        runId: string;
        jobId?: string;
    };
    target: {
        kind: "local-notification";
    } | {
        kind: "session";
        sessionId: string;
    };
}
export interface NotificationServiceOptions {
    path: string;
    recoveryDirectory: string;
    clock?: () => Date;
    idFactory?: () => string;
    onNotification?: (record: NotificationRecord) => void | Promise<void>;
    retainedRecords?: number;
}
export declare class NotificationService {
    #private;
    constructor(options: NotificationServiceOptions);
    initialize(): Promise<void>;
    notify(input: {
        level: NotificationLevel;
        title: string;
        body: string;
        source: NotificationRecord["source"];
        target?: NotificationRecord["target"];
    }): Promise<NotificationRecord>;
    deliverRun(run: RunRecord): Promise<void>;
    list(): NotificationRecord[];
}
//# sourceMappingURL=notification-service.d.ts.map