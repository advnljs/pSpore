import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../config/config.js";
import { bundledIndexerPath } from "../indexing/index-service.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { loadConfig } from "../storage/home.js";
import { decodeIndexingSettingsUpdate, } from "./indexing-settings.js";
/**
 * Reads and writes `config.indexing` on behalf of a client.
 *
 * Every write is re-parsed with the daemon's own `parseConfig` before it is
 * persisted, so a client cannot leave behind a file the daemon will refuse to
 * load.
 */
export class IndexingSettingsService {
    #home;
    #paths;
    constructor(home, paths) {
        this.#home = home;
        this.#paths = paths;
    }
    async get() {
        const config = await loadConfig(this.#home);
        const indexerPath = this.#indexerPath();
        return {
            version: 1,
            enabled: config.indexing.enabled,
            directories: [...config.indexing.directories],
            intervalMinutes: config.indexing.intervalMinutes,
            extensions: [...config.indexing.extensions],
            configPath: this.#paths.config,
            indexerAvailable: await exists(indexerPath),
            indexerPath,
        };
    }
    async save(update) {
        const decoded = decodeIndexingSettingsUpdate(update);
        const current = await loadConfig(this.#home);
        const next = parseConfig({ ...current, indexing: { ...decoded } }, this.#home);
        await atomicWriteJson(this.#paths.config, next, 0o600);
        return this.get();
    }
    /** Path of the indexer inside the bundled skill's workspace link. */
    #indexerPath() {
        return bundledIndexerPath(join(this.#paths.workspace, "skills", "aegis-search"));
    }
}
async function exists(path) {
    try {
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=indexing-settings-service.js.map