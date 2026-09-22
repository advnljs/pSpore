/// <reference lib="DOM" />

import type { gsap } from "gsap";

type Gsap = typeof gsap;
type TweenVars = Parameters<Gsap["set"]>[1];
type Tween = ReturnType<Gsap["to"]>;

const engine: Gsap | undefined = (window as unknown as { gsap?: Gsap }).gsap;
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

export const EASE_OUT = "expo.out";
export const EASE_SOFT = "power3.out";
export const EASE_IN = "power2.in";

function canAnimate(): boolean {
  return Boolean(engine) && !reducedQuery.matches;
}

/**
 * Everything below is progressive enhancement: when the vendored engine is
 * missing or the user prefers reduced motion each helper resolves instantly so
 * the UI never depends on animation to become visible or interactive.
 */

function set(target: Element | Element[] | null, vars: TweenVars): void {
  if (!engine || !target) return;
  engine.set(target, vars);
}

export function introChoreography(topbar: HTMLElement, panels: HTMLElement[]): void {
  if (!canAnimate()) return;
  const timeline = engine!.timeline({ defaults: { ease: EASE_OUT } });
  timeline
    .fromTo(topbar, { autoAlpha: 0, y: -10 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 0)
    .fromTo(panels[0] ?? [], { autoAlpha: 0, x: -14 }, { autoAlpha: 1, x: 0, duration: 0.55 }, 0.08)
    .fromTo(panels[1] ?? [], { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.55 }, 0.14)
    .fromTo(panels[2] ?? [], { autoAlpha: 0, x: 14 }, { autoAlpha: 1, x: 0, duration: 0.55 }, 0.2);
}

export function animateMessagesIn(targets: Element[], staggered: boolean): void {
  if (!canAnimate() || targets.length === 0) return;
  set(targets, { willChange: "transform, opacity" });
  engine!.fromTo(
    targets,
    { autoAlpha: 0, y: staggered ? 18 : 12 },
    {
      autoAlpha: 1,
      y: 0,
      duration: staggered ? 0.5 : 0.38,
      stagger: staggered ? 0.05 : 0,
      ease: EASE_SOFT,
      clearProps: "willChange",
    },
  );
}

export function animateTranscriptHero(target: Element | null): void {
  if (!canAnimate() || !target) return;
  const children = Array.from(target.children);
  engine!.fromTo(
    children.length ? children : target,
    { autoAlpha: 0, y: 16 },
    { autoAlpha: 1, y: 0, duration: 0.55, stagger: 0.07, ease: EASE_OUT, delay: 0.15 },
  );
}

export function showOverlayMotion(overlay: HTMLElement, dialog: HTMLElement): void {
  if (!canAnimate()) return;
  engine!.fromTo(
    overlay,
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: 0.26, ease: EASE_SOFT },
  );
  engine!.fromTo(
    dialog,
    { autoAlpha: 0, y: 18, scale: 0.965 },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.38, ease: EASE_OUT },
  );
}

/** Animates the overlay out, then invokes `finish` to flip `hidden`. */
export function hideOverlayMotion(overlay: HTMLElement, dialog: HTMLElement, finish: () => void): void {
  if (!canAnimate()) {
    finish();
    return;
  }
  engine!.to(dialog, { autoAlpha: 0, y: 12, duration: 0.2, ease: EASE_IN });
  engine!.to(overlay, {
    autoAlpha: 0,
    duration: 0.24,
    ease: EASE_IN,
    onComplete: () => {
      engine!.set([overlay, dialog], { clearProps: "all" });
      finish();
    },
  });
}

export function pulseStatus(target: Element | null): void {
  if (!canAnimate() || !target) return;
  engine!.fromTo(
    target,
    { scale: 0.9 },
    { scale: 1, duration: 0.45, ease: "elastic.out(1, 0.6)", overwrite: "auto" },
  );
}

export function nudgeElement(target: HTMLElement | null): void {
  if (!canAnimate() || !target) return;
  engine!.fromTo(
    target,
    { scale: 0.94 },
    { scale: 1, duration: 0.32, ease: EASE_OUT, overwrite: "auto", transformOrigin: "50% 60%" },
  );
}

const loops = new WeakMap<Element, Tween>();

/**
 * A slow breathe while a reconnect is being masked. The badge keeps saying
 * ONLINE, so this is the only hint that the socket is re-establishing — far
 * calmer than flipping the badge to OFFLINE and back during a long run.
 */
export function setReconnectingPulse(target: Element | null, active: boolean): void {
  if (!target) return;
  const running = loops.get(target);
  if (!active) {
    if (running) {
      running.kill();
      loops.delete(target);
      engine?.set(target, { clearProps: "opacity" });
    }
    return;
  }
  if (running || !canAnimate()) return;
  loops.set(
    target,
    engine!.to(target, {
      opacity: 0.55,
      duration: 0.85,
      ease: "sine.inOut",
      repeat: -1,
      yoyo: true,
    }),
  );
}

/**
 * Tweens a metric to its new value instead of snapping. `element.dataset.value`
 * carries the last rendered number so repeated renders with the same value are
 * free and an interrupted tween resumes from where it stopped.
 */
export function tweenMetric(element: HTMLElement | null, value: number, format: (value: number) => string): void {
  if (!element) return;
  const previous = Number(element.dataset["metric"] ?? Number.NaN);
  element.dataset["metric"] = String(value);
  if (!canAnimate() || !Number.isFinite(previous) || previous === value) {
    element.textContent = format(value);
    return;
  }
  const counter = { value: previous };
  engine!.to(counter, {
    value,
    duration: 0.5,
    ease: EASE_SOFT,
    overwrite: "auto",
    onUpdate: () => {
      element.textContent = format(Math.round(counter.value));
    },
    onComplete: () => {
      element.textContent = format(value);
    },
  });
}

/** Staggers freshly replaced list rows in, capped so long lists stay snappy. */
export function revealListItems(nodes: readonly Element[], options: { distance?: number; maxStagger?: number } = {}): void {
  if (!canAnimate() || nodes.length === 0) return;
  const distance = options.distance ?? 8;
  const limit = options.maxStagger ?? 12;
  const staggered = nodes.slice(0, limit);
  engine!.fromTo(
    staggered,
    { autoAlpha: 0, y: distance },
    { autoAlpha: 1, y: 0, duration: 0.34, stagger: 0.028, ease: EASE_SOFT, clearProps: "transform,opacity,visibility" },
  );
  const rest = nodes.slice(limit);
  if (rest.length > 0) {
    engine!.fromTo(
      rest,
      { autoAlpha: 0 },
      { autoAlpha: 1, duration: 0.24, ease: EASE_SOFT, delay: 0.1, clearProps: "opacity,visibility" },
    );
  }
}

/** Cross-fades an inspector tab panel that has just become visible. */
export function revealPanel(target: HTMLElement | null): void {
  if (!canAnimate() || !target) return;
  engine!.fromTo(
    target,
    { autoAlpha: 0, y: 10 },
    { autoAlpha: 1, y: 0, duration: 0.3, ease: EASE_SOFT, overwrite: "auto", clearProps: "transform,opacity,visibility" },
  );
}

/**
 * Slides the offline banner instead of toggling a class, so a masked reconnect
 * that never reaches the banner leaves no visual trace at all.
 */
export function toggleBannerMotion(banner: HTMLElement | null, visible: boolean): void {
  if (!banner) return;
  const wasVisible = banner.dataset["shown"] === "true";
  if (wasVisible === visible) return;
  banner.dataset["shown"] = String(visible);
  if (!canAnimate()) {
    banner.classList.toggle("visible", visible);
    return;
  }
  if (visible) {
    banner.classList.add("visible");
    engine!.fromTo(
      banner,
      { autoAlpha: 0, y: -8 },
      { autoAlpha: 1, y: 0, duration: 0.3, ease: EASE_OUT, overwrite: "auto" },
    );
    return;
  }
  engine!.to(banner, {
    autoAlpha: 0,
    y: -8,
    duration: 0.24,
    ease: EASE_IN,
    overwrite: "auto",
    onComplete: () => {
      banner.classList.remove("visible");
      engine!.set(banner, { clearProps: "all" });
    },
  });
}

/** Pops a newly added chip (composer file reference) into place. */
export function popChips(nodes: readonly Element[]): void {
  if (!canAnimate() || nodes.length === 0) return;
  engine!.fromTo(
    nodes,
    { autoAlpha: 0, scale: 0.86 },
    {
      autoAlpha: 1,
      scale: 1,
      duration: 0.3,
      stagger: 0.035,
      ease: "back.out(2)",
      clearProps: "transform,opacity,visibility",
    },
  );
}

/** Marks a status chip changing state without redrawing the whole header. */
export function flipStatusChip(target: HTMLElement | null): void {
  if (!canAnimate() || !target) return;
  engine!.fromTo(
    target,
    { autoAlpha: 0.35, y: -4 },
    { autoAlpha: 1, y: 0, duration: 0.34, ease: EASE_OUT, overwrite: "auto", clearProps: "transform,opacity,visibility" },
  );
}

/** Cross-fades the single-line status text when its content changes. */
export function crossfadeText(target: HTMLElement | null, value: string): void {
  if (!target) return;
  if (target.textContent === value) return;
  if (!canAnimate()) {
    target.textContent = value;
    return;
  }
  engine!.to(target, {
    autoAlpha: 0,
    duration: 0.12,
    ease: EASE_IN,
    overwrite: "auto",
    onComplete: () => {
      target.textContent = value;
      engine!.to(target, { autoAlpha: 1, duration: 0.2, ease: EASE_SOFT, clearProps: "opacity,visibility" });
    },
  });
}

/** Slides the article panel in from the right. Layout is already final; only opacity and position move. */
export function slideArticlePanel(panel: HTMLElement): void {
  if (!canAnimate()) return;
  engine!.fromTo(
    panel,
    { autoAlpha: 0, x: 28 },
    { autoAlpha: 1, x: 0, duration: 0.42, ease: EASE_OUT, overwrite: "auto", clearProps: "transform,opacity,visibility" },
  );
}

/** New blocks in a version. Capped by the caller so a whole first draft does not stagger for seconds. */
export function pulseArticleChanges(targets: readonly Element[]): void {
  if (!canAnimate() || targets.length === 0) return;
  engine!.fromTo(
    targets,
    { autoAlpha: 0.2, y: 12 },
    {
      autoAlpha: 1,
      y: 0,
      duration: 0.46,
      stagger: 0.045,
      ease: EASE_SOFT,
      overwrite: "auto",
      clearProps: "transform,opacity,visibility",
    },
  );
}
