import { isResearchAgentAvailable, runResearchAgent } from "@/data/ai/researchAgent";
import {
  DISCOVERY_MISSION_COUNT,
  selectMissions,
  type DiscoveryMission,
} from "@/data/ai/discoveryMissions";

/**
 * AI-driven niche universe discovery.
 *
 * Runs the hosted research agent across a rotating slice of niche missions and
 * collects the REAL tickers it surfaces via live web search. Results are cached
 * (localStorage) with a short TTL so the auto-run on launch doesn't spam the
 * agent, while still rotating to fresh themes between refreshes. The agent key
 * lives server-side (VITE_RESEARCH_PROXY_URL) - never in the bundle.
 */

const CACHE_KEY = "catalyzed-alpha:discovery-universe";
/**
 * How long a discovered list stays fresh before we rotate to new themes.
 * Kept generous because the agent's free tier (e.g. Gemini) is quota-limited -
 * caching is what keeps daily request counts sane while still rotating themes.
 */
const TTL_MS = 90 * 60 * 1000; // 90 minutes
/**
 * After a refresh that yields nothing (proxy down / over quota), wait this long
 * before trying the agent again so a failing endpoint can't burn quota or make
 * every run crawl. The feed uses anchors in the meantime.
 */
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
/**
 * Missions per refresh - run in parallel, so wall time ≈ one call, not N. Kept
 * low (2) to respect tight free-tier daily quotas; rotation still cycles through
 * every theme across refreshes.
 */
const MISSIONS_PER_REFRESH = 2;
/**
 * Per-mission network timeout. Must comfortably exceed the proxy's own
 * per-provider upstream timeout (~20s) plus one fast fallback, so a genuine
 * grounded result isn't cut off - while still bounding a fully-dead proxy.
 */
// 120s: the Gemini-backed discover run measured ~58s cold end-to-end, so 30s
// aborted real results. Must exceed the proxy's full upstream + failover latency.
const MISSION_TIMEOUT_MS = 120_000;
/** Hard cap on discovered tickers per refresh. */
const MAX_TICKERS = 36;

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,6}$/;

interface DiscoveryCache {
  tickers: string[];
  /** Mission labels used for the cached list (provenance). */
  missionLabels: string[];
  /** Index to start the next rotation from. */
  rotationIndex: number;
  generatedAt: string;
}

export interface DiscoveryResult {
  tickers: string[];
  missionLabels: string[];
  generatedAt: string;
  fromCache: boolean;
}

function readCache(): DiscoveryCache | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiscoveryCache;
    return Array.isArray(parsed.tickers) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: DiscoveryCache): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage may be unavailable; discovery still works in-memory this run */
  }
}

function cacheAge(cache: DiscoveryCache | null): number {
  if (!cache) return Infinity;
  const age = Date.now() - new Date(cache.generatedAt).getTime();
  return Number.isFinite(age) && age >= 0 ? age : Infinity;
}

function isFresh(cache: DiscoveryCache | null): boolean {
  return Boolean(cache && cache.tickers.length > 0 && cacheAge(cache) < TTL_MS);
}

/** A recent refresh that produced nothing - back off so a dead proxy isn't retried every run. */
function inFailureCooldown(cache: DiscoveryCache | null): boolean {
  return Boolean(cache && cache.tickers.length === 0 && cacheAge(cache) < FAILURE_COOLDOWN_MS);
}

async function runMission(mission: DiscoveryMission): Promise<string[]> {
  const intel = await runResearchAgent(
    { task: "discover", narrative: mission.narrative, themes: mission.themes },
    { timeoutMs: MISSION_TIMEOUT_MS },
  );
  const out: string[] = [];
  for (const suggestion of intel.suggestions ?? []) {
    const ticker = suggestion.ticker.trim().toUpperCase();
    if (ticker && TICKER_RE.test(ticker)) out.push(ticker);
  }
  return out;
}

function fromCacheResult(cache: DiscoveryCache | null): DiscoveryResult {
  return {
    tickers: cache?.tickers ?? [],
    missionLabels: cache?.missionLabels ?? [],
    generatedAt: cache?.generatedAt ?? new Date().toISOString(),
    fromCache: Boolean(cache),
  };
}

/**
 * Discover niche tickers. Returns cached results when fresh; otherwise rotates
 * to the next themes and runs the agent. Missions run in parallel with a timeout
 * so a slow/failing proxy can't stall the feed. Never throws - on failure it
 * returns whatever was cached (possibly empty) so the provider falls back to
 * anchors quickly, and records a short cooldown to avoid retry storms.
 */
export async function discoverNicheTickers(): Promise<DiscoveryResult> {
  const cache = readCache();
  if (isFresh(cache) || inFailureCooldown(cache)) {
    return fromCacheResult(cache);
  }

  if (!isResearchAgentAvailable()) {
    return fromCacheResult(cache);
  }

  const baseRotation = cache?.rotationIndex ?? 0;
  const missions = selectMissions(baseRotation, MISSIONS_PER_REFRESH);

  const settled = await Promise.allSettled(missions.map((m) => runMission(m)));
  const seen = new Set<string>();
  const tickers: string[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const ticker of result.value) {
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      tickers.push(ticker);
      if (tickers.length >= MAX_TICKERS) break;
    }
    if (tickers.length >= MAX_TICKERS) break;
  }

  // If every mission failed, keep the previous list (if any) so the feed works,
  // and stamp generatedAt so the failure cooldown applies.
  const resultTickers = tickers.length > 0 ? tickers : (cache?.tickers ?? []);
  const generatedAt = new Date().toISOString();
  const missionLabels = missions.map((m) => m.label);

  writeCache({
    tickers: resultTickers,
    missionLabels,
    rotationIndex: (baseRotation + MISSIONS_PER_REFRESH) % Math.max(DISCOVERY_MISSION_COUNT, 1),
    generatedAt,
  });

  return { tickers: resultTickers, missionLabels, generatedAt, fromCache: false };
}
