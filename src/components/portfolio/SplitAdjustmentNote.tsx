import { IconInfo, IconRefresh } from "@/components/icons";
import { formatSplitRatio } from "@/engine/portfolioSplits";
import type { PortfolioSplitAdjustment } from "@/types";
import { useAppStore } from "@/store/useAppStore";

/**
 * Render a YYYY-MM-DD calendar date (a split's effective date has no time
 * component) without an off-by-one shift. `new Date("2026-06-02")` parses as
 * UTC midnight, so formatting it in a timezone behind UTC (e.g. US Eastern)
 * would otherwise print the PRIOR day. Force `timeZone: "UTC"` so the
 * calendar date shown always matches the date stored.
 */
function formatEffectiveDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Visible, dismissible note surfaced on a holding once a REAL detected stock
 * split has rescaled its shares/costBasis - never a silent rewrite. Reuses the
 * existing `.pf-warning` info-tone primitive (see `PortfolioVitals.tsx`) so it
 * reads as part of the same design system rather than a bespoke banner.
 * `compact` renders it for the holdings table row; the fuller form is used in
 * the Holding Inspector drill-down.
 */
export function SplitAdjustmentNote({
  portfolioId,
  ticker,
  adjustment,
  compact,
}: {
  portfolioId: string;
  ticker: string;
  adjustment: PortfolioSplitAdjustment;
  compact?: boolean;
}) {
  const undoSplitAdjustment = useAppStore((s) => s.undoSplitAdjustment);
  const dismissSplitAdjustmentNote = useAppStore((s) => s.dismissSplitAdjustmentNote);

  const latestDate = adjustment.appliedDates[adjustment.appliedDates.length - 1];
  const dateLabel = formatEffectiveDate(latestDate);
  const ratio = formatSplitRatio(adjustment.factor);

  return (
    <div className={`pf-warning pf-warning--info split-note${compact ? " split-note--compact" : ""}`}>
      <span className="pf-warning__icon" aria-hidden>
        <IconInfo size={15} />
      </span>
      <div className="split-note__body">
        <strong className="pf-warning__title">
          Adjusted for a {ratio} split{dateLabel ? ` on ${dateLabel}` : ""}
        </strong>
        <p className="pf-warning__detail">
          {ticker}&rsquo;s shares and average cost were rescaled ({adjustment.label}) so its value and
          today&rsquo;s move stay accurate — not a real price jump, just a data correction. Not right? Undo
          restores exactly what you originally entered.
        </p>
        <div className="split-note__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => undoSplitAdjustment(portfolioId, ticker)}
          >
            <IconRefresh size={14} />
            Undo
          </button>
          {!adjustment.dismissedAt && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => dismissSplitAdjustmentNote(portfolioId, ticker)}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
