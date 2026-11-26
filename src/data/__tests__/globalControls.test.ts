import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Global operator controls - the server-side source of truth that governs the
 * whole app for ALL users. These tests lock the two invariants the feature ships:
 *   1. READ path: the singleton `app_controls` row loads into a synchronous cache
 *      so the (synchronous) sample/pause consumers read the operator's GLOBAL
 *      choice - not a device-local default.
 *   2. WRITE intent: only the signed-in operator may write; a non-operator (or
 *      signed-out) call is rejected before any RPC, and an operator write calls
 *      the server-side `set_app_controls` RPC (which re-checks the allowlist).
 *
 * Supabase + auth + the admin allowlist are mocked so the path is deterministic
 * and never touches the network.
 */

const OPERATOR = "operator@example.com";

// ── Mocks ───────────────────────────────────────────────────────────────────
// Hoisted so the (hoisted) vi.mock factory can close over them.
const { rpc, maybeSingle } = vi.hoisted(() => ({
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/data/supabase/client", () => {
  const fakeChannel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  const from = vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle })) })),
  }));
  return {
    isSupabaseConfigured: true,
    supabase: {
      from,
      rpc,
      channel: vi.fn(() => fakeChannel),
    },
  };
});

let authState: { ready: boolean; userId: string | null; email: string | null } = {
  ready: true,
  userId: "op-uid",
  email: OPERATOR,
};
vi.mock("@/store/useAuthStore", () => ({
  useAuthStore: { getState: () => authState },
}));

vi.mock("@/lib/admin", () => ({
  isAdminEmail: (email: string | null | undefined) =>
    (email ?? "").trim().toLowerCase() === OPERATOR,
}));

import {
  getGlobalControls,
  isGlobalControlsConfigured,
  initGlobalControls,
  refreshGlobalControls,
  saveGlobalControls,
} from "@/data/globalControls";

beforeEach(() => {
  rpc.mockReset();
  maybeSingle.mockReset();
  authState = { ready: true, userId: "op-uid", email: OPERATOR };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("global controls — read path", () => {
  it("loads the singleton row into the synchronous cache", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        sample_mode: false,
        live_paused: false,
        enforce_budgets: true,
        budgets: { finnhub: 250, fmp: 25 },
        active_variant: "challenger",
        updated_by: OPERATOR,
        updated_at: "2026-06-18T00:00:00.000Z",
      },
      error: null,
    });

    expect(isGlobalControlsConfigured()).toBe(true);
    await initGlobalControls();

    const g = getGlobalControls();
    expect(g).not.toBeNull();
    expect(g?.sampleMode).toBe(false);
    expect(g?.livePaused).toBe(false);
    expect(g?.budgets.finnhub).toBe(250);
    expect(g?.activeVariant).toBe("challenger");
    expect(g?.updatedBy).toBe(OPERATOR);
  });

  it("defaults active_variant to V5/challenger when the row value is missing/invalid", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        sample_mode: false,
        live_paused: false,
        enforce_budgets: true,
        budgets: {},
        active_variant: null, // an older row created before the column existed
        updated_by: OPERATOR,
        updated_at: "2026-06-18T00:00:00.000Z",
      },
      error: null,
    });
    await refreshGlobalControls();
    expect(getGlobalControls()?.activeVariant).toBe("challenger");
  });

  it("sample mode forces live OFF even if the row says live is on (invariant)", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        sample_mode: true,
        live_paused: false, // contradicts sample mode on purpose
        enforce_budgets: true,
        budgets: {},
        active_variant: "champion",
        updated_by: OPERATOR,
        updated_at: "2026-06-18T00:00:00.000Z",
      },
      error: null,
    });
    // initGlobalControls is idempotent (the cache may already be warm from a
    // prior test), so force a re-fetch to exercise the invariant on this row.
    await refreshGlobalControls();
    const g = getGlobalControls();
    expect(g?.sampleMode).toBe(true);
    expect(g?.livePaused).toBe(true);
  });
});

describe("global controls — operator-only write intent", () => {
  it("rejects a write from a non-operator (signed-out) session without calling the RPC", async () => {
    authState = { ready: true, userId: null, email: null };
    const ok = await saveGlobalControls({ sampleMode: true });
    expect(ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a write from a signed-in NON-operator without calling the RPC", async () => {
    authState = { ready: true, userId: "other-uid", email: "someone@else.com" };
    const ok = await saveGlobalControls({ livePaused: true });
    expect(ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("operator write calls set_app_controls and reconciles the cache from the row", async () => {
    rpc.mockResolvedValue({
      data: {
        sample_mode: true,
        live_paused: true,
        enforce_budgets: true,
        budgets: {},
        active_variant: "champion",
        updated_by: OPERATOR,
        updated_at: "2026-06-18T01:00:00.000Z",
      },
      error: null,
    });

    const ok = await saveGlobalControls({ sampleMode: true });
    expect(ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("set_app_controls", {
      p_sample_mode: true,
      p_live_paused: null,
      p_enforce_budgets: null,
      p_budgets: null,
      p_active_variant: null,
      p_score_spread_weight: null,
      p_quality_cap_strength: null,
    });
    expect(getGlobalControls()?.sampleMode).toBe(true);
    expect(getGlobalControls()?.livePaused).toBe(true);
  });

  it("operator PROMOTE writes the global active_variant via the RPC and reads it back", async () => {
    rpc.mockResolvedValue({
      data: {
        sample_mode: false,
        live_paused: false,
        enforce_budgets: true,
        budgets: {},
        active_variant: "challenger",
        updated_by: OPERATOR,
        updated_at: "2026-06-18T02:00:00.000Z",
      },
      error: null,
    });

    // This is exactly what promoteModel does when Supabase is configured.
    const ok = await saveGlobalControls({ activeVariant: "challenger" });
    expect(ok).toBe(true);
    // The variant rides in p_active_variant; the other fields stay NULL (a
    // partial patch never clobbers sample/pause/budgets).
    expect(rpc).toHaveBeenCalledWith("set_app_controls", {
      p_sample_mode: null,
      p_live_paused: null,
      p_enforce_budgets: null,
      p_budgets: null,
      p_active_variant: "challenger",
      p_score_spread_weight: null,
      p_quality_cap_strength: null,
    });
    // Source of truth reconciled from the authoritative row → every client that
    // reads getGlobalControls()/getActiveVariant() now runs the challenger.
    expect(getGlobalControls()?.activeVariant).toBe("challenger");
  });

  it("rejects a NON-operator active_variant (promote) write without calling the RPC", async () => {
    authState = { ready: true, userId: "other-uid", email: "someone@else.com" };
    const ok = await saveGlobalControls({ activeVariant: "challenger" });
    expect(ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("isGlobalControlsConfigured — trusted-scan escape hatch", () => {
  afterEach(() => {
    delete (globalThis as { __CATALYZED_TRUSTED_SCAN__?: boolean }).__CATALYZED_TRUSTED_SCAN__;
  });

  it("is configured normally (Supabase present)", () => {
    expect(isGlobalControlsConfigured()).toBe(true);
  });

  it("reports NOT configured under a trusted server scan, so the scan honors its own seeds (regression: the scan died with 'Finnhub not configured' when the browser-only fail-closed-to-sample guard overrode its sample-OFF seed)", () => {
    (globalThis as { __CATALYZED_TRUSTED_SCAN__?: boolean }).__CATALYZED_TRUSTED_SCAN__ = true;
    expect(isGlobalControlsConfigured()).toBe(false);
  });
});
