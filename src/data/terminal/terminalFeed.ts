import type {
  TerminalEvent,
  TerminalEventKind,
  TerminalFeedResult,
  TerminalSeverity,
  TerminalSourceStatus,
  TerminalTrade,
} from "@/types/terminal";
import { alpacaKeyId, alpacaSecret, fmpKey } from "@/data/http";
import { isMarketProxyConfigured } from "@/data/marketProxy";
import { fetchAlpacaWire } from "./alpacaWire";
import { fetchInsiderTrades } from "./insiderTrades";
import { fetchSecForm4Insider } from "./secForm4";
import { fetchPoliticianTradesAny } from "./politicianTrades";
import { fetchEdgar8K } from "./edgar8k";
import { fetchCacheFeed, isCacheFeedConfigured } from "./cacheFeed";
import { executiveTradeTerminalEvents } from "./executiveTrades";
import {
  discoveredTerminalEvents,
  fetchDiscoveredCatalysts,
  isDiscoveredCatalystsConfigured,
} from "./discoveredCatalysts";

/**
 * True when running inside the Tauri desktop shell.
 * Synchronous check (window.__TAURI__) so it can gate sourceRegistry() without
 * an async import. The async `isTauri()` from @tauri-apps/api/core is used
 * inside request paths (http.ts, fetch.ts); here we only need a boolean gate.
 */
function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * True where it's safe to call keyed vendor APIs directly with local keys:
 *   - the Tauri desktop build (keys live on-device, no CORS), and
 *   - the local dev server (`npm run dev` / import.meta.env.DEV) so the Terminal
 *     renders real data while iterating - the .env never ships.
 *
 * A *production* web/phone bundle (PROD && not Tauri) must NOT embed vendor keys,
 * so there the keyed sources are skipped and the feed comes from the edge cache.
 * The keyless SEC source always runs.
 */
function canUseLocalKeys(): boolean {
  return isDesktop() || Boolean(import.meta.env.DEV);
}

const SEVERITY_RANK: Record<TerminalSeverity, number> = { high: 3, elevated: 2, watch: 1 };

/**
 * De-flood cap: the most events any single actor (insider / politician) may
 * contribute to the wire. Someone liquidating a position files many Form 4s (or
 * one Form 4 with many sell transactions) under the same name - without a cap a
 * single account dumps over a whole tab and buries everyone else. Keeping each
 * actor's top few (highest-severity, then most recent - capPerActor runs AFTER
 * rank) preserves the "this person is active" signal while restoring variety.
 * News and 8-K events have no actor, so they are never capped.
 */
const MAX_EVENTS_PER_ACTOR = 3;

/**
 * Recency window for the wire, in days. The feed shows events surfaced within
 * this many days so day-old notable trades (e.g. someone who SOLD Nvidia
 * yesterday) still appear, while genuinely stale rows from a lagging cache drop
 * off. Filtered on `surfacedAt` (when it hit the wire / was disclosed), not
 * `occurredAt`, so a just-disclosed older trade still counts as fresh news.
 */
const FEED_WINDOW_DAYS = 7;

/**
 * Per-kind freshness overrides. News + 8-K move in real time, so the tight 7-day
 * default keeps the wire current. Three lanes need a WIDER window or their tab reads
 * empty even though the signal is real and recent:
 *  - CONGRESS: members have a legal 30–45 day PTR filing window and the keyless mirror
 *    surfaces disclosures in bursts - a 7-day window discarded ~97% (419→13), which is
 *    why the Congress tab was empty. 45 days.
 *  - INSIDER BUYS: a CEO/insider PURCHASE is the signal the owner cares about most, and it
 *    stays meaningful for weeks - a 7-day window starved the Insider-buys tab (it read
 *    as "no data"). 60 days so recent buys actually show.
 *  - INSIDER SELLS: 45 days (still relevant as a risk flag, but noisier than buys).
 * Any kind not listed here uses the caller's `maxAgeDays` default.
 */
const KIND_WINDOW_DAYS: Partial<Record<TerminalEventKind, number>> = {
  // 60d covers BOTH congressional PTR lag AND executive-branch OGE 278-T disclosures
  // (released ~quarterly, surfaced weeks after the trade).
  politician_trade: 60,
  insider_buy: 60,
  insider_sell: 45,
};

/**
 * True where the keyless SEC sources (8-K + Form 4) can actually be reached:
 *   - desktop / dev (direct or Vite `/__sec` proxy), or
 *   - any build with the hosted market proxy configured (it routes SEC for us).
 */
function secReachable(): boolean {
  return canUseLocalKeys() || isMarketProxyConfigured();
}

/**
 * Insider buys for the wire. Tries FMP first - one cheap call that works when the
 * key (local or proxy-injected) has insider access - then falls back to the
 * keyless SEC Form 4 source so the lane still shows real open-market purchases on
 * a free/keyless build. Each path already degrades to [] internally.
 */
async function fetchInsiderBuys(): Promise<TerminalEvent[]> {
  if (fmpKey()) {
    const fmp = await fetchInsiderTrades(1);
    if (fmp.length > 0) return fmp;
  }
  return fetchSecForm4Insider();
}

interface SourceDef {
  id: string;
  name: string;
  /** True when the keys/config this source needs are present. */
  configured: boolean;
  /** Human note when not configured (shown in the source strip). */
  unconfiguredNote?: string;
  run: () => Promise<TerminalEvent[]>;
}

/**
 * The registry of live Terminal sources. Each one fans out independently and
 * degrades to [] on failure so one dead source never blanks the feed.
 *
 * Desktop (Tauri) + local dev run the live sources directly:
 *   - SEC 8-K (EDGAR full-text search): keyless; direct in Tauri, via the
 *     `/__sec` dev proxy in the browser (EDGAR drops CORS when an Origin is set).
 *   - Alpaca catalyst wire + FMP insider/congress trades: keyed; the vendors
 *     serve permissive CORS and keys stay on-device / in the un-shipped .env.
 * Production web / phone: all of the above are skipped (no proxy, no embedded
 *   keys); the `cache` source hits the `terminal-feed` Supabase edge function,
 *   which the Python miner / desktop writer populate server-side.
 *
 * KNOWN LIMITATION (F-2, product decision - not yet built): unlike the daily
 *   universe scan, there is NO cloud scheduler (GitHub Action / pg_cron) that
 *   keeps `terminal_events` fresh. The cache is only refilled WHEN the owner's
 *   desktop miner runs; if his PC is off, web/phone Terminal can go stale or
 *   empty. Making it truly always-on would require running the miner
 *   server-side on a schedule (the same pattern as daily-universe.yml). Until
 *   that decision is made, treat web/phone Terminal freshness as best-effort.
 *
 * See docs/bloomberg-terminal.md for the full architecture.
 */
function sourceRegistry(): SourceDef[] {
  const alpacaReady = Boolean(alpacaKeyId() && alpacaSecret());
  const fmpReady = Boolean(fmpKey());
  const localKeys = canUseLocalKeys();

  const secOk = secReachable();
  // The Catalyst wire (Alpaca news) is reachable with a LOCAL key pair OR through
  // the hosted market proxy, which injects the Alpaca credentials server-side. The
  // old gate required a local key, so the keyless desktop/web build showed the chip
  // gray even though the proxy can serve it - fixed to match the SEC lanes.
  const alpacaOk = (localKeys && alpacaReady) || isMarketProxyConfigured();

  return [
    // --- SEC 8-K material events (keyless; direct in Tauri, dev proxy, or hosted proxy) ---
    {
      id: "edgar8k",
      name: "SEC 8-K wire",
      configured: secOk,
      unconfiguredNote: "Via edge cache",
      run: () => fetchEdgar8K(60),
    },
    // --- Keyed direct sources (desktop + local dev; vendors serve CORS) ---
    {
      id: "alpaca",
      name: "Catalyst wire",
      configured: alpacaOk,
      unconfiguredNote: localKeys ? "Set VITE_ALPACA_API_KEY or a market proxy" : "Via edge cache",
      run: () => fetchAlpacaWire(50),
    },
    {
      id: "insiders",
      name: "Insider buys",
      // Keyless via SEC Form 4 wherever SEC is reachable; FMP is a bonus fast path.
      configured: secOk,
      unconfiguredNote: "Via edge cache",
      run: () => fetchInsiderBuys(),
    },
    {
      id: "politicians",
      name: "Congress trades",
      // ALWAYS live: the keyless House Stock Watcher public mirror (the same source
      // the daily scan uses) needs no API key and works on every build, so the
      // Congress source is never dead/gray. When an FMP key IS present it also
      // pulls the Senate. See politicianTrades.ts `fetchPoliticianTradesAny`.
      configured: true,
      run: () => fetchPoliticianTradesAny(),
    },
    {
      id: "executive",
      name: "Executive branch",
      // REAL, sourced Presidential disclosures (OGE Form 278-T) + dated public
      // callouts - what the President BUYS and what he SAYS, direction-aware. A
      // curated in-repo seed (no key, no network), so it's live on every build.
      // See executiveTrades.ts. Degrades to [] if the projection ever throws.
      configured: true,
      run: async () => executiveTradeTerminalEvents(),
    },
    // --- DISCOVERED catalysts (the autonomous engine) - every build ----------
    // The live, self-updating primary: political callouts/trades + notable
    // insider buys + major M&A/FDA/guidance/contracts that the daily server-side
    // `catalyst_scan` discovered (cached in `discovered_catalysts`). Every item
    // is real-ticker + real-source. Read from the public Supabase cache (anon),
    // so it works on web AND desktop; degrades to [] when unconfigured/empty, so
    // the static executive seed remains the floor. This is what makes the app
    // stop MISSING events without anything being hand-coded.
    {
      id: "discovered",
      name: "Discovered catalysts",
      configured: isDiscoveredCatalystsConfigured(),
      unconfiguredNote: "Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY",
      run: async () => discoveredTerminalEvents(await fetchDiscoveredCatalysts()),
    },
    // --- Production web / phone source: Supabase edge-function cache ---
    // Active only on a production browser bundle (no local keys). On desktop and
    // in dev the live sources above run directly, so this is skipped to avoid a
    // redundant (and currently empty) round-trip.
    {
      id: "cache",
      name: "Terminal cache",
      configured: !localKeys && isCacheFeedConfigured(),
      unconfiguredNote: localKeys
        ? "Web build only"
        : "Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY",
      run: () => fetchCacheFeed(100),
    },
  ];
}

function dedupe(events: TerminalEvent[]): TerminalEvent[] {
  const seen = new Set<string>();
  const out: TerminalEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function rank(events: TerminalEvent[]): TerminalEvent[] {
  return events.sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return safeTime(b.surfacedAt) - safeTime(a.surfacedAt);
  });
}

/**
 * Normalized identity for an event's actor (insider / politician), or null when
 * the event has no person behind it (news, 8-K). Case/whitespace-insensitive so
 * "Noto Anthony" and "noto  anthony" collapse to one account.
 */
function actorKey(e: TerminalEvent): string | null {
  const name = e.actor?.name;
  if (typeof name !== "string") return null;
  const norm = name.trim().toLowerCase().replace(/\s+/g, " ");
  return norm.length > 0 ? norm : null;
}

/**
 * De-flood the wire: keep at most `maxPerActor` events from any single actor,
 * preserving input order (so when called on a ranked list each account keeps its
 * most material few). Actorless events (news, 8-K) pass through untouched. Pure -
 * returns a new array and never mutates the input.
 */
export function capPerActor(
  events: ReadonlyArray<TerminalEvent>,
  maxPerActor: number = MAX_EVENTS_PER_ACTOR,
): TerminalEvent[] {
  const cap = Number.isFinite(maxPerActor) && maxPerActor > 0 ? Math.floor(maxPerActor) : 1;
  const perActor = new Map<string, number>();
  const out: TerminalEvent[] = [];
  for (const e of events) {
    const key = actorKey(e);
    if (key === null) {
      out.push(e); // no person behind it - never a flood vector
      continue;
    }
    const seen = perActor.get(key) ?? 0;
    if (seen >= cap) continue; // this account already filled its slots
    perActor.set(key, seen + 1);
    out.push(e);
  }
  return out;
}

/**
 * Keep only events that surfaced within the last `maxAgeDays` (by `surfacedAt`),
 * so day-old notable trades still show while stale cache rows drop off. Future /
 * now timestamps always pass (clock skew shouldn't hide a brand-new item). Pure
 * and deterministic given `now`, so it's unit-testable without faking the clock.
 *
 * The window is per-kind: `maxAgeDays` is the default for fast-moving lanes, but a
 * kind in {@link KIND_WINDOW_DAYS} (currently Congress) uses its own wider window
 * so a lane with a long legal disclosure lag isn't windowed down to nothing. An
 * override only ever WIDENS relative to a kind's real cadence - the caller's
 * default still bounds every lane that isn't explicitly listed.
 */
export function withinWindow(
  events: ReadonlyArray<TerminalEvent>,
  maxAgeDays: number = FEED_WINDOW_DAYS,
  now: number = Date.now(),
): TerminalEvent[] {
  const fallback = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : FEED_WINDOW_DAYS;
  const floorFor = (kind: TerminalEventKind): number => {
    const span = KIND_WINDOW_DAYS[kind] ?? fallback;
    return now - span * 24 * 60 * 60 * 1000;
  };
  return events.filter((e) => safeTime(e.surfacedAt) >= floorFor(e.kind));
}

const VALID_KINDS = new Set<TerminalEventKind>([
  "catalyst_news",
  "insider_buy",
  "insider_sell",
  "filing_8k",
  "politician_trade",
  "gov_contract",
]);
const VALID_SEVERITIES = new Set<TerminalSeverity>(["high", "elevated", "watch"]);

function safeTime(iso: unknown): number {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function safeIso(iso: unknown): string {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function finiteOrUndefined(n: unknown): number | undefined {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

/** Keep only the numeric trade fields the card reads, coerced to finite numbers. */
function sanitizeTrade(trade: TerminalEvent["trade"]): TerminalTrade | undefined {
  if (!trade || typeof trade !== "object") return undefined;
  const direction = trade.direction === "buy" || trade.direction === "sell" ? trade.direction : "buy";
  return {
    direction,
    valueUsd: finiteOrUndefined(trade.valueUsd),
    shares: finiteOrUndefined(trade.shares),
    pricePerShare: finiteOrUndefined(trade.pricePerShare),
    code: typeof trade.code === "string" ? trade.code : undefined,
  };
}

/**
 * Repair or drop one event so the render can never null-deref on it.
 *
 * The live desktop sources build well-formed events, but the production web
 * `cache` source streams whatever the edge function holds, and a single malformed
 * row (missing `source`, a non-number `pricePerShare`, a bad timestamp) is enough
 * to throw in the card render and white-screen the whole app. This is the data
 * half of the crash fix: every field the UI touches is guaranteed here, and an
 * unrepairable event (no id/headline) is dropped rather than rendered.
 */
export function sanitizeEvent(raw: TerminalEvent | null | undefined): TerminalEvent | null {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
  const headline =
    typeof raw.headline === "string" && raw.headline.trim() ? raw.headline.trim() : null;
  if (!id || !headline) return null; // unrenderable / undedupable - drop

  const kind = VALID_KINDS.has(raw.kind) ? raw.kind : "catalyst_news";
  const severity = VALID_SEVERITIES.has(raw.severity) ? raw.severity : "watch";

  const url =
    typeof raw.source?.url === "string" && /^https?:\/\//i.test(raw.source.url)
      ? raw.source.url
      : "";
  const sourceName =
    typeof raw.source?.name === "string" && raw.source.name.trim()
      ? raw.source.name.trim()
      : "Source";

  const related = Array.isArray(raw.relatedTickers)
    ? raw.relatedTickers.filter((t): t is string => typeof t === "string" && t.length > 0)
    : undefined;

  return {
    id,
    kind,
    severity,
    ticker: typeof raw.ticker === "string" ? raw.ticker : "",
    relatedTickers: related && related.length > 0 ? related : undefined,
    companyName: typeof raw.companyName === "string" ? raw.companyName : undefined,
    headline,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    actor:
      raw.actor && typeof raw.actor.name === "string"
        ? { name: raw.actor.name, role: typeof raw.actor.role === "string" ? raw.actor.role : undefined }
        : undefined,
    trade: sanitizeTrade(raw.trade),
    occurredAt: safeIso(raw.occurredAt),
    surfacedAt: safeIso(raw.surfacedAt),
    source: { name: sourceName, url },
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
  };
}

export function sanitizeEvents(events: ReadonlyArray<TerminalEvent>): TerminalEvent[] {
  const out: TerminalEvent[] = [];
  for (const e of events) {
    const safe = sanitizeEvent(e);
    if (safe) out.push(safe);
  }
  return out;
}

/**
 * Load the unified Terminal feed. Runs every configured source in parallel,
 * reports per-source status, and returns a severity-then-recency ranked list.
 */
export async function loadTerminalFeed(): Promise<TerminalFeedResult> {
  const registry = sourceRegistry();
  const statuses: TerminalSourceStatus[] = [];

  const results = await Promise.all(
    registry.map(async (src): Promise<TerminalEvent[]> => {
      if (!src.configured) {
        statuses.push({ id: src.id, name: src.name, ok: false, count: 0, note: src.unconfiguredNote });
        return [];
      }
      try {
        const events = await src.run();
        statuses.push({ id: src.id, name: src.name, ok: true, count: events.length });
        return events;
      } catch (err) {
        statuses.push({
          id: src.id,
          name: src.name,
          ok: false,
          count: 0,
          note: err instanceof Error ? err.message : "Source error",
        });
        return [];
      }
    }),
  );

  // Sanitize BEFORE dedupe so no malformed source row can reach the render, then
  // window out stale rows, rank by severity→recency, and de-flood per actor so no
  // single account (e.g. someone liquidating) buries the rest of the wire.
  const cleaned = withinWindow(dedupe(sanitizeEvents(results.flat())));
  const events = capPerActor(rank(cleaned));
  // Keep source order stable (registry order) for a calm, predictable strip.
  statuses.sort(
    (a, b) =>
      registry.findIndex((s) => s.id === a.id) - registry.findIndex((s) => s.id === b.id),
  );

  return { events, sources: statuses, generatedAt: new Date().toISOString() };
}
