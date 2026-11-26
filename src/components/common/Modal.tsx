import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "@/components/icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * CSS selector for elements that can hold keyboard focus inside the dialog.
 * Excludes negative tabindex and disabled controls so the trap mirrors the
 * browser's own Tab order.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

/**
 * Pure boundary logic for a Tab focus trap. Given the ordered focusable
 * elements, the currently focused one, and the Shift state, returns the
 * element that focus should move to when it would otherwise escape the
 * dialog - or `null` when the browser's default Tab handling is fine
 * (i.e. focus stays inside the set). Extracted from the React component so
 * the cycling rules can be unit-tested without a DOM renderer.
 */
export function nextTrapFocus<T>(
  focusables: readonly T[],
  active: T | null,
  shift: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  // Focus currently sits outside the trapped set (e.g. on the page behind
  // the overlay, or the focus was lost). Pull it back to an edge.
  if (active === null || !focusables.includes(active)) {
    return shift ? last : first;
  }

  // Wrap at the boundaries so Tab can never leave the dialog.
  if (shift && active === first) return last;
  if (!shift && active === last) return first;

  // Interior element: let the browser advance focus normally.
  return null;
}

/** Centered glass modal. Closes on Escape and overlay click; traps focus. */
export function Modal({ title, onClose, children, footer, className }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    // Remember what was focused before the modal opened so we can restore it
    // when the modal closes (mirrors native <dialog> behaviour).
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const getFocusables = (): HTMLElement[] => {
      if (!dialog) return [];
      return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    };

    // Move focus into the dialog: first focusable element, else the dialog
    // container itself (it carries tabIndex={-1} so it can receive focus).
    const focusables = getFocusables();
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      dialog?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;

      const current = getFocusables();
      if (current.length === 0) {
        // Nothing focusable inside - keep focus pinned on the container.
        e.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = nextTrapFocus(current, active, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus to the triggering element on close/unmount.
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal__head">
          <span className="modal__title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={18} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
