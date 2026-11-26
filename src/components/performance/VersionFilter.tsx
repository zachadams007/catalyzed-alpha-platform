import { useRef, type KeyboardEvent } from "react";
import { VARIANT_VERSION_TAGS, type EngineVariantId } from "@/engine/challenger";
import type { LedgerVersionFilter } from "@/engine/outcomeLedger";

interface Option {
  value: LedgerVersionFilter;
  label: string;
  count: number;
}

/**
 *
 * Only versions that actually have picks are offered (plus "untagged" when
 * pre-tagging history exists), so the control never advertises an empty slice
 * as if it were a choice.
 */
export function VersionFilter({
  value,
  onChange,
  variantsPresent,
  hasUntagged,
  counts,
}: {
  value: LedgerVersionFilter;
  onChange: (next: LedgerVersionFilter) => void;
  variantsPresent: readonly EngineVariantId[];
  hasUntagged: boolean;
  counts: Partial<Record<LedgerVersionFilter, number>>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const options: Option[] = [
    { value: "all", label: "All", count: counts.all ?? 0 },
    ...variantsPresent.map((v) => ({ value: v as LedgerVersionFilter, label: VARIANT_VERSION_TAGS[v], count: counts[v] ?? 0 })),
    ...(hasUntagged ? [{ value: "untagged" as const, label: "Untagged", count: counts.untagged ?? 0 }] : []),
  ];
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));

  const select = (index: number) => {
    const next = options[(index + options.length) % options.length]!;
    onChange(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        select(activeIndex + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        select(activeIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        select(0);
        break;
      case "End":
        e.preventDefault();
        select(options.length - 1);
        break;
      default:
    }
  };

  // With a single option (all picks from one version) a filter is noise.
  if (options.length <= 2 && !hasUntagged && variantsPresent.length <= 1) return null;

  return (
    <div className="perf-version" role="group" aria-label="Engine version">
      <span className="perf-version__label">Engine version</span>
      <div className="perf-seg" role="radiogroup" aria-label="Filter picks by engine version" ref={ref} onKeyDown={onKeyDown}>
        <span
          className="perf-seg__thumb"
          style={{
            width: `calc((100% - 8px) / ${options.length})`,
            transform: `translateX(calc(${activeIndex} * 100%))`,
          }}
          aria-hidden="true"
        />
        {options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={i === activeIndex}
            tabIndex={i === activeIndex ? 0 : -1}
            data-value={o.value}
            className={`perf-seg__btn${i === activeIndex ? " is-active" : ""}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
            <span className="perf-version__count mono">{o.count.toLocaleString("en-US")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
