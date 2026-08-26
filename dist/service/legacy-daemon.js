import { readFile } from "node:fs/promises";
import { ProtocolClient } from "../protocol/client.js";
import { psporePaths } from "../storage/home.js";
/**
 * One-time migration helper: an old GUI-owned daemon cannot be adopted by
 * systemd, so ask it to exit cleanly before the new service starts.
 */
export async function stopLegacyDaemon(home) {
    const paths = psporePaths(home);
    let socket = paths.socket;
    try {
        const endpoint = JSON.parse(await readFile(paths.endpoint, "utf8"));
        if (typeof endpoint.socket === "string" && endpoint.socket)
            socket = endpoint.socket;
    }
    catch {
        return;
    }
    const client = new ProtocolClient({ socketPath: socket, clientId: `service-migration-${process.pid}` });
    try {
        await client.connect();
        await client.command("daemon.shutdown", {});
    }
    catch {
        return;
    }
    finally {
        await client.close().catch(() => undefined);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            await readFile(paths.endpoint, "utf8");
        }
        catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The legacy daemon did not stop within 5 seconds; stop it manually and retry service installation");
}
//# sourceMappingURL=legacy-daemon.js.map