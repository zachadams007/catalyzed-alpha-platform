import { describe, expect, it } from "vitest";
import { isUsMarketOpen, marketSession, quoteIsFresh, sessionLabel } from "@/lib/marketStatus";

// Anchors: 2026-06-26 is a Friday; June is EDT (UTC-4), so ET = UTC − 4h.
const at = (iso: string) => new Date(iso);

describe("marketSession", () => {
  it("is open during the regular cash session", () => {
    expect(marketSession(at("2026-06-26T14:00:00Z"))).toBe("open"); // 10:00 ET Fri
    expect(marketSession(at("2026-06-26T13:30:00Z"))).toBe("open"); // 09:30 ET - open boundary
    expect(marketSession(at("2026-06-26T19:59:00Z"))).toBe("open"); // 15:59 ET
    expect(isUsMarketOpen(at("2026-06-26T14:00:00Z"))).toBe(true);
  });

  it("flags pre-market before 9:30 ET", () => {
    expect(marketSession(at("2026-06-26T13:00:00Z"))).toBe("premarket"); // 09:00 ET
    expect(marketSession(at("2026-06-26T08:00:00Z"))).toBe("premarket"); // 04:00 ET - pre boundary
  });

  it("flags after-hours from 16:00 to 20:00 ET", () => {
    expect(marketSession(at("2026-06-26T20:00:00Z"))).toBe("afterhours"); // 16:00 ET - close boundary
    expect(marketSession(at("2026-06-26T23:00:00Z"))).toBe("afterhours"); // 19:00 ET
  });

  it("is closed overnight and on weekends", () => {
    expect(marketSession(at("2026-06-27T00:30:00Z"))).toBe("closed"); // 20:30 ET Fri (after 20:00)
    expect(marketSession(at("2026-06-26T07:00:00Z"))).toBe("closed"); // 03:00 ET Fri (before pre)
    expect(marketSession(at("2026-06-27T16:00:00Z"))).toBe("closed"); // 12:00 ET Saturday
    expect(marketSession(at("2026-06-28T16:00:00Z"))).toBe("closed"); // 12:00 ET Sunday
    expect(isUsMarketOpen(at("2026-06-27T16:00:00Z"))).toBe(false);
  });
});

describe("quoteIsFresh", () => {
  it("is fresh only when open AND the data is recent", () => {
    const now = at("2026-06-26T14:00:00Z"); // 10:00 ET, market open
    expect(quoteIsFresh("2026-06-26T13:58:00Z", now)).toBe(true); // 2 min old
    expect(quoteIsFresh("2026-06-26T13:40:00Z", now)).toBe(false); // 20 min old → stale
  });

  it("is never fresh when the market is closed", () => {
    const sat = at("2026-06-27T16:00:00Z");
    expect(quoteIsFresh("2026-06-27T16:00:00Z", sat)).toBe(false);
  });

  it("is not fresh without a usable timestamp", () => {
    const now = at("2026-06-26T14:00:00Z");
    expect(quoteIsFresh(null, now)).toBe(false);
    expect(quoteIsFresh("not-a-date", now)).toBe(false);
  });
});

describe("sessionLabel", () => {
  it("maps each session to an honest label", () => {
    expect(sessionLabel("open")).toBe("Live IEX");
    expect(sessionLabel("premarket")).toBe("Pre-market");
    expect(sessionLabel("afterhours")).toBe("After hours");
    expect(sessionLabel("closed")).toBe("Markets closed");
  });
});
