import type { ExecutiveSignalItem, ExecutiveSignalSummary } from "@/types";
import { ExternalLink } from "@/components/common/ExternalLink";
import { IconExternal, IconMega } from "@/components/icons";

interface ExecutiveSignalCalloutProps {
  signal: ExecutiveSignalSummary;
  /**
   * Compact one-line banner for the scrolling FEED tile - the same highlight the
   * full page shows, condensed so it isn't buried (a President buy/spotlight is
   * often THE reason a name is interesting). Links straight to the source.
   */
  compact?: boolean;
}

function dayLabel(iso: string): string {
  const ms = new Date(`${iso}T00:00:00Z`).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function tagLabel(kind: ExecutiveSignalItem["kind"]): string {
  switch (kind) {
    case "buy":
      return "Disclosed buy";
    case "sell":
      return "Disclosed sale";
    case "favorable_callout":
      return "Named — favorable";
    case "adverse_callout":
      return "Named — adverse";
  }
}

function Row({ item, tone }: { item: ExecutiveSignalItem; tone: "bull" | "bear" }) {
  return (
    <ExternalLink
      href={item.sourceUrl}
      className={`exec-callout__row exec-callout__row--${tone}`}
      title={`${item.actor} — ${item.summary}`}
    >
      <span className={`exec-callout__tag exec-callout__tag--${tone}`}>{tagLabel(item.kind)}</span>
      <span className="exec-callout__body">
        <span className="exec-callout__text">{item.summary}</span>
        <span className="exec-callout__meta text-faint">
          {item.actor} · {dayLabel(item.date)} · {item.sourceLabel}
        </span>
      </span>
      <IconExternal size={12} className="exec-callout__ext" />
    </ExternalLink>
  );
}

/**
 * Direction-aware "the President bought / named this ticker" callout for the
 * stock detail page. Surfaces the strongest favorable and/or adverse executive-
 * branch signal, each linking to its real source (OGE Form 278-T or the dated
 * statement). Renders nothing when the President has no disclosed signal for the
 * name. Real, sourced data only - see src/data/terminal/executiveTrades.ts.
 */
export function ExecutiveSignalCallout({ signal, compact = false }: ExecutiveSignalCalloutProps) {
  const { favorable, adverse } = signal;
  if (!favorable && !adverse) return null;

  const headline =
    signal.direction === "bullish"
      ? "🏛️ Spotlighted by the President"
      : signal.direction === "bearish"
        ? "🏛️ In the President's crosshairs"
        : "🏛️ On the President's radar";

  // Feed tile: a single prominent line - headline + what happened - linking out.
  // The strongest item leads (favorable preferred); the rich rows + sourcing live
  // on the stock page.
  if (compact) {
    const lead = favorable ?? adverse!;
    const tone = favorable ? "bull" : "bear";
    return (
      <ExternalLink
        href={lead.sourceUrl}
        className={`exec-callout exec-callout--compact exec-callout--${signal.direction}`}
        title={`${lead.actor} — ${lead.summary}`}
        aria-label="Executive-branch political signal"
      >
        <IconMega size={14} className="exec-callout__icon" />
        <span className="exec-callout__title">{headline}</span>
        <span className={`exec-callout__tag exec-callout__tag--${tone}`}>{tagLabel(lead.kind)}</span>
        <span className="exec-callout__text">{lead.summary}</span>
        <IconExternal size={11} className="exec-callout__ext" />
      </ExternalLink>
    );
  }

  return (
    <section
      className={`exec-callout exec-callout--${signal.direction}`}
      aria-label="Executive-branch political signal"
    >
      <div className="exec-callout__head">
        <IconMega size={15} className="exec-callout__icon" />
        <span className="exec-callout__title">{headline}</span>
      </div>
      <div className="exec-callout__rows">
        {favorable && <Row item={favorable} tone="bull" />}
        {adverse && <Row item={adverse} tone="bear" />}
      </div>
      <p className="exec-callout__foot text-faint">
        Real, sourced executive-branch disclosures (OGE Form 278-T) &amp; dated public statements.
        Direction-aware — favorable lifts the catalyst read, adverse policy weighs on it. Not advice.
      </p>
    </section>
  );
}
