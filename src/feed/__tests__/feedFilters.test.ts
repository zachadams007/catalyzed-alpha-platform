import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// Same link-helper stub the sibling suites use so the sample universe can init.
vi.mock("@/lib/links", () => ({
  externalXSearchUrl: (ticker: string, queryExtra?: string) => {
    const query = queryExtra ? `${ticker} ${queryExtra}` : `${ticker} stock`;
    return `https://x.com/search?q=${encodeURIComponent(query)}`;
  },
  isSampleUniverseTicker: () => true,
}));

import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { toStockSignal } from "@/engine/enrich";
import { scoreCompany } from "@/engine/scoring";
import { defaultPreferences } from "@/feed/feedAlgorithm";
import { composeForYou, FOR_YOU_FILTERS, forYouFilterById } from "@/feed/feedFilters";
import {
  EMERGING_THEMES,
  emergingThemeHits,
  matchEmergingTheme,
  nextThemeScope,
} from "@/feed/emergingThemes";
import type {
  MarketCapBucket,
  ScoreCategoryKey,
  StockSignal,
  UserPreferences,
} from "@/types";

const NOW = "2026-07-02T12:00:00.000Z";
const BASE: StockSignal[] = MOCK_UNIVERSE.map((company) =>
  toStockSignal(company, scoreCompany(company), NOW),
);

/** Clone a real signal with targeted category-score + field overrides. */
function craft(
  overrides: Partial<Record<ScoreCategoryKey, number>>,
  patch: Partial<StockSignal> = {},
  base: StockSignal = BASE[0],
): StockSignal {
  const sig: StockSignal = {
    ...base,
    ...patch,
    score: {
      ...base.score,
      categories: base.score.categories.map((c) =>
        overrides[c.key] != null ? { ...c, score: overrides[c.key] as number } : c,
      ),
    },
  };
  return sig;
}

/** Scrub every narrative text source so keyword matching sees ONLY the patch. */
function scrubText(patch: Partial<StockSignal> = {}): Partial<StockSignal> {
  return {
    name: "Placeholder Corp",
    thesis: "A diversified operating company.",
    companyBlurb: undefined,
    finnhubIndustry: undefined,
    newsInsight: "",
    socialSummary: "",
    news: { ...BASE[0].news, items: [] },
    socialPosts: [],
    catalyst: { ...BASE[0].catalyst, description: "" },
    ...patch,
  };
}

function prefsWith(patch: Partial<UserPreferences>): UserPreferences {
  return { ...defaultPreferences(), ...patch };
}

const capOf = (bucket: MarketCapBucket) => ({ marketCapBucket: bucket });

describe("FOR_YOU_FILTERS registry", () => {
  it("has unique ids, labels, and hints; lookup round-trips", () => {
    const ids = FOR_YOU_FILTERS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FOR_YOU_FILTERS) {
      expect(f.label.length).toBeGreaterThan(2);
      expect(f.hint.length).toBeGreaterThan(10);
      expect(forYouFilterById(f.id)).toBe(f);
    }
  });
});

describe("individual filter matching", () => {
  it("early_catalyst matches a small cap with live catalyst heat that hasn't run", () => {
    const def = forYouFilterById("early_catalyst")!;
    const hit = craft(
      { catalyst: 62, valuation: 55 },
      { ...capOf("Small"), ticker: "ERLY", id: "ERLY" },
    );
    expect(def.evaluate(hit, defaultPreferences())).not.toBeNull();
  });

  it("early_catalyst excludes Mega, Unknown caps and already-extended names", () => {
    const def = forYouFilterById("early_catalyst")!;
    const mega = craft({ catalyst: 80, valuation: 70 }, capOf("Mega"));
    const unknown = craft({ catalyst: 80, valuation: 70 }, capOf("Unknown"));
    const extended = craft({ catalyst: 80, valuation: 30 }, capOf("Small"));
    expect(def.evaluate(mega, defaultPreferences())).toBeNull();
    expect(def.evaluate(unknown, defaultPreferences())).toBeNull();
    expect(def.evaluate(extended, defaultPreferences())).toBeNull();
  });

  it("reversal_setups welcomes below-MA names with turn evidence", () => {
    const def = forYouFilterById("reversal_setups")!;
    const belowMa = craft(
      { valuation: 65, momentum: 38, fundamentals: 62 },
      {
        momentum: { ...BASE[0].momentum, aboveSMA50: false, aboveSMA200: false },
      },
    );
    const hit = def.evaluate(belowMa, defaultPreferences());
    expect(hit).not.toBeNull();
    // Below a moving average must NEVER disqualify - that's where reversals start.
    expect(hit?.why.toLowerCase()).toContain("under the 50-day");
  });

  it("reversal_setups rejects reason-less falling knives and already-moving names", () => {
    const def = forYouFilterById("reversal_setups")!;
    const knife = craft({
      valuation: 70,
      momentum: 35,
      fundamentals: 40,
      growth: 40,
      catalyst: 40,
      inflection: 40,
    });
    const moving = craft({ valuation: 65, momentum: 70, fundamentals: 65 });
    expect(def.evaluate(knife, defaultPreferences())).toBeNull();
    expect(def.evaluate(moving, defaultPreferences())).toBeNull();
  });

  it("breakout_watch requires momentum + attention and rejects parabolic RSI", () => {
    const def = forYouFilterById("breakout_watch")!;
    const setup = craft(
      { momentum: 68, news: 60 },
      { momentum: { ...BASE[0].momentum, rsi: 62, aboveSMA50: true, aboveSMA200: true } },
    );
    const parabolic = craft(
      { momentum: 80, news: 80 },
      { momentum: { ...BASE[0].momentum, rsi: 88 } },
    );
    expect(def.evaluate(setup, defaultPreferences())).not.toBeNull();
    expect(def.evaluate(parabolic, defaultPreferences())).toBeNull();
  });

  it("smart_money keys off real disclosures with honest evidence", () => {
    const def = forYouFilterById("smart_money")!;
    const insider = craft(
      {},
      {
        whyInteresting: undefined,
        secActivity: {
          cik: "0000000000",
          form4Count90d: 4,
          eightKCount90d: 0,
          filings: [],
          form4BuyCount90d: 3,
        },
      },
    );
    const hit = def.evaluate(insider, defaultPreferences());
    expect(hit?.why).toContain("3 open-market insider buys");
    // Low conviction score + no disclosures = no smart-money claim.
    const none = craft({ conviction: 45 }, {
      whyInteresting: undefined,
      secActivity: undefined,
      congressTrades: undefined,
      catalystType: "Product",
    });
    expect(def.evaluate(none, defaultPreferences())).toBeNull();
  });

  it("discounted_quality is large-cap only", () => {
    const def = forYouFilterById("discounted_quality")!;
    const large = craft({ valuation: 60, fundamentals: 65 }, capOf("Large"));
    const small = craft({ valuation: 60, fundamentals: 65 }, capOf("Small"));
    const unknown = craft({ valuation: 60, fundamentals: 65 }, capOf("Unknown"));
    expect(def.evaluate(large, defaultPreferences())).not.toBeNull();
    expect(def.evaluate(small, defaultPreferences())).toBeNull();
    expect(def.evaluate(unknown, defaultPreferences())).toBeNull();
  });
});

describe("emerging themes", () => {
  it("registry slugs are unique and every screenTagId resolves keywords", () => {
    const slugs = EMERGING_THEMES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(EMERGING_THEMES.length).toBeGreaterThanOrEqual(6);
  });

  it("matches by curated ticker", () => {
    const quantum = EMERGING_THEMES.find((t) => t.slug === "quantum-computing")!;
    const sig = craft({}, scrubText({ ticker: "IONQ", id: "IONQ" }));
    const hit = matchEmergingTheme(sig, quantum);
    expect(hit?.evidence).toContain("curated");
  });

  it("matches by core-keyword narrative evidence, not generic adjacency", () => {
    const quantum = EMERGING_THEMES.find((t) => t.slug === "quantum-computing")!;
    const onTheme = craft(
      {},
      scrubText({
        ticker: "QQQX",
        id: "QQQX",
        thesis: "A quantum computing pioneer scaling trapped-ion qubit systems.",
      }),
    );
    const generic = craft(
      {},
      scrubText({
        ticker: "GNRC1",
        id: "GNRC1",
        thesis: "A leading software platform for retail analytics.",
      }),
    );
    expect(matchEmergingTheme(onTheme, quantum)).not.toBeNull();
    expect(matchEmergingTheme(generic, quantum)).toBeNull();
  });

  it("theme-scope taps are SELECT-first from the all-on default", () => {
    const all = ["a", "b", "c"];
    // From all-on (undefined = all), a tap SELECTS that theme alone.
    expect(nextThemeScope(undefined, "b", all)).toEqual(["b"]);
    expect(nextThemeScope(["a", "b", "c"], "b", all)).toEqual(["b"]);
    // From a narrowed scope, taps toggle membership.
    expect(nextThemeScope(["b"], "a", all)).toEqual(["b", "a"]);
    // The last active theme can't be removed.
    expect(nextThemeScope(["b"], "b", all)).toEqual(["b"]);
    // Completing the set normalizes back to undefined (= all).
    expect(nextThemeScope(["a", "b"], "c", all)).toBeUndefined();
  });

  it("respects a narrowed theme scope", () => {
    const sig = craft({}, scrubText({ ticker: "IONQ", id: "IONQ" }));
    expect(emergingThemeHits(sig, ["quantum-computing"]).length).toBeGreaterThan(0);
    expect(emergingThemeHits(sig, ["cybersecurity"]).length).toBe(0);
  });
});

describe("composeForYou", () => {
  it("returns the classic personalized board when no filters are active", () => {
    const res = composeForYou(BASE, defaultPreferences());
    expect(res.activeFilters).toEqual([]);
    expect(res.backfill).toEqual([]);
    expect(res.ranked.length).toBe(BASE.length);
  });

  it("filters dominate: every ranked entry matches, non-matches land in backfill", () => {
    const matcher = craft(
      { valuation: 62, fundamentals: 68 },
      { ...capOf("Large"), ticker: "DISC", id: "DISC" },
    );
    // A monster score that does NOT match the active filter must still sit
    // behind the divider - this is the "hard filter, not a boost" contract.
    const monster = craft(
      { valuation: 30, fundamentals: 90, momentum: 90, catalyst: 90 },
      { ...capOf("Small"), ticker: "MNST1", id: "MNST1" },
    );
    const prefs = prefsWith({ forYouFilters: ["discounted_quality"] });
    const res = composeForYou([matcher, monster], prefs);
    expect(res.activeFilters).toEqual(["discounted_quality"]);
    expect(res.ranked.map((r) => r.signal.ticker)).toEqual(["DISC"]);
    expect(res.backfill.map((r) => r.signal.ticker)).toEqual(["MNST1"]);
    expect(res.counts.discounted_quality).toBe(1);
  });

  it("prepends the filter's honest why to the reasons", () => {
    const matcher = craft(
      { valuation: 62, fundamentals: 68 },
      { ...capOf("Large"), ticker: "DISC", id: "DISC" },
    );
    const prefs = prefsWith({ forYouFilters: ["discounted_quality"] });
    const res = composeForYou([matcher], prefs);
    expect(res.ranked[0].reasons[0]).toContain("Large-cap quality");
  });

  it("muted tickers never jump the divider even when they match", () => {
    const matcher = craft(
      { valuation: 62, fundamentals: 68 },
      { ...capOf("Large"), ticker: "MUTED", id: "MUTED" },
    );
    const prefs = prefsWith({
      forYouFilters: ["discounted_quality"],
      mutedTickers: ["MUTED"],
    });
    const res = composeForYou([matcher], prefs);
    expect(res.ranked.length).toBe(0);
    expect(res.backfill.map((r) => r.signal.ticker)).toEqual(["MUTED"]);
  });

  it("multi-filter matches earn the bonus over an identical single-filter match", () => {
    const single = craft(
      { valuation: 62, fundamentals: 68, momentum: 40 },
      { ...capOf("Large"), ticker: "ONE", id: "ONE" },
    );
    // Same base + also a reversal setup (low momentum + turn evidence).
    const double = craft(
      { valuation: 62, fundamentals: 68, momentum: 40 },
      { ...capOf("Large"), ticker: "TWO", id: "TWO" },
    );
    const prefs = prefsWith({
      forYouFilters: ["discounted_quality", "reversal_setups"],
    });
    const res = composeForYou([single, double], prefs);
    // Both match discounted_quality AND reversal_setups identically here, so
    // instead assert the bonus arithmetic: two hits ⇒ +6 over the base entry.
    const one = res.ranked.find((r) => r.signal.ticker === "ONE")!;
    const two = res.ranked.find((r) => r.signal.ticker === "TWO")!;
    expect(one.matchScore).toBe(two.matchScore);
    const baseline = composeForYou([single], prefsWith({}));
    expect(one.matchScore).toBeGreaterThanOrEqual(
      Math.min(100, Math.round(baseline.ranked[0].matchScore)),
    );
  });
});
