import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutTreemap, type Rect } from "@/components/heatmap/treemap";
import type { HeatMode, HypeDomain } from "@/components/heatmap/colorScale";
import type { HeatTile } from "@/components/heatmap/heatmapModel";
import { HeatmapTile } from "@/components/heatmap/HeatmapTile";
import { HeatmapTooltip } from "@/components/heatmap/HeatmapTooltip";
import type { TreemapGroup } from "@/components/heatmap/treemap";

interface Props {
  groups: TreemapGroup<HeatTile>[];
  mode: HeatMode;
  onSelect: (ticker: string) => void;
  /** Contrast-stretch window for hype coloring (stable ref so tiles stay memoized). */
  hypeDomain: HypeDomain;
}

const HEADER_H = 20;

/** Canvas height as a function of width - taller (squarer tiles) on narrow viewports,
 *  and a generous ceiling so the near-full-width map keeps real vertical presence. */
function canvasHeight(w: number): number {
  if (w <= 0) return 560;
  if (w < 560) return Math.round(Math.min(w * 1.2, 760));
  return Math.round(Math.min(Math.max(w * 0.5, 480), 880));
}

type Dir = "left" | "right" | "up" | "down";

/** Nearest tile to `idx` in a direction, by rect centers (primary + 2×cross distance). */
function findNeighbor(rects: Rect[], idx: number, dir: Dir): number {
  const cur = rects[idx];
  if (!cur) return idx;
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  let best = idx;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === idx) continue;
    const r = rects[i]!;
    const dx = r.x + r.w / 2 - cx;
    const dy = r.y + r.h / 2 - cy;
    let primary: number;
    let cross: number;
    if (dir === "left") {
      if (dx > -1) continue;
      primary = -dx;
      cross = Math.abs(dy);
    } else if (dir === "right") {
      if (dx < 1) continue;
      primary = dx;
      cross = Math.abs(dy);
    } else if (dir === "up") {
      if (dy > -1) continue;
      primary = -dy;
      cross = Math.abs(dx);
    } else {
      if (dy < 1) continue;
      primary = dy;
      cross = Math.abs(dx);
    }
    const score = primary + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function HeatmapTreemap({ groups, mode, onSelect, hypeDomain }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // Touch has no hover, so a single tap can't both PREVIEW and OPEN. We track the
  // last pointer type + which tile a tap has "armed": on touch the first tap on a
  // tile shows its read-out (and the tooltip's Open button), a second tap on the
  // SAME tile opens it. Mouse/pen click still opens immediately. (B3)
  const lastPointerType = useRef<string>("mouse");
  const [tapArmed, setTapArmed] = useState<number | null>(null);

  // Measure available width synchronously (rAF can be throttled in a
  // backgrounded/headless tab, which would strand width at 0), then track
  // resizes. Changing width only alters the canvas HEIGHT, so the observer
  // can't feedback-loop on the observed element's width.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = canvasHeight(width);

  const placedGroups = useMemo(
    () =>
      layoutTreemap(groups, (t) => t.marketCap, { x: 0, y: 0, w: width, h: height }, {
        headerHeight: HEADER_H,
        minHeaderRoom: HEADER_H * 2.6,
      }),
    [groups, width, height],
  );

  const flat = useMemo(
    () => placedGroups.flatMap((g) => g.tiles.map((p) => ({ tile: p.item, rect: p.rect }))),
    [placedGroups],
  );
  const rects = useMemo(() => flat.map((f) => f.rect), [flat]);

  // Keep the roving index valid as the tile set changes; drop any stale tap-arm.
  useEffect(() => {
    setActive((a) => (a < flat.length ? a : 0));
    setTapArmed(null);
  }, [flat.length]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flat.length === 0) return;
      let dir: Dir | null = null;
      if (e.key === "ArrowLeft") dir = "left";
      else if (e.key === "ArrowRight") dir = "right";
      else if (e.key === "ArrowUp") dir = "up";
      else if (e.key === "ArrowDown") dir = "down";

      if (dir) {
        e.preventDefault();
        const next = findNeighbor(rects, active, dir);
        if (next !== active) {
          setActive(next);
          setHover(next);
          const node = wrapRef.current?.querySelector<HTMLButtonElement>(`[data-i="${next}"]`);
          node?.focus();
        }
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const f = flat[active];
        if (f) onSelect(f.tile.ticker);
      }
    },
    [rects, active, flat, onSelect],
  );

  // Event delegation: one handler resolves the tile under the pointer/click.
  const tileIndexFromEvent = (e: React.SyntheticEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!el) return null;
    const i = Number(el.dataset.i);
    return Number.isInteger(i) ? i : null;
  };

  const onPointerOver = (e: React.PointerEvent) => {
    // Skip touch - it synthesizes a pointerover on tap that would otherwise
    // arm + preview through the hover path; the click handler owns touch.
    if (e.pointerType === "touch") return;
    const i = tileIndexFromEvent(e);
    if (i != null) setHover(i);
  };
  const onClick = (e: React.MouseEvent) => {
    const i = tileIndexFromEvent(e);
    if (i == null || !flat[i]) return;
    if (lastPointerType.current === "touch") {
      // First tap previews + arms; second tap on the same tile opens it.
      if (tapArmed === i) {
        onSelect(flat[i]!.tile.ticker);
        setTapArmed(null);
      } else {
        setHover(i);
        setActive(i);
        setTapArmed(i);
      }
      return;
    }
    onSelect(flat[i]!.tile.ticker);
  };
  const onFocusCapture = (e: React.FocusEvent) => {
    const i = tileIndexFromEvent(e);
    if (i != null) {
      setActive(i);
      setHover(i);
    }
  };

  const hoveredFlat = hover != null ? flat[hover] : null;

  // Clear the pointer-hover read-out only when focus isn't parked on a tile -
  // otherwise moving the mouse out would yank the tooltip off a keyboard
  // selection (pointer + keyboard share the single `hover` source).
  const clearHoverIfUnfocused = () => {
    if (!wrapRef.current?.contains(document.activeElement)) setHover(null);
  };

  return (
    <div className="hm-canvas-wrap">
      <div
        ref={wrapRef}
        className="hm-canvas"
        style={{ height }}
        role="application"
        aria-label="Market map treemap — sized by market cap, grouped by sector. Use arrow keys to move between companies and Enter to open one."
        onPointerDownCapture={(e) => {
          lastPointerType.current = e.pointerType || "mouse";
        }}
        onPointerOver={onPointerOver}
        onPointerLeave={clearHoverIfUnfocused}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onFocusCapture={onFocusCapture}
        onBlur={(e) => {
          if (!wrapRef.current?.contains(e.relatedTarget as Node)) setHover(null);
        }}
      >
        {/* Inner clip wrapper holds the tiles + sector frames (clipped to the
            rounded canvas). The hover card is a SIBLING below, so it escapes the
            clip and renders OVER everything. */}
        <div className="hm-canvas__clip">
          {width > 0 &&
            placedGroups.map((g) => (
              <div
                key={g.key}
                className="hm-sector"
                style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}
                aria-hidden="true"
              >
                {g.header && (
                  <span className="hm-sector__label" style={{ height: g.header.h }}>
                    {g.label}
                  </span>
                )}
              </div>
            ))}
          {width > 0 &&
            flat.map(({ tile, rect }, i) => (
              <HeatmapTile
                key={`${tile.sector}:${tile.ticker}`}
                tile={tile}
                rect={rect}
                mode={mode}
                index={i}
                active={i === active}
                hypeDomain={hypeDomain}
              />
            ))}
        </div>
        {hoveredFlat && (
          <HeatmapTooltip
            tile={hoveredFlat.tile}
            rect={hoveredFlat.rect}
            mode={mode}
            canvas={{ w: width, h: height }}
            onSelect={onSelect}
          />
        )}
      </div>
    </div>
  );
}
