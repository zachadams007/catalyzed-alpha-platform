import { describe, expect, it } from "vitest";

import {
  appendOutcomes,
  emptyLedger,
  filterLedgerByVariant,
  LEDGER_SCHEMA_VERSION,
  ledgerVersionsPresent,
  normalizeLedger,
  type OutcomeLedger,
} from "@/engine/outcomeLedger";
import type { StockSignal } from "@/types";

/**
 * Track Record engine-version tagging (ledger schema v3).
 *
 * The ledger stored both models' scores for every pick but never WHICH engine
 * was live when the pick was published, so a new version's record was mixed
 * into the old one's and could not be judged on its own. These tests pin the
 * stamp, the filter, and the forward migration of untagged history.
 */

function signal(ticker: string, price = 100): StockSignal {
  return {
    ticker,
    name: `${ticker} Inc`,
    price,
    score: { opportunityScore: 70, confidence: 60, categories: [] },
    confidence: 60,
  } as unknown as StockSignal;
}

describe("ledger v3 — engine version stamp", () => {
  it("stamps each recorded pick with the live engine variant", () => {
    const led = appendOutcomes(emptyLedger(), [signal("AAA")], "2026-09-17T13:00:00.000Z", {
      liveVariant: "v7",
    });
    expect(led.entries).toHaveLength(1);
    expect(led.entries[0]!.liveVariant).toBe("v7");
  });

  it("leaves the field absent when no variant is supplied (never guesses)", () => {
    const led = appendOutcomes(emptyLedger(), [signal("AAA")], "2026-09-17T13:00:00.000Z");
    expect(led.entries[0]!.liveVariant).toBeUndefined();
  });

  it("bumped the schema version", () => {
    expect(LEDGER_SCHEMA_VERSION).toBe(3);
  });
});

describe("ledger v3 — forward migration", () => {
  it("loads pre-v3 entries as untagged rather than dropping them", () => {
    const legacy = {
      schemaVersion: 2,
      droppedCount: 0,
      entries: [
        {
          ticker: "OLD",
          name: "Old Co",
          publishedAtISO: "2026-07-25T13:00:00.000Z",
          opportunityScore: 80,
          confidence: 55,
          categoryScores: {},
          priceAtPublish: 50,
          forwardReturns: {},
        },
      ],
    };
    const led = normalizeLedger(legacy);
    expect(led.entries).toHaveLength(1);
    expect(led.entries[0]!.liveVariant).toBeUndefined();
  });

  it("drops an UNKNOWN variant id (a retired version) but keeps the entry", () => {
    const weird = {
      schemaVersion: 3,
      droppedCount: 0,
      entries: [
        {
          ticker: "X",
          name: "X",
          publishedAtISO: "2026-09-01T13:00:00.000Z",
          opportunityScore: 60,
          confidence: 50,
          categoryScores: {},
          priceAtPublish: 10,
          forwardReturns: {},
          liveVariant: "v99",
        },
      ],
    };
    const led = normalizeLedger(weird);
    expect(led.entries).toHaveLength(1);
    expect(led.entries[0]!.liveVariant).toBeUndefined();
  });
});

describe("ledger v3 — filtering by version", () => {
  const mixed: OutcomeLedger = appendOutcomes(
    appendOutcomes(
      appendOutcomes(emptyLedger(), [signal("A"), signal("B")], "2026-07-25T13:00:00.000Z"),
      [signal("C")],
      "2026-08-10T13:00:00.000Z",
      { liveVariant: "challenger" },
    ),
    [signal("D"), signal("E"), signal("F")],
    "2026-09-17T13:00:00.000Z",
    { liveVariant: "v7" },
  );

  it("'all' returns every pick and preserves droppedCount", () => {
    expect(filterLedgerByVariant(mixed, "all").entries).toHaveLength(6);
  });

  it("a version returns only that version's picks", () => {
    expect(filterLedgerByVariant(mixed, "v7").entries.map((e) => e.ticker)).toEqual(["D", "E", "F"]);
    expect(filterLedgerByVariant(mixed, "challenger").entries.map((e) => e.ticker)).toEqual(["C"]);
  });

  it("'untagged' returns the pre-tagging history only", () => {
    expect(filterLedgerByVariant(mixed, "untagged").entries.map((e) => e.ticker)).toEqual(["A", "B"]);
  });

  it("a version with no picks yields an empty slice, not an error", () => {
    expect(filterLedgerByVariant(mixed, "v6").entries).toHaveLength(0);
  });

  it("reports which versions are actually present, in engine order", () => {
    const present = ledgerVersionsPresent(mixed);
    expect(present.variants).toEqual(["challenger", "v7"]);
    expect(present.hasUntagged).toBe(true);
  });
});
