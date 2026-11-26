import { TESTING_HOLDINGS, demoHoldingPriceSeries } from "@/data/demoHoldings";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { reconstructBasketSeries } from "@/engine/portfolioHistory";
import type {
  Portfolio,
  PortfolioHolding,
  PortfolioMode,
  PortfolioValuePoint,
} from "@/types";

/**
 * Seed portfolios shipped with the MVP. We ship exactly ONE owned demo book -
 * "TESTING" - a fully tracked sample (shares + cost on real research-universe
 * tickers) so every premium portfolio surface lights up out of the box: the
 * value-morph donut, best/worst vitals, the progression chart and the holding
 * inspector. It is SAMPLE-ONLY; a live tester never sees it (see
 * {@link seedPortfoliosForMode}).
 */

// On-brand mode identity colors. Values are design tokens (defined in
// tokens.css) so they stay in the azure/cobalt/violet/gold/coral family and
// never drift back to the forbidden green. Consumed as `--portfolio-accent`.
export const MODE_ACCENT: Record<PortfolioMode, string> = {
  "High Volatility Catalyst": "var(--pf-mode-catalyst)",
  "Small Cap Momentum": "var(--pf-mode-momentum)",
  "Fundamental Growth": "var(--pf-mode-growth)",
  "Political/News Heat": "var(--pf-mode-political)",
  "Balanced Aggressive": "var(--pf-mode-balanced)",
  Custom: "var(--pf-mode-custom)",
};

export const PORTFOLIO_MODES: PortfolioMode[] = [
  "High Volatility Catalyst",
  "Small Cap Momentum",
  "Fundamental Growth",
  "Political/News Heat",
  "Balanced Aggressive",
  "Custom",
];

const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** Fictional id that must never reach a live (sample-OFF) tester's Portfolios. */
export const FAKE_TEST_PORTFOLIO_ID = "pf_fake_test";

/**
 * Bake a TRUE, non-linear value history for the demo book straight from the
 * holdings' own price series (see {@link demoHoldingPriceSeries}). This
 * guarantees the progression chart renders a real curve out of the box - and that
 * the curve is consistent with the holdings' analytics rather than a faked smooth
 * line - independent of whichever research universe is loaded.
 */
function bakeValueHistory(holdings: PortfolioHolding[]): PortfolioValuePoint[] {
  const { series, coverageCount } = reconstructBasketSeries(
    holdings,
    (ticker) => demoHoldingPriceSeries(ticker),
  );
  return series.map((point) => ({ date: point.date, value: point.close, valuedCount: coverageCount }));
}

/** The canonical, fully-working "TESTING" demo book - the repair target. */
function buildTestingBook(): Portfolio {
  return {
    id: FAKE_TEST_PORTFOLIO_ID,
    name: "TESTING",
    mode: "Balanced Aggressive",
    description: "Sample tracked book — what your own portfolio looks like once shares and cost are in.",
    owner: "me",
    isPublic: false,
    createdAt: iso(10),
    updatedAt: iso(0),
    holdings: TESTING_HOLDINGS,
    valueHistory: bakeValueHistory(TESTING_HOLDINGS),
  };
}

export const SEED_PORTFOLIOS: Portfolio[] = [buildTestingBook()];

/**
 * The portfolios the store should seed for the CURRENT data mode.
 *
 * The demo book is SAMPLE-ONLY. A live tester (sample mode OFF - the default on
 * the hosted build) must start with an empty Portfolios tab and the real empty
 * state: the fictional "TESTING" book, and the net-worth summary it drives, must
 * never render as if it were the user's real money.
 */
export function seedPortfoliosForMode(): Portfolio[] {
  return isSampleDataModeEnabled() ? SEED_PORTFOLIOS : [];
}

/**
 * The exact ticker sets the two OWNED demo books shipped with BEFORE they were
 * given tracked positions. The persist migration uses these to recognise a
 * still-pristine sample book and upgrade it in place - see
 * {@link applyTrackedDemoSeed}.
 */
const LEGACY_OWNED_SEED_TICKERS: Record<string, string[]> = {
  pf_my_catalyst: ["COIN", "PLTR", "SMCI", "RIVN", "SOFI"],
  pf_my_ai: ["NVDA", "AMD", "GOOG", "MSFT", "ORCL"],
};

/** A book is "pristine sample" only if nothing about it has been touched. */
function isPristineLegacySeed(book: Portfolio): boolean {
  if (book.owner !== "me") return false;
  const legacy = LEGACY_OWNED_SEED_TICKERS[book.id];
  if (!legacy) return false;
  if ((book.valueHistory?.length ?? 0) > 0) return false;
  // Untouched means still watch-only (no shares/value/cost on any holding)…
  const watchOnly = book.holdings.every(
    (h) => h.shares == null && h.value == null && h.costBasis == null,
  );
  if (!watchOnly) return false;
  // …and the holdings are exactly the originally-seeded tickers.
  if (book.holdings.length !== legacy.length) return false;
  const tickers = new Set(book.holdings.map((h) => h.ticker));
  return legacy.every((t) => tickers.has(t));
}

/**
 * One-time, NON-DESTRUCTIVE upgrade run by the persist migration: swap the two
 * sample OWNED demo books for their new tracked seed ONLY when they are still
 * the original, untouched watch-only sample. Any book the user has edited - and
 * every real uploaded portfolio (different ids) - is preserved byte-for-byte.
 */
export function applyTrackedDemoSeed(portfolios: Portfolio[] | undefined): Portfolio[] {
  if (!portfolios || portfolios.length === 0) return SEED_PORTFOLIOS;
  const seedById = new Map(SEED_PORTFOLIOS.map((p) => [p.id, p]));
  return portfolios.map((book) => {
    const upgraded = seedById.get(book.id);
    return upgraded && isPristineLegacySeed(book) ? upgraded : book;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// One-shot cleanup - collapse a messy Portfolios tab down to the books that
// matter, SAFELY.
// ──────────────────────────────────────────────────────────────────────────

/**
 * The name a *half-deleted* (now empty) copy of the demo may still carry. Used
 * ONLY to recognise an empty leftover for repair - never to classify a populated
 * book, since the name is user-controlled and "Testing" is a likely real-import
 * name.
 */
const TESTING_NAME_RE = /^\s*testing\s*$|fake portfolio for testing/i;

/**
 * Reconcile a persisted portfolio set down to the user's REAL books plus a
 * single, repaired "TESTING" demo - the explicit, safe "delete everything else"
 * cleanup. Runs once (v22 migration) for EVERY install, so safety is paramount.
 *
 * Safety contract:
 *  • Any owned book WITH HOLDINGS is REAL data and is KEPT byte-for-byte -
 *    never deleted, never mutated, never overwritten. Classification never
 *    depends on the (user-controlled) name or on whether shares are filled in,
 *    so a watch-only imported book named "Testing" is just as safe as
 *    "Brokerage".
 *  • The fictional demo is identified ONLY by its fixed id, or by an EMPTY
 *    leftover still carrying the demo name (a half-deleted copy with no data to
 *    lose). It is repaired/seeded ONLY in sample mode - a live tester never sees
 *    a fictional book driving a fake net worth.
 *  • Everything else - empty/half-deleted junk books, public sample books
 *    (owner ≠ "me", reseeded from code) and duplicate empty demo copies - is
 *    dropped.
 */
export function cleanupPortfolios(
  portfolios: Portfolio[] | undefined,
  opts: { sampleMode: boolean },
): Portfolio[] {
  const own = (portfolios ?? []).filter((p) => p.owner === "me");

  // Real books to PRESERVE: owned, has holdings, and not the shipped demo id.
  const realKeeps = own.filter(
    (p) => p.id !== FAKE_TEST_PORTFOLIO_ID && p.holdings.length > 0,
  );

  // Demo / repairable leftovers: the fixed demo id, or an EMPTY book still named
  // like the demo (lost its id but has no real data).
  const demoLeftovers = own.filter(
    (p) =>
      p.id === FAKE_TEST_PORTFOLIO_ID ||
      (p.holdings.length === 0 && TESTING_NAME_RE.test(p.name)),
  );

  let testing: Portfolio | null = null;
  if (opts.sampleMode) {
    // Sample mode shows the demo. Repair an existing copy in place so its id/name
    // survive; otherwise seed a fresh one, but only when the tab is otherwise
    // empty (don't clutter a tab that already has the user's real books).
    const existing =
      demoLeftovers.find((p) => p.id === FAKE_TEST_PORTFOLIO_ID) ?? demoLeftovers[0];
    if (existing) {
      testing =
        existing.id === FAKE_TEST_PORTFOLIO_ID
          ? buildTestingBook()
          : { ...buildTestingBook(), id: existing.id, name: existing.name.trim() || "TESTING" };
    } else if (realKeeps.length === 0) {
      testing = buildTestingBook();
    }
  }
  // Live mode: the demo + any empty leftovers are simply dropped - a real tester
  // keeps only their own (populated) books.

  return testing ? [...realKeeps, testing] : [...realKeeps];
}
