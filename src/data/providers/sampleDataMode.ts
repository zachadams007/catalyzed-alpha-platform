import { isAdminEmail } from "@/lib/admin";
import { useAuthStore } from "@/store/useAuthStore";
import {
  getGlobalControls,
  isGlobalControlsConfigured,
  isGlobalControlsPending,
} from "@/data/globalControls";

export const SAMPLE_DATA_MODE_STORAGE_KEY = "catalyzed-dev-offline";
const SAMPLE_DATA_SAFETY_VERSION = 2;

export interface SampleDataModeState {
  safetyVersion: number;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

// Node/SSR + vitest fall back to this (sample ON) - there is no browser to
// reach a live source from, and the test suite relies on this default.
const SAFE_DEFAULT_STATE: SampleDataModeState = {
  safetyVersion: SAMPLE_DATA_SAFETY_VERSION,
  enabled: true,
  updatedBy: null,
  updatedAt: null,
};

/**
 * Default sample-mode for a fresh browser with no stored choice.
 *
 * Testers must get REAL data on first open without touching the Operator
 * Console, so the default is LIVE (sample OFF) whenever a real data source is
 * reachable - the hosted market proxy (`VITE_MARKET_PROXY_URL`, the web/phone
 * path) or a local vendor key (desktop/dev). When nothing is reachable we fall
 * back to sample ON so the app still shows content instead of an unconfigured
 * gate. An explicit `VITE_SAMPLE_DATA_MODE=on|off` build flag always wins.
 */
function defaultSampleEnabled(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  const override = env.VITE_SAMPLE_DATA_MODE?.trim().toLowerCase();
  if (override === "on" || override === "true" || override === "1") return true;
  if (override === "off" || override === "false" || override === "0") return false;
  const reachable = Boolean(
    env.VITE_MARKET_PROXY_URL?.trim() ||
      env.VITE_FINNHUB_API_KEY?.trim() ||
      env.VITE_FMP_API_KEY?.trim(),
  );
  return !reachable;
}

function browserDefaultState(): SampleDataModeState {
  return { ...SAFE_DEFAULT_STATE, enabled: defaultSampleEnabled() };
}

function loadSampleDataModeState(): SampleDataModeState {
  if (typeof window === "undefined") {
    return { ...SAFE_DEFAULT_STATE };
  }
  try {
    const raw = window.localStorage.getItem(SAMPLE_DATA_MODE_STORAGE_KEY);
    if (!raw) return browserDefaultState();

    // Legacy browser and Tauri storage were separate. Migrate both contexts to
    // the env-driven default once; a deliberate live/sample choice is re-made
    // through the Operator Console (safetyVersion gates stale explicit opt-ins).
    if (raw === "true" || raw === "false") {
      return browserDefaultState();
    }

    const parsed = JSON.parse(raw) as Partial<SampleDataModeState>;
    if (parsed.safetyVersion !== SAMPLE_DATA_SAFETY_VERSION) {
      return browserDefaultState();
    }
    return {
      safetyVersion: SAMPLE_DATA_SAFETY_VERSION,
      enabled: Boolean(parsed.enabled),
      updatedBy:
        typeof parsed.updatedBy === "string" && isAdminEmail(parsed.updatedBy)
          ? parsed.updatedBy.trim().toLowerCase()
          : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return browserDefaultState();
  }
}

/**
 * The GLOBAL sample-mode state when a server source exists, else the device-local
 * one. When Supabase is configured the operator's `app_controls` row governs the
 * ENTIRE app - a signed-out or non-operator session can NOT override it. Local
 * storage is only the fallback for an unconfigured (dev) build.
 */
function effectiveSampleState(): SampleDataModeState {
  if (isGlobalControlsConfigured()) {
    const g = getGlobalControls();
    if (g) {
      return {
        safetyVersion: SAMPLE_DATA_SAFETY_VERSION,
        enabled: g.sampleMode,
        updatedBy: g.updatedBy,
        updatedAt: g.updatedAt,
      };
    }
    // Global source exists but the operator's intent hasn't loaded yet. Fail
    // closed to sample ON - this is the kill-switch view that http.ts reads, so a
    // pre-load window can never leak a live API call against the operator's
    // choice. The DISPLAY/provider layer treats this same window as a distinct
    // "loading" state (see `isSampleDataModePending`): a skeleton, never the mock
    // universe and never a Live badge. Both views agree the only safe thing to
    // SHOW pre-load is nothing.
    return { ...SAFE_DEFAULT_STATE };
  }
  return loadSampleDataModeState();
}

export function isSampleDataModeEnabled(): boolean {
  return effectiveSampleState().enabled;
}

/**
 * The operator's GLOBAL sample/live choice isn't known on this client yet
 * (configured but no `app_controls` row cached - first fetch in flight or
 * failed). Distinct from "sample mode is ON": the data layer still fails closed
 * to zero live calls via `isSampleDataModeEnabled()`, but the UI must render a
 * skeleton + no provenance badge rather than the fictional sample universe.
 */
export function isSampleDataModePending(): boolean {
  return isGlobalControlsConfigured() && isGlobalControlsPending();
}

export function getSampleDataModeState(): SampleDataModeState {
  return effectiveSampleState();
}

// ── Subscriptions ──────────────────────────────────────────────────────────────
// Sample mode is read fresh from localStorage on every data-path call, so the
// DATA layer always applies a change instantly. The UI, however, snapshots the
// state into React on render - without a notification it can show a stale toggle
// until a reload. These listeners let any surface (the Operator Console, the
// data-mode banner/pill) re-read + re-render the instant the mode flips, no
// restart required. Mirrors `subscribeApiUsage` in apiUsage.ts.
const sampleListeners = new Set<() => void>();

function notifySampleListeners(): void {
  for (const l of sampleListeners) l();
}

/** Subscribe to sample-data-mode changes (UI live-updates). Returns unsubscribe. */
export function subscribeSampleDataMode(listener: () => void): () => void {
  sampleListeners.add(listener);
  return () => sampleListeners.delete(listener);
}

export function applySampleDataModeState(
  enabled: boolean,
  actorEmail: string,
  updatedAt: string,
): boolean {
  if (typeof window === "undefined" || !isAdminEmail(actorEmail)) return false;
  try {
    const state: SampleDataModeState = {
      safetyVersion: SAMPLE_DATA_SAFETY_VERSION,
      enabled,
      updatedBy: actorEmail.trim().toLowerCase(),
      updatedAt,
    };
    window.localStorage.setItem(SAMPLE_DATA_MODE_STORAGE_KEY, JSON.stringify(state));
    // Apply instantly everywhere - every subscribed surface re-reads + re-renders
    // without an app restart.
    notifySampleListeners();
    return true;
  } catch {
    return false;
  }
}

export function setSampleDataModeEnabled(
  enabled: boolean,
  actorEmail: string | null | undefined,
): boolean {
  const actor = actorEmail?.trim().toLowerCase();
  const auth = useAuthStore.getState();
  const sessionEmail = auth.email?.trim().toLowerCase();
  if (
    typeof window === "undefined" ||
    !auth.ready ||
    !auth.userId ||
    !actor ||
    actor !== sessionEmail ||
    !isAdminEmail(actor)
  ) {
    return false;
  }
  return applySampleDataModeState(enabled, actor, new Date().toISOString());
}
