import type {
  CatalystType,
  ExecutiveSignalKind,
  ExecutiveSignalSummary,
} from "@/types";
import type { TerminalEvent, TerminalSeverity } from "@/types/terminal";
import { clamp } from "@/lib/math";
import {
  type CatalystEvent,
  daysAwayFrom,
  eventStrength,
} from "@/data/catalysts/catalystEvent";
import { httpJson } from "@/data/http";
import type { ExecutiveItem } from "./executiveTrades";
import { isFavorable, isAdverse } from "./executiveTrades";

/**
 * DISCOVERED catalysts - the live, self-updating output of the autonomous
 * catalyst-discovery engine (research-agent `catalyst_scan` edge task, run
 * server-side on the daily schedule and cached in `discovered_catalysts`).
 *
 * WHY THIS EXISTS (the owner's mandate): the app must DISCOVER the whole class of
 * market-moving catalysts itself - political callouts/trades (President / Fed /
 * Cabinet / Congress naming, praising, criticizing, buying, or selling a stock),
 * notable CEO/insider open-market buys, and major corporate catalysts (M&A /
 * FDA / guidance / contracts) - so nothing important is missed and no example
 * ever has to be hand-coded in `executiveTrades.ts` again. That static file is
 * now the FALLBACK SEED; THIS source is the live primary.
 *
 * EVERY discovered item carries a REAL ticker + a REAL retrieved source URL (the
 * edge function drops anything unsourced) - the #1 product rule (never fabricate)
 * holds end to end. Direction is preserved from the scan (a tariff threat is
 * bearish, a disclosed buy is bullish).
 *
 * It maps each discovered catalyst into the SAME shapes `executiveTrades.ts`
 * emits, so discovered items flow through every existing surface UNCHANGED:
 *   - POLITICAL items → {@link ExecutiveItem} (favorable/adverse callout, buy/sell)
 *     → the executive-signal projections (badge + scoring tilt + Terminal wire).
 *   - ALL items (incl. insider buys / M&A / FDA / guidance / contracts) →
 *     {@link CatalystEvent} for the scoring catalyst fold, and
 *     {@link TerminalEvent} for the Terminal Catalyst wire.
 *
 * Reads from the public `discovered_catalysts` Supabase cache (anon read; the
 * scheduled scan is the only writer). Degrades to [] / null on any error so the
 * static seed always remains as a floor.
 */

/** One discovered catalyst, the strict shape the edge `catalyst_scan` emits. */
export interface DiscoveredCatalyst {
  ticker: string;
  company: string;
  headline: string;
  /** Who acted - "President Trump", "CEO Jane Doe", "Pfizer", or "". */
  actor: string;
  /** Role bucket - "President" | "Fed" | "Congress" | "CEO" | "Company" | … */
  role: string;
  direction: "bullish" | "bearish";
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** 0..100 importance the scan assigned. */
  importance: number;
  /** Catalyst class - political | insider_buy | ma | fda | guidance | contract | other. */
  kind: string;
  /** Real retrieved source URL (validated server-side). */
  url: string;
}

export interface DiscoveredScan {
  catalysts: DiscoveredCatalyst[];
  generatedAt: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** True when the Supabase env needed to read the discovered-catalysts cache is set. */
export function isDiscoveredCatalystsConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

interface CacheRow {
  market_day?: string;
  catalysts?: unknown;
  generated_at?: string;
}

/** Coerce one raw cache item into a DiscoveredCatalyst, or null if unusable. */
function coerce(raw: unknown): DiscoveredCatalyst | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
  const url = typeof r.url === "string" ? r.url.trim() : "";
  const headline = typeof r.headline === "string" ? r.headline.trim() : "";
  // The no-fabrication contract: a real ticker AND a real source URL, else drop.
  if (!ticker || !/^https?:\/\//i.test(url) || !headline) return null;
  const direction = r.direction === "bearish" ? "bearish" : "bullish";
  const importance = clamp(Number(r.importance) || 50, 0, 100);
  const date =
    typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
      ? r.date
      : new Date().toISOString().slice(0, 10);
  return {
    ticker,
    company: typeof r.company === "string" && r.company.trim() ? r.company.trim() : ticker,
    headline,
    actor: typeof r.actor === "string" ? r.actor.trim() : "",
    role: typeof r.role === "string" ? r.role.trim() : "",
    direction,
    date,
    importance,
    kind: typeof r.kind === "string" ? r.kind : "other",
    url,
  };
}

/**
 * Fetch the most-recent discovered-catalysts scan from the Supabase cache.
 * Returns null on any network/parse error or when unconfigured, so callers fall
 * back to the static executiveTrades seed. Reads the latest row by generated_at.
 */
export async function fetchDiscoveredCatalysts(): Promise<DiscoveredScan | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const url =
    `${SUPABASE_URL}/rest/v1/discovered_catalysts` +
    `?select=market_day,catalysts,generated_at&order=generated_at.desc&limit=1`;
  try {
    const rows = await httpJson<CacheRow[]>(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || !Array.isArray(row.catalysts)) return null;
    const catalysts = row.catalysts
      .map(coerce)
      .filter((c): c is DiscoveredCatalyst => c !== null);
    return {
      catalysts,
      generatedAt: typeof row.generated_at === "string" ? row.generated_at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Projections - map discovered catalysts into the EXISTING shapes so they flow
// through every surface (scoring, Terminal, badge) unchanged.
// --------------------------------------------------------------------------

/** True when a discovered catalyst is POLITICAL (President / Fed / Cabinet /
 *  Congress). These become ExecutiveItems; the rest become plain CatalystEvents. */
export function isPoliticalDiscovered(c: DiscoveredCatalyst): boolean {
  return c.kind === "political";
}

/** Map a discovered POLITICAL item's direction → the ExecutiveSignalKind. A buy/
 *  sell is detected from the headline; otherwise it's a favorable/adverse callout. */
function executiveKindFor(c: DiscoveredCatalyst): ExecutiveSignalKind {
  const text = `${c.headline} ${c.actor}`.toLowerCase();
  // Stems (no trailing \b) so "buying"/"selling"/"purchased"/"disclosed" all match.
  const isTrade = /\b(bought|buy|purchas|sold|sell|sale|disclos|trade|transaction|ptr|form 278|oge)/.test(text);
  if (isTrade) {
    return c.direction === "bearish" ? "sell" : "buy";
  }
  return c.direction === "bearish" ? "adverse_callout" : "favorable_callout";
}

/** importance 0..100 → magnitude 0..1 for the executive/catalyst projections. */
function magFor(c: DiscoveredCatalyst): number {
  return clamp(c.importance / 100, 0, 1);
}

/**
 * Project the discovered POLITICAL catalysts into {@link ExecutiveItem}s - the
 * exact shape `executiveTrades.ts` uses, so they merge with the static seed and
 * flow through `executiveSignalSummaries` / `executiveCatalystEvents` /
 * `executiveTradeTerminalEvents` unchanged.
 */
export function discoveredExecutiveItems(scan: DiscoveredScan | null): ExecutiveItem[] {
  if (!scan) return [];
  const out: ExecutiveItem[] = [];
  for (const c of scan.catalysts) {
    if (!isPoliticalDiscovered(c)) continue;
    const kind = executiveKindFor(c);
    out.push({
      ticker: c.ticker,
      companyName: c.company,
      kind,
      actor: c.actor || "Political actor",
      date: c.date,
      summary: c.headline,
      magnitude: magFor(c),
      sourceUrl: c.url,
      sourceLabel: c.role ? `${c.role} (discovered)` : "Discovered political catalyst",
    });
  }
  return out;
}

/** Map a NON-political discovered kind → the engine's CatalystType. */
function catalystTypeFor(c: DiscoveredCatalyst): CatalystType {
  switch (c.kind) {
    case "insider_buy":
      return "Insider";
    case "ma":
      return "M&A";
    case "fda":
      return "Regulatory";
    case "guidance":
      return "Earnings";
    case "contract":
      return "Partnership";
    case "political":
      return "Political";
    default:
      return "Macro";
  }
}

/** Hard, unambiguous catalyst types - a real corporate/market event, not a PR
 *  callout or donation-style announcement. These are trusted at any magnitude.
 *  ("Contract" discoveries map onto CatalystType "Partnership" via
 *  `catalystTypeFor`, so "Partnership" covers that case here.) */
const HARD_CATALYST_TYPES: ReadonlySet<CatalystType> = new Set([
  "M&A",
  "Earnings",
  "Regulatory",
  "Clinical",
  "Partnership",
]);

/** Minimum magnitude a SOFT (non-hard-typed) discovered item must clear to
 *  count as a scoring catalyst. Below this, an item without a hard type is
 *  presumed PR / political-donation / soft-news noise (e.g. a "$250M Trump
 *  Accounts" philanthropy press item) rather than a market-moving event. */
const MIN_SOFT_CATALYST_MAGNITUDE = 0.5;

/**
 * Materiality gate for the SCORING projection only (not the executive-signal
 * or terminal-wire projections, which still show every discovered item to the
 * user for awareness). A discovered item counts as a real catalyst input when
 * it EITHER maps to a hard, unambiguous type (M&A / Earnings / Regulatory /
 * Clinical / Partnership - i.e. a genuine structured corporate event) OR clears
 * a materiality magnitude floor. This keeps low-substance political/PR/donation
 * announcements that merely carry a $ figure (political "kind", or an
 * unclassified "other"/Macro item) from masquerading as a real catalyst just
 * because they mention a large number.
 */
function isMaterialDiscoveredCatalyst(c: DiscoveredCatalyst, catalystType: CatalystType): boolean {
  if (HARD_CATALYST_TYPES.has(catalystType)) return true;
  return magFor(c) >= MIN_SOFT_CATALYST_MAGNITUDE;
}

/**
 * Project discovered catalysts into scoring {@link CatalystEvent}s (type per
 * kind; `negative` set for bearish so the engine reads the sign). Political
 * items are ALSO carried as ExecutiveItems (above) for the direction-aware
 * tilt; here they additionally fold into `CompanyData.catalyst` like every
 * other event - but ONLY when they clear the materiality gate (see
 * `isMaterialDiscoveredCatalyst`), so a PR/donation-style political callout
 * with no hard classification doesn't inflate the catalyst score just because
 * it cites a dollar figure. Pure - the clock is injected so the daily cache
 * stays deterministic.
 */
export function discoveredCatalystEvents(
  scan: DiscoveredScan | null,
  now: number = Date.now(),
): CatalystEvent[] {
  if (!scan) return [];
  const out: CatalystEvent[] = [];
  for (const c of scan.catalysts) {
    const catalystType = catalystTypeFor(c);
    if (!isMaterialDiscoveredCatalyst(c, catalystType)) continue;
    const negative = c.direction === "bearish";
    const daysAway = daysAwayFrom(c.date, now);
    const mag = magFor(c);
    out.push({
      ticker: c.ticker,
      catalystType,
      date: c.date,
      summary: c.headline,
      sourceUrl: c.url,
      magnitude: mag,
      strength: eventStrength(mag, daysAway, negative),
      negative,
    } satisfies CatalystEvent);
  }
  return out;
}

// --------------------------------------------------------------------------
// Terminal wire projection.
// --------------------------------------------------------------------------

function severityFor(c: DiscoveredCatalyst): TerminalSeverity {
  if (c.importance >= 70) return "high";
  if (c.importance >= 45) return "elevated";
  return "watch";
}

function terminalKindFor(c: DiscoveredCatalyst): TerminalEvent["kind"] {
  switch (c.kind) {
    case "political":
      return "politician_trade";
    case "insider_buy":
      return "insider_buy";
    case "contract":
      return "gov_contract";
    // M&A / FDA / guidance / other → the generic catalyst-news lane.
    default:
      return "catalyst_news";
  }
}

/**
 * Project the discovered catalysts as Terminal wire events. Direction-aware
 * (bearish → sell tone). Reuses the existing TerminalEvent kinds so the wire's
 * relevance ranking (president/major/political boosts) and card styling apply
 * unchanged. Pure.
 */
export function discoveredTerminalEvents(scan: DiscoveredScan | null): TerminalEvent[] {
  if (!scan) return [];
  return scan.catalysts.map((c) => {
    const iso = new Date(`${c.date}T00:00:00Z`).toISOString();
    const bullish = c.direction === "bullish";
    const kind = terminalKindFor(c);
    return {
      id: `disc-${c.ticker}-${c.kind}-${c.date}-${c.url.slice(-12)}`,
      kind,
      severity: severityFor(c),
      ticker: c.ticker,
      companyName: c.company,
      headline: c.headline,
      summary: c.actor ? `${c.actor}${c.role ? ` (${c.role})` : ""}` : undefined,
      actor: c.actor ? { name: c.actor, role: c.role || undefined } : undefined,
      trade:
        kind === "politician_trade" || kind === "insider_buy"
          ? { direction: bullish ? "buy" : "sell" }
          : undefined,
      occurredAt: iso,
      surfacedAt: iso,
      source: { name: c.role ? `${c.role} · discovered` : "Discovered catalyst", url: c.url },
      reason: bullish
        ? "Discovered bullish catalyst (auto-surfaced by the catalyst-discovery engine)."
        : "Discovered bearish catalyst (auto-surfaced by the catalyst-discovery engine).",
    } satisfies TerminalEvent;
  });
}
