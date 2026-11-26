import { Skeleton } from "@/components/common/Skeleton";

interface FeedSkeletonProps {
  count?: number;
  /** List stack (Today/For You) vs responsive grid (Weekly). */
  layout?: "list" | "grid";
  /** Reserve space for PageHeader above the cards. */
  showHeader?: boolean;
  /**
   * When set, shows a small "still loading, not broken" status banner above the
   * shimmer cards naming WHAT is loading (e.g. "today's signals"). Opt-in so it
   * only appears on the main feed tabs, not single-card lookups.
   */
  label?: string;
}

/**
 * Shared "still loading, not broken" reassurance line - a pulsing dot + plain
 * copy + an indeterminate sweep so a slow fetch reads as "working", not a frozen
 * or broken screen. No fake ETA - just honest, calm motion.
 *
 * This is the ONE shared loading-cue primitive. Any data surface that shows bare
 * skeletons (Track Record, Watchlist, Groups, Market Map, Stock detail, a
 * portfolio, …) renders a `<LoadingNote>` above its shimmer so the user always
 * knows the wait is intentional. `FeedLoadingBanner` is the feed-tab preset.
 *
 * Only render this in a GENUINE loading state - never on empty / awaiting-action
 * / error states, which carry their own messaging (see `FeedState`).
 */
export function LoadingNote({
  /** What is loading, e.g. "your watchlist" → "Loading your watchlist…". */
  label,
  /** Optional second line. Defaults to a generic, honest "not stuck" reassurance. */
  hint,
}: {
  label?: string;
  hint?: string;
}) {
  return (
    <div className="feed-loading" role="status" aria-live="polite">
      <span className="feed-loading__pulse" aria-hidden />
      <div className="feed-loading__copy">
        <span className="feed-loading__title">Loading {label ?? "the latest data"}…</span>
        <span className="feed-loading__hint">
          {hint ?? "This is loading, not stuck — just a few seconds."}
        </span>
      </div>
      <span className="feed-loading__track" aria-hidden>
        <span className="feed-loading__sweep" />
      </span>
    </div>
  );
}

/**
 * Feed-tab preset of {@link LoadingNote}: the "pulling today's market scan"
 * reassurance shown above the feed shimmer on Today / Weekly / For You.
 */
export function FeedLoadingBanner({ label }: { label?: string }) {
  return (
    <LoadingNote
      label={label ?? "the latest signals"}
      hint="Pulling today’s market scan — a few seconds, not stuck."
    />
  );
}

function SignalCardSkeleton({ index }: { index: number }) {
  return (
    <article
      className="feed-skeleton__card"
      style={{ animationDelay: `${Math.min(index * 0.06, 0.36)}s` }}
      aria-hidden
    >
      <div className="feed-skeleton__top">
        <div className="feed-skeleton__id">
          <Skeleton width={72} height={22} radius={6} />
          <Skeleton width="58%" height={12} style={{ marginTop: 8 }} />
          <div className="feed-skeleton__price">
            <Skeleton width={88} height={16} radius={6} />
            <Skeleton width={52} height={14} radius={999} />
          </div>
        </div>
        <Skeleton width={56} height={56} radius={999} className="feed-skeleton__ring" />
      </div>
      <Skeleton width="100%" height={30} radius={8} style={{ marginTop: 12, opacity: 0.45 }} />
      <div className="feed-skeleton__badges">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} width={64 + i * 8} height={22} radius={999} />
        ))}
      </div>
      <Skeleton width="100%" height={12} style={{ marginTop: 14 }} />
      <Skeleton width="92%" height={12} style={{ marginTop: 8 }} />
      <Skeleton width="74%" height={12} style={{ marginTop: 8 }} />
      <div className="feed-skeleton__kfs">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="feed-skeleton__kf">
            <Skeleton width="70%" height={9} />
            <Skeleton width="50%" height={14} style={{ marginTop: 6 }} />
          </div>
        ))}
      </div>
      <div className="feed-skeleton__news">
        <Skeleton width={48} height={10} />
        <Skeleton width="100%" height={36} radius={10} style={{ marginTop: 10 }} />
        <Skeleton width="100%" height={36} radius={10} style={{ marginTop: 8 }} />
      </div>
    </article>
  );
}

/** Shimmer placeholders while the research feed bootstraps. */
export function FeedSkeleton({
  count = 3,
  layout = "list",
  showHeader = false,
  label,
}: FeedSkeletonProps) {
  return (
    <div className="feed-skeleton" aria-busy="true" aria-label="Loading feed">
      {label && <FeedLoadingBanner label={label} />}
      {showHeader && (
        <div className="feed-skeleton__header" aria-hidden>
          <Skeleton width={140} height={28} radius={8} />
          <Skeleton width="min(520px, 88%)" height={14} style={{ marginTop: 10 }} />
        </div>
      )}
      <div className={layout === "grid" ? "feed-grid feed-skeleton__grid" : "feed feed--timeline feed-skeleton__stack"}>
        {Array.from({ length: count }).map((_, i) => (
          <SignalCardSkeleton key={i} index={i} />
        ))}
      </div>
    </div>
  );
}
