import type { MarketCapBucket } from "@/types";
import { formatMarketCap } from "@/lib/format";

export interface MarketCapGuideEntry {
  bucket: MarketCapBucket;
  /** Typical USD range (approximate, U.S. equities). */
  rangeLabel: string;
  hint: string;
}

/** Reference ranges for filter chips - not investment advice. */
export const MARKET_CAP_GUIDE: MarketCapGuideEntry[] = [
  { bucket: "Nano", rangeLabel: "< $50M", hint: "OTC / pre-revenue labs, extreme liquidity risk" },
  { bucket: "Micro", rangeLabel: "$50M – $300M", hint: "Early commercialization, thin float" },
  { bucket: "Small", rangeLabel: "$300M – $2B", hint: "Niche leaders, higher idiosyncratic risk" },
  { bucket: "Mid", rangeLabel: "$2B – $10B", hint: "Growth compounders, still under-indexed" },
  { bucket: "Large", rangeLabel: "$10B – $200B", hint: "Established franchises, analyst coverage" },
  { bucket: "Mega", rangeLabel: "> $200B", hint: "Mega-cap liquidity, lower % moves" },
];

export function capGuideFor(bucket: MarketCapBucket): MarketCapGuideEntry {
  return MARKET_CAP_GUIDE.find((e) => e.bucket === bucket) ?? MARKET_CAP_GUIDE[0]!;
}

/** Example notional cap for HUD ring labels. */
export function exampleCapUsd(bucket: MarketCapBucket): number {
  switch (bucket) {
    case "Nano":
      return 28e6;
    case "Micro":
      return 180e6;
    case "Small":
      return 1.2e9;
    case "Mid":
      return 5e9;
    case "Large":
      return 45e9;
    case "Mega":
      return 800e9;
    default:
      return 1e9;
  }
}

/** Short chip label - pair with {@link MarketCapChip} or a tooltip for the range. */
export function capChipLabel(bucket: MarketCapBucket): string {
  return bucket;
}

/** Plain-text tooltip body for native `title` fallbacks. */
export function capChipTitle(bucket: MarketCapBucket): string {
  const g = capGuideFor(bucket);
  return `${g.rangeLabel} — ${g.hint} (e.g. ${formatMarketCap(exampleCapUsd(bucket))})`;
}
