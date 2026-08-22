export declare const EASE_OUT = "expo.out";
export declare const EASE_SOFT = "power3.out";
export declare function introChoreography(topbar: HTMLElement, panels: HTMLElement[]): void;
export declare function animateMessagesIn(targets: Element[], staggered: boolean): void;
export declare function animateTranscriptHero(target: Element | null): void;
export declare function showOverlayMotion(overlay: HTMLElement, dialog: HTMLElement): void;
/** Animates the overlay out, then invokes `finish` to flip `hidden`. */
export declare function hideOverlayMotion(overlay: HTMLElement, dialog: HTMLElement, finish: () => void): void;
export declare function pulseStatus(target: Element | null): void;
export declare function nudgeElement(target: HTMLElement | null): void;
//# sourceMappingURL=motion.d.ts.map