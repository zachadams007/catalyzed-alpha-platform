import { describe, it, expect } from "vitest";
import { isNewSince, countNewSince } from "@/data/terminal/newSince";

const T0 = "2026-06-15T12:00:00.000Z";
const BEFORE = "2026-06-15T11:00:00.000Z";
const AFTER = "2026-06-15T13:00:00.000Z";

describe("isNewSince", () => {
  it("flags events strictly after the previous visit", () => {
    expect(isNewSince(AFTER, T0)).toBe(true);
  });

  it("does not flag events at or before the previous visit", () => {
    expect(isNewSince(BEFORE, T0)).toBe(false);
    expect(isNewSince(T0, T0)).toBe(false); // equal = already seen
  });

  it("marks nothing on the first visit (null since)", () => {
    expect(isNewSince(AFTER, null)).toBe(false);
  });

  it("returns false for unparseable timestamps", () => {
    expect(isNewSince("not-a-date", T0)).toBe(false);
    expect(isNewSince(AFTER, "not-a-date")).toBe(false);
  });
});

describe("countNewSince", () => {
  const events = [
    { surfacedAt: AFTER },
    { surfacedAt: AFTER },
    { surfacedAt: BEFORE },
    { surfacedAt: T0 },
  ];

  it("counts only events after the previous visit", () => {
    expect(countNewSince(events, T0)).toBe(2);
  });

  it("returns 0 on the first visit", () => {
    expect(countNewSince(events, null)).toBe(0);
  });

  it("returns 0 for an empty feed", () => {
    expect(countNewSince([], T0)).toBe(0);
  });
});
