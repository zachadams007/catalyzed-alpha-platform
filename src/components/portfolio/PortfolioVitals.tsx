import { useMemo, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";

type NumberFlowFormat = NonNullable<ComponentProps<typeof NumberFlow>["format"]>;
import { IconAlertTriangle, IconSparkle } from "@/components/icons";
import {
  computePortfolioVitals,
  type PortfolioAnalytics,
  type PortfolioVital,
} from "@/engine/portfolioAnalytics";
import { formatPctPlain, formatSignedCurrency } from "@/lib/format";

interface VitalTile {
  key: string;
  label: string;
  /** Numeric value for NumberFlow. */
  value: number;
  format: NumberFlowFormat;
  ariaValue: string;
  ticker?: string;
  sub: string;
  tone: "positive" | "negative" | "neutral";
}

function toneClass(tone: VitalTile["tone"]): string {
  if (tone === "positive") return "pl-pos";
  if (tone === "negative") return "pl-neg";
  return "";
}

function perfTile(vital: PortfolioVital | undefined): VitalTile | null {
  if (!vital || vital.ratio == null) return null;
  return {
    key: vital.key,
    label: vital.label,
    value: vital.ratio,
    format: { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" },
    ariaValue: formatPctPlain(vital.ratio),
    ticker: vital.ticker,
    sub: `${vital.ticker ?? ""} · ${formatSignedCurrency(vital.value)}`.trim(),
    tone: vital.tone,
  };
}

/**
 * Instrument-grade "vitals" strip - the headline derived numbers (diversification,
 * concentration, sector tilt, best/worst, day mover) plus honest concentration /
 * sector warnings. Complements the hero valuation rather than repeating it.
 */
export function PortfolioVitals({
  analytics,
  valueTracked,
}: {
  analytics: PortfolioAnalytics;
  valueTracked: boolean;
}) {
  const vitals = useMemo(() => computePortfolioVitals(analytics), [analytics]);

  const tiles: VitalTile[] = [];

  tiles.push({
    key: "diversification",
    label: "Diversification",
    value: vitals.effectiveHoldings,
    format: { maximumFractionDigits: 1 },
    ariaValue: vitals.effectiveHoldings.toFixed(1),
    sub: `${vitals.sectorCount} sector${vitals.sectorCount === 1 ? "" : "s"} · effective names`,
    tone: "neutral",
  });

  if (vitals.concentrationTicker) {
    tiles.push({
      key: "concentration",
      label: "Top concentration",
      value: vitals.concentration,
      format: { style: "percent", maximumFractionDigits: 1 },
      ariaValue: formatPctPlain(vitals.concentration),
      ticker: vitals.concentrationTicker,
      sub: `${vitals.concentrationTicker} is the largest weight`,
      tone: vitals.concentration >= 0.35 ? "negative" : "neutral",
    });
  }

  if (vitals.topSector) {
    tiles.push({
      key: "sector",
      label: "Sector tilt",
      value: vitals.topSectorWeight,
      format: { style: "percent", maximumFractionDigits: 1 },
      ariaValue: formatPctPlain(vitals.topSectorWeight),
      sub: `${vitals.topSector}`,
      tone: vitals.topSectorWeight >= 0.55 ? "negative" : "neutral",
    });
  }

  const mover = perfTile(vitals.mover);
  if (mover) tiles.push({ ...mover, label: "Day's mover" });
  const best = perfTile(vitals.best);
  if (best) tiles.push(best);
  const worst = perfTile(vitals.worst);
  if (worst) tiles.push(worst);

  if (tiles.length === 0) return null;

  return (
    <section className="pf-vitals" aria-label="Portfolio vitals">
      <div className="pf-vitals__grid">
        {tiles.map((tile, i) => (
          <article
            key={tile.key}
            className="pf-vital pf-reveal"
            style={{ "--reveal-index": i } as CSSProperties}
          >
            <span className="pf-vital__label">{tile.label}</span>
            <span className={`pf-vital__value mono ${toneClass(tile.tone)}`}>
              <NumberFlow value={tile.value} format={tile.format} aria-label={tile.ariaValue} />
            </span>
            <span className="pf-vital__sub">{tile.sub}</span>
          </article>
        ))}
      </div>

      {valueTracked && vitals.warnings.length > 0 && (
        <ul className="pf-vitals__warnings" aria-label="Concentration & sector notes">
          {vitals.warnings.map((w, i): ReactNode => (
            <li key={`${w.kind}-${i}`} className={`pf-warning pf-warning--${w.severity}`}>
              <span className="pf-warning__icon" aria-hidden>
                {w.severity === "risk" ? <IconAlertTriangle size={15} /> : <IconSparkle size={15} />}
              </span>
              <div>
                <strong className="pf-warning__title">{w.title}</strong>
                <p className="pf-warning__detail">{w.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
