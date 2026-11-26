import { themeTagById } from "@/constants/screenThemes";
import { isCoreThemeToken } from "@/engine/narrativeIntel";
import type { StockSignal } from "@/types";

/**
 * Emerging-theme registry for the For-You "Emerging themes" filter.
 *
 * A theme = a curated, extensible bundle of evidence sources:
 *   1. `tickers` - names that ARE the theme (strongest evidence; curated +
 *      live-verified US listings, refreshed 2026-07-02 via web research - e.g.
 *      CYBR was dropped: acquired by Palo Alto, Nasdaq listing suspended 2026-02).
 *   2. `industryStrings` - provider industry labels (finnhubIndustry) tight
 *      enough to imply the theme on their own. Deliberately near-empty:
 *      "Software" is NOT cybersecurity evidence.
 *   3. keyword matching - reuses the Blueprint narrative engine
 *      (scoreNarrativeMatch + the theme's ScreenThemeTag keywords), whose
 *      core-token logic stops generic adjacency ("technology", "platform")
 *      from masquerading as theme evidence.
 *
 * Themes are sub-sector concepts (quantum ⊂ Technology), NOT sectors - the
 * 10-sector taxonomy stays untouched. Adding a theme = one entry here plus a
 * ScreenThemeTag (which Blueprint screening picks up for free).
 *
 * Full research + dated sources: docs/refinement/ + the 2026-07-02 theme-research session.
 */
export interface EmergingTheme {
  /** Stable slug persisted in preferences - never rename casually. */
  slug: string;
  label: string;
  /** One-line "why this theme, why now" shown as the chip tooltip. */
  tagline: string;
  /** Blueprint theme tag whose keyword set powers text matching. */
  screenTagId: string;
  /**
   * Optional tighter keyword set for THIS matcher when the shared Blueprint
   * tag carries terms too generic for identity matching (e.g. the space tag's
   * bare "launch"/"aerospace" would tag every product-launch thesis or A&D
   * supplier as space).
   */
  keywordsOverride?: string[];
  /** Curated US-listed tickers that are unambiguously on-theme. */
  tickers: string[];
  /** finnhubIndustry substrings (lowercase) tight enough to imply the theme. */
  industryStrings: string[];
}

export const EMERGING_THEMES: EmergingTheme[] = [
  {
    slug: "ai-infrastructure",
    label: "AI infrastructure",
    tagline:
      "The picks-and-shovels layer of $700B+ hyperscaler AI capex — power, cooling, optics, custom silicon.",
    screenTagId: "ai-infra",
    tickers: [
      "NVDA", "AVGO", "VRT", "ETN", "GEV", "PWR", "ANET", "DLR", "EQIX",
      "VST", "CEG", "MU", "SMCI", "CRWV", "NBIS", "FN", "VSH", "BE", "POWL",
    ],
    industryStrings: [],
  },
  {
    slug: "nuclear-smr",
    label: "Nuclear / SMR",
    tagline:
      "AI power demand + federal funding revived nuclear — SMR developers, uranium, and the HALEU fuel bottleneck.",
    screenTagId: "nuclear",
    tickers: [
      "OKLO", "SMR", "NNE", "XE", "LEU", "CEG", "VST", "TLN", "CCJ", "UEC",
      "DNN", "UUUU", "BWXT",
    ],
    industryStrings: [],
  },
  {
    slug: "cybersecurity",
    label: "Cybersecurity",
    tagline:
      "AI-driven threats lift security budgets while leaders compound 24–34% ARR and consolidate the platform layer.",
    screenTagId: "cybersecurity",
    tickers: [
      "PANW", "CRWD", "ZS", "NET", "FTNT", "S", "OKTA", "GEN", "CHKP",
      "RBRK", "TENB", "VRNS", "QLYS", "RPD", "SAIL", "AKAM",
    ],
    industryStrings: [],
  },
  {
    slug: "defense-tech",
    label: "Defense tech",
    tagline:
      "Unmanned-warfare doctrine and record budgets driving firm-order backlogs across drones and defense software.",
    screenTagId: "defense",
    tickers: [
      "PLTR", "AVAV", "KTOS", "RCAT", "KRMN", "LMT", "RTX", "LDOS", "LHX",
      "BAH", "AXON", "ONDS", "UMAC", "DRS", "BWXT",
    ],
    industryStrings: ["aerospace & defense"],
  },
  {
    slug: "quantum-computing",
    label: "Quantum",
    tagline:
      "Real revenue inflection (IonQ +755% YoY) plus federal quantum funding — the highest-ceiling frontier theme.",
    screenTagId: "quantum",
    tickers: ["IONQ", "RGTI", "QBTS", "QUBT", "IBM", "GOOGL", "SKYT", "HON", "ARQQ"],
    industryStrings: [],
  },
  {
    slug: "rare-earths",
    label: "Rare earths",
    tagline:
      "Export weaponization + defense stockpiling are rebuilding a domestic supply chain with price floors.",
    screenTagId: "rare-earths",
    tickers: ["MP", "USAR", "CRML", "UUUU", "NB", "IDR", "METC", "TMC"],
    industryStrings: [],
  },
  {
    slug: "quantum-security",
    label: "Post-quantum security",
    tagline:
      "Cybersecurity FOR the quantum era — NIST standards + federal mandates make PQC migration the biggest crypto refresh since Y2K.",
    screenTagId: "quantum-security",
    tickers: ["ARQQ", "LAES", "QUBT", "PANW", "IBM", "MSFT", "NET", "CRWD"],
    industryStrings: [],
  },
  {
    slug: "humanoid-robotics",
    label: "Humanoid robotics",
    tagline:
      "The demo-to-factory shift in physical AI — humanoids moved from stage demos to production lines in 2026.",
    screenTagId: "robotics",
    tickers: ["TSLA", "NVDA", "SYM", "SERV", "ISRG", "ARM", "ROK", "PATH", "RR"],
    industryStrings: [],
  },
  {
    slug: "space-economy",
    label: "Space",
    tagline:
      "Launch cadence, direct-to-device constellations, and the pending SpaceX IPO repricing the whole sector.",
    screenTagId: "space",
    // The shared space tag's bare "launch"/"aerospace"/"defense" keywords are
    // fine for Blueprint's blended scoring but too generic for a hard filter.
    keywordsOverride: [
      "spacecraft", "satellite", "orbital", "launch services", "launch vehicle",
      "lunar", "earth observation", "direct-to-device", "in-space",
    ],
    tickers: [
      "RKLB", "ASTS", "LUNR", "PL", "RDW", "FLY", "VOYG", "KRMN", "SATS",
      "GSAT", "IRDM",
    ],
    industryStrings: [],
  },
  {
    slug: "glp1-metabolic",
    label: "GLP-1 / metabolic",
    tagline:
      "The year of the obesity pill — an ~$80B+ market with heavy M&A among oral-GLP-1 challengers.",
    screenTagId: "glp1",
    tickers: [
      "LLY", "NVO", "VKTX", "GPCR", "AMGN", "PFE", "TERN", "RYTM", "ALT",
    ],
    industryStrings: [],
  },
];

export function emergingThemeBySlug(slug: string): EmergingTheme | undefined {
  return EMERGING_THEMES.find((t) => t.slug === slug);
}

/**
 * Next For-You theme scope after tapping `slug`. SELECT-first semantics: from
 * the everything-on default a tap means "show me THIS theme" (the
 * remove-one-of-ten reading made a Quantum tap DROP the quantum names -
 * backwards). From a narrowed scope, taps toggle membership; the last theme
 * can't be removed (an empty scope reads as "broken", not "filtered"); the
 * full set normalizes back to `undefined` (= all).
 */
export function nextThemeScope(
  current: string[] | undefined,
  slug: string,
  all: string[] = EMERGING_THEMES.map((t) => t.slug),
): string[] | undefined {
  if (current == null || current.length >= all.length) return [slug];
  const next = current.includes(slug)
    ? current.filter((s) => s !== slug)
    : [...current, slug];
  if (next.length === 0) return current;
  const isAll = all.length === next.length && all.every((s) => next.includes(s));
  return isAll ? undefined : next;
}

export interface ThemeHit {
  theme: EmergingTheme;
  /** Honest, data-backed evidence string ("curated name", "on-theme: qubit"). */
  evidence: string;
}

/**
 * IDENTITY text only - what the company IS, not what today's headlines mention.
 * Matching over news/social blobs tagged CBOE as "quantum" and Goldman as
 * "robot" off passing headlines; a theme is a property of the business.
 */
function identityBlob(signal: StockSignal): string {
  return [
    signal.ticker,
    signal.name,
    signal.companyBlurb,
    signal.finnhubIndustry,
    signal.thesis,
    signal.catalyst?.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function matchEmergingTheme(signal: StockSignal, theme: EmergingTheme): ThemeHit | null {
  if (theme.tickers.includes(signal.ticker)) {
    return { theme, evidence: `curated ${theme.label} name` };
  }
  const industry = signal.finnhubIndustry?.toLowerCase();
  if (industry && theme.industryStrings.some((s) => industry.includes(s))) {
    return { theme, evidence: `${signal.finnhubIndustry} industry` };
  }
  const tag = themeTagById(theme.screenTagId);
  const keywords = theme.keywordsOverride ?? (tag ? [tag.label.toLowerCase(), ...tag.keywords] : []);
  if (keywords.length > 0) {
    const blob = identityBlob(signal);
    const hits = keywords.filter((k) => blob.includes(k));
    // Require a CORE hit: the identity text must actually name the concept
    // ("qubit", "uranium"), not merely brush past a generic adjacent word.
    const coreHits = hits.filter((k) => isCoreThemeToken(k));
    if (coreHits.length > 0) {
      return { theme, evidence: `on-theme: ${coreHits.slice(0, 2).join(", ")}` };
    }
  }
  return null;
}

/**
 * All emerging-theme hits for one signal, restricted to `activeSlugs` when the
 * user has narrowed the theme scope (absent/empty = all curated themes).
 */
export function emergingThemeHits(signal: StockSignal, activeSlugs?: string[]): ThemeHit[] {
  const scope =
    activeSlugs && activeSlugs.length > 0
      ? EMERGING_THEMES.filter((t) => activeSlugs.includes(t.slug))
      : EMERGING_THEMES;
  const hits: ThemeHit[] = [];
  for (const theme of scope) {
    const hit = matchEmergingTheme(signal, theme);
    if (hit) hits.push(hit);
  }
  return hits;
}
