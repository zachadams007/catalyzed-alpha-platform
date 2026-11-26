import type {
  CatalystType,
  CompanyData,
  MarketCapBucket,
  NewsItem,
  Sector,
  SourceLink,
} from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { genSocialPosts } from "@/data/socialPosts";
import { seededRandom } from "@/lib/math";
import { getSymbol } from "@/data/symbols/symbolDirectory";

/**
 * Deterministic procedural universe generator.
 *
 * The hand-authored heroes in `mockSignals.ts` are rich but few (~26 names),
 * which made the Blueprint leaderboard feel capped and let narrow filter combos
 * (e.g. "Technology + Nano + Low risk") return nothing to rank. This module
 * expands the offline sample universe to a few hundred fictional names spread
 * across EVERY sector, cap bucket, catalyst type, and risk archetype so there is
 * always a best-fit set to rank.
 *
 * IMPORTANT: every ticker, name, and number here is FICTIONAL sample data, like
 * the rest of `mockSignals.ts`. Generation is fully deterministic (seeded by
 * ticker + field) so scoring stays a pure function and runs are reproducible.
 * News URLs use the same `example-research.local` host as the heroes so the
 * confidence/source model correctly treats these as modeled/sample records.
 */

type Range = [number, number];

const NOW = Date.now();

function rnd(seed: string): number {
  return seededRandom(seed);
}
function between(seed: string, [lo, hi]: Range): number {
  return lo + rnd(seed) * (hi - lo);
}
function pick<T>(seed: string, arr: readonly T[]): T {
  return arr[Math.floor(rnd(seed) * arr.length)] ?? arr[0]!;
}
function chance(seed: string, p: number): boolean {
  return rnd(seed) < p;
}
function r(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
function clampNum(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// ---------------------------------------------------------------------------
// Cap tiers - picked so bucketForMarketCap() lands each name in the right bucket
// (Nano <5e7, Micro <3e8, Small <2e9, Mid <1e10, Large <2e11, Mega ≥2e11) and
// liquidity/price/float scale sensibly with size.
// ---------------------------------------------------------------------------

interface CapTier {
  bucket: MarketCapBucket;
  mc: Range;
  price: Range;
  advol: Range;
  /** Multiplies growth ranges (small caps grow faster, mega-caps slower). */
  growth: number;
  /** Multiplies volatility ranges (small caps swing harder). */
  vol: number;
}

const CAP_TIERS: CapTier[] = [
  { bucket: "Nano", mc: [1.6e7, 4.6e7], price: [0.6, 6], advol: [4e5, 3e6], growth: 1.3, vol: 1.5 },
  { bucket: "Micro", mc: [6e7, 2.7e8], price: [2, 18], advol: [2e6, 2e7], growth: 1.2, vol: 1.3 },
  { bucket: "Small", mc: [3.3e8, 1.85e9], price: [6, 45], advol: [1.2e7, 1.1e8], growth: 1.1, vol: 1.15 },
  { bucket: "Mid", mc: [2.2e9, 9.5e9], price: [20, 120], advol: [8e7, 6e8], growth: 1.0, vol: 1.0 },
  { bucket: "Large", mc: [1.2e10, 1.9e11], price: [40, 400], advol: [4e8, 3e9], growth: 0.8, vol: 0.85 },
  { bucket: "Mega", mc: [2.3e11, 1.5e12], price: [80, 700], advol: [1.6e9, 1.1e10], growth: 0.65, vol: 0.7 },
];

// ---------------------------------------------------------------------------
// Risk / style archetypes - the shape that makes scores (and derived risk
// levels) span the full range from sleepy compounders to distressed micro-caps.
// ---------------------------------------------------------------------------

interface Profile {
  rev: Range;
  eps: Range;
  gross: Range;
  net: Range;
  d2e: Range;
  fcf: Range;
  ret1: Range;
  ret3: Range;
  ret6: Range;
  rsi: Range;
  rs3: Range;
  beta: Range;
  atr: Range;
  iv: Range;
  shortInt: Range;
  dilution: Range;
  runway: Range;
  gov: Range;
  newsCount: Range;
  newsSent: Range;
  fresh: Range;
  reddit: Range;
  x: Range;
  political: Range;
  socSent: Range;
  trend: Range;
  catMag: Range;
  catDays: Range;
  /** Probability the name is above its 50/200-day averages. */
  smaBias: number;
}

const ARCHETYPES: Record<string, Profile> = {
  // Profitable, steady, low leverage - the quality end. Derived risk: Low.
  compounder: {
    rev: [0.12, 0.3], eps: [0.12, 0.34], gross: [0.55, 0.8], net: [0.14, 0.3], d2e: [0.1, 0.5],
    fcf: [0.14, 0.3], ret1: [0.0, 0.1], ret3: [0.05, 0.22], ret6: [0.08, 0.35], rsi: [50, 64],
    rs3: [0.02, 0.18], beta: [0.8, 1.3], atr: [0.02, 0.045], iv: [0.28, 0.5], shortInt: [0.01, 0.05],
    dilution: [0.02, 0.12], runway: [24, 60], gov: [0, 0.05], newsCount: [6, 16], newsSent: [0.2, 0.5],
    fresh: [3, 18], reddit: [120, 900], x: [400, 3000], political: [0, 2], socSent: [0.2, 0.45],
    trend: [0.1, 0.6], catMag: [0.4, 0.7], catDays: [6, 30], smaBias: 0.92,
  },
  // Fast top-line, not yet profitable, some dilution. Derived risk: Elevated.
  hypergrowth: {
    rev: [0.35, 0.9], eps: [-0.4, 0.4], gross: [0.45, 0.72], net: [-0.4, 0.08], d2e: [0.1, 0.5],
    fcf: [-0.4, 0.06], ret1: [0.08, 0.3], ret3: [0.2, 0.6], ret6: [0.3, 1.0], rsi: [60, 78],
    rs3: [0.18, 0.6], beta: [1.5, 2.6], atr: [0.05, 0.1], iv: [0.6, 1.4], shortInt: [0.06, 0.2],
    dilution: [0.25, 0.6], runway: [5, 14], gov: [0, 0.12], newsCount: [10, 22], newsSent: [0.3, 0.6],
    fresh: [2, 10], reddit: [800, 4200], x: [2500, 11000], political: [0, 3], socSent: [0.35, 0.6],
    trend: [0.6, 2.2], catMag: [0.6, 0.92], catDays: [3, 22], smaBias: 0.85,
  },
  // Cheap, modest growth, discounted entry. Derived risk: Low/Moderate.
  value: {
    rev: [0.03, 0.16], eps: [0.02, 0.2], gross: [0.3, 0.55], net: [0.06, 0.18], d2e: [0.3, 1.1],
    fcf: [0.06, 0.2], ret1: [-0.1, 0.04], ret3: [-0.12, 0.08], ret6: [-0.1, 0.18], rsi: [36, 52],
    rs3: [-0.08, 0.06], beta: [0.7, 1.3], atr: [0.025, 0.05], iv: [0.3, 0.55], shortInt: [0.03, 0.1],
    dilution: [0.05, 0.18], runway: [16, 40], gov: [0, 0.08], newsCount: [3, 10], newsSent: [0.0, 0.3],
    fresh: [10, 36], reddit: [60, 500], x: [180, 1600], political: [0, 2], socSent: [0.05, 0.3],
    trend: [-0.1, 0.4], catMag: [0.35, 0.6], catDays: [10, 40], smaBias: 0.5,
  },
  // High attention, crowded short, very volatile. Derived risk: High/Elevated.
  meme: {
    rev: [0.0, 0.4], eps: [-0.5, 0.2], gross: [0.2, 0.5], net: [-0.3, 0.04], d2e: [0.3, 1.4],
    fcf: [-0.35, 0.02], ret1: [0.2, 0.6], ret3: [0.1, 0.7], ret6: [-0.1, 0.6], rsi: [66, 84],
    rs3: [0.2, 0.6], beta: [2.2, 3.0], atr: [0.11, 0.2], iv: [1.0, 2.2], shortInt: [0.2, 0.45],
    dilution: [0.25, 0.6], runway: [3, 9], gov: [0.08, 0.28], newsCount: [12, 24], newsSent: [0.05, 0.35],
    fresh: [1, 6], reddit: [2500, 7000], x: [6000, 16000], political: [0, 4], socSent: [0.35, 0.6],
    trend: [1.4, 2.8], catMag: [0.5, 0.8], catDays: [-3, 8], smaBias: 0.8,
  },
  // Negative cash flow, very short runway, flags. Derived risk: High/Extreme.
  distressed: {
    rev: [-0.1, 0.25], eps: [-0.6, -0.05], gross: [0.1, 0.4], net: [-1.2, -0.1], d2e: [0.8, 2.2],
    fcf: [-1.2, -0.4], ret1: [-0.2, 0.15], ret3: [-0.35, 0.1], ret6: [-0.5, 0.05], rsi: [30, 56],
    rs3: [-0.2, 0.05], beta: [1.6, 2.8], atr: [0.1, 0.18], iv: [0.9, 1.9], shortInt: [0.2, 0.42],
    dilution: [0.6, 0.9], runway: [0.3, 2.5], gov: [0.3, 0.6], newsCount: [5, 14], newsSent: [-0.2, 0.2],
    fresh: [4, 20], reddit: [300, 2200], x: [900, 6000], political: [0, 3], socSent: [-0.1, 0.3],
    trend: [0.2, 1.4], catMag: [0.5, 0.85], catDays: [2, 18], smaBias: 0.4,
  },
  // Mature, high margin, low growth, very liquid. Derived risk: Low.
  cashcow: {
    rev: [0.02, 0.1], eps: [0.03, 0.14], gross: [0.45, 0.72], net: [0.16, 0.34], d2e: [0.2, 0.9],
    fcf: [0.16, 0.32], ret1: [-0.03, 0.06], ret3: [0.0, 0.12], ret6: [0.02, 0.18], rsi: [46, 60],
    rs3: [-0.04, 0.08], beta: [0.55, 1.05], atr: [0.015, 0.035], iv: [0.22, 0.42], shortInt: [0.01, 0.05],
    dilution: [0.02, 0.1], runway: [30, 60], gov: [0, 0.05], newsCount: [4, 12], newsSent: [0.05, 0.35],
    fresh: [8, 30], reddit: [40, 300], x: [150, 1200], political: [0, 2], socSent: [0.05, 0.3],
    trend: [-0.05, 0.3], catMag: [0.3, 0.55], catDays: [12, 40], smaBias: 0.8,
  },
  // Macro / rate / commodity sensitive, mid vol. Derived risk: Moderate.
  cyclical: {
    rev: [0.05, 0.3], eps: [-0.1, 0.3], gross: [0.25, 0.5], net: [0.04, 0.18], d2e: [0.4, 1.4],
    fcf: [0.02, 0.18], ret1: [-0.08, 0.12], ret3: [-0.1, 0.22], ret6: [-0.05, 0.3], rsi: [44, 62],
    rs3: [-0.08, 0.14], beta: [1.0, 1.8], atr: [0.035, 0.07], iv: [0.4, 0.8], shortInt: [0.04, 0.14],
    dilution: [0.08, 0.25], runway: [12, 30], gov: [0, 0.1], newsCount: [5, 14], newsSent: [0.0, 0.35],
    fresh: [6, 26], reddit: [120, 900], x: [400, 3200], political: [0, 5], socSent: [0.05, 0.4],
    trend: [0.0, 0.8], catMag: [0.4, 0.7], catDays: [8, 36], smaBias: 0.6,
  },
  // Recovering momentum off a base, mixed quality. Derived risk: Moderate/Elevated.
  turnaround: {
    rev: [0.08, 0.35], eps: [-0.2, 0.3], gross: [0.3, 0.6], net: [-0.1, 0.14], d2e: [0.3, 1.2],
    fcf: [-0.1, 0.15], ret1: [0.05, 0.22], ret3: [0.08, 0.4], ret6: [-0.05, 0.4], rsi: [54, 70],
    rs3: [0.05, 0.3], beta: [1.2, 2.0], atr: [0.045, 0.09], iv: [0.5, 1.0], shortInt: [0.08, 0.22],
    dilution: [0.12, 0.35], runway: [8, 20], gov: [0.02, 0.15], newsCount: [7, 16], newsSent: [0.1, 0.45],
    fresh: [3, 14], reddit: [300, 1800], x: [900, 5000], political: [0, 3], socSent: [0.15, 0.45],
    trend: [0.3, 1.4], catMag: [0.5, 0.8], catDays: [4, 24], smaBias: 0.7,
  },
};

const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

// ---------------------------------------------------------------------------
// Sector flavor - theme tokens (aligned with narrativeIntel CORE_THEME_TOKENS
// and the curated screen themes) plus name parts so theme/description ranking
// modes find real evidence across the whole universe.
// ---------------------------------------------------------------------------

interface SectorFlavor {
  themes: string[];
  suffixes: string[];
  catalysts: CatalystType[];
}

const SECTOR_FLAVOR: Record<Sector, SectorFlavor> = {
  Technology: {
    themes: ["ai", "semiconductor", "chip", "foundry", "quantum", "robotics", "automation", "photonic", "software", "platform"],
    suffixes: ["Systems", "Labs", "Compute", "Semiconductors", "AI", "Robotics", "Networks", "Dynamics"],
    catalysts: ["Earnings", "Product", "Partnership", "M&A", "Technical"],
  },
  Healthcare: {
    themes: ["clinical", "fda", "therapy", "genomic", "biotech", "oncology", "device"],
    suffixes: ["Therapeutics", "Biosciences", "Health", "Genomics", "Medical", "Bio"],
    catalysts: ["Clinical", "Regulatory", "Earnings", "M&A", "Partnership"],
  },
  Financials: {
    themes: ["payments", "neobank", "lending", "fintech", "blockchain"],
    suffixes: ["Capital", "Financial", "Holdings", "Pay", "Bancorp", "Markets"],
    catalysts: ["Earnings", "M&A", "Regulatory", "Macro", "Insider"],
  },
  Energy: {
    themes: ["solar", "battery", "hydrogen", "lithium", "grid", "renewable"],
    suffixes: ["Energy", "Power", "Petroleum", "Renewables", "Fuels"],
    catalysts: ["Macro", "Regulatory", "Partnership", "Earnings", "Political"],
  },
  Consumer: {
    themes: ["retail", "brand", "ecommerce", "subscription", "viral"],
    suffixes: ["Brands", "Retail", "Goods", "Foods", "Commerce"],
    catalysts: ["Earnings", "Product", "Technical", "M&A", "Macro"],
  },
  Industrials: {
    themes: ["robotics", "automation", "aerospace", "satellite", "launch", "orbital", "defense"],
    suffixes: ["Industries", "Aerospace", "Robotics", "Manufacturing", "Defense", "Propulsion"],
    catalysts: ["Product", "Regulatory", "Partnership", "Earnings", "Political"],
  },
  Communications: {
    themes: ["streaming", "adtech", "platform", "media", "wireless"],
    suffixes: ["Media", "Networks", "Communications", "Streaming", "Telecom"],
    catalysts: ["Earnings", "Product", "M&A", "Political", "Technical"],
  },
  Materials: {
    themes: ["lithium", "battery", "mining", "materials", "semiconductor"],
    suffixes: ["Materials", "Mining", "Chemicals", "Metals", "Resources"],
    catalysts: ["Macro", "M&A", "Regulatory", "Earnings", "Partnership"],
  },
  Utilities: {
    themes: ["grid", "renewable", "battery", "storage"],
    suffixes: ["Utilities", "Grid", "Power", "Water", "Energy"],
    catalysts: ["Regulatory", "Macro", "Earnings", "Political", "Partnership"],
  },
  "Real Estate": {
    themes: ["logistics", "warehouse", "datacenter", "reit"],
    suffixes: ["Properties", "Realty", "Trust", "Estates", "Logistics"],
    catalysts: ["Macro", "Earnings", "M&A", "Regulatory", "Insider"],
  },
};

const SECTORS = Object.keys(SECTOR_FLAVOR) as Sector[];

const NAME_ROOTS = [
  "Vertex", "Helio", "Nova", "Aether", "Quanta", "Lumen", "Cobalt", "Aurora", "Strato", "Pinnacle",
  "Vector", "Cinder", "Halcyon", "Onyx", "Zephyr", "Meridian", "Apex", "Cipher", "Equinox", "Fathom",
  "Granite", "Horizon", "Juniper", "Kestrel", "Lattice", "Monolith", "Nimbus", "Polaris", "Quill",
  "Ridge", "Summit", "Tessera", "Umbra", "Valent", "Wavelength", "Xenon", "Yarrow", "Zenith", "Beacon",
  "Crucible", "Drift", "Ember", "Forge", "Glimmer", "Hollow", "Ironwood", "Jadeite", "Karst", "Lyric",
];

const HEADLINE_TEMPLATES: Record<string, (name: string, theme: string) => { headline: string; sentiment: number }> = {
  Earnings: (n, t) => ({ headline: `${n} guides ahead on ${t} demand`, sentiment: 0.4 }),
  Product: (n, t) => ({ headline: `${n} unveils next-gen ${t} platform`, sentiment: 0.45 }),
  "M&A": (n, t) => ({ headline: `${n} explores strategic options amid ${t} consolidation`, sentiment: 0.35 }),
  Regulatory: (n, t) => ({ headline: `${n} clears regulatory step for ${t} program`, sentiment: 0.4 }),
  Political: (n, t) => ({ headline: `${n} surfaces in policy debate over ${t}`, sentiment: 0.25 }),
  Macro: (n, t) => ({ headline: `${n} positioned for ${t} cycle turn`, sentiment: 0.3 }),
  Technical: (n, t) => ({ headline: `${n} breaks out as ${t} traders pile in`, sentiment: 0.2 }),
  Insider: (n, t) => ({ headline: `Insiders add to ${n} as ${t} thesis builds`, sentiment: 0.35 }),
  Partnership: (n, t) => ({ headline: `${n} lands ${t} partnership with industry leader`, sentiment: 0.5 }),
  Clinical: (n, t) => ({ headline: `${n} sets date for ${t} readout`, sentiment: 0.45 }),
};

const CATALYST_BLURB: Record<CatalystType, (theme: string) => string> = {
  Earnings: (t) => `Upcoming print is the swing factor for the ${t} story.`,
  Product: (t) => `Launch event for its ${t} line could re-rate the name.`,
  "M&A": (t) => `Takeout / consolidation chatter around ${t} assets.`,
  Regulatory: (t) => `Pending regulatory decision gates the ${t} opportunity.`,
  Political: (t) => `Policy / ${t} headlines driving political-trade attention.`,
  Macro: (t) => `Rate and ${t} macro backdrop is the key driver here.`,
  Technical: (t) => `Coiling setup; ${t} momentum building on the tape.`,
  Insider: (t) => `Disclosed insider buying alongside the ${t} thesis.`,
  Partnership: (t) => `Rumored ${t} design win / partnership in the pipeline.`,
  Clinical: (t) => `Binary ${t} trial readout due in the catalyst window.`,
  Institutional: (t) => `Activist / institutional stake disclosed in the ${t} name.`,
  // "None" never appears in the generated sample universe (samples always pick a
  // real catalyst type), but the Record must be exhaustive over CatalystType.
  None: (t) => `No dated catalyst in the ${t} story yet.`,
};

const src = (label: string, url: string): SourceLink => ({ label, url });

function buildNews(ticker: string, name: string, catalyst: CatalystType, themes: string[], freshness: number): NewsItem[] {
  const count = themes.length > 0 ? 2 : 1;
  const items: NewsItem[] = [];
  for (let i = 0; i < count; i++) {
    const theme = themes[i % themes.length] ?? "growth";
    const tmpl = HEADLINE_TEMPLATES[catalyst] ?? HEADLINE_TEMPLATES.Earnings!;
    const { headline, sentiment } = tmpl(name, theme);
    const slug = headline.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48);
    items.push({
      headline,
      source: pick(`${ticker}-src-${i}`, ["TechWire", "MarketBeat", "BioWire", "EnergyNow", "SectorDaily", "DeepTech Daily"]),
      url: `https://example-research.local/${ticker.toLowerCase()}/${slug}`,
      publishedAt: new Date(NOW - (freshness + i * 9) * 3600 * 1000).toISOString(),
      sentiment,
    });
  }
  return items;
}

function buildGenerated(
  sector: Sector,
  tier: CapTier,
  archetypeKey: string,
  idx: number,
  ticker: string,
  name: string,
): CompanyData {
  const p = ARCHETYPES[archetypeKey]!;
  const flavor = SECTOR_FLAVOR[sector];
  const s = (field: string) => `${ticker}-${field}`;

  // Theme tokens this name carries (2-3), seeded into copy for narrative match.
  const themeCount = 2 + (chance(s("tc"), 0.5) ? 1 : 0);
  const themes: string[] = [];
  for (let i = 0; i < themeCount; i++) {
    const t = pick(s(`theme-${i}`), flavor.themes);
    if (!themes.includes(t)) themes.push(t);
  }

  const catalystType = pick(s("cat"), flavor.catalysts);
  const marketCap = between(s("mc"), tier.mc);
  const rawPrice = between(s("price"), tier.price);
  const price = r(rawPrice, rawPrice < 5 ? 3 : 2);
  const dayChange = r(between(s("day"), [-0.05, 0.08]) * tier.vol, 3);

  const revenueGrowthYoY = r(clampNum(between(s("rev"), p.rev) * tier.growth, -0.2, 2.0), 2);
  const epsGrowthYoY = r(clampNum(between(s("eps"), p.eps) * tier.growth, -0.8, 1.5), 2);
  const grossMargin = r(clampNum(between(s("gross"), p.gross), 0, 0.9), 2);
  const netMargin = r(between(s("net"), p.net), 2);
  const fcfMargin = r(between(s("fcf"), p.fcf), 2);
  const debtToEquity = r(between(s("d2e"), p.d2e), 2);
  const profitable = netMargin > 0.02;
  const peRatio = profitable ? r(between(s("pe"), [12, 55]), 0) : null;
  const pegRatio = profitable && epsGrowthYoY > 0.05 ? r(between(s("peg"), [0.6, 2.6]), 2) : null;

  const aboveSMA50 = chance(s("sma50"), p.smaBias);
  const aboveSMA200 = chance(s("sma200"), p.smaBias * 0.95);

  const atrPct = r(clampNum(between(s("atr"), p.atr) * tier.vol, 0.012, 0.22), 3);
  const beta = r(between(s("beta"), p.beta), 2);

  const avgDollarVolume = Math.round(between(s("advol"), tier.advol));
  const floatShares = Math.round(marketCap / Math.max(price, 0.5));

  const reddit = Math.round(between(s("reddit"), p.reddit));
  const xMentions = Math.round(between(s("x"), p.x));
  const political = Math.round(between(s("pol"), p.political));
  const freshness = r(between(s("fresh"), p.fresh), 0);

  const theme0 = themes[0] ?? "growth";
  const catalystDescription = (CATALYST_BLURB[catalystType] ?? CATALYST_BLURB.Earnings)(theme0);
  const socialSummary = `${capitalize(theme0)} ${archetypeLabel(archetypeKey)} — ${
    xMentions > 5000 ? "heavy retail attention" : xMentions > 1500 ? "steady chatter" : "quiet tape"
  }.`;

  return {
    ticker,
    name,
    sector,
    price,
    dayChange,
    marketCap: Math.round(marketCap),
    priceSeries: [],
    priceHistory: [],
    fundamentals: {
      revenueGrowthYoY,
      epsGrowthYoY,
      grossMargin,
      netMargin,
      peRatio,
      pegRatio,
      debtToEquity,
      fcfMargin,
    },
    momentum: {
      return1M: r(between(s("ret1"), p.ret1) * tier.vol, 2),
      return3M: r(between(s("ret3"), p.ret3) * tier.vol, 2),
      return6M: r(between(s("ret6"), p.ret6) * tier.vol, 2),
      rsi: r(between(s("rsi"), p.rsi), 0),
      aboveSMA50,
      aboveSMA200: aboveSMA50 && aboveSMA200,
      relativeStrength3M: r(between(s("rs3"), p.rs3), 2),
    },
    catalyst: {
      type: catalystType,
      description: catalystDescription,
      daysAway: Math.round(between(s("catdays"), p.catDays)),
      magnitude: r(between(s("catmag"), p.catMag), 2),
    },
    news: {
      items: buildNews(ticker, name, catalystType, themes, freshness),
      sentiment: r(between(s("newssent"), p.newsSent), 2),
      count7d: Math.round(between(s("newscount"), p.newsCount)),
      freshnessHours: freshness,
    },
    social: {
      redditMentions24h: reddit,
      xMentions24h: xMentions,
      politicalMentions: political,
      sentiment: r(between(s("socsent"), p.socSent), 2),
      trendDelta: r(between(s("trend"), p.trend), 2),
      summary: socialSummary,
    },
    socialPosts: genSocialPosts({ ticker, xMentions, political, socialSummary }),
    volatility: {
      beta,
      atrPct,
      impliedVol: r(clampNum(between(s("iv"), p.iv) * tier.vol, 0.2, 2.4), 2),
    },
    liquidity: {
      avgDollarVolume,
      floatShares,
    },
    risk: {
      shortInterestPct: r(between(s("short"), p.shortInt), 2),
      dilutionRisk: r(between(s("dil"), p.dilution), 2),
      cashRunwayQuarters: r(between(s("run"), p.runway), 1),
      governanceFlag: r(between(s("gov"), p.gov), 2),
    },
    sources: [
      src(`${themes.map(capitalize).join(" / ")} coverage`, `https://example-research.local/${ticker.toLowerCase()}/coverage`),
    ],
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function archetypeLabel(key: string): string {
  switch (key) {
    case "compounder": return "compounder";
    case "hypergrowth": return "hyper-growth";
    case "value": return "value setup";
    case "meme": return "high-attention name";
    case "distressed": return "distressed turnaround";
    case "cashcow": return "cash generator";
    case "cyclical": return "cyclical";
    case "turnaround": return "turnaround";
    default: return "name";
  }
}

/**
 * A candidate sample ticker is usable only if it isn't already assigned in this
 * run AND doesn't collide with a REAL listed SYMBOL. The exact-symbol directory
 * check (`getSymbol`, not the fuzzy name search) is the data-integrity guard: a
 * fictional company must never reuse a real ticker (e.g. "RIDG", "LUMN", "CYBR")
 * or it could surface a made-up name under a real symbol - the exact bug class
 * this universe is sandboxed to avoid. A mere name-substring overlap is fine.
 */
function isTickerUsable(t: string, taken: Set<string>): boolean {
  return t.length >= 3 && !taken.has(t) && getSymbol(t) === null;
}

/** Build a unique, sample (fictional) ticker colliding with neither `taken` nor a real listing. */
function makeTicker(root: string, sector: Sector, idx: number, taken: Set<string>): string {
  const base = root.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
  const sectorLetter = sector.charAt(0).toUpperCase();
  const candidates = [
    base,
    `${base}${sectorLetter}`,
    `${base.slice(0, 3)}${sectorLetter}`,
    `${base.slice(0, 3)}${idx.toString(36).toUpperCase()}`,
    `${base.slice(0, 2)}${sectorLetter}${idx.toString(36).toUpperCase()}`,
  ];
  for (const c of candidates) {
    const t = c.slice(0, 6);
    if (isTickerUsable(t, taken)) {
      taken.add(t);
      return t;
    }
  }
  // Guaranteed-unique fallback. The leading "Z" namespaces the sample universe
  // away from the real listing space (almost no real US/CA symbol starts with a
  // bare "Z"-prefixed code of this shape), and the directory check below makes it
  // collision-proof regardless.
  let n = idx;
  for (;;) {
    const t = `Z${sectorLetter}${n.toString(36).toUpperCase()}`.slice(0, 6);
    if (isTickerUsable(t, taken)) {
      taken.add(t);
      return t;
    }
    n++;
  }
}

/**
 * Generate the procedural slice of the offline universe. ~`perSector` names for
 * each of the 10 sectors, spread across all 6 cap buckets and the 8 archetypes,
 * so every (sector × cap × risk) corner has candidates to rank.
 *
 * @param reservedTickers Hero tickers (and any others) to avoid colliding with.
 */
export function generateUniverse(reservedTickers: string[] = [], perSector = 30): CompanyData[] {
  const taken = new Set(reservedTickers.map((t) => t.toUpperCase()));
  const out: CompanyData[] = [];
  let idx = 0;

  for (const sector of SECTORS) {
    const flavor = SECTOR_FLAVOR[sector];
    for (let i = 0; i < perSector; i++) {
      // Spread deterministically across cap buckets and archetypes.
      const tier = CAP_TIERS[i % CAP_TIERS.length]!;
      const archetypeKey = pickArchetypeFor(tier.bucket, i, idx);
      const root = NAME_ROOTS[(idx * 7 + i) % NAME_ROOTS.length]!;
      const suffix = flavor.suffixes[(idx + i) % flavor.suffixes.length]!;
      const name = `${root} ${suffix}`;
      const ticker = makeTicker(root, sector, idx, taken);
      const company = buildGenerated(sector, tier, archetypeKey, idx, ticker, name);
      // Attach the price series now that the ticker/price/vol are settled.
      const series = genPriceSeries(ticker, company.price, company.momentum.return1M, company.volatility.atrPct);
      out.push({ ...company, priceSeries: series, priceHistory: closesFromSeries(series) });
      idx++;
    }
  }
  return out;
}

/**
 * Bias archetype selection by cap bucket so the spread is realistic: bigger caps
 * skew toward compounders/cash cows, smaller caps toward hyper-growth/meme/
 * distressed - while still covering every archetype across the universe.
 */
function pickArchetypeFor(bucket: MarketCapBucket, i: number, idx: number): string {
  const pools: Record<MarketCapBucket, string[]> = {
    Nano: ["hypergrowth", "meme", "distressed", "distressed", "turnaround", "value", "meme"],
    Micro: ["hypergrowth", "meme", "turnaround", "distressed", "distressed", "value", "cyclical"],
    Small: ["hypergrowth", "turnaround", "value", "cyclical", "compounder", "meme", "distressed"],
    Mid: ["compounder", "turnaround", "cyclical", "value", "hypergrowth"],
    Large: ["compounder", "cashcow", "cyclical", "value"],
    Mega: ["cashcow", "compounder", "cyclical"],
    // The synthetic universe always generates a real cap, so "Unknown" is never
    // reached here - but the Record must be total. Neutral, balanced fallback.
    Unknown: ["value", "compounder", "cyclical"],
  };
  const pool = pools[bucket];
  return pool[(i + idx) % pool.length] ?? ARCHETYPE_KEYS[0]!;
}
