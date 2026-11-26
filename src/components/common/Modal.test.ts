import { describe, it, expect } from "vitest";
import { nextTrapFocus, FOCUSABLE_SELECTOR } from "./Modal";

// The trap's correctness lives entirely in `nextTrapFocus`: where focus goes
// when Tab/Shift+Tab would otherwise leave the dialog. Exercised with plain
// tokens so the cycling rules are verified without a DOM renderer (the repo's
// vitest runs in the node environment).
describe("nextTrapFocus", () => {
  const set = ["first", "mid", "last"] as const;

  it("wraps from the last element to the first on Tab", () => {
    expect(nextTrapFocus(set, "last", false)).toBe("first");
  });

  it("wraps from the first element to the last on Shift+Tab", () => {
    expect(nextTrapFocus(set, "first", true)).toBe("last");
  });

  it("lets the browser advance interior elements (returns null)", () => {
    expect(nextTrapFocus(set, "mid", false)).toBeNull();
    expect(nextTrapFocus(set, "mid", true)).toBeNull();
  });

  it("does not redirect at the non-boundary edge in each direction", () => {
    // Tab on the first element is interior movement -> browser handles it.
    expect(nextTrapFocus(set, "first", false)).toBeNull();
    // Shift+Tab on the last element is interior movement -> browser handles it.
    expect(nextTrapFocus(set, "last", true)).toBeNull();
  });

  it("pulls focus back into the set when it has escaped", () => {
    expect(nextTrapFocus(set, null, false)).toBe("first");
    expect(nextTrapFocus(set, null, true)).toBe("last");
    expect(nextTrapFocus(set, "outside", false)).toBe("first");
    expect(nextTrapFocus(set, "outside", true)).toBe("last");
  });

  it("returns null when there is nothing focusable", () => {
    expect(nextTrapFocus([], "first", false)).toBeNull();
    expect(nextTrapFocus([], null, true)).toBeNull();
  });

  it("handles a single focusable element by wrapping onto itself", () => {
    const one = ["only"] as const;
    expect(nextTrapFocus(one, "only", false)).toBe("only");
    expect(nextTrapFocus(one, "only", true)).toBe("only");
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("targets the standard focusable controls", () => {
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("a[href]");
    expect(FOCUSABLE_SELECTOR).toContain("input:not([disabled]):not([type='hidden'])");
  });

  it("excludes elements removed from the tab order", () => {
    expect(FOCUSABLE_SELECTOR).toContain("[tabindex]:not([tabindex='-1'])");
    expect(FOCUSABLE_SELECTOR).not.toContain("[tabindex='-1'],");
  });
});
