import type { KernelState } from "../kernel/state.js";
import type { NotificationRecord } from "../notifications/notification-service.js";
/** The destination is resolved from authoritative state, never from popup IPC. */
export declare function notificationSession(record: NotificationRecord, state: KernelState): string | undefined;
/** First connection is a baseline; subsequent snapshots recover missed notifications. */
export declare class NotificationFeed {
    #private;
    accept(records: readonly NotificationRecord[]): NotificationRecord[];
}
export declare function notificationBounds(area: {
    x: number;
    y: number;
    width: number;
    height: number;
}): {
    x: number;
    y: number;
    width: number;
    height: number;
};
//# sourceMappingURL=notification-model.d.ts.map