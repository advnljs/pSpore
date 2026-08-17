import { type EventEnvelope, type ServerHelloFrame } from "./schema.js";
export interface ProtocolClientOptions {
    socketPath: string;
    clientId: string;
    capabilities?: string[];
    cursors?: Record<string, number>;
    maxFrameBytes?: number;
    idFactory?: () => string;
}
export declare class ProtocolClient {
    #private;
    constructor(options: ProtocolClientOptions);
    get hello(): ServerHelloFrame | undefined;
    get cursors(): Record<string, number>;
    connect(): Promise<ServerHelloFrame>;
    subscribe(listener: (event: EventEnvelope) => void): () => void;
    subscribeConnection(listener: (connected: boolean, error?: Error) => void): () => void;
    command<T = unknown>(type: string, payload: unknown, options?: {
        id?: string;
        sessionId?: string;
        expectedRevision?: number;
    }): Promise<T>;
    close(): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map