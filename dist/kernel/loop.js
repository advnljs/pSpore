import { reduceKernel } from "./reducer.js";
import { initialKernelState } from "./state.js";
export class KernelLoop {
    #state;
    #tail = Promise.resolve();
    #effectRunner;
    #effectTasks = new Set();
    constructor(effectRunner, state = initialKernelState()) {
        this.#effectRunner = effectRunner;
        this.#state = structuredClone(state);
    }
    snapshot() {
        return structuredClone(this.#state);
    }
    /**
     * Commits `event` and resolves with the resulting state. Like the effect
     * runner's argument, that state is shared and must be treated as read-only.
     */
    dispatch(event) {
        const operation = this.#tail.then(() => {
            const reduction = reduceKernel(this.#state, event);
            this.#state = reduction.state;
            for (const effect of reduction.effects)
                this.#startEffect(effect, reduction.state);
            return this.#state;
        });
        this.#tail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async idle() {
        await this.#tail;
        while (this.#effectTasks.size > 0) {
            await Promise.allSettled([...this.#effectTasks]);
        }
    }
    #startEffect(effect, state) {
        let task;
        task = Promise.resolve()
            .then(async () => this.#effectRunner(effect, state))
            .finally(() => this.#effectTasks.delete(task));
        this.#effectTasks.add(task);
        void task.catch(() => undefined);
    }
}
//# sourceMappingURL=loop.js.map