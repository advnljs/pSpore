export interface SessionSearchOptions {
    bar: HTMLElement;
    input: HTMLInputElement;
    count: HTMLElement;
    button: HTMLButtonElement;
    previous: HTMLButtonElement;
    next: HTMLButtonElement;
    close: HTMLButtonElement;
    transcript: HTMLElement;
    requestRender: () => void;
    getTexts: () => readonly string[];
    getSessionId: () => string;
    getOffset: (index: number) => number;
    setFollowTail: (value: boolean) => void;
    setPinnedIndex: (index: number | undefined) => void;
    forEachMessage: (visit: (node: HTMLElement) => void) => void;
    isModalOpen: () => boolean;
}
export interface SessionSearchController {
    /** Apply a pending jump before the virtual window is chosen. */
    prepare(sessionChanged: boolean): void;
    /** Highlight the visible messages after they have been reconciled. */
    paint(): void;
}
/**
 * Find bar for the open session. Matches come from the transcript texts, not
 * the virtualized DOM, so a hit that is scrolled out of view can still be jumped to.
 */
export declare function createSessionSearch(options: SessionSearchOptions): SessionSearchController;
//# sourceMappingURL=session-search.d.ts.map