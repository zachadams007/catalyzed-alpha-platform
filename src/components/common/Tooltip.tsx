import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /** Rich content shown in the bubble. Keep it short - one or two lines. */
  content: ReactNode;
  /** The trigger. A single focusable element (button, link, span tabIndex=0). */
  children: ReactElement;
  /** Preferred bubble side relative to the trigger; flips if there's no room. */
  placement?: "top" | "bottom";
  /** Extra class on the inline anchor wrapper. */
  className?: string;
}

/** Gap between trigger and bubble, and min distance from the viewport edge. */
const GAP = 9;
const MARGIN = 10;
/** Touch tuning: how long a finger must hold to reveal the tooltip on mobile
 *  (the equivalent of a desktop hover), how far it may drift before it counts as
 *  a scroll instead, and how long the bubble lingers before auto-dismissing. */
const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 10;
const TOUCH_AUTO_CLOSE_MS = 3600;
/** Ignore the emulated mouseenter that fires right after a touch, so a normal TAP
 *  triggers the control (not the tooltip) and only a real hover opens on hover. */
const EMULATED_HOVER_GUARD_MS = 700;

interface BubblePos {
  left: number;
  top: number;
  /** Arrow offset from the bubble's left edge, so it keeps pointing at the trigger. */
  arrow: number;
  side: "top" | "bottom";
}

/**
 * Accessible hover/focus tooltip.
 *
 * The bubble is rendered in a PORTAL to <body> and positioned with fixed
 * coordinates computed from the trigger's rect - so NO ancestor's
 * `overflow: hidden` / scroll container can ever clip it (the old in-place
 * absolute bubble got sliced whenever a trigger sat near a tile edge). It also
 * clamps to the viewport and flips top/bottom when there isn't room.
 *
 * - Opens on pointer hover and on keyboard focus (focus-within), fully keyboard
 *   reachable. Dismisses on Escape without losing focus.
 * - Wires `aria-describedby` (by id) onto the trigger while open; the portaled
 *   bubble carries `role="tooltip"`, and id references resolve across the portal.
 */
export function Tooltip({ content, children, placement = "top", className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<BubblePos | null>(null);
  // Touch long-press state. Refs (not state) so the timers/flags don't trigger
  // re-renders; the only state change is setOpen.
  const pressTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const openedByTouch = useRef(false);
  const lastTouchAt = useRef(0);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const t = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Horizontal: center on the trigger, then clamp into the viewport.
    const centerX = t.left + t.width / 2;
    const left = Math.max(MARGIN, Math.min(centerX - b.width / 2, vw - b.width - MARGIN));

    // Vertical: prefer the requested side, flip if it would overflow.
    const topRoom = t.top;
    const bottomRoom = vh - t.bottom;
    let side = placement;
    if (side === "top" && topRoom < b.height + GAP + MARGIN && bottomRoom > topRoom) side = "bottom";
    else if (side === "bottom" && bottomRoom < b.height + GAP + MARGIN && topRoom > bottomRoom) side = "top";
    const top = side === "top" ? t.top - b.height - GAP : t.bottom + GAP;

    // Arrow tracks the trigger center even after the bubble is clamped.
    const arrow = Math.max(12, Math.min(centerX - left, b.width - 12));
    setPos({ left, top, arrow, side });
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
    const onScrollOrResize = () => reposition();
    // Capture phase catches scrolls in any nested scroller (the cockpit board).
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, reposition]);

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  // --- Touch long-press (mobile equivalent of desktop hover) ---------------
  const clearPressTimer = useCallback(() => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (e: ReactTouchEvent<HTMLSpanElement>) => {
      lastTouchAt.current = Date.now();
      if (e.touches.length !== 1) return;
      const t = e.touches[0]!;
      touchStart.current = { x: t.clientX, y: t.clientY };
      clearPressTimer();
      // Hold past the threshold → reveal the tooltip (like a hover).
      pressTimer.current = window.setTimeout(() => {
        openedByTouch.current = true;
        setOpen(true);
      }, LONG_PRESS_MS);
    },
    [clearPressTimer],
  );

  const handleTouchMove = useCallback(
    (e: ReactTouchEvent<HTMLSpanElement>) => {
      const start = touchStart.current;
      if (!start) return;
      const t = e.touches[0];
      if (!t) return;
      // Drifted too far → it's a scroll/drag, not a press: cancel the reveal.
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_CANCEL_PX) {
        clearPressTimer();
      }
    },
    [clearPressTimer],
  );

  const handleTouchEnd = useCallback(
    (e: ReactTouchEvent<HTMLSpanElement>) => {
      lastTouchAt.current = Date.now();
      clearPressTimer();
      touchStart.current = null;
      // If the long-press opened the tooltip, swallow the emulated click so the
      // underlying control (e.g. the market-cap chip) isn't ALSO activated - a
      // hold shows info; a tap still triggers the control normally.
      if (openedByTouch.current) e.preventDefault();
    },
    [clearPressTimer],
  );

  // While open via a long-press: auto-dismiss after a beat and close on a tap
  // anywhere outside the trigger (touch UIs have no "mouse leave").
  useEffect(() => {
    if (!open || !openedByTouch.current) return;
    const auto = window.setTimeout(() => setOpen(false), TOUCH_AUTO_CLOSE_MS);
    const onOutside = (ev: TouchEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("touchstart", onOutside, true);
    return () => {
      window.clearTimeout(auto);
      document.removeEventListener("touchstart", onOutside, true);
      openedByTouch.current = false;
    };
  }, [open]);

  useEffect(() => clearPressTimer, [clearPressTimer]);

  // Open on a genuine hover, but ignore the synthetic mouseenter a touchscreen
  // fires right after a tap (otherwise a normal tap would pop the tooltip too).
  const handleMouseEnter = useCallback(() => {
    if (Date.now() - lastTouchAt.current < EMULATED_HOVER_GUARD_MS) return;
    setOpen(true);
  }, []);

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-describedby": open ? id : undefined,
      })
    : children;

  const side = pos?.side ?? placement;
  const bubbleStyle: CSSProperties = pos
    ? { left: `${pos.left}px`, top: `${pos.top}px`, ["--tip-arrow" as string]: `${pos.arrow}px` }
    : { left: 0, top: 0 };

  return (
    <span
      ref={anchorRef}
      className={`tip ${className ?? ""}`.trim()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={clearPressTimer}
    >
      {trigger}
      {open &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            ref={bubbleRef}
            className={`tip__bubble tip__bubble--${side}`}
            data-open={pos ? "true" : "false"}
            style={bubbleStyle}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

/**
 * Icon-only "info" affordance that reveals a tooltip. Use beside labels to
 * explain a control without cluttering the layout.
 */
export function InfoTip({
  label,
  content,
  placement = "top",
}: {
  label: string;
  content: ReactNode;
  placement?: "top" | "bottom";
}) {
  return (
    <Tooltip content={content} placement={placement}>
      <button type="button" className="tip-trigger" aria-label={label}>
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
    </Tooltip>
  );
}
