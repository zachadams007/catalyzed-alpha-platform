/**
 * Feed-card motion: scroll-reveal for below-fold cards. One shared
 * IntersectionObserver for the whole feed; cards already on screen at mount
 * keep the CSS stagger (`cardDock` + inline delay) and are never hidden, so
 * there is no flash of invisible content. (The old cursor-following spotlight
 * was removed - hover is now the CSS status-rail ignition, no JS needed.)
 */
import { useLayoutEffect, useRef } from "react";

let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            // Revealed cards drop their mount stagger: the inline delay would
            // otherwise beat the sc-in shorthand and hold the card (and its
            // rail, which inherits the delay) blank at the bottom of the view.
            (e.target as HTMLElement).style.animationDelay = "0s";
            e.target.classList.remove("sc-wait");
            e.target.classList.add("sc-in");
            observer?.unobserve(e.target);
          }
        }
      },
      {
        // Root at the app's scroll pane, not the viewport: IO clips targets by
        // scrollable ancestors, so a viewport-rooted observer can never see a
        // card that scrolled past inside main.content. With the pane as root,
        // the huge top margin covers fast jumps (End key, flick) that move a
        // card from below to above the visible area without ever intersecting
        // - skipped cards reveal instead of staying hidden forever.
        root: document.querySelector("main.content"),
        rootMargin: "10000px 0px -8% 0px",
        threshold: 0.05,
      }
    );
  }
  return observer;
}

const reducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function useCardMotion<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion) return;
    // Only cards that start below the viewport wait for the scroll reveal.
    if (el.getBoundingClientRect().top > window.innerHeight) {
      el.classList.add("sc-wait");
      const obs = getObserver();
      obs.observe(el);
      return () => obs.unobserve(el);
    }
  }, []);

  return { ref };
}
