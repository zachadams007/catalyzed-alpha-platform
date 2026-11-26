import type { CongressTrade } from "@/types";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconExternal } from "@/components/icons";

interface CongressTradesPanelProps {
  trades: CongressTrade[];
  /** Max rows to render (detail shows more than a card would). */
  limit?: number;
}

const TXN_LABEL: Record<CongressTrade["transaction"], string> = {
  buy: "Buy",
  sell: "Sell",
  exchange: "Exchange",
};

function formatDay(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Real disclosed congressional trades for this ticker (House financial
 * disclosures). Each row links to the underlying Periodic Transaction Report.
 * Renders nothing when there are no disclosures.
 */
export function CongressTradesPanel({ trades, limit = 6 }: CongressTradesPanelProps) {
  if (trades.length === 0) return null;
  const rows = trades.slice(0, limit);
  const buys = trades.filter((t) => t.transaction === "buy").length;

  return (
    <section className="congress-panel" aria-label="Congressional trades">
      <div className="congress-panel__head">
        <span className="congress-panel__title">Congressional trades</span>
        <span className="congress-panel__count text-faint">
          {trades.length} disclosed{buys > 0 ? ` · ${buys} buy${buys === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      <div className="congress-list">
        {rows.map((t, i) => {
          const row = (
            <>
              <span className={`congress-tag congress-tag--${t.transaction}`}>
                {TXN_LABEL[t.transaction]}
              </span>
              <span className="congress-row__rep grow">
                {t.representative}
                <span className="congress-row__chamber text-faint"> · {t.chamber}</span>
              </span>
              <span className="congress-row__amount text-faint">{t.amountRange}</span>
              <span className="congress-row__date text-faint">{formatDay(t.transactionDate)}</span>
              {t.url && <IconExternal size={12} className="congress-row__ext" />}
            </>
          );
          return t.url ? (
            <ExternalLink
              key={`${t.representative}-${t.transactionDate}-${i}`}
              href={t.url}
              className="congress-row congress-row--link"
              title={`${t.representative} — ${TXN_LABEL[t.transaction]} ${t.amountRange}`}
            >
              {row}
            </ExternalLink>
          ) : (
            <div
              key={`${t.representative}-${t.transactionDate}-${i}`}
              className="congress-row"
            >
              {row}
            </div>
          );
        })}
      </div>
      <p className="text-faint congress-panel__foot">
        Source: U.S. House financial disclosures (Periodic Transaction Reports).
      </p>
    </section>
  );
}
