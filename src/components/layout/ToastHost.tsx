import { useNavigate } from "react-router-dom";
import type { Toast } from "@/store/useAppStore";
import { useAppStore } from "@/store/useAppStore";

/** Tones that carry an error/attention signal - escalated for assistive tech. */
const URGENT_TONES: ReadonlySet<Toast["tone"]> = new Set(["warn"]);

/** Bottom-right transient notifications, driven by the store's toast queue. */
export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  const navigate = useNavigate();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-wrap" role="region" aria-label="Notifications">
      {toasts.map((t) => {
        const urgent = URGENT_TONES.has(t.tone);
        // A toast with an href is actionable: tapping it navigates to the relevant
        // surface (e.g. a friend-request toast → Friends) and then clears it.
        const onClick = t.href
          ? () => {
              navigate(t.href!);
              dismiss(t.id);
            }
          : () => dismiss(t.id);
        return (
          <button
            key={t.id}
            type="button"
            className={`toast toast--${t.tone}${t.href ? " toast--action" : ""}`}
            // Each toast is the PRIMARY error channel since Wave 4, so it must be
            // announced. Errors/warnings interrupt (alert/assertive); routine
            // confirmations wait their turn (status/polite).
            role={urgent ? "alert" : "status"}
            aria-live={urgent ? "assertive" : "polite"}
            aria-atomic="true"
            onClick={onClick}
            aria-label={t.href ? `${t.message}. Open.` : `${t.message}. Dismiss notification.`}
          >
            <span className="toast__bar" aria-hidden="true" />
            <span>{t.message}</span>
            {t.href && <span className="toast__chevron" aria-hidden="true">›</span>}
          </button>
        );
      })}
    </div>
  );
}
