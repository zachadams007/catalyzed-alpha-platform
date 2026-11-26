import { Link } from "react-router-dom";
import type { CrossListing } from "@/types";

/**
 * Small exchange · currency chip for the headline listing (e.g. "TSX · CAD").
 * Renders nothing when the exchange is unknown, so US cards that don't carry a
 * listing label are visually unchanged.
 */
export function ListingBadge({
  exchange,
  currency,
  className,
}: {
  exchange?: string;
  currency?: string;
  className?: string;
}) {
  if (!exchange) return null;
  return (
    <span className={`listing-chip${className ? ` ${className}` : ""}`} title={`Listed on ${exchange}${currency ? ` · trades in ${currency}` : ""}`}>
      <span className="listing-chip__ex mono">{exchange}</span>
      {currency && <span className="listing-chip__ccy">{currency}</span>}
    </span>
  );
}

/**
 * Brokerage-style dual-listing strip for the detail view - the company's
 * exchange listings, primary first, each a link to that listing's quote. Renders
 * nothing for single-listing names.
 */
export function CrossListings({
  listings,
  activeSymbol,
}: {
  listings: CrossListing[] | undefined;
  activeSymbol: string;
}) {
  if (!listings || listings.length < 2) return null;
  const active = activeSymbol.trim().toUpperCase();
  return (
    <div className="cross-listings" aria-label="Exchange listings">
      <span className="cross-listings__label">Listings</span>
      <div className="cross-listings__chips">
        {listings.map((l) => {
          const isActive = l.symbol.toUpperCase() === active;
          return (
            <Link
              key={l.symbol}
              to={`/signal/${l.symbol}`}
              className={`listing-chip listing-chip--link${isActive ? " is-active" : ""}${
                l.isPrimary ? " is-primary" : ""
              }`}
              title={`${l.symbol} · ${l.exchangeLabel} · ${l.currency}${l.isPrimary ? " (primary listing)" : ""}`}
              aria-current={isActive ? "true" : undefined}
            >
              <span className="listing-chip__sym mono">{l.symbol}</span>
              <span className="listing-chip__ex">{l.exchangeLabel}</span>
              <span className="listing-chip__ccy">{l.currency}</span>
              {l.isPrimary && <span className="listing-chip__tag">primary</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
