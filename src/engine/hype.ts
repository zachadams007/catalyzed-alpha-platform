import type {
  CompanyData,
  HypeDriver,
  HypeDriverKey,
  HypeScore,
  HypeTier,
  ScoreBreakdown,
  ScoreCategoryKey,
} from "@/types";
import { formatPct, formatPctPlain } from "@/lib/format";

/**
 * The hype layer - a composite "is this about to move?" read that is distinct
 * from the opportunity score. Where the opportunity score balances quality and
 * risk, hype tilts hard toward FRESHNESS and ATTENTION TIMING: an imminent
 * catalyst, a live news burst, a social spike, congressional buying.
 *
 * It is a PURE function and produces STRUCTURED drivers (label + concrete detail
 * + points), never free-form prose - the card renders it as an interactive strip.
 */

/** Hype-specific blend weights (sum to 1.0) - heavily catalyst/news/attention. */
const HYPE_WEIGHTS: Record<HypeDriverKey, number> = {
  catalyst: 0.26,
  news: 0.24,
  social: 0.18,
  political: 0.12,
  momentum: 0.12,
  volatility: 0.08,
};

const DRIVER_LABEL: Record<HypeDriverKey, string> = {
  catalyst: "Catalyst timing",
  news: "Fresh news",
  social: "Social buzz",
  political: "Congress / insider",
  momentum: "Momentum",
  volatility: "Volatility",
};

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function scale(value: number, lo: number, hi: number): number {
  if (hi === lo) return 0;
  return clamp100(((value - lo) / (hi - lo)) * 100);
}

function categoryScore(breakdown: ScoreBreakdown, key: ScoreCategoryKey): number {
  return breakdown.categories.find((c) => c.key === key)?.score ?? 0;
}

function catalystDetail(c: CompanyData): string {
  if (c.catalystLive === false) return "No dated catalyst in the feed yet";
  const { type, daysAway } = c.catalyst;
  const timing =
    daysAway < 0 ? `${Math.abs(daysAway)}d ago` : daysAway === 0 ? "today" : `in ${daysAway}d`;
  return `${type} catalyst ${timing}`;
}

function newsDetail(c: CompanyData): string {
  const fresh = Math.round(c.news.freshnessHours);
  return `${c.news.count7d} stories · freshest ${fresh}h ago`;
}

function socialDetail(c: CompanyData): string {
  const mentions = c.social.redditMentions24h + c.social.xMentions24h;
  return `${mentions.toLocaleString("en-US")} mentions · ${formatPct(c.social.trendDelta)} DoD`;
}

/** Combined recent insider (Form 4) + material-event (8-K) filing count. */
function secActivityCount(c: CompanyData): number {
  const a = c.secActivity;
  return a ? a.form4Count90d + a.eightKCount90d : 0;
}

function politicalDetail(c: CompanyData): string {
  const segments: string[] = [];

  const trades = c.congressTrades ?? [];
  if (trades.length > 0) {
    const buys = trades.filter((t) => t.transaction === "buy").length;
    const buyNote = buys > 0 ? `, ${buys} buy${buys === 1 ? "" : "s"}` : "";
    segments.push(`${trades.length} congress trade${trades.length === 1 ? "" : "s"}${buyNote}`);
  }

  const a = c.secActivity;
  if (a && (a.form4Count90d > 0 || a.eightKCount90d > 0)) {
    const sec: string[] = [];
    if (a.form4Count90d > 0) sec.push(`${a.form4Count90d} insider`);
    if (a.eightKCount90d > 0) sec.push(`${a.eightKCount90d} 8-K`);
    segments.push(`SEC ${sec.join(", ")}`);
  }

  if (segments.length > 0) return segments.join(" · ");
  const m = c.social.politicalMentions;
  return `${m} political/insider mention${m === 1 ? "" : "s"}`;
}

function momentumDetail(c: CompanyData): string {
  return `${formatPct(c.momentum.return3M)} 3M · RSI ${Math.round(c.momentum.rsi)}`;
}

function volatilityDetail(c: CompanyData): string {
  return `${formatPctPlain(c.volatility.atrPct)} ATR · ${c.volatility.beta.toFixed(2)} beta`;
}

function tierFor(score: number): HypeTier {
  if (score >= 78) return "On fire";
  if (score >= 60) return "Heating up";
  if (score >= 42) return "Warming";
  return "Cooling";
}

// Drivers worth leading the punchline with - concrete, decision-relevant signals.
// Raw news/social COUNTS ("10 stories", "1,652 mentions") are noise on the feed:
// their panels live further down the card, so they never headline the strip.
const PUNCHLINE_KEYS: HypeDriverKey[] = ["catalyst", "political", "momentum", "volatility"];

/**
 * One concrete punchline - the strongest decision-relevant driver's own detail
 * (e.g. "Partnership catalyst 4d ago."). The tier badge already says "Heating up
 * 64", so we don't restate the heat; we say WHAT is heating it. Skips raw
 * news/social counts as the lead.
 */
function buildTldr(_tier: HypeTier, drivers: HypeDriver[]): string {
  if (drivers.length === 0) {
    return "Quiet for now — no near-term catalyst or attention spike firing yet.";
  }
  const lead = drivers.find((d) => PUNCHLINE_KEYS.includes(d.key)) ?? drivers[0]!;
  const detail = `${lead.detail.charAt(0).toUpperCase()}${lead.detail.slice(1)}`;
  return detail.endsWith(".") ? detail : `${detail}.`;
}

export function computeHype(c: CompanyData, breakdown: ScoreBreakdown): HypeScore {
  // No live market data - there is no real attention to read, so don't model one.
  if (c.marketDataUnavailable === "directory") {
    return {
      score: 0,
      tier: "Cooling",
      tldr: "Live market data unavailable — no attention read for this listing yet.",
      drivers: [],
    };
  }

  // Raw 0..100 strength per driver. Catalyst/news/momentum/volatility reuse the
  // audited category scores; social/political are read straight from raw signals
  // so the attention spike isn't diluted by the broader social blend.
  const mentions = c.social.redditMentions24h + c.social.xMentions24h;
  const rawScore: Record<HypeDriverKey, number> = {
    catalyst: categoryScore(breakdown, "catalyst"),
    news: categoryScore(breakdown, "news"),
    momentum: categoryScore(breakdown, "momentum"),
    volatility: categoryScore(breakdown, "volatility"),
    social: clamp100(
      0.6 * scale(Math.log10(mentions + 1), 0, 4.5) + 0.4 * scale(c.social.trendDelta, -0.5, 2.0),
    ),
    // Congress trades (folded into politicalMentions) OR real SEC insider/8-K
    // activity - either can carry this driver on its own.
    political: clamp100(
      Math.max(scale(c.social.politicalMentions, 0, 6), scale(secActivityCount(c), 0, 10)),
    ),
  };

  const detail: Record<HypeDriverKey, (c: CompanyData) => string> = {
    catalyst: catalystDetail,
    news: newsDetail,
    social: socialDetail,
    political: politicalDetail,
    momentum: momentumDetail,
    volatility: volatilityDetail,
  };

  const keys = Object.keys(HYPE_WEIGHTS) as HypeDriverKey[];

  const score = Math.round(
    keys.reduce((sum, key) => sum + rawScore[key] * HYPE_WEIGHTS[key], 0),
  );
  const tier = tierFor(score);

  // Surface only genuine contributors (raw >= 50), strongest first.
  const drivers: HypeDriver[] = keys
    .filter((key) => rawScore[key] >= 50)
    .map((key) => ({
      key,
      label: DRIVER_LABEL[key],
      detail: detail[key](c),
      points: Math.round(rawScore[key] * HYPE_WEIGHTS[key]),
    }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 4);

  return {
    score: clamp100(score),
    tier,
    tldr: buildTldr(tier, drivers),
    drivers,
  };
}
