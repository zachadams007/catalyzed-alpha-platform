import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HeatmapTooltip } from "@/components/heatmap/HeatmapTooltip";
import type { HeatTile } from "@/components/heatmap/heatmapModel";

const TILE: HeatTile = {
  ticker: "NVDA",
  name: "Nvidia Corp",
  sector: "Technology",
  marketCap: 5_100_000_000_000,
  price: 207.34,
  opportunity: 45,
  dayChange: -0.009,
  hype: 39,
  hypeTier: "Cooling",
};

const RECT = { x: 200, y: 300, w: 180, h: 120 };

const html = (tile: HeatTile = TILE) =>
  renderToStaticMarkup(
    <HeatmapTooltip
      tile={tile}
      rect={RECT}
      mode="opportunity"
      canvas={{ w: 1000, h: 700 }}
      onSelect={vi.fn()}
    />,
  );

describe("HeatmapTooltip", () => {
  it("shows the stock PRICE (the thing the read-out was missing)", () => {
    expect(html()).toContain("$207.34");
  });

  it("shows price as an em-dash when unknown, never a fake $0", () => {
    const out = html({ ...TILE, price: 0 });
    expect(out).toContain("—");
    expect(out).not.toContain("$0.00");
  });

  it("the CTA is a real <button> that names THIS ticker (so the click opens it)", () => {
    const out = html();
    expect(out).toMatch(/<button[^>]*class="hm-tip__cta"/);
    expect(out).toContain("Open ");
    expect(out).toContain("NVDA");
  });

  it("still surfaces cap + sector + name", () => {
    const out = html();
    expect(out).toContain("Technology");
    expect(out).toContain("Nvidia Corp");
    expect(out).toContain("$5.10T");
  });
});
