/**
 * Per-user manual-refresh limiter - the soft daily cap on how many times a user
 * can force a fresh research run with the "Scan the Market" button.
 *
 * This sits ON TOP of the once-daily auto-cache (`isResearchFreshForToday` in
 * `src/lib/researchSchedule.ts`): re-opening the app reuses today's cached
 * signals for free, and this module governs the *extra* manual runs a user can
 * trigger by hand. It is the client-side half of the limiter design in
 * `docs/program/distribution-and-limiter-plan.md` §3 - the server-side proxy
 * ceiling is the backstop for the unexpected case.
 *
 * Sibling of `src/lib/apiUsage.ts`: both are pure, localStorage-backed ledgers
 * that govern API spend with zero coupling to the scoring engine or store, and
 * both expose a subscribe() so UI surfaces live-update. Where `apiUsage` counts
 * raw vendor *calls*, this counts user-initiated research *runs*.
 *
 * Threat model: trusted friends, not adversaries (per the plan). Nobody clears
 * localStorage to reset their counter; the real risk is accidental hammering.
 * A device-scoped soft cap is therefore sufficient - we deliberately do NOT key
 * the counter to a userId so the anonymous local path keeps working (the
 * `profiles-optional` rule), and so the cap survives sign-out.
 */

/** Manual "Scan the Market" runs allowed per device per day (admins bypass). */
export const MANUAL_REFRESH_LIMIT = 3;

/** localStorage key. Bump the version suffix if the stored shape changes. */
const STORAGE_KEY = "catalyzed-alpha:refresh-count:v1";

interface RefreshCounter {
  /** Local calendar day this count belongs to, `YYYY-MM-DD`. */
  date: string;
  /** Manual runs already spent today. */
  count: number;
}

export interface RefreshLimiterStatus {
  /** Local calendar day the status was computed for. */
  date: string;
  /** Manual runs spent today (always 0 for admins - they never accrue). */
  used: number;
  /** The daily allowance (admins report `Infinity`). */
  limit: number;
  /** Runs still available today (admins report `Infinity`). */
  remaining: number;
  /** True when the next manual run must be refused (never true for admins). */
  blocked: boolean;
  /** True when the caller is an allowlisted operator and bypasses the cap. */
  unlimited: boolean;
  /** ISO timestamp of the next reset (local midnight). */
  resetsAtIso: string;
}

interface LimiterOptions {
  /** Allowlisted operator → unlimited manual runs (admin bypass). */
  isAdmin?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

// ── Day boundary ────────────────────────────────────────────────────────────

/** Local-calendar day key, `YYYY-MM-DD`. The cap resets at local midnight. */
function dayKeyOf(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** Next local midnight after `now` - when the counter rolls back to zero. */
function nextMidnight(now: Date): Date {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d;
}

// ── Persistence (defensive - never throw into a click handler) ───────────────

function loadCounter(today: string): RefreshCounter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: today, count: 0 };
    const parsed = JSON.parse(raw) as Partial<RefreshCounter>;
    // A counter from a previous day is stale → start fresh for today.
    if (parsed.date !== today || typeof parsed.count !== "number" || parsed.count < 0) {
      return { date: today, count: 0 };
    }
    return { date: today, count: Math.floor(parsed.count) };
  } catch {
    return { date: today, count: 0 };
  }
}

function saveCounter(counter: RefreshCounter): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counter));
  } catch {
    /* storage full/unavailable - the cap degrades open, data paths don't break */
  }
}

// ── Subscriptions (UI live-update) ──────────────────────────────────────────

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to limiter changes (record/reset). Returns an unsubscribe fn. */
export function subscribeRefreshLimiter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Status + mutation ───────────────────────────────────────────────────────

function statusFrom(counter: RefreshCounter, now: Date, isAdmin: boolean): RefreshLimiterStatus {
  const resetsAtIso = nextMidnight(now).toISOString();
  if (isAdmin) {
    return {
      date: counter.date,
      used: 0,
      limit: Infinity,
      remaining: Infinity,
      blocked: false,
      unlimited: true,
      resetsAtIso,
    };
  }
  const used = Math.min(counter.count, MANUAL_REFRESH_LIMIT);
  const remaining = Math.max(0, MANUAL_REFRESH_LIMIT - counter.count);
  return {
    date: counter.date,
    used,
    limit: MANUAL_REFRESH_LIMIT,
    remaining,
    blocked: remaining <= 0,
    unlimited: false,
    resetsAtIso,
  };
}

/** Current limiter status without mutating the counter (safe to call in render). */
export function getManualRefreshStatus(opts: LimiterOptions = {}): RefreshLimiterStatus {
  const now = opts.now ?? new Date();
  return statusFrom(loadCounter(dayKeyOf(now)), now, Boolean(opts.isAdmin));
}

/** True when another manual run is allowed right now (admins: always true). */
export function canManualRefresh(opts: LimiterOptions = {}): boolean {
  return !getManualRefreshStatus(opts).blocked;
}

/**
 * Spend one manual run against today's allowance and persist it. Admins are a
 * no-op (they never accrue a count, so signing in as the operator never burns
 * a friend's quota on a shared device). Returns the post-increment status.
 *
 * Callers MUST gate on {@link canManualRefresh} / `getManualRefreshStatus().blocked`
 * first - this only records, it does not refuse.
 */
export function recordManualRefresh(opts: LimiterOptions = {}): RefreshLimiterStatus {
  const now = opts.now ?? new Date();
  const isAdmin = Boolean(opts.isAdmin);
  if (isAdmin) return getManualRefreshStatus({ isAdmin, now });

  const today = dayKeyOf(now);
  const counter = loadCounter(today);
  const next: RefreshCounter = { date: today, count: counter.count + 1 };
  saveCounter(next);
  notify();
  return statusFrom(next, now, false);
}

/**
 * Clear today's manual-refresh count (Operator console "reset" control). Used to
 * un-stick a friend who hit the cap, on this device. Returns the fresh status.
 */
export function resetManualRefreshCount(opts: LimiterOptions = {}): RefreshLimiterStatus {
  const now = opts.now ?? new Date();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
  notify();
  return getManualRefreshStatus({ isAdmin: opts.isAdmin, now });
}
