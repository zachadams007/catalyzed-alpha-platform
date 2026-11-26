import { describe, it, expect } from "vitest";

import { resolveSymbolFromQuery, SymbolResolveError } from "@/data/finnhub/symbolSearch";

// The offline directory is consulted FIRST, so these resolve with no API key and
// no network - the exact ship-blocker the directory was added to fix.
describe("resolveSymbolFromQuery — offline directory first", () => {
  it("resolves real US tickers to their exact symbol", async () => {
    await expect(resolveSymbolFromQuery("INFQ")).resolves.toBe("INFQ");
    await expect(resolveSymbolFromQuery("BLDP")).resolves.toBe("BLDP");
    await expect(resolveSymbolFromQuery("OKLO")).resolves.toBe("OKLO");
  });

  it("is case-insensitive on the ticker", async () => {
    await expect(resolveSymbolFromQuery("  oklo ")).resolves.toBe("OKLO");
  });

  it("preserves Canadian exchange suffixes — never strips .TO / .NE / .V", async () => {
    await expect(resolveSymbolFromQuery("GCU.TO")).resolves.toBe("GCU.TO");
    await expect(resolveSymbolFromQuery("DEFI.NE")).resolves.toBe("DEFI.NE");
    await expect(resolveSymbolFromQuery("mda.to")).resolves.toBe("MDA.TO");
  });

  it("resolves a company name to its listed symbol", async () => {
    await expect(resolveSymbolFromQuery("apple")).resolves.toBe("AAPL");
  });

  it("never throws 'not found' for a directory-known symbol, with no key", async () => {
    // A directory hit short-circuits before the missing-key branch entirely.
    await expect(resolveSymbolFromQuery("GCU.TO")).resolves.toBe("GCU.TO");
  });

  it("still rejects an empty query", async () => {
    await expect(resolveSymbolFromQuery("   ")).rejects.toBeInstanceOf(SymbolResolveError);
  });
});
