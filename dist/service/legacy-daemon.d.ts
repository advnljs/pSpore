/**
 * One-time migration helper: an old GUI-owned daemon cannot be adopted by
 * systemd, so ask it to exit cleanly before the new service starts.
 */
export declare function stopLegacyDaemon(home: string): Promise<void>;
//# sourceMappingURL=legacy-daemon.d.ts.map