import { Skeleton } from "@/components/common/Skeleton";

interface NewsSkeletonProps {
  rows?: number;
  layout?: "feed" | "detail" | "compact";
}

/** Shimmer rows for news / headline panels. */
export function NewsSkeleton({ rows = 3, layout = "feed" }: NewsSkeletonProps) {
  return (
    <div className={`news-skeleton news-skeleton--${layout}`} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="news-skeleton__row" key={i}>
          <Skeleton width={layout === "compact" ? 42 : "28%"} height={layout === "detail" ? 36 : 32} radius={10} />
          <div className="news-skeleton__body">
            <Skeleton width="92%" height={12} />
            <Skeleton width="38%" height={10} style={{ marginTop: 6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
