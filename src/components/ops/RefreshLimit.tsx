import { useEffect, useState } from "react";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminEmail } from "@/lib/admin";
import {
  getManualRefreshStatus,
  subscribeRefreshLimiter,
  type RefreshLimiterStatus,
} from "@/lib/refreshLimiter";

/**
 * Live view of the per-user manual-refresh limiter (src/lib/refreshLimiter.ts).
 * Admin-aware: the signed-in operator sees the "unlimited" bypass state. Used by
 * the TopBar Run-Research button and the Research page's "Manual refreshes" card.
 */
export function useRefreshLimit(): RefreshLimiterStatus {
  const email = useAuthStore((s) => s.email);
  const isAdmin = isAdminEmail(email);
  const [status, setStatus] = useState<RefreshLimiterStatus>(() =>
    getManualRefreshStatus({ isAdmin }),
  );
  useEffect(() => {
    const refresh = () => setStatus(getManualRefreshStatus({ isAdmin }));
    refresh();
    const unsubscribe = subscribeRefreshLimiter(refresh);
    // Re-evaluate periodically so a local-midnight rollover clears the cap even
    // if the app is left open, keeping the "resets at midnight" copy honest.
    const tick = setInterval(refresh, 60_000);
    return () => {
      unsubscribe();
      clearInterval(tick);
    };
  }, [isAdmin]);
  return status;
}

/**
 * The RAW device count, ignoring admin bypass - so the Operator console always
 * shows how many manual runs this device has actually spent today (the operator
 * is exempt, but still wants to see/reset a friend's count on a shared device).
 */
export function useDeviceManualRefreshUsage(): RefreshLimiterStatus {
  const [status, setStatus] = useState<RefreshLimiterStatus>(() =>
    getManualRefreshStatus({ isAdmin: false }),
  );
  useEffect(() => {
    const refresh = () => setStatus(getManualRefreshStatus({ isAdmin: false }));
    refresh();
    const unsubscribe = subscribeRefreshLimiter(refresh);
    const tick = setInterval(refresh, 60_000);
    return () => {
      unsubscribe();
      clearInterval(tick);
    };
  }, []);
  return status;
}

/**
 * "Manual refreshes" card - the user-facing surface of the daily cap. Renders
 * loading-free (the limiter is local + synchronous), with a clear at-limit state
 * that never reads as an error: the feed is still populated from the auto-cache.
 */
export function ManualRefreshCard() {
  const status = useRefreshLimit();
  const blocked = status.blocked;
  const pct = status.unlimited
    ? 100
    : Math.round((status.used / Math.max(1, status.limit)) * 100);

  const pillClass = status.unlimited
    ? "pill--horizon"
    : blocked
      ? "pill--risk-Elevated"
      : "pill--risk-Low";
  const pillLabel = status.unlimited
    ? "Operator bypass"
    : blocked
      ? "Limit reached"
      : `${status.remaining} left`;

  return (
    <div className="signal-card">
      <div className="section-title">Manual refreshes</div>

      <div
        className="row-between"
        style={{ alignItems: "baseline", marginBottom: "var(--sp-3)" }}
      >
        <div style={{ fontWeight: 600, fontSize: "var(--type-body)" }}>
          {status.unlimited ? (
            "Unlimited · operator"
          ) : (
            <>
              <span className="mono">{status.used}</span>
              <span className="text-faint"> / </span>
              <span className="mono">{status.limit}</span>
              <span className="text-faint" style={{ fontWeight: 500 }}>
                {" "}
                used today
              </span>
            </>
          )}
        </div>
        <span className={`pill ${pillClass}`}>{pillLabel}</span>
      </div>

      {!status.unlimited && (
        <div
          className="quota-meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={status.limit}
          aria-valuenow={status.used}
          aria-label={`${status.used} of ${status.limit} manual refreshes used today`}
        >
          <span
            className={`quota-meter__fill ${blocked ? "quota-meter__fill--critical" : ""}`}
            style={{ width: `${Math.max(pct, status.used > 0 ? 6 : 0)}%` }}
          />
        </div>
      )}

      <p className="text-faint" style={{ fontSize: "var(--type-sm)", marginTop: "var(--sp-3)", lineHeight: 1.55 }}>
        {status.unlimited
          ? "You're signed in as the operator — manual research runs aren't capped on your account."
          : blocked
            ? "You've spent today's manual runs. The feed still refreshes automatically once a day, so it stays current — the manual cap resets at midnight."
            : `Scan Market forces a fresh pipeline on demand. Each user gets ${status.limit} manual scans a day on top of the automatic once-daily refresh; the count resets at midnight.`}
      </p>
    </div>
  );
}
