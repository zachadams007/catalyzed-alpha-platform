import { useLayoutEffect, useRef, useState } from "react";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";

gsap.registerPlugin(ScrollTrigger, MotionPathPlugin);

export { gsap, ScrollTrigger };

export interface StoryScroll {
  /** The element ScrollTriggers must use as `scroller`. */
  scroller: HTMLElement | null;
  /** Live lenis instance - scrollTo targets, stop/start for overlays. */
  lenis: Lenis | null;
}

/**
 * Smooth-scroll host for the Algorithm story.
 *
 * The app shell scrolls its own pane - `<main class="content">` (body is
 * overflow:hidden) - so lenis wraps that element and every ScrollTrigger must
 * pass it as `scroller`. Lenis animates native scrollTop, driven by the gsap
 * ticker so pins and scrubs update in the same frame (no jitter).
 *
 * Returns nulls until wired (or when disabled for reduced motion - callers
 * render the static fallback on null).
 */
export function useStoryScroll(enabled: boolean): StoryScroll {
  const [scroll, setScroll] = useState<StoryScroll>({ scroller: null, lenis: null });

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = document.querySelector<HTMLElement>("main.content");
    if (!el) return;
    const content = (el.firstElementChild as HTMLElement | null) ?? undefined;

    const lenis = new Lenis({
      wrapper: el,
      content,
      duration: 1.05,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    });
    lenis.on("scroll", ScrollTrigger.update);

    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // Start the story from the top (the pane persists across routes).
    el.scrollTop = 0;
    setScroll({ scroller: el, lenis });
    const refresh = requestAnimationFrame(() => ScrollTrigger.refresh());

    // Anything that resizes the pane content (e.g. the ResearchNarrator strip
    // mounting above the story when a run starts) invalidates pin positions.
    let resizeDebounce = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeDebounce);
      resizeDebounce = window.setTimeout(() => ScrollTrigger.refresh(), 120);
    });
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);

    return () => {
      cancelAnimationFrame(refresh);
      window.clearTimeout(resizeDebounce);
      ro.disconnect();
      gsap.ticker.remove(tick);
      // lagSmoothing(0) is global - restore gsap defaults for the rest of the app.
      gsap.ticker.lagSmoothing(500, 33);
      lenis.destroy();
      setScroll({ scroller: null, lenis: null });
    };
  }, [enabled]);

  return scroll;
}

/** Scoped element selector handed to scene builders. */
export type SceneSelector = (selectorText: string) => Element[];

export interface ScrubSceneOptions {
  /** Scroll distance the pin lasts, e.g. "+=160%". Default "+=170%". */
  end?: string;
  /** Scrub smoothing seconds. Default 0.65. */
  scrub?: number;
  pin?: boolean;
  onToggle?: (active: boolean) => void;
}

/**
 * Pin a scene section inside the story scroller and scrub a timeline through
 * it. The `build` callback receives the timeline and a scoped selector. Uses
 * gsap.context so StrictMode double-mounts and route changes clean up fully.
 *
 * Scenes are authored so their resting CSS/DOM state is the FINISHED state and
 * timelines animate `from()`/`fromTo()` - with no timeline (reduced motion /
 * scroller not ready) the scene renders complete and legible.
 *
 * `deps` is the scene's data identity: when live signals replace the sample
 * walkthrough (or keyed rows swap their DOM), the timeline is rebuilt so
 * tweens never target detached nodes or count to stale numbers.
 */
export function useScrubScene(
  scroller: HTMLElement | null,
  ref: React.RefObject<HTMLElement | null>,
  build: (tl: gsap.core.Timeline, q: SceneSelector) => void,
  options?: ScrubSceneOptions,
  deps: unknown[] = [],
): void {
  const buildRef = useRef(build);
  buildRef.current = build;
  const optsRef = useRef(options);
  optsRef.current = options;

  useLayoutEffect(() => {
    const root = ref.current;
    if (!scroller || !root) return;
    const opts = optsRef.current;

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        defaults: { ease: "power3.out" },
        scrollTrigger: {
          trigger: root,
          scroller,
          start: "top top",
          end: opts?.end ?? "+=170%",
          pin: opts?.pin ?? true,
          scrub: opts?.scrub ?? 0.65,
          anticipatePin: 1,
          onToggle: (self) => opts?.onToggle?.(self.isActive),
        },
      });
      buildRef.current(tl, gsap.utils.selector(root) as SceneSelector);
    }, root);
    const refresh = requestAnimationFrame(() => ScrollTrigger.refresh());

    return () => {
      cancelAnimationFrame(refresh);
      ctx.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, ref, ...deps]);
}
