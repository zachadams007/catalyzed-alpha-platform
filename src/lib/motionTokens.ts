/**
 * Shared motion vocabulary for JS-driven animation (motion/react + gsap).
 * Mirrors the CSS motion tokens in `src/styles/tokens.css` - keep the two in
 * sync so CSS transitions and JS springs feel like one system.
 */

export const motionTokens = {
  /** Seconds (motion/gsap take seconds; CSS tokens are ms). */
  duration: {
    fast: 0.16, // --motion-fast
    base: 0.24, // --motion-base
    slow: 0.38, // --motion-slow
    crawl: 0.9, // long reveals / counters
  },
  easing: {
    /** cubic-bezier(0.22, 1, 0.36, 1) - matches --ease-out. */
    out: [0.22, 1, 0.36, 1] as [number, number, number, number],
    gsapOut: "power3.out",
    gsapInOut: "power2.inOut",
  },
  stagger: {
    tight: 0.045, // --motion-stagger
    base: 0.06,
    loose: 0.09,
  },
  distance: { sm: 8, md: 14, lg: 24, xl: 40 },
  scale: { press: 0.97, pop: 1.03 },
} as const;

/** Spring presets for motion/react transitions. */
export const springs = {
  snappy: { type: "spring", stiffness: 480, damping: 34, mass: 0.7 },
  gentle: { type: "spring", stiffness: 220, damping: 28, mass: 1 },
  /** For useSpring cursor-followers (no `type` key needed). */
  cursor: { stiffness: 260, damping: 26, mass: 0.6 },
} as const;
