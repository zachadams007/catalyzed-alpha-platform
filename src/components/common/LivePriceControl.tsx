import { IconRefresh } from "@/components/icons";
import { useLivePriceSync } from "@/lib/useLivePrices";
import { marketSession } from "@/lib/marketStatus";

/**
 * Compact, honest live-price status + manual refresh.
 *
 * Auto-refreshes the live overlay for `tickers` on mount, then refreshes again on
 * click - no polling (the product choice). Crucially, it only claims "Live" during
 * the regular cash session: overnight / weekends / pre- + after-hours, the same
 * Alpaca snapshot returns the LAST session's print, so the badge says "At close"
 * (etc.) with a muted dot instead of asserting a live price the market isn't making.
 */

const IEX_CAVEAT =
  "Live prices via Alpaca's free IEX feed — real-time for actively-traded names during market hours; very thin micro-caps can lag. Outside 9:30–4:00 ET this shows the last session's close. Daily research scores refresh once a day. Click to refresh.";

function clockLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function LivePriceControl({
  tickers,
  auto = true,
  className,
}: {
  tickers: string[];
  auto?: boolean;
  className?: string;
}) {
  const { refresh, refreshing, updatedAt, dataAsOf } = useLivePriceSync(tickers, { auto });
  const session = marketSession();
  const live = session === "open";
  // When live: show the moment we last refreshed. When closed: show WHEN the shown
  // data is actually from (the prior session), not the wall-clock fetch time.
  const stamp = live ? clockLabel(updatedAt) : dateLabel(dataAsOf);

  let label: string;
  if (refreshing) label = "Updating…";
  else if (live) label = stamp ? `Live IEX · ${stamp}` : "Live IEX";
  else if (session === "premarket") label = "Pre-market · last close";
  else if (session === "afterhours") label = stamp ? `At close · ${stamp}` : "At close";
  else label = stamp ? `Markets closed · ${stamp}` : "Markets closed";

  return (
    <button
      type="button"
      className={`pill live-price-ctl${live ? "" : " live-price-ctl--stale"}${refreshing ? " is-loading" : ""}${className ? ` ${className}` : ""}`}
      onClick={refresh}
      disabled={refreshing}
      title={IEX_CAVEAT}
      aria-label={
        live
          ? `Live prices${stamp ? ` — updated ${stamp}` : ""}. Refresh.`
          : `Market closed — showing last session's prices${stamp ? ` from ${stamp}` : ""}. Refresh.`
      }
    >
      <span className="pill__dot live-price-ctl__dot" aria-hidden />
      <span className="live-price-ctl__label">{label}</span>
      <IconRefresh size={12} className="live-price-ctl__icon" />
    </button>
  );
}
