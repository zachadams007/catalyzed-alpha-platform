import { clamp } from "@/lib/math";
import {
  getUsageSnapshot,
  SAFE_DEFAULT_BUDGETS,
  type ApiVendorId,
} from "@/lib/apiUsage";

/**
 * Budget-derived sizing for the full-market funnel.
 *
 * The funnel's top-N must fit inside the day's remaining free-tier allowance, or
 * a 300-name run would blow past the budgets and start failing mid-run. We
 * estimate the per-name enrichment cost for each vendor, read how much budget is
 * left today, and pick the largest N that every vendor can still afford (with a
 * safety headroom). This is the "N capped from remaining budget" guard from the
 * build handoff - Stage 0 itself is a single cached call and is not counted here.
 */

/** Aim for roughly this many names; budget shrinks it when the day is spent. */
export const FUNNEL_TARGET_MAX = 300;
/** Below this, the funnel is doing little better than the curated universe. */
export const FUNNEL_TARGET_MIN = 80;

/**
 * Estimated enrichment calls PER NAME, per vendor, during one research run.
 * Conservative (rounds up) so we under-size rather than over-spend. Yahoo is
 * usually the binding constraint (price history + headline RSS, tight budget).
 */
const PER_NAME_CALLS: Partial<Record<ApiVendorId, number>> = {
  yahoo: 2,
  finnhub: 1.2,
  sec: 1,
  stocktwits: 1,
  fmp: 0.3,
  apewisdom: 0.15,
};

export interface FunnelBudget {
  /** Names the funnel may hydrate + score this run. */
  n: number;
  /** The vendor whose remaining budget capped N (null when nothing bound it). */
  binding: ApiVendorId | null;
  /** Remaining daily budget per vendor that fed the calc (telemetry). */
  remainingByVendor: Partial<Record<ApiVendorId, number>>;
}

/**
 * PURE core: pick the largest N every vendor can still afford. `remainingByVendor`
 * is each vendor's remaining DAILY calls (omit / Infinity = unconstrained). N is
 * clamped to [0, targetMax]; the budget - not a floor - decides the lower bound,
 * so a nearly-spent day yields a smaller honest run rather than a blowout.
 */
export function computeFunnelSize(
  remainingByVendor: Partial<Record<ApiVendorId, number>>,
  opts: { targetMax?: number; headroom?: number } = {},
): FunnelBudget {
  const targetMax = opts.targetMax ?? FUNNEL_TARGET_MAX;
  const headroom = opts.headroom ?? 0.8;

  let n = targetMax;
  let binding: ApiVendorId | null = null;

  for (const [vendor, perName] of Object.entries(PER_NAME_CALLS) as Array<[ApiVendorId, number]>) {
    if (!perName || perName <= 0) continue;
    const remaining = remainingByVendor[vendor];
    if (remaining == null || !Number.isFinite(remaining)) continue; // unconstrained
    const affordable = Math.floor((Math.max(0, remaining) * headroom) / perName);
    if (affordable < n) {
      n = affordable;
      binding = vendor;
    }
  }

  return { n: clamp(Math.floor(n), 0, targetMax), binding, remainingByVendor };
}

/**
 * Read the live usage ledger and derive the funnel size for right now. Remaining
 * per vendor = its daily budget (operator override, else SAFE_DEFAULT_BUDGETS)
 * minus today's calls. Vendors without a finite daily budget are unconstrained.
 */
export function deriveFunnelSize(opts: { now?: number; targetMax?: number; headroom?: number } = {}): FunnelBudget {
  const snap = getUsageSnapshot(opts.now);
  const remainingByVendor: Partial<Record<ApiVendorId, number>> = {};
  for (const vendor of snap.vendors) {
    const id = vendor.meta.id;
    const budget = vendor.budget ?? SAFE_DEFAULT_BUDGETS[id];
    if (budget == null || !Number.isFinite(budget)) continue;
    remainingByVendor[id] = Math.max(0, budget - vendor.today);
  }
  return computeFunnelSize(remainingByVendor, {
    targetMax: opts.targetMax,
    headroom: opts.headroom,
  });
}
