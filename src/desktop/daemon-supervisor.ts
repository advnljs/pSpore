import { PsporeDaemon } from "../daemon/daemon.js";
import { DaemonAlreadyRunningError } from "../storage/daemon-lock.js";

interface ManagedDaemon {
  stop(): Promise<void>;
}

export type DesktopDaemonOwnership = "owned" | "external";

export interface DesktopDaemonSupervisorOptions {
  home: string;
  startDaemon?: (home: string) => Promise<ManagedDaemon>;
}

export class DesktopDaemonSupervisor {
  readonly #home: string;
  readonly #startDaemon: (home: string) => Promise<ManagedDaemon>;
  #daemon: ManagedDaemon | undefined;
  #ownership: DesktopDaemonOwnership | undefined;

  constructor(options: DesktopDaemonSupervisorOptions) {
    this.#home = options.home;
    this.#startDaemon = options.startDaemon ?? (async (home) => PsporeDaemon.start({ home }));
  }

  get ownership(): DesktopDaemonOwnership | undefined {
    return this.#ownership;
  }

  async start(): Promise<DesktopDaemonOwnership> {
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
