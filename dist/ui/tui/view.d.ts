import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { TuiStoreSnapshot } from "./store.js";
export interface TuiViewOptions {
    state: () => TuiStoreSnapshot;
    height: () => number;
    requestRender: () => void;
    onSubmit: (input: string) => void;
    onInterrupt: () => void;
    onBack: () => void;
}
export interface TuiRenderOptions {
    scrollOffset?: number;
    promptLabel?: string;
    secretInput?: boolean;
    color?: boolean;
    animationFrame?: number;
}
export declare class PsporeTuiView implements Component, Focusable {
    #private;
    focused: boolean;
    constructor(options: TuiViewOptions);
    render(width: number): string[];
    handleInput(data: string): void;
    requestValue(label: string, options?: {
        secret?: boolean;
    }): Promise<string | undefined>;
    invalidate(): void;
    dispose(): void;
}
export declare function renderTuiSnapshot(state: TuiStoreSnapshot, width?: number, height?: number, input?: string, options?: TuiRenderOptions): string[];
export declare function maskSecretInput(value: string, width: number): string;
//# sourceMappingURL=view.d.ts.map