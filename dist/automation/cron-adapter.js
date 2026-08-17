import { Cron } from "croner";
export function validateFiveFieldCron(pattern, timezone) {
    const fields = pattern.trim().split(/\s+/);
    if (fields.length !== 5)
        throw new Error("Cron expression must contain exactly 5 fields (minute hour day month weekday)");
    if (fields.some((field) => !/^[0-9*/?,A-Za-z-]+$/.test(field) || /[?LW#]/i.test(field))) {
        throw new Error("Cron expression contains unsupported non-standard syntax");
    }
    validateTimeZone(timezone);
    const cron = new Cron(pattern, { timezone, mode: "5-part", paused: true });
    try {
        if (!cron.nextRun(new Date()))
            throw new Error("Cron expression has no future run");
    }
    finally {
        cron.stop();
    }
}
export class CronSchedule {
    #cron;
    constructor(pattern, timezone) {
        validateFiveFieldCron(pattern, timezone);
        this.#cron = new Cron(pattern, { timezone, mode: "5-part", paused: true });
    }
    next(after) {
        return this.#cron.nextRun(after);
    }
    previous(before) {
        return this.#cron.previousRuns(1, before)[0] ?? null;
    }
    nextMany(count, after) {
        return this.#cron.nextRuns(count, after);
    }
    stop() {
        this.#cron.stop();
    }
}
export function validateTimeZone(timezone) {
    if (!timezone.trim() || timezone.length > 128)
        throw new Error("Timezone must be a non-empty IANA timezone");
    try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    }
    catch {
        throw new Error(`Invalid IANA timezone: ${timezone}`);
    }
}
//# sourceMappingURL=cron-adapter.js.map