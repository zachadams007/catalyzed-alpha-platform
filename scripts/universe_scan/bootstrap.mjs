/**
 * Node bootstrap for the daily broad-universe scan.
 *
 * The app's data layer is written for the browser/Tauri shell, so two gates
 * would otherwise block a headless Node run:
 *   1. `sampleDataMode.ts` returns sample-ON when `window` is undefined → every
 *      live fetch throws "blocked because Sample data mode is enabled".
 *   2. `apiUsage.ts` defaults to `enforceBudgets:true` (Finnhub 250/day etc.) →
 *      a 500-name scan would be throttled by the per-DEVICE tester budgets, which
 *      are irrelevant to a trusted server-side job using its own keys.
 *
 * This module - imported FIRST, before any `@/` import - installs an in-memory
 * `localStorage`, a minimal `window`, and SEEDS both safety keys to the scan's
 * needs (sample OFF, budgets OFF, not paused). Both `apiUsage` and
 * `sampleDataMode` read their state at module load, so the seed must exist before
 * those modules evaluate - hence the import-order contract.
 *
 * It also loads server-only secrets from `scripts/universe_scan/.scan.env`
 * (gitignored) into `process.env` for local runs; in CI the workflow provides
 * them directly. The client VITE_* keys come from `.env` (loaded by vite-node).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ── 1. Load .scan.env (server-only secrets) into process.env for local runs ──
const envFile = join(here, ".scan.env");
if (existsSync(envFile)) {
  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ── 2. In-memory localStorage shim ──────────────────────────────────────────
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(String(k), String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

const localStorageShim = makeLocalStorage();

// ── 3. Seed the safety keys BEFORE the app modules read them ─────────────────
// sampleDataMode.ts (SAMPLE_DATA_SAFETY_VERSION = 2): sample OFF so live fetches run.
localStorageShim.setItem(
  "catalyzed-dev-offline",
  JSON.stringify({ safetyVersion: 2, enabled: false, updatedBy: null, updatedAt: null }),
);
// apiUsage.ts (API_SAFETY_VERSION = 2): not paused, budgets OFF - this trusted
// server job uses its own keys and should not be capped by per-device budgets.
localStorageShim.setItem(
  "catalyzed-alpha:api-controls:v1",
  JSON.stringify({
    safetyVersion: 2,
    paused: false,
    enforceBudgets: false,
    budgets: {},
    updatedBy: null,
    updatedAt: null,
  }),
);

// ── 4. Expose globals the way the two access patterns expect ─────────────────
// Mark this as a TRUSTED SERVER SCAN so the app's global-controls layer skips its
// browser-only "Supabase configured but app_controls not yet loaded → fail closed
// to sample" guard. Without this, that guard overrides the sample-OFF seed above
// and `finnhubKey()` returns undefined → the scan dies with "Finnhub not
// configured" even though the real keys are present in .env.
globalThis.__CATALYZED_TRUSTED_SCAN__ = true;
// apiUsage uses bare `localStorage`; sampleDataMode uses `window.localStorage`.
globalThis.localStorage = localStorageShim;
if (typeof globalThis.window === "undefined") {
  globalThis.window = /** @type {any} */ ({});
}
globalThis.window.localStorage = localStorageShim;

export {};
