import { marketProxyUrl } from "@/data/marketProxy";

/**
 * Read-only fetch of the server-side KEY POOL status from the edge functions'
 * `/_status` routes (market-proxy: Finnhub + FMP pools; research-agent: the Gemini
 * pool). This is what makes "is the round-robin key rotation actually working?"
 * visibly answerable on-device - replacing the old "per-key counts aren't visible
 * from this device" copy with the real pool size + rotation cursor (+ per-key
 * counters where the isolate exposes them).
 *
 * NO secrets cross the wire - the endpoints return only key COUNTS + per-key
 * call/ok/failover counters. The counters are per-edge-isolate and reset on a cold
 * start, so the KEY COUNT + cursor are the load-bearing, always-accurate facts; the
 * per-key tallies are a best-effort "this isolate, since cold start" read.
 *
 * Pure-ish: one GET per configured proxy; tolerant (returns null / partial on any
 * failure), never throws.
 */

export interface KeyStat {
  calls: number;
  ok: number;
  failovers: number;
  lastStatus: number | null;
}

export interface PoolStatus {
  id: "finnhub" | "fmp" | "gemini" | "groq";
  label: string;
  /** Number of active keys in the round-robin pool. */
  keys: number;
  /** Current round-robin cursor (next key index). */
  cursor: number;
  /** Gemini-only: the grounded model in use. */
  model?: string;
  /** Gemini-only: whether the Groq/OpenAI-compatible fallback is configured. */
  openaiFallback?: boolean;
  /** Per-key counters (this isolate, since its cold start). */
  perKey: KeyStat[];
}

export interface KeyPoolStatus {
  pools: PoolStatus[];
  note: string;
  /** True when at least one proxy answered. */
  ok: boolean;
  fetchedAtISO: string;
}

function env(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[name]?.trim() || undefined;
}

async function getJson(url: string, timeoutMs = 6000): Promise<Record<string, unknown> | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const trimTrailing = (u: string) => u.replace(/\/+$/, "");

/**
 * Fetch the configured proxies' key-pool status. Returns null in pure DIRECT mode
 * (no market/research proxy configured) - there is no server-side pool to show.
 */
export async function fetchProxyKeyPools(): Promise<KeyPoolStatus | null> {
  const market = marketProxyUrl();
  const research = env("VITE_RESEARCH_PROXY_URL");
  if (!market && !research) return null;

  const pools: PoolStatus[] = [];
  let note = "in-memory counters; per edge isolate, reset on cold start";
  let ok = false;

  if (market) {
    const s = await getJson(`${trimTrailing(market)}/_status`);
    const vendors = s?.vendors as Record<string, { keys?: number; cursor?: number; perKey?: KeyStat[] }> | undefined;
    if (vendors) {
      ok = true;
      if (typeof s?.note === "string") note = s.note;
      for (const [id, label] of [
        ["finnhub", "Finnhub"],
        ["fmp", "FMP"],
      ] as const) {
        const v = vendors[id];
        if (v && typeof v.keys === "number") {
          pools.push({ id, label, keys: v.keys, cursor: v.cursor ?? 0, perKey: v.perKey ?? [] });
        }
      }
    }
  }

  if (research) {
    const s = await getJson(`${trimTrailing(research)}/_status`);
    const g = s?.gemini as
      | { keys?: number; cursor?: number; model?: string; openaiFallback?: boolean; perKey?: KeyStat[] }
      | undefined;
    if (g && typeof g.keys === "number") {
      ok = true;
      if (typeof s?.note === "string") note = s.note;
      pools.push({
        id: "gemini",
        label: "Gemini · Research",
        keys: g.keys,
        cursor: g.cursor ?? 0,
        model: g.model,
        openaiFallback: g.openaiFallback,
        perKey: g.perKey ?? [],
      });
    }
    // The Groq pool powers the Research Desk's Bull/Bear/Judge debate + the
    // OpenAI-compatible fallback. Surface it so its round-robin is visible too.
    const gq = s?.groq as
      | { keys?: number; cursor?: number; model?: string; perKey?: KeyStat[] }
      | undefined;
    if (gq && typeof gq.keys === "number" && gq.keys > 0) {
      ok = true;
      pools.push({
        id: "groq",
        label: "Groq · Debate",
        keys: gq.keys,
        cursor: gq.cursor ?? 0,
        model: gq.model,
        perKey: gq.perKey ?? [],
      });
    }
  }

  return { pools, note, ok, fetchedAtISO: new Date().toISOString() };
}
