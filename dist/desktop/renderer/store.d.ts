import type { RuntimeMessage } from "../../domain/runtime.js";
import type { KernelState } from "../../kernel/state.js";
import { type CoworkActivity } from "../../ui/shared/activity.js";
import type { DesktopBootstrap, DesktopConnectionState, DesktopFrame } from "../ipc-contract.js";
export type DesktopActivity = CoworkActivity;
/**
 * A reconnect that resolves inside this window is invisible to the user. Long
 * runs briefly drop and re-establish the socket; showing every one of those made
 * the header badge, banner and every connection-gated button flicker.
 */
export declare const CONNECTION_SETTLE_MS = 2000;
export interface DesktopStoreSnapshot {
    /** Raw bridge state; use `stableConnection` for anything the user sees. */
    connection: DesktopConnectionState;
    /**
     * Connection state after the settle window: it keeps reporting `connected`
     * through a short reconnect and only degrades once the outage outlasts
     * `CONNECTION_SETTLE_MS`.
     */
    stableConnection: DesktopConnectionState;
    /** True while a reconnect is in flight but still being presented as connected. */
    reconnecting: boolean;
    kernel: KernelState;
    cursors: Readonly<Record<string, number>>;
    streamingText: Readonly<Record<string, string>>;
    streamingThinking: Readonly<Record<string, string>>;
    /** Transcript item each session is streaming, keyed by session id. */
    streamingItems: Readonly<Record<string, string>>;
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
    constructor(now?: () => number);
    /**
     * Re-evaluates the settle window. The renderer calls this on a timer so a
     * genuine outage still surfaces even when no further frames arrive.
     * Returns true when the presented state changed.
     */
    settleConnection(): boolean;
    snapshot(): DesktopStoreSnapshot;
    applyBootstrap(bootstrap: DesktopBootstrap): void;
    applyFrame(frame: DesktopFrame): void;
    /** Merges an older page of history fetched by the transcript backfill. */
    applyTranscriptPage(page: {
        sessionId: string;
        from: number;
        count: number;
        messages: readonly RuntimeMessage[];
    }): boolean;
    selectSession(id: string): void;
    setNotice(notice: string): void;
}
//# sourceMappingURL=store.d.ts.map