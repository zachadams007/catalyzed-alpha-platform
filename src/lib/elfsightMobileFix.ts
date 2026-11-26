/**
 * Elfsight AI Chatbot - mobile layout fixes injected INTO the widget's shadow DOM.
 *
 * The Elfsight chatbot renders inside Shadow DOM with hashed styled-components
 * classes, so our normal app CSS physically cannot reach it. But the shadow roots
 * are OPEN, and Elfsight keeps a small set of STABLE `.es-*` classes (the exact ones
 * their dashboard "Custom CSS" field targets). So we inject a <style> using those
 * stable selectors into each Elfsight shadow root - the same effect as their Custom
 * CSS field, but owned + deployed by us instead of a dashboard toggle.
 *
 * Mobile only (`@media max-width: 768px`) so the desktop app is untouched. Fixes:
 *   1. Lift the floating launcher ABOVE our bottom tab bar + the iPhone home bar
 *      (it was sitting on top of the "More" tab).
 *   2. Turn the open chat from FULL-SCREEN into a bottom sheet (top ~24% of the
 *      screen stays visible) so its close (X) button is reachable and never lands
 *      in the iPhone top-right Control-Center hot corner - the same safe-zone lesson
 *      as the sign-in buttons.
 */

const STYLE_ID = "catalyzed-elfsight-mobile-fix";

const CSS = `
@media (max-width: 768px) {
  /* Lift the WHOLE launcher (button + its glow ring) up into the strip just above
     the bottom nav, and shrink it a touch. A single transform on the floating
     wrapper moves every part together — so the glow can't get left behind at the
     old spot (the bug from setting 'bottom' on inner elements separately). */
  /* Move the WHOLE fixed launcher wrapper up clear of the bottom nav.
     Verified against the LIVE shadow DOM: the blue button is
     .es-bubble-floating-button, but its FIXED positioning wrapper is a
     styled-components element [class*="FloatingButton__FloatingButton"] pinned at
     bottom-right. Moving only the inner button (as before) left this 64x64
     pointer-events wrapper behind ON TOP of the "More" tab — that's what blocked the
     tap and read as a leftover "ring". Move the WRAPPER so the button + its tap
     target lift together, and clear the inner button's own transform so it doesn't
     double-shift. */
  [class*="FloatingButton__FloatingButton"] {
    transform: translateY(-82px) scale(0.9) !important;
    transform-origin: bottom right !important;
  }
  .es-bubble-floating-button {
    transform: none !important;
  }
  /* Open chat = ~58% bottom sheet (was ~76%): leave the top ~42% of the app
     visible, with the close (X) reachable and well clear of the iPhone top-right
     Control-Center hot corner. */
  .es-window-container {
    position: fixed !important;
    inset: 42% 0 0 0 !important;
    width: 100% !important;
    height: auto !important;
    max-height: none !important;
    border-top-left-radius: 20px !important;
    border-top-right-radius: 20px !important;
    overflow: hidden !important;
  }
}
`;

function injectInto(root: ShadowRoot): void {
  // Only inject where Elfsight elements actually live, and never twice.
  if (root.querySelector(`#${STYLE_ID}`)) return;
  if (!root.querySelector('[class*="es-"]')) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  root.appendChild(style);
}

function walkShadows(node: ParentNode): void {
  const els = node.querySelectorAll?.("*");
  if (!els) return;
  els.forEach((el) => {
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) {
      injectInto(sr);
      walkShadows(sr);
    }
  });
}

/**
 * Watch for the Elfsight widget mounting (it loads async + may re-render) and keep
 * the override style present in its shadow roots. No-op until the widget appears.
 */
export function initElfsightMobileFix(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const run = () => walkShadows(document.body);

  // Throttle: a naive "walk the whole DOM on every mutation" pegs the CPU on a
  // data-heavy, frequently-updating feed. Coalesce bursts to at most ~3 walks/sec.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      run();
    }, 300);
  };

  run();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  // Safety net for the async CDN boot: re-run every 2s for the first minute, then
  // rely on the observer alone (and stop the interval to stay cheap).
  let ticks = 0;
  const interval = window.setInterval(() => {
    run();
    if (++ticks >= 30) window.clearInterval(interval);
  }, 2000);
}
