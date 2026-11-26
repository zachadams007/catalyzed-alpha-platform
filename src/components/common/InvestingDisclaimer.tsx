import {
  INVESTING_DISCLAIMER_LABEL,
  INVESTING_DISCLAIMER_TAGLINE,
  INVESTING_DISCLAIMER_QUOTE,
  INVESTING_DISCLAIMER_NOTE,
} from "@/lib/disclaimer";

type Props = {
  /** Tighter line height for sidebar / footers */
  compact?: boolean;
  className?: string;
};

export function InvestingDisclaimer({ compact = false, className = "" }: Props) {
  return (
    <p
      className={`disclaimer ${compact ? "disclaimer--compact" : ""} ${className}`.trim()}
      role="note"
    >
      <span className="disclaimer__label">
        <strong>{INVESTING_DISCLAIMER_LABEL}:</strong> {INVESTING_DISCLAIMER_TAGLINE}
      </span>
      <span className="disclaimer__quote">{INVESTING_DISCLAIMER_QUOTE}</span>{" "}
      {INVESTING_DISCLAIMER_NOTE}
    </p>
  );
}
