import { type Component, type Focusable } from "@earendil-works/pi-tui";
import type { TuiStoreSnapshot } from "./store.js";
export interface TuiViewOptions {
    state: () => TuiStoreSnapshot;
    height: () => number;
    requestRender: () => void;
    onSubmit: (input: string) => void;
    onInterrupt: () => void;
    onBack: () => void;
    /** Asked for when the reader scrolls past the oldest loaded message. */
    onScrollBack?: () => void;
}
export interface TuiRenderOptions {
    scrollOffset?: number;
    promptLabel?: string;
    secretInput?: boolean;
    color?: boolean;
    animationFrame?: number;
    /**
     * Called when the requested window reaches past every message loaded, which
     * is the only moment older history is worth fetching.
     */
    onHistoryExhausted?: () => void;
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
/**
 * The character an xterm-style `CSI 27 ; modifiers ; codepoint ~` key carries.
 * Pi's TUI falls back to this modifyOtherKeys mode on terminals without the
 * Kitty keyboard protocol (xterm among them), where Shift+letter arrives in
 * this form; its Input only decodes the Kitty form, so every capital letter
 * typed in xterm was dropped. Only Shift and the lock keys may be held, as in
 * Pi's own decoder: anything with Ctrl or Alt stays a shortcut.
 */
export declare function modifyOtherKeysPrintable(data: string): string | undefined;
//# sourceMappingURL=view.d.ts.map