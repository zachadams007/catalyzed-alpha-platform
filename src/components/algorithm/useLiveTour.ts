import { useCallback, useEffect, useRef, useState } from "react";
import type Lenis from "lenis";
import { gsap, ScrollTrigger } from "@/viz/useStoryScroll";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * "Run it live" guided tour - the demo centerpiece.
 *
 * When the user launches a research run from the hero, the story drives itself
 * on a deterministic, well-paced cadence: the camera glides through every
 * chapter start→finish - hero → discovery → enrichment → scoring → ranking -
 * and LANDS on the real leaderboard. The pacing is scripted (not slaved to
 * exact stage timing) so fast stages never get skipped and slow ones never
 * stall it: the journey always completes.
 *
 * Because the leaderboard must show the ACTUAL stocks this run found, the tour
 * pauses just before the ranking beat until the run lands its signals (capped,
 * so an error or a slow run can never hang it). It then glides the live board
 * into view, holds, and hands control back.
 *
 * The user owns the wheel the whole time: any real wheel / touch / scroll-key
 * input cancels instantly - the camera never fights a human.
 */

interface Beat {
  id: string;
  /** Seconds to glide through this chapter's pinned scrub range. */
  glide: number;
}

/** Seconds for the hop from one chapter's end to the next chapter's start. */
const HOP_SECONDS = 0.85;
/** Max wait for the run's real signals before gliding the leaderboard. */
const SIGNALS_WAIT_CAP_MS = 7_000;
/** Beat to hold on the finished leaderboard before handing back control. */
const FINALE_HOLD_MS = 2_400;

const BEATS: Beat[] = [
  { id: "hero", glide: 2.2 },
  { id: "discovery", glide: 4.6 },
  { id: "enrichment", glide: 5.0 },
  { id: "scoring", glide: 5.0 },
  { id: "ranking", glide: 5.4 },
];

const SCROLL_KEYS = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"];

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export function useLiveTour(
  lenis: Lenis | null,
  scroller: HTMLElement | null,
  data: StoryData,
) {
  const [engaged, setEngaged] = useState(false);

  // Latest-value refs so the async sequence never reads a stale closure.
  const lenisRef = useRef(lenis);
  lenisRef.current = lenis;
  const dataRef = useRef(data);
  dataRef.current = data;

  const activeRef = useRef(false);
  const cancelledRef = useRef(false);
  const tweenRef = useRef<gsap.core.Tween | null>(null);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    activeRef.current = false;
    tweenRef.current?.kill();
    tweenRef.current = null;
    setEngaged(false);
  }, []);

  const start = useCallback(() => {
    const lenisNow = lenisRef.current;
    if (!lenisNow || activeRef.current) return;
    activeRef.current = true;
    cancelledRef.current = false;
    setEngaged(true);

    /** Glide the smooth-scroll position to `y` over `secs`, resolving on done. */
    const glideTo = (y: number, secs: number, ease = "none") =>
      new Promise<void>((resolve) => {
        const l = lenisRef.current;
        if (!l || cancelledRef.current) return resolve();
        tweenRef.current?.kill();
        const proxy = { y: l.scroll as number };
        tweenRef.current = gsap.to(proxy, {
          y,
          duration: secs,
          ease,
          onUpdate: () => lenisRef.current?.scrollTo(proxy.y, { immediate: true }),
          onComplete: () => resolve(),
        });
      });

    /** Hold (capped) until the run lands its real signals, so the board is real. */
    const waitForSignals = async () => {
      const begin = performance.now();
      while (
        !cancelledRef.current &&
        dataRef.current.isRunning &&
        performance.now() - begin < SIGNALS_WAIT_CAP_MS
      ) {
        await wait(150);
      }
    };

    const run = async () => {
      // Reset to the top so the journey always starts from the establishing shot.
      await glideTo(0, 0.6, "power2.inOut");

      for (const beat of BEATS) {
        if (cancelledRef.current) return;
        const el = document.getElementById(`algo-${beat.id}`);
        if (!el) continue;

        const st = ScrollTrigger.getAll().find((t) => t.trigger === el);
        const startY = st ? st.start : el.offsetTop;
        const endY = st ? Math.max(st.start, st.end - 8) : el.offsetTop + el.offsetHeight;

        // Hop to the chapter's pin start, then play it as a take.
        await glideTo(startY, HOP_SECONDS, "power2.inOut");
        if (cancelledRef.current) return;

        // The leaderboard must show this run's real names - let them land first.
        if (beat.id === "ranking") await waitForSignals();
        if (cancelledRef.current) return;

        await glideTo(endY, beat.glide, "none");
      }

      if (cancelledRef.current) return;
      // Landed on the real leaderboard - hold the finale, then release the wheel.
      await wait(FINALE_HOLD_MS);
      stop();
    };

    void run();
  }, [stop]);

  // Any human scroll input releases the camera (programmatic scrollTo never
  // dispatches these, so the tour's own glide won't cancel itself).
  useEffect(() => {
    if (!engaged || !scroller) return;
    const cancel = () => stop();
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.includes(e.key)) stop();
    };
    scroller.addEventListener("wheel", cancel, { passive: true });
    scroller.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      scroller.removeEventListener("wheel", cancel);
      scroller.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [engaged, scroller, stop]);

  // Safety: kill any in-flight tween on unmount.
  useEffect(
    () => () => {
      cancelledRef.current = true;
      tweenRef.current?.kill();
    },
    [],
  );

  return { engaged, start, stop };
}
