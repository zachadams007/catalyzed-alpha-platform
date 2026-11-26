/** Short tag so readers immediately know this is a disclaimer. */
export const INVESTING_DISCLAIMER_LABEL = "Financial disclaimer";

/** The plain-English gist, shown right after the label. */
export const INVESTING_DISCLAIMER_TAGLINE = "Do your own research — not financial advice.";

/** Film quote - humor only; not attributed to Catalyzed Alpha or the user. */
export const INVESTING_DISCLAIMER_QUOTE =
  '"Nobody knows if a stock is gonna go up, down, sideways, or in circles." — Mark Hanna, The Wolf of Wall Street (2013)';

/** Provenance note - keeps the sample/modeled-data framing honest. */
export const INVESTING_DISCLAIMER_NOTE =
  "Catalyzed Alpha is for research and discovery only. Prices, news links, and analyst targets may be live when labeled; momentum, social, and some fundamentals remain modeled.";

/** Composed one-liner for any non-component consumer (meta tags, etc.). */
export const INVESTING_DISCLAIMER = `${INVESTING_DISCLAIMER_LABEL}: ${INVESTING_DISCLAIMER_TAGLINE} ${INVESTING_DISCLAIMER_QUOTE} ${INVESTING_DISCLAIMER_NOTE}`;
