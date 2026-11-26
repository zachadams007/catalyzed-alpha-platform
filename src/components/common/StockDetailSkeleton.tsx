import { Skeleton } from "@/components/common/Skeleton";
import { LoadingNote } from "@/components/common/FeedSkeleton";

/** Layout-preserving placeholder while a ticker is scored or resolved. */
export function StockDetailSkeleton({ ticker, busy = false }: { ticker?: string; busy?: boolean }) {
  const label = ticker
    ? busy
      ? `Scoring ${ticker}`
      : `Loading ${ticker}`
    : "Loading signal";

  return (
    <div className="stock-detail-skeleton" aria-busy="true" aria-label={label}>
      <LoadingNote
        label={ticker ?? "this stock"}
        hint={
          busy
            ? "Scoring this name against the latest run — not stuck."
            : "Pulling the live quote, fundamentals and filings — not stuck."
        }
      />
      <Skeleton width={120} height={14} radius={6} />

      <article className="feed-skeleton__card stock-detail-skeleton__hero">
        <div className="feed-skeleton__top">
          <div className="feed-skeleton__id">
            <Skeleton width={ticker ? 72 : 64} height={28} radius={6} />
            <Skeleton width="48%" height={14} style={{ marginTop: 8 }} />
            <div className="feed-skeleton__price">
              <Skeleton width={96} height={20} radius={6} />
              <Skeleton width={56} height={16} radius={999} />
              <Skeleton width={120} height={12} style={{ marginLeft: 8 }} />
            </div>
            <div className="feed-skeleton__badges" style={{ marginTop: 14 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} width={58 + i * 6} height={22} radius={999} />
              ))}
            </div>
          </div>
          <Skeleton width={104} height={104} radius={999} className="feed-skeleton__ring" />
        </div>
        <Skeleton width="100%" height={12} style={{ marginTop: 16 }} />
        <Skeleton width="88%" height={12} style={{ marginTop: 8 }} />
        <Skeleton width="100%" height={36} radius={10} style={{ marginTop: 16 }} />
        <Skeleton width="100%" height={40} radius={10} style={{ marginTop: 12 }} />
      </article>

      <article className="feed-skeleton__card" style={{ marginTop: 20 }}>
        <Skeleton width={160} height={12} />
        <div className="stock-detail-skeleton__stats">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="stock-detail-skeleton__stat">
              <Skeleton width="80%" height={9} />
              <Skeleton width="60%" height={16} style={{ marginTop: 6 }} />
            </div>
          ))}
        </div>
      </article>

      <div className="stock-detail-skeleton__grid">
        <article className="feed-skeleton__card">
          <Skeleton width={180} height={12} />
          <Skeleton width="100%" height={120} radius={12} style={{ marginTop: 14 }} />
        </article>
        <article className="feed-skeleton__card">
          <Skeleton width={140} height={12} />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} width="100%" height={32} radius={8} style={{ marginTop: i === 0 ? 14 : 8 }} />
          ))}
        </article>
      </div>
    </div>
  );
}
