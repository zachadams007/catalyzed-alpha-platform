import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live-model seam: getActiveVariant() is what EVERY engine hot path reads to
 * decide which model ranks the feed. After the global-promote change it must be
 * GLOBAL-FIRST - when Supabase is configured it reflects the operator's
 * server-side `app_controls.active_variant` (so a promote on the operator's
 * device switches the model for every client), and falls back to the device-local
 * override only on an unconfigured (dev) build. This locks both halves.
 *
 * globalControls + variantOverride are mocked so we can drive each branch without
 * a network or localStorage.
 */

const { isConfigured, getControls, getLocalOverride } = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  getControls: vi.fn(),
  getLocalOverride: vi.fn(),
}));

vi.mock("@/data/globalControls", () => ({
  isGlobalControlsConfigured: () => isConfigured(),
  getGlobalControls: () => getControls(),
}));

vi.mock("@/engine/variantOverride", () => ({
  getVariantOverride: () => getLocalOverride(),
  setVariantOverride: vi.fn(),
}));

import { getActiveVariant } from "@/engine/challenger";

beforeEach(() => {
  isConfigured.mockReset();
  getControls.mockReset();
  getLocalOverride.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getActiveVariant — global-first live model", () => {
  it("uses the GLOBAL active_variant when Supabase is configured (app-wide promote)", () => {
    isConfigured.mockReturnValue(true);
    getControls.mockReturnValue({ activeVariant: "challenger" });
    // Even if a stale device-local override exists, the global value wins.
    getLocalOverride.mockReturnValue("champion");

    expect(getActiveVariant()).toBe("challenger");
    // The device-local override is NOT consulted when global is configured, so a
    // non-operator device can't override the globally-promoted model.
    expect(getLocalOverride).not.toHaveBeenCalled();
  });

  it("falls back to the build-flag default while the global row is still loading", () => {
    isConfigured.mockReturnValue(true);
    getControls.mockReturnValue(null); // configured but not yet loaded
    expect(getActiveVariant()).toBe("challenger"); // current shipped default
  });

  it("uses the device-local override only when Supabase is unconfigured (dev)", () => {
    isConfigured.mockReturnValue(false);
    getLocalOverride.mockReturnValue("challenger");
    expect(getActiveVariant()).toBe("challenger");
  });

  it("defaults to V5/challenger when unconfigured and no local override is set", () => {
    isConfigured.mockReturnValue(false);
    getLocalOverride.mockReturnValue(null);
    expect(getActiveVariant()).toBe("challenger");
  });
});
