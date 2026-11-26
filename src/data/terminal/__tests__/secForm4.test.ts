import { describe, it, expect } from "vitest";
import { parseForm4Xml, form4DocToEvents } from "@/data/terminal/secForm4";

/**
 * Fixture modeled on a real EDGAR Form 4 ownership XML (the exact tag structure
 * EDGAR serves: nested <value> amounts, transactionCoding/transactionCode, the
 * reportingOwnerRelationship flags). It carries an open-market PURCHASE (P) plus
 * an AWARD (A) so we can assert the award is filtered out as noise.
 */
const FORM4_BUY_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-06-12</periodOfReport>
  <issuer>
    <issuerCik>0001818874</issuerCik>
    <issuerName>SoFi Technologies, Inc.</issuerName>
    <issuerTradingSymbol>SOFI</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001500382</rptOwnerCik>
      <rptOwnerName>Noto Anthony</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>Chief Executive Officer</officerTitle>
      <isTenPercentOwner>0</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-06-12</value></transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>P</transactionCode>
        <equitySwapInvolved>0</equitySwapInvolved>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100000</value></transactionShares>
        <transactionPricePerShare><value>8.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Restricted Stock Units</value></securityTitle>
      <transactionDate><value>2026-06-12</value></transactionDate>
      <transactionCoding>
        <transactionCode>A</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>5000</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const HIT = {
  accession: "0001500382-26-000045",
  cik: "1500382",
  xmlFile: "form4.xml",
  fileDateIso: "2026-06-13T00:00:00.000Z",
};

describe("parseForm4Xml", () => {
  it("extracts issuer, owner, role, and every transaction", () => {
    const doc = parseForm4Xml(FORM4_BUY_XML);
    expect(doc).not.toBeNull();
    expect(doc!.issuerSymbol).toBe("SOFI");
    expect(doc!.issuerName).toBe("SoFi Technologies, Inc.");
    expect(doc!.ownerName).toBe("Noto Anthony");
    expect(doc!.ownerRole).toContain("Chief Executive Officer");
    expect(doc!.ownerRole).toContain("Director");
    expect(doc!.transactions).toHaveLength(2);
  });

  it("parses the nested numeric amounts of the purchase", () => {
    const doc = parseForm4Xml(FORM4_BUY_XML)!;
    const buy = doc.transactions[0];
    expect(buy.code).toBe("P");
    expect(buy.shares).toBe(100000);
    expect(buy.pricePerShare).toBe(8.5);
    expect(buy.acquiredDisposed).toBe("A");
    expect(buy.dateIso.slice(0, 10)).toBe("2026-06-12");
  });

  it("returns null for non-ownership XML", () => {
    expect(parseForm4Xml("<html><body>not a filing</body></html>")).toBeNull();
    expect(parseForm4Xml("")).toBeNull();
  });
});

describe("form4DocToEvents", () => {
  it("emits one insider_buy for the open-market purchase and drops the award", () => {
    const doc = parseForm4Xml(FORM4_BUY_XML)!;
    const events = form4DocToEvents(doc, HIT);
    expect(events).toHaveLength(1); // award (code A) filtered out

    const ev = events[0];
    expect(ev.kind).toBe("insider_buy");
    expect(ev.ticker).toBe("SOFI");
    expect(ev.trade?.direction).toBe("buy");
    expect(ev.trade?.valueUsd).toBe(850000);
    expect(ev.severity).toBe("elevated"); // $850K ≥ $250K band
    expect(ev.headline).toContain("bought");
    expect(ev.headline).toContain("100,000 SOFI shares");
    expect(ev.actor?.role).toContain("Chief Executive Officer");
    expect(ev.source.url).toContain("/Archives/edgar/data/1500382/");
    expect(ev.id).toBe("form4-0001500382-26-000045-0");
  });

  it("drops events without an issuer symbol", () => {
    const doc = parseForm4Xml(FORM4_BUY_XML)!;
    expect(form4DocToEvents({ ...doc, issuerSymbol: "" }, HIT)).toHaveLength(0);
  });

  it("surfaces notable open-market sells (≥ $100K), dropping only tiny ones", () => {
    const doc = parseForm4Xml(FORM4_BUY_XML)!;
    const tinySell = { ...doc, transactions: [{ code: "S", shares: 1000, pricePerShare: 8.5, acquiredDisposed: "D" as const, dateIso: "2026-06-12T00:00:00.000Z" }] };
    expect(form4DocToEvents(tinySell, HIT)).toHaveLength(0); // $8.5K < $100K floor → noise

    // A mid-size sale that the old $1M floor hid - testers want to see these
    // ("who sold Nvidia yesterday"), so $212.5K now surfaces as a watch-level sell.
    const midSell = { ...doc, transactions: [{ code: "S", shares: 25000, pricePerShare: 8.5, acquiredDisposed: "D" as const, dateIso: "2026-06-12T00:00:00.000Z" }] };
    const mid = form4DocToEvents(midSell, HIT);
    expect(mid).toHaveLength(1); // $212.5K ≥ $100K
    expect(mid[0].kind).toBe("insider_sell");
    expect(mid[0].trade?.direction).toBe("sell");

    const bigSell = { ...doc, transactions: [{ code: "S", shares: 500000, pricePerShare: 8.5, acquiredDisposed: "D" as const, dateIso: "2026-06-12T00:00:00.000Z" }] };
    const events = form4DocToEvents(bigSell, HIT);
    expect(events).toHaveLength(1); // $4.25M ≥ $100K
    expect(events[0].kind).toBe("insider_sell");
  });
});
