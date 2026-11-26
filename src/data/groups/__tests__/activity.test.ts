import { describe, it, expect } from "vitest";

import type { Profile } from "@/data/supabase/friends";
import type { ActivityKind, GroupActivity } from "@/data/groups/types";
import {
  activitySummary,
  activityTone,
  actorName,
  unreadCount,
} from "@/data/groups/activity";

const NOW = Date.UTC(2026, 5, 18, 18, 0, 0);
const MIN = 60 * 1000;

function profile(id: string, name: string): Profile {
  return { id, handle: name.toLowerCase(), displayName: name, avatarAccent: "#1ab2e8" };
}

let seq = 0;
function act(over: Partial<GroupActivity> & { kind: ActivityKind }): GroupActivity {
  seq += 1;
  return {
    id: `a-${seq}`,
    groupId: "g1",
    refId: null,
    meta: {},
    createdAt: new Date(NOW).toISOString(),
    actor: profile("u-other", "Nina"),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// unreadCount
// ---------------------------------------------------------------------------
describe("unreadCount", () => {
  const me = "u-me";

  it("counts rows newer than the read mark", () => {
    const activity = [
      act({ kind: "message", createdAt: new Date(NOW - 1 * MIN).toISOString() }),
      act({ kind: "call", createdAt: new Date(NOW - 2 * MIN).toISOString() }),
      act({ kind: "watchlist", createdAt: new Date(NOW - 30 * MIN).toISOString() }),
    ];
    const lastRead = new Date(NOW - 10 * MIN).toISOString();
    expect(unreadCount(activity, lastRead, me)).toBe(2);
  });

  it("never counts the viewer's own actions", () => {
    const activity = [
      act({ kind: "message", actor: profile(me, "Me"), createdAt: new Date(NOW).toISOString() }),
      act({ kind: "call", actor: profile("u-other", "Nina"), createdAt: new Date(NOW).toISOString() }),
    ];
    expect(unreadCount(activity, new Date(NOW - 5 * MIN).toISOString(), me)).toBe(1);
  });

  it("treats a null read mark as everything-unread (minus own)", () => {
    const activity = [
      act({ kind: "message", actor: profile(me, "Me") }),
      act({ kind: "call", actor: profile("u-other", "Nina") }),
      act({ kind: "poll_opened", actor: profile("u-x", "Omar") }),
    ];
    expect(unreadCount(activity, null, me)).toBe(2);
  });

  it("returns 0 when everything is older than the read mark", () => {
    const activity = [act({ kind: "message", createdAt: new Date(NOW - 60 * MIN).toISOString() })];
    expect(unreadCount(activity, new Date(NOW).toISOString(), me)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// actorName / activitySummary / activityTone
// ---------------------------------------------------------------------------
describe("actorName", () => {
  it("prefers display name, falls back through handle to Someone", () => {
    expect(actorName(act({ kind: "message", actor: profile("u", "Zach") }))).toBe("Zach");
    expect(actorName(act({ kind: "message", actor: { id: "u", handle: "z", displayName: null, avatarAccent: "#000" } }))).toBe("z");
    expect(actorName(act({ kind: "message", actor: null }))).toBe("Someone");
  });
});

describe("activitySummary", () => {
  it("describes a buy vs a watch call", () => {
    expect(activitySummary(act({ kind: "call", meta: { ticker: "NVDA", direction: "buy" } }))).toBe(
      "called a buy on NVDA",
    );
    expect(activitySummary(act({ kind: "call", meta: { ticker: "TSLA", direction: "watch" } }))).toBe(
      "flagged a watch on TSLA",
    );
  });
  it("describes a watchlist add", () => {
    expect(activitySummary(act({ kind: "watchlist", meta: { ticker: "AAPL" } }))).toBe(
      "added AAPL to the watchlist",
    );
  });
  it("quotes the question for poll events", () => {
    expect(activitySummary(act({ kind: "poll_opened", meta: { question: "Next pick?" } }))).toContain("Next pick?");
    expect(activitySummary(act({ kind: "poll_closed", meta: { question: "Next pick?" } }))).toContain("closed the poll");
  });
  it("previews a chat message", () => {
    expect(activitySummary(act({ kind: "message", meta: { preview: "hi team" } }))).toBe('said: “hi team”');
  });
});

describe("activityTone", () => {
  it("maps kinds to accent roles", () => {
    expect(activityTone("call")).toBe("bull");
    expect(activityTone("poll_opened")).toBe("gold");
    expect(activityTone("poll_closed")).toBe("gold");
    expect(activityTone("watchlist")).toBe("accent");
    expect(activityTone("message")).toBe("muted");
  });
});
