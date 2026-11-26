import { describe, it, expect } from "vitest";
import { sanitizeEvent, sanitizeEvents } from "@/data/terminal/terminalFeed";
import type { TerminalEvent } from "@/types/terminal";

/** A fully valid baseline event we can mutate into malformed variants. */
function baseEvent(): TerminalEvent {
  return {
    id: "8k-0001-26-000001",
    kind: "filing_8k",
    severity: "elevated",
    ticker: "AAPL",
    headline: "Apple Inc. — Results of Operations",
    occurredAt: "2026-06-15T12:00:00.000Z",
    surfacedAt: "2026-06-15T12:00:00.000Z",
    source: { name: "SEC 8-K · EDGAR", url: "https://www.sec.gov/x" },
    reason: "8-K: Results",
  };
}

describe("sanitizeEvent", () => {
  it("passes a well-formed event through with its fields intact", () => {
    const e = sanitizeEvent(baseEvent());
    expect(e).not.toBeNull();
    expect(e!.id).toBe("8k-0001-26-000001");
    expect(e!.source.url).toBe("https://www.sec.gov/x");
    expect(e!.kind).toBe("filing_8k");
  });

  it("drops events that can't be rendered or deduped (no id / headline)", () => {
    expect(sanitizeEvent({ ...baseEvent(), id: "" })).toBeNull();
    expect(sanitizeEvent({ ...baseEvent(), headline: "   " })).toBeNull();
    expect(sanitizeEvent(null)).toBeNull();
    expect(sanitizeEvent(undefined)).toBeNull();
  });

  it("repairs a missing/invalid source instead of letting the render null-deref", () => {
    // This is the exact crash vector: Terminal.tsx reads e.source.url.
    const noSource = sanitizeEvent({ ...baseEvent(), source: undefined as unknown as TerminalEvent["source"] });
    expect(noSource).not.toBeNull();
    expect(noSource!.source).toEqual({ name: "Source", url: "" });

    const badUrl = sanitizeEvent({ ...baseEvent(), source: { name: "X", url: "javascript:alert(1)" } });
    expect(badUrl!.source.url).toBe(""); // only http(s) URLs survive
  });

  it("coerces non-finite trade numbers so .toFixed/.toLocaleString can't throw", () => {
    const e = sanitizeEvent({
      ...baseEvent(),
      kind: "insider_buy",
      trade: { direction: "buy", pricePerShare: "abc" as unknown as number, shares: NaN, valueUsd: 1234 },
    });
    expect(e!.trade?.pricePerShare).toBeUndefined();
    expect(e!.trade?.shares).toBeUndefined();
    expect(e!.trade?.valueUsd).toBe(1234);
  });

  it("coerces unknown kind / severity to safe defaults", () => {
    const e = sanitizeEvent({
      ...baseEvent(),
      kind: "wat" as unknown as TerminalEvent["kind"],
      severity: "nope" as unknown as TerminalEvent["severity"],
    });
    expect(e!.kind).toBe("catalyst_news");
    expect(e!.severity).toBe("watch");
  });

  it("normalizes unparseable timestamps to a valid ISO string", () => {
    const e = sanitizeEvent({ ...baseEvent(), occurredAt: "not-a-date", surfacedAt: "" });
    expect(Number.isFinite(Date.parse(e!.occurredAt))).toBe(true);
    expect(Number.isFinite(Date.parse(e!.surfacedAt))).toBe(true);
  });
});

describe("sanitizeEvents", () => {
  it("keeps the good and drops the unrenderable", () => {
    const good = baseEvent();
    const bad = { ...baseEvent(), id: "" };
    const out = sanitizeEvents([good, bad as TerminalEvent]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(good.id);
  });
});
