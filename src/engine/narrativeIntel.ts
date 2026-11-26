import { themeTagById } from "@/constants/screenThemes";
import type { StockSignal } from "@/types";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "with",
  "that",
  "this",
  "want",
  "like",
  "have",
  "been",
  "are",
  "was",
  "stocks",
  "stock",
  "companies",
  "company",
  "could",
  "would",
  "should",
  "potential",
  "promising",
  "next",
  "big",
  "growth",
  "areas",
  "examples",
  "looking",
  "find",
  "names",
  "cap",
  "mid",
  "large",
  "high",
  "low",
  "computing",
]);

const PHRASE_EXPANSIONS: Record<string, string[]> = {
  nvidia: ["gpu", "accelerator", "datacenter", "inference", "ai"],
  nvda: ["gpu", "accelerator", "datacenter"],
  robotics: ["robot", "automation", "humanoid", "cobot", "warehouse"],
  quantum: ["qubit", "photonic", "superconducting", "cryogenic", "annealing"],
  biotech: ["clinical", "fda", "therapy", "genomic"],
  "artificial intelligence": ["inference", "model", "llm", "gpu"],
  "clean energy": ["solar", "battery", "hydrogen", "grid"],
  "meme stock": ["retail", "squeeze", "viral", "wsb"],
  "earnings beat": ["earnings", "guidance", "revenue", "margin"],
  "short squeeze": ["short", "squeeze", "borrow", "retail"],
};

const CORE_THEME_TOKENS = new Set([
  "quantum",
  "qubit",
  "photonic",
  "superconducting",
  "cryogenic",
  "annealing",
  "robotics",
  "robot",
  // "automation" + "warehouse" are deliberately NOT core: they're genuinely
  // ambiguous (banks/retailers "automate", everyone has a "warehouse"), so a single
  // generic mention must not score a name as conclusively on-theme. Real robotics
  // names (Symbotic, Serve, Intuitive) also hit "robot"/"robotics", so they're
  // unaffected. Moved to WEAK_ADJACENCY_TOKENS below.
  "humanoid",
  "cobot",
  "clinical",
  "fda",
  "therapy",
  "genomic",
  "satellite",
  "launch",
  "orbital",
  "aerospace",
  "solar",
  "battery",
  "hydrogen",
  "lithium",
  "payments",
  "neobank",
  "lending",
  "blockchain",
  "semiconductor",
  "semiconductors",
  "chip",
  "foundry",
  "asic",
  "packaging",
  "policy",
  "congress",
  "tariff",
  // Emerging-theme cores (2026-07): specific enough that one real mention is
  // conclusive on-theme evidence. Deliberately EXCLUDED as too ambiguous:
  // "defense" (matches "defensive"), "encryption"/"cryptography" (generic
  // security copy), "enrichment" (data enrichment), "reactor" (bioreactor),
  // "grid"/"obesity-adjacent" generic wellness copy.
  "cybersecurity",
  "endpoint security",
  "ransomware",
  "firewall",
  "zero trust",
  "sase",
  "post-quantum",
  "quantum-safe",
  "quantum-resistant",
  "post quantum cryptography",
  "quantum encryption",
  "quantum key",
  "hyperscale",
  "liquid cooling",
  "optical transceiver",
  "silicon photonics",
  "nuclear",
  "uranium",
  "small modular reactor",
  "microreactor",
  "haleu",
  "triso",
  "drone",
  "missile",
  "hypersonic",
  "loitering munition",
  "counter-drone",
  "electronic warfare",
  "rare earth",
  "neodymium",
  "praseodymium",
  "dysprosium",
  "permanent magnet",
  "glp-1",
  "semaglutide",
  "tirzepatide",
  "orforglipron",
  "incretin",
  "spacecraft",
  "launch services",
  "lunar",
  "earth observation",
  "direct-to-device",
  "physical ai",
  "embodied ai",
]);

const WEAK_ADJACENCY_TOKENS = new Set([
  "ai",
  "model",
  "training",
  "technology",
  "product",
  "software",
  "platform",
  "digital",
  // Ambiguous theme-adjacent words: relevant but not conclusive on their own.
  "automation",
  "warehouse",
]);

const NICHE_INTENT_TOKENS = new Set([
  "niche",
  "emerging",
  "undiscovered",
  "underfollowed",
  "micro",
  "nano",
  "small",
  "smaller",
  "startup",
  "startups",
]);

function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(raw)];
}

function expandPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const [phrase, extras] of Object.entries(PHRASE_EXPANSIONS)) {
    if (lower.includes(phrase)) out.push(...extras);
  }
  return out;
}

function keywordWeight(keyword: string): number {
  if (CORE_THEME_TOKENS.has(keyword)) return 2.4;
  if (NICHE_INTENT_TOKENS.has(keyword)) return 1.5;
  if (WEAK_ADJACENCY_TOKENS.has(keyword)) return 0.45;
  return 1;
}

/**
 * Is this keyword specific enough that one real mention is conclusive
 * on-theme evidence? (Exported for the For-You emerging-theme matcher, which
 * requires a core hit so generic adjacency can't tag a name into a theme.)
 */
export function isCoreThemeToken(keyword: string): boolean {
  return CORE_THEME_TOKENS.has(keyword);
}

export interface NarrativeIntel {
  keywords: string[];
  themeLabels: string[];
  /** 0..100 - how much narrative text is driving the screen. */
  narrativeStrength: number;
}

/**
 * Build searchable tokens from description + optional theme tag ids.
 * Used by Blueprint - deterministic, explainable, no API key required.
 */
export function buildNarrativeIntel(
  description: string,
  themeTagIds?: string[],
  explicitKeywords?: string[],
): NarrativeIntel {
  const fromText = tokenize(description);
  const fromPhrases = expandPhrases(description);
  const themeLabels: string[] = [];
  const fromThemes: string[] = [];

  for (const id of themeTagIds ?? []) {
    const tag = themeTagById(id);
    if (!tag) continue;
    themeLabels.push(tag.label);
    fromThemes.push(tag.id, tag.label.toLowerCase(), ...tag.keywords);
  }

  const keywords = [
    ...new Set([
      ...fromText,
      ...fromPhrases,
      ...fromThemes,
      ...(explicitKeywords ?? []).map((k) => k.toLowerCase()),
    ]),
  ].slice(0, 40);

  const narrativeStrength = Math.min(
    100,
    Math.round(
      Math.min(description.trim().length / 4, 40) +
        (themeTagIds?.length ?? 0) * 10 +
        keywords.reduce((sum, k) => sum + keywordWeight(k), 0) * 1.7,
    ),
  );

  return { keywords, themeLabels, narrativeStrength };
}

export function hasNicheIntent(keywords: string[]): boolean {
  return keywords.some((k) => NICHE_INTENT_TOKENS.has(k));
}

export function narrativeBlob(signal: StockSignal): string {
  // Defensive reads: `news.items` and `socialPosts` are sample-only fields that
  // some live/shared-cache signal sources omit. They're optional flavor for the
  // text blob - a missing one must never throw and abort the whole screen
  // (an unguarded `.map` here was emptying the Blueprint leaderboard).
  const headlines = signal.news?.items?.map((n) => n.headline).join(" ") ?? "";
  const posts = signal.socialPosts?.map((p) => p.text).join(" ") ?? "";
  return [
    signal.ticker,
    signal.name,
    signal.sector,
    signal.thesis,
    signal.catalyst?.description,
    signal.newsInsight,
    signal.socialSummary,
    headlines,
    posts,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function scoreNarrativeMatch(
  signal: StockSignal,
  keywords: string[],
): { score: number; hits: string[] } {
  if (keywords.length === 0) return { score: 50, hits: [] };

  const blob = narrativeBlob(signal);
  const hits = keywords.filter((k) => blob.includes(k));
  const totalWeight = keywords.reduce((sum, k) => sum + keywordWeight(k), 0);
  const hitWeight = hits.reduce((sum, k) => sum + keywordWeight(k), 0);
  const coreKeywords = keywords.filter((k) => CORE_THEME_TOKENS.has(k));
  const coreHits = hits.filter((k) => CORE_THEME_TOKENS.has(k));
  const ratio = totalWeight > 0 ? hitWeight / totalWeight : 0;

  // A CORE theme token ("quantum", "robot", "fda", …) is SPECIFIC, near-conclusive
  // evidence: a name whose scan text actually names the concept is on-theme even if
  // it doesn't also mention every niche sub-term (qubit, photonic) OR every OTHER
  // theme the user combined (quantum + robotics). So a strong core hit drives the
  // score DIRECTLY rather than being diluted by the ratio across the full keyword
  // set - that dilution was scoring a real quantum name (IonQ matches just
  // "quantum" → 1 of 11 combined tokens → ratio ~0.09) at ~35 and burying it under
  // generic high-quality names. Breadth still earns a score on its own for names
  // with no single core hit (e.g. free-text/adjacency matches).
  const coreScore = coreHits.length > 0 ? Math.min(100, 70 + (coreHits.length - 1) * 12) : 0;
  const breadthScore = 24 + ratio * 60;
  let score = Math.round(Math.max(coreScore, breadthScore));

  // A theme was explicitly selected but this name matched NONE of its core tokens -
  // generic adjacency must not masquerade as theme evidence. This is what keeps
  // HOOD / TSLA / INTC from winning a "quantum" screen.
  if (coreKeywords.length > 0 && coreHits.length === 0) score = Math.min(score, 42);

  return { score: Math.max(20, Math.min(100, score)), hits };
}

/** Live preview chips for the narrative panel. */
export function previewNarrativeChips(description: string, themeTagIds?: string[]): string[] {
  const intel = buildNarrativeIntel(description, themeTagIds);
  return intel.keywords.slice(0, 12);
}
