export declare function validateFiveFieldCron(pattern: string, timezone: string): void;
export declare class CronSchedule {
    #private;
    constructor(pattern: string, timezone: string);
    next(after: Date): Date | null;
    previous(before: Date): Date | null;
    nextMany(count: number, after: Date): Date[];
    stop(): void;
}
export declare function validateTimeZone(timezone: string): void;
//# sourceMappingURL=cron-adapter.d.ts.map