import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_VENDORS,
  VISION_META,
  getUsageSnapshot,
  vendorMeta,
  vendorOf,
  visionBoardRows,
  type ApiVendorId,
} from "@/lib/apiUsage";

// The Vision (Groq) row is opt-in: it only exists when the operator sets
// VITE_VISION_API_KEY (the screenshot reader runs locally against that key).
// Neutralize the ambient .env before each test, then opt in per-case - mirrors
// the Gemini-backup pattern in apiUsage.proxyBackup.test.ts.
beforeEach(() => {
  vi.stubEnv("VITE_VISION_API_KEY", "");
  vi.stubEnv("VITE_VISION_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ids = (): ApiVendorId[] => getUsageSnapshot().vendors.map((v) => v.meta.id);

describe("Vision (Groq) board row — opt-in keyed provider", () => {
  it("stays OUT of the static API_VENDORS (so it doesn't show a phantom row unkeyed)", () => {
    expect(API_VENDORS.some((v) => v.id === "vision")).toBe(false);
    expect(VISION_META).toMatchObject({
      id: "vision",
      name: "Vision (Groq)",
      provider: "Groq",
      keyed: true,
    });
  });

  it("does NOT render the vision row when no key is configured", () => {
    expect(ids()).not.toContain("vision");
    expect(visionBoardRows()).toHaveLength(0);
  });

  it("renders the vision row only when VITE_VISION_API_KEY is set", () => {
    vi.stubEnv("VITE_VISION_API_KEY", "gsk_test");
    expect(ids()).toContain("vision");
    expect(visionBoardRows()).toHaveLength(1);
  });

  it("resolves vendorMeta('vision') to the Vision provider identity", () => {
    expect(vendorMeta("vision")).toMatchObject({ name: "Vision (Groq)", provider: "Groq" });
  });
});

describe("vendorOf() buckets vision endpoints to the 'vision' lane", () => {
  it("maps the default Groq base URL to 'vision'", () => {
    expect(vendorOf("https://api.groq.com/openai/v1/chat/completions")).toBe("vision");
  });

  it("maps a configured VITE_VISION_BASE_URL host to 'vision'", () => {
    vi.stubEnv("VITE_VISION_BASE_URL", "https://openrouter.ai/api/v1");
    expect(vendorOf("https://openrouter.ai/api/v1/chat/completions")).toBe("vision");
  });

  it("does not misattribute unrelated hosts to 'vision'", () => {
    expect(vendorOf("https://finnhub.io/api/v1/quote")).toBe("finnhub");
  });
});
