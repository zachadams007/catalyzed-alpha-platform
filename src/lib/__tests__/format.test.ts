import { describe, expect, it } from "vitest";

import {
  bucketForMarketCap,
  formatCurrency,
  formatMarketCap,
  formatNumber,
  formatPct,
  formatPctPlain,
  formatPrice,
  formatSignedCurrency,
  formatVolume,
  isNonPublicTicker,
  NON_PUBLIC_TICKERS,
  relativeTime,
} from "@/lib/format";

const expectFormatted = (value: string) => {
  expect(value).toEqual(expect.any(String));
  expect(value.length).toBeGreaterThan(0);
  expect(value).not.toMatch(/NaN|undefined/);
};

describe("formatPrice", () => {
  it.each([123.45, 0.000_001, 9_876_543_210.99])(
    "formats %s as a price",
    (value) => {
      const formatted = formatPrice(value);

      expectFormatted(formatted);
      expect(formatted).toContain("$");
    },
  );

  it("preserves grouped-value semantics for positive values", () => {
    expect(formatPrice(1_234_567)).toContain(",");
  });

  it("uses a dash when price data is unavailable", () => {
    expect(formatPrice(0)).toBe("—");
    expect(formatPrice(-1)).toBe("—");
    expect(formatPrice(NaN)).toBe("—");
  });

  it("labels non-USD currencies and keeps bare $ for USD/omitted", () => {
    expect(formatPrice(0.43, "CAD")).toBe("C$0.4300");
    expect(formatPrice(154, "CAD")).toBe("C$154.00");
    expect(formatPrice(108.95, "USD")).toBe("$108.95");
    expect(formatPrice(108.95)).toBe("$108.95");
    expect(formatPrice(10, "GBP")).toContain("£");
  });
});

describe("formatCurrency", () => {
  it.each([1_234.56, 0, -987.65, 0.000_001, 9_876_543_210.99])(
    "formats %s as currency",
    (value) => {
      const formatted = formatCurrency(value);

      expectFormatted(formatted);
      expect(formatted).toContain("$");
    },
  );

  it("distinguishes positive, zero, and negative values", () => {
    expect(formatCurrency(1)).not.toContain("-");
    expect(formatCurrency(0)).not.toContain("-");
    expect(formatCurrency(-1)).toContain("-");
  });
});

describe("formatSignedCurrency", () => {
  it.each([1_234.56, 0, -987.65, 0.000_001, -9_876_543_210.99])(
    "formats %s as explicitly signed currency",
    (value) => {
      const formatted = formatSignedCurrency(value);

      expectFormatted(formatted);
      expect(formatted).toContain("$");
    },
  );

  it("adds the expected sign", () => {
    expect(formatSignedCurrency(1)).toContain("+");
    expect(formatSignedCurrency(0)).not.toContain("+");
    expect(formatSignedCurrency(0)).not.toContain("-");
    expect(formatSignedCurrency(-1)).toContain("-");
  });
});

describe("formatNumber", () => {
  it.each([1_234.56, 0, -987.65, 0.000_001, 9_876_543_210.99])(
    "formats %s as a locale-aware number",
    (value) => {
      const formatted = formatNumber(value);

      expectFormatted(formatted);
      expect(formatted).not.toMatch(/[$%]/);
    },
  );

  it("groups large values and retains a negative sign", () => {
    expect(formatNumber(1_234_567)).toContain(",");
    expect(formatNumber(-1)).toContain("-");
  });
});

describe("formatPct", () => {
  it.each([12.345, 0, -12.345, 0.000_001, 1_000_000])(
    "formats %s as an explicitly signed percentage",
    (value) => {
      const formatted = formatPct(value);

      expectFormatted(formatted);
      expect(formatted).toContain("%");
    },
  );

  it("adds the expected sign", () => {
    expect(formatPct(1)).toContain("+");
    expect(formatPct(0)).not.toContain("+");
    expect(formatPct(-1)).toContain("-");
  });
});

describe("formatPctPlain", () => {
  it.each([12.345, 0, -12.345, 0.000_001, 1_000_000])(
    "formats %s as an unsigned percentage",
    (value) => {
      const formatted = formatPctPlain(value);

      expectFormatted(formatted);
      expect(formatted).toContain("%");
    },
  );

  it("does not add a positive sign but retains a negative sign", () => {
    expect(formatPctPlain(1)).not.toContain("+");
    expect(formatPctPlain(0)).not.toContain("+");
    expect(formatPctPlain(-1)).toContain("-");
  });
});

describe("formatMarketCap", () => {
  it.each([500_000_000, 1, 9_876_543_210_000])(
    "formats %s as a market capitalization",
    (value) => {
      const formatted = formatMarketCap(value);

      expectFormatted(formatted);
      expect(formatted).toContain("$");
    },
  );

  it("switches units at the billion and trillion boundaries", () => {
    expect(formatMarketCap(999_999_999)).not.toContain("B");
    expect(formatMarketCap(1_000_000_000)).toContain("B");
    expect(formatMarketCap(999_999_999_999)).not.toContain("T");
    expect(formatMarketCap(1_000_000_000_000)).toContain("T");
  });

  it("never prints $0 — dashes a missing/zero/invalid cap", () => {
    // Prime Directive: a missing or zero cap must read as absent (" - "), never "$0".
    expect(formatMarketCap(0)).toBe("—");
    expect(formatMarketCap(-500_000_000)).toBe("—");
    expect(formatMarketCap(NaN)).toBe("—");
    expect(formatMarketCap(Infinity)).toBe("—");
    expect(formatMarketCap(undefined as unknown as number)).toBe("—");
    expect(formatMarketCap(null as unknown as number)).toBe("—");
  });

  it("still formats a real trillion-scale cap", () => {
    // NVDA ~ $5.11T market cap, June 19 2026 (companiesmarketcap.com / stockanalysis.com).
    expect(formatMarketCap(5.11e12)).toBe("$5.11T");
  });
});

describe("formatVolume", () => {
  it.each([12_345_678, 0, -12_345_678, 1, 9_876_543_210])(
    "formats %s as volume",
    (value) => {
      const formatted = formatVolume(value);

      expectFormatted(formatted);
      expect(formatted).toContain("$");
      expect(formatted).not.toContain("%");
    },
  );

  it("switches units at the million and billion boundaries", () => {
    expect(formatVolume(999_999)).not.toContain("M");
    expect(formatVolume(1_000_000)).toContain("M");
    expect(formatVolume(999_999_999)).not.toContain("B");
    expect(formatVolume(1_000_000_000)).toContain("B");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-06-13T16:00:00.000Z");

  const formatAgo = (milliseconds: number) =>
    relativeTime(
      ...([
        new Date(now.getTime() - milliseconds).toISOString(),
        now,
      ] as unknown as Parameters<typeof relativeTime>),
    );

  it.each([
    ["now", 0],
    ["one second", 1_000],
    ["smallest minute", 60_000],
    ["smallest hour", 60 * 60_000],
    ["smallest day", 24 * 60 * 60_000],
    ["large day count", 400 * 24 * 60 * 60_000],
  ] as const)("formats a deterministic %s value", (_label, milliseconds) => {
    const formatted = formatAgo(milliseconds);

    expectFormatted(formatted);
    expect(formatAgo(milliseconds)).toBe(formatted);
  });

  // `relativeTime` rounds (Math.round), so assert with values that land
  // unambiguously inside each unit bucket rather than on the raw boundary.
  it("changes units at the seconds-to-minutes boundary", () => {
    expect(formatAgo(10_000)).toBe("just now");
    expect(formatAgo(5 * 60_000)).toMatch(/\d+m ago/);
  });

  it("changes units at the minutes-to-hours boundary", () => {
    expect(formatAgo(50 * 60_000)).toMatch(/\d+m ago/);
    expect(formatAgo(60 * 60_000)).toMatch(/\d+h ago/);
  });

  it("changes units at the hours-to-days boundary", () => {
    expect(formatAgo(20 * 60 * 60_000)).toMatch(/\d+h ago/);
    expect(formatAgo(24 * 60 * 60_000)).toMatch(/\d+d ago/);
  });
});

describe("bucketForMarketCap", () => {
  it("buckets a real mega-cap (NVDA-scale ~$5T) as Mega — never Nano", () => {
    expect(bucketForMarketCap(4.95e12)).toBe("Mega");
    expect(bucketForMarketCap(2e11)).toBe("Mega"); // exact floor
  });

  it("buckets the standard tiers correctly", () => {
    expect(bucketForMarketCap(5e10)).toBe("Large");
    expect(bucketForMarketCap(5e9)).toBe("Mid");
    expect(bucketForMarketCap(5e8)).toBe("Small");
    expect(bucketForMarketCap(1e8)).toBe("Micro");
    expect(bucketForMarketCap(1e7)).toBe("Nano");
  });

  it("returns Unknown (NOT Nano) for a missing/zero/garbage cap", () => {
    // This is the NVDA→Nano bug: a megacap whose live cap failed to populate
    // must NOT fall into the smallest bucket and match a small-cap filter.
    expect(bucketForMarketCap(0)).toBe("Unknown");
    expect(bucketForMarketCap(Number.NaN)).toBe("Unknown");
    expect(bucketForMarketCap(-5)).toBe("Unknown");
    expect(bucketForMarketCap(Number.POSITIVE_INFINITY)).toBe("Unknown");
  });
});

describe("isNonPublicTicker / NON_PUBLIC_TICKERS", () => {
  it("does NOT flag SPCX — SpaceX IPO'd on NASDAQ (2026-06-12) and is a real public mega-cap now", () => {
    expect(isNonPublicTicker("SPCX")).toBe(false);
    expect(isNonPublicTicker(" spcx ")).toBe(false);
  });

  it("does not flag real public tickers", () => {
    expect(isNonPublicTicker("NVDA")).toBe(false);
    expect(isNonPublicTicker("AAPL")).toBe(false);
  });

  it("carries no private/non-tradeable pseudo-tickers (the denylist is empty)", () => {
    expect(NON_PUBLIC_TICKERS.size).toBe(0);
  });
});
