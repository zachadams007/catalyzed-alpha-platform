import { describe, it, expect } from "vitest";
import { buildSocialNotices, reconcileNotices, MAX_BURST, type SocialInputs } from "@/lib/socialNotify";

/**
 * Guards the "notify even if you were offline" notification reconcile:
 *  - a new friend request / group invite / share becomes a tappable notice;
 *  - already-seen ids never re-toast (no repeats, no double-fire with realtime);
 *  - a long backlog collapses past MAX_BURST into one summary.
 */

const req = (id: string, name: string, createdAt: string) => ({
  friendshipId: id,
  profile: { displayName: name, handle: null },
  createdAt,
});
const inv = (id: string, group: string, createdAt: string) => ({
  id,
  groupName: group,
  inviter: { displayName: "Pat", handle: null },
  createdAt,
});

describe("socialNotify — reconcile", () => {
  it("builds a friend-request notice that navigates to /friends", () => {
    const notices = buildSocialNotices({ incoming: [req("f1", "Sam", "2026-06-26T10:00:00Z")], invites: [] });
    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe("freq:f1");
    expect(notices[0].message).toBe("Sam added you as a friend");
    expect(notices[0].href).toBe("/friends");
  });

  it("fires a new item once and never again (dedupe = no repeat / no double-fire)", () => {
    const notices = buildSocialNotices({ incoming: [req("f1", "Sam", "2026-06-26T10:00:00Z")], invites: [] });
    const first = reconcileNotices(notices, []);
    expect(first.toToast.map((n) => n.id)).toEqual(["freq:f1"]);
    // Second pass with the returned seen set: nothing new.
    const second = reconcileNotices(notices, first.nextSeen);
    expect(second.toToast).toHaveLength(0);
    expect(second.summary).toBeNull();
  });

  it("surfaces an item that was NOT in the seen set (arrived while offline)", () => {
    const seen = ["freq:old"];
    const notices = buildSocialNotices({ incoming: [req("new", "Lee", "2026-06-26T09:00:00Z")], invites: [] });
    const r = reconcileNotices(notices, seen);
    expect(r.toToast.map((n) => n.id)).toEqual(["freq:new"]);
    expect(r.nextSeen).toContain("freq:new");
    expect(r.nextSeen).toContain("freq:old");
  });

  it("collapses a backlog past MAX_BURST into a single summary, newest first", () => {
    const incoming = Array.from({ length: MAX_BURST + 2 }, (_, i) =>
      req(`f${i}`, `User${i}`, `2026-06-26T10:0${i}:00Z`),
    );
    const notices = buildSocialNotices({ incoming, invites: [] } as SocialInputs);
    const r = reconcileNotices(notices, []);
    expect(r.toToast).toHaveLength(MAX_BURST);
    expect(r.summary).not.toBeNull();
    expect(r.summary?.message).toContain("+2 more");
    // Newest-first: the last-created request leads the burst.
    expect(r.toToast[0].id).toBe(`freq:f${MAX_BURST + 1}`);
    // All fresh ids are marked seen (incl. the summarized overflow).
    expect(r.nextSeen).toHaveLength(MAX_BURST + 2);
  });

  it("emits a 'now connected' notice when a friend accepts (new entry in friends[])", () => {
    const notices = buildSocialNotices({
      incoming: [],
      invites: [],
      friends: [{ friendshipId: "fr1", profile: { displayName: "Ben", handle: null } }],
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe("facc:fr1");
    expect(notices[0].message).toBe("You're now connected with Ben");
    expect(notices[0].tone).toBe("success");
    // A friend already in the seen set must not re-toast.
    expect(reconcileNotices(notices, ["facc:fr1"]).toToast).toHaveLength(0);
  });

  it("mixes friend requests + group invites", () => {
    const notices = buildSocialNotices({
      incoming: [req("f1", "Sam", "2026-06-26T10:00:00Z")],
      invites: [inv("g1", "Quant Club", "2026-06-26T11:00:00Z")],
    });
    const ids = notices.map((n) => n.id);
    expect(ids).toContain("freq:f1");
    expect(ids).toContain("ginv:g1");
    const g = notices.find((n) => n.id === "ginv:g1")!;
    expect(g.message).toBe("Pat invited you to Quant Club");
    expect(g.href).toBe("/groups");
  });
});
