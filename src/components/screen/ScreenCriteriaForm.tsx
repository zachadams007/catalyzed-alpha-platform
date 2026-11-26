import { useEffect, useState, type ReactNode } from "react";
import type {
  CatalystType,
  MarketCapBucket,
  RiskLevel,
  ScreenCriteria,
  Sector,
  TradeHorizon,
} from "@/types";
import { TradeHorizonPicker } from "@/components/screen/TradeHorizonPicker";
import { NarrativeIntelPanel } from "@/components/screen/NarrativeIntelPanel";
import { MarketCapChip } from "@/components/screen/MarketCapChip";
import { InfoTip } from "@/components/common/Tooltip";
import { formatVolume } from "@/lib/format";

const ALL_SECTORS: Sector[] = [
  "Technology",
  "Healthcare",
  "Financials",
  "Energy",
  "Consumer",
  "Industrials",
  "Communications",
  "Materials",
  "Utilities",
  "Real Estate",
];

const ALL_CAPS: MarketCapBucket[] = ["Nano", "Micro", "Small", "Mid", "Large", "Mega"];

const ALL_CATALYSTS: CatalystType[] = [
  "Earnings",
  "Product",
  "M&A",
  "Regulatory",
  "Political",
  "Macro",
  "Technical",
  "Insider",
  "Partnership",
  "Clinical",
];

const ALL_RISKS: RiskLevel[] = ["Low", "Moderate", "Elevated", "High", "Extreme"];

const SCORE_CATS: Array<{ key: keyof NonNullable<ScreenCriteria["minCategoryScores"]>; label: string }> = [
  { key: "fundamentals", label: "Fundamentals" },
  { key: "growth", label: "Growth" },
  { key: "momentum", label: "Momentum" },
  { key: "catalyst", label: "Catalyst" },
  { key: "news", label: "News" },
  { key: "social", label: "Social" },
  { key: "volatility", label: "Volatility" },
  { key: "liquidity", label: "Liquidity" },
  { key: "valuation", label: "Entry / Value Timing" },
];

interface ScreenCriteriaFormProps {
  horizon?: TradeHorizon;
  onHorizonChange?: (h: TradeHorizon) => void;
  horizons?: TradeHorizon[];
  onHorizonsChange?: (h: TradeHorizon[]) => void;
  criteria: ScreenCriteria;
  onCriteriaChange: (c: ScreenCriteria) => void;
  description: string;
  onDescriptionChange: (d: string) => void;
  variant?: "default" | "forge";
  /** Blueprint only: the mode + Run dock, rendered right under the narrative. */
  runSlot?: ReactNode;
}

function toggle<T>(list: T[] | undefined, item: T): T[] {
  const base = list ?? [];
  return base.includes(item) ? base.filter((x) => x !== item) : [...base, item];
}

function chipClass(active: boolean, variant: "default" | "forge") {
  if (variant === "forge") return `forge-chip ${active ? "forge-chip--on" : ""}`;
  return `chip-select ${active ? "active" : ""}`;
}

function FilterSection({
  title,
  summary,
  tip,
  defaultOpen = true,
  children,
}: {
  title: string;
  summary?: string;
  tip?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="forge-filter-section" open={defaultOpen}>
      <summary className="forge-filter-section__summary">
        <span className="forge-filter-section__title">
          {title}
          {tip ? <InfoTip label={`About ${title}`} content={tip} /> : null}
        </span>
        {summary && <span className="forge-filter-section__hint text-faint">{summary}</span>}
      </summary>
      <div className="forge-filter-section__body col gap-3">{children}</div>
    </details>
  );
}

/** Opt-in filter group: collapsed + inactive until the user "includes" it. */
function ToggleFilterSection({
  title,
  summary,
  tip,
  active,
  onToggle,
  children,
}: {
  title: string;
  summary?: string;
  tip?: ReactNode;
  active: boolean;
  onToggle: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className={`forge-filter-section forge-filter-section--toggle ${active ? "is-active" : ""}`}>
      <div className="forge-filter-section__summary">
        <span className="forge-filter-section__title">
          {title}
          {tip ? <InfoTip label={`About ${title}`} content={tip} /> : null}
        </span>
        {summary && <span className="forge-filter-section__hint text-faint">{summary}</span>}
        <label className="forge-include">
          <input
            type="checkbox"
            className="forge-include__input"
            checked={active}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="forge-include__track" aria-hidden="true">
            <span className="forge-include__thumb" />
          </span>
          <span className="forge-include__label">{active ? "Filter on" : "Add filter"}</span>
        </label>
      </div>
      {active && <div className="forge-filter-section__body col gap-3">{children}</div>}
    </section>
  );
}

/** Opt-in filter groups in the Blueprint deck and the criteria fields each owns. */
type FilterSectionId = "sectors" | "catalysts" | "fundamentals" | "attention" | "categoryFloors";

const SECTION_IDS: FilterSectionId[] = [
  "sectors",
  "catalysts",
  "fundamentals",
  "attention",
  "categoryFloors",
];

const SECTION_FIELDS: Record<FilterSectionId, Array<keyof ScreenCriteria>> = {
  sectors: ["sectors", "capBuckets", "riskLevels"],
  catalysts: ["catalystTypes", "requireAboveSMA50", "requireAboveSMA200", "maxDaysToCatalyst"],
  fundamentals: [
    "minOpportunityScore",
    "minConfidence",
    "minRevenueGrowth",
    "minEpsGrowth",
    "minGrossMargin",
    "minPeRatio",
    "maxPeRatio",
  ],
  attention: [
    "minNewsArticles7d",
    "minSocialMentions24h",
    "minAvgDollarVolume",
    "maxShortInterestPct",
  ],
  categoryFloors: ["minCategoryScores"],
};

/**
 * Every gate HARD-FILTERS: a name that misses an active gate is screened out of
 * the board into the collapsed "Missed the cut" section - and an empty selection
 * inside any group means that row simply doesn't constrain. The tooltips repeat
 * this so nobody has to learn it by surprise.
 */
const SECTION_TIPS: Record<FilterSectionId, string> = {
  sectors:
    "Hard filters on sector, company size (market cap), and risk level. Any stock that doesn't match what you select is removed from the board — shown under “Missed the cut” below. Leaving a row empty means no restriction on that row.",
  catalysts:
    "Hard filters on catalyst type, whether the stock is above its 50- or 200-day moving average (a price-trend indicator), and how soon a catalyst is expected. Nothing selected = no restriction.",
  fundamentals:
    "Minimum thresholds for quality metrics: opportunity score, confidence, revenue growth, EPS (earnings per share) growth, gross margin, and a P/E (price-to-earnings) ceiling. Raising a floor removes stocks below it.",
  attention:
    "Minimum thresholds for news coverage, social mentions, and average daily trading volume, plus a maximum short interest — screens for stocks with enough activity and liquidity.",
  categoryFloors:
    "Minimum scores for each of the nine scoring categories (the same breakdown shown on every stock card). Stocks below any floor are removed from the board.",
};

/** True when the user has set at least one value in this section. */
function sectionHasValues(criteria: ScreenCriteria, id: FilterSectionId): boolean {
  return SECTION_FIELDS[id].some((field) => {
    const v = criteria[field];
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.values(v).some((x) => x != null);
    return true;
  });
}

/** Strip every field a section owns so it stops constraining the screen. */
function clearSection(criteria: ScreenCriteria, id: FilterSectionId): ScreenCriteria {
  const next = { ...criteria };
  for (const field of SECTION_FIELDS[id]) delete next[field];
  return next;
}

export function ScreenCriteriaForm({
  horizon,
  onHorizonChange,
  horizons,
  onHorizonsChange,
  criteria,
  onCriteriaChange,
  description,
  onDescriptionChange,
  variant = "default",
  runSlot,
}: ScreenCriteriaFormProps) {
  const forge = variant === "forge";
  const multiHorizon = forge && Boolean(onHorizonsChange);

  // Sections are opt-in: a group is "active" once it holds a value, or once the
  // user explicitly includes it (revealing empty controls). Turning it off
  // clears its criteria so it no longer constrains the screen - more stocks.
  const [forcedOpen, setForcedOpen] = useState<Partial<Record<FilterSectionId, boolean>>>({});
  const isSectionActive = (id: FilterSectionId): boolean =>
    sectionHasValues(criteria, id) || forcedOpen[id] === true;
  const setSectionActive = (id: FilterSectionId, on: boolean) => {
    setForcedOpen((prev) => ({ ...prev, [id]: on }));
    if (!on) onCriteriaChange(clearSection(criteria, id));
  };

  // Latch: once a group holds values it stays OPEN even if the user empties it
  // mid-tune - deselecting the last chip must not collapse the panel out from
  // under the cursor. (Empty selection still means "no constraint" in the
  // engine; only the explicit toggle closes the group.)
  useEffect(() => {
    setForcedOpen((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of SECTION_IDS) {
        if (sectionHasValues(criteria, id) && next[id] !== true) {
          next[id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [criteria]);

  return (
    <div className={`screen-form col gap-4 ${forge ? "screen-form--forge" : ""}`}>
      {forge ? (
        <NarrativeIntelPanel
          description={description}
          onDescriptionChange={onDescriptionChange}
          criteria={criteria}
          onCriteriaChange={onCriteriaChange}
          runSlot={runSlot}
        />
      ) : (
        <>
          {onHorizonsChange ? (
            <TradeHorizonPicker values={horizons} onChangeValues={onHorizonsChange} />
          ) : (
            <TradeHorizonPicker value={horizon!} onChange={onHorizonChange!} />
          )}
          <div className="field">
            <label>Narrative</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
            />
          </div>
        </>
      )}

      {multiHorizon ? (
        <FilterSection
          title="Time horizons"
          summary="Optional — blend multiple styles"
          tip="Your trading horizon shifts which factors matter most in the score — a short-term style weights momentum and volatility more; a long-term style weights fundamentals more. Horizons never remove stocks, they only affect sort order."
          defaultOpen={false}
        >
          <TradeHorizonPicker
            values={horizons}
            onChangeValues={onHorizonsChange}
            compact={forge}
            forge={forge}
          />
        </FilterSection>
      ) : (
        !forge && null
      )}

      {forge ? (
        <div className="forge-filter-deck">
          <ToggleFilterSection
            title="Sectors & cap"
            summary="Limit sectors, market cap, or risk"
            tip={SECTION_TIPS.sectors}
            active={isSectionActive("sectors")}
            onToggle={(on) => setSectionActive("sectors", on)}
          >
            <div className="field">
              <label>Sectors</label>
              <div className="chip-grid">
                {ALL_SECTORS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={chipClass(Boolean(criteria.sectors?.includes(s)), variant)}
                    onClick={() =>
                      onCriteriaChange({ ...criteria, sectors: toggle(criteria.sectors, s) })
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Market cap</label>
              <div className="chip-grid forge-cap-grid">
                {ALL_CAPS.map((c) => (
                  <MarketCapChip
                    key={c}
                    bucket={c}
                    active={Boolean(criteria.capBuckets?.includes(c))}
                    className={`${chipClass(Boolean(criteria.capBuckets?.includes(c)), variant)} forge-cap-chip`}
                    onToggle={() =>
                      onCriteriaChange({ ...criteria, capBuckets: toggle(criteria.capBuckets, c) })
                    }
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <label>Risk level</label>
              <div className="chip-grid">
                {ALL_RISKS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={chipClass(Boolean(criteria.riskLevels?.includes(r)), variant)}
                    onClick={() =>
                      onCriteriaChange({ ...criteria, riskLevels: toggle(criteria.riskLevels, r) })
                    }
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </ToggleFilterSection>

          <ToggleFilterSection
            title="Catalysts & technicals"
            summary="Catalyst type, moving averages & timing"
            tip={SECTION_TIPS.catalysts}
            active={isSectionActive("catalysts")}
            onToggle={(on) => setSectionActive("catalysts", on)}
          >
            <div className="field">
              <label>Catalyst type</label>
              <div className="chip-grid">
                {ALL_CATALYSTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={chipClass(Boolean(criteria.catalystTypes?.includes(c)), variant)}
                    onClick={() =>
                      onCriteriaChange({
                        ...criteria,
                        catalystTypes: toggle(criteria.catalystTypes, c),
                      })
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="forge-filter-row">
              <label className="forge-check">
                <input
                  type="checkbox"
                  checked={criteria.requireAboveSMA50 === true}
                  onChange={(e) =>
                    onCriteriaChange({
                      ...criteria,
                      requireAboveSMA50: e.target.checked || undefined,
                    })
                  }
                />
                Above 50-day SMA
              </label>
              <label className="forge-check">
                <input
                  type="checkbox"
                  checked={criteria.requireAboveSMA200 === true}
                  onChange={(e) =>
                    onCriteriaChange({
                      ...criteria,
                      requireAboveSMA200: e.target.checked || undefined,
                    })
                  }
                />
                Above 200-day SMA
              </label>
            </div>
            <div className="field">
              <label>
                Max days to catalyst:{" "}
                <span className="mono">{criteria.maxDaysToCatalyst ?? "any"}</span>
              </label>
              <input
                type="range"
                aria-label="Max days to catalyst"
                min={0}
                max={120}
                step={5}
                value={criteria.maxDaysToCatalyst ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onCriteriaChange({
                    ...criteria,
                    maxDaysToCatalyst: v > 0 ? v : undefined,
                  });
                }}
              />
            </div>
          </ToggleFilterSection>

          <ToggleFilterSection
            title="Fundamentals"
            summary="Score, growth, margin & valuation floors"
            tip={SECTION_TIPS.fundamentals}
            active={isSectionActive("fundamentals")}
            onToggle={(on) => setSectionActive("fundamentals", on)}
          >
            <div className="screen-form__sliders">
              <SliderField
                label="Min opportunity score"
                value={criteria.minOpportunityScore ?? 0}
                min={0}
                max={90}
                step={5}
                display={String(criteria.minOpportunityScore ?? 0)}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minOpportunityScore: v > 0 ? v : undefined,
                  })
                }
              />
              <SliderField
                label="Min confidence"
                value={criteria.minConfidence ?? 0}
                min={0}
                max={90}
                step={5}
                display={String(criteria.minConfidence ?? 0)}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minConfidence: v > 0 ? v : undefined,
                  })
                }
              />
              <SliderField
                label="Min revenue growth (YoY %)"
                value={Math.round((criteria.minRevenueGrowth ?? 0) * 100)}
                min={0}
                max={80}
                step={5}
                display={String(Math.round((criteria.minRevenueGrowth ?? 0) * 100))}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minRevenueGrowth: v > 0 ? v / 100 : undefined,
                  })
                }
              />
              <SliderField
                label="Min EPS growth (YoY %)"
                value={Math.round((criteria.minEpsGrowth ?? 0) * 100)}
                min={-20}
                max={80}
                step={5}
                display={String(Math.round((criteria.minEpsGrowth ?? 0) * 100))}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minEpsGrowth: v !== 0 ? v / 100 : undefined,
                  })
                }
              />
              <SliderField
                label="Min gross margin (%)"
                value={Math.round((criteria.minGrossMargin ?? 0) * 100)}
                min={0}
                max={80}
                step={5}
                display={String(Math.round((criteria.minGrossMargin ?? 0) * 100))}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minGrossMargin: v > 0 ? v / 100 : undefined,
                  })
                }
              />
              <SliderField
                label="Max P/E"
                value={criteria.maxPeRatio ?? 0}
                min={0}
                max={120}
                step={5}
                display={criteria.maxPeRatio ? String(criteria.maxPeRatio) : "off"}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    maxPeRatio: v > 0 ? v : undefined,
                  })
                }
              />
            </div>
          </ToggleFilterSection>

          <ToggleFilterSection
            title="Attention & liquidity"
            summary="News, social, volume & short interest"
            tip={SECTION_TIPS.attention}
            active={isSectionActive("attention")}
            onToggle={(on) => setSectionActive("attention", on)}
          >
            <div className="screen-form__sliders">
              <SliderField
                label="Min news articles (7d)"
                value={criteria.minNewsArticles7d ?? 0}
                min={0}
                max={20}
                step={1}
                display={String(criteria.minNewsArticles7d ?? 0)}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minNewsArticles7d: v > 0 ? v : undefined,
                  })
                }
              />
              <SliderField
                label="Min social mentions (24h)"
                value={criteria.minSocialMentions24h ?? 0}
                min={0}
                max={5000}
                step={100}
                display={String(criteria.minSocialMentions24h ?? 0)}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minSocialMentions24h: v > 0 ? v : undefined,
                  })
                }
              />
              <SliderField
                label="Min avg $ volume"
                value={criteria.minAvgDollarVolume ?? 0}
                min={0}
                max={500_000_000}
                step={1_000_000}
                display={
                  criteria.minAvgDollarVolume
                    ? formatVolume(criteria.minAvgDollarVolume)
                    : "off"
                }
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    minAvgDollarVolume: v > 0 ? v : undefined,
                  })
                }
              />
              <SliderField
                label="Max short interest (%)"
                value={Math.round((criteria.maxShortInterestPct ?? 0) * 100)}
                min={0}
                max={50}
                step={5}
                display={String(Math.round((criteria.maxShortInterestPct ?? 0) * 100))}
                onChange={(v) =>
                  onCriteriaChange({
                    ...criteria,
                    maxShortInterestPct: v > 0 ? v / 100 : undefined,
                  })
                }
              />
            </div>
          </ToggleFilterSection>

          <ToggleFilterSection
            title="Category floors"
            summary="Minimum per-category sub-scores"
            tip={SECTION_TIPS.categoryFloors}
            active={isSectionActive("categoryFloors")}
            onToggle={(on) => setSectionActive("categoryFloors", on)}
          >
            <div className="screen-form__sliders">
              {SCORE_CATS.map(({ key, label }) => (
                <SliderField
                  key={key}
                  label={`Min ${label}`}
                  value={criteria.minCategoryScores?.[key] ?? 0}
                  min={0}
                  max={90}
                  step={5}
                  display={String(criteria.minCategoryScores?.[key] ?? 0)}
                  onChange={(v) =>
                    onCriteriaChange({
                      ...criteria,
                      minCategoryScores: {
                        ...criteria.minCategoryScores,
                        [key]: v > 0 ? v : undefined,
                      },
                    })
                  }
                />
              ))}
            </div>
          </ToggleFilterSection>

          <FilterSection
            title="Results"
            tip='Limits how many stocks appear on the board. "All" shows the full ranked list — nothing is removed, just ordered. Set a number to keep the board focused.'
            defaultOpen
          >
            {/* 0 = uncapped: the board ranks the WHOLE universe; topping is opt-in. */}
            <SliderField
              label="Show top N"
              value={criteria.maxResults ?? 0}
              min={0}
              max={32}
              step={1}
              display={criteria.maxResults ? String(criteria.maxResults) : "All"}
              onChange={(v) =>
                onCriteriaChange({ ...criteria, maxResults: v > 0 ? v : undefined })
              }
            />
          </FilterSection>
        </div>
      ) : (
        <>
          <div className="field">
            <label>Sectors</label>
            <div className="chip-grid">
              {ALL_SECTORS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={chipClass(Boolean(criteria.sectors?.includes(s)), variant)}
                  onClick={() =>
                    onCriteriaChange({ ...criteria, sectors: toggle(criteria.sectors, s) })
                  }
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Market cap</label>
            <div className="chip-grid">
              {ALL_CAPS.map((c) => (
                <MarketCapChip
                  key={c}
                  bucket={c}
                  active={Boolean(criteria.capBuckets?.includes(c))}
                  className={chipClass(Boolean(criteria.capBuckets?.includes(c)), variant)}
                  onToggle={() =>
                    onCriteriaChange({ ...criteria, capBuckets: toggle(criteria.capBuckets, c) })
                  }
                />
              ))}
            </div>
          </div>
          <div className="screen-form__sliders">
            <SliderField
              label="Min opportunity score"
              value={criteria.minOpportunityScore ?? 0}
              min={0}
              max={90}
              step={5}
              display={String(criteria.minOpportunityScore ?? 0)}
              onChange={(v) =>
                onCriteriaChange({
                  ...criteria,
                  minOpportunityScore: v > 0 ? v : undefined,
                })
              }
            />
            <SliderField
              label="Max results"
              value={criteria.maxResults ?? 12}
              min={3}
              max={24}
              step={1}
              display={String(criteria.maxResults ?? 12)}
              onChange={(v) => onCriteriaChange({ ...criteria, maxResults: v })}
            />
          </div>
        </>
      )}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label>
        {label}: <span className="mono">{display}</span>
      </label>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
