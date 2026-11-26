import type { ReactNode } from "react";
import type { ResearchRunStatus } from "@/types";
import {
  isProviderResolutionPending,
  isResearchRunAllowed,
  resolveProviderId,
} from "@/data/providers";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminEmail } from "@/lib/admin";

/**
 * True while a feed skeleton is an honest representation of progress: a run
 * is in flight, the local sample universe is about to auto-run via bootstrap(),
 * or the GLOBAL operator controls are still loading (so we don't yet know whether
 * to show live data or the sample universe - a skeleton is the honest in-between).
 * Live providers never auto-run (quota protection), so an idle empty live feed
 * must show FeedAwaitingRun instead of a fake-loading skeleton.
 */
export function feedIsPreparing(status: ResearchRunStatus): boolean {
  return (
    status === "running" ||
    status === "loading" ||
    isProviderResolutionPending() ||
    resolveProviderId() === "mock"
  );
}

/**
 * Live-provider feed with no signals AFTER we've confirmed none is published yet
 * (the feed shows the loading skeleton until that check resolves - see
 * `hasCheckedSharedScan`). The real scan is a once-daily CLOUD job, so a local
 * "Scan Market" button only does something for the operator. Everyone else gets a
 * calm "it's on its way" message + a cheap re-check (re-reads the published board,
 * spends no vendor quota) - so a tester never hammers a dead Scan button while the
 * morning scan is just landing.
 */
export function FeedAwaitingRun({ onRun }: { onRun: () => void }) {
  const isAdmin = useAuthStore((s) => isAdminEmail(s.email));
  const allowed = isResearchRunAllowed();
  const bootstrap = useAppStore((s) => s.bootstrap);

  if (isAdmin && allowed) {
    return (
      <FeedState
        title="No scan published yet"
        action={
          <button className="btn btn--primary btn--sm" onClick={onRun}>
            Scan market now
          </button>
        }
      >
        Today&rsquo;s market scan hasn&rsquo;t published yet. As operator you can run one now, or it
        publishes automatically each morning.
      </FeedState>
    );
  }

  return (
    <FeedState
      title="Today&rsquo;s scan is on its way"
      action={
        <button className="btn btn--ghost btn--sm" onClick={() => bootstrap()}>
          Check again
        </button>
      }
    >
      The morning market scan publishes around the opening bell and loads in automatically — this
      isn&rsquo;t an error. Give it a moment, then tap to re-check.
    </FeedState>
  );
}

interface FeedStateProps {
  variant?: "empty" | "error";
  title: string;
  /** Plain-language reason + what to do next. */
  children?: ReactNode;
  /** Recovery / next-step action (button or link). */
  action?: ReactNode;
}

/** Console-style status card for feeds with nothing to render. */
export function FeedState({ variant = "empty", title, children, action }: FeedStateProps) {
  return (
    <div
      className={`empty feed-state${variant === "error" ? " feed-state--error" : ""}`}
      role={variant === "error" ? "alert" : "status"}
    >
      <span className="feed-state__lamp" aria-hidden />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
