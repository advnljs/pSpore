import type { KernelState, PublicKernelEvent } from "../kernel/state.js";
export declare const PROTOCOL_VERSION: 1;
export declare const DEFAULT_MAX_FRAME_BYTES = 1048576;
export declare const DEFAULT_MAX_NESTING_DEPTH = 32;
export declare const DEFAULT_MAX_STRING_LENGTH = 262144;
export interface ClientHelloFrame {
    v: 1;
    kind: "hello";
    id: string;
    clientId: string;
    supportedVersions: number[];
    capabilities: string[];
    cursors: Record<string, number>;
}
export interface ServerHelloFrame {
    v: 1;
    kind: "hello_ack";
    id: string;
    protocolVersion: 1;
    instanceId: string;
    streamId: string;
    latestSeq: number;
    replayFromSeq: number;
    snapshot: KernelState;
}
export interface CommandEnvelope<T = unknown> {
    v: 1;
    kind: "command";
    id: string;
    clientId: string;
    sessionId?: string;
    expectedRevision?: number;
    type: string;
    payload: T;
}
export interface ResponseEnvelope<T = unknown> {
    v: 1;
    kind: "response";
    id: string;
    commandId: string;
    ok: boolean;
    payload?: T;
    error?: {
        code: string;
        message: string;
        currentRevision?: number;
    };
}
export interface EventEnvelope<T = unknown> {
    v: 1;
    kind: "event";
    id: string;
    streamId: string;
    seq: number;
    ts: string;
    correlationId?: string;
    causationId?: string;
    durable: boolean;
    type: string;
    payload: T;
}
export type ClientFrame = ClientHelloFrame | CommandEnvelope;
export type ServerFrame = ServerHelloFrame | ResponseEnvelope | EventEnvelope;
export declare function decodeClientFrame(line: Uint8Array, maxFrameBytes?: number): ClientFrame;
export declare function encodeFrame(frame: ServerFrame | ClientFrame): string;
export declare function toEventEnvelope(event: PublicKernelEvent, streamId: string, seq: number): EventEnvelope;
export declare class ProtocolError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
//# sourceMappingURL=schema.d.ts.map