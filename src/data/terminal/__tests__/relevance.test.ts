import { describe, expect, it } from "vitest";
import { terminalRelevance, sortTerminalEvents } from "../relevance";
import type { TerminalEvent } from "@/types/terminal";

const NOW = Date.parse("2026-06-24T16:00:00Z");
const ev = (o: Partial<TerminalEvent>): TerminalEvent => ({
  id: o.id ?? "x",
  kind: o.kind ?? "catalyst_news",
  severity: o.severity ?? "watch",
  ticker: o.ticker ?? "",
  headline: o.headline ?? "",
  surfacedAt: o.surfacedAt ?? new Date(NOW).toISOString(),
  occurredAt: o.occurredAt ?? o.surfacedAt ?? new Date(NOW).toISOString(),
  reason: o.reason ?? "",
  source: o.source ?? { name: "Test", url: "https://example.com" },
  actor: o.actor,
  trade: o.trade,
});

describe("terminal relevance ranking", () => {
  // The motivating case: the president named a megacap on TV YESTERDAY (a top-tier
  // catalyst) vs a minor PR from minutes ago. Relevance must float the major up.
  const trumpMajorYesterday = ev({
    kind: "catalyst_news",
    severity: "high",
    ticker: "NVDA",
    headline: "Trump names Nvidia in live remarks on chip policy",
    surfacedAt: new Date(NOW - 22 * 3_600_000).toISOString(), // ~22h ago
  });
  const minorNow = ev({
    kind: "catalyst_news",
    severity: "watch",
    ticker: "ZXYW",
    headline: "Acme Co to host investor webinar next week",
    surfacedAt: new Date(NOW - 5 * 60_000).toISOString(), // 5 min ago
  });

  it("ranks a day-old MAJOR catalyst above a minutes-old minor one", () => {
    expect(terminalRelevance(trumpMajorYesterday, NOW)).toBeGreaterThan(
      terminalRelevance(minorNow, NOW),
    );
  });

  it("relevance sort floats the major up; latest sort keeps the newest first", () => {
    const byRel = sortTerminalEvents([minorNow, trumpMajorYesterday], "relevance", NOW);
    expect(byRel[0]?.ticker).toBe("NVDA");
    const byLatest = sortTerminalEvents([trumpMajorYesterday, minorNow], "latest", NOW);
    expect(byLatest[0]?.ticker).toBe("ZXYW");
  });

  it("a big politician/insider trade outranks a generic same-day note", () => {
    const senatorBuy = ev({
      kind: "politician_trade",
      severity: "elevated",
      ticker: "AMD",
      headline: "Senator disclosed AMD purchase",
      actor: { name: "A. Senator", role: "US Senator" } as TerminalEvent["actor"],
      trade: { direction: "buy", valueUsd: 2_000_000 } as TerminalEvent["trade"],
    });
    const genericNote = ev({ kind: "catalyst_news", severity: "watch", headline: "Company update" });
    expect(terminalRelevance(senatorBuy, NOW)).toBeGreaterThan(terminalRelevance(genericNote, NOW));
  });
});
