export interface DesktopArguments {
    home?: string;
    smokeDirectory?: string;
    smokeFixture: boolean;
}
/** The loaded application takes over teardown while the entry owns the splash. */
export interface DesktopStartup {
    setMessage(message: string): Promise<void>;
    close(): void;
}
//# sourceMappingURL=main.d.ts.map