import { reduceKernel } from "./reducer.js";
import { initialKernelState, type KernelEffect, type KernelEvent, type KernelState } from "./state.js";

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

  dispatch(event: KernelEvent): Promise<KernelState> {
    const operation = this.#tail.then(() => {
      const reduction = reduceKernel(this.#state, event);
      this.#state = reduction.state;
      for (const effect of reduction.effects) this.#startEffect(effect, reduction.state);
      return this.snapshot();
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
      .then(async () => this.#effectRunner(effect, structuredClone(state)))
      .finally(() => this.#effectTasks.delete(task));
    this.#effectTasks.add(task);
    void task.catch(() => undefined);
  }
}
