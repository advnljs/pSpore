import type { KernelState } from "../kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../protocol/schema.js";
export declare function validateKernelState(value: unknown): KernelState;
export declare function validateServerHello(value: unknown): ServerHelloFrame;
export declare function validateEventEnvelope(value: unknown): EventEnvelope;
export declare function validateProtocolResult<T = unknown>(value: T): T;
export declare function assertSafeProtocolValue(value: unknown): void;
//# sourceMappingURL=validation.d.ts.map