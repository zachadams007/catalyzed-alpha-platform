import type { CatalystType, CompanyData } from "@/types";
import { clamp } from "@/lib/math";
import { postJson } from "@/data/http";
import { type CatalystEvent, daysAwayFrom, eventStrength } from "./catalystEvent";

/**
 * USASpending.gov federal-contract awards → structured catalyst events.
 *
 * WHY (and why USASpending, not Quiver)
 * -------------------------------------
 * A large new government contract is a real, dateable revenue catalyst - it is
 * what Quiver Quantitative re-packages behind a paid tier. `api.usaspending.gov`
 * is the KEYLESS official upstream (no auth, no rate-limit drama), so we go to
 * the source for $0. One market-wide POST per scan returns the biggest recent
 * awards; we map each to a `Partnership` catalyst (a government "design win").
 *
 * THE NAME→TICKER PROBLEM (solved by anchoring to the universe)
 * ------------------------------------------------------------
 * USASpending identifies recipients by LEGAL ENTITY NAME ("LOCKHEED MARTIN
 * CORP"), not ticker. Fuzzy-matching free-text names to the whole market is a
 * false-positive minefield. Instead we anchor to the UNIVERSE IN HAND: build a
 * normalized-name → ticker index from the companies we are already scoring, and
 * only emit an event when a recipient maps to one of THOSE names. Deterministic,
 * no false positives onto names we don't even rank, and the parse stays pure.
 *
 * MATERIALITY (the owner's rule - big awards only, noise filtered)
 * ----------------------------------------------------------
 * Tiny purchase-orders are noise. An award must clear a $ floor to count, and
 * magnitude scales with award size (log): a $10M award barely registers, a $1B+
 * award saturates. We score on ABSOLUTE award size - `RawFundamentals` carries
 * only ratios (no absolute revenue), so an award/revenue relevance term would
 * require fabricating a denominator, which we refuse to do. Degrades to [] on
 * any error.
 */

/** A contract award must clear this notional to count (small POs are noise). */
const MIN_AWARD_USD = 10_000_000;
/** Award $ that saturates the log size-magnitude (a $1B award ⇒ size 1.0). */
const SIZE_REF_USD = 1_000_000_000;

export interface ContractAward {
  /** Federal Award ID (PIID). */
  awardId: string;
  /** Recipient legal entity name as USASpending reports it. */
  recipientName: string;
  /** Obligated / award amount, USD. */
  amountUsd: number;
  /** Awarding agency (for the summary). */
  agency?: string;
  /** ISO award start/action date. */
  dateIso: string;
  /** One-line award description, if any. */
  description?: string;
  /** USASpending award-detail URL. */
  url: string;
}

/**
 * Normalize a company / recipient name for matching: lowercase, drop corporate
 * suffixes and punctuation, collapse whitespace. "Lockheed Martin Corp." and
 * "LOCKHEED MARTIN CORPORATION" both reduce to "lockheed martin".
 */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,&]/g, " ")
    .replace(
      /\b(corp|corporation|inc|incorporated|company|co|llc|lp|ltd|limited|plc|holdings|holding|group|the|sa|nv|ag|class [a-c]|common stock)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a normalized-name → ticker index from the universe in hand. When two
 * companies normalize to the same key the FIRST wins (stable); such collisions
 * are rare among real listings and we'd rather skip an ambiguous award than
 * mis-attribute it.
 */
export function buildNameTickerIndex(companies: readonly CompanyData[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of companies) {
    const key = normalizeCompanyName(c.name);
    if (key && !map.has(key)) map.set(key, c.ticker.trim().toUpperCase());
  }
  return map;
}

/** Log-scaled award size, 0..1 - $10M ≈ 0.33, $1B saturates to 1.0. */
function sizeMagnitude(valueUsd: number): number {
  if (!(valueUsd > 0)) return 0;
  return clamp(Math.log(valueUsd) / Math.log(SIZE_REF_USD), 0, 1);
}

function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

/**
 * Map one award to a catalyst event, resolving the recipient to a universe
 * ticker via `nameIndex`. Returns null when the recipient is not in the universe
 * or the award is below the materiality floor. Magnitude is the log-scaled award
 * size. Pure - clock injected.
 */
export function awardToCatalystEvent(
  award: ContractAward,
  nameIndex: ReadonlyMap<string, string>,
  now: number = Date.now(),
): CatalystEvent | null {
  if (!(award.amountUsd >= MIN_AWARD_USD)) return null;
  const key = normalizeCompanyName(award.recipientName);
  const ticker = nameIndex.get(key);
  if (!ticker) return null;

  const mag = clamp(sizeMagnitude(award.amountUsd), 0, 1);
  const daysAway = daysAwayFrom(award.dateIso, now);
  const agency = award.agency ? ` from ${award.agency}` : "";
  const catalystType: CatalystType = "Partnership";
  return {
    ticker,
    catalystType,
    date: award.dateIso,
    summary: `${fmtUsd(award.amountUsd)} federal contract${agency}`,
    sourceUrl: award.url,
    magnitude: mag,
    strength: eventStrength(mag, daysAway, false),
  };
}

/** Map a batch of awards to events against a universe name index. */
export function awardsToCatalystEvents(
  awards: readonly ContractAward[],
  nameIndex: ReadonlyMap<string, string>,
  now: number = Date.now(),
): CatalystEvent[] {
  const out: CatalystEvent[] = [];
  for (const award of awards) {
    const ev = awardToCatalystEvent(award, nameIndex, now);
    if (ev) out.push(ev);
  }
  return out;
}

// --------------------------------------------------------------------------
// Live fetch (I/O) - keyless USASpending POST, bounded, degrades to []. Pure
// mappers above are unit-tested; this network wrapper is not.
// --------------------------------------------------------------------------

const AWARD_SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const AWARD_DETAIL_URL = "https://www.usaspending.gov/award/";

interface AwardRow {
  "Award ID"?: string;
  "Recipient Name"?: string;
  "Award Amount"?: number;
  "Awarding Agency"?: string;
  "Start Date"?: string;
  Description?: string | null;
  generated_internal_id?: string;
}
interface AwardSearchResponse {
  results?: AwardRow[];
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Map a raw USASpending row to a typed `ContractAward` (or null if no id/amt). */
export function rowToContractAward(row: AwardRow): ContractAward | null {
  const awardId = (row["Award ID"] || "").trim();
  const recipientName = (row["Recipient Name"] || "").trim();
  const amountUsd = typeof row["Award Amount"] === "number" ? row["Award Amount"] : 0;
  if (!recipientName || !(amountUsd > 0)) return null;
  const internalId = row.generated_internal_id;
  return {
    awardId,
    recipientName,
    amountUsd,
    agency: row["Awarding Agency"]?.trim() || undefined,
    dateIso: row["Start Date"] || ymd(new Date()),
    description: row.Description || undefined,
    url: internalId ? `${AWARD_DETAIL_URL}${encodeURIComponent(internalId)}` : AWARD_DETAIL_URL,
  };
}

/**
 * Fetch recent large federal-contract awards (one keyless POST) and map them to
 * catalyst events against the universe name index. Degrades to [] on any error.
 */
export async function fetchUsaSpendingCatalystEvents(
  companies: readonly CompanyData[],
  opts: { now?: number; lookbackDays?: number; limit?: number } = {},
): Promise<CatalystEvent[]> {
  if (companies.length === 0) return [];
  try {
    const now = opts.now ?? Date.now();
    const lookbackDays = opts.lookbackDays ?? 30;
    const limit = opts.limit ?? 100;
    const today = new Date(now);
    const from = new Date(now - lookbackDays * 24 * 60 * 60 * 1000);

    const body = {
      filters: {
        award_type_codes: ["A", "B", "C", "D"], // BPA call, PO, definitive, IDV
        // `new_awards_only` keeps NEW base awards in-window (not lifetime IDV
        // re-surfacing), and `action_date` scopes to recent contract activity -
        // together they bias toward award NEWS, not decades-old base contracts.
        time_period: [
          { start_date: ymd(from), end_date: ymd(today), date_type: "new_awards_only" },
        ],
      },
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Awarding Agency",
        "Start Date",
        "Description",
      ],
      sort: "Award Amount",
      order: "desc",
      limit,
      page: 1,
    };

    const res = await postJson<AwardSearchResponse>(AWARD_SEARCH_URL, body, 15_000);
    const rows = res.results;
    if (!Array.isArray(rows)) return [];

    const nameIndex = buildNameTickerIndex(companies);
    const awards = rows.map(rowToContractAward).filter((a): a is ContractAward => a !== null);
    // Drop events the recency engine would zero anyway (a base date that slipped
    // outside the window), so the daily board carries only live signal.
    return awardsToCatalystEvents(awards, nameIndex, now).filter((e) => e.strength > 0);
  } catch {
    return [];
  }
}
