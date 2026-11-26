import { Tooltip } from "@/components/common/Tooltip";
import { capGuideFor } from "@/lib/marketCapGuide";
import type { MarketCapBucket } from "@/types";

interface MarketCapChipProps {
  bucket: MarketCapBucket;
  active: boolean;
  className: string;
  onToggle: () => void;
}

/** Cap filter chip - label only; range + hint on hover/focus tooltip. */
export function MarketCapChip({ bucket, active, className, onToggle }: MarketCapChipProps) {
  const guide = capGuideFor(bucket);

  return (
    <Tooltip
      content={
        <>
          <span className="tip__range">{guide.rangeLabel}</span>
          <span className="tip__hint">{guide.hint}</span>
        </>
      }
      placement="top"
    >
      <button
        type="button"
        className={className}
        aria-pressed={active}
        onClick={onToggle}
      >
        {bucket}
      </button>
    </Tooltip>
  );
}
