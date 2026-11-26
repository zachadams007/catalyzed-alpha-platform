import type { TradeHorizon } from "@/types";
import { TRADE_HORIZON_HINTS, TRADE_HORIZON_LABELS } from "@/types";
import { SCALPING_DISCLAIMER } from "@/lib/tradeHorizon";

const HORIZONS: TradeHorizon[] = [
  "scalping",
  "day_trading",
  "swing_trading",
  "position_trading",
];

interface TradeHorizonPickerProps {
  /** Single-select (portfolio discovery). */
  value?: TradeHorizon;
  onChange?: (h: TradeHorizon) => void;
  /** Multi-select (Blueprint). */
  values?: TradeHorizon[];
  onChangeValues?: (h: TradeHorizon[]) => void;
  compact?: boolean;
  forge?: boolean;
}

export function TradeHorizonPicker({
  value,
  onChange,
  values,
  onChangeValues,
  compact,
  forge,
}: TradeHorizonPickerProps) {
  const multi = Boolean(onChangeValues);
  const selected = multi ? (values ?? []) : value ? [value] : [];

  const toggle = (h: TradeHorizon) => {
    if (multi && onChangeValues) {
      const set = new Set(selected);
      if (set.has(h)) {
        if (set.size <= 1) return;
        set.delete(h);
      } else {
        set.add(h);
      }
      onChangeValues([...set]);
      return;
    }
    onChange?.(h);
  };

  const isOn = (h: TradeHorizon) => selected.includes(h);
  const activeHint = multi
    ? selected.map((h) => TRADE_HORIZON_LABELS[h]).join(" + ")
    : value
      ? TRADE_HORIZON_HINTS[value]
      : "";

  return (
    <div className={compact ? "horizon-picker horizon-picker--compact" : "horizon-picker"}>
      {!compact && (
        <div className="act-group-label">
          {multi ? "Time horizons (blend fit)" : "Time horizon"}
        </div>
      )}
      <div className="chip-grid" role="group" aria-label={multi ? "Time horizons" : "Time horizon"}>
        {HORIZONS.map((h) => (
          <button
            key={h}
            type="button"
            className={
              forge
                ? `forge-chip ${isOn(h) ? "forge-chip--on" : ""}`
                : `chip-select ${isOn(h) ? "active" : ""}`
            }
            aria-pressed={isOn(h)}
            onClick={() => toggle(h)}
            title={TRADE_HORIZON_HINTS[h]}
          >
            {TRADE_HORIZON_LABELS[h]}
          </button>
        ))}
      </div>
      {!compact && activeHint && (
        <p className="text-faint" style={{ fontSize: 12, marginTop: 8 }}>
          {multi ? `Blending: ${activeHint}` : activeHint}
        </p>
      )}
      {selected.includes("scalping") && (
        <p className="lookup-banner" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.45 }}>
          {SCALPING_DISCLAIMER}
        </p>
      )}
    </div>
  );
}
