import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Mock the Supabase-backed data layer so the store logic is exercised in isolation.
vi.mock("@/data/groups/groupsApi", () => ({
  addWatchTicker: vi.fn(),
  getGroupWatchlist: vi.fn(async () => []),
  fetchCurrentPrices: vi.fn(async () => ({})),
}));

import * as G from "@/data/groups/groupsApi";
import { useGroupsStore } from "@/store/useGroupsStore";
import { useAuthStore } from "@/store/useAuthStore";
import type { GroupSummary } from "@/data/groups/types";

const ALPHA: GroupSummary = {
  id: "g1",
  name: "Alpha Club",
  description: "",
  createdBy: "user-1",
  leaderboardEnabled: false,
  createdAt: new Date(0).toISOString(),
  role: "owner",
  memberCount: 4,
};

const addWatchTicker = G.addWatchTicker as Mock;
const getGroupWatchlist = G.getGroupWatchlist as Mock;

describe("useGroupsStore.shareTickerToGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ userId: "user-1" });
    useGroupsStore.setState({ groups: [ALPHA], activeId: null, watchlist: [] });
  });

  it("posts a ticker to the chosen group's shared watchlist", async () => {
    addWatchTicker.mockResolvedValueOnce(undefined);
    const r = await useGroupsStore.getState().shareTickerToGroup("g1", "nvda", "great setup");
    expect(addWatchTicker).toHaveBeenCalledWith("g1", "user-1", "NVDA", "great setup");
    expect(r).toEqual({ ok: true, ticker: "NVDA", groupName: "Alpha Club" });
  });

  it("reflects the share live when the shared group is the one open", async () => {
    addWatchTicker.mockResolvedValueOnce(undefined);
    getGroupWatchlist.mockResolvedValueOnce([
      { id: "w1", groupId: "g1", ticker: "NVDA", note: "", addedBy: { id: "user-1", handle: null, displayName: "Me", avatarAccent: "#000" }, createdAt: "x" },
    ]);
    useGroupsStore.setState({ activeId: "g1" });
    const r = await useGroupsStore.getState().shareTickerToGroup("g1", "NVDA", "");
    expect(r.ok).toBe(true);
    expect(getGroupWatchlist).toHaveBeenCalledWith("g1");
    expect(useGroupsStore.getState().watchlist).toHaveLength(1);
  });

  it("returns a friendly error when the ticker is already on the list", async () => {
    addWatchTicker.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));
    const r = await useGroupsStore.getState().shareTickerToGroup("g1", "NVDA", "");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already on Alpha Club/i);
  });

  it("refuses when signed out", async () => {
    useAuthStore.setState({ userId: null });
    const r = await useGroupsStore.getState().shareTickerToGroup("g1", "NVDA", "");
    expect(r.ok).toBe(false);
    expect(addWatchTicker).not.toHaveBeenCalled();
  });

  it("refuses an unrecognized ticker without hitting the backend", async () => {
    const r = await useGroupsStore.getState().shareTickerToGroup("g1", "ZZZZNOTREAL", "");
    expect(r.ok).toBe(false);
    expect(addWatchTicker).not.toHaveBeenCalled();
  });
});
