import { type PsporeConfig } from "../config/config.js";
export interface PsporePaths {
    home: string;
    config: string;
    workspace: string;
    state: string;
    sessions: string;
    sessionCatalog: string;
    runs: string;
    approvals: string;
    events: string;
    audit: string;
    resourceTrust: string;
    artifacts: string;
    plugins: string;
    credentials: string;
    cache: string;
    run: string;
    agentDir: string;
    socket: string;
    endpoint: string;
    lock: string;
}
export declare function psporePaths(home: string, workspace?: string): PsporePaths;
export declare function initializePsporeHome(home: string): Promise<{
    paths: PsporePaths;
    created: string[];
}>;
export declare function loadConfig(home: string): Promise<PsporeConfig>;
//# sourceMappingURL=home.d.ts.map