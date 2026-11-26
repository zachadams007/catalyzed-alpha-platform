import type { StockSignal } from "@/types";
import { IconCore } from "@/components/icons";
import { isSampleProfile, isMarketDataUnavailable } from "@/lib/marketData";
import "./negative-badges.css";

/** Notable disclosed congressional activity = at least this many trades. */
const NOTABLE_MIN = 1;

/**
 * Surface a congress / politician-trade badge on a feed tile for names with
 * notable disclosed congressional activity. The score already consumes congress
 * trades (catalystStrength smart-money + materialSellSignal) - this makes that
 * input VISIBLE on the tile. Honest tilt: a buy-skew reads bullish, a sell-skew
 * reads bearish, a mixed/even book reads neutral. Real disclosures only - nothing
 * shows for a sample / unquoted profile.
 */
export function CongressBadge({ signal, className }: { signal: StockSignal; className?: string }) {
  if (isSampleProfile(signal) || isMarketDataUnavailable(signal)) return null;
  const trades = signal.congressTrades ?? [];
  if (trades.length < NOTABLE_MIN) return null;

  const buys = trades.filter((t) => t.transaction === "buy").length;
  const sells = trades.filter((t) => t.transaction === "sell").length;
  const tone = buys > sells ? "buy" : sells > buys ? "sell" : "neutral";

  const label =
    tone === "buy"
      ? "Congress buying"
      : tone === "sell"
        ? "Congress selling"
        : "Congress trading";

  const reps = Array.from(new Set(trades.map((t) => t.representative)));
  const who = reps.length === 1 ? reps[0] : `${reps.length} members`;
  const detail = `${trades.length} disclosed congressional trade${
    trades.length === 1 ? "" : "s"
  } (${who}${buys > 0 ? ` · ${buys} buy` : ""}${sells > 0 ? ` · ${sells} sell` : ""}).`;

  return (
    <span
      className={`congress-badge congress-badge--${tone} ${className ?? ""}`}
      title={detail}
    >
      <span className="congress-badge__icon" aria-hidden>
        <IconCore size={11} />
      </span>
      <span className="congress-badge__label">{label}</span>
      <span className="congress-badge__count mono">{trades.length}</span>
    </span>
  );
}
