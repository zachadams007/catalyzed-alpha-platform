import type { CatalystType } from "@/types";
import { httpJson } from "@/data/http";
import { secEndpoint } from "@/data/sec/secEndpoint";
import { type CatalystEvent, daysAwayFrom, eventStrength } from "./catalystEvent";

/**
 * SEC SC 13D / 13G beneficial-ownership filings → structured catalyst events.
 *
 * WHY THIS IS GENUINELY NEW SIGNAL
 * --------------------------------
 * An investor crossing 5% of a company's stock must disclose it:
 *   • SC 13D - an ACTIVIST stake (intent to influence/control). A documented
 *     same-day catalyst - the market re-rates on "a known activist is in."
 *   • SC 13G - a PASSIVE institutional stake (no control intent). Softer
 *     conviction, but a credible institution sizing into a name still matters.
 * Neither is covered by the 8-K, Form 4 (insider), or congressional sources -
 * those are issuer events / insider trades, not third-party stake crossings.
 *
 * The catalyst type is `"Institutional"` (NOT `"Insider"` - a 5%-crossing fund is
 * not a company insider). Amendments (13D/A, 13G/A) carry a position CHANGE:
 * an exit/reduction is read as a negative catalyst, an increase as positive.
 *
 * MATERIALITY (major players only, noise filtered)
 * --------------------------------------------------------------
 * Passive INDEX-FUND 13Gs (Vanguard / BlackRock / State Street / Fidelity, etc.)
 * are mechanical re-balancing, not conviction - they are filtered out as noise.
 * An ACTIVIST 13D is the high-materiality event; a non-index 13G is medium.
 *
 * Keyless + bounded: ONE market-wide EFTS call per form per scan (same endpoint,
 * UA, and rate contract as edgar8kCatalysts.ts). Degrades to [] on any error.
 */

/** Materiality tiers for a fresh stake crossing (pre-recency magnitude, 0..1). */
const MAG_ACTIVIST_13D = 0.8; // a known activist crossing 5% - high signal
const MAG_PASSIVE_13G = 0.45; // a non-index institution sizing in - medium

/** Index-fund / mega-passive filer names that are mechanical noise on a 13G. */
const INDEX_FUND_FILERS = [
  "vanguard",
  "blackrock",
  "state street",
  "fidelity",
  "fmr llc",
  "geode capital",
  "dimensional fund",
  "norges bank",
  "t. rowe price",
  "t rowe price",
  "invesco",
  "charles schwab",
  "northern trust",
  "bank of america",
  "morgan stanley",
  "jpmorgan",
  "j.p. morgan",
  "goldman sachs",
  "ubs group",
  "wellington management",
];

/** True when the filer is a mega-passive index manager (a mechanical 13G ⇒ noise). */
export function isIndexFundFiler(filerName: string | undefined): boolean {
  const f = (filerName ?? "").toLowerCase();
  if (!f) return false;
  return INDEX_FUND_FILERS.some((needle) => f.includes(needle));
}

export interface ThirteenDInput {
  /** Issuer ticker (the stock the stake is IN). */
  ticker: string;
  /** Issuer company name. */
  companyName?: string;
  /** Name of the FILER (the fund / activist crossing 5%). */
  filerName?: string;
  /** Root form: "SC 13D" or "SC 13G" (amendments collapse to the root here). */
  rootForm: "SC 13D" | "SC 13G";
  /** True when this is an amendment (13D/A or 13G/A) - a position CHANGE. */
  amendment: boolean;
  /** ISO filing date. */
  dateIso: string;
  /** Direct EDGAR filing-index URL. */
  url: string;
  /**
   * Position-change sign on an amendment, if parseable from the EFTS text:
   *  -1 = reduced/exited (negative), +1 = increased (positive), 0/undefined =
   *  unknown (treated as neutral-positive - still a disclosed stake). The EFTS
   *  metadata does not carry the % delta, so this is optional and usually absent;
   *  a full-text parse would set it. Kept in the contract so a later enrichment
   *  can populate it without a shape change.
   */
  changeSign?: -1 | 0 | 1;
}

/**
 * Map one 13D/13G filing to a catalyst event. Returns null when it has no issuer
 * ticker or is a filtered index-fund 13G. Pure - the clock is injected.
 */
export function thirteenDToCatalystEvent(
  input: ThirteenDInput,
  now: number = Date.now(),
): CatalystEvent | null {
  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker) return null;

  const isActivist = input.rootForm === "SC 13D";
  // Filter mega-passive index-fund 13Gs - mechanical, not conviction.
  if (!isActivist && isIndexFundFiler(input.filerName)) return null;

  // An amendment that DISCLOSES A REDUCTION/EXIT is a negative catalyst.
  const negative = input.amendment && input.changeSign === -1;
  const baseMag = isActivist ? MAG_ACTIVIST_13D : MAG_PASSIVE_13G;
  // An amendment (no fresh crossing) is somewhat less material than the initial.
  const mag = input.amendment ? baseMag * 0.7 : baseMag;

  const daysAway = daysAwayFrom(input.dateIso, now);
  const catalystType: CatalystType = "Institutional";
  const filer = input.filerName ? `${input.filerName} ` : "";
  const action = input.amendment
    ? negative
      ? "reduced / exited a"
      : "amended a"
    : "disclosed a new";
  const stakeWord = isActivist ? "activist (13D)" : "5%+ (13G)";
  const lead = input.companyName ? `${input.companyName} — ` : "";

  return {
    ticker,
    catalystType,
    date: input.dateIso,
    summary: `${lead}${filer}${action} ${stakeWord} stake`,
    sourceUrl: input.url,
    magnitude: mag,
    strength: eventStrength(mag, daysAway, negative),
    negative,
  };
}

/** Map a batch of 13D/13G filings to events, dropping unscorable/filtered ones. */
export function thirteenDsToCatalystEvents(
  inputs: readonly ThirteenDInput[],
  now: number = Date.now(),
): CatalystEvent[] {
  const out: CatalystEvent[] = [];
  for (const input of inputs) {
    const ev = thirteenDToCatalystEvent(input, now);
    if (ev) out.push(ev);
  }
  return out;
}

// --------------------------------------------------------------------------
// Live fetch (I/O) - keyless EFTS, bounded, degrades to []. Pure mappers above
// are unit-tested; this thin network wrapper is not (same convention as 8-K).
// --------------------------------------------------------------------------

interface EftsSource {
  adsh?: string;
  ciks?: string[];
  display_names?: string[];
  file_date?: string;
  file_type?: string;
  root_forms?: string[];
}
interface EftsHit {
  _id?: string;
  _source?: EftsSource;
}
interface EftsResponse {
  hits?: { hits?: EftsHit[] };
}

const USER_AGENT = "Catalyzed Alpha research (contact: contact@example.com)";

function eftsSearchUrl(): string {
  return secEndpoint("efts", "/LATEST/search-index");
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Pull "(SYM)" + company name out of an EDGAR display name, stripping "(CIK …)". */
function parseDisplayName(dn: string): { company: string; ticker: string } {
  const cikMatch = dn.match(/\(CIK\s+\d+\)\s*$/i);
  const head = (cikMatch && cikMatch.index != null ? dn.slice(0, cikMatch.index) : dn).trim();
  const tk = head.match(/\(([A-Za-z0-9.\-]{1,10}(?:\s*,\s*[A-Za-z0-9.\-]{1,10})*)\)\s*$/);
  if (tk && tk.index != null) {
    const ticker = tk[1].split(",")[0]?.trim().toUpperCase() ?? "";
    return { company: head.slice(0, tk.index).trim(), ticker };
  }
  return { company: head, ticker: "" };
}

/** Strip the trailing "(CIK …)" / "(TICKER)" to recover a clean filer name. */
function cleanFilerName(dn: string | undefined): string {
  if (!dn) return "";
  return dn
    .replace(/\(CIK\s+\d+\)\s*$/i, "")
    .replace(/\(([A-Za-z0-9.\-]{1,10}(?:\s*,\s*[A-Za-z0-9.\-]{1,10})*)\)\s*$/, "")
    .trim();
}

function indexUrl(cikPadded: string | undefined, accession: string): string {
  const cikInt = String(parseInt(cikPadded ?? "0", 10) || 0);
  const folder = accession.replace(/-/g, "");
  return secEndpoint("www", `/Archives/edgar/data/${cikInt}/${folder}/${accession}-index.htm`);
}

/** Parse one EFTS hit into a `ThirteenDInput` (or null if no issuer ticker). */
export function eftsHitToThirteenDInput(
  s: EftsSource,
  hitId: string | undefined,
): ThirteenDInput | null {
  const accession = s.adsh || hitId?.split(":")[0] || "";
  if (!accession) return null;
  const fileType = (s.file_type || "").toUpperCase();
  const root = (s.root_forms?.[0] || fileType).toUpperCase();
  const isD = root.startsWith("SC 13D") || fileType.startsWith("SC 13D");
  const isG = root.startsWith("SC 13G") || fileType.startsWith("SC 13G");
  if (!isD && !isG) return null;

  // For 13D/G the ISSUER (the stock) is the first display_name; the FILER second.
  const issuer = parseDisplayName(s.display_names?.[0] ?? "");
  if (!issuer.ticker) return null;
  const filerName = cleanFilerName(s.display_names?.[1]);

  return {
    ticker: issuer.ticker,
    companyName: issuer.company || undefined,
    filerName: filerName || undefined,
    rootForm: isD ? "SC 13D" : "SC 13G",
    amendment: fileType.includes("/A"),
    dateIso: s.file_date || ymd(new Date()),
    url: indexUrl(s.ciks?.[0], accession),
  };
}

async function fetchForm(
  rootForm: "SC 13D" | "SC 13G",
  startdt: string,
  enddt: string,
  limit: number,
): Promise<ThirteenDInput[]> {
  const forms = encodeURIComponent(rootForm);
  const url = `${eftsSearchUrl()}?forms=${forms}&startdt=${startdt}&enddt=${enddt}`;
  const res = await httpJson<EftsResponse>(url, {
    headers: { "User-Agent": USER_AGENT },
    timeoutMs: 12_000,
  });
  const hits = res.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const seen = new Set<string>();
  const inputs: ThirteenDInput[] = [];
  for (const hit of hits) {
    if (!hit._source) continue;
    const accession = hit._source.adsh || hit._id?.split(":")[0] || "";
    if (!accession || seen.has(accession)) continue;
    const input = eftsHitToThirteenDInput(hit._source, hit._id);
    if (!input) continue;
    seen.add(accession);
    inputs.push(input);
    if (inputs.length >= limit) break;
  }
  return inputs;
}

/**
 * Fetch recent market-wide SC 13D + SC 13G filings and map them to catalyst
 * events. Two EFTS calls (one per form), collapsed per accession, bounded by
 * `limit` per form. Degrades to [] on any error.
 */
export async function fetchEdgar13DCatalystEvents(
  limit = 150,
  lookbackDays = 14,
): Promise<CatalystEvent[]> {
  try {
    const today = new Date();
    const from = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const startdt = ymd(from);
    const enddt = ymd(today);
    const [d, g] = await Promise.all([
      fetchForm("SC 13D", startdt, enddt, limit).catch(() => [] as ThirteenDInput[]),
      fetchForm("SC 13G", startdt, enddt, limit).catch(() => [] as ThirteenDInput[]),
    ]);
    return thirteenDsToCatalystEvents([...d, ...g]);
  } catch {
    return [];
  }
}
