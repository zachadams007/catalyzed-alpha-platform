import { describe, it, expect } from "vitest";
import { capPerActor, withinWindow } from "@/data/terminal/terminalFeed";
import type { TerminalEvent } from "@/types/terminal";

/**
 * De-flood + window curation for the Terminal wire.
 *
 * These cover the owner's three asks after testing the live build:
 *   (a) one liquidating account must not flood a tab - cap per person,
 *   (b) SELLS must show alongside buys (not just open-market purchases),
 *   (c) the window must be wide enough that ~1-day-old notable trades still show.
 */

const NOW = Date.parse("2026-06-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const isoNow = new Date(NOW).toISOString();
function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function mkEvent(over: Partial<TerminalEvent> & { id: string }): TerminalEvent {
  const base: TerminalEvent = {
    id: over.id,
    kind: "insider_sell",
    severity: "watch",
    ticker: "NVDA",
    headline: "someone traded NVDA",
    occurredAt: isoNow,
    surfacedAt: isoNow,
    source: { name: "Test", url: "https://example.com" },
  };
  return { ...base, ...over };
}

describe("capPerActor — de-flood one person's dump", () => {
  it("limits a single account's share so it can't bury the tab (acceptance a)", () => {
    const jane = Array.from({ length: 6 }, (_, i) =>
      mkEvent({ id: `jane-${i}`, actor: { name: "Jane Liquidator" } }),
    );
    const others = [
      mkEvent({ id: "bob-0", actor: { name: "Bob Buyer" }, kind: "insider_buy" }),
      mkEvent({ id: "bob-1", actor: { name: "Bob Buyer" }, kind: "insider_buy" }),
      mkEvent({ id: "carol-0", actor: { name: "Carol" }, kind: "politician_trade" }),
    ];
    const out = capPerActor([...jane, ...others], 3);

    const share = (name: string) =>
      out.filter((e) => e.actor?.name === name).length;
    expect(share("Jane Liquidator")).toBe(3); // capped from 6 → 3
    expect(share("Bob Buyer")).toBe(2); // under the cap, untouched
    expect(share("Carol")).toBe(1);
    expect(out).toHaveLength(6);
  });

  it("keeps each account's FIRST (most material — list is pre-ranked) entries", () => {
    const jane = Array.from({ length: 5 }, (_, i) =>
      mkEvent({ id: `j${i}`, actor: { name: "Jane Liquidator" } }),
    );
    const kept = capPerActor(jane, 3).map((e) => e.id);
    expect(kept).toEqual(["j0", "j1", "j2"]);
  });

  it("treats case/whitespace variants of a name as the SAME account", () => {
    const events = [
      mkEvent({ id: "a", actor: { name: "Jane Liquidator" } }),
      mkEvent({ id: "b", actor: { name: "jane  liquidator" } }),
      mkEvent({ id: "c", actor: { name: " JANE LIQUIDATOR " } }),
      mkEvent({ id: "d", actor: { name: "Jane Liquidator" } }),
    ];
    expect(capPerActor(events, 2)).toHaveLength(2); // all one account → capped to 2
  });

  it("never caps actorless events (news, 8-K) — they aren't a person", () => {
    const news = Array.from({ length: 5 }, (_, i) =>
      mkEvent({ id: `n${i}`, kind: "catalyst_news", headline: "market headline" }),
    );
    expect(capPerActor(news, 3)).toHaveLength(5);
  });

  it("defaults to a sane per-actor cap when none is passed", () => {
    const jane = Array.from({ length: 8 }, (_, i) =>
      mkEvent({ id: `j${i}`, actor: { name: "Jane Liquidator" } }),
    );
    expect(capPerActor(jane).length).toBeLessThanOrEqual(3);
    expect(capPerActor(jane).length).toBeGreaterThan(0);
  });
});

describe("withinWindow — widen so day-old trades still surface", () => {
  it("includes a ~1-day-old event and drops a clearly stale one (acceptance c)", () => {
    // sec_8k is a fast lane (7-day default) - NOT insider/congress, which get wider
    // windows. Tests the generic floor.
    const events = [
      mkEvent({ id: "fresh", kind: "filing_8k", surfacedAt: daysAgo(1) }),
      mkEvent({ id: "stale", kind: "filing_8k", surfacedAt: daysAgo(10) }),
    ];
    const kept = withinWindow(events, 7, NOW).map((e) => e.id);
    expect(kept).toContain("fresh");
    expect(kept).not.toContain("stale");
  });

  it("keeps events at the window edge and into the future (clock skew)", () => {
    const events = [
      mkEvent({ id: "edge", surfacedAt: daysAgo(7) }), // exactly at the floor
      mkEvent({ id: "now", surfacedAt: isoNow }),
      mkEvent({ id: "future", surfacedAt: new Date(NOW + DAY).toISOString() }),
    ];
    const kept = withinWindow(events, 7, NOW).map((e) => e.id);
    expect(kept).toEqual(["edge", "now", "future"]);
  });

  it("drops everything older than the window but nothing newer", () => {
    const events = [
      mkEvent({ id: "d6", kind: "filing_8k", surfacedAt: daysAgo(6) }),
      mkEvent({ id: "d8", kind: "filing_8k", surfacedAt: daysAgo(8) }),
    ];
    const kept = withinWindow(events, 7, NOW).map((e) => e.id);
    expect(kept).toEqual(["d6"]);
  });

  it("gives Congress + insider trades a WIDER window than fast lanes (disclosure lag)", () => {
    // Trades disclosed weeks ago must still surface: Congress has a 30–45 day legal
    // PTR filing window, and an insider BUY stays a live signal for weeks (a CEO who
    // bought last month is exactly what the owner wants to see). A 7-day window wrongly
    // hid almost all of these (why both tabs read empty). True fast lanes (news/8-K)
    // are still correctly dropped at 7 days.
    const events = [
      mkEvent({ id: "congress-30d", kind: "politician_trade", surfacedAt: daysAgo(30) }),
      mkEvent({ id: "exec-50d", kind: "politician_trade", surfacedAt: daysAgo(50) }),
      mkEvent({ id: "insiderbuy-50d", kind: "insider_buy", surfacedAt: daysAgo(50) }),
      mkEvent({ id: "fast-30d", kind: "filing_8k", surfacedAt: daysAgo(30) }),
      mkEvent({ id: "congress-stale", kind: "politician_trade", surfacedAt: daysAgo(75) }),
    ];
    const kept = withinWindow(events, 7, NOW).map((e) => e.id);
    expect(kept).toContain("congress-30d"); // inside the 60-day political window
    expect(kept).toContain("exec-50d"); // a 50-day-old presidential OGE disclosure still surfaces
    expect(kept).toContain("insiderbuy-50d"); // inside the 60-day insider-buy window
    expect(kept).not.toContain("fast-30d"); // a true fast lane keeps the 7-day window
    expect(kept).not.toContain("congress-stale"); // beyond 60 days, dropped
  });
});

describe("curation keeps SELLS alongside buys (acceptance b)", () => {
  it("a mixed, in-window feed surfaces both insider buys and sells", () => {
    const feed = [
      mkEvent({ id: "buy", kind: "insider_buy", severity: "elevated", actor: { name: "Ann CEO" }, surfacedAt: daysAgo(1) }),
      mkEvent({ id: "sell", kind: "insider_sell", severity: "watch", actor: { name: "Bo CFO" }, surfacedAt: daysAgo(1) }),
      mkEvent({ id: "pol-sell", kind: "politician_trade", severity: "elevated", actor: { name: "Rep X" }, surfacedAt: daysAgo(1), trade: { direction: "sell" } }),
    ];
    const curated = capPerActor(withinWindow(feed, 7, NOW));
    const kinds = new Set(curated.map((e) => e.kind));
    expect(kinds.has("insider_buy")).toBe(true);
    expect(kinds.has("insider_sell")).toBe(true);
    // the day-old congressional SELL survives too
    expect(curated.some((e) => e.id === "pol-sell")).toBe(true);
  });
});
