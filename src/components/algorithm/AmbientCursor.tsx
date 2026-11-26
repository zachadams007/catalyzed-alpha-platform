import { useEffect } from "react";
import { gsap } from "@/viz/useStoryScroll";

/**
 * Ambient cursor layer for the Algorithm story.
 *
 * One reaction to pointer movement, compositor-only: parallax drift - the
 * sticky `.algo-ambient` backdrop (and its deeper starfield layer)
 * counter-drifts a few px against the cursor via CSS vars, so the whole scene
 * feels dimensional.
 *
 * (A cursor-following glow used to live here too - removed: a viewport-sized
 * blend layer chasing the pointer read as a glitchy spotlight.)
 *
 * Values are lerped on the gsap ticker (the same clock as the scroll scrub)
 * so drift never fights the pin/scrub style writes.
 */
export function AmbientCursor({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!window.matchMedia("(hover: hover)").matches) return;

    // Targets (set by mousemove) and currents (lerped on tick).
    let tnx = 0, tny = 0;
    let nx = 0, ny = 0;

    const onMove = (e: MouseEvent) => {
      tnx = e.clientX / window.innerWidth - 0.5;
      tny = e.clientY / window.innerHeight - 0.5;
    };
    const onLeave = () => {
      tnx = 0;
      tny = 0;
    };

    const tick = () => {
      nx += (tnx - nx) * 0.06;
      ny += (tny - ny) * 0.06;
      root.style.setProperty("--amb-nx", nx.toFixed(4));
      root.style.setProperty("--amb-ny", ny.toFixed(4));
    };

    root.addEventListener("mousemove", onMove, { passive: true });
    root.addEventListener("mouseleave", onLeave);
    gsap.ticker.add(tick);

    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
      gsap.ticker.remove(tick);
      root.style.removeProperty("--amb-nx");
      root.style.removeProperty("--amb-ny");
    };
  }, [rootRef]);

  return null;
}
