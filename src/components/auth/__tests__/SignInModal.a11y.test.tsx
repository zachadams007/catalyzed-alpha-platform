import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The auth store touches `window` at import time - install a stand-in first.
(globalThis as { window?: unknown }).window = {
  setTimeout: ((fn: () => void, ms?: number) =>
    globalThis.setTimeout(fn, ms)) as typeof window.setTimeout,
  clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as typeof window.clearTimeout,
};

// Modal renders through a document.body portal; the node env has no DOM, so
// stub it to an inline passthrough - we only assert on the form's own markup.
vi.mock("@/components/common/Modal", () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { SignInModal } = await import("@/components/auth/SignInModal");

/**
 * A11y regression: every field must link its <label> to its <input> via
 * htmlFor/id so screen readers announce the control's name.
 */
function render() {
  return renderToStaticMarkup(<SignInModal onClose={() => {}} />);
}

/** Count of <label for="X"> that have a matching <input id="X">. */
function pairedLabels(html: string): number {
  const forIds = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
  return forIds.filter((id) => html.includes(`<input id="${id}"`)).length;
}

describe("SignInModal — label/field association", () => {
  it("links the sign-in fields (email + password) to their labels", () => {
    const html = render();
    // Default mode is sign-in: email + password are both present and paired.
    expect(pairedLabels(html)).toBeGreaterThanOrEqual(2);
    // No bare <label> without a `for` should slip through for the visible fields.
    const bareLabels = [...html.matchAll(/<label(?![^>]*\bfor=)[^>]*>/g)].length;
    expect(bareLabels).toBe(0);
  });

  it("associates exactly the two sign-in fields (email + password)", () => {
    const html = render();
    // Both visible inputs must be id-linked to a label; neither label is bare.
    expect(pairedLabels(html)).toBe(2);
    // The labels we expect are present.
    expect(html).toContain("Email");
    expect(html).toContain("Password");
  });
});
