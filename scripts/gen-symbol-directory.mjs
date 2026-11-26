// AUTO-GENERATION SCRIPT for the offline symbol directory.
//
// Reads already-downloaded exchange listing files from scripts/_symdata/ and
// emits src/data/symbols/listings.generated.ts - the bundled, offline source of
// truth for "every real ticker is findable" across the whole app.
//
// Sources:
//   • US - NASDAQ Trader nasdaqlisted.txt + otherlisted.txt (keyless, daily, ~12.8k)
//   • CA - TMX Money company directory JSON for TSX (_tmx_tsx.json) and TSXV
//           (_tmx_tsxv.json) - the canonical, current, free issuer directory.
//           Each company's `instruments[]` expand to Yahoo-style symbols
//           ("GIB.A" → "GIB-A.TO", every share class / unit / debenture series).
//   • CA - CBOE_CA: a verified Cboe Canada (.NE) supplement. cboe.ca's live
//           directory is Cloudflare-gated and its CDN is a locked S3 bucket, so
//           there's no comprehensive free Cboe feed to bulk-pull; instead each
//           name below was confirmed against Yahoo's keyless chart endpoint as a
//           live "Cboe CA" listing (see REFRESH note). Comprehensive Cboe Canada
//           coverage is the one gap - TSX/TSXV (the bulk of Canada) is complete.
//   • CA - CURATED_CA: the TSX-60 spine + current/critical names, last so their
//           clean names win over the bulk directory on symbol collision.
//   • US - CURATED_US: brand-new names not yet in the NASDAQ Trader file.
//
// REFRESH (re-run after re-downloading _symdata):
//   US:  curl -s -o scripts/_symdata/nasdaqlisted.txt https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt
//        curl -s -o scripts/_symdata/otherlisted.txt   https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt
//   CA:  curl -s "https://www.tsx.com/json/company-directory/search/tsx/%5E"  > scripts/_symdata/_tmx_tsx.json
//        curl -s "https://www.tsx.com/json/company-directory/search/tsxv/%5E" > scripts/_symdata/_tmx_tsxv.json
//        (the "^" letter returns the ENTIRE directory in one call.)
//   Cboe: verify candidates via https://query1.finance.yahoo.com/v8/finance/chart/<SYM>.NE
//         keeping rows whose meta.fullExchangeName is "Cboe CA".
//   Then: `node scripts/gen-symbol-directory.mjs`
//   No network here; no Date.now()/new Date() (keeps output byte-stable).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "scripts", "_symdata");
const OUT = join(ROOT, "src", "data", "symbols", "listings.generated.ts");

/** otherlisted.txt single-letter exchange codes → display names. */
const OTHER_EXCHANGE = { A: "NYSE American", N: "NYSE", P: "NYSE Arca", Z: "Cboe", V: "IEX" };

/** Brand-new US names sometimes missing from the daily NASDAQ Trader file. */
const CURATED_US = [
  ["INFQ", "Infleqtion, Inc.", "NASDAQ"],
  ["NBIS", "Nebius Group N.V.", "NASDAQ"],
];

/** Current/critical Canadian names the stale dump misses + the TSX-60 spine. */
const CURATED_CA = [
  ["MDA.TO", "MDA Space Ltd.", "TSX"],
  ["GCU.TO", "Gunnison Copper Corp.", "TSX"],
  ["DEFI.NE", "DeFi Technologies Inc.", "Cboe Canada"],
  ["SHOP.TO", "Shopify Inc.", "TSX"],
  ["RY.TO", "Royal Bank of Canada", "TSX"],
  ["TD.TO", "Toronto-Dominion Bank", "TSX"],
  ["BNS.TO", "Bank of Nova Scotia", "TSX"],
  ["BMO.TO", "Bank of Montreal", "TSX"],
  ["CM.TO", "Canadian Imperial Bank of Commerce", "TSX"],
  ["NA.TO", "National Bank of Canada", "TSX"],
  ["ENB.TO", "Enbridge Inc.", "TSX"],
  ["TRP.TO", "TC Energy Corporation", "TSX"],
  ["CNQ.TO", "Canadian Natural Resources Limited", "TSX"],
  ["SU.TO", "Suncor Energy Inc.", "TSX"],
  ["CVE.TO", "Cenovus Energy Inc.", "TSX"],
  ["IMO.TO", "Imperial Oil Limited", "TSX"],
  ["PPL.TO", "Pembina Pipeline Corporation", "TSX"],
  ["CP.TO", "Canadian Pacific Kansas City Limited", "TSX"],
  ["CNR.TO", "Canadian National Railway Company", "TSX"],
  ["BN.TO", "Brookfield Corporation", "TSX"],
  ["BAM.TO", "Brookfield Asset Management Ltd.", "TSX"],
  ["CSU.TO", "Constellation Software Inc.", "TSX"],
  ["GIB-A.TO", "CGI Inc.", "TSX"],
  ["MFC.TO", "Manulife Financial Corporation", "TSX"],
  ["SLF.TO", "Sun Life Financial Inc.", "TSX"],
  ["GWO.TO", "Great-West Lifeco Inc.", "TSX"],
  ["IFC.TO", "Intact Financial Corporation", "TSX"],
  ["FFH.TO", "Fairfax Financial Holdings Limited", "TSX"],
  ["ATD.TO", "Alimentation Couche-Tard Inc.", "TSX"],
  ["L.TO", "Loblaw Companies Limited", "TSX"],
  ["MRU.TO", "Metro Inc.", "TSX"],
  ["QSR.TO", "Restaurant Brands International Inc.", "TSX"],
  ["DOL.TO", "Dollarama Inc.", "TSX"],
  ["WCN.TO", "Waste Connections, Inc.", "TSX"],
  ["TRI.TO", "Thomson Reuters Corporation", "TSX"],
  ["MG.TO", "Magna International Inc.", "TSX"],
  ["AEM.TO", "Agnico Eagle Mines Limited", "TSX"],
  ["ABX.TO", "Barrick Gold Corporation", "TSX"],
  ["FNV.TO", "Franco-Nevada Corporation", "TSX"],
  ["WPM.TO", "Wheaton Precious Metals Corp.", "TSX"],
  ["K.TO", "Kinross Gold Corporation", "TSX"],
  ["NTR.TO", "Nutrien Ltd.", "TSX"],
  ["FM.TO", "First Quantum Minerals Ltd.", "TSX"],
  ["TECK-B.TO", "Teck Resources Limited", "TSX"],
  ["CCO.TO", "Cameco Corporation", "TSX"],
  ["T.TO", "TELUS Corporation", "TSX"],
  ["BCE.TO", "BCE Inc.", "TSX"],
  ["RCI-B.TO", "Rogers Communications Inc.", "TSX"],
  ["FTS.TO", "Fortis Inc.", "TSX"],
  ["EMA.TO", "Emera Incorporated", "TSX"],
  ["H.TO", "Hydro One Limited", "TSX"],
  ["HUT.TO", "Hut 8 Corp.", "TSX"],
  ["WEED.TO", "Canopy Growth Corporation", "TSX"],
  ["ACB.TO", "Aurora Cannabis Inc.", "TSX"],
];

/**
 * Verified Cboe Canada (.NE) listings. There is no comprehensive free Cboe
 * Canada feed reachable here (cboe.ca is Cloudflare-gated, its CDN is a locked
 * S3 bucket), so this is NOT exhaustive - but every entry was confirmed live on
 * "Cboe CA" via Yahoo's keyless chart endpoint (see the REFRESH note up top), so
 * nothing here is a guess. TSX/TSXV (the overwhelming bulk of Canada) is pulled
 * comprehensively from TMX; Cboe Canada is the one slice still curated.
 */
const CBOE_CA = [
  ["AIAI.NE", "NetraMark Holdings Inc."],
  ["ALEX.NE", "Alpha Exploration Ltd."],
  ["BIGG.NE", "BIGG Digital Assets Inc."],
  ["BMND.NE", "Biomind Labs Inc."],
  ["BRAG.NE", "Bragg Gaming Group Inc."],
  ["BTCQ.NE", "3iQ Bitcoin ETF"],
  ["CXI.NE", "Currency Exchange International, Corp."],
  ["CYM.NE", "Cymat Technologies Ltd."],
  ["DEFI.NE", "DeFi Technologies Inc."],
  ["ELVA.NE", "Electrovaya Inc."],
  ["ETHQ.NE", "3iQ Ether Staking ETF"],
  ["FOOD.NE", "Goodfood Market Corp."],
  ["GLD.NE", "Gold Finder Resources Limited"],
  ["HASH.NE", "Simply Solventless Concentrates Ltd."],
  ["HEAL.NE", "Restart Life Sciences Corp."],
  ["HODL.NE", "Sol Strategies Inc."],
  ["JPEG.NE", "Pioneer AI Foundry Inc."],
  ["KNT.NE", "K92 Mining Inc."],
  ["LQWD.NE", "LQwD Technologies Corp."],
  ["MAXQ.NE", "Maritime Launch Services Inc."],
  ["MUSH.NE", "Mercanto Holdings Inc."],
  ["NCAP.NE", "Ninepoint Capital Appreciation ETF"],
  ["NEXT.NE", "NextSource Materials Inc."],
  ["NTAR.NE", "Nextech3D.AI Corporation"],
  ["NWST.NE", "Northwest Copper Corp."],
  ["NXTG.NE", "First Trust Indxx NextG ETF"],
  ["PSYC.NE", "Psyched Wellness Ltd."],
  ["RVX.NE", "Resverlogix Corp."],
  ["VERS.NE", "VERSES AI Inc."],
  ["WELL.NE", "WELL Health Technologies Corp."],
  ["WNDR.NE", "WonderFi Technologies Inc."],
];

function parsePipeFile(path, { symIdx, nameIdx, etfIdx, testIdx, exchangeIdx, exchange, country }) {
  const out = [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.warn(`[gen] WARN: could not read ${path} — skipping`);
    return out;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("File Creation Time")) continue;
    const cols = line.split("|");
    if (cols.length < 4) continue;
    const symbol = (cols[symIdx] || "").trim().toUpperCase();
    if (!symbol) continue;
    if (testIdx != null && (cols[testIdx] || "").trim() === "Y") continue;
    const name = (cols[nameIdx] || "").trim();
    const ex = exchangeIdx != null ? OTHER_EXCHANGE[(cols[exchangeIdx] || "").trim()] || "NYSE" : exchange;
    const isEtf = etfIdx != null && (cols[etfIdx] || "").trim() === "Y" ? 1 : 0;
    out.push({ s: symbol, n: name || symbol, x: ex, c: country, e: isEtf });
  }
  return out;
}

/**
 * Heuristic ETF flag for the TMX/Cboe directories, which (unlike NASDAQ Trader)
 * carry no machine ETF column. Deliberately tight - only an explicit "ETF"/"ETN"
 * token, "Index Fund", or an iShares product - so an operating company that
 * merely has "Fund" or "Capital" in its name is never mislabeled as an ETF.
 */
function isEtfName(name) {
  const n = String(name || "").toLowerCase();
  return /\betf\b/.test(n) || /\betn\b/.test(n) || /\bindex fund\b/.test(n) || n.includes("ishares")
    ? 1
    : 0;
}

/**
 * Convert a TMX trading symbol to the app's Yahoo-style form: internal "."
 * (share class / unit / debenture series) becomes "-", then the exchange suffix
 * is appended. "GIB.A" → "GIB-A.TO"; "AP.UN" → "AP-UN.TO"; "AW" → "AW.TO".
 */
function tmxSymbol(raw, suffix) {
  return `${String(raw).trim().toUpperCase().replace(/\./g, "-")}${suffix}`;
}

/**
 * Parse a TMX Money company-directory JSON ({ results: [{ symbol, name,
 * instruments: [{ symbol, name }] }] }) into compact rows. Every instrument
 * (share class, USD line, REIT unit, debenture series) is emitted under the
 * company's full name so each is independently findable.
 */
function parseTmx(path, { exchange, suffix }) {
  const out = [];
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.warn(`[gen] WARN: could not read/parse ${path} — skipping ${exchange}`);
    return out;
  }
  const results = Array.isArray(json?.results) ? json.results : [];
  for (const co of results) {
    const name = String(co?.name || "").trim();
    const instruments =
      Array.isArray(co?.instruments) && co.instruments.length
        ? co.instruments
        : [{ symbol: co?.symbol }];
    for (const inst of instruments) {
      const rawSym = String(inst?.symbol || co?.symbol || "").trim();
      if (!rawSym) continue;
      const display = name || rawSym;
      out.push({ s: tmxSymbol(rawSym, suffix), n: display, x: exchange, c: "CA", e: isEtfName(display) });
    }
  }
  return out;
}

function curated(rows, country) {
  return rows.map(([s, n, x]) => ({ s: s.toUpperCase(), n, x, c: country, e: 0 }));
}

/** Build the verified Cboe Canada rows (.NE), flagging ETFs by name. */
function cboe(rows) {
  return rows.map(([s, n]) => ({ s: s.toUpperCase(), n, x: "Cboe Canada", c: "CA", e: isEtfName(n) }));
}

// Order matters: later sources overwrite earlier on symbol collision, so the
// curated supplements (authoritative, current) win over the bulk/stale lists.
const all = [
  ...parsePipeFile(join(DATA, "nasdaqlisted.txt"), { symIdx: 0, nameIdx: 1, testIdx: 3, etfIdx: 6, exchange: "NASDAQ", country: "US" }),
  ...parsePipeFile(join(DATA, "otherlisted.txt"), { symIdx: 0, nameIdx: 1, exchangeIdx: 2, etfIdx: 4, testIdx: 6, country: "US" }),
  ...parseTmx(join(DATA, "_tmx_tsx.json"), { exchange: "TSX", suffix: ".TO" }),
  ...parseTmx(join(DATA, "_tmx_tsxv.json"), { exchange: "TSXV", suffix: ".V" }),
  ...cboe(CBOE_CA),
  ...curated(CURATED_US, "US"),
  ...curated(CURATED_CA, "CA"),
];

const bySymbol = new Map();
for (const r of all) bySymbol.set(r.s, r);
const rows = [...bySymbol.values()].sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));

const counts = {
  total: rows.length,
  us: rows.filter((r) => r.c === "US").length,
  ca: rows.filter((r) => r.c === "CA").length,
};

const raw = JSON.stringify(rows);
const banner = "// AUTO-GENERATED by scripts/gen-symbol-directory.mjs — do not edit by hand.\n";
const body =
  banner +
  `export type CompactRow = { s: string; n: string; x: string; c: "US" | "CA"; e: 0 | 1 };\n` +
  `const RAW = ${JSON.stringify(raw)};\n` +
  `export const SYMBOL_ROWS: CompactRow[] = JSON.parse(RAW);\n` +
  `export const SYMBOL_COUNTS = ${JSON.stringify(counts)} as const;\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, "utf8");
console.log(`[gen] wrote ${OUT}`);
console.log(`[gen] counts:`, counts);
