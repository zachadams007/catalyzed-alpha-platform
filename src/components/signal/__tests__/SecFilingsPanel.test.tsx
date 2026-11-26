import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SecActivity } from "@/types";
import { SecFilingsPanel } from "@/components/signal/SecFilingsPanel";

/**
 * Regression: opening a stock's detail page crashed to the error boundary
 * ("gray screen") whenever its `secActivity` arrived WITHOUT a `filings` array -
 * `SecFilingsPanel` did `activity.filings.slice(...)` unguarded. A `secActivity`
 * can legitimately carry only aggregate counts (e.g. the insider-cluster rollup)
 * or be a cached/older shape, so the panel must degrade, never throw.
 */
describe("SecFilingsPanel — null-safe filings", () => {
  const full: SecActivity = {
    cik: "0000320193",
    form4Count90d: 2,
    eightKCount90d: 1,
    filings: [
      { form: "4", filedAt: "2026-06-10T00:00:00Z", url: "https://sec.gov/x/form4.xml" },
      { form: "8-K", filedAt: "2026-06-05T00:00:00Z", url: "https://sec.gov/x/8k.htm" },
    ],
  };

  it("renders with a normal activity (filings present)", () => {
    const html = renderToStaticMarkup(<SecFilingsPanel activity={full} />);
    expect(html).toContain("SEC filings");
  });

  it("does NOT throw when `filings` is undefined (counts-only activity)", () => {
    // The exact crashing shape: aggregate counts but no per-filing list.
    const countsOnly = {
      cik: "0000000000",
      form4Count90d: 5,
      eightKCount90d: 0,
    } as unknown as SecActivity;
    expect(() => renderToStaticMarkup(<SecFilingsPanel activity={countsOnly} />)).not.toThrow();
    const html = renderToStaticMarkup(<SecFilingsPanel activity={countsOnly} />);
    // Counts still surface; the (absent) filing list simply isn't rendered.
    expect(html).toContain("5");
  });

  it("does NOT throw when `filings` is an empty array", () => {
    const empty: SecActivity = { ...full, filings: [] };
    expect(() => renderToStaticMarkup(<SecFilingsPanel activity={empty} />)).not.toThrow();
  });
});
