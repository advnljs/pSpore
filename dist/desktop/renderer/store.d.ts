import type { KernelState } from "../../kernel/state.js";
import { type CoworkActivity } from "../../ui/shared/activity.js";
import type { DesktopBootstrap, DesktopConnectionState, DesktopFrame } from "../ipc-contract.js";
export type DesktopActivity = CoworkActivity;
export interface DesktopStoreSnapshot {
    connection: DesktopConnectionState;
    kernel: KernelState;
    cursors: Readonly<Record<string, number>>;
    streamingText: Readonly<Record<string, string>>;
    selectedSessionId: string;
    activities: readonly DesktopActivity[];
    notice: string;
    gap?: {
        streamId: string;
        expected: number;
        received: number;
    };
}
export declare class DesktopStore {
    #private;
    snapshot(): DesktopStoreSnapshot;
    applyBootstrap(bootstrap: DesktopBootstrap): void;
    applyFrame(frame: DesktopFrame): void;
    selectSession(id: string): void;
    setNotice(notice: string): void;
}
//# sourceMappingURL=store.d.ts.map