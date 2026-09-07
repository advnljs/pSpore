import { type KernelEffect, type KernelEvent, type KernelState } from "./state.js";
/**
 * Receives the state that produced `effect`. Kernel state is immutable by
 * construction — every reducer branch rebuilds the parts it changes — so the
 * value is shared rather than copied and must never be mutated. Copying it per
 * event meant deep-cloning every session transcript for every streamed token.
 */
export type KernelEffectRunner = (effect: KernelEffect, state: KernelState) => void | Promise<void>;
export declare class KernelLoop {
    #private;
    constructor(effectRunner: KernelEffectRunner, state?: KernelState);
    snapshot(): KernelState;
    /**
     * Commits `event` and resolves with the resulting state. Like the effect
     * runner's argument, that state is shared and must be treated as read-only.
     */
    dispatch(event: KernelEvent): Promise<KernelState>;
    idle(): Promise<void>;
}
//# sourceMappingURL=loop.d.ts.map