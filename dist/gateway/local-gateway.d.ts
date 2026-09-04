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
    maxPendingBytes?: number;
    maxServerMessageBytes?: number;
    idFactory?: () => string;
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