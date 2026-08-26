export interface SystemServiceLaunchSpec {
    executable: string;
    args: readonly string[];
    workingDirectory: string;
    environment?: Readonly<Record<string, string>>;
}
export interface SystemServiceCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type SystemServiceCommandRunner = (executable: string, args: readonly string[]) => Promise<SystemServiceCommandResult>;
export interface SystemServiceStatus {
    unitName: string;
    unitPath: string;
    installed: boolean;
    enabled: boolean;
    active: boolean;
    linger: boolean | undefined;
    detail?: string;
}
export interface SystemServiceEnsureResult extends SystemServiceStatus {
    unitChanged: boolean;
    lingerWarning?: string;
}
export interface SystemServiceManagerOptions {
    home: string;
    userConfigDirectory?: string;
    username?: string;
    runner?: SystemServiceCommandRunner;
    beforeStart?: () => Promise<void>;
}
/**
 * Installs and controls the per-user systemd service used by production clients.
 * GUI/TUI callers never own the daemon process; their only lifecycle action is
 * asking systemd to keep the authoritative service enabled and running.
 */
export declare class SystemServiceManager {
    #private;
    readonly unitName: string;
    readonly unitPath: string;
    constructor(options: SystemServiceManagerOptions);
    ensureRunning(spec: SystemServiceLaunchSpec): Promise<SystemServiceEnsureResult>;
    install(spec: SystemServiceLaunchSpec): Promise<boolean>;
    restart(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    uninstall(): Promise<void>;
    status(): Promise<SystemServiceStatus>;
    logs(lines?: number): Promise<string>;
}
export declare function renderSystemdUserUnit(home: string, spec: SystemServiceLaunchSpec): string;
export declare function serviceUnitName(home: string, defaultHome?: string): string;
export declare function systemdQuote(value: string): string;
//# sourceMappingURL=system-service.d.ts.map