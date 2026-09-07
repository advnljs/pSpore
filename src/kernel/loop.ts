import { reduceKernel } from "./reducer.js";
import { initialKernelState, type KernelEffect, type KernelEvent, type KernelState } from "./state.js";

/**
 * Receives the state that produced `effect`. Kernel state is immutable by
 * construction — every reducer branch rebuilds the parts it changes — so the
 * value is shared rather than copied and must never be mutated. Copying it per
 * event meant deep-cloning every session transcript for every streamed token.
 */
export type KernelEffectRunner = (effect: KernelEffect, state: KernelState) => void | Promise<void>;

export class KernelLoop {
  #state: KernelState;
  #tail = Promise.resolve();
  readonly #effectRunner: KernelEffectRunner;
  readonly #effectTasks = new Set<Promise<void>>();

  constructor(effectRunner: KernelEffectRunner, state = initialKernelState()) {
    this.#effectRunner = effectRunner;
    this.#state = structuredClone(state);
  }

  snapshot(): KernelState {
    return structuredClone(this.#state);
  }

  /**
   * Commits `event` and resolves with the resulting state. Like the effect
   * runner's argument, that state is shared and must be treated as read-only.
   */
  dispatch(event: KernelEvent): Promise<KernelState> {
    const operation = this.#tail.then(() => {
      const reduction = reduceKernel(this.#state, event);
      this.#state = reduction.state;
      for (const effect of reduction.effects) this.#startEffect(effect, reduction.state);
      return this.#state;
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async idle(): Promise<void> {
    await this.#tail;
    while (this.#effectTasks.size > 0) {
      await Promise.allSettled([...this.#effectTasks]);
    }
  }

  #startEffect(effect: KernelEffect, state: KernelState): void {
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(async () => this.#effectRunner(effect, state))
      .finally(() => this.#effectTasks.delete(task));
    this.#effectTasks.add(task);
    void task.catch(() => undefined);
  }
}
