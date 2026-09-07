import type { ModelRef, RuntimeMessage } from "../../domain/runtime.js";
import type { KernelState } from "../../kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../../protocol/schema.js";
import { type CoworkActivity } from "../shared/activity.js";
/** Matches the desktop settle window so both shells report outages alike. */
export declare const TUI_CONNECTION_SETTLE_MS = 2000;
export interface TuiStoreSnapshot {
    /** Presented connection state: a reconnect inside the settle window stays true. */
    connected: boolean;
    /** True while a short reconnect is in flight but still presented as connected. */
    reconnecting: boolean;
    instanceId?: string;
    selectedSessionId: string;
    kernel: KernelState;
    cursors: Readonly<Record<string, number>>;
    gap?: {
        streamId: string;
        expected: number;
        received: number;
    };
    streamingText: Readonly<Record<string, string>>;
    streamingThinking: Readonly<Record<string, string>>;
    /** Transcript item each session is streaming, keyed by session id. */
    streamingItems: Readonly<Record<string, string>>;
    activities: readonly CoworkActivity[];
    configuredModel?: ModelRef;
    notice: string;
    panel?: {
        title: string;
        lines: readonly string[];
    };
}
export declare class TuiStore {
    #private;
    constructor(now?: () => number);
    /**
     * Re-checks the settle window from a timer so a real outage still surfaces
     * once the masking window expires. Returns true when the view changed.
     */
    settleConnection(): boolean;
    snapshot(): TuiStoreSnapshot;
    applyHello(hello: ServerHelloFrame): void;
    disconnected(message: string): void;
    setNotice(notice: string): void;
    setConfiguredModel(model: ModelRef | undefined): void;
    setPanel(title: string, lines: readonly string[]): void;
    clearPanel(): void;
    selectSession(id: string): string;
    /** Merges an older page of history fetched by the scrollback request. */
    applyTranscriptPage(page: {
        sessionId: string;
        from: number;
        count: number;
        messages: readonly RuntimeMessage[];
    }): boolean;
    applyEvent(event: EventEnvelope): void;
}
//# sourceMappingURL=store.d.ts.map