import type { CatalystType, CompanyData } from "@/types";
import { clamp } from "@/lib/math";
import { httpText } from "@/data/http";
import { type CatalystEvent, daysAwayFrom, eventStrength } from "./catalystEvent";

/**
 * Newsletter / public-feed catalyst ingestion - the "CEO watcher" pipeline,
 * built on CONFIRMED $0, keyless, no-auth public RSS feeds.
 *
 * RESEARCH GATE (why these feeds, 2026-06 - verified live)
 * --------------------------------------------------------
 * A prior attempt left this EMPTY (and routed extraction through a Gemini proxy
 * that didn't implement the task, so nothing ingested). The durable $0 path is
 * GlobeNewswire's public RSS feeds: they embed the issuer's exchange:ticker in
 * `<category>` tags (e.g. `Nasdaq:CHRS`, `NYSE:CLDI`), so we can resolve the
 * subject COMPANY *deterministically* - no LLM, no hallucinated tickers, works
 * headless in the daily Node scan with zero API spend.
 *
 * THE PARSE - fully deterministic, no model in the loop
 * -----------------------------------------------------
 *   1. Fetch + parse each feed (RSS `<item>` / Atom `<entry>`), capturing the
 *      `<category>` tags alongside title/description/date.
 *   2. Resolve US-listed tickers from the categories (and `(NASDAQ: X)` patterns
 *      in the headline) - US exchanges only; non-US listings (Paris:/Brussels:…)
 *      are ignored, and unknown symbols are dropped by the universe anchor below.
 *   3. Classify the catalyst TYPE + signed STRENGTH from transparent keyword
 *      rules over the real headline (FDA approval, M&A, contract win, earnings
 *      beat/miss, partnership, offering/dilution, …). An item that matches no
 *      rule scores 0 and is dropped - conservative by design.
 *
 * SAFETY RAILS
 * ------------
 *   • Tickers are VALIDATED against the universe in hand - an event for a symbol
 *     we don't rank is dropped (no off-universe symbol reaches the score).
 *   • Materiality floor: only items at/above `MIN_STRENGTH` survive.
 *   • This classifies REAL press releases by published rules - it never fabricates
 *     a number or a source; the summary is the real headline, the link the real URL.
 *   • Pure parse/extract/classify helpers are unit-tested; the network wrapper is
 *     not (same convention as the other catalyst sources).
 */

/**
 * Confirmed-free, no-auth public RSS feeds (GlobeNewswire) ingested by default.
 * All verified live 2026-06 and carry `<category>` exchange:ticker tags. Add or
 * override via `VITE_NEWSLETTER_FEEDS` (comma-separated). Broad public-company PR
 * plus biotech / pharma / clinical, which is where the small/mid-cap catalysts
 * (FDA, partnerships, contract wins, going-profitable beats) actually surface.
 */
export const DEFAULT_NEWSLETTER_FEEDS: readonly string[] = [
  "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies",
  "https://www.globenewswire.com/RssFeed/industry/4573-Biotechnology/feedTitle/GlobeNewswire%20-%20Biotechnology",
  "https://www.globenewswire.com/RssFeed/industry/4577-Pharmaceuticals/feedTitle/GlobeNewswire%20-%20Pharmaceuticals",
  "https://www.globenewswire.com/RssFeed/subjectcode/90-Clinical%20Study/feedTitle/GlobeNewswire%20-%20Clinical%20Study",
  // High-catalyst topical streams (verified live 2026-06-24, 20 items each, all
  // carrying exchange:ticker tags): CONTRACT wins, M&A, and Technology - exactly the
  // "catalyzed" plays (a contract award / acquisition / tech catalyst before the move).
  "https://www.globenewswire.com/RssFeed/subjectcode/13-Contracts/feedTitle/GlobeNewswire%20-%20Contracts",
  "https://www.globenewswire.com/RssFeed/subjectcode/29-Mergers%20And%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20And%20Acquisitions",
  "https://www.globenewswire.com/RssFeed/industry/9576-Technology/feedTitle/GlobeNewswire%20-%20Technology",
];

/** Catalyst strength a parsed item must clear to fold into scoring (noise floor). */
const MIN_STRENGTH = 0.4;

const VALID_TYPES: ReadonlySet<string> = new Set<CatalystType>([
  "Earnings",
  "Product",
  "M&A",
  "Regulatory",
  "Political",
  "Macro",
  "Technical",
  "Insider",
  "Partnership",
  "Clinical",
  "Institutional",
]);

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  /** ISO publish date, or "" when the feed omitted/garbled it. */
  dateIso: string;
  /** Raw `<category>` values (GlobeNewswire embeds `Nasdaq:TICKER` here). */
  categories: string[];
}

const TAG = (name: string) =>
  new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");

/** Strip CDATA wrappers and decode the handful of XML entities feeds emit. */
function cleanText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(pubDate: string): string {
  if (!pubDate) return "";
  const t = new Date(pubDate).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

/**
 * Extract feed items from raw RSS/Atom XML with a runtime-agnostic regex parse
 * (no DOMParser - works in the Node scan AND the browser). Handles `<item>`
 * (RSS) and `<entry>` (Atom), and captures `<category>` tags. Pure.
 */
export function parseFeedItems(xml: string): FeedItem[] {
  if (!xml) return [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const block of blocks) {
    const title = cleanText(block.match(TAG("title"))?.[1] ?? "");
    // RSS uses <link>text</link>; Atom uses <link href="…"/>.
    const linkText = block.match(TAG("link"))?.[1]?.trim();
    const linkHref = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
    const link = (linkText || linkHref || "").trim();
    const description = cleanText(
      block.match(TAG("description"))?.[1] ??
        block.match(TAG("summary"))?.[1] ??
        block.match(TAG("content"))?.[1] ??
        "",
    );
    const pub =
      block.match(TAG("pubDate"))?.[1] ??
      block.match(TAG("updated"))?.[1] ??
      block.match(TAG("published"))?.[1] ??
      "";
    const categories = [...block.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)]
      .map((m) => cleanText(m[1] ?? ""))
      .filter(Boolean);
    if (!title && !description) continue;
    out.push({ title, link, description, dateIso: toIso(pub.trim()), categories });
  }
  return out;
}

// --------------------------------------------------------------------------
// Deterministic ticker resolution (US exchanges only)
// --------------------------------------------------------------------------

/**
 * Match `EXCHANGE:TICKER` for US venues only. Catches both the GlobeNewswire
 * category form (`Nasdaq:CHRS`, `Other OTC:SGMO`) and the in-headline form
 * (`(NASDAQ: CHRS)`). Non-US venues (Paris:, Brussels:, Copenhagen:, …) are
 * intentionally NOT in the alternation, so foreign listings are skipped; a US
 * dual-listing of the same name (e.g. `Nasdaq:ARGX`) is still captured.
 */
const US_TICKER_RE =
  /\b(?:nasdaq|nyse(?:\s+american)?|nyse\s+arca|amex|cboe|bats|bzx|otcqx|otcqb|other\s+otc|otc\s+markets)\s*:\s*([A-Z][A-Z.\-]{0,6})\b/gi;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,6}$/;

/** Resolve the unique US-listed tickers an item refers to (categories + headline). Pure. */
export function tickersFromItem(item: FeedItem): string[] {
  const haystack = [...item.categories, item.title, item.description].join(" \n ");
  const found = new Set<string>();
  for (const m of haystack.matchAll(US_TICKER_RE)) {
    const t = m[1]?.trim().toUpperCase();
    if (t && TICKER_RE.test(t)) found.add(t);
  }
  return [...found];
}

// --------------------------------------------------------------------------
// Deterministic catalyst classification (transparent keyword rules)
// --------------------------------------------------------------------------

interface ClassRule {
  re: RegExp;
  type: CatalystType;
  /** Signed magnitude in -1..1 (negative = bearish). */
  mag: number;
}

/**
 * Ordered rules - first match wins, so the strongest/most-specific (and the
 * BEARISH ones, which must beat their bullish keyword cousins like "trial") come
 * first. An item that matches nothing scores 0 → dropped by the floor.
 */
const CLASS_RULES: ClassRule[] = [
  // ── Bearish (checked first so "trial fails" doesn't read as a positive "trial") ──
  {
    re: /\b(fail(?:s|ed)?|did not meet|miss(?:es|ed)? (?:its )?primary|complete response letter|\bcrl\b|not approv|reject(?:ed|s)? by|clinical hold|discontinu\w+ (?:the )?(?:trial|study|program)|halt\w*)\b/,
    type: "Clinical",
    mag: -0.72,
  },
  {
    re: /\b(going concern|bankrupt\w*|chapter 11|delist\w*|nasdaq (?:deficiency|notice)|default(?:s|ed)? on|covenant breach)\b/,
    type: "Regulatory",
    mag: -0.78,
  },
  {
    re: /\b(cut(?:s|ting)? (?:its )?guidance|lower(?:s|ed)? (?:its )?(?:guidance|outlook|forecast)|profit warning|warns? (?:on|of)|miss(?:es|ed)? (?:on )?(?:revenue|earnings|estimates))\b/,
    type: "Earnings",
    mag: -0.62,
  },
  {
    re: /\b(public offering|registered direct offering|underwritten offering|private placement|at-the-market|secondary offering|shelf (?:registration|offering)|pric(?:es|ed|ing) (?:a |an )?\$?[\d.,]*\s*(?:million|billion)?\s*offering)\b/,
    type: "Technical",
    mag: -0.5,
  },
  // ── Bullish ──
  {
    re: /\b(fda approv\w*|approved by the fda|received (?:fda )?approval|marketing authoriz\w*|ce mark|510\(k\) clearance|grants? approval|biologics license|bla approval|nda approval)\b/,
    type: "Clinical",
    mag: 0.82,
  },
  {
    re: /\b(positive (?:topline|top-line|phase|interim|pivotal)|met (?:its )?primary endpoint|topline (?:results|data)|breakthrough therapy|fast track designation|orphan drug designation|pdufa)\b/,
    type: "Clinical",
    mag: 0.7,
  },
  {
    re: /\b(to (?:acquire|be acquired)|acquisition of|to merge with|merger agreement|definitive (?:merger )?agreement to acquire|agrees? to acquire|buyout|takeover|tender offer)\b/,
    type: "M&A",
    mag: 0.8,
  },
  {
    re: /\b((?:awarded|wins?|win|receives?|secures?|granted|selected (?:by|for)).{0,40}?(?:contract|order|award|task order|purchase order)|contract (?:award|valued|worth)|(?:defense|government|federal) contract)\b/,
    type: "Partnership",
    mag: 0.64,
  },
  {
    re: /\b(raise(?:s|d)? (?:its )?(?:guidance|outlook|forecast)|record (?:revenue|quarter|quarterly|sales|bookings)|beat(?:s)? (?:on )?(?:revenue|earnings|estimates|expectations)|tops? (?:estimates|expectations|consensus))\b/,
    type: "Earnings",
    mag: 0.68,
  },
  {
    re: /\b(partnership|collaborat\w+|strategic alliance|joint venture|teams? up with|enter(?:s|ed)? (?:into )?(?:an? )?(?:agreement|deal) with|licens\w+ (?:agreement|deal)|distribution agreement|supply agreement)\b/,
    type: "Partnership",
    mag: 0.55,
  },
  {
    re: /\b(\b13d\b|\b13g\b|activist|takes? (?:a )?stake|acquires? (?:a )?stake|strategic investment|invests? \$|equity investment in)\b/,
    type: "Institutional",
    mag: 0.55,
  },
  {
    re: /\b(report(?:s|ed)? (?:first|second|third|fourth|q[1-4]|quarterly|fiscal).{0,30}?results|quarterly results|earnings (?:results|release)|reports? financial results)\b/,
    type: "Earnings",
    mag: 0.48,
  },
  {
    re: /\b(launch\w*|unveil\w+|introduc\w+|debut\w*|now available|general availability|roll(?:s|ed)? out)\b/,
    type: "Product",
    mag: 0.5,
  },
  {
    re: /\b(patent (?:granted|issued|allowance)|granted (?:a |its )?patent|receives? (?:a )?patent|notice of allowance)\b/,
    type: "Regulatory",
    mag: 0.48,
  },
];

/** Classify one headline into a catalyst type + signed magnitude, or null. Pure. */
export function classifyCatalyst(text: string): { type: CatalystType; mag: number } | null {
  const t = text.toLowerCase();
  for (const rule of CLASS_RULES) {
    if (rule.re.test(t)) return { type: rule.type, mag: rule.mag };
  }
  return null;
}

/** A raw structured event (untrusted - validated below by {@link validateParsedEvents}). */
export interface RawParsedEvent {
  ticker?: unknown;
  catalystType?: unknown;
  date?: unknown;
  summary?: unknown;
  sourceUrl?: unknown;
  strength?: unknown;
}

/**
 * Deterministically derive raw catalyst events from parsed feed items: resolve
 * the US ticker(s), classify the headline, and emit one event per (item, ticker)
 * that clears classification. Pure. The strengths/types are still funneled
 * through {@link validateParsedEvents} (universe anchor + floor + eventStrength).
 */
export function deriveEventsFromItems(
  items: readonly FeedItem[],
  now: number = Date.now(),
): RawParsedEvent[] {
  const out: RawParsedEvent[] = [];
  const nowIso = new Date(now).toISOString();
  for (const item of items) {
    const tickers = tickersFromItem(item);
    if (tickers.length === 0) continue;
    const headline = `${item.title}. ${item.description}`;
    const cls = classifyCatalyst(headline);
    if (!cls) continue;
    for (const ticker of tickers) {
      out.push({
        ticker,
        catalystType: cls.type,
        date: item.dateIso || nowIso,
        summary: item.title || `${cls.type} catalyst`,
        sourceUrl: item.link,
        strength: cls.mag,
      });
    }
  }
  return out;
}

/**
 * Validate + map derived events into `CatalystEvent`s, ANCHORED to the universe:
 * unknown tickers, unknown types, and sub-floor strengths are dropped. The
 * `validTickers` set comes from the universe in hand, so no off-universe symbol
 * survives. `negative` is inferred from a negative strength. Pure.
 */
export function validateParsedEvents(
  raw: readonly RawParsedEvent[],
  validTickers: ReadonlySet<string>,
  now: number = Date.now(),
  fallbackUrl = "",
): CatalystEvent[] {
  const out: CatalystEvent[] = [];
  for (const r of raw) {
    const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
    if (!ticker || !TICKER_RE.test(ticker) || !validTickers.has(ticker)) continue;

    const type = typeof r.catalystType === "string" ? r.catalystType.trim() : "";
    if (!VALID_TYPES.has(type)) continue;

    const dateIso = typeof r.date === "string" && r.date.trim() ? r.date.trim() : "";
    const t = new Date(dateIso).getTime();
    if (!Number.isFinite(t)) continue;

    const rawStrength = typeof r.strength === "number" ? r.strength : 0;
    const negative = rawStrength < 0;
    const magnitude = clamp(Math.abs(rawStrength), 0, 1);
    if (magnitude < MIN_STRENGTH) continue;

    const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : `${type} catalyst`;
    const sourceUrl = typeof r.sourceUrl === "string" && r.sourceUrl.trim() ? r.sourceUrl.trim() : fallbackUrl;
    const daysAway = daysAwayFrom(dateIso, now);

    out.push({
      ticker,
      catalystType: type as CatalystType,
      date: dateIso,
      summary,
      sourceUrl,
      magnitude,
      strength: eventStrength(magnitude, daysAway, negative),
      negative,
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// Live fetch (I/O) - RSS fetch + deterministic extract, degrades to [].
// --------------------------------------------------------------------------

/** Read the comma-separated `VITE_NEWSLETTER_FEEDS` env, else the default list. */
export function configuredNewsletterFeeds(): string[] {
  const env = (import.meta.env as Record<string, string | undefined>)?.VITE_NEWSLETTER_FEEDS;
  const fromEnv = (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_NEWSLETTER_FEEDS];
}

/**
 * Fetch + parse the configured newsletter/RSS feeds, deterministically extract
 * catalyst events, and validate them against the universe. Returns [] when no
 * feeds are configured or everything fails. No API key, no LLM - works headless
 * in the daily Node scan. The `validTickers` anchor guarantees no off-universe
 * symbol reaches scoring.
 */
export async function fetchNewsletterCatalystEvents(
  companies: readonly CompanyData[],
  opts: { now?: number; feeds?: readonly string[] } = {},
): Promise<CatalystEvent[]> {
  if (companies.length === 0) return [];
  const feeds = opts.feeds ?? configuredNewsletterFeeds();
  if (feeds.length === 0) return [];
  try {
    const now = opts.now ?? Date.now();
    const validTickers = new Set(companies.map((c) => c.ticker.trim().toUpperCase()));

    const itemsPerFeed = await Promise.all(
      feeds.map(async (feed) => {
        try {
          const xml = await httpText(feed, { timeoutMs: 12_000 });
          return parseFeedItems(xml).slice(0, 40); // bound the per-feed batch
        } catch {
          return [] as FeedItem[];
        }
      }),
    );
    const items = itemsPerFeed.flat();
    if (items.length === 0) return [];

    const raw = deriveEventsFromItems(items, now);
    return validateParsedEvents(raw, validTickers, now);
  } catch {
    return [];
  }
}
