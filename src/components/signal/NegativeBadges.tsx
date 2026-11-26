import type { ReactNode } from "react";
import type { StockSignal } from "@/types";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconUser,
  IconCore,
  IconNews,
  IconShield,
} from "@/components/icons";
import {
  deriveNegativeSignals,
  type NegativeKind,
} from "@/feed/negativeSignals";
import "./negative-badges.css";

const KIND_ICON: Record<NegativeKind, ReactNode> = {
  insider_selling: <IconUser size={11} />,
  congress_selling: <IconCore size={11} />,
  downgrade: <IconArrowDown size={11} />,
  deteriorating: <IconArrowDown size={11} />,
  bad_news: <IconNews size={11} />,
  high_risk: <IconShield size={11} />,
};

interface NegativeBadgesProps {
  signal: StockSignal;
  /** Cap the number of chips (worst-first). */
  limit?: number;
  className?: string;
}

/**
 * Honest negative badges for a held / watchlisted feed card - "Insider selling",
 * "Congress selling", "Analyst sells", "Deteriorating", "Bad news". Worst-first.
 * Renders nothing when the name has no real red flag (honest both ways). Callers
 * gate on ownership; this component itself only renders REAL, sourced negatives.
 */
export function NegativeBadges({ signal, limit = 3, className }: NegativeBadgesProps) {
  const negatives = deriveNegativeSignals(signal).slice(0, limit);
  if (negatives.length === 0) return null;

  return (
    <div className={`neg-badges ${className ?? ""}`} aria-label="Watch-outs on a name you follow">
      <span className="neg-badges__lead" aria-hidden>
        <IconAlertTriangle size={11} />
        Watch-out
      </span>
      {negatives.map((n) => (
        <span
          key={n.kind}
          className={`neg-badge neg-badge--${n.severity}`}
          title={n.detail}
        >
          <span className="neg-badge__icon" aria-hidden>
            {KIND_ICON[n.kind]}
          </span>
          <span className="neg-badge__label">{n.label}</span>
        </span>
      ))}
    </div>
  );
}
