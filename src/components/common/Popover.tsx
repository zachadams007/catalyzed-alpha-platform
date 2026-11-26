import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type PopoverPlacement = "top" | "bottom" | "auto";
type PopoverAlign = "start" | "center" | "end";

interface PopoverProps {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  placement?: PopoverPlacement;
  align?: PopoverAlign;
  matchAnchorWidth?: boolean;
  role?: "dialog" | "menu";
  ariaLabel?: string;
  children: ReactNode;
}

interface PopoverPos {
  left: number;
  top: number;
  width?: number;
}

const GAP = 8;
const MARGIN = 10;

function getOverlayRoot(): HTMLElement {
  return document.getElementById("overlay-root") ?? document.body;
}

function alignLeft(anchor: DOMRect, popoverWidth: number, align: PopoverAlign): number {
  if (align === "start") return anchor.left;
  if (align === "end") return anchor.right - popoverWidth;
  return anchor.left + anchor.width / 2 - popoverWidth / 2;
}

export function Popover({
  anchorRef,
  open,
  onClose,
  placement = "auto",
  align = "center",
  matchAnchorWidth = false,
  role = "dialog",
  ariaLabel,
  children,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const width = matchAnchorWidth
      ? Math.min(anchorRect.width, Math.max(0, vw - MARGIN * 2))
      : undefined;

    const measured = popover.getBoundingClientRect();
    const popoverWidth = width ?? measured.width;
    const popoverHeight = measured.height;
    const topRoom = anchorRect.top;
    const bottomRoom = vh - anchorRect.bottom;
    let side: "top" | "bottom" =
      placement === "top" || placement === "bottom"
        ? placement
        : bottomRoom >= popoverHeight + GAP + MARGIN || bottomRoom >= topRoom
          ? "bottom"
          : "top";

    if (side === "bottom" && bottomRoom < popoverHeight + GAP + MARGIN && topRoom > bottomRoom) {
      side = "top";
    } else if (side === "top" && topRoom < popoverHeight + GAP + MARGIN && bottomRoom > topRoom) {
      side = "bottom";
    }

    const unclampedLeft = alignLeft(anchorRect, popoverWidth, align);
    const left = Math.max(MARGIN, Math.min(unclampedLeft, vw - popoverWidth - MARGIN));
    const preferredTop =
      side === "top" ? anchorRect.top - popoverHeight - GAP : anchorRect.bottom + GAP;
    const top = Math.max(MARGIN, Math.min(preferredTop, vh - popoverHeight - MARGIN));

    setPos({ left, top, width });
  }, [align, anchorRef, matchAnchorWidth, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }

    reposition();
    const onScrollOrResize = () => reposition();
    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("scroll", onScrollOrResize, scrollOptions);
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, scrollOptions);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onClose, open]);

  if (!open || typeof document === "undefined") return null;

  const style: CSSProperties = {
    left: pos ? `${pos.left}px` : 0,
    top: pos ? `${pos.top}px` : 0,
    width: pos?.width ? `${pos.width}px` : undefined,
    visibility: pos ? "visible" : "hidden",
  };

  return createPortal(
    <div
      ref={popoverRef}
      className="popover-portal"
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      style={style}
    >
      {children}
    </div>,
    getOverlayRoot(),
  );
}
