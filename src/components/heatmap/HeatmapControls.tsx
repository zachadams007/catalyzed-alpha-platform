import { useRef } from "react";
import type { HeatMode } from "@/components/heatmap/colorScale";
import { HEAT_MODES } from "@/components/heatmap/heatmapModel";

interface Props {
  mode: HeatMode;
  onChange: (mode: HeatMode) => void;
}

/**
 * Segmented color-mode switch - a proper ARIA radiogroup: roving tabindex (only
 * the checked radio is tabbable) with arrow/Home/End selection, matching the
 * keyboard contract the radio roles advertise.
 */
export function HeatmapControls({ mode, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const activeIndex = HEAT_MODES.findIndex((m) => m.mode === mode);

  const select = (index: number) => {
    const next = HEAT_MODES[(index + HEAT_MODES.length) % HEAT_MODES.length]!;
    onChange(next.mode);
    // The button persists across the re-render (keyed by mode); focus it now.
    ref.current?.querySelector<HTMLButtonElement>(`[data-mode="${next.mode}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select(activeIndex + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select(activeIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      select(0);
    } else if (e.key === "End") {
      e.preventDefault();
      select(HEAT_MODES.length - 1);
    }
  };

  return (
    <div className="hm-seg" role="radiogroup" aria-label="Color tiles by" ref={ref} onKeyDown={onKeyDown}>
      <span
        className="hm-seg__thumb"
        style={{
          width: `calc((100% - 8px) / ${HEAT_MODES.length})`,
          transform: `translateX(calc(${activeIndex} * 100%))`,
        }}
        aria-hidden="true"
      />
      {HEAT_MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="radio"
          data-mode={m.mode}
          aria-checked={m.mode === mode}
          tabIndex={m.mode === mode ? 0 : -1}
          className={`hm-seg__btn ${m.mode === mode ? "is-active" : ""}`}
          onClick={() => onChange(m.mode)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
