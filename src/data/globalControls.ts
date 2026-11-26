/**
 * GLOBAL operator controls - the server-side source of truth that governs the
 * ENTIRE app for ALL users.
 *
 * Sample-data mode, the live-data pause, budget enforcement, and per-vendor
 * budgets used to live in localStorage (device-local), so a signed-out browser
 * could ignore the operator and still pull real data. This module replaces that
 * with a single Supabase row (`public.app_controls`) that EVERY client - signed
 * in or anonymous - reads on boot and subscribes to. The operator account is the
 * only writer (via the `set_app_controls` RPC, enforced server-side).
 *
 * The control consumers (`sampleDataMode.ts`, `apiUsage.ts`) are SYNCHRONOUS, so
 * this module keeps a synchronous in-memory cache that the async loader/realtime
 * subscription keeps fresh. When Supabase is unconfigured (dev with no keys) the
 * cache stays null and callers fall back to their local defaults.
 */

import { isAdminEmail } from "@/lib/admin";
import { supabase, isSupabaseConfigured } from "@/data/supabase/client";
import { useAuthStore } from "@/store/useAuthStore";
import type { ApiVendorId } from "@/lib/apiUsage";
import type { EngineVariantId } from "@/engine/challenger";

/** The globally-active engine variant when the row is missing/invalid. */
const DEFAULT_ACTIVE_VARIANT: EngineVariantId = "challenger";

function sanitizeVariant(value: unknown): EngineVariantId {
  if (value === "champion" || value === "challenger" || value === "v6" || value === "v7") return value;
  return DEFAULT_ACTIVE_VARIANT;
}

export interface GlobalControls {
  sampleMode: boolean;
  livePaused: boolean;
  enforceBudgets: boolean;
  budgets: Partial<Record<ApiVendorId, number>>;
  /** The model EVERY client runs as - the operator's promoted variant, app-wide. */
  activeVariant: EngineVariantId;
  /**
   * Score-spread dial (0..1). How much the displayed 0-100 score is spread by
   * percentile rank vs absolute quality. Maps to DISPLAY_DECOMPRESS_WEIGHT.
   * Default: 0.3.
   */
  scoreSpreadWeight: number;
  /**
   * Quality-cap strength (≥ 0). How hard a risky/low-conviction stock's score
   * is capped below the top. Maps to QUALITY_CEILING_RISK_W. Default: 1.4.
   */
  qualityCapStrength: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Default score-spread weight - mirrors DISPLAY_DECOMPRESS_WEIGHT in normalizeUniverse.ts. */
export const DEFAULT_SCORE_SPREAD_WEIGHT = 0.3;
/** Default quality-cap strength - mirrors QUALITY_CEILING_RISK_W in normalizeUniverse.ts. */
export const DEFAULT_QUALITY_CAP_STRENGTH = 1.4;

function sanitizeWeight(value: unknown, def: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** The raw row shape returned by Supabase / the set_app_controls RPC. */
interface AppControlsRow {
  sample_mode: boolean;
  live_paused: boolean;
  enforce_budgets: boolean;
  budgets: unknown;
  active_variant: unknown;
  score_spread_weight: unknown;
  quality_cap_strength: unknown;
  updated_by: string | null;
  updated_at: string | null;
}

const POLL_INTERVAL_MS = 60_000;

let cache: GlobalControls | null = null;
let loaded = false;
let loadPromise: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let realtimeBound = false;

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to global-control changes (UI + provider re-eval). Returns unsubscribe. */
export function subscribeGlobalControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sanitizeBudgets(value: unknown): Partial<Record<ApiVendorId, number>> {
  if (!value || typeof value !== "object") return {};
  const out: Partial<Record<ApiVendorId, number>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) out[k as ApiVendorId] = Math.floor(n);
  }
  return out;
}

function fromRow(row: AppControlsRow): GlobalControls {
  const sampleMode = Boolean(row.sample_mode);
  return {
    sampleMode,
    // Sample mode forces live OFF, mirroring the server + client invariant.
    livePaused: sampleMode ? true : Boolean(row.live_paused),
    enforceBudgets: Boolean(row.enforce_budgets),
    budgets: sanitizeBudgets(row.budgets),
    activeVariant: sanitizeVariant(row.active_variant),
    scoreSpreadWeight: sanitizeWeight(row.score_spread_weight, DEFAULT_SCORE_SPREAD_WEIGHT),
    qualityCapStrength: sanitizeWeight(row.quality_cap_strength, DEFAULT_QUALITY_CAP_STRENGTH),
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/**
 * The synchronous snapshot consumers read. Returns null until the first load
 * resolves OR when Supabase is unconfigured - callers MUST treat null as "no
 * global control, use the local fallback".
 */
export function getGlobalControls(): GlobalControls | null {
  return cache;
}

/** Whether a global control source exists (Supabase configured).
 *
 * Trusted server jobs (the daily scan) set `globalThis.__CATALYZED_TRUSTED_SCAN__`
 * in their bootstrap: they carry their own explicit safety seeds (sample OFF,
 * budgets OFF) and never run the browser's `initGlobalControls()` boot, so the
 * browser-only "configured but not yet loaded → fail closed to sample" guard would
 * wrongly disable their real keys. In that context global controls are treated as
 * not-configured so the scan honors its bootstrap seeds. The browser is unaffected
 * (the flag is undefined there). */
export function isGlobalControlsConfigured(): boolean {
  if ((globalThis as { __CATALYZED_TRUSTED_SCAN__?: boolean }).__CATALYZED_TRUSTED_SCAN__) {
    return false;
  }
  return isSupabaseConfigured;
}

/** Whether the first load has completed (success OR confirmed-unconfigured). */
export function areGlobalControlsLoaded(): boolean {
  return loaded;
}

/**
 * The operator's GLOBAL intent is NOT yet known on this client: a global source
 * is configured, but no `app_controls` row is in the cache (the first fetch is
 * still in flight, or it failed and never seeded the cache). Consumers must treat
 * this as a "loading / data-unavailable" state and fail closed - render a skeleton
 * and NEVER fabricate data - instead of guessing the operator's sample/live
 * choice. Returns false on an unconfigured (dev) build, where the device-local
 * fallback is authoritative.
 */
export function isGlobalControlsPending(): boolean {
  return isSupabaseConfigured && cache === null;
}

async function fetchOnce(): Promise<void> {
  if (!supabase) {
    loaded = true;
    return;
  }
  const { data, error } = await supabase
    .from("app_controls")
    .select(
      "sample_mode, live_paused, enforce_budgets, budgets, active_variant, score_spread_weight, quality_cap_strength, updated_by, updated_at",
    )
    .eq("id", true)
    .maybeSingle();
  loaded = true;
  if (error || !data) {
    // Leave the previous cache in place on a transient error; only seed null on
    // the very first failure (caller then falls back to local defaults).
    return;
  }
  const next = fromRow(data as AppControlsRow);
  cache = next;
  notify();
}

function bindRealtime(): void {
  if (realtimeBound || !supabase) return;
  realtimeBound = true;
  try {
    supabase
      .channel("app_controls")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_controls" },
        (payload) => {
          const row = payload.new as AppControlsRow | undefined;
          if (row && typeof row.sample_mode === "boolean") {
            cache = fromRow(row);
            notify();
          } else {
            void fetchOnce();
          }
        },
      )
      .subscribe();
  } catch {
    /* realtime unavailable - the poll below keeps us fresh */
  }
}

function startPolling(): void {
  if (pollTimer || typeof window === "undefined" || !supabase) return;
  pollTimer = setInterval(() => {
    void fetchOnce();
  }, POLL_INTERVAL_MS);
}

/**
 * Load the global controls once and keep them fresh (realtime + poll fallback).
 * Idempotent - call from app boot before selecting a provider. Resolves once the
 * first fetch settles so the boot path can fail closed on the global value.
 */
export function initGlobalControls(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = fetchOnce().then(() => {
    bindRealtime();
    startPolling();
  });
  return loadPromise;
}

/** Force a re-fetch (used right after an operator write to confirm the row). */
export async function refreshGlobalControls(): Promise<void> {
  await fetchOnce();
}

/**
 * The LIVE score-spread weight the scoring engine should use.
 * Returns the operator's global setting when Supabase is configured and the row
 * has loaded; otherwise falls back to the code-level default so the engine is
 * never blocked on a network round-trip.
 *
 * Intent: the lead engineer wires `normalizeUniverse` to call this instead of
 * reading the module-level `DISPLAY_DECOMPRESS_WEIGHT` constant directly.
 */
export function getScoreSpreadWeight(): number {
  return cache?.scoreSpreadWeight ?? DEFAULT_SCORE_SPREAD_WEIGHT;
}

/**
 * The LIVE quality-cap strength the scoring engine should use.
 * Same fall-back pattern as {@link getScoreSpreadWeight}.
 *
 * Intent: the lead engineer wires `computeNormalizedScores` to call this
 * instead of reading `QUALITY_CEILING_RISK_W` directly.
 */
export function getQualityCapStrength(): number {
  return cache?.qualityCapStrength ?? DEFAULT_QUALITY_CAP_STRENGTH;
}

function authorizedOperator(): { email: string; userId: string } | null {
  const auth = useAuthStore.getState();
  const email = auth.email?.trim().toLowerCase();
  if (!auth.ready || !auth.userId || !email || !isAdminEmail(email)) return null;
  return { email, userId: auth.userId };
}

export interface GlobalControlsPatch {
  sampleMode?: boolean;
  livePaused?: boolean;
  enforceBudgets?: boolean;
  budgets?: Partial<Record<ApiVendorId, number>>;
  /** Operator promotion: set the model that goes live for EVERY client. */
  activeVariant?: EngineVariantId;
  /** Score-spread dial 0..1 (see GlobalControls.scoreSpreadWeight). */
  scoreSpreadWeight?: number;
  /** Quality-cap strength >= 0 (see GlobalControls.qualityCapStrength). */
  qualityCapStrength?: number;
}

/**
 * Operator write. Calls the server-side `set_app_controls` RPC (operator-only,
 * enforced by the allowlist + JWT email), then echoes the authoritative row into
 * the local cache. Returns false when the caller isn't the operator, Supabase is
 * unconfigured, or the RPC rejected the write (so the UI can surface it).
 *
 * Optimistic echo: we apply the patch to the cache immediately so the operator's
 * own UI feels instant, then reconcile with the row the RPC returns.
 */
export async function saveGlobalControls(patch: GlobalControlsPatch): Promise<boolean> {
  const operator = authorizedOperator();
  if (!operator || !supabase) return false;

  // Optimistic local echo.
  if (cache) {
    const sampleMode = patch.sampleMode ?? cache.sampleMode;
    cache = {
      ...cache,
      ...patch,
      sampleMode,
      livePaused: sampleMode ? true : (patch.livePaused ?? cache.livePaused),
      activeVariant: patch.activeVariant ?? cache.activeVariant,
      scoreSpreadWeight: patch.scoreSpreadWeight ?? cache.scoreSpreadWeight,
      qualityCapStrength: patch.qualityCapStrength ?? cache.qualityCapStrength,
      updatedBy: operator.email,
      updatedAt: new Date().toISOString(),
    };
    notify();
  }

  const { data, error } = await supabase.rpc("set_app_controls", {
    p_sample_mode: patch.sampleMode ?? null,
    p_live_paused: patch.livePaused ?? null,
    p_enforce_budgets: patch.enforceBudgets ?? null,
    p_budgets: patch.budgets ?? null,
    p_active_variant: patch.activeVariant ?? null,
    p_score_spread_weight: patch.scoreSpreadWeight ?? null,
    p_quality_cap_strength: patch.qualityCapStrength ?? null,
  });

  if (error || !data) {
    // Reconcile with the truth on failure so the optimistic echo can't stick.
    await fetchOnce();
    return false;
  }
  cache = fromRow(data as AppControlsRow);
  notify();
  return true;
}
