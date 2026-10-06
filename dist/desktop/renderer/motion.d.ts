export declare const EASE_OUT = "expo.out";
export declare const EASE_SOFT = "power3.out";
export declare const EASE_IN = "power2.in";
export declare function introChoreography(topbar: HTMLElement, panels: HTMLElement[]): void;
export declare function animateMessagesIn(targets: Element[], staggered: boolean): void;
export declare function animateTranscriptHero(target: Element | null): void;
export declare function showOverlayMotion(overlay: HTMLElement, dialog: HTMLElement): void;
/** Animates the overlay out, then invokes `finish` to flip `hidden`. */
export declare function hideOverlayMotion(overlay: HTMLElement, dialog: HTMLElement, finish: () => void): void;
export declare function pulseStatus(target: Element | null): void;
export declare function nudgeElement(target: HTMLElement | null): void;
/**
 * A slow breathe while a reconnect is being masked. The badge keeps saying
 * ONLINE, so this is the only hint that the socket is re-establishing — far
 * calmer than flipping the badge to OFFLINE and back during a long run.
 */
export declare function setReconnectingPulse(target: Element | null, active: boolean): void;
/**
 * Tweens a metric to its new value instead of snapping. `element.dataset.value`
 * carries the last rendered number so repeated renders with the same value are
 * free and an interrupted tween resumes from where it stopped.
 */
export declare function tweenMetric(element: HTMLElement | null, value: number, format: (value: number) => string): void;
/** Staggers freshly replaced list rows in, capped so long lists stay snappy. */
export declare function revealListItems(nodes: readonly Element[], options?: {
    distance?: number;
    maxStagger?: number;
}): void;
/** Cross-fades an inspector tab panel that has just become visible. */
export declare function revealPanel(target: HTMLElement | null): void;
/**
 * Slides the offline banner instead of toggling a class, so a masked reconnect
 * that never reaches the banner leaves no visual trace at all.
 */
export declare function toggleBannerMotion(banner: HTMLElement | null, visible: boolean): void;
/** Pops a newly added chip (composer file reference) into place. */
export declare function popChips(nodes: readonly Element[]): void;
/** Marks a status chip changing state without redrawing the whole header. */
export declare function flipStatusChip(target: HTMLElement | null): void;
/** Cross-fades the single-line status text when its content changes. */
export declare function crossfadeText(target: HTMLElement | null, value: string): void;
/** Stops a width animation where it is; its finish callback never runs. */
export interface WidthAnimation {
    kill(): void;
}
/**
 * Moves the width the document column is laid out at.
 *
 * Opening and closing change the shape of the workspace, so the conversation
 * has to give the width up and take it back rather than jump: the panel used to
 * fade in over a column that had already appeared at full size. The caller keeps
 * the handle and kills it before starting another, so an open that follows a
 * close (or a session switch) never has two tweens writing the same width.
 */
export declare function animateArticleWidth(from: number, to: number, apply: (width: number) => void, finish?: () => void): WidthAnimation;
/** New blocks in a version. Capped by the caller so a whole first draft does not stagger for seconds. */
/**
 * Folds blocks that a new version dropped out of the flow, then hands them back
 * so the caller can detach them.
 *
 * The panel patches the version it already has on screen rather than redrawing
 * it, so a removed paragraph is the one thing that would otherwise vanish
 * between two frames with nothing to show what happened.
 */
export declare function collapseArticleRemovals(targets: readonly HTMLElement[], finish: () => void): void;
export declare function pulseArticleChanges(targets: readonly Element[]): void;
//# sourceMappingURL=motion.d.ts.map