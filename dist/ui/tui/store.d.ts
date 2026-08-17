import type { ModelRef } from "../../domain/runtime.js";
import type { KernelState } from "../../kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../../protocol/schema.js";
import { type CoworkActivity } from "../shared/activity.js";
export interface TuiStoreSnapshot {
    connected: boolean;
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
    snapshot(): TuiStoreSnapshot;
    applyHello(hello: ServerHelloFrame): void;
    disconnected(message: string): void;
    setNotice(notice: string): void;
    setConfiguredModel(model: ModelRef | undefined): void;
    setPanel(title: string, lines: readonly string[]): void;
    clearPanel(): void;
    selectSession(id: string): string;
    applyEvent(event: EventEnvelope): void;
}
//# sourceMappingURL=store.d.ts.map