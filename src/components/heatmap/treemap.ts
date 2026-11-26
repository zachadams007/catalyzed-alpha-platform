/**
 * Squarified treemap layout - pure geometry, no React.
 *
 * Implements the Bruls / Huizing / van Wijk squarified algorithm: tiles fill
 * the rectangle in rows along its shorter side, greedily packing each row to
 * keep aspect ratios as close to square as possible. The result fully tiles the
 * bounds with no gaps or overlaps (seams are added later, at render time).
 *
 * Two layers are exposed:
 *  - {@link squarify} lays a flat list of weighted items into one rectangle.
 *  - {@link layoutTreemap} is the two-level market-map layout: groups (sectors)
 *    are squarified into the canvas, then each group's items are squarified into
 *    its sub-rectangle (minus an optional header strip for the group label).
 *
 * Kept pure + framework-free so the geometry is unit-testable in isolation.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Minimum rendered company tile dimension; smaller names are trimmed before layout.
export const MIN_TILE_PX = 6;

export interface Placed<T> {
  item: T;
  rect: Rect;
}

export interface TreemapGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export interface PlacedGroup<T> {
  key: string;
  label: string;
  /** The group's full sub-rectangle within the canvas. */
  rect: Rect;
  /** The label strip at the top of {@link rect}, or null when too small to show. */
  header: Rect | null;
  /** The group's items, squarified into the area below the header. */
  tiles: Placed<T>[];
}

export interface TreemapOptions {
  /** Height of each group's label strip, in px. Set 0 to disable headers. */
  headerHeight?: number;
  /** A group rect must be at least this tall to earn a header strip. */
  minHeaderRoom?: number;
}

/**
 * The "worst" (largest) aspect ratio in a candidate row, per the squarified
 * paper. `row` holds already-scaled areas; `side` is the length of the side the
 * row is laid along (the shorter side of the remaining rectangle).
 */
function worstAspect(areas: number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  if (sum <= 0) return Infinity;
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * Lay `items` into `bounds`, sized proportionally to `getValue`. Returns one
 * {@link Placed} per item with a positive value, in descending-value order
 * (largest first). Items with a non-positive value are dropped. The placed
 * rectangles exactly tile `bounds`.
 */
export function squarify<T>(items: T[], getValue: (item: T) => number, bounds: Rect): Placed<T>[] {
  const valued = items
    .map((item) => ({ item, value: getValue(item) }))
    .filter((v) => Number.isFinite(v.value) && v.value > 0)
    .sort((a, b) => b.value - a.value);

  const placed: Placed<T>[] = [];
  if (valued.length === 0 || bounds.w <= 0 || bounds.h <= 0) return placed;

  const total = valued.reduce((sum, v) => sum + v.value, 0);
  const canvasArea = bounds.w * bounds.h;
  // Scale each value into px² so row areas map straight onto the rectangle.
  const scaled = valued.map((v) => ({ item: v.item, area: (v.value / total) * canvasArea }));

  // The free rectangle that shrinks as rows are committed.
  let x = bounds.x;
  let y = bounds.y;
  let w = bounds.w;
  let h = bounds.h;

  let i = 0;
  while (i < scaled.length) {
    const side = Math.min(w, h);
    const rowAreas: number[] = [];
    let rowStart = i;

    // Grow the row while it keeps (or improves) the worst aspect ratio.
    while (i < scaled.length) {
      const candidate = [...rowAreas, scaled[i]!.area];
      if (rowAreas.length === 0 || worstAspect(candidate, side) <= worstAspect(rowAreas, side)) {
        rowAreas.push(scaled[i]!.area);
        i++;
      } else {
        break;
      }
    }

    const rowArea = rowAreas.reduce((sum, a) => sum + a, 0);
    const isLastRow = i >= scaled.length;

    if (w <= h) {
      // Horizontal row across the full width; its thickness fills downward.
      const rowH = isLastRow ? h : rowArea / w;
      let cx = x;
      for (let k = rowStart; k < i; k++) {
        const last = k === i - 1;
        const tileW = last ? x + w - cx : rowAreas[k - rowStart]! / rowH;
        placed.push({ item: scaled[k]!.item, rect: { x: cx, y, w: tileW, h: rowH } });
        cx += tileW;
      }
      y += rowH;
      h -= rowH;
    } else {
      // Vertical row down the full height; its thickness fills rightward.
      const rowW = isLastRow ? w : rowArea / h;
      let cy = y;
      for (let k = rowStart; k < i; k++) {
        const last = k === i - 1;
        const tileH = last ? y + h - cy : rowAreas[k - rowStart]! / rowW;
        placed.push({ item: scaled[k]!.item, rect: { x, y: cy, w: rowW, h: tileH } });
        cy += tileH;
      }
      x += rowW;
      w -= rowW;
    }
  }

  return placed;
}

function squarifyWithoutDust<T>(items: T[], getValue: (item: T) => number, bounds: Rect): Placed<T>[] {
  if (bounds.w <= 0 || bounds.h <= 0) return [];

  const valued = items
    .map((item, index) => ({ item, index, value: getValue(item) }))
    .filter((v) => Number.isFinite(v.value) && v.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index);

  let kept = valued;

  while (kept.length > 1) {
    const placed = squarify(kept, (v) => v.value, bounds);
    const hasDust = placed.some(({ rect }) => rect.w < MIN_TILE_PX || rect.h < MIN_TILE_PX);

    if (!hasDust) {
      return placed.map(({ item, rect }) => ({ item: item.item, rect }));
    }

    kept = kept.slice(0, -1);
  }

  return squarify(kept, (v) => v.value, bounds).map(({ item, rect }) => ({ item: item.item, rect }));
}

/**
 * Two-level market-map layout. Groups are squarified into `bounds` by the sum
 * of their items' values; each group's items are then squarified into the area
 * beneath its header strip. Empty groups (no positive-value items) are dropped.
 */
export function layoutTreemap<T>(
  groups: TreemapGroup<T>[],
  getValue: (item: T) => number,
  bounds: Rect,
  options: TreemapOptions = {},
): PlacedGroup<T>[] {
  const headerHeight = options.headerHeight ?? 0;
  // Never let a header eat the whole group: require enough room that the inner
  // rect stays clearly positive, so a small/misconfigured minHeaderRoom degrades
  // to "no header" rather than silently dropping every tile in the group.
  const minHeaderRoom = Math.max(options.minHeaderRoom ?? headerHeight * 2.4, headerHeight * 1.6);

  const weighted = groups
    .map((group) => ({
      group,
      value: group.items.reduce((sum, item) => {
        const v = getValue(item);
        return Number.isFinite(v) && v > 0 ? sum + v : sum;
      }, 0),
    }))
    .filter((g) => g.value > 0);

  const groupRects = squarify(weighted, (g) => g.value, bounds);

  return groupRects.map(({ item: g, rect }) => {
    const showHeader = headerHeight > 0 && rect.h >= minHeaderRoom && rect.w > headerHeight * 1.5;
    const header = showHeader ? { x: rect.x, y: rect.y, w: rect.w, h: headerHeight } : null;
    const inner: Rect = header
      ? { x: rect.x, y: rect.y + headerHeight, w: rect.w, h: Math.max(0, rect.h - headerHeight) }
      : rect;
    return {
      key: g.group.key,
      label: g.group.label,
      rect,
      header,
      // Clamp every tile to the sector's inner rect so a floating-point / last-tile
      // fencepost overrun can't spill a tile past the sector boundary (the corner-
      // overflow bug). Clamping keeps x+w ≤ the inner right edge EXACTLY - no rounding,
      // which would re-introduce a sub-pixel overrun. Tiny names are trimmed before
      // layout so the remaining tiles still fill the full inner rect.
      // map reads as a clean big→small squarified layout with no invisible corner dust.
      tiles: squarifyWithoutDust(g.group.items, getValue, inner).map(({ item, rect: tileRect }) => {
        const x = Math.max(inner.x, Math.min(tileRect.x, inner.x + inner.w));
        const y = Math.max(inner.y, Math.min(tileRect.y, inner.y + inner.h));
        const w = Math.max(0, Math.min(tileRect.w, inner.x + inner.w - x));
        const h = Math.max(0, Math.min(tileRect.h, inner.y + inner.h - y));
        return { item, rect: { x, y, w, h } };
      }),
    };
  });
}
