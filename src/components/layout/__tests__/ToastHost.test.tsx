import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Toast } from "@/store/useAppStore";

/**
 * A11y regression: after Wave 4, toasts are the PRIMARY error channel, so they
 * must be announced to assistive tech and dismissable by keyboard. Each toast is
 * a focusable <button>; the wrapper is a labeled region; urgent tones (warn)
 * escalate to role="alert" + aria-live="assertive", routine tones stay polite.
 *
 * The store reads `window` at import time, so we stub the selector directly
 * (mirroring the other store-connected SSR tests) and drive `toasts` headlessly.
 */
let stubToasts: Toast[] = [];
vi.mock("@/store/useAppStore", () => ({
  useAppStore: (selector: (s: unknown) => unknown) =>
    selector({ toasts: stubToasts, dismissToast: () => {} }),
}));

const { ToastHost } = await import("@/components/layout/ToastHost");

function render(toasts: Toast[]): string {
  stubToasts = toasts;
  // ToastHost uses useNavigate (actionable toasts navigate on tap), so it must
  // render inside a Router - exactly as it does under AppShell in the app.
  return renderToStaticMarkup(
    <MemoryRouter>
      <ToastHost />
    </MemoryRouter>,
  );
}

describe("ToastHost — accessibility", () => {
  it("renders nothing when the queue is empty", () => {
    expect(render([])).toBe("");
  });

  it("wraps toasts in a labeled notifications region", () => {
    const html = render([{ id: "t1", message: "Saved AAPL", tone: "success" }]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Notifications"');
  });

  it("renders each toast as a keyboard-focusable button (dismissable)", () => {
    const html = render([{ id: "t1", message: "Saved AAPL", tone: "success" }]);
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    // The message is exposed both as text and on the dismiss-affording label.
    expect(html).toContain("Dismiss notification");
  });

  it("announces routine tones politely via role=status / aria-live=polite", () => {
    const html = render([{ id: "t1", message: "Liked AAPL", tone: "success" }]);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('aria-live="assertive"');
  });

  it("escalates warn tones to role=alert / aria-live=assertive", () => {
    const html = render([
      { id: "t1", message: "Couldn't load data for that ticker", tone: "warn" },
    ]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
  });

  it("marks each toast atomic so the whole message is read on update", () => {
    const html = render([{ id: "t1", message: "Info", tone: "info" }]);
    expect(html).toContain('aria-atomic="true"');
  });

  it("renders an actionable (href) toast with a chevron + action affordance", () => {
    const html = render([
      { id: "t1", message: "Sam added you as a friend", tone: "info", href: "/friends" },
    ]);
    expect(html).toContain("toast--action");
    expect(html).toContain("toast__chevron");
    // Actionable toasts label as "Open." rather than "Dismiss".
    expect(html).toContain("Open.");
  });
});
