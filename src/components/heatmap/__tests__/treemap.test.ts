import { describe, expect, it } from "vitest";
import { layoutTreemap, MIN_TILE_PX, squarify, type Rect } from "@/components/heatmap/treemap";

const BOUNDS: Rect = { x: 0, y: 0, w: 1000, h: 640 };

function area(r: Rect): number {
  return r.w * r.h;
}

/** Do two rectangles overlap with more than `eps` of shared area on both axes? */
function overlaps(a: Rect, b: Rect, eps = 0.01): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > eps && oy > eps;
}

function innerRect(group: { rect: Rect; header: Rect | null }): Rect {
  return group.header
    ? {
        x: group.rect.x,
        y: group.header.y + group.header.h,
        w: group.rect.w,
        h: Math.max(0, group.rect.h - group.header.h),
      }
    : group.rect;
}

describe("squarify", () => {
  it("returns one rect per positive-value item, largest first", () => {
    const items = [{ v: 3 }, { v: 10 }, { v: 1 }, { v: 6 }];
    const placed = squarify(items, (i) => i.v, BOUNDS);
    expect(placed).toHaveLength(4);
    const values = placed.map((p) => p.item.v);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("drops non-positive, NaN and Infinity values", () => {
    const items = [{ v: 5 }, { v: 0 }, { v: -2 }, { v: NaN }, { v: Infinity }];
    const placed = squarify(items, (i) => i.v, BOUNDS);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.item.v).toBe(5);
  });

  it("fully tiles the bounds (areas sum to the canvas area)", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ v: (i % 7) + 1 }));
    const placed = squarify(items, (i) => i.v, BOUNDS);
    const total = placed.reduce((sum, p) => sum + area(p.rect), 0);
    expect(total).toBeCloseTo(area(BOUNDS), 4);
  });

  it("keeps every rect inside the bounds", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ v: Math.sin(i) + 1.5 }));
    const placed = squarify(items, (i) => i.v, BOUNDS);
    for (const { rect } of placed) {
      expect(rect.x).toBeGreaterThanOrEqual(BOUNDS.x - 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(BOUNDS.y - 1e-6);
      expect(rect.x + rect.w).toBeLessThanOrEqual(BOUNDS.x + BOUNDS.w + 1e-6);
      expect(rect.y + rect.h).toBeLessThanOrEqual(BOUNDS.y + BOUNDS.h + 1e-6);
      expect(rect.w).toBeGreaterThan(0);
      expect(rect.h).toBeGreaterThan(0);
    }
  });

  it("produces non-overlapping rects", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ v: (i * 13) % 17 || 4 }));
    const placed = squarify(items, (i) => i.v, BOUNDS);
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        expect(overlaps(placed[a]!.rect, placed[b]!.rect)).toBe(false);
      }
    }
  });

  it("sizes rects proportionally to value", () => {
    const items = [{ v: 1 }, { v: 2 }, { v: 4 }, { v: 8 }];
    const placed = squarify(items, (i) => i.v, BOUNDS);
    const total = items.reduce((s, i) => s + i.v, 0);
    for (const { item, rect } of placed) {
      const expected = (item.v / total) * area(BOUNDS);
      expect(area(rect)).toBeCloseTo(expected, 2);
    }
  });

  it("returns nothing for an empty or zero-area canvas", () => {
    expect(squarify([{ v: 1 }], (i) => i.v, { x: 0, y: 0, w: 0, h: 100 })).toHaveLength(0);
    expect(squarify([], (i: { v: number }) => i.v, BOUNDS)).toHaveLength(0);
  });
});

describe("layoutTreemap", () => {
  const groups = [
    { key: "tech", label: "Technology", items: [{ cap: 100 }, { cap: 60 }, { cap: 30 }] },
    { key: "health", label: "Healthcare", items: [{ cap: 40 }, { cap: 20 }] },
    { key: "energy", label: "Energy", items: [{ cap: 25 }] },
    { key: "empty", label: "Empty", items: [{ cap: 0 }] },
  ];
  const denseGroups = [
    {
      key: "mega",
      label: "Mega",
      items: [
        { id: "leader", cap: 1_000_000 },
        ...Array.from({ length: 80 }, (_, i) => ({ id: `micro-${i}`, cap: 1 })),
      ],
    },
    {
      key: "steady",
      label: "Steady",
      items: [
        { id: "steady-a", cap: 300_000 },
        { id: "steady-b", cap: 150_000 },
        { id: "steady-c", cap: 75_000 },
      ],
    },
    { key: "single", label: "Single", items: [{ id: "single-a", cap: 50_000 }] },
  ];

  it("drops groups with no positive-value items", () => {
    const placed = layoutTreemap(groups, (i) => i.cap, BOUNDS);
    expect(placed.map((g) => g.key)).not.toContain("empty");
    expect(placed).toHaveLength(3);
  });

  it("group rects fully tile the canvas", () => {
    const placed = layoutTreemap(groups, (i) => i.cap, BOUNDS);
    const total = placed.reduce((sum, g) => sum + area(g.rect), 0);
    expect(total).toBeCloseTo(area(BOUNDS), 3);
  });

  it("keeps each group's tiles within its sub-rectangle and below the header", () => {
    const placed = layoutTreemap(groups, (i) => i.cap, BOUNDS, {
      headerHeight: 22,
      minHeaderRoom: 50,
    });
    for (const group of placed) {
      const top = group.header ? group.header.y + group.header.h : group.rect.y;
      for (const tile of group.tiles) {
        expect(tile.rect.x).toBeGreaterThanOrEqual(group.rect.x - 1e-6);
        expect(tile.rect.x + tile.rect.w).toBeLessThanOrEqual(group.rect.x + group.rect.w + 1e-6);
        expect(tile.rect.y).toBeGreaterThanOrEqual(top - 1e-6);
        expect(tile.rect.y + tile.rect.h).toBeLessThanOrEqual(group.rect.y + group.rect.h + 1e-6);
      }
    }
  });

  it("sizes groups proportionally to their total value", () => {
    const placed = layoutTreemap(groups, (i) => i.cap, BOUNDS);
    const tech = placed.find((g) => g.key === "tech")!;
    const health = placed.find((g) => g.key === "health")!;
    // tech total = 190, health total = 60 → ~3.17x the area.
    expect(area(tech.rect) / area(health.rect)).toBeCloseTo(190 / 60, 1);
  });

  it("keeps dense sector tiles inside, fully filled, and above the minimum size", () => {
    const eps = 1e-6;
    const placed = layoutTreemap(denseGroups, (i) => i.cap, { x: 13, y: 17, w: 720, h: 420 }, {
      headerHeight: 24,
      minHeaderRoom: 60,
    });
    const dense = placed.find((g) => g.key === "mega")!;

    expect(dense.tiles.length).toBeLessThan(denseGroups[0]!.items.length);

    for (const group of placed) {
      const inner = innerRect(group);
      const tileArea = group.tiles.reduce((sum, tile) => sum + area(tile.rect), 0);
      const areaTolerance = Math.max(group.tiles.length * 0.5, area(inner) * 0.01);

      expect(group.tiles.length).toBeGreaterThan(0);
      expect(Math.abs(tileArea - area(inner))).toBeLessThanOrEqual(areaTolerance);

      for (const tile of group.tiles) {
        expect(tile.rect.x).toBeGreaterThanOrEqual(inner.x - eps);
        expect(tile.rect.y).toBeGreaterThanOrEqual(inner.y - eps);
        expect(tile.rect.x + tile.rect.w).toBeLessThanOrEqual(inner.x + inner.w + eps);
        expect(tile.rect.y + tile.rect.h).toBeLessThanOrEqual(inner.y + inner.h + eps);
        expect(tile.rect.w).toBeGreaterThanOrEqual(MIN_TILE_PX - eps);
        expect(tile.rect.h).toBeGreaterThanOrEqual(MIN_TILE_PX - eps);
      }
    }
  });

  it("is deterministic for the same input", () => {
    const bounds = { x: 13, y: 17, w: 720, h: 420 };
    const options = { headerHeight: 24, minHeaderRoom: 60 };

    expect(layoutTreemap(denseGroups, (i) => i.cap, bounds, options)).toEqual(
      layoutTreemap(denseGroups, (i) => i.cap, bounds, options),
    );
  });
});
