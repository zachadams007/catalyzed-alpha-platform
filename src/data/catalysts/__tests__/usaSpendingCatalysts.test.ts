import { describe, expect, it } from "vitest";

import type { CompanyData } from "@/types";
import {
  type ContractAward,
  awardToCatalystEvent,
  awardsToCatalystEvents,
  buildNameTickerIndex,
  normalizeCompanyName,
  rowToContractAward,
} from "@/data/catalysts/usaSpendingCatalysts";

/**
 * Unit tests for USASpending federal-contract → catalyst mapping: name
 * normalization, universe-anchored name→ticker resolution (no fuzzy matching
 * onto names we don't rank), the materiality $ floor, size-scaled magnitude,
 * Partnership typing, and the raw-row parse. Deterministic (clock injected).
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");

function company(ticker: string, name: string): CompanyData {
  return { ticker, name } as unknown as CompanyData;
}

const UNIVERSE: CompanyData[] = [
  company("LMT", "Lockheed Martin Corporation"),
  company("BA", "The Boeing Company"),
];
const INDEX = buildNameTickerIndex(UNIVERSE);

function award(over: Partial<ContractAward>): ContractAward {
  return {
    awardId: over.awardId ?? "PIID1",
    recipientName: over.recipientName ?? "LOCKHEED MARTIN CORP",
    amountUsd: over.amountUsd ?? 500_000_000,
    agency: over.agency ?? "Department of Defense",
    dateIso: over.dateIso ?? "2026-06-10",
    description: over.description,
    url: over.url ?? "https://www.usaspending.gov/award/X",
  };
}

describe("normalizeCompanyName", () => {
  it("strips suffixes/punctuation so legal-name variants collapse to one key", () => {
    expect(normalizeCompanyName("Lockheed Martin Corp.")).toBe("lockheed martin");
    expect(normalizeCompanyName("LOCKHEED MARTIN CORPORATION")).toBe("lockheed martin");
    expect(normalizeCompanyName("The Boeing Company")).toBe("boeing");
  });
});

describe("awardToCatalystEvent", () => {
  it("maps a large award to a Partnership catalyst on the resolved ticker", () => {
    const e = awardToCatalystEvent(award({}), INDEX, NOW)!;
    expect(e.ticker).toBe("LMT");
    expect(e.catalystType).toBe("Partnership");
    expect(e.magnitude).toBeGreaterThan(0);
    expect(e.summary).toContain("federal contract");
    expect(e.strength).toBeGreaterThan(0);
  });

  it("scales magnitude with award size (a $1B+ award outscores a $20M one)", () => {
    const big = awardToCatalystEvent(award({ amountUsd: 2_000_000_000 }), INDEX, NOW)!;
    const small = awardToCatalystEvent(award({ amountUsd: 20_000_000 }), INDEX, NOW)!;
    expect(big.magnitude).toBeGreaterThan(small.magnitude);
  });

  it("drops awards below the materiality floor", () => {
    expect(awardToCatalystEvent(award({ amountUsd: 1_000_000 }), INDEX, NOW)).toBeNull();
  });

  it("drops recipients not in the universe (no fuzzy match onto unranked names)", () => {
    expect(
      awardToCatalystEvent(award({ recipientName: "SOME PRIVATE CONTRACTOR LLC" }), INDEX, NOW),
    ).toBeNull();
  });
});

describe("awardsToCatalystEvents", () => {
  it("maps a batch, resolving and filtering", () => {
    const out = awardsToCatalystEvents(
      [
        award({ recipientName: "BOEING CO", amountUsd: 800_000_000 }),
        award({ recipientName: "UNKNOWN VENDOR", amountUsd: 800_000_000 }),
      ],
      INDEX,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe("BA");
  });
});

describe("rowToContractAward", () => {
  it("parses a USASpending result row and builds the detail URL", () => {
    const a = rowToContractAward({
      "Award ID": "HT940216C0001",
      "Recipient Name": "HUMANA GOVERNMENT BUSINESS INC",
      "Award Amount": 51_269_205_263.03,
      "Awarding Agency": "Department of Defense",
      "Start Date": "2016-08-01",
      Description: "IGF",
      generated_internal_id: "CONT_AWD_HT940216C0001_9700_-NONE-_-NONE-",
    })!;
    expect(a.recipientName).toBe("HUMANA GOVERNMENT BUSINESS INC");
    expect(a.amountUsd).toBeGreaterThan(5e10);
    expect(a.url).toContain("CONT_AWD_HT940216C0001");
  });

  it("returns null when recipient or amount is missing", () => {
    expect(rowToContractAward({ "Award ID": "X", "Award Amount": 0 })).toBeNull();
    expect(rowToContractAward({ "Recipient Name": "ACME", "Award Amount": 0 })).toBeNull();
  });
});
