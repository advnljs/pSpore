import type { BrowserWindow } from "electron";
export declare function captureRendererDiagnostics(target: BrowserWindow): void;
export declare function waitForRenderer(target: BrowserWindow, expression: string, timeoutMs: number): Promise<void>;
export declare function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void>;
//# sourceMappingURL=renderer-diagnostics.d.ts.map