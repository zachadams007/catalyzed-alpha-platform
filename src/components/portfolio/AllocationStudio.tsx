import {
  useMemo,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import NumberFlow from "@number-flow/react";
import { IconChevronLeft } from "@/components/icons";
import type {
  AllocationHolding,
  AllocationSectorGroup,
} from "@/engine/portfolioAnalytics";
import { formatCurrency, formatPctPlain } from "@/lib/format";

/* ── Geometry ──────────────────────────────────────────────────────────────
   Two concentric rings: an OUTER sector ring wrapping an INNER holdings ring.
   Sectors and their holdings share the same angular order, so each sector arc
   sits directly above its constituent holdings. Pure SVG; the heavy motion is
   transform/opacity (arc lift, glow, orbiting packet) - the one-shot entrance
   uses the donut stroke-dash idiom already established in this app. */
const SIZE = 268;
const CENTER = SIZE / 2;
const OUTER_R = 116;
const OUTER_T = 13;
const INNER_R = 84;
const INNER_T = 30;
const SECTOR_GAP_DEG = 1.8;
const HOLDING_GAP_DEG = 1.4;

interface ArcLayout {
  startFrac: number;
  lenFrac: number;
  midDeg: number;
}

/** Lay a list of fractions (summing ~1) onto a ring, centring each in its slot
 *  with a hairline gap so segments read as distinct without losing tiny ones. */
function layoutArcs(fractions: number[], gapDeg: number): ArcLayout[] {
  const gapFrac = fractions.length > 1 ? gapDeg / 360 : 0;
  let cursor = 0;
  return fractions.map((f) => {
    const lenFrac = Math.max(f - gapFrac, f * 0.4);
    const startFrac = cursor + (f - lenFrac) / 2;
    const midDeg = (startFrac + lenFrac / 2) * 360;
    cursor += f;
    return { startFrac, lenFrac, midDeg };
  });
}

type ArcStyle = CSSProperties & {
  "--arc-c": number;
  "--arc-len": number;
  "--arc-lift-x": string;
  "--arc-lift-y": string;
  "--arc-color": string;
};

function arcStyle(
  layout: ArcLayout,
  r: number,
  color: string,
  lift: number,
): ArcStyle {
  const circ = 2 * Math.PI * r;
  const len = layout.lenFrac * circ;
  const rad = (layout.midDeg * Math.PI) / 180;
  return {
    "--arc-c": circ,
    "--arc-len": len,
    "--arc-lift-x": `${Math.cos(rad) * lift}px`,
    "--arc-lift-y": `${Math.sin(rad) * lift}px`,
    "--arc-color": color,
    stroke: color,
    strokeDasharray: `${len} ${circ - len}`,
    strokeDashoffset: -(layout.startFrac * circ),
  };
}

/** Within-sector tint: the top holding keeps the pure sector hue; deeper ranks
 *  step toward the surface so a sector reads as one colour "family". */
function holdingTint(base: string, rank: number, count: number): string {
  if (count <= 1) return base;
  const step = rank / Math.max(count - 1, 1);
  const towardBg = Math.round(step * 34);
  return towardBg === 0
    ? base
    : `color-mix(in oklab, ${base} ${100 - towardBg}%, var(--bg-elev))`;
}

type Active =
  | { kind: "sector"; sector: string }
  | { kind: "holding"; ticker: string; sector: string }
  | null;

/** Don't clear the spotlight when the pointer/focus moves between an arc and the
 *  legend row that shares its key - they read as one element. */
function clearIfOutside(
  key: string,
  onClear: () => void,
  event: MouseEvent<Element> | FocusEvent<Element>,
) {
  const related = event.relatedTarget;
  if (related instanceof Element && related.closest(`[data-alloc-key="${key}"]`)) return;
  onClear();
}

interface AllocationStudioProps {
  sectorGroups: AllocationSectorGroup[];
  valueTracked: boolean;
  totalValue: number;
  holdingCount: number;
  concentration: number;
  concentrationTicker?: string;
  effectiveHoldings: number;
  sectorCount: number;
  owned: boolean;
  /** Opens the position-tracking flow when an owned book is still watch-only. */
  onTrackValue?: () => void;
  /** Opens the holding inspector for a ticker. */
  onSelectHolding: (ticker: string) => void;
}

/**
 * The Allocation Studio - the Portfolio detail's signature instrument. Concentric
 * sector→holding rings with a hover spotlight, click-to-drill into a sector, a
 * morphing centre readout, an alternate bars view, and an integrated
 * concentration gauge. Research/discovery only - no trading language.
 */
export function AllocationStudio({
  sectorGroups,
  valueTracked,
  totalValue,
  holdingCount,
  concentration,
  concentrationTicker,
  effectiveHoldings,
  sectorCount,
  owned,
  onTrackValue,
  onSelectHolding,
}: AllocationStudioProps) {
  const [view, setView] = useState<"rings" | "bars">("rings");
  const [active, setActive] = useState<Active>(null);
  const [drill, setDrill] = useState<string | null>(null);

  const drilled = useMemo(
    () => (drill ? sectorGroups.find((g) => g.label === drill) ?? null : null),
    [drill, sectorGroups],
  );

  // The holdings shown in the inner ring, with the fraction each occupies. When
  // drilled, the sector's holdings expand to fill the whole ring.
  const innerHoldings: { holding: AllocationHolding; frac: number; color: string }[] =
    useMemo(() => {
      if (drilled) {
        const sum = drilled.holdings.reduce((a, h) => a + h.pct, 0) || 1;
        return drilled.holdings.map((h) => ({
          holding: h,
          frac: h.pct / sum,
          color: holdingTint(drilled.color, h.sectorRank, drilled.holdings.length),
        }));
      }
      return sectorGroups.flatMap((g) =>
        g.holdings.map((h) => ({
          holding: h,
          frac: h.pct,
          color: holdingTint(g.color, h.sectorRank, g.holdings.length),
        })),
      );
    }, [drilled, sectorGroups]);

  const outerSectors = drilled ? [drilled] : sectorGroups;

  const outerLayouts = layoutArcs(
    outerSectors.map((g) => (drilled ? 1 : g.pct)),
    SECTOR_GAP_DEG,
  );
  const innerLayouts = layoutArcs(
    innerHoldings.map((h) => h.frac),
    HOLDING_GAP_DEG,
  );

  const isSectorActive = (label: string) =>
    active?.kind === "sector" && active.sector === label;
  const isHoldingActive = (ticker: string) =>
    active?.kind === "holding" && active.ticker === ticker;
  const sectorDimmed = (label: string) =>
    active != null && active.sector !== label;
  const holdingDimmed = (h: AllocationHolding) => {
    if (active == null) return false;
    if (active.kind === "holding") return active.ticker !== h.ticker;
    return active.sector !== h.sector;
  };

  // What the centre reads - morphs on hover / drill, defaults to the whole book.
  const readout = useMemo<{
    value: number;
    pct: number | null;
    label: string;
    sub: string;
    color?: string;
  }>(() => {
    if (active?.kind === "holding") {
      // Search every sector (not just the drilled subset) so hovering any legend
      // row reads its own value, even while drilled into a different sector.
      const h = sectorGroups.flatMap((g) => g.holdings).find((x) => x.ticker === active.ticker);
      if (h) {
        return {
          value: valueTracked ? h.value : h.pct,
          pct: h.pct,
          label: h.ticker,
          sub: h.sector,
          color: holdingTint(
            sectorGroups[h.sectorIndex]?.color ?? "var(--accent)",
            h.sectorRank,
            sectorGroups[h.sectorIndex]?.holdings.length ?? 1,
          ),
        };
      }
    }
    const sectorLabel = active?.kind === "sector" ? active.sector : drilled?.label;
    if (sectorLabel) {
      const g = sectorGroups.find((x) => x.label === sectorLabel);
      if (g) {
        return {
          value: valueTracked ? g.value : g.pct,
          pct: g.pct,
          label: g.label,
          sub: `${g.holdings.length} holding${g.holdings.length === 1 ? "" : "s"}`,
          color: g.color,
        };
      }
    }
    return {
      value: valueTracked ? totalValue : holdingCount,
      pct: null,
      label: valueTracked ? "Market value" : `${holdingCount} holdings`,
      sub: `${sectorCount} sector${sectorCount === 1 ? "" : "s"}`,
    };
  }, [
    active,
    drilled,
    innerHoldings,
    sectorGroups,
    valueTracked,
    totalValue,
    holdingCount,
    sectorCount,
  ]);

  const concClass =
    concentration >= 0.35 ? "is-risk" : concentration >= 0.25 ? "is-watch" : "is-calm";

  const activateHolding = (h: AllocationHolding) =>
    setActive({ kind: "holding", ticker: h.ticker, sector: h.sector });
  const activateSector = (label: string) => setActive({ kind: "sector", sector: label });

  return (
    <section className="pf-panel pf-alloc-studio alloc-studio" aria-labelledby="pf-alloc-title">
      <header className="alloc-studio__head">
        <div className="alloc-studio__heading">
          <span className="pf-panel__title" id="pf-alloc-title">
            Allocation
          </span>
          <p className="pf-panel__description">
            {drilled
              ? `${drilled.label} — ${drilled.holdings.length} holding${drilled.holdings.length === 1 ? "" : "s"}`
              : valueTracked
                ? "Sector rings wrap their holdings — hover to spotlight, click to drill in"
                : "Equal-weighted until shares or values are added"}
          </p>
        </div>
        <div className="seg-toggle alloc-studio__view" aria-label="Allocation view">
          <button
            type="button"
            className={view === "rings" ? "seg-toggle__btn is-active" : "seg-toggle__btn"}
            onClick={() => setView("rings")}
            aria-pressed={view === "rings"}
          >
            Rings
          </button>
          <button
            type="button"
            className={view === "bars" ? "seg-toggle__btn is-active" : "seg-toggle__btn"}
            onClick={() => setView("bars")}
            aria-pressed={view === "bars"}
          >
            Bars
          </button>
        </div>
      </header>

      <div className="alloc-studio__body">
        <div className="alloc-studio__stage">
          {drill && (
            <button type="button" className="alloc-studio__back" onClick={() => setDrill(null)}>
              <IconChevronLeft size={14} />
              All sectors
            </button>
          )}

          {view === "rings" ? (
            <div className={`alloc-rings${active ? " has-active" : ""}`}>
              <span className="alloc-rings__glow" aria-hidden />
              <svg
                className="alloc-rings__svg"
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                role="img"
                aria-label={
                  drilled
                    ? `${drilled.label} holdings allocation`
                    : "Portfolio allocation: sectors and holdings"
                }
              >
                {/* Resting ring tracks */}
                <circle
                  cx={CENTER}
                  cy={CENTER}
                  r={OUTER_R}
                  fill="none"
                  stroke="var(--surface-2)"
                  strokeWidth={OUTER_T}
                  aria-hidden="true"
                />
                <circle
                  cx={CENTER}
                  cy={CENTER}
                  r={INNER_R}
                  fill="none"
                  stroke="var(--surface-2)"
                  strokeWidth={INNER_T}
                  aria-hidden="true"
                />

                {/* Outer ring - sectors */}
                {outerSectors.map((g, i) => {
                  const layout = outerLayouts[i]!;
                  return (
                    <circle
                      key={`sec-${g.label}`}
                      cx={CENTER}
                      cy={CENTER}
                      r={OUTER_R}
                      fill="none"
                      strokeWidth={isSectorActive(g.label) ? OUTER_T + 3 : OUTER_T}
                      strokeLinecap="butt"
                      className={`alloc-arc alloc-arc--sector${
                        isSectorActive(g.label) ? " is-active" : ""
                      }${sectorDimmed(g.label) ? " is-dim" : ""}`}
                      style={{ ...arcStyle(layout, OUTER_R, g.color, OUTER_T * 0.32), "--arc-i": i } as CSSProperties}
                      data-alloc-key={`s:${g.label}`}
                      tabIndex={drilled ? -1 : 0}
                      role={drilled ? "img" : "button"}
                      aria-label={`${g.label}: ${valueTracked ? formatCurrency(g.value) : "sector"}, ${formatPctPlain(g.pct)}. ${drilled ? "" : "Activate to drill into holdings."}`}
                      onMouseEnter={() => activateSector(g.label)}
                      onMouseLeave={(e) => clearIfOutside(`s:${g.label}`, () => setActive(null), e)}
                      onFocus={() => activateSector(g.label)}
                      onBlur={(e) => clearIfOutside(`s:${g.label}`, () => setActive(null), e)}
                      onClick={() => !drilled && setDrill(g.label)}
                      onKeyDown={(e: KeyboardEvent<SVGCircleElement>) => {
                        if (drilled || (e.key !== "Enter" && e.key !== " ")) return;
                        e.preventDefault();
                        setDrill(g.label);
                      }}
                    />
                  );
                })}

                {/* Inner ring - holdings */}
                {innerHoldings.map(({ holding, color }, i) => {
                  const layout = innerLayouts[i]!;
                  return (
                    <circle
                      key={`hold-${holding.ticker}`}
                      cx={CENTER}
                      cy={CENTER}
                      r={INNER_R}
                      fill="none"
                      strokeWidth={isHoldingActive(holding.ticker) ? INNER_T + 4 : INNER_T}
                      strokeLinecap="butt"
                      className={`alloc-arc alloc-arc--holding${
                        isHoldingActive(holding.ticker) ? " is-active" : ""
                      }${holdingDimmed(holding) ? " is-dim" : ""}`}
                      style={{ ...arcStyle(layout, INNER_R, color, INNER_T * 0.18), "--arc-i": i } as CSSProperties}
                      data-alloc-key={`h:${holding.ticker}`}
                      tabIndex={0}
                      role="button"
                      aria-label={`${holding.ticker}, ${holding.sector}: ${valueTracked ? formatCurrency(holding.value) : "unvalued"}, ${formatPctPlain(holding.pct)}. Activate to inspect.`}
                      onMouseEnter={() => activateHolding(holding)}
                      onMouseLeave={(e) => clearIfOutside(`h:${holding.ticker}`, () => setActive(null), e)}
                      onFocus={() => activateHolding(holding)}
                      onBlur={(e) => clearIfOutside(`h:${holding.ticker}`, () => setActive(null), e)}
                      onClick={() => onSelectHolding(holding.ticker)}
                      onKeyDown={(e: KeyboardEvent<SVGCircleElement>) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        onSelectHolding(holding.ticker);
                      }}
                    />
                  );
                })}

                {/* Ambient energy packet orbiting the sector ring */}
                <g className="alloc-rings__orbit" aria-hidden="true">
                  <circle cx={CENTER} cy={CENTER - OUTER_R} r={2.6} className="alloc-rings__packet" />
                </g>
              </svg>

              <div className="alloc-rings__center" aria-live="polite">
                <Readout readout={readout} valueTracked={valueTracked} />
              </div>
            </div>
          ) : (
            <AllocationBars
              sectorGroups={sectorGroups}
              valueTracked={valueTracked}
              readout={readout}
              active={active}
              onActivateSector={activateSector}
              onActivateHolding={activateHolding}
              onClear={() => setActive(null)}
              onSelectHolding={onSelectHolding}
              holdingTintFor={(g, h) => holdingTint(g.color, h.sectorRank, g.holdings.length)}
            />
          )}
        </div>

        <div className="alloc-studio__side">
          <ConcentrationGauge
            concentration={concentration}
            concentrationTicker={concentrationTicker}
            effectiveHoldings={effectiveHoldings}
            toneClass={concClass}
          />

          <AllocationLegendGrouped
            sectorGroups={sectorGroups}
            valueTracked={valueTracked}
            active={active}
            drill={drill}
            onActivateSector={activateSector}
            onActivateHolding={activateHolding}
            onClear={() => setActive(null)}
            onToggleDrill={(label) => setDrill((cur) => (cur === label ? null : label))}
            onSelectHolding={onSelectHolding}
            holdingTintFor={(g, h) => holdingTint(g.color, h.sectorRank, g.holdings.length)}
          />

          {owned && !valueTracked && onTrackValue && (
            <button type="button" className="alloc-studio__unlock" onClick={onTrackValue}>
              <span className="alloc-studio__unlock-dot" aria-hidden />
              Add shares to unlock value tracking
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/* ── Morphing centre / header readout ─────────────────────────────────────── */
function Readout({
  readout,
  valueTracked,
}: {
  readout: { value: number; pct: number | null; label: string; sub: string; color?: string };
  valueTracked: boolean;
}) {
  return (
    <>
      <span
        className="alloc-readout__value mono"
        style={readout.color ? ({ color: readout.color } as CSSProperties) : undefined}
      >
        {valueTracked ? (
          <NumberFlow
            value={readout.value}
            format={{ style: "currency", currency: "USD", maximumFractionDigits: 0 }}
            aria-label={formatCurrency(readout.value)}
          />
        ) : readout.pct != null ? (
          <NumberFlow
            value={readout.pct}
            format={{ style: "percent", maximumFractionDigits: 1 }}
            aria-label={formatPctPlain(readout.pct)}
          />
        ) : (
          readout.value
        )}
      </span>
      {readout.pct != null && (
        <span className="alloc-readout__pct mono">
          <NumberFlow
            value={readout.pct}
            format={{ style: "percent", maximumFractionDigits: 1 }}
            aria-label={formatPctPlain(readout.pct)}
          />
        </span>
      )}
      <span className="alloc-readout__label">{readout.label}</span>
      <span className="alloc-readout__sub">{readout.sub}</span>
    </>
  );
}

/* ── Bars view - grouped, animated weight bars ────────────────────────────── */
function AllocationBars({
  sectorGroups,
  valueTracked,
  readout,
  active,
  onActivateSector,
  onActivateHolding,
  onClear,
  onSelectHolding,
  holdingTintFor,
}: {
  sectorGroups: AllocationSectorGroup[];
  valueTracked: boolean;
  readout: { value: number; pct: number | null; label: string; sub: string; color?: string };
  active: Active;
  onActivateSector: (label: string) => void;
  onActivateHolding: (h: AllocationHolding) => void;
  onClear: () => void;
  onSelectHolding: (ticker: string) => void;
  holdingTintFor: (g: AllocationSectorGroup, h: AllocationHolding) => string;
}) {
  const maxPct = Math.max(...sectorGroups.flatMap((g) => g.holdings.map((h) => h.pct)), 0.0001);
  return (
    <div className="alloc-bars">
      <div className="alloc-bars__readout" aria-live="polite">
        <Readout readout={readout} valueTracked={valueTracked} />
      </div>
      <div className="alloc-bars__groups">
        {sectorGroups.map((g) => (
          <div key={g.label} className="alloc-bars__group">
            <button
              type="button"
              className={`alloc-bars__sector${
                active?.kind === "sector" && active.sector === g.label ? " is-active" : ""
              }`}
              data-alloc-key={`s:${g.label}`}
              onMouseEnter={() => onActivateSector(g.label)}
              onMouseLeave={(e) => clearIfOutside(`s:${g.label}`, onClear, e)}
              onFocus={() => onActivateSector(g.label)}
              onBlur={(e) => clearIfOutside(`s:${g.label}`, onClear, e)}
            >
              <span className="alloc-bars__swatch" style={{ background: g.color }} aria-hidden />
              <span className="alloc-bars__sector-name">{g.label}</span>
              <span className="alloc-bars__sector-pct mono">{formatPctPlain(g.pct)}</span>
            </button>
            {g.holdings.map((h) => {
              const isActive = active?.kind === "holding" && active.ticker === h.ticker;
              const dim =
                active != null && (active.kind === "holding" ? active.ticker !== h.ticker : active.sector !== h.sector);
              return (
                <button
                  key={h.ticker}
                  type="button"
                  className={`alloc-bars__row${isActive ? " is-active" : ""}${dim ? " is-dim" : ""}`}
                  data-alloc-key={`h:${h.ticker}`}
                  style={{ "--bar-w": `${(h.pct / maxPct) * 100}%` } as CSSProperties}
                  onMouseEnter={() => onActivateHolding(h)}
                  onMouseLeave={(e) => clearIfOutside(`h:${h.ticker}`, onClear, e)}
                  onFocus={() => onActivateHolding(h)}
                  onBlur={(e) => clearIfOutside(`h:${h.ticker}`, onClear, e)}
                  onClick={() => onSelectHolding(h.ticker)}
                  aria-label={`${h.ticker}, ${h.sector}: ${valueTracked ? formatCurrency(h.value) : "unvalued"}, ${formatPctPlain(h.pct)}. Activate to inspect.`}
                >
                  <span className="alloc-bars__ticker mono">{h.ticker}</span>
                  <span className="alloc-bars__track">
                    <span
                      className="alloc-bars__fill"
                      style={{ background: holdingTintFor(g, h) }}
                    />
                  </span>
                  <span className="alloc-bars__pct mono">{formatPctPlain(h.pct)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Concentration gauge ──────────────────────────────────────────────────── */
function ConcentrationGauge({
  concentration,
  concentrationTicker,
  effectiveHoldings,
  toneClass,
}: {
  concentration: number;
  concentrationTicker?: string;
  effectiveHoldings: number;
  toneClass: string;
}) {
  return (
    <div className={`alloc-gauge ${toneClass}`}>
      <div className="alloc-gauge__row">
        <span className="alloc-gauge__label">Concentration</span>
        <span className="alloc-gauge__value mono">{formatPctPlain(concentration)}</span>
      </div>
      <div
        className="alloc-gauge__meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(concentration * 100)}
        aria-label="Largest single-holding weight"
      >
        <span className="alloc-gauge__fill" style={{ width: `${Math.min(concentration, 1) * 100}%` }} />
        {/* Research-guidance thresholds: watch at 25%, review at 35%. */}
        <span className="alloc-gauge__tick" style={{ left: "25%" }} aria-hidden />
        <span className="alloc-gauge__tick" style={{ left: "35%" }} aria-hidden />
      </div>
      <p className="alloc-gauge__sub">
        {concentrationTicker ? (
          <>
            <strong className="mono">{concentrationTicker}</strong> largest ·{" "}
          </>
        ) : null}
        <strong className="mono">{effectiveHoldings.toFixed(1)}</strong> effective names
      </p>
    </div>
  );
}

/* ── Grouped legend (sectors → holdings) ──────────────────────────────────── */
function AllocationLegendGrouped({
  sectorGroups,
  valueTracked,
  active,
  drill,
  onActivateSector,
  onActivateHolding,
  onClear,
  onToggleDrill,
  onSelectHolding,
  holdingTintFor,
}: {
  sectorGroups: AllocationSectorGroup[];
  valueTracked: boolean;
  active: Active;
  drill: string | null;
  onActivateSector: (label: string) => void;
  onActivateHolding: (h: AllocationHolding) => void;
  onClear: () => void;
  onToggleDrill: (label: string) => void;
  onSelectHolding: (ticker: string) => void;
  holdingTintFor: (g: AllocationSectorGroup, h: AllocationHolding) => string;
}) {
  return (
    <div className="alloc-legend2" aria-label="Allocation legend">
      {sectorGroups.map((g) => {
        const sectorActive = active?.kind === "sector" && active.sector === g.label;
        return (
          <div key={g.label} className={`alloc-legend2__group${drill === g.label ? " is-drilled" : ""}`}>
            <button
              type="button"
              className={`alloc-legend2__sector${sectorActive ? " is-active" : ""}`}
              data-alloc-key={`s:${g.label}`}
              onMouseEnter={() => onActivateSector(g.label)}
              onMouseLeave={(e) => clearIfOutside(`s:${g.label}`, onClear, e)}
              onFocus={() => onActivateSector(g.label)}
              onBlur={(e) => clearIfOutside(`s:${g.label}`, onClear, e)}
              onClick={() => onToggleDrill(g.label)}
              aria-pressed={drill === g.label}
              aria-label={`${g.label}, ${formatPctPlain(g.pct)}. ${drill === g.label ? "Drilled in." : "Drill into holdings."}`}
            >
              <span className="alloc-legend2__swatch" style={{ background: g.color }} aria-hidden />
              <span className="alloc-legend2__sector-name">{g.label}</span>
              <span className="alloc-legend2__sector-pct mono">{formatPctPlain(g.pct)}</span>
            </button>
            <ul className="alloc-legend2__holdings">
              {g.holdings.map((h) => {
                const holdingActive = active?.kind === "holding" && active.ticker === h.ticker;
                return (
                  <li key={h.ticker}>
                    <button
                      type="button"
                      className={`alloc-legend2__row${holdingActive ? " is-active" : ""}`}
                      data-alloc-key={`h:${h.ticker}`}
                      onMouseEnter={() => onActivateHolding(h)}
                      onMouseLeave={(e) => clearIfOutside(`h:${h.ticker}`, onClear, e)}
                      onFocus={() => onActivateHolding(h)}
                      onBlur={(e) => clearIfOutside(`h:${h.ticker}`, onClear, e)}
                      onClick={() => onSelectHolding(h.ticker)}
                    >
                      <span
                        className="alloc-legend2__dot"
                        style={{ background: holdingTintFor(g, h) }}
                        aria-hidden
                      />
                      <span className="alloc-legend2__ticker">{h.ticker}</span>
                      <span className="alloc-legend2__value mono">
                        {valueTracked ? formatCurrency(h.value) : "Equal wt"}
                      </span>
                      <span className="alloc-legend2__pct mono">{formatPctPlain(h.pct)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export type { AllocationStudioProps };
