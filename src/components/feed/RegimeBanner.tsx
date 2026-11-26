import { useAppStore } from "@/store/useAppStore";

/**
 * Feed-tab regime notification (P9, owner request 2026-07-03): when market panic has
 * shifted the algorithm's behavior, SAY SO at the top of the feed - a small,
 * honest strip, not a scare box.
 *
 * Shows only when the scan-time regime meaningfully changed the ranking
 * (riskOffness ≥ 0.2 → the panic-opportunity mode is active), plus a milder
 * informational variant at extreme greed. Hidden entirely on a normal day and on
 * boards published before regime meta existed - silence is the default state.
 *
 * The copy must match the ACTUAL panic behavior (explainer contract): lean into
 * discounted QUALITY (fundamentals + catalysts), demote speculation harder,
 * do NOT rotate into "safe" stocks.
 */

const FG_LABEL_TEXT: Record<string, string> = {
  "extreme-fear": "Extreme fear",
  fear: "Fear",
  neutral: "Neutral",
  greed: "Greed",
  "extreme-greed": "Extreme greed",
};

export function RegimeBanner() {
  const regime = useAppStore((s) => s.boardRegime);
  if (!regime) return null;

  const riskOff = regime.riskOffness ?? 0;
  const fearGreed = regime.fearGreed;
  const labelText = regime.fearGreedLabel ? FG_LABEL_TEXT[regime.fearGreedLabel] : undefined;
  const reading =
    fearGreed != null ? `Fear & Greed ${Math.round(fearGreed)}${labelText ? ` — ${labelText}` : ""}` : labelText;

  const panicActive = riskOff >= 0.2;
  const euphoric = !panicActive && regime.fearGreedLabel === "extreme-greed";
  if (!panicActive && !euphoric) return null;

  return (
    <div
      className={`regime-banner ${panicActive ? "regime-banner--fear" : "regime-banner--greed"}`}
      role="status"
    >
      <span className="regime-banner__dot" aria-hidden="true" />
      <span className="regime-banner__reading mono">{reading}</span>
      <span className="regime-banner__copy">
        {panicActive
          ? "Market fear is elevated — today's ranking leans into discounted quality (solid fundamentals, real catalysts) and demotes speculative names harder. It does not rotate into “safe” stocks."
          : "The crowd is euphoric — extended, already-ran names score worse than discounted setups, as always. Careful chasing."}
      </span>
    </div>
  );
}
