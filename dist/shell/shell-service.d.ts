export type ShellMode = "pipe" | "pty";
export type ShellStream = "stdout" | "stderr";
export interface ShellRequest {
    command: string;
    cwd: string;
    envDelta?: Readonly<Record<string, string>>;
    mode: ShellMode;
    timeoutMs: number;
    maxOutputBytes: number;
}
export interface ShellChunk {
    processId: string;
    stream: ShellStream;
    data: string;
    ts: string;
}
export interface ShellResult {
    processId: string;
    pid: number;
    shell: string;
    mode: ShellMode;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    timedOut: boolean;
    aborted: boolean;
    outputLimitExceeded: boolean;
    stdout: string;
    stderr: string;
    capturedBytes: number;
    artifactPath: string;
    artifactSha256: string;
}
export interface ShellProcessStatus {
    processId: string;
    pid: number;
    state: "running" | "settled";
    capturedBytes: number;
    startedAt: string;
}
export interface ShellProcessHandle {
    readonly id: string;
    readonly pid: number;
    readonly completion: Promise<ShellResult>;
    write(data: string | Uint8Array, options?: {
        secret?: boolean;
    }): Promise<void>;
    signal(signal: NodeJS.Signals): void;
    poll(): ShellProcessStatus;
}
export interface ResolvedShell {
    path: string;
    source: "config" | "environment" | "passwd" | "fallback";
}
export interface ResolveShellOptions {
    configuredShell?: string;
    env?: NodeJS.ProcessEnv;
    uid?: number;
    passwdPath?: string;
}
export interface ShellServiceOptions {
    artifactRoot: string;
    configuredShell?: string;
    env?: NodeJS.ProcessEnv;
    passwdPath?: string;
    scriptPath?: string;
    clock?: () => Date;
    idFactory?: () => string;
    summaryBytesPerStream?: number;
}
export declare class ShellService {
    #private;
    constructor(options: ShellServiceOptions);
    initialize(): Promise<ResolvedShell>;
    doctor(): Promise<{
        shell: ResolvedShell;
        pipe: true;
        pty: {
            available: boolean;
            scriptPath?: string;
        };
    }>;
    run(request: ShellRequest, onChunk?: (chunk: ShellChunk) => void): Promise<ShellResult>;
    start(request: ShellRequest, onChunk?: (chunk: ShellChunk) => void): Promise<ShellProcessHandle>;
}
export declare function resolveUserShell(options?: ResolveShellOptions): Promise<ResolvedShell>;
export declare function shellDisplayName(path: string): string;
//# sourceMappingURL=shell-service.d.ts.map