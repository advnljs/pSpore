import { type KernelEffect, type KernelEvent, type KernelState } from "./state.js";
export type KernelEffectRunner = (effect: KernelEffect, state: KernelState) => void | Promise<void>;
export declare class KernelLoop {
    #private;
    constructor(effectRunner: KernelEffectRunner, state?: KernelState);
    snapshot(): KernelState;
    dispatch(event: KernelEvent): Promise<KernelState>;
    idle(): Promise<void>;
}
//# sourceMappingURL=loop.d.ts.map