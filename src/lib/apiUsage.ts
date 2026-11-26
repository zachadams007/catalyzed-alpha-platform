/**
 * Client-side API usage ledger - the single source of truth for "how hard are
 * we hitting each data vendor on this device?".
 *
 * Every market-data HTTP call funnels through `src/data/http.ts`, which calls
 * `checkApiAllowed()` before the request and `recordApiCall()` after. This
 * module persists a rolling event log + per-day aggregates to localStorage so
 * the Research page can show real quota pressure and the Admin console can
 * pause live data or enforce daily budgets - all without touching the engine.
 *
 * Design constraints:
 * - Pure module, no store coupling: scoring/feeds never read from here.
 * - Recording is fire-and-forget and must never throw into a data path.
 * - Quotas are *free-tier defaults*, labeled as estimates in the UI.
 */

import { isAdminEmail } from "@/lib/admin";
import { useAuthStore } from "@/store/useAuthStore";
import {
  getGlobalControls,
  isGlobalControlsConfigured,
  saveGlobalControls,
} from "@/data/globalControls";

export type ApiVendorId =
  | "finnhub"
  // The 2nd-Finnhub-key failover lane. Never returned by `vendorOf()` (so the
  // proxy router + budgets stay keyed to "finnhub"); it exists purely as a
  // ledger/board bucket for calls that rotated to the backup key - see
  // `recordApiCall`'s ledger override and the injected board row below.
  | "finnhub_backup"
  | "fmp"
  | "alpaca"
  | "yahoo"
  | "sec"
  | "stocktwits"
  | "apewisdom"
  | "proxy"
  // The Research-proxy Gemini failover lane - the mirror of `finnhub_backup`.
  // Never returned by `vendorOf()` (proxy calls stay keyed to "proxy" so the
  // single Research-proxy budget is unchanged); it exists purely as a board row
  // for the server-side backup Gemini key, injected only when the backup key is
  // configured - see `PROXY_BACKUP_META` and the injection in `getUsageSnapshot`.
  | "proxy_backup"
  // The photo→holdings/watchlist vision lane (Groq by default, any
  // OpenAI-compatible vision endpoint via VITE_VISION_BASE_URL). It's a real,
  // separately-keyed + separately-budgeted source, but it only exists when the
  // operator sets VITE_VISION_API_KEY - so it's kept OUT of the static
  // `API_VENDORS` and surfaced on the board + budget editor only when keyed
  // (see `VISION_META`, `hasVisionKey`, `visionBoardRows`).
  | "vision"
  | "other";

export type QuotaWindow = "minute" | "hour" | "day";

export interface VendorMeta {
  id: ApiVendorId;
  /** Functional label shown as the card title (e.g. "Finnhub (main)"). */
  name: string;
  /** Human provider/company behind this source - the brand identity shown on the
   *  board so the operator knows WHO serves each row (e.g. the Research Proxy is
   *  served by "Gemini", FMP by "Financial Modeling Prep"). */
  provider: string;
  /** Needs a key in .env (VITE_*) to do anything. */
  keyed: boolean;
  /** Free-tier call allowance for the binding window (soft estimate when unkeyed). */
  limit: number;
  window: QuotaWindow;
  /** Short human label for the allowance, e.g. "60 calls/min · free tier". */
  limitNote: string;
  /** What the app uses this source for. */
  feeds: string;
}

/** Ordered the way they appear on dashboards: keyed vendors first. */
export const API_VENDORS: VendorMeta[] = [
  {
    id: "finnhub",
    name: "Finnhub (main)",
    provider: "Finnhub",
    keyed: true,
    limit: 60,
    window: "minute",
    limitNote: "60 calls/min · free tier",
    feeds: "Quotes, news, analyst targets & symbol search",
  },
  {
    id: "fmp",
    name: "FMP",
    provider: "Financial Modeling Prep",
    keyed: true,
    limit: 250,
    window: "day",
    limitNote: "250 calls/day · free tier",
    feeds: "Fundamentals, insider & congress trades, news",
  },
  {
    id: "alpaca",
    name: "Alpaca",
    provider: "Alpaca Markets",
    keyed: true,
    limit: 200,
    window: "minute",
    limitNote: "200 calls/min · free tier",
    feeds: "Snapshots, daily bars & the market news wire",
  },
  {
    id: "proxy",
    name: "Research Proxy",
    provider: "Gemini",
    keyed: true,
    limit: 200,
    window: "day",
    limitNote: "200 calls/day · your own server",
    feeds: "Optional AI universe-discovery agent",
  },
  {
    id: "yahoo",
    name: "Yahoo Finance",
    provider: "Yahoo Finance",
    keyed: false,
    limit: 500,
    window: "day",
    limitNote: "~500 calls/day · unofficial, be gentle",
    feeds: "Price-history & momentum fallback · headline RSS",
  },
  {
    id: "sec",
    name: "SEC EDGAR",
    provider: "U.S. SEC EDGAR",
    keyed: false,
    limit: 600,
    window: "minute",
    limitNote: "10 calls/sec · official fair-access",
    feeds: "Insider Form 4s, 8-K filings & company tickers",
  },
  {
    id: "stocktwits",
    name: "StockTwits",
    provider: "StockTwits",
    keyed: false,
    limit: 200,
    window: "hour",
    limitNote: "~200 calls/hr · public endpoint",
    feeds: "Ticker attention & message sentiment",
  },
  {
    id: "apewisdom",
    name: "ApeWisdom",
    provider: "ApeWisdom",
    keyed: false,
    limit: 60,
    window: "hour",
    limitNote: "~60 calls/hr · public endpoint",
    feeds: "Reddit mention counts & rank",
  },
];

/**
 * The 2nd-Finnhub-key failover row, shown on the data-source board right after
 * the main Finnhub row. Deliberately kept OUT of {@link API_VENDORS}: the backup
 * key is a failover, not a separately-budgeted source, so it must not appear in
 * the Operator budget editor (which maps API_VENDORS). It IS injected into the
 * board snapshot by {@link getUsageSnapshot}. Per-key counts are real in DIRECT
 * mode (the client rotates the key - see http.ts); in PROXY mode the rotation is
 * server-side and invisible to the client, so the board labels it honestly.
 */
export const FINNHUB_BACKUP_META: VendorMeta = {
  id: "finnhub_backup",
  name: "Finnhub (backup)",
  provider: "Finnhub",
  keyed: true,
  limit: 60,
  window: "minute",
  limitNote: "2nd key · rotates on a 429",
  feeds: "Failover for quotes & news when the main key is rate-limited",
};

/**
 * The Research-proxy Gemini failover row, shown on the data-source board right
 * after the Research Proxy row - the exact mirror of {@link FINNHUB_BACKUP_META}.
 * Also kept OUT of {@link API_VENDORS}: the backup Gemini key is a server-side
 * failover on the research proxy, not a separately-budgeted source, so it must
 * not appear in the Operator budget editor - the single Research-proxy ("proxy")
 * cap stays. It is injected into the board snapshot by {@link getUsageSnapshot}
 * ONLY when a backup key is configured ({@link hasProxyBackupKey}). The Gemini
 * rotation is owned by the proxy server-side, so the client can't see per-key
 * counts - the board labels it honestly, just like the Finnhub backup in proxy
 * mode.
 */
export const PROXY_BACKUP_META: VendorMeta = {
  id: "proxy_backup",
  name: "Gemini (backup)",
  provider: "Gemini",
  keyed: true,
  limit: 200,
  window: "day",
  limitNote: "backup key · fails over server-side",
  feeds: "Failover for the AI universe-discovery agent when the main Gemini key errors",
};

/**
 * Whether a backup Gemini key is configured for the research proxy. The real key
 * lives server-side on the proxy (`GEMINI_API_KEY_BACKUP`); the client only needs
 * a presence flag to decide whether to surface the backup row - mirroring how
 * `VITE_FINNHUB_API_KEY_2` reveals the Finnhub backup lane. Set the client-visible
 * `VITE_GEMINI_API_KEY_BACKUP` to any truthy value to light it up (Vite only
 * exposes `VITE_*` to the bundle, and per the project rules no real secret ships
 * client-side - this is purely a presence signal).
 */
function hasProxyBackupKey(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  return Boolean(env.VITE_GEMINI_API_KEY_BACKUP?.trim());
}

/**
 * The photo→holdings/watchlist vision provider (Groq by default), served via an
 * OpenAI-compatible chat endpoint. It's a genuinely separate, separately-keyed
 * source - but unlike the Finnhub/Gemini failover lanes it has its OWN budget.
 * It is kept OUT of {@link API_VENDORS} (which always render) because the feature
 * is opt-in: with no `VITE_VISION_API_KEY` there's nothing to show. When a key IS
 * set it is injected into both the board snapshot ({@link getUsageSnapshot}) and
 * the Operator budget editor (via {@link visionBoardRows}) so the operator sees
 * usage AND can cap it - mirroring how the keyed market vendors behave.
 *
 * Groq's free tier serves the default model; the default limit below reflects a
 * conservative free-tier daily allowance (the feature reads a handful of
 * screenshots per session, never the bursty market scan).
 */
export const VISION_META: VendorMeta = {
  id: "vision",
  name: "Vision (Groq)",
  provider: "Groq",
  keyed: true,
  limit: 100,
  window: "day",
  limitNote: "~100 calls/day · free tier",
  feeds: "Photo → holdings/watchlist screenshot reader",
};

/**
 * Whether the vision provider is configured. The real key is a client-visible
 * `VITE_VISION_API_KEY` (the feature runs in-browser/in-Tauri against the Groq
 * endpoint). Mirrors `isVisionConfigured()` in
 * `src/data/vision/extractHoldings.ts` without importing it (apiUsage stays a
 * dependency-light, store-free leaf module).
 */
export function hasVisionKey(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  return Boolean(env.VITE_VISION_API_KEY?.trim());
}

/**
 * The keyed vendor rows that should appear on the board + budget editor ONLY
 * when their key is configured - currently just the Vision provider. Kept here so
 * the snapshot, the budget editor, and any future surface stay in lockstep.
 */
export function visionBoardRows(): VendorMeta[] {
  return hasVisionKey() ? [VISION_META] : [];
}

const VENDOR_BY_ID = new Map(
  [...API_VENDORS, FINNHUB_BACKUP_META, PROXY_BACKUP_META, VISION_META].map((v) => [v.id, v]),
);

export function vendorMeta(id: ApiVendorId): VendorMeta {
  return (
    VENDOR_BY_ID.get(id) ?? {
      id: "other",
      name: "Other",
      provider: "—",
      keyed: false,
      limit: 500,
      window: "day",
      limitNote: "untracked source",
      feeds: "Miscellaneous fetches",
    }
  );
}

/** Map a request URL to the vendor whose quota it spends. */
export function vendorOf(url: string): ApiVendorId {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host.endsWith("finnhub.io")) return "finnhub";
  if (host.endsWith("financialmodelingprep.com")) return "fmp";
  if (host.endsWith("alpaca.markets")) return "alpaca";
  if (host.endsWith("yahoo.com")) return "yahoo";
  if (host.endsWith("sec.gov")) return "sec";
  if (host.endsWith("stocktwits.com")) return "stocktwits";
  if (host.endsWith("apewisdom.io")) return "apewisdom";
  if (host.endsWith("groq.com")) return "vision";
  // Vision can be repointed at any OpenAI-compatible vision endpoint
  // (OpenRouter, a self-host) via VITE_VISION_BASE_URL - bucket those to the
  // same "vision" lane so the board + budget track the feature, not the host.
  const visionBase = (import.meta.env.VITE_VISION_BASE_URL as string | undefined)?.trim();
  if (visionBase) {
    try {
      if (host === new URL(visionBase).hostname.toLowerCase()) return "vision";
    } catch {
      /* malformed vision base URL - fall through */
    }
  }
  const proxy = (import.meta.env.VITE_RESEARCH_PROXY_URL as string | undefined)?.trim();
  if (proxy) {
    try {
      if (host === new URL(proxy).hostname.toLowerCase()) return "proxy";
    } catch {
      /* malformed proxy URL - fall through */
    }
  }
  return "other";
}

// ── Persistence ───────────────────────────────────────────────────────────────

interface UsageEvent {
  t: number; // epoch ms
  v: ApiVendorId;
  ok: boolean;
}

type DayCounts = Partial<Record<ApiVendorId, { ok: number; err: number }>>;

export interface ApiControls {
  /** Storage migration marker. Older contexts are forced back to a safe state. */
  safetyVersion: number;
  /** Kill switch: every market-data call short-circuits with a clear error. */
  paused: boolean;
  /** When true, vendors at/over their daily budget are blocked (not just flagged). */
  enforceBudgets: boolean;
  /** Per-vendor daily call budgets set from the Admin console. */
  budgets: Partial<Record<ApiVendorId, number>>;
  /** Allowlisted operator who last changed these controls. */
  updatedBy: string | null;
  /** ISO timestamp of the last operator change. */
  updatedAt: string | null;
}

const EVENTS_KEY = "catalyzed-alpha:api-usage:v1";
const CONTROLS_KEY = "catalyzed-alpha:api-controls:v1";

const EVENT_RETENTION_MS = 48 * 60 * 60 * 1000;
const EVENT_HARD_CAP = 4000;
const DAY_RETENTION_DAYS = 14;
const API_SAFETY_VERSION = 2;

// Default daily budgets = the FULL daily limit of each vendor's API key.
//
// The budget is the operator's safety rail, NOT a throttle: it should never be the thing that
// quietly starves a scan. So every default below equals the key's real daily allowance - a
// single shared operator key, used to its full ceiling, with the per-vendor budget set to that
// same ceiling.
//
// Per-vendor daily ceilings (free tier unless the operator's key is higher):
//   • Research Proxy (Gemini) - 200/day  (Gemini free-tier daily request cap)
//   • FMP - 250/day  (free-tier daily call cap)
//   • Finnhub - 250/day  (60/min has no daily cap; 250 is a
//                                           generous, key-safe daily ceiling that
//                                           a full market scan stays under)
//   • Alpaca - 500/day  (200/min has no daily cap; 500 covers
//                                           snapshots + the live-price overlay)
//   • Yahoo Finance - 500/day  (unofficial; full daily we'll allow)
//   • SEC EDGAR - 600/day  (10 req/sec official fair-access; 600
//                                           is the daily ceiling we hold ourselves to)
//   • StockTwits - 200/day  (public endpoint, full daily)
//   • ApeWisdom - 60/day   (public endpoint, full daily)
//   • Vision (Groq) - 100/day  (free-tier daily; opt-in screenshot reader)
//
// These mirror each vendor's `limit`/`limitNote` in API_VENDORS so the editor's
// default value matches the allowance printed on the same card.
export const SAFE_DEFAULT_BUDGETS: Partial<Record<ApiVendorId, number>> = {
  finnhub: 250,
  fmp: 250,
  alpaca: 500,
  proxy: 200,
  yahoo: 500,
  sec: 600,
  stocktwits: 200,
  apewisdom: 60,
  vision: 100,
};

/**
 * Whether live data should START paused for a fresh device with no stored
 * operator controls. Testers must get real data on first open WITHOUT touching
 * the Operator Console, so we DON'T pause when a data source is reachable - the
 * hosted market proxy (`VITE_MARKET_PROXY_URL`) or a local vendor key. With
 * nothing reachable we keep the safe paused default. An explicit
 * `VITE_LIVE_DATA_PAUSED=on|off` build flag always wins. Per-device daily
 * budgets (enforceBudgets) still protect the shared keys regardless.
 */
function defaultLiveDataPaused(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  const override = env.VITE_LIVE_DATA_PAUSED?.trim().toLowerCase();
  if (override === "on" || override === "true" || override === "1") return true;
  if (override === "off" || override === "false" || override === "0") return false;
  const reachable = Boolean(
    env.VITE_MARKET_PROXY_URL?.trim() ||
      env.VITE_FINNHUB_API_KEY?.trim() ||
      env.VITE_FMP_API_KEY?.trim(),
  );
  return !reachable;
}

const DEFAULT_CONTROLS: ApiControls = {
  safetyVersion: API_SAFETY_VERSION,
  paused: true,
  enforceBudgets: true,
  budgets: { ...SAFE_DEFAULT_BUDGETS },
  updatedBy: null,
  updatedAt: null,
};

function dayKeyOf(t: number): string {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

interface LedgerState {
  events: UsageEvent[];
  days: Record<string, DayCounts>;
  clearedAt: string | null;
  clearedBy: string | null;
}

function loadLedger(): LedgerState {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return { events: [], days: {}, clearedAt: null, clearedBy: null };
    const parsed = JSON.parse(raw) as Partial<LedgerState>;
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    // Sanitize day cells so a corrupted blob can't poison recording later
    // (recordApiCall does `cell.ok += 1` and must never hit a non-number).
    const days: Record<string, DayCounts> = {};
    for (const [key, day] of Object.entries(parsed.days ?? {})) {
      if (!day || typeof day !== "object") continue;
      const clean: DayCounts = {};
      for (const [v, cell] of Object.entries(day)) {
        if (cell && typeof cell.ok === "number" && typeof cell.err === "number") {
          clean[v as ApiVendorId] = { ok: cell.ok, err: cell.err };
        }
      }
      days[key] = clean;
    }
    return {
      events: (parsed.events ?? []).filter((e) => e && typeof e.t === "number" && e.t > cutoff),
      days,
      clearedAt: typeof parsed.clearedAt === "string" ? parsed.clearedAt : null,
      clearedBy:
        typeof parsed.clearedBy === "string" && isAdminEmail(parsed.clearedBy)
          ? parsed.clearedBy.trim().toLowerCase()
          : null,
    };
  } catch {
    return { events: [], days: {}, clearedAt: null, clearedBy: null };
  }
}

function loadControls(): ApiControls {
  try {
    const raw = localStorage.getItem(CONTROLS_KEY);
    // Fresh device, no stored operator choice: live data flows by default when a
    // source is reachable (tester ship), but stays inside per-device budgets.
    if (!raw) {
      return {
        ...DEFAULT_CONTROLS,
        paused: defaultLiveDataPaused(),
        budgets: { ...DEFAULT_CONTROLS.budgets },
      };
    }
    const parsed = JSON.parse(raw) as Partial<ApiControls>;
    if (parsed.safetyVersion !== API_SAFETY_VERSION) {
      return { ...DEFAULT_CONTROLS, budgets: { ...DEFAULT_CONTROLS.budgets } };
    }
    return {
      safetyVersion: API_SAFETY_VERSION,
      paused: Boolean(parsed.paused),
      enforceBudgets: Boolean(parsed.enforceBudgets),
      budgets: parsed.budgets ?? { ...SAFE_DEFAULT_BUDGETS },
      updatedBy:
        typeof parsed.updatedBy === "string" && isAdminEmail(parsed.updatedBy)
          ? parsed.updatedBy.trim().toLowerCase()
          : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_CONTROLS, budgets: { ...DEFAULT_CONTROLS.budgets } };
  }
}

const ledger: LedgerState = loadLedger();
let controls: ApiControls = loadControls();

/**
 * The EFFECTIVE controls every gate reads. When Supabase is configured the global
 * operator row (`app_controls`) governs the ENTIRE app for ALL users - a signed
 * out or non-operator session can NOT loosen the pause/budgets. Local controls
 * are only the fallback for an unconfigured (dev) build.
 *
 * Fail-closed: if the global source exists but hasn't loaded yet, treat live data
 * as paused so a pre-load flash can never bypass the operator's kill switch.
 */
// Set on auth when the signed-in email is an admin (the operator KILL SWITCH / pause still
// applies; only the per-vendor budget cap is lifted). The desk's separate "busy" is the free
// Gemini per-minute window, not this.
let adminUnlimited = false;
export function setAdminUnlimited(on: boolean): void {
  adminUnlimited = on;
}

function effectiveControls(): ApiControls {
  let eff: ApiControls;
  if (isGlobalControlsConfigured()) {
    const g = getGlobalControls();
    eff = !g
      ? { ...DEFAULT_CONTROLS, paused: true, budgets: { ...SAFE_DEFAULT_BUDGETS } }
      : {
          safetyVersion: API_SAFETY_VERSION,
          paused: g.livePaused,
          enforceBudgets: g.enforceBudgets,
          budgets: g.budgets,
          updatedBy: g.updatedBy,
          updatedAt: g.updatedAt,
        };
  } else {
    eff = controls;
  }
  // Lift the budget cap for the admin/owner (pause still respected).
  return adminUnlimited ? { ...eff, enforceBudgets: false } : eff;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesce writes - research runs burst hundreds of calls in seconds. */
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(ledger));
    } catch {
      /* storage full/unavailable - usage display degrades, data paths don't */
    }
  }, 400);
}

function saveControls(): void {
  try {
    localStorage.setItem(CONTROLS_KEY, JSON.stringify(controls));
  } catch {
    /* non-fatal */
  }
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();
const reservedCalls: Partial<Record<ApiVendorId, number>> = {};

function notify(): void {
  for (const l of listeners) l();
}

let notifyTimer: ReturnType<typeof setTimeout> | undefined;

/** Research runs record hundreds of calls in bursts - coalesce UI updates so
 *  dashboards re-render a few times a second, not once per call. */
function notifyThrottled(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    notify();
  }, 250);
}

/** Subscribe to ledger/controls changes (UI live-updates). Returns unsubscribe. */
export function subscribeApiUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Recording + gating ────────────────────────────────────────────────────────

/**
 * Record one settled market-data call.
 *
 * `ledgerVendor` overrides only the LEDGER/board bucket the call is credited to,
 * NOT the reservation/budget vendor: the gate reserved a slot against
 * `vendorOf(url)` (always the primary vendor), so that slot is always released
 * against the same id - while the event itself can be attributed to a failover
 * lane (e.g. `finnhub_backup`) so the board can show per-key usage. Without an
 * override the call is credited to the same vendor it was gated against, exactly
 * as before.
 */
export function recordApiCall(url: string, ok: boolean, ledgerVendor?: ApiVendorId): void {
  try {
    const reserveVendor = vendorOf(url);
    reservedCalls[reserveVendor] = Math.max(0, (reservedCalls[reserveVendor] ?? 0) - 1);
    const v = ledgerVendor ?? reserveVendor;
    // Clamp against the previous event so the array stays time-ordered even if
    // the OS wall clock steps backwards (the window scans rely on ordering).
    const last = ledger.events[ledger.events.length - 1]?.t ?? 0;
    const t = Math.max(Date.now(), last);
    ledger.events.push({ t, v, ok });
    if (ledger.events.length > EVENT_HARD_CAP + 500) {
      ledger.events.splice(0, ledger.events.length - EVENT_HARD_CAP);
    }
    const key = dayKeyOf(t);
    const day = (ledger.days[key] ??= {});
    const cell = (day[v] ??= { ok: 0, err: 0 });
    if (ok) cell.ok += 1;
    else cell.err += 1;
    // Prune old day buckets occasionally (cheap: only when a new day appears).
    const keys = Object.keys(ledger.days);
    if (keys.length > DAY_RETENTION_DAYS) {
      for (const k of keys.sort().slice(0, keys.length - DAY_RETENTION_DAYS)) {
        delete ledger.days[k];
      }
    }
    scheduleSave();
    notifyThrottled();
  } catch {
    /* never let bookkeeping break a data fetch */
  }
}

export function getTodayUsageByVendor(): Array<{ vendor: ApiVendorId; ok: number; err: number }> {
  const day = ledger.days[dayKeyOf(Date.now())] ?? {};
  return Object.entries(day)
    .map(([vendor, cell]) => ({
      vendor: vendor as ApiVendorId,
      ok: cell?.ok ?? 0,
      err: cell?.err ?? 0,
    }))
    .filter(({ ok, err }) => ok + err > 0);
}

export type ApiGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Non-reserving availability peek. UI surfaces (e.g. Blueprint's AI lane) call
 * this to render "paused for today" states ahead of time - unlike
 * `checkApiAllowed` it never reserves a call slot, so peeking is free.
 */
export function peekApiAllowed(url: string): ApiGate {
  try {
    const eff = effectiveControls();
    if (eff.paused) {
      return {
        allowed: false,
        reason: "Live data is paused from the Operator console.",
      };
    }
    if (eff.enforceBudgets) {
      const v = vendorOf(url);
      const budget = eff.budgets[v];
      if (budget != null && budget > 0) {
        const today = ledger.days[dayKeyOf(Date.now())]?.[v];
        const used = (today?.ok ?? 0) + (today?.err ?? 0);
        if (used + (reservedCalls[v] ?? 0) >= budget) {
          return {
            allowed: false,
            reason: `${vendorMeta(v).name} reached its ${budget}-call daily budget.`,
          };
        }
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Live data safety check failed." };
  }
}

/** Pre-flight check used by src/data/http.ts. Pause + budget enforcement. */
export function checkApiAllowed(url: string): ApiGate {
  try {
    const eff = effectiveControls();
    if (eff.paused) {
      return {
        allowed: false,
        reason: "Live data is paused from the Operator console — flip it back on under /#/admin.",
      };
    }
    if (eff.enforceBudgets) {
      const v = vendorOf(url);
      const budget = eff.budgets[v];
      if (budget != null && budget > 0) {
        const today = ledger.days[dayKeyOf(Date.now())]?.[v];
        const used = (today?.ok ?? 0) + (today?.err ?? 0);
        if (used + (reservedCalls[v] ?? 0) >= budget) {
          return {
            allowed: false,
            reason: `${vendorMeta(v).name} hit its ${budget}-call daily budget — raise it in the Operator console.`,
          };
        }
      }
    }
    const v = vendorOf(url);
    reservedCalls[v] = (reservedCalls[v] ?? 0) + 1;
    return { allowed: true };
  } catch {
    return {
      allowed: false,
      reason: "Live data safety check failed. No API request was sent.",
    };
  }
}

// ── Controls API (Admin console) ──────────────────────────────────────────────

export function getApiControls(): ApiControls {
  const eff = effectiveControls();
  return { ...eff, budgets: { ...eff.budgets } };
}

export function isApiAccessPaused(): boolean {
  return effectiveControls().paused;
}

function authorizedOperator(email: string | null | undefined): string | null {
  const actor = email?.trim().toLowerCase();
  const auth = useAuthStore.getState();
  const sessionEmail = auth.email?.trim().toLowerCase();
  if (!auth.ready || !auth.userId || !actor || actor !== sessionEmail || !isAdminEmail(actor)) {
    return null;
  }
  return actor;
}

export function updateApiControls(
  patch: Partial<Pick<ApiControls, "paused" | "enforceBudgets">>,
  actorEmail: string | null | undefined,
): boolean {
  const actor = authorizedOperator(actorEmail);
  if (!actor) return false;
  // When a global source exists, the operator's controls are GLOBAL: write them
  // to Supabase so they govern every client. The local copy below is the dev
  // fallback (Supabase unconfigured) and an optimistic echo otherwise.
  if (isGlobalControlsConfigured()) {
    void saveGlobalControls({
      livePaused: patch.paused,
      enforceBudgets: patch.enforceBudgets,
    });
  }
  controls = {
    ...controls,
    ...patch,
    safetyVersion: API_SAFETY_VERSION,
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  saveControls();
  notify();
  return true;
}

export function setVendorBudget(
  vendor: ApiVendorId,
  budget: number | undefined,
  actorEmail: string | null | undefined,
): boolean {
  const actor = authorizedOperator(actorEmail);
  if (!actor) return false;
  // Budgets are GLOBAL when a server source exists - start from the effective
  // (global) budgets so we patch the authoritative set, then write it back.
  const base = isGlobalControlsConfigured() ? effectiveControls().budgets : controls.budgets;
  const budgets = { ...base };
  if (budget == null || !Number.isFinite(budget) || budget <= 0) delete budgets[vendor];
  else budgets[vendor] = Math.floor(budget);
  if (isGlobalControlsConfigured()) {
    void saveGlobalControls({ budgets });
  }
  controls = {
    ...controls,
    budgets,
    safetyVersion: API_SAFETY_VERSION,
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  saveControls();
  notify();
  return true;
}

export function applyApiSafetyState(
  paused: boolean,
  actorEmail: string,
  updatedAt: string,
): boolean {
  if (!isAdminEmail(actorEmail)) return false;
  controls = {
    ...controls,
    safetyVersion: API_SAFETY_VERSION,
    paused,
    updatedBy: actorEmail.trim().toLowerCase(),
    updatedAt,
  };
  saveControls();
  notify();
  return true;
}

/** Wipe the on-device ledger (events + day aggregates). Controls survive. */
export function clearApiUsage(actorEmail: string | null | undefined): boolean {
  const actor = authorizedOperator(actorEmail);
  if (!actor) return false;
  ledger.events = [];
  ledger.days = {};
  ledger.clearedAt = new Date().toISOString();
  ledger.clearedBy = actor;
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(ledger));
  } catch {
    /* non-fatal */
  }
  notify();
  return true;
}

// ── Snapshot (what the dashboards render) ─────────────────────────────────────

export type VendorLevel = "idle" | "ok" | "elevated" | "critical";
export type DataQuality = "full" | "elevated" | "degraded" | "paused";

export interface VendorUsage {
  meta: VendorMeta;
  lastMinute: number;
  lastHour: number;
  today: number;
  errorsToday: number;
  /** Calls inside the vendor's binding window (minute/hour/day). */
  windowUsed: number;
  /** windowUsed / limit, clamped 0..1. */
  usedFrac: number;
  remaining: number;
  lastCallAt: number | null;
  budget?: number;
  overBudget: boolean;
  level: VendorLevel;
}

export interface UsageSnapshot {
  vendors: VendorUsage[];
  totalToday: number;
  /** False until this device has recorded at least one call (drives the empty state). */
  hasHistory: boolean;
  /** Calls per minute for the trailing 10 minutes (oldest → newest). */
  pulse: number[];
  quality: DataQuality;
  controls: ApiControls;
  clearedAt: string | null;
  clearedBy: string | null;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Roll one vendor's ledger events/day-cell into the gauge the board renders. */
function computeVendorUsage(
  meta: VendorMeta,
  now: number,
  dayKey: string,
  eff: ApiControls,
): VendorUsage {
  let lastMinute = 0;
  let lastHour = 0;
  let lastCallAt: number | null = null;
  for (let i = ledger.events.length - 1; i >= 0; i--) {
    const e = ledger.events[i];
    if (e.v !== meta.id) continue;
    if (lastCallAt === null) lastCallAt = e.t;
    const age = now - e.t;
    if (age < MINUTE) lastMinute += 1;
    if (age < HOUR) lastHour += 1;
    else break; // events are time-ordered; nothing older matters here
  }
  const dayCell = ledger.days[dayKey]?.[meta.id];
  const today = (dayCell?.ok ?? 0) + (dayCell?.err ?? 0);
  const errorsToday = dayCell?.err ?? 0;

  const windowUsed =
    meta.window === "minute" ? lastMinute : meta.window === "hour" ? lastHour : today;
  const usedFrac = Math.max(0, Math.min(1, windowUsed / meta.limit));
  const budget = eff.budgets[meta.id];
  const overBudget = budget != null && budget > 0 && today >= budget;

  let level: VendorLevel;
  if (overBudget || usedFrac >= 0.85) level = "critical";
  else if (usedFrac >= 0.55) level = "elevated";
  else if (windowUsed === 0) level = "idle";
  else level = "ok";

  return {
    meta,
    lastMinute,
    lastHour,
    today,
    errorsToday,
    windowUsed,
    usedFrac,
    remaining: Math.max(0, meta.limit - windowUsed),
    lastCallAt,
    budget,
    overBudget,
    level,
  };
}

export function getUsageSnapshot(now = Date.now()): UsageSnapshot {
  const dayKey = dayKeyOf(now);
  const eff = effectiveControls();
  const vendors: VendorUsage[] = API_VENDORS.map((meta) =>
    computeVendorUsage(meta, now, dayKey, eff),
  );
  // Inject the Finnhub backup-key row right after the main Finnhub row so the
  // operator sees per-key usage side by side. It lives only in the board
  // snapshot (not in API_VENDORS), so the budget editor still lists a single
  // Finnhub cap - the backup is a failover, not separately budgeted.
  const backupRow = computeVendorUsage(FINNHUB_BACKUP_META, now, dayKey, eff);
  const mainIdx = vendors.findIndex((v) => v.meta.id === "finnhub");
  if (mainIdx >= 0) vendors.splice(mainIdx + 1, 0, backupRow);
  else vendors.push(backupRow);

  // Mirror the same move for the Research-proxy Gemini backup key: inject its row
  // right after the "proxy" row, but ONLY when a backup key is configured. Like
  // the Finnhub backup it lives only in the snapshot (not API_VENDORS), so the
  // budget editor still lists a single Research-proxy cap; the Gemini rotation is
  // server-side, so this row carries no client-visible per-key count.
  if (hasProxyBackupKey()) {
    const proxyBackupRow = computeVendorUsage(PROXY_BACKUP_META, now, dayKey, eff);
    const proxyIdx = vendors.findIndex((v) => v.meta.id === "proxy");
    if (proxyIdx >= 0) vendors.splice(proxyIdx + 1, 0, proxyBackupRow);
    else vendors.push(proxyBackupRow);
  }

  // Append the Vision provider row(s) only when keyed - it's an opt-in,
  // separately-budgeted source, so unlike the failover lanes it sits at the end
  // of the keyed group rather than being spliced beside a parent vendor.
  for (const meta of visionBoardRows()) {
    vendors.push(computeVendorUsage(meta, now, dayKey, eff));
  }

  const dayTotals = ledger.days[dayKey] ?? {};
  const totalToday = Object.values(dayTotals).reduce((s, c) => s + (c?.ok ?? 0) + (c?.err ?? 0), 0);

  const pulse = new Array<number>(10).fill(0);
  const pulseStart = now - 10 * MINUTE;
  for (let i = ledger.events.length - 1; i >= 0; i--) {
    const e = ledger.events[i];
    if (e.t < pulseStart) break;
    const slot = Math.min(9, Math.floor((e.t - pulseStart) / MINUTE));
    pulse[slot] += 1;
  }

  let quality: DataQuality = "full";
  if (eff.paused) quality = "paused";
  else if (vendors.some((v) => v.level === "critical")) quality = "degraded";
  else if (vendors.some((v) => v.level === "elevated")) quality = "elevated";

  const hasHistory =
    ledger.events.length > 0 ||
    Object.values(ledger.days).some((day) =>
      Object.values(day).some((c) => (c?.ok ?? 0) + (c?.err ?? 0) > 0),
    );

  return {
    vendors,
    totalToday,
    hasHistory,
    pulse,
    quality,
    controls: getApiControls(),
    clearedAt: ledger.clearedAt,
    clearedBy: ledger.clearedBy,
  };
}

export const QUALITY_COPY: Record<DataQuality, { label: string; detail: string }> = {
  full: {
    label: "Full fidelity",
    detail: "All sources inside their free-tier allowance — signals use the freshest data.",
  },
  elevated: {
    label: "Elevated load",
    detail: "A source is running hot. Bursty re-runs may start hitting rate limits.",
  },
  degraded: {
    label: "Degraded",
    detail: "A source is at its allowance — calls fail or back off, so freshness drops.",
  },
  paused: {
    label: "Paused",
    detail: "Live data is switched off from the Operator console. Cached/sample data only.",
  },
};
