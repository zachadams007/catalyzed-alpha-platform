import { supabase } from "@/data/supabase/client";

/**
 * Persistent, CROSS-USER API-usage today - the TRUE pooled usage of the shared
 * free-tier keys across EVERYONE using the app, read from the server (migration
 * 0020_api_usage_daily.sql) via the `get_api_usage_today()` RPC.
 *
 * The market-proxy / research-agent edge functions fire-and-forget a counter bump
 * after every vendor request, keyed by a STABLE secret-free label (`key_1`..`key_N`)
 * derived from the key index they used. This module reads those counters and folds
 * them into per-vendor aggregates the Operator board renders against each vendor's
 * pooled daily limit.
 *
 * This is the answer to "how close are we to the limits each day, for EVERYBODY" -
 * distinct from the per-DEVICE localStorage ledger (which only counts this browser).
 *
 * Pure-ish + tolerant: returns null when Supabase is unconfigured or the RPC is not
 * deployed yet (the table starts empty until the proxy is redeployed), never throws.
 */

/** One server row: a single key's calls+failures today. */
export interface ApiUsageRow {
  vendor: string;
  keyLabel: string;
  calls: number;
  failures: number;
  /** ISO timestamp of the last recorded call for this key. */
  lastUsed: string | null;
}

/** A per-key breakdown line inside a vendor aggregate. */
export interface ApiUsageKey {
  keyLabel: string;
  calls: number;
  failures: number;
  lastUsed: string | null;
}

/** A vendor's cross-user usage today, with its pooled daily budget when one is real. */
export interface ApiUsageVendor {
  vendor: string;
  /** Total calls today across ALL users + ALL keys. */
  calls: number;
  failures: number;
  /** Distinct key labels seen today (a floor on the pool size). */
  keysSeen: number;
  perKey: ApiUsageKey[];
  lastUsed: string | null;
}

export interface ApiUsageToday {
  vendors: ApiUsageVendor[];
  /** Grand total of all recorded calls today (all vendors, all users, all keys). */
  totalCalls: number;
  fetchedAtISO: string;
}

interface RpcRow {
  vendor: string | null;
  key_label: string | null;
  calls: number | string | null;
  failures: number | string | null;
  last_used: string | null;
}

const toInt = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(n) ? Number(n) : 0;
};

const newerIso = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

/**
 * Fetch today's persistent cross-user usage. Returns null when Supabase is not
 * configured, the RPC errors (e.g. migration not applied yet), or anything throws.
 */
export async function fetchApiUsageToday(): Promise<ApiUsageToday | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.rpc("get_api_usage_today");
    if (error || !Array.isArray(data)) return null;

    const byVendor = new Map<string, ApiUsageVendor>();
    let totalCalls = 0;

    for (const raw of data as RpcRow[]) {
      const vendor = typeof raw.vendor === "string" ? raw.vendor.trim() : "";
      const keyLabel = typeof raw.key_label === "string" ? raw.key_label.trim() : "";
      if (!vendor || !keyLabel) continue;
      const calls = toInt(raw.calls);
      const failures = toInt(raw.failures);
      const lastUsed = raw.last_used ?? null;
      totalCalls += calls;

      let agg = byVendor.get(vendor);
      if (!agg) {
        agg = { vendor, calls: 0, failures: 0, keysSeen: 0, perKey: [], lastUsed: null };
        byVendor.set(vendor, agg);
      }
      agg.calls += calls;
      agg.failures += failures;
      agg.perKey.push({ keyLabel, calls, failures, lastUsed });
      agg.lastUsed = newerIso(agg.lastUsed, lastUsed);
    }

    // Stable per-key order (key_1, key_2, …) and a keysSeen count per vendor.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const vendors = [...byVendor.values()].map((v) => {
      v.perKey.sort((a, b) => collator.compare(a.keyLabel, b.keyLabel));
      v.keysSeen = v.perKey.length;
      return v;
    });
    vendors.sort((a, b) => b.calls - a.calls);

    return { vendors, totalCalls, fetchedAtISO: new Date().toISOString() };
  } catch {
    return null;
  }
}
