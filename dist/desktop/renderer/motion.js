/// <reference lib="DOM" />
const engine = window.gsap;
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
export const EASE_OUT = "expo.out";
export const EASE_SOFT = "power3.out";
function canAnimate() {
    return Boolean(engine) && !reducedQuery.matches;
}
/**
 * Everything below is progressive enhancement: when the vendored engine is
 * missing or the user prefers reduced motion each helper resolves instantly so
 * the UI never depends on animation to become visible or interactive.
 */
function set(target, vars) {
    if (!engine || !target)
        return;
    engine.set(target, vars);
}
export function introChoreography(topbar, panels) {
    if (!canAnimate())
        return;
    const timeline = engine.timeline({ defaults: { ease: EASE_OUT } });
    timeline
        .fromTo(topbar, { autoAlpha: 0, y: -10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 0)
        .fromTo(panels[0] ?? [], { autoAlpha: 0, x: -14 }, { autoAlpha: 1, x: 0, duration: 0.55 }, 0.08)
        .fromTo(panels[1] ?? [], { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.55 }, 0.14)
        .fromTo(panels[2] ?? [], { autoAlpha: 0, x: 14 }, { autoAlpha: 1, x: 0, duration: 0.55 }, 0.2);
}
export function animateMessagesIn(targets, staggered) {
    if (!canAnimate() || targets.length === 0)
        return;
    set(targets, { willChange: "transform, opacity" });
    engine.fromTo(targets, { autoAlpha: 0, y: staggered ? 18 : 12 }, {
        autoAlpha: 1,
        y: 0,
        duration: staggered ? 0.5 : 0.38,
        stagger: staggered ? 0.05 : 0,
        ease: EASE_SOFT,
        clearProps: "willChange",
    });
}
export function animateTranscriptHero(target) {
    if (!canAnimate() || !target)
        return;
    const children = Array.from(target.children);
    engine.fromTo(children.length ? children : target, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.55, stagger: 0.07, ease: EASE_OUT, delay: 0.15 });
}
export function showOverlayMotion(overlay, dialog) {
    if (!canAnimate())
        return;
    engine.fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.26, ease: EASE_SOFT });
    engine.fromTo(dialog, { autoAlpha: 0, y: 18, scale: 0.965 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.38, ease: EASE_OUT });
}
/** Animates the overlay out, then invokes `finish` to flip `hidden`. */
export function hideOverlayMotion(overlay, dialog, finish) {
    if (!canAnimate()) {
        finish();
        return;
    }
    engine.to(dialog, { autoAlpha: 0, y: 12, duration: 0.2, ease: "power2.in" });
    engine.to(overlay, {
        autoAlpha: 0,
        duration: 0.24,
        ease: "power2.in",
        onComplete: () => {
            engine.set([overlay, dialog], { clearProps: "all" });
            finish();
        },
    });
}
export function pulseStatus(target) {
    if (!canAnimate() || !target)
        return;
    engine.fromTo(target, { scale: 0.9 }, { scale: 1, duration: 0.45, ease: "elastic.out(1, 0.6)", overwrite: "auto" });
}
export function nudgeElement(target) {
    if (!canAnimate() || !target)
        return;
    engine.fromTo(target, { scale: 0.94 }, { scale: 1, duration: 0.32, ease: EASE_OUT, overwrite: "auto", transformOrigin: "50% 60%" });
}
//# sourceMappingURL=motion.js.map