import { type ServerFrame } from "./schema.js";
export declare const SERVER_FRAME_CHUNKS_CAPABILITY = "server-frame-chunks.v1";
export declare const DEFAULT_MAX_SERVER_MESSAGE_BYTES = 67108864;
export declare function encodeServerFrame(frame: ServerFrame, options: {
    maxFrameBytes: number;
    maxMessageBytes?: number;
    idFactory: () => string;
}): readonly string[];
export declare class ServerFrameDecoder {
    #private;
    constructor(options: {
        maxFrameBytes: number;
        maxMessageBytes?: number;
    });
    reset(): void;
    decode(line: Uint8Array): ServerFrame | undefined;
}
//# sourceMappingURL=server-frame-codec.d.ts.map