import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_VENDORS,
  PROXY_BACKUP_META,
  getUsageSnapshot,
  type ApiVendorId,
} from "@/lib/apiUsage";

// The Gemini-backup row is gated on the client-visible presence flag
// `VITE_GEMINI_API_KEY_BACKUP` (the real key lives server-side on the research
// proxy). Neutralize it before each test so the ambient .env can't leak in, then
// opt in per-case - mirrors src/data/__tests__/vendorReach.test.ts.
beforeEach(() => {
  vi.stubEnv("VITE_GEMINI_API_KEY_BACKUP", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ids = (): ApiVendorId[] => getUsageSnapshot().vendors.map((v) => v.meta.id);

describe("Gemini (backup) board row — mirrors the Finnhub backup pattern", () => {
  it("stays OUT of API_VENDORS, so the budget editor keeps a single Research-proxy cap", () => {
    expect(API_VENDORS.some((v) => v.id === "proxy_backup")).toBe(false);
    // The one editable Gemini/Research-proxy slot is still "proxy".
    expect(API_VENDORS.some((v) => v.id === "proxy")).toBe(true);
    expect(PROXY_BACKUP_META).toMatchObject({
      id: "proxy_backup",
      name: "Gemini (backup)",
      provider: "Gemini",
      keyed: true,
    });
  });

  it("does NOT render the backup row when no backup key is configured", () => {
    expect(ids()).not.toContain("proxy_backup");
  });

  it("renders the backup row only when VITE_GEMINI_API_KEY_BACKUP is set", () => {
    vi.stubEnv("VITE_GEMINI_API_KEY_BACKUP", "present");
    expect(ids()).toContain("proxy_backup");
  });

  it("injects the backup row immediately after the Research Proxy row", () => {
    vi.stubEnv("VITE_GEMINI_API_KEY_BACKUP", "present");
    const order = ids();
    const proxyIdx = order.indexOf("proxy");
    expect(proxyIdx).toBeGreaterThanOrEqual(0);
    expect(order[proxyIdx + 1]).toBe("proxy_backup");
  });

  it("leaves the Finnhub backup row (and its placement after main Finnhub) intact", () => {
    vi.stubEnv("VITE_GEMINI_API_KEY_BACKUP", "present");
    const order = ids();
    const finnhubIdx = order.indexOf("finnhub");
    expect(finnhubIdx).toBeGreaterThanOrEqual(0);
    expect(order[finnhubIdx + 1]).toBe("finnhub_backup");
  });
});
