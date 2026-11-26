import { Skeleton } from "@/components/common/Skeleton";

/** Stat grid + hero band while analyst coverage loads. */
export function PriceTargetsSkeleton() {
  return (
    <div className="price-targets-skeleton" aria-hidden>
      <div className="price-targets-skeleton__stats">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="price-targets-skeleton__stat">
            <Skeleton width="72%" height={9} />
            <Skeleton width="55%" height={18} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
      <Skeleton width="100%" height={56} radius={12} style={{ marginTop: 16 }} />
    </div>
  );
}
