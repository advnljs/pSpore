import { createConnection } from "node:net";
/** Connect only when the native launcher has already drawn the startup card. */
export async function connectNativeStartup(onFocus, name = process.env["PSPORE_STARTUP_SOCKET"]) {
    if (process.platform !== "linux" || !name || !/^pspore-startup-\d+-[a-f0-9]{24}$/.test(name))
        return undefined;
    // The Linux abstract socket disappears with its owner; no stale lock/socket
    // files can prevent the next launch. The native peer validates UID and PID.
    return new Promise((resolve) => {
        const socket = createConnection({ path: `\0${name}` });
        let settled = false;
        let buffer = "";
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (!result)
                socket.destroy();
            resolve(result);
        };
        const send = (message) => {
            if (!socket.destroyed && socket.writable)
                socket.write(`${message}\n`);
        };
        const timeout = setTimeout(() => finish(undefined), 1_000);
        socket.setEncoding("utf8");
        socket.unref();
        socket.once("connect", () => send("HELLO"));
        socket.on("error", (error) => {
            process.stderr.write(`pSpore native startup: ${error.message}\n`);
            finish(undefined);
        });
        socket.once("close", () => finish(undefined));
        socket.on("data", (chunk) => {
            buffer += chunk;
            if (buffer.length > 1_024) {
                socket.destroy(new Error("Native startup message exceeds the protocol limit"));
                return;
            }
            let newline;
            while ((newline = buffer.indexOf("\n")) !== -1) {
                const message = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (message === "WELCOME") {
                    finish({
                        setMessage: async (text) => send(`STATUS ${text.replace(/[\r\n]/g, " ").slice(0, 240)}`),
                        close: () => send("HIDE"),
                    });
                }
                else if (message === "FOCUS" && settled) {
                    onFocus();
                }
            }
        });
    });
}
//# sourceMappingURL=native-startup.js.map