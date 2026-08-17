import { PsporeDaemon } from "./daemon.js";
import { DaemonAlreadyRunningError } from "../storage/daemon-lock.js";
/** Shares the same single-instance Daemon lifecycle across GUI and TUI shells. */
export class DaemonSupervisor {
    #home;
    #startDaemon;
    #daemon;
    #ownership;
    constructor(options) {
        this.#home = options.home;
        this.#startDaemon = options.startDaemon ?? (async (home) => PsporeDaemon.start({ home }));
    }
    get ownership() {
        return this.#ownership;
    }
    async start() {
        if (this.#ownership)
            return this.#ownership;
        try {
            this.#daemon = await this.#startDaemon(this.#home);
            this.#ownership = "owned";
        }
        catch (error) {
            if (!(error instanceof DaemonAlreadyRunningError))
                throw error;
            this.#ownership = "external";
        }
        return this.#ownership;
    }
    async stop() {
        const daemon = this.#daemon;
        this.#daemon = undefined;
        this.#ownership = undefined;
        await daemon?.stop();
    }
}
//# sourceMappingURL=supervisor.js.map