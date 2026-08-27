import { type KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";
export interface ProtocolUiState {
    kernel: KernelState;
    cursors: Readonly<Record<string, number>>;
    streamingText: Readonly<Record<string, string>>;
    streamingThinking: Readonly<Record<string, string>>;
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
export declare function selectProtocolSession(current: ProtocolUiState, id: string): ProtocolUiState;
export declare function applyProtocolDelta(current: ProtocolUiState, delta: {
    streamId: string;
    fromSeq: number;
    seq: number;
    sessionId: string;
    channel: "text" | "thinking";
    text: string;
}): ProtocolApplyResult;
export declare function applyProtocolEvent(current: ProtocolUiState, event: EventEnvelope): ProtocolApplyResult;
//# sourceMappingURL=protocol-state.d.ts.map