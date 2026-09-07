import type { RuntimeMessage } from "../../domain/runtime.js";
import { type KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";
export interface ProtocolUiState {
    kernel: KernelState;
    cursors: Readonly<Record<string, number>>;
    streamingText: Readonly<Record<string, string>>;
    streamingThinking: Readonly<Record<string, string>>;
    /** Transcript item each session is currently streaming, so a delta for a
     * superseded item cannot append to the one on screen. */
    streamingItems: Readonly<Record<string, string>>;
    selectedSessionId: string;
    gap?: {
        streamId: string;
        expected: number;
        received: number;
    };
}
export interface ProtocolApplyResult {
    state: ProtocolUiState;
    applied: boolean;
    notificationNotice?: string;
}
export declare function initialProtocolUiState(): ProtocolUiState;
export declare function replaceProtocolSnapshot(current: ProtocolUiState, kernel: KernelState, cursors: Readonly<Record<string, number>>): ProtocolUiState;
/**
 * Merges an older page of history in front of what a client already holds.
 * Only prepending is supported: the newest messages arrive with events, and a
 * page that would leave a hole is refused rather than silently reordered.
 */
export declare function applyTranscriptPage(current: ProtocolUiState, page: {
    sessionId: string;
    from: number;
    count: number;
    messages: readonly RuntimeMessage[];
}): ProtocolUiState;
export declare function selectProtocolSession(current: ProtocolUiState, id: string): ProtocolUiState;
export declare function applyProtocolDelta(current: ProtocolUiState, delta: {
    streamId: string;
    fromSeq: number;
    seq: number;
    skipped?: number;
    sessionId: string;
    itemId: string;
    channel: "text" | "thinking";
    text: string;
}): ProtocolApplyResult;
export declare function applyProtocolEvent(current: ProtocolUiState, event: EventEnvelope): ProtocolApplyResult;
//# sourceMappingURL=protocol-state.d.ts.map