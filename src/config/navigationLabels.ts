/**
 * Display names for System nav tiles.
 * Routes stay stable (/forge, /beacon, /core) so bookmarks keep working.
 */

export const SYSTEM_NAV = {
  forge: {
    path: "/forge",
    /** Screening + filters + narrative */
    label: "Blueprint",
    tagline: "Your custom stock screen — filters, horizon & themes",
  },
  beacon: {
    path: "/beacon",
    /** Single-symbol resolve - scope/snipe vibe + clear ticker intent */
    label: "Ticker Scope",
    tagline: "Scope one symbol — company name or ticker (e.g. Google → GOOG)",
  },
  core: {
    path: "/core",
    /** How the engine works */
    label: "Algorithm",
    tagline: "Scoring, data sources & screening — no black box",
  },
  terminal: {
    path: "/terminal",
    /** Live market-intelligence wire */
    label: "Terminal",
    tagline: "Live catalysts, insider buys & political trades as they break",
  },
} as const;
