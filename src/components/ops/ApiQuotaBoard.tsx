import { useEffect, useState } from "react";
import {
  getUsageSnapshot,
  subscribeApiUsage,
  QUALITY_COPY,
  hasVisionKey,
  type ApiVendorId,
  type UsageSnapshot,
  type VendorUsage,
} from "@/lib/apiUsage";
import { vendorReach, type VendorReach, type VendorReachKind } from "@/data/http";
import { isSampleDataModeEnabled } from "@/data/providers";
import { subscribeGlobalControls } from "@/data/globalControls";
import { relativeTime, formatNumber } from "@/lib/format";
import { fetchProxyKeyPools, type KeyPoolStatus, type KeyStat } from "@/data/proxyStatus";
import { fetchApiUsageToday, type ApiUsageToday, type ApiUsageVendor } from "@/data/apiUsageDaily";

/**
 * "Data-source health" board - ONE card per data source, no doubling-up.
 *
 * Each keyed vendor that the server load-balances across a key pool (Finnhub,
 * FMP, Gemini, Groq) renders a SINGLE card that shows BOTH:
 *   • this device's calls vs daily budget (the readable "47 / 250" gauge), and
 *   • the server-side key-rotation lamps + which key is next + failover count,
 * folded into the same card. The public/single-key sources (Alpaca, Yahoo, SEC,
 * StockTwits, ApeWisdom) render as plain cards with no lamp strip.
 *
 * This replaced the old split layout (a per-source grid PLUS a separate
 * "Key pool" panel underneath), which showed Finnhub/FMP/Gemini twice and was
 * the Operator tab's worst density offender.
 *
 * Reachability is PROXY-AWARE (see `vendorReach`): the production bundle ships
 * zero local keys and reaches every vendor through the hosted market proxy, so a
 * proxied vendor reads "Live · via proxy", never the old false "No key".
 */

/** Live status text for a reachable, healthy/idle keyed vendor - encodes the path. */
function liveStatusLabel(kind: VendorReachKind): string {
  switch (kind) {
    case "proxy":
      return "Live · via proxy";
    case "server":
      return "Live · your server";
    case "local":
      return "Live · local key";
    default:
      return "Healthy";
  }
}

/** The word a genuinely-unconfigured vendor shows. */
function noPathLabel(id: ApiVendorId): string {
  if (id === "proxy") return "no proxy";
  return "no key";
}

/** Live snapshot: re-render on every recorded call + a slow tick so rolling
 *  windows (last minute/hour) decay even when no new calls arrive. */
export function useApiUsage(): UsageSnapshot {
  const [snapshot, setSnapshot] = useState<UsageSnapshot>(() => getUsageSnapshot());
  useEffect(() => {
    const refresh = () => setSnapshot(getUsageSnapshot());
    const unsubscribe = subscribeApiUsage(refresh);
    // Also re-render when the GLOBAL operator controls change (realtime/poll), so
    // a remote operator flip is reflected here without a manual reload.
    const unsubscribeGlobal = subscribeGlobalControls(refresh);
    const tick = setInterval(refresh, 20_000);
    return () => {
      unsubscribe();
      unsubscribeGlobal();
      clearInterval(tick);
    };
  }, []);
  return snapshot;
}

const WINDOW_LABEL: Record<VendorUsage["meta"]["window"], string> = {
  minute: "this minute",
  hour: "this hour",
  day: "today",
};

/** Live server-side key-pool status (round-robin rotation), polled slowly. */
function useKeyPools(): KeyPoolStatus | null {
  const [status, setStatus] = useState<KeyPoolStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next = await fetchProxyKeyPools();
      if (alive) setStatus(next);
    };
    void load();
    const tick = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(tick);
    };
  }, []);
  return status;
}

/**
 * Persistent, CROSS-USER usage today - read from the server (`get_api_usage_today`),
 * polled slowly. `loaded` distinguishes "still fetching" from "fetched, but the RPC
 * isn't deployed / returned nothing" so the board can show an honest empty state.
 */
function useApiUsageToday(): { usage: ApiUsageToday | null; loaded: boolean } {
  const [usage, setUsage] = useState<ApiUsageToday | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next = await fetchApiUsageToday();
      if (!alive) return;
      setUsage(next);
      setLoaded(true);
    };
    void load();
    const tick = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(tick);
    };
  }, []);
  return { usage, loaded };
}

// ── Pooled (cross-user) budget model ────────────────────────────────────────

/** Brand label for a vendor id recorded by the proxy. */
const VENDOR_LABEL: Record<string, string> = {
  finnhub: "Finnhub",
  fmp: "FMP",
  gemini: "Gemini",
  groq: "Groq",
  alpaca: "Alpaca",
  yahoo: "Yahoo Finance",
  sec: "SEC EDGAR",
  stocktwits: "StockTwits",
  apewisdom: "ApeWisdom",
};

/** What each vendor serves - one short line for the pooled card. */
const VENDOR_FEEDS: Record<string, string> = {
  finnhub: "Quotes, fundamentals & news",
  fmp: "Fundamentals & screeners",
  gemini: "Grounded research (Research Desk)",
  groq: "Bull/Bear/Judge debate & fallback",
  alpaca: "Live price snapshots",
  yahoo: "Charts, TSX quotes & targets",
  sec: "EDGAR filings (8-K, Form 4)",
  stocktwits: "Social sentiment",
  apewisdom: "Retail hype index",
};

/**
 * Per-KEY daily call cap - ONLY real, sourced numbers. `null` means the vendor has
 * no single daily call cap we can cite (rate-limited per-minute, or generous): the
 * card then shows the total + an honest note, never a fabricated budget bar.
 *   • FMP - 250 requests/day per key (free tier)
 *   • Gemini - 200 requests/day per key (free-tier daily request cap)
 *   • Finnhub - no daily cap (60 calls/min per key) → show total + "60/min" note
 *   • Groq - per-model RPM/TPD, no single daily call cap → " - "
 *   • Alpaca - generous; show total only
 */
const PER_KEY_DAILY_CAP: Record<string, number | null> = {
  fmp: 250,
  gemini: 200,
  finnhub: null,
  groq: null,
  alpaca: null,
};

/** Honest sub-note for vendors with no daily-call budget bar. */
const NO_BUDGET_NOTE: Record<string, string> = {
  finnhub: "60 calls/min per key · no daily cap",
  groq: "per-model rate limits · no daily call cap",
  alpaca: "generous limits · daily total only",
};

/** How many keys back this vendor's pool - prefer the live /_status count, else
 *  the distinct keys actually seen in today's recorded usage (a floor). */
function poolKeyCount(vendor: string, keyPools: KeyPoolStatus | null, seen: number): number {
  const live = keyPools?.pools.find((p) => p.id === vendor)?.keys;
  return Math.max(live ?? 0, seen, 1);
}

/** Display order for the pooled board (keyed/budgeted vendors first). */
const POOLED_ORDER = ["finnhub", "fmp", "gemini", "groq", "alpaca", "yahoo", "sec", "stocktwits", "apewisdom"];

// ── Unified source model ────────────────────────────────────────────────────

/** A server-side key pool folded INTO a vendor card (lamps + rotation). */
interface PoolView {
  keys: number;
  /** Round-robin cursor - the next key to serve (server pools). */
  cursor?: number;
  perKey: KeyStat[];
  /** True when per-key tallies are best-effort server-side (vs device-true). */
  serverSide: boolean;
  /** Extra fact chips (e.g. the grounded model, "fallback armed"). */
  chips?: string[];
  /**
   * Per-KEY free-tier allowance, verbatim from the vendor's published limit
   * (e.g. "60 calls/min" for a Finnhub key). Shown in each key's detail panel as
   * "Limit · free tier" so a 0 reads against a real budget. `null` when the
   * vendor has no verifiable per-key cap - the panel then shows " - ", never a
   * fabricated number.
   */
  perKeyLimit: string | null;
  /**
   * This device's calls-today for the SAME vendor (the persistent localStorage
   * ledger). The per-key chips are SERVER counters that reset on the edge's cold
   * start, so when they read 0 but the device logged calls, the pool summary
   * shows this number to reconcile the two clocks instead of a bare, broken-
   * looking "0". `null` for a server-only lane with no device meter.
   */
  deviceToday: number | null;
}

/** One row on the board: a vendor's device usage + optional key pool. */
interface BoardSource {
  id: string;
  /** Brand kicker (e.g. "Finnhub"). */
  provider: string;
  /** Functional title (e.g. "Quotes & news"). */
  name: string;
  /** One-line "what this serves". */
  feeds: string;
  /** Device-metered usage, or null for a server-only lane (Groq research). */
  usage: VendorUsage | null;
  reach: VendorReach | null;
  pool: PoolView | null;
  keyed: boolean;
}

/** Cleaner functional names for the pooled vendors (avoids "Finnhub / Finnhub (main)"). */
const POOLED_TITLE: Partial<Record<ApiVendorId, string>> = {
  finnhub: "Quotes & news",
  fmp: "Fundamentals",
  proxy: "Research grounding",
};

/**
 * The per-KEY free-tier allowance for each pooled vendor - sourced from the
 * vendor's own published limit (the same numbers the card already prints), so
 * each key's "0" reads against a real budget. The proxy/Gemini pool shows the
 * Gemini free-tier daily request cap; Groq's free tier has no single verifiable
 * per-key daily call cap we can cite, so it stays `null` → the panel shows " - ".
 *   • Finnhub - 60 calls/min per key (free tier)
 *   • FMP - 250 calls/day per key (free tier)
 *   • Gemini - 200 requests/day per key (free-tier daily cap; matches the
 *               Research-proxy ceiling printed on the same card)
 */
const PER_KEY_LIMIT: Partial<Record<string, string>> = {
  finnhub: "60 calls/min · free tier",
  fmp: "250 calls/day · free tier",
  gemini: "200 calls/day · free tier",
};

/**
 * Build the de-duplicated board: one entry per source, in a stable display order,
 * with each pooled vendor's server-side key pool folded into its own card.
 */
function buildSources(snapshot: UsageSnapshot, keyPools: KeyPoolStatus | null): BoardSource[] {
  const byId = new Map(snapshot.vendors.map((v) => [v.meta.id, v]));
  const poolById = new Map((keyPools?.pools ?? []).map((p) => [p.id, p]));
  const out: BoardSource[] = [];

  const push = (id: ApiVendorId, pool: PoolView | null) => {
    const usage = byId.get(id);
    if (!usage) return;
    out.push({
      id,
      provider: usage.meta.provider,
      name: POOLED_TITLE[id] ?? usage.meta.name,
      feeds: usage.meta.feeds,
      usage,
      reach: vendorReach(id),
      pool,
      keyed: usage.meta.keyed,
    });
  };

  // 1) Pooled keyed vendors - usage gauge + key lamps in ONE card.
  const finnhubPool = poolById.get("finnhub");
  push(
    "finnhub",
    finnhubPool
      ? {
          keys: finnhubPool.keys,
          cursor: finnhubPool.cursor,
          perKey: finnhubPool.perKey,
          serverSide: true,
          perKeyLimit: PER_KEY_LIMIT.finnhub ?? null,
          deviceToday: byId.get("finnhub")?.today ?? 0,
        }
      : null,
  );

  const fmpPool = poolById.get("fmp");
  push(
    "fmp",
    fmpPool
      ? {
          keys: fmpPool.keys,
          cursor: fmpPool.cursor,
          perKey: fmpPool.perKey,
          serverSide: true,
          perKeyLimit: PER_KEY_LIMIT.fmp ?? null,
          deviceToday: byId.get("fmp")?.today ?? 0,
        }
      : null,
  );

  const geminiPool = poolById.get("gemini");
  push(
    "proxy",
    geminiPool
      ? {
          keys: geminiPool.keys,
          cursor: geminiPool.cursor,
          perKey: geminiPool.perKey,
          serverSide: true,
          chips: geminiPool.model ? [geminiPool.model] : undefined,
          perKeyLimit: PER_KEY_LIMIT.gemini ?? null,
          deviceToday: byId.get("proxy")?.today ?? 0,
        }
      : null,
  );

  // 2) Groq - its own card whenever Vision is keyed OR the research lane is armed.
  //    Vision reads are device-metered; the Research Desk's Bull/Bear/Judge debate +
  //    fallback rotate a server-side key POOL. When research-agent /_status reports
  //    that real pool we show its true key count + per-key rotation; otherwise we
  //    fall back to a 2-key estimate (pure direct mode with only a Vision key).
  const groqPool = poolById.get("groq");
  const researchFallbackReady = Boolean(geminiPool?.openaiFallback) || Boolean(groqPool && groqPool.keys > 0);
  const visionKeyed = hasVisionKey();
  if (visionKeyed || researchFallbackReady) {
    const visionUsage = byId.get("vision") ?? null;
    const visionCalls = visionUsage?.today ?? 0;
    const visionErrs = visionUsage?.errorsToday ?? 0;
    const perKey: KeyStat[] =
      groqPool?.perKey && groqPool.perKey.length > 0
        ? groqPool.perKey
        : [
            {
              calls: visionCalls,
              ok: Math.max(0, visionCalls - visionErrs),
              failovers: 0,
              lastStatus: visionErrs > 0 ? 429 : visionCalls > 0 ? 200 : null,
            },
            { calls: 0, ok: 0, failovers: 0, lastStatus: null },
          ];
    const chips: string[] = [];
    if (groqPool?.model) chips.push(groqPool.model);
    if (researchFallbackReady) chips.push("research fallback armed");
    out.push({
      id: "groq",
      provider: "Groq",
      name: "Debate & fallback",
      feeds: visionKeyed
        ? "Research Desk Bull/Bear/Judge debate + fast fallback · reads tickers from screenshots"
        : "Research Desk Bull/Bear/Judge debate + fast fallback when Gemini is rate-limited",
      usage: visionUsage,
      reach: null,
      pool: {
        keys: groqPool?.keys ?? 2,
        cursor: groqPool?.cursor,
        perKey,
        serverSide: !visionKeyed || Boolean(groqPool),
        chips: chips.length > 0 ? chips : undefined,
        // Groq's free tier has per-model RPM/TPD limits but no single verifiable
        // per-key daily CALL cap we can cite app-wide - keep it honest as " - ".
        perKeyLimit: null,
        // Vision reads are the only device-metered Groq calls; the debate/fallback
        // lane is server-side. Reconcile against the device vision tally when present.
        deviceToday: visionUsage?.today ?? null,
      },
      keyed: true,
    });
  }

  // 3) Single-key + public sources - plain cards, no lamps.
  for (const id of ["alpaca", "yahoo", "sec", "stocktwits", "apewisdom"] as ApiVendorId[]) {
    push(id, null);
  }

  return out;
}

// ── Card ────────────────────────────────────────────────────────────────────

/** Status tone for a single key stat. */
function keyTone(stat: KeyStat | undefined): "ok" | "err" | "idle" {
  if (!stat) return "idle";
  if (stat.lastStatus != null && stat.lastStatus >= 400) return "err";
  if (stat.calls > 0) return "ok";
  return "idle";
}

/** Colour class for an HTTP status code displayed in the detail panel. */
function statusClass(code: number | null): string {
  if (code == null) return "pool-key__stat-value--faint";
  if (code >= 500) return "pool-key__stat-value--err";
  if (code >= 400) return "pool-key__stat-value--warn";
  return "pool-key__stat-value--ok";
}

/**
 * Numbered, tappable key chips - each opens a detail panel showing per-key
 * stats. One chip is open at a time; tapping the active chip closes it.
 * Keyboard-accessible (button + aria-expanded). Mobile-first: tap works, hover
 * tooltip is a bonus on desktop.
 */
function KeyLamps({ pool, vendorId }: { pool: PoolView; vendorId: string }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const toggle = (i: number) => setOpenIdx((prev) => (prev === i ? null : i));

  // The active/next key can legitimately show 0 calls - it's next in line but not yet used - so
  // the total + the "next → Key N" marker anchor what each key's number means.
  const totalCalls = pool.perKey.reduce((a, k) => a + (k?.calls ?? 0), 0);
  const maxKeyCalls = pool.perKey.reduce((a, k) => Math.max(a, k?.calls ?? 0), 0);
  const nextKey = pool.cursor != null ? (pool.cursor % Math.max(pool.keys, 1)) + 1 : null;

  // The two clocks that used to collide here. The per-key chips are SERVER counters
  // that reset on the edge's cold start, so they read 0 right after a restart -
  // even though this device logged real calls (the persistent localStorage ledger
  // = `deviceToday`). When the server total is 0 but the device has calls, say so
  // plainly instead of a bare "0 calls" that looks broken. (This is the root of
  // the "pool says 10, each key says 0" confusion.)
  const serverReset = totalCalls === 0 && (pool.deviceToday ?? 0) > 0;

  return (
    <div className="vendor-card__keys" aria-label={`${pool.keys} keys in this pool`}>
      {/* Pool summary - server-side rotation total + which key is next. Honest
          about scope: these are the edge's counters, not this device's ledger. */}
      <div className="pool-key-summary">
        <span className="pool-key-summary__total mono">{totalCalls}</span>
        <span className="pool-key-summary__label">
          server-side {totalCalls === 1 ? "call" : "calls"} across {pool.keys}{" "}
          {pool.keys === 1 ? "key" : "keys"}
          {nextKey != null ? (
            <>
              {" "}
              · next → <span className="pool-key-summary__next mono">Key {nextKey}</span>
            </>
          ) : null}
        </span>
      </div>

      {/* Reconciliation line - only when the server counters are cold-reset but the
          device logged calls today. Resolves the "10 vs 0" contradiction inline. */}
      {serverReset && (
        <p className="pool-key-reconcile">
          Counters reset on the server's last restart — your device logged{" "}
          <span className="mono">{pool.deviceToday}</span> {pool.deviceToday === 1 ? "call" : "calls"}{" "}
          today (shown above). They climb again as new requests rotate through the keys.
        </p>
      )}
      {/* Chip row */}
      <div className="pool-key-row">
        {Array.from({ length: pool.keys }, (_, i) => {
          const stat = pool.perKey[i];
          const isNext = pool.cursor != null && i === pool.cursor % Math.max(pool.keys, 1);
          const tone = keyTone(stat);
          const expanded = openIdx === i;
          return (
            <button
              key={i}
              type="button"
              className={`pool-key pool-key--${tone}${isNext ? " is-next" : ""}${expanded ? " is-open" : ""}`}
              onClick={() => toggle(i)}
              aria-expanded={expanded}
              aria-controls={`pool-key-detail-${vendorId}-${i}`}
              style={
                {
                  "--key-share": maxKeyCalls > 0 ? String((stat?.calls ?? 0) / maxKeyCalls) : "0",
                } as React.CSSProperties
              }
              title={
                stat && stat.calls > 0
                  ? `Key ${i + 1}: ${stat.calls} calls · ${stat.ok} ok · ${stat.failovers} failovers${
                      stat.lastStatus != null ? ` · last ${stat.lastStatus}` : ""
                    }${isNext ? " · next in rotation" : ""}`
                  : `Key ${i + 1}: idle${isNext ? " · next in rotation" : ""}`
              }
            >
              <span className="pool-key__label">Key</span>
              <span className="pool-key__idx mono">{i + 1}</span>
              {stat && stat.calls > 0 ? (
                <span className="pool-key__n mono">{stat.calls}</span>
              ) : (
                // A bare blank chip read as "broken" - say "idle" so a 0 is
                // legible as "not its turn yet", not a missing number.
                <span className="pool-key__idle">{isNext ? "next" : "idle"}</span>
              )}
              {isNext && <span className="pool-key__next-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>

      {/* Detail panels - one per key, only the open one is visible */}
      {Array.from({ length: pool.keys }, (_, i) => {
        const stat = pool.perKey[i];
        const isNext = pool.cursor != null && i === pool.cursor % Math.max(pool.keys, 1);
        const expanded = openIdx === i;
        const tone = keyTone(stat);
        return (
          <div
            key={i}
            id={`pool-key-detail-${vendorId}-${i}`}
            className={`pool-key__detail pool-key__detail--${tone}${expanded ? " is-open" : ""}`}
            aria-hidden={!expanded}
          >
            <div className="pool-key__detail-head">
              <span className="pool-key__detail-title mono">Key {i + 1}</span>
              {totalCalls > 0 ? (
                <span className="pool-key__detail-share mono">
                  {Math.round(((stat?.calls ?? 0) / totalCalls) * 100)}% of pool
                </span>
              ) : (
                // No server calls yet (cold start / next in line) - say "idle",
                // never a misleading "0% of pool".
                <span className="pool-key__detail-share">idle</span>
              )}
              {isNext && <span className="pool-key__next-badge">next in rotation</span>}
            </div>
            <div className="pool-key__detail-stats">
              <div className="pool-key__stat">
                <span className="pool-key__stat-label">Calls</span>
                <span className="pool-key__stat-value mono">{stat?.calls ?? 0}</span>
              </div>
              <div className="pool-key__stat">
                <span className="pool-key__stat-label">OK</span>
                <span className="pool-key__stat-value mono pool-key__stat-value--ok">{stat?.ok ?? 0}</span>
              </div>
              <div className="pool-key__stat">
                <span className="pool-key__stat-label">Failovers</span>
                <span className={`pool-key__stat-value mono${(stat?.failovers ?? 0) > 0 ? " pool-key__stat-value--warn" : ""}`}>
                  {stat?.failovers ?? 0}
                </span>
              </div>
              <div className="pool-key__stat">
                <span className="pool-key__stat-label">Last status</span>
                <span className={`pool-key__stat-value mono ${statusClass(stat?.lastStatus ?? null)}`}>
                  {stat?.lastStatus != null ? stat.lastStatus : "—"}
                </span>
              </div>
            </div>
            {/* Per-key free-tier budget - the limit each individual key spends
                against. Sourced from the vendor's published allowance; " - " when
                there's no verifiable per-key cap (never fabricated). */}
            <div className="pool-key__budget">
              <span className="pool-key__budget-label">Per-key budget</span>
              <span className="pool-key__budget-value mono">{pool.perKeyLimit ?? "—"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourceCard({ source, inactive }: { source: BoardSource; inactive: boolean }) {
  const { usage, reach, pool, keyed } = source;
  const reachable = keyed ? (reach ? reach.reachable : true) : true;
  const ghost = keyed && !reachable && !pool;

  // Status pill.
  let statusLabel: string;
  let statusLevel: "ok" | "idle" | "elevated" | "critical";
  if (inactive) {
    statusLabel = "Inactive";
    statusLevel = "idle";
  } else if (!reachable && !pool) {
    statusLabel = source.id === "proxy" ? "No proxy" : noPathLabel(source.id as ApiVendorId);
    statusLevel = "idle";
  } else if (usage?.level === "critical") {
    statusLabel = usage.overBudget ? "Budget hit" : "At limit";
    statusLevel = "critical";
  } else if (usage?.level === "elevated") {
    statusLabel = "Running hot";
    statusLevel = "elevated";
  } else if (!usage && pool) {
    // Server-only lane (Groq research fallback): armed but no device meter.
    statusLabel = "Armed";
    statusLevel = "ok";
  } else if (keyed) {
    statusLabel = reach ? liveStatusLabel(reach.kind) : "Live";
    statusLevel = "ok";
  } else {
    statusLabel = usage && usage.level !== "idle" ? "Healthy" : "Idle";
    statusLevel = usage?.level === "idle" || !usage ? "idle" : "ok";
  }

  // Primary gauge: prefer calls-today / daily-budget (the readable style operators
  // asked for), else fall back to the window allowance. Server-only Groq shows
  // its pooled call total instead of a meter.
  const hasBudget = usage?.budget != null && usage.budget > 0;
  const meterMax = hasBudget ? (usage!.budget as number) : usage ? usage.meta.limit : 0;
  const meterVal = hasBudget ? (usage?.today ?? 0) : usage ? usage.windowUsed : 0;
  const pct = meterMax > 0 ? Math.round((meterVal / meterMax) * 100) : 0;
  const meterTone = usage?.level === "critical" ? "critical" : usage?.level === "elevated" ? "elevated" : "";

  const errorsToday = usage?.errorsToday ?? 0;
  const lastCall = usage?.lastCallAt != null ? relativeTime(new Date(usage.lastCallAt).toISOString()) : null;

  // Pool sub-line: active key + failover count (the "which key + last failover"
  // the operator needs), honest about server-side best-effort tallies.
  const activeKey = pool?.cursor != null ? (pool.cursor % Math.max(pool.keys, 1)) + 1 : null;
  const totalFailovers = pool ? pool.perKey.reduce((a, k) => a + (k?.failovers ?? 0), 0) : 0;

  return (
    <div className={`vendor-card${ghost ? " vendor-card--ghost" : ""}`}>
      <div className="vendor-card__head">
        <span className="vendor-card__provider">{source.provider}</span>
        <div className="vendor-card__headrow">
          <span className="vendor-card__name">{source.name}</span>
          <span className={`vendor-status vendor-status--${statusLevel}`}>
            <span className="vendor-status__dot" aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </div>

      {usage ? (
        <>
          <div className="vendor-card__nums">
            <span>
              <span className="vendor-card__big mono">{meterVal}</span>
              <span className="vendor-card__unit">
                / <span className="mono">{meterMax}</span>{" "}
                {hasBudget ? "budget" : WINDOW_LABEL[usage.meta.window]}
                {/* Scope the headline explicitly. This is the PERSISTENT device
                    ledger - distinct from the server-side pool total below, which
                    resets on the edge's cold start. Naming the scope is what kills
                    the "pool says 10, each key says 0" confusion. */}
                {(hasBudget || usage.meta.window === "day") && (
                  <span className="vendor-card__scope"> · this device today</span>
                )}
              </span>
            </span>
            {hasBudget && usage.meta.window !== "day" && (
              <span className="vendor-card__minor mono">
                {usage.windowUsed}/{usage.meta.limit} {WINDOW_LABEL[usage.meta.window]}
              </span>
            )}
          </div>
          <div
            className="quota-meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={meterMax}
            aria-valuenow={Math.min(meterVal, meterMax)}
            aria-label={`${source.name}: ${meterVal} of ${meterMax} ${hasBudget ? "daily budget" : WINDOW_LABEL[usage.meta.window]}`}
          >
            <span
              className={`quota-meter__fill${meterTone ? ` quota-meter__fill--${meterTone}` : ""}`}
              style={{ width: `${Math.max(pct, meterVal > 0 ? 2 : 0)}%` }}
            />
          </div>
        </>
      ) : (
        pool && (
          <div className="vendor-card__nums">
            <span>
              <span className="vendor-card__big mono">{pool.perKey.reduce((a, k) => a + k.calls, 0)}</span>
              <span className="vendor-card__unit">calls · server-rotated</span>
            </span>
          </div>
        )
      )}

      {pool && (
        <>
          <KeyLamps pool={pool} vendorId={source.id} />
          <div className="vendor-card__keyline">
            <span className="mono">{pool.keys} keys</span>
            {activeKey != null && <span>· key {activeKey} next</span>}
            {totalFailovers > 0 && <span>· {totalFailovers} failovers</span>}
            {pool.serverSide && <span className="text-faint">· server-side</span>}
          </div>
        </>
      )}

      <p className="vendor-card__feeds">{source.feeds}</p>

      {((pool?.chips && pool.chips.length > 0) || errorsToday > 0 || lastCall) && (
        <div className="vendor-card__meta">
          <div className="vendor-card__tags">
            {pool?.chips?.map((c) => (
              <span key={c} className="vendor-tag">
                {c}
              </span>
            ))}
            {errorsToday > 0 && (
              <span className="vendor-tag vendor-tag--err">
                <span className="mono">{errorsToday}</span> failed
              </span>
            )}
            {lastCall && <span className="vendor-tag vendor-tag--faint">{lastCall}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pooled (cross-user) board ───────────────────────────────────────────────

/** One pooled vendor card: total calls today across ALL users + keys, vs the
 *  pooled daily budget (keys × per-key cap) when a real cap exists. */
function PooledVendorCard({ vendor, keyPools }: { vendor: ApiUsageVendor; keyPools: KeyPoolStatus | null }) {
  const id = vendor.vendor;
  const label = VENDOR_LABEL[id] ?? id;
  const feeds = VENDOR_FEEDS[id] ?? "";
  const keys = poolKeyCount(id, keyPools, vendor.keysSeen);
  const perKeyCap = id in PER_KEY_DAILY_CAP ? PER_KEY_DAILY_CAP[id] : null;
  const poolBudget = perKeyCap != null ? perKeyCap * keys : null;

  const pct = poolBudget && poolBudget > 0 ? Math.min(100, Math.round((vendor.calls / poolBudget) * 100)) : 0;
  const tone = pct >= 90 ? "critical" : pct >= 70 ? "elevated" : "";
  const note = poolBudget == null ? NO_BUDGET_NOTE[id] ?? "no published daily call cap" : null;
  const lastUsed = vendor.lastUsed ? relativeTime(vendor.lastUsed) : null;

  // Per-key share is relative to the busiest key, so the bars read like a load
  // balance (which key is carrying the pool today).
  const maxKeyCalls = vendor.perKey.reduce((a, k) => Math.max(a, k.calls), 0);

  return (
    <div className="pooled-card">
      <div className="pooled-card__head">
        <span className="pooled-card__provider">{label}</span>
        <span className="pooled-card__keys mono">
          {keys} {keys === 1 ? "key" : "keys"}
        </span>
      </div>

      <div className="pooled-card__nums">
        <span className="pooled-card__big mono">{formatNumber(vendor.calls, 0)}</span>
        <span className="pooled-card__unit">
          {poolBudget != null ? (
            <>
              / <span className="mono">{formatNumber(poolBudget, 0)}</span> pooled budget
            </>
          ) : (
            <>calls today · all users</>
          )}
        </span>
      </div>

      {poolBudget != null ? (
        <>
          <div
            className="quota-meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={poolBudget}
            aria-valuenow={Math.min(vendor.calls, poolBudget)}
            aria-label={`${label}: ${vendor.calls} of ${poolBudget} pooled daily budget`}
          >
            <span
              className={`quota-meter__fill${tone ? ` quota-meter__fill--${tone}` : ""}`}
              style={{ width: `${Math.max(pct, vendor.calls > 0 ? 2 : 0)}%` }}
            />
          </div>
          <div className="pooled-card__budgetline">
            <span className="mono">{pct}%</span> of {keys} × {perKeyCap}/day across the pool
          </div>
        </>
      ) : (
        note && <div className="pooled-card__budgetline pooled-card__budgetline--nocap">{note}</div>
      )}

      {vendor.perKey.length > 0 && (
        <div className="pooled-card__keys-grid" aria-label={`Per-key calls for ${label}`}>
          {vendor.perKey.map((k) => {
            const share = maxKeyCalls > 0 ? k.calls / maxKeyCalls : 0;
            return (
              <div className="pooled-key" key={k.keyLabel} title={`${k.keyLabel}: ${k.calls} calls${k.failures > 0 ? ` · ${k.failures} failed` : ""}`}>
                <span className="pooled-key__label mono">{k.keyLabel.replace("key_", "K")}</span>
                <span className="pooled-key__bar" aria-hidden="true">
                  <span className="pooled-key__bar-fill" style={{ width: `${Math.max(share * 100, k.calls > 0 ? 4 : 0)}%` }} />
                </span>
                <span className="pooled-key__n mono">{formatNumber(k.calls, 0)}</span>
              </div>
            );
          })}
        </div>
      )}

      {feeds && <p className="pooled-card__feeds">{feeds}</p>}

      {(vendor.failures > 0 || lastUsed) && (
        <div className="pooled-card__meta">
          {vendor.failures > 0 && (
            <span className="vendor-tag vendor-tag--err">
              <span className="mono">{formatNumber(vendor.failures, 0)}</span> failed
            </span>
          )}
          {lastUsed && <span className="vendor-tag vendor-tag--faint">last {lastUsed}</span>}
        </div>
      )}
    </div>
  );
}

/** The PRIMARY board: persistent, cross-user pooled usage vs each vendor's limit. */
function PooledUsageBoard({
  usage,
  loaded,
  keyPools,
  deviceToday,
}: {
  usage: ApiUsageToday | null;
  loaded: boolean;
  keyPools: KeyPoolStatus | null;
  deviceToday: number;
}) {
  const vendors = usage
    ? [...usage.vendors].sort((a, b) => {
        const ai = POOLED_ORDER.indexOf(a.vendor);
        const bi = POOLED_ORDER.indexOf(b.vendor);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      })
    : [];
  const hasData = vendors.length > 0;

  return (
    <section className="ops-board pooled-board" aria-label="Pooled API usage across all users today">
      <div className="ops-board__head">
        <div>
          <div className="ops-board__title">Pooled usage today · everybody</div>
          <p className="ops-board__sub">
            The TRUE total usage of the shared keys across every device using the app, vs each
            vendor's pooled daily limit. Resets with the U.S. market day (Eastern).
          </p>
        </div>
        {hasData && (
          <span className="quality-chip quality-chip--full" title="Total recorded calls across all users today">
            <span className="quality-chip__dot" aria-hidden="true" />
            Pooled
            <span className="text-faint mono" style={{ fontWeight: 500 }}>
              · {formatNumber(usage!.totalCalls, 0)} calls today
            </span>
          </span>
        )}
      </div>

      {!loaded ? (
        <div className="pooled-skeleton" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="pooled-skeleton__card" key={i} />
          ))}
        </div>
      ) : hasData ? (
        <div className="pooled-grid">
          {vendors.map((v) => (
            <PooledVendorCard key={v.vendor} vendor={v} keyPools={keyPools} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <h3>No pooled usage recorded yet</h3>
          <p>
            {usage === null
              ? "Cross-user tracking isn't reachable yet — it starts recording once the server migration is applied and the market proxy is redeployed."
              : "No shared-key calls have been recorded across users today. Totals appear here as the app makes live requests through the proxy."}
          </p>
        </div>
      )}

      <div className="pooled-board__foot">
        This device contributed <span className="mono">{formatNumber(deviceToday, 0)}</span> of today's
        calls. Budgets shown only where a vendor publishes a real daily cap (FMP 250/day, Gemini
        200/day, per key); Finnhub is per-minute, Groq/Alpaca have no single daily call cap.
      </div>
    </section>
  );
}

interface ApiQuotaBoardProps {
  /** Board headline - defaults to the Research framing. */
  title?: string;
}

export function ApiQuotaBoard({ title = "This device · live key rotation" }: ApiQuotaBoardProps) {
  const snapshot = useApiUsage();
  const keyPools = useKeyPools();
  const { usage: pooledUsage, loaded: pooledLoaded } = useApiUsageToday();
  const peak = Math.max(1, ...snapshot.pulse);
  const inactive = snapshot.controls.paused || isSampleDataModeEnabled();
  const displayedQuality = inactive ? "paused" : snapshot.quality;
  const quality = QUALITY_COPY[displayedQuality];
  const sources = buildSources(snapshot, keyPools);
  const anyPooled = sources.some((s) => s.pool != null);

  return (
    <>
      {/* PRIMARY: persistent, cross-user pooled usage vs each vendor's daily limit. */}
      <PooledUsageBoard
        usage={pooledUsage}
        loaded={pooledLoaded}
        keyPools={keyPools}
        deviceToday={snapshot.totalToday}
      />

      {/* SECONDARY: this device's own ledger + live server-side key rotation lamps. */}
      <section className="ops-board" aria-label="This device's API usage and remaining quota">
        <div className="ops-board__head">
          <div>
            <div className="ops-board__title">{title}</div>
            <p className="ops-board__sub">
              This device's own calls vs budget, plus the server-side key rotation lamps. The
              pooled total above is the cross-user number; this is just this browser.
              {snapshot.clearedAt && snapshot.clearedBy
                ? ` Ledger last cleared by ${snapshot.clearedBy} ${relativeTime(snapshot.clearedAt)}.`
                : ""}
            </p>
          </div>
          <span className={`quality-chip quality-chip--${displayedQuality}`} title={quality.detail}>
            <span className="quality-chip__dot" aria-hidden="true" />
            {quality.label}
            <span className="text-faint mono" style={{ fontWeight: 500 }}>
              · {snapshot.totalToday} this device
            </span>
          </span>
        </div>

      {!snapshot.hasHistory && (
        <div className="empty" style={{ marginBottom: "var(--sp-4)" }}>
          <h3>No API calls recorded yet</h3>
          <p>
            {snapshot.clearedAt
              ? "The operator cleared this device's usage ledger. Toggles and key changes do not clear it."
              : "This device hasn't spent any quota yet. Run the research engine and watch each source light up in real time."}
          </p>
        </div>
      )}

      <div className="vendor-grid">
        {sources.map((s) => (
          <SourceCard key={s.id} source={s} inactive={inactive} />
        ))}
      </div>

      <div
        className="pulse-strip"
        role="img"
        aria-label={`${snapshot.pulse.reduce((a, b) => a + b, 0)} API calls in the last 10 minutes`}
      >
        {snapshot.pulse.map((count, i) => (
          <div className="pulse-strip__bar" key={i} title={`${count} calls`} aria-hidden="true">
            <div
              className={`pulse-strip__fill ${count === 0 ? "is-zero" : ""}`}
              style={{ height: `${Math.max(5, Math.round((count / peak) * 100))}%` }}
            />
          </div>
        ))}
      </div>
      <div className="pulse-strip__caption">
        Calls per minute · trailing 10 minutes · tracked on this device only
        {anyPooled && (
          <>
            {" · "}A card's headline is this device's persistent tally; the per-key chips are the
            server's own counters (exact key count &amp; active key, but the call tallies reset on
            the edge's cold start — so a freshly-restarted key reads 0)
          </>
        )}
      </div>
      </section>
    </>
  );
}
