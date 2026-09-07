import { type PsporePaths } from "../storage/home.js";
import { type IndexingSettings, type IndexingSettingsUpdate } from "./indexing-settings.js";
/**
 * Reads and writes `config.indexing` on behalf of a client.
 *
 * Every write is re-parsed with the daemon's own `parseConfig` before it is
 * persisted, so a client cannot leave behind a file the daemon will refuse to
 * load.
 */
export declare class IndexingSettingsService {
    #private;
    constructor(home: string, paths: PsporePaths);
    get(): Promise<IndexingSettings>;
    save(update: IndexingSettingsUpdate): Promise<IndexingSettings>;
}
//# sourceMappingURL=indexing-settings-service.d.ts.map