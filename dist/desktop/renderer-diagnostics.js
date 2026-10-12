/**
 * Renderer-side failures otherwise surface only as a bare wait timeout, which
 * says nothing about the cause. Buffering console output and load failures lets
 * a timeout report what the renderer actually did.
 */
const rendererDiagnostics = [];
export function captureRendererDiagnostics(target) {
    const record = (line) => {
        rendererDiagnostics.push(line);
        // Keep the buffer bounded; the earliest lines explain a failed startup.
        if (rendererDiagnostics.length > 200)
            rendererDiagnostics.shift();
    };
    target.webContents.on("console-message", (_event, level, message, line, source) => {
        record(`console[${level}] ${message} (${source}:${line})`);
    });
    target.webContents.on("did-fail-load", (_event, code, description) => {
        record(`did-fail-load ${code} ${description}`);
    });
    target.webContents.on("preload-error", (_event, preload, error) => {
        record(`preload-error ${preload}: ${error.message}`);
    });
    target.webContents.on("render-process-gone", (_event, details) => {
        record(`render-process-gone ${details.reason} exit=${String(details.exitCode)}`);
    });
}
export async function waitForRenderer(target, expression, timeoutMs) {
    try {
        await waitFor(async () => Boolean(await target.webContents.executeJavaScript(expression)), timeoutMs);
    }
    catch (error) {
        const detail = rendererDiagnostics.length > 0
            ? `\nRenderer diagnostics:\n  ${rendererDiagnostics.join("\n  ")}`
            : "\nRenderer diagnostics: none captured";
        throw new Error(`${error instanceof Error ? error.message : String(error)} while waiting for: ${expression}${detail}`);
    }
}
export async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate())
            return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out after ${timeoutMs}ms`);
}
//# sourceMappingURL=renderer-diagnostics.js.map