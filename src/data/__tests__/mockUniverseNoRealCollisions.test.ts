import { describe, expect, it } from "vitest";
import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { getSymbol } from "@/data/symbols/symbolDirectory";

/**
 * Defense-in-depth (B-1): the fictional sample universe must NEVER reuse a REAL
 * listed symbol. If the fail-closed gate ever regresses and the mock universe
 * leaks under a "Live data" badge, a fictional company on a real ticker (e.g.
 * "Aegis Cyber Defense" on CYBR / CyberArk, "Luminax Photonics" on LUMN / Lumen,
 * "Ridge AI" on RIDG) is the worst-case data-integrity bug. This test makes the
 * sample universe collision-proof against the bundled real-listing directory so
 * the names are unmistakably synthetic.
 *
 * The check is EXACT-SYMBOL (`getSymbol`), not the fuzzy name search: the bug is a
 * fictional ticker EQUALLING a real symbol. A sample name that merely shares
 * letters with some real company's NAME (e.g. "GigaForge") is not a collision.
 */

describe("MOCK_UNIVERSE — no fictional ticker collides with a real listing", () => {
  it("every sample ticker is absent from the offline symbol directory", () => {
    const collisions = MOCK_UNIVERSE.filter((c) => getSymbol(c.ticker) !== null).map(
      (c) => `${c.ticker} (${c.name})`,
    );
    expect(collisions).toEqual([]);
  });

  it("the previously-colliding hero symbols are gone", () => {
    const tickers = new Set(MOCK_UNIVERSE.map((c) => c.ticker));
    for (const real of ["AETH", "BREW", "DRVN", "GENM", "HELX", "LUMN", "MEDX", "NVTX", "QUBX", "SOLR", "VOLT", "CYBR"]) {
      expect(tickers.has(real)).toBe(false);
    }
  });
});
