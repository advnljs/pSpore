import type { EventEnvelope, ServerHelloFrame } from "../protocol/schema.js";
import { type DesktopBootstrap, type DesktopFrame, type DesktopVersions } from "./ipc-contract.js";
interface ProtocolClientLike {
    connect(): Promise<ServerHelloFrame>;
    close(): Promise<void>;
    command<T = unknown>(type: string, payload: unknown, options?: {
        id?: string;
        sessionId?: string;
        expectedRevision?: number;
    }): Promise<T>;
    subscribe(listener: (event: EventEnvelope) => void): () => void;
    subscribeConnection(listener: (connected: boolean, error?: Error) => void): () => void;
}
export interface DaemonBridgeOptions {
    socketPath: string;
    stagingRoot: string;
    versions: DesktopVersions;
    clientId?: string;
    reconnectDelay?: (attempt: number) => number;
    clientFactory?: (cursors: Record<string, number>) => ProtocolClientLike;
}
export declare class DaemonBridge {
    #private;
    constructor(options: DaemonBridgeOptions);
    start(): void;
    stop(): Promise<void>;
    bootstrap(): DesktopBootstrap;
    subscribe(listener: (frame: DesktopFrame) => void): () => void;
    dispatch(value: unknown): Promise<unknown>;
}
export {};
//# sourceMappingURL=daemon-bridge.d.ts.map