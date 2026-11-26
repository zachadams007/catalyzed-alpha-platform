/**
 * Operator diagnostic: compare Finnhub's US common-stock eligible set against
 * the $0 NASDAQ Trader symbol directories (nasdaqlisted.txt + otherlisted.txt).
 *
 * This does NOT clear admission quarantine by itself. The archive contract still
 * requires an independently proven completeness claim wired into
 * deriveQuarantineReasons; this script only measures how far a lawful $0
 * exchange-directory cross-check can go today and reports the residual gap.
 *
 * Usage:
 *   npx tsx scripts/universe_scan/checkFinnhubCompleteness.mts
 *
 * Requires VITE_FINNHUB_API_KEY (or FINNHUB_API_KEY) in the environment / .scan.env.
 * Spend: $0. Sanctioned sources only.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fetchUsCommonStockUniverseAudited } from "../../src/data/finnhub/symbolList";
import "./bootstrap.mjs";

const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt";
const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt";

const NON_COMMON_NAME =
  /\b(ETF|ETN|ETP|Fund|Trust|Warrant|Right|Unit|Preferred|Note|Bond|Debenture|Future|Option|Index|Depositary Share|ADS|ADR)\b/i;
const COMMONISH_NAME =
  /\b(Common Stock|Ordinary Shares|Ordinary Share|Class [A-Z] Common Stock|REIT)\b/i;

function isCleanRoot(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol);
}

function parsePipeRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("File Creation Time"))
    .slice(1)
    .map((line) => line.split("|"));
}

function parseNasdaqListed(text: string): Set<string> {
  const out = new Set<string>();
  for (const parts of parsePipeRows(text)) {
    const symbol = (parts[0] ?? "").trim().toUpperCase();
    const name = parts[1] ?? "";
    const testIssue = parts[3] ?? "";
    const etf = parts[6] ?? "";
    if (!isCleanRoot(symbol) || testIssue === "Y" || etf === "Y") continue;
    // NASDAQ-listed rows lack a clean security-type column; exclude obvious non-commons by name.
    if (NON_COMMON_NAME.test(name) && !COMMONISH_NAME.test(name)) continue;
    if (!COMMONISH_NAME.test(name) && /\b(Acquisition|Sponsorship|Rights|Units)\b/i.test(name)) continue;
    out.add(symbol);
  }
  return out;
}

function parseOtherListed(text: string): Set<string> {
  const out = new Set<string>();
  for (const parts of parsePipeRows(text)) {
    const symbol = (parts[0] ?? "").trim().toUpperCase();
    const name = parts[1] ?? "";
    const etf = parts[4] ?? "";
    const testIssue = parts[6] ?? "";
    if (!isCleanRoot(symbol) || testIssue === "Y" || etf === "Y") continue;
    // Prefer explicit common/REIT naming on NYSE/ARCA/etc. rows.
    if (!COMMONISH_NAME.test(name)) continue;
    if (NON_COMMON_NAME.test(name) && !/\bREIT\b/i.test(name)) continue;
    out.add(symbol);
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const [nasdaqText, otherText, finnhub] = await Promise.all([
    fetchText(NASDAQ_LISTED_URL),
    fetchText(OTHER_LISTED_URL),
    fetchUsCommonStockUniverseAudited(),
  ]);

  const nasdaq = parseNasdaqListed(nasdaqText);
  const other = parseOtherListed(otherText);
  const reference = new Set<string>([...nasdaq, ...other]);
  const finnhubSet = new Set(finnhub.entries.map((entry) => entry.symbol));

  const missingFromFinnhub = [...reference].filter((ticker) => !finnhubSet.has(ticker)).sort();
  const extraInFinnhub = [...finnhubSet].filter((ticker) => !reference.has(ticker)).sort();

  const report = {
    checkedAtISO: new Date().toISOString(),
    sources: {
      nasdaqListedUrl: NASDAQ_LISTED_URL,
      otherListedUrl: OTHER_LISTED_URL,
      finnhubEndpoint: finnhub.audit.endpoint,
      finnhubStatus: finnhub.audit.status,
    },
    counts: {
      nasdaqReferenceRoots: nasdaq.size,
      otherReferenceRoots: other.size,
      unionReferenceRoots: reference.size,
      finnhubEligible: finnhubSet.size,
      missingFromFinnhub: missingFromFinnhub.length,
      extraInFinnhub: extraInFinnhub.length,
    },
    /** Strict subset proof the admission contract would need. */
    independentCompletenessWouldPass:
      finnhub.audit.status === "minimum_coverage_met" &&
      reference.size >= finnhub.audit.minimumExpectedEligibleCount &&
      missingFromFinnhub.length === 0,
    residualGap: [
      "NASDAQ Trader directories do not label ADR/REIT/Common Stock the same way Finnhub's type field does; name heuristics are approximate.",
      "Finnhub exchange=US may include names outside the two NASDAQ Trader files (and vice versa).",
      "Admission still quarantines as finnhub_universe_completeness_unproven until a validated mapping is wired into deriveQuarantineReasons with sealed audit fields — this diagnostic does not mutate that gate.",
    ],
    sampleMissingFromFinnhub: missingFromFinnhub.slice(0, 40),
    sampleExtraInFinnhub: extraInFinnhub.slice(0, 40),
  };

  const outPath = resolve("scripts/universe_scan/learning-archive/_completeness-diagnostic.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
