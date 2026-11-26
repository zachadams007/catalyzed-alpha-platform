import { Skeleton } from "@/components/common/Skeleton";
import type { SecActivity } from "@/types";
import type { Form4InsiderRow, Form4TradeSummary } from "@/data/sec/form4";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconExternal } from "@/components/icons";

interface SecFilingsPanelProps {
  activity: SecActivity;
  /** Parsed Form 4 buy/sell breakdown (lazy single-ticker deep dive); optional. */
  form4Summary?: Form4TradeSummary | null;
  form4Loading?: boolean;
  /** Max filing rows to render. */
  limit?: number;
}

/** EDGAR form labels we surface; fall back to the raw code for anything else. */
const FORM_LABEL: Record<string, string> = {
  "4": "Form 4",
  "8-K": "8-K",
};

/** Compact unsigned USD value, e.g. "$1.2M", "$420K", "$50". */
function fmtUsd(value: number): string {
  if (value <= 0) return "";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/** "Jun 18" from an ISO date string. */
function fmtShortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** One Bloomberg-style insider trade row. */
function InsiderTradeRow({ row }: { row: Form4InsiderRow }) {
  const isBuy = row.direction === "buy";
  const dot = isBuy ? "insider-row__dot insider-row__dot--buy" : "insider-row__dot insider-row__dot--sell";
  const valueLabel = row.valueUsd > 0 ? ` (~${fmtUsd(row.valueUsd)})` : "";
  const sharesLabel = row.shares > 0 ? `${row.shares.toLocaleString("en-US")} sh` : "";
  const roleLabel = row.insiderRole ? ` · ${row.insiderRole}` : "";

  return (
    <ExternalLink
      href={row.edgarUrl}
      className="insider-row"
      title={`${row.insiderName}${roleLabel} — EDGAR filing`}
    >
      <span className={dot} aria-hidden />
      <span className="insider-row__who">
        <span className="insider-row__name">{row.insiderName}</span>
        {row.insiderRole && (
          <span className="insider-row__role text-faint">{row.insiderRole}</span>
        )}
      </span>
      <span className={`insider-row__action ${isBuy ? "text-bull" : "text-bear"}`}>
        {isBuy ? "bought" : "sold"}
      </span>
      <span className="insider-row__detail text-faint">
        {sharesLabel}
        {valueLabel}
      </span>
      <span className="insider-row__date text-faint">{fmtShortDate(row.date)}</span>
      <IconExternal size={11} className="insider-row__ext" />
    </ExternalLink>
  );
}

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
 * Real SEC EDGAR filing activity for this ticker - insider transactions (Form 4)
 * and material events (8-K), straight from the regulator. Shows trailing-90d
 * counts, an optional parsed Form 4 buy/sell breakdown, and direct links to each
 * filing. Renders nothing when there is no activity. Discovery/research only.
 */
export function SecFilingsPanel({
  activity,
  form4Summary,
  form4Loading,
  limit = 8,
}: SecFilingsPanelProps) {
  // `filings` is optional in practice: a `secActivity` can arrive with only the
  // aggregate counts (e.g. the insider-cluster rollup) and no per-filing list, or
  // be a cached/older shape where the array is absent. Default to [] so the panel
  // shows the counts honestly instead of crashing the whole detail page.
  const rows = (activity.filings ?? []).slice(0, limit);
  const hasTrades = Boolean(form4Summary && form4Summary.buys + form4Summary.sells > 0);

  return (
    <section className="sec-panel" aria-label="SEC filings">
      <div className="sec-panel__head">
        <span className="sec-panel__title">SEC filings</span>
        <span className="sec-panel__count text-faint">last 90 days</span>
      </div>

      <div className="sec-stats">
        <div className="sec-stat">
          <span className="sec-stat__value">{activity.form4Count90d}</span>
          <span className="sec-stat__label text-faint">Insider (Form 4)</span>
        </div>
        <div className="sec-stat">
          <span className="sec-stat__value">{activity.eightKCount90d}</span>
          <span className="sec-stat__label text-faint">Material (8-K)</span>
        </div>
      </div>

      {form4Loading && (
        <div className="sec-panel__form4-skeleton" aria-hidden>
          <Skeleton width="72%" height={12} />
          <Skeleton width="88%" height={12} style={{ marginTop: 6 }} />
          <Skeleton width="65%" height={12} style={{ marginTop: 6 }} />
        </div>
      )}

      {!form4Loading && hasTrades && (
        <>
          {/* Net summary badge */}
          <p
            className="sec-panel__form4"
            title="Counts open-market buys (P) and sells (S) only. Buys are the cleaner conviction signal; some sells are routine or pre-scheduled (10b5-1) and grants/option exercises are excluded."
          >
            <span className="sec-stat__label text-faint">Insider trades:</span>{" "}
            <span
              className={
                form4Summary!.netValue > 0
                  ? "sec-net sec-net--buy"
                  : form4Summary!.netValue < 0
                    ? "sec-net sec-net--sell"
                    : "sec-net"
              }
            >
              {form4Summary!.summary}
            </span>
            <span className="text-faint"> · {form4Summary!.filingsParsed} parsed</span>
          </p>

          {/* Per-insider Bloomberg-style rows */}
          {form4Summary!.insiderRows.length > 0 && (
            <div className="insider-rows" aria-label="Insider transactions">
              {form4Summary!.insiderRows.map((row, i) => (
                <InsiderTradeRow key={`${row.insiderName}-${row.date}-${i}`} row={row} />
              ))}
            </div>
          )}
        </>
      )}

      {!form4Loading && form4Summary && !hasTrades && (
        <p className="sec-panel__form4 text-faint">
          Recent Form 4s are grants / option exercises — no open-market buys or sells.
        </p>
      )}

      {rows.length > 0 && (
        <div className="sec-list">
          {rows.map((filing, i) => (
            <ExternalLink
              key={`${filing.form}-${filing.filedAt}-${i}`}
              href={filing.url}
              className="sec-row"
              title={`${FORM_LABEL[filing.form] ?? filing.form} filed ${formatDay(filing.filedAt)}`}
            >
              <span className={`sec-tag sec-tag--${filing.form === "4" ? "form4" : "eightk"}`}>
                {FORM_LABEL[filing.form] ?? filing.form}
              </span>
              <span className="grow text-faint">{formatDay(filing.filedAt)}</span>
              <IconExternal size={12} className="sec-row__ext" />
            </ExternalLink>
          ))}
        </div>
      )}

      <p className="text-faint sec-panel__foot">
        {hasTrades && (
          <>
            Open-market buys (P) are the cleaner signal; some sells are routine or pre-planned (10b5-1 plan). US EDGAR only — Canadian insider filings (TSX) use SEDI.{" "}
          </>
        )}
        Source: SEC EDGAR (Forms 4 &amp; 8-K). Research only — not investment advice.
      </p>
    </section>
  );
}
