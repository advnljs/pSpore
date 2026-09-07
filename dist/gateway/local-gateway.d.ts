import type { KernelState, PublicKernelEvent } from "../kernel/state.js";
import { type CommandEnvelope, type EventEnvelope } from "../protocol/schema.js";
export interface LocalGatewayOptions {
    socketPath: string;
    instanceId: string;
    snapshot: () => KernelState;
    handleCommand: (command: CommandEnvelope) => Promise<unknown>;
    streamId?: string;
    replayCapacity?: number;
    commandCacheCapacity?: number;
    maxFrameBytes?: number;
    /** Ceiling for a single connection's undecoded *incoming* buffer. */
    maxPendingBytes?: number;
    /** Ceiling for a single connection's queued *outgoing* bytes. */
    maxOutgoingBytes?: number;
    maxServerMessageBytes?: number;
    /** Ceiling for the retained replay window, measured in payload characters. */
    maxReplayBytes?: number;
    idFactory?: () => string;
    /** Reports a dropped connection or an undeliverable frame to the daemon log. */
    onWarning?: (message: string) => void;
}
export declare class LocalGateway {
    #private;
    constructor(options: LocalGatewayOptions);
    get latestSeq(): number;
    start(): Promise<void>;
    publish(event: PublicKernelEvent): EventEnvelope;
    stop(): Promise<void>;
}
//# sourceMappingURL=local-gateway.d.ts.map