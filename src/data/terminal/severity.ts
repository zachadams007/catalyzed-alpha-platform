import type { TerminalSeverity } from "@/types/terminal";

/**
 * Transparent severity heuristics for the Terminal feed.
 *
 * No black box: every severity comes with a short human reason so the UI can
 * explain *why* an item is flagged. These are intentionally simple keyword /
 * threshold rules - when the AI research lane or a paid sentiment source is
 * wired, it can supersede these, but the rules stay documented in
 * docs/bloomberg-terminal.md and mirrored on the Algorithm page if surfaced.
 */

/** Market-moving language → "high". Endorsements & policy are first-class here. */
const HIGH_NEWS = [
  "halt",
  "halted",
  "fda approv",
  "fda clear",
  "acquir",
  "acquisition",
  "merger",
  "buyout",
  "takeover",
  "bankrupt",
  "chapter 11",
  "delist",
  "fraud",
  "sec charges",
  "investigation",
  "subpoena",
  "recall",
  "guidance cut",
  "slashes guidance",
  "endorse",
  "endorsement",
  "executive order",
  "tariff",
  "ban on",
  "short seller",
  "short-seller",
  "going private",
];

/** Notable, but a tier below an outright catalyst → "elevated". */
const ELEVATED_NEWS = [
  "earnings",
  "beats",
  "misses",
  "tops estimates",
  "upgrade",
  "downgrade",
  "initiates",
  "price target",
  "partnership",
  "contract",
  "awarded",
  "lawsuit",
  "guidance",
  "secondary offering",
  "stock split",
  "buyback",
  "dividend",
  "layoff",
  "ceo",
  "resign",
];

/** Political figures whose mention alone elevates a headline. */
const POLITICAL_FIGURES = [
  "trump",
  "biden",
  "harris",
  "powell",
  "yellen",
  "musk",
  "white house",
  "congress",
  "senate",
  "pelosi",
];

function matches(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n;
  return null;
}

export interface SeverityVerdict {
  severity: TerminalSeverity;
  reason: string;
}

/** Classify a news headline (+ optional summary) into a severity + reason. */
export function classifyNewsSeverity(headline: string, summary?: string): SeverityVerdict {
  const text = `${headline} ${summary ?? ""}`.toLowerCase();

  const political = matches(text, POLITICAL_FIGURES);
  const high = matches(text, HIGH_NEWS);
  if (high) {
    return {
      severity: "high",
      reason: political
        ? `Market-moving language ("${high}") + political figure (${political})`
        : `Market-moving language: "${high}"`,
    };
  }

  const elevated = matches(text, ELEVATED_NEWS);
  if (political) {
    return { severity: "elevated", reason: `Political figure mentioned: ${political}` };
  }
  if (elevated) {
    return { severity: "elevated", reason: `Notable catalyst language: "${elevated}"` };
  }
  return { severity: "watch", reason: "General coverage" };
}

/**
 * Classify an insider / politician trade by direction and notional size.
 */
export function classifyTradeSeverity(
  direction: "buy" | "sell",
  valueUsd: number | undefined,
): SeverityVerdict {
  const v = valueUsd ?? 0;
  if (direction === "buy") {
    if (v >= 1_000_000) return { severity: "high", reason: "Insider buy ≥ $1M" };
    if (v >= 250_000) return { severity: "elevated", reason: "Insider buy ≥ $250K" };
    return { severity: "watch", reason: "Open-market insider buy" };
  }
  // Sells: only large disposals are interesting; smaller ones are watch-only.
  if (v >= 5_000_000) return { severity: "elevated", reason: "Large insider sale ≥ $5M" };
  return { severity: "watch", reason: "Insider sale" };
}

/**
 * Human-readable labels for SEC 8-K item codes. Mirrors the map in the Python
 * deep-miner (`scripts/terminal_miner/edgar_8k_miner.py`) so the desktop cache
 * and the live client describe filings identically. Exported so the 8-K source
 * can render item descriptions in the card summary.
 */
export const ITEM_8K_LABELS: Record<string, string> = {
  "1.01": "Entry into Material Agreement",
  "1.02": "Termination of Material Agreement",
  "1.03": "Bankruptcy or Receivership",
  "2.01": "Acquisition or Disposition of Assets",
  "2.02": "Results of Operations / Financial Condition",
  "2.03": "Creation of Direct Financial Obligation",
  "2.04": "Triggering Events for Financial Obligations",
  "2.05": "Exit Activity Costs",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting",
  "3.02": "Unregistered Sale of Equity Securities",
  "3.03": "Modification of Security Holder Rights",
  "4.01": "Change in Certifying Accountant",
  "4.02": "Non-Reliance on Prior Financial Statements",
  "5.01": "Change in Control",
  "5.02": "Departure / Election of Directors or Officers",
  "5.03": "Amendment to Articles / Bylaws",
  "5.07": "Submission to Security Holder Vote",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

/** 8-K items that signal a genuine, market-moving corporate event. */
const HIGH_8K_ITEMS = new Set(["1.03", "2.01", "3.01", "4.02", "5.01"]);
/** 8-K items that are notable but a tier below an outright catalyst. */
const ELEVATED_8K_ITEMS = new Set(["1.01", "1.02", "2.02", "2.05", "2.06", "3.02", "5.02"]);

/**
 * Classify an 8-K filing by its item codes. A single filing can carry several
 * items (e.g. earnings "2.02" + exhibits "9.01"); we surface the most material
 * one. Routine items (Reg FD 7.01, exhibits 9.01) stay "watch".
 */
export function classify8kSeverity(items: string[]): SeverityVerdict {
  const high = items.find((i) => HIGH_8K_ITEMS.has(i));
  if (high) return { severity: "high", reason: `8-K: ${ITEM_8K_LABELS[high] ?? `Item ${high}`}` };
  const elevated = items.find((i) => ELEVATED_8K_ITEMS.has(i));
  if (elevated) {
    return { severity: "elevated", reason: `8-K: ${ITEM_8K_LABELS[elevated] ?? `Item ${elevated}`}` };
  }
  const first = items[0];
  return {
    severity: "watch",
    reason: first ? `8-K: ${ITEM_8K_LABELS[first] ?? `Item ${first}`}` : "8-K material-event filing",
  };
}

/**
 * Classify a congressional trade. Disclosures report an AMOUNT RANGE (e.g.
 * "$15,001 - $50,000"), never an exact figure, so we threshold on the upper
 * bound. Politician trades are inherently higher-interest than routine insider
 * activity, so the floor is "watch" but mid-size trades clear to "elevated" and
 * large ones to "high". Direction is noted in the reason (buys are the signal).
 */
export function classifyPoliticianSeverity(
  direction: "buy" | "sell",
  upperAmountUsd: number | undefined,
): SeverityVerdict {
  const v = upperAmountUsd ?? 0;
  const side = direction === "buy" ? "purchase" : "sale";
  if (v >= 250_000) return { severity: "high", reason: `Congressional ${side} up to ≥ $250K` };
  if (v >= 50_000) return { severity: "elevated", reason: `Congressional ${side} up to ≥ $50K` };
  return { severity: "watch", reason: `Congressional ${side}` };
}
