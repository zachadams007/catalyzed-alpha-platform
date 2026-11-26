// AUTO-GENERATION SCRIPT for the market-majors backbone.
//
// Emits src/data/symbols/majors.generated.ts - the top ~200 US common stocks by
// MARKET CAP, refreshed from live data so the list NEVER goes stale. PRIVATE /
// non-tradeable pseudo-tickers (SPCX = SpaceX, a synthetic ~$2.5T pre-IPO
// valuation) are excluded - they are not public market caps and would paint a
// giant fake megacap tile. The daily scan unions these tickers into the pre-rank
// `alwaysInclude` seed set so the DAY-move Market
// Map is a classic market map: every biggest-cap name present, sized by cap,
// colored by its live day move.
//
// WHY a separate file (not computed in the scan): the cross-sectional pre-rank has
// NO market-cap input (Alpaca snapshots + the symbol directory carry none), so the
// scan can't know which names are the majors until it's told. Market caps move
// slowly, so we precompute the backbone here and commit it; regenerate weekly.
//
// DATA PATH (free tier only - no paid endpoints; FMP's /stock-screener is a dead
// legacy endpoint as of 2025-08, returns 403):
//   1. Finnhub /stock/symbol?exchange=US - the whole US common-stock list (1 call).
//   2. Alpaca bulk snapshots - dollar volume for the whole list, to
//      cheaply PREFILTER to the most-traded ~700 names (every mega/large cap and
//      any hot IPO trades heavily, so the top-by-cap set is a strict subset).
//   3. Finnhub /stock/profile2 - marketCapitalization (in $millions)
//      for those ~700 candidates only, paced for the 60/min free tier (2 keys when
//      a 2nd is configured). Sort by cap desc, keep the top TARGET.
//
// KEYS: read from process.env first (CI provides VITE_* Action secrets), then fall
// back to the staged local secrets file for a developer run. No secret is ever
// printed; only counts, tickers, and caps are logged.
//
// REFRESH:
//   node scripts/gen-market-majors.mjs              # uses staged keys locally
//   MAJORS_TARGET=200 MAJORS_CANDIDATES=700 node scripts/gen-market-majors.mjs
//   (in CI set VITE_FINNHUB_API_KEY / VITE_ALPACA_API_KEY / VITE_ALPACA_API_SECRET)
// Then commit src/data/symbols/majors.generated.ts.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "src", "data", "symbols", "majors.generated.ts");

// ── Tunables ────────────────────────────────────────────────────────────────
const TARGET = intEnv("MAJORS_TARGET", 200); // how many majors to emit
const CANDIDATES = intEnv("MAJORS_CANDIDATES", 700); // top-by-volume names to price
const PER_KEY_PER_MIN = 55; // stay under Finnhub's 60/min free tier with margin

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Key loading (env → staged local secrets, never printed) ──────────────────
function loadKeys() {
  const env = { ...process.env };
  // Local convenience: pull from the staged secrets file when env vars are absent.
  if (!env.VITE_FINNHUB_API_KEY && !env.FINNHUB_API_KEY) {
    try {
      const path = join(homedir(), ".claude", "catalyzed-supabase-secrets.txt");
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const i = t.indexOf("=");
        const k = t.slice(0, i).trim();
        if (env[k] === undefined) env[k] = t.slice(i + 1).trim();
      }
    } catch {
      /* no staged file - env must provide the keys */
    }
  }
  const pick = (...names) => {
    for (const n of names) if (env[n]) return env[n];
    return undefined;
  };
  return {
    finnhub: [
      pick("VITE_FINNHUB_API_KEY", "FINNHUB_API_KEY"),
      pick("VITE_FINNHUB_API_KEY_2", "FINNHUB_API_KEY_2"),
      pick("VITE_FINNHUB_API_KEY_3", "FINNHUB_API_KEY_3"),
      pick("VITE_FINNHUB_API_KEY_4", "FINNHUB_API_KEY_4"),
    ].filter(Boolean),
    alpacaId: pick("VITE_ALPACA_API_KEY", "ALPACA_API_KEY"),
    alpacaSecret: pick("VITE_ALPACA_API_SECRET", "ALPACA_API_SECRET"),
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function log(msg) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(6, " ");
  console.log(`[+${secs}s] ${msg}`);
}

async function getJson(url, headers) {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── 1. Finnhub US common-stock universe (mirrors src/data/finnhub/symbolList) ──
// NOTE: ADRs are intentionally EXCLUDED here (the app's symbol list keeps them).
// Finnhub's profile2 `marketCapitalization` is inflated for ADRs - it multiplies
// the ADR price by the LOCAL share count, so TSM reads ~$62T, HDB ~$12T, etc.,
// which would dominate the treemap as fake giants. The majors backbone is the
// biggest *US-listed domestic* companies (+ REITs), whose caps profile2 reports
// correctly. (Correcting ADR caps would need each name's ADR ratio - a separate,
// app-wide fix; tracked as a follow-on.)
const KEPT_TYPES = new Set(["Common Stock", "REIT"]);
// Private / non-tradeable pseudo-tickers some providers carry with a synthetic
// ticker + a private-markets "valuation" (Finnhub reports SpaceX as SPCX with a
// ~$2.5T pre-IPO valuation). These are NOT public market caps and must NEVER enter
// the majors backbone - they paint a giant fake megacap tile. Mirror of
// src/lib/format.ts NON_PUBLIC_TICKERS (kept in sync by hand; this script is .mjs).
const NON_PUBLIC_TICKERS = new Set(["SPCX"]);
/** Above this, a profile2 cap is almost certainly an ADR/units artifact, not a
 *  real company (the largest real US names are ~$5T). Drop & log such rows. */
const MAX_PLAUSIBLE_CAP = 10_000_000_000_000;
const isCleanRootTicker = (s) => /^[A-Z]{1,5}$/.test(s);

// finnhubIndustry → our Sector enum. MIRRORS src/data/finnhub/liveCompany.ts
// (kept in sync by hand; this script is .mjs and can't import the TS). Substring
// match in insertion order; defaults to Technology when nothing matches. A small
// curated override below fixes the handful Finnhub's coarse industry mislabels.
const INDUSTRY_TO_SECTOR = {
  technology: "Technology",
  software: "Technology",
  semiconductor: "Technology",
  "electronic gaming": "Communications",
  automobile: "Consumer",
  consumer: "Consumer",
  retail: "Consumer",
  apparel: "Consumer",
  hotel: "Consumer",
  restaurant: "Consumer",
  bank: "Financials",
  financial: "Financials",
  insurance: "Financials",
  "capital markets": "Financials",
  health: "Healthcare",
  pharmaceutical: "Healthcare",
  biotech: "Healthcare",
  "life sciences": "Healthcare",
  medical: "Healthcare",
  oil: "Energy",
  gas: "Energy",
  energy: "Energy",
  industrial: "Industrials",
  aerospace: "Industrials",
  machinery: "Industrials",
  airline: "Industrials",
  logistics: "Industrials",
  road: "Industrials",
  telecom: "Communications",
  media: "Communications",
  communication: "Communications",
  material: "Materials",
  chemical: "Materials",
  metal: "Materials",
  mining: "Materials",
  utility: "Utilities",
  utilities: "Utilities",
  reit: "Real Estate",
  "real estate": "Real Estate",
};
// Curated overrides for names Finnhub's coarse `finnhubIndustry` gets wrong or
// leaves ambiguous (verified by hand). Ticker → Sector.
const SECTOR_OVERRIDE = {
  TSLA: "Consumer", AMZN: "Consumer", BRK: "Financials", "BRK.B": "Financials",
  GOOGL: "Communications", GOOG: "Communications", META: "Communications",
  NFLX: "Communications", DIS: "Communications", T: "Communications",
  VZ: "Communications", TMUS: "Communications", CMCSA: "Communications",
  NVDA: "Technology", AVGO: "Technology", ORCL: "Technology", CRM: "Technology",
  ACN: "Technology", IBM: "Technology", NOW: "Technology", UBER: "Technology",
  ABNB: "Consumer", MCD: "Consumer", SBUX: "Consumer", NKE: "Consumer",
  HD: "Consumer", LOW: "Consumer", BKNG: "Consumer",
  V: "Financials", MA: "Financials", PYPL: "Financials", AXP: "Financials",
  JPM: "Financials", BAC: "Financials", WFC: "Financials", GS: "Financials",
  MS: "Financials", SCHW: "Financials", BLK: "Financials", SPGI: "Financials",
  BX: "Financials", KKR: "Financials", HOOD: "Financials", COIN: "Financials",
  UPS: "Industrials", FDX: "Industrials", BA: "Industrials", CAT: "Industrials",
  GE: "Industrials", HON: "Industrials", RTX: "Industrials", LMT: "Industrials",
  DE: "Industrials", UNP: "Industrials", ETN: "Industrials",
  LIN: "Materials", SHW: "Materials", FCX: "Materials", NEM: "Materials",
  AEM: "Materials", SCCO: "Materials",
  PLD: "Real Estate", AMT: "Real Estate", EQIX: "Real Estate", WELL: "Real Estate",
  NEE: "Utilities", SO: "Utilities", DUK: "Utilities", CEG: "Utilities",
  LLY: "Healthcare", JNJ: "Healthcare", UNH: "Healthcare", ABBV: "Healthcare",
  MRK: "Healthcare", TMO: "Healthcare", ABT: "Healthcare", DHR: "Healthcare",
  AMGN: "Healthcare", ISRG: "Healthcare", CVS: "Healthcare", MCK: "Healthcare",
  XOM: "Energy", CVX: "Energy", COP: "Energy", SLB: "Energy", EOG: "Energy",
  WMB: "Energy", KMI: "Energy", MPC: "Energy", VLO: "Energy", SU: "Energy",
  CNQ: "Energy", PG: "Consumer", KO: "Consumer", PEP: "Consumer", COST: "Consumer",
  WMT: "Consumer", PM: "Consumer", MO: "Consumer", MDLZ: "Consumer", CL: "Consumer",
  // Curated fixes (2026-06-24 fact-check audit): these fell to the "Technology"
  // default because Finnhub's industry string didn't match - corrected to real GICS.
  GILD: "Healthcare", VRTX: "Healthcare", MNST: "Consumer",
  WM: "Industrials", GEV: "Industrials", JCI: "Industrials", EMR: "Industrials",
  TT: "Industrials", PWR: "Industrials", CRH: "Materials",
};
function sectorFromIndustry(ticker, industry) {
  const o = SECTOR_OVERRIDE[ticker];
  if (o) return o;
  const lower = String(industry ?? "").toLowerCase();
  for (const [needle, sector] of Object.entries(INDUSTRY_TO_SECTOR)) {
    if (lower.includes(needle)) return sector;
  }
  return "Technology";
}
function titleCaseName(desc) {
  const raw = (desc ?? "").trim();
  if (!raw) return "";
  if (raw !== raw.toUpperCase()) return raw;
  return raw.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function fetchUniverse(finnhubKey) {
  const url = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${finnhubKey}`;
  const rows = await getJson(url);
  const names = new Map();
  const seen = new Set();
  const symbols = [];
  if (!Array.isArray(rows)) return { symbols, names };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const symbol = (r.symbol ?? "").trim().toUpperCase();
    if (!symbol || !isCleanRootTicker(symbol)) continue;
    if (NON_PUBLIC_TICKERS.has(symbol)) continue; // private/non-tradeable (SPCX = SpaceX)
    if (!r.type || !KEPT_TYPES.has(r.type)) continue;
    if (r.currency && String(r.currency).toUpperCase() !== "USD") continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
    names.set(symbol, titleCaseName(r.description) || symbol);
  }
  return { symbols, names };
}

// ── 2. Alpaca dollar-volume prefilter (mirrors src/data/alpaca/snapshots) ─────
function dollarVolumeOf(snap) {
  if (!snap || typeof snap !== "object") return 0;
  const bar = snap.prevDailyBar ?? snap.dailyBar;
  const v = Number(bar?.v);
  const vw = Number(bar?.vw ?? bar?.c);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const px = Number.isFinite(vw) && vw > 0 ? vw : Number(snap.latestTrade?.p) || 0;
  return Math.max(0, v * px);
}

async function fetchDollarVolumes(symbols, id, secret) {
  const headers = { "APCA-API-KEY-ID": id, "APCA-API-SECRET-KEY": secret };
  const vols = new Map();
  const batchSize = 200;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const url = `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(
      batch.join(","),
    )}&feed=iex`;
    try {
      const json = await getJson(url, headers);
      const inner = json && json.snapshots && typeof json.snapshots === "object" ? json.snapshots : json;
      for (const [sym, snap] of Object.entries(inner ?? {})) {
        if (!snap || typeof snap !== "object" || Array.isArray(snap)) continue;
        const dv = dollarVolumeOf(snap);
        if (dv > 0) vols.set(sym.toUpperCase(), dv);
      }
    } catch {
      /* skip a dead batch - partial coverage beats aborting */
    }
    if ((i / batchSize) % 10 === 0) log(`  snapshots ${Math.min(i + batchSize, symbols.length)}/${symbols.length}`);
  }
  return vols;
}

// ── 3. Finnhub profile2 → market cap (USD) for the candidate set ──────────────
async function fetchMarketCap(symbol, key) {
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(
    symbol,
  )}&token=${key}`;
  try {
    const json = await getJson(url);
    const capM = Number(json?.marketCapitalization); // in $millions
    const name = (json?.name ?? "").trim();
    if (!Number.isFinite(capM) || capM <= 0) return null;
    return { marketCap: Math.round(capM * 1_000_000), name, industry: json?.finnhubIndustry };
  } catch {
    return null;
  }
}

async function main() {
  const keys = loadKeys();
  if (keys.finnhub.length === 0) throw new Error("No Finnhub key (VITE_FINNHUB_API_KEY).");
  if (!keys.alpacaId || !keys.alpacaSecret)
    throw new Error("No Alpaca key (VITE_ALPACA_API_KEY / VITE_ALPACA_API_SECRET).");

  log(`Generating market majors — target ${TARGET}, pricing top ${CANDIDATES} by volume.`);

  const { symbols, names } = await fetchUniverse(keys.finnhub[0]);
  if (symbols.length === 0) throw new Error("Finnhub returned no US common-stock symbols.");
  log(`US common-stock universe: ${symbols.length} symbols.`);

  const vols = await fetchDollarVolumes(symbols, keys.alpacaId, keys.alpacaSecret);
  if (vols.size === 0) throw new Error("Alpaca returned no snapshots — cannot prefilter.");
  log(`Snapshots with volume: ${vols.size}.`);

  const candidates = [...vols.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATES)
    .map(([sym]) => sym);
  log(`Pricing ${candidates.length} most-traded names via Finnhub profile2…`);

  // Round-robin across keys; pace each key under its 60/min free-tier limit.
  const gapMs = Math.ceil(60_000 / (keys.finnhub.length * PER_KEY_PER_MIN));
  const majors = [];
  let droppedArtifacts = 0;
  for (let i = 0; i < candidates.length; i++) {
    const sym = candidates[i];
    const key = keys.finnhub[i % keys.finnhub.length];
    const res = await fetchMarketCap(sym, key);
    if (res) {
      if (res.marketCap > MAX_PLAUSIBLE_CAP) {
        droppedArtifacts++;
        log(`  dropped ${sym}: implausible cap $${(res.marketCap / 1e12).toFixed(1)}T (artifact)`);
      } else {
        majors.push({
          ticker: sym,
          name: res.name || names.get(sym) || sym,
          marketCap: res.marketCap,
          sector: sectorFromIndustry(sym, res.industry),
        });
      }
    }
    if ((i + 1) % 50 === 0 || i === candidates.length - 1) {
      log(`  priced ${i + 1}/${candidates.length} (kept ${majors.length})`);
    }
    if (i < candidates.length - 1) await delay(gapMs);
  }

  majors.sort((a, b) => b.marketCap - a.marketCap);
  const top = majors.slice(0, TARGET);
  if (top.length === 0) throw new Error("No market caps resolved — refusing to write an empty file.");

  // Self-check: the very biggest US names must be present, or the prefilter/keys
  // are broken.
  const present = new Set(top.map((m) => m.ticker));
  const wantAtLeast = ["AAPL", "MSFT", "NVDA"].filter((t) => present.has(t));
  if (wantAtLeast.length < 2) {
    throw new Error(
      `Sanity check failed: expected the mega-caps in the top ${TARGET}, found only [${wantAtLeast.join(", ")}]. Aborting.`,
    );
  }
  // Self-check: no private/non-tradeable pseudo-ticker may leak into the backbone.
  // SPCX (SpaceX) is the canary - it is PRIVATE and must be ABSENT. If it ever
  // reappears, the provider added another synthetic valuation and the denylist
  // above (and src/lib/format.ts NON_PUBLIC_TICKERS) needs the new ticker.
  const leaked = top.filter((m) => NON_PUBLIC_TICKERS.has(m.ticker));
  if (leaked.length > 0) {
    throw new Error(
      `Sanity check failed: private/non-tradeable ticker(s) [${leaked
        .map((m) => m.ticker)
        .join(", ")}] reached the majors backbone. Add them to NON_PUBLIC_TICKERS. Aborting.`,
    );
  }
  // The #1 cap must be plausible - a $60T leader means the ADR/units inflation
  // leaked back in. Apple/Nvidia-class (~$5T) is the real ceiling.
  if (top[0].marketCap > MAX_PLAUSIBLE_CAP) {
    throw new Error(
      `Sanity check failed: top name ${top[0].ticker} reads $${(top[0].marketCap / 1e12).toFixed(1)}T — a cap-inflation artifact. Aborting.`,
    );
  }

  const generatedAt = new Date().toISOString();
  const rows = top.map((m) => ({ t: m.ticker, n: m.name, c: m.marketCap, s: m.sector }));
  const raw = JSON.stringify(rows);
  const banner = "// AUTO-GENERATED by scripts/gen-market-majors.mjs — do not edit by hand.\n";
  const body =
    banner +
    "// Top US common stocks by market cap — the Market Map backbone (see the script\n" +
    "// header for the free data path + refresh command). Regenerate weekly.\n" +
    'import type { Sector } from "@/types";\n' +
    "export type MajorRow = { ticker: string; name: string; marketCap: number; sector: Sector };\n" +
    `const RAW = ${JSON.stringify(raw)};\n` +
    "const ROWS: { t: string; n: string; c: number; s: Sector }[] = JSON.parse(RAW);\n" +
    "export const MARKET_MAJORS: MajorRow[] = ROWS.map((r) => ({ ticker: r.t, name: r.n, marketCap: r.c, sector: r.s }));\n" +
    "export const MARKET_MAJOR_TICKERS: string[] = MARKET_MAJORS.map((m) => m.ticker);\n" +
    "/** Trusted GICS-ish sector by ticker (real Finnhub industry + curated overrides). */\n" +
    "export const MARKET_MAJOR_SECTOR: Record<string, Sector> = Object.fromEntries(\n" +
    "  MARKET_MAJORS.map((m) => [m.ticker, m.sector]),\n" +
    ");\n" +
    `export const MARKET_MAJORS_META = ${JSON.stringify({
      generatedAt,
      count: top.length,
      source: "finnhub-profile2",
    })} as const;\n`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body, "utf8");

  const spcx = top.find((m) => m.ticker === "SPCX");
  log(`Wrote ${OUT}`);
  log(`Majors: ${top.length}. Top 12: ${top.slice(0, 12).map((m) => `${m.ticker}($${(m.marketCap / 1e12).toFixed(2)}T)`).join(" ")}`);
  log(`SPCX (SpaceX, private): ${spcx ? `LEAKED — should be absent!` : "absent (correct)"}`);
}

main()
  .then(() => {
    log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("gen-market-majors failed:", err);
    process.exit(1);
  });
