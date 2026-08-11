import { PsporeDaemon } from "./daemon.js";
import { DaemonAlreadyRunningError } from "../storage/daemon-lock.js";

interface ManagedDaemon {
  stop(): Promise<void>;
}

export type DaemonOwnership = "owned" | "external";

export interface DaemonSupervisorOptions {
  home: string;
  startDaemon?: (home: string) => Promise<ManagedDaemon>;
}

/** Shares the same single-instance Daemon lifecycle across GUI and TUI shells. */
export class DaemonSupervisor {
  readonly #home: string;
  readonly #startDaemon: (home: string) => Promise<ManagedDaemon>;
  #daemon: ManagedDaemon | undefined;
  #ownership: DaemonOwnership | undefined;

  constructor(options: DaemonSupervisorOptions) {
    this.#home = options.home;
    this.#startDaemon = options.startDaemon ?? (async (home) => PsporeDaemon.start({ home }));
  }

  get ownership(): DaemonOwnership | undefined {
    return this.#ownership;
  }

  async start(): Promise<DaemonOwnership> {
    if (this.#ownership) return this.#ownership;
    try {
      this.#daemon = await this.#startDaemon(this.#home);
      this.#ownership = "owned";
    } catch (error) {
      if (!(error instanceof DaemonAlreadyRunningError)) throw error;
      this.#ownership = "external";
    }
    return this.#ownership;
  }

  async stop(): Promise<void> {
    const daemon = this.#daemon;
    this.#daemon = undefined;
    this.#ownership = undefined;
    await daemon?.stop();
  }
}
