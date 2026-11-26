import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// The store touches `window` at import time - install a stand-in first.
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

const { CreatePortfolioModal } = await import("@/components/portfolio/CreatePortfolioModal");

/**
 * A11y regression: name + description fields must be label-associated, and the
 * mode chips must form a labeled radiogroup so the control is announced.
 */
function render() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CreatePortfolioModal onClose={() => {}} />
    </MemoryRouter>,
  );
}

describe("CreatePortfolioModal — accessibility", () => {
  it("links the name + description fields to their labels", () => {
    const html = render();
    const forIds = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
    const paired = forIds.filter(
      (id) => html.includes(`<input id="${id}"`) || html.includes(`<textarea id="${id}"`),
    );
    // Name (input) + Description (textarea).
    expect(paired.length).toBe(2);
  });

  it("exposes the mode chips as a labeled radiogroup", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="true"');
  });
});
