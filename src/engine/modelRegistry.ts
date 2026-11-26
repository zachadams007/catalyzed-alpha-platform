import type { EngineVariantId } from "./challenger";

/**
 * Model registry / changelog: the Operator's control surface for the
 * champion/challenger loop.
 *
 * Every engine version is an entry: what it is, what changed, when it was
 * created, and when/by whom it was promoted. `championId` marks the live model.
 * Promotion/rollback are pure transforms; the store mirrors `championId`'s kind
 * into the runtime variant override so the decision is real, not cosmetic.
 */

export interface ModelRegistryEntry {
  /** Stable id. */
  id: string;
  /** Short human label. */
  label: string;
  /** Which engine variant this version runs as. */
  kind: EngineVariantId;
  /** What changed in this version. */
  changeSummary: string;
  /** ISO timestamp the version was registered. */
  createdAtISO: string;
  /** ISO timestamp it last became champion. */
  promotedAtISO?: string;
  /** Operator who promoted it. */
  promotedBy?: string;
}

export interface ModelRegistry {
  /** Versions, newest first. */
  entries: ModelRegistryEntry[];
  /** Id of the current live champion. */
  championId: string;
}

const V4_CREATED_ISO = "2026-06-28T00:00:00.000Z";
const V4_PROMOTED_ISO = "2026-06-30T00:00:00.000Z";
const V5_CREATED_ISO = "2026-07-01T00:00:00.000Z";
const V5_PROMOTED_ISO = "2026-07-11T00:00:00.000Z";
const V6_CREATED_ISO = "2026-07-25T00:00:00.000Z";
const V7_CREATED_ISO = "2026-09-17T00:00:00.000Z";

/** Rollback baseline: the V4 archetype + regime engine. */
export const CHAMPION_BASE_ID = "champion-v4-archetype-regime";
/** Live model: the V5 reversal-first engine. */
export const CHALLENGER_FUNNEL_ID = "challenger-v5-reversal-first";
/** Candidate: the V6 misunderstood-quality engine (registered, NOT promoted). */
export const V6_MISUNDERSTOOD_ID = "v6-misunderstood-quality";
/** Candidate: the V7 synthesis (registered, NOT promoted). */
export const V7_SYNTHESIS_ID = "v7-synthesis";

/**
 * Default registry: V5 reversal-first remains live. V6 is REGISTERED as a
 * candidate only - promoting it is a deliberate operator action, not a
 * side-effect of shipping the code.
 */
export function seedModelRegistry(): ModelRegistry {
  return {
    championId: CHALLENGER_FUNNEL_ID,
    entries: [
      {
        id: V7_SYNTHESIS_ID,
        kind: "v7",
        label: "V7 - Synthesis (candidate)",
        changeSummary:
          "The best of every July-2026 version, sized by a backtest of all nine against live closes on 2026-09-16. Keeps every data-layer fix, the asymmetry tilt, the discount-led compounder, consolidation-as-room and the good-price readiness floor. Removes the absolute-P/E penalty outright - the only version carrying it demoted a strong name for its multiple, and PEG inside the fundamentals score already prices the multiple. Shrinks the own-history tilt from 18 to 10 (shipped at 6, raised on 2026-09-19 once the pre-earnings replay showed the tilt could not separate a name at its own five-year-high multiple from one merely near a price high) and the attention tilt from 10 to 5, and softens entry-quality damping. Same day, three engine-wide corrections: extension now means price outran the business (not near a 52-week high), a lender's disclosed total revenue beats its partial contract tag, and the quarterly re-acceleration read is seasonally matched. One short window is evidence, not proof; V6 stays registered so the two can be compared on the same board.",
        createdAtISO: V7_CREATED_ISO,
      },
      {
        id: V6_MISUNDERSTOOD_ID,
        kind: "v6",
        label: "V6 - Misunderstood quality (candidate)",
        changeSummary:
          "V5 plus the T4 misunderstood-quality archetype. A 2026-07-25 board audit found the dimensions that were supposed to carry V5's reversal-first identity had no inputs in production: pipeline, sentimentShift and the own-history valuation percentile all scored a flat neutral 50 for 100% of the published board, so the model was ranking mostly on price action. V6 folds DISCLOSED SEC XBRL remaining-performance-obligation and contract-liability figures into the scan (about 45% of the board gains real order-book data) and adds an archetype for a profitable large cap in a deep drawdown whose contracted demand is compounding far ahead of recognized revenue - where bad price momentum is the precondition rather than a disqualifier. Risk penalties, anti-lottery guards, falling-knife discipline and cap balancing are unchanged from V5.",
        createdAtISO: V6_CREATED_ISO,
      },
      {
        id: CHALLENGER_FUNNEL_ID,
        kind: "challenger",
        label: "V5 - Reversal-first Champion",
        changeSummary:
          "The live model. It keeps the V4 archetype router, regime tilt, and cap-cohort routing, then cuts momentum's weight about 70% and redistributes it into early-entry signals: inflection, entry timing, catalyst, sentiment shift, and pipeline. July 11 live tweak: discounted high-quality large/mega compounders get a bounded lift so names like Microsoft do not sit near 50 just because they lack a fresh catalyst, while commodity/regulated cyclicals still need their own catalyst or inflection proof.",
        createdAtISO: V5_CREATED_ISO,
        promotedAtISO: V5_PROMOTED_ISO,
        promotedBy: "operator",
      },
      {
        id: CHAMPION_BASE_ID,
        kind: "champion",
        label: "V4 - Archetype + regime rollback",
        changeSummary:
          "The prior live model. It keeps the V3 catalyst-driven engine and adds the winner-study archetype router: mega-cap discounted reversals, re-accelerating mid-cap compounders, and small-cap runners each judged on the curve that predicts their moves, plus revenue re-acceleration and margin-turn evidence ahead of raw momentum, false-positive screens, and one upstream market-regime tilt.",
        createdAtISO: V4_CREATED_ISO,
        promotedAtISO: V4_PROMOTED_ISO,
        promotedBy: "operator",
      },
    ],
  };
}

function isEntry(e: unknown): e is ModelRegistryEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<ModelRegistryEntry>;
  return (
    typeof x.id === "string" &&
    (x.kind === "champion" || x.kind === "challenger" || x.kind === "v6" || x.kind === "v7") &&
    typeof x.label === "string" &&
    typeof x.changeSummary === "string" &&
    typeof x.createdAtISO === "string"
  );
}

/** Tolerant coercion of a persisted value; falls back to the seed when invalid. */
export function normalizeModelRegistry(value: unknown): ModelRegistry {
  if (!value || typeof value !== "object") return seedModelRegistry();
  const v = value as Partial<ModelRegistry>;
  if (!Array.isArray(v.entries)) return seedModelRegistry();
  const entries = v.entries.filter(isEntry);
  if (entries.length === 0) return seedModelRegistry();
  const championId = entries.some((e) => e.id === v.championId)
    ? (v.championId as string)
    : (entries.find((e) => e.kind === "champion")?.id ?? entries[0]!.id);
  return { entries, championId };
}

/** Promote a version to champion. Pure. */
export function promoteModelEntry(
  reg: ModelRegistry,
  id: string,
  nowISO: string,
  by: string,
): ModelRegistry {
  if (!reg.entries.some((e) => e.id === id)) return reg;
  return {
    championId: id,
    entries: reg.entries.map((e) =>
      e.id === id ? { ...e, promotedAtISO: nowISO, promotedBy: by } : e,
    ),
  };
}

/** Roll the champion back to a prior version. Pure. */
export function rollbackModelEntry(
  reg: ModelRegistry,
  id: string,
  nowISO: string,
  by: string,
): ModelRegistry {
  return promoteModelEntry(reg, id, nowISO, by);
}

export function currentChampion(reg: ModelRegistry): ModelRegistryEntry | undefined {
  return reg.entries.find((e) => e.id === reg.championId);
}

/** The engine variant the current champion runs as. */
export function variantForRegistry(reg: ModelRegistry): EngineVariantId {
  return currentChampion(reg)?.kind ?? "challenger";
}
