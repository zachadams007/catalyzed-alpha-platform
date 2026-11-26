import type { PortfolioHolding, PortfolioSplitAdjustment } from "@/types";
import type { StockSplitEvent } from "@/data/corporateActions/splits";

/**
 * Pure split-adjustment engine for portfolio holdings - no React, no store,
 * fully testable. Fixes the "phantom market value" bug: a held position kept
 * its OLD share count after a reverse split, so `shares × post-split price`
 * produced a ~10x inflated value (and the same inflated value fed the "Today"
 * day-change dollar figure every single day). This module computes the patch
 * that RESCALES `shares`/`costBasis` - it never touches price/value math
 * directly (that stays in `portfolioAnalytics.ts`).
 *
 * Safety rules (binding - see the split-adjustment feature spec):
 *   - NEVER silently rewrite: every rescale is recorded as a
 *     `PortfolioSplitAdjustment` audit trail the UI must surface as a
 *     dismissible note with an Undo.
 *   - NEVER double-adjust: a split whose `effectiveDate` predates the
 *     holding's `addedAt` is assumed to be already reflected in the entered
 *     shares (the user typed in post-split terms) and is skipped.
 *   - Idempotent: a split date already folded into `appliedDates`, or one the
 *     user explicitly rejected via Undo (`rejectedSplitDates`), is never
 *     re-applied.
 */

/** The subset of `PortfolioHolding` fields a detected split rescales. */
export interface SplitAdjustmentPatch {
  shares: number;
  costBasis?: number;
  splitAdjustment: PortfolioSplitAdjustment;
}

/**
 * Given a holding and the known split events for its ticker, decide whether a
 * NEW rescale should be applied. Returns `null` when nothing changes (no
 * shares tracked, no pending splits, or every known split predates the
 * holding / was already applied / was already rejected by the user).
 */
export function computeSplitAdjustment(
  holding: PortfolioHolding,
  events: StockSplitEvent[],
): SplitAdjustmentPatch | null {
  if (!holding.shares || holding.shares <= 0) return null;
  if (events.length === 0) return null;

  const addedDate = holding.addedAt.slice(0, 10);
  const alreadyHandled = new Set([
    ...(holding.splitAdjustment?.appliedDates ?? []),
    ...(holding.rejectedSplitDates ?? []),
  ]);

  // Only splits that happened strictly AFTER the lot was added (a lot added
  // ON or before a split's effective date is assumed entered in post-split
  // terms already) and not yet applied or explicitly rejected.
  const pending = events
    .filter((event) => event.effectiveDate > addedDate)
    .filter((event) => !alreadyHandled.has(event.effectiveDate))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (pending.length === 0) return null;

  // Compound multiple splits detected since the last check (rare, but a
  // holding can span more than one corporate action while it's held).
  const incrementalFactor = pending.reduce((acc, event) => acc * event.factor, 1);
  const newShares = holding.shares * incrementalFactor;
  const newCostBasis = holding.costBasis != null ? holding.costBasis / incrementalFactor : undefined;

  const latest = pending[pending.length - 1]!;
  const label = pending.length === 1 ? latest.label : `${pending.length} splits since your entry (latest: ${latest.label})`;

  const priorAdjustment = holding.splitAdjustment;
  const cumulativeFactor = (priorAdjustment?.factor ?? 1) * incrementalFactor;

  return {
    shares: newShares,
    costBasis: newCostBasis,
    splitAdjustment: {
      factor: cumulativeFactor,
      appliedDates: [...(priorAdjustment?.appliedDates ?? []), ...pending.map((event) => event.effectiveDate)],
      label,
      appliedAt: new Date().toISOString(),
      // Set once, on the FIRST-ever adjustment - `holding.shares`/`costBasis`
      // here are still the pre-patch (current) values, which on a first
      // application are exactly the user's originally-entered numbers.
      originalShares: priorAdjustment?.originalShares ?? holding.shares,
      originalCostBasis: priorAdjustment ? priorAdjustment.originalCostBasis : holding.costBasis,
      // A fresh split deserves a fresh notice even if an earlier one was dismissed.
      dismissedAt: undefined,
    },
  };
}

/** Render a split factor as a "1:X" (reverse) or "X:1" (forward) ratio string. */
export function formatSplitRatio(factor: number): string {
  const clean = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  if (factor > 0 && factor < 1) return `1:${clean(1 / factor)}`;
  return `${clean(factor)}:1`;
}
